import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { personalWorkspace } = await import("../dist/workspaces.js");
const { createSignWell } = await import("../dist/esign/signwell.js");
const { esignWebhook } = await import("../dist/agreement-esign.js");
const { CATALOG } = await import("./helpers.js");

// Program agreements signed by e-signature, end to end against a fake of the e-signature service's API (never the
// live one; the keys are fakes): licence providers' templates (theirs only, versions immutable), the document made
// when the sponsor accepts, signing links only for each side's signer, the webhook (verified, handled once, the
// document's state read back rather than believed), and only a completed document signing the agreement, its signed
// copy and certificate sealed with their hashes and readable by both parties' members only.

const T = "financial_products";
const HOOK = "fake-webhook-id";
const PDF = Buffer.from("%PDF-1.4\n% the licence provider's program agreement\n%%EOF\n");
const SIGNED = Buffer.from("%PDF-1.4\n% signed by both\n%%EOF\n");
const CERT = Buffer.from("%PDF-1.4\n% signed by both, with the audit page\n%%EOF\n");
const sha = (b) => createHash("sha256").update(b).digest("hex");

// The fake service: documents it was asked to make, recipients' states, and the completed PDFs.
function fakeService() {
  const docs = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname, search: u.search, body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    const view = (d) => ({
      id: d.id,
      status: d.status,
      test_mode: d.test_mode,
      recipients: d.recipients.map((r) => ({ id: r.id, email: r.email, status: r.signed ? "completed" : "sent", embedded_signing_url: `https://sign.service.test/embed/${d.id}/${r.id}` })),
    });
    if (init.method === "POST" && (u.pathname.endsWith("/documents") || u.pathname.endsWith("/document_templates/documents"))) {
      const id = `doc-${docs.size + 1}`;
      docs.set(id, { id, status: "Sent", test_mode: body.test_mode, recipients: body.recipients.map((r) => ({ ...r, signed: false })), body });
      return reply(201, view(docs.get(id)));
    }
    const m = /\/documents\/([^/]+)(\/completed_pdf)?$/.exec(u.pathname);
    const d = m && docs.get(m[1]);
    if (!d) return reply(404, { message: "Not found" });
    if (init.method === "DELETE") {
      d.status = "Canceled";
      return new Response(null, { status: 204 });
    }
    if (m[2]) {
      if (d.status !== "Completed") return reply(404, {});
      return new Response(u.searchParams.get("audit_page") === "true" ? CERT : SIGNED, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return reply(200, view(d));
  };
  const sign = (id, recipient) => {
    const d = docs.get(id);
    d.recipients.find((r) => r.id === recipient).signed = true;
    if (d.recipients.every((r) => r.signed)) d.status = "Completed";
  };
  return { docs, calls, fetch, sign };
}

async function setup({ esign = true } = {}) {
  const service = fakeService();
  const provider = createSignWell({ apiKey: "fake-key", webhookId: HOOK, fetch: service.fetch });
  const ctxEsign = esign ? { provider, testMode: true } : null;
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
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
  const as = async (name, roles, entityId = null) => {
    const { user } = await store.createUser(name, roles);
    if (entityId) await store.setUserEntity(user.id, entityId);
    // Every licence provider here has standing at its firm (a second one is accepted by the first).
    if (entityId) await store.db.query(`UPDATE ${T}.users SET lp_since = coalesce(lp_since, now()) WHERE id = $1`, [user.id]);
    await store.db.query(`UPDATE ${T}.users SET email = $2 WHERE id = $1`, [user.id, `${name.toLowerCase()}@example.test`]);
    const fresh = await store.getUser(user.id);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, fresh, { esign: ctxEsign }).connect(s);
    const client = new Client({ name: "agreement-esign", version: "0" });
    await client.connect(c);
    return { user: fresh, call: (n, a) => call(client, n, a), tools: async () => (await client.listTools()).tools.map((t) => t.name) };
  };
  const firm = (name) => store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });
  const dev = await as("Dana", ["developer"]);
  const workspace = await personalWorkspace(store.db, dev.user.id);
  const app = await store.createApp(dev.user.id, { name: "Pay app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const member = await as("Mo", ["developer"]);
  await store.db.query(`INSERT INTO ${T}.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')`, [workspace, member.user.id]);
  const outsider = await as("Olive", ["developer"]);
  const lpFirm = await firm("Sponsor Bank");
  const lp = await as("Lena", ["license_provider"], lpFirm.id);
  const lp2 = await as("Lars", ["license_provider"], lpFirm.id);
  const otherFirm = await firm("Other Bank");
  const otherLp = await as("Omar", ["license_provider"], otherFirm.id);
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const [ac, as2] = InMemoryTransport.createLinkedPair();
  await createServer(store, await store.getUser(adminUser.id), { esign: ctxEsign }).connect(as2);
  const adminClient = new Client({ name: "agreement-esign-admin", version: "0" });
  await adminClient.connect(ac);
  const admin = { call: (n, a) => call(adminClient, n, a), tools: async () => (await adminClient.listTools()).tools.map((t) => t.name) };
  const builderFirm = await firm("Builder Inc");
  const sponsorshipId = randomUUID();
  await store.db.query(
    `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, 'savings-account', 'main', $2, $3, ARRAY['us-ny','us-ca'], 'approved')`,
    [sponsorshipId, builderFirm.id, lpFirm.id],
  );
  const webhook = async (raw) => {
    const req = Readable.from([Buffer.from(raw)]);
    req.method = "POST";
    req.headers = { "content-type": "application/json" };
    let status = 0;
    let out = "";
    const res = { writeHead: (s) => ((status = s), res), end: (b) => (out = b ?? "") };
    await esignWebhook(store, ctxEsign, req, res);
    return { status, body: out ? JSON.parse(out) : null };
  };
  return { store, service, dev, member, outsider, lp, lp2, otherLp, admin, lpFirm, app, sponsorshipId, webhook };
}

const ok = (r) => {
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};
const refused = (r, re) => {
  assert.equal(r.isError, true, JSON.stringify(r.data));
  if (re) assert.match(r.data.error, re);
};
const actions = async (store, id) => (await store.db.query(`SELECT action, actor_id, details FROM ${T}.audit_log WHERE target = $1 ORDER BY created_at, id`, [id])).rows;
const event = (type, documentId, time = Math.floor(Date.now() / 1000)) =>
  JSON.stringify({ event: { type, time, hash: createHmac("sha256", HOOK).update(`${type}@${time}`).digest("hex") }, data: { object: { id: documentId, status: "whatever the body says" } } });
const upload = { name: "Sponsor Bank program agreement", source: "upload", file_name: "program.pdf", file_base64: PDF.toString("base64") };

test("templates: the licence provider's own firm only, never an admin for it; versions immutable, the newest active", async () => {
  const w = await setup();
  for (const t of ["upload_agreement_template", "list_agreement_templates", "retire_agreement_template", "get_agreement_signing_link", "download_agreement_document"]) assert.ok((await w.lp.tools()).includes(t), t);
  assert.ok(!(await w.dev.tools()).includes("upload_agreement_template"), "developers don't keep licence providers' templates");
  refused(await w.admin.call("upload_agreement_template", upload), /don't act for a firm as a licence provider/, "admins don't act for a licence provider");

  refused(await w.lp.call("upload_agreement_template", { ...upload, file_name: "program.exe" }), /\.pdf or \.docx/);
  refused(await w.lp.call("upload_agreement_template", { ...upload, file_base64: Buffer.from("<html>not a pdf</html>").toString("base64") }), /PDF or a Word document/);
  refused(await w.lp.call("upload_agreement_template", { ...upload, file_name: "program.docx" }), /PDF or a Word document/, "a PDF named .docx");
  refused(await w.lp.call("upload_agreement_template", { ...upload, licence_id: randomUUID() }), /No licence/);
  refused(await w.otherLp.call("upload_agreement_template", { ...upload, sponsorship_id: w.sponsorshipId }), /No sponsorship/);

  const v1 = ok(await w.lp.call("upload_agreement_template", { ...upload, sponsorship_id: w.sponsorshipId, notes: "Signature page at the end" }));
  assert.equal(v1.version, 1);
  assert.equal(v1.sha256, sha(PDF));
  assert.equal(v1.active, true);
  assert.equal(v1.file_type, "pdf");
  assert.ok(!("file_sealed" in v1), "the file never comes back");
  const stored = (await w.store.db.query(`SELECT file_sealed FROM ${T}.agreement_templates WHERE id = $1`, [v1.id])).rows[0].file_sealed;
  assert.match(stored, /^v1:/, "sealed under the vault key");
  assert.ok(!stored.includes(PDF.toString("base64")));

  const v2 = ok(await w.lp2.call("upload_agreement_template", { ...upload, sponsorship_id: w.sponsorshipId }));
  assert.equal(v2.version, 2, "the same name is the next version");
  const listed = ok(await w.lp.call("list_agreement_templates", {}));
  assert.deepEqual(listed.templates.map((t) => [t.version, t.active]), [[2, true]]);
  assert.deepEqual(ok(await w.lp.call("list_agreement_templates", { include_retired: true })).templates.map((t) => [t.version, t.active]), [[2, true], [1, false]]);
  assert.equal((await w.store.db.query(`SELECT sha256 FROM ${T}.agreement_templates WHERE id = $1`, [v1.id])).rows[0].sha256, sha(PDF), "version 1 unchanged");
  assert.deepEqual(ok(await w.otherLp.call("list_agreement_templates", {})).templates, [], "another firm sees none");
  refused(await w.otherLp.call("retire_agreement_template", { template_id: v2.id }), /No template/);
  ok(await w.lp.call("retire_agreement_template", { template_id: v2.id, reason: "New terms coming" }));
  refused(await w.lp.call("retire_agreement_template", { template_id: v2.id }), /isn't in use/);
  assert.deepEqual((await actions(w.store, v1.id)).map((a) => a.action), ["upload_agreement_template"]);
  assert.deepEqual((await actions(w.store, v2.id)).map((a) => [a.action, a.actor_id]), [["upload_agreement_template", w.lp2.user.id], ["retire_agreement_template", w.lp.user.id]]);
});

test("accept → document from the active template with Mynt's schedule → each signer signs inside Mynt → completed → signed, sealed, both parties read it", async () => {
  const w = await setup();
  const tpl = ok(await w.lp.call("upload_agreement_template", { ...upload, sponsorship_id: w.sponsorshipId }));
  const a = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product", effective_from: "2026-12-01" }));
  assert.equal(a.signed_by_esignature, true);
  assert.equal(a.signature_document, null);
  refused(await w.dev.call("get_agreement_signing_link", { agreement_id: a.id }), /hasn't accepted/);

  const accepted = ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }));
  assert.deepEqual(accepted.signing, { ready: true });
  assert.equal(accepted.signature_document.status, "pending");
  assert.equal(accepted.signature_document.test_mode, true);
  assert.deepEqual(accepted.signature_document.template, { id: tpl.id, name: upload.name, version: 1 });
  const [created] = w.service.calls.filter((c) => c.method === "POST");
  assert.equal(created.body.test_mode, true);
  assert.equal(created.body.embedded_signing, true);
  assert.deepEqual(created.body.recipients.map((r) => [r.id, r.email]), [["1", "lena@example.test"], ["2", "dana@example.test"]]);
  assert.deepEqual(created.body.files.map((f) => f.name), ["program.pdf", "program-schedule.pdf"]);
  assert.equal(Buffer.from(created.body.files[0].file_base64, "base64").toString(), PDF.toString(), "the licence provider's file as uploaded");
  const schedule = Buffer.from(created.body.files[1].file_base64, "base64").toString("latin1");
  for (const s of ["Sponsor Bank", "Pay app", "savings-account", "US-CA, US-NY", "2026-12-01", a.id, sha(PDF)]) assert.ok(schedule.includes(s), `the schedule states ${s}`);
  assert.equal(created.body.metadata.mynt_agreement_id, a.id);
  const docId = w.service.docs.keys().next().value;

  // The manual path doesn't sign a program agreement here.
  refused(await w.dev.call("sign_app_agreement", { agreement_id: a.id }), /by e-signature/);
  // Signing links: only each side's signer; a plain member, an outsider, the other firm and a second licence provider can't.
  refused(await w.member.call("get_agreement_signing_link", { agreement_id: a.id }), /No agreement/);
  refused(await w.outsider.call("get_agreement_signing_link", { agreement_id: a.id }), /No agreement/);
  refused(await w.otherLp.call("get_agreement_signing_link", { agreement_id: a.id }), /No agreement/);
  refused(await w.lp2.call("get_agreement_signing_link", { agreement_id: a.id }), /Lena signs this for your side/);
  const lpLink = ok(await w.lp.call("get_agreement_signing_link", { agreement_id: a.id }));
  assert.equal(lpLink.signing_url, `https://sign.service.test/embed/${docId}/1`);
  assert.equal(lpLink.signing_origin, "https://sign.service.test");
  assert.equal(ok(await w.dev.call("get_agreement_signing_link", { agreement_id: a.id })).signing_url, `https://sign.service.test/embed/${docId}/2`);
  // Nothing to download yet.
  refused(await w.dev.call("download_agreement_document", { agreement_id: a.id }), /no signed copy yet/);

  // The licence provider signs; the service's event comes in, verified; Mynt reads the state back.
  w.service.sign(docId, "1");
  const first = await w.webhook(event("document_signed", docId));
  assert.equal(first.status, 200);
  assert.equal((await w.webhook(event("document_signed", docId).replace(/"hash":"[a-f0-9]+"/, `"hash":"${"0".repeat(64)}"`))).status, 401, "a bad hash is refused");
  let listed = ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).agreements[0];
  assert.equal(listed.status, "accepted", "one signature isn't a signed agreement");
  assert.deepEqual([listed.signature_document.signers.counterparty.signed, listed.signature_document.signers.app.signed], [true, false]);
  assert.equal(ok(await w.lp.call("get_agreement_signing_link", { agreement_id: a.id })).signing_url, null, "signed already: no link");

  // A "completed" event whose document isn't complete at the service changes nothing (the body isn't believed).
  assert.equal((await w.webhook(event("document_completed", docId, Math.floor(Date.now() / 1000) - 5))).status, 200);
  assert.equal(ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).agreements[0].status, "accepted");

  // The developer signs; completed: signed copy and certificate downloaded, sealed, hashed; the agreement signed.
  w.service.sign(docId, "2");
  const done = event("document_completed", docId);
  assert.equal((await w.webhook(done)).status, 200);
  assert.deepEqual((await w.webhook(done)).body, { received: true, duplicate: true }, "a replayed delivery is handled once");
  listed = ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).agreements[0];
  assert.equal(listed.status, "signed");
  assert.ok(listed.signed_at);
  assert.equal(listed.document_sha256, sha(SIGNED));
  assert.deepEqual(listed.signature_document.signed_copy, { sha256: sha(SIGNED), certificate_sha256: sha(CERT) });
  assert.deepEqual(listed.signatures, { app_side: true, counterparty_side: true });
  const row = (await w.store.db.query(`SELECT signed_sealed, certificate_sealed FROM ${T}.app_agreement_documents WHERE agreement_id = $1`, [a.id])).rows[0];
  assert.match(row.signed_sealed, /^v1:/);
  assert.match(row.certificate_sealed, /^v1:/);
  assert.ok(JSON.stringify(ok(await w.lp.call("list_firm_notices"))).includes("app_agreement.signed"));

  // Both parties' members read it (a plain member of the app's workspace too); nobody else.
  const copy = ok(await w.member.call("download_agreement_document", { agreement_id: a.id }));
  assert.equal(Buffer.from(copy.content_base64, "base64").toString(), SIGNED.toString());
  assert.equal(copy.sha256, sha(SIGNED));
  const cert = ok(await w.lp2.call("download_agreement_document", { agreement_id: a.id, part: "certificate" }));
  assert.equal(Buffer.from(cert.content_base64, "base64").toString(), CERT.toString());
  refused(await w.outsider.call("download_agreement_document", { agreement_id: a.id }), /No agreement/);
  refused(await w.otherLp.call("download_agreement_document", { agreement_id: a.id }), /No agreement/);
  refused(await w.admin.call("download_agreement_document", { agreement_id: a.id }));

  const trail = (await actions(w.store, a.id)).map((r) => r.action);
  for (const step of ["propose_app_agreement", "accept_app_agreement", "esign_document_created", "open_agreement_signing", "esign_signer_signed", "esign_completed", "download_agreement_document"]) assert.ok(trail.includes(step), step);
  assert.equal(trail.filter((x) => x === "esign_completed").length, 1, "completed once");
  assert.equal(trail.filter((x) => x === "sign_app_agreement").length, 0, "no manual signature recorded");
});

test("no template yet: accepted waits, the document is made on first signing; declined at signing, and ending one cancels its document", async () => {
  const w = await setup();
  const proposal = { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" };
  const a = ok(await w.dev.call("propose_app_agreement", proposal));
  const accepted = ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }));
  assert.equal(accepted.signing.ready, false);
  assert.match(accepted.signing.reason, /hasn't uploaded a program agreement template/);
  refused(await w.dev.call("get_agreement_signing_link", { agreement_id: a.id }), /hasn't uploaded/);
  // The firm's default template (attached to nothing) is used once it's there.
  ok(await w.lp.call("upload_agreement_template", upload));
  assert.ok(ok(await w.dev.call("get_agreement_signing_link", { agreement_id: a.id })).signing_url);
  const docId = [...w.service.docs.keys()][0];
  // A signer declines at the service: the agreement is declined.
  w.service.docs.get(docId).status = "Declined";
  assert.equal((await w.webhook(event("document_declined", docId))).status, 200);
  assert.equal(ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).agreements[0].status, "declined");

  // Ending an agreement with a document in progress cancels the document at the service.
  const b = ok(await w.dev.call("propose_app_agreement", proposal));
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: b.id, decision: "accept" }));
  const docB = [...w.service.docs.keys()][1];
  ok(await w.dev.call("terminate_app_agreement", { agreement_id: b.id, reason: "Changed our plans" }));
  assert.equal(w.service.docs.get(docB).status, "Canceled");
  assert.ok(w.service.calls.some((c) => c.method === "DELETE" && c.path.endsWith(`/documents/${docB}`)));
  assert.ok((await actions(w.store, b.id)).some((r) => r.action === "esign_canceled"));
  // An event for a document Mynt didn't make is ignored.
  assert.deepEqual((await w.webhook(event("document_completed", "doc-unknown"))).body, { received: true, ignored: true });
});

test("without e-signature configured: the feature says so and the manual flow still signs", async () => {
  const w = await setup({ esign: false });
  const a = ok(await w.dev.call("propose_app_agreement", { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" }));
  assert.equal(a.signed_by_esignature, false);
  const accepted = ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }));
  assert.equal(accepted.signing, undefined);
  refused(await w.dev.call("get_agreement_signing_link", { agreement_id: a.id }), /E-signature isn't configured on this deployment yet/);
  // Templates can still be uploaded ahead of it.
  ok(await w.lp.call("upload_agreement_template", upload));
  refused(await w.lp.call("upload_agreement_template", { name: "At the service", source: "provider_template", provider_template_id: "tpl-1" }), /isn't configured/);
  ok(await w.dev.call("sign_app_agreement", { agreement_id: a.id }));
  assert.equal(ok(await w.lp.call("sign_app_agreement", { agreement_id: a.id })).status, "signed");
  assert.equal((await w.webhook(event("document_completed", "doc-1"))).status, 503);
});

test("with e-signature, the production check names whose signature is missing, and the app's attention list hears of each e-signature step", async () => {
  const w = await setup();
  const workspace = (await w.store.getApp(w.app.id)).workspace_id;
  const attention = async () => ok(await w.dev.call("get_workspace_attention", { workspace_id: workspace })).items.filter((i) => i.kind === "app_agreement_update");
  const note = async () => ok(await w.dev.call("list_app_agreements", { app_id: w.app.id })).program_coverage.find((c) => c.product_id === "savings-account").note;
  ok(await w.lp.call("upload_agreement_template", upload));
  const proposal = { app_id: w.app.id, counterparty_entity_id: w.lpFirm.id, kind: "program", products: ["savings-account"], terms_summary: "Sponsor Bank's program for the savings product" };
  const a = ok(await w.dev.call("propose_app_agreement", proposal));
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: a.id, decision: "accept" }));
  const docA = [...w.service.docs.keys()][0];
  assert.match(await note(), /waiting for both signatures/);

  // The app's side signs first: the sponsor's signature is what's missing.
  w.service.sign(docA, "2");
  assert.equal((await w.webhook(event("document_signed", docA))).status, 200);
  assert.match(await note(), /waiting for Sponsor Bank's signature/);
  assert.equal((await attention()).length, 1, "only the acceptance: the app's own signature isn't news to it");

  // Then the sponsor signs: complete; the attention list says it's signed by both, low.
  w.service.sign(docA, "1");
  assert.equal((await w.webhook(event("document_completed", docA))).status, 200);
  let items = await attention();
  const completed = items.find((i) => i.title.includes("is signed by both sides"));
  assert.ok(completed, JSON.stringify(items));
  assert.equal(completed.severity, "low");
  assert.match(completed.href, new RegExp(`/${w.app.id}\\?tab=agreements$`));
  assert.ok(items.some((i) => i.title.includes("Sponsor Bank signed the program agreement by e-signature")));

  // Another app: the sponsor signs first, so it's the app's turn (medium for an owner); then it's declined at signing.
  const app2 = await w.store.createApp(w.dev.user.id, { name: "Second app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const b = ok(await w.dev.call("propose_app_agreement", { ...proposal, app_id: app2.id }));
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: b.id, decision: "accept" }));
  const docB = [...w.service.docs.keys()][1];
  w.service.sign(docB, "1");
  assert.equal((await w.webhook(event("document_signed", docB))).status, 200);
  const note2 = ok(await w.dev.call("list_app_agreements", { app_id: app2.id })).program_coverage[0].note;
  assert.match(note2, /waiting for your signature/);
  items = await attention();
  const yourTurn = items.find((i) => i.href.startsWith(`/${app2.id}`) && i.title.includes("signed the program agreement by e-signature"));
  assert.equal(yourTurn.severity, "medium");
  assert.match(yourTurn.detail, /waits for your side's signature/);
  w.service.docs.get(docB).status = "Declined";
  assert.equal((await w.webhook(event("document_declined", docB))).status, 200);
  const declined = (await attention()).find((i) => i.title.includes("was declined at signing"));
  assert.equal(declined.severity, "medium");

  // A third: its document expires at the service, which ends a program agreement: high.
  const app3 = await w.store.createApp(w.dev.user.id, { name: "Third app", description: "d", audience: "a", product_ids: ["savings-account"] }, workspace);
  const c = ok(await w.dev.call("propose_app_agreement", { ...proposal, app_id: app3.id }));
  ok(await w.lp.call("respond_to_app_agreement", { agreement_id: c.id, decision: "accept" }));
  const docC = [...w.service.docs.keys()][2];
  w.service.docs.get(docC).status = "Expired";
  assert.equal((await w.webhook(event("document_expired", docC))).status, 200);
  const expired = (await attention()).find((i) => i.title.includes("its e-signature document expired"));
  assert.equal(expired.severity, "high");
  assert.match(expired.detail, /Production needs a signed program agreement/);
});
