import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { ClerkIdentityProvider } from "../dist/auth.js";
import { LinkedAccountsService } from "../dist/linked-accounts.js";
import { CATALOG } from "./helpers.js";

const REPO = "acme/web";
const PK = `pk_test_${Buffer.from("happy-otter-12.clerk.accounts.dev$").toString("base64")}`;

// GitHub as Mynt's app sees it: the repository (its stable id can change under the same name), accounts by id, and
// each login's permission. `fail` makes it answer 5xx.
function fakeGitHub() {
  const gh = {
    ids: [1001], // repositoryInfo answers these in turn (the last one repeats)
    name: REPO,
    accounts: { 42: "octo" },
    permissions: { octo: "write" },
    fail: false,
    calls: [],
    async installationFor(repo) {
      return repo === REPO ? 7 : null;
    },
    async tokenFor() {
      return { token: "ghs_x", expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    installUrl: () => "https://github.com/apps/mynt/installations/new",
    async openPullRequest() {
      return "";
    },
    async repositoryInfo(repo, installation) {
      gh.calls.push(["repositoryInfo", repo, installation]);
      if (gh.fail) throw new Error("GitHub 502");
      const id = gh.ids.length > 1 ? gh.ids.shift() : gh.ids[0];
      return { id: String(id), full_name: gh.name };
    },
    async loginOf(id) {
      if (gh.fail) throw new Error("GitHub 502");
      return gh.accounts[id] ?? null;
    },
    async permissionOf(repo, installation, login) {
      gh.calls.push(["permissionOf", repo, installation, login]);
      if (gh.fail) throw new Error("GitHub 502");
      return gh.permissions[login] ?? "none";
    },
  };
  return gh;
}

// Clerk's backend: the person's linked GitHub account (verified or not), by Clerk user.
function fakeClerk(accounts) {
  const c = {
    down: false,
    users: {
      async getUser(id) {
        if (c.down) throw Object.assign(new Error("clerk down"), { status: 503 });
        return { externalAccounts: accounts[id] ?? [], web3Wallets: [] };
      },
    },
  };
  return c;
}
const github = (providerUserId, status = "verified") => ({ provider: "oauth_github", username: "octo", providerUserId, verification: { status } });

async function setup(accounts) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const gh = fakeGitHub();
  const builds = await BuildService.open(db, store, null, gh, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com" });
  const clerk = fakeClerk(accounts);
  const identity = new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, db, clerk), 0, Date.now, 0);
  builds.identity = identity; // as index.ts sets it, for builds' re-checks
  const connect = async (name, clerkId) => {
    const { user } = await store.createUser(name, ["developer"]);
    if (clerkId) await pg.query("UPDATE financial_products.users SET clerk_user_id = $2 WHERE id = $1", [user.id, clerkId]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds, identity }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    const call = async (tool, args = {}) => JSON.parse((await client.callTool({ name: tool, arguments: args })).content[0].text);
    return { user, call };
  };
  const row = async (userId) => (await pg.query("SELECT approval, repo_id, approval_note, approved_via FROM financial_products.repo_connections WHERE developer_id = $1", [userId])).rows[0];
  const audits = async (action) => (await pg.query("SELECT details FROM financial_products.audit_log WHERE action = $1", [action])).rows.map((r) => r.details);
  const age = (userId, minutes) => pg.query("UPDATE financial_products.repo_connections SET checked_at = now() - make_interval(mins => $2) WHERE developer_id = $1", [userId, minutes]);
  return { pg, gh, builds, clerk, connect, row, audits, age };
}

test("the GitHub account linked to the sign-in can push: approved at once, the repository pinned by its id", async () => {
  const w = await setup({ clerk_ana: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  const r = await ana.call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "approved");
  assert.equal(r.why, undefined);
  const row = await w.row(ana.user.id);
  assert.equal(row.repo_id, "1001");
  assert.match(row.approval_note, /octo can push \(write\)/);
  assert.deepEqual(await w.audits("auto_approve_repository_connection"), [{ login: "octo", permission: "write", repo_id: "1001" }]);
  assert.ok(w.gh.calls.every((c) => c[0] !== "permissionOf" || c[2] === 7), "through the installation that covers the repository");
  for (const p of ["admin", "maintain"]) {
    const v = await setup({ clerk_v: [github("42")] });
    v.gh.permissions.octo = p;
    assert.equal((await (await v.connect("V", "clerk_v")).call("connect_repository", { repository: REPO })).approval, "approved", p);
  }
});

test("read access only, no linked account, an unverified one, or GitHub down: an admin decides, and the developer is told why", async () => {
  // Read only.
  let w = await setup({ clerk_ana: [github("42")] });
  w.gh.permissions.octo = "read";
  let r = await (await w.connect("Ana", "clerk_ana")).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /octo can't push to acme\/web \(its permission there is read\)/);
  // No GitHub account linked: the hint, with where to link one.
  w = await setup({ clerk_ana: [] });
  r = await (await w.connect("Ana", "clerk_ana")).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /No verified GitHub account is linked to your sign-in.*link your GitHub account/);
  assert.equal(r.manage_url, "https://happy-otter-12.accounts.dev/user");
  // Linked, but not verified with Clerk: it counts for nothing.
  w = await setup({ clerk_ana: [github("42", "unverified")] });
  r = await (await w.connect("Ana", "clerk_ana")).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /No verified GitHub account/);
  // GitHub answers 5xx.
  w = await setup({ clerk_ana: [github("42")] });
  w.gh.fail = true;
  r = await (await w.connect("Ana", "clerk_ana")).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /GitHub couldn't be reached/);
  assert.ok(!JSON.stringify(r).includes("502"), "not the host's own message");
  // Signed in without the identity provider (a local token): an admin decides.
  w = await setup({});
  r = await (await w.connect("Loc", null)).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
});

test("a repository renamed or transferred during the check, or not the one connected before, is never approved on its name", async () => {
  // Another repository answers to the name between Mynt's two looks.
  let w = await setup({ clerk_ana: [github("42")] });
  w.gh.ids = [1001, 2002];
  let r = await (await w.connect("Ana", "clerk_ana")).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /changed \(renamed or transferred\) while Mynt was checking/);
  // It answers under another name now.
  w = await setup({ clerk_ana: [github("42")] });
  w.gh.name = "someone-else/web";
  r = await (await w.connect("Ana", "clerk_ana")).call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /now answers as someone-else\/web/);
  // Approved before as repository 1001; connected again, the name is a different repository: back to an admin.
  w = await setup({ clerk_ana: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  assert.equal((await ana.call("connect_repository", { repository: REPO })).approval, "approved");
  w.gh.ids = [3003];
  await w.age(ana.user.id, 11); // within 10 minutes of GitHub's answer, a reconnect isn't checked again
  r = await ana.call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /different repository from the one you connected before/);
});

test("an admin's rejection stands through any number of reconnects, whoever can push; only an admin lifts it", async () => {
  const w = await setup({ clerk_ana: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  w.gh.permissions.octo = "read";
  await ana.call("connect_repository", { repository: REPO });
  await w.pg.query("UPDATE financial_products.repo_connections SET approval = 'rejected', decided_by = $2 WHERE developer_id = $1", [ana.user.id, ana.user.id]);
  // Now they can push: reconnecting again and again changes nothing.
  w.gh.permissions.octo = "admin";
  for (let i = 0; i < 3; i++) {
    const r = await ana.call("connect_repository", { repository: REPO });
    assert.equal(r.approval, "rejected", `reconnect ${i + 1}`);
    assert.match(r.why, /only an admin can change that/);
  }
  assert.equal((await w.row(ana.user.id)).approval, "rejected");
});

test("an admin rejecting while GitHub is being asked wins", async () => {
  const w = await setup({ clerk_ana: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  const ask = w.gh.permissionOf;
  w.gh.permissionOf = async (...a) => {
    await w.pg.query("UPDATE financial_products.repo_connections SET approval = 'rejected' WHERE developer_id = $1", [ana.user.id]);
    return ask(...a);
  };
  const r = await ana.call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "rejected");
  assert.equal((await w.row(ana.user.id)).approval, "rejected");
});

test("push access lost later: a build checks again once GitHub's answer is 10 minutes old, and the connection goes back to an admin; admins' approvals aren't re-checked", async () => {
  const w = await setup({ clerk_ana: [github("42")], clerk_ben: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  assert.equal((await ana.call("connect_repository", { repository: REPO })).approval, "approved");
  assert.equal((await w.row(ana.user.id)).approved_via, "github");
  w.gh.permissions.octo = "read";
  // Within the window: GitHub isn't asked again.
  const before = w.gh.calls.length;
  await w.builds.requireApprovedConnection(ana.user.id, REPO);
  assert.equal(w.gh.calls.length, before, "the recent answer stands");
  // Older than 10 minutes: asked again, and lost.
  await w.age(ana.user.id, 11);
  await assert.rejects(w.builds.requireApprovedConnection(ana.user.id, REPO), /can't push.*waits for an admin/);
  assert.equal((await w.row(ana.user.id)).approval, "pending_approval");
  assert.equal((await w.audits("repository_access_withdrawn")).length, 1);
  // GitHub down at build time: an approval GitHub gave stands (not blocked by an outage).
  w.gh.permissions.octo = "write";
  assert.equal((await ana.call("connect_repository", { repository: REPO })).approval, "approved");
  await w.age(ana.user.id, 11);
  w.gh.fail = true;
  await w.builds.requireApprovedConnection(ana.user.id, REPO);
  assert.equal((await w.row(ana.user.id)).approval, "approved");
  // An admin's approval isn't re-checked.
  w.gh.fail = false;
  await w.pg.query("UPDATE financial_products.repo_connections SET approved_via = 'admin' WHERE developer_id = $1", [ana.user.id]);
  w.gh.permissions.octo = "none";
  await w.builds.requireApprovedConnection(ana.user.id, REPO);
  assert.equal((await w.row(ana.user.id)).approval, "approved");
  // Reconnecting with no push any more also takes back an approval that rested on it.
  const ben = await w.connect("Ben", "clerk_ben");
  w.gh.permissions.octo = "write";
  assert.equal((await ben.call("connect_repository", { repository: REPO })).approval, "approved");
  w.gh.permissions.octo = "read";
  await w.age(ben.user.id, 11);
  assert.equal((await ben.call("connect_repository", { repository: REPO })).approval, "pending_approval");
});

test("GitHub is asked sparingly: an approved, recently checked connection isn't checked again; checks are capped per developer per minute", async () => {
  const w = await setup({ clerk_ana: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  assert.equal((await ana.call("connect_repository", { repository: REPO })).approval, "approved");
  const before = w.gh.calls.length;
  assert.equal((await ana.call("connect_repository", { repository: REPO })).approval, "approved");
  assert.equal(w.gh.calls.length, before, "no GitHub call for an approved, recently checked connection");
  // Ten checks a minute.
  await w.pg.query("UPDATE financial_products.repo_connections SET approval = 'pending_approval' WHERE developer_id = $1", [ana.user.id]);
  w.gh.permissions.octo = "read";
  // One check so far (the first connect; the second was skipped): nine more are allowed.
  let last;
  for (let i = 0; i < 9; i++) last = await ana.call("connect_repository", { repository: REPO });
  assert.equal(last.approval, "pending_approval");
  assert.match((await ana.call("connect_repository", { repository: REPO })).error, /checked 10 repositories with GitHub in the last minute/);
});

test("GitHub: one check asks for one token and reuses it", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { GitHubApp } = await import("../dist/github.js");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const app = new GitHubApp("1", privateKey.export({ type: "pkcs8", format: "pem" }), "mynt", "https://gh.test");
  const real = globalThis.fetch;
  let tokens = 0;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    const reply = (v, status = 200) => new Response(JSON.stringify(v), { status });
    if (path === "/app/installations/7/access_tokens") {
      tokens++;
      return reply({ token: "ghs_meta", expires_at: new Date(Date.now() + 3600e3).toISOString() }, 201);
    }
    if (path === "/repos/acme/web") return reply({ id: 1001, full_name: "acme/web" });
    if (path === "/user/42") return reply({ login: "octo" });
    if (path === "/repos/acme/web/collaborators/octo/permission") return reply({ permission: "write" });
    if (path === "/user/99") return reply({ message: "Not Found" }, 404);
    return reply({}, 500);
  };
  try {
    assert.deepEqual(await app.repositoryInfo("acme/web", 7), { id: "1001", full_name: "acme/web" });
    assert.equal(await app.loginOf("42", "acme/web", 7), "octo");
    assert.equal(await app.permissionOf("acme/web", 7, "octo"), "write");
    assert.deepEqual(await app.repositoryInfo("acme/web", 7), { id: "1001", full_name: "acme/web" });
    assert.equal(tokens, 1);
    assert.equal(await app.loginOf("99", "acme/web", 7), null);
    assert.equal(await app.loginOf("not-a-number", "acme/web", 7), null);
  } finally {
    globalThis.fetch = real;
  }
});

test("an identity-provider outage is an outage: a re-check keeps the approval, and a new connection waits for an admin, saying why", async () => {
  const w = await setup({ clerk_ana: [github("42")], clerk_bob: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  assert.equal((await ana.call("connect_repository", { repository: REPO })).approval, "approved");
  // Clerk stops answering.
  w.clerk.down = true;
  await w.age(ana.user.id, 11);
  await w.builds.requireApprovedConnection(ana.user.id, REPO);
  assert.equal((await w.row(ana.user.id)).approval, "approved", "not withdrawn by the outage");
  assert.equal((await w.audits("repository_access_withdrawn")).length, 0);
  // A new connection meanwhile goes to an admin, with the reason.
  const bob = await w.connect("Bob", "clerk_bob");
  const r = await bob.call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /couldn't read the accounts linked to your sign-in/);
});
