import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { personalWorkspace } from "../dist/workspaces.js";
import { CATALOG } from "./helpers.js";

// An app is the distribution layer and holds no licences: its workspace makes business agreements with the firms behind
// its products. Double-yes: the app's owners or admins propose, the other firm accepts or declines, both sign (signed
// only once both have), either side ends it with a reason. Only the right people on each side, every change audited,
// and each side lists its own.

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
    const client = new Client({ name: "app-agreements", version: "0" });
    await client.connect(c);
    return { user: fresh, call: (n, a) => call(client, n, a), tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  const firm = (name) => store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });

  const dev = await as("Dana", ["developer"]);
  const workspace = await personalWorkspace(store.db, dev.user.id);
  const app = await store.createApp(dev.user.id, { name: "Pay app", description: "d", audience: "a", product_ids: ["savings-account", "fixed-deposit"] }, workspace);
  // Another member of the workspace, not an owner or admin.
  const member = await as("Mo", ["developer"]);
  await store.db.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspace, member.user.id]);
  const outsider = await as("Olive", ["developer"]);

  const lpFirm = await firm("Sponsor Bank");
  const lp = await as("Lena", ["license_provider"], lpFirm.id);
  const otherFirm = await firm("Other Bank");
  const otherLp = await as("Omar", ["license_provider"], otherFirm.id);
  const builderFirm = await firm("Builder Inc");
  // Sponsor Bank sponsors savings-account (approved), not fixed-deposit.
  await store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, 'savings-account', 'main', $2, $3, ARRAY['us-ny','us-ca'], 'approved')`,
    [randomUUID(), builderFirm.id, lpFirm.id],
  );
  return { store, dev, member, outsider, lp, otherLp, lpFirm, otherFirm, app, workspace };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const audits = async (store, id) => (await store.db.query(`SELECT action, actor_id, details FROM ${T}.audit_log WHERE target = $1 ORDER BY created_at, id`, [id])).rows;

test("the tools each side gets", async () => {
  const w = await setup();
  const dev = await w.dev.tools();
  for (const t of ["propose_app_agreement", "sign_app_agreement", "terminate_app_agreement", "list_app_agreements", "get_app_customers", "set_app_target_segments"]) assert.ok(dev.includes(t), t);
  // Agreements are two-sided: a developer answers what a licence provider proposed to the workspace.
  assert.ok(dev.includes("respond_to_app_agreement"));
  assert.ok(!dev.includes("propose_workspace_agreement"), "a developer proposes for its own workspace, not to others'");
  const lp = await w.lp.tools();
  for (const t of ["respond_to_app_agreement", "sign_app_agreement", "terminate_app_agreement", "list_app_agreements", "propose_workspace_agreement"]) assert.ok(lp.includes(t), t);
  assert.ok(!lp.includes("propose_app_agreement") && !lp.includes("get_app_customers"));
});

test("propose → accept → both sign → signed; audited, the counterparty told, each side lists it", async () => {
  const w = await setup();
  const proposal = { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product", effective_from: "2026-12-01", document_url: "https://docs.example.com/program.pdf", document_sha256: "a".repeat(64) };

  // Only the owner or an admin proposes; only for the app's own products; a program only with the products' sponsor.
  refused(await w.member.call("propose_app_agreement", proposal), /owners and admins/);
  refused(await w.outsider.call("propose_app_agreement", proposal), /No app/);
  refused(await w.dev.call("propose_app_agreement", { ...proposal, products: ["auto-loan-x"] }), /doesn't use/);
  refused(await w.dev.call("propose_app_agreement", { ...proposal, products: ["fixed-deposit"] }), /doesn't sponsor/);
  refused(await w.dev.call("propose_app_agreement", { ...proposal, counterparty_entity_id: w.otherFirm.id }), /doesn't sponsor/);
  refused(await w.dev.call("propose_app_agreement", { ...proposal, products: [] }), /names the products/);
  refused(await w.dev.call("propose_app_agreement", { ...proposal, kind: "vendor" }), /no vendor services/);
  refused(await w.dev.call("propose_app_agreement", { ...proposal, effective_to: "2026-01-01" }), /before/);

  const a = ok(await w.dev.call("propose_app_agreement", proposal));
  assert.equal(a.status, "proposed");
  assert.equal(a.counterparty.name, "Sponsor Bank");
  assert.deepEqual(a.products, [{ id: "savings-account", name: CATALOG.find((p) => p.id === "savings-account").name }]);
  assert.equal(a.counterparty_told, true, "the sponsor's members get a notice");
  const notices = ok(await w.lp.call("list_firm_notices"));
  assert.ok(JSON.stringify(notices).includes("app_agreement.proposed"));
  refused(await w.dev.call("propose_app_agreement", proposal), /already an open program agreement/);

  // Nobody signs before the counterparty accepts; only its firm answers.
  refused(await w.dev.call("sign_app_agreement", { agreement_id: a.id }), /hasn't accepted/);
  refused(await w.otherLp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }), /No agreement/);
  refused(await w.otherLp.call("sign_app_agreement", { agreement_id: a.id }), /No agreement/);
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept", note: "Happy to" }));
  refused(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "decline" }), /not waiting/);

  // A plain member can't sign for the app; the owner signs, then the sponsor, and only then is it signed.
  refused(await w.member.call("sign_app_agreement", { agreement_id: a.id }), /No agreement/);
  const half = ok(await w.dev.call("sign_app_agreement", { agreement_id: a.id }));
  assert.equal(half.status, "accepted");
  assert.deepEqual(half.signatures, { app_side: true, counterparty_side: false });
  refused(await w.dev.call("sign_app_agreement", { agreement_id: a.id }), /already signed/);
  const signed = ok(await w.lp.call("sign_app_agreement", { agreement_id: a.id }));
  assert.equal(signed.status, "signed");
  assert.equal(signed.effective_from, "2026-12-01");
  assert.deepEqual(signed.signatures, { app_side: true, counterparty_side: true });

  const trail = await audits(w.store, a.id);
  assert.deepEqual(trail.map((r) => r.action), ["propose_app_agreement", "accept_app_agreement", "sign_app_agreement", "sign_app_agreement"]);
  assert.ok(trail.every((r) => r.details.app_id === w.app.id), "the app's own trail shows each change");
  assert.deepEqual(trail.map((r) => r.actor_id), [w.dev.user.id, w.lp.user.id, w.dev.user.id, w.lp.user.id]);

  // The app side: any member lists it, with the products, their sponsors and states; an outsider can't.
  const mine = ok(await w.member.call("list_app_agreements", { app_id: w.app.id }));
  assert.equal(mine.can_manage, false);
  assert.deepEqual(mine.agreements.map((x) => [x.id, x.status]), [[a.id, "signed"]]);
  const savings = mine.products.find((p) => p.id === "savings-account");
  assert.deepEqual(savings.sponsors, [{ entity_id: w.lpFirm.id, name: "Sponsor Bank", jurisdictions: ["us-ca", "us-ny"] }]);
  assert.deepEqual(savings.states, ["us-ca", "us-ny"]);
  assert.equal(savings.stage, "production");
  assert.deepEqual(mine.products.find((p) => p.id === "fixed-deposit").sponsors, []);
  assert.deepEqual(mine.vendor_contracts, []);
  assert.equal(mine.introductions, null, "no business-development agent here: not shown as none");
  refused(await w.outsider.call("list_app_agreements", { app_id: w.app.id }), /No app/);
  // The counterparty side: its firm's, and no one else's.
  assert.deepEqual(ok(await w.lp.call("list_app_agreements")).agreements.map((x) => x.id), [a.id]);
  assert.deepEqual(ok(await w.otherLp.call("list_app_agreements")).agreements, []);
  refused(await w.lp.call("list_app_agreements", { app_id: w.app.id }), /No app/);
});

test("decline ends a proposal; terminate by either side, with a reason, audited", async () => {
  const w = await setup();
  const proposal = { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" };
  const a = ok(await w.dev.call("propose_app_agreement", proposal));
  const declined = ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "decline", note: "Not now" }));
  assert.equal(declined.status, "declined");
  refused(await w.dev.call("sign_app_agreement", { agreement_id: a.id }), /declined/);
  refused(await w.dev.call("terminate_app_agreement", { agreement_id: a.id, reason: "tidy" }), /already declined/);

  // A declined one doesn't block a new proposal; the app side withdraws it, the counterparty is told.
  const b = ok(await w.dev.call("propose_app_agreement", { ...proposal, kind: "data_sharing" }));
  refused(await w.member.call("terminate_app_agreement", { agreement_id: b.id, reason: "not mine" }), /No agreement/);
  refused(await w.otherLp.call("terminate_app_agreement", { agreement_id: b.id, reason: "not mine" }), /No agreement/);
  const withdrawn = ok(await w.dev.call("terminate_app_agreement", { agreement_id: b.id, reason: "Changed our plans" }));
  assert.equal(withdrawn.status, "terminated");
  assert.equal(withdrawn.termination_reason, "Changed our plans");
  assert.ok(JSON.stringify(ok(await w.lp.call("list_firm_notices"))).includes("app_agreement.terminated"));

  // The counterparty ends a signed one.
  const c = ok(await w.dev.call("propose_app_agreement", proposal));
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: c.id, decision: "accept" }));
  ok(await w.dev.call("sign_app_agreement", { agreement_id: c.id }));
  ok(await w.lp.call("sign_app_agreement", { agreement_id: c.id }));
  const ended = ok(await w.lp.call("terminate_app_agreement", { agreement_id: c.id, reason: "Program wound down" }));
  assert.equal(ended.status, "terminated");
  const trail = await audits(w.store, c.id);
  assert.equal(trail.at(-1).action, "terminate_app_agreement");
  assert.equal(trail.at(-1).details.side, "counterparty");
  assert.equal(trail.at(-1).details.from_status, "signed");
  assert.deepEqual((await audits(w.store, a.id)).map((r) => r.action), ["propose_app_agreement", "decline_app_agreement"]);

  const statuses = ok(await w.dev.call("list_app_agreements", { app_id: w.app.id, status: "terminated" })).agreements.map((x) => x.id).sort();
  assert.deepEqual(statuses, [b.id, c.id].sort());
});

test("target customers: personas from the app's products, chosen by owners and admins; counts only where measured", async () => {
  const w = await setup();
  await w.store.db.query(`UPDATE ${T}.products SET definition = $2 WHERE id = $1`, [
    "savings-account",
    JSON.stringify({ customer_segments: [{ _id: "retail", name: "Retail savers", customer_kind: "individual" }, { _id: "students", name: "Students" }] }),
  ]);
  const before = ok(await w.dev.call("get_app_customers", { app_id: w.app.id }));
  assert.deepEqual(before.products.find((p) => p.id === "savings-account").segments.map((s) => [s.id, s.targeted]), [["retail", false], ["students", false]]);
  assert.equal(before.customers.live.customers_with_sessions, null, "no client sessions: not measured, never 0");
  assert.match(before.customers.live.reason, /No live client sessions/);

  refused(await w.member.call("set_app_target_segments", { app_id: w.app.id, segments: [{ product_id: "savings-account", segment_id: "retail" }] }), /owners and admins/);
  refused(await w.dev.call("set_app_target_segments", { app_id: w.app.id, segments: [{ product_id: "savings-account", segment_id: "nobody" }] }), /Not a segment/);
  ok(await w.dev.call("set_app_target_segments", { app_id: w.app.id, segments: [{ product_id: "savings-account", segment_id: "retail" }] }));
  const after = ok(await w.member.call("get_app_customers", { app_id: w.app.id }));
  assert.deepEqual(after.products.find((p) => p.id === "savings-account").segments.map((s) => [s.id, s.targeted]), [["retail", true], ["students", false]]);
  const trail = (await w.store.db.query(`SELECT action FROM ${T}.audit_log WHERE target = $1`, [w.app.id])).rows.map((r) => r.action);
  assert.ok(trail.includes("set_app_target_segments"));
  refused(await w.outsider.call("get_app_customers", { app_id: w.app.id }), /No app/);
});

test("remove_app removes an app's chosen personas, and refuses an app with agreements (the other firm's record too)", async () => {
  const w = await setup();
  const { user } = await w.store.createUser("Ada", ["admin"]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(w.store, await w.store.getUser(user.id)).connect(s);
  const admin = new Client({ name: "app-agreements-admin", version: "0" });
  await admin.connect(c);
  const remove = async (appId) => {
    const res = await admin.callTool({ name: "remove_app", arguments: { app_id: appId, confirm: true, reason: "test" } });
    return { isError: res.isError ?? false, text: res.content[0].text };
  };
  await w.store.db.query(`UPDATE ${T}.products SET definition = $2 WHERE id = $1`, ["savings-account", JSON.stringify({ customer_segments: [{ _id: "retail", name: "Retail" }] })]);
  ok(await w.dev.call("set_app_target_segments", { app_id: w.app.id, segments: [{ product_id: "savings-account", segment_id: "retail" }] }));
  const removed = await remove(w.app.id);
  assert.equal(removed.isError, false, removed.text);
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.app_target_segments`)).rows[0].n, 0);

  const app = await w.store.createApp(w.dev.user.id, { name: "Second", description: "d", audience: "a", product_ids: ["savings-account"] }, w.workspace);
  ok(await w.dev.call("propose_app_agreement", { app_id: app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" }));
  const refusedRemoval = await remove(app.id);
  assert.equal(refusedRemoval.isError, true, refusedRemoval.text);
  assert.match(refusedRemoval.text, /agreements with other firms/);
});

// ---- production waits on program agreements ----

const day = (offset) => new Date(Date.now() + offset * 86400_000).toISOString().slice(0, 10);
const gate = async (w) => {
  const r = ok(await w.dev.call("get_promotion_checks", { app_id: w.app.id, to_stage: "production" }));
  return { checks: r, check: r.checks.find((c) => c.id === "program_agreements") };
};
// Propose, accept and have both sides sign a program agreement; `dates` as the proposal takes them.
const signedProgram = async (w, lp, firmId, products, dates = {}) => {
  const a = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: firmId, kind: "program", products, terms_summary: "The sponsor's program for these products", ...dates }));
  ok(await lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }));
  ok(await w.dev.call("sign_app_agreement", { agreement_id: a.id }));
  return ok(await lp.call("sign_app_agreement", { agreement_id: a.id }));
};

test("production: blocked without a signed program agreement with each product's sponsor, passes once one is signed and in force", async () => {
  const w = await setup();
  const productName = CATALOG.find((p) => p.id === "savings-account").name;
  await w.store.db.query(`INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, 'staging')`, [w.app.id]);

  // None: blocked in plain words, naming the sponsor and the product; the unsponsored product needs none.
  let { checks, check } = await gate(w);
  assert.equal(check.status, "fail");
  assert.equal(check.detail, `No signed program agreement with Sponsor Bank for ${productName}`);
  assert.equal(check.fix.tool, "propose_app_agreement");
  assert.equal(check.fix.href, `/${w.app.id}?tab=agreements`);
  assert.deepEqual(check.coverage.map((c) => [c.product_id, c.sponsor_entity_id, c.sponsor_name, c.covered]), [["savings-account", w.lpFirm.id, "Sponsor Bank", false]]);
  assert.equal(checks.can_promote, false);
  assert.equal(checks.checks.findIndex((c) => c.id === "program_agreements"), checks.checks.findIndex((c) => c.id === "licences") + 1, "right after the licences check");

  // On its way: still blocked, saying where it stands.
  const a = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" }));
  assert.match((await gate(w)).check.detail, /proposed, waiting for Sponsor Bank to accept/);
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }));
  assert.match((await gate(w)).check.detail, /waiting for both signatures/);
  ok(await w.dev.call("sign_app_agreement", { agreement_id: a.id }));
  assert.match((await gate(w)).check.detail, /waiting for Sponsor Bank's signature/);
  ok(await w.lp.call("sign_app_agreement", { agreement_id: a.id }));
  ({ checks, check } = await gate(w));
  assert.equal(check.status, "pass", check.detail);
  assert.equal(check.detail, `Signed and in force: Sponsor Bank for ${productName}`);
  assert.equal(check.coverage[0].agreement_id, a.id);

  // The app's own view says the same.
  const listed = ok(await w.member.call("list_app_agreements", { app_id: w.app.id }));
  assert.deepEqual(listed.production_gate, { met: true, missing: [], flagged: false });
  assert.equal(listed.app.stage, "staging");

  // An app on no sponsored product needs none.
  const solo = await w.store.createApp(w.dev.user.id, { name: "Deposits", description: "d", audience: "a", product_ids: ["fixed-deposit"] }, w.workspace);
  await w.store.db.query(`INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, 'staging')`, [solo.id]);
  const soloCheck = ok(await w.dev.call("get_promotion_checks", { app_id: solo.id, to_stage: "production" })).checks.find((c) => c.id === "program_agreements");
  assert.equal(soloCheck.status, "pass");
  assert.match(soloCheck.detail, /Not applicable/);
  // Staging doesn't ask for agreements.
  await w.store.db.query(`UPDATE ${T}.app_promotions SET stage = 'idea' WHERE app_id = $1`, [solo.id]);
  assert.equal(ok(await w.dev.call("get_promotion_checks", { app_id: solo.id, to_stage: "staging" })).checks.some((c) => c.id === "program_agreements"), false);
});

test("production: an agreement not yet in force, expired, terminated or declined blocks", async () => {
  const w = await setup();
  await w.store.db.query(`INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, 'staging')`, [w.app.id]);

  const future = await signedProgram(w, w.lp, w.lpFirm.id, ["savings-account"], { effective_from: day(5) });
  let { check } = await gate(w);
  assert.equal(check.status, "fail");
  assert.match(check.detail, new RegExp(`No signed program agreement with Sponsor Bank for .*takes effect on ${day(5)}`));

  // Effective from today counts; until today counts too (the last day it runs).
  await w.store.db.query(`UPDATE ${T}.app_agreements SET effective_from = $2, effective_to = $2 WHERE id = $1`, [future.id, day(0)]);
  assert.equal((await gate(w)).check.status, "pass");

  // Expired.
  await w.store.db.query(`UPDATE ${T}.app_agreements SET effective_from = $2, effective_to = $3 WHERE id = $1`, [future.id, day(-30), day(-1)]);
  ({ check } = await gate(w));
  assert.equal(check.status, "fail");
  assert.match(check.detail, new RegExp(`its signed agreement ended on ${day(-1)}`));

  // Terminated.
  await w.store.db.query(`UPDATE ${T}.app_agreements SET effective_to = NULL WHERE id = $1`, [future.id]);
  assert.equal((await gate(w)).check.status, "pass");
  ok(await w.lp.call("terminate_app_agreement", { agreement_id: future.id, reason: "Program wound down" }));
  ({ check } = await gate(w));
  assert.equal(check.status, "fail");
  assert.match(check.detail, /it was ended on \d{4}-\d{2}-\d{2}: Program wound down/);

  // Declined.
  const d = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program, second try" }));
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: d.id, decision: "decline" }));
  assert.match((await gate(w)).check.detail, /Sponsor Bank declined it/);
  // A signed data-sharing agreement isn't a program agreement.
  const shared = await signedProgram(w, w.lp, w.lpFirm.id, ["savings-account"]);
  assert.equal((await gate(w)).check.status, "pass");
  await w.store.db.query(`UPDATE ${T}.app_agreements SET kind = 'data_sharing' WHERE id = $1`, [shared.id]);
  assert.equal((await gate(w)).check.status, "fail");
});

test("production: a product with several sponsors needs every one of them, wherever the app serves", async () => {
  const w = await setup();
  const productName = CATALOG.find((p) => p.id === "savings-account").name;
  await w.store.db.query(`INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, 'staging')`, [w.app.id]);
  // Other Bank sponsors the savings product in Texas.
  await w.store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, 'savings-account', 'rate', $2, $3, ARRAY['us-tx'], 'approved')`,
    [randomUUID(), w.lpFirm.id, w.otherFirm.id],
  );
  await signedProgram(w, w.lp, w.lpFirm.id, ["savings-account"]);
  // No states set: every sponsor counts.
  let { check } = await gate(w);
  assert.equal(check.status, "fail");
  assert.equal(check.detail, `No signed program agreement with Other Bank for ${productName}`);
  assert.deepEqual(check.coverage.map((c) => [c.sponsor_name, c.covered]).sort(), [["Other Bank", false], ["Sponsor Bank", true]]);

  // Serving New York only: Other Bank sponsors the product only in Texas, and still counts.
  ok(await w.dev.call("set_app_target_states", { app_id: w.app.id, states: ["us-ny"] }));
  ({ check } = await gate(w));
  assert.equal(check.status, "fail");
  assert.match(check.detail, /No signed program agreement with Other Bank/);
  assert.deepEqual(check.coverage.map((c) => c.sponsor_name).sort(), ["Other Bank", "Sponsor Bank"]);

  // A signed agreement with Other Bank covering it: passes.
  await signedProgram(w, w.otherLp, w.otherFirm.id, ["savings-account"]);
  ({ check } = await gate(w));
  assert.equal(check.status, "pass", check.detail);
  assert.equal(check.coverage.length, 2);
});

test("production: an agreement ending after the app went live doesn't move it back; it's flagged to the workspace and in ops_status", async () => {
  const w = await setup();
  const { opsStatus } = await import("../dist/ops.js");
  const a = await signedProgram(w, w.lp, w.lpFirm.id, ["savings-account"]);
  await w.store.db.query(`INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, 'production')`, [w.app.id]);
  const attention = async () => ok(await w.member.call("get_workspace_attention", { workspace_id: w.workspace })).items;
  const failing = async () => (await attention()).find((i) => i.kind === "promotion_checks_failing" && i.href === `/${w.app.id}`);
  assert.doesNotMatch((await failing())?.detail ?? "", /program agreement/);
  assert.deepEqual((await opsStatus(w.store.db)).apps.production_without_program_agreements, []);
  // What the sponsor did is the app side's notice: it accepted and signed.
  const signedNote = (await attention()).find((i) => i.kind === "app_agreement_update" && i.title.includes("Sponsor Bank signed"));
  assert.ok(signedNote, "the sponsor's signature is told to the workspace");
  assert.equal(signedNote.href, `/${w.app.id}?tab=agreements`);
  assert.ok((await attention()).some((i) => i.kind === "app_agreement_update" && i.title.includes("Sponsor Bank accepted")));

  ok(await w.lp.call("terminate_app_agreement", { agreement_id: a.id, reason: "Program wound down" }));
  assert.equal(ok(await w.member.call("list_my_apps")).find((x) => x.id === w.app.id).stage, "production", "not moved back");
  assert.match((await failing()).detail, /No signed program agreement with Sponsor Bank/);
  const ended = (await attention()).find((i) => i.kind === "app_agreement_update" && i.title.includes("ended"));
  assert.equal(ended.severity, "high");
  assert.match(ended.detail, /Program wound down/);
  const listed = ok(await w.member.call("list_app_agreements", { app_id: w.app.id }));
  assert.equal(listed.production_gate.flagged, true);
  assert.match(listed.production_gate.missing[0], /No signed program agreement with Sponsor Bank/);
  const ops = await opsStatus(w.store.db);
  assert.deepEqual(ops.apps.production_without_program_agreements.map((x) => [x.app_id, x.missing]), [[w.app.id, 1]]);
  assert.ok(ops.attention.some((l) => l.includes("without a signed program agreement") && l.includes("Pay app")));

  // An expired one too, once signed again.
  const b = await signedProgram(w, w.lp, w.lpFirm.id, ["savings-account"]);
  assert.deepEqual((await opsStatus(w.store.db)).apps.production_without_program_agreements, []);
  await w.store.db.query(`UPDATE ${T}.app_agreements SET effective_to = $2 WHERE id = $1`, [b.id, day(-1)]);
  assert.equal((await opsStatus(w.store.db)).apps.production_without_program_agreements.length, 1);
  assert.match((await failing()).detail, /ended on/);
});

test("a licence provider proposes to a workspace: its owners answer (not members), both sign; told and listed both ways", async () => {
  const w = await setup();
  // The firm sees the workspaces it may propose to: those whose apps use products it sponsors.
  const before = ok(await w.lp.call("list_app_agreements"));
  const ws = before.proposable_workspaces.find((x) => x.workspace.id === w.workspace);
  assert.ok(ws, JSON.stringify(before.proposable_workspaces));
  assert.deepEqual(ws.apps.map((a) => a.id), [w.app.id]);

  const proposal = { workspace_id: w.workspace, app_id: w.app.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" };
  refused(await w.lp.call("propose_workspace_agreement", { ...proposal, app_id: undefined }), /app_id/);
  refused(await w.lp.call("propose_workspace_agreement", { ...proposal, products: ["fixed-deposit"] }), /doesn't sponsor/);
  refused(await w.lp.call("propose_workspace_agreement", { ...proposal, template_id: "00000000-0000-4000-8000-000000000000" }), /No template/);
  const a = ok(await w.lp.call("propose_workspace_agreement", proposal));
  assert.equal(a.proposed_by_side, "counterparty");
  assert.equal(a.your_side, "counterparty");
  assert.deepEqual(a.actions, ["withdraw"]);
  refused(await w.lp.call("propose_workspace_agreement", proposal), /already an open program agreement/);

  // The proposer can't answer its own proposal.
  refused(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }), /Your side proposed it/);
  // The workspace is told in its attention list.
  const waiting = ok(await w.member.call("get_workspace_attention", { workspace_id: w.workspace })).items.find((i) => i.kind === "app_agreement_proposed");
  assert.ok(waiting);
  assert.match(waiting.title, /Pay app: Sponsor Bank proposed a program agreement/);
  assert.equal(waiting.href, "/licences?tab=business-agreements");

  // The workspace lists it with what each may do.
  const listed = ok(await w.dev.call("list_app_agreements", { workspace_id: w.workspace }));
  assert.equal(listed.can_manage, true);
  const mine = listed.agreements.find((x) => x.id === a.id);
  assert.deepEqual([mine.your_side, mine.actions], ["app", ["accept", "decline"]]);
  assert.ok(listed.proposable_counterparties.some((c) => c.entity_id === w.lpFirm.id && c.product_ids.includes("savings-account") && c.app_ids.includes(w.app.id)));
  assert.deepEqual(ok(await w.member.call("list_app_agreements", { workspace_id: w.workspace })).agreements.find((x) => x.id === a.id).actions, [], "a plain member reads only");
  refused(await w.outsider.call("list_app_agreements", { workspace_id: w.workspace }), /No workspace/);

  refused(await w.member.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }), /owners and admins/);
  refused(await w.outsider.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }), /No agreement/);
  refused(await w.otherLp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }), /No agreement/);
  const accepted = ok(await w.dev.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept", note: "Happy to go ahead" }));
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.actions, ["sign", "end"]);
  // The firm is told the app's side answered; the workspace isn't told of its own answer.
  assert.ok(JSON.stringify(ok(await w.lp.call("list_firm_notices"))).includes("app_agreement.answered"));
  assert.ok(!ok(await w.member.call("get_workspace_attention", { workspace_id: w.workspace })).items.some((i) => i.kind === "app_agreement_proposed" || (i.kind === "app_agreement_update" && i.title.includes("accepted"))));

  ok(await w.dev.call("sign_app_agreement", { agreement_id: a.id }));
  const signed = ok(await w.lp.call("sign_app_agreement", { agreement_id: a.id }));
  assert.equal(signed.status, "signed");
  assert.deepEqual(signed.actions, ["end"]);
  const trail = await audits(w.store, a.id);
  assert.deepEqual(trail.map((r) => [r.action, r.details.side]), [["propose_app_agreement", "counterparty"], ["accept_app_agreement", "app"], ["sign_app_agreement", "app"], ["sign_app_agreement", "counterparty"]]);
  // It counts for production like any other program agreement.
  assert.ok(ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).program_coverage.some((c) => c.sponsor_entity_id === w.lpFirm.id && c.covered));
});

test("msa and sla are app agreements too, from either side, never without an app; the developer flow is unchanged", async () => {
  const w = await setup();
  // Every kind names its app: a workspace alone is refused by both tools.
  refused(await w.dev.call("propose_app_agreement", { workspace_id: w.workspace, counterparty_entity_id: w.lpFirm.id, kind: "msa", terms_summary: "Master services for the workspace" }));
  refused(await w.lp.call("propose_workspace_agreement", { workspace_id: w.workspace, kind: "msa", terms_summary: "Master services for the workspace" }));
  refused(await w.lp.call("propose_workspace_agreement", { workspace_id: w.workspace, kind: "sla", terms_summary: "Service levels for the workspace" }));
  refused(await w.member.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "msa", terms_summary: "Master services for the Pay app" }), /owners and admins/);

  // The developer's msa for the app.
  const msa = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "msa", terms_summary: "Master services for the Pay app" }));
  assert.equal(msa.app_id, w.app.id);
  assert.equal(msa.workspace_id, w.workspace);
  assert.equal(msa.proposed_by_side, "app");
  assert.deepEqual(msa.actions, ["withdraw"]);
  refused(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "msa", terms_summary: "Master services for the Pay app" }), /already an open msa/);
  // The proposer can't accept its own; the firm does.
  refused(await w.dev.call("respond_to_app_agreement", { agreement_id: msa.id, decision: "accept" }), /Your side proposed it/);
  const firmView = ok(await w.lp.call("list_app_agreements")).agreements.find((x) => x.id === msa.id);
  assert.deepEqual([firmView.your_side, firmView.actions, firmView.app.id, firmView.workspace.id], ["counterparty", ["accept", "decline"], w.app.id, w.workspace]);
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: msa.id, decision: "accept" }));
  ok(await w.dev.call("sign_app_agreement", { agreement_id: msa.id }));
  assert.equal(ok(await w.lp.call("sign_app_agreement", { agreement_id: msa.id })).status, "signed");
  // The firm's side shows in the workspace's attention list as for any other kind.
  assert.ok(ok(await w.dev.call("get_workspace_attention", { workspace_id: w.workspace })).items.some((i) => i.kind === "app_agreement_update" && i.title === "Pay app: Sponsor Bank signed the master services agreement"));

  // The firm's sla for the app; the proposer withdraws it before it's answered.
  const sla = ok(await w.lp.call("propose_workspace_agreement", { workspace_id: w.workspace, app_id: w.app.id, kind: "sla", terms_summary: "Service levels for the Pay app" }));
  assert.equal(sla.app_id, w.app.id);
  const waiting = ok(await w.dev.call("get_workspace_attention", { workspace_id: w.workspace })).items.find((i) => i.kind === "app_agreement_proposed");
  assert.equal(waiting.title, "Pay app: Sponsor Bank proposed a service-level agreement");

  // The app's own list has both, and so has the workspace's.
  const appList = ok(await w.member.call("list_app_agreements", { app_id: w.app.id }));
  assert.deepEqual(appList.agreements.map((x) => x.kind).sort(), ["msa", "sla"]);
  const listed = ok(await w.member.call("list_app_agreements", { workspace_id: w.workspace }));
  assert.deepEqual(listed.agreements.map((x) => x.kind).sort(), ["msa", "sla"]);
  assert.ok(listed.agreements.every((x) => x.template === null && x.your_side === "app" && x.app.id === w.app.id));
  assert.equal(ok(await w.lp.call("terminate_app_agreement", { agreement_id: sla.id, reason: "Wrong targets" })).status, "terminated");

  // A developer's own program proposal still works as before.
  const program = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" }));
  assert.equal(program.proposed_by_side, "app");
  assert.equal(ok(await w.lp.call("respond_to_app_agreement", { agreement_id: program.id, decision: "accept" })).status, "accepted");
});
