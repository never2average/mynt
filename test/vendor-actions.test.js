import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { deliverDueWebhooks, signWebhook } from "../dist/runtime.js";
import { createServer } from "../dist/server.js";
import { signBody } from "../dist/vendor-call.js";
import { sweepVendorActionRuns } from "../dist/vendors.js";
import { definitionFor, publishDefined, setup } from "./v2-helpers.js";

// A product's client action served by its bound vendor service: a device starts a PAN check or an e-sign, Mynt
// calls the vendor (test endpoint for sandbox sessions, live for live), keeps the result sealed, sends it in full
// to the innovator's firm webhook, and tells the device only a status, a reference and, for services the
// customer finishes on the provider's page, a redirect_url. Asynchronous services finish through a signed callback.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 1000 };
const CREDENTIAL = "vendor-test-cred-5d1e";
const LIVE_CREDENTIAL = "vendor-live-cred-8c2a";
const PAN = "ABCPV1234K";
const NAME = "Asha Verma";
const REDIRECT = "https://esign.vendor.example/sign/7f2c";

const servers = [];
after(() => servers.forEach((s) => s.close()));
const listen = async (handler) => {
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  servers.push({ close: () => (server.closeAllConnections(), server.close()) });
  return `http://127.0.0.1:${server.address().port}`;
};
const verifySig = (header, raw, secrets, maxAge = 300) => {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
  if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > maxAge) return false;
  return [...secrets].some((s) => timingSafeEqual(createHmac("sha256", s).update(`${m[1]}.${raw}`).digest(), Buffer.from(m[2], "hex")));
};

// The vendor: PAN verification and e-sign, on its test endpoint and (under /live) its live one.
async function vendorServer() {
  const state = { secrets: new Set(), seen: [], pan: "valid", esign: "pending" };
  const url = await listen(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const signed = verifySig(req.headers["mynt-signature"], raw, state.secrets);
    state.seen.push({ path: req.url, authorization: req.headers.authorization ?? null, signed, body });
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!signed) return reply(401, { request_id: body.request_id, status: "error", output: null, error: { code: "bad_signature" } });
    const conformance = body.consent?.artefact_ref === "mynt_conformance";
    if (req.url.endsWith("/v1/pan_verification")) {
      const mode = conformance ? "valid" : state.pan;
      if (mode === "bad_output") return reply(200, { request_id: body.request_id, status: "ok", output: { pan_status: "maybe", holder_name: NAME } });
      return reply(200, { request_id: body.request_id, status: "ok", output: { pan_status: mode, name_match: true, dob_match: null } });
    }
    if (req.url.endsWith("/v1/esign")) {
      if (conformance || state.esign === "ok") return reply(200, { request_id: body.request_id, status: "ok", output: { signature_status: "signed", signed_document_ref: "doc-signed-1" } });
      // Answered at once, but the customer hasn't signed yet: the service's own status says pending.
      if (state.esign === "ok_pending") return reply(200, { request_id: body.request_id, status: "ok", output: { signature_status: "pending" } });
      return reply(200, { request_id: body.request_id, status: "pending", redirect_url: REDIRECT });
    }
    reply(404, { status: "error" });
  });
  return { state, url };
}

// The innovator's own server, receiving its firm webhook.
async function innovatorServer() {
  const received = [];
  const url = await listen(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    received.push({ signature: req.headers["mynt-signature"], raw, body: JSON.parse(raw) });
    res.writeHead(200).end();
  });
  return { received, url };
}

test("client actions served by the bound vendor: the device gets a status, the innovator the result", async () => {
  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "vendor-actions", version: "0" });
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
  const vendor = await vendorServer();
  const firmHook = await innovatorServer();
  const appHook = await innovatorServer(); // the developer's app server, for its own (data-free) webhooks

  // ---- service types: what a device may be told is part of each one ----
  const loaded = await ok(admin, "load_service_types", { region: "IN", licence_map: { rbi_nbfc: "rbi_bank", rbi_cic: "rbi_pa", cca_esp: "rbi_pa" } });
  assert.equal(loaded.loaded.length, 8, JSON.stringify(loaded.skipped));
  const types = await ok(admin, "list_service_types", { region: "IN" });
  const byKey = Object.fromEntries(types.map((t) => [t.key, t]));
  assert.deepEqual(byKey.pan_verification.client_result.fields, [], "identity: status only");
  assert.equal(byKey.pan_verification.client_result.status.map.valid, "verified");
  assert.deepEqual(byKey.credit_bureau_report.client_result, { fields: [], redirect: false }, "bureau: status only");
  assert.equal(byKey.esign.client_result.redirect, true, "e-sign: status and redirect_url");
  assert.equal(byKey.emandate_registration.client_result.redirect, true, "e-mandate: status and redirect_url");
  assert.equal(byKey.ckyc_search_download.client_result, null, "by default the device gets nothing of the output");
  // Customer data can't be let through to the device.
  const { updated_at, fixtures, ...ckyc } = byKey.ckyc_search_download;
  const leaky = await call(admin, "define_service_type", {
    service_type: { ...ckyc, client_result: { fields: ["full_name", "shoe_size"], status: { from: "colour", map: {} } } },
  });
  assert.equal(leaky.isError, true);
  const leakErrors = leaky.data.errors?.join("\n") ?? JSON.stringify(leaky.data);
  assert.match(leakErrors, /'full_name' is customer data/);
  assert.match(leakErrors, /'shoe_size' isn't a property of output_schema/);
  assert.match(leakErrors, /status.from: 'colour' isn't a property/);
  // Only plain scalar properties may go to the device: never objects, arrays or anything that can nest.
  const nested = await call(admin, "define_service_type", {
    service_type: {
      ...ckyc,
      output_schema: {
        ...ckyc.output_schema,
        properties: {
          ...ckyc.output_schema.properties,
          match_detail: { type: "object" },
          flags: { type: "array", items: { type: "string" } },
          either: { anyOf: [{ type: "string" }, { type: "object" }] },
          band: { enum: ["a", "b"] },
          score_band: { type: ["integer", "null"] },
        },
      },
      client_result: { fields: ["match_detail", "flags", "either", "band", "score_band"] },
    },
  });
  assert.equal(nested.isError, true);
  const nestedErrors = nested.data.errors.join("\n");
  for (const f of ["match_detail", "flags", "either"]) assert.match(nestedErrors, new RegExp(`'${f}' must be a plain string, number, boolean or enum`), f);
  for (const f of ["band", "score_band"]) assert.doesNotMatch(nestedErrors, new RegExp(`'${f}'`), `${f} is a plain scalar`);

  // ---- a vendor with two listed offerings ----
  await ok(admin, "invite_user", { email: "vic@signworks.example", roles: ["vendor"] });
  const firm = await ok(admin, "register_firm", { name: "SignWorks Pvt Ltd", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const invite = await store.getInvite("vic@signworks.example");
  const vicUser = await store.upsertClerkUser("clerk_vic", "vic@signworks.example", "Vic", invite.roles);
  await ok(admin, "add_entity_member", { email: "vic@signworks.example", entity_id: firm.id });
  const vic = await connect(vicUser);
  const lic = await ok(vic, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: "PA-SIGN-1" });
  await ok(admin, "review_license", { license_record_id: lic.id, decision: "verified", note: "ok" });
  const offerings = {};
  for (const key of ["pan_verification", "esign"]) {
    const o = await ok(vic, "create_vendor_offering", {
      region: "IN",
      service_type: key,
      name: `SignWorks ${key}`,
      price: { amount: 2, currency: "INR" },
      test_base_url: vendor.url,
      live_base_url: `${vendor.url}/live`,
      licence_ids: [lic.id],
      requires_credential: true,
    });
    vendor.state.secrets.add(o.conformance_signing_secret);
    const run = await ok(vic, "run_conformance", { offering_id: o.id, test_credential: "conformance-cred" });
    assert.equal(run.passed, true, JSON.stringify(run.cases));
    await ok(vic, "update_vendor_offering", { offering_id: o.id, listed: true });
    offerings[key] = o.id;
  }

  // ---- the innovator subscribes, binds two handoffs, and gets a firm webhook ----
  const subs = {};
  const secrets = {};
  for (const key of ["pan_verification", "esign"]) {
    subs[key] = await ok(innovator, "subscribe_vendor_service", { offering_id: offerings[key], test_credential: CREDENTIAL });
    secrets[key] = (await ok(vic, "reveal_subscription_secret", { subscription_id: subs[key].subscription_id })).signing_secret;
    vendor.state.secrets.add(secrets[key]);
  }
  const hook = await ok(innovator, "create_firm_webhook", { url: `${firmHook.url}/mynt` });
  assert.match(hook.secret, /^whsec_/);
  // By default a firm webhook gets every firm event, the Mynt Ramp's reversals and late settlements included, and
  // its Solana programs' deploys, upgrades and events, and the mainnet program gate's notices.
  assert.deepEqual(hook.events, [
    "vendor_action.completed",
    "vendor_action.failed",
    "vendor_action.reversed",
    "vendor_action.late_settlement",
    "ramp_link.requested",
    "program.deployed",
    "program.upgraded",
    "program.event",
    "program.upgrade_scheduled",
    "program.upgrade_cancelled",
    "program.review_flagged",
    "partner_ledger.endpoint_change_pending",
    "partner_ledger.endpoints_confirmed",
    "partner_ledger.source_changed",
    "partner_ledger.key_changed",
    "partner_ledger.approval_requested",
    "partner_ledger.conformance_expiring",
    "firm.member_added",
    "firm.member_pending",
  ]);
  assert.ok(!JSON.stringify(await ok(innovator, "list_firm_webhooks")).includes(hook.secret), "the secret is shown once");

  const bind = (d, panSends = ["pan"]) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    d.partner_handoffs.push(
      { _id: "pan_check", name: "Verify the customer's PAN", trigger: "account_opened", sends: { type: "object", required: panSends }, returns: { type: "object", required: ["status"] } },
      { _id: "esign_agreement", name: "Sign the deposit agreement", trigger: "account_opened", sends: { type: "object", required: ["full_name"] }, returns: { type: "object", required: ["status"] } },
    );
    for (const [id, key, purpose] of [
      ["pan_check", "pan_verification", "identity_verification"],
      ["esign_agreement", "esign", "document_esign"],
    ])
      d.connections.push(
        {
          _id: `h_${id}`,
          type: "handoff_to_party",
          from: { kind: "partner_handoff", id },
          to: { kind: "party", id: subs[key].vendor_party_id },
          attributes: { sla: "PT1M", consent_purpose: purpose, channel: "api", vendor_subscription_id: subs[key].subscription_id, service_type: key },
        },
        { _id: `s_${id}`, type: "handoff_serves_component", from: { kind: "partner_handoff", id }, to: { kind: "component", id: "deposit" } },
      );
    return d;
  };
  // The handoff must ask the customer for the service's required inputs.
  const probe = await call(ctx.client, "check_product_definition", { definition: bind(definitionFor(ctx, "00000000-0000-4000-8000-000000000000"), ["full_name"]) });
  assert.match(probe.data.errors.join("\n"), /partner handoff 'pan_check': sends.required must include pan/);
  await publishDefined(ctx, (d) => bind(d));
  const record = await store.getProduct("everyday-rd");
  const contract = record.pins.contract;
  const panAction = contract.actions.find((a) => a.id === "pan_check");
  assert.deepEqual(panAction.served_by, {
    kind: "vendor_service",
    service_type: "pan_verification",
    client_result: { statuses: ["verified", "not_verified", "completed", "failed", "pending"], fields: [], redirect: false },
  });
  assert.equal(contract.actions.find((a) => a.id === "esign_agreement").served_by.client_result.redirect, true);
  assert.equal(contract.actions.find((a) => a.id === "mandate_setup").served_by, undefined, "an unbound action isn't vendor-served");
  const contractText = JSON.stringify(contract);
  for (const hidden of [subs.pan_verification.subscription_id, subs.esign.subscription_id, vendor.url, "mvs_", CREDENTIAL, firm.id])
    assert.ok(!contractText.includes(hidden), `the contract never carries ${hidden}`);

  // ---- a developer's app ----
  await ok(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = await ok(dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] });
  const key = (await ok(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).key;
  await ok(dev, "create_webhook", { app_id: app.id, url: `${appHook.url}/hook`, events: ["handoff.completed", "handoff.failed"] });
  const runtimeServer = async (extra = {}) => {
    const s = createMcpHttpServer(store, null, { vendors: VENDOR_OPTS }, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS, ...extra }).listen(0, "127.0.0.1");
    await new Promise((r) => s.once("listening", r));
    servers.push({ close: () => (s.closeAllConnections(), s.close()) });
    return `http://127.0.0.1:${s.address().port}`;
  };
  const apiBase = await runtimeServer();
  const deviceResponses = [];
  const api = async (method, path, secret, body, headers = {}) => {
    const res = await fetch(`${apiBase}${path}`, {
      method,
      headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (secret?.startsWith("mcs_")) deviceResponses.push(text);
    return { status: res.status, body: JSON.parse(text), text };
  };
  const scopes = ["pan_check", "esign_agreement", "mandate_setup"];
  const session = async (k, customer_ref) => {
    const r = await api("POST", "/v1/client_sessions", k, { product_ids: ["everyday-rd"], scopes, customer_ref });
    assert.equal(r.status, 201, r.text);
    return r.body.client_secret;
  };
  const consent = (s, subject) => api("POST", "/v1/client/evidence", s, { product_id: "everyday-rd", type: "consent_given", subject });
  const start = (s, action) => api("POST", `/v1/client/actions/${action}`, s, { product_id: "everyday-rd" });
  const counts = async () => ({
    runs: (await store.db.query("SELECT count(*)::int AS n FROM financial_products.vendor_action_runs")).rows[0].n,
    evidence: (await store.db.query("SELECT count(*)::int AS n FROM financial_products.client_evidence WHERE type IN ('action_completed', 'action_failed')")).rows[0].n,
    deliveries: (await store.db.query("SELECT count(*)::int AS n FROM financial_products.webhook_deliveries")).rows[0].n,
    vault: (await store.db.query("SELECT count(*)::int AS n FROM financial_products.customer_vault")).rows[0].n,
  });

  // Everything printed while Mynt handles the customer's data.
  const printed = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(original)) console[k] = (...a) => printed.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  try {
    const s = await session(key, "cust_1");
    // ---- consent first: 409, and the vendor isn't called ----
    const seenBefore = vendor.state.seen.length;
    const noConsent = await start(s, "pan_check");
    assert.equal(noConsent.status, 409);
    assert.equal(noConsent.body.error, "consent_required");
    assert.match(noConsent.body.message, /identity_verification/);
    await consent(s, "identity_verification");
    const noPan = await start(s, "pan_check");
    assert.equal(noPan.status, 409);
    assert.equal(noPan.body.error, "data_required");
    assert.match(noPan.body.message, /needs pan/);
    assert.equal(vendor.state.seen.length, seenBefore, "no vendor call without consent and data");
    assert.equal((await counts()).runs, 0, "nothing kept of a refused start");

    // ---- an identity check: status only to the device ----
    await consent(s, "document_esign");
    assert.equal((await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { pan: PAN }, source: "secure_field" })).status, 201);
    assert.equal((await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { full_name: NAME } })).status, 201);
    const verified = await start(s, "pan_check");
    assert.equal(verified.status, 201, verified.text);
    assert.deepEqual(Object.keys(verified.body).sort(), ["action", "reference", "sandbox", "status"]);
    assert.equal(verified.body.status, "verified");
    assert.equal(verified.body.action, "pan_check");
    assert.equal(verified.body.sandbox, true);
    const panCall = vendor.state.seen.at(-1);
    assert.equal(panCall.path, "/v1/pan_verification", "the test endpoint");
    assert.equal(panCall.authorization, `Bearer ${CREDENTIAL}`, "with the test credential");
    assert.equal(panCall.body.environment, "test");
    assert.deepEqual(panCall.body.input, { pan: PAN, full_name: NAME }, "the service type's declared inputs, from the vault");
    assert.equal(panCall.body.consent.purpose, "identity_verification");

    // Kept sealed, with evidence (status only) for the session.
    const run = (await store.db.query("SELECT * FROM financial_products.vendor_action_runs WHERE id = $1", [verified.body.reference])).rows[0];
    assert.equal(run.status, "completed");
    assert.ok(run.result_sealed.startsWith("v1s:") && !run.result_sealed.includes("name_match"), "sealed at rest");
    // Sandbox results are sealed with a key derived from MYNT_VAULT_KEY, so they open after a restart too.
    const durable = Buffer.from(hkdfSync("sha256", Buffer.from(process.env.MYNT_VAULT_KEY, "base64"), Buffer.alloc(0), "mynt-sandbox-durable-v1", 32));
    const [, iv, tag, ct] = run.result_sealed.split(":");
    const decipher = createDecipheriv("aes-256-gcm", durable, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8")), { pan_status: "valid", name_match: true, dob_match: null });
    assert.deepEqual(run.client_outcome, { status: "verified" });
    const evidence = (await store.db.query("SELECT * FROM financial_products.client_evidence WHERE type = 'action_completed'")).rows;
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].subject, "pan_check");
    assert.equal(evidence[0].contract_hash, contract.contract_hash);
    // The device can read its outcome back (e.g. after a redirect), and only its own customer's.
    assert.deepEqual((await api("GET", `/v1/client/action_runs/${verified.body.reference}`, s)).body, verified.body);
    const other = await session(key, "cust_other");
    assert.equal((await api("GET", `/v1/client/action_runs/${verified.body.reference}`, other)).status, 404);

    // The innovator gets the whole result at its firm webhook, signed; queued sealed.
    const queued = JSON.stringify((await store.db.query("SELECT payload FROM financial_products.webhook_deliveries")).rows);
    assert.ok(!queued.includes("name_match") && queued.includes("result_sealed"), "the queued payload holds the result sealed");
    const sent = await deliverDueWebhooks(store);
    assert.equal(sent.delivered, 1, JSON.stringify(sent));
    const got = firmHook.received.at(-1);
    const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(got.signature);
    assert.equal(v1, signWebhook(hook.secret, Number(t), got.raw), "signed with the firm webhook's secret");
    assert.equal(got.body.type, "vendor_action.completed");
    assert.deepEqual(got.body.data.result, { pan_status: "valid", name_match: true, dob_match: null });
    assert.equal(got.body.data.reference, verified.body.reference);
    assert.equal(got.body.data.customer_ref, "cust_1");
    assert.equal(got.body.data.app_id, app.id);
    assert.equal(got.body.data.status, "verified");
    assert.equal(got.body.data.sandbox, true);
    assert.equal(got.body.data.result_sealed, undefined);

    // A different answer maps to a different status.
    vendor.state.pan = "invalid";
    assert.equal((await start(s, "pan_check")).body.status, "not_verified");
    vendor.state.pan = "valid";

    // ---- an answer that breaks the output schema: 502, and nothing stored ----
    vendor.state.pan = "bad_output";
    const before = await counts();
    const broken = await start(s, "pan_check");
    assert.equal(broken.status, 502);
    assert.equal(broken.body.error, "vendor_error");
    assert.deepEqual(await counts(), before, "no run, evidence, delivery or vault field");
    vendor.state.pan = "valid";

    // ---- e-sign: pending with the provider's page, then the vendor's signed callback ----
    const pending = await start(s, "esign_agreement");
    assert.equal(pending.status, 201, pending.text);
    assert.deepEqual(Object.keys(pending.body).sort(), ["action", "redirect_url", "reference", "sandbox", "status"]);
    assert.equal(pending.body.status, "pending");
    assert.equal(pending.body.redirect_url, REDIRECT);
    const esignCall = vendor.state.seen.at(-1);
    assert.equal(esignCall.path, "/v1/esign");
    assert.deepEqual(esignCall.body.input, { full_name: NAME }, "only e-sign's declared inputs: never the PAN");
    const requestId = esignCall.body.request_id;
    const pendingCounts = await counts();
    const callback = (subscriptionId, payload, sig) => {
      const raw = JSON.stringify(payload);
      return api("POST", `/v1/vendor/callback/${subscriptionId}`, null, raw, { "Mynt-Signature": sig ?? signBody(secrets.esign, raw) });
    };
    const done = { request_id: requestId, status: "ok", output: { signature_status: "signed", signed_document_ref: "doc-signed-9" } };
    const esignSub = subs.esign.subscription_id;
    assert.equal((await callback(esignSub, done, signBody(secrets.pan_verification, JSON.stringify(done)))).status, 401, "another subscription's secret is refused");
    assert.equal((await callback(esignSub, done, signBody(secrets.esign, JSON.stringify(done), Math.floor(Date.now() / 1000) - 600))).status, 401, "a stale signature is refused");
    assert.equal((await callback(esignSub, done, "t=1,v1=" + "0".repeat(64))).status, 401);
    assert.equal((await callback(subs.pan_verification.subscription_id, done, signBody(secrets.pan_verification, JSON.stringify(done)))).status, 404, "the request belongs to the e-sign subscription");
    const badOutput = await callback(esignSub, { ...done, output: { signature_status: "maybe" } });
    assert.equal(badOutput.status, 400);
    assert.equal(badOutput.body.error, "invalid_output");
    assert.deepEqual(await counts(), pendingCounts, "nothing changes on a refused callback");
    assert.equal((await api("GET", `/v1/client/action_runs/${pending.body.reference}`, s)).body.status, "pending");
    const completed = await callback(esignSub, done);
    assert.equal(completed.status, 200, completed.text);
    assert.deepEqual(completed.body, { request_id: requestId, status: "completed" });
    const replay = await callback(esignSub, done);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.duplicate, true, "a replay is answered, not applied twice");
    const afterCallback = await counts();
    assert.equal(afterCallback.evidence, pendingCounts.evidence + 1);
    assert.equal(afterCallback.deliveries, pendingCounts.deliveries + 2, "one to the innovator, one (data-free) to the app");
    const finished = (await api("GET", `/v1/client/action_runs/${pending.body.reference}`, s)).body;
    assert.equal(finished.status, "completed");
    assert.equal(finished.redirect_url, undefined, "once finished, there is no page to send the device to");
    await deliverDueWebhooks(store);
    const signedHook = firmHook.received.find((r) => r.body.data.action === "esign_agreement");
    assert.deepEqual(signedHook.body.data.result, { signature_status: "signed", signed_document_ref: "doc-signed-9" });
    // The app hears that the asynchronous action finished: reference, action and status, no data.
    const appDone = appHook.received.find((r) => r.body.data.reference === pending.body.reference);
    assert.equal(appDone.body.type, "handoff.completed");
    assert.deepEqual(appDone.body.data, { product_id: "everyday-rd", reference: pending.body.reference, action: "esign_agreement", status: "completed", sandbox: true, app_id: app.id });
    const lastFirm = () => firmHook.received.at(-1).body;
    const lastApp = () => appHook.received.at(-1).body;
    const runOf = async (reference) => (await store.db.query("SELECT * FROM financial_products.vendor_action_runs WHERE id = $1", [reference])).rows[0];
    const requestOf = () => vendor.state.seen.at(-1).body.request_id;

    // ---- a service that answers at once but whose own status is pending stays open for the callback ----
    vendor.state.esign = "ok_pending";
    const before3 = await counts();
    const notYet = await start(s, "esign_agreement");
    assert.equal(notYet.status, 201, notYet.text);
    assert.equal(notYet.body.status, "pending");
    const notYetRequest = requestOf();
    assert.equal((await runOf(notYet.body.reference)).status, "pending");
    assert.equal((await runOf(notYet.body.reference)).result_sealed, null);
    const after3 = await counts();
    assert.equal(after3.evidence, before3.evidence, "no evidence until it finishes");
    assert.equal(after3.deliveries, before3.deliveries, "no event until it finishes");
    // ...and a signature that failed ends it as failed: action_failed evidence, vendor_action.failed with the result.
    const failedSig = await callback(esignSub, { request_id: notYetRequest, status: "ok", output: { signature_status: "failed" } });
    assert.deepEqual(failedSig.body, { request_id: notYetRequest, status: "failed" });
    assert.equal((await api("GET", `/v1/client/action_runs/${notYet.body.reference}`, s)).body.status, "failed");
    const failedEvidence = (await store.db.query("SELECT type FROM financial_products.client_evidence WHERE type IN ('action_completed', 'action_failed') ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(failedEvidence.type, "action_failed");
    await deliverDueWebhooks(store);
    assert.equal(lastFirm().type, "vendor_action.failed");
    assert.deepEqual(lastFirm().data.result, { signature_status: "failed" });
    assert.equal(lastApp().type, "handoff.failed");
    assert.equal(lastApp().data.status, "failed");

    // ---- consent withdrawn before the callback: nothing of the late answer is kept ----
    vendor.state.esign = "pending";
    const late = await start(s, "esign_agreement");
    const lateRequest = requestOf();
    await api("POST", "/v1/client/evidence", s, { product_id: "everyday-rd", type: "consent_withdrawn", subject: "document_esign" });
    const lateAnswer = await callback(esignSub, { request_id: lateRequest, status: "ok", output: { signature_status: "signed", signed_document_ref: "doc-signed-late" } });
    assert.deepEqual(lateAnswer.body, { request_id: lateRequest, status: "withdrawn" });
    const lateRun = await runOf(late.body.reference);
    assert.equal(lateRun.status, "withdrawn");
    assert.equal(lateRun.result_sealed, null);
    assert.equal((await api("GET", `/v1/client/action_runs/${late.body.reference}`, s)).body.status, "failed");
    await deliverDueWebhooks(store);
    assert.equal(lastFirm().type, "vendor_action.failed");
    assert.equal(lastFirm().data.error_code, "consent_withdrawn");
    assert.equal(lastFirm().data.result, undefined, "the innovator isn't sent what came after the withdrawal");
    assert.equal(lastApp().type, "handoff.failed");
    await consent(s, "document_esign");

    // ---- erasure: the customer's kept results and queued results go, and open actions can't fill anything ----
    const se = await session(key, "cust_erase");
    await consent(se, "identity_verification");
    await consent(se, "document_esign");
    await api("POST", "/v1/client/fields", se, { product_id: "everyday-rd", values: { pan: PAN }, source: "secure_field" });
    await api("POST", "/v1/client/fields", se, { product_id: "everyday-rd", values: { full_name: NAME } });
    const erasedDone = await start(se, "pan_check");
    assert.equal(erasedDone.body.status, "verified");
    const erasedOpen = await start(se, "esign_agreement");
    const erasedRequest = requestOf();
    const queuedFor = async () =>
      (await store.db.query("SELECT payload FROM financial_products.webhook_deliveries WHERE payload->'data'->>'customer_ref' = 'cust_erase'")).rows.map((r) => r.payload);
    assert.ok((await queuedFor()).some((p) => p.data.result_sealed), "queued sealed before erasure");
    assert.equal((await api("DELETE", "/v1/client/fields", se)).status, 200);
    assert.equal((await runOf(erasedDone.body.reference)).result_sealed, null, "the kept result is erased");
    assert.equal((await runOf(erasedOpen.body.reference)).status, "withdrawn", "an open action is stopped");
    assert.ok((await queuedFor()).every((p) => !p.data.result_sealed), "the queued result is erased");
    const afterErasure = await callback(esignSub, { request_id: erasedRequest, status: "ok", output: { signature_status: "signed" } });
    assert.equal(afterErasure.body.duplicate, true);
    assert.equal(afterErasure.body.status, "withdrawn");
    assert.deepEqual((await api("GET", "/v1/client/fields", se)).body.fields, []);
    await deliverDueWebhooks(store);
    const erasedEvent = firmHook.received.find((r) => r.body.data.reference === erasedDone.body.reference);
    assert.equal(erasedEvent.body.data.result, undefined, "delivered without the erased result");

    // ---- runs that never finish expire: a pending one after the expiry, a call cut short after minutes ----
    const stale = await start(s, "esign_agreement");
    await store.db.query(
      `INSERT INTO financial_products.vendor_action_runs (id, request_id, subscription_id, entity_id, app_id, session_id, product_id, contract_hash, action, service_type, customer_ref, sandbox, status, created_at)
       SELECT $2, $3, subscription_id, entity_id, app_id, session_id, product_id, contract_hash, action, service_type, customer_ref, sandbox, 'calling', now() - interval '10 minutes'
       FROM financial_products.vendor_action_runs WHERE id = $1`,
      [stale.body.reference, randomUUID(), randomUUID()],
    );
    assert.equal(await sweepVendorActionRuns(store), 1, "the cut-short call expires after minutes; the fresh pending one waits");
    assert.equal((await runOf(stale.body.reference)).status, "pending");
    assert.equal(await sweepVendorActionRuns(store, { now: new Date(Date.now() + 25 * 3600e3) }), 1);
    assert.equal((await runOf(stale.body.reference)).status, "expired");
    assert.equal((await api("GET", `/v1/client/action_runs/${stale.body.reference}`, s)).body.status, "failed");
    await deliverDueWebhooks(store);
    assert.equal(lastFirm().type, "vendor_action.failed");
    assert.equal(lastFirm().data.error_code, "expired");
    assert.equal(lastApp().type, "handoff.failed");
    assert.equal((await counts()).runs, (await store.db.query("SELECT count(*)::int AS n FROM financial_products.vendor_action_runs WHERE status NOT IN ('calling', 'pending')")).rows[0].n, "nothing left open");

    // ---- callback rate limits: per caller before the signature check, per subscription only once signed ----
    const forged = { request_id: randomUUID(), status: "ok", output: { signature_status: "signed" } };
    const post = (base, payload, sig) =>
      fetch(`${base}/v1/vendor/callback/${esignSub}`, { method: "POST", headers: { "Content-Type": "application/json", "Mynt-Signature": sig }, body: JSON.stringify(payload) }).then((r) => r.status);
    const perCaller = await runtimeServer({ callbackRateLimit: { perCaller: 3 } });
    const forgedSig = "t=1,v1=" + "0".repeat(64);
    assert.deepEqual([await post(perCaller, forged, forgedSig), await post(perCaller, forged, forgedSig), await post(perCaller, forged, forgedSig), await post(perCaller, forged, forgedSig)], [401, 401, 401, 429]);
    const perSub = await runtimeServer({ callbackRateLimit: { perSubscription: 1 } });
    for (let i = 0; i < 3; i++) assert.equal(await post(perSub, forged, forgedSig), 401, "unsigned callers don't use up the vendor's allowance");
    assert.equal(await post(perSub, forged, signBody(secrets.esign, JSON.stringify(forged))), 404);
    assert.equal(await post(perSub, forged, signBody(secrets.esign, JSON.stringify(forged))), 429);

    // ---- an unbound action keeps today's hand-off to the innovator's own flow ----
    await consent(s, "mandate_setup");
    const handoff = await start(s, "mandate_setup");
    assert.equal(handoff.status, 201, handoff.text);
    assert.match(handoff.body.handoff_id, /^[0-9a-f-]{36}$/);
    assert.equal(handoff.body.redirect_url, `https://mynt.test/v1/sandbox/handoffs/${handoff.body.handoff_id}`);

    // ---- live: its own endpoint and credential, only once the innovator turned the subscription live ----
    assert.equal((await ok(dev, "check_experience", { app_id: app.id })).ready, true);
    await ok(dev, "publish_app", { app_id: app.id });
    const liveKey = (await ok(dev, "create_api_key", { app_id: app.id, environment: "live", label: "live" })).key;
    const ls = await session(liveKey, "cust_live");
    await consent(ls, "identity_verification");
    await api("POST", "/v1/client/fields", ls, { product_id: "everyday-rd", values: { pan: PAN }, source: "secure_field" });
    const notLive = await start(ls, "pan_check");
    assert.equal(notLive.status, 503);
    assert.match(notLive.body.message, /isn't turned on for live use yet/);
    await ok(innovator, "set_subscription_live", { subscription_id: subs.pan_verification.subscription_id, live: true, live_credential: LIVE_CREDENTIAL });
    const liveBefore = vendor.state.seen.length;
    const liveRun = await start(ls, "pan_check");
    assert.equal(liveRun.status, 201, liveRun.text);
    assert.deepEqual(liveRun.body, { reference: liveRun.body.reference, action: "pan_check", status: "verified", sandbox: false });
    const liveCalls = vendor.state.seen.slice(liveBefore);
    assert.equal(liveCalls.length, 1);
    assert.equal(liveCalls[0].path, "/live/v1/pan_verification", "the live endpoint");
    assert.equal(liveCalls[0].authorization, `Bearer ${LIVE_CREDENTIAL}`, "with the live credential");
    assert.equal(liveCalls[0].body.environment, "live");
    assert.ok(vendor.state.seen.filter((x) => !x.path.startsWith("/live/")).every((x) => x.authorization !== `Bearer ${LIVE_CREDENTIAL}`), "test calls never carry the live credential");
    await deliverDueWebhooks(store);
    const liveHook = firmHook.received.at(-1);
    assert.equal(liveHook.body.data.sandbox, false);
    assert.equal(liveHook.body.data.reference, liveRun.body.reference);
    assert.equal((await api("GET", `/v1/client/action_runs/${liveRun.body.reference}`, s)).status, 404, "a sandbox session can't read a live run");
  } finally {
    Object.assign(console, original);
  }

  // ---- nothing secret or personal reaches devices or logs ----
  for (const text of deviceResponses) {
    for (const hidden of [PAN, NAME, "pan_status", "name_match", "signed_document_ref", "doc-signed", CREDENTIAL, LIVE_CREDENTIAL, secrets.pan_verification, secrets.esign, hook.secret])
      assert.ok(!text.includes(hidden), `a device response carried ${hidden}: ${text}`);
  }
  for (const line of printed)
    for (const hidden of [PAN, NAME, CREDENTIAL, LIVE_CREDENTIAL, secrets.pan_verification, secrets.esign, hook.secret, "doc-signed"]) assert.ok(!line.includes(hidden), `logged ${hidden}: ${line}`);
  const audit = JSON.stringify((await store.db.query("SELECT details FROM financial_products.audit_log")).rows);
  assert.ok(!audit.includes(PAN) && !audit.includes(CREDENTIAL) && !audit.includes(hook.secret));
});
