import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpHttpServer } from "../dist/http.js";
import { createServer } from "../dist/server.js";
import { signBody } from "../dist/vendor-call.js";
import { sampleFromPattern, sandboxOutput, pointsAtVendorSandbox } from "../dist/vendor-sandbox.js";
import { getOffering, runConformance, schemaProblems, serviceType, SERVICE_TYPES_DIR } from "../dist/vendors.js";
import { setup } from "./v2-helpers.js";

// The vendor sandbox: a practice endpoint Mynt serves for every offering, and run_practice_conformance, which runs
// the conformance test's own cases against it. A practice pass is never conformance: it never changes an offering's
// status, never allows listing, and the sandbox never answers the real test.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 400 };

const ID_CHECK = {
  region: "IN",
  key: "practice_id_check",
  name: "Identity check",
  category: "identity",
  moves_money: false,
  input_schema: { type: "object", required: ["pan"], properties: { pan: { type: "string", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$" } }, additionalProperties: false },
  output_schema: {
    type: "object",
    required: ["result", "reference", "checked_on", "score"],
    properties: {
      result: { enum: ["match", "no_match"] },
      reference: { type: "string", pattern: "^[A-Z]{3}-[0-9]{6}$" },
      checked_on: { type: "string", format: "date" },
      score: { type: "integer", minimum: 300, maximum: 900 },
      note: { type: "string" },
    },
    additionalProperties: false,
  },
  consent_purpose: "identity_verification",
  fills: [],
  innovator_licences: [],
  vendor_licences: [],
};

const servers = [];
after(() => servers.forEach((s) => (s.closeAllConnections(), s.close())));

async function world() {
  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "vendor-sandbox", version: "0" });
    await client.connect(c);
    return client;
  };
  const ok = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const refused = async (client, name, args = {}) => {
    const r = await call(client, name, args);
    assert.equal(r.isError, true, `${name} should be refused: ${JSON.stringify(r.data)}`);
    return r.data.error;
  };
  const { user: adminUser } = await store.createUser("Root", ["admin"]);
  const admin = await connect(adminUser);
  const vendorPerson = async (email, name, firmId) => {
    await ok(admin, "invite_user", { email, roles: ["vendor"] });
    const user = await store.upsertClerkUser(`clerk_${name}`, email, name, (await store.getInvite(email)).roles);
    await ok(admin, "add_entity_member", { email, entity_id: firmId });
    return connect((await store.getUser(user.id)) ?? user);
  };
  await ok(admin, "define_service_type", { service_type: ID_CHECK });
  const firm = await ok(admin, "register_firm", { name: "Checkwell Ltd", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const vera = await vendorPerson("vera@checkwell.example", "Vera", firm.id);
  const srv = createMcpHttpServer(store, null, { vendors: VENDOR_OPTS }, { publicUrl: "https://mynt.test", vendors: VENDOR_OPTS }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  servers.push(srv);
  const base = `http://127.0.0.1:${srv.address().port}`;
  const count = async (table, offeringId) => Number((await store.db.query(`SELECT count(*)::int AS n FROM financial_products.${table} WHERE offering_id = $1`, [offeringId])).rows[0].n);
  return { ...ctx, connect, ok, refused, admin, vendorPerson, firm, vera, base, count };
}

const draft = (w, extra = {}) => w.ok(w.vera, "create_vendor_offering", { region: "IN", service_type: "practice_id_check", name: "Checkwell ID", price: { amount: 2, currency: "INR" }, ...extra });
const practiceBody = (extra = {}) => ({ request_id: "req-1", environment: "test", input: { pan: "ABCDE1234F" }, consent: { purpose: "identity_verification", artefact_ref: "mynt_practice", given_at: new Date().toISOString() }, ...extra });

test("the sandbox builds an answer valid against every shipped service type's output schema, the same each time", () => {
  let n = 0;
  for (const region of readdirSync(SERVICE_TYPES_DIR)) {
    for (const file of readdirSync(join(SERVICE_TYPES_DIR, region)).filter((f) => f.endsWith(".json"))) {
      const t = JSON.parse(readFileSync(join(SERVICE_TYPES_DIR, region, file), "utf8"));
      const now = new Date();
      const built = sandboxOutput({ ...t, quote: t.quote ?? false }, now);
      assert.ok("output" in built, `${region}/${file}: ${JSON.stringify(built.problems)}`);
      assert.deepEqual(schemaProblems(t.output_schema, built.output), [], `${region}/${file}`);
      assert.deepEqual(sandboxOutput({ ...t, quote: t.quote ?? false }, now), built, `${region}/${file} is deterministic`);
      if (t.quote) assert.ok(Date.parse(built.output.expires_at) > now.getTime(), `${region}/${file}: a quote's expires_at is ahead`);
      n++;
    }
  }
  assert.ok(n >= 10, `checked ${n} service types`);
  // What the schema states wins: const, default, the first example, the first enum value.
  const stated = sandboxOutput({ quote: false, output_schema: { type: "object", required: ["a", "b", "c"], properties: { a: { const: "x" }, b: { type: "string", examples: ["first", "second"] }, c: { type: "number", default: 7 }, d: { type: "string", default: "opt" }, e: { type: "string" } } } });
  assert.deepEqual(stated.output, { a: "x", b: "first", c: 7, d: "opt" });
  // A schema it can't satisfy is said so, never answered with something invalid.
  const impossible = sandboxOutput({ quote: false, output_schema: { type: "object", required: ["a"], properties: { a: { type: "string", pattern: "^(?=x)y$" } } } });
  assert.ok("problems" in impossible && impossible.problems.length > 0);
  assert.equal(sampleFromPattern("^[A-Z]{5}[0-9]{4}[A-Z]$"), "AAAAA0000A");
  assert.equal(sampleFromPattern("^us-[a-z]{2}$"), "us-aa");
  assert.equal(sampleFromPattern("^(?:in|out)_\\d+(\\.[0-9]{1,2})?$"), "in_0");
  assert.equal(sampleFromPattern("(?<=a)b"), null);
});

test("a draft without a test endpoint practises and passes; the pass never counts, moves the offering or allows listing", async () => {
  const w = await world();
  const { ok, refused, vera, store } = w;
  const created = await draft(w);
  const secret = created.conformance_signing_secret;
  assert.equal(created.test_base_url, null);
  assert.equal(created.status, "draft");
  assert.equal(created.next, "run_practice_conformance");

  // The real test needs the vendor's own endpoint; so does listing.
  assert.match(await refused(vera, "run_conformance", { offering_id: created.id }), /no test endpoint yet/);
  assert.match(await refused(vera, "update_vendor_offering", { offering_id: created.id, listed: true }), /own test endpoint/);

  const run = await ok(vera, "run_practice_conformance", { offering_id: created.id });
  assert.equal(run.kind, "practice");
  assert.equal(run.passed, true, JSON.stringify(run.cases));
  assert.equal(run.counts_as_conformance, false);
  assert.equal(run.status, "draft");
  assert.equal(run.message, "Practice run passed — now point Mynt at your own test endpoint and run the real test");
  assert.deepEqual(run.cases.map((c) => [c.case, c.passed, c.http_status]), [["fixture_1", true, 200], ["bad_signature_refused", true, 401], ["stale_timestamp_refused", true, 401]]);

  // What Mynt sends and expects: the schemas and the run's transcript, with nothing secret in it.
  const ref = run.reference;
  assert.equal(ref.service_type, "practice_id_check");
  assert.deepEqual(ref.sends.input_schema, ID_CHECK.input_schema);
  assert.deepEqual(ref.expects.output_schema, ID_CHECK.output_schema);
  assert.equal(ref.sandbox_endpoint, null, "no PUBLIC_URL in this process: not made up");
  assert.equal(ref.signing_secret, "<redacted>");
  assert.deepEqual(ref.transcript.map((x) => x.case), ["fixture_1", "bad_signature_refused", "stale_timestamp_refused"]);
  const first = ref.transcript[0];
  assert.equal(first.request.method, "POST");
  assert.equal(first.request.path, "/v1/practice_id_check");
  assert.match(first.request.headers["Mynt-Signature"], /^t=\d+,v1=<redacted>$/);
  assert.equal(first.request.body.environment, "test");
  assert.equal(first.request.body.consent.artefact_ref, "mynt_practice");
  assert.deepEqual(schemaProblems(ID_CHECK.input_schema, first.request.body.input), []);
  assert.equal(first.response.http_status, 200);
  assert.equal(first.response.body.request_id, first.request.body.request_id);
  assert.equal(first.response.body.status, "ok");
  assert.deepEqual(schemaProblems(ID_CHECK.output_schema, first.response.body.output), []);
  assert.deepEqual(first.response.body.output, { result: "match", reference: "AAA-000000", checked_on: "2026-01-15", score: 300 });
  assert.equal(ref.transcript[1].response.body.error.code, "bad_signature");
  const text = JSON.stringify(run);
  assert.ok(!text.includes(secret), "the signing secret is never returned");
  assert.ok(!/v1=[0-9a-f]{64}/.test(text), "no signature is returned either");
  assert.ok(!text.includes(secret.slice(4, 24)));

  // Nothing real moved: still a draft, no conformance run on record, and it still can't be listed.
  assert.equal((await getOffering(store.db, created.id)).status, "draft");
  assert.equal(await w.count("vendor_conformance_runs", created.id), 0);
  assert.equal(await w.count("vendor_practice_runs", created.id), 1);
  const mine = (await ok(vera, "list_my_offerings")).find((o) => o.id === created.id);
  assert.equal(mine.status, "draft");
  assert.equal(mine.last_conformance, null, "a practice run is never the last conformance run");
  assert.match(await refused(vera, "update_vendor_offering", { offering_id: created.id, listed: true }), /own test endpoint/);
  assert.match(await refused(vera, "run_conformance", { offering_id: created.id }), /no test endpoint yet/);
  assert.deepEqual((await ok(w.innovator ?? (await w.connect(w.user)), "list_vendor_offerings", { region: "IN" })).filter((o) => o.offering_id === created.id), [], "not in the marketplace");
  const audits = (await store.db.query("SELECT action, details FROM financial_products.audit_log WHERE target = $1 ORDER BY created_at", [created.id])).rows;
  assert.deepEqual(audits.map((a) => a.action), ["create_vendor_offering", "run_practice_conformance"]);
  assert.ok(!JSON.stringify(audits).includes(secret));

  // The checklist: an informational practice line, done; the real conformance step still to do, and never counted in.
  const o = (await ok(vera, "get_vendor_onboarding", { offering_id: created.id }));
  const steps = o.offerings[0].steps;
  assert.deepEqual(steps.map((s) => s.key), ["service_created", "practice", "conformance", "terms", "listed", "first_subscriber"]);
  const practice = steps.find((s) => s.key === "practice");
  assert.equal(practice.informational, true);
  assert.equal(practice.status, "done");
  assert.equal(practice.tool, "run_practice_conformance");
  assert.match(practice.detail, /^Practice run passed on \d{4}-\d\d-\d\d — now point Mynt at your own test endpoint and run the real test\./);
  assert.equal(practice.facts.counts_as_conformance, false);
  assert.equal(practice.facts.last_run.kind, "practice");
  const conformance = steps.find((s) => s.key === "conformance");
  assert.equal(conformance.status, "next");
  assert.equal(conformance.facts.last_run, null);
  assert.equal(conformance.facts.test_endpoint, false);
  assert.match(conformance.detail, /no test endpoint yet/);
  assert.equal(o.offerings[0].progress.total, 4, "the practice run and the first subscriber are never counted");
  assert.equal(o.offerings[0].progress.done, 1);
  assert.deepEqual(o.history[0].conformance_runs, []);
  assert.equal(o.history[0].practice_runs.length, 1);
  assert.equal(o.history[0].practice_runs[0].kind, "practice");

  // Before any practice run the line is there, not started, and still not counted.
  const second = await draft(w, { name: "Checkwell ID 2" });
  const fresh = (await ok(vera, "get_vendor_onboarding", { offering_id: second.id })).offerings[0];
  assert.equal(fresh.steps.find((s) => s.key === "practice").status, "not_started");
  assert.equal(fresh.steps.find((s) => s.key === "practice").facts.last_run, null);
  assert.equal(fresh.progress.next.key, "conformance");
});

test("only the offering's own firm practises; an offering is never pointed at the sandbox; runs are rate-limited", async () => {
  const w = await world();
  const { ok, refused, vera, admin, store } = w;
  const created = await draft(w);
  const other = await ok(admin, "register_firm", { name: "Other Vendor Ltd", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const omar = await w.vendorPerson("omar@other.example", "Omar", other.id);
  assert.match(await refused(omar, "run_practice_conformance", { offering_id: created.id }), /No offering of yours/);
  assert.equal(await w.count("vendor_practice_runs", created.id), 0);

  // Mynt's sandbox is never an offering's endpoint, on any host, however it's written.
  for (const u of [`${w.base}/vendor-sandbox/${created.id}`, `https://vendor.example.com/vendor-sandbox/${created.id}`, `https://vendor.example.com//Vendor-Sandbox/x`, `https://vendor.example.com/%76endor-sandbox/x`])
    assert.ok(pointsAtVendorSandbox(u), u);
  assert.ok(!pointsAtVendorSandbox("https://vendor.example.com/api/vendor-sandboxes"));
  assert.match(await refused(vera, "update_vendor_offering", { offering_id: created.id, test_base_url: `${w.base}/vendor-sandbox/${created.id}` }), /practice sandbox/);
  assert.match(await refused(vera, "update_vendor_offering", { offering_id: created.id, live_base_url: `https://vendor.example.com/vendor-sandbox/${created.id}` }), /practice sandbox/);
  assert.match(await refused(vera, "create_vendor_offering", { region: "IN", service_type: "practice_id_check", name: "Sneaky", price: { amount: 1, currency: "INR" }, test_base_url: `${w.base}/vendor-sandbox/${created.id}` }), /practice sandbox/);

  // Even put there behind the tools' backs, the real test refuses to run against it...
  await store.db.query("UPDATE financial_products.vendor_offerings SET test_base_url = $2 WHERE id = $1", [created.id, `${w.base}/vendor-sandbox/${created.id}`]);
  assert.match(await refused(vera, "run_conformance", { offering_id: created.id }), /practice sandbox/);
  // ...and if the real test's requests did reach the sandbox, it wouldn't answer them: only practice requests.
  const o = await getOffering(store.db, created.id);
  const real = await runConformance(store, o, await serviceType(store.db, "IN", "practice_id_check"), { ...VENDOR_OPTS, timeoutMs: 10_000 }, null);
  assert.equal(real.passed, false);
  assert.equal(real.status, "draft");
  assert.deepEqual(real.cases.find((c) => c.case === "fixture_1").problems, ['status is "error", not "ok"']);
  assert.equal((await getOffering(store.db, created.id)).status, "draft");

  // Ten practice runs a minute per offering.
  const fresh = await draft(w, { name: "Checkwell ID 3" });
  for (let i = 0; i < 10; i++) assert.equal((await ok(vera, "run_practice_conformance", { offering_id: fresh.id })).passed, true);
  assert.match(await refused(vera, "run_practice_conformance", { offering_id: fresh.id }), /Too many practice runs/);
  assert.equal(await w.count("vendor_practice_runs", fresh.id), 10);
  assert.equal((await getOffering(store.db, fresh.id)).status, "draft");
});

test("the endpoint answers as a correct vendor: signed practice requests only, bad and stale signatures refused, small bodies, rate-limited", async () => {
  const w = await world();
  const created = await draft(w);
  const other = await draft(w, { name: "Checkwell ID B" });
  const secret = created.conformance_signing_secret;
  const url = `${w.base}/vendor-sandbox/${created.id}`;
  const post = (raw, signature, to = url) => fetch(to, { method: "POST", headers: signature ? { "Mynt-Signature": signature } : {}, body: raw });
  const raw = JSON.stringify(practiceBody());

  const good = await post(raw, signBody(secret, raw));
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("mynt-sandbox"), "practice");
  const answer = await good.json();
  assert.equal(answer.request_id, "req-1");
  assert.equal(answer.status, "ok");
  assert.equal(answer.error, null);
  assert.deepEqual(schemaProblems(ID_CHECK.output_schema, answer.output), []);
  // The wire contract's own path works too; another service type's doesn't.
  assert.equal((await (await post(raw, signBody(secret, raw), `${url}/v1/practice_id_check`)).json()).status, "ok");
  assert.equal((await post(raw, signBody(secret, raw), `${url}/v1/esign`)).status, 404);

  // Unsigned, forged, signed for another offering, and stale: all 401, as is an offering that doesn't exist.
  assert.equal((await post(raw)).status, 401);
  assert.equal((await post(raw, signBody("mvs_not_the_secret", raw))).status, 401);
  assert.equal((await post(raw, signBody(other.conformance_signing_secret, raw))).status, 401);
  const stale = await post(raw, signBody(secret, raw, Math.floor(Date.now() / 1000) - 600));
  assert.equal(stale.status, 401);
  assert.equal((await stale.json()).error.code, "bad_signature");
  assert.equal((await post(raw, signBody(secret, raw), `${w.base}/vendor-sandbox/2b0c6a52-0000-4000-8000-000000000000`)).status, 401);
  assert.equal((await post(raw, signBody(secret, raw), `${w.base}/vendor-sandbox/not-an-id`)).status, 401);
  // A body that was changed after signing doesn't verify.
  assert.equal((await post(raw.replace("req-1", "req-2"), signBody(secret, raw))).status, 401);

  // Signed, but not a practice request: the real test's marker, a live call, a bad input.
  const errorOf = async (body) => {
    const r = JSON.stringify(body);
    const res = await post(r, signBody(secret, r));
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.status, "error");
    assert.equal(j.output, null);
    return j.error.code;
  };
  assert.equal(await errorOf(practiceBody({ consent: { purpose: "identity_verification", artefact_ref: "mynt_conformance", given_at: new Date().toISOString() } })), "practice_only");
  assert.equal(await errorOf(practiceBody({ consent: { purpose: "identity_verification", artefact_ref: "cns_real_customer", given_at: new Date().toISOString() } })), "practice_only");
  assert.equal(await errorOf(practiceBody({ environment: "live" })), "sandbox_only");
  assert.equal(await errorOf(practiceBody({ input: { pan: "nope" } })), "invalid_input");
  assert.equal((await post("not json", signBody(secret, "not json"))).status, 400);

  assert.equal((await fetch(url)).status, 405);
  const big = JSON.stringify(practiceBody({ padding: "x".repeat(70 * 1024) }));
  assert.equal((await post(big, signBody(secret, big))).status, 413);
  assert.equal((await fetch(`${w.base}/vendor-sandbox/`, { method: "POST", body: "{}" })).status, 404);

  // Nothing above touched the offering or recorded a run.
  assert.equal((await getOffering(w.store.db, created.id)).status, "draft");
  assert.equal(await w.count("vendor_practice_runs", created.id), 0);
  assert.equal(await w.count("vendor_conformance_runs", created.id), 0);

  // Thirty requests a minute per offering; then 429 with Retry-After, whatever the signature.
  const burst = await Promise.all(Array.from({ length: 45 }, () => post(raw, signBody(secret, raw))));
  const limited = burst.filter((r) => r.status === 429);
  assert.ok(limited.length >= 10, `rate-limited: ${limited.length} of 45`);
  assert.ok(burst.every((r) => r.status === 200 || r.status === 429));
  assert.ok(Number(limited[0].headers.get("retry-after")) >= 1);
  assert.equal((await limited[0].json()).error.code, "rate_limited");
  // Another offering's requests aren't held back by this one's.
  const rawB = JSON.stringify(practiceBody());
  assert.equal((await post(rawB, signBody(other.conformance_signing_secret, rawB), `${w.base}/vendor-sandbox/${other.id}`)).status, 200);
});

test("with its own endpoint, the real test still decides: practice before or after changes nothing", async () => {
  const w = await world();
  const { ok, vera, store } = w;
  // The vendor's own endpoint: here, a plain server answering as the contract says.
  const http = await import("node:http");
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  let secret = "";
  const vendor = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(req.headers["mynt-signature"] ?? "");
    const good = m && Math.abs(Date.now() / 1000 - Number(m[1])) <= 300 && timingSafeEqual(createHmac("sha256", secret).update(`${m[1]}.${raw}`).digest(), Buffer.from(m[2], "hex"));
    res.writeHead(good ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(good ? { request_id: body.request_id, status: "ok", output: { result: "match", reference: "ABC-123456", checked_on: "2026-02-01", score: 700 }, error: null } : { request_id: body.request_id, status: "error", output: null, error: { code: "bad_signature", message: "no" } }));
  });
  vendor.listen(0, "127.0.0.1");
  await new Promise((r) => vendor.once("listening", r));
  servers.push(vendor);

  const created = await draft(w, { test_base_url: `http://127.0.0.1:${vendor.address().port}` });
  secret = created.conformance_signing_secret;
  assert.equal(created.next, "run_conformance");
  assert.equal((await ok(vera, "run_practice_conformance", { offering_id: created.id })).next, "run_conformance");
  assert.equal((await getOffering(store.db, created.id)).status, "draft", "a practice pass doesn't move a draft on");

  const real = await ok(vera, "run_conformance", { offering_id: created.id });
  assert.equal(real.passed, true, JSON.stringify(real.cases));
  assert.equal(real.status, "conformance_passed");
  assert.equal(real.kind, undefined);

  const again = await ok(vera, "run_practice_conformance", { offering_id: created.id });
  assert.equal(again.status, "conformance_passed", "nor does it move a passed offering");
  assert.equal(await w.count("vendor_conformance_runs", created.id), 1);
  assert.equal(await w.count("vendor_practice_runs", created.id), 2);
  const steps = (await ok(vera, "get_vendor_onboarding", { offering_id: created.id })).offerings[0].steps;
  assert.equal(steps.find((s) => s.key === "conformance").status, "done");
  assert.match(steps.find((s) => s.key === "practice").detail, /didn't count: the real test of your endpoint did/);
  assert.equal((await ok(vera, "update_vendor_offering", { offering_id: created.id, listed: true })).status, "listed");

  // A suspended service doesn't practise.
  await store.db.query("UPDATE financial_products.vendor_offerings SET status = 'suspended' WHERE id = $1", [created.id]);
  const r = await w.call(vera, "run_practice_conformance", { offering_id: created.id });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /suspended/);
});
