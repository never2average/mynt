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

// Coverage per state: US money transmission and virtual-currency business are licensed state by state, so a
// product lists the states it's offered in and each component is checked in each, on the US model as data
// (schemas/regulatory/us.json: NYDFS scoped to us-ny, DFPI to us-ca, FinCEN and the OCC country-wide).

const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "state-coverage", version: "0" });
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

  const licence = async (entityId, regulator_id, license_id, jurisdiction) => {
    const held = await store.registerLicense(adminUser.id, { entity_id: entityId, region: "US", regulator_id, license_id, jurisdiction, registration_number: `${license_id}-${jurisdiction ?? "1"}`, valid_from: null, valid_to: null });
    await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
    return held;
  };
  const firm = async (name) => {
    const { user } = await store.createUser(name, ["innovator"]);
    const entity = await store.createEntity(user.id, { name: `${name} Inc`, registration_numbers: {}, regions: ["US"], legal_form: "company_private", incorporation: { country: "us", subdivision: "us-ny" } });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    const client = await connect(user);
    const f = { user, entity, client, call: (n, a) => call(client, n, a) };
    // Holds a licence and names the people it mandates on the roster.
    f.hold = async (regulator_id, license_id, jurisdiction) => {
      const held = await licence(entity.id, regulator_id, license_id, jurisdiction);
      const lt = MODEL.regulators.find((r) => r.id === regulator_id)?.license_types.find((l) => l._id === license_id);
      const people = [];
      for (const s of lt?.grc.mandatory_stakeholders.internal ?? []) {
        const p = await f.call("add_party", { kind: "internal", person: { name: s.name }, fills: [{ licence_id: held.id, stakeholder: s.id }] });
        assert.equal(p.isError, false, JSON.stringify(p.data));
        people.push(p.data.id);
      }
      return { ...held, people };
    };
    return f;
  };
  return { store, admin, adminUser, call, firm, licence };
}

const product = (id) => ({
  id,
  name: "Dollar Wallet",
  product_line: "exchange",
  category: "virtual_currency",
  region: "US",
  risk_level: "moderate",
  liquidity: "high",
  typical_horizon: "short",
  return_type: "market_linked",
  regulator: "NYDFS",
  description: "Buy and sell a digital asset for dollars at a quoted price, offered in the states the firm is licensed in.",
  key_features: ["Quoted prices", "Dollars in and out"],
});
const buy = (offered_in, provider = { by: "self" }) => ({
  key: "buy",
  country: "us",
  primitive: "exchange",
  action: "sale",
  underlying: "digital_assets",
  provider,
  ...(offered_in ? { offered_in } : {}),
});
const bindAll = (...held) => held.flatMap((h) => h.people.map((party_id) => ({ party_id, for: "buy" })));
const compose = async (f, id, components, parties) => {
  const r = await f.call("set_product_composition", { product_id: id, components, parties });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const blockers = async (f, id) => (await f.call("get_product_regime", { product_id: id })).data;

test("a product offered in New York and California with only a New York licence is blocked for California, until a California licence covers it", async () => {
  const ctx = await setup();
  const f = await ctx.firm("Ines");
  const ny = await f.hold("nydfs", "nydfs_bitlicense");
  assert.equal(ny.jurisdiction, null, "a licence type not issued per jurisdiction records none");
  assert.equal((await f.call("create_product", product("dollar-wallet"))).isError, false);

  // Without offered_in, the country is checked as a whole, exactly as before: one licence in the US counts.
  const legacy = await compose(f, "dollar-wallet", [buy()], bindAll(ny));
  const legacyRow = legacy.regions[0].components[0];
  assert.equal(legacyRow.coverage.status, "covered");
  assert.equal(legacyRow.jurisdictions, undefined);
  assert.equal(legacy.regions[0].jurisdictions, undefined);

  // Offered in NY and CA: covered in NY, blocked in CA with the licence that would cover it.
  const regime = await compose(f, "dollar-wallet", [buy(["us-ny", "us-ca"])], bindAll(ny));
  const us = regime.regions.find((r) => r.region === "US");
  const row = us.components[0];
  assert.deepEqual(row.jurisdictions.map((j) => [j.jurisdiction, j.coverage.status]), [["us-ny", "covered"], ["us-ca", "uncovered"]]);
  assert.equal(row.jurisdictions[0].coverage.by[0].license_id, "nydfs_bitlicense");
  assert.equal(row.coverage.status, "uncovered");
  assert.deepEqual(us.jurisdictions, [{ jurisdiction: "us-ny", covered: true }, { jurisdiction: "us-ca", covered: false }]);
  assert.equal(us.covered, false);
  const tested = await f.call("test_product", { id: "dollar-wallet" });
  assert.equal(tested.isError, false);
  const refused = await f.call("publish_product", { id: "dollar-wallet" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error ?? JSON.stringify(refused.data), /In us-ca: .*nydfs_bitlicense \(us-ny\), not us-ca; needs one covering us-ca: .*ca_dfpi_dfal/);
  assert.doesNotMatch(refused.data.error ?? JSON.stringify(refused.data), /In us-ny/);

  // The stored summary has the per-state rows, without registration numbers or who the parties are.
  const stored = (await ctx.store.productDerived("dollar-wallet")).regime_summary;
  assert.equal(stored.publishable, false);
  assert.deepEqual(stored.regions[0].jurisdictions, us.jurisdictions);
  const storedRow = stored.regions[0].components[0];
  assert.deepEqual(storedRow.jurisdictions.map((j) => [j.jurisdiction, j.coverage.status, Boolean(j.blocking)]), [["us-ny", "covered", false], ["us-ca", "uncovered", true]]);
  assert.deepEqual(stored.publish_blockers.map((b) => [b.key, b.jurisdiction]), [["buy", "us-ca"]]);
  assert.doesNotMatch(JSON.stringify(stored), /nydfs_bitlicense-1/, "no registration numbers in the stored summary");

  // A California licence unblocks it.
  await f.hold("ca_dfpi", "ca_dfpi_dfal");
  const covered = await compose(f, "dollar-wallet", [buy(["us-ny", "us-ca"])], bindAll(ny));
  assert.deepEqual(covered.regions[0].jurisdictions, [{ jurisdiction: "us-ny", covered: true }, { jurisdiction: "us-ca", covered: true }]);
  assert.equal(covered.regions[0].components[0].jurisdictions[1].coverage.by[0].license_id, "ca_dfpi_dfal");
  assert.equal((await f.call("test_product", { id: "dollar-wallet" })).data.passed, true);
  const published = await f.call("publish_product", { id: "dollar-wallet" });
  assert.equal(published.isError, false, JSON.stringify(published.data));
  const live = (await ctx.store.productDerived("dollar-wallet")).regime_summary;
  assert.equal(live.composition, "live");
  assert.equal(live.publishable, true);

  // Suspending the New York licence drifts the product: the change names us-ny, and sales pause for the
  // whole product (the runtime can't tell which state a customer is in).
  const suspended = await ctx.call(ctx.admin, "review_license", { license_record_id: ny.id, decision: "suspended", note: "regulator order" });
  assert.deepEqual(suspended.data.drifted_products, ["dollar-wallet"]);
  const drift = (await ctx.store.getProduct("dollar-wallet")).drift;
  assert.deepEqual(drift.changes.map((c) => [c.kind, c.id, c.jurisdictions]), [["licence", ny.id, ["us-ny"]]]);
  assert.match(drift.note, /us-ny.*whole product/);
  const afterDrift = (await ctx.store.productDerived("dollar-wallet")).regime_summary;
  assert.deepEqual(afterDrift.regions[0].jurisdictions, [{ jurisdiction: "us-ny", covered: false }, { jurisdiction: "us-ca", covered: true }]);
  // Re-verifying clears it.
  await ctx.call(ctx.admin, "review_license", { license_record_id: ny.id, decision: "verified", note: "order lifted" });
  assert.equal((await ctx.store.getProduct("dollar-wallet")).drift, null);
});

test("a country-wide federal licence that grants the type covers every state; the whole country needs one", async () => {
  const ctx = await setup();
  const f = await ctx.firm("Fed");
  const msb = await f.hold("fincen", "fincen_msb");
  assert.equal((await f.call("create_product", product("fed-wallet"))).isError, false);
  const regime = await compose(f, "fed-wallet", [buy(["us-ny", "us-ca", "us-tx"])], bindAll(msb));
  assert.deepEqual(regime.regions[0].jurisdictions.map((j) => j.covered), [true, true, true]);
  for (const j of regime.regions[0].components[0].jurisdictions) assert.equal(j.coverage.by[0].license_id, "fincen_msb");

  // offered_in: ['us'] is the whole country: a New York licence alone doesn't cover it.
  const g = await ctx.firm("Gotham");
  const ny = await g.hold("nydfs", "nydfs_bitlicense");
  assert.equal((await g.call("create_product", product("ny-wallet"))).isError, false);
  const whole = await compose(g, "ny-wallet", [buy(["us"])], bindAll(ny));
  assert.deepEqual(whole.regions[0].jurisdictions, [{ jurisdiction: "us", covered: false }]);
  assert.match(whole.regions[0].components[0].coverage.reason, /cover nydfs_bitlicense \(us-ny\), not the whole of US/);

  // A state outside the component's country is refused when the composition is saved.
  const wrong = await g.call("set_product_composition", { product_id: "ny-wallet", components: [buy(["in-mh"])], parties: bindAll(ny) });
  assert.equal(wrong.isError, true);
  assert.match(JSON.stringify(wrong.data), /offered_in 'in-mh' isn't in US/);
});

test("a partner on the roster licensed in a state covers that state, and only that one", async () => {
  const ctx = await setup();
  const f = await ctx.firm("Owner");
  const partnerEntity = await ctx.store.createEntity(null, { name: "West Coast Exchange", registration_numbers: {}, regions: ["US"] });
  await ctx.licence(partnerEntity.id, "ca_dfpi", "ca_dfpi_dfal");
  const partner = await f.call("add_party", { kind: "external", legal_entity_id: partnerEntity.id, relationship: "exchange_agreement" });
  assert.equal(partner.isError, false, JSON.stringify(partner.data));
  assert.equal((await f.call("create_product", product("partner-wallet"))).isError, false);
  const regime = await compose(f, "partner-wallet", [buy(["us-ca", "us-ny"], { by: "party", party_id: partner.data.id })], []);
  const row = regime.regions[0].components[0];
  assert.deepEqual(row.jurisdictions.map((j) => [j.jurisdiction, j.coverage.status]), [["us-ca", "covered"], ["us-ny", "uncovered"]]);
  assert.equal(row.jurisdictions[0].coverage.by[0].entity_id, partnerEntity.id);
  assert.match(row.jurisdictions[1].coverage.reason, /The partner's licences granting this cover ca_dfpi_dfal \(us-ca\), not us-ny/);
});

test("a licence type issued per jurisdiction is held once per state, and covers only the state it was issued for", async () => {
  const ctx = await setup();
  const grc = (grants) => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
    allowed_product_types: grants,
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  });
  const regulator = (r) => ctx.call(ctx.admin, "define_regulator", { region: "US", regulator: r });
  const base = { name: "State money transmission (test)", scope: { product_types: [{ id: "us_cvc_exchange" }], customer_personas: [] } };
  const lt = (extra) => ({ _id: "mtl_test_licence", name: "Money transmitter licence", scope: "", application_procedure: [], grc: grc(["us_cvc_exchange"]), ...extra });
  // Bad jurisdictions are refused.
  const outside = await regulator({ id: "mtl_test", ...base, license_types: [lt({ covers: ["in-mh"] })] });
  assert.equal(outside.isError, true);
  assert.match(JSON.stringify(outside.data), /covers 'in-mh', which isn't in US/);
  const beyond = await regulator({ id: "mtl_test", ...base, jurisdiction: "us-ny", license_types: [lt({ covers: ["us-ca"] })] });
  assert.match(JSON.stringify(beyond.data), /beyond its regulator's jurisdiction \(us-ny\)/);
  const noList = await regulator({ id: "mtl_test", ...base, license_types: [lt({ issued_per_jurisdiction: true })] });
  assert.match(JSON.stringify(noList.data), /covers must list the jurisdictions/);
  const ok = await regulator({ id: "mtl_test", ...base, license_types: [lt({ covers: ["us-tx", "us-fl"], issued_per_jurisdiction: true })] });
  assert.equal(ok.isError, false, JSON.stringify(ok.data));

  const f = await ctx.firm("Lone Star");
  const reg = (jurisdiction) => f.call("register_license", { region: "US", regulator_id: "mtl_test", license_id: "mtl_test_licence", registration_number: `MTL-${jurisdiction}`, ...(jurisdiction ? { jurisdiction } : {}) });
  assert.match(JSON.stringify((await reg()).data), /issued per jurisdiction: name the one/);
  assert.match(JSON.stringify((await reg("us-ny")).data), /isn't issued for 'us-ny'/);
  const tx = await reg("us-tx");
  const fl = await reg("us-fl");
  assert.equal(tx.isError, false, JSON.stringify(tx.data));
  assert.equal(fl.isError, false, JSON.stringify(fl.data));
  assert.notEqual(tx.data.id, fl.data.id, "one held licence per state");
  assert.equal((await reg("us-tx")).data.id, tx.data.id, "re-registering the same state resubmits it");
  // A licence type not issued per jurisdiction takes none.
  assert.match(JSON.stringify((await f.call("register_license", { region: "US", regulator_id: "nydfs", license_id: "nydfs_bitlicense", registration_number: "BL-1", jurisdiction: "us-ny" })).data), /isn't issued per jurisdiction/);
  for (const h of [tx.data, fl.data]) await ctx.store.reviewLicense(h.id, "verified", ctx.adminUser.id, "ok");

  assert.equal((await f.call("create_product", product("tx-wallet"))).isError, false);
  const regime = await compose(f, "tx-wallet", [buy(["us-tx", "us-fl", "us-ga"])], []);
  assert.deepEqual(regime.regions[0].jurisdictions, [
    { jurisdiction: "us-tx", covered: true },
    { jurisdiction: "us-fl", covered: true },
    { jurisdiction: "us-ga", covered: false },
  ]);
  assert.match(regime.regions[0].components[0].jurisdictions[2].coverage.reason, /not us-ga; no licence in the regulatory model covers us-ga for this yet|needs one covering us-ga/);
});

test("the USDC template lists its states, and a v2 product is checked in each", async () => {
  const ctx = await setup();
  const template = JSON.parse(readFileSync(new URL("../schemas/examples/us/usdc-account.v2.json", import.meta.url), "utf8"));
  assert.deepEqual(template.offered_in, ["us-ny", "us-ca"]);
  const f = await ctx.firm("Ivy");
  const ny = await f.hold("nydfs", "nydfs_bitlicense");
  const p = { ...product("usdc-account"), name: template.product_name, description: template.descriptions.summary, key_features: template.descriptions.key_features.slice(0, 3) };
  assert.equal((await f.call("create_product", p)).isError, false);
  const def = structuredClone(template);
  def.owner_entity_id = f.entity.id;
  for (const c of def.components)
    def.connections.push({ _id: `p_${c.key}`, type: "component_provided_by", from: { kind: "component", id: c.key }, to: { kind: "owner" }, attributes: { business_role: "issuer" } });
  def.connections.push({ _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "usdc_exchange" } });
  for (const c of def.components)
    for (const [i, id] of ny.people.entries())
      def.connections.push({ _id: `ny_${i}_${c.key}`, type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "party", id }, attributes: { role: "compliance_officer", bound_component: c.key } });
  const checked = (await f.call("check_product_definition", { product_id: "usdc-account", definition: def })).data;
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  // Every component is blocked in California and nowhere else.
  assert.ok(checked.publish_blockers.length > 0);
  assert.deepEqual([...new Set(checked.publish_blockers.map((b) => b.jurisdiction))], ["us-ca"], JSON.stringify(checked.publish_blockers));
  assert.deepEqual(checked.publish_blockers.map((b) => b.key).sort(), def.components.map((c) => c.key).sort());

  // A state outside the product's countries is refused.
  const bad = (await f.call("check_product_definition", { product_id: "usdc-account", definition: { ...def, offered_in: ["us-ny", "in-mh"] } })).data;
  assert.equal(bad.valid, false);
  assert.match(JSON.stringify(bad.errors), /offered_in: 'in-mh' isn't in any component's country/);
});
