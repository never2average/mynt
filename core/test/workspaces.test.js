import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { ClerkAuth } from "../dist/auth.js";
import { appStages } from "../dist/workspaces.js";
import { CATALOG } from "./helpers.js";

// A sandbox host that never gets past queueing: these tests are about who may reach a build, not running one.
const idleSandboxes = {
  stopped: [],
  async createSandbox() {
    return { id: "sbx", state: "provisioning" };
  },
  async getSandbox() {
    return undefined;
  },
  async stop(id) {
    this.stopped.push(id);
  },
  async readFile() {
    return null;
  },
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  async costDollars() {
    return 0;
  },
};

// Hosting as far as the tools reach before asking whether the caller may touch the app.
const stubHosting = {
  enabled: true,
  config: null,
  provider: null,
  async tenantOf() {
    return undefined;
  },
  async tenantHostingApp() {
    return undefined;
  },
  async tenantOfWorkspace() {
    return undefined;
  },
  async tenantsHosting() {
    return [];
  },
  async revokeVmAccess() {
    return false;
  },
  async undeploy() {
    return false;
  },
};

async function setup({ env = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const builds = await BuildService.open(db, store, idleSandboxes, null, {
    ...buildConfigFromEnv(env),
    publicUrl: "https://mynt.example.com",
    agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" },
  });
  const connect = async (name, email = `${name.toLowerCase()}@example.com`) => {
    const { user } = await store.createUser(name, ["developer"]);
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, email]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, { ...user, email }, { builds, hosting: stubHosting }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return { user: { ...user, email }, client };
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError ?? false, data };
  };
  // A build row as the builds service would have made it (queued, nothing running).
  const build = async (developerId, appId, status = "queued") => {
    const id = randomUUID();
    await pg.query(
      "INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd) VALUES ($1, $2, $3, 'build the thing', $4, 5)",
      [id, developerId, appId, status],
    );
    return id;
  };
  return { pg, store, builds, connect, call, build };
}

const app = (name) => ({ name, description: `${name} app`, audience: "Savers", product_ids: ["fixed-deposit"] });
const NOT_FOUND = /No (app|build)( of yours)? with id|No workspace of yours|No API key|No webhook|No sandbox hand-off/;

test("migration: every app made before workspaces lands in its owner's own workspace, owned by them; running it again changes nothing", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const { user: ana } = await store.createUser("Ana", ["developer"]);
  const { user: ben } = await store.createUser("Ben", ["developer"]);
  // Apps as they were: no workspace.
  for (const [owner, name] of [
    [ana, "A1"],
    [ana, "A2"],
    [ben, "B1"],
  ])
    await pg.query(
      "INSERT INTO financial_products.apps (id, owner_id, name, description, audience, product_ids, status) VALUES ($1, $2, $3, 'd', 'a', '{}', 'draft')",
      [randomUUID(), owner.id, name],
    );
  await Store.open(db, CATALOG); // the next start migrates them
  const rows = (
    await pg.query(
      `SELECT a.name AS app, w.name AS workspace, m.user_id, m.role FROM financial_products.apps a
       JOIN financial_products.workspaces w ON w.id = a.workspace_id JOIN financial_products.workspace_members m ON m.workspace_id = w.id ORDER BY a.name`,
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => [r.app, r.workspace, r.user_id, r.role]),
    [
      ["A1", "Ana's workspace", ana.id, "owner"],
      ["A2", "Ana's workspace", ana.id, "owner"],
      ["B1", "Ben's workspace", ben.id, "owner"],
    ],
  );
  const a = rows.filter((r) => r.app.startsWith("A"));
  assert.equal(new Set(a.map((r) => r.workspace)).size, 1, "one workspace per owner");
  await Store.open(db, CATALOG);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.workspaces")).rows[0].n, 2, "idempotent");
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'workspace_migrated'")).rows[0].n, 2);
});

test("apps go in a workspace the caller belongs to; list_my_apps shows every workspace's apps, or one", async () => {
  const { connect, call } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const first = (await call(ana.client, "create_app", app("Saver"))).data;
  const [mine] = (await call(ana.client, "list_workspaces")).data;
  assert.equal(first.workspace_id, mine.id, "no workspace named: her own, made for her");
  assert.equal(mine.name, "Ana's workspace");
  assert.equal(mine.role, "owner");
  const team = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  assert.match((await call(ana.client, "create_app", app("Ambiguous"))).data.error, /created several workspaces/);
  assert.equal(mine.personal, true, "list_workspaces marks her own");
  assert.equal((await call(ana.client, "list_workspaces")).data.find((w) => w.id === team.id).personal, false);
  const t1 = (await call(ana.client, "create_app", { ...app("Team app"), workspace_id: team.id })).data;
  assert.equal(t1.workspace_id, team.id);
  assert.equal(t1.owner_id, ana.user.id, "owner_id stays the creator");
  // Someone else's workspace is refused.
  const r = await call(ben.client, "create_app", { ...app("Sneaky"), workspace_id: team.id });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /No workspace of yours/);

  assert.deepEqual((await call(ana.client, "list_my_apps")).data.map((a) => a.name), ["Saver", "Team app"]);
  assert.deepEqual((await call(ana.client, "list_my_apps", { workspace_id: team.id })).data.map((a) => a.name), ["Team app"]);
  assert.equal((await call(ben.client, "list_my_apps", { workspace_id: team.id })).isError, true);
  assert.deepEqual((await call(ben.client, "list_my_apps")).data, []);
});

// The identity provider as sign-in sees it: tokens name people, each with one verified address.
function fakeClerk(people) {
  return {
    idPOAuthAccessToken: {
      async verify(token) {
        if (!people[token]) throw new Error("bad");
        return { subject: people[token].sub, revoked: false, expired: false };
      },
    },
    users: {
      async getUser(sub) {
        const p = Object.values(people).find((x) => x.sub === sub);
        return { primaryEmailAddressId: "e1", emailAddresses: [{ id: "e1", emailAddress: p.email, verification: { status: "verified" } }], firstName: p.email.split("@")[0], lastName: "", publicMetadata: p.metadata ?? {} };
      },
    },
  };
}
const clerkAuth = (store, people) =>
  new ClerkAuth({ secretKey: "sk_test_x", publishableKey: `pk_test_${Buffer.from("x.clerk.accounts.dev$").toString("base64")}`, publicUrl: "https://mcp.example.com", requireAudience: false }, store, fakeClerk(people));

// Signs someone in through the identity provider and connects them, as the studio would.
async function signIn(store, people, token) {
  const r = await clerkAuth(store, people).authenticate(token);
  if (!r.ok) return r;
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await createServer(store, r.user, {}).connect(sv);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return { ...r, client };
}

test("invites are explicit: someone new signs in as a user, sees the invite, and accepting a developer invite makes them a developer", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  const inv = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "Cara@Example.com", role: "admin" })).data;
  assert.equal(inv.email, "cara@example.com");
  assert.equal(inv.mynt_access, "new");
  assert.deepEqual((await store.getInvite("cara@example.com")).roles, ["consumer"], "let onto Mynt as a user, nothing more yet");
  const people = { t_cara: { sub: "clerk_cara", email: "cara@example.com" } };
  const cara = await signIn(store, people, "t_cara");
  assert.equal(cara.ok, true);
  assert.deepEqual(cara.user.roles, ["consumer"]);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.workspace_members WHERE user_id = $1", [cara.user.id])).rows[0].n, 0, "nobody joins by signing in");

  const { invitations } = (await call(cara.client, "list_my_invitations")).data;
  assert.equal(invitations.length, 1);
  const [i] = invitations;
  assert.deepEqual(i.workspace, { id: ws.id, name: "Team" });
  assert.deepEqual(i.invited_by, { name: "Ana", email: "ana@example.com" });
  assert.equal(i.role, "admin");
  assert.ok(i.grants.includes("Become a developer on Mynt") && i.grants.includes("Build and steer this workspace's apps"));
  assert.ok(Date.parse(i.expires_at) > Date.now());
  // Only the invitee can answer it.
  assert.match((await call(ana.client, "accept_workspace_invite", { invite_id: i.id })).data.error, /No open invitation to you/);
  assert.deepEqual((await call(cara.client, "accept_workspace_invite", { invite_id: i.id })).data.workspace_id, ws.id);
  assert.deepEqual((await store.getUser(cara.user.id)).roles, ["consumer", "developer"]);
  assert.deepEqual((await store.getInvite("cara@example.com")).roles, ["consumer", "developer"]);
  assert.equal((await pg.query("SELECT role FROM financial_products.workspace_members WHERE user_id = $1", [cara.user.id])).rows[0].role, "admin");
  // Signing in again keeps it; the identity provider sees the same roles.
  assert.deepEqual([...(await clerkAuth(store, people).authenticate("t_cara")).user.roles].sort(), ["consumer", "developer"]);
  assert.match((await call(cara.client, "accept_workspace_invite", { invite_id: i.id })).data.error, /No open invitation/);
  const audit = (await pg.query("SELECT details FROM financial_products.audit_log WHERE action = 'accept_workspace_invite'")).rows;
  assert.equal(audit[0].details.developer, "granted");
});

test("declining and withdrawing: a declined invite joins nobody; a withdrawn one closes the way onto Mynt it opened, unless it was changed since", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  // Declined.
  await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "dee@example.com" });
  const dee = await signIn(store, { t: { sub: "clerk_dee", email: "dee@example.com" } }, "t");
  const [di] = (await call(dee.client, "list_my_invitations")).data.invitations;
  assert.deepEqual((await call(dee.client, "decline_workspace_invite", { invite_id: di.id })).data, { declined: true });
  assert.deepEqual((await call(dee.client, "list_my_invitations")).data.invitations, []);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.workspace_members WHERE user_id = $1", [dee.user.id])).rows[0].n, 0);
  // Withdrawn before they ever signed in: no way onto Mynt either.
  const dan = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "dan@example.com" })).data;
  await call(ana.client, "revoke_workspace_invite", { invite_id: dan.id });
  assert.equal(await store.getInvite("dan@example.com"), undefined);
  assert.equal((await clerkAuth(store, { t: { sub: "clerk_dan", email: "dan@example.com" } }).authenticate("t")).error, "not_whitelisted");
  // Withdrawn after an admin changed the Mynt invite: the admin's choice stands.
  const fay = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "fay@example.com" })).data;
  await store.upsertInvite("fay@example.com", ["consumer", "vendor"]); // what invite_user does
  await call(ana.client, "revoke_workspace_invite", { invite_id: fay.id });
  assert.deepEqual((await store.getInvite("fay@example.com")).roles, ["consumer", "vendor"]);
  // An admin's own invite is never withdrawn by a workspace's.
  await store.upsertInvite("gus@example.com", ["developer"]);
  const gus = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "gus@example.com" })).data;
  assert.equal(gus.mynt_access, "already");
  await call(ana.client, "revoke_workspace_invite", { invite_id: gus.id });
  assert.deepEqual((await store.getInvite("gus@example.com")).roles, ["developer"]);
});

test("an open workspace invite opens Mynt's gate, as a user, even when it was made before the invite to Mynt existed", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "gil@example.com" });
  await pg.query("DELETE FROM financial_products.invites WHERE email = 'gil@example.com'"); // the Mynt invite never written
  const gil = await clerkAuth(store, { t: { sub: "clerk_gil", email: "gil@example.com" } }).authenticate("t");
  assert.equal(gil.ok, true);
  assert.deepEqual(gil.user.roles, ["consumer"]);
});

test("someone a Mynt admin revoked stays out, workspace invite or not", async () => {
  const { store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await store.blockSignup("eve@example.com", null); // what revoke_user leaves behind
  const inv = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "eve@example.com" })).data;
  assert.equal(inv.mynt_access, "blocked");
  assert.match(inv.note, /removed from Mynt by an admin/);
  assert.equal(await store.getInvite("eve@example.com"), undefined);
  const eve = await clerkAuth(store, { t: { sub: "clerk_eve", email: "eve@example.com" } }).authenticate("t");
  assert.equal(eve.ok, false);
  assert.equal(eve.error, "not_whitelisted");
});

test("a developer invite never promotes a firm's or an admin's account, or past roles an admin set after it; a user invite grants nothing", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  const invite = async (email, extra = {}) => (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email, ...extra })).data;
  const answer = async (email, sub) => {
    const who = await signIn(store, { t: { sub, email } }, "t");
    const [i] = (await call(who.client, "list_my_invitations")).data.invitations;
    const r = (await call(who.client, "accept_workspace_invite", { invite_id: i.id })).data;
    return { who, i, r, roles: [...(await store.getUser(who.user.id)).roles].sort() };
  };
  // A vendor: joins, roles unchanged, and the invitation says why.
  await store.upsertInvite("val@example.com", ["vendor"]);
  await invite("val@example.com", { role: "owner" });
  const val = await answer("val@example.com", "clerk_val");
  assert.ok(val.i.grants.includes("Your Mynt role stays as it is (you're a vendor)"));
  assert.deepEqual(val.roles, ["vendor"]);
  assert.equal(val.r.developer, "not_eligible");
  // An admin re-admitted Wes as a user after the invite was sent: the stale invite doesn't promote him.
  await invite("wes@example.com");
  await pg.query("UPDATE financial_products.workspace_invites SET created_at = now() - interval '1 hour' WHERE email = 'wes@example.com'");
  await store.upsertInvite("wes@example.com", ["consumer"]);
  await pg.query("UPDATE financial_products.invites SET admin_roles_at = now() WHERE email = 'wes@example.com'");
  const wes = await answer("wes@example.com", "clerk_wes");
  assert.deepEqual(wes.roles, ["consumer"]);
  // A user invite.
  await invite("uma@example.com", { mynt_role: "user" });
  const uma = await answer("uma@example.com", "clerk_uma");
  assert.deepEqual(uma.roles, ["consumer"]);
  assert.equal(uma.r.developer, "not_offered");
  const tools = (await uma.who.client.listTools()).tools.map((t) => t.name);
  for (const t of ["create_app", "start_build", "list_my_apps", "invite_to_workspace"]) assert.ok(!tools.includes(t), `a user doesn't get ${t}`);
  const granted = (await pg.query("SELECT roles FROM financial_products.users")).rows.flatMap((r) => r.roles);
  assert.ok(!granted.includes("admin") && !granted.includes("license_provider"));
});

test("new apps go only in a workspace the caller created, never one they were invited into, and two first apps at once make one workspace", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [ws.id, ben.user.id]);
  const [a, b] = await Promise.all([call(ben.client, "create_app", app("One")), call(ben.client, "create_app", app("Two"))]);
  assert.equal(a.data.workspace_id, b.data.workspace_id);
  assert.notEqual(a.data.workspace_id, ws.id, "not the workspace he was brought into, though he owns it");
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.workspaces WHERE created_by = $1", [ben.user.id])).rows[0].n, 1);
  void store;
});

test("any member invites, as a member only; the inviter picks developer or user on Mynt, never more; invites are capped per day", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const cara = await connect("Cara");
  const eve = await connect("Eve");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, cara.user.id]);

  // A member invites a member, with the user role on Mynt.
  const u = (await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: "uma@example.com", mynt_role: "user" })).data;
  assert.equal(u.role, "member");
  assert.equal(u.mynt_role, "user");
  assert.match(u.note, /adds no Mynt role/);
  assert.deepEqual((await store.getInvite("uma@example.com")).roles, ["consumer"]);
  assert.match((await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: "x@example.com", role: "admin" })).data.error, /owners and admins/);
  // Only into workspaces they're in; no Mynt role beyond the two.
  assert.match((await call(eve.client, "invite_to_workspace", { workspace_id: ws.id, email: "y@example.com" })).data.error, /No workspace of yours/);
  assert.equal((await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: "z@example.com", mynt_role: "admin" })).isError, true);


  // A member withdraws their own invite, not someone else's.
  const theirs = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "vic@example.com" })).data;
  assert.match((await call(cara.client, "revoke_workspace_invite", { invite_id: theirs.id })).data.error, /owners and admins/);
  const own = (await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: "wes@example.com" })).data;
  assert.equal((await call(cara.client, "revoke_workspace_invite", { invite_id: own.id })).data.revoked, true);

  // 20 a day each.
  for (let i = 0; i < 18; i++) assert.equal((await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: `p${i}@example.com` })).isError, false, `invite ${i}`);
  assert.match((await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: "one-too-many@example.com" })).data.error, /20 workspace invites in the last day/);
  assert.equal((await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "still-fine@example.com" })).isError, false, "the cap is per inviter");
  const audited = (await pg.query("SELECT details FROM financial_products.audit_log WHERE action = 'invite_to_workspace' AND actor_id = $1", [cara.user.id])).rows;
  assert.equal(audited.length, 20);
  assert.equal(audited[0].details.mynt_role, "user");
});

test("roles: members can't manage members; only owners make owners; the last owner can't leave, be demoted or be removed", async () => {
  const { pg, connect, call } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const cara = await connect("Cara");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  const join = async (u, role) =>
    pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [ws.id, u.user.id, role]);
  await join(ben, "admin");
  await join(cara, "member");

  // A member manages nobody (they may invite members: see the next test).
  for (const [tool, args] of [
    ["invite_to_workspace", { workspace_id: ws.id, email: "x@example.com", role: "admin" }],
    ["change_member_role", { workspace_id: ws.id, user_id: ben.user.id, role: "member" }],
    ["remove_workspace_member", { workspace_id: ws.id, user_id: ben.user.id }],
    ["rename_workspace", { workspace_id: ws.id, name: "Mine now" }],
  ])
    assert.match((await call(cara.client, tool, args)).data.error, /Only the workspace's owners and admins/, tool);
  // An admin manages members but not owners.
  assert.match((await call(ben.client, "invite_to_workspace", { workspace_id: ws.id, email: "o@example.com", role: "owner" })).data.error, /Only an owner/);
  assert.match((await call(ben.client, "change_member_role", { workspace_id: ws.id, user_id: cara.user.id, role: "owner" })).data.error, /Only an owner/);
  assert.match((await call(ben.client, "change_member_role", { workspace_id: ws.id, user_id: ana.user.id, role: "member" })).data.error, /Only an owner/);
  assert.match((await call(ben.client, "remove_workspace_member", { workspace_id: ws.id, user_id: ana.user.id })).data.error, /Only an owner/);
  assert.equal((await call(ben.client, "change_member_role", { workspace_id: ws.id, user_id: cara.user.id, role: "admin" })).isError, false);
  assert.equal((await call(ben.client, "rename_workspace", { workspace_id: ws.id, name: "Team 2" })).data.name, "Team 2");

  // The last owner.
  assert.match((await call(ana.client, "leave_workspace", { workspace_id: ws.id })).data.error, /last owner/);
  assert.match((await call(ana.client, "change_member_role", { workspace_id: ws.id, user_id: ana.user.id, role: "admin" })).data.error, /needs an owner/);
  // With a second owner, the first may step down or leave.
  assert.equal((await call(ana.client, "change_member_role", { workspace_id: ws.id, user_id: ben.user.id, role: "owner" })).isError, false);
  assert.equal((await call(ana.client, "change_member_role", { workspace_id: ws.id, user_id: ana.user.id, role: "member" })).isError, false);
  assert.match((await call(ben.client, "remove_workspace_member", { workspace_id: ws.id, user_id: ben.user.id })).data.error, /leave_workspace/);
  assert.match((await call(ben.client, "leave_workspace", { workspace_id: ws.id })).data.error, /last owner/);
  assert.equal((await call(ben.client, "remove_workspace_member", { workspace_id: ws.id, user_id: cara.user.id })).data.removed, true);
  assert.equal((await call(ana.client, "leave_workspace", { workspace_id: ws.id })).data.left, true);
  // Gone means gone.
  assert.match((await call(ana.client, "list_workspace_members", { workspace_id: ws.id })).data.error, /No workspace of yours/);
  assert.match((await call(cara.client, "rename_workspace", { workspace_id: ws.id, name: "x" })).data.error, /No workspace of yours/);

  const actions = (await pg.query("SELECT action FROM financial_products.audit_log WHERE target = $1 ORDER BY created_at", [ws.id])).rows.map((r) => r.action);
  assert.deepEqual(actions, [
    "create_workspace",
    "change_member_role",
    "rename_workspace",
    "change_member_role",
    "change_member_role",
    "remove_workspace_member",
    "workspace_offboard",
    "leave_workspace",
    "workspace_offboard",
  ]);
});

test("isolation: nobody outside an app's workspace can see or act on it or its builds, through any tool; members can", async () => {
  const { pg, connect, call, build } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben"); // Ana's teammate
  const eve = await connect("Eve"); // in no workspace of theirs
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, ben.user.id]);
  const a = (await call(ana.client, "create_app", { ...app("Team app"), workspace_id: ws.id })).data;
  const b = await build(ana.user.id, a.id, "succeeded");
  const running = await build(ana.user.id, a.id, "coding");
  const key = (await call(ana.client, "create_api_key", { app_id: a.id, environment: "sandbox", label: "k" })).data;
  const hook = (await call(ana.client, "create_webhook", { app_id: a.id, url: "http://127.0.0.1:9/x", events: ["product.version_published"] })).data;
  assert.ok(hook.id, JSON.stringify(hook));
  const handoff = randomUUID();
  await pg.query(
    "INSERT INTO financial_products.handoffs (id, app_id, product_id, action, sandbox, status, redirect_url) VALUES ($1, $2, 'fixed-deposit', 'deep_link', true, 'started', 'https://x.example')",
    [handoff, a.id],
  );

  const appTools = [
    ["update_app", { app_id: a.id, name: "Renamed" }],
    ["check_experience", { app_id: a.id }],
    ["preview_app", { app_id: a.id }],
    ["request_product_access", { app_id: a.id, product_id: "fixed-deposit" }],
    ["publish_app", { app_id: a.id }],
    ["create_api_key", { app_id: a.id, environment: "sandbox", label: "k" }],
    ["create_webhook", { app_id: a.id, url: "https://hooks.example.com/x", events: ["product.version_published"] }],
    ["list_webhooks", { app_id: a.id }],
    ["list_api_keys", { app_id: a.id }],
    ["rotate_api_key", { key_id: key.id }],
    ["revoke_api_key", { key_id: key.id }],
    ["rotate_webhook_secret", { webhook_id: hook.id }],
    ["list_webhook_deliveries", { webhook_id: hook.id }],
    ["delete_webhook", { webhook_id: hook.id }],
    ["simulate_handoff", { handoff_id: handoff, outcome: "completed" }],
    ["list_my_apps", { workspace_id: ws.id }],
    ["get_developer_dashboard", { workspace_id: ws.id }],
    ["create_test_consumer", { app_id: a.id, label: "t" }],
    ["release_app", { app_id: a.id, version: "1.0.0", changelog: "first" }],
    ["list_app_releases", { app_id: a.id }],
    ["rollback_app", { app_id: a.id, version: "1.0.0" }],
    ["get_app_metrics", { app_id: a.id }],
    ["set_experience", { app_id: a.id, experience: null }],
    ["render_experience_preview", { app_id: a.id }],
    ["save_journey", { app_id: a.id, journey: {} }],
    ["list_journeys", { app_id: a.id }],
    ["get_app_repository", { app_id: a.id }],
    ["set_app_repository", { app_id: a.id, repository: "acme/web" }],
    ["start_build", { app_id: a.id, goal: "Add a savings calculator" }],
    ["deploy_app", { app_id: a.id, build_id: b }],
    ["undeploy_app", { app_id: a.id }],
    ["app_status", { app_id: a.id }],
    ["app_logs", { app_id: a.id }],
    ["app_run", { app_id: a.id, command: "true" }],
    ["restart_app", { app_id: a.id }],
  ];
  const buildTools = [
    ["get_build", { build_id: b }],
    ["get_build_activity", { build_id: b }],
    ["steer_build", { build_id: running, message: "use the design system" }],
    ["finish_build", { build_id: running }],
    ["stop_build", { build_id: running }],
    ["reopen_sandbox", { build_id: b }],
    ["close_sandbox", { build_id: b }],
    ["open_sandbox_editor", { build_id: b }],
    ["sandbox_run", { build_id: b, command: "ls" }],
    ["sandbox_files", { build_id: b }],
    ["sandbox_diff", { build_id: b }],
    ["start_build", { goal: "Carry on from that build", continue_from: b }],
  ];
  const refused = [];
  for (const [tool, args] of [...appTools, ...buildTools]) {
    const r = await call(eve.client, tool, args);
    if (!(r.isError && NOT_FOUND.test(r.data.error))) refused.push(`${tool}: ${JSON.stringify(r.data).slice(0, 160)}`);
  }
  assert.deepEqual(refused, [], "every tool refuses a non-member as if the app or build didn't exist");
  // Read-only listings show them nothing of it.
  assert.deepEqual((await call(eve.client, "list_builds")).data.builds, []);
  assert.deepEqual((await call(eve.client, "list_builds", { app_id: a.id })).data.builds, []);
  assert.deepEqual((await call(eve.client, "list_webhooks")).data, []);
  assert.deepEqual((await call(eve.client, "get_developer_dashboard")).data.apps, []);
  assert.equal((await call(eve.client, "get_developer_dashboard", { workspace_id: ws.id })).isError, true);

  // The teammate gets past every one of those checks (what happens next is the tool's own business).
  const blocked = [];
  for (const [tool, args] of [...appTools, ...buildTools]) {
    const r = await call(ben.client, tool, args);
    if (r.isError && NOT_FOUND.test(r.data.error)) blocked.push(`${tool}: ${r.data.error}`);
  }
  assert.deepEqual(blocked, [], "a member reaches every app and build of the workspace");
  const seen = (await call(ben.client, "list_builds")).data.builds.map((x) => x.id);
  assert.ok(seen.includes(b) && seen.includes(running), "a member lists the builds teammates started");
  assert.deepEqual((await call(ben.client, "get_developer_dashboard", { workspace_id: ws.id })).data.apps.map((x) => x.name), ["Renamed"]);

  // Leaving cuts it off at once, for the builds they started too.
  const mine = await build(ben.user.id, a.id, "succeeded");
  await pg.query("DELETE FROM financial_products.workspace_members WHERE user_id = $1", [ben.user.id]);
  assert.match((await call(ben.client, "get_build", { build_id: mine })).data.error, NOT_FOUND);
  assert.match((await call(ben.client, "update_app", { app_id: a.id, name: "x" })).data.error, NOT_FOUND);
});

test("the workspace's monthly build budget is shared by everyone building its apps, beside each developer's own", async () => {
  const { pg, connect, call, build } = await setup({ env: { BUILD_WORKSPACE_MONTHLY_CAP_USD: "12", BUILD_CAP_USD: "5" } });
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, ben.user.id]);
  const a = (await call(ana.client, "create_app", { ...app("Team app"), workspace_id: ws.id })).data;
  const spent = await build(ana.user.id, a.id, "succeeded");
  await pg.query("UPDATE financial_products.build_runs SET cost_usd = 10 WHERE id = $1", [spent]);
  // Ben has spent nothing himself, but the workspace has US$2 left.
  const r = await call(ben.client, "start_build", { app_id: a.id, goal: "Add a savings calculator" });
  assert.match(r.data.error, /workspace's remaining build budget .*US\$2\.00 of US\$12/);
  const small = await call(ben.client, "start_build", { app_id: a.id, goal: "Add a savings calculator", cap_usd: 2 });
  assert.equal(small.isError, false, JSON.stringify(small.data));
  // An app of another workspace isn't held back by this one's spend (and a member's new app goes in their own workspace).
  const own = (await call(ben.client, "create_app", app("Ben's own"))).data;
  assert.notEqual(own.workspace_id, ws.id);
  assert.equal((await call(ben.client, "start_build", { app_id: own.id, goal: "Add a savings calculator" })).isError, false);
});

test("stages: idea until a verified build, staging with one or a deployment that isn't live, production when published and running", async () => {
  const { pg, store } = await setup();
  await pg.exec("CREATE TABLE IF NOT EXISTS financial_products.hosted_apps (app_id uuid PRIMARY KEY, status text NOT NULL)");
  const { user } = await store.createUser("Ana", ["developer"]);
  const mk = async (name, status = "draft") => {
    const a = await store.createApp(user.id, { ...app(name) });
    if (status !== "draft") await pg.query("UPDATE financial_products.apps SET status = $2 WHERE id = $1", [a.id, status]);
    return { ...a, status };
  };
  const idea = await mk("idea");
  const failed = await mk("failed build");
  const built = await mk("built");
  const sandboxDeploy = await mk("deployed draft");
  const stopped = await mk("published but stopped", "published");
  const live = await mk("live", "published");
  const b = (appId, status) =>
    pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd) VALUES ($1, $2, $3, 'g', $4, 5)", [randomUUID(), user.id, appId, status]);
  await b(failed.id, "failed");
  await b(built.id, "succeeded");
  for (const a of [sandboxDeploy, live]) await b(a.id, "succeeded");
  await pg.query("INSERT INTO financial_products.hosted_apps (app_id, status) VALUES ($1, 'running'), ($2, 'stopped'), ($3, 'running')", [sandboxDeploy.id, stopped.id, live.id]);
  const stages = await appStages(pg, [idea, failed, built, sandboxDeploy, stopped, live]);
  assert.deepEqual(
    [idea, failed, built, sandboxDeploy, stopped, live].map((a) => [a.name, stages.get(a.id)]),
    [
      ["idea", "idea"],
      ["failed build", "idea"],
      ["built", "staging"],
      ["deployed draft", "staging"],
      ["published but stopped", "staging"],
      ["live", "production"],
    ],
  );
  // Without the builds and hosting services' tables, every app is an idea.
  const bare = new PGlite();
  await Store.open({ query: (s, p) => bare.query(s, p), exec: (s) => bare.exec(s), close: () => bare.close() }, CATALOG);
  assert.equal((await appStages(bare, [idea])).get(idea.id), "idea");
});

test("leaving cuts access at once: the leaver's keys revoked, webhooks disabled, builds and reopened sandboxes stopped, programs to an owner; live keys are owners' and admins'", async () => {
  const { pg, store, connect, call, build } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, ben.user.id]);
  const a = (await call(ana.client, "create_app", { ...app("Team app"), workspace_id: ws.id })).data;
  // Members make sandbox keys only, and don't rotate.
  assert.match((await call(ben.client, "create_api_key", { app_id: a.id, environment: "live", label: "prod" })).data.error, /owners and admins create live keys/);
  const live = (await call(ana.client, "create_api_key", { app_id: a.id, environment: "live", label: "prod" })).data;
  assert.match((await call(ben.client, "rotate_api_key", { key_id: live.id })).data.error, /owners and admins rotate/);
  const bensKey = (await call(ben.client, "create_api_key", { app_id: a.id, environment: "sandbox", label: "bens" })).data;
  const bensHook = (await call(ben.client, "create_webhook", { app_id: a.id, url: "http://127.0.0.1:9/ben", events: ["product.version_published"] })).data;
  const anasHook = (await call(ana.client, "create_webhook", { app_id: a.id, url: "http://127.0.0.1:9/ana", events: ["product.version_published"] })).data;
  const runningBuild = await build(ben.user.id, a.id, "coding");
  await pg.query("UPDATE financial_products.build_runs SET sandbox_id = 'sbx-run' WHERE id = $1", [runningBuild]);
  const reopened = await build(ben.user.id, a.id, "succeeded");
  await pg.query("UPDATE financial_products.build_runs SET box_sandbox_id = 'sbx-box', box_until = now() + interval '1 hour' WHERE id = $1", [reopened]);
  await pg.exec("CREATE TABLE IF NOT EXISTS financial_products.solana_programs (program_id text PRIMARY KEY, owner_id uuid, app_id uuid)");
  await pg.query("INSERT INTO financial_products.solana_programs (program_id, owner_id, app_id) VALUES ('Prog1111', $1, $2)", [ben.user.id, a.id]);

  const r = (await call(ana.client, "remove_workspace_member", { workspace_id: ws.id, user_id: ben.user.id })).data;
  assert.equal(r.removed, true);
  assert.deepEqual(r.access_cut.revoked_api_keys, [bensKey.id]);
  assert.deepEqual(r.access_cut.disabled_webhooks, [bensHook.id]);
  assert.deepEqual([...r.access_cut.stopped_builds].sort(), [runningBuild, reopened].sort());
  assert.deepEqual(r.access_cut.programs_to_owner, ["Prog1111"]);
  assert.equal((await store.getApiKey(bensKey.id)).status, "revoked");
  assert.equal((await store.getApiKey(live.id)).status, "active", "others' keys stay");
  const hooks = (await pg.query("SELECT id::text AS id, disabled_at FROM financial_products.webhooks")).rows;
  assert.ok(hooks.find((h) => h.id === bensHook.id).disabled_at && !hooks.find((h) => h.id === anasHook.id).disabled_at);
  // An owner turns Ben's webhook back on: with a new secret, which only she now holds.
  const back = (await call(ana.client, "enable_webhook", { webhook_id: bensHook.id })).data;
  assert.equal(back.enabled, true);
  assert.match(back.secret, /^whsec_/);
  const builds = (await pg.query("SELECT id::text AS id, status, box_sandbox_id FROM financial_products.build_runs WHERE developer_id = $1", [ben.user.id])).rows;
  assert.equal(builds.find((x) => x.id === runningBuild).status, "stopped");
  assert.equal(builds.find((x) => x.id === reopened).box_sandbox_id, null);
  assert.equal((await pg.query("SELECT owner_id FROM financial_products.solana_programs")).rows[0].owner_id, ana.user.id);
  // And Ben reaches none of it any more.
  assert.match((await call(ben.client, "get_build", { build_id: runningBuild })).data.error, NOT_FOUND);
  assert.match((await call(ben.client, "list_api_keys", { app_id: a.id })).data.error, NOT_FOUND);
});

test("a teammate's build: read-only, unless they may drive its sandbox (their own approved connection, the app's managed repository, or no repository); steering and reopening stay its starter's", async () => {
  const { pg, connect, call, build } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, ben.user.id]);
  const a = (await call(ana.client, "create_app", { ...app("Team app"), workspace_id: ws.id })).data;
  const own = await build(ana.user.id, a.id, "coding");
  await pg.query("UPDATE financial_products.build_runs SET repository = 'acme/web', sandbox_id = 'sbx-a' WHERE id = $1", [own]);
  const DRIVE = /connect it yourself/;
  // Reading is fine.
  for (const [tool, args] of [["get_build", { build_id: own }], ["get_build_activity", { build_id: own }], ["sandbox_files", { build_id: own }], ["sandbox_diff", { build_id: own }]]) {
    const r = await call(ben.client, tool, args);
    assert.ok(!(r.isError && (DRIVE.test(r.data.error) || NOT_FOUND.test(r.data.error))), tool);
  }
  // Driving needs his own approved connection to the repository the sandbox can push to.
  assert.match((await call(ben.client, "sandbox_run", { build_id: own, command: "ls" })).data.error, DRIVE);
  assert.match((await call(ben.client, "open_sandbox_editor", { build_id: own })).data.error, DRIVE);
  await pg.query("INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id, approval) VALUES ($1, 'acme/web', 1, 'pending')", [ben.user.id]);
  assert.match((await call(ben.client, "sandbox_run", { build_id: own, command: "ls" })).data.error, DRIVE, "pending isn't approved");
  await pg.query("UPDATE financial_products.repo_connections SET approval = 'approved' WHERE developer_id = $1", [ben.user.id]);
  const r = await call(ben.client, "sandbox_run", { build_id: own, command: "ls" });
  assert.ok(!(r.isError && DRIVE.test(r.data.error)), JSON.stringify(r.data));
  // A build with no repository holds no credential.
  const plain = await build(ana.user.id, a.id, "coding");
  const p = await call(ben.client, "sandbox_run", { build_id: plain, command: "ls" });
  assert.ok(!(p.isError && DRIVE.test(p.data.error)));
  // Files only inside the app's directory.
  for (const path of ["/etc/passwd", "../../secrets", "src/../../x", "~/.ssh"])
    assert.match((await call(ben.client, "sandbox_files", { build_id: own, path })).data.error, /inside the app's directory/, path);
  // Steering and reopening spend the starter's budget: only theirs.
  assert.match((await call(ben.client, "steer_build", { build_id: own, message: "use the design system" })).data.error, /Only the developer who started this build/);
  assert.match((await call(ben.client, "reopen_sandbox", { build_id: own })).data.error, /Only the developer who started this build/);
});

test("someone removed can't come back through an invite they sent, and an invite stands only while its sender may still send it", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const cara = await connect("Cara");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')", [ws.id, ben.user.id, cara.user.id]);
  // Ben invites a second address of his own, then is removed: the invite goes with him.
  const alt = (await call(ben.client, "invite_to_workspace", { workspace_id: ws.id, email: "ben.alt@example.com" })).data;
  const cut = (await call(ana.client, "remove_workspace_member", { workspace_id: ws.id, user_id: ben.user.id })).data.access_cut;
  assert.deepEqual(cut.revoked_invites, [alt.id]);
  assert.equal(await store.getInvite("ben.alt@example.com"), undefined, "and the way onto Mynt it opened");
  // Cara (an admin) invites an admin, then is made a member: the invite no longer stands.
  const adm = (await call(cara.client, "invite_to_workspace", { workspace_id: ws.id, email: "dee@example.com", role: "admin" })).data;
  await call(ana.client, "change_member_role", { workspace_id: ws.id, user_id: cara.user.id, role: "member" });
  const dee = await signIn(store, { t: { sub: "clerk_dee", email: "dee@example.com" } }, "t");
  const r = await call(dee.client, "accept_workspace_invite", { invite_id: adm.id });
  assert.match(r.data.error, /no longer stands/);
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.workspace_members WHERE user_id = $1", [dee.user.id])).rows[0].n, 0);
  assert.deepEqual((await call(dee.client, "list_my_invitations")).data.invitations, [], "voided");
  // A user invite is a member's only.
  assert.match((await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "u@example.com", role: "admin", mynt_role: "user" })).data.error, /can only be a member/);
});

test("secrets someone was handed go with them: keys whose secret they rotated are revoked, webhook secrets they got are rotated; members don't rotate", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ben = await connect("Ben");
  const mem = await connect("Mem");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [ws.id, ben.user.id, mem.user.id]);
  const a = (await call(ana.client, "create_app", { ...app("Team app"), workspace_id: ws.id })).data;
  const key = (await call(ana.client, "create_api_key", { app_id: a.id, environment: "live", label: "prod" })).data;
  const hook = (await call(ana.client, "create_webhook", { app_id: a.id, url: "http://127.0.0.1:9/ana", events: ["product.version_published"] })).data;
  assert.match((await call(mem.client, "rotate_webhook_secret", { webhook_id: hook.id })).data.error, /owners and admins rotate/);
  // Ben (an admin) rotates both: he holds their current secrets.
  await call(ben.client, "rotate_api_key", { key_id: key.id });
  const bensSecret = (await call(ben.client, "rotate_webhook_secret", { webhook_id: hook.id })).data.secret;
  const before = (await pg.query("SELECT secret FROM financial_products.webhooks WHERE id = $1", [hook.id])).rows[0].secret;
  assert.equal(before, bensSecret);
  const cut = (await call(ana.client, "remove_workspace_member", { workspace_id: ws.id, user_id: ben.user.id })).data.access_cut;
  assert.deepEqual(cut.revoked_api_keys, [key.id]);
  assert.deepEqual(cut.rotated_webhook_secrets, [hook.id]);
  assert.equal((await store.getApiKey(key.id)).status, "revoked");
  const after = (await pg.query("SELECT secret, disabled_at, last_secret_issued_to FROM financial_products.webhooks WHERE id = $1", [hook.id])).rows[0];
  assert.notEqual(after.secret, bensSecret, "Ben's secret no longer signs anything");
  assert.equal(after.disabled_at, null, "Ana's webhook keeps delivering");
  assert.equal(after.last_secret_issued_to, null);
});
