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

// schemas/regulatory/us.json, applied exactly the way scripts/apply-regulatory-model.mjs applies it: a dry run
// changes nothing, the real run sets up the US model through admin tools only, and running it again is safe.

const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));

test("the US regulatory model applies, and the Mynt Ramp's service types load against it", async () => {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Ada", ["admin"]);
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(s);
  const admin = new Client({ name: "us-model", version: "0" });
  await admin.connect(c);
  const call = async (name, args = {}) => {
    const res = await admin.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const listTools = async () => (await admin.listTools()).tools;

  // Every obligation and filing cites an instrument the file defines, and every instrument has a source.
  const legal = new Set(MODEL.legislation.map((l) => l.id));
  for (const l of MODEL.legislation) assert.match(l.url, /^https:\/\//, `${l.id} has a source`);
  for (const r of MODEL.regulators)
    for (const lt of r.license_types)
      for (const item of [...lt.grc.registers.obligations, ...lt.grc.registers.reporting_disclosure_filings]) assert.ok(legal.has(item.legal_ref), `${lt._id}/${item.id} cites ${item.legal_ref}`);

  // ---- dry run: checked against the server's own tool schemas, nothing written ----
  const before = (await call("list_regulated_product_types", { region: "US" })).data;
  const dry = await applyRegulatoryModel({ call, listTools, model: MODEL, dryRun: true });
  assert.deepEqual(dry.problems, []);
  assert.equal(dry.applied, false);
  assert.ok(dry.plan.some((p) => p.tool === "define_regulator" && p.id === "fincen" && p.change === "add"));
  assert.deepEqual((await call("list_regulated_product_types", { region: "US" })).data, before, "a dry run writes nothing");

  // A broken item is caught before anything is written.
  const broken = structuredClone(MODEL);
  broken.regulated_product_types[0].actions = ["teleport"];
  const refused = await applyRegulatoryModel({ call, listTools, model: broken, dryRun: false });
  assert.equal(refused.applied, false);
  assert.match(refused.problems.join("\n"), /us_cvc_money_transmission/);
  assert.deepEqual((await call("list_regulated_product_types", { region: "US" })).data, before);

  // ---- the real run ----
  const lines = [];
  const done = await applyRegulatoryModel({ call, listTools, model: MODEL, say: (l) => lines.push(l) });
  assert.equal(done.applied, true, JSON.stringify(done.problems));
  for (const r of MODEL.regulators) {
    const got = await call("get_regulator", { region: "US", regulator_id: r.id });
    assert.equal(got.isError, false, r.id);
    assert.deepEqual(
      got.data.license_types.map((l) => l._id),
      r.license_types.map((l) => l._id),
    );
  }
  const fincen = (await call("get_regulator", { region: "US", regulator_id: "fincen" })).data;
  const msb = fincen.license_types.find((l) => l._id === "fincen_msb");
  assert.ok(msb.grc.registers.obligations.some((o) => o.id === "fincen_sar" && o.recurrence === "event_driven"));
  assert.ok(msb.grc.registers.obligations.some((o) => o.id === "fincen_msb_renew" && o.recurrence === "biennial"));
  const instruments = (await call("list_legal_instruments", { region: "US" })).data.legislative.map((l) => l.id);
  for (const id of legal) assert.ok(instruments.includes(id), id);
  const region = (await call("list_regions", {})).data.find((r) => r.code === "US");
  for (const r of ["FinCEN", "NYDFS", "DFPI", "OCC"]) assert.ok(region.regulators.includes(r), r);

  // Who may provide each part of a buy-and-hold USDC product follows from the model.
  const licences = async (category, action) => (await call("find_licenses", { region: "US", category, action })).data;
  const ids = (r) => JSON.stringify(r);
  assert.match(ids(await licences("virtual_currency", "sale")), /fincen_msb/);
  assert.match(ids(await licences("virtual_currency", "sale")), /nydfs_bitlicense/);
  assert.match(ids(await licences("digital_asset_custody", "servicing")), /occ_national_trust_bank/);
  assert.doesNotMatch(ids(await licences("payment_stablecoins", "issuance")), /fincen_msb/, "a money services business doesn't issue stablecoins");

  // The Mynt Ramp's four service types load, since their licence type now exists.
  for (const k of ["onramp_quote", "onramp_transfer", "offramp_quote", "offramp_transfer"]) assert.ok(done.services.loaded.includes(`US/${k}`), k);

  // ---- running it again is safe: the file is merged into what is there, so nothing changes and nothing is sent ----
  const again = await applyRegulatoryModel({ call, listTools, model: MODEL });
  assert.equal(again.applied, true);
  assert.ok(again.plan.every((p) => p.change === "keep"), JSON.stringify(again.plan.filter((p) => p.change !== "keep")));
  assert.deepEqual(again.removals, []);
  const regionAgain = (await call("list_regions", {})).data.find((r) => r.code === "US");
  assert.deepEqual([...regionAgain.regulators].sort(), [...region.regulators].sort(), "the region's regulators are merged, not duplicated");
});

// The dollar holding account template (schemas/examples/us/usdc-account.v2.json; USDC on Solana underneath, dollars for customers) checks against the US model as it is,
// and a firm holding a FinCEN registration, state licences in New York and California and a national trust
// bank charter can take it, name itself as the provider of each part, and publish it, with the regime Mynt
// computes from the US model. (A FinCEN registration alone once covered every state; it covers none now.)
test("the US dollar holding account template checks, and a licensed firm publishes it on the US model", async () => {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "us-usdc", version: "0" });
    await client.connect(c);
    return client;
  };
  const callOn = (client) => async (name, args = {}) => {
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
  const call = callOn(admin);
  assert.equal((await applyRegulatoryModel({ call, listTools: async () => (await admin.listTools()).tools, model: MODEL })).applied, true);

  const template = JSON.parse(readFileSync(new URL("../schemas/examples/us/usdc-account.v2.json", import.meta.url), "utf8"));
  const checked = await call("check_product_definition", { definition: template });
  assert.equal(checked.data.valid, true, JSON.stringify(checked.data.errors));
  assert.deepEqual(checked.data.errors, []);

  // A licensed firm.
  const { user } = await store.createUser("Ines", ["innovator"]);
  const entity = await store.createEntity(user.id, { name: "Dollar Trust", registration_numbers: {}, regions: ["US"] });
  await store.setUserEntity(user.id, entity.id);
  user.entity_id = entity.id;
  const licence = async (regulator_id, license_id) => {
    const held = await store.registerLicense(user.id, { entity_id: entity.id, region: "US", regulator_id, license_id, registration_number: `${license_id}-1`, valid_from: null, valid_to: null });
    await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
    return held;
  };
  const msb = await licence("fincen", "fincen_msb");
  const firm = callOn(await connect(user));
  // A FinCEN registration mandates an AML compliance officer: the firm names one on its roster.
  const officer = await firm("add_party", {
    kind: "internal",
    person: { name: "AML compliance officer" },
    fills: [{ licence_id: msb.id, stakeholder: "fincen_aml_compliance_officer" }],
  });
  assert.equal(officer.isError, false, JSON.stringify(officer.data));

  const product = {
    id: "dollar-holding-account",
    name: template.product_name,
    product_line: "exchange",
    category: "virtual_currency",
    region: "US",
    risk_level: "moderate",
    liquidity: "high",
    typical_horizon: "short",
    return_type: "market_linked",
    regulator: "FinCEN",
    description: template.descriptions.summary,
    key_features: template.descriptions.key_features.slice(0, 3),
  };
  const created = await firm("create_product", product);
  assert.equal(created.isError, false, JSON.stringify(created.data));
  // Each part is provided by the firm; `licences` pins one where a single licence covers it, null leaves the
  // regime to find the covering licence in each state. `people` are bound to the parts they stand behind.
  const own = (d, licences, people = []) => {
    d.owner_entity_id = entity.id;
    for (const [component, l] of Object.entries(licences))
      d.connections.push({ _id: `p_${component}`, type: "component_provided_by", from: { kind: "component", id: component }, to: { kind: "owner", ...(l ? { licence_id: l.id } : {}) }, attributes: { business_role: "issuer" } });
    d.connections.push({ _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "settlement_exchange" } });
    for (const [i, [party, components]] of [[officer.data.id, ["ramp", "settlement_exchange"]], ...people].entries())
      for (const component of components)
        d.connections.push({ _id: `person_${i}_${component}`, type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "party", id: party }, attributes: { role: "compliance_officer", bound_component: component } });
    return d;
  };

  // With only a FinCEN registration nothing is covered: the registration covers no state by itself, and a
  // money services business isn't a custodian either.
  const partial = own(structuredClone(template), { ramp: null, settlement_exchange: null, settlement_custody: null });
  const refused = await firm("check_product_definition", { product_id: "dollar-holding-account", definition: partial });
  assert.deepEqual([...new Set(refused.data.publish_blockers.map((b) => b.key))].sort(), ["ramp", "settlement_custody", "settlement_exchange"], JSON.stringify(refused.data));
  assert.match(JSON.stringify(refused.data.publish_blockers), /fincen_msb covers nowhere by itself/);

  // State licences for the ramp (money transmission) and the exchange (virtual currency) in New York and
  // California, and a national trust bank charter for custody: it publishes.
  for (const [regulator, id] of [["nydfs", "nydfs_money_transmitter"], ["ca_dfpi", "ca_dfpi_money_transmitter"], ["ca_dfpi", "ca_dfpi_dfal"]]) await licence(regulator, id);
  const bit = await licence("nydfs", "nydfs_bitlicense");
  const people = [];
  for (const s of MODEL.regulators.find((r) => r.id === "nydfs").license_types.find((l) => l._id === "nydfs_bitlicense").grc.mandatory_stakeholders.internal) {
    const p = await firm("add_party", { kind: "internal", person: { name: s.name }, fills: [{ licence_id: bit.id, stakeholder: s.id }] });
    assert.equal(p.isError, false, JSON.stringify(p.data));
    people.push([p.data.id, ["ramp", "settlement_exchange", "settlement_custody"]]);
  }
  const trust = await licence("occ", "occ_national_trust_bank");
  const def = own(structuredClone(template), { ramp: null, settlement_exchange: null, settlement_custody: trust }, people);
  const ready = await firm("check_product_definition", { product_id: "dollar-holding-account", definition: def });
  assert.equal(ready.data.valid, true, JSON.stringify(ready.data));
  assert.deepEqual(ready.data.publish_blockers, [], JSON.stringify(ready.data.publish_blockers));
  assert.equal((await firm("set_product_definition", { product_id: "dollar-holding-account", definition: def })).isError, false);
  const tested = await firm("test_product", { id: "dollar-holding-account" });
  assert.equal(tested.data.passed, true, JSON.stringify(tested.data.checks?.filter((c) => c.status === "fail")));
  const published = await firm("publish_product", { id: "dollar-holding-account" });
  assert.equal(published.isError, false, JSON.stringify(published.data));

  // Its regime names FinCEN for the ramp and the exchange, and the OCC for custody.
  const regime = (await firm("get_product_regime", { product_id: "dollar-holding-account" })).data;
  const comps = Object.fromEntries(regime.regions.find((r) => r.region === "US").components.map((c) => [c.key, c]));
  assert.ok(JSON.stringify(comps.ramp.supervised_by).includes("fincen"));
  assert.ok(JSON.stringify(comps.settlement_exchange.supervised_by).includes("fincen"));
  assert.ok(JSON.stringify(comps.settlement_custody.supervised_by).includes("occ"));
  const contract = (await firm("get_developer_contract", { product_id: "dollar-holding-account" })).data;
  assert.ok(contract.actions.some((a) => a.id === "onramp_accepted"), "customer-triggered events become actions developers can call");
  assert.ok(contract.actions.some((a) => a.id === "offramp_accepted"));
  // Dollars only: what customers and developers' apps see (the name, the customer copy, the whole contract) names
  // no crypto asset, network or wallet; USDC on Solana stays in the components, for the regulatory model.
  const customerFacing = JSON.stringify({ name: template.product_name, summary: template.descriptions.summary, features: template.descriptions.key_features, contract });
  assert.doesNotMatch(customerFacing, /usdc|solana|ethereum|stablecoin|crypto|wallet|token|blockchain|chain/i, customerFacing);
  assert.equal(template.components.find((c) => c.key === "settlement_exchange").underlying, "digital_assets", "the regulatory model still sees digital assets");
  assert.equal(template.components.find((c) => c.key === "settlement_exchange").terms.asset, "USDC");
});

// #101's templates (money transmission, and the dollar account built on it) and the dollar holding account: every
// customer-facing name and line of copy is in dollars; the USDC rail stays in the components' terms.
test("every US template's customer-facing copy is dollars only", () => {
  const ids = new Set();
  for (const f of ["money-transmission", "dollar-account", "usdc-account"]) {
    const t = JSON.parse(readFileSync(new URL(`../schemas/examples/us/${f}.v2.json`, import.meta.url), "utf8"));
    assert.ok(!ids.has(t._id), `one template per product id (${t._id})`);
    ids.add(t._id);
    const facing = JSON.stringify({ id: t._id, name: t.product_name, summary: t.descriptions.summary, features: t.descriptions.key_features, documents: t.descriptions.documents ?? {} });
    assert.doesNotMatch(facing, /usdc|solana|ethereum|stablecoin|crypto|wallet|token|blockchain/i, `${f}: ${facing}`);
  }
});
