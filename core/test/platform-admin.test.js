import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { CATALOG, inProduction } from "./helpers.js";

// The platform admin's reads (platform-admin.ts): every workspace, app and financial product across Mynt, paged and
// read-only, for admins only. The operational settings are platform-settings.test.js's.

const idleSandboxes = {
  async createSandbox() {
    return { id: "sbx", state: "provisioning" };
  },
  async getSandbox() {
    return undefined;
  },
  async stop() {},
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

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const builds = await BuildService.open(db, store, idleSandboxes, null, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } });
  const connect = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const email = `${name.toLowerCase()}@example.com`;
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, email]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, { ...user, email }, { builds }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return { user: { ...user, email }, client };
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  return { pg, store, connect, call };
}

const ADMIN_READS = ["list_all_workspaces", "admin_get_workspace", "list_all_apps", "admin_get_app", "list_all_products", "get_platform_settings"];

test("admins read every workspace, app and product across Mynt; nobody else has the tools", async () => {
  const { pg, store, connect, call } = await setup();
  const admin = await connect("Ada", ["admin"]);
  const ana = await connect("Ana", ["developer"]);
  const ben = await connect("Ben", ["developer"]);
  for (const role of [["developer"], ["license_provider"], ["vendor"], ["consumer"]]) {
    const other = await connect(`U${randomUUID().slice(0, 6)}`, role);
    const names = (await other.client.listTools()).tools.map((t) => t.name);
    for (const t of ADMIN_READS) assert.ok(!names.includes(t), `${role} doesn't get ${t}`);
  }
  const adminNames = (await admin.client.listTools()).tools.map((t) => t.name);
  for (const t of ADMIN_READS) assert.ok(adminNames.includes(t), `admins get ${t}`);

  // Ana's app in her own workspace (made for her), Ben's in a team workspace he owns, with Ana invited.
  const a1 = (await call(ana.client, "create_app", { name: "Saver", description: "Saver app", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const team = (await call(ben.client, "create_workspace", { name: "Team Ben" })).data;
  const b1 = (await call(ben.client, "create_app", { name: "Lender", description: "Lender app", audience: "Borrowers", product_ids: ["fixed-deposit"], workspace_id: team.id })).data;
  assert.ok(b1.id, JSON.stringify(b1));
  await call(ben.client, "invite_to_workspace", { workspace_id: team.id, email: "ana@example.com", role: "member" });
  await inProduction(store, b1.id);
  await pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd, preview_url) VALUES ($1, $2, $3, 'build the lender', 'succeeded', 5, 'https://preview.secret.example.com/x')", [randomUUID(), ben.user.id, b1.id]);

  const all = (await call(admin.client, "list_all_workspaces")).data;
  assert.equal(all.total, 2);
  const t = all.workspaces.find((w) => w.id === team.id);
  assert.equal(t.name, "Team Ben");
  assert.equal(t.status, "active");
  assert.equal(t.owner.email, "ben@example.com");
  assert.equal(t.members, 1);
  assert.equal(t.apps, 1);
  assert.equal((await call(admin.client, "list_all_workspaces", { query: "team" })).data.total, 1);
  assert.equal((await call(admin.client, "list_all_workspaces", { query: "ana@example" })).data.workspaces[0].owner.email, "ana@example.com");
  assert.equal((await call(admin.client, "list_all_workspaces", { limit: 1, offset: 1 })).data.workspaces.length, 1);
  // Archived and frozen are statuses, filterable.
  await pg.query("UPDATE financial_products.workspaces SET org_missing_at = now() WHERE id = $1", [team.id]);
  assert.deepEqual((await call(admin.client, "list_all_workspaces", { status: "frozen" })).data.workspaces.map((w) => w.id), [team.id]);

  const detail = (await call(admin.client, "admin_get_workspace", { workspace_id: team.id })).data;
  assert.deepEqual(detail.members.map((m) => [m.email, m.role]), [["ben@example.com", "owner"]]);
  assert.deepEqual(detail.apps.map((a) => [a.name, a.stage]), [["Lender", "production"]]);
  assert.equal(detail.apps[0].latest_build.status, "succeeded");
  assert.deepEqual(detail.invitations.map((i) => [i.email, i.status]), [["ana@example.com", "open"]]);
  assert.ok(detail.activity.length > 0, "the workspace's audit trail");
  assert.ok(!JSON.stringify(detail).includes("preview.secret"), "never a preview link");
  assert.equal((await call(admin.client, "admin_get_workspace", { workspace_id: randomUUID() })).isError, true);

  const apps = (await call(admin.client, "list_all_apps")).data;
  assert.equal(apps.total, 2);
  assert.deepEqual(apps.apps.map((a) => a.name).sort(), ["Lender", "Saver"]);
  const lender = apps.apps.find((a) => a.id === b1.id);
  assert.equal(lender.workspace.name, "Team Ben");
  assert.equal(lender.stage, "production");
  assert.equal(lender.builds, 1);
  assert.equal(lender.hosting, null);
  assert.deepEqual((await call(admin.client, "list_all_apps", { stage: "idea" })).data.apps.map((a) => a.id), [a1.id]);
  assert.deepEqual((await call(admin.client, "list_all_apps", { workspace_id: team.id })).data.apps.map((a) => a.id), [b1.id]);
  assert.deepEqual((await call(admin.client, "list_all_apps", { query: "lend" })).data.apps.map((a) => a.id), [b1.id]);

  const one = (await call(admin.client, "admin_get_app", { app_id: b1.id })).data;
  assert.equal(one.app.products[0].id, "fixed-deposit");
  assert.equal(one.builds[0].goal, "build the lender");
  assert.equal(one.hosting, null);
  assert.ok(!JSON.stringify(one).includes("preview.secret"), "never a preview link");

  // Products across firms: the bundled ones have no owner (Mynt's reference products).
  const products = (await call(admin.client, "list_all_products", { limit: 500 })).data;
  assert.ok(products.total >= 1);
  for (const p of products.products) {
    assert.ok(["idea", "staging", "production"].includes(p.stage));
    assert.ok(Array.isArray(p.sponsors));
  }
  const published = (await call(admin.client, "list_all_products", { status: "published" })).data;
  assert.ok(published.products.every((p) => p.status === "published" && p.stage === "production"));
  assert.equal((await call(admin.client, "list_all_products", { query: "zzz-nothing" })).data.total, 0);
});

test("operational settings: the admin's read still lists the nine settings first (platform-settings.test.js has the rest)", async () => {
  const { connect, call } = await setup();
  const admin = await connect("Ada", ["admin"]);
  const got = (await call(admin.client, "get_platform_settings")).data;
  assert.deepEqual(got.settings.slice(0, 9).map((s) => s.key), ["BUILD_CAP_USD", "BUILD_MONTHLY_CAP_USD", "BUILD_AUDIT", "BUILD_AUDIT_MODEL", "BUILD_AUDIT_CAP_USD", "BUILD_AUDIT_MINUTES", "BUILD_AUDIT_WORKFLOWS", "EXPLORE_CAP_USD", "FREESTYLE_USD_PER_HOUR"]);
  assert.equal(got.settings.length, 22);
});
