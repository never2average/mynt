import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { personalWorkspace } from "../dist/workspaces.js";
import { workspaceAttention } from "../dist/attention.js";
import { opsStatus } from "../dist/ops.js";
import { auditClass } from "../dist/audit-classes.js";
import { FIRM_WEBHOOK_EVENTS } from "../dist/runtime.js";
import { CATALOG } from "./helpers.js";

// Service-level commitments under an app's SLA agreement (kind 'sla'): either party adds them (1:n) while it's proposed
// or accepted and retires them while it's open; once signed, either party records breaches (1:n per commitment) and
// either resolves them. Only the agreement's parties read them, plain workspace members read but don't act, an open
// breach flags the app and shows in ops_status, and every change is audited in the obligations class.

const T = "financial_products";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const as = async (name, roles, entityId = null) => {
    const { user } = await store.createUser(name, roles);
    if (entityId) await store.setUserEntity(user.id, entityId);
    const fresh = await store.getUser(user.id);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, fresh).connect(s);
    const client = new Client({ name: "agreement-slas", version: "0" });
    await client.connect(c);
    return { user: fresh, call: (n, a) => call(client, n, a), tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  const firm = (name) => store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });

  const dev = await as("Dana", ["developer"]);
  const workspace = await personalWorkspace(store.db, dev.user.id);
  const app = await store.createApp(dev.user.id, { name: "Pay app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const member = await as("Mo", ["developer"]);
  await store.db.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspace, member.user.id]);
  const outsider = await as("Olive", ["developer"]);

  const lpFirm = await firm("Sponsor Bank");
  const lp = await as("Lena", ["license_provider"], lpFirm.id);
  const otherFirm = await firm("Other Bank");
  const otherLp = await as("Omar", ["license_provider"], otherFirm.id);
  const vendorFirm = await firm("Vendor Co");
  const vendor = await as("Vic", ["vendor"], vendorFirm.id);
  const builderFirm = await firm("Builder Inc");
  await store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, 'savings-account', 'main', $2, $3, ARRAY['us-ny'], 'approved')`,
    [randomUUID(), builderFirm.id, lpFirm.id],
  );
  const ok = (r) => {
    assert.equal(r.isError, false, JSON.stringify(r.data));
    return r.data;
  };
  const program = ok(await dev.call("propose_app_agreement", { app_id: app.id, counterparty_entity_id: lpFirm.id, scopes: ["technology"], kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" }));
  const agreement = ok(await dev.call("propose_app_agreement", { app_id: app.id, counterparty_entity_id: lpFirm.id, scopes: ["technology"], kind: "sla", terms_summary: "Service levels for the Pay app" }));
  assert.equal(agreement.app_id, app.id);
  const sign = async () => {
    ok(await lp.call("respond_to_app_agreement", { agreement_id: agreement.id, decision: "accept" }));
    ok(await dev.call("sign_app_agreement", { agreement_id: agreement.id }));
    ok(await lp.call("sign_app_agreement", { agreement_id: agreement.id }));
  };
  return { store, dev, member, outsider, lp, otherLp, vendor, lpFirm, app, workspace, agreement, program, sign, ok };
}

const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const actions = async (store, id) => (await store.db.query(`SELECT action FROM ${T}.audit_log WHERE target = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.action);
const uptime = (agreementId) => ({ agreement_id: agreementId, metric: "API uptime", target: 99.9, unit: "%", measurement_window: "monthly", measurement_source: "The app's status page monitor", remedy: "Service credit of 5% of the month's fees" });

test("the tools each side gets", async () => {
  const w = await setup();
  const all = ["list_agreement_slas", "add_agreement_sla", "retire_agreement_sla", "record_sla_breach", "resolve_sla_breach"];
  const dev = await w.dev.tools();
  for (const t of all) assert.ok(dev.includes(t), t);
  const lp = await w.lp.tools();
  for (const t of all) assert.ok(lp.includes(t), t);
  const vendor = await w.vendor.tools();
  assert.ok(!vendor.some((t) => t.includes("sla")), "vendors don't keep service levels here");
  assert.ok(FIRM_WEBHOOK_EVENTS.includes("agreement_sla.breached"));
});

test("either party sets service levels on an SLA agreement while it's proposed or accepted", async () => {
  const w = await setup();
  const { ok } = w;
  refused(await w.otherLp.call("add_agreement_sla", uptime(w.agreement.id)), /No agreement/);
  refused(await w.outsider.call("add_agreement_sla", uptime(w.agreement.id)), /No agreement/);
  refused(await w.member.call("add_agreement_sla", uptime(w.agreement.id)), /owners and admins/);
  // Only SLA agreements carry them.
  refused(await w.lp.call("add_agreement_sla", uptime(w.program.id)), /kind sla/);
  // Proposed: commitments come with the terms, from either side.
  const { sla } = ok(await w.lp.call("add_agreement_sla", uptime(w.agreement.id)));
  assert.equal(sla.status, "active");
  assert.equal(sla.target, "99.9");
  assert.equal(sla.target_value, 99.9);
  assert.equal(sla.unit, "%");
  const fromApp = ok(await w.dev.call("add_agreement_sla", { ...uptime(w.agreement.id), metric: "Support response" })).sla;
  assert.equal(fromApp.status, "active");
  const words = ok(await w.lp.call("add_agreement_sla", { agreement_id: w.agreement.id, metric: "Complaint response", target: "Within 2 business days", measurement_window: "weekly", measurement_source: "Complaints log" })).sla;
  assert.equal(words.target_value, null);
  refused(await w.lp.call("add_agreement_sla", { ...uptime(w.agreement.id), measurement_window: "hourly" }));

  // Breaches wait for a signed agreement.
  refused(await w.lp.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 99.1 }), /signed/);

  // Only the parties read them.
  refused(await w.otherLp.call("list_agreement_slas", { agreement_id: w.agreement.id }), /party/);
  assert.deepEqual(ok(await w.otherLp.call("list_agreement_slas")).slas, []);
  refused(await w.outsider.call("list_agreement_slas", { app_id: w.app.id }), /No app/);
  assert.deepEqual(ok(await w.outsider.call("list_agreement_slas")).slas, []);
  refused(await w.outsider.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 1 }), /No service level/);
  // Only SLA agreements are listed.
  const lpList = ok(await w.lp.call("list_agreement_slas"));
  assert.deepEqual(lpList.agreements.map((a) => [a.kind, a.can_add_slas]), [["sla", true]]);
  assert.equal(lpList.slas.length, 3);

  // Signed: the terms are settled, so no new commitments; ended: none either, and nothing to retire.
  await w.sign();
  refused(await w.lp.call("add_agreement_sla", uptime(w.agreement.id)), /proposed or accepted/);
  ok(await w.dev.call("terminate_app_agreement", { agreement_id: w.agreement.id, reason: "Changed plans" }));
  refused(await w.lp.call("add_agreement_sla", uptime(w.agreement.id)), /terminated/);
  refused(await w.dev.call("retire_agreement_sla", { sla_id: fromApp.id, reason: "Ended anyway" }), /terminated/);
  assert.deepEqual(await actions(w.store, sla.id), ["add_agreement_sla"]);
  assert.equal(auditClass("add_agreement_sla"), "obligations");
});

test("breaches by either side, told to both, flagged until resolved; retiring stops new ones", async () => {
  const w = await setup();
  const { ok } = w;
  const { sla } = ok(await w.lp.call("add_agreement_sla", uptime(w.agreement.id)));
  await w.sign();

  // A plain member reads, but doesn't act.
  const memberView = ok(await w.member.call("list_agreement_slas", { workspace_id: w.workspace }));
  assert.equal(memberView.slas.length, 1);
  assert.deepEqual(memberView.slas[0].actions, []);
  assert.deepEqual(memberView.agreements.map((a) => [a.id, a.kind, a.your_side, a.can_add_slas, a.app.name, a.workspace.id, a.counterparty.name]), [[w.agreement.id, "sla", "app", false, "Pay app", w.workspace, "Sponsor Bank"]]);
  refused(await w.member.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 99.1 }), /owners and admins/);

  // Each side sees what it may do.
  const lpView = ok(await w.lp.call("list_agreement_slas"));
  assert.deepEqual(lpView.slas[0].actions, ["record_breach", "retire"]);
  assert.deepEqual(lpView.agreements.map((a) => [a.your_side, a.can_add_slas]), [["counterparty", false]], "signed: no new commitments");
  assert.deepEqual(ok(await w.dev.call("list_agreement_slas")).slas[0].actions, ["record_breach", "retire"]);

  refused(await w.lp.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-10-31", period_end: "2026-10-01", measured_value: 99.1 }), /ends before/);
  const byLp = ok(await w.lp.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 99.1, note: "Two outages" }));
  assert.equal(byLp.breach.recorded_side, "counterparty");
  assert.equal(byLp.breach.measured_value, "99.1");
  assert.equal(byLp.breach.resolved_at, null);
  const byDev = ok(await w.dev.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-11-01", period_end: "2026-11-30", measured_value: "98.7" }));
  assert.equal(byDev.breach.recorded_side, "app");

  // The sponsor's firm is told of each.
  assert.ok(JSON.stringify(ok(await w.lp.call("list_firm_notices"))).includes("agreement_sla.breached"));
  const queued = (await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.firm_notices WHERE type = 'agreement_sla.breached'`)).rows[0].n;
  assert.ok(queued >= 2, "a notice per breach to the sponsor's members");

  const list = ok(await w.dev.call("list_agreement_slas", { workspace_id: w.workspace }));
  assert.equal(list.slas[0].open_breaches, 2);
  assert.deepEqual(list.counts, { slas: 1, active: 1, open_breaches: 2 });
  const b = list.slas[0].breaches.find((x) => x.id === byLp.breach.id);
  assert.equal(b.recorded_by.name, "Lena");
  assert.equal(b.open, true);
  assert.deepEqual(b.actions, ["resolve"]);

  // The app is flagged, and ops_status counts them.
  const attention = await workspaceAttention(w.store, w.dev.user, w.workspace, { role: "owner" });
  const items = attention.items.filter((i) => i.kind === "agreement_sla_breach");
  assert.equal(items.length, 2, JSON.stringify(attention.items));
  assert.equal(items[0].title, "Pay app: API uptime SLA breached");
  assert.equal(items[0].severity, "medium");
  assert.equal(items[0].href, "/licences?tab=sla");
  const ops = await opsStatus(w.store.db);
  assert.deepEqual(ops.sla_breaches, { open: 2, agreements: 1 });
  assert.ok(ops.attention.some((a) => a.startsWith("agreement SLAs: 2 open SLA breach(es) on 1 app agreement(s)")));

  // Either side resolves; a member and other firms can't.
  refused(await w.member.call("resolve_sla_breach", { breach_id: byLp.breach.id }), /owners and admins/);
  refused(await w.otherLp.call("resolve_sla_breach", { breach_id: byLp.breach.id }), /No SLA breach/);
  const resolved = ok(await w.dev.call("resolve_sla_breach", { breach_id: byLp.breach.id, note: "Credit applied" }));
  assert.ok(resolved.breach.resolved_at);
  assert.equal(resolved.breach.resolution_note, "Credit applied");
  refused(await w.dev.call("resolve_sla_breach", { breach_id: byLp.breach.id }), /already resolved/);
  ok(await w.lp.call("resolve_sla_breach", { breach_id: byDev.breach.id }));
  assert.deepEqual((await opsStatus(w.store.db)).sla_breaches, { open: 0, agreements: 0 });
  assert.equal((await workspaceAttention(w.store, w.dev.user, w.workspace, { role: "owner" })).items.filter((i) => i.kind === "agreement_sla_breach").length, 0);

  // Retiring: a party's owners and admins only; no new breaches after; hidden unless asked for.
  refused(await w.otherLp.call("retire_agreement_sla", { sla_id: sla.id, reason: "No longer needed" }), /No service level/);
  refused(await w.member.call("retire_agreement_sla", { sla_id: sla.id, reason: "Not mine to retire" }), /owners and admins/);
  const retired = ok(await w.dev.call("retire_agreement_sla", { sla_id: sla.id, reason: "Replaced by a new target" })).sla;
  assert.equal(retired.status, "retired");
  assert.equal(retired.retire_reason, "Replaced by a new target");
  refused(await w.lp.call("retire_agreement_sla", { sla_id: sla.id, reason: "Again please" }), /already retired/);
  refused(await w.dev.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-12-01", period_end: "2026-12-31", measured_value: 97 }), /retired/);
  assert.deepEqual(ok(await w.dev.call("list_agreement_slas")).slas, []);
  const all = ok(await w.dev.call("list_agreement_slas", { include_retired: true }));
  assert.equal(all.slas[0].status, "retired");
  assert.deepEqual(all.slas[0].actions, []);

  // Audited, with the app, workspace and agreement, in the obligations class.
  assert.deepEqual(await actions(w.store, sla.id), ["add_agreement_sla", "retire_agreement_sla"]);
  assert.deepEqual(await actions(w.store, byLp.breach.id), ["record_sla_breach", "resolve_sla_breach"]);
  const rows = (await w.store.db.query(`SELECT details FROM ${T}.audit_log WHERE target = ANY($1::text[])`, [[sla.id, byLp.breach.id, byDev.breach.id]])).rows;
  assert.ok(rows.every((r) => r.details.app_id === w.app.id && r.details.workspace_id === w.workspace && r.details.agreement_id === w.agreement.id));
  for (const a of ["add_agreement_sla", "retire_agreement_sla", "record_sla_breach", "resolve_sla_breach"]) assert.equal(auditClass(a), "obligations", a);
});

test("an SLA agreement the licence provider proposed: the app's side answers and adds commitments; never without an app", async () => {
  const w = await setup();
  const { ok } = w;
  // Every SLA agreement names its app, from either side.
  refused(await w.dev.call("propose_app_agreement", { workspace_id: w.workspace, counterparty_entity_id: w.lpFirm.id, scopes: ["technology"], kind: "sla", terms_summary: "Service levels for the workspace" }));
  refused(await w.lp.call("propose_workspace_agreement", { workspace_id: w.workspace, scopes: ["technology"], kind: "sla", terms_summary: "Service levels for the workspace" }));
  ok(await w.dev.call("terminate_app_agreement", { agreement_id: w.agreement.id, reason: "Replaced by the sponsor's" }));
  const appSla = ok(await w.lp.call("propose_workspace_agreement", { workspace_id: w.workspace, app_id: w.app.id, scopes: ["technology"], kind: "sla", terms_summary: "Service levels for the Pay app" }));
  assert.equal(appSla.proposed_by_side, "counterparty");
  const { sla } = ok(await w.dev.call("add_agreement_sla", uptime(appSla.id)));
  ok(await w.dev.call("respond_to_app_agreement", { agreement_id: appSla.id, decision: "accept" }));
  ok(await w.dev.call("sign_app_agreement", { agreement_id: appSla.id }));
  ok(await w.lp.call("sign_app_agreement", { agreement_id: appSla.id }));
  ok(await w.dev.call("record_sla_breach", { sla_id: sla.id, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 98 }));
  assert.deepEqual(ok(await w.member.call("list_agreement_slas", { app_id: w.app.id })).slas.map((s) => [s.id, s.app.name, s.open_breaches]), [[sla.id, "Pay app", 1]]);
  const items = (await workspaceAttention(w.store, w.dev.user, w.workspace, { role: "owner" })).items.filter((i) => i.kind === "agreement_sla_breach");
  assert.equal(items[0].title, "Pay app: API uptime SLA breached");
});
