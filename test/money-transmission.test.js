import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { CATALOG } from "./helpers.js";

// Money transmission is the first foundational product: the licensed ramp partner's firm publishes it in the
// states it holds a money transmitter licence in (each counting only alongside its FinCEN registration), and
// dollar products are built on it (builds_on) instead of declaring transmission again, inheriting its per-state
// coverage and its drift. On the US model as data (schemas/regulatory/us.json) and the two templates in
// schemas/examples/us/.

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));
const MODEL = read("../schemas/regulatory/us.json");
const BASE = read("../schemas/examples/us/money-transmission.v2.json");
const DOLLAR = read("../schemas/examples/us/dollar-account.v2.json");

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "money-transmission", version: "0" });
    await client.connect(c);
    return client;
  };
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
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const admin = await connect(adminUser);
  const applied = await applyRegulatoryModel({ call: (n, a) => call(admin, n, a), listTools: async () => (await admin.listTools()).tools, model: MODEL });
  assert.equal(applied.applied, true, JSON.stringify(applied.problems));

  const firm = async (name) => {
    const { user } = await store.createUser(name, ["innovator"]);
    const entity = await store.createEntity(user.id, { name: `${name} Inc`, registration_numbers: {}, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ny" } });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    const client = await connect(user);
    const f = { user, entity, call: (n, a) => call(client, n, a), people: [] };
    // Holds a verified licence and names the people it mandates on the roster.
    f.hold = async (regulator_id, license_id) => {
      const held = await store.registerLicense(adminUser.id, { entity_id: entity.id, region: "US", regulator_id, license_id, registration_number: `${license_id}-test`, valid_from: null, valid_to: null });
      await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
      const lt = MODEL.regulators.find((r) => r.id === regulator_id).license_types.find((l) => l._id === license_id);
      for (const s of lt.grc.mandatory_stakeholders.internal) {
        const p = await f.call("add_party", { kind: "internal", person: { name: s.name }, fills: [{ licence_id: held.id, stakeholder: s.id }] });
        assert.equal(p.isError, false, JSON.stringify(p.data));
        f.people.push(p.data.id);
      }
      return held;
    };
    return f;
  };
  return { store, admin, call: (n, a) => call(admin, n, a), firm };
}

const catalogue = (id, template, product_line, category) => ({
  id,
  name: template.product_name,
  product_line,
  category,
  region: "US",
  risk_level: "not_applicable",
  liquidity: "high",
  typical_horizon: "short",
  return_type: "fixed_interest",
  regulator: "FinCEN",
  description: template.descriptions.summary,
  key_features: template.descriptions.key_features.slice(0, 3),
});

// The base template, owned by the partner's firm, which provides transmission itself (the regime finds the
// state licence covering each state) and binds the people its licences mandate.
const baseDefinition = (f, offered_in = BASE.offered_in) => {
  const d = structuredClone(BASE);
  d.owner_entity_id = f.entity.id;
  d.offered_in = offered_in;
  d.connections.push(
    { _id: "p_transmission", type: "component_provided_by", from: { kind: "component", id: "transmission" }, to: { kind: "owner" }, attributes: { business_role: "issuer" } },
    { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "transmission" } },
    ...f.people.map((id, i) => ({ _id: `person_${i}`, type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "party", id }, attributes: { role: "compliance_officer", bound_component: "transmission" } })),
  );
  return d;
};

// The dollar account, owned by another firm, whose balance is held by the partner on its roster.
const dollarDefinition = (f, partyId, offered_in) => {
  const d = structuredClone(DOLLAR);
  d.owner_entity_id = f.entity.id;
  d.offered_in = offered_in;
  d.partner_handoffs = [{ _id: "open_balance", name: "Open the customer's balance with the partner", trigger: "account_opened", sends: { type: "object", required: ["customer_ref"] }, returns: { type: "object", required: ["balance_ref"] } }];
  d.connections.push(
    { _id: "p_balance", type: "component_provided_by", from: { kind: "component", id: "dollar_balance" }, to: { kind: "party", id: partyId }, attributes: { business_role: "custodian" } },
    { _id: "h_party", type: "handoff_to_party", from: { kind: "partner_handoff", id: "open_balance" }, to: { kind: "party", id: partyId }, attributes: { sla: "PT15M", consent_purpose: "account_opening", channel: "api" } },
    { _id: "h_serves", type: "handoff_serves_component", from: { kind: "partner_handoff", id: "open_balance" }, to: { kind: "component", id: "dollar_balance" } },
    { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "dollar_balance" } },
  );
  return d;
};

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const passes = async (f, id) => {
  const report = ok(await f.call("test_product", { id }));
  assert.equal(report.passed, true, JSON.stringify(report.checks.filter((c) => c.status === "fail")));
};

test("the templates check, and money transmission publishes only where a state licence and the FinCEN registration both cover it", async () => {
  const ctx = await setup();
  for (const t of [BASE]) assert.equal(ok(await ctx.call("check_product_definition", { definition: t })).valid, true);
  // Customers see dollars only: no USDC, chains or wallets in any customer-facing text.
  for (const t of [BASE, DOLLAR]) {
    const words = JSON.stringify([t.product_name, t.descriptions.summary, t.descriptions.key_features, t.terms?.map((x) => x.label), t.lifecycle_events?.map((x) => x._id)]);
    assert.doesNotMatch(words, /usdc|solana|stablecoin|crypto|wallet|token|chain/i, t._id);
  }

  const partner = await ctx.firm("Ramp Partner");
  ok(await partner.call("create_product", catalogue("money-transmission", BASE, "payments", "money_transmission")));

  // The FinCEN registration alone covers nothing, in any state or in the country as a whole.
  await partner.hold("fincen", "fincen_msb");
  const fincenOnly = ok(await partner.call("check_product_definition", { product_id: "money-transmission", definition: baseDefinition(partner) }));
  assert.equal(fincenOnly.valid, true, JSON.stringify(fincenOnly.errors));
  assert.deepEqual(fincenOnly.publish_blockers.map((b) => b.jurisdiction), ["us-ny", "us-ca"]);
  for (const b of fincenOnly.publish_blockers) assert.match(b.reason, /fincen_msb covers nowhere by itself/);
  assert.match(fincenOnly.publish_blockers[0].reason, /needs one covering us-ny: nydfs_money_transmitter/);
  assert.match(fincenOnly.publish_blockers[1].reason, /needs one covering us-ca: ca_dfpi_money_transmitter/);
  const whole = ok(await partner.call("check_product_definition", { product_id: "money-transmission", definition: { ...baseDefinition(partner), offered_in: undefined } }));
  assert.equal(whole.publish_blockers.length, 1);
  assert.match(whole.publish_blockers[0].reason, /holds no verified licence granting this; needs one of: .*fincen_msb covers nowhere by itself/);

  // A state licence without the FinCEN registration doesn't count either.
  const unregistered = await ctx.firm("Unregistered");
  await unregistered.hold("nydfs", "nydfs_money_transmitter");
  ok(await unregistered.call("create_product", catalogue("mt-unregistered", BASE, "payments", "money_transmission")));
  const lone = ok(await unregistered.call("set_product_composition", { product_id: "mt-unregistered", components: [{ key: "transmission", country: "us", primitive: "payments", action: "sale", underlying: "cash", provider: { by: "self" }, offered_in: ["us-ny"] }] }));
  assert.match(lone.regions[0].components[0].coverage.reason, /nydfs_money_transmitter \(us-ny\) counts only alongside fincen_msb or fincen_money_services_business or fincen_msb_registration, verified and in force/);

  // New York's licence covers New York only; California still blocks.
  const ny = await partner.hold("nydfs", "nydfs_money_transmitter");
  const nyOnly = ok(await partner.call("check_product_definition", { product_id: "money-transmission", definition: baseDefinition(partner) }));
  assert.deepEqual(nyOnly.publish_blockers.map((b) => b.jurisdiction), ["us-ca"]);

  // With California's too, it publishes, and each state's licence is pinned with the FinCEN registration it relies on.
  const ca = await partner.hold("ca_dfpi", "ca_dfpi_money_transmitter");
  ok(await partner.call("set_product_definition", { product_id: "money-transmission", definition: baseDefinition(partner) }));
  await passes(partner, "money-transmission");
  ok(await partner.call("publish_product", { id: "money-transmission" }));
  const regime = ok(await partner.call("get_product_regime", { product_id: "money-transmission" }));
  const row = regime.regions[0].components[0];
  assert.deepEqual(row.jurisdictions.map((j) => [j.jurisdiction, j.coverage.by[0].license_id]), [["us-ny", "nydfs_money_transmitter"], ["us-ca", "ca_dfpi_money_transmitter"]]);
  const msb = (await ctx.store.licensesOf(partner.entity.id)).find((h) => h.license_id === "fincen_msb");
  for (const j of row.jurisdictions) assert.deepEqual(j.coverage.by[0].requires, [msb.id]);
  const pins = (await ctx.store.getProduct("money-transmission")).pins;
  assert.deepEqual(pins.licence_jurisdictions[ny.id], ["us-ny"]);
  assert.deepEqual(pins.licence_jurisdictions[ca.id], ["us-ca"]);
  assert.deepEqual(pins.licence_jurisdictions[msb.id], ["us-ny", "us-ca"]);

  // Suspending the FinCEN registration drifts it in both states.
  const suspended = ok(await ctx.call("review_license", { license_record_id: msb.id, decision: "suspended", note: "registration lapsed" }));
  assert.deepEqual(suspended.drifted_products, ["money-transmission"]);
  assert.deepEqual((await ctx.store.getProduct("money-transmission")).drift.changes.map((c) => [c.id, c.jurisdictions]), [[msb.id, ["us-ny", "us-ca"]]]);
});

test("a dollar account built on money transmission is offered only where the base is covered, and drifts with it", async () => {
  const ctx = await setup();
  const partner = await ctx.firm("Ramp Partner");
  await partner.hold("fincen", "fincen_msb");
  const ny = await partner.hold("nydfs", "nydfs_money_transmitter");
  await partner.hold("ca_dfpi", "ca_dfpi_money_transmitter");
  await partner.hold("occ", "occ_national_trust_bank");
  ok(await partner.call("create_product", catalogue("money-transmission", BASE, "payments", "money_transmission")));
  ok(await partner.call("set_product_definition", { product_id: "money-transmission", definition: baseDefinition(partner) }));

  const neo = await ctx.firm("Neo Dollars");
  const party = ok(await neo.call("add_party", { kind: "external", legal_entity_id: partner.entity.id, relationship: "custody_agreement" }));
  ok(await neo.call("create_product", catalogue("dollar-account", DOLLAR, "custody_settlement", "digital_asset_custody")));

  // The template checks; while the base is a draft, it says so and publishing waits for it.
  const draftBase = ok(await neo.call("check_product_definition", { product_id: "dollar-account", definition: dollarDefinition(neo, party.id, ["us-ny", "us-ca"]) }));
  assert.equal(draftBase.valid, true, JSON.stringify(draftBase.errors));
  assert.ok(draftBase.warnings.some((w) => /builds_on 'money-transmission' isn't published yet/.test(w)), JSON.stringify(draftBase.warnings));
  assert.ok(draftBase.publish_blockers.every((b) => b.key === "builds_on:money-transmission" && /isn't published/.test(b.reason)), JSON.stringify(draftBase.publish_blockers));
  await passes(partner, "money-transmission");
  ok(await partner.call("publish_product", { id: "money-transmission" }));

  // Offered in Texas too, where money transmission isn't: blocked there, with the base's reason; the balance
  // itself (custody under a national charter) is covered everywhere.
  const texas = ok(await neo.call("check_product_definition", { product_id: "dollar-account", definition: dollarDefinition(neo, party.id, ["us-ny", "us-ca", "us-tx"]) }));
  assert.deepEqual(texas.publish_blockers.map((b) => [b.key, b.jurisdiction]), [["builds_on:money-transmission", "us-tx"]]);
  assert.match(texas.publish_blockers[0].reason, /In us-tx: Built on 'money-transmission', which isn't offered in us-tx \(it's offered in us-ny, us-ca\)/);
  ok(await neo.call("set_product_definition", { product_id: "dollar-account", definition: dollarDefinition(neo, party.id, ["us-ny", "us-ca", "us-tx"]) }));
  assert.deepEqual((await ctx.store.getProduct("dollar-account")).underlying_product_ids, ["money-transmission"]);
  const coverage = ok(await neo.call("test_product", { id: "dollar-account" })).checks.find((c) => c.name === "composition_coverage");
  assert.equal(coverage.status, "fail");
  assert.match(coverage.message, /builds_on:money-transmission/);
  const refused = await neo.call("publish_product", { id: "dollar-account" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /builds_on:money-transmission .*In us-tx: Built on 'money-transmission'/);
  const stored = (await ctx.store.productDerived("dollar-account")).regime_summary;
  assert.deepEqual(stored.regions[0].built_on[0].jurisdictions.map((j) => [j.jurisdiction, j.covered]), [["us-ny", true], ["us-ca", true], ["us-tx", false]]);

  // Offered where the base is covered, it publishes, pinned to the base.
  ok(await neo.call("set_product_definition", { product_id: "dollar-account", definition: dollarDefinition(neo, party.id, ["us-ny", "us-ca"]) }));
  await passes(neo, "dollar-account");
  ok(await neo.call("publish_product", { id: "dollar-account" }));
  const pins = (await ctx.store.getProduct("dollar-account")).pins;
  assert.ok(pins.state.products["money-transmission"]);
  assert.ok(pins.entity_ids.includes(partner.entity.id));

  // Suspending the partner's New York licence drifts the base and the dollar account built on it.
  const suspended = ok(await ctx.call("review_license", { license_record_id: ny.id, decision: "suspended", note: "regulator order" }));
  assert.deepEqual([...suspended.drifted_products].sort(), ["dollar-account", "money-transmission"]);
  const baseDrift = (await ctx.store.getProduct("money-transmission")).drift;
  assert.deepEqual(baseDrift.changes.map((c) => [c.kind, c.id, c.jurisdictions]), [["licence", ny.id, ["us-ny"]]]);
  const drift = (await ctx.store.getProduct("dollar-account")).drift;
  assert.deepEqual(drift.changes.map((c) => [c.kind, c.id, c.jurisdictions]), [["product", "money-transmission", ["us-ny"]]]);
  assert.match(drift.note, /us-ny/);
  // While the base is paused, the dollar account's next version can't publish anywhere.
  const paused = ok(await neo.call("check_product_definition", { product_id: "dollar-account", definition: dollarDefinition(neo, party.id, ["us-ca"]) }));
  assert.match(paused.publish_blockers[0].reason, /whose sales are paused/);

  // Re-verifying clears both, in either order of the sweep.
  ok(await ctx.call("review_license", { license_record_id: ny.id, decision: "verified", note: "order lifted" }));
  assert.equal((await ctx.store.getProduct("money-transmission")).drift, null);
  assert.equal((await ctx.store.getProduct("dollar-account")).drift, null);

  // Unpublishing the base drifts the dollar account.
  const unpublished = ok(await partner.call("unpublish_product", { id: "money-transmission" }));
  assert.deepEqual(unpublished.drifted_products, ["dollar-account"]);
});

test("builds_on is checked: a real product, never itself, linked to real components", async () => {
  const ctx = await setup();
  const f = await ctx.firm("Checker");
  ok(await f.call("create_product", catalogue("dollar-account", DOLLAR, "custody_settlement", "digital_asset_custody")));
  const d = structuredClone(DOLLAR);
  d.owner_entity_id = f.entity.id;
  d.builds_on = [{ product_id: "nowhere-product" }, { product_id: "dollar-account" }, { product_id: "nowhere-2", funds: ["no_such_part"] }];
  const r = ok(await f.call("check_product_definition", { product_id: "dollar-account", definition: d }));
  assert.equal(r.valid, false);
  const errors = r.errors.join("\n");
  assert.match(errors, /builds_on 'nowhere-product': no product 'nowhere-product'/);
  assert.match(errors, /builds_on 'dollar-account': a product can't be built on itself/);
});
