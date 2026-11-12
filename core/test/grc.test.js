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
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError ?? false, data };
  };
  return { pg, store, as, connect, call };
}

// Test fixtures, not statements of real regulation.
const licence = (grc) => ({
  _id: "rbi_pa",
  name: "Payment aggregator",
  grc: {
    allowed_product_types: [],
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [{ id: "board", name: "Board", action: "oversight" }, { id: "cco", name: "Chief Compliance Officer", action: "compliance" }], external: [] },
    ...grc,
  },
});
const regulator = (grc) => ({ id: "rbi", name: "Reserve Bank of India", short_name: "RBI", license_types: [licence(grc)] });

test("controls, policies, risk models and inspections are templates that teach licensees what to keep", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const inno = await connect(await as("Ines", ["innovator"]));
  await call(admin, "define_legislation", { region: "IN", instrument: { id: "pa_guidelines", title: "PA guidelines", kind: "guideline", issued_by: "rbi" } });

  const saved = await call(admin, "define_regulator", {
    region: "IN",
    regulator: regulator({
      registers: {
        risks: [{ id: "fraud", title: "Seller fraud", impact: "high", likelihood: "medium", control_test_frequency: "Quarterly" }],
        obligations: [{ id: "escrow", title: "Hold funds in escrow", recurrence: "continuous", risk_ref: "fraud", owner: "cco", legal_ref: "pa_guidelines" }],
        reporting_disclosure_filings: [{ id: "escrow_cert", name: "Escrow certificate", category: "filing", frequency: "quarterly", obligation_ref: "escrow" }],
        controls: [
          {
            id: "seller_kyc",
            name: "Seller due diligence",
            guidance: "Onboard sellers only after due diligence proportionate to their risk.",
            legal_ref: "pa_guidelines",
            mitigates: ["fraud"],
            owner: "cco",
            minimum_test_frequency: "half-yearly",
            fields: [{ key: "risk_tier", label: "Seller risk tier", type: "enum", required: true, enum_values: ["low", "medium", "high"], guidance: "Tier every seller" }],
          },
        ],
        inspection_events: [{ id: "info_request", name: "Information request from the supervisor" }],
      },
      repositories: {
        enforcement_actions: [{ title: "Penalty on a PA", url: "https://example.org/penalty" }],
        policies: [
          {
            id: "seller_onboarding_policy",
            name: "Seller onboarding policy",
            guidance: "Board-approved; reviewed at least annually.",
            review_frequency: "annual",
            approved_by: "board",
            fields: [{ key: "review_frequency", label: "Review frequency", type: "enum", required: true, enum_values: ["annual"] }],
          },
        ],
        risk_models: [{ id: "seller_risk_model", name: "Seller risk scoring", validation_frequency: "yearly" }],
        inspection_history: [{ id: "onsite_inspection", name: "On-site inspection", inspection_type: "onsite_inspection" }],
      },
    }),
  });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.warnings, []);

  // Data registers use Mynt's vocabulary, with aliases normalised.
  const rbi = (await call(inno, "get_regulator", { region: "IN", regulator_id: "rbi" })).data;
  const grc = rbi.license_types[0].grc;
  assert.equal(grc.registers.risks[0].control_test_frequency, "quarterly");
  assert.equal(grc.registers.obligations[0].criticality, "medium");
  assert.equal(grc.repositories.policies[0].review_frequency, "annual");
  assert.equal(grc.registers.controls[0].minimum_test_frequency, "half_yearly");

  // A control template = Mynt's default control schema + the regulator's additions.
  const control = (await call(inno, "get_template", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", kind: "control", template_id: "seller_kyc" })).data;
  assert.match(control.guidance, /due diligence/);
  const byKey = Object.fromEntries(control.schema.map((x) => [x.key, x]));
  assert.deepEqual(byKey.control_type.enum_values, ["preventive", "detective", "corrective", "directive", "compensating", "recovery"]);
  assert.deepEqual(byKey.test_method.enum_values, ["manual", "automated", "it_dependent_manual"]);
  assert.deepEqual(byKey.last_test_rating.enum_values, ["effective", "partially_effective", "ineffective", "not_tested"]);
  assert.ok(byKey.test_frequency.enum_values.includes("quarterly"));
  assert.equal(byKey.risk_tier.guidance, "Tier every seller");

  // Overrides replace a default field by key.
  const policy = (await call(inno, "get_template", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", kind: "policy", template_id: "seller_onboarding_policy" })).data;
  assert.deepEqual(policy.schema.find((x) => x.key === "review_frequency").enum_values, ["annual"]);
  assert.ok(policy.schema.some((x) => x.key === "sections"));

  // Listing a kind shows the licence's templates; the new inspection kinds are there.
  assert.deepEqual((await call(inno, "get_template", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", kind: "inspection_event" })).data.map((t) => t.id), ["info_request"]);
  const inspection = (await call(inno, "get_template", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", kind: "inspection_record", template_id: "onsite_inspection" })).data;
  assert.deepEqual(inspection.schema.find((x) => x.key === "inspection_type").enum_values, ["onsite_inspection", "offsite_review", "thematic_review", "investigation", "audit"]);

  const defaults = (await call(inno, "list_template_defaults", { kind: "risk_model" })).data.risk_model;
  assert.deepEqual(defaults.find((x) => x.key === "inherent_scoring").enum_values, ["likelihood_times_impact", "weighted_average", "matrix_lookup"]);
});

test("a template can opt out of the default schema", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  await call(admin, "define_regulator", {
    region: "IN",
    regulator: regulator({
      repositories: { policies: [{ id: "lean", name: "Lean policy", extends_default: false, fields: [{ key: "title", label: "Title", type: "string", required: true }] }] },
    }),
  });
  const t = (await call(admin, "get_template", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", kind: "policy", template_id: "lean" })).data;
  assert.deepEqual(t.schema.map((x) => x.key), ["title"]);
});

test("broken template and register links are refused", async () => {
  const { as, connect, call } = await setup();
  const admin = await connect(await as("Ada", ["admin"]));
  const enumWithoutValues = await call(admin, "define_regulator", {
    region: "IN",
    regulator: regulator({ registers: { controls: [{ id: "c1", name: "C", fields: [{ key: "level", label: "Level", type: "enum" }] }] } }),
  });
  assert.equal(enumWithoutValues.isError, true);
  assert.match(JSON.stringify(enumWithoutValues.data), /enum but has no enum_values/);

  const broken = await call(admin, "define_regulator", {
    region: "IN",
    regulator: regulator({
      registers: {
        obligations: [{ id: "o1", title: "O", risk_ref: "nope" }],
        reporting_disclosure_filings: [{ id: "f1", name: "F", obligation_ref: "missing" }],
        controls: [{ id: "c1", name: "C", fields: [{ key: "a", label: "A", type: "string" }, { key: "a", label: "A2", type: "string" }] }],
      },
    }),
  });
  assert.equal(broken.isError, true);
  assert.equal(broken.data.errors.length, 3);
});

test("earlier data-shaped controls, repository items and free-text frequencies read in the new shape", async () => {
  const { pg, as, connect, call } = await setup();
  const legacy = {
    id: "sebi",
    name: "SEBI",
    scope: { product_types: [], customer_personas: [] },
    license_types: [
      {
        _id: "ria",
        name: "Investment adviser",
        scope: "",
        application_procedure: [],
        grc: {
          registers: {
            obligations: [{ id: "o1", title: "Risk profiling", description: "", frequency: "annual" }],
            reporting_disclosure_filings: [{ id: "f1", name: "Compliance report", description: "", frequency: "as per circular" }],
            risks: [{ id: "r1", title: "Mis-selling", description: "", severity: "high" }],
            controls: [{ id: "c1", title: "Suitability review", description: "Check suitability", mitigates: ["r1"] }],
          },
          repositories: {
            regulatory_communications: [],
            enforcement_actions: [],
            press_releases: [],
            policies: [{ title: "Conflict of interest policy", url: "https://example.org/coi", summary: "Manage conflicts" }],
            risk_models: [],
          },
          allowed_product_types: [],
          allowed_customer_segments: [],
          mandatory_stakeholders: { internal: [], external: [] },
        },
      },
    ],
  };
  await pg.query(
    "UPDATE financial_products.regions SET regulatory = jsonb_build_object('regulators', $1::jsonb, 'legal', jsonb_build_object('legislative', '[]'::jsonb, 'judiciary', '[]'::jsonb)) WHERE code = 'IN'",
    [JSON.stringify([legacy])],
  );
  const inno = await connect(await as("Ines", ["innovator"]));
  const grc = (await call(inno, "get_regulator", { region: "IN", regulator_id: "sebi" })).data.license_types[0].grc;
  assert.equal(grc.registers.obligations[0].recurrence, "annual");
  assert.equal(grc.registers.reporting_disclosure_filings[0].frequency_note, "as per circular");
  assert.equal(grc.registers.reporting_disclosure_filings[0].frequency, undefined);
  assert.equal(grc.registers.controls[0].name, "Suitability review");
  assert.deepEqual(grc.registers.inspection_events, []);
  assert.equal(grc.repositories.policies[0].id, "conflict_of_interest_policy");
  assert.equal(grc.repositories.policies[0].source_url, "https://example.org/coi");
  assert.deepEqual(grc.repositories.inspection_history, []);
  const t = (await call(inno, "get_template", { region: "IN", regulator_id: "sebi", license_id: "ria", kind: "control", template_id: "c1" })).data;
  assert.ok(t.schema.some((x) => x.key === "test_method"));
});
