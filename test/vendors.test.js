import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { createServer } from "../dist/server.js";
import { callVendor, resolveVendorUrl } from "../dist/vendor-call.js";
import { publishDefined, setup } from "./v2-helpers.js";

// Vendors offer standard services (here a CKYC search) that innovators plug into their products. Mynt tests a
// vendor's endpoint itself before it's listed, keeps the subscriber's credential in its key vault, and calls
// the vendor when a developer's app asks to prefill a customer's data: the app changes nothing.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
// Tests reach the vendor they run on 127.0.0.1 over plain HTTP; production never sets this.
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 400 };
const CREDENTIAL = "vendor-cred-7f3a9c";
const LIVE_CREDENTIAL = "vendor-live-cred-91b2e4";

// A vendor's service as the wire contract describes it: it checks Mynt-Signature against the secrets it was
// shown, and answers in the mode the test sets.
async function vendorServer() {
  const state = { mode: "ok", secrets: new Set(), seen: [], acceptStale: false };
  const verify = (header, raw) => {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
    if (!m) return false;
    if (!state.acceptStale && Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
    return [...state.secrets].some((s) => {
      const want = createHmac("sha256", s).update(`${m[1]}.${raw}`).digest();
      return timingSafeEqual(want, Buffer.from(m[2], "hex"));
    });
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const signed = verify(req.headers["mynt-signature"], raw);
    state.seen.push({ path: req.url, authorization: req.headers.authorization ?? null, signed, body });
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!signed) return reply(401, { request_id: body.request_id, status: "error", output: null, error: { code: "bad_signature", message: "Signature mismatch" } });
    if (state.mode === "slow") await new Promise((r) => setTimeout(r, 1200));
    if (state.mode === "redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    const output =
      state.mode === "bad_output"
        ? { ckyc_number: 42, full_name: "Asha Verma" }
        : { ckyc_number: "12345678901234", full_name: "Asha Verma", date_of_birth: "1991-04-12", address: "12 MG Road, Bengaluru" };
    reply(200, { request_id: body.request_id, status: "ok", output, error: null });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
}

const servers = [];
after(() => servers.forEach((s) => s.close()));

async function world() {
  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "vendors", version: "0" });
    await client.connect(c);
    return client;
  };
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const tools = async (client) => (await client.listTools()).tools.map((t) => t.name);
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const admin = await connect(adminUser);
  const innovator = await connect(ctx.user);
  const vendor = await vendorServer();
  servers.push(vendor);
  return { ...ctx, connect, ok, tools, admin, adminUser, innovator, vendor };
}

// The CKYC service as an admin defines it for the test's regulatory model: the subscribing firm must hold a
// bank licence; the vendor, as a stand-in, the payment aggregator licence the test model has.
const CKYC = {
  region: "IN",
  key: "ckyc_search_download",
  name: "CKYC search and download",
  category: "kyc",
  input_schema: { type: "object", required: ["pan"], properties: { pan: { type: "string", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$" } }, additionalProperties: false },
  output_schema: {
    type: "object",
    required: ["ckyc_number", "full_name", "date_of_birth"],
    properties: { ckyc_number: { type: "string", pattern: "^[0-9]{14}$" }, full_name: { type: "string" }, date_of_birth: { type: "string", format: "date" }, address: { type: "string" } },
    additionalProperties: false,
  },
  consent_purpose: "kyc_records_fetch",
  fills: ["full_name", "date_of_birth", "address"],
  innovator_licences: ["rbi_bank"],
  vendor_licences: ["rbi_pa"],
};

test("outbound safety: HTTPS only, no private, loopback, link-local or metadata addresses, no redirects", async () => {
  for (const [url, why] of [
    ["http://8.8.8.8/v1", /HTTPS only/],
    ["http://127.0.0.1:9/v1", /HTTPS only/],
    ["https://127.0.0.1/v1", /private, loopback/],
    ["https://localhost/v1", /private, loopback|doesn't resolve/],
    ["https://10.1.2.3/v1", /private/],
    ["https://192.168.1.10/v1", /private/],
    ["https://169.254.169.254/latest/meta-data/", /private, loopback, link-local/],
    ["https://100.100.100.200/", /private/],
    ["https://[::1]/v1", /private/],
    ["https://[fd00:ec2::254]/", /private/],
    ["https://[::ffff:169.254.169.254]/", /private/],
    ["https://[::ffff:a9fe:a9fe]/", /private/],
    ["https://[::a9fe:a9fe]/", /private/],
    ["https://[64:ff9b:1::a9fe:a9fe]/", /private/],
    ["https://[2002:a9fe:a9fe::1]/", /private/],
    ["https://[fec0::1]/", /private/],
    ["https://8.8.8.8:8443/v1", /only port 443/],
    ["https://8.8.8.8:22/", /only port 443/],
    ["https://user:secret@8.8.8.8/", /credentials/],
    ["ftp://8.8.8.8/", /HTTPS only/],
  ])
    await assert.rejects(resolveVendorUrl(url), why, url);
  assert.equal((await resolveVendorUrl("https://8.8.8.8/v1")).address, "8.8.8.8", "a public address is fine (not called)");
  assert.equal((await resolveVendorUrl("https://8.8.8.8:443/v1")).address, "8.8.8.8");
  // Even with the test-only loopback allowance, plain HTTP elsewhere and private addresses stay refused.
  await assert.rejects(resolveVendorUrl("http://8.8.8.8/", VENDOR_OPTS), /HTTPS only/);
  await assert.rejects(resolveVendorUrl("https://10.0.0.1/", VENDOR_OPTS), /private/);

  // A refused URL is never called; a redirect is never followed.
  const refused = await callVendor({ base_url: "https://169.254.169.254", service_type: "x", body: {}, signing_secret: "s" });
  assert.match(refused.error, /^refused:/);
  assert.equal(refused.http_status, null);
  const v = await vendorServer();
  servers.push(v);
  v.state.secrets.add("s");
  v.state.mode = "redirect";
  const redirected = await callVendor({ base_url: v.url, service_type: "x", body: { request_id: "r" }, signing_secret: "s" }, VENDOR_OPTS);
  assert.equal(redirected.ok, false);
  assert.equal(redirected.error, "redirects aren't followed");
  assert.equal(v.state.seen.length, 1, "only the first hop was called");
});

test("vendors: roles, service types per region, Mynt's conformance test, subscriptions, and prefill through the vendor", async () => {
  const w = await world();
  const { store, call, ok, tools, admin, innovator, vendor } = w;

  // ---- roles: a vendor is a peer of innovators, with vendor tools only ----
  await ok(admin, "invite_user", { email: "vera@kycworks.example", roles: ["vendor"] });
  const firm = await ok(admin, "register_firm", { name: "KYC Works Pvt Ltd", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const invite = await store.getInvite("vera@kycworks.example");
  const veraUser = await store.upsertClerkUser("clerk_vera", "vera@kycworks.example", "Vera", invite.roles);
  await ok(admin, "add_entity_member", { email: "vera@kycworks.example", entity_id: firm.id });
  const vera = await w.connect(veraUser);
  const vendorTools = await tools(vera);
  for (const t of ["whoami", "list_service_types", "create_vendor_offering", "update_vendor_offering", "run_conformance", "list_my_offerings", "list_my_subscribers", "reveal_subscription_secret", "rotate_subscription_secret", "get_my_entity", "register_license"])
    assert.ok(vendorTools.includes(t), t);
  for (const t of ["create_product", "publish_product", "set_product_definition", "create_app", "create_entity", "add_party", "list_vendor_offerings", "subscribe_vendor_service", "define_service_type", "create_product_request"])
    assert.ok(!vendorTools.includes(t), `vendors don't get ${t}`);
  assert.deepEqual((await ok(vera, "whoami")).effective_roles, ["vendor"]);
  assert.equal((await call(vera, "publish_product", { id: "everyday-rd" })).isError, true, "a vendor can't publish");
  const innovatorTools = await tools(innovator);
  for (const t of ["list_vendor_offerings", "subscribe_vendor_service", "list_my_vendor_subscriptions", "set_subscription_live", "unsubscribe_vendor_service", "list_service_types"]) assert.ok(innovatorTools.includes(t), t);
  for (const t of ["create_vendor_offering", "run_conformance", "define_service_type"]) assert.ok(!innovatorTools.includes(t), `innovators don't get ${t}`);
  const adminTools = await tools(admin);
  for (const t of ["define_service_type", "load_service_types", "suspend_vendor_offering", "register_firm", "create_vendor_offering", "subscribe_vendor_service"]) assert.ok(adminTools.includes(t), `admins keep ${t}`);

  // ---- service types, per region ----
  assert.deepEqual(await ok(vera, "list_service_types", { region: "IN" }), []);
  const bad = await call(admin, "define_service_type", {
    service_type: { ...CKYC, fills: ["full_name", "monthly_income", "shoe_size"], innovator_licences: ["rbi_nbfc"], input_schema: { type: "object", required: ["customer_secret"], properties: {} } },
  });
  assert.equal(bad.isError, true);
  const errs = bad.data.errors.join("\n");
  assert.match(errs, /input 'customer_secret' isn't in Mynt's data dictionary/);
  assert.match(errs, /'monthly_income' isn't a property of output_schema/);
  assert.match(errs, /'shoe_size' isn't in Mynt's data dictionary/);
  assert.match(errs, /no licence type 'rbi_nbfc' in IN's regulatory model/);
  assert.match((await call(admin, "define_service_type", { service_type: { ...CKYC, region: "ZZ" } })).data.errors.join(), /No region 'ZZ'/);

  // The shipped examples: those naming licence types this model lacks are skipped until mapped.
  const firstLoad = await ok(admin, "load_service_types", { region: "IN" });
  assert.deepEqual(firstLoad.loaded.sort(), ["IN/bank_statement_analytics", "IN/digilocker_documents", "IN/emandate_registration", "IN/pan_verification"]);
  assert.deepEqual(firstLoad.skipped.map((s) => s.file).sort(), ["in/aa_data_fetch.json", "in/ckyc_search_download.json", "in/credit_bureau_report.json", "in/esign.json"]);
  assert.match(JSON.stringify(firstLoad.skipped), /no licence type 'rbi_nbfc'/);
  const mapped = await ok(admin, "load_service_types", { region: "IN", licence_map: { rbi_nbfc: "rbi_bank", rbi_cic: "rbi_pa", cca_esp: "rbi_pa" } });
  assert.equal(mapped.loaded.length, 8, JSON.stringify(mapped.skipped));
  assert.deepEqual((await ok(admin, "load_service_types", { region: "US" })).loaded.sort(), ["US/bank_account_verification", "US/credit_bureau_report", "US/identity_verification", "US/smart_contract_audit"]);
  await ok(admin, "define_service_type", { service_type: CKYC });
  const inTypes = await ok(vera, "list_service_types", { region: "IN" });
  const usTypes = await ok(vera, "list_service_types", { region: "US" });
  assert.equal(inTypes.length, 8);
  assert.equal(usTypes.length, 4); // with smart_contract_audit (the mainnet program gate's outside audit)
  assert.ok(!usTypes.some((t) => t.key === "ckyc_search_download"), "service types are per region");
  assert.deepEqual(inTypes.find((t) => t.key === "ckyc_search_download").vendor_licences, ["rbi_pa"]);
  assert.deepEqual((await ok(vera, "list_service_types", { category: "credit_bureau" })).map((t) => t.region).sort(), ["IN", "US"]);

  // ---- the vendor's firm, its licence and its offering ----
  const paLicence = await ok(vera, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: "PA-KYC-1" });
  const base = { region: "IN", service_type: "ckyc_search_download", name: "KYC Works CKYC", price: { amount: 3.5, currency: "INR" }, sla_notes: "99.9% monthly; p95 under 2 s" };
  for (const [url, why] of [
    ["http://8.8.8.8", /HTTPS only/],
    ["https://10.0.0.7", /private/],
    ["https://169.254.169.254", /link-local/],
  ])
    assert.match((await call(vera, "create_vendor_offering", { ...base, test_base_url: url })).data.error, why, url);
  const created = await ok(vera, "create_vendor_offering", { ...base, test_base_url: vendor.url, licence_ids: [paLicence.id], requires_credential: true });
  assert.equal(created.status, "draft");
  assert.match(created.conformance_signing_secret, /^mvs_/);
  vendor.state.secrets.add(created.conformance_signing_secret);
  const offeringId = created.id;
  assert.ok(!JSON.stringify(await ok(vera, "list_my_offerings")).includes(created.conformance_signing_secret), "the secret is shown once");
  assert.match((await call(vera, "update_vendor_offering", { offering_id: offeringId, listed: true })).data.error, /run_conformance/);

  // ---- Mynt's conformance test (the vendor never grades itself) ----
  assert.match((await call(vera, "run_conformance", { offering_id: offeringId })).data.error, /test_credential/);
  vendor.state.mode = "bad_output";
  const badRun = await ok(vera, "run_conformance", { offering_id: offeringId, test_credential: "test-cred" });
  assert.equal(badRun.passed, false);
  assert.match(badRun.cases.find((c) => c.case === "fixture_1").problems.join(" "), /output \/ckyc_number must be string/);
  vendor.state.mode = "slow";
  const slowRun = await ok(vera, "run_conformance", { offering_id: offeringId, test_credential: "test-cred" });
  assert.equal(slowRun.passed, false);
  assert.deepEqual(slowRun.cases.find((c) => c.case === "fixture_1").problems, ["timeout"]);
  // The licence named on the offering isn't verified yet, so even a working endpoint doesn't pass.
  vendor.state.mode = "ok";
  const unverified = await ok(vera, "run_conformance", { offering_id: offeringId, test_credential: "test-cred" });
  assert.equal(unverified.passed, false);
  assert.ok(unverified.cases.filter((c) => c.case !== "vendor_licences").every((c) => c.passed), JSON.stringify(unverified.cases));
  assert.match(unverified.licence_gap, /rbi_pa/);
  // A vendor that accepts a correctly signed but stale request (a replay) fails that case.
  vendor.state.acceptStale = true;
  const replayable = await ok(vera, "run_conformance", { offering_id: offeringId, test_credential: "test-cred" });
  assert.equal(replayable.cases.find((c) => c.case === "stale_timestamp_refused").passed, false);
  assert.match(replayable.cases.find((c) => c.case === "stale_timestamp_refused").problems[0], /more than 300 s ago/);
  vendor.state.acceptStale = false;
  await ok(admin, "review_license", { license_record_id: paLicence.id, decision: "verified", note: "On the register" });
  const passed = await ok(vera, "run_conformance", { offering_id: offeringId, test_credential: "test-cred" });
  assert.equal(passed.passed, true, JSON.stringify(passed.cases));
  assert.equal(passed.status, "conformance_passed");
  assert.deepEqual(passed.cases.map((c) => c.case), ["fixture_1", "bad_signature_refused", "stale_timestamp_refused"]);
  const conformanceCall = vendor.state.seen.at(-3);
  assert.equal(conformanceCall.path, "/v1/ckyc_search_download");
  assert.equal(conformanceCall.signed, true);
  assert.equal(conformanceCall.authorization, "Bearer test-cred");
  assert.deepEqual(conformanceCall.body.input, { pan: "ABCPV1234K" });
  assert.deepEqual(Object.keys(conformanceCall.body).sort(), ["consent", "environment", "input", "request_id"]);
  assert.equal(vendor.state.seen.at(-2).signed, false, "the bad-signature case really was badly signed");
  assert.equal(vendor.state.seen.at(-1).signed, false, "the stale case was refused for its timestamp");
  assert.equal((await ok(vera, "update_vendor_offering", { offering_id: offeringId, listed: true })).status, "listed");
  const opsAfter = JSON.parse((await admin.callTool({ name: "ops_status", arguments: {} })).content[0].text);
  assert.ok(opsAfter.attention.includes("vendors: 4 conformance run(s) failed in the last 24h"), JSON.stringify(opsAfter.attention));

  // An admin changing another firm's offering is audited as an admin action, naming the firm.
  await ok(admin, "update_vendor_offering", { offering_id: offeringId, sla_notes: "99.95% monthly" });
  const adminEdit = (await store.db.query("SELECT actor_id, details FROM financial_products.audit_log WHERE action = 'admin_update_vendor_offering'")).rows;
  assert.equal(adminEdit.length, 1);
  assert.equal(adminEdit[0].actor_id, w.adminUser.id);
  assert.equal(adminEdit[0].details.vendor_entity_id, firm.id);
  assert.deepEqual(adminEdit[0].details.fields, ["sla_notes"]);
  assert.equal((await store.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'update_vendor_offering'")).rows[0].n, 1, "the vendor's own edit stays a plain one");

  // ---- innovators: browse, and subscribe only with the licences the service needs ----
  const offers = await ok(innovator, "list_vendor_offerings", { region: "IN", category: "kyc" });
  assert.equal(offers.length, 1);
  assert.equal(offers[0].vendor, "KYC Works Pvt Ltd");
  assert.deepEqual(offers[0].price, { amount: 3.5, currency: "INR", per: "call" });
  assert.equal(offers[0].you_can_subscribe, true);
  assert.equal(offers[0].vendor_licences[0].license_id, "rbi_pa");
  assert.deepEqual(await ok(innovator, "list_vendor_offerings", { region: "US" }), []);

  const { user: ivan } = await store.createUser("Ivan", ["innovator"]);
  const ivanFirm = await store.createEntity(ivan.id, { name: "Ivan Fintech", registration_numbers: {}, regions: ["IN"] });
  await store.setUserEntity(ivan.id, ivanFirm.id);
  const ivanClient = await w.connect({ ...ivan, entity_id: ivanFirm.id });
  assert.equal((await ok(ivanClient, "list_vendor_offerings", { region: "IN" }))[0].you_can_subscribe, false);
  assert.match((await call(ivanClient, "subscribe_vendor_service", { offering_id: offeringId, test_credential: CREDENTIAL })).data.error, /needs your firm to hold a verified licence of one of: rbi_bank/);

  assert.match((await call(innovator, "subscribe_vendor_service", { offering_id: offeringId })).data.error, /requires a credential/);
  const sub = await ok(innovator, "subscribe_vendor_service", { offering_id: offeringId, test_credential: CREDENTIAL, credential_label: "KYC Works API key" });
  assert.equal(sub.live, false);
  assert.equal(sub.credentials.test.label, "KYC Works API key (test)");
  assert.equal(sub.credentials.live, null);
  assert.ok(!JSON.stringify(sub).includes(CREDENTIAL), "the credential isn't returned");
  assert.match((await call(innovator, "subscribe_vendor_service", { offering_id: offeringId, test_credential: CREDENTIAL })).data.error, /already subscribes/);
  const roster = (await ok(innovator, "get_my_entity")).parties;
  const vendorParty = roster.find((p) => p.id === sub.vendor_party_id);
  assert.equal(vendorParty.legal_entity_id, firm.id, "the vendor joined the roster");
  assert.equal(vendorParty.relationship, "vendor_service_agreement");
  const vaulted = (await store.db.query("SELECT type, sealed FROM financial_products.key_vault")).rows;
  assert.equal(vaulted.length, 1);
  assert.equal(vaulted[0].type, "vendor_test_credential");
  assert.ok(vaulted[0].sealed.startsWith("v1:") && !vaulted[0].sealed.includes(CREDENTIAL), "sealed at rest");

  // The vendor sees its new subscriber; listing never reveals the signing secret, revealing does, once, even
  // when asked twice at the same moment.
  const listed = await ok(vera, "list_my_subscribers");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].subscriber, "Ines Bank");
  assert.equal(listed[0].secret_revealed, false);
  assert.ok(!JSON.stringify(listed).includes("mvs_"));
  const [r1, r2] = await Promise.all([1, 2].map(() => call(vera, "reveal_subscription_secret", { subscription_id: sub.subscription_id })));
  assert.equal([r1, r2].filter((r) => !r.isError).length, 1, "exactly one reveal wins");
  const signingSecret = (r1.isError ? r2 : r1).data.signing_secret;
  assert.match(signingSecret, /^mvs_/);
  assert.match((r1.isError ? r1 : r2).data.error, /already revealed/);
  assert.equal((await ok(vera, "list_my_subscribers"))[0].secret_revealed, true);
  assert.equal((await call(innovator, "reveal_subscription_secret", { subscription_id: sub.subscription_id })).isError, true, "the subscriber itself never sees it");
  const subscribers = [{ signing_secret: signingSecret }];
  vendor.state.secrets = new Set([signingSecret]);

  // ---- the product: a handoff bound to the subscription ----
  const bind = (d, attrs = {}) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    d.partner_handoffs[0].sends = { type: "object", required: ["customer_ref", "amount", "bank_account_number", "ifsc"] };
    d.partner_handoffs.push({
      _id: "kyc_fetch",
      name: "Fetch the customer's KYC record",
      trigger: "account_opened",
      sends: { type: "object", required: ["pan", "full_name", "date_of_birth", "address"] },
      returns: { type: "object", required: ["ckyc_number"] },
    });
    d.connections.push(
      {
        _id: "h_kyc_party",
        type: "handoff_to_party",
        from: { kind: "partner_handoff", id: "kyc_fetch" },
        to: { kind: "party", id: sub.vendor_party_id },
        attributes: { sla: "PT1M", consent_purpose: "kyc_records_fetch", channel: "api", vendor_subscription_id: sub.subscription_id, service_type: "ckyc_search_download", ...attrs },
      },
      { _id: "h_kyc_serves", type: "handoff_serves_component", from: { kind: "partner_handoff", id: "kyc_fetch" }, to: { kind: "component", id: "deposit" } },
    );
    return d;
  };
  const { definitionFor } = await import("./v2-helpers.js");
  const probe = (attrs) => call(w.client, "check_product_definition", { definition: bind(definitionFor(w, "00000000-0000-4000-8000-000000000000"), attrs) });
  assert.match((await probe({ consent_purpose: "mandate_setup" })).data.errors.join("\n"), /consent_purpose must be 'kyc_records_fetch'/);
  assert.match((await probe({ vendor_subscription_id: "00000000-0000-4000-8000-000000000001" })).data.errors.join("\n"), /no active vendor subscription/);
  assert.match((await probe({ service_type: "credit_bureau_report" })).data.errors.join("\n"), /provides 'ckyc_search_download', not 'credit_bureau_report'/);
  await publishDefined(w, (d) => bind(d));
  const pinned = await store.getProduct("everyday-rd");
  assert.deepEqual(pinned.pins.vendor_bindings, [
    { handoff_id: "kyc_fetch", party_id: sub.vendor_party_id, subscription_id: sub.subscription_id, service_type: "ckyc_search_download", consent_purpose: "kyc_records_fetch" },
  ]);
  assert.ok(pinned.pins.state.parties[sub.vendor_party_id], "the vendor party is drift-checked like any other");
  assert.ok(pinned.pins.contract.consent_purposes.includes("kyc_records_fetch"));

  // ---- a developer's app: nothing vendor-specific ----
  await ok(w.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const dev = await w.connect(devUser);
  const app = await ok(dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] });
  const key = (await ok(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).key;
  const httpServer = createMcpHttpServer(store, null, { vendors: VENDOR_OPTS }, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS }).listen(0, "127.0.0.1");
  await new Promise((r) => httpServer.once("listening", r));
  servers.push({ close: () => (httpServer.closeAllConnections(), httpServer.close()) });
  const apiBase = `http://127.0.0.1:${httpServer.address().port}`;
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${apiBase}${path}`, { method, headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const session = async (customer_ref) => (await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["kyc_fetch", "mandate_setup"], customer_ref })).body.client_secret;
  const consent = (secret, subject) => api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "consent_given", subject });
  const prefill = (secret, source, fields) => api("POST", "/v1/client/prefill", secret, { product_id: "everyday-rd", source, fields });

  // Everything printed while Mynt handles the customer's data, to check nothing secret or personal leaks.
  const printed = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(original)) console[k] = (...a) => printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  const responses = [];
  try {
    const s = await session("cust_1");
    assert.equal((await prefill(s, "ckyc", ["full_name"])).body.error, "consent_required");
    await consent(s, "mandate_setup");
    const wrongPurpose = await prefill(s, "ckyc", ["full_name", "date_of_birth", "address"]);
    assert.equal(wrongPurpose.status, 409);
    assert.match(wrongPurpose.body.message, /Record consent 'kyc_records_fetch'/, "the service type's own purpose is needed");
    await consent(s, "kyc_records_fetch");
    // A busy app: another session's 1,100 newer evidence rows don't hide this session's grant.
    const busy = await session("cust_busy");
    const busyId = (await store.db.query("SELECT id FROM financial_products.client_sessions ORDER BY created_at DESC LIMIT 1")).rows[0].id;
    assert.ok(busy);
    await store.db.query(
      `INSERT INTO financial_products.client_evidence (id, app_id, session_id, product_id, contract_hash, type, subject, content_hash, customer_ref, sandbox)
       SELECT gen_random_uuid(), $1, $2, 'everyday-rd', NULL, 'consent_given', 'mandate_setup', NULL, NULL, true FROM generate_series(1, 1100)`,
      [app.id, busyId],
    );
    const noPan = await prefill(s, "ckyc", ["full_name", "date_of_birth", "address"]);
    assert.equal(noPan.body.error, "data_required");
    assert.match(noPan.body.message, /needs pan/);
    assert.equal((await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { pan: "ABCPV1234K" }, source: "secure_field" })).status, 201);

    const before = vendor.state.seen.length;
    const filled = await prefill(s, "ckyc", ["full_name", "date_of_birth", "address"]);
    responses.push(filled.text);
    assert.equal(filled.status, 201, filled.text);
    assert.deepEqual(filled.body, { filled: ["full_name", "date_of_birth", "address"], missing: [], sandbox: true });
    const sent = vendor.state.seen.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path, "/v1/ckyc_search_download", "the vendor's test endpoint");
    assert.equal(sent[0].signed, true, "signed with the subscription's secret");
    assert.equal(sent[0].authorization, `Bearer ${CREDENTIAL}`, "with the innovator's own credential");
    assert.equal(sent[0].body.environment, "test");
    assert.deepEqual(sent[0].body.input, { pan: "ABCPV1234K" }, "inputs come from the customer's vault");
    assert.equal(sent[0].body.consent.purpose, "kyc_records_fetch");
    assert.match(sent[0].body.consent.artefact_ref, /^[0-9a-f-]{36}$/, "the consent evidence id");
    const held = await api("GET", "/v1/client/fields", s);
    responses.push(held.text);
    assert.deepEqual(Object.fromEntries(held.body.fields.map((f) => [f.field, f.source])), { address: "ckyc", date_of_birth: "ckyc", full_name: "ckyc", pan: "secure_field" });

    // A vendor answer that breaks the output schema is refused, not saved.
    vendor.state.mode = "bad_output";
    const s2 = await session("cust_2");
    await consent(s2, "kyc_records_fetch");
    await api("POST", "/v1/client/fields", s2, { product_id: "everyday-rd", values: { pan: "ABCPV1234K" }, source: "secure_field" });
    const broken = await prefill(s2, "ckyc", ["full_name", "date_of_birth"]);
    responses.push(broken.text);
    assert.equal(broken.status, 502);
    assert.equal(broken.body.error, "vendor_error");
    assert.deepEqual((await api("GET", "/v1/client/fields", s2)).body.fields.map((f) => f.field), ["pan"]);
    vendor.state.mode = "ok";

    // A source with no vendor bound falls back to today's sandbox fixtures.
    const fallbackBefore = vendor.state.seen.length;
    const fixtures = await prefill(s2, "account_aggregator", ["bank_account_number", "ifsc"]);
    assert.deepEqual(fixtures.body, { filled: ["bank_account_number", "ifsc"], missing: [], sandbox: true });
    assert.equal(vendor.state.seen.length, fallbackBefore, "no vendor call");
  } finally {
    Object.assign(console, original);
  }
  for (const text of [...printed, ...responses]) {
    assert.ok(!text.includes(CREDENTIAL), "the credential never appears in responses or logs");
    assert.ok(!text.includes(subscribers[0].signing_secret), "nor the signing secret");
  }
  assert.ok(!printed.some((t) => t.includes("ABCPV1234K") || t.includes("Asha Verma")), `no customer data in logs: ${printed.join("\n")}`);
  const audit = JSON.stringify((await store.db.query("SELECT details FROM financial_products.audit_log")).rows);
  assert.ok(!audit.includes(CREDENTIAL) && !audit.includes("ABCPV1234K"));

  // ---- usage: counts only, for both sides ----
  const mine = await ok(innovator, "list_my_vendor_subscriptions");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].usage.calls, 2);
  assert.equal(mine[0].usage.errors, 1);
  assert.deepEqual(Object.keys(mine[0].usage.by_day[0]).sort(), ["day", "environment", "errors", "ok"]);
  assert.equal(mine[0].usage.by_day[0].environment, "test");
  const theirs = await ok(vera, "list_my_subscribers");
  assert.deepEqual(theirs[0].usage, mine[0].usage);

  // ---- rotation: the old secret stops verifying, the new one works ----
  const rotated = await ok(vera, "rotate_subscription_secret", { subscription_id: sub.subscription_id });
  assert.notEqual(rotated.signing_secret, signingSecret);
  const sr = await session("cust_rot");
  await consent(sr, "kyc_records_fetch");
  await api("POST", "/v1/client/fields", sr, { product_id: "everyday-rd", values: { pan: "ABCPV1234K" }, source: "secure_field" });
  assert.equal((await prefill(sr, "ckyc", ["full_name"])).body.error, "vendor_error", "the vendor still holds only the old secret");
  vendor.state.secrets = new Set([rotated.signing_secret]);
  assert.equal((await prefill(sr, "ckyc", ["full_name"])).status, 201);
  assert.equal((await call(vera, "reveal_subscription_secret", { subscription_id: sub.subscription_id })).isError, true, "a rotated secret was shown once already");

  // ---- live: its own endpoint and credential, licences re-checked at call time ----
  assert.match((await call(innovator, "set_subscription_live", { subscription_id: sub.subscription_id, live: true })).data.error, /hasn't given a live endpoint/);
  vendor.state.secrets.add(created.conformance_signing_secret);
  assert.equal((await ok(vera, "update_vendor_offering", { offering_id: offeringId, live_base_url: `${vendor.url}/live` })).status, "draft", "a new endpoint needs conformance again");
  assert.equal((await ok(vera, "run_conformance", { offering_id: offeringId, test_credential: "test-cred" })).passed, true);
  await ok(vera, "update_vendor_offering", { offering_id: offeringId, listed: true });
  assert.match((await call(innovator, "set_subscription_live", { subscription_id: sub.subscription_id, live: true })).data.error, /live_credential/);
  const live = await ok(innovator, "set_subscription_live", { subscription_id: sub.subscription_id, live: true, live_credential: LIVE_CREDENTIAL });
  assert.equal(live.live, true);
  assert.equal(live.credentials.live.label, "KYC Works CKYC (live)");
  assert.equal((await ok(dev, "check_experience", { app_id: app.id })).ready, true);
  await ok(dev, "publish_app", { app_id: app.id });
  const liveKey = (await ok(dev, "create_api_key", { app_id: app.id, environment: "live", label: "live" })).key;
  const liveSession = (await api("POST", "/v1/client_sessions", liveKey, { product_ids: ["everyday-rd"], scopes: ["kyc_fetch"], customer_ref: "cust_live" })).body.client_secret;
  await consent(liveSession, "kyc_records_fetch");
  await api("POST", "/v1/client/fields", liveSession, { product_id: "everyday-rd", values: { pan: "ABCPV1234K" }, source: "secure_field" });
  const liveBefore = vendor.state.seen.length;
  const liveFill = await prefill(liveSession, "ckyc", ["full_name", "date_of_birth"]);
  assert.equal(liveFill.status, 201, liveFill.text);
  assert.equal(liveFill.body.sandbox, false);
  const liveCall = vendor.state.seen.slice(liveBefore);
  assert.equal(liveCall.length, 1);
  assert.equal(liveCall[0].path, "/live/v1/ckyc_search_download", "the live endpoint");
  assert.equal(liveCall[0].authorization, `Bearer ${LIVE_CREDENTIAL}`, "with the live credential");
  assert.equal(liveCall[0].body.environment, "live");
  assert.ok(
    vendor.state.seen.filter((x) => !x.path.startsWith("/live/")).every((x) => x.authorization !== `Bearer ${LIVE_CREDENTIAL}`),
    "test calls never carry the live credential",
  );
  // The vendor's licence is suspended: products bound to it drift (and their innovators hear of it), and live calls stop.
  const lapsed = await ok(admin, "review_license", { license_record_id: paLicence.id, decision: "suspended", note: "Register shows it suspended" });
  assert.ok(lapsed.drifted_products.includes("everyday-rd"), JSON.stringify(lapsed));
  assert.equal((await store.getProduct("everyday-rd")).drift.changes[0].kind, "vendor");
  assert.match((await store.getProduct("everyday-rd")).drift.changes[0].now, /vendor_licences:gap/);
  const refusedLive = await prefill(liveSession, "ckyc", ["full_name"]);
  assert.equal(refusedLive.body.error, "vendor_unavailable");
  assert.match(refusedLive.body.message, /licence it needs isn't in force/);
  assert.equal((await store.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'product_drifted' AND target = 'everyday-rd'")).rows[0].n, 1);
  await ok(admin, "review_license", { license_record_id: paLicence.id, decision: "verified", note: "Restored" });
  assert.equal((await store.getProduct("everyday-rd")).drift, null, "drift clears once the licence is back");

  // ---- unsubscribing and suspension ----
  assert.match((await call(innovator, "unsubscribe_vendor_service", { subscription_id: sub.subscription_id })).data.error, /Live products hand off through it: everyday-rd/);
  const suspendedNow = await ok(admin, "suspend_vendor_offering", { offering_id: offeringId, note: "Under review" });
  assert.deepEqual(suspendedNow.drifted_products, ["everyday-rd"], "a suspension drifts the products bound to it");
  assert.match((await store.getProduct("everyday-rd")).drift.changes[0].now, /offering:suspended/);
  assert.deepEqual(await ok(innovator, "list_vendor_offerings", { region: "IN", category: "kyc" }), [], "a suspended offering isn't listed");
  const s3 = await session("cust_3");
  await consent(s3, "kyc_records_fetch");
  assert.equal((await prefill(s3, "ckyc", ["full_name"])).body.error, "vendor_unavailable");
});
