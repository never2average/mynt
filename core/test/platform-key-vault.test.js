import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { PlatformKeyVault, PLATFORM_KEY_TYPES, SERVER_ONLY_KEYS, installPlatformKeys, platformSecret, fingerprintOf } = await import("../dist/platform-keys.js");
const { LocalConfidentialHost } = await import("../dist/confidential/local.js");
const { EsignSettings } = await import("../dist/esign-settings.js");
const { seal: legacySeal } = await import("../dist/vault.js");
const { auditClass } = await import("../dist/audit-classes.js");
const { CATALOG } = await import("./helpers.js");

// The platform key vault (platform-keys.ts): Mynt's own keys, one row per key, one active key per type, set by admins
// only. Every value here is an obvious fake. What's checked: a value never comes back (not in an answer, the audit
// log, the console or the table in the clear); the server's environment overrides the vault; replacing retires the
// old row and destroys its value; the confidential host does the sealing; the resolver's copy follows each change;
// and which types say they need a restart.

const T = "financial_products";
const FAKE = {
  model: "sk-ant-FAKE-not-a-real-key-0001",
  model2: "sk-ant-FAKE-not-a-real-key-0002",
  hook: "whsec_FAKEfakeFAKEfake0001",
  hook2: "whsec_FAKEfakeFAKEfake0002",
  sandbox: "fake-sandbox-key-000000000001",
  envModel: "sk-ant-FAKE-from-the-environment",
};
const ALL_FAKES = Object.values(FAKE);

// A confidential host that counts what it's asked to seal and open, over the local one.
function countingHost() {
  const local = new LocalConfidentialHost();
  const calls = { seal: [], unseal: [], contexts: [] };
  const host = new Proxy(local, {
    get(target, k) {
      if (k === "seal")
        return async (purpose, plain, context) => {
          calls.seal.push(purpose);
          calls.contexts.push(context);
          return target.seal(purpose, plain, context);
        };
      if (k === "unseal")
        return async (purpose, sealed, context) => {
          calls.unseal.push(purpose);
          return target.unseal(purpose, sealed, context);
        };
      const v = target[k];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { host, calls };
}

async function setup({ env = {}, esign = false } = {}) {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { host, calls } = countingHost();
  const vault = await PlatformKeyVault.open(store, { host, env });
  const service = esign ? fakeEsignService() : null;
  const settings = esign ? await EsignSettings.open(store, { env, fetch: service.fetch, publicUrl: "https://mynt.example.test", keys: vault }) : undefined;
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, await store.getUser(user.id), { platformKeys: vault, ...(settings ? { esign: settings } : {}) }).connect(s);
    const client = new Client({ name: "platform-keys", version: "0" });
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
  return { store, vault, calls, settings, service, admin: await as("Ada", ["admin"]), dev: await as("Dana", ["developer"]), lp: await as("Lena", ["license_provider"]), vendor: await as("Vik", ["vendor"]) };
}

const GOOD_ESIGN = "sw-fake-key-0123456789abcdef";
function fakeEsignService() {
  const hooks = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (status, json) => new Response(json === undefined ? null : JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    if (init.headers?.["X-Api-Key"] !== GOOD_ESIGN) return reply(401, { message: "Unauthorized" });
    if (u.pathname.endsWith("/me")) return reply(200, { id: "me" });
    if (u.pathname.endsWith("/hooks") && init.method === "GET") return reply(200, hooks);
    if (u.pathname.endsWith("/hooks") && init.method === "POST") {
      const h = { id: `hook-fake-${hooks.length + 1}`, callback_url: body.callback_url };
      hooks.push(h);
      return reply(201, h);
    }
    const m = /\/hooks\/([^/]+)$/.exec(u.pathname);
    if (m && init.method === "DELETE") {
      hooks.splice(hooks.findIndex((h) => h.id === m[1]), 1);
      return reply(204);
    }
    return reply(404, {});
  };
  return { hooks, fetch };
}

const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r.data;
};
const rowOf = (data, type) => data.keys.find((k) => k.type === type);
const clean = (text, what) => {
  for (const f of ALL_FAKES) assert.ok(!String(text).includes(f), `${what} carries a key's value`);
};
// Everything the server printed while `f` ran.
async function consoleDuring(f) {
  const out = [];
  const real = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(real)) console[k] = (...a) => out.push(a.map(String).join(" "));
  try {
    await f();
  } finally {
    Object.assign(console, real);
  }
  return out.join("\n");
}

test("the registry: every type has what the page shows; the keys that stay on the server are named with why", () => {
  const types = PLATFORM_KEY_TYPES.map((t) => t.key);
  assert.equal(new Set(types).size, types.length, "one type per key name");
  for (const t of PLATFORM_KEY_TYPES) {
    assert.ok(t.label && t.purpose && t.used_by && t.validation, t.key);
    assert.equal(typeof t.needs_restart, "boolean");
    assert.equal(typeof t.check("x"), "string", `${t.key} refuses a value that's too short to be one`);
  }
  // Read where they're used, so a change applies at once; the rest are captured when the server starts.
  const live = PLATFORM_KEY_TYPES.filter((t) => !t.needs_restart).map((t) => t.key).sort();
  assert.deepEqual(live, ["CLERK_WEBHOOK_SECRET", "MYNT_PSEUDONYM_SECRET", "SIGNWELL_API_KEY", "SIGNWELL_WEBHOOK_ID"]);
  const restart = PLATFORM_KEY_TYPES.filter((t) => t.needs_restart).map((t) => t.key).sort();
  assert.deepEqual(restart, ["ANTHROPIC_API_KEY", "BOAT_API_KEY", "CLERK_SECRET_KEY", "FREESTYLE_API_KEY", "GITHUB_APP_PRIVATE_KEY", "HOSTING_DO_TOKEN", "SOLANA_RPC_URL_DEVNET", "SOLANA_RPC_URL_MAINNET", "TURNKEY_API_PRIVATE_KEY"]);
  // What can't live in the database it's needed to open, or is read before the vault is.
  const server = SERVER_ONLY_KEYS.map((k) => k.key);
  for (const k of ["DATABASE_URL", "MYNT_VAULT_KEY", "CONFIDENTIAL_HOST_CLIENT_KEY", "CONFIDENTIAL_HOST_CLIENT_CERT"]) assert.ok(server.includes(k), k);
  for (const k of SERVER_ONLY_KEYS) assert.ok(k.why.length > 10 && !types.includes(k.key));
});

test("admins only; a key goes in once, sealed by the confidential host, and never comes back", async () => {
  const w = await setup();
  const TOOLS = ["list_platform_keys", "set_platform_key", "remove_platform_key"];
  for (const t of TOOLS) assert.ok((await w.admin.tools()).includes(t), t);
  for (const who of [w.dev, w.lp, w.vendor]) {
    const tools = await who.tools();
    for (const t of TOOLS) assert.ok(!tools.includes(t), `${t} is admins' only`);
    assert.equal((await who.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model })).isError, true);
  }
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.platform_secrets`)).rows[0].n, 0, "a refused caller stored nothing");

  const before = ok(await w.admin.call("list_platform_keys"));
  assert.equal(before.vault_ready, true);
  assert.deepEqual([rowOf(before, "ANTHROPIC_API_KEY").source, rowOf(before, "ANTHROPIC_API_KEY").source_label], ["none", "Not set"]);
  // The server-only keys are rows too, read-only, with why.
  const db = rowOf(before, "DATABASE_URL");
  assert.equal(db.server_only, true);
  assert.match(db.note, /Set on the server only/);
  assert.equal((await w.admin.call("set_platform_key", { type: "DATABASE_URL", value: "postgres://fake-not-real/db" })).isError, true, "a server-only key can't be put in the vault");
  assert.equal((await w.admin.call("set_platform_key", { type: "MYNT_VAULT_KEY", value: "fake-fake-fake-fake" })).isError, true);

  let printed = await consoleDuring(async () => {
    const r = await w.admin.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model });
    const set = ok(r);
    clean(r.text, "set_platform_key's answer");
    assert.equal(set.needs_restart, true);
    assert.equal(set.in_effect, false, "captured when the server starts");
    assert.match(set.message, /after the server restarts/);
    assert.equal(set.key.source, "vault");
    assert.equal(set.key.source_label, "Key vault");
    assert.equal(set.key.set_by, "Ada");
    assert.ok(set.key.set_at);
    assert.equal(set.key.fingerprint, createHash("sha256").update(FAKE.model).digest("hex").slice(0, 8));
    assert.equal(set.key.fingerprint, fingerprintOf(FAKE.model));
    assert.equal(set.key.takes_effect, "After a restart");
  });
  clean(printed, "the console");

  // Sealed by the host for the purpose that may come back to the server, and stored only sealed.
  assert.deepEqual(w.calls.seal.filter((p) => p === "secret").length >= 1, true);
  const rows = (await w.store.db.query(`SELECT name, key_type, status, sealed, fingerprint FROM ${T}.platform_secrets`)).rows;
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].name, rows[0].key_type, rows[0].status], ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY", "active"]);
  // Bound to its key type (cs2): the value opens only as an ANTHROPIC_API_KEY.
  assert.match(rows[0].sealed, /^cs2:local:secret:/);
  assert.ok(w.calls.contexts.includes("ANTHROPIC_API_KEY"));
  clean(JSON.stringify(rows), "the table");
  // The whole database, as text: the value is nowhere in it.
  const dump = JSON.stringify((await w.store.db.query(`SELECT * FROM ${T}.audit_log`)).rows) + JSON.stringify((await w.store.db.query(`SELECT * FROM ${T}.settings`)).rows);
  clean(dump, "the audit log or the settings");

  // A strict input: nothing but the type and the value; a value of the wrong shape is refused without being kept.
  assert.equal((await w.admin.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model, note: "x" })).isError, true);
  assert.equal((await w.admin.call("set_platform_key", { type: "NOT_A_KEY", value: FAKE.model })).isError, true);
  const bad = await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: "not-the-right-shape-0000" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /whsec_/);
  assert.ok(!bad.text.includes("not-the-right-shape-0000"), "a refused value isn't echoed");
  assert.equal(rowOf(ok(await w.admin.call("list_platform_keys")), "CLERK_WEBHOOK_SECRET").source, "none");

  // Audited in the security class, without the value.
  const trail = (await w.store.db.query(`SELECT action, target, details FROM ${T}.audit_log WHERE action LIKE '%platform_key%' ORDER BY created_at, id`)).rows;
  assert.deepEqual(trail.map((t) => [t.action, t.target]), [["set_platform_key", "ANTHROPIC_API_KEY"], ["set_platform_key_refused", "CLERK_WEBHOOK_SECRET"]]);
  for (const a of ["set_platform_key", "set_platform_key_refused", "remove_platform_key"]) assert.equal(auditClass(a), "security");
  assert.equal(trail[0].details.fingerprint, fingerprintOf(FAKE.model));
  clean(JSON.stringify(trail), "the audit trail");
  assert.ok(!JSON.stringify(trail).includes("not-the-right-shape"));

  printed = await consoleDuring(async () => {
    const read = await w.admin.call("list_platform_keys", { include_history: true });
    clean(read.text, "list_platform_keys");
    for (const k of ok(read).keys) assert.ok(!("value" in k) && !("sealed" in k));
  });
  clean(printed, "the console");
});

test("replacing a key makes a new row, retires the old one and destroys its value; removing destroys it too", async () => {
  const w = await setup();
  ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook }));
  const first = (await w.store.db.query(`SELECT id::text AS id, sealed FROM ${T}.platform_secrets WHERE status = 'active'`)).rows[0];
  const second = ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook2 }));
  assert.equal(second.in_effect, true, "read where it's used");
  assert.equal(second.key.fingerprint, fingerprintOf(FAKE.hook2));
  assert.equal(second.key.times_replaced, 1);

  let rows = (await w.store.db.query(`SELECT id::text AS id, name, status, sealed, fingerprint, retired_reason, retired_at, retired_by FROM ${T}.platform_secrets WHERE key_type = 'CLERK_WEBHOOK_SECRET' ORDER BY set_at, status DESC`)).rows;
  assert.equal(rows.length, 2, "one row per key: the old one stays as history");
  const old = rows.find((r) => r.id === first.id);
  const now = rows.find((r) => r.id !== first.id);
  assert.deepEqual([old.status, old.sealed, old.retired_reason], ["retired", null, "replaced"], "the retired row keeps no value");
  assert.ok(old.retired_at && old.retired_by);
  assert.equal(old.fingerprint, fingerprintOf(FAKE.hook), "only its fingerprint");
  assert.equal(now.status, "active");
  assert.notEqual(now.sealed, first.sealed);
  // The old ciphertext is gone from the table altogether.
  assert.ok(!JSON.stringify((await w.store.db.query(`SELECT * FROM ${T}.platform_secrets`)).rows).includes(first.sealed));
  // One active key per type, by the table's own rule.
  await assert.rejects(w.store.db.query(`INSERT INTO ${T}.platform_secrets (id, name, key_type, sealed) VALUES (gen_random_uuid(), 'another', 'CLERK_WEBHOOK_SECRET', 'x')`));

  const history = ok(await w.admin.call("list_platform_keys", { include_history: true })).history.CLERK_WEBHOOK_SECRET;
  assert.equal(history.length, 1);
  assert.deepEqual([history[0].reason, history[0].value_destroyed, history[0].retired_by, history[0].fingerprint], ["replaced", true, "Ada", fingerprintOf(FAKE.hook)]);

  // Remove needs its confirmation, and leaves no value anywhere.
  assert.equal((await w.admin.call("remove_platform_key", { type: "CLERK_WEBHOOK_SECRET" })).isError, true);
  const removed = ok(await w.admin.call("remove_platform_key", { type: "CLERK_WEBHOOK_SECRET", confirm: true }));
  assert.equal(removed.removed, true);
  assert.equal(removed.key.source, "none");
  rows = (await w.store.db.query(`SELECT status, sealed FROM ${T}.platform_secrets`)).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.sealed]), [["retired", null], ["retired", null]]);
  assert.equal((await w.admin.call("remove_platform_key", { type: "CLERK_WEBHOOK_SECRET", confirm: true })).isError, true, "nothing left to remove");
  const trail = (await w.store.db.query(`SELECT action, details FROM ${T}.audit_log WHERE action LIKE '%platform_key%' ORDER BY created_at, id`)).rows;
  assert.deepEqual(trail.map((t) => t.action), ["set_platform_key", "set_platform_key", "remove_platform_key"]);
  assert.deepEqual(trail.map((t) => t.details.replaced), [false, true, undefined]);
  clean(JSON.stringify(trail), "the audit trail");
});

test("the resolver: the environment overrides the vault, and its copy follows every change", async () => {
  const w = await setup();
  try {
    installPlatformKeys(w.vault);
    assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", {}), null, "unset");
    ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook }));
    assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", {}), FAKE.hook, "the vault's key, at once");
    // Answered from this process's copy: reading it again asks the host for nothing.
    const opened = w.calls.unseal.length;
    for (let i = 0; i < 5; i++) assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", {}), FAKE.hook);
    assert.equal(w.calls.unseal.length, opened);
    // Replaced: the next read has the new key, never the old.
    ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook2 }));
    assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", {}), FAKE.hook2);
    // The server's environment wins whenever it sets the name; an empty one doesn't count as set.
    assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", { CLERK_WEBHOOK_SECRET: "whsec_FAKEfromTheEnvironment" }), "whsec_FAKEfromTheEnvironment");
    assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", { CLERK_WEBHOOK_SECRET: "  " }), FAKE.hook2);
    // Removed: nothing.
    ok(await w.admin.call("remove_platform_key", { type: "CLERK_WEBHOOK_SECRET", confirm: true }));
    assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", {}), null);
    // A name that isn't a vault type is never answered from the vault.
    assert.equal(platformSecret("DATABASE_URL", {}), null);
  } finally {
    installPlatformKeys(null);
  }
  assert.equal(platformSecret("CLERK_WEBHOOK_SECRET", {}), null, "no vault installed: the environment only, as before");
});

test("a change made by another process is picked up when this one's copy is old", async () => {
  const w = await setup();
  let clock = 1_000_000;
  const mine = await PlatformKeyVault.open(w.store, { env: {}, now: () => clock });
  assert.equal(mine.peek("CLERK_WEBHOOK_SECRET"), null);
  ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook })); // through the other vault
  assert.equal(mine.peek("CLERK_WEBHOOK_SECRET"), null, "not yet: its copy is fresh");
  clock += 31_000;
  assert.equal(await mine.get("CLERK_WEBHOOK_SECRET"), FAKE.hook);
});

test("the environment overrides the vault: the row says so, shows nothing of the environment's key, and the vault's waits", async () => {
  const w = await setup({ env: { ANTHROPIC_API_KEY: FAKE.envModel, DATABASE_URL: "postgres://fake-not-real/db" } });
  let list = ok(await w.admin.call("list_platform_keys"));
  let row = rowOf(list, "ANTHROPIC_API_KEY");
  assert.deepEqual([row.source, row.source_label, row.note], ["environment", "Server environment", "Set on the server; overrides the vault"]);
  assert.deepEqual([row.set_at, row.set_by, row.fingerprint], [null, null, null], "nothing derived from the environment's key");
  assert.equal(rowOf(list, "DATABASE_URL").source, "environment");
  assert.ok(!JSON.stringify(list).includes("fake-not-real"));
  clean(JSON.stringify(list), "the list");

  const r = await w.admin.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model });
  const set = ok(r);
  clean(r.text, "the answer");
  assert.equal(set.in_effect, false);
  assert.match(set.message, /server's environment sets this key and overrides the vault/);
  row = set.key;
  assert.equal(row.source, "environment");
  assert.equal(row.vault_key.fingerprint, fingerprintOf(FAKE.model), "the vault's key is kept for when the server stops setting it");
  assert.equal(w.vault.peek("ANTHROPIC_API_KEY"), FAKE.envModel, "the environment's is the one in use");
  assert.equal(w.vault.bootEnv().ANTHROPIC_API_KEY, FAKE.envModel);
  const removed = ok(await w.admin.call("remove_platform_key", { type: "ANTHROPIC_API_KEY", confirm: true }));
  assert.equal(removed.still_set_by_environment, true);
  assert.match(removed.message, /still sets it/);
});

test("keys captured at start-up reach their consumers through the start-up environment, after a restart", async () => {
  const w = await setup({ env: { PUBLIC_URL: "https://mynt.example.test", BOAT_API_KEY: "fake-env-sandbox-key-0001" } });
  ok(await w.admin.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model }));
  ok(await w.admin.call("set_platform_key", { type: "BOAT_API_KEY", value: FAKE.sandbox }));
  // What the next start-up builds its provider clients from: the environment, with the vault's keys underneath.
  const restarted = await PlatformKeyVault.open(w.store, { env: w.vault.env });
  const env = restarted.bootEnv();
  assert.equal(env.ANTHROPIC_API_KEY, FAKE.model);
  assert.equal(env.BOAT_API_KEY, "fake-env-sandbox-key-0001", "the environment's own key wins");
  assert.equal(env.PUBLIC_URL, "https://mynt.example.test");
  assert.equal(w.vault.env.ANTHROPIC_API_KEY, undefined, "the environment itself is never written to");
  assert.equal(process.env.ANTHROPIC_API_KEY === FAKE.model, false);
  const { buildConfigFromEnv } = await import("../dist/builds.js");
  assert.deepEqual(buildConfigFromEnv(env).agentBackend, { kind: "anthropic", apiKey: FAKE.model });
  assert.equal(buildConfigFromEnv(w.vault.env).agentBackend, null, "without the vault there's no model key here");
  // The row is honest about it.
  const row = rowOf(ok(await w.admin.call("list_platform_keys")), "ANTHROPIC_API_KEY");
  assert.deepEqual([row.needs_restart, row.takes_effect], [true, "After a restart"]);
  assert.deepEqual([rowOf(ok(await w.admin.call("list_platform_keys")), "CLERK_WEBHOOK_SECRET").needs_restart], [false]);
});

test("a multi-line key (a PEM block) is checked as one before it's kept", async () => {
  const w = await setup();
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 }); // made here, used nowhere
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  assert.equal((await w.admin.call("set_platform_key", { type: "GITHUB_APP_PRIVATE_KEY", value: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----" })).isError, true);
  const r = await w.admin.call("set_platform_key", { type: "GITHUB_APP_PRIVATE_KEY", value: pem });
  const set = ok(r);
  assert.ok(!r.text.includes(pem.split("\n")[1]));
  assert.equal(set.key.multiline, true);
  assert.equal((await PlatformKeyVault.open(w.store, { env: {} })).bootEnv().GITHUB_APP_PRIVATE_KEY, pem.trim());
  assert.equal((await w.admin.call("set_platform_key", { type: "SOLANA_RPC_URL_MAINNET", value: "http://rpc.example.test/fake" })).isError, true, "an RPC address must be https");
  ok(await w.admin.call("set_platform_key", { type: "SOLANA_RPC_URL_MAINNET", value: "https://rpc.example.test/fake-key-0001" }));
});

test("the e-signature key is a row of the same vault: set from either side, checked with the service, removed with its webhook", async () => {
  const w = await setup({ esign: true });
  // A key the service refuses is never kept, whichever tool it came through.
  const bad = await w.admin.call("set_platform_key", { type: "SIGNWELL_API_KEY", value: "sw-fake-wrong-key-000000" });
  assert.equal(bad.isError, true);
  assert.match(bad.data.error, /refused that key/);
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.platform_secrets`)).rows[0].n, 0);

  // Set in the vault: checked with the service, the webhook registered, e-signature on at once.
  const r = await w.admin.call("set_platform_key", { type: "SIGNWELL_API_KEY", value: GOOD_ESIGN });
  const set = ok(r);
  assert.ok(!r.text.includes(GOOD_ESIGN) && !r.text.includes("hook-fake-1"));
  assert.deepEqual(set.webhook, { registered: true, reused: false });
  assert.equal(set.in_effect, true);
  assert.ok(set.key.validated_at, "checked with the service");
  assert.equal(w.settings.current.provider.name, "signwell");
  let esign = ok(await w.admin.call("get_esign_settings"));
  assert.deepEqual([esign.configured, esign.key.source, esign.key.set_by, esign.webhook.registered], [true, "studio", "Ada", true]);
  let list = ok(await w.admin.call("list_platform_keys"));
  assert.equal(rowOf(list, "SIGNWELL_API_KEY").fingerprint, fingerprintOf(GOOD_ESIGN));
  assert.equal(rowOf(list, "SIGNWELL_WEBHOOK_ID").source, "vault", "the webhook's id is its own row");
  assert.ok(!JSON.stringify(list).includes("hook-fake-1"));

  // Removed in the vault: the webhook is deleted at the service and e-signature is off.
  const removed = ok(await w.admin.call("remove_platform_key", { type: "SIGNWELL_API_KEY", confirm: true }));
  assert.equal(removed.removed, true);
  assert.deepEqual(w.service.hooks, []);
  assert.equal(w.settings.current, null);
  list = ok(await w.admin.call("list_platform_keys"));
  assert.deepEqual([rowOf(list, "SIGNWELL_API_KEY").source, rowOf(list, "SIGNWELL_WEBHOOK_ID").source], ["none", "none"]);

  // Set from the e-signature side: the same row.
  ok(await w.admin.call("set_esign_api_key", { provider: "signwell", api_key: GOOD_ESIGN }));
  list = ok(await w.admin.call("list_platform_keys"));
  assert.deepEqual([rowOf(list, "SIGNWELL_API_KEY").source, rowOf(list, "SIGNWELL_API_KEY").times_replaced], ["vault", 1]);
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.platform_secrets WHERE status = 'active'`)).rows[0].n, 2);
});

test("a key stored before the vault was general (sealed by the vault itself, named by its slot) still opens and keeps working", async () => {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const { user } = await store.createUser("Ada", ["admin"]);
  await store.db.query(`INSERT INTO ${T}.platform_secrets (id, name, sealed, set_by) VALUES (gen_random_uuid(), 'esign:signwell:api_key', $1, $2)`, [legacySeal(GOOD_ESIGN, false), user.id]);
  const vault = await PlatformKeyVault.open(store, { env: {} });
  assert.equal(vault.peek("SIGNWELL_API_KEY"), GOOD_ESIGN);
  const row = (await vault.list()).find((k) => k.type === "SIGNWELL_API_KEY");
  assert.deepEqual([row.source, row.set_by, row.fingerprint], ["vault", "Ada", fingerprintOf(GOOD_ESIGN)]);
  // Replaced: the new row is sealed by the host, in the same slot; the old one keeps no value.
  assert.equal((await vault.set(await store.getUser(user.id), "SIGNWELL_API_KEY", "sw-fake-key-replacement-0002")).ok, true);
  const rows = (await store.db.query(`SELECT name, status, sealed FROM ${T}.platform_secrets ORDER BY status`)).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.name === "esign:signwell:api_key", r.sealed === null]), [["active", true, false], ["retired", false, true]]);
  assert.match(rows[0].sealed, /^cs2:local:secret:/);
});

test("a sealed key is bound to its type: moved to another type's row in the database, it doesn't open there", async () => {
  const w = await setup();
  ok(await w.admin.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model }));
  ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook }));
  const sealedOf = async (type) => (await w.store.db.query(`SELECT sealed FROM ${T}.platform_secrets WHERE key_type = $1 AND status = 'active'`, [type])).rows[0].sealed;
  const [model, hook] = [await sealedOf("ANTHROPIC_API_KEY"), await sealedOf("CLERK_WEBHOOK_SECRET")];
  assert.match(model, /^cs2:local:secret:/);
  // Someone who can write the database swaps the two sealed values (to have the model key sent where the webhook
  // secret goes, say). Neither opens as the other: the rows stay listed, without a value, and nothing is misused.
  await w.store.db.query(`UPDATE ${T}.platform_secrets SET sealed = $2 WHERE key_type = $1 AND status = 'active'`, ["ANTHROPIC_API_KEY", hook]);
  await w.store.db.query(`UPDATE ${T}.platform_secrets SET sealed = $2 WHERE key_type = $1 AND status = 'active'`, ["CLERK_WEBHOOK_SECRET", model]);
  const printed = [];
  const error = console.error;
  console.error = (...a) => printed.push(a.join(" "));
  let swapped;
  try {
    swapped = await PlatformKeyVault.open(w.store, { host: new LocalConfidentialHost(), env: {} });
  } finally {
    console.error = error;
  }
  assert.equal(swapped.peek("ANTHROPIC_API_KEY"), null);
  assert.equal(swapped.peek("CLERK_WEBHOOK_SECRET"), null);
  assert.ok(printed.some((l) => /ANTHROPIC_API_KEY couldn't be opened/.test(l)));
  clean(printed.join("\n"), "the console");
  // Put back, each opens as itself.
  await w.store.db.query(`UPDATE ${T}.platform_secrets SET sealed = $2 WHERE key_type = $1 AND status = 'active'`, ["ANTHROPIC_API_KEY", model]);
  await w.store.db.query(`UPDATE ${T}.platform_secrets SET sealed = $2 WHERE key_type = $1 AND status = 'active'`, ["CLERK_WEBHOOK_SECRET", hook]);
  const back = await PlatformKeyVault.open(w.store, { host: new LocalConfidentialHost(), env: {} });
  assert.deepEqual([back.peek("ANTHROPIC_API_KEY"), back.peek("CLERK_WEBHOOK_SECRET")], [FAKE.model, FAKE.hook]);
});

test("a key the host sealed before types were bound (cs1) still opens, is sealed again bound to its type, and the next write binds too", async () => {
  const w = await setup();
  const local = new LocalConfidentialHost();
  // As the vault stored it before: sealed for the purpose alone.
  const old = await local.seal("secret", Buffer.from(FAKE.model, "utf8"));
  assert.match(old, /^cs1:local:secret:/);
  await w.store.db.query(`INSERT INTO ${T}.platform_secrets (id, name, key_type, status, sealed, fingerprint, set_by) VALUES (gen_random_uuid(), 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'active', $1, $2, $3)`, [old, fingerprintOf(FAKE.model), w.admin.user.id]);
  const vault = await PlatformKeyVault.open(w.store, { host: local, env: {} });
  assert.equal(vault.peek("ANTHROPIC_API_KEY"), FAKE.model, "an old row is read");
  const sealedNow = async () => (await w.store.db.query(`SELECT sealed FROM ${T}.platform_secrets WHERE key_type = 'ANTHROPIC_API_KEY' AND status = 'active'`)).rows[0].sealed;
  const rebound = await sealedNow();
  assert.match(rebound, /^cs2:local:secret:/, "and sealed again, bound to its type, once it has opened");
  assert.equal((await local.unseal("secret", rebound, "ANTHROPIC_API_KEY")).toString(), FAKE.model);
  await assert.rejects(local.unseal("secret", rebound, "CLERK_WEBHOOK_SECRET"));
  // A restart reads the bound row; replacing the key writes a bound row.
  assert.equal((await PlatformKeyVault.open(w.store, { host: local, env: {} })).peek("ANTHROPIC_API_KEY"), FAKE.model);
  assert.equal((await vault.set(w.admin.user, "ANTHROPIC_API_KEY", FAKE.model2)).ok, true);
  assert.match(await sealedNow(), /^cs2:local:secret:/);
  assert.equal(vault.peek("ANTHROPIC_API_KEY"), FAKE.model2);
  // A host that can't seal just now leaves the old row as it is, still readable.
  const w2 = await setup();
  await w2.store.db.query(`INSERT INTO ${T}.platform_secrets (id, name, key_type, status, sealed, fingerprint, set_by) VALUES (gen_random_uuid(), 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'active', $1, $2, $3)`, [old, fingerprintOf(FAKE.model), w2.admin.user.id]);
  const readOnly = new Proxy(local, { get: (t, k) => (k === "seal" ? async () => Promise.reject(new Error("down")) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  assert.equal((await PlatformKeyVault.open(w2.store, { host: readOnly, env: {} })).peek("ANTHROPIC_API_KEY"), FAKE.model);
  assert.equal((await w2.store.db.query(`SELECT sealed FROM ${T}.platform_secrets WHERE key_type = 'ANTHROPIC_API_KEY'`)).rows[0].sealed, old);
});

test("without a vault key nothing can be sealed: the key is refused, in words, and nothing is stored", async () => {
  const w = await setup();
  const refusing = new Proxy(new LocalConfidentialHost(), { get: (t, k) => (k === "seal" ? async () => Promise.reject(new Error("no vault key")) : typeof t[k] === "function" ? t[k].bind(t) : t[k]) });
  const vault = await PlatformKeyVault.open(w.store, { host: refusing, env: {} });
  assert.equal(await vault.ready(), false);
  const r = await vault.set(w.admin.user, "CLERK_WEBHOOK_SECRET", FAKE.hook);
  assert.equal(r.ok, false);
  assert.match(r.error, /can't seal keys yet/);
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.platform_secrets`)).rows[0].n, 0);
});

// ---- sign-in can't fall away quietly ----

test("a server that requires sign-in keeps the keys sign-in rests on: removal from the vault is refused unless the environment sets them", async () => {
  const SIGN_IN = "sk_test_FAKEfakeFAKEfake0001";
  // Sign-in is meant to be on (the publishable key is set) and the vault holds the only secret key and webhook secret.
  const w = await setup({ env: { CLERK_PUBLISHABLE_KEY: "pk_test_FAKE" } });
  ok(await w.admin.call("set_platform_key", { type: "CLERK_SECRET_KEY", value: SIGN_IN }));
  ok(await w.admin.call("set_platform_key", { type: "CLERK_WEBHOOK_SECRET", value: FAKE.hook }));
  for (const type of ["CLERK_SECRET_KEY", "CLERK_WEBHOOK_SECRET"]) {
    const r = await w.admin.call("remove_platform_key", { type, confirm: true });
    assert.equal(r.isError, true, r.text);
    assert.match(r.data.error, /can't be removed from the vault while this server requires sign-in/);
    assert.match(r.data.error, /set_platform_key/);
    clean(r.text, "the refusal");
  }
  assert.equal(w.vault.source("CLERK_SECRET_KEY"), "vault", "still there");
  assert.equal(w.vault.bootEnv().CLERK_SECRET_KEY, SIGN_IN, "and still what the server starts with");
  const refusedTrail = (await w.store.db.query(`SELECT action, target, details FROM ${T}.audit_log WHERE action = 'remove_platform_key_refused' ORDER BY created_at, id`)).rows;
  assert.deepEqual(refusedTrail.map((t) => [t.target, t.details.reason]), [["CLERK_SECRET_KEY", "sign_in_depends_on_it"], ["CLERK_WEBHOOK_SECRET", "sign_in_depends_on_it"]]);
  assert.equal(auditClass("remove_platform_key_refused"), "security");
  // Replacing is how it changes; other keys are removed as before.
  ok(await w.admin.call("set_platform_key", { type: "CLERK_SECRET_KEY", value: "sk_test_FAKEfakeFAKEfake0002" }));
  ok(await w.admin.call("set_platform_key", { type: "ANTHROPIC_API_KEY", value: FAKE.model }));
  ok(await w.admin.call("remove_platform_key", { type: "ANTHROPIC_API_KEY", confirm: true }));

  // The environment sets it too: the vault's copy isn't what sign-in rests on, so it may go.
  const both = await setup({ env: { CLERK_PUBLISHABLE_KEY: "pk_test_FAKE", CLERK_SECRET_KEY: "sk_test_FAKEfromTheEnvironment" } });
  ok(await both.admin.call("set_platform_key", { type: "CLERK_SECRET_KEY", value: SIGN_IN }));
  const removed = ok(await both.admin.call("remove_platform_key", { type: "CLERK_SECRET_KEY", confirm: true }));
  assert.deepEqual([removed.removed, removed.still_set_by_environment], [true, true]);

  // A server without sign-in (local, development): nothing rests on the key, and it's removed as before.
  const local = await setup();
  ok(await local.admin.call("set_platform_key", { type: "CLERK_SECRET_KEY", value: SIGN_IN }));
  assert.equal(ok(await local.admin.call("remove_platform_key", { type: "CLERK_SECRET_KEY", confirm: true })).removed, true);
});

test("start-up: a server meant to require sign-in refuses to start when no secret key can be read; without sign-in it starts as before", async () => {
  const { clerkConfigFromEnv, SIGN_IN_KEY_MISSING } = await import("../dist/auth.js");
  const PUBLIC = { CLERK_PUBLISHABLE_KEY: "pk_test_FAKE", PUBLIC_URL: "https://mynt.example.test" };
  // Local and development use: neither key, no sign-in.
  assert.equal(clerkConfigFromEnv({}), null);
  assert.equal(clerkConfigFromEnv({ PUBLIC_URL: "https://mynt.example.test" }), null);
  // The publishable key without a secret key: never "no sign-in".
  assert.throws(() => clerkConfigFromEnv(PUBLIC), (e) => e.message === SIGN_IN_KEY_MISSING);
  assert.throws(() => clerkConfigFromEnv({ ...PUBLIC, CLERK_SECRET_KEY: "  " }), /Refusing to start without sign-in/);
  assert.match(SIGN_IN_KEY_MISSING, /CLERK_SECRET_KEY/);
  // With both, sign-in is on.
  assert.equal(clerkConfigFromEnv({ ...PUBLIC, CLERK_SECRET_KEY: "sk_test_FAKEfakeFAKEfake0001" }).publishableKey, "pk_test_FAKE");

  // The case that used to start without sign-in: the vault holds the secret key, but it can't be opened (the vault
  // key it was sealed with isn't the one this server has), so start-up's environment has no secret key.
  const w = await setup({ env: { CLERK_PUBLISHABLE_KEY: "pk_test_FAKE", PUBLIC_URL: "https://mynt.example.test" } });
  ok(await w.admin.call("set_platform_key", { type: "CLERK_SECRET_KEY", value: "sk_test_FAKEfakeFAKEfake0001" }));
  assert.ok(clerkConfigFromEnv(w.vault.bootEnv()), "readable: sign-in is on");
  await w.store.db.query(`UPDATE ${T}.platform_secrets SET sealed = 'cs1:local:secret:AAAA:AAAA:AAAA' WHERE key_type = 'CLERK_SECRET_KEY' AND status = 'active'`);
  const printed = [];
  const error = console.error;
  console.error = (...a) => printed.push(a.join(" "));
  let reopened;
  try {
    reopened = await PlatformKeyVault.open(w.store, { env: { CLERK_PUBLISHABLE_KEY: "pk_test_FAKE", PUBLIC_URL: "https://mynt.example.test" } });
  } finally {
    console.error = error;
  }
  assert.equal(reopened.bootEnv().CLERK_SECRET_KEY, undefined);
  assert.throws(() => clerkConfigFromEnv(reopened.bootEnv()), /Refusing to start without sign-in/);
});
