import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// Shared by the v2 tests: a regulator and a firm with a roster, the recurring-deposit definition, and a
// way to publish it.

export const TEMPLATE = JSON.parse(readFileSync(new URL("./fixtures/rd_template.v2.json", import.meta.url), "utf8"));

// A bank (with a risk-model template on its licence) and a payment aggregator; a firm holding the bank
// licence with the aggregator on its roster.
export async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
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
  await call(admin, "define_product_category", { id: "mandates", name: "Payment mandates", product_lines: ["payments"] });
  for (const t of [
    { id: "in_term_deposit", name: "Term deposit", type_id: "deposits", actions: ["issuance", "sale"] },
    { id: "in_recurring_mandate", name: "Recurring payment mandate", type_id: "mandates", actions: ["issuance", "sale"] },
  ])
    await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } });
  const grc = (grants, extra = {}) => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [], ...extra },
    allowed_product_types: grants,
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  });
  const defined = await call(admin, "define_regulator", {
    region: "IN",
    regulator: {
      id: "rbi",
      name: "Reserve Bank of India",
      short_name: "RBI",
      scope: {
        product_types: [{ id: "in_term_deposit" }, { id: "in_recurring_mandate", actions: ["sale"] }],
        customer_personas: [
          { id: "rbi_retail_depositor", name: "Retail depositor", qualification: { resident: true }, action: "deposit_custody" },
          { id: "rbi_senior_depositor", name: "Senior citizen depositor", qualification: { min_age: 60 }, action: "deposit_custody" },
        ],
      },
      license_types: [
        {
          _id: "rbi_bank",
          name: "Bank",
          grc: grc(["in_term_deposit", "in_recurring_mandate"], {
            risk_models: [{ id: "interest_model", name: "Interest computation model", extends_default: false, fields: [{ key: "model", label: "Model", type: "string", required: true }] }],
          }),
        },
        { _id: "rbi_pa", name: "Payment aggregator", grc: grc([{ id: "in_recurring_mandate", actions: ["sale"] }]) },
      ],
    },
  });
  assert.equal(defined.isError, false, JSON.stringify(defined.data));

  const { user } = await store.createUser("Ines", ["innovator"]);
  const entity = await store.createEntity(user.id, { name: "Ines Bank", registration_numbers: {}, regions: ["IN"] });
  await store.setUserEntity(user.id, entity.id);
  user.entity_id = entity.id;
  const licence = async (entityId, id) => {
    const held = await store.registerLicense(user.id, { entity_id: entityId, region: "IN", regulator_id: "rbi", license_id: id, registration_number: `${id}-1`, valid_from: null, valid_to: null });
    await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
    return held;
  };
  const bank = await licence(entity.id, "rbi_bank");
  const partnerEntity = await store.createEntity(null, { name: "Pay Partner", registration_numbers: {}, regions: ["IN"] });
  await licence(partnerEntity.id, "rbi_pa");
  const client = await connect(user);
  const partner = (await call(client, "add_party", { kind: "external", legal_entity_id: partnerEntity.id, relationship: "mandate_collection_agreement" })).data;
  const officer = (await call(client, "add_party", { kind: "internal", person: { name: "Model risk officer" } })).data;
  return { store, admin, call, connect, client, user, entity, bank, partner, officer };
}

export const rd = {
  id: "everyday-rd",
  name: "Everyday Recurring Deposit",
  product_line: "account_operations",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Placeholder until the definition is saved.",
  key_features: ["Daily instalments", "Fixed rate"],
};

// The recurring-deposit template, owned by the firm: the deposit by its bank licence, the mandate by the
// aggregator on its roster (with a handoff), interest governed by a record in the product's GRC folder.
export function definitionFor(ctx, governanceRecordId) {
  const d = structuredClone(TEMPLATE);
  d._id = "everyday-rd";
  d.owner_entity_id = ctx.entity.id;
  d.plane = { role: "standalone", sellable: true };
  d.risk_models = [{ _id: "rd_interest_model", model_name: "RD interest model", description: "Compounding per instalment", purpose: "other", repository: "models/rd-interest" }];
  d.partner_handoffs = [
    { _id: "mandate_setup", name: "Register the mandate", trigger: "account_opened", sends: { type: "object", required: ["customer_ref", "amount"] }, returns: { type: "object", required: ["mandate_id"] } },
  ];
  d.connections = d.connections
    .filter((c) => c.type !== "segment_maps_to_persona")
    .concat([
      { _id: "p_deposit", type: "component_provided_by", from: { kind: "component", id: "deposit" }, to: { kind: "owner", licence_id: ctx.bank.id }, attributes: { business_role: "issuer" } },
      { _id: "p_mandate", type: "component_provided_by", from: { kind: "component", id: "mandate" }, to: { kind: "party", id: ctx.partner.id }, attributes: { business_role: "payment_service_provider" } },
      { _id: "h_party", type: "handoff_to_party", from: { kind: "partner_handoff", id: "mandate_setup" }, to: { kind: "party", id: ctx.partner.id }, attributes: { sla: "PT15M", consent_purpose: "mandate_setup", channel: "api" } },
      { _id: "h_serves", type: "handoff_serves_component", from: { kind: "partner_handoff", id: "mandate_setup" }, to: { kind: "component", id: "mandate" } },
      { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "deposit" } },
      { _id: "retail_persona", type: "segment_maps_to_persona", from: { kind: "customer_segment", id: "retail_saver" }, to: { kind: "register_persona", regulator_id: "rbi", id: "rbi_retail_depositor" }, attributes: { fit: "subset" } },
      { _id: "senior_persona", type: "segment_maps_to_persona", from: { kind: "customer_segment", id: "senior_saver" }, to: { kind: "register_persona", regulator_id: "rbi", id: "rbi_senior_depositor" }, attributes: { fit: "subset" } },
      { _id: "uses_model", type: "algorithm_uses_risk_model", from: { kind: "core_algorithm", id: "rd_interest" }, to: { kind: "risk_model", id: "rd_interest_model" }, attributes: { role: "primary", outputs_used: ["rate"] } },
      { _id: "governed", type: "risk_model_governed_by", from: { kind: "risk_model", id: "rd_interest_model" }, to: { kind: "grc_record", id: governanceRecordId, section: "risk_models", product_id: "everyday-rd" }, attributes: { governance_kind: "validation", frequency: "annual", owner_party_id: ctx.officer.id } },
    ]);
  return d;
}

// Creates, defines, tests and publishes everyday-rd; `change` edits the definition first.
export async function publishDefined(ctx, change = (d) => d) {
  const { call, client, bank } = ctx;
  assert.equal((await call(client, "create_product", rd)).isError, false);
  const governance = await call(client, "file_grc_record", { product_id: "everyday-rd", licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "m", record: { model: "x" } });
  const def = change(definitionFor(ctx, governance.data.id)) ?? definitionFor(ctx, governance.data.id);
  const saved = await call(client, "set_product_definition", { product_id: "everyday-rd", definition: def });
  assert.equal(saved.isError, false, JSON.stringify(saved.data));
  await call(client, "test_product", { id: "everyday-rd" });
  const published = await call(client, "publish_product", { id: "everyday-rd" });
  assert.equal(published.isError, false, JSON.stringify(published.data));
  return def;
}
