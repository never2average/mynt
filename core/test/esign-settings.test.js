import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { EsignSettings } = await import("../dist/esign-settings.js");
const { CATALOG } = await import("./helpers.js");

// E-signature set up from Mynt Studio by an admin, against a fake of the service (never the live one; the keys are
// fakes): the key checked before it's kept, sealed in Mynt's database and never returned or logged; the webhook
// registered (or an existing one reused) and its id sealed; Remove key deleting the hook; test mode stored; the
// environment overriding what's stored; admins only.

const T = "financial_products";
const GOOD = "sw-fake-key-0123456789abcdef";
const PUBLIC = "https://mynt.example.test";

function fakeService() {
  const hooks = [];
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method ?? "GET", path: u.pathname, key: init.headers?.["X-Api-Key"], body });
    const reply = (status, json) => new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    if (init.headers?.["X-Api-Key"] !== GOOD) return reply(401, { message: "Unauthorized" });
    if (u.pathname.endsWith("/me")) return reply(200, { id: "me" });
    if (u.pathname.endsWith("/hooks") && init.method === "GET") return reply(200, hooks);
    if (u.pathname.endsWith("/hooks") && init.method === "POST") {
      const h = { id: `hook-${hooks.length + 1}`, callback_url: body.callback_url };
      hooks.push(h);
      return reply(201, h);
    }
    const m = /\/hooks\/([^/]+)$/.exec(u.pathname);
    if (m && init.method === "DELETE") {
      const i = hooks.findIndex((h) => h.id === m[1]);
      if (i < 0) return reply(404, {});
      hooks.splice(i, 1);
      return reply(204);
    }
    return reply(404, {});
  };
  return { hooks, calls, fetch };
}

async function setup({ env = {}, publicUrl = PUBLIC } = {}) {
  const service = fakeService();
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const settings = await EsignSettings.open(store, { env, fetch: service.fetch, publicUrl });
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, await store.getUser(user.id), { esign: settings }).connect(s);
    const client = new Client({ name: "esign-settings", version: "0" });
    await client.connect(c);
    return {
      user,
      tools: async () => (await client.listTools()).tools.map((t) => t.name),
      call: async (n, a = {}) => {
        const res = await client.callTool({ name: n, arguments: a });
        const text = res.content[0].text;
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          data = { error: text };
        }
        return { isError: res.isError ?? false, data, text };
      },
    };
  };
  return { store, settings, service, admin: await as("Ada", ["admin"]), dev: await as("Dana", ["developer"]), lp: await as("Lena", ["license_provider"]) };
}

const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r.data;
};

test("admins only; the key is checked, sealed, never returned; the webhook is registered and its id sealed", async () => {
  const w = await setup();
  const TOOLS = ["get_esign_settings", "register_esign_webhook", "remove_esign_api_key", "set_esign_api_key", "set_esign_test_mode"];
  for (const t of TOOLS) assert.ok((await w.admin.tools()).includes(t), t);
  for (const t of TOOLS) assert.ok(!(await w.dev.tools()).includes(t) && !(await w.lp.tools()).includes(t), `${t} is admins' only`);

  let s = ok(await w.admin.call("get_esign_settings"));
  assert.equal(s.configured, false);
  assert.deepEqual(s.key, { set: false, source: null, set_at: null, set_by: null });
  assert.equal(s.test_mode.on, true, "test mode on by default");
  assert.equal(s.webhook.callback_url, `${PUBLIC}/esign/webhook`);

  // A key the service refuses isn't kept.
  const bad = await w.admin.call("set_esign_api_key", { provider: "signwell", api_key: "sw-wrong-key-000000" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /refused that key/);
  assert.ok(!bad.text.includes("sw-wrong-key-000000"));
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.platform_secrets`)).rows[0].n, 0);

  const r = await w.admin.call("set_esign_api_key", { provider: "signwell", api_key: GOOD });
  const set = ok(r);
  assert.deepEqual(set.webhook, { registered: true, reused: false });
  assert.ok(!r.text.includes(GOOD), "the key never comes back");
  assert.ok(!r.text.includes("hook-1"), "nor the webhook's id");
  assert.equal(set.settings.configured, true);
  assert.equal(set.settings.key.source, "studio");
  assert.equal(set.settings.key.set_by, "Ada");
  assert.equal(set.settings.webhook.registered, true);
  assert.deepEqual(w.service.hooks, [{ id: "hook-1", callback_url: `${PUBLIC}/esign/webhook` }]);
  // Sealed in the database, one row per key.
  const rows = (await w.store.db.query(`SELECT name, sealed FROM ${T}.platform_secrets WHERE status = 'active' ORDER BY name`)).rows;
  assert.deepEqual(rows.map((x) => x.name), ["esign:signwell:api_key", "esign:signwell:webhook_id"]);
  // Sealed by the confidential host (the platform key vault's rows, platform-keys.ts).
  for (const x of rows) assert.match(x.sealed, /^cs2:local:secret:/);
  assert.ok(!JSON.stringify(rows).includes(GOOD) && !JSON.stringify(rows).includes("hook-1"));
  // The live configuration uses them at once.
  assert.equal(w.settings.current.provider.name, "signwell");
  assert.equal(w.settings.current.testMode, true);
  // Audited without the value.
  const trail = (await w.store.db.query(`SELECT action, details FROM ${T}.audit_log WHERE target = 'esign' ORDER BY created_at, id`)).rows;
  assert.deepEqual(trail.map((t) => t.action), ["set_esign_api_key_refused", "set_esign_api_key", "register_esign_webhook"]);
  assert.ok(!JSON.stringify(trail).includes(GOOD) && !JSON.stringify(trail).includes("sw-wrong-key"));
  // Nothing the admin reads carries a secret.
  const read = await w.admin.call("get_esign_settings");
  assert.ok(!read.text.includes(GOOD) && !read.text.includes("hook-1"));
});

test("Re-register reuses a hook already pointing here; Remove key deletes the hook and the stored secrets", async () => {
  const w = await setup();
  w.service.hooks.push({ id: "hook-existing", callback_url: `${PUBLIC}/esign/webhook` });
  const set = ok(await w.admin.call("set_esign_api_key", { provider: "signwell", api_key: GOOD }));
  assert.deepEqual(set.webhook, { registered: true, reused: true });
  assert.equal(w.service.hooks.length, 1, "no second hook");
  const again = ok(await w.admin.call("register_esign_webhook"));
  assert.equal(again.reused, true);
  ok(await w.admin.call("set_esign_test_mode", { test_mode: false }));
  assert.equal(w.settings.current.testMode, false);
  assert.equal(ok(await w.admin.call("get_esign_settings")).test_mode.on, false);
  const removed = ok(await w.admin.call("remove_esign_api_key", { confirm: true }));
  assert.equal(removed.removed, true);
  assert.equal(removed.webhook_deleted, true);
  assert.equal(removed.still_configured_by_environment, false);
  assert.deepEqual(w.service.hooks, [], "the hook is deleted at the service");
  // The vault keeps the rows as history, retired, with their values destroyed.
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.platform_secrets WHERE status = 'active' OR sealed IS NOT NULL`)).rows[0].n, 0);
  assert.equal(w.settings.current, null);
  assert.equal(ok(await w.admin.call("get_esign_settings")).configured, false);
  assert.equal((await w.admin.call("register_esign_webhook")).isError, true, "no key, no webhook");
});

test("without an https public address the key is kept and the webhook waits; the environment overrides what's stored", async () => {
  const w = await setup({ publicUrl: "http://localhost:8080" });
  const set = ok(await w.admin.call("set_esign_api_key", { provider: "signwell", api_key: GOOD }));
  assert.equal(set.webhook.registered, false);
  assert.match(set.webhook.reason, /isn't an https address/);
  assert.equal(set.settings.webhook.can_register, false);
  assert.equal(set.settings.configured, true, "the key works for documents; events wait for the webhook");

  // The environment wins: its key, its webhook id, its test mode.
  const env = await setup({ env: { ESIGN_PROVIDER: "signwell", SIGNWELL_API_KEY: "env-fake-key-000000", SIGNWELL_WEBHOOK_ID: "env-hook", ESIGN_TEST_MODE: "off" } });
  assert.equal(env.settings.current.provider.name, "signwell");
  assert.equal(env.settings.current.testMode, false);
  const s = ok(await env.admin.call("get_esign_settings"));
  assert.equal(s.key.source, "environment");
  assert.equal(s.webhook.source, "environment");
  assert.equal(s.test_mode.source, "environment");
  ok(await env.admin.call("set_esign_test_mode", { test_mode: true }));
  assert.equal(env.settings.current.testMode, false, "ESIGN_TEST_MODE still wins");
  // A stored key under an environment key: the environment's is the one used.
  ok(await env.admin.call("set_esign_api_key", { provider: "signwell", api_key: GOOD }));
  assert.equal(ok(await env.admin.call("get_esign_settings")).key.source, "environment");
  const removed = ok(await env.admin.call("remove_esign_api_key", { confirm: true }));
  assert.equal(removed.still_configured_by_environment, true);

  // Without a key anywhere it's off; ESIGN_PROVIDER without a key is off too.
  const none = await setup({ env: { ESIGN_PROVIDER: "signwell" } });
  assert.equal(none.settings.current, null);
  const unknown = await setup({ env: { ESIGN_PROVIDER: "nobody", SIGNWELL_API_KEY: GOOD } });
  assert.equal(unknown.settings.current, null);
});

test("stored settings survive a restart: a new EsignSettings reads the sealed key and webhook id back", async () => {
  const w = await setup();
  ok(await w.admin.call("set_esign_api_key", { provider: "signwell", api_key: GOOD }));
  ok(await w.admin.call("set_esign_test_mode", { test_mode: false }));
  const again = await EsignSettings.open(w.store, { env: {}, fetch: w.service.fetch, publicUrl: PUBLIC });
  assert.equal(again.current.provider.name, "signwell");
  assert.equal(again.current.testMode, false);
  // The webhook id is what verifies the service's events.
  const { createHmac } = await import("node:crypto");
  const time = Math.floor(Date.now() / 1000);
  const hash = createHmac("sha256", "hook-1").update(`document_completed@${time}`).digest("hex");
  assert.equal(again.current.provider.verifyWebhook(JSON.stringify({ event: { type: "document_completed", time, hash }, data: { object: { id: "d" } } }), {}).ok, true);
});
