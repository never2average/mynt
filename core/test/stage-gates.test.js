import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { createMcpHttpServer } from "../dist/http.js";
import { Store } from "../dist/store.js";
import { grandfatherLiveApps } from "../dist/promotion-schema.js";
import { CATALOG, inProduction } from "./helpers.js";

// Production gates real money: live keys, live runtime calls and publishing are for apps whose stored stage is
// production. Ideas and staging run on sandbox keys only.

const PROMOTE = /Promote this app to Production first/;

async function setup() {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const person = async (name) => {
    const { user } = await store.createUser(name, ["developer"]);
    const email = `${name.toLowerCase()}@example.com`;
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, email]);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, { ...user, email }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    const call = async (name, args = {}) => {
      const res = await client.callTool({ name, arguments: args });
      let data;
      try {
        data = JSON.parse(res.content[0].text);
      } catch {
        data = { error: res.content[0].text };
      }
      return { isError: res.isError ?? false, data };
    };
    return { user, call };
  };
  const http = createMcpHttpServer(store, null, {}, { publicUrl: "https://mynt.test" }).listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  const base = `http://127.0.0.1:${http.address().port}`;
  const api = async (method, path, secret) => {
    const res = await fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${secret}` } });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const close = () => {
    http.closeAllConnections();
    http.close();
  };
  const ana = await person("Ana");
  const app = (await ana.call("create_app", { name: "Saver", description: "Saving", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  assert.ok(app.id, JSON.stringify(app));
  const setStage = (stage) =>
    pg.query("INSERT INTO financial_products.app_promotions (app_id, stage) VALUES ($1, $2) ON CONFLICT (app_id) DO UPDATE SET stage = EXCLUDED.stage", [app.id, stage]);
  return { pg, store, ana, app, api, close, setStage };
}

test("live keys, rotation and publishing: production apps only; ideas and staging get sandbox keys", async () => {
  const w = await setup();
  try {
    const { ana, app } = w;
    for (const stage of ["idea", "staging"]) {
      if (stage === "staging") await w.setStage("staging");
      const live = await ana.call("create_api_key", { app_id: app.id, environment: "live", label: "prod" });
      assert.equal(live.isError, true, stage);
      assert.match(live.data.error, PROMOTE, stage);
      assert.equal((await ana.call("create_api_key", { app_id: app.id, environment: "sandbox", label: "dev" })).isError, false, stage);
      assert.match((await ana.call("publish_app", { app_id: app.id })).data.error, PROMOTE, stage);
      assert.match((await ana.call("release_app", { app_id: app.id, version: "1.0.0", changelog: "first" })).data.error, PROMOTE, stage);
    }
    // In production: a live key, and publishing goes on to its own checks.
    await w.setStage("production");
    const live = await ana.call("create_api_key", { app_id: app.id, environment: "live", label: "prod" });
    assert.equal(live.isError, false, JSON.stringify(live.data));
    const pub = await ana.call("publish_app", { app_id: app.id });
    assert.doesNotMatch(JSON.stringify(pub.data), PROMOTE);
    // Back in staging (as by a demotion after its keys were revoked): an old live key can't be rotated.
    await w.setStage("staging");
    assert.match((await ana.call("rotate_api_key", { key_id: live.data.id })).data.error, PROMOTE);
  } finally {
    w.close();
  }
});

test("the runtime API refuses live calls (keys and client sessions) from an app not in production; sandbox calls go on", async () => {
  const w = await setup();
  try {
    const { store, app, api } = w;
    await inProduction(store, app.id);
    await w.pg.query("UPDATE financial_products.apps SET status = 'published' WHERE id = $1", [app.id]);
    const { key: liveKey, secret: live } = await store.createApiKey(w.ana.user.id, { app_id: app.id, environment: "live", label: "prod", allowed_origins: [] });
    const { secret: sandbox } = await store.createApiKey(w.ana.user.id, { app_id: app.id, environment: "sandbox", label: "dev", allowed_origins: [] });
    const { secret: session } = await store.createClientSession({ app_id: app.id, key_id: liveKey.id, customer_ref: "c1", product_ids: ["fixed-deposit"], scopes: [], sandbox: false, ttl_seconds: 600 });
    const path = "/v1/products/fixed-deposit/contract";
    const okLive = await api("GET", path, live);
    assert.notEqual(okLive.body?.error, "app_not_in_production", "production: the gate lets it through");
    await w.setStage("staging");
    for (const [secret, p] of [
      [live, path],
      [session, "/v1/client/products"],
    ]) {
      const r = await api("GET", p, secret);
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "app_not_in_production");
      assert.match(r.body.message, PROMOTE);
    }
    const sb = await api("GET", path, sandbox);
    assert.notEqual(sb.body?.error, "app_not_in_production", "sandbox calls aren't gated");
  } finally {
    w.close();
  }
});

test("demoting a production app: refused while it has active live keys; once they're revoked it goes, unpublished", async () => {
  const w = await setup();
  try {
    const { ana, app } = w;
    await w.setStage("production");
    const live = (await ana.call("create_api_key", { app_id: app.id, environment: "live", label: "prod" })).data;
    await w.pg.query("UPDATE financial_products.apps SET status = 'published' WHERE id = $1", [app.id]);
    const refused = await ana.call("demote_app", { app_id: app.id, to_stage: "staging", reason: "Rework" });
    assert.match(refused.data.error, /active live key\(s\).*revoke them first/);
    assert.ok(refused.data.error.includes(live.id), "names the key");
    assert.equal((await w.pg.query("SELECT stage FROM financial_products.app_promotions WHERE app_id = $1", [app.id])).rows[0].stage, "production");
    assert.equal((await ana.call("revoke_api_key", { key_id: live.id })).isError, false);
    const d = await ana.call("demote_app", { app_id: app.id, to_stage: "staging", reason: "Rework" });
    assert.equal(d.isError, false, JSON.stringify(d.data));
    assert.equal(d.data.unpublished, true);
    assert.equal((await w.store.getApp(app.id)).status, "draft");
    const audit = (await w.pg.query("SELECT details FROM financial_products.audit_log WHERE action = 'app_demoted' AND target = $1", [app.id])).rows[0].details;
    assert.equal(audit.unpublished, true);
    // Staging to idea: no keys question.
    assert.equal((await ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "Back to ideas" })).isError, false);
  } finally {
    w.close();
  }
});

test("grandfathering, once: apps already live (a live key, published, or real customers) go to production with why; others don't", async () => {
  const w = await setup();
  try {
    const { store, ana, pg } = w;
    const make = async (name) => (await ana.call("create_app", { name, description: "d", audience: "a", product_ids: ["fixed-deposit"] })).data;
    const keyed = w.app;
    await store.createApiKey(ana.user.id, { app_id: keyed.id, environment: "live", label: "old", allowed_origins: [] });
    const published = await make("Published");
    await pg.query("UPDATE financial_products.apps SET status = 'published' WHERE id = $1", [published.id]);
    const customers = await make("Customers");
    await pg.query(
      "INSERT INTO financial_products.handoffs (id, app_id, product_id, action, sandbox, status, redirect_url) VALUES ($1, $2, 'fixed-deposit', 'deep_link', false, 'completed', 'https://example.com')",
      [randomUUID(), customers.id],
    );
    const sandboxOnly = await make("Sandbox only");
    await store.createApiKey(ana.user.id, { app_id: sandboxOnly.id, environment: "sandbox", label: "dev", allowed_origins: [] });
    await pg.query("DELETE FROM financial_products.app_live_grandfathered");
    assert.equal(await grandfatherLiveApps(store.db), 3);
    const stage = async (id) => (await pg.query("SELECT stage FROM financial_products.app_promotions WHERE app_id = $1", [id])).rows[0]?.stage ?? "idea";
    assert.deepEqual([await stage(keyed.id), await stage(published.id), await stage(customers.id), await stage(sandboxOnly.id)], ["production", "production", "production", "idea"]);
    const why = Object.fromEntries(
      (await pg.query("SELECT target, details FROM financial_products.audit_log WHERE action = 'app_stage_grandfathered'")).rows.map((r) => [r.target, r.details.why]),
    );
    assert.deepEqual(why, { [keyed.id]: ["an active live key"], [published.id]: ["published"], [customers.id]: ["real customers"] });
    assert.equal(await grandfatherLiveApps(store.db), 0, "once");
    // Their live keys keep working: the app is in production.
    assert.equal((await ana.call("create_api_key", { app_id: keyed.id, environment: "live", label: "new" })).isError, false);
  } finally {
    w.close();
  }
});
