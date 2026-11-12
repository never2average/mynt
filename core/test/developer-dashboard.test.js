import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const connect = async (name, roles = ["developer"]) => {
    const { user } = await store.createUser(name, roles);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, {}).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return { user, client };
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
  return { pg, store, connect, call };
}

// A live, settled money movement (or another status) through an app, on a real rail.
async function moved(pg, store, ownerId, appId, { cents, settled = cents, status = "settled", sandbox = false, day = new Date().toISOString().slice(0, 10) }) {
  let rail = (await pg.query("SELECT id, entity_id FROM financial_products.money_rails LIMIT 1")).rows[0];
  if (!rail) {
    const entity = await store.createEntity(ownerId, { name: "Bank Ltd", registration_numbers: {}, regions: ["US"] });
    rail = { id: randomUUID(), entity_id: entity.id };
    await pg.query(
      `INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status)
       VALUES ($1, $2, 'ach', 'test', 'deposit', '{CA}', 100000000, 100000000, 'approved')`,
      [rail.id, rail.entity_id],
    );
  }
  const at = `${day}T12:00:00Z`;
  await pg.query(
    `INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, app_id, sponsor_entity_id, rail_id, direction, amount_cents, settled_amount_cents, status, sandbox, created_at, updated_at, settled_at)
     VALUES ($1, $2, 'fixed-deposit', $3, $4, $5, 'deposit', $6, $7, $8, $9, $10, $10, CASE WHEN $8 = 'settled' THEN $10::timestamptz END)`,
    [randomUUID(), randomUUID(), appId, rail.entity_id, rail.id, cents, status === "settled" ? settled : null, status, sandbox, at],
  );
}

test("the developer dashboard: the studio's contract, live money and hand-offs across the caller's own apps only", async () => {
  const { pg, store, connect, call } = await setup();
  const dev = await connect("Dev");
  const other = await connect("Other");
  const appA = (await call(dev.client, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const appB = (await call(dev.client, "create_app", { name: "Starter", description: "First salary", audience: "Graduates", product_ids: ["fixed-deposit"] })).data;
  const theirs = (await call(other.client, "create_app", { name: "Theirs", description: "Not yours", audience: "Anyone", product_ids: ["fixed-deposit"] })).data;

  // Strict input: 7, 30 or 90 days, nothing else.
  assert.equal((await call(dev.client, "get_developer_dashboard", { days: 14 })).isError, true);
  assert.equal((await call(dev.client, "get_developer_dashboard", { days: 30, extra: 1 })).isError, true);

  // Nothing yet: zeros where Mynt measured nothing, nulls where it doesn't measure.
  const empty = (await call(dev.client, "get_developer_dashboard")).data;
  assert.equal(empty.currency, "USD");
  assert.equal(empty.period.days, 30);
  assert.equal(empty.daily.length, 30);
  assert.deepEqual(empty.money_moved, { settled_usd: 0, live: true });
  assert.deepEqual(empty.customers, { active_enrollments: null });
  assert.deepEqual(empty.handoffs, { total: 0, converted: 0, conversion_rate: null });
  assert.deepEqual(empty.build_spend, { month_usd: null, monthly_cap_usd: null }, "no builds service here: not measured");
  assert.deepEqual(empty.earnings, { usd: null, tracked: false });
  assert.deepEqual(empty.apps.map((a) => [a.name, a.status, a.money_moved_usd, a.customers, a.conversion_rate, a.last_build]), [
    ["Saver", "draft", 0, null, null, null],
    ["Starter", "draft", 0, null, null, null],
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await moved(pg, store, dev.user.id, appA.id, { cents: 5000, settled: 4901, day: yesterday }); // the settled amount counts
  await moved(pg, store, dev.user.id, appA.id, { cents: 1999, day: today });
  await moved(pg, store, dev.user.id, appB.id, { cents: 10, day: today });
  await moved(pg, store, dev.user.id, appA.id, { cents: 9999, status: "submitted" }); // not settled
  await moved(pg, store, dev.user.id, appA.id, { cents: 7777, sandbox: true }); // sandbox
  await moved(pg, store, other.user.id, theirs.id, { cents: 123456 }); // another developer's app
  for (const [app, status, sandbox] of [
    [appA.id, "completed", false],
    [appA.id, "started", false],
    [appA.id, "completed", true], // sandbox
    [appB.id, "failed", false],
    [theirs.id, "completed", false],
  ])
    await pg.query("INSERT INTO financial_products.handoffs (id, app_id, product_id, action, sandbox, status, redirect_url) VALUES ($1, $2, 'fixed-deposit', 'apply', $3, $4, 'https://provider.example/flow')", [randomUUID(), app, sandbox, status]);

  const d = (await call(dev.client, "get_developer_dashboard", { days: 7 })).data;
  assert.deepEqual(d.period, { from: new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10), to: today, days: 7 });
  assert.equal(d.money_moved.settled_usd, 69.1, "49.01 + 19.99 + 0.10, from cents");
  assert.equal(d.daily.length, 7);
  assert.deepEqual(d.daily.slice(-2), [{ date: yesterday, money_moved_usd: 49.01 }, { date: today, money_moved_usd: 20.09 }]);
  assert.deepEqual(d.handoffs, { total: 3, converted: 1, conversion_rate: 0.3333 });
  const a = d.apps.find((x) => x.app_id === appA.id);
  const b = d.apps.find((x) => x.app_id === appB.id);
  assert.deepEqual([a.money_moved_usd, b.money_moved_usd], [69, 0.1]);
  assert.deepEqual([a.conversion_rate, b.conversion_rate], [0.5, 0]);
  assert.ok(!d.apps.some((x) => x.app_id === theirs.id), "owner-scoped");
  // The other developer sees only theirs.
  const o = (await call(other.client, "get_developer_dashboard")).data;
  assert.deepEqual([o.apps.length, o.money_moved.settled_usd, o.handoffs.converted], [1, 1234.56, 1]);
});

test("the studio's catalogue and app creation: shapes it reads, and errors it can show", async () => {
  const { connect, call } = await setup();
  const dev = await connect("Dev");
  const products = (await call(dev.client, "list_buildable_products")).data;
  assert.ok(Array.isArray(products) && products.length > 0);
  for (const k of ["id", "name", "product_line", "region", "access_mode", "access", "build_terms"]) assert.ok(k in products[0], `list_buildable_products gives ${k}`);
  assert.ok(products.some((p) => p.id === "fixed-deposit"));
  const app = (await call(dev.client, "create_app", { name: "  Saver  ", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit", "fixed-deposit"] })).data;
  assert.equal(app.name, "Saver", "names are trimmed");
  assert.deepEqual(app.product_ids, ["fixed-deposit"], "a product named twice counts once");
  for (const k of ["id", "name", "status", "product_ids", "owner_id"]) assert.ok(k in app, `create_app gives ${k}`);
  const missing = await call(dev.client, "create_app", { name: "Ghost", description: "On nothing", audience: "Nobody", product_ids: ["no-such-product"] });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /Products not available: no-such-product \(not published\)/);
  const blank = await call(dev.client, "create_app", { name: "   ", description: "Blank name", audience: "Nobody", product_ids: ["fixed-deposit"] });
  assert.equal(blank.isError, true);
});
