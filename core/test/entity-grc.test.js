import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// A bank licence whose GRC has an obligation owned by the compliance officer, a filing, a risk, a control
// template owned by the officer, a policy template the board approves, and an inspection-history template.
async function setup() {
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
  await call(admin, "define_regulated_product_type", { region: "IN", product_type: { id: "in_term_deposit", name: "Term deposit", description: "", type_id: "deposits", actions: ["issuance"] } });
  const regulator = {
    id: "rbi",
    name: "Reserve Bank of India",
    scope: { product_types: [{ id: "in_term_deposit" }], customer_personas: [] },
    license_types: [
      {
        _id: "rbi_bank",
        name: "Bank",
        grc: {
          registers: {
            obligations: [{ id: "kyc_master_direction", title: "Follow the KYC master direction", owner: "rbi_bank_compliance_officer" }],
            reporting_disclosure_filings: [{ id: "form_a", name: "Form A return" }],
            risks: [{ id: "aml_risk", title: "Money laundering through deposit accounts" }],
            controls: [{ id: "kyc_review", name: "Periodic KYC review", owner: "rbi_bank_compliance_officer" }],
            inspection_events: [],
          },
          repositories: {
            policies: [{ id: "kyc_policy", name: "KYC policy", approved_by: "rbi_bank_board", fields: [{ key: "risk_categories", label: "Risk categories", type: "multi_enum", enum_values: ["low", "medium", "high"], required: true }] }],
            inspection_history: [{ id: "rbi_inspection", name: "RBI inspection report", mandatory: false }],
          },
          allowed_product_types: ["in_term_deposit"],
          mandatory_stakeholders: {
            internal: [
              { id: "rbi_bank_compliance_officer", name: "Chief compliance officer", action: "compliance" },
              { id: "rbi_bank_board", name: "Board of directors", action: "governance" },
            ],
            external: [],
          },
        },
      },
    ],
  };
  assert.equal((await call(admin, "define_regulator", { region: "IN", regulator })).isError, false);
  const { user } = await store.createUser("Ines", ["innovator"]);
  const entity = await store.createEntity(user.id, { name: "Ines Bank", registration_numbers: {}, regions: ["IN"] });
  await store.setUserEntity(user.id, entity.id);
  user.entity_id = entity.id;
  const held = await store.registerLicense(user.id, { entity_id: entity.id, region: "IN", regulator_id: "rbi", license_id: "rbi_bank", registration_number: "B-1", valid_from: null, valid_to: null });
  await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
  const client = await connect(user);
  const officer = (await call(client, "add_party", { kind: "internal", person: { name: "Rhea" }, fills: [{ licence_id: held.id, stakeholder: "rbi_bank_compliance_officer" }] })).data;
  const board = (await call(client, "add_party", { kind: "internal", person: { name: "Board of directors" }, fills: [{ licence_id: held.id, stakeholder: "rbi_bank_board" }] })).data;
  const vendor = (await call(client, "add_party", { kind: "external", new_legal_entity: { name: "KYC Vendor Pvt Ltd", legal_form: "company_private" }, relationship: "kyc_outsourcing_agreement" })).data;
  return { store, admin, call, client, held, officer, board, vendor, entity };
}

test("an entity's GRC folder mirrors its licence's GRC, and Mynt lists what isn't answered yet", async () => {
  const { call, client, held } = await setup();
  const empty = (await call(client, "get_grc_folder")).data;
  assert.deepEqual(Object.keys(empty.registers), ["obligations", "reporting_disclosure_filings", "risks", "controls", "inspection_events"]);
  assert.deepEqual(Object.keys(empty.repositories), ["regulatory_communications", "enforcement_actions", "press_releases", "policies", "risk_models", "inspection_history"]);
  const [bank] = empty.reconciliation.licences;
  assert.equal(bank.licence_id, held.id);
  assert.deepEqual(
    bank.gaps.map((g) => `${g.section}/${g.ref}`),
    ["obligations/kyc_master_direction", "reporting_disclosure_filings/form_a", "risks/aml_risk", "controls/kyc_review", "policies/kyc_policy"],
    "the optional inspection-history template isn't a gap",
  );
  assert.equal(empty.reconciliation.complete, false);
});

test("records answer the licence's items, follow its templates, and are owned by the parties the regulator makes accountable", async () => {
  const { call, client, held, officer, board, vendor } = await setup();
  const file = (args) => call(client, "file_grc_record", { licence_id: held.id, ...args });

  // The board can't own what the regulator gives the compliance officer.
  assert.equal((await file({ section: "obligations", ref: "kyc_master_direction", record: { status: "compliant", owner: board.id } })).isError, false);
  let folder = (await call(client, "get_grc_folder")).data;
  assert.ok(folder.reconciliation.licences[0].gaps.some((g) => g.ref === "kyc_master_direction" && /doesn't fill rbi_bank_compliance_officer/.test(g.gap)));
  // Filing the same key again supersedes it; history is kept.
  await file({ section: "obligations", ref: "kyc_master_direction", record: { status: "compliant", owner: officer.id, evidence: ["KYC policy v3"] } });
  await file({ section: "reporting_disclosure_filings", ref: "form_a", key: "form_a_2026_q2", record: { period: "2026-Q2", status: "filed", filed_on: "2026-07-10", reference: "ACK-991" } });
  await file({ section: "risks", ref: "aml_risk", record: { inherent: "high", residual: "medium", owner: officer.id } });
  const control = await file({
    section: "controls",
    ref: "kyc_review",
    key: "kyc_review_branches",
    record: { title: "Quarterly KYC review", objective: "Keep customer KYC current", control_type: "detective", test_method: "manual", test_frequency: "quarterly", status: "active", owner: officer.id },
  });
  assert.equal(control.isError, false, JSON.stringify(control.data));
  const badPolicy = await file({ section: "policies", ref: "kyc_policy", record: { risk_categories: ["extreme"], nonsense: 1 } });
  assert.equal(badPolicy.isError, true);
  const badErrors = badPolicy.data.errors.join("\n");
  assert.match(badErrors, /risk_categories: expected a list of low, medium, high/);
  assert.match(badErrors, /nonsense: not a field of this template/);
  assert.match(badErrors, /approved_by: required/, "the template's default policy fields apply too");

  // A vendor's due diligence lives in its own folder and still answers the licence; the board approves it.
  const policyRecord = (approver) => ({
    title: "Vendor KYC policy",
    version: "1.0",
    status: "approved",
    purpose: "How the KYC vendor verifies customers for us",
    effective_date: "2026-04-01",
    review_frequency: "annual",
    owner: officer.id,
    approved_by: approver,
    sections: [{ heading: "Scope", content: "All deposit customers" }],
    risk_categories: ["low", "high"],
  });
  await call(client, "file_grc_record", { party_id: vendor.id, licence_id: held.id, section: "policies", ref: "kyc_policy", key: "vendor_kyc_policy", record: policyRecord(officer.id) });
  folder = (await call(client, "get_grc_folder")).data;
  assert.ok(folder.reconciliation.licences[0].gaps.some((g) => g.ref === "kyc_policy" && /approved by a party that doesn't fill rbi_bank_board/.test(g.gap)));
  const policy = await call(client, "file_grc_record", { party_id: vendor.id, licence_id: held.id, section: "policies", ref: "kyc_policy", key: "vendor_kyc_policy", record: policyRecord(board.id) });
  assert.equal(policy.isError, false, JSON.stringify(policy.data));
  assert.equal(policy.data.folder, "repositories");

  folder = (await call(client, "get_grc_folder", { history: true })).data;
  assert.equal(folder.registers.obligations.length, 1);
  assert.equal(folder.registers.obligations[0].record.owner, officer.id);
  assert.equal(folder.history.length, 1, "the board-owned record was superseded (the vendor's history is in its own folder)");
  assert.equal(folder.repositories.policies.length, 0, "the vendor's policy is in the vendor's folder");
  const vendorFolder = (await call(client, "get_grc_folder", { party_id: vendor.id })).data;
  assert.equal(vendorFolder.repositories.policies[0].key, "vendor_kyc_policy");
  assert.deepEqual(folder.reconciliation.licences[0].gaps, []);
  assert.equal(folder.reconciliation.complete, true);
  const mine = (await call(client, "get_my_entity")).data;
  assert.equal(mine.grc.complete, true);
});

test("records are checked against the licence GRC and the roster", async () => {
  const { call, client, held, officer } = await setup();
  const file = (args) => call(client, "file_grc_record", args);
  const errors = async (args) => (await file(args)).data.errors.join("\n");
  assert.match(await errors({ section: "obligations", ref: "kyc_master_direction", record: { status: "compliant" } }), /give licence_id and ref/);
  assert.match(await errors({ licence_id: held.id, section: "obligations", ref: "made_up", record: { status: "compliant" } }), /has no obligations item 'made_up'/);
  assert.match(await errors({ licence_id: held.id, section: "obligations", ref: "kyc_master_direction", record: { status: "fine" } }), /status/);
  assert.match(await errors({ licence_id: held.id, section: "risks", ref: "aml_risk", record: { inherent: "high", residual: "low", owner: "00000000-0000-4000-8000-000000000000" } }), /isn't an active party/);
  assert.match(await errors({ licence_id: held.id, section: "controls", ref: "kyc_review", record: { owner: "someone" } }), /owner: 'someone' isn't an active party on the roster/);
  assert.match(await errors({ party_id: "00000000-0000-4000-8000-000000000000", section: "enforcement_actions", key: "x", record: { title: "Fine" } }), /No party/);
  // An ended party can't own new records.
  await call(client, "end_party", { party_id: officer.id });
  assert.match(await errors({ licence_id: held.id, section: "risks", ref: "aml_risk", record: { inherent: "high", residual: "low", owner: officer.id } }), /isn't an active party/);
  // The entity's own repository items need no licence.
  const comm = await file({ section: "regulatory_communications", key: "rbi_letter_2026_05", record: { title: "Letter on KYC backlog", date: "2026-05-02", summary: "Asked for a plan by June" } });
  assert.equal(comm.isError, false, JSON.stringify(comm.data));
});
