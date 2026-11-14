import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { AUDIT_ACTION_CLASSES, AUDIT_ACTION_TEMPLATES, AUDIT_CLASSES, AUDIT_CLASS_LISTS, auditClass } from "../dist/audit-classes.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { loadFixture, runSponsoredProduct } from "../scripts/sponsored-product.mjs";
import { auditActionsInSource } from "./audit-actions.js";
import { CATALOG } from "./helpers.js";

// Audits in three classes (application security, financial licence obligations, financial activity) plus the
// workspace's own running, by one mapping table; and the obligations behind a workspace's products.

// Where the source passes the action in a variable: each site, and every action it can be.
const VARIABLE_SITES = {
  // forwarding helpers: `const audit = (action, ...) => store.audit(user.id, action, ...)`
  "admin.ts var:action": [],
  "liquidity-tools.ts var:action": [],
  "marketplace.ts var:action": [],
  "money-rails.ts var:action": [],
  "ramp-adapters/index.ts var:action": [],
  "runtime.ts var:action": [],
  "server.ts var:action": [],
  "sponsorships.ts var:action": [],
  "vendors.ts var:action": [],
  "workspace-sync.ts var:action": [],
  "workspaces.ts var:action": [],
  // tools registered in a loop, audited by their name
  "admin.ts var:name": ["remove_legislation", "remove_judgment"],
  "hosting-tools.ts var:name": ["suspend_tenant", "resume_tenant"],
  "money-rails.ts var:name": ["suspend_rail", "revoke_rail"],
  "solana/service.ts var:TOPUP_ACTION": ["solana_devnet_topup"],
};
// Each template, and what it expands to.
const TEMPLATE_EXPANSIONS = {
  "${op}_refused": ["set_covenant_refused", "delete_covenant_refused", "acknowledge_breach_refused", "release_covenant_pause_refused"],
  "app_${kind}": ["app_status", "app_logs", "app_restart", "app_exec"],
  "review_${r.kind}": ["review_product_access", "review_campaign_launch"],
  "admin_${action}": ["admin_update_vendor_offering", "admin_run_conformance", "admin_reveal_subscription_secret", "admin_rotate_subscription_secret"],
};

test("every audit action in the source is classified, by one table, each in exactly one class", () => {
  const found = auditActionsInSource();
  assert.ok(found.length > 200, "the scan finds the source's audit calls");
  const unmapped = [...new Set(found.filter((f) => f.kind === "literal" && !(f.action in AUDIT_ACTION_CLASSES)).map((f) => `${f.file}: ${f.action}`))];
  assert.deepEqual(unmapped, [], "add each new audit action to core/src/audit-classes.ts");
  for (const t of new Set(found.filter((f) => f.kind === "template").map((f) => f.action))) {
    assert.ok(AUDIT_ACTION_TEMPLATES.includes(t), `template action \`${t}\`: list it in AUDIT_ACTION_TEMPLATES and its expansions in a class`);
    assert.ok(TEMPLATE_EXPANSIONS[t], `template action \`${t}\`: list its expansions in this test`);
  }
  for (const site of new Set(found.filter((f) => f.kind === "variable").map((f) => `${f.file} ${f.action}`)))
    assert.ok(site in VARIABLE_SITES, `an audit action passed as a variable (${site}): list the actions it can be in this test and in a class`);
  for (const a of [...Object.values(VARIABLE_SITES).flat(), ...Object.values(TEMPLATE_EXPANSIONS).flat()]) assert.ok(a in AUDIT_ACTION_CLASSES, `${a} is classified`);
  // Exactly one class each.
  const seen = new Map();
  for (const [cls, list] of Object.entries(AUDIT_CLASS_LISTS))
    for (const a of list) {
      assert.ok(!seen.has(a), `${a} is in both ${seen.get(a)} and ${cls}`);
      seen.set(a, cls);
    }
  assert.deepEqual(Object.keys(AUDIT_CLASS_LISTS).sort(), [...AUDIT_CLASSES].sort());
  // Unknown actions are the workspace's own.
  assert.equal(auditClass("something_new"), "workspace");
  assert.equal(auditClass("build_audit"), "security");
  assert.equal(auditClass("money_movement"), "financial");
  assert.equal(auditClass("review_license"), "obligations");
  assert.equal(auditClass("change_member_role"), "workspace");
});

// A real sponsored US product (as in workspace-compliance.test.js): a licence provider sponsors its
// money-transmission component in us-ny and us-ca under its New York and California licences.
process.env.SPONSOR_LEGITIMACY_RULE = "off";
const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));
const PRODUCT = "example-dollar-transfer";

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const caller = (client) => async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const adminClient = await connect(adminUser);
  const admin = caller(adminClient);
  const applied = await applyRegulatoryModel({ call: admin, listTools: async () => (await adminClient.listTools()).tools, model: MODEL });
  assert.equal(applied.applied, true);
  const fixture = loadFixture();
  const lpUser = await store.upsertClerkUser("clerk_lp", fixture.licence_provider.member_email, "Lena", ["license_provider"]);
  const { user: builderUser } = await store.createUser("Neo", ["developer"]);
  const sessions = { admin, licence_provider: caller(await connect(lpUser)), builder: caller(await connect(builderUser)) };
  const run = await runSponsoredProduct({ call: (n, i, actor) => sessions[actor](n, i), staging: true });
  assert.equal(run.done, true, JSON.stringify(run));
  const dev = async (name) => {
    const { user } = await store.createUser(name, ["developer"]);
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, `${name.toLowerCase()}@example.com`]);
    return { user, call: caller(await connect({ ...user, email: `${name.toLowerCase()}@example.com` })) };
  };
  const ana = await dev("Ana");
  const mem = await dev("Mem");
  const eve = await dev("Eve");
  const ws = (await ana.call("create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, mem.user.id]);
  const app = (await ana.call("create_app", { name: "Dollar transfers", description: "Send dollars", audience: "US individuals", product_ids: [PRODUCT], workspace_id: ws.id })).data;
  const theirsWs = (await eve.call("create_workspace", { name: "Elsewhere" })).data;
  const theirs = (await eve.call("create_app", { name: "Theirs", description: "Not yours", audience: "Anyone", product_ids: [PRODUCT], workspace_id: theirsWs.id })).data;
  const licence = async (id) => (await pg.query("SELECT id::text AS id FROM financial_products.held_licenses WHERE entity_id = $1 AND license_id = $2", [run.provider_entity_id, id])).rows[0];
  return { pg, store, run, ana, mem, eve, ws, app, theirs, licence };
}

test("list_workspace_audit by class: security, obligations, financial, workspace; no class is everything", async () => {
  const w = await world();
  const { pg, ana, mem, eve, ws, app, theirs } = w;
  const ev = (action, target, details, at = "2026-03-01T00:00:00Z") =>
    pg.query("INSERT INTO financial_products.audit_log (id, actor_id, action, target, details, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [
      randomUUID(),
      ana.user.id,
      action,
      target,
      JSON.stringify(details),
      at,
    ]);
  await ev("repository_access_withdrawn", app.id, { app_id: app.id });
  await ev("covenant_breached", app.id, { app_id: app.id });
  await ev("money_movement_refused", app.id, { app_id: app.id, code: "too_large", api_key: "mynt_live_secret" });
  await ev("change_member_role", ws.id, { user_id: mem.user.id, from: "member", to: "admin" });
  await ev("something_new", ws.id, {});
  // A build with Mynt's independent audit, and one without (no audit row).
  await pg.exec(`CREATE TABLE IF NOT EXISTS financial_products.build_runs (id uuid PRIMARY KEY, developer_id uuid, app_id uuid, goal text, status text,
    maxwell jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), finished_at timestamptz)`);
  const audited = randomUUID();
  await pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, maxwell, finished_at) VALUES ($1, $2, $3, 'build', 'blocked', $4, '2026-03-02T00:00:00Z')", [
    audited,
    ana.user.id,
    app.id,
    JSON.stringify({ counts: { critical: 0, high: 2, medium: 1 } }),
  ]);
  await pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status) VALUES ($1, $2, $3, 'build', 'coding')", [randomUUID(), ana.user.id, app.id]);
  // Live and sandbox money and hand-offs, here and in another workspace.
  const rail = (await pg.query("SELECT id, entity_id FROM financial_products.money_rails LIMIT 1")).rows[0] ?? (await (async () => {
    const id = randomUUID();
    await pg.query(
      `INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status)
       VALUES ($1, $2, 'ach', 'test', 'deposit', '{us-ny}', 100000000, 100000000, 'approved')`,
      [id, w.run.provider_entity_id],
    );
    return { id, entity_id: w.run.provider_entity_id };
  })());
  const move = (appId, sandbox) =>
    pg.query(
      `INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, app_id, sponsor_entity_id, rail_id, direction, amount_cents, settled_amount_cents, status, sandbox, customer_key, created_at, updated_at, settled_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'deposit', 5000, 4901, 'settled', $7, 'customer-ref-123', '2026-03-03T00:00:00Z', now(), now())`,
      [randomUUID(), randomUUID(), PRODUCT, appId, rail.entity_id, rail.id, sandbox],
    );
  await move(app.id, false);
  await move(app.id, true);
  await move(theirs.id, false);
  for (const [a, sandbox] of [[app.id, false], [app.id, true], [theirs.id, false]])
    await pg.query("INSERT INTO financial_products.handoffs (id, app_id, product_id, action, sandbox, status, redirect_url) VALUES ($1, $2, $3, 'apply', $4, 'completed', 'https://provider.example/flow')", [
      randomUUID(),
      a,
      PRODUCT,
      sandbox,
    ]);

  const list = async (args = {}) => {
    const r = await mem.call("list_workspace_audit", { workspace_id: ws.id, limit: 100, ...args });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    return r.data.events;
  };
  const all = await list();
  for (const e of all) {
    for (const k of ["id", "at", "class", "kind", "actor", "target", "summary", "details"]) assert.ok(k in e, `${e.kind} has ${k}`);
    assert.equal(e.class, auditClass(e.kind));
    assert.equal(e.action, e.kind, "action is kept for existing readers");
  }
  const kinds = (es) => es.map((e) => e.kind).sort();
  const security = await list({ class: "security" });
  assert.deepEqual(kinds(security), ["build_audit", "repository_access_withdrawn"]);
  const audit = security.find((e) => e.kind === "build_audit");
  assert.deepEqual([audit.severity, audit.status, audit.app_id, audit.target.id], ["high", "blocked", app.id, audited]);
  assert.match(audit.summary, /2 high, 1 medium/);
  assert.deepEqual(kinds(await list({ class: "obligations" })), ["covenant_breached"]);
  const financial = await list({ class: "financial" });
  assert.deepEqual(kinds(financial), ["handoff", "money_movement", "money_movement_refused"], "live only, this workspace's apps only");
  const money = financial.find((e) => e.kind === "money_movement");
  assert.equal(money.status, "settled");
  assert.match(money.summary, /Deposit of US\$49\.01/);
  assert.ok(!JSON.stringify(financial).includes("customer-ref-123"), "no customer references");
  assert.ok(!JSON.stringify(financial).includes("mynt_live_secret"), "secrets redacted as before");
  const workspace = await list({ class: "workspace" });
  assert.ok(workspace.some((e) => e.kind === "something_new"), "an unclassified action is the workspace's");
  assert.ok(workspace.some((e) => e.kind === "change_member_role"));
  assert.ok(workspace.every((e) => e.class === "workspace"));
  assert.equal(all.length, security.length + (await list({ class: "obligations" })).length + financial.length + workspace.length, "the classes partition everything");
  // Other filters still apply on top of a class.
  assert.deepEqual(kinds(await list({ class: "financial", action: "handoff" })), ["handoff"]);
  assert.equal((await mem.call("list_workspace_audit", { workspace_id: ws.id, class: "money" })).isError, true);
  // Paging across classes' own rows keeps every row.
  const paged = [];
  let cursor;
  do {
    const p = (await mem.call("list_workspace_audit", { workspace_id: ws.id, class: "financial", limit: 1, ...(cursor ? { cursor } : {}) })).data;
    paged.push(...p.events);
    cursor = p.next_cursor;
  } while (cursor);
  assert.deepEqual(kinds(paged), kinds(financial));
  // Members only.
  assert.equal((await eve.call("list_workspace_audit", { workspace_id: ws.id, class: "financial" })).isError, true);
});

test("get_workspace_obligations: the regulator's own obligations for the licences covering its products, with status from records only", async () => {
  const w = await world();
  const { pg, ana, eve, ws } = w;
  assert.equal((await eve.call("get_workspace_obligations", { workspace_id: ws.id })).isError, true, "members only");

  const ny = await w.licence("nydfs_money_transmitter");
  const ca = await w.licence("ca_dfpi_money_transmitter");
  const get = async () => {
    const r = await ana.call("get_workspace_obligations", { workspace_id: ws.id });
    assert.equal(r.isError, false, JSON.stringify(r.data));
    return Object.fromEntries(r.data.map((o) => [o.obligation_id, o]));
  };
  // Nothing recorded yet: unknown, with the reason, never met.
  let o = await get();
  assert.deepEqual(Object.keys(o).sort(), ["ca_dfpi_mtl_licence", "nydfs_mtl_licence"]);
  for (const x of Object.values(o)) {
    assert.equal(x.status, "unknown");
    assert.match(x.reason, /hasn't recorded its compliance/);
    assert.deepEqual(x.products.map((p) => p.id), [PRODUCT]);
    for (const k of ["licence_id", "partner", "regulator", "title"]) assert.ok(x[k], k);
  }
  assert.equal(o.nydfs_mtl_licence.licence_id, ny.id);
  assert.equal(o.nydfs_mtl_licence.regulator, "nydfs");

  const record = (licenceId, section, ref, rec) =>
    pg.query(
      "INSERT INTO financial_products.grc_records (id, entity_id, licence_id, section, ref, key, record) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [randomUUID(), w.run.provider_entity_id, licenceId, section, ref, `${ref}-${randomUUID().slice(0, 8)}`, JSON.stringify(rec)],
    );
  await record(ny.id, "obligations", "nydfs_mtl_licence", { status: "compliant", assessed_on: "2026-10-01", evidence: ["licence certificate", "token=ghp_abcdefghijklmnopqrstuvwxyz0123456789"] });
  await record(ca.id, "obligations", "ca_dfpi_mtl_licence", { status: "non_compliant", assessed_on: "2026-10-02", evidence: [] });
  o = await get();
  assert.equal(o.nydfs_mtl_licence.status, "met");
  assert.match(o.nydfs_mtl_licence.evidence, /compliant on 2026-10-01, with 2 evidence items/);
  assert.ok(!JSON.stringify(o).includes("ghp_abcdef"), "the firm's evidence text isn't shown");
  assert.equal(o.ca_dfpi_mtl_licence.status, "at_risk");

  // Not applicable is the firm's say-so: unknown.
  await pg.query("UPDATE financial_products.grc_records SET status = 'superseded' WHERE ref = 'ca_dfpi_mtl_licence'");
  await record(ca.id, "obligations", "ca_dfpi_mtl_licence", { status: "not_applicable" });
  o = await get();
  assert.equal(o.ca_dfpi_mtl_licence.status, "unknown");
  assert.match(o.ca_dfpi_mtl_licence.reason, /not applicable/);

  // A filing the regulator ties to the obligation, recorded overdue: overdue, whatever the obligation record says.
  const region = (await pg.query("SELECT regulatory FROM financial_products.regions WHERE code = 'US'")).rows[0].regulatory;
  const nydfs = region.regulators.find((r) => r.id === "nydfs").license_types.find((t) => t._id === "nydfs_money_transmitter");
  nydfs.grc.registers.reporting_disclosure_filings = [
    ...(nydfs.grc.registers.reporting_disclosure_filings ?? []),
    { id: "nydfs_quarterly_report", name: "Quarterly report", obligation_ref: "nydfs_mtl_licence" },
  ];
  await pg.query("UPDATE financial_products.regions SET regulatory = $1 WHERE code = 'US'", [JSON.stringify(region)]);
  await record(ny.id, "reporting_disclosure_filings", "nydfs_quarterly_report", { period: "2026-Q3", status: "overdue" });
  o = await get();
  assert.equal(o.nydfs_mtl_licence.status, "overdue");
  assert.match(o.nydfs_mtl_licence.evidence, /Quarterly report.*2026-Q3.*overdue/);

  // A workspace whose apps use no product has none.
  const empty = (await ana.call("create_workspace", { name: "Empty" })).data;
  assert.deepEqual((await ana.call("get_workspace_obligations", { workspace_id: empty.id })).data, []);
});
