import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { personalWorkspace } from "../dist/workspaces.js";
import { CATALOG } from "./helpers.js";

// The vendor marketplace: vendors list standard services under standard terms (a document, its SHA-256, a summary,
// pricing and a version), and an app's workspace subscribes by accepting the current version for named apps. Mynt
// records the subscription and one vendor agreement per app, signed by both sides at once; ending either ends the other.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const T = "financial_products";
const TERMS = {
  document_url: "https://vendor.example.com/terms/v1.pdf",
  document_sha256: "a".repeat(64),
  summary: "Standard identity checks, 99.9% uptime, data kept 30 days.",
  pricing_summary: "$0.40 per check, invoiced monthly by the vendor",
};
const CREDENTIAL = "idv-test-cred-41c9";

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
    const client = new Client({ name: "vendor-marketplace", version: "0" });
    await client.connect(c);
    return { user: fresh, call: (n, a) => call(client, n, a) };
  };
  const firm = (name) => store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });

  const builderFirm = await firm("Builder Inc");
  const dev = await as("Dana", ["developer"], builderFirm.id);
  const workspace = await personalWorkspace(store.db, dev.user.id);
  const app = await store.createApp(dev.user.id, { name: "Pay app", description: "d", audience: "a", product_ids: ["savings-account", "fixed-deposit"] }, workspace);
  const app2 = await store.createApp(dev.user.id, { name: "Second app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const member = await as("Mo", ["developer"], builderFirm.id);
  await store.db.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspace, member.user.id]);

  const vendorFirm = await firm("Verify Co");
  const vendor = await as("Vera", ["vendor"], vendorFirm.id);
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const [ac, as2] = InMemoryTransport.createLinkedPair();
  await createServer(store, adminUser).connect(as2);
  const adminClient = new Client({ name: "vendor-marketplace-admin", version: "0" });
  await adminClient.connect(ac);
  const admin = { user: adminUser, call: (n, a) => call(adminClient, n, a) };

  // Two US service types (an admin's, written directly here): identity checks anyone may use, and a bureau report
  // that needs the subscriber to hold a licence Builder Inc doesn't.
  const schema = JSON.stringify({ type: "object", properties: {} });
  for (const [key, category, licences] of [
    ["identity_check", "identity", []],
    ["bureau_report", "credit_bureau", ["us_cra_user"]],
  ])
    await store.db.query(
      `INSERT INTO ${T}.service_types (region, key, name, category, input_schema, output_schema, consent_purpose, innovator_licences, moves_money) VALUES ('US', $1, $2, $3, $4, $4, 'kyc', $5, false)`,
      [key, key.replace("_", " "), category, schema, licences],
    );
  // Offerings listed (Mynt's conformance test is vendors.test.js's job).
  const offering = async (serviceType, name, requiresCredential = false) => {
    const id = randomUUID();
    await store.db.query(
      `INSERT INTO ${T}.vendor_offerings (id, entity_id, region, service_type, name, test_base_url, price, requires_credential, conformance_secret, status) VALUES ($1, $2, 'US', $3, $4, 'https://8.8.8.8', $5, $6, 'x', 'listed')`,
      [id, vendorFirm.id, serviceType, name, JSON.stringify({ amount: 0.4, currency: "USD", per: "call" }), requiresCredential],
    );
    return id;
  };
  return { store, dev, member, vendor, admin, app, app2, vendorFirm, builderFirm, offering };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const agreementsOf = async (store, subscriptionId) => (await store.db.query(`SELECT * FROM ${T}.app_agreements WHERE vendor_subscription_id = $1 ORDER BY created_at`, [subscriptionId])).rows;

test("vendors set versioned standard terms; only their own members; unchanged terms keep their version", async () => {
  const w = await setup();
  const id = await w.offering("identity_check", "Verify Co identity", true);
  const v1 = ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: TERMS }));
  assert.equal(v1.terms.version, 1);
  assert.equal(v1.terms.set_by, w.vendor.user.id);
  assert.equal(ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: TERMS })).terms.version, 1, "the same terms again: no new version");
  refused(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: { ...TERMS, document_url: "http://vendor.example.com/t.pdf" } }), /https/);
  refused(await w.admin.call("update_vendor_offering", { offering_id: id, standard_terms: { ...TERMS, summary: "An admin's version of the terms." } }), /Only the vendor's own members/);
  const v2 = ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: { ...TERMS, pricing_summary: "$0.35 per check" } }));
  assert.equal(v2.terms.version, 2);
  const trail = (await w.store.db.query(`SELECT details FROM ${T}.audit_log WHERE action = 'set_vendor_terms' AND target = $1 ORDER BY created_at`, [id])).rows;
  assert.deepEqual(trail.map((r) => r.details.version), [1, 2]);

  // The marketplace listing shows them, the conformance result (none yet: null, not a pass) and whether the firm may subscribe.
  const listed = ok(await w.dev.call("list_vendor_offerings", { region: "US" }));
  const row = listed.find((o) => o.offering_id === id);
  assert.equal(row.standard_terms.version, 2);
  assert.equal(row.standard_terms.pricing_summary, "$0.35 per check");
  assert.equal(row.vendor_entity_id, w.vendorFirm.id);
  assert.equal(row.conformance, null);
  assert.equal(row.you_can_subscribe, true);
  assert.equal(row.your_subscription_id, null);
});

test("click-through: the current version, for apps the caller manages; creates the subscription and a signed agreement per app", async () => {
  const w = await setup();
  const id = await w.offering("identity_check", "Verify Co identity", true);
  ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: TERMS }));
  ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: { ...TERMS, document_sha256: "b".repeat(64) } }));
  const base = { offering_id: id, app_ids: [w.app.id], products: ["savings-account"], test_credential: CREDENTIAL };

  refused(await w.dev.call("subscribe_vendor_service", { ...base, accept_terms_version: undefined }), /accept_terms_version: 2/);
  refused(await w.dev.call("subscribe_vendor_service", { ...base, accept_terms_version: 1 }), /version 2 is current/);
  refused(await w.dev.call("subscribe_vendor_service", { ...base, accept_terms_version: 2, app_ids: [] }), /Name the apps/);
  refused(await w.member.call("subscribe_vendor_service", { ...base, accept_terms_version: 2 }), /owners and admins/);
  refused(await w.dev.call("subscribe_vendor_service", { ...base, accept_terms_version: 2, products: ["auto-loan-x"] }), /None of those apps uses/);
  refused(await w.dev.call("subscribe_vendor_service", { ...base, accept_terms_version: 2, test_credential: undefined }), /requires a credential/);
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.vendor_subscriptions`)).rows[0].n, 0, "nothing made by a refusal");

  const sub = ok(await w.dev.call("subscribe_vendor_service", { ...base, accept_terms_version: 2 }));
  assert.ok(!JSON.stringify(sub).includes(CREDENTIAL), "the credential is never returned");
  assert.equal(sub.terms_accepted.length, 1);
  assert.equal(sub.terms_accepted[0].terms_version, 2);
  const [a] = await agreementsOf(w.store, sub.subscription_id);
  assert.equal(a.kind, "vendor");
  assert.equal(a.status, "signed");
  assert.equal(a.app_id, w.app.id);
  assert.equal(a.counterparty_entity_id, w.vendorFirm.id);
  assert.deepEqual(a.products, ["savings-account"]);
  assert.equal(a.terms_version, 2);
  assert.equal(a.document_sha256, "b".repeat(64));
  assert.equal(a.document_url, TERMS.document_url);
  assert.equal(a.app_signed_by, w.dev.user.id, "the subscriber signed by its click");
  assert.equal(a.counterparty_signed_by, w.vendor.user.id, "the vendor signed by listing those terms");
  assert.ok(a.app_signed_at && a.counterparty_signed_at);

  // Audited in the app's trail, the vendor told.
  const audit = (await w.store.db.query(`SELECT actor_id, details FROM ${T}.audit_log WHERE action = 'accept_vendor_terms' AND target = $1`, [a.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, w.dev.user.id);
  assert.equal(audit[0].details.app_id, w.app.id);
  assert.equal(audit[0].details.terms_version, 2);
  assert.equal(audit[0].details.vendor_accepted_by, w.vendor.user.id);
  assert.equal((await w.store.db.query(`SELECT details FROM ${T}.audit_log WHERE action = 'subscribe_vendor_service' AND target = $1`, [sub.subscription_id])).rows[0].details.terms_version, 2);
  assert.ok(JSON.stringify(ok(await w.vendor.call("list_firm_notices"))).includes("app_agreement.signed"));

  // The vendor sees its subscriber and the terms it accepted; both sides list the agreement.
  const subscribers = ok(await w.vendor.call("list_my_subscribers"));
  assert.equal(subscribers[0].subscriber, "Builder Inc");
  assert.equal(subscribers[0].terms_accepted[0].terms_version, 2);
  assert.equal(subscribers[0].terms_accepted[0].app.name, "Pay app");
  assert.deepEqual(ok(await w.vendor.call("list_app_agreements")).agreements.map((x) => [x.app.name, x.status, x.terms_version]), [["Pay app", "signed", 2]]);
  const mine = ok(await w.dev.call("list_app_agreements", { app_id: w.app.id }));
  assert.equal(mine.vendor_contracts[0].terms_version, 2);
  assert.equal(mine.vendor_contracts[0].for_this_app, true);
  assert.equal(mine.vendor_contracts[0].no_standard_terms, false);
  assert.equal(ok(await w.dev.call("list_vendor_offerings", { region: "US" })).find((o) => o.offering_id === id).your_subscription_id, sub.subscription_id);

  // A new version of the terms doesn't change the agreement made.
  ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: { ...TERMS, summary: "Version three of the terms, with longer retention." } }));
  assert.equal((await agreementsOf(w.store, sub.subscription_id))[0].terms_version, 2);

  // Another app accepts the current version on the same subscription; the same app again is refused.
  refused(await w.dev.call("subscribe_vendor_service", { offering_id: id, accept_terms_version: 2, app_ids: [w.app2.id] }), /version 3 is current/);
  const more = ok(await w.dev.call("subscribe_vendor_service", { offering_id: id, accept_terms_version: 3, app_ids: [w.app2.id] }));
  assert.deepEqual(more.added_apps, [w.app2.id]);
  assert.deepEqual((await agreementsOf(w.store, sub.subscription_id)).map((x) => [x.app_id, x.terms_version]), [[w.app.id, 2], [w.app2.id, 3]]);
  refused(await w.dev.call("subscribe_vendor_service", { offering_id: id, accept_terms_version: 3, app_ids: [w.app2.id] }), /already subscribes/);

  // A negotiated vendor agreement can still be proposed beside it.
  ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.vendorFirm.id, kind: "vendor", products: [], terms_summary: "A bespoke volume deal for this app" }));
});

test("ending: unsubscribing ends the agreements; ending the last agreement ends the subscription", async () => {
  const w = await setup();
  const id = await w.offering("identity_check", "Verify Co identity");
  ok(await w.vendor.call("update_vendor_offering", { offering_id: id, standard_terms: TERMS }));
  const sub = ok(await w.dev.call("subscribe_vendor_service", { offering_id: id, accept_terms_version: 1, app_ids: [w.app.id, w.app2.id] }));
  assert.equal((await agreementsOf(w.store, sub.subscription_id)).length, 2);

  const ended = ok(await w.dev.call("unsubscribe_vendor_service", { subscription_id: sub.subscription_id, reason: "Switching providers" }));
  assert.equal(ended.agreements_ended.length, 2);
  const after = await agreementsOf(w.store, sub.subscription_id);
  assert.deepEqual(after.map((x) => x.status), ["terminated", "terminated"]);
  assert.ok(after.every((x) => x.termination_reason === "Switching providers" && x.terminated_by === w.dev.user.id));
  const terminations = (await w.store.db.query(`SELECT target FROM ${T}.audit_log WHERE action = 'terminate_app_agreement'`)).rows.map((r) => r.target).sort();
  assert.deepEqual(terminations, after.map((x) => x.id).sort());
  assert.ok(JSON.stringify(ok(await w.vendor.call("list_firm_notices"))).includes("app_agreement.terminated"));

  // Subscribed again for two apps: ending one agreement keeps the subscription; the vendor ending the last ends it.
  const again = ok(await w.dev.call("subscribe_vendor_service", { offering_id: id, accept_terms_version: 1, app_ids: [w.app.id, w.app2.id] }));
  const [first, second] = await agreementsOf(w.store, again.subscription_id);
  const one = ok(await w.dev.call("terminate_app_agreement", { agreement_id: first.id, reason: "Not used by this app" }));
  assert.equal(one.subscription_ended, undefined);
  assert.equal((await w.store.db.query(`SELECT status FROM ${T}.vendor_subscriptions WHERE id = $1`, [again.subscription_id])).rows[0].status, "active");
  const last = ok(await w.vendor.call("terminate_app_agreement", { agreement_id: second.id, reason: "Account closed" }));
  assert.equal(last.subscription_ended, again.subscription_id);
  assert.equal((await w.store.db.query(`SELECT status FROM ${T}.vendor_subscriptions WHERE id = $1`, [again.subscription_id])).rows[0].status, "ended");
  const unsub = (await w.store.db.query(`SELECT actor_id, details FROM ${T}.audit_log WHERE action = 'unsubscribe_vendor_service' AND target = $1`, [again.subscription_id])).rows;
  assert.equal(unsub[0].actor_id, w.vendor.user.id);
});

test("prerequisites still apply; offerings without standard terms subscribe as before, flagged", async () => {
  const w = await setup();
  const bureau = await w.offering("bureau_report", "Verify Co bureau");
  ok(await w.vendor.call("update_vendor_offering", { offering_id: bureau, standard_terms: TERMS }));
  const row = ok(await w.dev.call("list_vendor_offerings", { region: "US" })).find((o) => o.offering_id === bureau);
  assert.equal(row.you_can_subscribe, false);
  assert.match(row.prerequisite, /us_cra_user/);
  refused(await w.dev.call("subscribe_vendor_service", { offering_id: bureau, accept_terms_version: 1, app_ids: [w.app.id] }), /needs your firm to hold a verified licence/);

  const plain = await w.offering("identity_check", "Verify Co legacy");
  refused(await w.dev.call("subscribe_vendor_service", { offering_id: plain, accept_terms_version: 1, app_ids: [w.app.id] }), /no standard terms on file/);
  const sub = ok(await w.dev.call("subscribe_vendor_service", { offering_id: plain }));
  assert.equal(sub.terms_accepted, null);
  assert.deepEqual(await agreementsOf(w.store, sub.subscription_id), []);
  const contracts = ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).vendor_contracts;
  assert.equal(contracts[0].no_standard_terms, true);
  assert.equal(contracts[0].terms_version, null);
  assert.equal(ok(await w.vendor.call("list_my_subscribers"))[0].terms_accepted, null);
});
