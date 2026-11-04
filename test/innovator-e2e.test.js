import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";
import { TEMPLATE } from "./v2-helpers.js";

// An innovator mints a financial product end to end, through nothing but Mynt's MCP tools, as each
// person would: the admin keeps the regulatory model and verifies licences, the innovator sets up
// the firm and composes, checks, versions and publishes a recurring deposit (a recurring mandate
// plus a term deposit), and a developer finds it, gets access and reads what an app needs.
//
// The only steps outside MCP are signing in (the auth layer creates the user from the admin's
// invitation, as Clerk does) and reading the store to confirm what the tools said.

async function world() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "e2e", version: "0" });
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
  // Calls a tool and fails the test with its error if it errs.
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  // Signing in: the admin's invitation decides the roles (the auth layer's job, not a tool).
  const signIn = async (email, name) => {
    const invite = await store.getInvite(email);
    assert.ok(invite, `${email} wasn't invited`);
    const user = await store.upsertClerkUser(`clerk_${name.toLowerCase()}`, email, name, invite.roles);
    return { user, client: await connect(user) };
  };
  const tools = async (client) => (await client.listTools()).tools.map((t) => t.name);
  return { store, connect, call, ok, signIn, tools };
}

const PRODUCT = "daily-saver-rd";

// The recurring-deposit definition: the deposit issued under the firm's bank licence, the mandate
// sold by the payment aggregator on its roster (with a handoff), interest governed by a record in the
// product's GRC folder.
function recurringDeposit({ entityId, bankLicenceId, partnerId, officerId, governanceId }) {
  const d = structuredClone(TEMPLATE);
  d._id = PRODUCT;
  d.product_name = "Daily Saver Recurring Deposit";
  d.owner_entity_id = entityId;
  d.plane = { role: "standalone", sellable: true };
  d.risk_models = [{ _id: "rd_interest_model", model_name: "RD interest model", description: "Compounding per instalment", purpose: "other", repository: "models/rd-interest" }];
  d.partner_handoffs = [
    { _id: "mandate_setup", name: "Register the mandate", trigger: "account_opened", sends: { type: "object", required: ["customer_ref", "amount"] }, returns: { type: "object", required: ["mandate_id"] } },
  ];
  d.connections = d.connections
    .filter((c) => c.type !== "segment_maps_to_persona")
    .concat([
      { _id: "p_deposit", type: "component_provided_by", from: { kind: "component", id: "deposit" }, to: { kind: "owner", licence_id: bankLicenceId }, attributes: { business_role: "issuer" } },
      { _id: "p_mandate", type: "component_provided_by", from: { kind: "component", id: "mandate" }, to: { kind: "party", id: partnerId }, attributes: { business_role: "payment_service_provider" } },
      { _id: "h_party", type: "handoff_to_party", from: { kind: "partner_handoff", id: "mandate_setup" }, to: { kind: "party", id: partnerId }, attributes: { sla: "PT15M", consent_purpose: "mandate_setup", channel: "api" } },
      { _id: "h_serves", type: "handoff_serves_component", from: { kind: "partner_handoff", id: "mandate_setup" }, to: { kind: "component", id: "mandate" } },
      { _id: "owner_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "owner" }, attributes: { role: "product_owner", bound_component: "deposit" } },
      { _id: "retail_persona", type: "segment_maps_to_persona", from: { kind: "customer_segment", id: "retail_saver" }, to: { kind: "register_persona", regulator_id: "rbi", id: "rbi_retail_depositor" }, attributes: { fit: "subset" } },
      { _id: "senior_persona", type: "segment_maps_to_persona", from: { kind: "customer_segment", id: "senior_saver" }, to: { kind: "register_persona", regulator_id: "rbi", id: "rbi_senior_depositor" }, attributes: { fit: "subset" } },
      { _id: "uses_model", type: "algorithm_uses_risk_model", from: { kind: "core_algorithm", id: "rd_interest" }, to: { kind: "risk_model", id: "rd_interest_model" }, attributes: { role: "primary", outputs_used: ["rate"] } },
      { _id: "governed", type: "risk_model_governed_by", from: { kind: "risk_model", id: "rd_interest_model" }, to: { kind: "grc_record", id: governanceId, section: "risk_models", product_id: PRODUCT }, attributes: { governance_kind: "validation", frequency: "annual", owner_party_id: officerId } },
    ]);
  return d;
}

const emptyGrc = (grants, extra = {}) => ({
  registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [], ...(extra.registers ?? {}) },
  repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [], ...(extra.repositories ?? {}) },
  allowed_product_types: grants,
  allowed_customer_segments: [],
  mandatory_stakeholders: extra.mandatory_stakeholders ?? { internal: [], external: [] },
});

test("an innovator mints a recurring deposit end to end through MCP tools, and a developer builds on it", async () => {
  const w = await world();
  const { store, connect, call, ok, signIn, tools } = w;

  // ---- each role sees its own tools (roles nest: admin > innovator > developer > consumer) ----
  const { user: adminUser } = await store.createUser("Ada", ["admin"]); // bootstrapped from the CLI
  const admin = await connect(adminUser);
  const adminTools = await tools(admin);
  for (const t of ["define_regulator", "define_regulated_product_type", "define_product_category", "review_license", "invite_user"]) assert.ok(adminTools.includes(t), t);

  // ---- admin: invite the people, and make sure the regulatory model a recurring deposit needs is there ----
  await ok(admin, "invite_user", { email: "ines@bank.example", roles: ["innovator"] });
  await ok(admin, "invite_user", { email: "paul@pay.example", roles: ["innovator"] });
  await ok(admin, "invite_user", { email: "dev@apps.example", roles: ["developer"] });
  await ok(admin, "invite_user", { email: "dana@apps.example", roles: ["developer"] });

  // The region and the deposits category come prefilled (the seed); the mandates category doesn't.
  const regions = await ok(admin, "list_regions");
  assert.ok(regions.some((r) => r.code === "IN"), "India is defined");
  const categories = await ok(admin, "list_product_categories");
  assert.ok(categories.some((c) => c.id === "deposits" && c.product_lines.includes("account_operations")), JSON.stringify(categories));
  if (!categories.some((c) => c.id === "mandates")) await ok(admin, "define_product_category", { id: "mandates", name: "Payment mandates", product_lines: ["payments"] });

  // Nothing about RBI yet: define the two product types and the regulator with its licences.
  assert.equal((await call(admin, "get_regulator", { region: "IN", regulator_id: "rbi" })).isError, true, "no RBI in a fresh model");
  const types = await ok(admin, "list_regulated_product_types", { region: "IN" });
  for (const t of [
    { id: "in_term_deposit", name: "Term deposit", type_id: "deposits", actions: ["issuance", "sale"], underlying: "cash" },
    { id: "in_recurring_mandate", name: "Recurring payment mandate", type_id: "mandates", actions: ["issuance", "sale"] },
  ])
    if (!JSON.stringify(types).includes(`"${t.id}"`)) await ok(admin, "define_regulated_product_type", { region: "IN", product_type: { ...t, description: "" } });
  await ok(admin, "define_regulator", {
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
          application_procedure: ["Apply to RBI for a banking licence"],
          grc: emptyGrc(["in_term_deposit", "in_recurring_mandate"], {
            registers: { obligations: [{ id: "rbi_kyc", title: "Know your customer", criticality: "high", owner: "rbi_principal_officer" }] },
            repositories: { risk_models: [{ id: "interest_model", name: "Interest computation model", extends_default: false, fields: [{ key: "model", label: "Model", type: "string", required: true }] }] },
            mandatory_stakeholders: { internal: [{ id: "rbi_principal_officer", name: "Principal officer", qualification: {}, action: "kyc_reporting" }], external: [] },
          }),
        },
        { _id: "rbi_pa", name: "Payment aggregator", grc: emptyGrc([{ id: "in_recurring_mandate", actions: ["sale"] }]) },
      ],
    },
  });

  // ---- the payment aggregator (another firm on Mynt) registers itself and its licence ----
  const paul = await signIn("paul@pay.example", "Paul");
  const payFirm = await ok(paul.client, "create_entity", { name: "Pay Partner Pvt Ltd", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const paLicence = await ok(paul.client, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: "PA-0042" });

  // ---- innovator: the firm, its licence, its roster and its GRC folder ----
  const ines = await signIn("ines@bank.example", "Ines");
  const innovator = ines.client;
  const innovatorTools = await tools(innovator);
  for (const t of ["create_entity", "register_license", "add_party", "file_grc_record", "create_product", "check_product_definition", "set_product_definition", "test_product", "publish_product", "create_product_version", "set_product_access", "review_request"])
    assert.ok(innovatorTools.includes(t), t);
  assert.ok(!innovatorTools.includes("review_license"), "innovators can't verify their own licences");
  assert.deepEqual((await ok(innovator, "whoami")).effective_roles.sort(), ["consumer", "developer", "innovator"]);
  assert.equal((await call(innovator, "get_my_entity")).isError, true, "no firm yet");

  const firm = await ok(innovator, "create_entity", {
    name: "Ines Bank Ltd",
    legal_form: "company_public",
    incorporation: { country: "in", subdivision: "in-mh" },
    identifiers: [{ scheme: "in_cin", value: "L65110MH2020PLC000001" }],
    regions: ["IN"],
  });
  const found = await ok(innovator, "find_licenses", { region: "IN", category: "deposits", action: "issuance" });
  assert.ok(JSON.stringify(found).includes("rbi_bank"), `find_licenses names the bank licence: ${JSON.stringify(found)}`);
  const bank = await ok(innovator, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_bank", registration_number: "BANK-0001", valid_from: "2020-01-01" });
  assert.equal((await ok(innovator, "get_my_entity")).licenses.find((l) => l.id === bank.id).status, "pending");

  // ---- admin: verify both licences against the regulator's register ----
  const pending = await ok(admin, "list_license_reviews");
  assert.deepEqual(new Set(pending.map((l) => l.id)), new Set([bank.id, paLicence.id]));
  for (const l of pending) await ok(admin, "review_license", { license_record_id: l.id, decision: "verified", note: "Checked on the RBI register" });

  // The roster: the aggregator (an external firm already on Mynt) and the principal officer the bank licence mandates.
  // GAP: no innovator tool finds another firm on Mynt (list_entities is admin-only), so add_party's
  // legal_entity_id has to reach Ines out of band: here Paul's create_entity result. The other route,
  // add_party { new_legal_entity }, makes a firm with no members, whose licences nobody can register
  // until an admin adds someone to it (add_entity_member).
  assert.equal((await tools(innovator)).includes("list_entities"), false);
  const partner = await ok(innovator, "add_party", { kind: "external", legal_entity_id: payFirm.id, relationship: "mandate_collection_agreement" });
  const officer = await ok(innovator, "add_party", { kind: "internal", person: { name: "Priya Principal Officer" }, fills: [{ licence_id: bank.id, stakeholder: "rbi_principal_officer" }] });
  const kyc = await ok(innovator, "file_grc_record", { licence_id: bank.id, section: "obligations", ref: "rbi_kyc", record: { status: "compliant", owner: officer.id, assessed_on: "2026-10-01" } });
  assert.equal(kyc.folder, "registers");
  const entity = await ok(innovator, "get_my_entity");
  assert.equal(entity.licenses.find((l) => l.id === bank.id).status, "verified");
  assert.equal(entity.parties.length, 2);

  // ---- innovator: compose the product ----
  await ok(innovator, "create_product", {
    id: PRODUCT,
    name: "Daily Saver Recurring Deposit",
    product_line: "account_operations",
    category: "deposits",
    region: "IN",
    risk_level: "low",
    liquidity: "low",
    typical_horizon: "medium",
    return_type: "fixed_interest",
    regulator: "RBI",
    description: "Placeholder until the definition is saved.",
    key_features: ["Monthly instalments", "Fixed rate"],
  });
  // The definition's JSON Schema is readable over MCP (innovators can't open the repository).
  const schema = await innovator.readResource({ uri: "mynt://schemas/financial-product.v2" });
  const schemaJson = JSON.parse(schema.contents[0].text);
  for (const k of ["components", "customer_segments", "terms", "rates", "fees", "servicing_policies", "connections"]) assert.ok(schemaJson.properties[k], k);
  const ids = { entityId: firm.id, bankLicenceId: bank.id, partnerId: partner.id, officerId: officer.id };

  // First check: the interest model has no governance record yet, so the definition is refused with the reason.
  const first = await ok(innovator, "check_product_definition", { product_id: PRODUCT, definition: recurringDeposit({ ...ids, governanceId: "00000000-0000-4000-8000-000000000000" }) });
  assert.equal(first.valid, false);
  assert.match(first.errors.join("\n"), /no current record/);

  // File the model's governance in the product's own GRC folder, then check again until it passes.
  const governance = await ok(innovator, "file_grc_record", { product_id: PRODUCT, licence_id: bank.id, section: "risk_models", ref: "interest_model", key: "rd_interest_model", record: { model: "RD interest model v1.2" } });
  const definition = recurringDeposit({ ...ids, governanceId: governance.id });
  const almost = await ok(innovator, "check_product_definition", { product_id: PRODUCT, definition });
  assert.equal(almost.valid, true, JSON.stringify(almost.errors));
  // Valid, but the bank licence mandates a principal officer, and the deposit (which the firm issues
  // itself) has to name them. The check says so before publish would.
  assert.deepEqual(
    almost.publish_blockers.map((b) => [b.key, b.reason]),
    [["deposit", `rbi_bank: bind party ${officer.id} to 'deposit'`]],
  );
  definition.connections.push({ _id: "officer_role", type: "party_plays_role", from: { kind: "product", id: "self" }, to: { kind: "party", id: officer.id }, attributes: { role: "compliance_officer", bound_component: "deposit" } });
  const checked = await ok(innovator, "check_product_definition", { product_id: PRODUCT, definition });
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  assert.deepEqual(checked.publish_blockers, []);
  assert.ok(checked.developer_contract, "the contract developers will get is previewed");
  // Business context the definition carries: segments (with eligibility), pricing and servicing.
  assert.deepEqual(definition.customer_segments.map((s) => s._id), ["retail_saver", "senior_saver"]);
  assert.ok(definition.rates.length && definition.fees.length && definition.servicing_policies.length);

  await ok(innovator, "set_product_definition", { product_id: PRODUCT, definition });
  const regime = await ok(innovator, "get_product_regime", { product_id: PRODUCT, working: true });
  assert.equal(regime.regions[0].covered, true, JSON.stringify(regime.regions[0].components.map((c) => [c.coverage, c.stakeholders])));
  assert.deepEqual(regime.regions[0].components.map((c) => [c.key, c.primitive, c.action]), [["mandate", "payments", "sale"], ["deposit", "account_operations", "issuance"]].sort((a, b) => a[0].localeCompare(b[0])));
  const tested = await ok(innovator, "test_product", { id: PRODUCT });
  assert.equal(tested.passed, true, JSON.stringify(tested.checks.filter((c) => c.status === "fail")));
  await ok(innovator, "publish_product", { id: PRODUCT });
  const guest = await connect(null);
  assert.equal((await ok(guest, "get_product", { id: PRODUCT })).name, "Daily Saver Recurring Deposit", "live in the public catalogue");

  // ---- innovator: version it (a senior-citizen bonus), check, test and republish ----
  await ok(innovator, "create_product_version", { id: PRODUCT, changelog: "Senior citizen bonus of 50 bps" });
  const v2 = structuredClone(definition);
  v2.descriptions.summary = "A recurring deposit with a 50 bps bonus for senior citizens.";
  assert.equal((await ok(innovator, "check_product_definition", { product_id: PRODUCT, definition: v2 })).valid, true);
  assert.equal((await ok(innovator, "set_product_definition", { product_id: PRODUCT, definition: v2, changelog: "Senior citizen bonus of 50 bps" })).applied_to, "draft_version");
  assert.equal((await ok(innovator, "test_product", { id: PRODUCT })).passed, true);
  await ok(innovator, "publish_product", { id: PRODUCT });
  const versions = await ok(innovator, "list_product_versions", { id: PRODUCT });
  assert.equal(versions.live_version, 2, JSON.stringify(versions));
  assert.deepEqual(versions.versions.map((v) => [v.version, v.status]).sort(), [[1, "superseded"], [2, "published"]]);

  // ---- innovator: publish it to developers, with approval ----
  await ok(innovator, "set_product_access", {
    id: PRODUCT,
    access_mode: "approval",
    build_terms: {
      permitted_actions: ["display", "compare", "deep_link", "initiate_onboarding"],
      required_disclosures: ["Deposits are subject to RBI rules on premature withdrawal."],
      banned_phrases: ["risk-free"],
      handoff_url: "https://bank.example/rd/start",
    },
  });

  // ---- developer: find it, get access, read what an app needs ----
  const dev = await signIn("dev@apps.example", "Dev");
  const developer = dev.client;
  const developerTools = await tools(developer);
  assert.ok(!developerTools.includes("create_product"), "developers don't mint products");
  const buildable = await ok(developer, "list_buildable_products", { product_line: "account_operations" });
  const listed = buildable.find((p) => p.id === PRODUCT);
  assert.ok(listed, `in the developer's catalogue: ${JSON.stringify(buildable).slice(0, 500)}`);
  assert.equal(listed.access_mode, "approval");

  const contract = await ok(developer, "get_developer_contract", { product_id: PRODUCT });
  assert.equal(contract.version, 2, "the live version's contract");
  assert.match(contract.contract_hash, /^sha256:/);
  assert.deepEqual(contract.offers.map((o) => o.segment_id).sort(), ["retail_saver", "senior_saver"]);
  assert.ok(contract.actions.some((a) => a.id === "mandate_setup" && a.surface === "client"), "a client action a session can be scoped to");

  const app = await ok(developer, "create_app", {
    name: "Saver",
    description: "Save a little every month",
    audience: "Salaried savers in India",
    product_ids: [PRODUCT],
    disclosures: ["Deposits are subject to RBI rules on premature withdrawal."],
    actions: ["display", "initiate_onboarding"],
  });
  assert.equal((await call(developer, "publish_app", { app_id: app.id })).isError, true, "can't go live before the innovator approves");
  const asked = await ok(developer, "request_product_access", { app_id: app.id, product_id: PRODUCT, note: "A monthly saving app" });

  const inbox = await ok(innovator, "list_requests", { product_id: PRODUCT });
  assert.deepEqual(inbox.map((r) => r.id), [asked.id]);
  assert.equal(inbox[0].app.name, "Saver");
  await ok(innovator, "review_request", { request_id: asked.id, decision: "approve", note: "Welcome" });

  assert.equal((await ok(developer, "list_my_requests", { status: "approved" })).length, 1);
  const fit = await ok(developer, "check_experience", { app_id: app.id });
  assert.equal(fit.ready, true, JSON.stringify(fit));
  await ok(developer, "publish_app", { app_id: app.id });
  const key = await ok(developer, "create_api_key", { app_id: app.id, environment: "sandbox", label: "e2e" });
  assert.match(key.key, /^mynt_test_/);

  // The app's server mints a client session for a device: the product has a pinned developer
  // contract, so this doesn't fail with 'no_contract'.
  const http = createMcpHttpServer(store, null, {}, { publicUrl: "https://mynt.test" }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  try {
    const base = `http://127.0.0.1:${http.address().port}`;
    const api = async (method, path, body) => {
      const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${key.key}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    const served = await api("GET", `/v1/products/${PRODUCT}/contract`);
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(served.body.contract_hash, contract.contract_hash);
    const session = await api("POST", "/v1/client_sessions", { product_ids: [PRODUCT], scopes: ["mandate_setup"], customer_ref: "cust_1" });
    assert.equal(session.status, 201, JSON.stringify(session.body));
    assert.match(session.body.client_secret, /^mcs_test_/);
  } finally {
    http.closeAllConnections();
    http.close();
  }

  // ---- private access: a second developer needs an invitation ----
  await ok(innovator, "set_product_access", { id: PRODUCT, access_mode: "private" });
  const dana = await signIn("dana@apps.example", "Dana");
  const sees = async () => (await ok(dana.client, "list_buildable_products")).some((p) => p.id === PRODUCT);
  assert.equal(await sees(), false, "a private product is hidden from developers who weren't invited");
  const danaAppInput = { name: "Dana's", description: "Saving for students", audience: "Students", product_ids: [PRODUCT], disclosures: ["Deposits are subject to RBI rules on premature withdrawal."] };
  assert.match((await call(dana.client, "create_app", danaAppInput)).data.error, /not available.*private/, "no building on it uninvited");
  await ok(innovator, "invite_developer", { product_id: PRODUCT, developer_email: "dana@apps.example" });
  assert.equal(await sees(), true, "and shows once they are");
  const danaApp = await ok(dana.client, "create_app", danaAppInput);
  await ok(dana.client, "publish_app", { app_id: danaApp.id });
});
