import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { setup } from "./v2-helpers.js";

// get_vendor_onboarding: a vendor's onboarding as one ordered checklist, firm-wide and per offering, each step done,
// next, not_started or blocked, in plain words with the tool that does it. Only the vendor's own firm members read
// theirs; admins read any firm's, and every vendor firm's progress.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");
const VENDOR_OPTS = { allowInsecureLoopback: true, timeoutMs: 400 };

// A vendor's test endpoint: checks Mynt-Signature and answers in the mode the test sets.
async function vendorServer() {
  const state = { mode: "ok", secrets: new Set() };
  const verify = (header, raw) => {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? "");
    if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
    return [...state.secrets].some((s) => timingSafeEqual(createHmac("sha256", s).update(`${m[1]}.${raw}`).digest(), Buffer.from(m[2], "hex")));
  };
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    const reply = (code, value) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (!verify(req.headers["mynt-signature"], raw)) return reply(401, { request_id: body.request_id, status: "error", output: null, error: { code: "bad_signature", message: "no" } });
    const output = state.mode === "bad_output" ? { ckyc_number: 42, full_name: "Asha Verma" } : { ckyc_number: "12345678901234", full_name: "Asha Verma", date_of_birth: "1991-04-12" };
    reply(200, { request_id: body.request_id, status: "ok", output, error: null });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => (server.closeAllConnections(), server.close()) };
}
const servers = [];
after(() => servers.forEach((s) => s.close()));

const CKYC = {
  region: "IN",
  key: "ckyc_search_download",
  name: "CKYC search and download",
  category: "kyc",
  moves_money: false,
  input_schema: { type: "object", required: ["pan"], properties: { pan: { type: "string", pattern: "^[A-Z]{5}[0-9]{4}[A-Z]$" } }, additionalProperties: false },
  output_schema: {
    type: "object",
    required: ["ckyc_number", "full_name", "date_of_birth"],
    properties: { ckyc_number: { type: "string", pattern: "^[0-9]{14}$" }, full_name: { type: "string" }, date_of_birth: { type: "string", format: "date" } },
    additionalProperties: false,
  },
  consent_purpose: "kyc_records_fetch",
  fills: ["full_name", "date_of_birth"],
  innovator_licences: ["rbi_bank"],
  vendor_licences: ["rbi_pa"],
};
const TERMS = { document_url: "https://kycworks.example.com/terms-v1.pdf", document_sha256: "a".repeat(64), summary: "Standard terms for CKYC lookups.", pricing_summary: "INR 3.50 per lookup, invoiced monthly", scopes: ["technology"] };

async function world() {
  const ctx = await setup();
  const { store, call } = ctx;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { vendors: VENDOR_OPTS }).connect(s);
    const client = new Client({ name: "onboarding", version: "0" });
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
  // A vendor's person: invited with the vendor role, added to the firm.
  const vendorPerson = async (email, name, firmId) => {
    await ok(admin, "invite_user", { email, roles: ["vendor"] });
    const user = await store.upsertClerkUser(`clerk_${name}`, email, name, (await store.getInvite(email)).roles);
    if (firmId) await ok(admin, "add_entity_member", { email, entity_id: firmId });
    return connect((await store.getUser(user.id)) ?? user);
  };
  const vendor = await vendorServer();
  servers.push(vendor);
  return { ...ctx, connect, ok, admin, adminUser, vendorPerson, vendor, innovator: await connect(ctx.user) };
}

const statuses = (steps) => Object.fromEntries(steps.map((s) => [s.key, s.status]));
const stepOf = (steps, key) => steps.find((s) => s.key === key);

test("each step's states, from a firm with nothing to a listed service with a subscriber", async () => {
  const w = await world();
  const { ok, admin, vendor } = w;
  const firm = await ok(admin, "register_firm", { name: "KYC Works Pvt Ltd", legal_form: "company_private", incorporation: { country: "in" }, regions: ["IN"] });
  const vera = await w.vendorPerson("vera@kycworks.example", "Vera", firm.id);

  // ---- a new firm: registered, its person has the vendor role, and the first service is next ----
  let o = await ok(vera, "get_vendor_onboarding");
  assert.deepEqual(o.entity, { id: firm.id, name: "KYC Works Pvt Ltd", status: "active" });
  assert.deepEqual(statuses(o.firm_steps), { firm_registered: "done", vendor_members: "done", first_service: "next" });
  assert.equal(stepOf(o.firm_steps, "vendor_members").facts.members, 1);
  assert.equal(stepOf(o.firm_steps, "first_service").tool, "create_vendor_offering");
  assert.equal(stepOf(o.firm_steps, "first_service").by, "vendor");
  assert.deepEqual(o.offerings, []);
  assert.deepEqual(o.progress, { done: 2, total: 3, next: { key: "first_service", title: "Create your first service", status: "next", tool: "create_vendor_offering", offering_id: null }, complete: false });
  for (const s of o.firm_steps) assert.ok(s.detail.length > 10 && !/[_]/.test(s.detail), `${s.key} is in plain words: ${s.detail}`);

  // ---- a service whose type needs a licence the vendor hasn't registered ----
  await ok(admin, "define_service_type", { service_type: CKYC });
  const created = await ok(vera, "create_vendor_offering", { region: "IN", service_type: "ckyc_search_download", name: "KYC Works CKYC", test_base_url: vendor.url, price: { amount: 3.5, currency: "INR" } });
  vendor.state.secrets.add(created.conformance_signing_secret);
  o = await ok(vera, "get_vendor_onboarding");
  assert.equal(stepOf(o.firm_steps, "first_service").status, "done");
  assert.equal(o.offerings.length, 1);
  let steps = o.offerings[0].steps;
  assert.deepEqual(steps.map((s) => s.key), ["service_created", "licence", "practice", "conformance", "terms", "listed", "first_subscriber"]);
  assert.deepEqual(statuses(steps), { service_created: "done", licence: "next", practice: "not_started", conformance: "not_started", terms: "not_started", listed: "not_started", first_subscriber: "not_started" });
  assert.match(stepOf(steps, "licence").detail, /needs a licence of one of: rbi_pa/);
  assert.equal(stepOf(steps, "licence").tool, "register_license");
  assert.equal(stepOf(steps, "conformance").facts.last_run, null, "no run yet: null, never a made-up figure");
  assert.equal(stepOf(steps, "terms").facts.terms_version, null);
  assert.equal(stepOf(steps, "first_subscriber").informational, true);
  assert.equal(stepOf(steps, "first_subscriber").by, "subscriber");
  assert.equal(o.offerings[0].progress.total, 5, "the first subscriber never counts");
  assert.equal(o.offerings[0].service_name, "CKYC search and download");
  assert.equal(o.progress.next.key, "licence");
  assert.equal(o.progress.next.offering_id, created.id);

  // ---- registered: waiting for Mynt to verify it, and conformance waits too ----
  const licence = await ok(vera, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: "PA-KYC-1" });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "licence").status, "blocked");
  assert.equal(stepOf(steps, "licence").by, "admin");
  assert.equal(stepOf(steps, "licence").detail, "Waiting for Mynt to verify your licence rbi_pa (PA-KYC-1).");
  assert.equal(stepOf(steps, "conformance").status, "blocked");
  assert.match(stepOf(steps, "conformance").detail, /Waits for Mynt to verify your licence/);
  assert.equal(stepOf(steps, "terms").status, "next", "terms can be set meanwhile");

  // ---- rejected: register it again; verified but not named on the service: name it ----
  await ok(admin, "review_license", { license_record_id: licence.id, decision: "rejected", note: "Number not on the register" });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "licence").status, "next");
  assert.match(stepOf(steps, "licence").detail, /didn't verify your licence rbi_pa \("Number not on the register"\)/);
  await ok(vera, "register_license", { region: "IN", regulator_id: "rbi", license_id: "rbi_pa", registration_number: "PA-KYC-1" });
  await ok(admin, "review_license", { license_record_id: licence.id, decision: "verified" });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "licence").status, "next");
  assert.match(stepOf(steps, "licence").detail, /Name your verified licence rbi_pa/);
  assert.equal(stepOf(steps, "licence").tool, "update_vendor_offering");
  await ok(vera, "update_vendor_offering", { offering_id: created.id, licence_ids: [licence.id] });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "licence").status, "done");
  assert.equal(stepOf(steps, "conformance").status, "next");
  assert.match(stepOf(steps, "conformance").detail, /hasn't tested your endpoint yet/);

  // ---- conformance: a failed run names its failures; a pass is done ----
  vendor.state.mode = "bad_output";
  await ok(vera, "run_conformance", { offering_id: created.id });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  const failed = stepOf(steps, "conformance");
  assert.equal(failed.status, "next");
  assert.match(failed.detail, /^The last run on \d{4}-\d{2}-\d{2} failed: fixture 1: .*output \/ckyc_number must be string.*Fix your endpoint and run it again\.$/);
  assert.equal(failed.facts.last_run.passed, false);
  assert.deepEqual(failed.facts.last_run.failures.map((f) => f.case), ["fixture_1"]);
  vendor.state.mode = "ok";
  await ok(vera, "run_conformance", { offering_id: created.id });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "conformance").status, "done");
  assert.match(stepOf(steps, "conformance").detail, /^Passed on \d{4}-\d{2}-\d{2}\.$/);
  assert.deepEqual(statuses(steps), { service_created: "done", licence: "done", practice: "not_started", conformance: "done", terms: "next", listed: "not_started", first_subscriber: "not_started" });
  assert.match(stepOf(steps, "listed").detail, /passed Mynt's test: list it/);

  // ---- listed (before terms), then a first subscriber, then standard terms: complete ----
  await ok(vera, "update_vendor_offering", { offering_id: created.id, listed: true });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "listed").status, "done");
  assert.equal(stepOf(steps, "terms").status, "next");
  // Listed with no standard terms: both steps say the same gap, the same way.
  assert.equal(stepOf(steps, "listed").detail, "Listed in the Marketplace, without standard terms: app teams can't subscribe until you set them.");
  assert.match(stepOf(steps, "terms").detail, /^It's listed without standard terms: app teams see it in the Marketplace and can't subscribe until you set them/);
  assert.equal(stepOf(steps, "first_subscriber").detail, "No subscribers yet. App teams can subscribe from the Marketplace once you set standard terms.");
  assert.equal(stepOf(steps, "first_subscriber").facts.subscribers, 0, "a measured count: none yet");
  await ok(w.innovator, "subscribe_vendor_service", { offering_id: created.id });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "first_subscriber").status, "done");
  assert.equal(stepOf(steps, "first_subscriber").detail, "1 firm subscribes.");
  await ok(vera, "update_vendor_offering", { offering_id: created.id, standard_terms: TERMS });
  await ok(vera, "update_vendor_offering", { offering_id: created.id, standard_terms: { ...TERMS, pricing_summary: "INR 3.00 per lookup, invoiced monthly" } });
  o = await ok(vera, "get_vendor_onboarding");
  steps = o.offerings[0].steps;
  assert.equal(stepOf(steps, "terms").status, "done");
  assert.match(stepOf(steps, "terms").detail, /^Version 2, set on \d{4}-\d{2}-\d{2}\. Scope: Technology\.$/);
  assert.deepEqual(stepOf(steps, "terms").facts.scopes, ["technology"]);
  assert.equal(o.offerings[0].progress.complete, true);
  assert.equal(o.offerings[0].progress.next, null);
  assert.deepEqual({ done: o.progress.done, total: o.progress.total, complete: o.progress.complete, next: o.progress.next }, { done: 8, total: 8, complete: true, next: null });
  assert.equal(o.history, undefined, "history only for one offering");

  // ---- one offering's history: its conformance runs and every terms version ----
  const one = await ok(vera, "get_vendor_onboarding", { offering_id: created.id });
  assert.equal(one.offerings.length, 1);
  const h = one.history[0];
  assert.equal(h.offering_id, created.id);
  assert.deepEqual(h.conformance_runs.map((r) => r.passed), [true, false], "newest first");
  assert.equal(h.conformance_runs[0].run_by, "Vera");
  assert.deepEqual(h.terms_versions.map((v) => [v.version, v.current]), [[2, true], [1, false]]);
  assert.equal(h.terms_versions[0].pricing_summary, "INR 3.00 per lookup, invoiced monthly");
  assert.equal(h.terms_versions[1].document_sha256, "a".repeat(64), "an earlier version keeps its SHA-256 from the audit log");
  assert.equal(h.terms_versions[1].summary, null, "not kept for an earlier version nobody accepted: null, not made up");
  assert.equal(h.terms_versions[0].agreements, 0);
  assert.deepEqual(h.terms_versions.map((v) => v.scopes), [["technology"], ["technology"]], "each version's scopes, the earlier one from the audit log");

  // ---- terms from before scopes were recorded (an older server's): the step asks for new terms naming their scope ----
  await w.store.db.query(`UPDATE financial_products.vendor_offerings SET terms_scopes = '{}' WHERE id = $1`, [created.id]);
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "terms").status, "next");
  assert.match(stepOf(steps, "terms").detail, /^Version 2 doesn't say what it covers\. Set new terms with their scope/);
  await w.store.db.query(`UPDATE financial_products.vendor_offerings SET terms_scopes = '{technology}' WHERE id = $1`, [created.id]);

  // ---- suspended by Mynt: the offering's steps wait on Mynt ----
  await ok(admin, "suspend_vendor_offering", { offering_id: created.id, suspended: true, note: "Endpoint down for a week" });
  steps = (await ok(vera, "get_vendor_onboarding")).offerings[0].steps;
  assert.equal(stepOf(steps, "conformance").status, "blocked");
  assert.equal(stepOf(steps, "listed").status, "blocked");
  assert.equal(stepOf(steps, "listed").detail, "Mynt suspended this service: Endpoint down for a week. Waiting for Mynt to reinstate it.");
  assert.equal(stepOf(steps, "terms").status, "done", "terms set stay done");

  // ---- the firm suspended: its steps wait for it to be active again ----
  await ok(admin, "suspend_vendor_offering", { offering_id: created.id, suspended: false });
  await ok(admin, "set_entity_status", { entity_id: firm.id, status: "suspended" });
  o = await ok(vera, "get_vendor_onboarding");
  assert.equal(stepOf(o.firm_steps, "firm_registered").status, "blocked");
  assert.match(stepOf(o.firm_steps, "firm_registered").detail, /Mynt has suspended KYC Works Pvt Ltd\. Waiting for Mynt/);
  steps = o.offerings[0].steps;
  assert.equal(stepOf(steps, "conformance").status, "blocked");
  assert.match(stepOf(steps, "conformance").detail, /^Waits for your firm to be active again\./);
  assert.ok(!steps.some((s) => s.status === "next"), "nothing to do until the firm is active");
});

test("permissions: vendor firm members read their own firm only; admins any firm, and every vendor firm", async () => {
  const w = await world();
  const { ok, call, admin, vendor } = w;
  const firmA = await ok(admin, "register_firm", { name: "A Checks", regions: ["IN"] });
  const firmB = await ok(admin, "register_firm", { name: "B Bureau", regions: ["IN"] });
  const ana = await w.vendorPerson("ana@a.example", "Ana", firmA.id);
  const bo = await w.vendorPerson("bo@b.example", "Bo", firmB.id);
  await ok(admin, "define_service_type", { service_type: { ...CKYC, vendor_licences: [] } });
  const offering = await ok(ana, "create_vendor_offering", { region: "IN", service_type: "ckyc_search_download", name: "A CKYC", test_base_url: vendor.url, price: { amount: 1, currency: "INR" } });

  // No licence needed: no licence step.
  const own = await ok(ana, "get_vendor_onboarding", { entity_id: firmA.id });
  assert.deepEqual(own.offerings[0].steps.map((s) => s.key), ["service_created", "practice", "conformance", "terms", "listed", "first_subscriber"]);

  // Another firm's vendor sees neither the firm nor its offering.
  assert.match((await call(bo, "get_vendor_onboarding", { entity_id: firmA.id })).data.error, /only see your own firm/);
  assert.match((await call(bo, "get_vendor_onboarding", { offering_id: offering.id })).data.error, /No offering of yours/);
  assert.match((await call(bo, "get_vendor_onboarding", { all_firms: true })).data.error, /Only Mynt admins/);
  assert.equal((await ok(bo, "get_vendor_onboarding")).entity.id, firmB.id);

  // Builders don't get the tool.
  assert.ok(!(await w.innovator.listTools()).tools.some((t) => t.name === "get_vendor_onboarding"));

  // A vendor not yet in a firm: waiting for Mynt, with nothing made up.
  const loose = await w.vendorPerson("lu@nofirm.example", "Lu", null);
  const none = await ok(loose, "get_vendor_onboarding");
  assert.equal(none.entity, null);
  assert.deepEqual(statuses(none.firm_steps), { firm_registered: "blocked", vendor_members: "blocked", first_service: "blocked" });
  assert.equal(stepOf(none.firm_steps, "firm_registered").detail, "Waiting for Mynt to add your firm and you to it.");
  assert.equal(stepOf(none.firm_steps, "vendor_members").facts.members, null, "unmeasured: null, never 0");
  assert.equal(stepOf(none.firm_steps, "first_service").facts.services, null);

  // Admins: any firm by entity_id or offering_id, and every vendor firm.
  assert.equal((await ok(admin, "get_vendor_onboarding", { entity_id: firmA.id })).offerings[0].offering_id, offering.id);
  assert.equal((await ok(admin, "get_vendor_onboarding", { offering_id: offering.id })).entity.id, firmA.id);
  assert.match((await call(admin, "get_vendor_onboarding", { entity_id: firmB.id, offering_id: offering.id })).data.error, /at that firm/);
  assert.match((await call(admin, "get_vendor_onboarding")).data.error, /entity_id/);
  const { firms } = await ok(admin, "get_vendor_onboarding", { all_firms: true });
  assert.deepEqual(firms.map((f) => f.name), ["A Checks", "B Bureau"]);
  const a = firms.find((f) => f.entity_id === firmA.id);
  assert.equal(a.services, 1);
  assert.equal(a.vendor_members, 1);
  assert.equal(a.progress.next.key, "conformance");
  const b = firms.find((f) => f.entity_id === firmB.id);
  assert.equal(b.services, 0);
  assert.equal(b.progress.next.key, "first_service");
  // The tool only reads.
  const tool = (await admin.listTools()).tools.find((t) => t.name === "get_vendor_onboarding");
  assert.equal(tool.annotations.readOnlyHint, true);
});
