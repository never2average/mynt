// Financial products move idea → staging → production as apps do (product-stages.ts): the stage of existing rows,
// promotion and demotion with their checks, staging products for sandbox builds only, publish_product as promotion
// to production, and the audit trail.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, inProduction, licensed } from "./helpers.js";

const open = (pg) => Store.open({ query: (sql, params) => pg.query(sql, params), exec: (sql) => pg.exec(sql), close: () => pg.close() }, CATALOG);
async function connect(store, user) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await createServer(store, user).connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}
const call = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
};

const fd = (id, name = "Green Fixed Deposit") => ({
  id,
  name,
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
});

async function setup() {
  const pg = new PGlite();
  const store = await open(pg);
  const innovator = (await store.createUser("Ines", ["innovator"])).user;
  const developer = (await store.createUser("Dev", ["developer"])).user;
  return { pg, store, innovator, developer, inno: await connect(store, innovator), dev: await connect(store, developer) };
}
const stageOf = async (client, id) => (await call(client, "list_my_products")).data.find((p) => p.id === id)?.stage;
const audits = async (store, action) => (await store.db.query("SELECT target, details FROM financial_products.audit_log WHERE action = $1 ORDER BY created_at", [action])).rows;

test("existing rows keep their availability: published is production, drafts and unpublished are ideas", async () => {
  const { pg, store, innovator, inno } = await setup();
  await licensed(store, innovator);
  for (const id of ["live-fd", "draft-fd", "gone-fd"]) await call(inno, "create_product", fd(id));
  for (const id of ["live-fd", "gone-fd"]) {
    await call(inno, "test_product", { id });
    assert.equal((await call(inno, "publish_product", { id })).data.status, "published");
  }
  await call(inno, "unpublish_product", { id: "gone-fd" });
  // As before the stage column existed: drop it, then open the store again, which adds it back on existing rows.
  await store.db.query("ALTER TABLE financial_products.products DROP COLUMN stage");
  const before = (await store.db.query("SELECT id, status FROM financial_products.products WHERE owner_id = $1 ORDER BY id", [innovator.id])).rows;
  const again = await open(pg);
  const after = (await again.db.query("SELECT id, status, stage FROM financial_products.products WHERE owner_id = $1 ORDER BY id", [innovator.id])).rows;
  assert.deepEqual(after.map((r) => ({ id: r.id, status: r.status })), before, "no status changes");
  assert.ok(after.every((r) => r.stage === null), "the new column is empty on every existing row");
  const client = await connect(again, innovator);
  assert.equal(await stageOf(client, "live-fd"), "production");
  assert.equal(await stageOf(client, "draft-fd"), "idea");
  assert.equal(await stageOf(client, "gone-fd"), "idea");
  assert.ok((await again.publishedProducts()).some((p) => p.id === "live-fd"), "still in the catalogue");
});

test("promotion goes one step at a time, with Mynt's checks; demotion steps back down, audited", async () => {
  const { store, innovator, inno } = await setup();
  await call(inno, "create_product", fd("green-fd"));
  assert.match((await call(inno, "promote_product", { product_id: "green-fd", to_stage: "production" })).data.error, /one step at a time/);
  // Staging needs a passing test of what would go live.
  const untested = await call(inno, "get_product_promotion_checks", { product_id: "green-fd", to_stage: "staging" });
  assert.equal(untested.data.can_promote, false);
  assert.equal(untested.data.checks[0].id, "tests_passed");
  assert.match((await call(inno, "promote_product", { product_id: "green-fd", to_stage: "staging" })).data.error, /test_product/);
  await call(inno, "test_product", { id: "green-fd" });
  const staged = await call(inno, "promote_product", { product_id: "green-fd", to_stage: "staging" });
  assert.equal(staged.isError, false, JSON.stringify(staged.data));
  assert.equal(staged.data.stage, "staging");
  assert.equal(await stageOf(inno, "green-fd"), "staging");
  assert.equal((await store.getProduct("green-fd")).status, "draft", "staging isn't published");

  // Production needs what publishing needs: no licence, no promotion.
  const checks = (await call(inno, "get_product_promotion_checks", { product_id: "green-fd", to_stage: "production" })).data;
  assert.equal(checks.can_promote, false);
  assert.equal(checks.checks.find((c) => c.id === "licences").status, "fail");
  assert.match((await call(inno, "promote_product", { product_id: "green-fd", to_stage: "production" })).data.error, /verified licence/);
  assert.equal(await stageOf(inno, "green-fd"), "staging");
  await licensed(store, innovator);
  const live = await call(inno, "promote_product", { product_id: "green-fd", to_stage: "production" });
  assert.equal(live.isError, false, JSON.stringify(live.data));
  assert.equal((await store.getProduct("green-fd")).status, "published");
  assert.equal((await store.getProduct("green-fd")).stage, null, "publishing clears the stored stage");
  assert.equal(await stageOf(inno, "green-fd"), "production");
  assert.match((await call(inno, "promote_product", { product_id: "green-fd", to_stage: "production" })).data.error, /already in production/);

  // Down: one step, with a reason; out of production it leaves the catalogue and stays in staging.
  assert.match((await call(inno, "demote_product", { product_id: "green-fd", to_stage: "idea", reason: "x" })).data.error, /one step at a time/);
  const down = await call(inno, "demote_product", { product_id: "green-fd", to_stage: "staging", reason: "Rate review" });
  assert.equal(down.data.unpublished, true);
  assert.equal((await store.getProduct("green-fd")).status, "unpublished");
  assert.equal(await stageOf(inno, "green-fd"), "staging");
  assert.ok(!(await store.publishedProducts()).some((p) => p.id === "green-fd"));
  await call(inno, "demote_product", { product_id: "green-fd", to_stage: "staging", reason: "again" }).then((r) => assert.equal(r.isError, true));
  assert.equal((await call(inno, "demote_product", { product_id: "green-fd", to_stage: "idea", reason: "Back to the drawing board" })).isError, false);
  assert.equal(await stageOf(inno, "green-fd"), "idea");
  assert.match((await call(inno, "demote_product", { product_id: "green-fd", to_stage: "idea", reason: "x" })).data.error, /first stage/);

  const promoted = await audits(store, "product_promoted");
  assert.deepEqual(promoted.map((r) => [r.details.from_stage, r.details.to_stage, r.details.via]), [["idea", "staging", "promote_product"], ["staging", "production", "promote_product"]]);
  assert.ok(promoted[1].details.checks.every((c) => c.status === "pass"), "the checks it passed with");
  const demoted = await audits(store, "product_demoted");
  assert.deepEqual(demoted.map((r) => [r.details.from_stage, r.details.to_stage, r.details.reason]), [["production", "staging", "Rate review"], ["staging", "idea", "Back to the drawing board"]]);
});

test("only the owner moves a product", async () => {
  const { store, inno } = await setup();
  await call(inno, "create_product", fd("green-fd"));
  await call(inno, "test_product", { id: "green-fd" });
  const rival = await connect(store, (await store.createUser("Ravi", ["innovator"])).user);
  assert.match((await call(rival, "promote_product", { product_id: "green-fd", to_stage: "staging" })).data.error, /No product of yours/);
  assert.match((await call(rival, "demote_product", { product_id: "green-fd", to_stage: "idea", reason: "x" })).data.error, /No product of yours/);
});

test("publish_product still works, as a promotion to production, with the same refusals", async () => {
  const { store, innovator, inno } = await setup();
  await call(inno, "create_product", fd("green-fd"));
  assert.match((await call(inno, "publish_product", { id: "green-fd" })).data.error, /run test_product first/);
  await call(inno, "test_product", { id: "green-fd" });
  assert.match((await call(inno, "publish_product", { id: "green-fd" })).data.error, /Publishing needs a verified licence/);
  await licensed(store, innovator);
  const r = await call(inno, "publish_product", { id: "green-fd" });
  assert.equal(r.data.status, "published");
  assert.equal(r.data.licensed_under.length, 1);
  assert.match((await call(inno, "publish_product", { id: "green-fd" })).data.error, /already published/);
  const [audit] = await audits(store, "product_promoted");
  assert.deepEqual([audit.details.from_stage, audit.details.to_stage, audit.details.via], ["idea", "production", "publish_product"]);

  // A production product's next version goes live by a promotion to production, staying in production meanwhile.
  await call(inno, "create_product_version", { id: "green-fd", changelog: "Better rate", name: "Green FD v2" });
  assert.equal(await stageOf(inno, "green-fd"), "production");
  await call(inno, "test_product", { id: "green-fd" });
  const v2 = await call(inno, "promote_product", { product_id: "green-fd", to_stage: "production" });
  assert.equal(v2.isError, false, JSON.stringify(v2.data));
  assert.equal(v2.data.version, 2);
  assert.equal((await store.getProduct("green-fd")).product.name, "Green FD v2");
});

test("a product in staging is for sandbox builds only, never production apps", async () => {
  const { store, innovator, inno, dev } = await setup();
  await licensed(store, innovator);
  for (const id of ["live-fd", "staged-fd"]) {
    await call(inno, "create_product", fd(id, id));
    await call(inno, "test_product", { id });
    await call(inno, "set_product_access", { id, access_mode: "open" });
  }
  await call(inno, "publish_product", { id: "live-fd" });
  await call(inno, "promote_product", { product_id: "staged-fd", to_stage: "staging" });

  const production = (await call(dev, "list_buildable_products")).data.map((p) => p.id);
  assert.ok(production.includes("live-fd"));
  assert.ok(!production.includes("staged-fd"), "not offered for production builds");
  const sandbox = (await call(dev, "list_buildable_products", { environment: "sandbox" })).data;
  assert.equal(sandbox.find((p) => p.id === "staged-fd")?.stage, "staging");
  assert.equal(sandbox.find((p) => p.id === "live-fd")?.stage, "production");
  assert.equal((await call(dev, "get_product_sdk", { product_id: "staged-fd" })).data.stage, "staging");

  // A new app (an idea) may pin it for sandbox builds.
  const app = await call(dev, "create_app", { name: "Saver", description: "Saves", audience: "Savers", product_ids: ["staged-fd"] });
  assert.equal(app.isError, false, JSON.stringify(app.data));
  // A production app may not take it on, and promote_app's licence check refuses an app that uses it.
  const other = (await call(dev, "create_app", { name: "Live", description: "Live", audience: "Savers", product_ids: ["live-fd"] })).data;
  await inProduction(store, other.id);
  assert.match((await call(dev, "update_app", { app_id: other.id, product_ids: ["live-fd", "staged-fd"] })).data.error, /in staging: sandbox builds only/);
  await call(dev, "set_app_target_states", { app_id: app.data.id, states: ["us-ny"] });
  await store.db.query("INSERT INTO financial_products.app_promotions (app_id, stage) VALUES ($1, 'staging') ON CONFLICT (app_id) DO UPDATE SET stage = 'staging'", [app.data.id]);
  const checks = (await call(dev, "get_promotion_checks", { app_id: app.data.id, to_stage: "production" })).data;
  const licences = checks.checks.find((c) => c.id === "licences");
  assert.equal(licences.status, "fail");
  assert.match(licences.detail, /is in staging \(sandbox builds only\)/);

  // Out of staging, sandbox builds can no longer pick it.
  await call(inno, "demote_product", { product_id: "staged-fd", to_stage: "idea", reason: "Not yet" });
  assert.ok(!(await call(dev, "list_buildable_products", { environment: "sandbox" })).data.some((p) => p.id === "staged-fd"));
  assert.match((await call(dev, "create_app", { name: "X", description: "X", audience: "X", product_ids: ["staged-fd"] })).data.error, /not published/);
});
