import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { auditClass } from "../dist/audit-classes.js";
import { RISK_HISTORY_ACTIONS } from "../dist/risk-register.js";
import { personalWorkspace } from "../dist/workspaces.js";
import { CATALOG } from "./helpers.js";

// One risk in full (get_risk) and what its keeper adds under it: scoring factors, treatment tasks, controls and
// links. Each follows the register's rules per subject (an app's: workspace owners and admins write, members read; a
// product's: its own firm writes, its sponsor reads; the platform's: Mynt admins only, who also read the others), and
// every write is audited against the risk, which is its history.

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
    const client = new Client({ name: "risk-detail", version: "0" });
    await client.connect(c);
    return { user: fresh, call: (n, a) => call(client, n, a), tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  const firm = (name) => store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });

  const devFirm = await firm("Dana Apps");
  const dev = await as("Dana", ["developer"], devFirm.id);
  const workspace = await personalWorkspace(store.db, dev.user.id);
  const app = await store.createApp(dev.user.id, { name: "Pay app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const member = await as("Mo", ["developer"]);
  await store.db.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspace, member.user.id]);
  const outsider = await as("Olive", ["developer"]);

  const builderFirm = await firm("Builder Inc");
  const bea = await as("Bea", ["developer", "innovator"], builderFirm.id);
  const productId = "savings-account";
  await store.db.query(`UPDATE ${T}.products SET owner_id = $1, entity_id = $2 WHERE id = $3`, [bea.user.id, builderFirm.id, productId]);
  const lpFirm = await firm("Sponsor Bank");
  const lp = await as("Lena", ["license_provider"], lpFirm.id);
  await store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, $2, 'main', $3, $4, ARRAY['us-ny'], 'approved')`,
    [randomUUID(), productId, builderFirm.id, lpFirm.id],
  );
  const admin = await as("Ada", ["admin"]);
  return { store, dev, member, outsider, bea, lp, admin, app, productId, workspace, devFirm, builderFirm };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const appRisk = async (t, more = {}) => ok(await t.dev.call("add_risk", { subject_type: "app", subject_id: t.app.id, title: "Card testing at checkout", category: "fraud", likelihood: 4, impact: 3, ...more })).risk;

const WRITE_TOOLS = ["add_risk_factor", "update_risk_factor", "remove_risk_factor", "add_risk_treatment", "update_risk_treatment", "add_risk_control", "update_risk_control", "retire_risk_control", "link_risk", "unlink_risk"];

test("the tools each side gets: keepers write, a licence provider only reads", async () => {
  const t = await setup();
  for (const who of [t.dev, t.admin, t.bea]) {
    const tools = await who.tools();
    for (const name of ["get_risk", ...WRITE_TOOLS]) assert.ok(tools.includes(name), name);
  }
  const lp = await t.lp.tools();
  assert.ok(lp.includes("get_risk"));
  for (const name of WRITE_TOOLS) assert.ok(!lp.includes(name), name);
  // Every write's audit action is an obligation's, and part of a risk's history.
  for (const action of WRITE_TOOLS) {
    assert.equal(auditClass(action), "obligations", action);
    assert.ok(RISK_HISTORY_ACTIONS.includes(action), action);
  }
});

test("factors: three lists explain the three scores; they never set them", async () => {
  const t = await setup();
  const risk = await appRisk(t);
  const f1 = ok(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "impact", name: "Chargeback losses", score: 4, rationale: "Each run costs fees", source: "https://example.test/chargebacks" })).factor;
  assert.deepEqual(f1.source, { kind: "link", url: "https://example.test/chargebacks" });
  ok(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "impact", name: "Scheme penalties", score: 3 }));
  ok(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "likelihood", name: "Open checkout", score: 5, source: `app:${t.app.id}` }));
  const c1 = ok(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "control", name: "Velocity limits", score: 2 })).factor;

  let got = ok(await t.dev.call("get_risk", { risk_id: risk.id }));
  assert.equal(got.can_manage, true);
  assert.deepEqual(got.scoring.impact.factors.map((f) => [f.name, f.score]), [["Chargeback losses", 4], ["Scheme penalties", 3]]);
  assert.equal(got.scoring.impact.average, 3.5);
  assert.equal(got.scoring.impact.recorded, 3, "the risk's own impact stays the score");
  assert.equal(got.scoring.likelihood.average, 5);
  // An in-app source carries its name for someone who may read it.
  assert.deepEqual(got.scoring.likelihood.factors[0].source, { kind: "reference", target_type: "app", target_id: t.app.id, type_words: "App", name: "Pay app" });
  assert.equal(got.scoring.control.recorded, null, "not assessed until the keeper says");
  for (const k of ["impact", "likelihood", "control"]) assert.match(got.scoring[k].formula, /\w/);
  assert.match(got.scoring.control.formula, /Residual = inherent × \(1 − the control's reduction\)/);
  assert.equal(got.risk.inherent.score, 12);

  // A source is an https link or type:id, nothing else.
  for (const source of ["http://example.test/x", "ftp://x", "app", "thing:1", "javascript:alert(1)"]) refused(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "impact", name: "Bad source", score: 1, source }));

  const changed = ok(await t.dev.call("update_risk_factor", { risk_id: risk.id, factor_id: c1.id, score: 4, rationale: "Limits tightened" }));
  assert.deepEqual(changed.changed.sort(), ["rationale", "score"]);
  refused(await t.dev.call("update_risk_factor", { risk_id: risk.id, factor_id: c1.id, score: 4 }), /Nothing to change/);
  refused(await t.dev.call("update_risk_factor", { risk_id: risk.id, factor_id: randomUUID(), score: 1 }), /No factor/);
  ok(await t.dev.call("remove_risk_factor", { risk_id: risk.id, factor_id: f1.id }));
  refused(await t.dev.call("remove_risk_factor", { risk_id: risk.id, factor_id: f1.id }), /No factor/);
  got = ok(await t.dev.call("get_risk", { risk_id: risk.id }));
  assert.equal(got.scoring.impact.factors.length, 1);
  assert.equal(got.scoring.control.average, 4);
  // A list with no factors has no average: null, never 0.
  ok(await t.dev.call("remove_risk_factor", { risk_id: risk.id, factor_id: got.scoring.likelihood.factors[0].id }));
  assert.equal(ok(await t.dev.call("get_risk", { risk_id: risk.id })).scoring.likelihood.average, null);
});

test("treatment tasks: owner on the register's side, status, done date, effectiveness once done; earliest open due date", async () => {
  const t = await setup();
  const risk = await appRisk(t);
  const a = ok(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Add velocity limits", due: "2031-03-01" })).treatment;
  assert.equal(a.status, "todo");
  assert.equal(a.effectiveness, "not_assessed");
  assert.equal(a.owner.user_id, t.dev.user.id);
  assert.equal(a.done_at, null);
  const b = ok(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Turn on 3-D Secure", owner_user_id: t.member.user.id, due: "2031-01-15" })).treatment;
  const late = ok(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Old task", due: "2020-01-01" })).treatment;
  assert.equal(late.overdue, true);
  refused(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Someone else's", owner_user_id: t.outsider.user.id }), /owner must be a member of the app's workspace/);

  assert.equal(ok(await t.dev.call("get_risk", { risk_id: risk.id })).treatment_due, "2020-01-01");
  ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: late.id, status: "dropped" }));
  assert.equal(ok(await t.dev.call("get_risk", { risk_id: risk.id })).treatment_due, "2031-01-15", "the earliest due date among open tasks");

  refused(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: a.id, effectiveness: "effective" }), /once it's done/);
  const doing = ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: a.id, status: "doing", progress_note: "Limits drafted" })).treatment;
  assert.equal(doing.status, "doing");
  assert.equal(doing.done_at, null);
  const done = ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: a.id, status: "done", effectiveness: "partly_effective", effectiveness_note: "Halved the attempts" })).treatment;
  assert.equal(done.status, "done");
  assert.ok(done.done_at);
  assert.equal(done.effectiveness, "partly_effective");
  // Reopened: no longer done.
  assert.equal(ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: a.id, status: "doing" })).treatment.done_at, null);
  refused(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: randomUUID(), status: "done" }), /No treatment task/);
  // A task with no due date and none open: treatment_due is null, not a date.
  ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: a.id, status: "done" }));
  ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: b.id, status: "done" }));
  assert.equal(ok(await t.dev.call("get_risk", { risk_id: risk.id })).treatment_due, null);
});

test("controls: added, tested, retired; a done treatment task becomes one", async () => {
  const t = await setup();
  const risk = await appRisk(t);
  const c = ok(await t.dev.call("add_risk_control", { risk_id: risk.id, name: "Velocity limits", kind: "preventive", description: "Five attempts a minute per card" })).control;
  assert.equal(c.test_result, null, "not tested until someone says");
  assert.equal(c.last_tested_at, null);
  refused(await t.dev.call("add_risk_control", { risk_id: risk.id, kind: "detective" }), /name/);
  refused(await t.dev.call("add_risk_control", { risk_id: risk.id, name: "Future test", kind: "detective", last_tested_at: "2999-01-01", test_result: "passed" }), /future/);
  refused(await t.dev.call("update_risk_control", { risk_id: risk.id, control_id: c.id, test_result: "passed" }), /needs the date/);
  const tested = ok(await t.dev.call("update_risk_control", { risk_id: risk.id, control_id: c.id, last_tested_at: "2026-01-10", test_result: "gaps_found" })).control;
  assert.equal(tested.last_tested_at, "2026-01-10");
  assert.equal(tested.test_result, "gaps_found");

  // "Make this a control": only from a task of this risk that is done, and once.
  const task = ok(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Turn on 3-D Secure" })).treatment;
  refused(await t.dev.call("add_risk_control", { risk_id: risk.id, kind: "preventive", source_treatment_id: task.id }), /done/);
  ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: task.id, status: "done" }));
  const from = ok(await t.dev.call("add_risk_control", { risk_id: risk.id, kind: "preventive", source_treatment_id: task.id })).control;
  assert.equal(from.name, "Turn on 3-D Secure");
  assert.deepEqual(from.from_treatment, { id: task.id, title: "Turn on 3-D Secure" });
  refused(await t.dev.call("add_risk_control", { risk_id: risk.id, kind: "preventive", source_treatment_id: task.id }), /already a control/);
  const other = await appRisk(t, { title: "Another risk" });
  refused(await t.dev.call("add_risk_control", { risk_id: other.id, kind: "preventive", source_treatment_id: task.id }), /No treatment task/);

  const retired = ok(await t.dev.call("retire_risk_control", { risk_id: risk.id, control_id: c.id, reason: "Replaced by the processor's own limits" })).control;
  assert.equal(retired.retired.reason, "Replaced by the processor's own limits");
  refused(await t.dev.call("retire_risk_control", { risk_id: risk.id, control_id: c.id, reason: "Again" }), /already retired/);
  refused(await t.dev.call("update_risk_control", { risk_id: risk.id, control_id: c.id, name: "New name" }), /retired/);
  const got = ok(await t.dev.call("get_risk", { risk_id: risk.id }));
  assert.deepEqual(got.controls.map((x) => [x.name, x.retired !== null]), [["Velocity limits", true], ["Turn on 3-D Secure", false]]);
});

test("links: you link what you can read, and a link's name shows only to someone who may read it", async () => {
  const t = await setup();
  const risk = await appRisk(t);
  const link = ok(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "app", target_id: t.app.id, note: "Where it happens" })).link;
  assert.equal(link.name, "Pay app");
  refused(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "app", target_id: t.app.id }), /already linked/);
  ok(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "product", target_id: t.productId }));
  ok(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "firm", target_id: t.devFirm.id }));
  // Not theirs to read: another firm, a risk model, something that doesn't exist. All refused the same way.
  refused(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "firm", target_id: t.builderFirm.id }), /No firm '.*' you can read/);
  refused(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "app", target_id: randomUUID() }), /No app '.*' you can read/);
  const model = ok(await t.admin.call("add_risk_model", { risk_area: "operations", name: "Fraud loss model", purpose: "Expected fraud losses", method: "Rate × volume" })).model;
  refused(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "risk_model", target_id: model.id }), /No risk model '.*' you can read/);

  const got = ok(await t.member.call("get_risk", { risk_id: risk.id }));
  assert.equal(got.can_manage, false);
  assert.deepEqual(got.links.map((l) => [l.type_words, l.note]), [["App", "Where it happens"], ["Product", null], ["Firm", null]]);
  assert.equal(got.links[0].name, "Pay app");
  assert.ok(got.links[1].name, "a published product's name is readable");
  assert.equal(got.links[2].name, null, "Mo isn't at Dana's firm: the link shows, its name doesn't");

  refused(await t.dev.call("unlink_risk", { risk_id: risk.id, link_id: randomUUID() }), /No link/);
  ok(await t.dev.call("unlink_risk", { risk_id: risk.id, link_id: link.id }));
  assert.equal(ok(await t.dev.call("get_risk", { risk_id: risk.id })).links.length, 2);

  // Mynt's own risk links to a risk model, and the model lists it.
  const own = ok(await t.admin.call("add_risk", { subject_type: "platform", subject_id: "mynt", title: "Fraud model drifts", category: "operational", risk_area: "operations", likelihood: 3, impact: 4, control_effectiveness: "partial" })).risk;
  assert.equal(ok(await t.admin.call("link_risk", { risk_id: own.id, target_type: "risk_model", target_id: model.id })).link.name, "Fraud loss model");
  const detail = ok(await t.admin.call("list_risk_models", { model_id: model.id }));
  assert.equal(detail.model.linked_risks, 1);
  assert.deepEqual(detail.linked.map((l) => [l.risk.title, l.source, l.risk.residual.score, l.risk.status]), [["Fraud model drifts", "Mynt", 6, "open"]]);
});

test("permissions per subject: who reads and who writes a risk's detail", async () => {
  const t = await setup();
  const app = await appRisk(t);
  const product = ok(await t.bea.call("add_risk", { subject_type: "product", subject_id: t.productId, title: "Rate shock", category: "liquidity", likelihood: 2, impact: 5 })).risk;
  const platform = ok(await t.admin.call("add_risk", { subject_type: "platform", subject_id: "mynt", title: "Key compromise", category: "security", risk_area: "technology", likelihood: 2, impact: 5 })).risk;
  const factor = (id) => ({ risk_id: id, kind: "impact", name: "A factor", score: 3 });

  // An app's: owners and admins write, members read, outsiders see nothing.
  ok(await t.dev.call("add_risk_factor", factor(app.id)));
  ok(await t.member.call("get_risk", { risk_id: app.id }));
  refused(await t.member.call("add_risk_factor", factor(app.id)), /owners and admins/);
  refused(await t.member.call("add_risk_treatment", { risk_id: app.id, title: "Not mine to add" }), /owners and admins/);
  refused(await t.member.call("add_risk_control", { risk_id: app.id, name: "Not mine", kind: "preventive" }), /owners and admins/);
  refused(await t.member.call("link_risk", { risk_id: app.id, target_type: "app", target_id: t.app.id }), /owners and admins/);
  refused(await t.outsider.call("get_risk", { risk_id: app.id }), /No risk/);
  refused(await t.outsider.call("add_risk_factor", factor(app.id)), /No risk/);

  // A product's: its own firm writes, its sponsor reads, others see nothing.
  ok(await t.bea.call("add_risk_factor", factor(product.id)));
  const seen = ok(await t.lp.call("get_risk", { risk_id: product.id }));
  assert.equal(seen.can_manage, false);
  assert.equal(seen.scoring.impact.factors.length, 1);
  refused(await t.dev.call("get_risk", { risk_id: product.id }), /No risk/);
  refused(await t.dev.call("add_risk_factor", factor(product.id)), /No risk/);

  // The platform's: Mynt admins only. They also read, never write, an app's and a product's.
  ok(await t.admin.call("add_risk_factor", factor(platform.id)));
  for (const who of [t.dev, t.bea, t.lp, t.member]) refused(await who.call("get_risk", { risk_id: platform.id }), /No risk/);
  refused(await t.dev.call("add_risk_factor", factor(platform.id)), /No risk/);
  for (const id of [app.id, product.id]) {
    const read = ok(await t.admin.call("get_risk", { risk_id: id }));
    assert.equal(read.can_manage, false);
    refused(await t.admin.call("add_risk_factor", factor(id)), /No risk/);
    refused(await t.admin.call("update_risk", { risk_id: id, likelihood: 1 }), /No risk/);
  }
  refused(await t.dev.call("get_risk", { risk_id: randomUUID() }), /No risk/);
});

test("history: every change from the audit trail, in words, with the scores before → after", async () => {
  const t = await setup();
  const risk = await appRisk(t);
  ok(await t.dev.call("update_risk", { risk_id: risk.id, control_effectiveness: "strong", control_note: "Limits and 3-D Secure" }));
  ok(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "control", name: "Velocity limits", score: 4 }));
  const task = ok(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Turn on 3-D Secure" })).treatment;
  ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: task.id, status: "done" }));
  ok(await t.dev.call("add_risk_control", { risk_id: risk.id, kind: "preventive", source_treatment_id: task.id }));
  ok(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "app", target_id: t.app.id }));
  ok(await t.dev.call("update_risk", { risk_id: risk.id, likelihood: 2 }));
  ok(await t.dev.call("update_risk", { risk_id: risk.id, status: "closed", note: "Attempts stopped" }));

  const { history } = ok(await t.member.call("get_risk", { risk_id: risk.id }));
  assert.deepEqual(history.map((h) => h.action), ["add_risk", "update_risk", "add_risk_factor", "add_risk_treatment", "update_risk_treatment", "add_risk_control", "link_risk", "update_risk", "update_risk"]);
  for (const h of history) {
    assert.equal(h.actor.name, "Dana");
    assert.match(h.what, /\w/);
    assert.ok(h.at);
  }
  const score = (h) => [h.score.before && [h.score.before.inherent, h.score.before.control, h.score.before.residual], [h.score.after.inherent, h.score.after.control, h.score.after.residual]];
  assert.deepEqual(score(history[0]), [null, [12, null, 12]], "added: nothing before; not assessed, so the residual is the inherent score");
  assert.deepEqual(score(history[1]), [[12, null, 12], [12, "strong", 3]]);
  assert.match(history[1].what, /control effectiveness \(none → strong\)/);
  assert.deepEqual(score(history[2]), [[12, "strong", 3], [12, "strong", 3]], "a factor explains; it moves no score");
  assert.equal(history[2].what, "Control factor added: Velocity limits (4 of 5)");
  assert.equal(history[5].what, "Control added: Turn on 3-D Secure (preventive), from the task Turn on 3-D Secure");
  assert.equal(history[6].what, "Linked to app: Pay app");
  assert.deepEqual(score(history[7]), [[12, "strong", 3], [6, "strong", 2]]);
  assert.equal(history[8].note, "Attempts stopped");
  assert.match(history[8].what, /status \(open → closed\)/);
  // list_risks with risk_id reads the same history.
  assert.equal(ok(await t.dev.call("list_risks", { subject_type: "app", subject_id: t.app.id, risk_id: risk.id })).history.length, history.length);
  // Each entry is in the audit trail against the risk, with the app it belongs to.
  const { rows } = await t.store.db.query(`SELECT action, details FROM ${T}.audit_log WHERE target = $1`, [risk.id]);
  assert.equal(rows.length, history.length);
  for (const r of rows) {
    assert.equal(r.details.app_id, t.app.id, r.action);
    assert.equal(auditClass(r.action), "obligations", r.action);
  }
});

test("a risk from before three-step scoring keeps working: its old history carries the inherent score, the residual not recorded", async () => {
  const t = await setup();
  const id = randomUUID();
  await t.store.db.query(`INSERT INTO ${T}.risk_register (id, subject_type, subject_id, title, category, likelihood, impact, created_by) VALUES ($1, 'app', $2, 'Old risk', 'fraud', 3, 3, $3)`, [id, t.app.id, t.dev.user.id]);
  await t.store.audit(t.dev.user.id, "add_risk", id, { subject_type: "app", subject_id: t.app.id, app_id: t.app.id, title: "Old risk", likelihood: 3, impact: 3, score: 9, status: "open" });
  await t.store.audit(t.dev.user.id, "update_risk", id, { subject_type: "app", subject_id: t.app.id, app_id: t.app.id, changes: { impact: { from: 3, to: 4 } }, score: 12, status: "open", note: null });
  await t.store.db.query(`UPDATE ${T}.risk_register SET impact = 4 WHERE id = $1`, [id]);
  const got = ok(await t.dev.call("get_risk", { risk_id: id }));
  assert.equal(got.risk.control.effectiveness, null);
  assert.equal(got.risk.control.words, "Not assessed");
  assert.equal(got.risk.residual.score, 12);
  assert.equal(got.risk.residual.assessed, false);
  assert.match(got.risk.residual.words, /same as inherent, control not assessed/);
  assert.deepEqual(got.history.map((h) => [h.score.before, h.score.after]), [
    [null, { inherent: 9, control: null, residual: null }],
    [{ inherent: 9, control: null, residual: null }, { inherent: 12, control: null, residual: null }],
  ]);
  assert.equal(got.history[1].what, "Changed impact (3 → 4)");
});

test("remove_app takes the app's risks with everything under them; each risk's history stays in the audit trail", async () => {
  const t = await setup();
  const risk = await appRisk(t);
  ok(await t.dev.call("add_risk_factor", { risk_id: risk.id, kind: "impact", name: "Losses", score: 4 }));
  const task = ok(await t.dev.call("add_risk_treatment", { risk_id: risk.id, title: "Turn on 3-D Secure" })).treatment;
  ok(await t.dev.call("update_risk_treatment", { risk_id: risk.id, treatment_id: task.id, status: "done" }));
  ok(await t.dev.call("add_risk_control", { risk_id: risk.id, kind: "preventive", source_treatment_id: task.id }));
  ok(await t.dev.call("link_risk", { risk_id: risk.id, target_type: "app", target_id: t.app.id }));
  // One of Mynt's own risks links to the app too: that link is Mynt's row, not the app's.
  const own = ok(await t.admin.call("add_risk", { subject_type: "platform", subject_id: "mynt", title: "An app goes wrong", category: "operational", risk_area: "operations", likelihood: 2, impact: 2 })).risk;
  ok(await t.admin.call("link_risk", { risk_id: own.id, target_type: "app", target_id: t.app.id }));

  const dry = ok(await t.admin.call("remove_app", { app_id: t.app.id }));
  assert.deepEqual([dry.would_remove.rows.risk_register, dry.would_remove.rows.risk_factors, dry.would_remove.rows.risk_treatments, dry.would_remove.rows.risk_controls, dry.would_remove.rows.risk_links], [1, 1, 1, 1, 1], JSON.stringify(dry));
  ok(await t.admin.call("remove_app", { app_id: t.app.id, confirm: true, reason: "test" }));
  const count = async (table) => Number((await t.store.db.query(`SELECT count(*)::int AS n FROM ${T}.${table} WHERE risk_id = $1`, [risk.id])).rows[0].n);
  for (const table of ["risk_factors", "risk_treatments", "risk_controls", "risk_links"]) assert.equal(await count(table), 0, table);
  assert.equal((await t.store.db.query(`SELECT 1 FROM ${T}.risk_register WHERE id = $1`, [risk.id])).rows.length, 0);
  assert.ok((await t.store.db.query(`SELECT 1 FROM ${T}.audit_log WHERE target = $1`, [risk.id])).rows.length >= 6, "the history stays");
  // Mynt's own risk keeps its link; the app it named is gone, so it has no name.
  const links = ok(await t.admin.call("get_risk", { risk_id: own.id })).links;
  assert.deepEqual(links.map((l) => [l.target_type, l.target_id, l.name]), [["app", t.app.id, null]]);
});
