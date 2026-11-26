import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { buildConfigFromEnv, monthlyBuildCapUsd } from "../dist/builds.js";
import { deskConfigFromEnv } from "../dist/desk.js";
import { exploreConfigFromEnv } from "../dist/explore.js";
import { reviewConfigFromEnv } from "../dist/review.js";
import { sandboxesFromEnv } from "../dist/sandbox-providers/index.js";
import { OperationalSettings, PLATFORM_SETTINGS, checkSetting, operationalSetting } from "../dist/platform-settings.js";
import { auditClass } from "../dist/audit-classes.js";
import { CATALOG } from "./helpers.js";

// The operational settings (platform-settings.ts): non-secret, typed, kept in the settings table, changed by admins
// only and audited old → new. The server's environment overrides what's stored; what's stored overrides the default;
// and their consumers read them at each use, so a change needs no restart.

const T = "financial_products";
const NINE = ["BUILD_CAP_USD", "BUILD_MONTHLY_CAP_USD", "BUILD_AUDIT", "BUILD_AUDIT_MODEL", "BUILD_AUDIT_CAP_USD", "BUILD_AUDIT_MINUTES", "BUILD_AUDIT_WORKFLOWS", "EXPLORE_CAP_USD", "FREESTYLE_USD_PER_HOUR"];

async function setup({ env = {} } = {}) {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const settings = await OperationalSettings.open(store, { env });
  const as = async (name, roles) => {
    const { user } = await store.createUser(name, roles);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, await store.getUser(user.id), { operationalSettings: settings }).connect(s);
    const client = new Client({ name: "platform-settings", version: "0" });
    await client.connect(c);
    return {
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
  return { store, settings, admin: await as("Ada", ["admin"]), dev: await as("Dana", ["developer"]), lp: await as("Lena", ["license_provider"]) };
}
const ok = (r) => {
  assert.equal(r.isError, false, r.text);
  return r.data;
};
const by = (data) => Object.fromEntries(data.settings.map((s) => [s.key, s]));

test("the list: the nine settings first, then the other agents' budgets; never a secret; each with how it's checked", async () => {
  const keys = PLATFORM_SETTINGS.map((s) => s.key);
  assert.deepEqual(keys.slice(0, 9), NINE);
  assert.deepEqual(keys.slice(9), ["EXPLORE_MAX_ITERATIONS", "EXPLORE_MAX_MINUTES", "DESK_JOB_CAP_USD", "DESK_MONTHLY_CAP_USD", "REVIEW_CASE_CAP_USD", "REVIEW_MONTHLY_CAP_USD"]);
  assert.ok(keys.every((k) => !/KEY|SECRET|TOKEN|PASSWORD|URL/.test(k)), "no secret is an operational setting");
  // Each default passes its own check.
  for (const s of PLATFORM_SETTINGS) assert.deepEqual(checkSetting(s.key, s.default), { ok: true, value: s.default }, s.key);

  const w = await setup({ env: { BUILD_CAP_USD: "12", BUILD_AUDIT: "something", FREESTYLE_API_KEY: "fake-secret-value", CLERK_SECRET_KEY: "fake-x" } });
  const r = await w.admin.call("get_platform_settings");
  const s = by(ok(r));
  assert.deepEqual(Object.keys(s), keys);
  assert.ok(!r.text.includes("fake-secret-value") && !r.text.includes("fake-x"));
  assert.deepEqual([s.BUILD_CAP_USD.value, s.BUILD_CAP_USD.source, s.BUILD_CAP_USD.source_label, s.BUILD_CAP_USD.overridden_by_environment], ["12", "environment", "Server environment", true]);
  assert.deepEqual([s.BUILD_MONTHLY_CAP_USD.value, s.BUILD_MONTHLY_CAP_USD.default, s.BUILD_MONTHLY_CAP_USD.source], ["100", "100", "default"]);
  assert.equal(s.BUILD_AUDIT.value, "none", "anything but maxwell runs no audit, as builds.ts reads it");
  assert.deepEqual(s.BUILD_AUDIT.options, ["none", "maxwell"]);
  assert.equal(s.BUILD_CAP_USD.validation, "A number from 0.5 to 500");
  assert.equal(s.BUILD_AUDIT_MINUTES.validation, "A whole number from 1 to 240");
  for (const x of Object.values(s)) assert.ok(x.description && x.used_by && x.validation && x.needs_restart === false, x.key);
});

test("admins only; a value is checked against its type and range before it's kept", async () => {
  const w = await setup();
  assert.ok((await w.admin.tools()).includes("set_platform_setting"));
  for (const who of [w.dev, w.lp]) {
    assert.ok(!(await who.tools()).includes("set_platform_setting") && !(await who.tools()).includes("get_platform_settings"));
    assert.equal((await who.call("set_platform_setting", { key: "BUILD_CAP_USD", value: "50" })).isError, true);
  }
  const refused = [
    ["BUILD_CAP_USD", "0"],
    ["BUILD_CAP_USD", "501"],
    ["BUILD_CAP_USD", "-3"],
    ["BUILD_CAP_USD", "ten"],
    ["BUILD_CAP_USD", "1e3"],
    ["BUILD_AUDIT", "on"],
    ["BUILD_AUDIT_MINUTES", "2.5"],
    ["BUILD_AUDIT_MINUTES", "0"],
    ["BUILD_AUDIT_MODEL", "Some Model!"],
    ["BUILD_AUDIT_WORKFLOWS", "execute-scr,; rm -rf"],
    ["FREESTYLE_USD_PER_HOUR", "51"],
  ];
  for (const [key, value] of refused) {
    const r = await w.admin.call("set_platform_setting", { key, value });
    assert.equal(r.isError, true, `${key}=${value}`);
  }
  assert.match((await w.admin.call("set_platform_setting", { key: "BUILD_CAP_USD", value: "501" })).data.error, /BUILD_CAP_USD takes a number from 0.5 to 500/);
  assert.equal((await w.admin.call("set_platform_setting", { key: "DATABASE_URL", value: "x" })).isError, true, "only the listed settings");
  assert.equal((await w.admin.call("set_platform_setting", { key: "BUILD_CAP_USD", value: "20", extra: true })).isError, true, "a strict input");
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.settings WHERE key LIKE 'ops:%'`)).rows[0].n, 0, "nothing refused was stored");
  assert.equal((await w.store.db.query(`SELECT count(*)::int AS n FROM ${T}.audit_log WHERE action = 'set_platform_setting'`)).rows[0].n, 0);
});

test("a change is stored, audited old → new, and read by its consumers at the next use, without a restart", async () => {
  const w = await setup();
  // Built once, as the server builds them when it starts.
  const env = {};
  const builds = buildConfigFromEnv(env);
  const desk = deskConfigFromEnv(builds, env);
  const explore = exploreConfigFromEnv(desk, env);
  const review = reviewConfigFromEnv(builds, env);
  assert.deepEqual([builds.capUsd, builds.monthlyCapUsd, builds.audit.mode, builds.audit.minutes, explore.capUsd, desk.jobCapUsd, review.caseCapUsd], [10, 100, "none", 20, 20, 5, 3]);

  const set = ok(await w.admin.call("set_platform_setting", { key: "BUILD_CAP_USD", value: " 25 " }));
  assert.deepEqual([set.from, set.to, set.in_effect], ["10", "25", true]);
  assert.match(set.message, /applies from the next use/);
  assert.deepEqual([set.setting.value, set.setting.source, set.setting.source_label, set.setting.set_by], ["25", "stored", "Set in Mynt", "Ada"]);
  assert.equal(builds.capUsd, 25, "the same config object, no restart");
  ok(await w.admin.call("set_platform_setting", { key: "BUILD_MONTHLY_CAP_USD", value: "250" }));
  ok(await w.admin.call("set_platform_setting", { key: "BUILD_AUDIT", value: "maxwell" }));
  ok(await w.admin.call("set_platform_setting", { key: "BUILD_AUDIT_MINUTES", value: "45" }));
  ok(await w.admin.call("set_platform_setting", { key: "BUILD_AUDIT_WORKFLOWS", value: "execute-scr, probe-cicd-env ,extra-one" }));
  ok(await w.admin.call("set_platform_setting", { key: "EXPLORE_CAP_USD", value: "7.5" }));
  ok(await w.admin.call("set_platform_setting", { key: "DESK_JOB_CAP_USD", value: "8" }));
  ok(await w.admin.call("set_platform_setting", { key: "REVIEW_CASE_CAP_USD", value: "4" }));
  ok(await w.admin.call("set_platform_setting", { key: "FREESTYLE_USD_PER_HOUR", value: "0.35" }));
  assert.deepEqual([builds.monthlyCapUsd, monthlyBuildCapUsd(env), builds.audit.mode, builds.audit.minutes, builds.audit.workflows], [250, 250, "maxwell", 45, ["execute-scr", "probe-cicd-env", "extra-one"]]);
  assert.deepEqual([explore.capUsd, desk.jobCapUsd, review.caseCapUsd], [7.5, 8, 4]);
  assert.equal(operationalSetting("FREESTYLE_USD_PER_HOUR", env), "0.35");
  // The sandbox host prices machine time with it each time it's asked.
  const sandboxes = sandboxesFromEnv({ FREESTYLE_API_KEY: "fake-sandbox-key-000000000001" });
  assert.equal(sandboxes.opts.usdPerHour, 0.35);
  ok(await w.admin.call("set_platform_setting", { key: "FREESTYLE_USD_PER_HOUR", value: "0.5" }));
  assert.equal(sandboxes.opts.usdPerHour, 0.5);

  // Changed again: from is what was stored.
  const again = ok(await w.admin.call("set_platform_setting", { key: "BUILD_CAP_USD", value: "30" }));
  assert.deepEqual([again.from, again.to], ["25", "30"]);
  // Back to Mynt's default.
  const reset = ok(await w.admin.call("set_platform_setting", { key: "BUILD_CAP_USD", value: null }));
  assert.deepEqual([reset.from, reset.to, reset.setting.source, reset.setting.value], ["30", "10", "default", "10"]);
  assert.equal(builds.capUsd, 10);

  const trail = (await w.store.db.query(`SELECT action, target, details, actor_id FROM ${T}.audit_log WHERE action = 'set_platform_setting' AND target = 'BUILD_CAP_USD' ORDER BY created_at, id`)).rows;
  assert.deepEqual(trail.map((t) => [t.details.from, t.details.to, t.details.reset_to_default]), [["10", "25", false], ["25", "30", false], ["30", "10", true]]);
  assert.ok(trail.every((t) => t.actor_id));
  assert.equal(auditClass("set_platform_setting"), "security");

  // A restart reads what was stored.
  const restarted = await OperationalSettings.open(w.store, { env: {} });
  assert.equal(Object.fromEntries(restarted.list().map((s) => [s.key, s.value])).BUILD_AUDIT, "maxwell");
  assert.equal(buildConfigFromEnv({}).audit.mode, "maxwell");
});

test("the server's environment overrides what's stored: the row says so, and the consumer keeps the environment's value", async () => {
  const env = { BUILD_CAP_USD: "12", BUILD_AUDIT_MODEL: "" };
  const w = await setup({ env });
  const builds = buildConfigFromEnv(env);
  assert.equal(builds.capUsd, 12);
  const set = ok(await w.admin.call("set_platform_setting", { key: "BUILD_CAP_USD", value: "40" }));
  assert.equal(set.in_effect, false);
  assert.match(set.message, /server's environment sets it to 12, which wins/);
  assert.deepEqual([set.setting.value, set.setting.source, set.setting.stored_value, set.setting.overridden_by_environment], ["12", "environment", "40", true]);
  assert.equal(builds.capUsd, 12, "the environment still wins");
  assert.equal((await w.store.db.query(`SELECT details FROM ${T}.audit_log WHERE action = 'set_platform_setting'`)).rows[0].details.overridden_by, "environment");
  // Once the server stops setting it, what's stored takes over.
  assert.equal(buildConfigFromEnv({}).capUsd, 40);
  // An empty variable isn't a setting: what's stored (or the default) applies, as the list says.
  ok(await w.admin.call("set_platform_setting", { key: "BUILD_AUDIT_MODEL", value: "claude-fake-model-1" }));
  assert.equal(builds.audit.model, "claude-fake-model-1");
  assert.equal(by(ok(await w.admin.call("get_platform_settings"))).BUILD_AUDIT_MODEL.source, "stored");
});

test("with nothing stored, the environment is read exactly as before", async () => {
  await setup(); // an empty store: nothing kept
  const c = buildConfigFromEnv({ BUILD_CAP_USD: "7", BUILD_MONTHLY_CAP_USD: "70", BUILD_AUDIT: "maxwell", BUILD_AUDIT_MODEL: "m-1", BUILD_AUDIT_CAP_USD: "2", BUILD_AUDIT_MINUTES: "9", BUILD_AUDIT_WORKFLOWS: "a-b, c-d" });
  assert.deepEqual([c.capUsd, c.monthlyCapUsd, c.audit.mode, c.audit.model, c.audit.capUsd, c.audit.minutes, c.audit.workflows], [7, 70, "maxwell", "m-1", 2, 9, ["a-b", "c-d"]]);
  const d = buildConfigFromEnv({});
  assert.deepEqual([d.capUsd, d.monthlyCapUsd, d.audit.mode, d.audit.model, d.audit.capUsd, d.audit.minutes, d.audit.workflows], [10, 100, "none", "claude-sonnet-5-5", 5, 20, ["execute-scr", "probe-cicd-env"]]);
  assert.equal(exploreConfigFromEnv({ sandboxType: "default" }, { EXPLORE_CAP_USD: "33" }).capUsd, 33);
});
