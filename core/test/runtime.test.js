import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { checkWebhookUrl, compareSemver, deliverDueWebhooks, emitEvent, retryDelay, webhookUrlProblem } from "../dist/runtime.js";
import { Store } from "../dist/store.js";
import { CATALOG, inProduction, licensed } from "./helpers.js";

const SANDBOX_ORIGIN = "https://mynt.test";

async function setup(runtimeOptions = {}) {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, `${name.toLowerCase()}@example.com`]);
    return { ...user, email: `${name.toLowerCase()}@example.com` };
  };
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content[0].text;
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    return { isError: res.isError ?? false, data };
  };
  const http = createMcpHttpServer(store, null, {}, { publicUrl: SANDBOX_ORIGIN, ...runtimeOptions }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  // A runtime API request: { status, body, headers }.
  const api = async (method, path, key, body, headers = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const close = () => {
    http.closeAllConnections();
    http.close();
  };
  return { pg, store, as, connect, call, api, close };
}

const product = (over = {}) => ({
  id: "green-fd",
  name: "Green Fixed Deposit",
  product_line: "account_operations",
  category: "deposits",
  region: "IN",
  risk_level: "low",
  liquidity: "low",
  typical_horizon: "medium",
  return_type: "fixed_interest",
  regulator: "RBI",
  description: "Fixed deposit whose proceeds fund certified renewable-energy projects.",
  key_features: ["Fixed rate", "Funds green projects"],
  ...over,
});

const HANDOFF_URL = "https://onboard.example.com/start?src=mynt";

// An innovator with a published, licensed product, open to developers with a hand-off URL.
async function publishedBy(ctx, name, over = {}, terms = {}) {
  const user = await ctx.as(name, ["innovator"]);
  await licensed(ctx.store, user, { region: "IN", category: "deposits", action: "issuance" });
  const client = await ctx.connect(user);
  const id = over.id ?? "green-fd";
  assert.equal((await ctx.call(client, "create_product", product(over))).isError, false);
  await ctx.call(client, "test_product", { id });
  assert.equal((await ctx.call(client, "publish_product", { id })).isError, false);
  const access = await ctx.call(client, "set_product_access", {
    id,
    access_mode: terms.access_mode ?? "open",
    build_terms: { permitted_actions: ["display", "deep_link", "initiate_onboarding"], handoff_url: HANDOFF_URL, ...terms.build_terms },
  });
  assert.equal(access.isError, false, JSON.stringify(access.data));
  return { user, client };
}

// A developer with an app on green-fd (and the bundled ppf).
async function devWithApp(ctx, name = "Dev", fields = {}) {
  const user = await ctx.as(name, ["developer"]);
  const client = await ctx.connect(user);
  const app = (await ctx.call(client, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["green-fd", "ppf"], ...fields })).data;
  assert.ok(app.id, JSON.stringify(app));
  // These tests are about what a production app does with live keys (production gates real money).
  await inProduction(ctx.store, app.id);
  return { user, client, app };
}

const key = async (ctx, client, app_id, environment = "live", extra = {}) => {
  const r = await ctx.call(client, "create_api_key", { app_id, environment, label: `${environment} key`, ...extra });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data;
};

// Records webhook POSTs; answers with the next status in `statuses` (then 200).
async function receiver(statuses = []) {
  const received = [];
  const server = createHttpServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(statuses.shift() ?? 200).end();
    });
  }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, received, close: () => server.close() };
}

const verify = (secret, header, body) => {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  return createHmac("sha256", secret).update(`${t}.${body}`).digest("hex") === v1;
};

const later = (hours = 24) => new Date(Date.now() + hours * 3600_000);

test("API keys: shown once, stored hashed, live only once published, rotation and revocation", async () => {
  const ctx = await setup();
  try {
    await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx);

    const live = await key(ctx, dev, app.id, "live");
    const sandbox = await key(ctx, dev, app.id, "sandbox");
    assert.match(live.key, /^mynt_live_[A-Za-z0-9_-]{20,}$/);
    assert.match(sandbox.key, /^mynt_test_/);
    assert.match(live.note, /once the app is published/);

    // Only the hash is stored, and the secret never comes back.
    const { rows } = await ctx.pg.query("SELECT * FROM financial_products.api_keys");
    assert.equal(rows.length, 2);
    assert.ok(rows.some((r) => r.key_hash === createHash("sha256").update(live.key).digest("hex")));
    assert.ok(!JSON.stringify(rows).includes(live.key));
    const listed = (await ctx.call(dev, "list_api_keys", { app_id: app.id })).data;
    assert.equal(listed.length, 2);
    assert.ok(!JSON.stringify(listed).includes(live.key) && !JSON.stringify(listed).includes(sandbox.key));
    assert.equal(listed[0].prefix, live.key.slice(0, 14));

    assert.equal((await ctx.api("GET", "/v1/products")).status, 401);
    assert.equal((await ctx.api("GET", "/v1/products", "mynt_live_bogus")).body.error, "invalid_key");
    assert.equal((await ctx.api("GET", "/v1/products", "fpm_not_an_app_key")).status, 401);
    const early = await ctx.api("GET", "/v1/products", live.key);
    assert.equal(early.status, 403);
    assert.equal(early.body.error, "app_not_published");
    assert.equal((await ctx.api("GET", "/v1/products", sandbox.key)).status, 200, "sandbox keys work on drafts");

    assert.equal((await ctx.call(dev, "publish_app", { app_id: app.id })).data.status, "published");
    assert.equal((await ctx.api("GET", "/v1/products", live.key)).status, 200);

    const rotated = (await ctx.call(dev, "rotate_api_key", { key_id: live.id })).data;
    assert.equal(rotated.id, live.id);
    assert.notEqual(rotated.key, live.key);
    assert.equal((await ctx.api("GET", "/v1/products", live.key)).status, 401, "old secret stops working");
    assert.equal((await ctx.api("GET", "/v1/products", rotated.key)).status, 200);

    assert.equal((await ctx.call(dev, "revoke_api_key", { key_id: live.id })).data.status, "revoked");
    assert.equal((await ctx.api("GET", "/v1/products", rotated.key)).status, 401);
    assert.equal((await ctx.call(dev, "rotate_api_key", { key_id: live.id })).isError, true);

    const actions = (await ctx.store.auditLog()).map((a) => a.action);
    for (const a of ["create_api_key", "rotate_api_key", "revoke_api_key"]) assert.ok(actions.includes(a), a);
  } finally {
    ctx.close();
  }
});

test("GET /v1/products: only published products the app has access to, and revocation is immediate", async () => {
  const ctx = await setup();
  try {
    const { client: inno } = await publishedBy(ctx, "Ines", {}, { access_mode: "approval" });
    const { client: dev, app } = await devWithApp(ctx);
    const sandbox = (await key(ctx, dev, app.id, "sandbox")).key;

    // Approval product: not shown until approved.
    assert.deepEqual((await ctx.api("GET", "/v1/products", sandbox)).body.products.map((p) => p.id), ["ppf"]);
    assert.equal((await ctx.api("GET", "/v1/products/green-fd", sandbox)).status, 404);
    const req = (await ctx.call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd" })).data;
    await ctx.call(inno, "review_request", { request_id: req.id, decision: "approve" });

    const { body } = await ctx.api("GET", "/v1/products", sandbox);
    assert.deepEqual(body.products.map((p) => p.id).sort(), ["green-fd", "ppf"]);
    const fd = body.products.find((p) => p.id === "green-fd");
    assert.equal(fd.name, "Green Fixed Deposit");
    assert.equal(fd.version, 1);
    assert.deepEqual(fd.build_terms.permitted_actions, ["display", "deep_link", "initiate_onboarding"]);
    assert.equal(fd.build_terms.handoff_url, undefined, "the hand-off URL is used through /v1/handoffs");
    assert.equal((await ctx.api("GET", "/v1/products/green-fd", sandbox)).body.id, "green-fd");
    assert.equal((await ctx.api("GET", "/v1/products/nope", sandbox)).body.error, "product_not_found");

    const post = await ctx.api("POST", "/v1/products", sandbox, {});
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    assert.equal((await ctx.api("GET", "/v1/nothing", sandbox)).status, 404);
    assert.equal(post.headers.get("access-control-allow-origin"), null, "no CORS wildcard");

    await ctx.call(inno, "revoke_access", { request_id: req.id, reason: "Breached our terms" });
    assert.deepEqual((await ctx.api("GET", "/v1/products", sandbox)).body.products.map((p) => p.id), ["ppf"]);
    assert.equal((await ctx.api("GET", "/v1/products/green-fd", sandbox)).status, 404);
  } finally {
    ctx.close();
  }
});

test("hand-offs: permitted actions, the innovator's handoff_url, and no consumer data", async () => {
  const ctx = await setup({ maxBodyBytes: 512 });
  try {
    const { client: inno } = await publishedBy(ctx, "Ines", {}, { build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: undefined } });
    const { client: dev, app } = await devWithApp(ctx);
    await ctx.call(dev, "publish_app", { app_id: app.id });
    const live = (await key(ctx, dev, app.id, "live")).key;

    const notPermitted = await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "initiate_onboarding" });
    assert.equal(notPermitted.status, 403);
    assert.equal(notPermitted.body.error, "action_not_permitted");
    const unset = await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link" });
    assert.equal(unset.status, 409);
    assert.equal(unset.body.error, "handoff_not_configured");
    assert.match(unset.body.message, /handoff_url/);

    assert.equal(
      (await ctx.call(inno, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: "http://insecure.example.com" } })).isError,
      true,
      "handoff_url must be https",
    );
    await ctx.call(inno, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: { permitted_actions: ["display", "deep_link"], handoff_url: HANDOFF_URL } });

    const ok = await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link", consumer_ref: "user_42" });
    assert.equal(ok.status, 201);
    const redirect = new URL(ok.body.redirect_url);
    assert.equal(redirect.origin + redirect.pathname, "https://onboard.example.com/start");
    assert.equal(redirect.searchParams.get("src"), "mynt");
    assert.equal(redirect.searchParams.get("handoff_id"), ok.body.handoff_id);
    assert.equal(redirect.searchParams.get("app_id"), app.id);
    assert.equal(ok.body.sandbox, false);

    // Only an opaque reference: no phone/account numbers, no extra fields, nothing oversized.
    assert.equal((await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link", consumer_ref: "9876543210" })).status, 400);
    assert.equal((await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link", consumer_ref: "a@b.com" })).status, 400);
    const extra = await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link", pan: "ABCDE1234F" });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error, "invalid_request");
    assert.equal((await ctx.api("POST", "/v1/handoffs", live, "{nope")).body.error, "invalid_json");
    assert.equal((await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link", pad: "x".repeat(2000) })).status, 413);
    assert.equal((await ctx.api("POST", "/v1/handoffs", live, { product_id: "nope", action: "deep_link" })).status, 404);

    // Sandbox: a simulated Mynt URL instead of the innovator's flow.
    const sandbox = (await key(ctx, dev, app.id, "sandbox")).key;
    const sim = await ctx.api("POST", "/v1/handoffs", sandbox, { product_id: "green-fd", action: "deep_link" });
    assert.equal(sim.status, 201);
    assert.equal(sim.body.redirect_url, `${SANDBOX_ORIGIN}/v1/sandbox/handoffs/${sim.body.handoff_id}`);
    const page = await ctx.api("GET", `/v1/sandbox/handoffs/${sim.body.handoff_id}`);
    assert.equal(page.status, 200);
    assert.equal(page.body.status, "started");
    assert.equal((await ctx.api("GET", `/v1/sandbox/handoffs/${ok.body.handoff_id}`)).status, 404, "live hand-offs have no sandbox page");
  } finally {
    ctx.close();
  }
});

test("events and metrics: live only by default, per product and day; developers see only their apps", async () => {
  const ctx = await setup();
  try {
    const { client: inno } = await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx);
    await ctx.call(dev, "publish_app", { app_id: app.id });
    const live = (await key(ctx, dev, app.id, "live")).key;
    const sandbox = (await key(ctx, dev, app.id, "sandbox")).key;

    for (let i = 0; i < 3; i++) assert.equal((await ctx.api("POST", "/v1/events", live, { type: "view", product_id: "green-fd", screen: "home" })).status, 202);
    await ctx.api("POST", "/v1/events", live, { type: "view", product_id: "ppf" });
    await ctx.api("POST", "/v1/events", live, { type: "click", product_id: "green-fd", screen: "product/green-fd" });
    await ctx.api("POST", "/v1/events", live, { type: "handoff_started", product_id: "green-fd" });
    for (let i = 0; i < 5; i++) await ctx.api("POST", "/v1/events", sandbox, { type: "view", product_id: "green-fd" });
    assert.equal((await ctx.api("POST", "/v1/events", live, { type: "purchase", product_id: "green-fd" })).status, 400);
    assert.equal((await ctx.api("POST", "/v1/events", live, { type: "view", product_id: "elsewhere" })).status, 404);

    const h = (await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "deep_link" })).body;
    await ctx.api("POST", "/v1/handoffs", live, { product_id: "green-fd", action: "initiate_onboarding" });
    const sim = (await ctx.api("POST", "/v1/handoffs", sandbox, { product_id: "green-fd", action: "deep_link" })).body;
    await ctx.call(dev, "simulate_handoff", { handoff_id: sim.handoff_id, outcome: "completed" });
    // The innovator's flow reports how a live hand-off ended.
    assert.equal((await ctx.call(dev, "report_handoff_outcome", { handoff_id: h.handoff_id, outcome: "completed" })).isError, true, "innovator tool");
    assert.equal((await ctx.call(inno, "report_handoff_outcome", { handoff_id: h.handoff_id, outcome: "completed" })).data.status, "completed");
    assert.equal((await ctx.call(inno, "report_handoff_outcome", { handoff_id: sim.handoff_id, outcome: "failed" })).isError, true, "sandbox ones are simulated");

    const m = (await ctx.call(dev, "get_app_metrics", { app_id: app.id })).data;
    assert.deepEqual(
      { views: m.totals.views, clicks: m.totals.clicks, events: m.totals.handoff_events, started: m.totals.handoffs_started, completed: m.totals.handoffs_completed, failed: m.totals.handoffs_failed },
      { views: 4, clicks: 1, events: 1, started: 2, completed: 1, failed: 0 },
    );
    assert.equal(m.totals.conversion_rate, 0.25);
    assert.equal(m.totals.handoff_completion_rate, 0.5);
    const fd = m.by_product.find((p) => p.product_id === "green-fd");
    assert.equal(fd.views, 3);
    assert.equal(m.by_day.length, 1);
    assert.equal(m.by_day[0].day, new Date().toISOString().slice(0, 10));
    const withSandbox = (await ctx.call(dev, "get_app_metrics", { app_id: app.id, include_sandbox: true })).data;
    assert.equal(withSandbox.totals.views, 9);
    assert.equal(withSandbox.totals.handoffs_completed, 2);
    const past = (await ctx.call(dev, "get_app_metrics", { app_id: app.id, from: "2020-01-01", to: "2020-01-31" })).data;
    assert.equal(past.totals.views, 0);

    // Innovators see their product across apps; nobody sees other people's numbers.
    const { client: dev2, app: app2 } = await devWithApp(ctx, "Dana");
    await ctx.call(dev2, "publish_app", { app_id: app2.id });
    await ctx.api("POST", "/v1/events", (await key(ctx, dev2, app2.id, "live")).key, { type: "view", product_id: "green-fd" });
    const dist = (await ctx.call(inno, "get_product_distribution_metrics", { product_id: "green-fd" })).data;
    assert.equal(dist.totals.views, 4);
    assert.deepEqual(dist.by_app.map((a) => a.views).sort(), [1, 3]);
    assert.equal(dist.by_app.find((a) => a.app_id === app.id).developer.email, "dev@example.com");
    assert.equal((await ctx.call(dev2, "get_app_metrics", { app_id: app.id })).isError, true);
    const other = await ctx.connect(await ctx.as("Otto", ["innovator"]));
    assert.equal((await ctx.call(other, "get_product_distribution_metrics", { product_id: "green-fd" })).isError, true);
    assert.equal((await ctx.call(other, "report_handoff_outcome", { handoff_id: h.handoff_id, outcome: "failed" })).isError, true);
  } finally {
    ctx.close();
  }
});

test("webhooks: events from innovator actions, signed deliveries, retries with backoff", async () => {
  const ctx = await setup();
  const hook = await receiver([500]);
  try {
    const { client: inno } = await publishedBy(ctx, "Ines", {}, { access_mode: "approval" });
    const { client: dev, app } = await devWithApp(ctx);

    assert.match((await ctx.call(dev, "create_webhook", { app_id: app.id, url: "http://example.com/hook", events: ["access.revoked"] })).data.error, /https/);
    const created = (await ctx.call(dev, "create_webhook", { app_id: app.id, url: hook.url, events: ["product.version_published", "access.approved", "access.revoked", "request.decided"] })).data;
    assert.match(created.secret, /^whsec_/);
    assert.ok(!JSON.stringify((await ctx.call(dev, "list_webhooks", {})).data).includes(created.secret), "secret shown once");

    // The innovator approves the app's request, then ships a new version.
    const req = (await ctx.call(dev, "request_product_access", { app_id: app.id, product_id: "green-fd" })).data;
    await ctx.call(inno, "review_request", { request_id: req.id, decision: "approve" });
    await ctx.call(inno, "create_product_version", { id: "green-fd", changelog: "Higher rate", key_features: ["Fixed rate", "Funds green projects", "Higher rate"] });
    await ctx.call(inno, "test_product", { id: "green-fd" });
    assert.equal((await ctx.call(inno, "publish_product", { id: "green-fd" })).data.version, 2);

    // First attempt: the first delivery gets a 500 and waits for a retry.
    const first = await deliverDueWebhooks(ctx.store);
    assert.equal(first.attempted, 3);
    assert.equal(first.delivered, 2);
    let deliveries = (await ctx.call(dev, "list_webhook_deliveries", { webhook_id: created.id })).data;
    const retrying = deliveries.find((d) => d.status === "pending");
    assert.equal(retrying.attempts, 1);
    assert.equal(retrying.last_response_code, 500);
    assert.ok(Date.parse(retrying.next_attempt_at) >= Date.now() + 25_000, "backs off");
    assert.equal((await deliverDueWebhooks(ctx.store)).attempted, 0, "not due yet");
    assert.equal((await deliverDueWebhooks(ctx.store, { now: later() })).delivered, 1);
    deliveries = (await ctx.call(dev, "list_webhook_deliveries", { webhook_id: created.id })).data;
    assert.ok(deliveries.every((d) => d.status === "delivered"));
    assert.equal(deliveries.find((d) => d.id === retrying.id).attempts, 2);

    // Every delivery is signed with the webhook's secret over "t.body".
    assert.equal(hook.received.length, 4);
    for (const r of hook.received) {
      assert.equal(r.headers["content-type"], "application/json");
      assert.ok(verify(created.secret, r.headers["mynt-signature"], r.body), "valid signature");
      assert.ok(!verify("whsec_wrong", r.headers["mynt-signature"], r.body));
    }
    const events = hook.received.map((r) => JSON.parse(r.body));
    assert.deepEqual([...new Set(events.map((e) => e.type))].sort(), ["access.approved", "product.version_published", "request.decided"]);
    const published = events.find((e) => e.type === "product.version_published");
    assert.deepEqual(Object.keys(published).sort(), ["created_at", "data", "id", "type"]);
    assert.deepEqual(published.data, { product_id: "green-fd", version: 2, app_id: app.id });
    assert.equal(events.find((e) => e.type === "request.decided").data.decision, "approved");

    // Rotated secrets sign later deliveries; revocation is delivered too.
    const rotated = (await ctx.call(dev, "rotate_webhook_secret", { webhook_id: created.id })).data;
    await ctx.call(inno, "revoke_access", { request_id: req.id, reason: "Breached our terms" });
    await deliverDueWebhooks(ctx.store);
    const revoked = hook.received.at(-1);
    assert.equal(JSON.parse(revoked.body).type, "access.revoked");
    assert.equal(JSON.parse(revoked.body).data.reason, "Breached our terms");
    assert.ok(verify(rotated.secret, revoked.headers["mynt-signature"], revoked.body));

    // Unsubscribed events aren't sent; failing endpoints give up after maxAttempts.
    await ctx.call(inno, "suspend_product_experiences", { product_id: "green-fd", reason: "Rate change" });
    assert.equal((await deliverDueWebhooks(ctx.store)).attempted, 0);
    const down = (await ctx.call(dev, "create_webhook", { app_id: app.id, url: "http://127.0.0.1:9/unreachable", events: ["product.unpublished"] })).data;
    await ctx.call(inno, "unpublish_product", { id: "green-fd" });
    await deliverDueWebhooks(ctx.store, { maxAttempts: 2 });
    await deliverDueWebhooks(ctx.store, { maxAttempts: 2, now: later() });
    const [gaveUp] = (await ctx.call(dev, "list_webhook_deliveries", { webhook_id: down.id })).data;
    assert.equal(gaveUp.status, "failed");
    assert.equal(gaveUp.attempts, 2);
    assert.ok(gaveUp.last_error);

    assert.deepEqual((await ctx.call(dev, "delete_webhook", { webhook_id: down.id })).data, { deleted: down.id });
    assert.equal((await ctx.call(dev, "list_webhooks", { app_id: app.id })).data.length, 1);
    const actions = (await ctx.store.auditLog()).map((a) => a.action);
    for (const a of ["create_webhook", "delete_webhook"]) assert.ok(actions.includes(a), a);
  } finally {
    hook.close();
    ctx.close();
  }
});

test("webhook URLs: https and public in production; backoff schedule", () => {
  assert.equal(webhookUrlProblem("https://hooks.example.com/mynt", true), null);
  assert.match(webhookUrlProblem("http://hooks.example.com/mynt", true), /https/);
  assert.match(webhookUrlProblem("http://127.0.0.1:8080/hook", true), /https/);
  assert.match(webhookUrlProblem("https://127.0.0.1/hook", true), /publicly/);
  assert.match(webhookUrlProblem("https://10.1.2.3/hook", true), /publicly/);
  assert.match(webhookUrlProblem("https://192.168.0.5/hook", true), /publicly/);
  assert.match(webhookUrlProblem("https://localhost/hook", true), /publicly/);
  assert.match(webhookUrlProblem("https://user:pw@hooks.example.com/", true), /credentials/);
  assert.equal(webhookUrlProblem("http://127.0.0.1:8080/hook", false), null);
  assert.match(webhookUrlProblem("not a url", false), /valid/);
  assert.deepEqual([1, 2, 3, 4, 20].map(retryDelay), [30, 60, 120, 240, 21600]);
});

test("sandbox: test consumers, simulated hand-offs and their webhooks, kept out of live analytics", async () => {
  const ctx = await setup();
  const hook = await receiver();
  try {
    await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx);
    const created = (await ctx.call(dev, "create_webhook", { app_id: app.id, url: hook.url, events: ["handoff.completed", "handoff.failed"] })).data;
    const sandbox = (await key(ctx, dev, app.id, "sandbox")).key;
    const consumer = (await ctx.call(dev, "create_test_consumer", { app_id: app.id, label: "First-time saver" })).data;
    assert.match(consumer.consumer_ref, /^tc_/);

    const a = (await ctx.api("POST", "/v1/handoffs", sandbox, { product_id: "green-fd", action: "initiate_onboarding", consumer_ref: consumer.consumer_ref })).body;
    const done = (await ctx.call(dev, "simulate_handoff", { handoff_id: a.handoff_id, outcome: "completed" })).data;
    assert.equal(done.status, "completed");
    assert.match((await ctx.call(dev, "simulate_handoff", { handoff_id: a.handoff_id, outcome: "failed" })).data.error, /already completed/);

    // Or over the API with the sandbox key.
    const b = (await ctx.api("POST", "/v1/handoffs", sandbox, { product_id: "green-fd", action: "deep_link" })).body;
    await ctx.call(dev, "publish_app", { app_id: app.id });
    const live = (await key(ctx, dev, app.id, "live")).key;
    assert.equal((await ctx.api("POST", `/v1/sandbox/handoffs/${b.handoff_id}`, live, { outcome: "failed" })).body.error, "sandbox_only");
    assert.equal((await ctx.api("POST", `/v1/sandbox/handoffs/${b.handoff_id}`, sandbox, { outcome: "failed" })).body.status, "failed");
    assert.equal((await ctx.api("POST", `/v1/sandbox/handoffs/${b.handoff_id}`, sandbox, { outcome: "failed" })).status, 409);

    const { client: other, app: otherApp } = await devWithApp(ctx, "Dana");
    const c = (await ctx.api("POST", "/v1/handoffs", sandbox, { product_id: "green-fd", action: "deep_link" })).body;
    assert.equal((await ctx.call(other, "simulate_handoff", { handoff_id: c.handoff_id, outcome: "completed" })).isError, true);
    const otherKey = (await key(ctx, other, otherApp.id, "sandbox")).key;
    assert.equal((await ctx.api("POST", `/v1/sandbox/handoffs/${c.handoff_id}`, otherKey, { outcome: "completed" })).status, 404);

    await deliverDueWebhooks(ctx.store);
    const events = hook.received.map((r) => JSON.parse(r.body));
    assert.deepEqual(events.map((e) => e.type).sort(), ["handoff.completed", "handoff.failed"]);
    const completed = events.find((e) => e.type === "handoff.completed");
    assert.deepEqual(completed.data, {
      handoff_id: a.handoff_id,
      product_id: "green-fd",
      action: "initiate_onboarding",
      consumer_ref: consumer.consumer_ref,
      sandbox: true,
      app_id: app.id,
    });
    assert.ok(hook.received.every((r) => verify(created.secret, r.headers["mynt-signature"], r.body)));
    const deliveries = (await ctx.call(dev, "list_webhook_deliveries", { webhook_id: created.id })).data;
    assert.ok(deliveries.every((d) => d.sandbox === true));

    const m = (await ctx.call(dev, "get_app_metrics", { app_id: app.id })).data;
    assert.equal(m.totals.handoffs_started, 0, "sandbox hand-offs aren't live analytics");
    assert.equal((await ctx.call(dev, "get_app_metrics", { app_id: app.id, include_sandbox: true })).data.totals.handoffs_started, 3);
  } finally {
    hook.close();
    ctx.close();
  }
});

test("releases: semver that increases, whole-row snapshots, rollback re-checked", async () => {
  const ctx = await setup();
  try {
    const { client: inno } = await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx, "Dev", { name: "Saver" });

    await ctx.call(dev, "update_app", { app_id: app.id, actions: ["display", "embed_widget"] });
    assert.equal((await ctx.call(dev, "release_app", { app_id: app.id, version: "1.0.0", changelog: "First" })).data.failed_checks[0].name, "actions");
    await ctx.call(dev, "update_app", { app_id: app.id, actions: ["display"] });

    // publish_app records an implicit first release.
    await ctx.call(dev, "publish_app", { app_id: app.id });
    assert.deepEqual((await ctx.call(dev, "list_app_releases", { app_id: app.id })).data.map((r) => r.version), ["1.0.0"]);
    assert.equal((await ctx.call(dev, "release_app", { app_id: app.id, version: "1.0.0", changelog: "Again" })).isError, true);
    assert.equal((await ctx.call(dev, "release_app", { app_id: app.id, version: "v2", changelog: "Bad" })).isError, true);

    await ctx.call(dev, "update_app", { app_id: app.id, name: "Saver Plus", disclosures: ["Deposits carry credit risk"] });
    const r = (await ctx.call(dev, "release_app", { app_id: app.id, version: "1.1.0", changelog: "New name" })).data;
    assert.equal(r.version, "1.1.0");
    assert.equal(r.snapshot, undefined);
    assert.match((await ctx.call(dev, "release_app", { app_id: app.id, version: "1.0.9", changelog: "Older" })).data.error, /greater than the latest release, 1.1.0/);
    assert.equal((await ctx.call(dev, "release_app", { app_id: app.id, version: "1.2.0-beta.1", changelog: "Beta" })).isError, false);
    assert.equal((await ctx.call(dev, "release_app", { app_id: app.id, version: "1.2.0-alpha", changelog: "Older beta" })).isError, true);

    // The snapshot is the whole app row.
    const { rows } = await ctx.pg.query("SELECT snapshot FROM financial_products.app_releases WHERE version = '1.1.0'");
    for (const col of ["id", "name", "description", "audience", "product_ids", "disclosures", "actions", "status", "owner_id"]) assert.ok(col in rows[0].snapshot, col);
    assert.equal(rows[0].snapshot.name, "Saver Plus");

    const back = (await ctx.call(dev, "rollback_app", { app_id: app.id, version: "1.0.0" })).data;
    assert.equal(back.app.name, "Saver");
    assert.deepEqual(back.app.disclosures, []);
    assert.equal(back.app.status, "published");
    assert.equal((await ctx.call(dev, "rollback_app", { app_id: app.id, version: "0.9.0" })).isError, true);

    // A release that no longer meets the product's terms can't be restored.
    await ctx.call(inno, "set_product_access", { id: "green-fd", access_mode: "open", build_terms: { banned_phrases: ["plus"] } });
    const refused = await ctx.call(dev, "rollback_app", { app_id: app.id, version: "1.1.0" });
    assert.equal(refused.isError, true);
    assert.equal(refused.data.failed_checks[0].name, "banned_phrases");
    assert.equal((await ctx.store.getApp(app.id)).name, "Saver");

    const { client: other } = await devWithApp(ctx, "Dana");
    assert.equal((await ctx.call(other, "list_app_releases", { app_id: app.id })).isError, true);
    assert.equal((await ctx.call(other, "rollback_app", { app_id: app.id, version: "1.0.0" })).isError, true);
    assert.equal((await ctx.call(other, "release_app", { app_id: app.id, version: "9.0.0", changelog: "Mine now" })).isError, true);
  } finally {
    ctx.close();
  }
});

test("semver ordering", () => {
  const sorted = ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-alpha.beta", "0.9.12", "1.10.0", "1.2.0", "1.0.0-beta.11", "1.0.0-beta.2", "1.0.0-rc.1"].sort(compareSemver);
  assert.deepEqual(sorted, ["0.9.12", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.2.0", "1.10.0"]);
});

test("rate limits and CORS are per key", async () => {
  const ctx = await setup({ rateLimit: { capacity: 3, perMinute: 1 } });
  try {
    await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx);
    const browser = (await key(ctx, dev, app.id, "sandbox", { allowed_origins: ["https://app.example.com"] })).key;
    const server = (await key(ctx, dev, app.id, "sandbox")).key;
    assert.equal((await ctx.call(dev, "create_api_key", { app_id: app.id, environment: "sandbox", label: "x", allowed_origins: ["https://app.example.com/path"] })).isError, true);

    const ok = await ctx.api("GET", "/v1/products", browser, undefined, { Origin: "https://app.example.com" });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://app.example.com");
    const evil = await ctx.api("GET", "/v1/products", browser, undefined, { Origin: "https://evil.example.com" });
    assert.equal(evil.status, 403);
    assert.equal(evil.body.error, "origin_not_allowed");
    assert.equal(evil.headers.get("access-control-allow-origin"), null);
    assert.equal((await ctx.api("GET", "/v1/products", server, undefined, { Origin: "https://app.example.com" })).status, 403, "no origins: server-side only");

    const preflight = (origin) => ctx.api("OPTIONS", "/v1/products", null, undefined, { Origin: origin, "Access-Control-Request-Method": "GET" });
    const pf = await preflight("https://app.example.com");
    assert.equal(pf.status, 204);
    assert.equal(pf.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.match(pf.headers.get("access-control-allow-headers"), /Authorization/);
    assert.equal((await preflight("https://evil.example.com")).headers.get("access-control-allow-origin"), null);

    // The browser key uses up its 3; then it waits, while another key still has its own bucket.
    for (let i = 0; i < 2; i++) assert.equal((await ctx.api("GET", "/v1/products", browser)).status, 200);
    const limited = await ctx.api("GET", "/v1/products", browser, undefined, { Origin: "https://app.example.com" });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, "rate_limited");
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await ctx.api("GET", "/v1/products", server)).status, 200);
  } finally {
    ctx.close();
  }
});

test("developers can't touch each other's keys, webhooks or deliveries", async () => {
  const ctx = await setup();
  try {
    await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx);
    const { client: other } = await devWithApp(ctx, "Dana");
    const k = await key(ctx, dev, app.id, "sandbox");
    const hook = (await ctx.call(dev, "create_webhook", { app_id: app.id, url: "http://127.0.0.1:9/hook", events: ["access.revoked"] })).data;

    assert.equal((await ctx.call(other, "create_api_key", { app_id: app.id, environment: "live", label: "steal" })).isError, true);
    assert.equal((await ctx.call(other, "list_api_keys", { app_id: app.id })).isError, true);
    assert.equal((await ctx.call(other, "rotate_api_key", { key_id: k.id })).isError, true);
    assert.equal((await ctx.call(other, "revoke_api_key", { key_id: k.id })).isError, true);
    assert.equal((await ctx.call(other, "create_webhook", { app_id: app.id, url: "http://127.0.0.1:9/x", events: ["access.revoked"] })).isError, true);
    assert.equal((await ctx.call(other, "list_webhooks", { app_id: app.id })).isError, true);
    assert.deepEqual((await ctx.call(other, "list_webhooks", {})).data, []);
    assert.equal((await ctx.call(other, "delete_webhook", { webhook_id: hook.id })).isError, true);
    assert.equal((await ctx.call(other, "rotate_webhook_secret", { webhook_id: hook.id })).isError, true);
    assert.equal((await ctx.call(other, "list_webhook_deliveries", { webhook_id: hook.id })).isError, true);
    assert.equal((await ctx.call(other, "create_test_consumer", { app_id: app.id, label: "x" })).isError, true);
    assert.equal((await ctx.call(other, "get_app_metrics", { app_id: app.id })).isError, true);
    assert.equal((await ctx.call(dev, "list_api_keys", { app_id: app.id })).data[0].status, "active");
  } finally {
    ctx.close();
  }
});

test("releases enforce the experience structure checks, like publish_app", async () => {
  const ctx = await setup();
  try {
    await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx, "Dev", { name: "Saver" });
    // A screen showing green-fd without its disclosure block.
    const set = await ctx.call(dev, "set_experience", {
      app_id: app.id,
      experience: { screens: [{ id: "home", title: "Home", components: [{ type: "product_card", product_id: "green-fd" }] }] },
    });
    assert.equal(set.isError, false, JSON.stringify(set.data));
    const refused = await ctx.call(dev, "release_app", { app_id: app.id, version: "1.0.0", changelog: "First" });
    assert.equal(refused.isError, true);
    assert.ok(refused.data.failed_checks.some((c) => /disclosure/.test(c.name)), JSON.stringify(refused.data));
    assert.equal((await ctx.call(dev, "publish_app", { app_id: app.id })).isError, true);
  } finally {
    ctx.close();
  }
});

test("webhook URLs: private, metadata and carrier-grade NAT addresses refused in any notation", async () => {
  for (const url of [
    "https://[::ffff:10.0.0.1]/hook",
    "https://[::ffff:a9fe:a9fe]/hook",
    "https://[::ffff:169.254.169.254]/hook",
    "https://100.64.0.1/hook",
    "https://169.254.169.254/latest/meta-data/",
    "https://[fd00:ec2::254]/",
    "https://0.0.0.0/",
  ])
    assert.match(webhookUrlProblem(url, true), /publicly/, url);
  assert.equal(await checkWebhookUrl("https://8.8.8.8:8443/hook", true), null, "a public address on another https port is fine (not called)");
  assert.match(await checkWebhookUrl("https://[::ffff:7f00:1]/hook", true), /publicly/);
  assert.match(await checkWebhookUrl("http://127.0.0.1:8080/hook", true), /https/);
  assert.equal(await checkWebhookUrl("http://127.0.0.1:8080/hook", false), null, "loopback http outside production, for local testing");
});

test("webhook deliveries go through the outbound guard: no private addresses, no redirects", async () => {
  const ctx = await setup();
  const redirecting = createHttpServer((req, res) => {
    req.resume();
    req.on("end", () => res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" }).end());
  }).listen(0, "127.0.0.1");
  await new Promise((r) => redirecting.once("listening", r));
  try {
    await publishedBy(ctx, "Ines");
    const { client: dev, app } = await devWithApp(ctx);
    // At creation: refused before anything is stored.
    for (const url of ["https://[::ffff:169.254.169.254]/hook", "https://100.64.0.9/hook"])
      assert.match((await ctx.call(dev, "create_webhook", { app_id: app.id, url, events: ["product.unpublished"] })).data.error, /publicly/, url);
    // Rows that got in another way (or a name that later points somewhere private) are refused at send time,
    // with no response code to learn from.
    const owner = (await ctx.store.getApp(app.id)).owner_id;
    const hooks = [];
    for (const url of ["https://10.0.0.7:8443/x", "https://[::ffff:169.254.169.254]/latest/meta-data/", `http://127.0.0.1:${redirecting.address().port}/hook`])
      hooks.push((await ctx.store.createWebhook(owner, { app_id: app.id, url, events: ["product.unpublished"] })).webhook);
    await emitEvent(ctx.store, [app.id], "product.unpublished", { product_id: "green-fd" });
    await deliverDueWebhooks(ctx.store, { maxAttempts: 1 });
    const [privateHook, metadataHook, redirectHook] = await Promise.all(hooks.map(async (h) => (await ctx.store.webhookDeliveries(h.id))[0]));
    for (const d of [privateHook, metadataHook]) {
      assert.equal(d.status, "failed");
      assert.equal(d.last_response_code, null);
      assert.match(d.last_error, /^refused: .*private/);
    }
    assert.equal(redirectHook.status, "failed");
    assert.equal(redirectHook.last_error, "redirects aren't followed");
  } finally {
    redirecting.close();
    ctx.close();
  }
});
