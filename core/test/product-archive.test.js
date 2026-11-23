// An owner archives a product in idea or staging to put it out of the way (product-stages.ts): it leaves their lists
// and every build, can't be promoted, keeps its stage for unarchiving, and nothing is deleted. Production is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

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
const fd = (id) => ({
  id,
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
});
async function setup() {
  const pg = new PGlite();
  const store = await open(pg);
  const innovator = (await store.createUser("Ines", ["innovator"])).user;
  const developer = (await store.createUser("Dev", ["developer"])).user;
  return { pg, store, innovator, inno: await connect(store, innovator), dev: await connect(store, developer) };
}
const ids = async (client, args) => (await call(client, "list_my_products", args)).data.map((p) => p.id);
const audits = async (store, action) => (await store.db.query("SELECT actor_id, target, details FROM financial_products.audit_log WHERE action = $1 ORDER BY created_at", [action])).rows;

test("the archived_at column is added empty on existing rows", async () => {
  const { pg, store, inno } = await setup();
  await call(inno, "create_product", fd("old-fd"));
  await store.db.query("ALTER TABLE financial_products.products DROP COLUMN archived_at");
  const again = await open(pg);
  const rows = (await again.db.query("SELECT id, status, archived_at FROM financial_products.products WHERE id = 'old-fd'")).rows;
  assert.deepEqual(rows.map((r) => [r.status, r.archived_at]), [["draft", null]]);
});

test("an idea is archived out of the owner's list, can't be promoted, and comes back as an idea; audited", async () => {
  const { store, innovator, inno } = await setup();
  await call(inno, "create_product", fd("demo-fd"));
  await call(inno, "create_product", fd("keep-fd"));
  const r = await call(inno, "archive_product", { product_id: "demo-fd", reason: "Test product" });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.archived, true);
  assert.equal(r.data.stage, "idea");
  assert.deepEqual(await ids(inno), ["keep-fd"]);
  const all = (await call(inno, "list_my_products", { include_archived: true })).data;
  const archived = all.find((p) => p.id === "demo-fd");
  assert.equal(archived.archived, true);
  assert.ok(archived.archived_at);
  assert.equal(all.find((p) => p.id === "keep-fd").archived, undefined);
  assert.match((await call(inno, "archive_product", { product_id: "demo-fd", reason: "again" })).data.error, /already archived/);

  await call(inno, "test_product", { id: "demo-fd" });
  assert.match((await call(inno, "promote_product", { product_id: "demo-fd", to_stage: "staging" })).data.error, /archived/);
  assert.match((await call(inno, "get_product_promotion_checks", { product_id: "demo-fd", to_stage: "staging" })).data.error, /archived/);
  await licensed(store, innovator);
  assert.match((await call(inno, "publish_product", { id: "demo-fd" })).data.error, /archived/);
  assert.equal((await store.getProduct("demo-fd")).status, "draft");

  const back = await call(inno, "unarchive_product", { product_id: "demo-fd" });
  assert.equal(back.isError, false, JSON.stringify(back.data));
  assert.equal(back.data.stage, "idea");
  assert.deepEqual((await ids(inno)).sort(), ["demo-fd", "keep-fd"]);
  assert.match((await call(inno, "unarchive_product", { product_id: "demo-fd" })).data.error, /isn't archived/);

  const [a] = await audits(store, "product_archived");
  assert.equal(a.actor_id, innovator.id);
  assert.deepEqual([a.target, a.details.stage, a.details.reason], ["demo-fd", "idea", "Test product"]);
  const [u] = await audits(store, "product_unarchived");
  assert.deepEqual([u.target, u.details.stage], ["demo-fd", "idea"]);
  assert.ok(u.details.archived_at);
});

test("archiving a staging product takes it out of sandbox builds; unarchiving puts it back in staging", async () => {
  const { store, innovator, inno, dev } = await setup();
  await licensed(store, innovator);
  await call(inno, "create_product", fd("staged-fd"));
  await call(inno, "test_product", { id: "staged-fd" });
  await call(inno, "set_product_access", { id: "staged-fd", access_mode: "open" });
  await call(inno, "promote_product", { product_id: "staged-fd", to_stage: "staging" });
  const sandbox = async () => (await call(dev, "list_buildable_products", { environment: "sandbox" })).data.map((p) => p.id);
  assert.ok((await sandbox()).includes("staged-fd"));

  const r = await call(inno, "archive_product", { product_id: "staged-fd", reason: "Done testing" });
  assert.equal(r.data.stage, "staging");
  assert.equal(r.data.left_sandbox_builds, true);
  assert.ok(!(await sandbox()).includes("staged-fd"), "not offered for sandbox builds");
  assert.ok(!(await store.stagingProducts()).some((p) => p.product.id === "staged-fd"));
  assert.match((await call(dev, "create_app", { name: "X", description: "X", audience: "X", product_ids: ["staged-fd"] })).data.error, /archived/);
  assert.match((await call(inno, "demote_product", { product_id: "staged-fd", to_stage: "idea", reason: "x" })).data.error, /archived/);
  assert.equal((await store.getProduct("staged-fd")).stage, "staging", "its stage is kept");

  const back = await call(inno, "unarchive_product", { product_id: "staged-fd", reason: "Needed again" });
  assert.equal(back.data.stage, "staging");
  assert.ok((await sandbox()).includes("staged-fd"));
  const app = await call(dev, "create_app", { name: "Saver", description: "Saves", audience: "Savers", product_ids: ["staged-fd"] });
  assert.equal(app.isError, false, JSON.stringify(app.data));
  assert.equal((await audits(store, "product_unarchived"))[0].details.reason, "Needed again");
});

test("a product in production is refused: move it back first", async () => {
  const { store, innovator, inno } = await setup();
  await licensed(store, innovator);
  await call(inno, "create_product", fd("live-fd"));
  await call(inno, "test_product", { id: "live-fd" });
  await call(inno, "publish_product", { id: "live-fd" });
  assert.match((await call(inno, "archive_product", { product_id: "live-fd", reason: "x" })).data.error, /production; move it back first/);
  assert.equal((await store.getProduct("live-fd")).archived_at, null);
  await call(inno, "demote_product", { product_id: "live-fd", to_stage: "staging", reason: "Winding down" });
  assert.equal((await call(inno, "archive_product", { product_id: "live-fd", reason: "Retired" })).isError, false);
});

test("only the owner archives or unarchives, and nothing is deleted", async () => {
  const { store, inno } = await setup();
  await call(inno, "create_product", fd("green-fd"));
  const rival = await connect(store, (await store.createUser("Ravi", ["innovator"])).user);
  assert.match((await call(rival, "archive_product", { product_id: "green-fd", reason: "x" })).data.error, /No product of yours/);
  assert.equal((await store.getProduct("green-fd")).archived_at, null);
  await call(inno, "archive_product", { product_id: "green-fd", reason: "Out of the way" });
  assert.match((await call(rival, "unarchive_product", { product_id: "green-fd" })).data.error, /No product of yours/);
  assert.equal((await store.db.query("SELECT count(*)::int AS n FROM financial_products.products WHERE id = 'green-fd'")).rows[0].n, 1);
});
