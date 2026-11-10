import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { sweepVendorActionRuns } from "../dist/vendors.js";
import { identityProblem, normName, pendingDeadline, pollRampAdapterTransfers } from "../dist/ramp-adapters/index.js";
import { bridgeAdapter, bridgeStatus } from "../dist/ramp-adapters/bridge.js";
import { createServer } from "../dist/server.js";
import { generateSdk } from "../dist/sdk.js";
import { publishDefined, setup } from "./v2-helpers.js";

// The Mynt Ramp through an adapter: the licensed partner keeps its own API (here a local fake of Bridge's, with
// only the documented endpoints), and Mynt answers its own wire contract in front of it. The adapter must pass
// Mynt's ramp conformance, quotes are Mynt's (Bridge has none that lock a price), and the device sees dollars only.
// No real network calls: the fake runs on 127.0.0.1.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
process.env.PUBLIC_URL ??= "https://mynt.test";
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 2000 };
const API_KEY = `sk-test-${randomBytes(12).toString("hex")}`;
const SETTLEMENT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const NAME = "Avery Stone";

const servers = [];
after(() => servers.forEach((s) => s.close()));
const listen = async (handler) => {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push({ close: () => (server.closeAllConnections(), server.close()) });
  return `http://127.0.0.1:${server.address().port}`;
};

// A fake of Bridge's API: Api-Key auth, Idempotency-Key on POST, transfers and their states.
async function fakeBridge() {
  const state = {
    calls: [],
    transfers: new Map(),
    byIdempotency: new Map(),
    n: 0,
    accounts: { cust_bridge_1: ["ea_bridge_1"], cust_other: ["ea_other"] },
    customers: { cust_bridge_1: { id: "cust_bridge_1", first_name: "Avery", last_name: "Stone" }, cust_other: { id: "cust_other", first_name: "Blake", last_name: "Doe" } },
  };
  const url = await listen(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const reply = (code, body) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const call = { method: req.method, path: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    state.calls.push(call);
    if (req.headers["api-key"] !== API_KEY) return reply(401, { code: "unauthorized", message: "bad key" });
    if (req.method === "GET" && req.url === "/v0/customers?limit=1") return reply(200, { count: 0, data: [] });
    if (req.method === "POST" && req.url === "/v0/transfers") {
      const key = req.headers["idempotency-key"];
      if (!key) return reply(400, { code: "invalid_parameters", message: "Idempotency-Key required" });
      if (state.nextTransferReply) {
        const r = state.nextTransferReply;
        state.nextTransferReply = null;
        return reply(r.code, r.body);
      }
      if (state.byIdempotency.has(key)) return reply(201, state.transfers.get(state.byIdempotency.get(key)));
      const b = call.body;
      if (!b.on_behalf_of || !b.source || !b.destination) return reply(400, { code: "invalid_parameters", message: "missing" });
      const id = `tr_${++state.n}`;
      const on = b.source.payment_rail === "ach_push";
      const t = {
        id,
        state: "awaiting_funds",
        amount: b.amount,
        currency: "usd",
        on_behalf_of: b.on_behalf_of,
        developer_fee: b.developer_fee,
        source: b.source,
        destination: b.destination,
        source_deposit_instructions: on
          ? { payment_rail: "ach_push", amount: b.amount, currency: "usd", deposit_message: "BRGDEPOSIT7Q2", bank_name: "Lead Bank", bank_routing_number: "101019644", bank_account_number: "215268129123" }
          : { payment_rail: "solana", amount: b.amount, currency: "usdc", to_address: "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT" },
        receipt: { initial_amount: b.amount, developer_fee: b.developer_fee, exchange_fee: "0.0", final_amount: b.amount },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.transfers.set(id, t);
      state.byIdempotency.set(key, id);
      return reply(201, t);
    }
    const acct = /^\/v0\/customers\/([a-z0-9_]+)\/external_accounts\/([a-z0-9_]+)$/.exec(req.url);
    if (req.method === "GET" && acct)
      return (state.accounts[acct[1]] ?? []).includes(acct[2]) ? reply(200, { id: acct[2], customer_id: acct[1], active: true, last_4: "6789" }) : reply(404, { code: "resource_not_found", message: "no" });
    const cust = /^\/v0\/customers\/([a-z0-9_]+)$/.exec(req.url);
    if (req.method === "GET" && cust) return state.customers[cust[1]] ? reply(200, state.customers[cust[1]]) : reply(404, { code: "resource_not_found", message: "no" });
    const one = /^\/v0\/transfers\/([a-z0-9_]+)$/.exec(req.url);
    // Bridge cancels only a transfer still awaiting funds.
    if (req.method === "DELETE" && one) {
      const t = state.transfers.get(one[1]);
      if (!t) return reply(404, { code: "resource_not_found", message: "no" });
      if (t.state !== "awaiting_funds") return reply(409, { code: "resource_state_conflict", message: "not cancellable" });
      t.state = "canceled";
      return reply(200, t);
    }
    if (req.method === "GET" && one) return state.transfers.has(one[1]) ? reply(200, state.transfers.get(one[1])) : reply(404, { code: "resource_not_found", message: "no" });
    reply(404, { code: "not_found", message: "no route" });
  });
  return { state, url };
}

test("Bridge's transfer states map to Mynt's", () => {
  for (const s of ["awaiting_funds", "funds_received", "payment_submitted", "in_review"]) assert.equal(bridgeStatus(s), "submitted");
  assert.equal(bridgeStatus("payment_processed"), "settled");
  for (const s of ["returned", "refunded", "refund_in_flight"]) assert.equal(bridgeStatus(s), "returned");
  for (const s of ["undeliverable", "canceled", "refund_failed"]) assert.equal(bridgeStatus(s), "failed");
  assert.equal(bridgeStatus("something_new"), null);
});

test("Bridge's sandbox and production stay apart, and pending windows count business days", () => {
  const ok = { test_base_url: "https://api.sandbox.bridge.xyz", live_base_url: "https://api.bridge.xyz", test_credential: "sk-test-1", live_credential: "sk-live-1" };
  assert.deepEqual(bridgeAdapter.environmentProblems(ok), []);
  const bad = bridgeAdapter.environmentProblems({ test_base_url: "https://api.bridge.xyz", live_base_url: "https://api.sandbox.bridge.xyz", test_credential: "sk-live-1", live_credential: "sk-test-1" });
  assert.equal(bad.length, 4, bad.join("\n"));
  // Friday + 1 business day is Monday; + 7 is the Tuesday after next.
  assert.equal(pendingDeadline(new Date("2026-11-06T12:00:00Z"), 1).toISOString().slice(0, 10), "2026-11-09");
  assert.equal(pendingDeadline(new Date("2026-11-06T12:00:00Z"), 7).toISOString().slice(0, 10), "2026-11-17");
});

test("a link's identity check: names in any script, never empty, and dates of birth in live", () => {
  assert.equal(normName("  José  NÚÑEZ "), "jose nunez");
  assert.equal(normName("王小明"), "王小明");
  assert.equal(normName("!!! 123"), "");
  assert.equal(identityProblem({ full_name: "José Núñez" }, { full_name: "jose nunez", date_of_birth: null }, "test"), null);
  assert.match(identityProblem({ full_name: "王小明" }, { full_name: "李四", date_of_birth: null }, "test"), /names don't match/, "non-Latin names are compared, not stripped to nothing");
  assert.match(identityProblem({ full_name: "王小明" }, { full_name: "", date_of_birth: null }, "test"), /no letters/);
  assert.match(identityProblem({ full_name: "123" }, { full_name: "456", date_of_birth: null }, "test"), /no letters/, "two empty names never match");
  assert.equal(identityProblem({ full_name: "王小明" }, { full_name: "王小明", date_of_birth: null }, "test"), null);
  assert.match(identityProblem({ full_name: "Avery Stone" }, { full_name: "Avery Stone", date_of_birth: null }, "live"), /date of birth/, "live needs both dates of birth");
  assert.match(identityProblem({ full_name: "Avery Stone", date_of_birth: "1990-01-02" }, { full_name: "Avery Stone", date_of_birth: "1990-01-03" }, "live"), /dates of birth don't match/);
  assert.equal(identityProblem({ full_name: "Avery Stone", date_of_birth: "1990-01-02" }, { full_name: "Avery Stone", date_of_birth: "1990-01-02" }, "live"), null);
});

test("the Mynt Ramp through the Bridge adapter: conformance, dollar quotes, accept, webhooks and status, dollars only", async () => {
  // Nothing written to the console during the run may carry the partner's credential.
  const logged = [];
  const orig = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(orig))
    console[k] = (...a) => {
      logged.push(a.map(String).join(" "));
      orig[k](...a);
    };
  after(() => Object.assign(console, orig));

  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "ramp-adapter", version: "0" });
    await client.connect(c);
    return client;
  };
  const toolTexts = [];
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    toolTexts.push(JSON.stringify(r.data));
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const admin = await connect(adminUser);
  const innovator = await connect(ctx.user);
  const bridge = await fakeBridge();
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const PEM = publicKey.export({ type: "spki", format: "pem" });

  const srv = createMcpHttpServer(store, null, { vendors: VENDOR_OPTS }, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  servers.push({ close: () => (srv.closeAllConnections(), srv.close()) });
  const base = `http://127.0.0.1:${srv.address().port}`;

  const grc = {
    registers: { obligations: [], reporting_disclosure_filings: [], risks: [], controls: [], inspection_events: [] },
    repositories: { regulatory_communications: [], enforcement_actions: [], press_releases: [], policies: [], risk_models: [], inspection_history: [] },
    allowed_product_types: [],
    allowed_customer_segments: [],
    mandatory_stakeholders: { internal: [], external: [] },
  };
  await ok(admin, "define_regulator", {
    region: "US",
    regulator: { id: "fincen", name: "Financial Crimes Enforcement Network", short_name: "FinCEN", scope: { product_types: [], customer_personas: [] }, license_types: [{ _id: "fincen_msb", name: "Money services business", grc }] },
  });
  const KEYS = ["onramp_quote", "onramp_transfer", "offramp_quote", "offramp_transfer"];
  await ok(admin, "load_service_types", { region: "US" });

  // ---- the ramp partner's firm, designated; its offerings answered through the Bridge adapter ----
  await ok(admin, "invite_user", { email: "ops@bridge.example", roles: ["vendor"] });
  const firm = await ok(admin, "register_firm", { name: "Bridge", legal_form: "company_private", incorporation: { country: "us" }, regions: ["US"] });
  const vu = await store.upsertClerkUser("clerk_bridge", "ops@bridge.example", "Bridge ops", (await store.getInvite("ops@bridge.example")).roles);
  await ok(admin, "add_entity_member", { email: "ops@bridge.example", entity_id: firm.id });
  const partner = await connect(vu);
  const lic = await ok(partner, "register_license", { region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "MSB-2" });
  await ok(admin, "review_license", { license_record_id: lic.id, decision: "verified", note: "ok" });
  await ok(admin, "set_mynt_ramp", { entity_id: firm.id });
  const offerings = {};
  for (const key of KEYS) {
    const o = await ok(partner, "create_vendor_offering", { region: "US", service_type: key, name: `Mynt Ramp ${key}`, price: { amount: 0, currency: "USD" }, test_base_url: bridge.url, licence_ids: [lic.id] });
    offerings[key] = o.id;
  }

  // Settings are checked; the credential is sealed and never shown again.
  const bad = await call(partner, "set_ramp_adapter", { offering_id: offerings.onramp_quote, adapter: "bridge", config: { settlement_address: "0xnot-solana", colour: "red" }, test_credential: API_KEY });
  assert.equal(bad.isError, true);
  assert.match(JSON.stringify(bad.data), /settlement_address: a Solana address/);
  assert.match(JSON.stringify(bad.data), /'colour' isn't a setting/);
  const config = { settlement_address: SETTLEMENT, quote_seconds: "120", test_webhook_public_key: PEM };
  for (const key of KEYS) {
    const set = await ok(partner, "set_ramp_adapter", { offering_id: offerings[key], adapter: "bridge", config, test_credential: API_KEY });
    assert.equal(set.status, "draft");
    assert.ok(set.credentials.test.key_id);
    assert.match(set.webhook_urls.test, new RegExp(`/v1/ramp-adapters/${offerings[key]}/webhook/test$`));
  }

  // ---- Mynt's own conformance, against the adapter in front of the fake ----
  for (const key of KEYS) {
    const run = await ok(partner, "run_conformance", { offering_id: offerings[key] });
    assert.equal(run.passed, true, `${key}: ${JSON.stringify(run.cases)}`);
    assert.deepEqual(run.cases.map((c) => c.case), ["fixture_1", "bad_signature_refused", "stale_timestamp_refused"]);
    await ok(partner, "update_vendor_offering", { offering_id: offerings[key], listed: true });
  }
  assert.ok(bridge.state.calls.some((c) => c.path === "/v0/customers?limit=1" && c.headers["api-key"] === API_KEY), "conformance probes the partner with the credential");
  assert.ok(!bridge.state.calls.some((c) => c.method === "POST"), "conformance moves no money");

  // A wrong credential fails conformance (the partner refuses it), and the offering goes back to draft.
  const spare = await ok(partner, "create_vendor_offering", { region: "US", service_type: "onramp_quote", name: "spare", price: { amount: 0, currency: "USD" }, test_base_url: bridge.url, licence_ids: [lic.id] });
  await ok(partner, "set_ramp_adapter", { offering_id: spare.id, adapter: "bridge", config, test_credential: "sk-test-wrong" });
  const refused = await ok(partner, "run_conformance", { offering_id: spare.id });
  assert.equal(refused.passed, false);
  assert.match(JSON.stringify(refused.cases[0].problems), /error/);
  // A production key for the test environment, or a sandbox key for live, is refused.
  assert.match(JSON.stringify((await call(partner, "set_ramp_adapter", { offering_id: spare.id, adapter: "bridge", config, test_credential: "sk-live-abc" })).data), /looks like a production key/);
  assert.match(JSON.stringify((await call(partner, "set_ramp_adapter", { offering_id: spare.id, adapter: "bridge", config, live_credential: "sk-test-abc" })).data), /sandbox key/);
  // With both credentials set, conformance probes both: a live key the partner refuses fails it.
  const spare2 = await ok(partner, "create_vendor_offering", { region: "US", service_type: "onramp_quote", name: "spare2", price: { amount: 0, currency: "USD" }, test_base_url: bridge.url, live_base_url: (await fakeBridge()).url, licence_ids: [lic.id] });
  await ok(partner, "set_ramp_adapter", { offering_id: spare2.id, adapter: "bridge", config, test_credential: API_KEY, live_credential: "sk-live-wrong" });
  const liveRefused = await ok(partner, "run_conformance", { offering_id: spare2.id });
  assert.equal(liveRefused.passed, false);
  assert.match(JSON.stringify(liveRefused.cases[0].problems), /error/);

  // ---- a product with both ramps, a developer's app and a customer's device ----
  const subs = {};
  for (const key of KEYS) subs[key] = await ok(innovator, "subscribe_vendor_service", { offering_id: offerings[key] });
  const types = Object.fromEntries((await ok(admin, "list_service_types", { region: "US" })).map((t) => [t.key, t]));
  const SENDS = ["full_name", "bank_account_number", "routing_number"];
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    for (const key of KEYS) {
      d.partner_handoffs.push({ _id: key, name: key, trigger: "account_opened", sends: { type: "object", required: SENDS }, returns: { type: "object", required: ["status"] } });
      d.connections.push(
        {
          _id: `h_${key}`,
          type: "handoff_to_party",
          from: { kind: "partner_handoff", id: key },
          to: { kind: "party", id: subs[key].vendor_party_id },
          attributes: { sla: "PT1M", consent_purpose: types[key].consent_purpose, channel: "api", vendor_subscription_id: subs[key].subscription_id, service_type: key },
        },
        { _id: `s_${key}`, type: "handoff_serves_component", from: { kind: "partner_handoff", id: key }, to: { kind: "component", id: "deposit" } },
      );
    }
    return d;
  });
  const contract = (await store.getProduct("everyday-rd")).pins.contract;
  assert.doesNotMatch(JSON.stringify(contract), new RegExp(`${API_KEY}|${SETTLEMENT}|bridge`, "i"), "the contract names neither the partner, its key nor the settlement address");
  await ok(ctx.client, "set_product_access", { id: "everyday-rd", access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: "https://bank.example.com/start" } });
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = await ok(dev, "create_app", { name: "Dollars", description: "Add and cash out dollars", audience: "Savers", product_ids: ["everyday-rd"] });
  const appKey = (await ok(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).key;
  const sink = await listen((req, res) => res.writeHead(200).end("{}"));
  await ok(innovator, "create_firm_webhook", { url: `${sink}/firm` });
  await ok(dev, "create_webhook", { app_id: app.id, url: `${sink}/app`, events: ["handoff.reversed"] });
  const queued = async () => (await store.db.query("SELECT type FROM financial_products.webhook_deliveries")).rows.map((r) => r.type);
  const seenByDevice = [];
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    seenByDevice.push(text);
    return { status: res.status, body: JSON.parse(text), text };
  };
  const sess = await api("POST", "/v1/client_sessions", appKey, { product_ids: ["everyday-rd"], scopes: KEYS, customer_ref: "cust_b1" });
  assert.equal(sess.status, 201, sess.text);
  const device = sess.body.client_secret;
  const P = "everyday-rd";
  for (const purpose of ["fiat_onramp", "fiat_offramp"]) assert.equal((await api("POST", "/v1/client/evidence", device, { product_id: P, type: "consent_given", subject: purpose })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { full_name: NAME, routing_number: "021000021" } })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { bank_account_number: "000123456789" }, source: "secure_field" })).status, 201);
  const start = (action, extra) => api("POST", `/v1/client/actions/${action}`, device, { product_id: P, ...extra });
  const run = (reference) => api("GET", `/v1/client/action_runs/${reference}`, device);

  // ---- a quote is Mynt's: dollars, a fee, a total and a validity Mynt sets ----
  const q1 = await start("onramp_quote", { params: { direction: "in", amount_usd: "100.00" } });
  assert.equal(q1.status, 201, q1.text);
  assert.deepEqual(
    { amount: q1.body.amount_usd, fee: q1.body.fee_usd, total: q1.body.total_usd, currency: q1.body.currency },
    { amount: "100.00", fee: "0.50", total: "99.50", currency: "USD" },
  );
  const validity = Date.parse(q1.body.expires_at) - Date.now();
  assert.ok(validity > 100_000 && validity <= 120_000, `quote_seconds sets the validity (${validity} ms)`);
  assert.ok(!q1.text.includes("maq."), "the device never sees the quote id");
  assert.equal((await start("onramp_quote", { params: { direction: "in", amount_usd: "20000.00" } })).body.error, "vendor_error", "above max_usd");
  assert.equal((await start("onramp_quote", { params: { direction: "in", amount_usd: "0.99" } })).body.error, "vendor_error", "below min_usd");
  // Cash-out isn't available until the USDC leg into Bridge exists: no price, no transfer.
  assert.equal((await start("offramp_quote", { params: { direction: "out", amount_usd: "250.00" } })).body.error, "vendor_error");

  // Before the ramp firm links the customer to the partner, a transfer can't start; the quote stays usable.
  const early = await start("onramp_transfer", { quote: q1.body.reference });
  assert.equal(early.status, 502, early.text);
  assert.equal(early.body.error, "vendor_error");
  assert.ok(!bridge.state.calls.some((c) => c.method === "POST"));
  // ---- linking: the customer asks from their own session, with the ramp's consent; the ramp firm sees only an id ----
  const otherSess = await api("POST", "/v1/client_sessions", appKey, { product_ids: ["everyday-rd"], scopes: KEYS, customer_ref: "cust_b2" });
  const noConsent = await api("POST", "/v1/client/ramp_links", otherSess.body.client_secret, { product_id: P });
  assert.equal(noConsent.status, 409, noConsent.text);
  assert.equal(noConsent.body.error, "consent_required");
  const ask = async () => {
    const r = await api("POST", "/v1/client/ramp_links", device, { product_id: P });
    assert.equal(r.status, 201, r.text);
    return r.body.link_reference;
  };
  const firstAsk = await ask();
  // The partner's customer isn't this one: refused, and that request is spent.
  const wrong = await call(partner, "link_ramp_partner_customer", { link_reference: firstAsk, partner_customer_id: "cust_other", partner_payout_account_id: "ea_x" });
  assert.equal(wrong.isError, true);
  assert.equal(wrong.data.refusal, "identity_mismatch");
  assert.equal((await call(partner, "link_ramp_partner_customer", { link_reference: firstAsk, partner_customer_id: "cust_bridge_1" })).isError, true);
  assert.equal((await start("onramp_transfer", { quote: q1.body.reference })).status, 502, "no transfer on an unverified link");
  // A payout account that isn't that partner customer's own is refused.
  const notTheirs = await call(partner, "link_ramp_partner_customer", { link_reference: await ask(), partner_customer_id: "cust_bridge_1", partner_payout_account_id: "ea_other" });
  assert.equal(notTheirs.data.refusal, "payout_account_mismatch", JSON.stringify(notTheirs.data));
  const linked = await ok(partner, "link_ramp_partner_customer", { link_reference: await ask(), partner_customer_id: "cust_bridge_1", partner_payout_account_id: "ea_bridge_1" });
  assert.equal(linked.identity, "verified");
  assert.ok(!JSON.stringify(linked).includes("cust_b1"), "the ramp firm never sees the customer reference");
  const links = (await store.db.query("SELECT customer_key, identity_verified_at FROM financial_products.ramp_partner_links")).rows;
  assert.ok(links.length === 1 && !links[0].customer_key.includes("cust_b1") && links[0].identity_verified_at, "filed under a pseudonymous key, verified");
  // Two completions of one request at once: exactly one goes through.
  const race = await ask();
  const both = await Promise.all([0, 1].map(() => call(partner, "link_ramp_partner_customer", { link_reference: race, partner_customer_id: "cust_bridge_1", partner_payout_account_id: "ea_bridge_1" })));
  assert.deepEqual(both.map((r) => r.isError).sort(), [false, true]);
  // A request the ramp firm leaves too long expires.
  const stale = await ask();
  await store.db.query("UPDATE financial_products.ramp_link_requests SET created_at = now() - interval '8 days' WHERE id = $1", [stale]);
  assert.equal((await call(partner, "link_ramp_partner_customer", { link_reference: stale, partner_customer_id: "cust_bridge_1" })).data.refusal, "expired");
  // Five requests an hour per session (the stale one, moved back 8 days, no longer counts).
  await ask();
  const limited = await api("POST", "/v1/client/ramp_links", device, { product_id: P });
  assert.equal(limited.status, 429, limited.text);
  // One partner customer is one Mynt customer: another customer can't be linked to cust_bridge_1.
  const os = otherSess.body.client_secret;
  assert.equal((await api("POST", "/v1/client/evidence", os, { product_id: P, type: "consent_given", subject: "fiat_onramp" })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", os, { product_id: P, values: { full_name: NAME } })).status, 201);
  const otherAsk = await api("POST", "/v1/client/ramp_links", os, { product_id: P });
  assert.equal(otherAsk.status, 201, otherAsk.text);
  assert.equal((await call(partner, "link_ramp_partner_customer", { link_reference: otherAsk.body.link_reference, partner_customer_id: "cust_bridge_1" })).data.refusal, "partner_customer_already_linked");

  // ---- add dollars: the customer pushes $100 to the deposit account; the USDC goes to the ramp's address ----
  const t1 = await start("onramp_transfer", { quote: q1.body.reference });
  assert.equal(t1.status, 201, t1.text);
  assert.equal(t1.body.status, "pending");
  assert.deepEqual(
    [t1.body.transfer_status, t1.body.pay_to_bank_name, t1.body.pay_to_account_number, t1.body.pay_to_routing_number, t1.body.pay_to_reference, t1.body.pay_to_status],
    ["submitted", "Lead Bank", "215268129123", "101019644", "BRGDEPOSIT7Q2", "active"],
  );
  const post1 = bridge.state.calls.filter((c) => c.method === "POST" && c.path === "/v0/transfers");
  assert.equal(post1.length, 1);
  assert.deepEqual(post1[0].body, {
    on_behalf_of: "cust_bridge_1",
    amount: "100.00",
    developer_fee: "0.50",
    source: { payment_rail: "ach_push", currency: "usd" },
    destination: { payment_rail: "solana", currency: "usdc", to_address: SETTLEMENT },
  });
  assert.match(post1[0].headers["idempotency-key"], /^[0-9a-f]{48}$/);
  assert.equal(post1[0].headers.authorization, undefined, "the credential goes only as Api-Key");
  assert.equal((await start("onramp_transfer", { quote: q1.body.reference })).body.error, "quote_used");

  // Bridge's webhook: signed with its key, it settles the run; a forged or stale one is refused.
  const hook = (offering, transfer, { key = privateKey, t = Date.now(), eventId = `wh_${randomBytes(4).toString("hex")}` } = {}) => {
    const raw = JSON.stringify({ api_version: "v0", event_id: eventId, event_category: "transfer", event_type: "transfer.updated.status_transitioned", event_object: transfer });
    const digest = createHash("sha256").update(`${t}.${raw}`).digest();
    const sig = sign("sha256", digest, key).toString("base64");
    return fetch(`${base}/v1/ramp-adapters/${offering}/webhook/test`, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Signature": `t=${t},v0=${sig}` }, body: raw });
  };
  const tr1 = bridge.state.transfers.get("tr_1");
  // Bridge reports what it actually delivered (its own fees off): Mynt shows that, never an assumed 1:1.
  Object.assign(tr1, { state: "payment_processed", receipt: { ...tr1.receipt, final_amount: "99.40", destination_tx_hash: "5VERYLongSolanaSignature1111111111111111111111111111111111111111" } });
  const { privateKey: other } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.equal((await hook(offerings.onramp_transfer, tr1, { key: other })).status, 400, "a forged webhook is refused");
  assert.equal((await hook(offerings.onramp_transfer, tr1, { t: Date.now() - 11 * 60 * 1000 })).status, 400, "a stale webhook is refused");
  assert.equal((await run(t1.body.reference)).body.status, "pending");
  const delivered = await hook(offerings.onramp_transfer, tr1, { eventId: "wh_settle_1" });
  assert.equal(delivered.status, 200, await delivered.text());
  const done1 = await run(t1.body.reference);
  assert.deepEqual([done1.body.status, done1.body.transfer_status, done1.body.total_usd], ["completed", "settled", "99.40"]);
  const again = await hook(offerings.onramp_transfer, tr1, { eventId: "wh_settle_1" });
  assert.equal((await again.json()).duplicate, true, "a redelivered event (same event id) is applied once");
  // An earlier state arriving late doesn't move it back.
  assert.equal((await hook(offerings.onramp_transfer, { ...tr1, state: "awaiting_funds" })).status, 200);
  assert.equal((await run(t1.body.reference)).body.status, "completed");

  // The innovator gets the full result, partner-side fields included (sealed), the device never does.
  const sealed = (await store.db.query("SELECT result_sealed FROM financial_products.vendor_action_runs WHERE id = $1", [t1.body.reference])).rows[0].result_sealed;
  assert.ok(sealed && !sealed.includes("5VERYLong"), "the full result is sealed");

  // ---- the bank sends a settled payment back: the one change after the end ----
  assert.equal((await hook(offerings.onramp_transfer, { ...tr1, state: "returned" })).status, 200);
  const rev = await run(t1.body.reference);
  assert.deepEqual([rev.body.status, rev.body.transfer_status, rev.body.reversed], ["failed", "returned", true]);
  assert.equal((await store.db.query("SELECT status FROM financial_products.vendor_action_runs WHERE id = $1", [t1.body.reference])).rows[0].status, "reversed");
  assert.ok((await queued()).includes("vendor_action.reversed"), "the innovator is told, with the sealed details");
  assert.ok((await queued()).includes("handoff.reversed"), "the app is told, without data");
  assert.equal((await hook(offerings.onramp_transfer, { ...tr1, state: "payment_processed" })).status, 200);
  assert.equal((await run(t1.body.reference)).body.status, "failed", "nothing moves it after the reversal");

  // ---- cash-out in the test environment only (test_offramp), once enabled ----
  for (const key of ["offramp_quote", "offramp_transfer"]) {
    await ok(partner, "set_ramp_adapter", { offering_id: offerings[key], adapter: "bridge", config: { ...config, test_offramp: "true" } });
    assert.equal((await ok(partner, "run_conformance", { offering_id: offerings[key] })).passed, true);
    await ok(partner, "update_vendor_offering", { offering_id: offerings[key], listed: true });
  }

  // ---- cash out: $250 to the payout account; $251.25 of USDC leaves the ramp's address ----
  const q2 = await start("offramp_quote", { params: { direction: "out", amount_usd: "250.00" } });
  assert.deepEqual([q2.body.amount_usd, q2.body.fee_usd, q2.body.total_usd], ["250.00", "1.25", "251.25"]);
  const t2 = await start("offramp_transfer", { quote: q2.body.reference });
  assert.equal(t2.status, 201, t2.text);
  assert.equal(t2.body.transfer_status, "submitted");
  const post2 = bridge.state.calls.filter((c) => c.method === "POST" && c.path === "/v0/transfers").at(-1);
  assert.deepEqual(post2.body, {
    on_behalf_of: "cust_bridge_1",
    amount: "251.25",
    developer_fee: "1.25",
    source: { payment_rail: "solana", currency: "usdc", from_address: SETTLEMENT },
    destination: { payment_rail: "ach", currency: "usd", external_account_id: "ea_bridge_1" },
  });
  // Where the USDC goes is kept partner-side by the adapter.
  const kept = (await store.db.query("SELECT partner_side FROM financial_products.ramp_adapter_transfers WHERE partner_transfer_id = 'tr_2'")).rows[0].partner_side;
  assert.equal(kept.deposit_to, "9wFFyRfZBsuAha4YcuxcXLKwMxJR43S7fPfQLusDBzvT");
  // No webhook comes: Mynt reads the state back. The bank sent the payment back.
  bridge.state.transfers.get("tr_2").state = "returned";
  assert.equal(await pollRampAdapterTransfers(store, VENDOR_OPTS, { olderThanSeconds: 0 }), 1);
  const done2 = await run(t2.body.reference);
  assert.deepEqual([done2.body.status, done2.body.transfer_status], ["failed", "returned"]);

  // ---- a transfer Bridge can't deliver fails ----
  const q3 = await start("onramp_quote", { params: { direction: "in", amount_usd: "40.00" } });
  const t3 = await start("onramp_transfer", { quote: q3.body.reference });
  const tr3 = bridge.state.transfers.get("tr_3");
  tr3.state = "undeliverable";
  assert.equal((await hook(offerings.onramp_transfer, tr3)).status, 200);
  const done3 = await run(t3.body.reference);
  assert.deepEqual([done3.body.status, done3.body.transfer_status], ["failed", "failed"]);
  // Still open while Bridge says so.
  const q4 = await start("onramp_quote", { params: { direction: "in", amount_usd: "41.00" } });
  const t4 = await start("onramp_transfer", { quote: q4.body.reference });
  bridge.state.transfers.get("tr_4").state = "funds_received";
  assert.equal(await pollRampAdapterTransfers(store, VENDOR_OPTS, { olderThanSeconds: 0 }), 0);
  assert.equal((await run(t4.body.reference)).body.status, "pending");

  // ---- the customer never pays: the transfer waits business days, not the 24 hours other actions get ----
  const q5 = await start("onramp_quote", { params: { direction: "in", amount_usd: "42.00" } });
  const t5 = await start("onramp_transfer", { quote: q5.body.reference });
  const days = (n) => new Date(Date.now() + n * 86_400_000);
  await sweepVendorActionRuns(store, { now: days(3) });
  assert.equal((await run(t5.body.reference)).body.status, "pending", "the 24-hour sweep leaves ramp transfers to their own window");
  assert.equal(await pollRampAdapterTransfers(store, VENDOR_OPTS, { olderThanSeconds: 0, now: days(2) }), 0);
  assert.equal((await run(t5.body.reference)).body.status, "pending");
  // Past 7 business days: voided at Bridge, and the customer told the payment instructions are void.
  await pollRampAdapterTransfers(store, VENDOR_OPTS, { olderThanSeconds: 0, now: days(12) });
  assert.ok(bridge.state.calls.some((c) => c.method === "DELETE" && c.path === "/v0/transfers/tr_5"));
  const void5 = await run(t5.body.reference);
  assert.deepEqual([void5.body.status, void5.body.transfer_status, void5.body.pay_to_status], ["failed", "failed", "void"], "void only because Bridge confirmed it");
  const detailOf = async (q) => (await store.db.query("SELECT status, status_detail FROM financial_products.money_movements WHERE idempotency_key = $1", [`quote:${q.body.reference}`])).rows[0];
  assert.deepEqual(await detailOf(q5), { status: "failed", status_detail: "partner_failed" }, "the partner did void it");
  // tr_4 had its money arrive (funds_received): Bridge won't cancel it, so it keeps waiting, up to the hard stop.
  assert.equal((await run(t4.body.reference)).body.status, "pending");
  await pollRampAdapterTransfers(store, VENDOR_OPTS, { olderThanSeconds: 0, now: days(60) });
  const stop4 = await run(t4.body.reference);
  assert.deepEqual([stop4.body.status, stop4.body.pay_to_status], ["failed", "unknown"], "Bridge never confirmed a void: unknown, not void");
  assert.deepEqual(await detailOf(q4), { status: "failed", status_detail: "mynt_gave_up" }, "Mynt's decision, not the partner's answer");
  // Then the money lands anyway: recorded, and the innovator is told to handle it; never dropped.
  const tr4 = bridge.state.transfers.get("tr_4");
  tr4.state = "payment_processed";
  assert.equal((await hook(offerings.onramp_transfer, tr4)).status, 200);
  assert.ok((await queued()).includes("vendor_action.late_settlement"));
  const late = (await store.db.query("SELECT late_result_sealed FROM financial_products.vendor_action_runs WHERE id = $1", [t4.body.reference])).rows[0];
  assert.ok(late.late_result_sealed, "the late result is kept, sealed");
  assert.equal((await store.db.query("SELECT status FROM financial_products.ramp_adapter_transfers WHERE partner_transfer_id = 'tr_4'")).rows[0].status, "settled_late");
  assert.equal((await run(t4.body.reference)).body.status, "failed", "the device's answer doesn't change");
  assert.deepEqual(await detailOf(q4), { status: "settled", status_detail: "late_settlement" }, "and the ledger hears that the money moved");

  // ---- cash-out amounts: total_usd is what the customer is charged, paid_out_usd what reached their bank ----
  const q6 = await start("offramp_quote", { params: { direction: "out", amount_usd: "250.00" } });
  const t6 = await start("offramp_transfer", { quote: q6.body.reference });
  const tr6 = bridge.state.transfers.get(`tr_${bridge.state.n}`);
  Object.assign(tr6, { state: "payment_processed", receipt: { ...tr6.receipt, initial_amount: "251.25", final_amount: "249.90" } });
  assert.equal((await hook(offerings.offramp_transfer, tr6)).status, 200);
  const done6 = await run(t6.body.reference);
  assert.deepEqual([done6.body.status, done6.body.total_usd, done6.body.paid_out_usd], ["completed", "251.25", "249.90"]);

  // ---- a row left settled while its run never ended (an attempt stopped part-way) is finished, not ignored ----
  const q7 = await start("onramp_quote", { params: { direction: "in", amount_usd: "43.00" } });
  const t7 = await start("onramp_transfer", { quote: q7.body.reference });
  const tr7 = bridge.state.transfers.get(`tr_${bridge.state.n}`);
  await store.db.query("UPDATE financial_products.ramp_adapter_transfers SET status = 'settled' WHERE partner_transfer_id = $1", [tr7.id]);
  tr7.state = "payment_processed";
  assert.equal((await hook(offerings.onramp_transfer, tr7)).status, 200);
  assert.equal((await run(t7.body.reference)).body.status, "completed");
  // ... and one whose run already ended another way becomes a late settlement, once.
  const q8 = await start("onramp_quote", { params: { direction: "in", amount_usd: "44.00" } });
  const t8 = await start("onramp_transfer", { quote: q8.body.reference });
  const tr8 = bridge.state.transfers.get(`tr_${bridge.state.n}`);
  await store.db.query("UPDATE financial_products.ramp_adapter_transfers SET status = 'settled' WHERE partner_transfer_id = $1", [tr8.id]);
  await store.db.query("UPDATE financial_products.vendor_action_runs SET status = 'expired' WHERE id = $1", [t8.body.reference]);
  tr8.state = "payment_processed";
  const lateBefore = (await queued()).filter((t) => t === "vendor_action.late_settlement").length;
  assert.equal((await hook(offerings.onramp_transfer, tr8)).status, 200);
  assert.equal((await hook(offerings.onramp_transfer, tr8)).status, 200);
  assert.equal((await queued()).filter((t) => t === "vendor_action.late_settlement").length, lateBefore + 1, "told once");
  assert.ok((await store.db.query("SELECT late_result_sealed FROM financial_products.vendor_action_runs WHERE id = $1", [t8.body.reference])).rows[0].late_result_sealed);

  // ---- what the partner says about money, in the ledger ----
  const movement = async (quoteRef) => (await store.db.query("SELECT * FROM financial_products.money_movements WHERE idempotency_key = $1", [`quote:${quoteRef}`])).rows[0];
  assert.equal((await movement(q8.body.reference)).status, "settled", "a run that ended another way doesn't stop the ledger hearing of the money");
  assert.equal((await movement(q2.body.reference)).status, "failed", "returned before it settled, by the poller");
  assert.equal((await movement(q3.body.reference)).status, "failed", "undeliverable, by webhook");
  // A session of its own: this test's first has used up its allowance of requests by now on a fast machine.
  const second = (await api("POST", "/v1/client_sessions", appKey, { product_ids: ["everyday-rd"], scopes: KEYS, customer_ref: "cust_b1" })).body.client_secret;
  assert.equal((await api("POST", "/v1/client/evidence", second, { product_id: P, type: "consent_given", subject: "fiat_onramp" })).status, 201);
  const startAgain = (action, extra) => api("POST", `/v1/client/actions/${action}`, second, { product_id: P, ...extra });
  const refusedWith = async (amount, reply) => {
    const q = await startAgain("onramp_quote", { params: { direction: "in", amount_usd: amount } });
    bridge.state.nextTransferReply = reply;
    const t = await startAgain("onramp_transfer", { quote: q.body.reference });
    assert.equal(t.status, 502, t.text);
    return movement(q.body.reference);
  };
  // A 5xx, even with a code, a rate limit and a code Mynt doesn't know: it may have moved, so it stays open and counted.
  for (const [amount, reply, code] of [
    ["50.00", { code: 500, body: { code: "internal_server_error" } }, "partner_internal_server_error"],
    ["51.00", { code: 429, body: { code: "rate_limited" } }, "partner_rate_limited"],
    ["52.00", { code: 400, body: { code: "something_new" } }, "partner_something_new"],
  ]) {
    const m = await refusedWith(amount, reply);
    assert.equal(m.status, "requested", code);
    assert.equal(m.status_detail, `outcome_unknown:${code}`);
  }
  // A clear refusal from the allowlist means nothing moved, but not if a server error sits behind it.
  const clearRefusal = await refusedWith("53.00", { code: 400, body: { code: "requires_active_kyc_status" } });
  assert.equal(clearRefusal.status, "failed");
  assert.equal(clearRefusal.status_detail, "vendor_error");
  assert.equal((await refusedWith("54.00", { code: 503, body: { code: "requires_active_kyc_status" } })).status, "requested", "any 5xx is unknown");
  // A 2xx whose state Mynt can't read, with an id: unknown, and the transfer is kept, so its later webhook lands.
  const odd = await refusedWith("55.00", { code: 201, body: { id: "tr_odd", state: "brand_new_state" } });
  assert.equal(odd.status, "requested");
  assert.equal(odd.status_detail, "outcome_unknown:partner_bad_answer");
  assert.equal((await store.db.query("SELECT status FROM financial_products.ramp_adapter_transfers WHERE partner_transfer_id = 'tr_odd'")).rows[0].status, "submitted");
  assert.equal((await hook(offerings.onramp_transfer, { id: "tr_odd", state: "payment_processed", receipt: { final_amount: (Number(odd.expected_total_cents) / 100).toFixed(2) } })).status, 200);
  const landed = (await store.db.query("SELECT * FROM financial_products.money_movements WHERE id = $1", [odd.id])).rows[0];
  assert.equal(landed.status, "settled");
  assert.equal(Number(landed.settled_amount_cents), Number(odd.expected_total_cents), "what the partner reports it moved");
  assert.equal(landed.settled_amount_differs, false, "it matches what the quote said would arrive");

  // ---- dollars only, and the credential nowhere ----
  // The SDK a developer generates for this product: its actions, types and docs carry no crypto concept.
  const sdk = await generateSdk({ name: "dollars", version: "1.0.0", languages: ["typescript"], baseUrl: "https://mynt.test/v1", products: [{ record: await store.getProduct("everyday-rd"), issuer: null }] });
  const sdkText = sdk.map((f) => f.content).join("\n");
  assert.ok(sdkText.includes("onramp_quote") && sdkText.includes("offramp_transfer"), "the SDK knows the ramp actions");
  assert.doesNotMatch(sdkText, /usdc|solana|ethereum|wallet|settlement_(asset|network|tx|amount)|blockchain|stablecoin/i);
  for (const text of seenByDevice) assert.doesNotMatch(text, /usdc|solana|wallet|chain|network|asset|token|address|settlement|_tx|5VERYLong|9wFFy|7xKXt/i, text);
  const audit = JSON.stringify((await store.db.query("SELECT details FROM financial_products.audit_log")).rows);
  const vault = JSON.stringify((await store.db.query("SELECT * FROM financial_products.key_vault")).rows);
  const offeringsRows = JSON.stringify((await store.db.query("SELECT * FROM financial_products.vendor_offerings")).rows);
  toolTexts.push(JSON.stringify(await ok(partner, "list_my_offerings")));
  toolTexts.push(JSON.stringify(await ok(innovator, "list_vendor_offerings", { region: "US" })));
  for (const [where, text] of Object.entries({ responses: seenByDevice.join("\n"), tools: toolTexts.join("\n"), audit, vault, offerings: offeringsRows, console: logged.join("\n") }))
    assert.ok(!text.includes(API_KEY), `the partner's credential appears in ${where}`);
});
