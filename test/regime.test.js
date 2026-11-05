import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const db = (pg) => ({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() });

async function setup() {
  const pg = new PGlite();
  const store = await Store.open(db(pg), CATALOG);
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
  // Mandates are payments; term deposits are account operations. A bank licence may do both and mandates a
  // compliance officer with ten years' experience and a statutory auditor; a payment aggregator may only sell
  // mandates and mandates nobody.
  await call(admin, "define_product_category", { id: "mandates", name: "Payment mandates", product_lines: ["payments"] });
  for (const t of [
    { id: "in_term_deposit", name: "Term deposit", type_id: "deposits", actions: ["issuance", "sale"] },
    { id: "in_recurring_mandate", name: "Recurring payment mandate", type_id: "mandates", actions: ["issuance", "sale"] },
  ]) {
    assert.equal((await call(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } })).isError, false);
  }
  const grc = (grants, stakeholders = { internal: [], external: [] }) => ({
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
    allowed_product_types: grants,
    allowed_customer_segments: [],
    mandatory_stakeholders: stakeholders,
  });
  const bankStakeholders = {
    internal: [{ id: "rbi_bank_compliance_officer", name: "Chief compliance officer", qualification: { years_experience: 10 }, action: "compliance" }],
    external: [{ id: "rbi_bank_statutory_auditor", name: "Statutory auditor", qualification: {}, action: "audit" }],
  };
  const regulator = {
    id: "rbi",
    name: "Reserve Bank of India",
    short_name: "RBI",
    scope: { product_types: [{ id: "in_term_deposit" }, { id: "in_recurring_mandate", actions: ["sale"] }], customer_personas: [] },
    license_types: [
      { _id: "rbi_bank", name: "Bank", scope: "", application_procedure: [], grc: grc(["in_term_deposit", "in_recurring_mandate"], bankStakeholders) },
      { _id: "rbi_pa", name: "Payment aggregator", scope: "", application_procedure: [], grc: grc([{ id: "in_recurring_mandate", actions: ["sale"] }]) },
    ],
  };
  const defined = await call(admin, "define_regulator", { region: "IN", regulator });
  assert.equal(defined.isError, false, JSON.stringify(defined.data));
  await call(admin, "define_legislation", {
    region: "IN",
    instrument: { id: "in_banking_regulation_act", kind: "act", title: "Banking Regulation Act", issued_by: "parliament", status: "in_force", applies_to: { regulators: ["rbi"] } },
  });
  const licence = async (entityId, by, licenceId) => {
    const held = await store.registerLicense(by, { entity_id: entityId, region: "IN", regulator_id: "rbi", license_id: licenceId, registration_number: `${licenceId}-1`, valid_from: null, valid_to: null });
    await store.reviewLicense(held.id, "verified", adminUser.id, "ok");
    return held;
  };
  // A firm with an innovator acting for it and, optionally, a verified licence.
  const innovator = async (name, licenceId) => {
    const { user } = await store.createUser(name, ["innovator"]);
    const entity = await store.createEntity(user.id, { name: `${name} Bank`, registration_numbers: {}, regions: ["IN"], legal_form: "company_public", incorporation: { country: "in" } });
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    const held = licenceId ? await licence(entity.id, user.id, licenceId) : null;
    return { user, entity, held, client: await connect(user) };
  };
  return { pg, store, admin, adminUser, call, connect, innovator, licence };
}

const rd = {
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
  description: "A recurring deposit that collects a small amount every day from a mandate and pays a fixed rate.",
  key_features: ["Daily instalments", "Fixed rate"],
};

// A bank with its roster complete (compliance officer + auditor) and a partner aggregator on it.
async function bankWithRoster(ctx) {
  const { call, store, innovator, licence } = ctx;
  const bank = await innovator("Ines", "rbi_bank");
  const partnerEntity = await store.createEntity(null, { name: "Pay Partner", registration_numbers: {}, regions: ["IN"] });
  const partnerLicence = await licence(partnerEntity.id, bank.user.id, "rbi_pa");
  const officer = await call(bank.client, "add_party", {
    kind: "internal",
    person: { name: "Rhea Rao", identifiers: [{ scheme: "in_pan", value: "ABCDE1234F" }] },
    fills: [{ licence_id: bank.held.id, stakeholder: "rbi_bank_compliance_officer" }],
    attributes: { years_experience: 12 },
  });
  assert.equal(officer.isError, false, JSON.stringify(officer.data));
  const auditor = await call(bank.client, "add_party", {
    kind: "external",
    new_legal_entity: { name: "Audit & Co LLP", legal_form: "llp", incorporation: { country: "in", subdivision: "in-mh" }, identifiers: [{ scheme: "in_llpin", value: "AAA-1234" }] },
    fills: [{ licence_id: bank.held.id, stakeholder: "rbi_bank_statutory_auditor" }],
  });
  assert.equal(auditor.isError, false, JSON.stringify(auditor.data));
  const partner = await call(bank.client, "add_party", { kind: "external", legal_entity_id: partnerEntity.id, relationship: "mandate_collection_agreement" });
  assert.equal(partner.isError, false, JSON.stringify(partner.data));
  return { ...bank, officer: officer.data, auditor: auditor.data, partner: partner.data, partnerEntity, partnerLicence };
}

const composition = (b) => ({
  components: [
    { key: "deposit", country: "in", primitive: "account_operations", action: "issuance", underlying: "cash", provider: { by: "self" } },
    { key: "mandate", country: "in", primitive: "payments", action: "sale", provider: { by: "party", party_id: b.partner.id } },
  ],
  parties: [
    { party_id: b.officer.id, for: "deposit" },
    { party_id: b.auditor.id, for: "deposit" },
  ],
});

async function publishRd(ctx, b, comp = composition(b)) {
  const { call } = ctx;
  assert.equal((await call(b.client, "create_product", rd)).isError, false);
  const set = await call(b.client, "set_product_composition", { product_id: "everyday-rd", ...comp });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  await call(b.client, "test_product", { id: "everyday-rd" });
  return call(b.client, "publish_product", { id: "everyday-rd" });
}

test("the primitive is the line: a component's perimeter, supervisors, licences, law and provider follow from it", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  assert.equal((await ctx.call(b.client, "create_product", rd)).isError, false);
  const set = await ctx.call(b.client, "set_product_composition", { product_id: "everyday-rd", ...composition(b) });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  const [inRegion] = set.data.regions;
  const deposit = inRegion.components.find((c) => c.key === "deposit");
  assert.equal(deposit.primitive, "account_operations");
  assert.deepEqual(deposit.perimeter.map((p) => p.id), ["in_term_deposit"]);
  assert.deepEqual(deposit.supervised_by.map((s) => s.regulator_id), ["rbi"]);
  assert.deepEqual(deposit.licences.map((l) => l.license_id), ["rbi_bank"]);
  assert.ok(deposit.law.some((l) => l.legal_ref === "in_banking_regulation_act"));
  assert.equal(deposit.coverage.status, "covered");
  assert.equal(deposit.coverage.by[0].licence_id, b.held.id);
  assert.equal(deposit.stakeholders.complete, true);
  assert.deepEqual(deposit.stakeholders.unbound, []);

  const mandate = inRegion.components.find((c) => c.key === "mandate");
  assert.deepEqual(mandate.perimeter.map((p) => p.id), ["in_recurring_mandate"]);
  assert.deepEqual(mandate.licences.map((l) => l.license_id).sort(), ["rbi_bank", "rbi_pa"]);
  assert.equal(mandate.provider_entity_id, b.partnerEntity.id);
  assert.equal(mandate.coverage.status, "covered");
  assert.equal(mandate.coverage.by[0].license_id, "rbi_pa");
  assert.equal(mandate.stakeholders.enforced, false, "a partner's own roster is the partner's to keep");
  assert.equal(inRegion.covered, true);

  // A cross-line primitive no regulated type covers yet is unmodelled, and blocks publishing.
  const fx = await ctx.call(b.client, "set_product_composition", {
    product_id: "everyday-rd",
    components: [...composition(b).components, { key: "fx", country: "in", primitive: "exchange", action: "issuance", provider: { by: "self" } }],
    parties: composition(b).parties,
  });
  assert.equal(fx.data.regions[0].components.find((c) => c.key === "fx").coverage.status, "unmodelled");
  assert.equal(fx.data.regions[0].covered, false);
});

test("a firm's roster is reconciled against the stakeholders its licences mandate", async () => {
  const ctx = await setup();
  const { call } = ctx;
  const b = await ctx.innovator("Omar", "rbi_bank");
  let mine = (await call(b.client, "get_my_entity")).data;
  assert.equal(mine.legal_form, "company_public");
  assert.deepEqual(mine.incorporation, { country: "in" });
  const [bank] = mine.reconciliation.licences;
  assert.equal(bank.mandated, 2);
  assert.deepEqual(bank.missing.map((m) => m.stakeholder).sort(), ["rbi_bank_compliance_officer", "rbi_bank_statutory_auditor"]);
  assert.equal(mine.reconciliation.complete, false);

  // A junior officer fills the slot but fails its criteria; an officer with no stated experience is unconfirmed.
  const junior = await call(b.client, "add_party", {
    kind: "internal",
    person: { name: "Jay" },
    fills: [{ licence_id: b.held.id, stakeholder: "rbi_bank_compliance_officer" }],
    attributes: { years_experience: 3 },
  });
  mine = (await call(b.client, "get_my_entity")).data;
  assert.deepEqual(mine.reconciliation.licences[0].unqualified, [{ stakeholder: "rbi_bank_compliance_officer", party_id: junior.data.id, failed: ["years_experience"] }]);
  await call(b.client, "end_party", { party_id: junior.data.id });
  const unknown = await call(b.client, "add_party", { kind: "internal", person: { name: "Uma" }, fills: [{ licence_id: b.held.id, stakeholder: "rbi_bank_compliance_officer" }] });
  mine = (await call(b.client, "get_my_entity")).data;
  assert.deepEqual(mine.reconciliation.licences[0].filled, [{ stakeholder: "rbi_bank_compliance_officer", party_ids: [unknown.data.id] }]);
  assert.deepEqual(mine.reconciliation.licences[0].unconfirmed[0].criteria, ["years_experience"]);

  // Fills are checked against the regulatory model and the party's kind.
  const bad = await call(b.client, "add_party", {
    kind: "internal",
    person: { name: "Zed" },
    fills: [
      { licence_id: b.held.id, stakeholder: "rbi_bank_statutory_auditor" },
      { licence_id: b.held.id, stakeholder: "rbi_bank_chairman" },
      { licence_id: "00000000-0000-4000-8000-000000000000", stakeholder: "rbi_bank_compliance_officer" },
    ],
  });
  assert.equal(bad.isError, true);
  const errors = bad.data.errors.join("\n");
  assert.match(errors, /is an external stakeholder; this party is internal/);
  assert.match(errors, /'rbi_bank_chairman' isn't a mandatory stakeholder of rbi_bank/);
  assert.match(errors, /holds no licence/);
  assert.equal((await call(b.client, "add_party", { kind: "external", person: { name: "Firm?" } })).isError, true);
  assert.equal((await call(b.client, "add_party", { kind: "external", legal_entity_id: b.entity.id })).isError, true, "not on its own roster");
});

test("publishing needs every mandated stakeholder of the licence the firm provides under filled and bound", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  const comp = composition(b);
  const refused = await publishRd(ctx, b, { ...comp, parties: [comp.parties[0]] });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, new RegExp(`deposit .*bind party ${b.auditor.id} to 'deposit'`));
  const tested = (await ctx.call(b.client, "test_product", { id: "everyday-rd" })).data;
  assert.equal(tested.checks.find((c) => c.name === "composition_coverage").status, "fail");

  await ctx.call(b.client, "set_product_composition", { product_id: "everyday-rd", ...comp });
  await ctx.call(b.client, "test_product", { id: "everyday-rd" });
  const published = await ctx.call(b.client, "publish_product", { id: "everyday-rd" });
  assert.equal(published.isError, false, JSON.stringify(published.data));

  // The live composition is pinned: providers' licences resolved, and every entity, licence and party hashed.
  const record = await ctx.store.getProduct("everyday-rd");
  assert.equal(record.pins.version, 1);
  assert.deepEqual(record.pins.components.find((c) => c.key === "deposit").provider, { by: "self", licence_id: b.held.id });
  assert.deepEqual(new Set(record.pins.entity_ids), new Set([b.entity.id, b.partnerEntity.id, b.auditor.legal_entity_id]));
  assert.deepEqual(Object.keys(record.pins.state.licences).sort(), [b.held.id, b.partnerLicence.id].sort());
  assert.deepEqual(Object.keys(record.pins.state.parties).sort(), [b.officer.id, b.auditor.id, b.partner.id].sort());
  const guest = await ctx.connect(null);
  const regime = (await ctx.call(guest, "get_product_regime", { product_id: "everyday-rd" })).data;
  assert.equal(regime.live, true);
  assert.equal(regime.sales_paused, false);
});

test("when a pinned party leaves, the product drifts and new sales pause until a new version is published", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  assert.equal((await publishRd(ctx, b)).isError, false);
  const { user: consumerUser } = await ctx.store.createUser("Asha", ["consumer"]);
  const consumer = await ctx.connect(consumerUser);

  const ended = await ctx.call(b.client, "end_party", { party_id: b.auditor.id });
  assert.deepEqual(ended.data.drifted_products, ["everyday-rd"]);
  const shown = (await ctx.call(consumer, "get_product", { id: "everyday-rd" })).data;
  assert.equal(shown.sales_paused, true);
  assert.deepEqual(shown.drift.changes.map((c) => [c.kind, c.id]), [["party", b.auditor.id]]);
  const paused = await ctx.call(consumer, "enroll_in_product", { product_id: "everyday-rd" });
  assert.equal(paused.isError, true);
  assert.match(paused.data.error, /paused/);
  assert.ok((await ctx.store.auditLog(20)).some((a) => a.action === "product_drifted" && a.target === "everyday-rd"));

  // The working copy can't name the ended party any more; a new auditor goes live with a new version.
  const stale = await ctx.call(b.client, "set_product_composition", { product_id: "everyday-rd", ...composition(b) });
  assert.equal(stale.isError, true);
  assert.match(stale.data.errors.join("\n"), new RegExp(`party '${b.auditor.id}' isn't active`));
  const next = await ctx.call(b.client, "add_party", {
    kind: "external",
    new_legal_entity: { name: "Ledger Auditors LLP", legal_form: "llp", incorporation: { country: "in" } },
    fills: [{ licence_id: b.held.id, stakeholder: "rbi_bank_statutory_auditor" }],
  });
  const comp = composition(b);
  comp.parties[1] = { party_id: next.data.id, for: "deposit" };
  assert.equal((await ctx.call(b.client, "set_product_composition", { product_id: "everyday-rd", ...comp })).isError, false);
  await ctx.call(b.client, "create_product_version", { id: "everyday-rd", changelog: "New statutory auditor" });
  await ctx.call(b.client, "test_product", { id: "everyday-rd" });
  const republished = await ctx.call(b.client, "publish_product", { id: "everyday-rd" });
  assert.equal(republished.isError, false, JSON.stringify(republished.data));
  const record = await ctx.store.getProduct("everyday-rd");
  assert.equal(record.drift, null);
  assert.equal(record.pins.version, 2);
  assert.equal((await ctx.call(consumer, "enroll_in_product", { product_id: "everyday-rd" })).isError, false);
});

test("a suspended licence drifts every product resting on it, and re-verifying clears the drift", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  assert.equal((await publishRd(ctx, b)).isError, false);
  // The partner's licence, not the bank's.
  const suspended = await ctx.call(ctx.admin, "review_license", { license_record_id: b.partnerLicence.id, decision: "suspended", note: "regulator order" });
  assert.deepEqual(suspended.data.drifted_products, ["everyday-rd"]);
  assert.deepEqual((await ctx.store.getProduct("everyday-rd")).drift.changes.map((c) => [c.kind, c.id]), [["licence", b.partnerLicence.id]]);
  const restored = await ctx.call(ctx.admin, "review_license", { license_record_id: b.partnerLicence.id, decision: "verified", note: "order lifted" });
  assert.deepEqual(restored.data.drifted_products, []);
  assert.equal((await ctx.store.getProduct("everyday-rd")).drift, null);

  // A struck-off entity, too.
  const struck = await ctx.call(ctx.admin, "set_entity_status", { entity_id: b.partnerEntity.id, status: "struck_off" });
  assert.deepEqual(struck.data.drifted_products, ["everyday-rd"]);
});

test("compositions are checked against the reference data and the owner's roster", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  const rival = await bankWithRoster({ ...ctx, innovator: (n, l) => ctx.innovator(`${n}2`, l) });
  await ctx.call(b.client, "create_product", rd);
  const bad = await ctx.call(b.client, "set_product_composition", {
    product_id: "everyday-rd",
    components: [
      { key: "deposit", country: "in", primitive: "account_operations", action: "issuance", provider: { by: "self" } },
      { key: "deposit", country: "us", primitive: "payments", action: "sale" },
      { key: "mandate", country: "in", primitive: "payments", action: "sale", provider: { by: "party", party_id: rival.partner.id } },
      { key: "advice", country: "in", primitive: "wealth", action: "advice", provider: { by: "party", party_id: b.officer.id } },
      { key: "own", country: "in", primitive: "account_operations", action: "sale", provider: { by: "self", licence_id: rival.held.id } },
    ],
    parties: [{ party_id: b.officer.id, for: "nothing" }, { party_id: rival.officer.id, for: "deposit" }],
  });
  assert.equal(bad.isError, true);
  const errors = bad.data.errors.join("\n");
  assert.match(errors, /component 'deposit': the key is used twice/);
  assert.match(errors, /offered in IN, not US/);
  assert.match(errors, /name its provider/);
  assert.match(errors, new RegExp(`party '${rival.partner.id}' isn't on your entity's roster`));
  assert.match(errors, /a provider is a firm/);
  assert.match(errors, /your entity holds no licence/);
  assert.match(errors, /no component 'nothing'/);
  assert.match(errors, new RegExp(`party '${rival.officer.id}' isn't on your entity's roster`));
  // Old-shaped components are refused outright.
  const old = await ctx.call(b.client, "set_product_composition", { product_id: "everyday-rd", components: [{ region: "IN", primitive: "in_term_deposit", action: "issuance", role: "holds it", provided_by: "self" }] });
  assert.equal(old.isError, true);
  assert.equal((await ctx.call(rival.client, "set_product_composition", { product_id: "everyday-rd", ...composition(b) })).isError, true, "only the owner composes a product");
});

test("admins compose Mynt's reference products without providers; they show as reference", async () => {
  const { call, admin } = await setup();
  const id = CATALOG.find((p) => p.region === "IN" && p.category === "deposits").id;
  const component = { key: "deposit", country: "in", primitive: "account_operations", action: "issuance" };
  const set = await call(admin, "admin_set_product_composition", { product_id: id, components: [component] });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  assert.equal(set.data.regions[0].components[0].coverage.status, "reference");
  assert.equal(set.data.regions[0].covered, true);
  const withProvider = await call(admin, "admin_set_product_composition", { product_id: id, components: [{ ...component, provider: { by: "self" } }] });
  assert.match(withProvider.data.errors.join("\n"), /reference product has no firm/);
});

test("components stored in the old shape move to line primitives, partners on Mynt onto the owner's roster", async () => {
  const ctx = await setup();
  const b = await ctx.innovator("Ines", "rbi_bank");
  const partner = await ctx.store.createEntity(null, { name: "Partner", registration_numbers: {}, regions: ["IN"] });
  await ctx.call(b.client, "create_product", rd);
  const legacy = [
    { region: "IN", primitive: "in_term_deposit", action: "issuance", role: "holds the deposit", provided_by: "self" },
    { region: "IN", primitive: "in_recurring_mandate", action: "sale", role: "collects", provided_by: "partner", partner_entity_id: partner.id },
    { region: "IN", primitive: "in_recurring_mandate", action: "sale", role: "collects too", provided_by: "partner", partner_name: "Somebody" },
  ];
  await ctx.pg.query("UPDATE financial_products.products SET components = $2 WHERE id = $1", ["everyday-rd", JSON.stringify(legacy)]);
  const reopened = await Store.open(db(ctx.pg), CATALOG);
  const { components } = await reopened.getProduct("everyday-rd");
  const [roster] = [await reopened.partiesOf(b.entity.id)];
  assert.equal(roster.length, 1);
  assert.equal(roster[0].legal_entity_id, partner.id);
  assert.equal(roster[0].relationship, "partner");
  assert.deepEqual(components, [
    { key: "account_operations_issuance", country: "in", primitive: "account_operations", action: "issuance", provider: { by: "self" } },
    { key: "payments_sale", country: "in", primitive: "payments", action: "sale", provider: { by: "party", party_id: roster[0].id } },
    { key: "payments_sale_2", country: "in", primitive: "payments", action: "sale" },
  ]);
  // Idempotent.
  await Store.open(db(ctx.pg), CATALOG);
  assert.equal((await reopened.partiesOf(b.entity.id)).length, 1);
});

// What Mynt stores on a product: its own regime result, projected (see derived.ts).
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

test("the stored regime summary is productRegime's coverage: covered, partner-provided, uncovered, stakeholders bound or not", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  assert.equal((await ctx.call(b.client, "create_product", rd)).isError, false);
  const comp = composition(b);
  // The bank provides the deposit (auditor left unbound), the partner the mandate, and a resale the partner isn't licensed for.
  const set = await ctx.call(b.client, "set_product_composition", {
    product_id: "everyday-rd",
    components: [...comp.components, { key: "resale", country: "in", primitive: "account_operations", action: "sale", provider: { by: "party", party_id: b.partner.id } }],
    parties: [comp.parties[0]],
  });
  assert.equal(set.isError, false, JSON.stringify(set.data));
  // Mynt's own result for the working copy, as its owner sees it.
  const regime = (await ctx.call(b.client, "get_product_regime", { product_id: "everyday-rd" })).data;
  assert.ok(regime.regions, JSON.stringify(regime));
  const stored = await ctx.store.productDerived("everyday-rd");
  assert.ok(stored.derived_at);
  const s = stored.regime_summary;
  assert.equal(s.composition, "working_copy");
  assert.equal(s.publishable, false);
  // Component by component, the status, regulator and licence type are Mynt's own.
  const rows = regime.regions[0].components;
  const summary = s.regions[0].components;
  assert.deepEqual(summary.map((c) => [c.key, c.primitive, c.action, c.coverage.status]), rows.map((c) => [c.key, c.primitive, c.action, c.coverage.status]));
  assert.deepEqual(
    summary.map((c) => c.coverage.by.map((x) => [x.regulator_id, x.license_id])),
    rows.map((c) => (c.coverage.status === "covered" ? c.coverage.by.map((x) => [x.regulator_id, x.license_id]) : [])),
  );
  assert.deepEqual(s.regions[0].regulators, [{ regulator_id: "rbi", name: "Reserve Bank of India" }]);
  const [deposit, mandate, resale] = summary;
  assert.deepEqual(deposit.coverage.by, [{ regulator_id: "rbi", name: "Reserve Bank of India", license_id: "rbi_bank", licence: "Bank" }]);
  assert.equal(deposit.provided_by, "self");
  assert.deepEqual(
    { required: deposit.stakeholders.required, filled: deposit.stakeholders.filled, bound: deposit.stakeholders.bound, unbound: deposit.stakeholders.unbound },
    { required: 2, filled: ["rbi_bank_compliance_officer", "rbi_bank_statutory_auditor"], bound: 1, unbound: 1 },
  );
  assert.equal(mandate.provided_by, "partner");
  assert.equal(mandate.coverage.by[0].license_id, "rbi_pa");
  assert.equal(mandate.stakeholders.enforced, false);
  assert.equal(mandate.stakeholders.bound, null);
  assert.equal(resale.coverage.status, "uncovered");
  assert.equal(resale.coverage.reason, rows[2].coverage.reason);
  // The publish blockers are blockingComponents', without who the parties are.
  assert.deepEqual(s.publish_blockers.map((x) => x.key), ["deposit", "resale"]);
  assert.match(s.publish_blockers[0].reason, /bind a party to 'deposit'/);
  assert.equal(deposit.blocking, s.publish_blockers[0].reason);
  // No registration numbers, licence records or party ids.
  const text = JSON.stringify(s);
  assert.doesNotMatch(text, /rbi_bank-1|rbi_pa-1/);
  assert.doesNotMatch(text, UUID_RE);

  // Bound and published: the live composition, every stakeholder bound, nothing blocking.
  await ctx.call(b.client, "set_product_composition", { product_id: "everyday-rd", ...comp });
  await ctx.call(b.client, "test_product", { id: "everyday-rd" });
  assert.equal((await ctx.call(b.client, "publish_product", { id: "everyday-rd" })).isError, false);
  const live = (await ctx.store.productDerived("everyday-rd")).regime_summary;
  assert.equal(live.composition, "live");
  assert.equal(live.publishable, true);
  assert.deepEqual(live.publish_blockers, []);
  assert.equal(live.regions[0].components[0].stakeholders.bound, 2);
});

test("a licence suspension recomputes the stored coverage of the products resting on it", async () => {
  const ctx = await setup();
  const b = await bankWithRoster(ctx);
  assert.equal((await publishRd(ctx, b)).isError, false);
  const before = await ctx.store.productDerived("everyday-rd");
  assert.equal(before.regime_summary.regions[0].components[0].coverage.status, "covered");
  await ctx.call(ctx.admin, "review_license", { license_record_id: b.held.id, decision: "suspended", note: "regulator order" });
  const after = await ctx.store.productDerived("everyday-rd");
  assert.ok(after.derived_at >= before.derived_at);
  const deposit = after.regime_summary.regions[0].components[0];
  assert.equal(deposit.coverage.status, "uncovered");
  assert.match(deposit.coverage.reason, /The pinned licence isn't verified and in force/);
  assert.deepEqual(after.regime_summary.publish_blockers.map((x) => x.key), ["deposit"]);
  const guest = await ctx.connect(null);
  const regime = (await ctx.call(guest, "get_product_regime", { product_id: "everyday-rd", live: true })).data;
  assert.equal(regime.regions[0].components[0].coverage.status, "uncovered");
  await ctx.call(ctx.admin, "review_license", { license_record_id: b.held.id, decision: "verified", note: "order lifted" });
  assert.equal((await ctx.store.productDerived("everyday-rd")).regime_summary.regions[0].components[0].coverage.status, "covered");
});

test("reference products are stored as reference; admins recompute every product, and products without one get it on boot", async () => {
  const { call, admin, store, pg } = await setup();
  const id = CATALOG.find((p) => p.region === "IN" && p.category === "deposits").id;
  await call(admin, "admin_set_product_composition", { product_id: id, components: [{ key: "deposit", country: "in", primitive: "account_operations", action: "issuance" }] });
  const stored = await store.productDerived(id);
  assert.equal(stored.regime_summary.regions[0].components[0].coverage.status, "reference");
  assert.equal(stored.regime_summary.regions[0].components[0].provided_by, null);
  assert.equal(stored.regime_summary.publishable, true);
  assert.equal(stored.take_rate.configured, false);
  assert.equal(stored.take_rate.rate_pct, null);
  assert.match(stored.take_rate.reason, /No take rate is configured/);

  // The admin tool: one product, or all of them.
  const one = await call(admin, "recompute_product_derived", { product_id: id });
  assert.equal(one.data.recomputed, 1);
  assert.equal(one.data.regime_summary.regions[0].components[0].coverage.status, "reference");
  const all = await call(admin, "recompute_product_derived");
  assert.equal(all.data.recomputed, CATALOG.length);
  assert.deepEqual(all.data.failed, []);
  assert.equal((await store.productsNotDerived()).length, 0);

  // Boot: only the products without one.
  await pg.query("UPDATE financial_products.products SET derived_at = NULL, regime_summary = NULL, take_rate = NULL WHERE id = $1", [id]);
  const { recomputeDerived } = await import("../dist/derived.js");
  assert.equal((await recomputeDerived(store, { missing_only: true })).recomputed, 1);
  assert.equal((await store.productDerived(id)).regime_summary.regions[0].components[0].coverage.status, "reference");
});

test("a regime Mynt can't compute is stored as a note, never thrown", async () => {
  const { store } = await setup();
  const { deriveProduct } = await import("../dist/derived.js");
  const id = CATALOG[0].id;
  const record = await store.getProduct(id);
  const broken = new Proxy(store, {
    get: (t, k) => (k === "regulatedProductTypes" ? async () => { throw new Error("model unavailable"); } : typeof t[k] === "function" ? t[k].bind(t) : t[k]),
  });
  const result = await deriveProduct(broken, { ...record, components: [{ key: "deposit", country: "in", primitive: "account_operations", action: "issuance" }] });
  assert.equal(result.ok, false);
  const stored = await store.productDerived(id);
  assert.match(stored.regime_summary.error, /couldn't compute the regime: model unavailable/);
  assert.ok(stored.derived_at);
});
