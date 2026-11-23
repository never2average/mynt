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

  // The app's signals: fraud isn't measured, conduct waits on agreement audits, vendors and products are lists.
  assert.equal(read.signals.fraud.available, false);
  assert.match(read.signals.fraud.reason, /Not measured/);
  assert.equal(read.signals.conduct.available, false);
  assert.match(read.signals.conduct.reason, /Not available yet/);
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
