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
const ORIGIN = "https://app.example.com";
const scratch = [];
after(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

// A published, defined recurring deposit (with a key fact statement to show), open to developers; a
// developer's app on it with a sandbox key allowed from ORIGIN; the HTTP API in front.
async function world() {
  const ctx = await setup();
  await publishDefined(ctx, (d) => {
    d.descriptions.documents = { kfs: "https://bank.example.com/rd/kfs.pdf" };
    return d;
  });
  const access = await ctx.call(ctx.client, "set_product_access", {
    id: "everyday-rd",
    access_mode: "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: "https://bank.example.com/start" },
  });
  assert.equal(access.isError, false, JSON.stringify(access.data));
  const { user } = await ctx.store.createUser("Dev", ["developer"]);
  const dev = await ctx.connect(user);
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Saving made daily", audience: "Savers", product_ids: ["everyday-rd"] })).data;
  assert.ok(app.id, JSON.stringify(app));
  const key = (await ctx.call(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "test", allowed_origins: [ORIGIN] })).data.key;
  const http = createMcpHttpServer(ctx.store, null, {}, { publicUrl: "https://mynt.test" }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = async (method, path, secret, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const close = () => {
    http.closeAllConnections();
    http.close();
  };
  return { ...ctx, app, key, base, api, close };
}

test("client sessions: minted server-side, scoped, consent before hosted actions, evidence against the contract", async () => {
  const w = await world();
  try {
    const { api, key } = w;
    // Never from a browser, and only client actions of the session's products.
    assert.equal((await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"] }, { Origin: ORIGIN })).body.error, "server_only");
    const badScope = await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["premature_closure"] });
    assert.equal(badScope.status, 400);
    assert.match(badScope.body.message, /premature_closure/);
    assert.equal((await api("POST", "/v1/client_sessions", key, { product_ids: ["ppf"] })).status, 404, "not in the app");

    const minted = await api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["view_offers", "mandate_setup"], customer_ref: "cust_1", ttl_seconds: 600 });
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    const secret = minted.body.client_secret;
    assert.match(secret, /^mcs_test_/);

    // The device: its own secret, only from allowed origins; app keys don't work here.
    assert.equal((await api("GET", "/v1/client/offers", key)).status, 401);
    assert.equal((await api("GET", "/v1/client/offers", secret, undefined, { Origin: "https://evil.example.com" })).status, 403);
    const offers = await api("GET", "/v1/client/offers", secret, undefined, { Origin: ORIGIN });
    assert.equal(offers.status, 200);
    assert.equal(offers.headers.get("access-control-allow-origin"), ORIGIN);
    const [p] = offers.body.products;
    assert.equal(p.product_id, "everyday-rd");
    assert.equal(p.offers.length, 2);
    assert.deepEqual(p.actions.map((a) => a.id).sort(), ["mandate_setup", "view_offers"]);
    assert.deepEqual(p.documents, { kfs: "https://bank.example.com/rd/kfs.pdf" });

    // No hosted action without its consent; evidence only for the contract's documents and purposes.
    const early = await api("POST", "/v1/client/actions/mandate_setup", secret, { product_id: "everyday-rd" });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "consent_required");
    assert.equal((await api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "disclosure_shown", subject: "brochure" })).body.error, "unknown_document");
    assert.equal((await api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "consent_given", subject: "marketing" })).body.error, "unknown_purpose");
    const hash = `sha256:${"a".repeat(64)}`;
    assert.equal((await api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "disclosure_shown", subject: "kfs", content_hash: hash })).status, 201);
    assert.equal((await api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "consent_given", subject: "mandate_setup", content_hash: hash })).status, 201);

    const started = await api("POST", "/v1/client/actions/mandate_setup", secret, { product_id: "everyday-rd" });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.match(started.body.redirect_url, /^https:\/\/mynt\.test\/v1\/sandbox\/handoffs\//);
    assert.equal((await api("POST", "/v1/client/actions/premature_closure", secret, { product_id: "everyday-rd" })).body.error, "action_not_in_scope");

    // Withdrawn consent stops the action again.
    await api("POST", "/v1/client/evidence", secret, { product_id: "everyday-rd", type: "consent_withdrawn", subject: "mandate_setup" });
    assert.equal((await api("POST", "/v1/client/actions/mandate_setup", secret, { product_id: "everyday-rd" })).body.error, "consent_required");
    const evidence = await w.store.clientEvidence(w.app.id);
    assert.deepEqual(evidence.map((e) => e.type).sort(), ["consent_given", "consent_withdrawn", "disclosure_shown"]);
    assert.ok(evidence.every((e) => e.customer_ref === "cust_1" && e.contract_hash?.startsWith("sha256:")));

    // Servers read the contract; an expired session stops working.
    const contract = await api("GET", "/v1/products/everyday-rd/contract", key);
    assert.equal(contract.status, 200);
    assert.equal(contract.body.contract_hash, p.contract_hash);
    await w.store.db.query("UPDATE financial_products.client_sessions SET expires_at = now() - interval '1 second'");
    assert.equal((await api("GET", "/v1/client/offers", secret)).body.error, "session_expired");
  } finally {
    w.close();
  }
});

test("a Mynt-hosted app's key arrives from the edge: honoured only with the placeholder, never on client routes", async () => {
  const w = await world();
  try {
    const { api, key } = w;
    const EDGE = "x-mynt-app-key";
    const mint = (bearer, headers = {}) => api("POST", "/v1/client_sessions", bearer, { product_ids: ["everyday-rd"] }, headers);
    // The app sends the placeholder; the edge adds its key.
    assert.equal((await mint("mynt_test_injected_at_edge", { [EDGE]: key })).status, 201);
    // The placeholder alone, or with the other environment's key, is nothing.
    assert.equal((await mint("mynt_test_injected_at_edge")).status, 401);
    assert.equal((await mint("mynt_live_injected_at_edge", { [EDGE]: key })).status, 401, "a sandbox key can't stand in for a live placeholder");
    assert.equal((await mint("mynt_test_injected_at_edge", { [EDGE]: "mynt_test_not_a_real_key_000000" })).status, 401);
    // A client session isn't swapped for the app key: the injected header is ignored next to any other bearer.
    const session = (await mint(key)).body.client_secret;
    assert.equal((await mint(session, { [EDGE]: key })).status, 401, "a session token plus the injected key doesn't reach server routes");
    assert.equal((await api("GET", "/v1/client/offers", session, undefined, { Origin: ORIGIN, [EDGE]: key })).status, 200, "client routes run on the session alone");
    assert.equal((await api("GET", "/v1/client/offers", "mynt_test_injected_at_edge", undefined, { Origin: ORIGIN, [EDGE]: key })).status, 401, "and never take the app key");
  } finally {
    w.close();
  }
});

test("the generated SDK has a server client that mints sessions and a browser client that uses them", async () => {
  const w = await world();
  try {
    const record = await w.store.getProduct("everyday-rd");
    const files = await generateSdk({ name: "Saver kit", version: "1.0.0", languages: ["typescript"], baseUrl: w.base, products: [{ record, issuer: "Ines Bank" }] });
    const file = (p) => files.find((f) => f.path === p)?.content;
    const doc = JSON.parse(file("openapi.json"));
    for (const path of ["/client_sessions", "/products/{id}/contract", "/client/offers", "/client/actions/{action}", "/client/evidence"]) assert.ok(doc.paths[path], path);
    assert.ok(doc.components.securitySchemes.clientSession);
    const browser = file("typescript/src/browser.ts");
    assert.doesNotMatch(browser, /node:crypto|mynt_live_|apiKey:/, "the browser client holds no key and uses no Node built-ins");
    assert.match(file("typescript/src/index.ts"), /createClientSession/);
    assert.deepEqual(JSON.parse(file("typescript/package.json")).exports["./browser"].default, "./dist/browser.js");

    // Both typecheck, and a misuse (a server-only action from the device) doesn't.
    const dir = mkdtempSync(join(ROOT, "node_modules", ".mynt-client-sdk-"));
    scratch.push(dir);
    const sources = { "schema.d.ts": file("typescript/src/schema.d.ts"), "index.ts": file("typescript/src/index.ts"), "browser.ts": file("typescript/src/browser.ts") };
    const usage = `import { createMyntClient } from "./index.js";
import { createMyntBrowserClient } from "./browser.js";
export async function server() {
  const s = await createMyntClient({ apiKey: "mynt_test_x" }).createClientSession(["everyday-rd"], ["mandate_setup"], { customerRef: "c1" });
  return s.client_secret;
}
export async function device(secret: string) {
  const c = createMyntBrowserClient({ clientSecret: secret });
  await c.giveConsent("everyday-rd", "mandate_setup", "I agree");
  return (await c.startAction("everyday-rd", "mandate_setup")).redirect_url;
}
`;
    const misuse = `import { createMyntBrowserClient } from "./browser.js";
export const go = (s: string) => createMyntBrowserClient({ clientSecret: s }).startAction("everyday-rd", "premature_closure");
`;
    const check = (extra) => {
      for (const [n, c] of Object.entries({ ...sources, ...extra })) writeFileSync(join(dir, n), c);
      const program = ts.createProgram(
        Object.keys({ ...sources, ...extra }).map((f) => join(dir, f)),
        {
          strict: true,
          noEmit: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
          types: ["node"],
          typeRoots: [join(ROOT, "node_modules/@types")],
          skipLibCheck: true,
        },
      );
      return ts.getPreEmitDiagnostics(program).map((d) => `${d.file?.fileName.split("/").pop() ?? ""}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    };
    assert.deepEqual(check({ "usage.ts": usage }), []);
    const errors = check({ "misuse.ts": misuse });
    assert.equal(errors.length, 1, errors.join("\n"));
    assert.match(errors[0], /^misuse\.ts/);

    // The browser client runs against the real API: consent, document evidence, a hosted action.
    const js = ts.transpileModule(sources["browser.ts"], { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
    writeFileSync(join(dir, "browser.mjs"), js);
    const mod = await import(pathToFileURL(join(dir, "browser.mjs")).href);
    assert.throws(() => mod.createMyntBrowserClient({ clientSecret: w.key }), /app key/);
    const secret = (await w.api("POST", "/v1/client_sessions", w.key, { product_ids: ["everyday-rd"], scopes: ["mandate_setup"] })).body.client_secret;
    const device = mod.createMyntBrowserClient({ clientSecret: secret, baseUrl: `${w.base}/v1` });
    assert.equal((await device.offers()).products[0].product_id, "everyday-rd");
    await device.documentShown("everyday-rd", "kfs", "Key fact statement: 7.1% p.a.");
    await device.giveConsent("everyday-rd", "mandate_setup", "I agree to set up the mandate");
    assert.match((await device.startAction("everyday-rd", "mandate_setup")).redirect_url, /sandbox\/handoffs/);
    const shown = (await w.store.clientEvidence(w.app.id)).find((e) => e.type === "disclosure_shown");
    assert.equal(shown.content_hash, `sha256:${(await import("node:crypto")).createHash("sha256").update("Key fact statement: 7.1% p.a.").digest("hex")}`);
  } finally {
    w.close();
  }
});

// ---- live keys: a sponsored product only under a signed program agreement in force ----

test("a live key isn't served a sponsored product without a program agreement in force (never signed, ended, or signed only in test mode); sandbox keeps working", async () => {
  const { randomUUID } = await import("node:crypto");
  const { inProduction } = await import("./helpers.js");
  const w = await world();
  try {
    const { api, store, app } = w;
    const T = "financial_products";
    const dev = (await store.getApp(app.id)).owner_id;
    // The app is live: in production, published, with a live key. Nobody sponsors its product yet.
    await inProduction(store, app.id);
    await store.db.query(`UPDATE ${T}.apps SET status = 'published' WHERE id = $1`, [app.id]);
    const live = (await store.createApiKey(dev, { app_id: app.id, environment: "live", label: "prod", allowed_origins: [ORIGIN] })).secret;
    assert.match(live, /^mynt_live_/);
    const mint = (key) => api("POST", "/v1/client_sessions", key, { product_ids: ["everyday-rd"], scopes: ["view_offers"] });
    const listed = async (key) => (await api("GET", "/v1/products", key)).body.products.map((p) => p.id);
    assert.equal((await mint(live)).status, 201, "a product nobody sponsors needs no agreement");

    // A licence provider's sponsorship of the product is approved: from now on real customers need its agreement.
    const sponsor = await store.createEntity(null, { name: "Sponsor Bank", registration_numbers: {}, regions: ["IN"] });
    const builder = await store.createEntity(null, { name: "Builder Inc", registration_numbers: {}, regions: ["IN"] });
    await store.db.query(
      `INSERT INTO ${T}.sponsorships (id, product_id, component_key, builder_entity_id, provider_entity_id, jurisdictions, status) VALUES ($1, 'everyday-rd', 'main', $2, $3, ARRAY['in'], 'approved')`,
      [randomUUID(), builder.id, sponsor.id],
    );
    const refused = await mint(live);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error, "program_agreement_required");
    assert.match(refused.body.message, /No signed program agreement with Sponsor Bank for /);
    assert.match(refused.body.message, /Sandbox keys still work/);
    assert.deepEqual(await listed(live), [], "not in the live catalogue either");
    assert.equal((await api("GET", "/v1/products/everyday-rd/contract", live)).body.error, "program_agreement_required");
    assert.equal((await api("POST", "/v1/handoffs", live, { product_id: "everyday-rd", action: "deep_link" })).body.error, "program_agreement_required");
    // Sandbox is untouched.
    assert.equal((await mint(w.key)).status, 201);
    assert.deepEqual(await listed(w.key), ["everyday-rd"]);

    // A signed agreement in force with that sponsor, covering the product: served.
    const agreement = randomUUID();
    const workspace = (await store.getApp(app.id)).workspace_id;
    await store.db.query(
      `INSERT INTO ${T}.app_agreements (id, workspace_id, app_id, counterparty_entity_id, kind, products, terms_summary, status, signed_at, app_signed_at, counterparty_signed_at, proposed_by_side, scopes)
       VALUES ($1, $2, $3, $4, 'program', '["everyday-rd"]', 'The sponsor''s program', 'signed', now(), now(), now(), 'app', ARRAY['technology'])`,
      [agreement, workspace, app.id, sponsor.id],
    );
    const minted = await mint(live);
    assert.equal(minted.status, 201, JSON.stringify(minted.body));
    assert.match(minted.body.client_secret, /^mcs_live_/);
    assert.deepEqual(await listed(live), ["everyday-rd"]);

    // Signed only in the e-signature service's test mode: not binding, so not served.
    await store.db.query(`INSERT INTO ${T}.app_agreement_documents (agreement_id, provider, test_mode, status, completed_at) VALUES ($1, 'signwell', true, 'completed', now())`, [agreement]);
    const test = await mint(live);
    assert.equal(test.body.error, "program_agreement_required");
    assert.match(test.body.message, /test mode/);
    await store.db.query(`UPDATE ${T}.app_agreement_documents SET test_mode = false WHERE agreement_id = $1`, [agreement]);
    assert.equal((await mint(live)).status, 201);

    // The sponsor ends it after the app went live: no new live sessions on that product, and it leaves the live
    // catalogue; a customer session already open runs out on its own (within the hour), and sandbox still works.
    await store.db.query(`UPDATE ${T}.app_agreements SET status = 'terminated', terminated_at = now(), termination_reason = 'Program wound down' WHERE id = $1`, [agreement]);
    const after = await mint(live);
    assert.equal(after.status, 403);
    assert.match(after.body.message, /it was ended on .*Program wound down/);
    assert.deepEqual(await listed(live), []);
    assert.equal((await api("GET", "/v1/client/offers", minted.body.client_secret)).status, 200, "an open session isn't cut off mid-flow");
    assert.equal((await mint(w.key)).status, 201);

    // Expired counts the same.
    await store.db.query(`UPDATE ${T}.app_agreements SET status = 'signed', terminated_at = NULL, effective_to = current_date - 1 WHERE id = $1`, [agreement]);
    assert.equal((await mint(live)).body.error, "program_agreement_required");
    await store.db.query(`UPDATE ${T}.app_agreements SET effective_to = NULL WHERE id = $1`, [agreement]);
    assert.equal((await mint(live)).status, 201);
  } finally {
    w.close();
  }
});
