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
import { addMonths, sweepAgreementAudits } from "../dist/agreement-audits.js";
import { opsStatus } from "../dist/ops.js";
import { CATALOG } from "./helpers.js";

// Oversight audits under an app's program agreement: the licence provider sets requirements (1:n), each requirement
// has audits over time (1:n, one open at a time), the app's side submits evidence and answers findings, the licence
// provider passes, fails or waives. Cadences roll over, overdue audits flag the app, and only the agreement's parties
// read them.

const T = "financial_products";
const DAY = 24 * 3600 * 1000;
const date = (ms) => new Date(ms).toISOString().slice(0, 10);
const SHA = "b".repeat(64);

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
    const client = new Client({ name: "agreement-audits", version: "0" });
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
  const builderFirm = await firm("Builder Inc");
  await store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, 'savings-account', 'main', $2, $3, ARRAY['us-ny'], 'approved')`,
    [randomUUID(), builderFirm.id, lpFirm.id],
  );
  const ok = (r) => {
    assert.equal(r.isError, false, JSON.stringify(r.data));
    return r.data;
  };
  const agreement = ok(await dev.call("propose_app_agreement", { app_id: app.id, counterparty_entity_id: lpFirm.id, scopes: ["technology"], kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" }));
  const sign = async () => {
    ok(await lp.call("respond_to_app_agreement", { agreement_id: agreement.id, decision: "accept" }));
    ok(await dev.call("sign_app_agreement", { agreement_id: agreement.id }));
    ok(await lp.call("sign_app_agreement", { agreement_id: agreement.id }));
  };
  return { store, dev, member, outsider, lp, otherLp, lpFirm, app, workspace, agreement, sign, ok };
}

const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const actions = async (store, id) => (await store.db.query(`SELECT action, actor_id FROM ${T}.audit_log WHERE target = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.action);

test("the tools each side gets", async () => {
  const w = await setup();
  const dev = await w.dev.tools();
  for (const t of ["list_agreement_audits", "get_agreement_audit", "submit_agreement_audit_evidence", "respond_to_agreement_audit_finding"]) assert.ok(dev.includes(t), t);
  for (const t of ["add_agreement_audit_requirement", "open_agreement_audit", "close_agreement_audit", "record_agreement_audit_finding"]) assert.ok(!dev.includes(t), `a developer doesn't ${t}`);
  const lp = await w.lp.tools();
  for (const t of ["list_agreement_audits", "get_agreement_audit", "add_agreement_audit_requirement", "retire_agreement_audit_requirement", "open_agreement_audit", "record_agreement_audit_finding", "resolve_agreement_audit_finding", "close_agreement_audit"]) assert.ok(lp.includes(t), t);
  assert.ok(!lp.includes("submit_agreement_audit_evidence"));
});

test("an agreement has many requirements, each many audits; only the sponsor sets them, from the proposal on", async () => {
  const w = await setup();
  const { ok } = w;
  const base = { agreement_id: w.agreement.id, name: "Annual compliance review", kind: "compliance_review", cadence: "annual", first_due: date(Date.now() + 200 * DAY), evidence_required: "Compliance officer's report" };
  refused(await w.otherLp.call("add_agreement_audit_requirement", base), /No agreement/);
  refused(await w.lp.call("add_agreement_audit_requirement", { ...base, first_due: undefined }), /first due date/);
  refused(await w.lp.call("add_agreement_audit_requirement", { ...base, cadence: "on_change" }), /no first due date/);
  // Proposed, not signed: requirements can come with the sponsor's terms, but no audit opens yet.
  const annual = ok(await w.lp.call("add_agreement_audit_requirement", base));
  assert.deepEqual(annual.opened, []);
  const quarterly = ok(await w.lp.call("add_agreement_audit_requirement", { ...base, name: "Quarterly complaints review", kind: "complaints_review", cadence: "quarterly", first_due: date(Date.now() + 10 * DAY) }));
  const marketing = ok(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Marketing material review", kind: "marketing_review", cadence: "on_change" }));
  assert.deepEqual(quarterly.opened, [], "not signed yet");

  await w.sign();
  const opened = await sweepAgreementAudits(w.store);
  // The quarterly one is inside its 30-day window; the annual one (200 days out) isn't; on_change waits for a change.
  assert.deepEqual(opened.map((x) => x.requirement_id), [quarterly.requirement.id]);
  const list = ok(await w.member.call("list_agreement_audits", { app_id: w.app.id }));
  assert.deepEqual(list.requirements.map((r) => r.id).sort(), [annual.requirement.id, quarterly.requirement.id, marketing.requirement.id].sort());
  assert.equal(list.audits.length, 1);
  assert.deepEqual(list.agreements.map((a) => [a.id, a.your_side, a.can_add_requirements]), [[w.agreement.id, "app", false]]);
  const lpView = ok(await w.lp.call("list_agreement_audits"));
  assert.deepEqual(lpView.agreements.map((a) => [a.id, a.your_side, a.can_add_requirements, a.app.name]), [[w.agreement.id, "counterparty", true, "Pay app"]]);
  assert.equal(list.audits[0].status, "scheduled");
  assert.equal(list.audits[0].overdue, false);
  assert.equal(list.audits[0].your_side, "app");
  assert.deepEqual(list.audits[0].actions, [], "a plain member reads but doesn't act");
  assert.equal(list.requirements.find((r) => r.id === quarterly.requirement.id).next_due.slice(0, 10), quarterly.requirement.first_due);
  // The sponsor's members are told of the audit opening.
  assert.ok(JSON.stringify(ok(await w.lp.call("list_firm_notices"))).includes("agreement_audit.opened"));
  // A sweep with nothing new opens nothing (one open at a time).
  assert.deepEqual(await sweepAgreementAudits(w.store), []);

  // Only the agreement's parties read: not another sponsor, not a developer outside the workspace.
  refused(await w.otherLp.call("list_agreement_audits", { agreement_id: w.agreement.id }), /party/);
  assert.deepEqual(ok(await w.otherLp.call("list_agreement_audits")).audits, []);
  refused(await w.outsider.call("list_agreement_audits", { app_id: w.app.id }), /No app/);
  refused(await w.outsider.call("get_agreement_audit", { audit_id: list.audits[0].id }), /No audit/);
  refused(await w.otherLp.call("get_agreement_audit", { audit_id: list.audits[0].id }), /No audit/);
  assert.equal(ok(await w.lp.call("get_agreement_audit", { audit_id: list.audits[0].id })).your_side, "counterparty");
  assert.deepEqual(await actions(w.store, annual.requirement.id), ["add_agreement_audit_requirement"]);
});

test("evidence, findings, answers and the outcome, each by its own side; audited and told", async () => {
  const w = await setup();
  const { ok } = w;
  await w.sign();
  const req = ok(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Quarterly complaints review", kind: "complaints_review", cadence: "quarterly", first_due: date(Date.now() + 5 * DAY) }));
  const audit = req.opened[0];
  assert.ok(audit, "opened at once: inside its window");
  const evidence = [{ name: "Complaints log Q4", url: "https://files.example.com/q4.csv", sha256: SHA }];

  // The sponsor opens it; another sponsor and the app's side can't.
  refused(await w.otherLp.call("open_agreement_audit", { audit_id: audit.id }), /No audit/);
  const open = ok(await w.lp.call("open_agreement_audit", { audit_id: audit.id }));
  assert.equal(open.status, "in_progress");
  assert.equal(open.reviewer, w.lp.user.id);
  refused(await w.lp.call("open_agreement_audit", { audit_id: audit.id }), /not scheduled/);

  // Evidence: only the workspace's owners and admins, https links with a SHA-256.
  refused(await w.member.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence }), /owners and admins/);
  refused(await w.outsider.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence }), /No audit/);
  refused(await w.dev.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence: [{ ...evidence[0], url: "http://files.example.com/q4.csv" }] }));
  refused(await w.dev.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence: [{ ...evidence[0], sha256: "nothex" }] }));
  const submitted = ok(await w.dev.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence, note: "As agreed" }));
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.evidence[0].sha256, SHA);
  assert.ok(submitted.actions.includes("submit_evidence"));
  assert.ok(JSON.stringify(ok(await w.lp.call("list_firm_notices"))).includes("agreement_audit.submitted"));

  // A finding sends it back to in progress; it can't pass while a finding is open.
  const found = ok(await w.lp.call("record_agreement_audit_finding", { audit_id: audit.id, severity: "high", title: "Two complaints unanswered past 15 days", detail: "Tickets 12 and 19" }));
  assert.equal(found.status, "in_progress");
  assert.equal(found.findings_open, 1);
  const finding = found.findings[0];
  refused(await w.lp.call("close_agreement_audit", { audit_id: audit.id, outcome: "passed" }), /submitted evidence/);
  refused(await w.lp.call("respond_to_agreement_audit_finding", { audit_id: audit.id, finding_id: finding.id, response: "x" }));
  refused(await w.member.call("respond_to_agreement_audit_finding", { audit_id: audit.id, finding_id: finding.id, response: "Answered both" }), /owners and admins/);
  const answered = ok(await w.dev.call("respond_to_agreement_audit_finding", { audit_id: audit.id, finding_id: finding.id, response: "Answered both; added an SLA alert" }));
  assert.equal(answered.findings[0].responses[0].text, "Answered both; added an SLA alert");
  ok(await w.dev.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence: [{ name: "SLA alert config", url: "https://files.example.com/sla.json", sha256: "c".repeat(64) }] }));
  refused(await w.lp.call("close_agreement_audit", { audit_id: audit.id, outcome: "passed" }), /open findings/);
  refused(await w.dev.call("resolve_agreement_audit_finding", { audit_id: audit.id, finding_id: finding.id }));
  ok(await w.lp.call("resolve_agreement_audit_finding", { audit_id: audit.id, finding_id: finding.id, note: "Fixed" }));
  refused(await w.lp.call("close_agreement_audit", { audit_id: audit.id, outcome: "failed" }), /why/);
  const passed = ok(await w.lp.call("close_agreement_audit", { audit_id: audit.id, outcome: "passed", note: "Good" }));
  assert.equal(passed.status, "passed");
  assert.deepEqual(passed.actions, []);
  refused(await w.dev.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence }), /already passed/);

  // Every change audited in order, with the app's id; History shows them with names.
  assert.deepEqual(await actions(w.store, audit.id), [
    "agreement_audit_scheduled",
    "open_agreement_audit",
    "submit_agreement_audit_evidence",
    "record_agreement_audit_finding",
    "respond_to_agreement_audit_finding",
    "submit_agreement_audit_evidence",
    "resolve_agreement_audit_finding",
    "pass_agreement_audit",
  ]);
  const detail = ok(await w.dev.call("get_agreement_audit", { audit_id: audit.id }));
  assert.equal(detail.history.length, 8);
  assert.equal(detail.history[1].actor.name, "Lena");
  assert.equal(detail.history[0].actor, null, "the schedule opened it");
  const rows = (await w.store.db.query(`SELECT details FROM ${T}.audit_log WHERE target = $1`, [audit.id])).rows;
  assert.ok(rows.every((r) => r.details.app_id === w.app.id));
  // The workspace's obligations trail carries them.
  const cls = (await import("../dist/audit-classes.js")).auditClass;
  assert.equal(cls("pass_agreement_audit"), "obligations");
});

test("cadence rollover: the next audit opens when one closes and its window opens; once runs once", async () => {
  const w = await setup();
  const { ok } = w;
  await w.sign();
  const first = date(Date.now() + 3 * DAY);
  const monthly = ok(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Monthly financial review", kind: "financial_review", cadence: "monthly", first_due: first }));
  const once = ok(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Launch security review", kind: "security_review", cadence: "once", first_due: date(Date.now() + 90 * DAY) }));
  assert.equal(once.opened.length, 1, "a once audit is scheduled at once");
  const a1 = monthly.opened[0];
  assert.equal(a1.due_at.slice(0, 10), first);
  const waived = ok(await w.lp.call("close_agreement_audit", { audit_id: a1.id, outcome: "waived", note: "Launch month" }));
  // The next one is due a month later: 3 + ~30 days out, inside the 14-day window only later.
  assert.deepEqual(waived.next, []);
  const nextDue = addMonths(new Date(a1.due_at), 1);
  const later = await sweepAgreementAudits(w.store, new Date(nextDue.getTime() - 13 * DAY));
  assert.equal(later.length, 1);
  assert.equal(later[0].due_at, nextDue.toISOString());
  assert.equal(later[0].requirement_id, monthly.requirement.id);
  // Once: closed, never again.
  ok(await w.lp.call("close_agreement_audit", { audit_id: once.opened[0].id, outcome: "failed", note: "Not ready" }));
  assert.deepEqual((await sweepAgreementAudits(w.store, new Date(Date.now() + 800 * DAY))).filter((x) => x.requirement_id === once.requirement.id), []);
  const list = ok(await w.dev.call("list_agreement_audits", { agreement_id: w.agreement.id }));
  assert.equal(list.requirements.find((r) => r.id === monthly.requirement.id).audits, 2, "1:n audits per requirement");

  // Retiring waives the open audit, and no more open.
  const retired = ok(await w.lp.call("retire_agreement_audit_requirement", { requirement_id: monthly.requirement.id, reason: "Folded into the quarterly review" }));
  assert.deepEqual(retired.waived, [later[0].id]);
  assert.deepEqual((await sweepAgreementAudits(w.store, new Date(Date.now() + 400 * DAY))).filter((x) => x.requirement_id === monthly.requirement.id), []);
  refused(await w.lp.call("retire_agreement_audit_requirement", { requirement_id: monthly.requirement.id, reason: "again" }), /already retired/);
});

test("on_change: a new verified build opens one; the sponsor opens one by hand", async () => {
  const w = await setup();
  const { ok } = w;
  await w.sign();
  const req = ok(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Marketing material review", kind: "marketing_review", cadence: "on_change" }));
  assert.deepEqual(req.opened, []);
  const hasBuilds = (await w.store.db.query(`SELECT to_regclass('${T}.build_runs') IS NOT NULL AS ok`)).rows[0].ok;
  if (!hasBuilds) {
    await w.store.db.query(`CREATE TABLE ${T}.build_runs (id uuid PRIMARY KEY, app_id uuid, status text, source_sha256 text, finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now())`);
  }
  const build = async (sha) => {
    const id = randomUUID();
    if (hasBuilds) await w.store.db.query(`INSERT INTO ${T}.build_runs (id, developer_id, app_id, goal, status, cap_usd, source_sha256, finished_at) VALUES ($1, $2, $3, 'g', 'succeeded', 1, $4, now())`, [id, w.dev.user.id, w.app.id, sha]);
    else await w.store.db.query(`INSERT INTO ${T}.build_runs (id, app_id, status, source_sha256, finished_at) VALUES ($1, $2, 'succeeded', $3, now())`, [id, w.app.id, sha]);
    return id;
  };
  const b1 = await build("1".repeat(64));
  const opened = await sweepAgreementAudits(w.store);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].trigger, "build");
  assert.equal(opened[0].build_id, b1);
  // While it's open nothing else opens; closed, the same source doesn't open another, new source does.
  assert.deepEqual(await sweepAgreementAudits(w.store), []);
  ok(await w.lp.call("close_agreement_audit", { audit_id: opened[0].id, outcome: "waived", note: "Copy unchanged" }));
  assert.deepEqual(await sweepAgreementAudits(w.store), []);
  await new Promise((r) => setTimeout(r, 5));
  await build("2".repeat(64));
  assert.equal((await sweepAgreementAudits(w.store)).length, 1);

  // By hand: refused while one is open; the app's side can't.
  refused(await w.lp.call("open_agreement_audit", { requirement_id: req.requirement.id }), /already open/);
  const open = ok(await w.dev.call("list_agreement_audits", { status: "scheduled" })).audits[0];
  ok(await w.lp.call("close_agreement_audit", { audit_id: open.id, outcome: "waived", note: "Seen" }));
  refused(await w.lp.call("open_agreement_audit", { audit_id: open.id, requirement_id: req.requirement.id }), /not both/);
  const manual = ok(await w.lp.call("open_agreement_audit", { requirement_id: req.requirement.id, due: date(Date.now() + 20 * DAY) }));
  assert.equal(manual.status, "in_progress");
  assert.equal(manual.trigger, "manual");
  assert.equal(manual.due_at.slice(0, 10), date(Date.now() + 20 * DAY));
});

test("overdue: past its due date and not closed flags the app in the lists, the workspace's attention and ops_status", async () => {
  const w = await setup();
  const { ok } = w;
  await w.sign();
  const req = ok(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Annual compliance review", kind: "compliance_review", cadence: "annual", first_due: date(Date.now() - 2 * DAY) }));
  const audit = req.opened[0];
  const list = ok(await w.dev.call("list_agreement_audits", { overdue: true }));
  assert.deepEqual(list.audits.map((x) => x.id), [audit.id]);
  assert.equal(list.counts.overdue, 1);
  assert.equal(list.requirements[0].overdue, true);
  assert.deepEqual(ok(await w.dev.call("list_agreement_audits", { overdue: false })).audits, []);
  const attention = await workspaceAttention(w.store, w.dev.user, w.workspace, { role: "owner" });
  const item = attention.items.find((i) => i.kind === "agreement_audit_overdue");
  assert.ok(item, JSON.stringify(attention.items));
  assert.match(item.title, /Pay app: Annual compliance review is overdue/);
  assert.equal(item.href, `/audits?tab=agreements&agreement=${w.agreement.id}`);
  const ops = await opsStatus(w.store.db);
  assert.equal(ops.agreement_audits.overdue, 1);
  assert.ok(ops.attention.some((a) => a.startsWith("agreement audits: 1 overdue oversight audits (on 1 apps)")));
  // Submitted is still overdue until it's closed; closed, it isn't.
  ok(await w.dev.call("submit_agreement_audit_evidence", { audit_id: audit.id, evidence: [{ name: "Report", url: "https://files.example.com/r.pdf", sha256: SHA }] }));
  assert.equal(ok(await w.dev.call("get_agreement_audit", { audit_id: audit.id })).overdue, true);
  ok(await w.lp.call("close_agreement_audit", { audit_id: audit.id, outcome: "passed" }));
  assert.equal((await opsStatus(w.store.db)).agreement_audits.overdue, 0);
});

test("only program agreements with the sponsor's firm take requirements, and only while open", async () => {
  const w = await setup();
  const { ok } = w;
  ok(await w.dev.call("terminate_app_agreement", { agreement_id: w.agreement.id, reason: "Changed plans" }));
  refused(await w.lp.call("add_agreement_audit_requirement", { agreement_id: w.agreement.id, name: "Annual review", kind: "compliance_review", cadence: "annual", first_due: "2027-01-31" }), /terminated/);
  const ds = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, scopes: ["technology"], kind: "data_sharing", products: ["savings-account"], terms_summary: "Sharing complaint records with the sponsor" }));
  refused(await w.lp.call("add_agreement_audit_requirement", { agreement_id: ds.id, name: "Annual review", kind: "compliance_review", cadence: "annual", first_due: "2027-01-31" }), /program agreements/);
});
