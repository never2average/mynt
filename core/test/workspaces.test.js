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
  async createSandbox() {
    return { id: "sbx", state: "provisioning" };
  },
  async getSandbox() {
    return undefined;
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
const NOT_FOUND = /No (app|build)( of yours)? with id|No workspace of yours/;

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
  assert.match((await call(ana.client, "create_app", app("Ambiguous"))).data.error, /own several workspaces/);
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

test("invites become memberships when the invited, verified email signs in; revoked ones never do", async () => {
  const { pg, store, connect, call } = await setup();
  const ana = await connect("Ana");
  const ws = (await call(ana.client, "create_workspace", { name: "Team" })).data;
  const inv = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "Cara@Example.com", role: "admin" })).data;
  assert.equal(inv.email, "cara@example.com");
  assert.match(inv.note, /can't sign in to Mynt yet/, "a workspace invite doesn't let anyone onto Mynt itself");
  assert.match((await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "cara@example.com" })).data.error, /already has an open invite/);
  const dropped = (await call(ana.client, "invite_to_workspace", { workspace_id: ws.id, email: "dan@example.com" })).data;
  assert.deepEqual((await call(ana.client, "revoke_workspace_invite", { invite_id: dropped.id })).data, { invite_id: dropped.id, revoked: true });

  // Cara and Dan sign in through the identity provider with verified addresses (Mynt's own invites let them in).
  await store.upsertInvite("cara@example.com", ["developer"]);
  await store.upsertInvite("dan@example.com", ["developer"]);
  const people = {
    t_cara: { sub: "clerk_cara", email: "cara@example.com" },
    t_dan: { sub: "clerk_dan", email: "dan@example.com" },
  };
  const clerk = {
    idPOAuthAccessToken: {
      async verify(token) {
        if (!people[token]) throw new Error("bad");
        return { subject: people[token].sub, revoked: false, expired: false };
      },
    },
    users: {
      async getUser(sub) {
        const p = Object.values(people).find((x) => x.sub === sub);
        return { primaryEmailAddressId: "e1", emailAddresses: [{ id: "e1", emailAddress: p.email, verification: { status: "verified" } }], firstName: p.email.split("@")[0], lastName: "", publicMetadata: {} };
      },
    },
  };
  const auth = new ClerkAuth({ secretKey: "sk_test_x", publishableKey: `pk_test_${Buffer.from("x.clerk.accounts.dev$").toString("base64")}`, publicUrl: "https://mcp.example.com", requireAudience: false }, store, clerk);
  const cara = await auth.authenticate("t_cara");
  const dan = await auth.authenticate("t_dan");
  assert.equal(cara.ok, true);
  assert.equal(dan.ok, true);
  const members = (await call(ana.client, "list_workspace_members", { workspace_id: ws.id })).data;
  assert.deepEqual(members.members.map((m) => [m.email, m.role]).sort(), [["ana@example.com", "owner"], ["cara@example.com", "admin"]]);
  assert.deepEqual(members.open_invites, []);
  // Signing in again changes nothing; the acceptance is audited.
  await auth.authenticate("t_cara");
  const audits = (await pg.query("SELECT actor_id, details FROM financial_products.audit_log WHERE action = 'accept_workspace_invite'")).rows;
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor_id, cara.user.id);
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

  // A member manages nobody.
  for (const [tool, args] of [
    ["invite_to_workspace", { workspace_id: ws.id, email: "x@example.com" }],
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
  assert.deepEqual((await call(ben.client, "remove_workspace_member", { workspace_id: ws.id, user_id: cara.user.id })).data, { workspace_id: ws.id, user_id: cara.user.id, removed: true });
  assert.deepEqual((await call(ana.client, "leave_workspace", { workspace_id: ws.id })).data, { workspace_id: ws.id, left: true });
  // Gone means gone.
  assert.match((await call(ana.client, "list_workspace_members", { workspace_id: ws.id })).data.error, /No workspace of yours/);
  assert.match((await call(cara.client, "rename_workspace", { workspace_id: ws.id, name: "x" })).data.error, /No workspace of yours/);

  const actions = (await pg.query("SELECT action FROM financial_products.audit_log WHERE target = $1 ORDER BY created_at", [ws.id])).rows.map((r) => r.action);
  assert.deepEqual(actions, ["create_workspace", "change_member_role", "rename_workspace", "change_member_role", "change_member_role", "remove_workspace_member", "leave_workspace"]);
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

  const appTools = [
    ["update_app", { app_id: a.id, name: "Renamed" }],
    ["check_experience", { app_id: a.id }],
    ["preview_app", { app_id: a.id }],
    ["request_product_access", { app_id: a.id, product_id: "fixed-deposit" }],
    ["publish_app", { app_id: a.id }],
    ["create_api_key", { app_id: a.id, environment: "sandbox", label: "k" }],
    ["create_webhook", { app_id: a.id, url: "https://hooks.example.com/x", events: ["product.version_published"] }],
    ["list_webhooks", { app_id: a.id }],
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
