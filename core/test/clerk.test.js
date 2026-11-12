import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { ClerkAuth, frontendApiFromPublishableKey } from "../dist/auth.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const PUBLISHABLE_KEY = `pk_test_${Buffer.from("fpm-test.clerk.accounts.dev$").toString("base64")}`;
const PUBLIC_URL = "https://mcp.example.com";

// A stand-in for Clerk: tokens map to Clerk users; verify records the audience it was asked for.
function fakeClerk() {
  const tokens = new Map();
  const users = new Map();
  const audiences = [];
  return {
    audiences,
    userMap: users,
    addUser(id, email, { verified = true, token = `oat_${id}`, publicMetadata = {} } = {}) {
      users.set(id, {
        publicMetadata,
        firstName: id,
        lastName: null,
        primaryEmailAddressId: `e_${id}`,
        emailAddresses: [{ id: `e_${id}`, emailAddress: email, verification: { status: verified ? "verified" : "unverified" } }],
      });
      tokens.set(token, { subject: id, revoked: false, expired: false });
      return token;
    },
    idPOAuthAccessToken: {
      async verify(token, options) {
        audiences.push(options?.audience);
        const t = tokens.get(token);
        if (!t) throw new Error("invalid");
        return t;
      },
    },
    users: {
      async getUser(id) {
        return users.get(id);
      },
    },
  };
}

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const clerk = fakeClerk();
  const auth = new ClerkAuth({ secretKey: "sk_test_x", publishableKey: PUBLISHABLE_KEY, publicUrl: PUBLIC_URL, requireAudience: true }, store, clerk);
  // Stand-in for Clerk's Backend API: role changes land in the fake users' public metadata.
  const roleWrites = [];
  const allowlistWrites = [];
  const clerkAdmin = {
    setAllowlist: async (enabled) => {
      allowlistWrites.push(enabled);
      return null;
    },
    allow: async () => null,
    disallow: async () => {},
    setRoles: async (id, roles) => {
      roleWrites.push([id, roles]);
      clerk.userMap.get(id).publicMetadata = { ...clerk.userMap.get(id).publicMetadata, mynt_roles: roles };
    },
  };
  const http = createMcpHttpServer(store, auth, { clerkAdmin }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const rpc = (method, params = {}, token) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const tools = async (token) => {
    const res = await rpc("tools/list", {}, token);
    assert.equal(res.status, 200);
    const text = await res.text();
    return JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result.tools.map((t) => t.name);
  };
  const callTool = async (name, args, token) => {
    const res = await rpc("tools/call", { name, arguments: args }, token);
    const text = await res.text();
    const result = JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result;
    return { isError: result.isError ?? false, data: JSON.parse(result.content[0].text) };
  };
  return { store, clerk, base, rpc, tools, callTool, roleWrites, allowlistWrites, close: () => http.close() };
}

test("decodes the Clerk frontend API host from the publishable key", () => {
  assert.equal(frontendApiFromPublishableKey(PUBLISHABLE_KEY), "fpm-test.clerk.accounts.dev");
});

test("publishes protected-resource metadata pointing at Clerk", async () => {
  const { base, close } = await setup();
  try {
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    assert.equal(meta.resource, `${PUBLIC_URL}/mcp`);
    assert.deepEqual(meta.authorization_servers, ["https://fpm-test.clerk.accounts.dev"]);
  } finally {
    close();
  }
});

test("requests without a token get a 401 that points clients at the metadata", async () => {
  const { rpc, close } = await setup();
  try {
    const res = await rpc("tools/list");
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /resource_metadata="https:\/\/mcp\.example\.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  } finally {
    close();
  }
});

test("invalid tokens and local fpm_ tokens are refused with invalid_token", async () => {
  const { store, rpc, close } = await setup();
  try {
    assert.equal((await rpc("tools/list", {}, "oat_nope")).status, 401);
    const { token } = await store.createUser("Local", ["innovator"]);
    const res = await rpc("tools/list", {}, token);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("www-authenticate"), /error="invalid_token"/);
  } finally {
    close();
  }
});

test("a signed-in user who is not whitelisted gets 403", async () => {
  const { clerk, rpc, close } = await setup();
  try {
    const token = clerk.addUser("u1", "stranger@example.com");
    const res = await rpc("tools/list", {}, token);
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, "not_whitelisted");
  } finally {
    close();
  }
});

test("a new Clerk account with the same verified email keeps the existing user (e.g. moving to production)", async () => {
  const { store, clerk, rpc, tools, close } = await setup();
  try {
    await store.upsertInvite("priya@example.com", ["developer"]);
    const devToken = clerk.addUser("dev_user", "priya@example.com");
    await tools(devToken);
    const [before] = (await store.listUsers()).filter((u) => u.email === "priya@example.com");
    const created = await rpc("tools/call", { name: "create_app", arguments: { name: "A", description: "B", audience: "C", product_ids: ["ppf"] } }, devToken);
    assert.equal(created.status, 200);

    const prodToken = clerk.addUser("prod_user", "priya@example.com");
    const res = await rpc("tools/call", { name: "list_my_apps", arguments: {} }, prodToken);
    const text = await res.text();
    const apps = JSON.parse(JSON.parse(text.match(/^data: (.*)$/m)?.[1] ?? text).result.content[0].text);
    assert.equal(apps.length, 1, "the app is still theirs");
    const after = (await store.listUsers()).filter((u) => u.email === "priya@example.com");
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before.id);
    assert.ok(await store.userByClerkId("prod_user"));
  } finally {
    close();
  }
});

test("an unverified email does not match the whitelist", async () => {
  const { store, clerk, rpc, close } = await setup();
  try {
    await store.upsertInvite("pending@example.com", ["consumer"]);
    const token = clerk.addUser("u2", "pending@example.com", { verified: false });
    assert.equal((await rpc("tools/list", {}, token)).status, 403);
  } finally {
    close();
  }
});

test("whitelisted users get their invite's roles; changes and revocation apply on the next request", async () => {
  const { store, clerk, tools, rpc, close } = await setup();
  try {
    await store.upsertInvite("Ines@Example.com", ["consumer"]);
    const token = clerk.addUser("u3", "ines@example.com");

    const first = await tools(token);
    assert.ok(first.includes("enroll_in_product"));
    assert.ok(!first.includes("create_app") && !first.includes("create_product"));
    assert.deepEqual(clerk.audiences.at(-1), `${PUBLIC_URL}/mcp`, "tokens must be issued for this resource");

    await store.upsertInvite("ines@example.com", ["innovator"]);
    const promoted = await tools(token);
    assert.ok(["enroll_in_product", "create_app", "create_product"].every((t) => promoted.includes(t)), "innovator includes everything");
    assert.equal((await store.listUsers()).filter((u) => u.email === "ines@example.com").length, 1, "one linked user");

    await store.deleteInvite("ines@example.com");
    assert.equal((await rpc("tools/list", {}, token)).status, 403);
  } finally {
    close();
  }
});

test("roles granted in Clerk (public metadata mynt_roles) whitelist the user; Mynt then manages them", async () => {
  const { store, clerk, rpc, tools, roleWrites, close } = await setup();
  try {
    const adminToken = clerk.addUser("a1", "Boss@Example.com", { publicMetadata: { mynt_roles: ["admin"] } });
    const adminTools = await tools(adminToken);
    assert.ok(adminTools.includes("define_region") && adminTools.includes("create_product"), "admin via Clerk, with everything below it");
    assert.deepEqual((await store.getInvite("boss@example.com")).roles, ["admin"]);
    assert.equal((await store.auditLog())[0].action, "invite_via_clerk");

    // Junk in the metadata grants nothing.
    const junk = clerk.addUser("j1", "junk@example.com", { publicMetadata: { mynt_roles: ["superuser"] } });
    assert.equal((await rpc("tools/list", {}, junk)).status, 403);

    // A Clerk-granted developer, later revoked from Mynt by the admin: Clerk's copy is cleared too,
    // so the next sign-in doesn't re-grant access.
    const devToken = clerk.addUser("d1", "dev@example.com", { publicMetadata: { mynt_roles: "developer" } });
    assert.ok((await tools(devToken)).includes("create_campaign"));
    const res = await rpc("tools/call", { name: "revoke_user", arguments: { email: "dev@example.com" } }, adminToken);
    assert.equal(res.status, 200);
    assert.deepEqual(roleWrites.at(-1), ["d1", null]);
    assert.equal((await rpc("tools/list", {}, devToken)).status, 403);
  } finally {
    close();
  }
});

test("public sign-up: verified strangers join as consumers through an invite; revoked people stay out", async () => {
  const { store, clerk, rpc, tools, callTool, allowlistWrites, close } = await setup();
  try {
    await store.upsertInvite("boss@example.com", ["admin"]);
    const adminToken = clerk.addUser("a1", "boss@example.com");
    const strangerToken = clerk.addUser("s1", "Stranger@Example.com");
    assert.equal((await rpc("tools/list", {}, strangerToken)).status, 403, "invite-only by default");

    const opened = await callTool("set_public_signup", { enabled: true }, adminToken);
    assert.deepEqual(opened.data, { public_signup: true });
    assert.deepEqual(allowlistWrites, [false], "the sign-in provider's allowlist goes off");
    assert.equal((await callTool("list_whitelist", {}, adminToken)).data.public_signup, true);

    const joined = await tools(strangerToken);
    assert.ok(joined.includes("enroll_in_product"));
    assert.ok(!joined.includes("create_app") && !joined.includes("create_product"), "consumer only");
    assert.deepEqual((await store.getInvite("stranger@example.com")).roles, ["consumer"]);
    assert.ok((await store.auditLog(10)).some((a) => a.action === "invite_via_public_signup" && a.target === "stranger@example.com"));

    // An unverified email still gets nothing, and says why.
    const unverified = clerk.addUser("u9", "maybe@example.com", { verified: false });
    const refused = await rpc("tools/list", {}, unverified);
    assert.equal(refused.status, 403);
    assert.match((await refused.json()).message, /Verify your email/);

    // Revoked: public sign-up doesn't let them back in, until an admin invites them again.
    assert.equal((await callTool("revoke_user", { email: "stranger@example.com" }, adminToken)).isError, false);
    assert.equal((await rpc("tools/list", {}, strangerToken)).status, 403);
    assert.equal(await store.getInvite("stranger@example.com"), undefined);
    await callTool("invite_user", { email: "stranger@example.com", roles: ["developer"] }, adminToken);
    assert.ok((await tools(strangerToken)).includes("create_app"));

    // Closing it again: new strangers are refused; people already in keep their invites.
    await callTool("set_public_signup", { enabled: false }, adminToken);
    assert.deepEqual(allowlistWrites, [false, true]);
    const late = clerk.addUser("l1", "late@example.com");
    assert.equal((await rpc("tools/list", {}, late)).status, 403);
    assert.ok((await tools(strangerToken)).includes("create_app"));
    // Only admins can flip it.
    assert.equal((await rpc("tools/call", { name: "set_public_signup", arguments: { enabled: true } }, strangerToken)).status, 200);
    assert.equal(await store.publicSignup(), false);
  } finally {
    close();
  }
});
