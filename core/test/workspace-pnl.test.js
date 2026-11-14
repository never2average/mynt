import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { HostingService } from "../dist/hosting.js";
import { periodStart, shiftPeriod, workspacePnl } from "../dist/workspace-pnl.js";
import { CATALOG } from "./helpers.js";

// A workspace's profit and loss (get_workspace_pnl): money settled through its apps against what building and running
// them costs, from the records Mynt keeps; whatever it doesn't keep is null with a reason, never 0.

const idleSandboxes = {
  async createSandbox() {
    return { id: "sbx", state: "provisioning" };
  },
  async getSandbox() {
    return undefined;
  },
  async stop() {},
  async readFile() {
    return null;
  },
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  async costDollars() {
    return 0;
  },
};

async function setup({ builds = true } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  if (builds) {
    await BuildService.open(db, store, idleSandboxes, null, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } });
    await HostingService.open(db, null, null);
  }
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
  const ana = await person("Ana"); // owner
  const mem = await person("Mem"); // a member
  const eve = await person("Eve"); // another workspace's owner
  const ws = (await ana.call("create_workspace", { name: "Team" })).data;
  const other = (await eve.call("create_workspace", { name: "Elsewhere" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member')", [ws.id, mem.user.id]);
  const app = async (who, workspace_id, name) =>
    (await who.call("create_app", { name, description: `${name} app`, audience: "Savers", product_ids: ["fixed-deposit"], workspace_id })).data;
  const saver = await app(ana, ws.id, "Saver");
  const starter = await app(ana, ws.id, "Starter");
  const theirs = await app(eve, other.id, "Theirs");

  let rail;
  const moved = async (appId, { cents, settled = cents, status = "settled", sandbox = false, at = new Date().toISOString() }) => {
    if (!rail) {
      const entity = await store.createEntity(ana.user.id, { name: "Bank Ltd", registration_numbers: {}, regions: ["US"] });
      rail = { id: randomUUID(), entity_id: entity.id };
      await pg.query(
        `INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status)
         VALUES ($1, $2, 'ach', 'test', 'deposit', '{CA}', 100000000, 100000000, 'approved')`,
        [rail.id, rail.entity_id],
      );
    }
    await pg.query(
      `INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, app_id, sponsor_entity_id, rail_id, direction, amount_cents, settled_amount_cents, status, sandbox, created_at, updated_at, settled_at)
       VALUES ($1, $2, 'fixed-deposit', $3, $4, $5, 'deposit', $6, $7, $8, $9, $10, $10, CASE WHEN $8 = 'settled' THEN $10::timestamptz END)`,
      [randomUUID(), randomUUID(), appId, rail.entity_id, rail.id, cents, status === "settled" ? settled : null, status, sandbox, at],
    );
  };
  const build = (appId, costUsd, at = new Date().toISOString()) =>
    pg.query(
      `INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cost_usd, cap_usd, created_at, updated_at)
       VALUES ($1, $2, $3, 'build it', 'succeeded', $4, 10, $5, $5)`,
      [randomUUID(), ana.user.id, appId, costUsd, at],
    );
  return { pg, store, ana, mem, eve, ws, other, saver, starter, theirs, moved, build };
}

const line = (lines, key) => lines.find((l) => l.key === key);

test("members only, strictly the workspace's own apps, and bounded input", async () => {
  const w = await setup();
  await w.moved(w.saver.id, { cents: 1000 });
  await w.moved(w.theirs.id, { cents: 999999 }); // another workspace's app
  await w.build(w.theirs.id, 50);

  const refused = await w.eve.call("get_workspace_pnl", { workspace_id: w.ws.id });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /No workspace of yours/);
  assert.equal((await w.ana.call("get_workspace_pnl", { workspace_id: "not-a-uuid" })).isError, true);
  // Another workspace's app can't be asked for through this one.
  const foreign = await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id, app_id: w.theirs.id });
  assert.equal(foreign.isError, true);
  assert.match(foreign.data.error, /No app with id/);

  const r = await w.mem.call("get_workspace_pnl", { workspace_id: w.ws.id });
  assert.equal(r.isError, false, JSON.stringify(r.data));
  assert.equal(r.data.currency, "USD");
  assert.deepEqual(new Set(r.data.statement.revenue.map((l) => l.app_id)), new Set([w.saver.id, w.starter.id]));
  assert.equal(r.data.statement.totals.revenue.this_period, 1000, "the other workspace's money never counts");
  assert.equal(line(r.data.statement.costs, "build_agents").values.this_period, 0, "nor its builds");

  // Bounds: 1..24 periods, month or week, nothing else.
  for (const bad of [{ periods: 0 }, { periods: 25 }, { periods: 2.5 }, { granularity: "day" }, { extra: 1 }])
    assert.equal((await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id, ...bad })).isError, true, JSON.stringify(bad));
  assert.equal(r.data.series.length, 6, "six periods by default");
  const one = (await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id, periods: 1 })).data;
  assert.equal(one.series.length, 1);
  const weeks = (await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id, granularity: "week", periods: 24 })).data;
  assert.equal(weeks.series.length, 24);
  for (let i = 1; i < 24; i++) {
    assert.equal(weeks.series[i].start, weeks.series[i - 1].end, "contiguous, oldest first");
    assert.equal(Date.parse(weeks.series[i].start) - Date.parse(weeks.series[i - 1].start), 7 * 86_400_000);
  }
  assert.equal(new Date(weeks.series[0].start).getUTCDay(), 1, "weeks start on Monday (UTC)");

  // Still readable while the workspace is archived.
  await w.pg.query("UPDATE financial_products.workspaces SET archived_at = now(), archive_offboard_at = now() + interval '7 days' WHERE id = $1", [w.ws.id]);
  assert.equal((await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id })).isError, false);
});

test("each measured line from Mynt's records; unmeasured lines null with reasons; net null when costs aren't all measured", async () => {
  const w = await setup();
  await w.moved(w.saver.id, { cents: 5000, settled: 4901 }); // the settled amount counts
  await w.moved(w.saver.id, { cents: 99 });
  await w.moved(w.starter.id, { cents: 10 });
  await w.moved(w.saver.id, { cents: 7777, status: "submitted" }); // not settled
  await w.moved(w.saver.id, { cents: 8888, sandbox: true }); // sandbox: never revenue
  await w.build(w.saver.id, 1.234);
  await w.build(w.starter.id, 2.5);

  const r = (await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id })).data;
  const s = r.statement;
  assert.deepEqual(s.columns.map((c) => c.key), ["this_period", "last_period", "year_to_date"]);
  const saver = line(s.revenue, `app:${w.saver.id}:product:fixed-deposit`);
  assert.equal(saver.product_id, "fixed-deposit");
  assert.equal(saver.measured, true);
  assert.equal(saver.values.this_period, 5000, "49.01 + 0.99");
  assert.equal(saver.values.last_period, 0);
  assert.equal(line(s.revenue, `app:${w.starter.id}:product:fixed-deposit`).values.this_period, 10);
  assert.equal(s.totals.revenue.this_period, 5010);
  assert.ok(s.totals.revenue.year_to_date >= 5010);

  const builds = line(s.costs, "build_agents");
  assert.equal(builds.measured, true);
  assert.equal(builds.values.this_period, 373, "1.234 + 2.50 dollars, in cents");
  const audits = line(s.costs, "audits");
  assert.deepEqual([audits.measured, audits.values.this_period], [true, 0]);
  assert.match(audits.source, /Mynt pays/);
  const hosting = line(s.costs, "hosting");
  assert.deepEqual([hosting.measured, hosting.values.this_period], [true, 0], "not hosted by Mynt: a real 0");

  for (const key of ["sandboxes", "mynt_fees"]) {
    const l = line(s.costs, key);
    assert.equal(l.measured, false, key);
    assert.deepEqual(l.values, { this_period: null, last_period: null, year_to_date: null }, key);
    const u = r.unmeasured.find((x) => x.key === key);
    assert.ok(u && u.reason.length > 20, key);
  }
  assert.ok(r.unmeasured.some((x) => x.key === "app_earnings"));
  // A cost line isn't measured, so total costs and net can't be: null, never a partial sum.
  assert.deepEqual(s.totals.costs, { this_period: null, last_period: null, year_to_date: null });
  assert.deepEqual(s.totals.net, { this_period: null, last_period: null, year_to_date: null });
  const now = r.series.at(-1);
  assert.deepEqual([now.revenue_cents, now.costs_cents, now.net_cents], [5010, null, null]);
  assert.equal(r.series[0].revenue_cents, 0);

  // Hosted by Mynt: hosting isn't recorded per period, so it's unmeasured.
  const tenant = randomUUID();
  await w.pg.query("INSERT INTO financial_products.hosting_tenants (id, workspace_id, provider, status) VALUES ($1, $2, 'test', 'running')", [tenant, w.ws.id]);
  const hosted = (await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id })).data;
  assert.equal(line(hosted.statement.costs, "hosting").measured, false);
  assert.equal(line(hosted.statement.costs, "hosting").values.this_period, null);
  assert.match(hosted.unmeasured.find((u) => u.key === "hosting").reason, /hosting costs per workspace/);
});

test("app_id narrows every line to that app", async () => {
  const w = await setup();
  await w.moved(w.saver.id, { cents: 300 });
  await w.moved(w.starter.id, { cents: 40 });
  await w.build(w.saver.id, 1);
  await w.build(w.starter.id, 2);
  const r = (await w.mem.call("get_workspace_pnl", { workspace_id: w.ws.id, app_id: w.starter.id })).data;
  assert.deepEqual(r.statement.revenue.map((l) => l.app_id), [w.starter.id]);
  assert.equal(r.statement.totals.revenue.this_period, 40);
  assert.equal(line(r.statement.costs, "build_agents").values.this_period, 200);
});

test("no builds service: build spend isn't measured, so it's null with a reason", async () => {
  const w = await setup({ builds: false });
  const r = (await w.ana.call("get_workspace_pnl", { workspace_id: w.ws.id })).data;
  const b = line(r.statement.costs, "build_agents");
  assert.deepEqual([b.measured, b.values.this_period], [false, null]);
  assert.ok(r.unmeasured.some((u) => u.key === "build_agents"));
});

test("periods are UTC calendar months or Monday weeks; last period and year to date bucket by day", async () => {
  assert.equal(new Date(periodStart(Date.parse("2026-11-14T23:30:00Z"), "month")).toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(new Date(periodStart(Date.parse("2026-11-15T23:30:00Z"), "week")).toISOString(), "2026-11-09T00:00:00.000Z", "a Sunday belongs to the week before");
  assert.equal(new Date(shiftPeriod(Date.parse("2026-01-01T00:00:00Z"), "month", -1)).toISOString(), "2025-12-01T00:00:00.000Z");

  const w = await setup();
  const now = Date.parse("2026-03-18T12:00:00Z");
  await w.moved(w.saver.id, { cents: 100, at: "2026-03-02T10:00:00Z" }); // this month
  await w.moved(w.saver.id, { cents: 20, at: "2026-02-28T23:59:59Z" }); // last month
  await w.moved(w.saver.id, { cents: 3, at: "2026-01-01T00:00:00Z" }); // this year
  await w.moved(w.saver.id, { cents: 7000, at: "2025-12-31T23:59:59Z" }); // last year: outside year to date
  await w.build(w.saver.id, 0.5, "2026-02-10T00:00:00Z");
  const app = await w.store.getApp(w.saver.id);
  const m = await workspacePnl(w.store, w.ws.id, [app], { granularity: "month", periods: 4, now });
  const rev = m.statement.totals.revenue;
  assert.deepEqual(rev, { this_period: 100, last_period: 20, year_to_date: 123 });
  assert.deepEqual(m.series.map((p) => [p.start.slice(0, 10), p.revenue_cents]), [
    ["2025-12-01", 7000],
    ["2026-01-01", 3],
    ["2026-02-01", 20],
    ["2026-03-01", 100],
  ]);
  assert.deepEqual(line(m.statement.costs, "build_agents").values, { this_period: 0, last_period: 50, year_to_date: 50 });
  const wk = await workspacePnl(w.store, w.ws.id, [app], { granularity: "week", periods: 3, now });
  assert.deepEqual(wk.statement.columns.map((c) => c.start.slice(0, 10)), ["2026-03-16", "2026-03-09", "2026-01-01"]);
  assert.equal(wk.series.at(-1).revenue_cents, 0);
});
