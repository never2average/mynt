import { readFileSync } from "node:fs";
import { normalizeModel } from "../dist/regulatory.js";

// Mynt ships no catalogue; tests seed this fixture (with the regions and categories it implies).
export const CATALOG = JSON.parse(readFileSync(new URL("./fixtures/catalog.json", import.meta.url), "utf8"));

// Gives `user` a firm holding a verified licence for `action` on `category` in `region`, with a
// matching licence type in the regulatory model. Mutates `user.entity_id` so servers built for that
// user see the firm.
export async function licensed(store, user, { region = "IN", category = "deposits", action = "issuance" } = {}) {
  if (!user.entity_id) {
    const entity = await store.createEntity(user.id, { name: `${user.name} Ltd`, registration_numbers: {}, regions: [region] });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
  }
  const regulatorId = `test_${category}_${action}`.replace(/[^a-z0-9_]/g, "_");
  const regionRow = (await store.referenceData(true)).regions.find((r) => r.code === region);
  const model = normalizeModel(regionRow.regulatory);
  const productTypeId = `${regulatorId}_pt`;
  await store.upsertRegulatedProductType(region, { id: productTypeId, name: category, description: "", type_id: category, actions: [action] });
  const regulator = {
    id: regulatorId,
    name: `Test regulator for ${category}`,
    scope: { product_types: [{ id: productTypeId, name: category, description: "", type_id: category, action: [action] }], customer_personas: [] },
    license_types: [
      {
        _id: "lic",
        name: `Licence to ${action} ${category}`,
        scope: "",
        application_procedure: [],
        grc: {
          registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
          repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
          allowed_product_types: [{ id: productTypeId, actions: [action] }],
          allowed_customer_segments: [],
          mandatory_stakeholders: { internal: [], external: [] },
        },
      },
    ],
  };
  await store.setRegulatoryModel(region, { ...model, regulators: [...model.regulators.filter((r) => r.id !== regulatorId), regulator] });
  const held = await store.registerLicense(user.id, {
    entity_id: user.entity_id,
    region,
    regulator_id: regulatorId,
    license_id: "lic",
    registration_number: "TEST-001",
    valid_from: null,
    valid_to: null,
  });
  await store.reviewLicense(held.id, "verified", user.id, "test");
  return held;
}
