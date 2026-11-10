import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, randomBytes, randomUUID, sign as edSign, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The partner integration kit: a licence provider connects its ledger (an HTTPS feed Mynt pulls, or a signed daily
// file it uploads), Mynt tests it the way it tests vendors, and only a passed ledger lets a firm leave the sandbox.
// The partner here is a server on 127.0.0.1 that speaks the contract in docs/partners.md.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
// These tests' licence-provider accounts are minutes old: the partner kit's member cool-off (tested on its own in
// partner-kit.test.js) is off here, so they can register keys straight away.
process.env.PARTNER_MEMBER_COOLOFF_HOURS ??= "0";

const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { ProductHealthService, canonicalJson } = await import("../dist/product-health.js");
const { partnerLedgerFor } = await import("../dist/partner-kit.js");
const { checkStatement, statementMessage } = await import("../dist/partner-ledger/contract.js");
const { schemaProblems } = await import("../dist/vendors.js");
const { base58Encode } = await import("../dist/solana/codec.js");
const { seal } = await import("../dist/vault.js");
const { CATALOG } = await import("./helpers.js");

const OPTS = { allowInsecureLoopback: true, timeoutMs: 2000 };
const HOUR = 3_600_000;
const closers = [];
after(() => closers.forEach((c) => c()));

const edKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, address: base58Encode(Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url")) };
};

// A statement as a partner builds it: canonical JSON without the signature, signed with its Ed25519 key.
const signStatement = (unsigned, key) => {
  const message = Buffer.concat([Buffer.from("mynt.partner_ledger.v1", "utf8"), Buffer.from([0]), Buffer.from(canonicalJson(unsigned), "utf8")]);
  return { ...unsigned, signature: { public_key: key.address, value: edSign(null, message, key.privateKey).toString("hex") } };
};

// The partner's ledger endpoint, as docs/partners.md describes it.
// Each deployment (here /test and /live on one port) knows its own environment and its own URL, signs with that
// environment's key, and refuses a request for the other environment or meant for another URL.
async function partnerServer(entityId, keys) {
  const state = {
    secret: null,
    // ok | wrong_key | test_key_on_live | stale | float | null_no_reason | zero_unknown | env_flip | accept_any |
    // accept_stale | accept_any_env | ignore_audience
    mode: "ok",
    omit: [],
    nulls: {}, // product_id -> reason: answer that product null
    known: new Set(),
    seen: [],
  };
  const verify = (header, raw) => {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
    if (!m || !state.secret) return false;
    if (state.mode !== "accept_stale" && Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
    const want = createHmac("sha256", state.secret).update(`${m[1]}.${raw}`).digest();
    return timingSafeEqual(want, Buffer.from(m[2], "hex"));
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const env = req.url.startsWith("/live/") ? "live" : "test";
    const own = `http://127.0.0.1:${server.address().port}${req.url}`;
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const signed = verify(req.headers["mynt-signature"], raw);
    const body = JSON.parse(raw || "{}");
    state.seen.push({ env, path: req.url, signed, audience: body.audience ?? null });
    if (!signed && state.mode !== "accept_any") return reply(401, { error: { code: "bad_signature", message: "no" } });
    if (!Array.isArray(body.product_ids)) return reply(400, { error: { code: "bad_request", message: "no" } });
    if (body.environment !== env && state.mode !== "accept_any_env") return reply(400, { error: { code: "wrong_environment", message: "no" } });
    if (body.audience !== own && state.mode !== "ignore_audience") return reply(400, { error: { code: "wrong_audience", message: "no" } });
    const products = body.product_ids
      .filter((id) => !state.omit.includes(id))
      .map((id) => {
        if (state.nulls[id]) return { product_id: id, reserves_held_cents: null, customer_obligations_cents: null, reason: state.mode === "null_no_reason" ? null : state.nulls[id] };
        if (!state.known.has(id)) return state.mode === "zero_unknown" ? { product_id: id, reserves_held_cents: 0, customer_obligations_cents: 0, reason: null } : { product_id: id, reserves_held_cents: null, customer_obligations_cents: null, reason: "unknown_product" };
        return { product_id: id, reserves_held_cents: state.mode === "float" ? 150.5 : 150_00, customer_obligations_cents: 100_00, reason: null };
      });
    const asOf = state.mode === "stale" ? new Date(Date.now() - 48 * HOUR) : new Date();
    const unsigned = { schema: "mynt.partner_ledger.v1", provider_entity_id: entityId, environment: state.mode === "env_flip" ? "test" : env, request_id: body.request_id, as_of: asOf.toISOString(), products };
    if (state.mode === "float") return reply(200, { ...unsigned, signature: { public_key: keys.live.address, value: "0".repeat(128) } });
    const key = state.mode === "wrong_key" ? edKey() : state.mode === "live_key_on_test" ? keys.live : state.mode === "test_key_on_live" || unsigned.environment === "test" ? keys.test : keys.live;
    reply(200, signStatement(unsigned, key));
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  closers.push(() => (server.closeAllConnections(), server.close()));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}

async function world() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  let clock = Date.now();
  let health = null;
  health = await ProductHealthService.open(db, store, { intervalMs: HOUR, cosignWindowMs: 10 * 60_000, pollMs: 60_000, programId: null }, {
    chain: null,
    ledgerFor: partnerLedgerFor(store, { signingKeyOf: (id) => health.signingKey(id), opts: OPTS }),
    now: () => new Date(clock),
  });
  const firm = async (name, roles) => {
    const entity = await store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });
    const { user } = await store.createUser(`${name} person`, roles);
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    return { entity, user };
  };
  const lp = await firm("Partner Bank", ["license_provider"]);
  const builder = await firm("Builder Co", ["innovator"]);
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const [a, b] = await store.publishedProducts();
  const sponsorships = [];
  for (const p of [a, b]) {
    const s = await store.requestSponsorship(builder.user.id, { product_id: p.id, component_key: "core", builder_entity_id: builder.entity.id, provider_entity_id: lp.entity.id, requested_jurisdictions: [], note: null });
    sponsorships.push(await store.decideSponsorship(s.id, { status: "approved", decided_by: lp.user.id, note: null }));
  }
  const products = [a.id, b.id].sort();
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { productHealth: health, vendors: OPTS }).connect(s);
    const client = new Client({ name: "partner-kit", version: "0" });
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
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const refused = async (client, name, args, pattern) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, true, `${name} should be refused: ${JSON.stringify(r.data)}`);
    if (pattern) assert.match(JSON.stringify(r.data), pattern);
    return r.data;
  };
  const provider = await connect(lp.user);
  const admin = await connect(adminUser);
  const key = edKey();
  const testKey = edKey();
  await ok(provider, "register_partner_signing_key", { public_key: key.address });
  await ok(provider, "register_partner_test_signing_key", { public_key: testKey.address });
  const partner = await partnerServer(lp.entity.id, { live: key, test: testKey });
  partner.state.known = new Set(products);
  // An admin proposes the endpoints; the firm's own member confirms them and takes the secret.
  const propose = (test_url, live_url) => ok(admin, "configure_partner_ledger", { entity_id: lp.entity.id, test_url, live_url });
  const confirm = (test_url, live_url) => ok(provider, "confirm_partner_ledger_endpoints", { test_url, live_url });
  const connectHttp = async () => {
    await propose(`${partner.url}/test`, `${partner.url}/live`);
    await confirm(`${partner.url}/test`, `${partner.url}/live`);
    partner.state.secret = (await ok(provider, "reveal_partner_ledger_secret")).secret;
  };
  const tick = async (advance = HOUR) => {
    clock += advance;
    await health.tick();
  };
  const latest = async (productId) => (await health.get(lp.user, productId, null, 1)).latest.report;
  const conformance = (source = "http") => ok(provider, "run_partner_conformance", { source });
  const caseOf = (run, name) => run.ledger.cases.find((c) => c.case === name);
  const statement = (over = {}, k = key) =>
    signStatement({ schema: "mynt.partner_ledger.v1", provider_entity_id: lp.entity.id, environment: "live", request_id: null, as_of: new Date(clock).toISOString(), products: products.map((id) => ({ product_id: id, reserves_held_cents: 150_00, customer_obligations_cents: 100_00, reason: null })), ...over }, k);
  return { pg, store, health, lp, builder, adminUser, products, sponsorships, provider, admin, key, testKey, partner, propose, confirm, connectHttp, tick, latest, conformance, caseOf, statement, call, ok, refused, connect, setClock: (t) => (clock = t), clock: () => clock };
}

test("the shipped schemas are JSON, and a signed statement passes them", async () => {
  for (const f of ["statement.v1.schema.json", "request.v1.schema.json", "error.v1.schema.json"]) JSON.parse(readFileSync(new URL(`../schemas/partner-ledger/${f}`, import.meta.url), "utf8"));
  const schema = JSON.parse(readFileSync(new URL("../schemas/partner-ledger/statement.v1.schema.json", import.meta.url), "utf8"));
  const key = edKey();
  const s = signStatement({ schema: "mynt.partner_ledger.v1", provider_entity_id: randomUUID(), environment: "live", request_id: null, as_of: new Date().toISOString(), products: [{ product_id: "p1", reserves_held_cents: 1, customer_obligations_cents: null, reason: "reconciling" }] }, key);
  assert.deepEqual(schemaProblems(schema, s), []);
  // A null figure without its reason, a float, or a string where cents go: all refused by the schema itself.
  assert.ok(schemaProblems(schema, { ...s, products: [{ product_id: "p1", reserves_held_cents: null, customer_obligations_cents: 1, reason: null }] }).length);
  assert.ok(schemaProblems(schema, { ...s, products: [{ product_id: "p1", reserves_held_cents: 1.5, customer_obligations_cents: 1, reason: null }] }).length);
  assert.ok(schemaProblems(schema, { ...s, products: [{ product_id: "p1", reserves_held_cents: "100", customer_obligations_cents: 1, reason: null }] }).length);
  // The signature covers every member but itself: change one figure and it fails.
  const x = { entity_id: s.provider_entity_id, environment: "live", request_id: null, public_key: key.address, now: new Date(), max_age_ms: HOUR, product_ids: ["p1"] };
  assert.equal(checkStatement(s, x).ok, true);
  assert.equal(statementMessage(s).length, statementMessage({ ...s, signature: undefined }).length);
  const tampered = { ...s, products: [{ ...s.products[0], reserves_held_cents: 2 }] };
  assert.deepEqual(checkStatement(tampered, x).cases.filter((c) => !c.passed).map((c) => c.case), ["signature"]);
});

test("contract happy path: conformance passes, and switching from sandbox to live reads the partner's books", async () => {
  const w = await world();
  await w.tick();
  assert.equal((await w.latest(w.products[0])).source, "sandbox", "before the partner is connected, its source is the sandbox");

  await w.connectHttp();
  const run = await w.conformance("http");
  assert.equal(run.ledger.passed, true, JSON.stringify(run.ledger.cases));
  assert.equal(run.can_go_live, true);
  for (const c of ["setup", "answer", "schema", "identity", "signature", "clock", "null_handling", "coverage", "unknown_product_null", "bad_signature_refused", "stale_request_refused", "malformed_request_refused", "wrong_environment_refused", "wrong_audience_refused", "live_wrong_audience_refused"])
    assert.equal(w.caseOf(run, c)?.passed, true, c);
  // (b) and (c) are reported: this firm accepts no identity provider and has no rail yet.
  assert.equal(run.identity.passed, false);
  assert.match(run.identity.problems[0], /accept no identity provider/);
  assert.equal(run.rails.passed, false);
  assert.equal(run.passed, false);
  // Conformance reads the test endpoint; the live endpoint gets only the audience probe, which asks for no figures.
  const liveCalls = w.partner.state.seen.filter((s) => s.env === "live");
  assert.equal(liveCalls.length, 1);
  assert.equal(liveCalls[0].audience, `${w.partner.url}/test/v1/ledger`);

  const switched = await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  assert.equal(switched.live, true);
  assert.ok(w.partner.state.seen.some((s) => s.env === "live" && s.signed), "switching reads the live endpoint once, signed");
  await w.tick();
  const r = await w.latest(w.products[0]);
  assert.equal(r.source, "partner_ledger");
  assert.equal(r.partner.ledger, "partner_http");
  assert.equal(r.figures.reserves_cents.value, 150_00);
  assert.equal(r.figures.obligations_cents.value, 100_00);
  assert.equal(r.figures.coverage_bps.value, 15_000);
  assert.ok(r.ledger_as_of);

  // The firm sees its source and the run with its time; an admin sees pass or fail and never a figure.
  const mine = await w.ok(w.provider, "get_my_entity");
  assert.equal(mine.partner_kit.ledger_source, "http");
  assert.equal(mine.partner_kit.live, true);
  assert.ok(mine.partner_kit.last_conformance.http.at);
  const seen = await w.ok(w.admin, "get_partner_kit", { entity_id: w.lp.entity.id });
  assert.equal(seen.live, true);
  assert.equal(seen.conformance_runs[0].ledger_passed, true);
  assert.doesNotMatch(JSON.stringify(seen), /15000|reserves_held_cents|customer_obligations_cents/);
  // An admin can't read the numbers through product health either.
  assert.equal((await w.call(w.admin, "get_product_health", { product_id: w.products[0] })).isError, true);
});

test("conformance gates going live; changing the endpoints puts the firm back on the sandbox", async () => {
  const w = await world();
  await w.connectHttp();
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /hasn't passed its ledger part/);
  await w.refused(w.provider, "set_partner_ledger_source", { source: "file" }, /hasn't passed its ledger part/);
  // An admin can't switch a firm to live, and has no upload or secret tools.
  await w.refused(w.admin, "set_partner_ledger_source", { source: "http", entity_id: w.lp.entity.id }, /only send it back to sandbox/);
  const adminTools = (await w.admin.listTools()).tools.map((t) => t.name);
  for (const t of ["upload_partner_ledger_file", "reveal_partner_ledger_secret", "rotate_partner_ledger_secret"]) assert.ok(!adminTools.includes(t), t);
  // The secret is shown once.
  await w.refused(w.provider, "reveal_partner_ledger_secret", {}, /already shown once/);

  // A failing run doesn't open the gate.
  w.partner.state.mode = "wrong_key";
  assert.equal((await w.conformance()).ledger.passed, false);
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /hasn't passed/);
  w.partner.state.mode = "ok";
  assert.equal((await w.conformance()).ledger.passed, true);
  // A live endpoint that doesn't answer properly still keeps the firm off live.
  w.partner.state.mode = "env_flip";
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /live endpoint's statement/);
  w.partner.state.mode = "ok";
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  assert.equal((await w.health.ledgerIsLive(w.lp.entity.id)), true);

  // An admin's change waits for the firm: nothing moves until its own member confirms it.
  const moved = await w.propose(`${w.partner.url}/test`, `${w.partner.url}/live/v2`);
  assert.equal(moved.status, "pending_confirmation");
  assert.equal(await w.health.ledgerIsLive(w.lp.entity.id), true);
  await w.refused(w.provider, "confirm_partner_ledger_endpoints", { test_url: `${w.partner.url}/test`, live_url: `${w.partner.url}/live` }, /aren't the URLs proposed/);
  const confirmed = await w.confirm(`${w.partner.url}/test`, `${w.partner.url}/live/v2`);
  assert.equal(confirmed.ledger_source, "sandbox");
  assert.equal(await w.health.ledgerIsLive(w.lp.entity.id), false);
  await w.tick();
  assert.equal((await w.latest(w.products[0])).source, "sandbox");
  // An admin can always send a firm back to sandbox; endpoints must be public HTTPS and different.
  await w.refused(w.admin, "configure_partner_ledger", { entity_id: w.lp.entity.id, test_url: "https://10.0.0.1/x", live_url: "https://10.0.0.2/x" }, /private/);
  await w.refused(w.admin, "configure_partner_ledger", { entity_id: w.lp.entity.id, test_url: `${w.partner.url}/same`, live_url: `${w.partner.url}/same/` }, /different endpoints/);
  // An origin and a path only: no query string, no fragment.
  await w.refused(w.admin, "configure_partner_ledger", { entity_id: w.lp.entity.id, test_url: `${w.partner.url}/t?x=1`, live_url: `${w.partner.url}/l` }, /no query string or fragment/);
  await w.refused(w.admin, "configure_partner_ledger", { entity_id: w.lp.entity.id, test_url: `${w.partner.url}/t`, live_url: `${w.partner.url}/l#frag` }, /no query string or fragment/);
  await w.ok(w.admin, "set_partner_ledger_source", { source: "sandbox", entity_id: w.lp.entity.id });
});

test("bad signature: a statement signed with another key fails, and a live read of one is unavailable, never a number", async () => {
  const w = await world();
  await w.connectHttp();
  w.partner.state.mode = "wrong_key";
  const run = await w.conformance();
  assert.equal(w.caseOf(run, "signature").passed, false);
  assert.match(w.caseOf(run, "signature").problems[0], /other than your firm's registered/);

  // A partner that answers requests Mynt didn't sign fails conformance too.
  w.partner.state.mode = "accept_any";
  assert.equal(w.caseOf(await w.conformance(), "bad_signature_refused").passed, false);

  w.partner.state.mode = "ok";
  await w.conformance();
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  w.partner.state.mode = "wrong_key";
  await w.tick();
  const r = await w.latest(w.products[0]);
  assert.equal(r.source, "unavailable");
  assert.equal(r.live, false);
  assert.equal(r.figures.reserves_cents.value, null);
  assert.match(r.figures.reserves_cents.reason, /statement_signature/);
});

test("stale: an old as_of fails the clock check, and a partner accepting stale requests fails conformance", async () => {
  const w = await world();
  await w.connectHttp();
  w.partner.state.mode = "stale";
  const run = await w.conformance();
  assert.equal(w.caseOf(run, "clock").passed, false);
  assert.match(w.caseOf(run, "clock").problems[0], /hours old/);
  w.partner.state.mode = "accept_stale";
  assert.equal(w.caseOf(await w.conformance(), "stale_request_refused").passed, false);
});

test("schema violation: floats and null figures without a reason are refused", async () => {
  const w = await world();
  await w.connectHttp();
  w.partner.state.mode = "float";
  const run = await w.conformance();
  assert.equal(w.caseOf(run, "schema").passed, false);
  assert.equal(run.ledger.passed, false);
  w.partner.state.mode = "null_no_reason";
  w.partner.state.nulls = { [w.products[0]]: "x" };
  assert.equal(w.caseOf(await w.conformance(), "schema").passed, false);
});

test("partial coverage: a product left out fails conformance, and reads null with a reason once live", async () => {
  const w = await world();
  await w.connectHttp();
  w.partner.state.omit = [w.products[1]];
  const run = await w.conformance();
  const coverage = w.caseOf(run, "coverage");
  assert.equal(coverage.passed, false);
  assert.match(coverage.problems[0], new RegExp(w.products[1]));
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /hasn't passed/);

  w.partner.state.omit = [];
  await w.conformance();
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  w.partner.state.omit = [w.products[1]];
  await w.tick();
  assert.equal((await w.latest(w.products[0])).figures.reserves_cents.value, 150_00);
  const left = await w.latest(w.products[1]);
  assert.equal(left.source, "partner_ledger");
  assert.equal(left.figures.reserves_cents.value, null);
  assert.match(left.figures.reserves_cents.reason, /didn't cover this product/);
  assert.equal(left.figures.coverage_bps.value, null);
});

test("nulls: a figure the partner can't give stays null with its reason; an unknown product answered 0 fails", async () => {
  const w = await world();
  await w.connectHttp();
  w.partner.state.mode = "zero_unknown";
  const run = await w.conformance();
  assert.equal(w.caseOf(run, "unknown_product_null").passed, false);
  assert.match(w.caseOf(run, "unknown_product_null").problems[0], /never 0/);

  w.partner.state.mode = "ok";
  await w.conformance();
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  w.partner.state.nulls = { [w.products[0]]: "Reconciliation still running" };
  await w.tick();
  const r = await w.latest(w.products[0]);
  assert.equal(r.source, "partner_ledger");
  assert.equal(r.figures.reserves_cents.value, null);
  assert.equal(r.figures.reserves_cents.reason, "Reconciliation still running");
  assert.equal(r.figures.obligations_cents.value, null);
});

test("the daily file: signed, checked, sealed, and the ledger once it passes and the firm switches", async () => {
  const w = await world();
  const tools = (await w.provider.listTools()).tools.map((t) => t.name);
  assert.ok(tools.includes("upload_partner_ledger_file"));

  await w.refused(w.provider, "upload_partner_ledger_file", { statement: w.statement({}, edKey()) }, /signature/);
  await w.refused(w.provider, "upload_partner_ledger_file", { statement: w.statement({ as_of: new Date(w.clock() - 48 * HOUR).toISOString() }) }, /clock/);
  await w.refused(w.provider, "upload_partner_ledger_file", { statement: w.statement({ request_id: "r1" }) }, /request_id must be null/);
  await w.refused(w.provider, "upload_partner_ledger_file", { statement: w.statement({ provider_entity_id: randomUUID() }) }, /isn't your firm's/);

  // A test file passes conformance, but never reads as live.
  const testFile = await w.ok(w.provider, "upload_partner_ledger_file", { statement: w.statement({ environment: "test", as_of: new Date(w.clock() - 60_000).toISOString() }, w.testKey) });
  assert.equal(testFile.environment, "test");
  assert.deepEqual(testFile.missing, []);
  const run = await w.conformance("file");
  assert.equal(run.ledger.passed, true, JSON.stringify(run.ledger.cases));
  await w.refused(w.provider, "set_partner_ledger_source", { source: "file" }, /live daily file/);

  const live = await w.ok(w.provider, "upload_partner_ledger_file", { statement: w.statement({ products: [{ product_id: w.products[0], reserves_held_cents: 90_00, customer_obligations_cents: 100_00, reason: null }] }) });
  assert.deepEqual(live.missing, [w.products[1]]);
  await w.refused(w.provider, "upload_partner_ledger_file", { statement: w.statement({ as_of: new Date(w.clock() - 120_000).toISOString() }) }, /newer one/);
  await w.ok(w.provider, "set_partner_ledger_source", { source: "file" });
  await w.tick();
  const r = await w.latest(w.products[0]);
  assert.equal(r.source, "partner_ledger");
  assert.equal(r.partner.ledger, "partner_file");
  assert.equal(r.figures.reserves_cents.value, 90_00);
  assert.equal(r.figures.coverage_bps.value, 9_000);
  assert.match((await w.latest(w.products[1])).figures.reserves_cents.reason, /didn't cover/);

  // Sealed at rest, and admins see only times and counts.
  const rows = (await w.pg.query("SELECT statement_sealed FROM financial_products.partner_ledger_uploads")).rows;
  assert.ok(rows.every((x) => !/9000|reserves/.test(x.statement_sealed)));
  const kit = await w.ok(w.admin, "get_partner_kit", { entity_id: w.lp.entity.id });
  assert.equal(kit.daily_files.length, 2);
  assert.doesNotMatch(JSON.stringify(kit), /9000|reserves_held_cents/);

  // A file past its maximum age stops counting on its own: the snapshot is unavailable, not the old numbers.
  await w.tick(40 * HOUR);
  const old = await w.latest(w.products[0]);
  assert.equal(old.source, "unavailable");
  assert.match(old.figures.reserves_cents.reason, /daily_file_stale/);
});

test("identity: an accepted provider must return residential_state on a passed test check", async () => {
  const w = await world();
  const idv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ request_id: body.request_id, status: "ok", output: idvState.output, error: null }));
  });
  const idvState = { output: { result: "match", residential_state: "us-ny" } };
  idv.listen(0, "127.0.0.1");
  await new Promise((r) => idv.once("listening", r));
  closers.push(() => (idv.closeAllConnections(), idv.close()));
  await w.pg.query(
    `INSERT INTO financial_products.service_types (region, key, name, category, input_schema, output_schema, consent_purpose, fixtures, client_result) VALUES ('US', 'idv_test', 'Identity', 'identity', '{}', $1, 'identity_verification', '[{}]', $2)`,
    [
      JSON.stringify({ type: "object", required: ["result"], properties: { result: { enum: ["match", "no_match"] }, residential_state: { type: "string" } } }),
      JSON.stringify({ status: { from: "result", map: { match: "verified", no_match: "not_verified" } }, fields: [], redirect: false }),
    ],
  );
  const vendor = await w.store.createEntity(null, { name: "IDV Co", registration_numbers: {}, regions: ["US"] });
  const offering = randomUUID();
  await w.pg.query(
    `INSERT INTO financial_products.vendor_offerings (id, entity_id, region, service_type, name, test_base_url, price, licence_ids, conformance_secret, status) VALUES ($1, $2, 'US', 'idv_test', 'IDV', $3, '{"amount":0,"currency":"USD"}', '{}', $4, 'listed')`,
    [offering, vendor.id, `http://127.0.0.1:${idv.address().port}`, seal("conformance-secret", false)],
  );
  await w.pg.query(`INSERT INTO financial_products.sponsorship_identity_providers (sponsorship_id, offering_id, approved_by) VALUES ($1, $2, $3)`, [w.sponsorships[0].id, offering, w.lp.user.id]);

  const run = await w.conformance("file");
  assert.equal(run.identity.passed, true, JSON.stringify(run.identity));
  assert.equal(run.identity.providers[0].offering_id, offering);

  idvState.output = { result: "match" };
  const missing = await w.conformance("file");
  assert.equal(missing.identity.passed, false);
  assert.match(missing.identity.providers[0].problems[0], /without a valid residential_state/);
  // Each run is kept with its time, newest first.
  const kit = await w.ok(w.provider, "get_partner_kit");
  assert.equal(kit.conformance_runs.length, 2);
  assert.ok(new Date(kit.conformance_runs[0].at) >= new Date(kit.conformance_runs[1].at));
  assert.equal(kit.conformance_runs[0].identity_passed, false);
});

// ---- review fixes: test books never live, no relaying, endpoint changes wait for the firm ----

test("test books can't be read as live: a separate test key, and each deployment refuses the other environment", async () => {
  const w = await world();
  // The two keys must differ, whichever is registered second.
  await w.refused(w.provider, "register_partner_test_signing_key", { public_key: w.key.address }, /different key/);
  await w.refused(w.provider, "register_partner_signing_key", { public_key: w.testKey.address }, /test signing key/);

  await w.connectHttp();
  // A test deployment signing with the live key fails, and says so.
  w.partner.state.mode = "live_key_on_test";
  const liveOnTest = await w.conformance();
  assert.equal(w.caseOf(liveOnTest, "signature").passed, false);
  assert.match(w.caseOf(liveOnTest, "signature").problems[0], /signed with your live key/);
  // A test deployment that answers a live request fails.
  w.partner.state.mode = "accept_any_env";
  assert.equal(w.caseOf(await w.conformance(), "wrong_environment_refused").passed, false);

  w.partner.state.mode = "ok";
  assert.equal((await w.conformance()).ledger.passed, true);
  // The switch-time live read refuses a statement signed with the test key.
  w.partner.state.mode = "test_key_on_live";
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /statement_signature/);
  w.partner.state.mode = "ok";
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  // And once live, a statement signed with the test key reads as unavailable, never as live figures.
  w.partner.state.mode = "test_key_on_live";
  await w.tick();
  const r = await w.latest(w.products[0]);
  assert.equal(r.source, "unavailable");
  assert.equal(r.figures.reserves_cents.value, null);

  // A live daily file signed with the test key is refused at upload.
  const refused = await w.refused(w.provider, "upload_partner_ledger_file", { statement: w.statement({}, w.testKey) }, /signature/);
  assert.match(JSON.stringify(refused), /signed with your test key/);
});

test("a relayed request is refused by the partner, and an admin's endpoint change waits for the firm", async () => {
  const w = await world();
  await w.store.createFirmWebhook(w.lp.user.id, { entity_id: w.lp.entity.id, url: "https://hooks.example.com/mynt", events: ["partner_ledger.endpoint_change_pending", "partner_ledger.source_changed"] });
  const delivered = async (type) => (await w.pg.query("SELECT payload FROM financial_products.webhook_deliveries")).rows.filter((d) => (typeof d.payload === "string" ? JSON.parse(d.payload) : d.payload).type === type);
  await w.connectHttp();
  // A partner that doesn't check the audience fails conformance.
  w.partner.state.mode = "ignore_audience";
  const careless = await w.conformance();
  assert.equal(w.caseOf(careless, "wrong_audience_refused").passed, false);
  // The live endpoint is probed too, with a made-up product only, so no live figure is asked for.
  assert.equal(w.caseOf(careless, "live_wrong_audience_refused").passed, false);
  assert.ok(w.partner.state.seen.some((x) => x.env === "live" && x.audience === `${w.partner.url}/test/v1/ledger`));
  w.partner.state.mode = "ok";
  await w.conformance();
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });

  // A relay that forwards Mynt's signed request, untouched, to the partner's real live endpoint.
  const relayed = [];
  const relay = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    relayed.push(raw);
    const upstream = await fetch(`${w.partner.url}/live/v1/ledger`, { method: "POST", headers: { "content-type": "application/json", "mynt-signature": req.headers["mynt-signature"] }, body: raw });
    res.writeHead(upstream.status, { "Content-Type": "application/json" });
    res.end(await upstream.text());
  });
  relay.listen(0, "127.0.0.1");
  await new Promise((r) => relay.once("listening", r));
  closers.push(() => (relay.closeAllConnections(), relay.close()));
  const relayUrl = `http://127.0.0.1:${relay.address().port}/relay`;

  // The admin's change is only a proposal: shown plainly, sent to the firm's webhooks, and nothing moves.
  await w.propose(`${w.partner.url}/test`, relayUrl);
  assert.equal((await delivered("partner_ledger.endpoint_change_pending")).length, 2, "one for each proposal: the first setup and this one");
  const kit = await w.ok(w.provider, "get_partner_kit");
  assert.equal(kit.pending_endpoint_change.live_url, relayUrl);
  assert.equal(kit.endpoints.live_url, `${w.partner.url}/live`);
  assert.equal(kit.live, true);
  await w.tick();
  assert.equal((await w.latest(w.products[0])).source, "partner_ledger");
  assert.equal(relayed.length, 0, "the proposed endpoint isn't called before the firm confirms it");

  // Even if the firm confirms it, the partner refuses the relayed request: its audience is the relay's URL.
  await w.confirm(`${w.partner.url}/test`, relayUrl);
  assert.equal(await w.health.ledgerIsLive(w.lp.entity.id), false);
  await w.conformance();
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /http_400/);
  // Two requests reached the relay: conformance's live audience probe, and the switch's live read. Both refused.
  assert.equal(relayed.length, 2);
  assert.equal(w.partner.state.seen.at(-1).audience, `${relayUrl}/v1/ledger`);

  // An admin sending the firm back to sandbox tells the firm.
  await w.ok(w.admin, "set_partner_ledger_source", { source: "sandbox", entity_id: w.lp.entity.id });
  const changes = (await delivered("partner_ledger.source_changed")).map((d) => (typeof d.payload === "string" ? JSON.parse(d.payload) : d.payload).data);
  assert.equal(changes.filter((d) => d.by === "admin").length, 1);
});

test("a daily file counts only under the firm's current live key", async () => {
  const w = await world();
  await w.ok(w.provider, "upload_partner_ledger_file", { statement: w.statement() });
  assert.equal((await w.conformance("file")).ledger.passed, true);
  await w.ok(w.provider, "set_partner_ledger_source", { source: "file" });
  await w.tick();
  assert.equal((await w.latest(w.products[0])).source, "partner_ledger");
  // The firm replaces its live key: the file signed with the old one stops counting at once.
  await w.ok(w.provider, "register_partner_signing_key", { public_key: edKey().address });
  await w.tick();
  const r = await w.latest(w.products[0]);
  assert.equal(r.source, "unavailable");
  assert.match(r.figures.reserves_cents.reason, /daily_file_signature/);
});

test("one live request per firm per round, covering every product it sponsors", async () => {
  const w = await world();
  await w.connectHttp();
  await w.conformance();
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  const before = w.partner.state.seen.length;
  await w.tick();
  const live = w.partner.state.seen.slice(before).filter((s) => s.env === "live");
  assert.equal(live.length, 1, "two products, one request");
  for (const p of w.products) assert.equal((await w.latest(p)).source, "partner_ledger");
});

test("conformance passes run out, and an inactive firm can't use the kit", async () => {
  const w = await world();
  await w.connectHttp();
  const run = await w.conformance();
  assert.ok(run.expires_at);
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  await w.pg.query("UPDATE financial_products.partner_conformance_runs SET created_at = now() - interval '40 days'");
  assert.equal(await w.health.ledgerIsLive(w.lp.entity.id), false, "a pass that ran out doesn't keep a firm live");
  const kit = await w.ok(w.provider, "get_partner_kit");
  assert.equal(kit.live, false);
  assert.match(kit.note, /ran out/);
  await w.refused(w.provider, "set_partner_ledger_source", { source: "http" }, /run out/);

  await w.store.setEntityStatus(w.lp.entity.id, "suspended");
  await w.refused(w.provider, "run_partner_conformance", { source: "http" }, /isn't active/);
  await w.refused(w.provider, "register_partner_signing_key", { public_key: edKey().address }, /isn't active/);
  await w.refused(w.provider, "register_partner_test_signing_key", { public_key: edKey().address }, /isn't active/);
});

test("a ledger Mynt can't tell is unknown, never sandbox", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const health = await ProductHealthService.open(db, store, { intervalMs: HOUR, cosignWindowMs: 60_000, pollMs: 60_000, programId: null }, {
    chain: null,
    ledgerFor: async () => {
      throw new Error("database down");
    },
  });
  assert.equal(await health.ledgerState(randomUUID()), "unknown");
  assert.equal(await health.ledgerIsLive(randomUUID()), false);
});

// ---- puppet members: the cool-off, notices, and a second member's approval ----

const backdate = (w, userId, days = 10) => w.pg.query("UPDATE financial_products.users SET created_at = now() - make_interval(days => $2), entity_joined_at = now() - make_interval(days => $2) WHERE id = $1", [userId, days]);
const withCoolOff = async (hours, f) => {
  const was = process.env.PARTNER_MEMBER_COOLOFF_HOURS;
  process.env.PARTNER_MEMBER_COOLOFF_HOURS = String(hours);
  try {
    return await f();
  } finally {
    process.env.PARTNER_MEMBER_COOLOFF_HOURS = was;
  }
};
const noticesOf = async (w, client) => w.ok(client, "list_firm_notices", {});

test("a member who just joined can't change what Mynt reads as the firm's books, and the firm is told who joined", async () => {
  const w = await world();
  await w.connectHttp();
  await w.conformance();
  await w.ok(w.admin, "configure_partner_ledger", { entity_id: w.lp.entity.id, test_url: `${w.partner.url}/test`, live_url: `${w.partner.url}/live/v3` });
  await w.ok(w.provider, "upload_partner_ledger_file", { statement: w.statement({ environment: "test" }, w.testKey) });
  await backdate(w, w.lp.user.id);
  // An admin adds a new account to the firm: the existing member is told, on the webhooks and as a notice.
  const puppetUser = await w.store.upsertClerkUser("puppet", "puppet@example.com", "Puppet", ["license_provider"]);
  const added = await w.ok(w.admin, "add_entity_member", { email: "puppet@example.com", entity_id: w.lp.entity.id });
  assert.equal(added.firm_told.members, 1);
  assert.ok((await noticesOf(w, w.provider)).some((n) => n.type === "firm.member_added" && n.data.member_email === "puppet@example.com"));
  puppetUser.entity_id = w.lp.entity.id;
  const puppet = await w.connect(puppetUser);
  await withCoolOff(72, async () => {
    await w.refused(puppet, "register_partner_signing_key", { public_key: edKey().address }, /joined this firm too recently/);
    await w.refused(puppet, "register_partner_test_signing_key", { public_key: edKey().address }, /joined this firm too recently/);
    await w.refused(puppet, "confirm_partner_ledger_endpoints", { test_url: `${w.partner.url}/test`, live_url: `${w.partner.url}/live/v3` }, /joined this firm too recently/);
    await w.refused(puppet, "upload_partner_ledger_file", { statement: w.statement() }, /joined this firm too recently/);
    await w.refused(puppet, "set_partner_ledger_source", { source: "http" }, /joined this firm too recently/);
    // A test file is fine: it never reads as live.
    await w.ok(puppet, "upload_partner_ledger_file", { statement: w.statement({ environment: "test", as_of: new Date(w.clock() + 1000).toISOString() }, w.testKey) });
    // A long-standing member isn't held back.
    await w.ok(w.provider, "confirm_partner_ledger_endpoints", { test_url: `${w.partner.url}/test`, live_url: `${w.partner.url}/live/v3` });
  });
  assert.ok((await noticesOf(w, puppet)).some((n) => n.type === "partner_ledger.endpoints_confirmed"));
});

test("with a second long-standing member, a live key change and a switch to live need that member's approval", async () => {
  const w = await world();
  await w.connectHttp();
  await backdate(w, w.lp.user.id);
  const otherUser = await w.store.upsertClerkUser("second", "second@example.com", "Second member", ["license_provider"]);
  await w.ok(w.admin, "add_entity_member", { email: "second@example.com", entity_id: w.lp.entity.id });
  otherUser.entity_id = w.lp.entity.id;
  await backdate(w, otherUser.id);
  const other = await w.connect(otherUser);

  await withCoolOff(72, async () => {
    // A live key change waits for the other member.
    const replacement = edKey();
    const asked = await w.ok(w.provider, "register_partner_signing_key", { public_key: replacement.address });
    assert.equal(asked.status, "pending_approval");
    assert.equal(await w.health.signingKey(w.lp.entity.id), w.key.address, "nothing changes until it's approved");
    assert.ok((await noticesOf(w, other)).some((n) => n.type === "partner_ledger.approval_requested" && n.data.approval_id === asked.approval_id));
    await w.refused(w.provider, "approve_partner_kit_change", { approval_id: asked.approval_id }, /another long-standing member/);
    await w.ok(other, "approve_partner_kit_change", { approval_id: asked.approval_id, approve: false });
    assert.equal(await w.health.signingKey(w.lp.entity.id), w.key.address);
    const again = await w.ok(w.provider, "register_partner_signing_key", { public_key: replacement.address });
    const approved = await w.ok(other, "approve_partner_kit_change", { approval_id: again.approval_id });
    assert.equal(approved.status, "approved");
    assert.equal(await w.health.signingKey(w.lp.entity.id), replacement.address);
    assert.ok((await noticesOf(w, w.provider)).some((n) => n.type === "partner_ledger.key_changed" && n.data.public_key === replacement.address));
    w.partner.state.mode = "ok";
    // The partner signs live statements with its new key from now on.
    w.key.privateKey = replacement.privateKey;
    w.key.address = replacement.address;

    // A switch to live waits too, and runs every check when approved.
    await w.conformance();
    const switching = await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
    assert.equal(switching.status, "pending_approval");
    assert.equal(await w.health.ledgerIsLive(w.lp.entity.id), false);
    const live = await w.ok(other, "approve_partner_kit_change", { approval_id: switching.approval_id });
    assert.equal(live.result.live, true);
    assert.equal(await w.health.ledgerIsLive(w.lp.entity.id), true);
    assert.ok((await noticesOf(w, other)).some((n) => n.type === "partner_ledger.source_changed" && n.data.source === "http"));
  });
});

test("a key once used for test is never accepted as live, nor a live key for test", async () => {
  const w = await world();
  const oldTest = w.testKey.address;
  await w.ok(w.provider, "register_partner_test_signing_key", { public_key: edKey().address });
  await w.refused(w.provider, "register_partner_signing_key", { public_key: oldTest }, /registered as a test signing key/);
  const oldLive = w.key.address;
  await w.ok(w.provider, "register_partner_signing_key", { public_key: edKey().address });
  await w.refused(w.provider, "register_partner_test_signing_key", { public_key: oldLive }, /registered as a live signing key/);
});

test("a pass running out is warned of ahead, and the firm is told when it sends it back to the sandbox", async () => {
  const w = await world();
  await w.connectHttp();
  await w.conformance();
  await w.ok(w.provider, "set_partner_ledger_source", { source: "http" });
  const notices = async () => (await w.pg.query("SELECT type, data FROM financial_products.firm_notices WHERE user_id = $1 ORDER BY created_at", [w.lp.user.id])).rows;
  // 25 days on: inside the warning window.
  await w.pg.query("UPDATE financial_products.partner_conformance_runs SET created_at = now() - interval '25 days'");
  await w.tick();
  await w.tick();
  assert.equal((await notices()).filter((n) => n.type === "partner_ledger.conformance_expiring").length, 1, "warned once");
  // 31 days on: run out, back to the sandbox, told once.
  await w.pg.query("UPDATE financial_products.partner_conformance_runs SET created_at = now() - interval '31 days'");
  await w.tick();
  await w.tick();
  const expired = (await notices()).filter((n) => n.type === "partner_ledger.source_changed" && n.data.reason === "conformance_expired");
  assert.equal(expired.length, 1);
  assert.equal((await w.latest(w.products[0])).source, "sandbox");
});

test("confirming checks the very proposal it read: a newer one isn't confirmed by an older call", async () => {
  const w = await world();
  await w.propose(`${w.partner.url}/test`, `${w.partner.url}/live`);
  // The admin proposes again before the firm confirms: the firm's call names the first URLs and is refused.
  await w.propose(`${w.partner.url}/test`, `${w.partner.url}/live/other`);
  await w.refused(w.provider, "confirm_partner_ledger_endpoints", { test_url: `${w.partner.url}/test`, live_url: `${w.partner.url}/live` }, /aren't the URLs proposed/);
  const done = await w.confirm(`${w.partner.url}/test`, `${w.partner.url}/live/other`);
  assert.equal(done.live_url, `${w.partner.url}/live/other`);
  // Nothing is left to confirm twice.
  await w.refused(w.provider, "confirm_partner_ledger_endpoints", { test_url: `${w.partner.url}/test`, live_url: `${w.partner.url}/live/other` }, /No endpoint change/);
});
