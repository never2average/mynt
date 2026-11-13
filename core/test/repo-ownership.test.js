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
  return {
    users: {
      async getUser(id) {
        return { externalAccounts: accounts[id] ?? [], web3Wallets: [] };
      },
    },
  };
}
const github = (providerUserId, status = "verified") => ({ provider: "oauth_github", username: "octo", providerUserId, verification: { status } });

async function setup(accounts) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const gh = fakeGitHub();
  const builds = await BuildService.open(db, store, null, gh, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com" });
  const identity = new LinkedAccountsService(new ClerkIdentityProvider({ secretKey: "sk_test_x", publishableKey: PK }, db, fakeClerk(accounts)));
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
  const row = async (userId) => (await pg.query("SELECT approval, repo_id, approval_note FROM financial_products.repo_connections WHERE developer_id = $1", [userId])).rows[0];
  const audits = async (action) => (await pg.query("SELECT details FROM financial_products.audit_log WHERE action = $1", [action])).rows.map((r) => r.details);
  return { pg, gh, connect, row, audits };
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
  r = await ana.call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /different repository from the one you connected before/);
});

test("an admin's rejection stands, whoever can push", async () => {
  const w = await setup({ clerk_ana: [github("42")] });
  const ana = await w.connect("Ana", "clerk_ana");
  w.gh.permissions.octo = "read";
  await ana.call("connect_repository", { repository: REPO });
  await w.pg.query("UPDATE financial_products.repo_connections SET approval = 'rejected' WHERE developer_id = $1", [ana.user.id]);
  w.gh.permissions.octo = "admin";
  const r = await ana.call("connect_repository", { repository: REPO });
  assert.equal(r.approval, "pending_approval");
  assert.match(r.why, /admin rejected access to it before/);
});
