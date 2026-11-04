import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { createServer as createMcpServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { login } from "../scripts/mynt-login.mjs";
import { CATALOG } from "./helpers.js";
import { regulatoryModel } from "./seed-regulatory-model.js";

// scripts/apply-seed-definitions.mjs --login signs a person in the way an MCP client does: Mynt's
// protected-resource metadata, the authorization server's metadata, dynamic client registration, then
// the authorization code flow with PKCE (S256) and a state check, with the callback at localhost (loopback only). Here
// the authorization server is a fake that enforces each of those (no real Clerk calls), and Mynt is the
// real HTTP server with a stand-in for its Clerk verifier.

const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const readBody = async (req) => {
  let s = "";
  for await (const c of req) s += c;
  return s;
};

function fakeAuthServer(expectedResource) {
  const clients = new Map();
  const codes = new Map();
  const issued = new Map(); // token -> audience
  const seen = { registrations: [], tokenRequests: 0 };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (status, body, headers = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return json(200, {
        issuer: server.base,
        authorization_endpoint: `${server.base}/authorize`,
        token_endpoint: `${server.base}/token`,
        registration_endpoint: `${server.base}/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic", "none"],
        scopes_supported: ["openid", "profile", "email"],
      });
    if (url.pathname === "/register" && req.method === "POST") {
      const b = JSON.parse(await readBody(req));
      seen.registrations.push(b);
      if (b.token_endpoint_auth_method !== "none" || !b.redirect_uris?.every((u) => /^http:\/\/localhost:\d+\/callback$/.test(u)))
        return json(400, { error: "invalid_client_metadata" });
      const id = `client_${randomBytes(4).toString("hex")}`;
      clients.set(id, b);
      return json(201, { client_id: id, ...b });
    }
    if (url.pathname === "/authorize") {
      const p = Object.fromEntries(url.searchParams);
      const c = clients.get(p.client_id);
      const valid =
        c && p.response_type === "code" && c.redirect_uris.includes(p.redirect_uri) && p.code_challenge_method === "S256" && p.code_challenge && p.state && p.resource === expectedResource && p.scope === "openid profile email";
      if (!valid) return json(400, { error: "invalid_request" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, p);
      // The person signs in; the browser is sent back to the script.
      res.writeHead(302, { Location: `${p.redirect_uri}?code=${code}&state=${encodeURIComponent(p.state)}` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      seen.tokenRequests++;
      const p = Object.fromEntries(new URLSearchParams(await readBody(req)));
      const a = codes.get(p.code);
      codes.delete(p.code); // single use
      const challenge = p.code_verifier && createHash("sha256").update(p.code_verifier).digest("base64url");
      if (!a || p.grant_type !== "authorization_code" || p.client_id !== a.client_id || p.redirect_uri !== a.redirect_uri || challenge !== a.code_challenge || p.resource !== a.resource)
        return json(400, { error: "invalid_grant" });
      const token = `at_${randomBytes(16).toString("hex")}`;
      issued.set(token, a.resource);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 3600 });
    }
    json(404, { error: "not_found" });
  });
  return { server, issued, seen };
}

// Real Mynt over HTTP; its Clerk verifier is replaced by one that accepts the fake server's tokens for this resource.
async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const clerk = { issuer: "", resource: "", resourceMetadataUrl: "" };
  const mynt = createMcpHttpServer(store, clerk);
  const base = await listen(mynt);
  const resource = `${base}/mcp`;
  const as = fakeAuthServer(resource);
  as.server.base = await listen(as.server);
  Object.assign(clerk, {
    issuer: as.server.base,
    resource,
    resourceMetadataUrl: `${base}/.well-known/oauth-protected-resource/mcp`,
    protectedResourceMetadata: () => ({ resource, authorization_servers: [as.server.base], bearer_methods_supported: ["header"], scopes_supported: ["openid", "profile", "email"] }),
    authenticate: async (token) =>
      as.issued.get(token) === resource ? { ok: true, user: adminUser } : { ok: false, status: 401, error: "invalid_token", message: "invalid" },
  });
  const close = () => {
    for (const s of [mynt, as.server]) {
      s.closeAllConnections();
      s.close();
    }
  };
  return { store, adminUser, resource, as, close };
}

// The browser: follows the sign-in link, and the fake server's redirect, back to the script's callback.
const browser = (url) => void fetch(url).catch(() => {});

test("--login: discovery, registration, PKCE and state, callback on localhost (IPv4 and IPv6 loopback), token kept out of the output", async () => {
  const w = await world();
  try {
    const lines = [];
    const token = await login({ mcpUrl: w.resource, log: (l) => lines.push(l), openBrowser: browser });
    assert.match(token, /^at_/);
    assert.equal(w.as.issued.get(token), w.resource, "issued for Mynt's MCP resource");
    const [reg] = w.as.seen.registrations;
    assert.equal(reg.token_endpoint_auth_method, "none");
    assert.equal(reg.scope, "openid profile email");
    assert.match(reg.redirect_uris[0], /^http:\/\/localhost:\d+\/callback$/);
    const link = new URL(lines.find((l) => l.trim().startsWith("http")).trim());
    assert.equal(link.searchParams.get("code_challenge_method"), "S256");
    assert.equal(link.searchParams.get("resource"), w.resource);
    assert.ok(!lines.join("\n").includes(token), "the token is never printed");
  } finally {
    w.close();
  }
});

// The browser may resolve localhost to either loopback address: the callback answers on both.
for (const host of ["127.0.0.1", "[::1]"]) {
  test(`--login takes the callback on ${host}`, async (t) => {
    if (host === "[::1]") {
      const probe = createServer();
      const v6 = await new Promise((r) => probe.once("error", () => r(false)).listen(0, "::1", () => (probe.close(), r(true))));
      if (!v6) return t.skip("no IPv6 loopback on this machine");
    }
    const w = await world();
    try {
      const via = async (url) => {
        const r = await fetch(url, { redirect: "manual" });
        const back = new URL(r.headers.get("location"));
        assert.equal(back.hostname, "localhost");
        back.hostname = host;
        await fetch(back).catch(() => {});
      };
      assert.match(await login({ mcpUrl: w.resource, log: () => {}, openBrowser: (u) => void via(u) }), /^at_/);
    } finally {
      w.close();
    }
  });
}

test("--login refuses a callback whose state isn't its own, and never exchanges the code", async () => {
  const w = await world();
  try {
    const forged = async (url) => {
      const r = await fetch(url, { redirect: "manual" });
      const back = new URL(r.headers.get("location"));
      back.searchParams.set("state", "someone-elses");
      await fetch(back).catch(() => {});
    };
    await assert.rejects(login({ mcpUrl: w.resource, log: () => {}, openBrowser: (u) => void forged(u) }), /state/);
    assert.equal(w.as.seen.tokenRequests, 0);
  } finally {
    w.close();
  }
});

test("--login says what's wrong when the server publishes no OAuth metadata", async () => {
  const plain = createServer((req, res) => res.writeHead(404).end());
  const base = await listen(plain);
  try {
    await assert.rejects(login({ mcpUrl: `${base}/mcp`, log: () => {}, openBrowser: () => {} }), /doesn't publish OAuth metadata/);
  } finally {
    plain.close();
  }
});

test("apply-seed-definitions --login --dry-run signs in, checks every definition, changes nothing and prints no token", async () => {
  const w = await world();
  try {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createMcpServer(w.store, w.adminUser).connect(s);
    const admin = new Client({ name: "t", version: "0" });
    await admin.connect(c);
    const ok = async (cl, name, args) => {
      const r = await cl.callTool({ name, arguments: args });
      assert.ok(!r.isError, r.content[0].text);
      return JSON.parse(r.content[0].text);
    };
    await regulatoryModel({ ok, admin });

    const env = { ...process.env };
    delete env.MYNT_ADMIN_TOKEN;
    const child = spawn(process.execPath, [new URL("../scripts/apply-seed-definitions.mjs", import.meta.url).pathname, "--url", w.resource, "--login", "--dry-run"], {
      env: { ...env, DISPLAY: "", BROWSER: "true" },
    });
    let out = "";
    let followed = false;
    const onData = (d) => {
      out += d;
      const link = out.split("\n").find((l) => l.trim().startsWith(`${w.as.server.base}/authorize`));
      if (link && !followed) {
        followed = true;
        browser(link.trim());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, out);
    assert.match(out, /Signed in\./);
    assert.match(out, /Dry run: 4 definition\(s\) checked, nothing changed\./);
    for (const t of w.as.issued.keys()) assert.ok(!out.includes(t), "the token is never printed");
    assert.equal(developerReady(await w.store.getProduct("savings-account")), false, "nothing was published");
  } finally {
    w.close();
  }
});

const developerReady = (record) => Boolean(record.pins?.contract);
