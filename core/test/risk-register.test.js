import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { opsStatus } from "../dist/ops.js";
import { riskLevel } from "../dist/risk-register.js";
import { auditClass } from "../dist/audit-classes.js";
import { RISK_AREA_OF_CATEGORY, RISK_AREAS, RISK_CATEGORIES, RISK_REGISTER_TABLES } from "../dist/risk-register-schema.js";
import { personalWorkspace } from "../dist/workspaces.js";
import { CATALOG } from "./helpers.js";

// A risk register shared by apps and financial products: an app's is kept by its workspace's owners and admins (any
// member reads it), a product's by its own firm, and a licence provider sponsoring the product reads it but never
// writes it. Scores are likelihood × impact, every change is audited (the risk's history), and an overdue review
// shows in ops_status.

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
    const client = new Client({ name: "risk-register", version: "0" });
    await client.connect(c);
    return { user: fresh, call: (n, a) => call(client, n, a), tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  const firm = (name) => store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });

  // An app in Dana's workspace; Mo is a plain member; Olive is outside it.
  const devFirm = await firm("Dana Apps");
  const dev = await as("Dana", ["developer"], devFirm.id);
  const workspace = await personalWorkspace(store.db, dev.user.id);
  const app = await store.createApp(dev.user.id, { name: "Pay app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const member = await as("Mo", ["developer"]);
  await store.db.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspace, member.user.id]);
  const outsider = await as("Olive", ["developer"]);

  // A product owned by Builder Inc (Bea created it; Ben is a colleague at the firm), sponsored by Sponsor Bank.
  const builderFirm = await firm("Builder Inc");
  const bea = await as("Bea", ["innovator"], builderFirm.id);
  const ben = await as("Ben", ["innovator"], builderFirm.id);
  const productId = "savings-account";
  await store.db.query(`UPDATE ${T}.products SET owner_id = $1, entity_id = $2 WHERE id = $3`, [bea.user.id, builderFirm.id, productId]);
  const lpFirm = await firm("Sponsor Bank");
  const lp = await as("Lena", ["license_provider"], lpFirm.id);
  const otherFirm = await firm("Other Bank");
  const otherLp = await as("Omar", ["license_provider"], otherFirm.id);
  await store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, $2, 'main', $3, $4, ARRAY['us-ny'], 'approved')`,
    [randomUUID(), productId, builderFirm.id, lpFirm.id],
  );
  return { store, dev, member, outsider, bea, ben, lp, otherLp, app, productId, workspace };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};

test("scores: likelihood × impact, in four levels", () => {
  assert.equal(riskLevel(1), "low");
  assert.equal(riskLevel(4), "low");
  assert.equal(riskLevel(5), "medium");
  assert.equal(riskLevel(9), "medium");
  assert.equal(riskLevel(10), "high");
  assert.equal(riskLevel(12), "high");
  assert.equal(riskLevel(15), "critical");
  assert.equal(riskLevel(25), "critical");
  assert.equal(auditClass("add_risk"), "obligations");
  assert.equal(auditClass("update_risk"), "obligations");
});

test("the tools each side gets: builders keep registers, licence providers only read them", async () => {
  const w = await setup();
  const dev = await w.dev.tools();
  for (const t of ["add_risk", "update_risk", "list_risks"]) assert.ok(dev.includes(t), t);
  const lp = await w.lp.tools();
  assert.ok(lp.includes("list_risks"));
  assert.ok(!lp.includes("add_risk") && !lp.includes("update_risk"), "a licence provider never writes a register");
});

test("an app's register: owners and admins keep it, members read it, outsiders see nothing", async () => {
  const w = await setup();
  const risk = { subject_type: "app", subject_id: w.app.id, title: "Session tokens could leak in logs", category: "security", likelihood: 3, impact: 4, mitigation: "Scrub logs", review_by: "2099-01-01" };
  refused(await w.member.call("add_risk", risk), /owners and admins/);
  refused(await w.outsider.call("add_risk", risk), /No app/);
  refused(await w.outsider.call("list_risks", { subject_type: "app", subject_id: w.app.id }), /No app/);
  refused(await w.dev.call("add_risk", { ...risk, owner_user_id: w.outsider.user.id }), /owner must be a member/);
  refused(await w.dev.call("add_risk", { ...risk, likelihood: 6 }));

  const added = ok(await w.dev.call("add_risk", { ...risk, owner_user_id: w.member.user.id }));
  assert.equal(added.risk.score, 12);
  assert.equal(added.risk.level, "high");
  assert.equal(added.risk.status, "open");
  assert.equal(added.risk.owner.name, "Mo");
  assert.equal(added.risk.overdue, false);

  const read = ok(await w.member.call("list_risks", { subject_type: "app", subject_id: w.app.id }));
  assert.equal(read.can_manage, false);
  assert.equal(read.risks.length, 1);
  assert.equal(read.counts.open, 1);
  assert.equal(ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id })).can_manage, true);
  refused(await w.member.call("update_risk", { risk_id: added.risk.id, status: "mitigating" }), /owners and admins/);

  // The app's signals: fraud isn't measured; conduct, vendors and products are lists.
  assert.equal(read.signals.fraud.available, false);
  assert.match(read.signals.fraud.reason, /Not measured/);
  assert.deepEqual(read.signals.conduct, { available: true, rows: [] });
  assert.deepEqual(read.signals.vendors, { available: true, rows: [] });
  assert.deepEqual(read.signals.products, { available: true, rows: [] });

  // A drifted product shows under products.
  await w.store.db.query(`UPDATE ${T}.products SET drift = $1 WHERE id = $2`, [JSON.stringify({ detected_at: "2026-11-01T00:00:00.000Z", changes: [] }), w.productId]);
  const drifted = ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id }));
  assert.equal(drifted.signals.products.rows[0].issue, "drifted");
});

test("reviews change scores, status and owner, each change audited as the risk's history", async () => {
  const w = await setup();
  const { risk } = ok(await w.dev.call("add_risk", { subject_type: "app", subject_id: w.app.id, title: "Card testing on sign-up", category: "fraud", likelihood: 2, impact: 2 }));
  assert.equal(risk.level, "low");
  refused(await w.dev.call("update_risk", { risk_id: risk.id }), /Nothing to change/);
  refused(await w.dev.call("update_risk", { risk_id: risk.id, status: "accepted" }), /Say why/);
  const up = ok(await w.dev.call("update_risk", { risk_id: risk.id, likelihood: 4, impact: 5, status: "mitigating", mitigation: "Velocity limits on sign-up" }));
  assert.equal(up.risk.score, 20);
  assert.equal(up.risk.level, "critical");
  assert.deepEqual(up.changed.sort(), ["impact", "likelihood", "mitigation", "status"]);
  ok(await w.dev.call("update_risk", { risk_id: risk.id, status: "closed", note: "Limits shipped" }));

  const one = ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id, risk_id: risk.id }));
  assert.deepEqual(one.history.map((h) => h.action), ["add_risk", "update_risk", "update_risk"]);
  assert.deepEqual(one.history[1].changes.likelihood, { from: 2, to: 4 });
  assert.deepEqual(one.history[2].changes.status, { from: "mitigating", to: "closed" });
  assert.equal(one.history[2].note, "Limits shipped");
  assert.equal(one.history[1].actor.name, "Dana");

  const audit = (await w.store.db.query(`SELECT action, details FROM ${T}.audit_log WHERE target = $1 ORDER BY created_at, id`, [risk.id])).rows;
  assert.equal(audit.length, 3);
  assert.ok(audit.every((a) => a.details.app_id === w.app.id), "each entry names the app, so its audit trail shows it");

  // Filters.
  assert.equal(ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id, status: "open" })).risks.length, 0);
  assert.equal(ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id, category: "fraud" })).risks.length, 1);
});

test("a product's register: its own firm keeps it; its sponsor reads it, never writes it; others see nothing", async () => {
  const w = await setup();
  const risk = { subject_type: "product", subject_id: w.productId, title: "Rate model drifts from market", category: "credit", likelihood: 2, impact: 5 };
  const added = ok(await w.bea.call("add_risk", risk));
  assert.equal(added.risk.score, 10);
  // A colleague at the product's firm keeps it too, and may own it.
  ok(await w.ben.call("update_risk", { risk_id: added.risk.id, owner_user_id: w.ben.user.id }));
  refused(await w.bea.call("update_risk", { risk_id: added.risk.id, owner_user_id: w.dev.user.id }), /owner must be a member/);
  // A developer outside the firm doesn't see it.
  refused(await w.dev.call("list_risks", { subject_type: "product", subject_id: w.productId }), /No product/);
  refused(await w.dev.call("add_risk", risk), /No product/);

  // The sponsoring licence provider reads it, read-only.
  const seen = ok(await w.lp.call("list_risks", { subject_type: "product", subject_id: w.productId }));
  assert.equal(seen.can_manage, false);
  assert.equal(seen.risks[0].title, "Rate model drifts from market");
  assert.equal(seen.signals, undefined, "signals are an app's");
  // Another licence provider, not sponsoring it, sees nothing.
  refused(await w.otherLp.call("list_risks", { subject_type: "product", subject_id: w.productId }), /No product/);
  // A licence provider has no app registers.
  refused(await w.lp.call("list_risks", { subject_type: "app", subject_id: w.app.id }), /No app/);
});

test("overdue reviews: flagged on the risk and in ops_status, until closed", async () => {
  const w = await setup();
  const { risk } = ok(await w.dev.call("add_risk", { subject_type: "app", subject_id: w.app.id, title: "Vendor KYC outage", category: "vendor", likelihood: 3, impact: 3, review_by: "2020-01-01" }));
  assert.equal(risk.overdue, true);
  const list = ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id, overdue_only: true }));
  assert.equal(list.risks.length, 1);
  assert.equal(list.counts.overdue, 1);
  let ops = await opsStatus(w.store.db);
  assert.equal(ops.risks.overdue_reviews, 1);
  assert.ok(ops.attention.some((a) => a.startsWith("risks: 1 risk review(s) overdue")), JSON.stringify(ops.attention));

  ok(await w.dev.call("update_risk", { risk_id: risk.id, status: "closed", note: "Second KYC vendor added" }));
  ops = await opsStatus(w.store.db);
  assert.equal(ops.risks.overdue_reviews, 0);
  assert.ok(!ops.attention.some((a) => a.startsWith("risks:")));
});

test("conduct: open findings from marketing and complaints oversight audits under the app's agreements", async () => {
  const w = await setup();
  const agreement = randomUUID();
  await w.store.db.query(
    `INSERT INTO ${T}.app_agreements (id, workspace_id, app_id, counterparty_entity_id, kind, status, products, terms_summary) VALUES ($1, $2, $3, $4, 'program', 'signed', '["savings-account"]', 'Program terms for the app')`,
    [agreement, w.workspace, w.app.id, w.lp.user.entity_id],
  );
  const requirement = async (kind, name) => {
    const id = randomUUID();
    await w.store.db.query(`INSERT INTO ${T}.agreement_audit_requirements (id, agreement_id, name, kind, cadence) VALUES ($1, $2, $3, $4, 'quarterly')`, [id, agreement, name, kind]);
    return id;
  };
  const audit = async (req, findings) =>
    w.store.db.query(`INSERT INTO ${T}.agreement_audits (id, requirement_id, agreement_id, app_id, due_at, status, findings) VALUES ($1, $2, $3, $4, now(), 'in_progress', $5)`, [randomUUID(), req, agreement, w.app.id, JSON.stringify(findings)]);
  const f = (title, status, severity = "high") => ({ id: randomUUID(), title, status, severity, recorded_at: "2026-11-01T00:00:00.000Z" });
  await audit(await requirement("marketing_review", "Ad review"), [f("Rate shown without APR", "open"), f("Old banner", "resolved")]);
  await audit(await requirement("complaints_review", "Complaints review"), [f("Slow responses", "open", "medium")]);
  await audit(await requirement("security_review", "Pen test"), [f("Weak TLS", "open")]);

  const { signals } = ok(await w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id }));
  assert.equal(signals.conduct.available, true);
  const rows = signals.conduct.rows.map((r) => [r.kind, r.finding, r.severity]).sort();
  assert.deepEqual(rows, [["complaints", "Slow responses", "medium"], ["marketing", "Rate shown without APR", "high"]], "only open marketing and complaints findings");
  assert.equal(signals.conduct.rows[0].since, "2026-11-01T00:00:00.000Z");
});

async function adminClient(store, name) {
  const { user } = await store.createUser(name, ["admin"]);
  const fresh = await store.getUser(user.id);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, fresh).connect(s);
  const client = new Client({ name: "risk-register-admin", version: "0" });
  await client.connect(c);
  return {
    user: fresh,
    call: async (n, a = {}) => {
      const res = await client.callTool({ name: n, arguments: a });
      let data;
      try {
        data = JSON.parse(res.content[0].text);
      } catch {
        data = { error: res.content[0].text };
      }
      return { isError: res.isError ?? false, data };
    },
  };
}

test("the platform's own register: Mynt admins keep and read it, nobody else sees it; admin_list_risks reads every register's open risks", async () => {
  const w = await setup();
  const admin = await adminClient(w.store, "Ada");
  const platform = { subject_type: "platform", subject_id: "mynt", title: "Single admin can approve recoveries", category: "security", risk_area: "technology", likelihood: 3, impact: 5, review_by: "2020-01-01" };
  const added = ok(await admin.call("add_risk", platform));
  assert.deepEqual(added.subject, { type: "platform", id: "mynt", name: "Mynt platform" });
  assert.equal(added.risk.level, "critical");
  refused(await admin.call("add_risk", { ...platform, subject_id: "other" }), /No risk register 'other'/);
  refused(await admin.call("add_risk", { ...platform, owner_user_id: w.dev.user.id }), /owner must be a Mynt admin/);
  ok(await admin.call("update_risk", { risk_id: added.risk.id, status: "mitigating", mitigation: "Second admin" }));
  const list = ok(await admin.call("list_risks", { subject_type: "platform", subject_id: "mynt" }));
  assert.equal(list.can_manage, true);
  assert.equal(list.risks.length, 1);
  assert.equal(list.signals, undefined);

  // Anyone else: as if it doesn't exist, and no admin_list_risks.
  for (const who of [w.dev, w.bea, w.lp]) {
    refused(await who.call("list_risks", { subject_type: "platform", subject_id: "mynt" }), /No risk register 'mynt'/);
    assert.ok(!(await who.tools()).includes("admin_list_risks"));
  }
  refused(await w.dev.call("update_risk", { risk_id: added.risk.id, status: "open" }), /No risk/);

  // An app's and a product's risks too; a closed one is left out.
  ok(await w.dev.call("add_risk", { subject_type: "app", subject_id: w.app.id, title: "Card fraud", category: "fraud", likelihood: 2, impact: 2 }));
  const p = ok(await w.bea.call("add_risk", { subject_type: "product", subject_id: w.productId, title: "Rate risk", category: "credit", likelihood: 3, impact: 3 }));
  ok(await w.bea.call("update_risk", { risk_id: p.risk.id, status: "closed", note: "Hedged" }));
  ok(await w.bea.call("add_risk", { subject_type: "product", subject_id: w.productId, title: "Liquidity squeeze", category: "liquidity", likelihood: 4, impact: 3 }));
  const all = ok(await admin.call("admin_list_risks", {}));
  assert.deepEqual(all.counts, { critical: 1, high: 1, medium: 0, low: 1 });
  assert.equal(all.total, 3);
  assert.equal(all.overdue, 1);
  assert.deepEqual(all.risks.map((r) => [r.subject_type, r.score]), [["platform", 15], ["product", 12], ["app", 4]]);
  assert.equal(all.risks[0].subject_name, "Mynt platform");
  assert.equal(all.risks[2].subject_name, "Pay app");
  assert.equal(typeof all.risks[1].subject_name, "string");
  assert.equal(all.risks[1].firm_id, w.bea.user.entity_id, "a product's risk says its firm");
  assert.equal(all.risks[2].workspace_id, w.workspace, "an app's risk says its workspace");
  const apps = ok(await admin.call("admin_list_risks", { subject_type: "app", limit: 1 }));
  assert.equal(apps.total, 1);
  assert.equal(apps.risks.length, 1);

  // The platform's overdue review is in ops_status with the others.
  const ops = await opsStatus(w.store.db);
  assert.equal(ops.risks.overdue_reviews, 1);
});

test("risk areas: the seven platform areas, and every fine-grained category's area (other has none)", () => {
  assert.deepEqual([...RISK_AREAS], ["financial", "compliance", "third_party", "operations", "business_process", "technology", "regulated_product"]);
  assert.deepEqual(RISK_AREA_OF_CATEGORY, {
    credit: "financial",
    liquidity: "financial",
    compliance: "compliance",
    conduct: "compliance",
    vendor: "third_party",
    operational: "operations",
    fraud: "operations",
    security: "technology",
    other: null,
  });
  for (const c of RISK_CATEGORIES) assert.ok(c in RISK_AREA_OF_CATEGORY, c);
});

test("risk_area: required on the platform's register, the category's by default elsewhere, filtered and reviewed", async () => {
  const w = await setup();
  const admin = await adminClient(w.store, "Ada");
  const base = { subject_type: "platform", subject_id: "mynt", title: "Treasury concentration", category: "other", likelihood: 2, impact: 4 };
  refused(await admin.call("add_risk", base), /risk_area/);
  refused(await admin.call("add_risk", { ...base, risk_area: "nowhere" }));
  const fin = ok(await admin.call("add_risk", { ...base, risk_area: "financial" }));
  assert.equal(fin.risk.risk_area, "financial");

  // An app's: its category's area unless it says otherwise; other stays unassigned.
  const app = { subject_type: "app", subject_id: w.app.id, likelihood: 2, impact: 2 };
  assert.equal(ok(await w.dev.call("add_risk", { ...app, title: "Card fraud", category: "fraud" })).risk.risk_area, "operations");
  assert.equal(ok(await w.dev.call("add_risk", { ...app, title: "Vendor outage", category: "vendor", risk_area: "operations" })).risk.risk_area, "operations");
  const loose = ok(await w.dev.call("add_risk", { ...app, title: "Something else", category: "other" }));
  assert.equal(loose.risk.risk_area, null);

  const listed = (args) => w.dev.call("list_risks", { subject_type: "app", subject_id: w.app.id, ...args });
  assert.deepEqual(ok(await listed({ risk_area: "operations" })).risks.map((r) => r.title).sort(), ["Card fraud", "Vendor outage"]);
  assert.deepEqual(ok(await listed({ risk_area: "unassigned" })).risks.map((r) => r.title), ["Something else"]);
  assert.equal(ok(await listed({ risk_area: "technology" })).risks.length, 0);

  // Reviewing it gives it an area; the change is in its history.
  const reviewed = ok(await w.dev.call("update_risk", { risk_id: loose.risk.id, risk_area: "business_process" }));
  assert.deepEqual(reviewed.changed, ["risk_area"]);
  const history = ok(await listed({ risk_id: loose.risk.id })).history;
  assert.deepEqual(history.at(-1).changes.risk_area, { from: null, to: "business_process" });

  // admin_list_risks by area, across every register; unassigned are the ones with none.
  const ops = ok(await admin.call("admin_list_risks", { risk_area: "operations" }));
  assert.equal(ops.total, 2);
  assert.ok(ops.risks.every((r) => r.risk_area === "operations"));
  assert.deepEqual(ok(await admin.call("admin_list_risks", { risk_area: "financial" })).risks.map((r) => r.subject_type), ["platform"]);
  assert.equal(ok(await admin.call("admin_list_risks", { risk_area: "unassigned" })).total, 0);
});

test("backfill: rows made before risk areas get their category's area, other stays unassigned, and running it again changes nothing", async () => {
  const w = await setup();
  const insert = (category, area = null) =>
    w.store.db.query(`INSERT INTO ${T}.risk_register (id, subject_type, subject_id, title, category, risk_area, likelihood, impact) VALUES ($1, 'app', $2, $3, $4, $5, 2, 2) RETURNING id`, [randomUUID(), w.app.id, `Old ${category}`, category, area]);
  for (const c of RISK_CATEGORIES) await insert(c);
  // One already given an area by hand keeps it.
  const kept = (await insert("security", "regulated_product")).rows[0].id;
  await w.store.db.exec(RISK_REGISTER_TABLES);
  const areas = async () => Object.fromEntries((await w.store.db.query(`SELECT title, risk_area FROM ${T}.risk_register WHERE title LIKE 'Old %' AND id <> $1`, [kept])).rows.map((r) => [r.title.slice(4), r.risk_area]));
  assert.deepEqual(await areas(), RISK_AREA_OF_CATEGORY);
  assert.equal((await w.store.db.query(`SELECT risk_area FROM ${T}.risk_register WHERE id = $1`, [kept])).rows[0].risk_area, "regulated_product");
  await w.store.db.exec(RISK_REGISTER_TABLES);
  assert.deepEqual(await areas(), RISK_AREA_OF_CATEGORY);
});
