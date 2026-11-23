import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createSignWell, signwellFromEnv } from "../dist/esign/signwell.js";
import { esignFromEnv } from "../dist/esign/adapters.js";
import { testModeFromEnv } from "../dist/esign/provider.js";
import { schedulePdf } from "../dist/esign/schedule-pdf.js";

// The e-signature adapter against a fake of the service's API (never the live one): what each call sends, how the
// answers are read, and the webhook check (good, bad, replayed with another body, stale). Keys here are fakes.

const KEY = "fake-api-key-for-tests";
const HOOK = "fake-webhook-id-for-tests";
const PDF = Buffer.from("%PDF-1.4\nfake\n%%EOF\n");

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined, redirect: init.redirect, hasSignal: Boolean(init.signal) };
    calls.push(call);
    const { status = 200, json, bytes, url: finalUrl } = (await handler(call)) ?? {};
    const body = json !== undefined ? JSON.stringify(json) : (bytes ?? "");
    const res = new Response(status === 204 ? null : body, { status, headers: { "content-type": json !== undefined ? "application/json" : "application/pdf" } });
    if (finalUrl) Object.defineProperty(res, "url", { value: finalUrl });
    return res;
  };
  return { f, calls };
}

const docJson = (over = {}) => ({
  id: "doc-123",
  status: "Sent",
  test_mode: true,
  recipients: [
    { id: "1", email: "lena@sponsor.test", status: "sent", embedded_signing_url: "https://sign.service.test/embed/one" },
    { id: "2", email: "dana@dev.test", status: "sent", embedded_signing_url: "https://sign.service.test/embed/two" },
  ],
  ...over,
});

const signers = [
  { role: "counterparty", name: "Lena", email: "lena@sponsor.test" },
  { role: "app", name: "Dana", email: "dana@dev.test" },
];

test("creating from a document: the key only in its header, both signers embedded, test mode, a signature page", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 201, json: docJson() }));
  const p = createSignWell({ apiKey: KEY, webhookId: HOOK, fetch: f });
  const doc = await p.createFromDocument({ name: "Program", files: [{ name: "a.pdf", content: PDF }, { name: "program-schedule.pdf", content: PDF }], signers, signature: "signature_page", metadata: { mynt_agreement_id: "x" }, testMode: true });
  assert.equal(doc.id, "doc-123");
  assert.equal(doc.status, "pending");
  assert.deepEqual(doc.signers.map((s) => [s.role, s.signed]), [["counterparty", false], ["app", false]]);
  const c = calls[0];
  assert.equal(c.method, "POST");
  assert.match(c.url, /^https:\/\/[^/]+\/api\/v1\/documents$/);
  assert.equal(c.headers["X-Api-Key"], KEY);
  assert.equal(c.redirect, "error");
  assert.ok(c.hasSignal, "every call has a time limit");
  assert.ok(!JSON.stringify(c.body).includes(KEY), "the key is never in the body");
  assert.equal(c.body.test_mode, true);
  assert.equal(c.body.embedded_signing, true);
  assert.equal(c.body.draft, false);
  assert.equal(c.body.with_signature_page, true);
  assert.equal(c.body.text_tags, undefined);
  assert.deepEqual(c.body.recipients.map((r) => [r.id, r.email, r.send_email]), [["1", "lena@sponsor.test", false], ["2", "dana@dev.test", false]]);
  assert.deepEqual(c.body.files.map((x) => x.name), ["a.pdf", "program-schedule.pdf"]);
  assert.equal(Buffer.from(c.body.files[0].file_base64, "base64").toString(), PDF.toString());
  assert.deepEqual(c.body.metadata, { mynt_agreement_id: "x" });

  await p.createFromDocument({ name: "Program", files: [{ name: "a.pdf", content: PDF }], signers, signature: "text_tags", metadata: {}, testMode: false });
  assert.equal(calls[1].body.text_tags, true);
  assert.equal(calls[1].body.with_signature_page, undefined);
  assert.equal(calls[1].body.test_mode, false);
});

test("creating from a template: placeholders, filled fields and the appended schedule", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 201, json: docJson() }));
  const p = createSignWell({ apiKey: KEY, fetch: f });
  await p.createFromTemplate({ name: "Program", templateId: "tpl-1", placeholders: { counterparty: "Sponsor", app: "Developer" }, fields: [{ apiId: "app_name", value: "Pay app" }], appendFiles: [{ name: "program-schedule.pdf", content: PDF }], signers, metadata: {}, testMode: true });
  const c = calls[0];
  assert.match(c.url, /\/api\/v1\/document_templates\/documents$/);
  assert.equal(c.body.template_id, "tpl-1");
  assert.deepEqual(c.body.recipients.map((r) => r.placeholder_name), ["Sponsor", "Developer"]);
  assert.deepEqual(c.body.template_fields, [{ api_id: "app_name", value: "Pay app" }]);
  assert.equal(c.body.files.length, 1);
});

test("statuses as Mynt reads them; manually completed is never completed; signing links only for an unsigned signer", async () => {
  let current = docJson();
  const { f } = fakeFetch(() => ({ json: current }));
  const p = createSignWell({ apiKey: KEY, fetch: f });
  assert.equal(await p.embeddedSigningUrl("doc-123", "app"), "https://sign.service.test/embed/two");
  current = docJson({ recipients: [{ id: "1", email: "l", status: "completed" }, { id: "2", email: "d", status: "sent", embedded_signing_url: "https://sign.service.test/embed/two" }] });
  assert.equal(await p.embeddedSigningUrl("doc-123", "counterparty"), null, "signed already");
  assert.equal(await p.embeddedSigningUrl("doc-123", "app"), "https://sign.service.test/embed/two");
  current = docJson({ recipients: [{ id: "2", email: "d", status: "sent", embedded_signing_url: "http://insecure.test/x" }] });
  assert.equal(await p.embeddedSigningUrl("doc-123", "app"), null, "only https links");
  for (const [raw, want] of [["Completed", "completed"], ["Manually completed", "error"], ["Declined", "declined"], ["Canceled", "canceled"], ["Expired", "expired"], ["Viewed", "pending"], ["Whatever", "error"]]) {
    current = docJson({ status: raw });
    assert.equal((await p.getStatus("doc-123")).status, want, raw);
  }
  await assert.rejects(p.getStatus("../../etc"), /bad_document_id/);
});

test("errors are short codes, never the service's text or the key", async () => {
  const { f } = fakeFetch(() => ({ status: 422, json: { message: `bad stuff ${KEY}` } }));
  const p = createSignWell({ apiKey: KEY, fetch: f });
  await assert.rejects(p.getStatus("doc-1"), (e) => e.code === "refused" && !e.message.includes(KEY) && !e.message.includes("bad stuff"));
  const unauth = createSignWell({ apiKey: KEY, fetch: fakeFetch(() => ({ status: 401, json: {} })).f });
  await assert.rejects(unauth.getStatus("doc-1"), (e) => e.code === "not_authorised");
  const down = createSignWell({ apiKey: KEY, fetch: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.getStatus("doc-1"), (e) => e.code === "unreachable");
  // Cancel treats an already-gone document as done.
  const gone = createSignWell({ apiKey: KEY, fetch: fakeFetch(() => ({ status: 404, json: {} })).f });
  await gone.cancel("doc-1");
});

test("the completed download: the signed copy and the copy with the audit certificate, PDFs only, https only", async () => {
  const { f, calls } = fakeFetch((c) => ({ bytes: c.url.includes("audit_page=true") ? Buffer.concat([PDF, Buffer.from("cert")]) : PDF }));
  const p = createSignWell({ apiKey: KEY, fetch: f });
  const { signed, certificate } = await p.downloadCompleted("doc-123");
  assert.equal(signed.toString(), PDF.toString());
  assert.ok(certificate.toString().endsWith("cert"));
  assert.ok(calls.every((c) => c.url.includes("/documents/doc-123/completed_pdf") && c.url.includes("url_only=false")));
  assert.ok(calls.some((c) => c.url.includes("audit_page=false")) && calls.some((c) => c.url.includes("audit_page=true")));
  const html = createSignWell({ apiKey: KEY, fetch: fakeFetch(() => ({ bytes: "<html>" })).f });
  await assert.rejects(html.downloadCompleted("doc-123"), (e) => e.code === "not_a_pdf");
  const redirected = createSignWell({ apiKey: KEY, fetch: fakeFetch(() => ({ bytes: PDF, url: "http://plain.test/x.pdf" })).f });
  await assert.rejects(redirected.downloadCompleted("doc-123"), (e) => e.code === "insecure_redirect");
});

const event = (type, time, over = {}) => {
  const hash = createHmac("sha256", HOOK).update(`${type}@${time}`).digest("hex");
  return JSON.stringify({ event: { type, time, hash, ...over }, data: { object: { id: "doc-123", status: "Completed" }, account_id: "acct" } });
};

test("webhook events: the hash of type@time under the webhook id, compared in constant time; tampered, stale or unconfigured refused", () => {
  const p = createSignWell({ apiKey: KEY, webhookId: HOOK, fetch: fakeFetch(() => ({})).f });
  const now = new Date();
  const t = Math.floor(now.getTime() / 1000) - 10;
  const good = p.verifyWebhook(event("document_completed", t), {}, now);
  assert.equal(good.ok, true);
  assert.equal(good.event.type, "document_completed");
  assert.equal(good.event.documentId, "doc-123");
  // The same delivery again carries the same event id (Mynt handles each once).
  assert.equal(p.verifyWebhook(event("document_completed", t), {}, now).event.eventId, good.event.eventId);
  // A different type with the same hash, or another hash, fails.
  const forged = JSON.parse(event("document_completed", t));
  forged.event.type = "document_declined";
  assert.deepEqual(p.verifyWebhook(JSON.stringify(forged), {}, now), { ok: false, reason: "bad_signature" });
  assert.deepEqual(p.verifyWebhook(event("document_completed", t, { hash: "0".repeat(64) }), {}, now), { ok: false, reason: "bad_signature" });
  assert.deepEqual(p.verifyWebhook(event("document_completed", t, { hash: "short" }), {}, now), { ok: false, reason: "malformed" });
  assert.deepEqual(p.verifyWebhook("not json", {}, now), { ok: false, reason: "malformed" });
  // Signed with another webhook's id.
  const other = createSignWell({ apiKey: KEY, webhookId: "another-id", fetch: fakeFetch(() => ({})).f });
  assert.deepEqual(other.verifyWebhook(event("document_completed", t), {}, now), { ok: false, reason: "bad_signature" });
  // A genuine event replayed days later.
  const old = t - 4 * 86_400;
  assert.deepEqual(p.verifyWebhook(event("document_completed", old), {}, now), { ok: false, reason: "stale" });
  // A replay of a genuine hash with another document in the body verifies (the hash doesn't cover it) but is a
  // different event id; Mynt reads that document's state from the service rather than believing the body.
  const swapped = JSON.parse(event("document_completed", t));
  swapped.data.object.id = "doc-999";
  const v = p.verifyWebhook(JSON.stringify(swapped), {}, now);
  assert.equal(v.ok, true);
  assert.notEqual(v.event.eventId, good.event.eventId);
  const noHook = createSignWell({ apiKey: KEY, fetch: fakeFetch(() => ({})).f });
  assert.deepEqual(noHook.verifyWebhook(event("document_completed", t), {}, now), { ok: false, reason: "unconfigured" });
});

test("settings by name: off without a key; test mode on unless turned off", async () => {
  assert.equal(signwellFromEnv({}), null);
  assert.ok(signwellFromEnv({ SIGNWELL_API_KEY: KEY }));
  assert.equal(await esignFromEnv({}), null);
  assert.equal(await esignFromEnv({ ESIGN_PROVIDER: "signwell" }), null, "no key: off");
  const on = await esignFromEnv({ ESIGN_PROVIDER: "signwell", SIGNWELL_API_KEY: KEY });
  assert.equal(on.provider.name, "signwell");
  assert.equal(on.testMode, true);
  assert.equal((await esignFromEnv({ ESIGN_PROVIDER: "signwell", SIGNWELL_API_KEY: KEY, ESIGN_TEST_MODE: "off" })).testMode, false);
  assert.equal(testModeFromEnv({ ESIGN_TEST_MODE: "on" }), true);
  assert.equal(await esignFromEnv({ ESIGN_PROVIDER: "nobody", SIGNWELL_API_KEY: KEY }), null);
});

test("Mynt's program schedule is a well-formed PDF stating what Mynt filled in", () => {
  const pdf = schedulePdf("Program schedule", [{ heading: "Parties", lines: [["Licence provider", "Sponsor Bank (a) \\ b"], ["Developer", "Dana’s firm"]] }], "Footer ".repeat(1000));
  const s = pdf.toString("latin1");
  assert.ok(s.startsWith("%PDF-1.4"));
  assert.ok(s.trimEnd().endsWith("%%EOF"));
  assert.ok(s.includes("(Licence provider: Sponsor Bank \\(a\\) \\\\ b) Tj"), "text escaped");
  assert.ok(s.includes("Developer: Dana's firm"), "typographic quotes made Latin-1");
  // The cross-reference table points at each object.
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.ok(s.slice(xref).startsWith("xref"));
  for (const m of s.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)) assert.match(s.slice(Number(m[1]), Number(m[1]) + 12), /^\d+ 0 obj/);
  assert.match(s, /\/Count [2-9]/, "long text runs onto more pages");
});
