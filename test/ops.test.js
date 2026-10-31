import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostingService } from "../dist/hosting.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

test("ops_status: admins see failures, stuck runs, spend and hosting trouble at a glance; nobody else gets the tool", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, {}).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const admin = await connect((await store.createUser("Ada", ["admin"])).user);
  const dev = await connect((await store.createUser("Dev", ["developer"])).user);
  assert.ok(!(await dev.listTools()).tools.some((t) => t.name === "ops_status"));
  const status = async (args = {}) => JSON.parse((await admin.callTool({ name: "ops_status", arguments: args })).content[0].text);

  // A quiet deployment: no agent tables yet, nothing to report.
  assert.deepEqual((await status()).attention, ["Nothing needs attention"]);

  // Builds: one failed today, one stuck for hours, spend this month; an old failure outside the window.
  await pg.exec(`CREATE TABLE financial_products.build_runs (id uuid PRIMARY KEY, status text, error text, cost_usd numeric, created_at timestamptz DEFAULT now())`);
  const add = (status, error, cost, ago) =>
    pg.query("INSERT INTO financial_products.build_runs (id, status, error, cost_usd, created_at) VALUES ($1, $2, $3, $4, now() - $5::interval)", [randomUUID(), status, error, cost, ago]);
  await add("failed", "Coding agent error_max_budget_usd", 3.5, "1 hour");
  await add("coding", null, 1.25, "5 hours");
  await add("succeeded", null, 2, "2 hours");
  await add("failed", "old", 0, "3 days");
  // Hosting: a VM that failed to come up, an app stopped with its error.
  const hosting = await HostingService.open(db, null, null);
  void hosting;
  const devId = (await store.createUser("Host", ["developer"])).user.id;
  const tenant = randomUUID();
  await pg.query("INSERT INTO financial_products.hosting_tenants (id, developer_id, provider, status, error) VALUES ($1, $2, 'freestyle', 'failed', 'VM setup failed: no space left')", [tenant, devId]);

  const s = await status();
  assert.deepEqual(s.attention, ["builds: 1 failed in the last 24h", "builds: 1 running over 120 min", "hosting: 1 VM(s) failed to provision"]);
  assert.deepEqual(s.agents.builds.last_hours, { coding: 1, failed: 1, succeeded: 1 });
  assert.equal(s.agents.builds.failures[0].error, "Coding agent error_max_budget_usd");
  assert.equal(s.agents.builds.stuck[0].status, "coding");
  const month = Number((await pg.query("SELECT coalesce(sum(cost_usd), 0) AS s FROM financial_products.build_runs WHERE created_at >= date_trunc('month', now())")).rows[0].s);
  assert.equal(s.agents.builds.spend_this_month_usd, month, "this calendar month's spend (6.75 unless run just after a month starts)");
  assert.equal(s.hosting.failed_tenants[0].error, "VM setup failed: no space left");
  assert.equal((await status({ hours: 96 })).agents.builds.failures.length, 2, "a wider window reaches the older failure");
});
