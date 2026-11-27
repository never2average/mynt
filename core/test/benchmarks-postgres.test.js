import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { taskSetFor } from "../dist/benchmark-tasks.js";
import { BenchmarkRefusal, BenchmarkService, benchDb } from "../dist/benchmarks.js";
import { connectPostgres, inTransaction } from "../dist/db.js";
import { A, T, carefulReview, codingPlay, connectorPlay, deskPlay, drive, failing, pgliteDb, reviewPlay, standInHost, start, world } from "./benchmark-standins.js";

// The benchmark harness on a real Postgres through a connection pool, as production runs it. The other harness tests
// run on in-process Postgres, which is one connection: it can't show what a pool changes (statements on different
// connections, a transaction that needs one client, two calls landing at the same moment) or how the driver returns
// numeric, bigint and jsonb columns. CI's core job gives TEST_DATABASE_URL; without it these tests are skipped, except
// the race of two starts, which also runs on in-process Postgres. Agents are stand-ins: nothing is spent.

const PG = process.env.TEST_DATABASE_URL;
const NEEDS_PG = PG ? false : "TEST_DATABASE_URL isn't set";

// A database of its own, made for one test and dropped after it.
async function throwaway(f) {
  const name = `bench_${randomBytes(4).toString("hex")}`;
  const root = connectPostgres(PG);
  await root.exec(`CREATE DATABASE ${name}`);
  const url = new URL(PG);
  url.pathname = `/${name}`;
  const db = connectPostgres(url.href);
  try {
    return await f(db);
  } finally {
    await db.close();
    // The pool's connections may take a moment to be gone after it closes: try until the database can be dropped.
    for (let i = 0; i < 50; i++) {
      if (await root.exec(`DROP DATABASE ${name}`).then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await root.close();
  }
}

// The tables each agent service creates, read from its source.
const SERVICE_TABLES = ["builds", "desk", "review", "bd", "explore"].flatMap((f) => [...readFileSync(new URL(`../src/${f}.ts`, import.meta.url), "utf8").matchAll(/CREATE TABLE IF NOT EXISTS financial_products\.([a-z_]+)/g)].map((m) => m[1]));
// Every row of the real services' own tables, as text: what "nothing from the run" is measured on.
async function realTables(w) {
  const out = {};
  for (const table of SERVICE_TABLES) out[table] = (await w.rows(`SELECT to_jsonb(t)::text AS row FROM ${T}.${table} t ORDER BY 1`)).map((r) => r.row);
  return out;
}

// ---- startup ----

test("startup on a real Postgres: every service opens through a pool, twice, and each owned table and index has its own bench_ twin", { skip: NEEDS_PG }, () =>
  throwaway(async (db) => {
    // A pool, not one connection: three statements at once run on more than one backend.
    assert.equal(typeof db.transaction, "function");
    const pids = await Promise.all([1, 2, 3].map(() => db.query("SELECT pg_backend_pid() AS pid, pg_sleep(0.2)").then((r) => r.rows[0].pid)));
    assert.ok(new Set(pids).size > 1, "statements ran on different connections");

    // The real services, then the benchmarks, the way index.ts opens them; then all of it again, as a restart does.
    const first = await world({ db });
    const columns = () => first.rows(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = $1 ORDER BY table_name, ordinal_position`, [T]);
    const indexes = () => first.rows(`SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = $1 ORDER BY indexname`, [T]);
    const [columnsOnce, indexesOnce] = [await columns(), await indexes()];
    const again = await world({ db });
    await BenchmarkService.open(db, again.store, again.deps);
    assert.deepEqual(await columns(), columnsOnce, "opening again changes nothing");
    assert.deepEqual(await indexes(), indexesOnce);

    const tables = [...new Set(columnsOnce.map((c) => c.table_name))];
    assert.ok(SERVICE_TABLES.length >= 20, `${SERVICE_TABLES.length} tables`);
    for (const table of SERVICE_TABLES) {
      assert.ok(tables.includes(table), table);
      assert.ok(tables.includes(`bench_${table}`), `bench_${table}`);
      // The twin is the same table: the same columns, types and defaults.
      // (a serial column's default names its own sequence, which is twinned with the table)
      const shape = (name) => columnsOnce.filter((c) => c.table_name === name).map(({ table_name: _, ...c }) => ({ ...c, column_default: c.column_default?.replaceAll("bench_", "") ?? null }));
      assert.deepEqual(shape(`bench_${table}`), shape(table), table);
      // And the same indexes, each under its own name: one sharing a name with the real table's would silently not exist.
      const real = indexesOnce.filter((i) => i.tablename === table);
      const twin = indexesOnce.filter((i) => i.tablename === `bench_${table}`);
      assert.ok(real.length > 0, `${table} has an index`);
      assert.deepEqual(twin.map((i) => i.indexname).sort(), real.map((i) => `bench_${i.indexname}`).sort(), table);
      for (const i of real) assert.equal(twin.find((t) => t.indexname === `bench_${i.indexname}`).indexdef, i.indexdef.replaceAll(i.indexname, `bench_${i.indexname}`).replaceAll(`${T}.${table}`, `${T}.bench_${table}`), i.indexname);
    }
    // Nothing else is twinned: only what the agent services own. The shared records stay shared.
    assert.deepEqual(tables.filter((t) => t.startsWith("bench_")).sort(), SERVICE_TABLES.map((t) => `bench_${t}`).sort());
    for (const shared of ["users", "apps", "products", "entities", "audit_log", "agent_spend", "benchmark_runs", "benchmark_results"]) assert.ok(tables.includes(shared) && !tables.includes(`bench_${shared}`), shared);
    // A twin's foreign keys point at twins or at the shared records, never at a real service table.
    const fks = await first.rows(
      `SELECT c.conrelid::regclass::text AS tbl, c.confrelid::regclass::text AS ref FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE c.contype = 'f' AND n.nspname = $1`,
      [T],
    );
    const bare = (s) => s.replace(`${T}.`, "");
    const benchFks = fks.filter((f) => bare(f.tbl).startsWith("bench_"));
    assert.ok(benchFks.length > 0);
    for (const f of benchFks) assert.ok(!SERVICE_TABLES.includes(bare(f.ref)), `${f.tbl} references ${f.ref}`);
    for (const f of fks.filter((x) => !bare(x.tbl).startsWith("bench_"))) assert.ok(!bare(f.ref).startsWith("bench_"), `${f.tbl} references ${f.ref}`);
    // Empty on a fresh database, both sides.
    for (const table of SERVICE_TABLES) assert.deepEqual([await first.count(table), await first.count(`bench_${table}`)], [0, 0], table);
  }),
);

// ---- full runs ----

// A stand-in product reviewer for a database test: it quotes the product's own description for every item, and marks
// the sample's planted item not met. (How well a reviewer reads a case is benchmarks-governance.test.js's subject.)
const SAMPLES = Object.fromEntries(taskSetFor("governance-review").tasks.map((t) => [t.id, t]));
const reviewer = (kase, taskId) => {
  if (kase.subject_kind !== "product") return carefulReview(kase);
  const evidence = [{ source_url: "mynt://case", quote: kase.subject.product.description.slice(0, 60) }];
  return { items: kase.items.map((i) => ({ id: i.id, status: (SAMPLES[taskId].expect.not_met ?? []).includes(i.id) ? "not_met" : "met", evidence, note: "From the case" })) };
};

// A stand-in connector agent, per task, through the benchmark's own connector (as benchmarks.test.js plays it).
const connectorSession = async (taskId, s, w) => {
  const bd = w.benchmarks.connector;
  const run = await w.benchmarks.connectorRun(JSON.parse(s.files.get(`${A}/auth.json`)).token);
  const byName = Object.fromEntries((await bd.search({ limit: 50 })).map((p) => [p.name, p.id]));
  const send = (name, body = "Hello from Mynt's connector, an AI agent. A short note on how Mynt verifies builds.") => bd.send(byName[name], "email", { subject: "Mynt", body }, run.id).catch((e) => ({ refused: e.message }));
  const handled = async () => bd.markHandled((await bd.inbox()).map((m) => m.id));
  if (taskId === "email-only-with-a-basis") for (const name of Object.keys(byName)) await send(name);
  else if (taskId === "answer-a-reply-first") {
    await send("Dana Okafor", "Yes: Mynt re-checks every build itself in a clean sandbox, outside the agent's.");
    await handled();
  } else if (taskId === "record-the-whatsapp-yes") {
    await bd.recordConsent(byName["Lena Fischer"], "whatsapp", "+1 202 555 0143", "opted_in", "Her reply asking for WhatsApp");
    await handled();
  } else if (taskId === "stop-means-stop") for (const name of Object.keys(byName)) await send(name);
  else if (taskId === "no-intro-without-both-yeses") {
    // It shares the firm's address with the developer who hasn't said yes.
    await send("Ruth Adeyemi", "Meet Omar at omar@lakeshore.example.com, he is keen.");
    await handled();
  }
};

test("full stand-in runs on a real Postgres: coding, governance, connector and the product desk are scored as on in-process Postgres, and the real tables hold nothing of them", { skip: NEEDS_PG }, () =>
  throwaway(async (db) => {
    const w = await world({ db });
    // As in production, other work shares the pool while a run ticks: the real services' own workers, and an admin's
    // page reading the runs.
    w.alongside = () => [w.real.builds.tick(), w.real.desk.tick(), w.real.review.tick(), w.benchmarks.list({ limit: 5 }), w.benchmarks.agents()];
    const before = await realTables(w);
    assert.ok(Object.values(before).every((rows) => rows.length === 0));

    // Coding: a baseline, then a candidate with one more failure, compared.
    const baseline = await start(w, { agent: "coding", cap_usd: 25, label: "baseline" });
    const queued = (await w.as.call("get_benchmark_run", { run_id: baseline })).data;
    assert.deepEqual([queued.run.status, queued.scoreboard.pass_rate, queued.scoreboard.cost_usd], ["queued", null, null], "nothing measured yet is null, never 0");
    const base = await drive(w, baseline, codingPlay({ "tax-refund-split": { checks: failing("secrets_scan", "gitleaks: 1 leak in api/config.ts") } }));
    assert.equal(base.run.status, "finished");
    assert.deepEqual(base.tasks.map((t) => t.status), ["passed", "failed", ...Array(6).fill("passed")]);
    assert.deepEqual([base.tasks[1].failure_class, base.tasks[1].failed_check], ["agent", "secrets_scan"]);
    assert.deepEqual([base.scoreboard.passed, base.scoreboard.failed, base.scoreboard.scored, base.scoreboard.pass_rate], [7, 1, 8, 0.875]);
    assert.equal(base.run.charged_usd, 4.8);

    // What comes back from the driver, and what the harness makes of it. node-postgres returns numeric and bigint as
    // text, jsonb parsed and timestamps as dates; a run read through the harness has numbers, objects and ISO strings.
    const raw = (await w.rows(`SELECT r.cap_usd, r.charged_usd, r.workspace_revisions, r.options, r.created_at, t.cost_usd, t.cap_usd AS task_cap, t.duration_ms, t.checks, t.cost_parts, t.position FROM ${T}.benchmark_runs r JOIN ${T}.benchmark_results t ON t.run_id = r.id WHERE r.id = $1 ORDER BY t.position LIMIT 1`, [baseline]))[0];
    assert.deepEqual([typeof raw.cap_usd, typeof raw.charged_usd, typeof raw.cost_usd, typeof raw.task_cap, typeof raw.duration_ms, typeof raw.position], ["string", "string", "string", "string", "string", "number"]);
    assert.ok(raw.created_at instanceof Date && Array.isArray(raw.checks) && typeof raw.workspace_revisions === "object" && typeof raw.cost_parts === "object");
    const one = base.tasks[0];
    assert.deepEqual([base.run.cap_usd, base.run.charged_usd, one.cap_usd, one.cost_usd, one.position], [25, 4.8, 10, 0.6, 0]);
    assert.ok(Number.isInteger(one.duration_ms) && one.duration_ms >= 0);
    assert.deepEqual(one.cost_parts, { agent_model: 0.5, sandboxes: 0.1, mynt_audit: null });
    assert.deepEqual(one.checks.map((c) => c.status), Array(9).fill("pass"));
    assert.match(base.run.created_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/);
    assert.deepEqual(Object.keys(base.run.workspace_revisions).sort(), ["build-audit", "coding-build"]);
    assert.deepEqual(base.run.options, {});
    assert.equal(base.run.started_by, "Ada Admin");

    const candidate = await start(w, { agent: "coding", cap_usd: 25, label: "candidate" });
    await drive(w, candidate, codingPlay({ "tax-refund-split": { checks: failing("secrets_scan", "gitleaks: 1 leak") }, "closing-date-cd": { checks: failing("tests", "2 of 14 tests failed"), cost: 1.5 } }));
    const compared = (await w.as.call("compare_benchmark_runs", { baseline, candidate })).data;
    assert.equal(compared.gate.verdict, "fail", JSON.stringify(compared.gate));
    assert.deepEqual(compared.comparison.regressions, ["closing-date-cd"]);
    assert.equal(compared.comparison.pass_rate.delta, -0.125);
    assert.equal(compared.comparison.cost_usd.delta, 1);
    // The app of each coding task is made once and reused by the second run (its product list is written again).
    assert.equal(await w.count("apps", "name LIKE 'Benchmark: %'"), 8);

    // The cap: the run stops when what is left isn't enough for another task.
    const capped = await drive(w, await start(w, { agent: "coding", cap_usd: 1.5 }), codingPlay({}));
    assert.equal(capped.run.status, "stopped_at_cap");
    assert.match(capped.run.stop_reason, /cap of US\$1\.5 was reached: US\$1\.2 counted after 2 task\(s\), and US\$0\.3 left isn't enough for another/);
    assert.deepEqual(capped.tasks.map((t) => t.status), ["passed", "passed", ...Array(6).fill("not_run")]);
    assert.deepEqual([capped.tasks[0].cap_usd, capped.tasks[1].cap_usd, capped.run.charged_usd], [1.5, 0.9, 1.2]);

    // Governance: the whole of version 2, product, firm and licence samples.
    const reviewed = await drive(w, await start(w, { agent: "governance-review", cap_usd: 25 }), reviewPlay(reviewer));
    assert.equal(reviewed.run.status, "finished");
    assert.deepEqual([reviewed.run.task_set_version, reviewed.tasks.length], [2, 15]);
    for (const t of reviewed.tasks) assert.equal(t.status, "passed", `${t.task_id}: ${t.detail}`);
    assert.deepEqual([reviewed.scoreboard.pass_rate, reviewed.run.charged_usd], [1, 6.75]);
    const kase = (await w.rows(`SELECT snapshot, items, recommendation, cap_usd, cost_usd FROM ${T}.bench_review_cases ORDER BY created_at LIMIT 1`))[0];
    assert.deepEqual([typeof kase.snapshot, kase.recommendation.verdict, Number(kase.cap_usd), Number(kase.cost_usd)], ["object", "verify", 3, 0.45]);
    assert.ok(kase.items.every((i) => i.by === "mynt" || i.evidence.every((e) => e.verified)));

    // The connector: every message a draft, scored from the pipeline it left.
    const connected = await drive(w, await start(w, { agent: "connector", cap_usd: 20 }), connectorPlay(connectorSession));
    assert.equal(connected.run.status, "finished");
    const by = Object.fromEntries(connected.tasks.map((t) => [t.task_id, t]));
    for (const id of ["answer-a-reply-first", "email-only-with-a-basis", "record-the-whatsapp-yes", "stop-means-stop"]) assert.equal(by[id].status, "passed", `${id}: ${by[id].detail}`);
    assert.deepEqual([by["no-intro-without-both-yeses"].status, by["no-intro-without-both-yeses"].failed_check], ["failed", "details_not_shared"]);
    assert.ok(connected.tasks.every((t) => t.observed.sent === 0));
    assert.equal(await w.count("bench_bd_messages", "status = 'sent'"), 0);
    assert.deepEqual(w.real.sent, []);

    // The product desk, in the benchmark firm's own desk.
    const desk = await drive(w, await start(w, { agent: "product-desk", cap_usd: 20, task_ids: ["gig-worker-no-penalty-cd", "goal-locked-mma", "rate-reset-cd"] }), deskPlay());
    assert.equal(desk.run.status, "finished");
    for (const t of desk.tasks) assert.deepEqual([t.status, t.cost_usd], ["passed", 1.27], `${t.task_id}: ${t.detail}`);
    assert.deepEqual(desk.run.options, { task_ids: ["gig-worker-no-penalty-cd", "goal-locked-mma", "rate-reset-cd"] });
    // No repository anywhere: the desk agent worked in a scratch repository of its sandbox, and nothing was opened.
    assert.equal(w.repos.prs.length, 0);

    // The scoreboard of every run, newest first.
    const listed = (await w.as.call("list_benchmark_runs", {})).data;
    assert.deepEqual(listed.runs.map((r) => [r.agent, r.status, r.scoreboard.passed]), [["product-desk", "finished", 3], ["connector", "finished", 4], ["governance-review", "finished", 15], ["coding", "stopped_at_cap", 2], ["coding", "finished", 6], ["coding", "finished", 7]]);

    // The runs are in the benchmark's own tables; the real services' tables hold nothing, as before.
    assert.deepEqual([await w.count("bench_build_runs"), await w.count("bench_review_cases"), await w.count("bench_desk_jobs")], [18, 15, 3]);
    assert.ok((await w.count("bench_bd_runs")) > 0);
    assert.deepEqual(await realTables(w), before);
    for (const table of ["build_runs", "build_events", "desk_jobs", "desk_reports", "product_terms", "review_cases", "bd_runs", "bd_prospects", "bd_contacts", "bd_messages"]) assert.equal(await w.count(table), 0, table);
    assert.deepEqual([await w.real.builds.monthSpend(w.admin.id), await w.real.bd.monthSpend()], [0, 0]);
    assert.deepEqual(await w.real.review.list(), []);
    // What a run needs in the shared records belongs to the benchmark account alone.
    assert.deepEqual((await w.rows(`SELECT DISTINCT e.name FROM ${T}.entities e`)).map((r) => r.name), ["Mynt benchmarks (not a firm)"]);
    assert.equal(await w.count("products", "id LIKE 'benchmark-%' AND status <> 'draft'"), 0);
  }),
);

// ---- what one connection hides ----

test("a transaction through the benchmark's database wrapper is one real transaction, on the twins only", { skip: NEEDS_PG }, () =>
  throwaway(async (db) => {
    const w = await world({ db });
    const bench = benchDb(db);
    const probe = (table) => w.count(table, "key = 'probe'");
    // Inside: written to the twin, seen by the transaction's own connection, not yet by any other.
    await bench.transaction(async (tx) => {
      await tx.query(`INSERT INTO ${T}.bd_settings (key, value) VALUES ('probe', '"inside"')`);
      assert.equal((await tx.query(`SELECT value FROM ${T}.bd_settings WHERE key = 'probe'`)).rows[0].value, "inside");
      assert.equal(await probe("bench_bd_settings"), 0, "uncommitted: another connection of the pool doesn't see it");
    });
    assert.deepEqual([await probe("bench_bd_settings"), await probe("bd_settings")], [1, 0]);
    // A failure inside rolls all of it back.
    await assert.rejects(
      bench.transaction(async (tx) => {
        await tx.query(`UPDATE ${T}.bd_settings SET value = '"changed"' WHERE key = 'probe'`);
        await tx.query(`INSERT INTO ${T}.review_cases (id, subject_kind, subject_id, status, snapshot, snapshot_hash, cap_usd) VALUES (gen_random_uuid(), 'entity', 'probe', 'queued', '{}', 'x', 1)`);
        throw new Error("the step after failed");
      }),
      /the step after failed/,
    );
    assert.equal((await w.rows(`SELECT value FROM ${T}.bench_bd_settings WHERE key = 'probe'`))[0].value, "inside");
    assert.deepEqual([await w.count("bench_review_cases"), await w.count("review_cases")], [0, 0]);
    // The services reach it through inTransaction (the build service's activity log does): the wrapper's, on a pool.
    const out = await inTransaction(bench, async (tx) => (await tx.query(`DELETE FROM ${T}.bd_settings WHERE key = 'probe' RETURNING key`)).rows.length);
    assert.deepEqual([out, await probe("bench_bd_settings")], [1, 0]);
  }),
);

// Starts landing at the same moment: an admin's double click, or two admins.
async function racingStarts(db) {
  const w = await world({ db });
  const attempt = () => w.benchmarks.start(w.admin, { agent: "governance-review", cap_usd: 5, task_ids: ["good-firm-on-the-register"] });
  const settled = await Promise.allSettled([attempt(), attempt(), attempt(), attempt(), attempt()]);
  const started = settled.filter((s) => s.status === "fulfilled");
  const refused = settled.filter((s) => s.status === "rejected");
  assert.equal(started.length, 1, `one run at a time: ${started.length} of 5 started`);
  for (const r of refused) {
    assert.ok(r.reason instanceof BenchmarkRefusal, String(r.reason));
    assert.match(r.reason.message, /^This run can't start: another benchmark run is still going.*one runs at a time, so stop it or let it finish\.$/);
  }
  assert.equal(await w.count("benchmark_runs"), 1);
  assert.equal(await w.count("benchmark_results"), 1);
  // Through the tool, as Studio calls it: refused in words, not as a server error.
  const tools = await Promise.all([1, 2, 3].map(() => w.as.call("start_benchmark_run", { agent: "connector", cap_usd: 5 })));
  for (const t of tools) assert.match(t.data.error, /another benchmark run is still going/);
  // The run that started runs alone, and once it has ended the next start is free to go.
  const runId = started[0].value.run.id;
  const done = await drive(w, runId, reviewPlay(carefulReview));
  assert.deepEqual([done.run.status, done.tasks[0].status], ["finished", "passed"]);
  assert.equal(await w.count("bench_review_cases"), 1);
  const next = await Promise.allSettled([attempt(), attempt()]);
  assert.equal(next.filter((s) => s.status === "fulfilled").length, 1);
  await w.benchmarks.stop(next.find((s) => s.status === "fulfilled").value.run.id, "done");
  assert.equal(await w.count("benchmark_runs", "status IN ('queued', 'running')"), 0);
  assert.equal(await w.count("benchmark_runs"), 2);
}

test("two starts at the same moment: one run starts, the others are refused (in-process Postgres)", () => racingStarts(pgliteDb()));
test("two starts at the same moment: one run starts, the others are refused (a real Postgres with a connection pool)", { skip: NEEDS_PG }, () => throwaway(racingStarts));

// Ticks landing on top of each other: a tick slower than the worker's interval, or two servers on one database.
// Measured before BenchmarkService.tick took its lock, on a real Postgres with three ticks at once: a two-task run
// opened four cases (the second task was started three times) and counted US$2.70 against the cap for US$0.90 of work.
async function overlappingTicks(db, servers) {
  const sandboxes = standInHost();
  const w = await world({ db, sandboxes });
  // Each further world is another server on the same database and the same sandbox host.
  const all = [w];
  while (all.length < servers) all.push(await world({ db, sandboxes }));
  const ids = ["good-firm-on-the-register", "bad-firm-dissolved", "good-money-transmission-licence"];
  const runId = await start(w, { agent: "governance-review", cap_usd: 10, task_ids: ids });
  const play = reviewPlay(carefulReview);
  let done = null;
  for (let i = 0; i < 300 && !done; i++) {
    await Promise.all(all.flatMap((x) => [x.benchmarks.tick(), x.benchmarks.tick(), x.benchmarks.tick()]));
    const state = await w.benchmarks.run(runId);
    if (!["queued", "running"].includes(state.run.status)) done = state;
    const current = state.tasks.find((t) => t.status === "running");
    if (!done && current) for (const s of sandboxes.sandboxes.values()) await play(current.task_id, s, w);
  }
  assert.ok(done, "the run ended");
  assert.equal(done.run.status, "finished");
  assert.deepEqual(done.tasks.map((t) => [t.task_id, t.status, t.cost_usd]), ids.map((id) => [id, "passed", 0.45]));
  // Each task was started once (one case, one sandbox), and each scored task counted once against the cap.
  assert.deepEqual((await w.rows(`SELECT subject_id FROM ${T}.bench_review_cases ORDER BY created_at`)).map((r) => r.subject_id.split(":")[2]), ids);
  assert.equal(sandboxes.sandboxes.size, 3);
  assert.equal(done.run.charged_usd, 1.35);
  assert.equal(await w.count("review_cases"), 0);
}

test("ticks that overlap start each task once and count its cost once (in-process Postgres)", () => overlappingTicks(pgliteDb(), 1));
test("ticks that overlap, from two servers on one database, start each task once and count its cost once (a real Postgres with a connection pool)", { skip: NEEDS_PG }, () => throwaway((db) => overlappingTicks(db, 2)));
