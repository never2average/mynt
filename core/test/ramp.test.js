import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { createServer } from "../dist/server.js";
import { signBody } from "../dist/vendor-call.js";
import { definitionFor, publishDefined, setup } from "./v2-helpers.js";

// The Mynt Ramp: one on- and off-ramp for all digital-asset liquidity, offered only by the firm an admin
// designates (today the licensed ramp partner, which holds funds in transit). A device asks for a quote with
// params (direction and a dollar amount), sees the price in dollars and when it expires, and accepts it by Mynt's
// reference. Mynt sends the vendor its own quote id once, only while unexpired, and only to the vendor that quoted.
// Customers see US dollars only: the settlement asset is the partner's, and never reaches a device.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 1000 };
const NAME = "Avery Stone";

const servers = [];
after(() => servers.forEach((s) => s.close()));
const listen = async (handler) => {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push({ close: () => (server.closeAllConnections(), server.close()) });
  return `http://127.0.0.1:${server.address().port}`;
};
const verifySig = (header, raw, secrets) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  return [...secrets].some((s) => timingSafeEqual(createHmac("sha256", s).update(`${m[1]}.${raw}`).digest(), Buffer.from(m[2], "hex")));
};

// The ramp partner's endpoint, speaking Mynt's vendor contract.
async function rampPartner() {
  const state = { secrets: new Set(), seen: [], quotes: new Map(), transfer: "pending", quoteTtl: 60, n: 0 };
  const url = await listen(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const signed = verifySig(req.headers["mynt-signature"], raw, state.secrets);
    state.seen.push({ path: req.url, signed, body });
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!signed) return reply(401, { request_id: body.request_id, status: "error", output: null, error: { code: "bad_signature" } });
    if (req.url.endsWith("/v1/ramp_quote")) {
      const quote_id = `q_${++state.n}`;
      state.quotes.set(quote_id, body.params);
      const expires_at = new Date(Date.now() + state.quoteTtl * 1000).toISOString();
      const p = body.params;
      return reply(200, {
        request_id: body.request_id,
        status: "ok",
        output: { quote_id, expires_at, direction: p.direction, fiat_amount: p.fiat_amount, fiat_currency: "USD", receive_amount: "99.50", fee: "0.50", settlement_asset: "USDC", settlement_network: "solana" },
      });
    }
    if (req.url.endsWith("/v1/ramp_transfer")) {
      if (body.consent?.artefact_ref === "mynt_conformance") return reply(200, { request_id: body.request_id, status: "ok", output: { transfer_status: "submitted", settlement_ref: null } });
      if (state.transfer === "bad_output") return reply(200, { request_id: body.request_id, status: "ok", output: { transfer_status: "maybe" } });
      return reply(200, { request_id: body.request_id, status: "ok", output: { transfer_status: "submitted", settlement_ref: null } });
    }
    reply(404, { status: "error" });
  });
  return { state, url };
}

// Service types shaped like the shipped US ramp quote and transfer, in this test's region: dollars for the device,
// the settlement asset partner-side.
const RAMP_INPUT = { type: "object", required: ["full_name"], properties: { full_name: { type: "string" } }, additionalProperties: false };
const QUOTE = {
  region: "IN",
  key: "ramp_quote",
  name: "Mynt Ramp quote",
  category: "ramp",
  input_schema: RAMP_INPUT,
  params_schema: {
    type: "object",
    required: ["direction", "fiat_amount"],
    properties: { direction: { enum: ["on", "off"] }, fiat_amount: { type: "string", pattern: "^[0-9]{1,9}(\\.[0-9]{1,2})?$" } },
    additionalProperties: false,
  },
  params_fixture: { direction: "on", fiat_amount: "100.00" },
  output_schema: {
    type: "object",
    required: ["quote_id", "expires_at", "direction", "fiat_amount", "fiat_currency", "receive_amount", "fee", "settlement_asset", "settlement_network"],
    properties: {
      quote_id: { type: "string" },
      expires_at: { type: "string" },
      direction: { enum: ["on", "off"] },
      fiat_amount: { type: "string" },
      fiat_currency: { enum: ["USD"] },
      receive_amount: { type: "string" },
      fee: { type: "string" },
      settlement_asset: { enum: ["USDC"] },
      settlement_network: { enum: ["solana"] },
    },
    additionalProperties: false,
  },
  quote: true,
  moves_money: false,
  consent_purpose: "fiat_ramp_transfer",
  vendor_licences: ["rbi_pa"],
  client_result: { fields: ["direction", "fiat_amount", "fiat_currency", "receive_amount", "fee"], redirect: false },
};
const TRANSFER = {
  region: "IN",
  key: "ramp_transfer",
  name: "Mynt Ramp transfer",
  category: "ramp",
  input_schema: RAMP_INPUT,
  output_schema: {
    type: "object",
    required: ["transfer_status"],
    properties: { transfer_status: { enum: ["submitted", "settled", "failed", "returned"] }, settlement_ref: { type: ["string", "null"] } },
    additionalProperties: false,
  },
  accepts: "ramp_quote",
  moves_money: true,
  consent_purpose: "fiat_ramp_transfer",
  vendor_licences: ["rbi_pa"],
  client_result: { status: { from: "transfer_status", map: { submitted: "pending", settled: "completed", failed: "failed", returned: "failed" } }, fields: ["transfer_status"], redirect: false },
};

test("the Mynt Ramp: one designated ramp, quotes with params, accepted once while unexpired", async () => {
  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "ramp", version: "0" });
    await client.connect(c);
    return client;
  };
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const errorsOf = async (client, name, args) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, true, `${name} should fail`);
    return r.data.errors?.join("\n") ?? JSON.stringify(r.data);
  };
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const admin = await connect(adminUser);
  const innovator = await connect(ctx.user);
  const partner = await rampPartner();

  // ---- service types: params are declared scalars, never customer data; quotes carry an id and an expiry ----
  let errs = await errorsOf(admin, "define_service_type", { service_type: { ...QUOTE, params_schema: { ...QUOTE.params_schema, additionalProperties: true } } });
  assert.match(errs, /additionalProperties: false/);
  errs = await errorsOf(admin, "define_service_type", {
    service_type: { ...QUOTE, params_schema: { type: "object", properties: { full_name: { type: "string" }, legs: { type: "array" } }, additionalProperties: false } },
  });
  assert.match(errs, /'full_name' is customer data/);
  assert.match(errs, /'legs' must be a plain/);
  errs = await errorsOf(admin, "define_service_type", { service_type: { ...QUOTE, params_fixture: undefined } });
  assert.match(errs, /params_fixture: needed/);
  errs = await errorsOf(admin, "define_service_type", {
    service_type: { ...QUOTE, output_schema: { ...QUOTE.output_schema, required: ["direction"] }, client_result: { fields: ["quote_id"] } },
  });
  assert.match(errs, /must require 'quote_id'/);
  assert.match(errs, /must require 'expires_at'/);
  assert.match(errs, /'quote_id' stays between Mynt and the vendor/);
  assert.match(await errorsOf(admin, "define_service_type", { service_type: TRANSFER }), /accepts: no service type 'ramp_quote'/);

  // ---- dollars only: a service type that would show a device, or take from it, a crypto concept is refused ----
  const leaky = (fields, props, extra = {}) => ({
    ...QUOTE,
    output_schema: { ...QUOTE.output_schema, properties: { ...QUOTE.output_schema.properties, ...props } },
    client_result: { fields, redirect: false },
    ...extra,
  });
  errs = await errorsOf(admin, "define_service_type", {
    service_type: leaky(["chain", "wallet_address", "asset", "settlement_network"], { chain: { type: "string" }, wallet_address: { type: "string" }, asset: { const: "USDC" } }),
  });
  for (const f of ["chain", "wallet_address", "asset", "settlement_network"]) assert.match(errs, new RegExp(`client_result.fields: '${f}' names a crypto concept`));
  assert.match(errs, /US dollars only/);
  errs = await errorsOf(admin, "define_service_type", { service_type: leaky(["unit"], { unit: { enum: ["USD", "USDC"] } }) });
  assert.match(errs, /'unit' can take the value "USDC", a crypto asset or network/);
  errs = await errorsOf(admin, "define_service_type", { service_type: leaky(["fiat_currency"], { fiat_currency: { type: "string" } }) });
  assert.match(errs, /'fiat_currency' must be US dollars only/);
  errs = await errorsOf(admin, "define_service_type", {
    service_type: {
      ...QUOTE,
      params_schema: { ...QUOTE.params_schema, properties: { ...QUOTE.params_schema.properties, network: { enum: ["solana"] } } },
    },
  });
  assert.match(errs, /params_schema: 'network' names a crypto concept/);
  errs = await errorsOf(admin, "define_service_type", { service_type: { ...QUOTE, params_schema: { ...QUOTE.params_schema, properties: { ...QUOTE.params_schema.properties, rail: { enum: ["ethereum", "ach"] } } } } });
  assert.match(errs, /'rail' can take the value "ethereum"/);
  assert.match(await errorsOf(admin, "define_service_type", { service_type: { ...QUOTE, name: "USDC on-ramp quote" } }), /name: 'USDC on-ramp quote' names a crypto concept/);
  await ok(admin, "define_service_type", { service_type: QUOTE });
  await ok(admin, "define_service_type", { service_type: TRANSFER });
  assert.match(await errorsOf(admin, "define_service_type", { service_type: { ...TRANSFER, key: "ramp_again", accepts: "ramp_transfer" } }), /isn't a quote service type/);

  // ---- only the designated firm offers ramp services ----
  const firm = async (name, email) => {
    await ok(admin, "invite_user", { email, roles: ["vendor"] });
    const f = await ok(admin, "register_firm", { name, legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
    const invite = await store.getInvite(email);
    const u = await store.upsertClerkUser(`clerk_${email}`, email, name, invite.roles);
    await ok(admin, "add_entity_member", { email, entity_id: f.id });
    const client = await connect(u);
    const lic = await ok(client, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: `PA-${name}` });
    await ok(admin, "review_license", { license_record_id: lic.id, decision: "verified", note: "ok" });
    return { firm: f, client, lic };
  };
  const ramp = await firm("RampCo", "ops@rampco.example");
  const other = await firm("OtherRamp", "ops@otherramp.example");
  const offer = (v, key) =>
    call(v.client, "create_vendor_offering", { region: "IN", service_type: key, name: `Mynt Ramp ${key}`, price: { amount: 0, currency: "INR" }, test_base_url: partner.url, licence_ids: [v.lic.id] });
  assert.match(JSON.stringify((await offer(ramp, "ramp_quote")).data), /No firm operates the Mynt Ramp yet/);
  assert.deepEqual(await ok(admin, "set_mynt_ramp", {}), { entity_id: null, name: null });
  await ok(admin, "set_mynt_ramp", { entity_id: ramp.firm.id });
  assert.equal((await ok(admin, "set_mynt_ramp", {})).name, "RampCo");
  assert.match(JSON.stringify((await offer(other, "ramp_quote")).data), /only by the firm that operates the Mynt Ramp/);
  const offerings = {};
  for (const key of ["ramp_quote", "ramp_transfer"]) {
    const o = (await offer(ramp, key)).data;
    assert.ok(o.id, JSON.stringify(o));
    partner.state.secrets.add(o.conformance_signing_secret);
    const run = await ok(ramp.client, "run_conformance", { offering_id: o.id });
    assert.equal(run.passed, true, JSON.stringify(run.cases));
    await ok(ramp.client, "update_vendor_offering", { offering_id: o.id, listed: true });
    offerings[key] = o.id;
  }
  // Conformance sent the params fixture to the quote, and a placeholder quote to the transfer.
  assert.deepEqual(partner.state.seen.find((x) => x.path === "/v1/ramp_quote").body.params, QUOTE.params_fixture);
  assert.deepEqual(partner.state.seen.find((x) => x.path === "/v1/ramp_transfer").body.quote, { quote_id: "mynt_conformance" });

  // ---- the innovator plugs the ramp into its product ----
  const subs = {};
  for (const key of ["ramp_quote", "ramp_transfer"]) {
    subs[key] = await ok(innovator, "subscribe_vendor_service", { offering_id: offerings[key] });
    partner.state.secrets.add((await ok(ramp.client, "reveal_subscription_secret", { subscription_id: subs[key].subscription_id })).signing_secret);
  }
  const bind = (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    for (const [id, key] of [
      ["get_quote", "ramp_quote"],
      ["transfer", "ramp_transfer"],
    ]) {
      d.partner_handoffs.push({ _id: id, name: id, trigger: "account_opened", sends: { type: "object", required: ["full_name"] }, returns: { type: "object", required: ["status"] } });
      d.connections.push(
        {
          _id: `h_${id}`,
          type: "handoff_to_party",
          from: { kind: "partner_handoff", id },
          to: { kind: "party", id: subs[key].vendor_party_id },
          attributes: { sla: "PT1M", consent_purpose: "fiat_ramp_transfer", channel: "api", vendor_subscription_id: subs[key].subscription_id, service_type: key },
        },
        { _id: `s_${id}`, type: "handoff_serves_component", from: { kind: "partner_handoff", id }, to: { kind: "component", id: "deposit" } },
      );
    }
    return d;
  };
  assert.equal((await call(ctx.client, "check_product_definition", { definition: bind(definitionFor(ctx, "00000000-0000-4000-8000-000000000000")) })).isError, false);
  await publishDefined(ctx, (d) => bind(d));
  const contract = (await store.getProduct("everyday-rd")).pins.contract;
  const quoteAction = contract.actions.find((a) => a.id === "get_quote");
  assert.equal(quoteAction.served_by.quote, true);
  assert.deepEqual(quoteAction.served_by.params_schema, QUOTE.params_schema);
  assert.equal(contract.actions.find((a) => a.id === "transfer").served_by.accepts_quote_from, "get_quote");
  assert.equal(contract.actions.find((a) => a.id === "mandate_setup").served_by, undefined);
  assert.ok(!JSON.stringify(contract).includes(partner.url), "the contract never names the ramp's endpoint");

  // ---- a developer's app and a customer's device ----
  await ok(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = await ok(dev, "create_app", { name: "Stable", description: "Dollars in and out", audience: "Savers", product_ids: ["everyday-rd"] });
  const key = (await ok(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).key;
  const s = createMcpHttpServer(store, null, { vendors: VENDOR_OPTS }, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS }).listen(0, "127.0.0.1");
  await new Promise((r) => s.once("listening", r));
  servers.push({ close: () => (s.closeAllConnections(), s.close()) });
  const base = `http://127.0.0.1:${s.address().port}`;
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const session = async (customer_ref) => {
    const r = await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["get_quote", "transfer", "mandate_setup"], customer_ref });
    assert.equal(r.status, 201, r.text);
    const secret = r.body.client_secret;
    assert.equal((await api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "consent_given", subject: "fiat_ramp_transfer" })).status, 201);
    assert.equal((await api("POST", "/v1/client/fields", secret, { product_id: "everyday-rd", values: { full_name: NAME } })).status, 201);
    return secret;
  };
  const start = (secret, action, extra = {}) => api("POST", `/v1/client/actions/${action}`, secret, { product_id: "everyday-rd", ...extra });
  const PARAMS = { direction: "on", fiat_amount: "100.00" };
  const dev1 = await session("cust_1");

  // Params are checked before the ramp is called.
  const callsBefore = partner.state.seen.length;
  const noParams = await start(dev1, "get_quote");
  assert.equal(noParams.status, 400);
  assert.equal(noParams.body.error, "invalid_params");
  assert.equal((await start(dev1, "get_quote", { params: { ...PARAMS, fiat_amount: "lots" } })).body.error, "invalid_params");
  assert.equal((await start(dev1, "get_quote", { params: { ...PARAMS, wallet: "0xabc" } })).body.error, "invalid_params", "nothing undeclared");
  assert.equal(partner.state.seen.length, callsBefore, "no call with bad params");
  assert.equal((await start(dev1, "mandate_setup", { params: PARAMS })).body.error, "params_not_accepted", "a hand-off to the innovator takes no params");

  // ---- a quote: the device sees the price and its expiry, never the vendor's quote id ----
  const quote = await start(dev1, "get_quote", { params: PARAMS });
  assert.equal(quote.status, 201, quote.text);
  assert.equal(quote.body.status, "completed");
  assert.equal(quote.body.fiat_amount, "100.00");
  assert.equal(quote.body.receive_amount, "99.50");
  assert.doesNotMatch(quote.text, /usdc|solana|settlement|asset|network/i, "dollars only: the settlement asset stays partner-side");
  assert.ok(Date.parse(quote.body.expires_at) > Date.now());
  const issued = `q_${partner.state.n}`; // the partner's own id for this quote
  assert.ok(!quote.text.includes(issued), "the vendor's quote id stays with Mynt");
  const quoteCall = partner.state.seen.at(-1);
  assert.deepEqual(quoteCall.body.params, PARAMS);
  assert.deepEqual(quoteCall.body.input, { full_name: NAME }, "customer data comes from the vault");

  // ---- accepting it ----
  assert.equal((await start(dev1, "transfer")).body.error, "quote_required");
  assert.equal((await start(dev1, "transfer", { quote: quote.body.reference, params: PARAMS })).body.error, "params_not_accepted");
  assert.equal((await start(dev1, "get_quote", { params: PARAMS, quote: quote.body.reference })).body.error, "quote_not_accepted");
  assert.equal((await start(dev1, "transfer", { quote: randomUUID() })).status, 404);
  const dev2 = await session("cust_2");
  assert.equal((await start(dev2, "transfer", { quote: quote.body.reference })).body.error, "quote_not_found", "another customer's quote can't be accepted");

  // A transfer the ramp answers badly releases the quote, so the customer can try again.
  partner.state.transfer = "bad_output";
  assert.equal((await start(dev1, "transfer", { quote: quote.body.reference })).status, 502);
  partner.state.transfer = "pending";
  const accepted = await start(dev1, "transfer", { quote: quote.body.reference });
  assert.equal(accepted.status, 201, accepted.text);
  assert.equal(accepted.body.status, "pending");
  assert.equal(accepted.body.transfer_status, "submitted");
  const sent = partner.state.seen.filter((x) => x.path === "/v1/ramp_transfer" && x.body.consent?.artefact_ref !== "mynt_conformance");
  assert.deepEqual(
    sent.map((x) => x.body.quote),
    [{ quote_id: issued }, { quote_id: issued }],
    "the ramp gets its own quote id, the same on a retry",
  );
  const again = await start(dev1, "transfer", { quote: quote.body.reference });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "quote_used");

  // The ramp settles by callback; the device reads the outcome back.
  const run = (await store.db.query("SELECT request_id, subscription_id FROM financial_products.vendor_action_runs WHERE id = $1", [accepted.body.reference])).rows[0];
  const callback = JSON.stringify({ request_id: run.request_id, status: "ok", output: { transfer_status: "settled", settlement_ref: "tx_1" } });
  const secret = (await ok(ramp.client, "rotate_subscription_secret", { subscription_id: run.subscription_id })).signing_secret;
  partner.state.secrets.add(secret); // the ramp signs and verifies with the rotated secret from now on
  const cb = await fetch(`${base}/v1/vendor/callback/${run.subscription_id}`, { method: "POST", headers: { "Content-Type": "application/json", "Mynt-Signature": signBody(secret, callback) }, body: callback });
  assert.equal(cb.status, 200, await cb.text());
  const settled = await api("GET", `/v1/client/action_runs/${accepted.body.reference}`, dev1);
  assert.equal(settled.body.status, "completed");
  assert.equal(settled.body.transfer_status, "settled");

  // ---- an expired quote can't be accepted ----
  const late = await start(dev1, "get_quote", { params: PARAMS });
  await store.db.query("UPDATE financial_products.vendor_action_runs SET quote_expires_at = now() - interval '1 second' WHERE id = $1", [late.body.reference]);
  const expired = await start(dev1, "transfer", { quote: late.body.reference });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error, "quote_expired");

  // ---- two accepts of one quote at once: exactly one goes through ----
  const race = await start(dev1, "get_quote", { params: PARAMS });
  const both = await Promise.all([start(dev1, "transfer", { quote: race.body.reference }), start(dev1, "transfer", { quote: race.body.reference })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [201, 409]);

  // ---- a quote further ahead than an hour isn't usable ----
  partner.state.quoteTtl = 7200;
  assert.equal((await start(dev1, "get_quote", { params: PARAMS })).body.error, "vendor_error");
  partner.state.quoteTtl = 60;

  // ---- moving the Mynt Ramp to another firm stops calls to the old one's offerings ----
  const fresh = await start(dev1, "get_quote", { params: PARAMS });
  await ok(admin, "set_mynt_ramp", { entity_id: other.firm.id });
  const moved = await start(dev1, "get_quote", { params: PARAMS });
  assert.equal(moved.status, 503);
  assert.equal(moved.body.error, "vendor_unavailable");
  assert.equal((await start(dev1, "transfer", { quote: fresh.body.reference })).status, 503);
  const audit = (await store.db.query("SELECT action FROM financial_products.audit_log WHERE action = 'set_mynt_ramp'")).rows;
  assert.equal(audit.length, 2, "every designation is audited");
});

test("the Mynt Ramp sandbox: on-ramp and off-ramp end to end, on the shipped US service types", async () => {
  process.env.RAMP_SANDBOX_SETTLE_MS = "50";
  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "ramp-sandbox", version: "0" });
    await client.connect(c);
    return client;
  };
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const admin = await connect(adminUser);
  const innovator = await connect(ctx.user);

  // Mynt's own server: the runtime API, and the sandbox ramp at /ramp-sandbox.
  const srv = createMcpHttpServer(store, null, { vendors: VENDOR_OPTS }, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  servers.push({ close: () => (srv.closeAllConnections(), srv.close()) });
  const base = `http://127.0.0.1:${srv.address().port}`;

  // ---- the US model knows the ramp's licence type, so the shipped types load ----
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
  const loaded = await ok(admin, "load_service_types", { region: "US" });
  for (const k of KEYS) assert.ok(loaded.loaded.includes(`US/${k}`), JSON.stringify(loaded));
  const types = Object.fromEntries((await ok(admin, "list_service_types", { region: "US" })).map((t) => [t.key, t]));
  assert.equal(types.onramp_transfer.accepts, "onramp_quote");
  assert.equal(types.offramp_transfer.accepts, "offramp_quote");
  assert.notEqual(types.onramp_quote.consent_purpose, types.offramp_quote.consent_purpose, "on and off are separate consents");

  // ---- the ramp partner's firm, designated, with its test endpoint on Mynt's sandbox ----
  await ok(admin, "invite_user", { email: "ops@rampco.example", roles: ["vendor"] });
  const firm = await ok(admin, "register_firm", { name: "RampCo", legal_form: "company_private", incorporation: { country: "us" }, regions: ["US"] });
  const vu = await store.upsertClerkUser("clerk_rampco", "ops@rampco.example", "RampCo ops", (await store.getInvite("ops@rampco.example")).roles);
  await ok(admin, "add_entity_member", { email: "ops@rampco.example", entity_id: firm.id });
  const rampco = await connect(vu);
  const lic = await ok(rampco, "register_license", { region: "US", regulator_id: "fincen", license_id: "fincen_msb", registration_number: "MSB-1" });
  await ok(admin, "review_license", { license_record_id: lic.id, decision: "verified", note: "ok" });
  await ok(admin, "set_mynt_ramp", { entity_id: firm.id });
  const offerings = {};
  for (const key of KEYS) {
    const o = await ok(rampco, "create_vendor_offering", {
      region: "US",
      service_type: key,
      name: `Mynt Ramp ${key}`,
      price: { amount: 0, currency: "USD" },
      test_base_url: `${base}/ramp-sandbox`,
      licence_ids: [lic.id],
    });
    const run = await ok(rampco, "run_conformance", { offering_id: o.id });
    assert.equal(run.passed, true, `${key}: ${JSON.stringify(run.cases)}`);
    await ok(rampco, "update_vendor_offering", { offering_id: o.id, listed: true });
    offerings[key] = o.id;
  }

  // The sandbox answers only what Mynt signed for a ramp offering pointed at it.
  const raw = JSON.stringify({ request_id: randomUUID(), environment: "test", input: {}, params: { direction: "in", amount_usd: "10.00" } });
  const unsigned = await fetch(`${base}/ramp-sandbox/v1/onramp_quote`, { method: "POST", body: raw });
  assert.equal(unsigned.status, 401);
  const forged = await fetch(`${base}/ramp-sandbox/v1/onramp_quote`, { method: "POST", headers: { "Mynt-Signature": signBody("not-a-ramp-secret", raw) }, body: raw });
  assert.equal(forged.status, 401);
  assert.equal((await fetch(`${base}/ramp-sandbox/v1/wire_money`, { method: "POST", body: "{}" })).status, 404);

  // ---- a product with both ramps ----
  const subs = {};
  for (const key of KEYS) subs[key] = await ok(innovator, "subscribe_vendor_service", { offering_id: offerings[key] });
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
  assert.equal(contract.actions.find((a) => a.id === "onramp_transfer").served_by.accepts_quote_from, "onramp_quote");
  assert.equal(contract.actions.find((a) => a.id === "offramp_transfer").served_by.accepts_quote_from, "offramp_quote");
  // Dollars only: what the contract tells developers a device sends and sees names no crypto concept.
  const deviceSide = JSON.stringify(contract.actions.filter((a) => a.served_by).map((a) => [a.served_by.client_result, a.served_by.params_schema ?? null]));
  assert.doesNotMatch(deviceSide, /usdc|solana|ethereum|wallet|chain|network|asset|token|address|tx_|_tx|hash/i, deviceSide);
  assert.deepEqual(contract.actions.find((a) => a.id === "onramp_quote").served_by.client_result.fields, ["direction", "amount_usd", "fee_usd", "total_usd", "currency", "estimated_arrival"]);

  await ok(ctx.client, "set_product_access", { id: "everyday-rd", access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: "https://bank.example.com/start" } });
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = await ok(dev, "create_app", { name: "Dollars", description: "In and out of USDC", audience: "Savers", product_ids: ["everyday-rd"] });
  const key = (await ok(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).key;
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${secret}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  const sess = await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: KEYS, customer_ref: "cust_us_1" });
  assert.equal(sess.status, 201, sess.text);
  const device = sess.body.client_secret;
  const P = "everyday-rd";
  for (const purpose of ["fiat_onramp", "fiat_offramp"]) assert.equal((await api("POST", "/v1/client/evidence", device, { product_id: P, type: "consent_given", subject: purpose })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { full_name: NAME, routing_number: "021000021" } })).status, 201);
  assert.equal((await api("POST", "/v1/client/fields", device, { product_id: P, values: { bank_account_number: "000123456789" }, source: "secure_field" })).status, 201);
  const start = (action, extra) => deviceApi("POST", `/v1/client/actions/${action}`, device, { product_id: P, ...extra });
  const settled = async (reference) => {
    for (let i = 0; i < 100; i++) {
      const r = await deviceApi("GET", `/v1/client/action_runs/${reference}`, device);
      if (r.body.status !== "pending") return r.body;
      await new Promise((ok) => setTimeout(ok, 20));
    }
    throw new Error("never settled");
  };
  const params = (amount_usd, direction = "in") => ({ params: { direction, amount_usd } });
  // Every device response, checked for crypto concepts at the end.
  const seenByDevice = [];
  const apiSeen = api;
  const deviceApi = async (...a) => {
    const r = await apiSeen(...a);
    seenByDevice.push(r.text);
    return r;
  };

  // ---- add dollars: $100 from the bank, $99.50 added after a $0.50 fee ----
  const onQuote = await start("onramp_quote", params("100.00"));
  assert.equal(onQuote.status, 201, onQuote.text);
  assert.deepEqual(
    { direction: onQuote.body.direction, amount: onQuote.body.amount_usd, fee: onQuote.body.fee_usd, total: onQuote.body.total_usd, currency: onQuote.body.currency },
    { direction: "in", amount: "100.00", fee: "0.50", total: "99.50", currency: "USD" },
  );
  assert.equal((await start("onramp_quote", params("100.00", "out"))).body.error, "invalid_params", "an on-ramp quote is direction in");
  assert.ok(!onQuote.text.includes("sbq."), "the device never sees the ramp's quote id");
  const onTransfer = await start("onramp_transfer", { quote: onQuote.body.reference });
  assert.equal(onTransfer.status, 201, onTransfer.text);
  assert.equal(onTransfer.body.status, "pending");
  const onDone = await settled(onTransfer.body.reference);
  assert.equal(onDone.status, "completed");
  assert.equal(onDone.transfer_status, "settled");

  // ---- cash out: $250 to the bank account, $251.25 from the balance including a $1.25 fee ----
  const offQuote = await start("offramp_quote", params("250.00", "out"));
  assert.equal(offQuote.body.total_usd, "251.25");
  assert.equal(offQuote.body.fee_usd, "1.25");
  // An off-ramp quote can't be accepted as an on-ramp, or the other way round.
  assert.equal((await start("onramp_transfer", { quote: offQuote.body.reference })).body.error, "quote_not_found");
  const offDone = await settled((await start("offramp_transfer", { quote: offQuote.body.reference })).body.reference);
  assert.equal(offDone.transfer_status, "settled");

  // ---- a bounced bank transfer and a failed one ----
  const bounced = await settled((await start("onramp_transfer", { quote: (await start("onramp_quote", params("20.13"))).body.reference })).body.reference);
  assert.deepEqual([bounced.status, bounced.transfer_status], ["failed", "returned"]);
  const failed = await settled((await start("offramp_transfer", { quote: (await start("offramp_quote", params("40.66", "out"))).body.reference })).body.reference);
  assert.deepEqual([failed.status, failed.transfer_status], ["failed", "failed"]);

  // ---- too small to cover the fee ----
  assert.equal((await start("onramp_quote", params("0.50"))).body.error, "vendor_error");

  // ---- dollars only: nothing a device was sent names a crypto asset, network, wallet or transaction ----
  assert.ok(seenByDevice.length > 10);
  for (const text of seenByDevice) assert.doesNotMatch(text, /usdc|solana|ethereum|wallet|chain|network|asset|token|address|settlement|_tx|0x[0-9a-f]{8}/i, text);
});
