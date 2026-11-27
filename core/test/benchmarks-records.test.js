import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { bdConfigFromEnv } from "../dist/bd.js";
import { BENCHMARK_MARKED, notBenchmark } from "../dist/benchmark-marker.js";
import { taskSetFor } from "../dist/benchmark-tasks.js";
import { BenchmarkService } from "../dist/benchmarks.js";
import { buildConfigFromEnv } from "../dist/builds.js";
import { deskConfigFromEnv } from "../dist/desk.js";
import { reviewConfigFromEnv } from "../dist/review.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// The benchmarks' own rows in the shared records (an account, its workspace, an app per coding task, a stand-in firm
// with draft products) carry one mark, and every list, count, search and directory leaves marked rows out.

const T = "financial_products";

// A sandbox host that takes a job and never finishes it: enough for a run to make its records.
const idleHost = () => ({
  created: 0,
  async createSandbox() {
    return { id: `sbx_${++this.created}`, state: "ready" };
  },
  async getSandbox(id) {
    return { id, state: "provisioning" };
  },
  async writeFile() {},
  async readFile() {
    return null;
  },
  async costDollars() {
    return 0;
  },
  async stop() {},
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  async commandStatus() {
    return { running: true, exitCode: null };
  },
  async downloadUrl() {
    return "https://files.example/x";
  },
  async host() {
    return { url: "https://preview.example" };
  },
});

async function world() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const sandboxes = idleHost();
  const buildConfig = { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } };
  const benchmarks = await BenchmarkService.open(db, store, { sandboxes, repos: null, buildConfig, deskConfig: deskConfigFromEnv(buildConfig, {}), reviewConfig: reviewConfigFromEnv(buildConfig, {}), bdConfig: bdConfigFromEnv(buildConfig, {}) });
  const admin = (await store.createUser("Ada Admin", ["admin"])).user;
  const dev = (await store.createUser("Dev Real", ["developer"])).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { benchmarks }).connect(s);
    const cl = new Client({ name: "test", version: "0" });
    await cl.connect(c);
    return async (name, args = {}) => JSON.parse((await cl.callTool({ name, arguments: args })).content[0].text);
  };
  return { pg, db, store, benchmarks, admin, dev, asAdmin: await connect(admin), asDev: await connect(dev), asGuest: await connect(null) };
}

// Everything an admin's lists and counts, a developer's catalogue and the public directory show.
async function everythingListed(w) {
  return {
    workspaces: await w.asAdmin("list_all_workspaces", {}),
    workspaces_search: await w.asAdmin("list_all_workspaces", { query: "benchmark" }),
    apps: await w.asAdmin("list_all_apps", {}),
    apps_search: await w.asAdmin("list_all_apps", { query: "Benchmark" }),
    products: await w.asAdmin("list_all_products", {}),
    products_search: await w.asAdmin("list_all_products", { query: "benchmark" }),
    drafts: await w.asAdmin("list_all_products", { status: "draft" }),
    people: await w.asAdmin("list_whitelist"),
    firms: await w.asAdmin("list_entities"),
    catalogue: await w.asDev("list_products", {}),
    catalogue_search: await w.asDev("list_products", { query: "benchmark" }),
    published_apps: await w.asGuest("list_apps"),
    store: {
      users: (await w.store.listUsers()).map((u) => u.id),
      apps: (await w.store.allApps()).map((a) => a.id),
      firms: (await w.store.listEntities()).map((e) => e.id),
      products: (await w.store.allProducts()).map((p) => p.product.id),
      published: (await w.store.publishedProducts()).map((p) => p.id),
      staging: (await w.store.stagingProducts()).map((p) => p.product.id),
    },
  };
}

test("a benchmark run's account, workspace, apps, firm and draft products change no list, count or search an admin or anyone else sees", async () => {
  const w = await world();
  // Something real beside it, so the lists aren't empty.
  await w.store.createApp(w.dev.id, { name: "A real app", description: "", audience: "", product_ids: ["fd"] });
  const firm = await w.store.createEntity(w.dev.id, { name: "A Real Firm Inc.", registration_numbers: {}, regions: ["US"] });
  await w.store.insertDraft(w.dev.id, { ...CATALOG[0], id: "a-real-draft", name: "A real draft" }, { entity_id: firm.id });
  const before = await everythingListed(w);
  assert.equal(before.apps.total, 1);

  // A coding run: the benchmark's account, its workspace and one app per task appear in the shared records.
  const started = await w.benchmarks.start(w.admin, { agent: "coding", cap_usd: 25 });
  for (let i = 0; i < 4; i++) await w.benchmarks.tick();
  // The product desk's records, made the way its adapter makes them: a stand-in firm and a draft product per task.
  const account = await w.benchmarks.identity();
  const benchFirm = await w.benchmarks.firm(account);
  for (const task of taskSetFor("product-desk").tasks.slice(0, 2)) await w.store.insertDraft(account.id, { id: `benchmark-${task.id}`, ...task.product }, { entity_id: benchFirm });
  // One of them in staging, as a tested draft would be.
  await w.pg.query(`UPDATE ${T}.products SET stage = 'staging' WHERE owner_id = $1`, [account.id]);
  await w.benchmarks.stop(started.run.id, "the test has what it needs");

  // They exist, and are marked.
  const marked = Object.fromEntries(await Promise.all(BENCHMARK_MARKED.map(async (t) => [t, (await w.pg.query(`SELECT count(*)::int AS n FROM ${T}.${t} WHERE benchmark`)).rows[0].n])));
  assert.deepEqual(marked, { users: 1, workspaces: 1, apps: 1, entities: 1, products: 2 });

  // Nothing anyone lists has changed: the same rows and the same totals.
  assert.deepEqual(await everythingListed(w), before);

  // The Agent benchmarks page is the one place that lists them.
  const { records } = await w.asAdmin("list_benchmark_runs", {});
  assert.equal(records.account.name, "Mynt benchmarks");
  assert.equal(records.workspaces.length, 1);
  assert.deepEqual(records.apps.map((a) => a.name), [`Benchmark: ${taskSetFor("coding").tasks[0].id}`]);
  assert.deepEqual(records.firms.map((f) => f.name), ["Mynt benchmarks (not a firm)"]);
  assert.equal(records.products.length, 2);
  // Still reachable by id, which is how the benchmark's own services use them.
  assert.ok(await w.store.getApp(records.apps[0].id));
  assert.ok(await w.store.getProduct(records.products[0].id));
});

test("records an earlier version made unmarked are marked the next time the benchmark's account is used", async () => {
  const w = await world();
  const account = await w.benchmarks.identity();
  await w.benchmarks.firm(account);
  await w.store.createApp(account.id, { name: "Benchmark: old", description: "", audience: "", product_ids: [] });
  // As the first version left them: no mark anywhere.
  for (const t of BENCHMARK_MARKED) await w.pg.query(`UPDATE ${T}.${t} SET benchmark = false`);
  assert.equal((await w.store.listUsers()).some((u) => u.name === "Mynt benchmarks"), true);
  await w.benchmarks.identity();
  assert.equal((await w.store.listUsers()).some((u) => u.name === "Mynt benchmarks"), false);
  assert.deepEqual((await w.store.allApps()).map((a) => a.name), []);
  assert.deepEqual(await w.store.listEntities(), []);
  assert.equal((await w.asAdmin("list_all_workspaces", {})).total, 0);
});

test("the mark is inherited where a row is made, and no organization is ever made for a benchmark's workspace", async () => {
  const w = await world();
  const account = await w.benchmarks.identity();
  // Made by the store's ordinary methods: marked in the same statement, with nothing for the caller to remember.
  const app = await w.store.createApp(account.id, { name: "x", description: "", audience: "", product_ids: [] });
  assert.equal((await w.pg.query(`SELECT benchmark FROM ${T}.apps WHERE id = $1`, [app.id])).rows[0].benchmark, true);
  assert.equal((await w.pg.query(`SELECT benchmark FROM ${T}.workspaces WHERE id = $1`, [app.workspace_id])).rows[0].benchmark, true);
  // A real person's rows never are.
  const real = await w.store.createApp(w.dev.id, { name: "y", description: "", audience: "", product_ids: [] });
  assert.equal((await w.pg.query(`SELECT benchmark FROM ${T}.apps WHERE id = $1`, [real.id])).rows[0].benchmark, false);
  assert.equal((await w.pg.query(`SELECT benchmark FROM ${T}.workspaces WHERE id = $1`, [real.workspace_id])).rows[0].benchmark, false);
  // The identity provider's sync links every workspace without an organization: its scans leave marked ones out.
  const sync = readFileSync(new URL("../dist/workspace-sync.js", import.meta.url), "utf8");
  const scans = sync.split("\n").filter((l) => /FROM \$\{T\}\.workspaces\b/.test(l) && /org_sync = 'creating'|org_sync = 'backfill'/.test(l + sync.split("\n")[sync.split("\n").indexOf(l) + 1]));
  assert.ok(scans.length >= 2 && scans.every((l) => l.includes("notBenchmark(")), "both scans for workspaces to link or clear leave the benchmarks' out");
  assert.equal(notBenchmark("w"), "NOT w.benchmark");
});

test("nothing in the server picks the benchmarks' records out by name", () => {
  const dir = new URL("../dist/", import.meta.url);
  // benchmarks.js names its own records where it makes them; scratch-repo.js signs the scratch repository's first commit.
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".js") && !["benchmarks.js", "scratch-repo.js"].includes(f))) {
    const text = readFileSync(new URL(f, dir), "utf8");
    assert.ok(!/Mynt benchmarks|Benchmark: /.test(text), `${f} names the benchmarks' records`);
  }
});
