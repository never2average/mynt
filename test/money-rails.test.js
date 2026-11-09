import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { connectPostgres } from "../dist/db.js";
import { createMcpHttpServer } from "../dist/http.js";
import { authorizeMovement, centsOf, flowsFor, isDefiniteRefusal, movementShape, recordMovementFailed, recordMovementOutput, recordMovementPending, recordMovementReversed, resolveCustomerState, sweepStaleMovements } from "../dist/money-rails.js";
import { normalizeModel } from "../dist/regulatory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { signBody } from "../dist/vendor-call.js";
import { CATALOG, licensed } from "./helpers.js";
import { publishDefined, setup } from "./v2-helpers.js";

// Approved money rails: money moves only through a rail an admin approved for the product's licence provider, in
// the customer's state, within its limits, and every movement is a row in the ledger in integer cents.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 1000 };

const closers = [];
after(() => closers.forEach((c) => c()));

const openPglite = async () => {
  const pg = new PGlite();
  return Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
};

const connect = async (store, user) => {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(s);
  const client = new Client({ name: "rails", version: "0" });
  await client.connect(c);
  return client;
};
const callTool = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  let data;
  try {
    data = JSON.parse(res.content[0].text);
  } catch {
    data = { error: res.content[0].text }; // the SDK's own refusal of an invalid input
  }
  return { isError: res.isError ?? false, data };
};
const ok = async (client, name, args = {}) => {
  const r = await callTool(client, name, args);
  assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
  return r.data;
};

// A verified state money transmitter licence covering `covers`, as the US model has them: it grants
// us_money_transmission and counts only with a FinCEN registration, which covers nowhere itself.
async function moneyTransmitter(store, user, covers, { fincen = true, grants = "us_money_transmission" } = {}) {
  if (!user.entity_id) {
    const entity = await store.createEntity(user.id, { name: `${user.name} Ltd`, registration_numbers: {}, regions: ["US"] });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
  }
  await store.upsertRegulatedProductType("US", { id: grants, name: grants, description: "", type_id: "deposits", actions: ["sale", "servicing"] });
  const grc = (ids) => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
    allowed_product_types: ids.map((id) => ({ id, actions: ["sale", "servicing"] })),
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  });
  const scope = { product_types: [{ id: grants, name: grants, description: "", type_id: "deposits", action: ["sale", "servicing"] }], customer_personas: [] };
  const region = (await store.referenceData(true)).regions.find((r) => r.code === "US");
  const model = normalizeModel(region.regulatory);
  await store.setRegulatoryModel("US", {
    ...model,
    regulators: [
      ...model.regulators.filter((r) => !["t_fincen", "t_state"].includes(r.id)),
      { id: "t_fincen", name: "Test FinCEN", scope, license_types: [{ _id: "t_msb", name: "MSB", scope: "", application_procedure: [], covers: [], grc: grc([grants]) }] },
      { id: "t_state", name: "Test state", scope, license_types: [{ _id: "t_mt", name: "Money transmitter", scope: "", application_procedure: [], covers, requires: [["t_msb"]], grc: grc([grants]) }] },
    ],
  });
  const hold = async (regulator_id, license_id) => {
    const h = await store.registerLicense(user.id, { entity_id: user.entity_id, region: "US", regulator_id, license_id, registration_number: `T-${license_id}`, valid_from: null, valid_to: null });
    await store.reviewLicense(h.id, "verified", user.id, "test");
    return h;
  };
  const registration = fincen ? await hold("t_fincen", "t_msb") : null;
  return { held: await hold("t_state", "t_mt"), registration };
}

// A licence provider whose verified US licence covers `covers`, sponsoring one product in `jurisdictions`.
async function world(store, { covers = ["us-ny", "us-ca"], jurisdictions = ["us-ny", "us-ca"] } = {}) {
  const tag = randomBytes(4).toString("hex");
  const { user: adminUser } = await store.createUser(`Admin ${tag}`, ["admin"]);
  const { user: lpUser } = await store.createUser(`Lena ${tag}`, ["license_provider"]);
  const { held, registration } = await moneyTransmitter(store, lpUser, covers);
  const { user: builderUser } = await store.createUser(`Neo ${tag}`, ["innovator"]);
  const builderFirm = await store.createEntity(builderUser.id, { name: `Builder ${tag}`, registration_numbers: {}, regions: ["US"] });
  await store.setUserEntity(builderUser.id, builderFirm.id);
  builderUser.entity_id = builderFirm.id;
  const product_id = `rail-product-${tag}`;
  const asked = await store.requestSponsorship(builderUser.id, { product_id, component_key: "account", builder_entity_id: builderFirm.id, provider_entity_id: lpUser.entity_id, requested_jurisdictions: jurisdictions, note: null });
  await store.decideSponsorship(asked.id, { status: "approved", decided_by: lpUser.id, note: null, licence_ids: [held.id], jurisdictions });
  const admin = await connect(store, adminUser);
  const provider = await connect(store, lpUser);
  const builder = await connect(store, builderUser);
  const RAIL = { kind: "ramp_adapter", provider: "bridge", direction: "off_ramp", states: ["us-ny"], per_transfer_limit_cents: 50_000, daily_limit_cents: 100_000 };
  const approvedRail = async (fields = {}) => {
    const rail = await ok(provider, "propose_rail", { ...RAIL, ...fields });
    return ok(admin, "approve_rail", { rail_id: rail.id });
  };
  const move = (over = {}) => ({
    product_id,
    sandbox: false,
    direction: "off_ramp",
    amount_cents: 10_000,
    channel: { kind: "ramp_adapter", provider: "bridge" },
    customer_state: "us-ny",
    customer_ref: "cust_1",
    idempotency_key: randomUUID(),
    subscription_id: randomUUID(),
    request_id: randomUUID(),
    ...over,
  });
  const ledger = async (railId) => (await store.db.query("SELECT * FROM financial_products.money_movements WHERE rail_id = $1 AND NOT sandbox ORDER BY created_at", [railId])).rows;
  const audited = async (action) => (await store.db.query("SELECT * FROM financial_products.audit_log WHERE action = $1", [action])).rows;
  return { store, tag, admin, provider, builder, RAIL, approvedRail, move, ledger, audited, product_id, lpUser, adminUser, held, registration, builderUser, builderFirm };
}

test("dollars become integer cents without a float", () => {
  assert.equal(centsOf("100.00"), 10_000);
  assert.equal(centsOf("0.07"), 7);
  assert.equal(centsOf("19.9"), 1_990);
  assert.equal(centsOf(250), 25_000);
  for (const bad of ["1.005", "-1", "abc", "", null, "0", "1e5"]) assert.equal(centsOf(bad), null, String(bad));
});

test("no approved rail, no movement; the refusal is clear and audited", async () => {
  const store = await openPglite();
  const w = await world(store);
  const refused = await authorizeMovement(store, w.move());
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "no_approved_rail");
  assert.match(refused.message, /off_ramp/);
  const [row] = await w.audited("money_movement_refused");
  assert.equal(row.target, w.product_id);
  assert.equal(row.details.code, "no_approved_rail");
  assert.equal(row.details.amount_cents, 10_000);

  // A rail that's only proposed moves nothing, and neither does a rail for the other direction.
  const proposed = await ok(w.provider, "propose_rail", w.RAIL);
  assert.equal(proposed.status, "proposed");
  assert.equal((await authorizeMovement(store, w.move())).code, "no_approved_rail");
  await w.approvedRail({ direction: "on_ramp" });
  assert.equal((await authorizeMovement(store, w.move())).code, "no_approved_rail");

  // A product nobody sponsors has no rails at all.
  assert.equal((await authorizeMovement(store, w.move({ product_id: "unsponsored" }))).code, "no_sponsor");
  // What Mynt can't size or place isn't allowed through.
  assert.equal((await authorizeMovement(store, w.move({ amount_cents: null }))).code, "amount_unknown");
  assert.equal((await authorizeMovement(store, w.move({ direction: null }))).code, "movement_unknown");
});

test("the customer's state must be on the rail and sponsored", async () => {
  const store = await openPglite();
  const w = await world(store);
  await w.approvedRail();
  assert.equal((await authorizeMovement(store, w.move())).allowed, true);
  assert.equal((await authorizeMovement(store, w.move({ customer_state: "US-NY" }))).allowed, true, "ISO's capitals count");
  // Sponsored in California, but this rail is New York's only.
  const ca = await authorizeMovement(store, w.move({ customer_state: "us-ca" }));
  assert.equal(ca.code, "state_not_on_rail");
  // Not sponsored in Texas at all.
  assert.equal((await authorizeMovement(store, w.move({ customer_state: "us-tx" }))).code, "state_not_sponsored");
  // No state on file: asked for, in the customer's terms.
  const none = await authorizeMovement(store, w.move({ customer_state: undefined }));
  assert.equal(none.code, "customer_state_required");
  assert.equal(none.status, 409);
  assert.equal((await authorizeMovement(store, w.move({ customer_state: "california" }))).code, "customer_state_required");
});

test("over the per-transfer limit is refused and counts for nothing", async () => {
  const store = await openPglite();
  const w = await world(store);
  const rail = await w.approvedRail();
  assert.equal((await authorizeMovement(store, w.move({ amount_cents: 50_001 }))).code, "over_transfer_limit");
  assert.equal((await w.ledger(rail.id)).length, 0);
  assert.equal((await authorizeMovement(store, w.move({ amount_cents: 50_000 }))).allowed, true, "exactly the limit is fine");
});

async function dailyLimitRace(store) {
  const w = await world(store);
  const rail = await w.approvedRail({ per_transfer_limit_cents: 30_000, daily_limit_cents: 100_000 });
  const verdicts = await Promise.all(Array.from({ length: 12 }, () => authorizeMovement(store, w.move({ amount_cents: 30_000 }))));
  const allowed = verdicts.filter((v) => v.allowed);
  assert.equal(allowed.length, 3, JSON.stringify(verdicts.map((v) => v.code ?? "ok")));
  for (const v of verdicts.filter((x) => !x.allowed)) assert.equal(v.code, "over_daily_limit");
  const rows = await w.ledger(rail.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.reduce((n, r) => n + Number(r.amount_cents), 0), 90_000);
  // A failed movement frees its share of the day; nothing else does.
  await recordMovementFailed(store, { subscription_id: rows[0].subscription_id, request_id: rows[0].request_id }, "partner_failed");
  assert.equal((await authorizeMovement(store, w.move({ amount_cents: 30_000 }))).allowed, true);
  assert.equal((await authorizeMovement(store, w.move({ amount_cents: 30_000 }))).code, "over_daily_limit");
}

test("the daily limit holds under concurrent requests (in-process Postgres)", async () => {
  await dailyLimitRace(await openPglite());
});

test("the daily limit holds under concurrent requests (a real Postgres with a connection pool)", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  // Its own database, so seeding it can't disturb another test file sharing this server.
  const name = `rails_${randomBytes(4).toString("hex")}`;
  const root = connectPostgres(process.env.TEST_DATABASE_URL);
  await root.exec(`CREATE DATABASE ${name}`);
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = connectPostgres(url.href);
  try {
    await dailyLimitRace(await Store.open(db, CATALOG));
  } finally {
    await db.close();
    await root.exec(`DROP DATABASE ${name}`).catch(() => {}); // best effort: a closing connection may still hold it
    await root.close();
  }
});

test("a suspended or revoked rail stops new movements at once; in-flight ones are reported, not cancelled", async () => {
  const store = await openPglite();
  const w = await world(store);
  const rail = await w.approvedRail();
  const first = w.move();
  const inFlight = await authorizeMovement(store, first);
  assert.equal(inFlight.allowed, true);
  await recordMovementPending(store, first);

  const suspended = await ok(w.admin, "suspend_rail", { rail_id: rail.id, reason: "partner incident" });
  assert.equal(suspended.status, "suspended");
  assert.deepEqual(suspended.in_flight.map((m) => m.id), [inFlight.movement_id]);
  const stopped = await authorizeMovement(store, w.move());
  assert.equal(stopped.allowed, false);
  assert.equal(stopped.code, "rail_suspended");

  // The one in flight runs on to its end.
  await recordMovementOutput(store, first, { transfer_status: "settled", settlement_ref: "tr_1" });
  const [row] = await w.ledger(rail.id);
  assert.equal(row.status, "settled");
  assert.equal(row.external_ref, "tr_1");

  // Back on, then off for good.
  await ok(w.admin, "approve_rail", { rail_id: rail.id });
  assert.equal((await authorizeMovement(store, w.move())).allowed, true);
  await ok(w.admin, "revoke_rail", { rail_id: rail.id, reason: "agreement ended" });
  assert.equal((await authorizeMovement(store, w.move())).code, "rail_revoked");
  assert.match(JSON.stringify((await callTool(w.admin, "approve_rail", { rail_id: rail.id })).data), /revoked/);

  for (const action of ["propose_rail", "approve_rail", "suspend_rail", "revoke_rail"]) assert.ok((await w.audited(action)).some((a) => a.target === rail.id), `${action} is audited`);
  const [sus] = (await w.audited("suspend_rail")).filter((a) => a.target === rail.id);
  assert.equal(sus.details.in_flight, 1);
});

test("a retry of one idempotency key doesn't count twice, in order or at once", async () => {
  const store = await openPglite();
  const w = await world(store);
  const rail = await w.approvedRail({ per_transfer_limit_cents: 60_000, daily_limit_cents: 100_000 });
  const key = randomUUID();
  const verdicts = await Promise.all([1, 2, 3, 4].map(() => authorizeMovement(store, w.move({ idempotency_key: key, amount_cents: 60_000 }))));
  assert.ok(verdicts.every((v) => v.allowed), JSON.stringify(verdicts));
  assert.equal(new Set(verdicts.map((v) => v.movement_id)).size, 1);
  assert.equal((await w.ledger(rail.id)).length, 1, "one row");
  // Only 60,000 of the 100,000 is used: a different 40,000 still fits, one more cent doesn't.
  assert.equal((await authorizeMovement(store, w.move({ amount_cents: 40_001 }))).code, "over_daily_limit");

  // A retry that came back with no clear answer is the same movement, and so is one after a clean failure.
  const again = await authorizeMovement(store, w.move({ idempotency_key: key, amount_cents: 60_000 }));
  assert.equal(again.replay, false);
  assert.equal((await w.ledger(rail.id)).length, 1);
  const [row] = await w.ledger(rail.id);
  await recordMovementFailed(store, { subscription_id: row.subscription_id, request_id: row.request_id }, "partner_failed");
  const retried = await authorizeMovement(store, w.move({ idempotency_key: key, amount_cents: 60_000, request_id: randomUUID() }));
  assert.equal(retried.allowed, true);
  assert.equal(retried.movement_id, row.id);
  const rows = await w.ledger(rail.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "requested");

  // Finished: a replay, nothing is instructed again.
  await recordMovementOutput(store, { subscription_id: rows[0].subscription_id, request_id: rows[0].request_id }, { transfer_status: "settled" });
  const replay = await authorizeMovement(store, w.move({ idempotency_key: key, amount_cents: 60_000 }));
  assert.equal(replay.replay, true);
  assert.equal(replay.status, "settled");

});

test("a key reused for a different transfer is refused", async () => {
  const store = await openPglite();
  const w = await world(store);
  await w.approvedRail();
  const key = randomUUID();
  assert.equal((await authorizeMovement(store, w.move({ idempotency_key: key, amount_cents: 1_000 }))).allowed, true);
  assert.equal((await authorizeMovement(store, w.move({ idempotency_key: key, amount_cents: 2_000 }))).code, "idempotency_conflict");
});

test("approval refuses a state outside the firm's verified licences, and a licence that lapses stops the rail", async () => {
  const store = await openPglite();
  const w = await world(store, { covers: ["us-ny"] });
  const rail = await ok(w.provider, "propose_rail", { ...w.RAIL, states: ["us-ny", "us-tx"] });
  assert.deepEqual(rail.outside_licence_coverage, ["us-tx"], "the proposer sees it coming");
  const refused = await callTool(w.admin, "approve_rail", { rail_id: rail.id });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.data.outside_licence_coverage, ["us-tx"]);
  const [listed] = await ok(w.provider, "list_rails", {});
  assert.equal(listed.status, "proposed");
  assert.ok((await w.audited("approve_rail_refused")).length);

  const good = await w.approvedRail({ direction: "on_ramp", states: ["us-ny"] });
  assert.equal(good.status, "approved");
  assert.equal(good.approved_by, w.adminUser.id);
  assert.ok(good.approved_at);

  // A movement checks the licence again: suspended licence, no movement.
  assert.equal((await authorizeMovement(store, w.move({ direction: "on_ramp" }))).allowed, true);
  await store.reviewLicense(w.held.id, "rejected", w.adminUser.id, "lapsed");
  assert.equal((await authorizeMovement(store, w.move({ direction: "on_ramp" }))).code, "licence_not_in_force");
});

test("only a licence granting money transmission counts, with its FinCEN prerequisite, state by state", async () => {
  const store = await openPglite();
  // A deposits-only licence, however verified, is no licence to move money.
  const a = await world(store);
  const { user: depositsOnly } = await store.createUser("Deposits", ["license_provider"]);
  await licensed(store, depositsOnly, { region: "US" });
  const client = await connect(store, depositsOnly);
  const rail = await ok(client, "propose_rail", a.RAIL);
  assert.deepEqual(rail.outside_licence_coverage, ["us-ny"]);
  const refused = await callTool(a.admin, "approve_rail", { rail_id: rail.id });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.data.outside_licence_coverage, ["us-ny"]);

  // The FinCEN registration lapsing takes the state licence with it, at the chokepoint and at approval.
  const r1 = await a.approvedRail();
  assert.equal((await authorizeMovement(store, a.move())).allowed, true);
  await store.reviewLicense(a.registration.id, "rejected", a.adminUser.id, "lapsed");
  assert.equal((await authorizeMovement(store, a.move())).code, "licence_not_in_force");
  await ok(a.admin, "suspend_rail", { rail_id: r1.id, reason: "looking into it" });
  assert.deepEqual((await callTool(a.admin, "approve_rail", { rail_id: r1.id })).data.outside_licence_coverage, ["us-ny"]);

  // A licence claiming the whole country doesn't clear each state: money transmission is licensed state by state.
  const nationwide = await openPglite();
  const b = await world(nationwide, { covers: ["us"] });
  const nw = await ok(b.provider, "propose_rail", b.RAIL);
  assert.deepEqual((await callTool(b.admin, "approve_rail", { rail_id: nw.id })).data.outside_licence_coverage, ["us-ny"]);

  // Only the licences the sponsorship is under count at the chokepoint, not any other the firm holds.
  const c = await world(await openPglite());
  await c.approvedRail();
  await c.store.db.query("UPDATE financial_products.sponsorships SET licence_ids = '{}' WHERE product_id = $1", [c.product_id]);
  assert.equal((await authorizeMovement(c.store, c.move())).code, "licence_not_in_force");
});

test("the sponsor must be the action's own; no component and several sponsors is refused", async () => {
  const store = await openPglite();
  const w = await world(store);
  await w.approvedRail();
  assert.equal((await authorizeMovement(store, w.move({ component_key: "account" }))).allowed, true);
  // The product has a sponsor, but not of what this action serves.
  assert.equal((await authorizeMovement(store, w.move({ component_key: "lending" }))).code, "component_not_sponsored");

  const { user: second } = await store.createUser("Second", ["license_provider"]);
  const { held } = await moneyTransmitter(store, second, ["us-ny", "us-ca"]);
  const asked = await store.requestSponsorship(w.builderUser.id, { product_id: w.product_id, component_key: "lending", builder_entity_id: w.builderFirm.id, provider_entity_id: second.entity_id, requested_jurisdictions: ["us-ny"], note: null });
  await store.decideSponsorship(asked.id, { status: "approved", decided_by: second.id, note: null, licence_ids: [held.id], jurisdictions: ["us-ny"] });
  assert.equal((await authorizeMovement(store, w.move())).code, "sponsor_ambiguous");
  assert.equal((await authorizeMovement(store, w.move({ component_key: "account" }))).allowed, true);
  // The other sponsor has no rail, and the first one's doesn't serve its component.
  assert.equal((await authorizeMovement(store, w.move({ component_key: "lending" }))).code, "no_approved_rail");
});

test("whoever proposed a rail, or works for its firm, can't approve it", async () => {
  const store = await openPglite();
  const w = await world(store);
  const { user: both } = await store.createUser("Both", ["admin", "license_provider"]);
  await store.setUserEntity(both.id, w.lpUser.entity_id);
  both.entity_id = w.lpUser.entity_id;
  const insider = await connect(store, both);
  const own = await ok(insider, "propose_rail", w.RAIL);
  assert.match(JSON.stringify((await callTool(insider, "approve_rail", { rail_id: own.id })).data), /another admin must/);
  await ok(w.admin, "approve_rail", { rail_id: own.id });
  await ok(w.admin, "suspend_rail", { rail_id: own.id, reason: "check" });
  // A colleague at the firm, who didn't propose it: still the firm's own.
  const { user: colleague } = await store.createUser("Colleague", ["admin"]);
  await store.setUserEntity(colleague.id, w.lpUser.entity_id);
  colleague.entity_id = w.lpUser.entity_id;
  assert.match(JSON.stringify((await callTool(await connect(store, colleague), "approve_rail", { rail_id: own.id })).data), /another admin must/);
});

test("partner refusals: only the allowlist, and no server error, mean nothing moved", () => {
  for (const c of ["partner_customer_required", "partner_customer_not_ready", "unknown_quote"]) assert.equal(isDefiniteRefusal(c, undefined), true, c);
  for (const c of ["partner_bad_answer", "partner_internal_server_error", "partner_rate_limited", "partner_error", "partner_unreachable", "whatever"]) assert.equal(isDefiniteRefusal(c, undefined), false, c);
  assert.equal(isDefiniteRefusal(null, undefined), false);
  assert.equal(isDefiniteRefusal("partner_customer_not_ready", 400), true);
  assert.equal(isDefiniteRefusal("partner_customer_not_ready", 503), false);
});

test("a service that accepts a quote takes its figures from the quote, never from what the device sends", () => {
  const device = { direction: "on", amount_usd: "1.00" };
  assert.deepEqual(movementShape({ key: "ramp_transfer", accepts: "ramp_quote" }, device, null), { direction: null, amount_cents: null, expected_total_cents: null });
  assert.deepEqual(movementShape({ key: "ramp_transfer", accepts: "ramp_quote" }, device, { direction: "off", amount_usd: "90.00", total_usd: "91.00" }), { direction: "off_ramp", amount_cents: 9_000, expected_total_cents: 9_100 });
  assert.deepEqual(movementShape({ key: "ramp_direct" }, device), { direction: "on_ramp", amount_cents: 100, expected_total_cents: null });
});

test("the customer's state comes from one place, and what it was is on the movement", async () => {
  assert.deepEqual(resolveCustomerState({ residence_state: "US-NY" }), { state: "us-ny", source: "customer_attested" });
  assert.deepEqual(resolveCustomerState({}), { state: null, source: "customer_attested" });
  const store = await openPglite();
  const w = await world(store);
  const rail = await w.approvedRail();
  await authorizeMovement(store, w.move({ customer_state: "us-ny", state_source: "customer_attested" }));
  const [row] = await w.ledger(rail.id);
  assert.deepEqual([row.state, row.state_source], ["us-ny", "customer_attested"]);
});

test("what settled is kept, and a difference from the quote is flagged", async () => {
  const store = await openPglite();
  const w = await world(store);
  const rail = await w.approvedRail();
  const rowOf = async (m) => (await w.ledger(rail.id)).find((r) => r.request_id === m.request_id);
  const same = w.move({ expected_total_cents: 9_950 });
  await authorizeMovement(store, same);
  await recordMovementOutput(store, same, { transfer_status: "settled", total_usd: "99.50" });
  assert.deepEqual([Number((await rowOf(same)).settled_amount_cents), (await rowOf(same)).settled_amount_differs], [9_950, false]);
  const short = w.move({ expected_total_cents: 9_950 });
  await authorizeMovement(store, short);
  await recordMovementOutput(store, short, { transfer_status: "settled", total_usd: "98.00" });
  assert.deepEqual([Number((await rowOf(short)).settled_amount_cents), (await rowOf(short)).settled_amount_differs], [9_800, true]);
  assert.ok((await w.audited("money_movement_amount_differs")).length);
  // A partner that doesn't say: unknown, not zero and not a match.
  const silent = w.move();
  await authorizeMovement(store, silent);
  await recordMovementOutput(store, silent, { transfer_status: "settled" });
  assert.equal((await rowOf(silent)).settled_amount_cents, null);
  assert.equal((await rowOf(silent)).settled_amount_differs, null);
});

test("tools: who can do what", async () => {
  const store = await openPglite();
  const w = await world(store);
  const names = async (c) => (await c.listTools()).tools.map((t) => t.name);
  for (const t of ["approve_rail", "suspend_rail", "revoke_rail"]) {
    assert.ok(!(await names(w.provider)).includes(t), `a licence provider can't ${t}`);
    assert.ok((await names(w.admin)).includes(t));
  }
  assert.ok(!(await names(w.builder)).includes("list_rails"));

  // An unknown adapter, an unknown state, limits the wrong way round.
  assert.equal((await callTool(w.provider, "propose_rail", { ...w.RAIL, provider: "nobody" })).isError, true);
  assert.equal((await callTool(w.provider, "propose_rail", { ...w.RAIL, states: ["us-zz"] })).isError, true);
  assert.equal((await callTool(w.provider, "propose_rail", { ...w.RAIL, per_transfer_limit_cents: 200_000 })).isError, true);
  assert.equal((await callTool(w.provider, "propose_rail", { ...w.RAIL, per_transfer_limit_cents: 10.5 })).isError, true, "integer cents only");

  // One live rail per firm, kind, provider and direction.
  const rail = await ok(w.provider, "propose_rail", w.RAIL);
  assert.match(JSON.stringify((await callTool(w.provider, "propose_rail", w.RAIL)).data), /already has/);

  // Another firm sees neither its rails nor its movements; an admin sees both.
  await ok(w.admin, "approve_rail", { rail_id: rail.id });
  assert.equal((await authorizeMovement(store, w.move())).allowed, true);
  const other = await world(store);
  assert.deepEqual(await ok(other.provider, "list_rails", {}), []);
  assert.deepEqual(await ok(other.provider, "list_money_movements", {}), []);
  assert.deepEqual(await ok(other.builder, "list_money_movements", {}), []);
  const mine = await ok(w.provider, "list_money_movements", {});
  assert.equal(mine.length, 1);
  assert.equal(mine[0].amount_cents, 10_000);
  assert.equal(mine[0].state, "us-ny");
  assert.match(mine[0].customer_key, /^[0-9a-f]{40}$/);
  assert.ok(!JSON.stringify(mine).includes("cust_1"), "the ledger holds a pseudonymous key, not the reference");
  assert.equal((await ok(w.admin, "list_rails", {})).length >= 1, true);
  assert.equal((await ok(w.admin, "list_money_movements", { rail_id: rail.id })).length, 1);
});

test("a movement's status only moves forward", async () => {
  const store = await openPglite();
  const w = await world(store);
  const rail = await w.approvedRail();
  const m = w.move();
  await authorizeMovement(store, m);
  const status = async () => (await w.ledger(rail.id))[0].status;
  await recordMovementOutput(store, m, { transfer_status: "settled", settlement_ref: "x" });
  await recordMovementPending(store, m);
  assert.equal(await status(), "settled", "a late 'submitted' doesn't undo a settlement");
  await recordMovementFailed(store, m, "too_late");
  assert.equal(await status(), "settled");
  await recordMovementReversed(store, m);
  assert.equal(await status(), "reversed");

  // A bank return before settlement is a failure, not a reversal.
  const b = w.move();
  await authorizeMovement(store, b);
  await recordMovementOutput(store, b, { transfer_status: "returned" });
  assert.equal((await w.ledger(rail.id)).find((r) => r.request_id === b.request_id).status, "failed");
});

test("flowsFor: null for what can't be measured, never 0", async () => {
  const store = await openPglite();
  const w = await world(store);
  const later = new Date(Date.now() + 3600_000);
  const unknown = await flowsFor(store, "no-such-product", new Date(), later);
  assert.equal(unknown.measured, false);
  assert.equal(unknown.flows.on_ramp, null);
  assert.equal(unknown.not_measured.on_ramp, "no such product");
  await assert.rejects(flowsFor(store, "x", later, new Date(0)), RangeError);
});

test("end to end: a live transfer goes through the chokepoint, and the ledger follows it", async () => {
  const ctx = await setup();
  const { store, call } = ctx;
  const VENDOR = { vendors: VENDOR_OPTS };
  const connectV = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, VENDOR).connect(s);
    const client = new Client({ name: "rails-e2e", version: "0" });
    await client.connect(c);
    return client;
  };
  const must = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const admin = await connectV(adminUser);
  const innovator = await connectV(ctx.user);

  // The ramp partner: it quotes, and takes transfers; how it answers is set per test.
  const partner = { transfers: [], answer: "submitted" };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.endsWith("/v1/ramp_quote"))
      return res.end(JSON.stringify({ request_id: body.request_id, status: "ok", output: { quote_id: `q_${randomUUID()}`, expires_at: new Date(Date.now() + 60_000).toISOString(), direction: "on", amount_usd: body.params.amount_usd, currency: "USD" } }));
    partner.transfers.push(body);
    if (partner.answer === "refused") return res.end(JSON.stringify({ request_id: body.request_id, status: "error", output: null, error: { code: "unknown_quote", message: "no" } }));
    if (partner.answer === "vague") return res.end(JSON.stringify({ request_id: body.request_id, status: "error", output: null, error: { code: "try_later", message: "hm" } }));
    res.end(JSON.stringify({ request_id: body.request_id, status: "ok", output: { transfer_status: "submitted", settlement_ref: null } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => (server.closeAllConnections(), server.close()));
  const partnerUrl = `http://127.0.0.1:${server.address().port}`;

  const inputSchema = { type: "object", required: ["full_name"], properties: { full_name: { type: "string" } }, additionalProperties: false };
  await must(admin, "define_service_type", {
    service_type: {
      region: "IN",
      key: "ramp_quote",
      name: "Ramp quote",
      category: "ramp",
      input_schema: inputSchema,
      params_schema: { type: "object", required: ["direction", "amount_usd"], properties: { direction: { enum: ["on", "off"] }, amount_usd: { type: "string" } }, additionalProperties: false },
      params_fixture: { direction: "on", amount_usd: "100.00" },
      output_schema: {
        type: "object",
        required: ["quote_id", "expires_at", "direction", "amount_usd", "currency"],
        properties: { quote_id: { type: "string" }, expires_at: { type: "string" }, direction: { enum: ["on", "off"] }, amount_usd: { type: "string" }, currency: { enum: ["USD"] } },
        additionalProperties: false,
      },
      quote: true,
      consent_purpose: "fiat_ramp_transfer",
      vendor_licences: ["rbi_pa"],
      client_result: { fields: ["direction", "amount_usd", "currency"], redirect: false },
    },
  });
  await must(admin, "define_service_type", {
    service_type: {
      region: "IN",
      key: "ramp_transfer",
      name: "Ramp transfer",
      category: "ramp",
      input_schema: inputSchema,
      output_schema: { type: "object", required: ["transfer_status"], properties: { transfer_status: { enum: ["submitted", "settled", "failed", "returned"] }, settlement_ref: { type: ["string", "null"] } }, additionalProperties: false },
      accepts: "ramp_quote",
      moves_money: true,
      consent_purpose: "fiat_ramp_transfer",
      vendor_licences: ["rbi_pa"],
      client_result: { status: { from: "transfer_status", map: { submitted: "pending", settled: "completed", failed: "failed", returned: "failed" } }, fields: ["transfer_status"], redirect: false },
    },
  });
  // What moves money is declared: not by its category or its name alone, and a quote can't be one.
  const plain = { region: "IN", name: "Plain", input_schema: inputSchema, output_schema: { type: "object", properties: {}, additionalProperties: false }, consent_purpose: "x", vendor_licences: [], client_result: { fields: [], redirect: false } };
  assert.match(JSON.stringify((await call(admin, "define_service_type", { service_type: { ...plain, key: "bank_payout", name: "Payouts", category: "other" } })).data), /declare moves_money/);
  assert.match(JSON.stringify((await call(admin, "define_service_type", { service_type: { ...plain, key: "ramp_undeclared", category: "ramp" } })).data), /declare moves_money/);
  const quoteOutput = { type: "object", required: ["quote_id", "expires_at"], properties: { quote_id: { type: "string" }, expires_at: { type: "string" } }, additionalProperties: false };
  assert.match(JSON.stringify((await call(admin, "define_service_type", { service_type: { ...plain, key: "ramp_transfer_quote", category: "ramp", quote: true, output_schema: quoteOutput } })).data), /named as a transfer/);
  assert.match(JSON.stringify((await call(admin, "define_service_type", { service_type: { ...plain, key: "ramp_price", category: "ramp", quote: true, moves_money: true, output_schema: quoteOutput } })).data), /a quote only prices/);

  // The ramp firm, with its partner listed as live.
  await must(admin, "invite_user", { email: "ops@rampco.example", roles: ["vendor"] });
  const rampFirm = await must(admin, "register_firm", { name: "RampCo", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const rampUser = await store.upsertClerkUser("clerk_rampco", "ops@rampco.example", "RampCo", (await store.getInvite("ops@rampco.example")).roles);
  await must(admin, "add_entity_member", { email: "ops@rampco.example", entity_id: rampFirm.id });
  const rampClient = await connectV(rampUser);
  const rampLic = await must(rampClient, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: "PA-1" });
  await must(admin, "review_license", { license_record_id: rampLic.id, decision: "verified", note: "ok" });
  await must(admin, "set_mynt_ramp", { entity_id: rampFirm.id });
  const offerings = {};
  const subs = {};
  // A ramp's test and live endpoints can't be the same one.
  const clash = await call(rampClient, "create_vendor_offering", { region: "IN", service_type: "ramp_quote", name: "same", price: { amount: 0, currency: "INR" }, test_base_url: partnerUrl, live_base_url: `${partnerUrl}/`, licence_ids: [rampLic.id] });
  assert.match(JSON.stringify(clash.data), /must be different endpoints/);
  for (const key of ["ramp_quote", "ramp_transfer"]) {
    const o = await must(rampClient, "create_vendor_offering", { region: "IN", service_type: key, name: key, price: { amount: 0, currency: "INR" }, test_base_url: partnerUrl, licence_ids: [rampLic.id] });
    await store.db.query("UPDATE financial_products.vendor_offerings SET status = 'listed', live_base_url = $2 WHERE id = $1", [o.id, partnerUrl]);
    offerings[key] = o.id;
    if (key === "ramp_quote") assert.match(JSON.stringify((await call(rampClient, "update_vendor_offering", { offering_id: o.id, test_base_url: partnerUrl })).data), /must be different endpoints/);
    subs[key] = await must(innovator, "subscribe_vendor_service", { offering_id: o.id });
    await store.db.query("UPDATE financial_products.vendor_subscriptions SET live = true WHERE id = $1", [subs[key].subscription_id]);
  }
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/kfs.pdf" };
    for (const [id, key] of [["get_quote", "ramp_quote"], ["transfer", "ramp_transfer"]]) {
      d.partner_handoffs.push({ _id: id, name: id, trigger: "account_opened", sends: { type: "object", required: ["full_name"] }, returns: { type: "object", required: ["status"] } });
      d.connections.push(
        { _id: `h_${id}`, type: "handoff_to_party", from: { kind: "partner_handoff", id }, to: { kind: "party", id: subs[key].vendor_party_id }, attributes: { sla: "PT1M", consent_purpose: "fiat_ramp_transfer", channel: "api", vendor_subscription_id: subs[key].subscription_id, service_type: key } },
        { _id: `s_${id}`, type: "handoff_serves_component", from: { kind: "partner_handoff", id }, to: { kind: "component", id: "deposit" } },
      );
    }
    return d;
  });
  const P = "everyday-rd";
  await must(ctx.client, "set_product_access", { id: P, access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: "https://bank.example.com/start" } });

  // A live app on the product.
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const dev = await connectV(devUser);
  const app = await must(dev, "create_app", { name: "Dollars", description: "In and out", audience: "Savers", product_ids: [P] });
  await store.db.query("UPDATE financial_products.apps SET status = 'published' WHERE id = $1", [app.id]);
  const key = (await must(dev, "create_api_key", { app_id: app.id, environment: "live", label: "live" })).key;
  const s = createMcpHttpServer(store, null, VENDOR, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS }).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  closers.push(() => (s.closeAllConnections(), s.close()));
  const base = `http://127.0.0.1:${s.address().port}`;
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const session = (customer_ref) => api("POST", "/v1/client_sessions", key, { product_ids: [P], scopes: ["get_quote", "transfer"], customer_ref }).then((r) => r.body.client_secret);
  const device = await session("cust_rail_1");
  assert.equal((await api("POST", "/v1/client/evidence", device, { product_id: P, type: "consent_given", subject: "fiat_ramp_transfer" })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { full_name: "Avery Stone" } })).status, 201);
  const start = (action, extra) => api("POST", `/v1/client/actions/${action}`, device, { product_id: P, ...extra });
  const quote = async (amount = "100.00") => {
    const q = await start("get_quote", { params: { direction: "on", amount_usd: amount } });
    assert.equal(q.status, 201, q.text);
    return q.body.reference;
  };

  // No state on file yet: the transfer asks for it, the partner hears nothing, and the quote stays usable.
  const q1 = await quote();
  const noState = await start("transfer", { quote: q1 });
  assert.equal(noState.status, 409, noState.text);
  assert.equal(noState.body.error, "customer_state_required");
  assert.equal(partner.transfers.length, 0);

  // The customer's state is accepted, because this product moves money.
  const stateSet = await api("POST", "/v1/client/fields", device, { product_id: P, values: { residence_state: "us-ny" } });
  assert.equal(stateSet.status, 201, stateSet.text);

  // Nobody sponsors it: refused before anything is instructed.
  const noSponsor = await start("transfer", { quote: q1 });
  assert.equal(noSponsor.status, 403, noSponsor.text);
  assert.equal(noSponsor.body.error, "no_sponsor");

  // A licence provider sponsors it in New York, covered by its US licence.
  const { user: lpUser } = await store.createUser("Lena", ["license_provider"]);
  const { held } = await moneyTransmitter(store, lpUser, ["us-ny"]);
  const asked = await store.requestSponsorship(ctx.user.id, { product_id: P, component_key: "deposit", builder_entity_id: ctx.user.entity_id, provider_entity_id: lpUser.entity_id, requested_jurisdictions: ["us-ny"], note: null });
  await store.decideSponsorship(asked.id, { status: "approved", decided_by: lpUser.id, note: null, licence_ids: [held.id], jurisdictions: ["us-ny"] });
  const provider = await connectV(lpUser);

  const noRail = await start("transfer", { quote: q1 });
  assert.equal(noRail.status, 403, noRail.text);
  assert.equal(noRail.body.error, "no_approved_rail");
  assert.equal(partner.transfers.length, 0, "the partner never heard of it");

  // With an approved rail for this partner's offering, the same quote goes through.
  const proposed = await must(provider, "propose_rail", { kind: "ramp_adapter", provider: offerings.ramp_transfer, direction: "on_ramp", states: ["us-ny"], per_transfer_limit_cents: 15_000, daily_limit_cents: 40_000 });
  const rail = await must(admin, "approve_rail", { rail_id: proposed.id });
  const accepted = await start("transfer", { quote: q1 });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(accepted.body.status, "pending");
  assert.equal(partner.transfers.length, 1);
  const rowOf = async (id) => (await store.db.query("SELECT * FROM financial_products.money_movements WHERE idempotency_key = $1", [`quote:${id}`])).rows[0];
  let row = await rowOf(q1);
  assert.equal(row.status, "submitted");
  assert.equal(Number(row.amount_cents), 10_000);
  assert.equal(row.rail_id, rail.id);
  assert.equal(row.sandbox, false);
  assert.equal(row.direction, "on_ramp");
  assert.equal(row.state, "us-ny");
  assert.equal(row.sponsor_entity_id, lpUser.entity_id);
  assert.equal(row.state_source, "customer_attested");

  // If the run can't even be started, or fails before the partner is called, nothing moved: the reservation goes.
  const realQuery = store.db.query;
  for (const breaks of ["INSERT INTO financial_products.vendor_action_runs", "SELECT signing_secret AS v"]) {
    const q = await quote("20.00");
    store.db.query = (s, p) => (s.includes(breaks) ? Promise.reject(new Error("database went away")) : realQuery.call(store.db, s, p));
    const failed = await start("transfer", { quote: q });
    store.db.query = realQuery;
    assert.equal(failed.status, 500, failed.text);
    assert.deepEqual([(await rowOf(q)).status, (await rowOf(q)).status_detail], ["failed", "internal_before_call"], breaks);
  }
  assert.equal(partner.transfers.length, 1, "neither reached the partner");

  // Over the per-transfer limit, on the amount the customer was quoted.
  assert.equal((await start("transfer", { quote: await quote("150.01") })).body.error, "over_transfer_limit");
  assert.equal(partner.transfers.length, 1);

  // A clean refusal from the partner frees the day's limit; the movement is failed, and the quote can be retried.
  partner.answer = "refused";
  const q2 = await quote("100.00");
  assert.equal((await start("transfer", { quote: q2 })).status, 502);
  assert.equal((await rowOf(q2)).status, "failed");
  partner.answer = "submitted";
  const retried = await start("transfer", { quote: q2 });
  assert.equal(retried.status, 201, retried.text);
  assert.equal((await rowOf(q2)).status, "submitted");
  assert.equal((await store.db.query("SELECT count(*)::int AS n FROM financial_products.money_movements WHERE rail_id = $1 AND status <> 'failed'", [rail.id])).rows[0].n, 2);

  // An answer that isn't a clear refusal may have moved money: it stays open, and counts against the day.
  partner.answer = "vague";
  const q4 = await quote("100.00");
  assert.equal((await start("transfer", { quote: q4 })).status, 502);
  assert.deepEqual([(await rowOf(q4)).status, (await rowOf(q4)).status_detail], ["requested", "outcome_unknown:try_later"]);
  partner.answer = "submitted";

  // The day's limit: 300 used of 400, so another 100 fits and then nothing does.
  assert.equal((await start("transfer", { quote: await quote("100.00") })).status, 201);
  assert.equal((await start("transfer", { quote: await quote("50.00") })).body.error, "over_daily_limit");

  // The partner settles by signed callback; the ledger follows.
  const runRow = (await store.db.query("SELECT request_id, subscription_id FROM financial_products.vendor_action_runs WHERE id = $1", [accepted.body.reference])).rows[0];
  const cb = JSON.stringify({ request_id: runRow.request_id, status: "ok", output: { transfer_status: "settled", settlement_ref: "tr_9" } });
  const secret = (await must(rampClient, "reveal_subscription_secret", { subscription_id: runRow.subscription_id })).signing_secret;
  const answered = await fetch(`${base}/v1/vendor/callback/${runRow.subscription_id}`, { method: "POST", headers: { "Content-Type": "application/json", "Mynt-Signature": signBody(secret, cb) }, body: cb });
  assert.equal(answered.status, 200, await answered.text());
  row = await rowOf(q1);
  assert.equal(row.status, "settled");
  assert.equal(row.external_ref, "tr_9");
  assert.ok(row.settled_at);

  // What stage 2 reads: integer cents, by direction and status, and null for what Mynt doesn't instruct here.
  const flows = await flowsFor(store, P, await store.getSetting("money_ledger_started_at"), new Date(Date.now() + 60_000));
  assert.equal(flows.measured, true);
  assert.deepEqual(flows.flows.on_ramp.settled, { count: 1, amount_cents: 10_000 });
  assert.deepEqual(flows.flows.on_ramp.submitted, { count: 2, amount_cents: 20_000 });
  assert.deepEqual(flows.flows.on_ramp.requested, { count: 1, amount_cents: 10_000 });
  assert.deepEqual(flows.unresolved.on_ramp, { count: 0, amount_cents: 0 });
  assert.deepEqual(flows.flows.on_ramp.reversed, { count: 0, amount_cents: 0 });
  assert.equal(flows.flows.payout, null);
  assert.match(flows.not_measured.payout, /doesn't instruct/);
  // A period before the ledger existed can't be measured, even for this product.
  const before = await flowsFor(store, P, new Date("2020-01-01"), new Date("2020-02-01"));
  assert.equal(before.measured, false);
  assert.equal(before.flows.on_ramp, null);
  assert.match(before.not_measured.on_ramp, /before Mynt's money ledger/);

  // Suspended: the next transfer is refused and the partner isn't called; the ones in flight are named.
  const seen = partner.transfers.length;
  const q3 = await quote("10.00");
  const suspended = await must(admin, "suspend_rail", { rail_id: rail.id, reason: "partner incident" });
  assert.equal(suspended.in_flight.length, 3, "submitted or unanswered, and not settled");
  const stopped = await start("transfer", { quote: q3 });
  assert.equal(stopped.status, 403, stopped.text);
  assert.equal(stopped.body.error, "rail_suspended");
  assert.equal(partner.transfers.length, seen);

  // Dollars only for the device: a refusal names no rail provider or crypto concept.
  assert.doesNotMatch(stopped.text + noRail.text, /usdc|solana|wallet|chain|bridge/i);
  assert.ok((await store.db.query("SELECT 1 FROM financial_products.audit_log WHERE action = 'money_movement_refused'")).rows.length >= 3);

  // A partner's error after the run is over still reaches the ledger.
  const q2Row = await rowOf(q2);
  await store.db.query("UPDATE financial_products.vendor_action_runs SET status = 'expired' WHERE request_id = $1", [q2Row.request_id]);
  const lateError = JSON.stringify({ request_id: q2Row.request_id, status: "error", output: null, error: { code: "bank_rejected" } });
  assert.equal((await fetch(`${base}/v1/vendor/callback/${q2Row.subscription_id}`, { method: "POST", headers: { "Content-Type": "application/json", "Mynt-Signature": signBody(secret, lateError) }, body: lateError })).status, 200);
  assert.deepEqual([(await rowOf(q2)).status, (await rowOf(q2)).status_detail], ["failed", "partner_failed_late"]);

  // Nobody ever answers for the rest: swept, and reported apart from what's in flight or known to have failed.
  assert.equal(await sweepStaleMovements(store, { now: new Date(Date.now() - 3_600_000) }), 0, "not stale yet");
  assert.ok((await sweepStaleMovements(store, { now: new Date(Date.now() + 90 * 86_400_000) })) >= 2);
  const swept = await flowsFor(store, P, await store.getSetting("money_ledger_started_at"), new Date(Date.now() + 60_000));
  assert.deepEqual(swept.flows.on_ramp.requested, { count: 0, amount_cents: 0 });
  assert.deepEqual(swept.flows.on_ramp.submitted, { count: 0, amount_cents: 0 });
  assert.equal(swept.unresolved.on_ramp.count, 2);
  // ... and if it turns out the money moved, the partner's word still counts.
  const lastRow = (await store.db.query("SELECT * FROM financial_products.money_movements WHERE status_detail = 'stale_no_answer' AND rail_id = $1 LIMIT 1", [rail.id])).rows[0];
  const lateOk = JSON.stringify({ request_id: lastRow.request_id, status: "ok", output: { transfer_status: "settled", settlement_ref: "tr_late" } });
  await fetch(`${base}/v1/vendor/callback/${lastRow.subscription_id}`, { method: "POST", headers: { "Content-Type": "application/json", "Mynt-Signature": signBody(secret, lateOk) }, body: lateOk });
  const revived = (await store.db.query("SELECT status, status_detail FROM financial_products.money_movements WHERE id = $1", [lastRow.id])).rows[0];
  assert.deepEqual([revived.status, revived.status_detail], ["settled", "late_settlement"]);

  // Every change to the customer's state is kept, append-only, and erasing it is a change too.
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { residence_state: "us-ny" } })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { residence_state: "us-ca" } })).status, 201);
  assert.equal((await api("DELETE", "/v1/client/fields", device)).status, 200);
  const history = (await store.db.query("SELECT * FROM financial_products.customer_state_history ORDER BY created_at, new_state NULLS LAST")).rows;
  assert.deepEqual(history.map((h) => [h.old_state, h.new_state]), [[null, "us-ny"], ["us-ny", "us-ca"], ["us-ca", null]], "the same value twice is no change");
  assert.match(history[0].changed_by, /^session:/);
  assert.match(history[0].customer_key, /^[0-9a-f]{40}$/);
  assert.ok(!JSON.stringify(history).includes("cust_rail_1"));
  await assert.rejects(store.db.query("UPDATE financial_products.customer_state_history SET new_state = 'us-tx'"), /append-only/);
  await assert.rejects(store.db.query("DELETE FROM financial_products.customer_state_history"), /append-only/);
});
