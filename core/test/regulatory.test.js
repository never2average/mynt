import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  return { store, as, connect, call };
}

// Test fixtures in the pasted schema's shape (not statements of real regulation).
const PRODUCT_TYPES = [
  { id: "term_deposit", name: "Term deposit", type_id: "deposits", actions: "issuance" },
  { id: "personal_loan", name: "Personal loan", type_id: "credit", actions: ["issuance", "sale"] },
];
const defineCatalogue = async (call, admin, region = "IN") => {
  for (const product_type of PRODUCT_TYPES) {
    const res = await call(admin, "define_regulated_product_type", { region, product_type });
    assert.equal(res.isError, false, JSON.stringify(res.data));
  }
};

const regulator = (over = {}) => ({
  id: "rbi",
  name: "Reserve Bank of India",
  short_name: "RBI",
  scope: {
    product_types: [{ id: "term_deposit" }, { id: "personal_loan", actions: ["issuance", "sale"] }],
    customer_personas: [
      { id: "rbi_retail_resident", name: "Resident individual", qualification: { resident: true, min_age: 18 }, action: ["onboarding", "identity_validation"] },
      { id: "rbi_hni", name: "High-net-worth individual", qualification: { min_net_worth_inr: 50000000 }, action: "onboarding" },
    ],
  },
  license_types: [
    {
      _id: "rbi_nbfc_d",
      name: "Deposit-taking NBFC",
      scope: "Accept public deposits and lend",
      application_procedure: ["Incorporate", "Apply for a certificate of registration", "Meet net-owned-fund requirement"],
      grc: {
        registers: {
          obligations: [{ id: "kyc", title: "Customer due diligence", legal_ref: "kyc_direction" }],
          reporting_disclosure_filings: [{ id: "alm_return", name: "ALM return", frequency: "quarterly" }],
          risks: [{ id: "liquidity", title: "Liquidity mismatch", severity: "high" }],
          controls: [{ id: "alm_committee", title: "ALM committee", mitigates: ["liquidity"], owner: "cro" }],
        },
        repositories: { enforcement_actions: [{ title: "Penalty on an NBFC", url: "https://example.org/penalty" }] },
        // A bare id grants everything the regulator supervises; an object narrows it.
        allowed_product_types: ["term_deposit", { id: "personal_loan", actions: ["issuance"] }],
        allowed_customer_segments: ["rbi_retail_resident"],
        mandatory_stakeholders: {
          internal: [{ id: "cro", name: "Chief Risk Officer", action: "risk_oversight", obligations: ["kyc"] }],
          external: [{ id: "statutory_auditor", name: "Statutory auditor", action: "audit" }],
        },
      },
    },
  ],
  ...over,
});

test("admins load regulators and legal instruments in the pasted schema; innovators query them", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));

  await defineCatalogue(call, admin);
  // Citing a law that isn't recorded yet is a warning, not an error.
  const first = (await call(admin, "define_regulator", { region: "IN", regulator: regulator() })).data;
  assert.ok(first.warnings.some((w) => /kyc_direction/.test(w)));
  await call(admin, "define_legislation", {
    region: "IN",
    instrument: { id: "kyc_direction", title: "KYC Master Direction", kind: "master_direction", issued_by: "rbi", summary: "Customer due diligence rules" },
  });
  const second = (await call(admin, "define_regulator", { region: "IN", regulator: regulator() })).data;
  assert.equal(second.replaced, true);
  assert.deepEqual(second.warnings, []);

  // Single actions are stored as lists; the short name joins the region's regulator list.
  const rbi = (await call(inno, "get_regulator", { region: "IN", regulator_id: "rbi" })).data;
  assert.deepEqual(rbi.scope.product_types.find((p) => p.id === "term_deposit").action, ["issuance"]);
  assert.equal(rbi.license_types[0].grc.repositories.enforcement_actions.length, 1);
  const region = (await call(inno, "get_region", { code: "IN" })).data;
  assert.deepEqual(region.regulatory.regulators[0].license_types, [{ _id: "rbi_nbfc_d", name: "Deposit-taking NBFC" }]);
  assert.ok(region.regulators.includes("RBI"));

  // Which licence lets me issue a term deposit to a resident individual?
  const hits = (await call(inno, "find_licenses", { region: "IN", category: "deposits", action: "issuance", persona: "rbi_retail_resident" })).data;
  assert.equal(hits.length, 1);
  assert.equal(hits[0].license._id, "rbi_nbfc_d");
  assert.deepEqual(hits[0].mandatory_stakeholders.internal, ["Chief Risk Officer"]);
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "deposits", persona: "rbi_hni" })).data, [], "HNIs aren't an allowed segment");
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "deposits", action: "repackaging" })).data, []);

  const laws = (await call(inno, "list_legal_instruments", { region: "IN", applies_to: "rbi" })).data;
  assert.deepEqual(laws.legislative.map((l) => l.id), ["kyc_direction"]);
  assert.equal(laws.legislative[0].status, "in_force");
});

test("legal is split into legislative and judiciary branches", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));

  await call(admin, "define_legislation", { region: "IN", instrument: { id: "rbi_act", title: "RBI Act", kind: "act", issued_by: "parliament" } });
  const rule = (await call(admin, "define_legislation", {
    region: "IN",
    instrument: { id: "nbfc_direction", title: "NBFC Master Direction", kind: "master_direction", issued_by: "rbi", parent_id: "rbi_act" },
  })).data;
  assert.equal(rule.branch, "legislative");
  assert.ok(rule.warnings.some((w) => /issued_by 'rbi'/.test(w)), "rbi isn't defined as a regulator yet");

  const judgment = (await call(admin, "define_judgment", {
    region: "IN",
    judgment: {
      id: "case_one",
      title: "A v. B",
      court: "Supreme Court of India",
      court_level: "supreme_court",
      decided_on: "2020-01-01",
      holding: "Fixture holding",
      interprets: ["rbi_act", "missing_act"],
    },
  })).data;
  assert.equal(judgment.branch, "judiciary");
  assert.deepEqual(judgment.warnings, ["interprets 'missing_act', which isn't recorded legislation in IN"]);

  // A regulator's obligations may cite either branch.
  await defineCatalogue(call, admin);
  const r = regulator();
  r.license_types[0].grc.registers.obligations = [
    { id: "o1", title: "From statute", legal_ref: "rbi_act" },
    { id: "o2", title: "From case law", legal_ref: "case_one" },
  ];
  assert.deepEqual((await call(admin, "define_regulator", { region: "IN", regulator: r })).data.warnings, []);

  const all = (await call(inno, "list_legal_instruments", { region: "IN" })).data;
  assert.deepEqual(all.legislative.map((l) => l.id).sort(), ["nbfc_direction", "rbi_act"]);
  assert.deepEqual(all.judiciary.map((j) => [j.id, j.status]), [["case_one", "good_law"]]);
  assert.deepEqual((await call(inno, "list_legal_instruments", { region: "IN", court_level: "supreme_court" })).data.legislative, []);
  assert.deepEqual((await call(inno, "list_legal_instruments", { region: "IN", applies_to: "rbi_act" })).data.judiciary.map((j) => j.id), ["case_one"]);
  const summary = (await call(inno, "get_region", { code: "IN" })).data.regulatory.legal;
  assert.equal(summary.legislative.length, 2);
  assert.equal(summary.judiciary[0].court, "Supreme Court of India");

  await call(admin, "remove_judgment", { region: "IN", id: "case_one" });
  assert.deepEqual((await call(inno, "list_legal_instruments", { region: "IN", branch: "judiciary" })).data.judiciary, []);
});

test("the deprecated define_legal_instrument files items into the right branch", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const leg = (await call(admin, "define_legal_instrument", { region: "IN", instrument: { id: "a1", title: "Act", kind: "act" } })).data;
  const jud = (await call(admin, "define_legal_instrument", { region: "IN", instrument: { id: "j1", title: "X v. Y", kind: "judgment", issued_by: "Delhi High Court" } })).data;
  assert.equal(leg.branch, "legislative");
  assert.equal(jud.branch, "judiciary");
  const all = (await call(admin, "list_legal_instruments", { region: "IN" })).data;
  assert.equal(all.judiciary[0].court, "Delhi High Court");
  assert.equal((await call(admin, "remove_legal_instrument", { region: "IN", instrument_id: "j1" })).data.removed, "j1");
});

test("a stored flat legal list is migrated into the two branches when Mynt starts", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: async () => {} };
  await Store.open(db, CATALOG);
  const flat = [
    { id: "act1", title: "Some Act", kind: "act", issued_by: "parliament", summary: "s" },
    { id: "case1", title: "P v. Q", kind: "judgment", issued_by: "Bombay High Court", effective_from: "2019-05-01" },
  ];
  await pg.query("UPDATE financial_products.regions SET regulatory = jsonb_build_object('regulators', '[]'::jsonb, 'legal', $1::jsonb) WHERE code = 'IN'", [
    JSON.stringify(flat),
  ]);
  const store = await Store.open(db, CATALOG);
  const { rows } = await pg.query("SELECT regulatory FROM financial_products.regions WHERE code = 'IN'");
  const legal = rows[0].regulatory.legal;
  assert.deepEqual(legal.legislative.map((l) => l.id), ["act1"]);
  assert.deepEqual(legal.legislative[0], flat[0], "legislative items move unchanged");
  assert.equal(legal.judiciary[0].court, "Bombay High Court");
  assert.equal(legal.judiciary[0].decided_on, "2019-05-01");
  assert.equal(legal.judiciary[0].court_level, "other");
  // Running again leaves the split shape alone.
  await Store.open(db, CATALOG);
  assert.deepEqual((await pg.query("SELECT regulatory FROM financial_products.regions WHERE code = 'IN'")).rows[0].regulatory.legal, legal);
  assert.ok(store);
});

test("broken links inside a regulator are refused; links outside it are warnings", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  await defineCatalogue(call, admin);
  const broken = regulator();
  broken.license_types[0].grc.allowed_product_types.push("ghost_product");
  broken.license_types[0].grc.registers.controls.push({ id: "c2", title: "x", mitigates: ["ghost_risk"] });
  const refused = await call(admin, "define_regulator", { region: "IN", regulator: broken });
  assert.equal(refused.isError, true);
  assert.equal(refused.data.errors.length, 2);

  // Product types must map to a Mynt category before any regulator can supervise them.
  const token = await call(admin, "define_regulated_product_type", { region: "IN", product_type: { id: "token", name: "Token", type_id: "crypto", actions: "issuance" } });
  assert.equal(token.isError, true);
  assert.match(JSON.stringify(token.data), /'crypto'/);
  const odd = regulator();
  odd.scope.product_types.push({ id: "token" });
  const refusedOdd = await call(admin, "define_regulator", { region: "IN", regulator: odd });
  assert.equal(refusedOdd.isError, true);
  assert.match(JSON.stringify(refusedOdd.data.errors), /'token', which isn't a regulated product type/);

  assert.equal((await call(admin, "define_regulator", { region: "ZZ", regulator: regulator() })).isError, true, "region must exist");
});

test("test_product reports which licence covers a product, and warns when none does", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));
  const base = {
    name: "Green FD",
    product_line: "account_operations",
    category: "deposits",
    region: "IN",
    risk_level: "low",
    liquidity: "low",
    typical_horizon: "medium",
    return_type: "fixed_interest",
    regulator: "RBI",
    description: "Fixed deposit whose proceeds fund renewable-energy projects.",
    key_features: ["Fixed rate", "Green projects"],
  };
  await call(inno, "create_product", { id: "green-fd", ...base });
  assert.equal((await call(inno, "test_product", { id: "green-fd" })).data.checks.find((c) => c.name === "licensing").status, "warn");

  await defineCatalogue(call, admin);
  await call(admin, "define_regulator", { region: "IN", regulator: regulator() });
  const licensed = (await call(inno, "test_product", { id: "green-fd" })).data.checks.find((c) => c.name === "licensing");
  assert.equal(licensed.status, "pass");
  assert.match(licensed.message, /Deposit-taking NBFC \(rbi\)/);

  await call(admin, "remove_regulator", { region: "IN", regulator_id: "rbi" });
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "deposits" })).data, []);
  const actions = (await call(admin, "audit_log")).data.map((e) => e.action);
  assert.deepEqual(actions.slice(0, 2), ["remove_regulator", "define_regulator"]);
});

test("regulated product types are a catalogue that regulators map onto many to many", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));
  await defineCatalogue(call, admin);
  await call(admin, "define_regulated_product_type", {
    region: "IN",
    product_type: { id: "gold_bond", name: "Sovereign gold bond", type_id: "bonds", actions: ["issuance", "sale", "secondary_sale"] },
  });
  await call(admin, "define_regulator", { region: "IN", regulator: regulator() });
  const both = (id, actions, lic) => ({
    id,
    name: id.toUpperCase(),
    scope: { product_types: [{ id: "gold_bond", actions }], customer_personas: [] },
    license_types: [{ _id: `${id}_${lic}`, name: lic, grc: { allowed_product_types: ["gold_bond"] } }],
  });
  assert.equal((await call(admin, "define_regulator", { region: "IN", regulator: both("mof", ["issuance"], "issuer") })).isError, false);
  assert.equal((await call(admin, "define_regulator", { region: "IN", regulator: both("sebi", ["secondary_sale"], "broker") })).isError, false);

  const catalogue = (await call(inno, "list_regulated_product_types", { region: "IN", category: "bonds" })).data;
  assert.deepEqual(catalogue.map((p) => p.id), ["gold_bond"]);
  assert.deepEqual(catalogue[0].supervised_by, [
    { regulator_id: "mof", actions: ["issuance"] },
    { regulator_id: "sebi", actions: ["secondary_sale"] },
  ]);
  assert.deepEqual((await call(inno, "list_regulated_product_types", { region: "IN", regulator_id: "rbi" })).data.map((p) => p.id), ["personal_loan", "term_deposit"]);

  // Each regulator's view carries the catalogue entry with only the actions it supervises.
  const sebi = (await call(inno, "get_regulator", { region: "IN", regulator_id: "sebi" })).data;
  assert.deepEqual(sebi.scope.product_types[0], { id: "gold_bond", name: "Sovereign gold bond", description: "", type_id: "bonds", action: ["secondary_sale"] });
  assert.deepEqual(sebi.license_types[0].grc.allowed_product_types, [{ id: "gold_bond", actions: ["secondary_sale"] }]);
  const hits = (await call(inno, "find_licenses", { region: "IN", product_type: "gold_bond", action: "secondary_sale" })).data;
  assert.deepEqual(hits.map((h) => h.license._id), ["sebi_broker"]);

  // A regulator can't supervise actions the product type doesn't have.
  const tooMuch = await call(admin, "define_regulator", { region: "IN", regulator: both("sebi", ["repackaging"], "broker") });
  assert.equal(tooMuch.isError, true);
  assert.match(JSON.stringify(tooMuch.data.errors), /supervises 'repackaging' on 'gold_bond'/);

  // The catalogue can't drop actions or entries a regulator still relies on.
  const narrowed = await call(admin, "define_regulated_product_type", {
    region: "IN",
    product_type: { id: "gold_bond", name: "Sovereign gold bond", type_id: "bonds", actions: ["issuance"] },
  });
  assert.equal(narrowed.isError, true);
  assert.match(JSON.stringify(narrowed.data.errors), /sebi still supervises 'secondary_sale'/);
  assert.match((await call(admin, "remove_regulated_product_type", { region: "IN", product_type_id: "gold_bond" })).data.error, /mof, sebi/);
  await call(admin, "remove_regulator", { region: "IN", regulator_id: "mof" });
  await call(admin, "remove_regulator", { region: "IN", regulator_id: "sebi" });
  assert.equal((await call(admin, "remove_regulated_product_type", { region: "IN", product_type_id: "gold_bond" })).data.removed, "gold_bond");
});

test("a licence's grant, not its regulator's whole scope, decides what find_licenses returns", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));
  await defineCatalogue(call, admin);
  await call(admin, "define_regulator", { region: "IN", regulator: regulator() });
  // rbi supervises issuance and sale of personal loans, but the NBFC licence grants issuance only.
  assert.equal((await call(inno, "find_licenses", { region: "IN", category: "credit", action: "issuance" })).data.length, 1);
  assert.deepEqual((await call(inno, "find_licenses", { region: "IN", category: "credit", action: "sale" })).data, []);

  const beyond = regulator();
  beyond.license_types[0].grc.allowed_product_types = [{ id: "term_deposit", actions: ["sale"] }];
  const refused = await call(admin, "define_regulator", { region: "IN", regulator: beyond });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused.data.errors), /grants 'sale' on 'term_deposit', beyond what rbi supervises/);
});

test("persona and licence ids are prefixed with their regulator and never shared across regulators", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  await defineCatalogue(call, admin);

  const unprefixed = regulator();
  unprefixed.license_types[0]._id = "nbfc_d";
  unprefixed.scope.customer_personas[1].id = "hni";
  const refused = await call(admin, "define_regulator", { region: "IN", regulator: unprefixed });
  assert.equal(refused.isError, true);
  assert.deepEqual(refused.data.errors, ["persona id 'hni' must start with 'rbi_'", "licence id 'nbfc_d' must start with 'rbi_'"]);

  // 'rbi_x_lic' is a valid rbi licence id, so a regulator called 'rbi_x' can't reuse it.
  const rbi = regulator();
  rbi.license_types[0]._id = "rbi_x_lic";
  assert.equal((await call(admin, "define_regulator", { region: "IN", regulator: rbi })).isError, false);
  const clash = await call(admin, "define_regulator", {
    region: "IN",
    regulator: { id: "rbi_x", name: "X", license_types: [{ _id: "rbi_x_lic", name: "Clash", grc: {} }] },
  });
  assert.equal(clash.isError, true);
  assert.deepEqual(clash.data.errors, ["licence id 'rbi_x_lic' is already used by rbi"]);
  // Replacing a regulator doesn't clash with its own earlier ids.
  assert.equal((await call(admin, "define_regulator", { region: "IN", regulator: rbi })).data.replaced, true);
});

test("regulators stored with inline product types are lifted into the catalogue when Mynt starts", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: async () => {} };
  await Store.open(db, CATALOG);
  const inline = (id, actions) => ({
    id,
    name: id,
    scope: { product_types: [{ id: "bond", name: "Bond", description: "", type_id: "bonds", action: actions }], customer_personas: [] },
    license_types: [{ _id: `${id}_l`, name: "L", grc: { allowed_product_types: ["bond"] } }],
  });
  await pg.query(
    "UPDATE financial_products.regions SET regulatory = jsonb_build_object('regulators', $1::jsonb, 'legal', jsonb_build_object('legislative', '[]'::jsonb, 'judiciary', '[]'::jsonb)) WHERE code = 'IN'",
    [JSON.stringify([inline("rbi", ["purchase"]), inline("sebi", ["issuance", "sale"])])],
  );
  const store = await Store.open(db, CATALOG);
  const catalogue = await store.regulatedProductTypes("IN");
  assert.deepEqual(catalogue.map((p) => [p.id, [...p.actions].sort()]), [["bond", ["issuance", "purchase", "sale"]]], "actions are the union across regulators");
  assert.deepEqual((await store.productMappings("IN")).map((m) => [m.regulator_id, m.actions]), [["rbi", ["purchase"]], ["sebi", ["issuance", "sale"]]]);
  const { rows } = await pg.query("SELECT regulatory FROM financial_products.regions WHERE code = 'IN'");
  assert.ok(rows[0].regulatory.regulators.every((r) => r.scope.product_types.length === 0), "the JSON no longer carries product types");
  const sebi = (await store.referenceData(true)).regions.find((r) => r.code === "IN").regulatory.regulators.find((r) => r.id === "sebi");
  assert.deepEqual(sebi.license_types[0].grc.allowed_product_types, [{ id: "bond", actions: ["issuance", "sale"] }]);
  // Running again changes nothing.
  await Store.open(db, CATALOG);
  assert.equal((await store.productMappings("IN")).length, 2);
});
