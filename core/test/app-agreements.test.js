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
  assert.ok(!dev.includes("respond_to_app_agreement"), "a developer doesn't answer agreements as a counterparty");
  const lp = await w.lp.tools();
  for (const t of ["respond_to_app_agreement", "sign_app_agreement", "terminate_app_agreement", "list_app_agreements"]) assert.ok(lp.includes(t), t);
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
