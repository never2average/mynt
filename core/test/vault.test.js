import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { createMcpHttpServer } from "../dist/http.js";
import { generateSdk } from "../dist/sdk.js";
import { publishDefined, setup } from "./v2-helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

// The recurring deposit whose mandate needs PAN and bank details, a developer's app with a saved default
// journey, a sandbox key, and the HTTP API.
async function world() {
  const ctx = await setup();
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    d.partner_handoffs[0].sends = { type: "object", required: ["pan", "bank_account_number", "ifsc", "amount"] };
    return d;
  });
  await ctx.call(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  const { user } = await ctx.store.createUser("Dev", ["developer"]);
  const dev = await ctx.connect(user);
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Daily saving", audience: "Savers", product_ids: ["everyday-rd"] })).data;
  const key = (await ctx.call(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test" })).data.key;
  const journey = (await ctx.call(dev, "get_default_journey", { product_id: "everyday-rd" })).data.journey;
  assert.equal((await ctx.call(dev, "save_journey", { app_id: app.id, journey })).isError, false);
  const http = createMcpHttpServer(ctx.store, null, {}, { publicUrl: "https://mynt.test" }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = async (method, path, secret, body) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  const session = async (customer_ref) =>
    (await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["mandate_setup"], ...(customer_ref ? { customer_ref } : {}) })).body.client_secret;
  const consent = (secret) => api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "consent_given", subject: "mandate_setup" });
  const close = () => {
    http.closeAllConnections();
    http.close();
  };
  return { ...ctx, app, key, base, api, session, consent, close };
}

test("the vault: only needed fields, after consent, sensitive ones from secure inputs; encrypted, masked, erasable", async () => {
  const w = await world();
  try {
    const { api } = w;
    const anonymous = await w.session();
    assert.equal((await api("POST", "/v1/client/fields", anonymous, { product_id: "everyday-rd", values: { ifsc: "HDFC0001234" } })).body.error, "customer_ref_required");

    const s = await w.session("cust_1");
    const before = await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { ifsc: "HDFC0001234" } });
    assert.match(before.body.message, /record the customer's consent first/);
    await w.consent(s);
    const bad = await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { pan: "ABCPV1234K", email: "a@b.co", ifsc: "nope" } });
    assert.equal(bad.status, 400);
    assert.match(bad.body.message, /pan is sensitive: send it from a secure field/);
    assert.match(bad.body.message, /email: no action of 'everyday-rd' needs it/);
    assert.match(bad.body.message, /ifsc: not a valid IFSC/);
    assert.equal((await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { pan: "ABCPV1234K", bank_account_number: "123456789012" }, source: "secure_field" })).status, 201);

    // Hosted actions wait for their data.
    const missing = await api("POST", "/v1/client/actions/mandate_setup", s, { product_id: "everyday-rd" });
    assert.equal(missing.body.error, "data_required");
    assert.match(missing.body.message, /needs ifsc/);
    assert.equal((await api("POST", "/v1/client/fields", s, { product_id: "everyday-rd", values: { ifsc: "HDFC0001234" } })).status, 201);
    assert.equal((await api("POST", "/v1/client/actions/mandate_setup", s, { product_id: "everyday-rd" })).status, 201);

    // Held values come back masked, and are encrypted in the database.
    const held = (await api("GET", "/v1/client/fields", s)).body.fields;
    assert.deepEqual(Object.fromEntries(held.map((h) => [h.field, h.value])), { bank_account_number: "••••••••9012", ifsc: "•••••••1234", pan: "••••••234K" });
    const rows = (await w.store.db.query("SELECT sealed FROM financial_products.customer_vault")).rows;
    assert.ok(rows.every((r) => r.sealed.startsWith("v1:") && !r.sealed.includes("ABCPV1234K") && !r.sealed.includes("123456789012")));

    // The same customer in a new session needn't be asked again; another customer must.
    const again = await w.session("cust_1");
    await w.consent(again);
    assert.equal((await api("POST", "/v1/client/actions/mandate_setup", again, { product_id: "everyday-rd" })).status, 201);

    // Prefill (sandbox fixtures) fills what a new customer is missing.
    const other = await w.session("cust_2");
    assert.equal((await api("POST", "/v1/client/prefill", other, { product_id: "everyday-rd", source: "account_aggregator", fields: ["bank_account_number", "ifsc"] })).body.error, "consent_required");
    await w.consent(other);
    assert.match((await api("POST", "/v1/client/prefill", other, { product_id: "everyday-rd", source: "account_aggregator", fields: ["pan"] })).body.message, /Can't prefill pan from account_aggregator/);
    const filled = await api("POST", "/v1/client/prefill", other, { product_id: "everyday-rd", source: "account_aggregator", fields: ["bank_account_number", "ifsc"] });
    assert.deepEqual(filled.body.filled, ["bank_account_number", "ifsc"]);
    await api("POST", "/v1/client/prefill", other, { product_id: "everyday-rd", source: "digilocker", fields: ["pan"] });
    assert.equal((await api("POST", "/v1/client/actions/mandate_setup", other, { product_id: "everyday-rd" })).status, 201);

    // Erasure: the customer's data is gone, and the action needs it again.
    assert.equal((await api("DELETE", "/v1/client/fields", s)).body.erased, 3);
    assert.deepEqual((await api("GET", "/v1/client/fields", s)).body.fields, []);
    assert.equal((await api("POST", "/v1/client/actions/mandate_setup", s, { product_id: "everyday-rd" })).body.error, "data_required");
  } finally {
    w.close();
  }
});

test("the browser SDK's journey runner walks the saved journey end to end", async () => {
  const w = await world();
  try {
    const record = await w.store.getProduct("everyday-rd");
    const files = await generateSdk({ name: "Saver kit", version: "1.0.0", languages: ["typescript"], baseUrl: w.base, products: [{ record, issuer: "Ines Bank" }] });
    const browser = files.find((f) => f.path === "typescript/src/browser.ts").content;
    const dir = mkdtempSync(join(ROOT, "node_modules", ".mynt-journey-sdk-"));
    scratch.push(dir);
    writeFileSync(join(dir, "browser.mjs"), ts.transpileModule(browser, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText);
    const sdk = await import(pathToFileURL(join(dir, "browser.mjs")).href);

    const device = sdk.createMyntBrowserClient({ clientSecret: await w.session("cust_9"), baseUrl: `${w.base}/v1` });
    const run = await sdk.createJourneyRunner(device, "everyday_rd_default");
    assert.equal(run.current.id, "intro");
    await assert.rejects(run.complete(), /Pass the text shown for document kfs/);
    await run.complete({ documents: { kfs: "Key facts: 7.1% p.a., 12 to 60 months" } });
    assert.equal(run.current.id, "consent_mandate_setup");
    await run.complete({ consentText: "I agree to share my details to set up the mandate" });
    assert.equal(run.current.id, "details_mandate_setup");
    await run.complete({ fields: { pan: "ABCPV1234K", bank_account_number: "123456789012", ifsc: "HDFC0001234" } });
    assert.equal(run.current.id, "mandate_setup");
    const { redirect_url } = await run.complete();
    assert.match(redirect_url, /sandbox\/handoffs/);
    await run.complete({ outcome: "completed" });
    assert.equal(run.current.id, "done");
    assert.equal(run.done, true);

    const evidence = (await w.store.clientEvidence(w.app.id)).map((e) => `${e.type}:${e.subject}`).sort();
    assert.deepEqual(evidence, ["consent_given:mandate_setup", "disclosure_shown:kfs"]);
    const sources = Object.fromEntries((await w.store.vaultFields(w.app.id, "cust_9", true)).map((f) => [f.field, f.source]));
    assert.deepEqual(sources, { bank_account_number: "secure_field", ifsc: "typed", pan: "secure_field" });
  } finally {
    w.close();
  }
});
