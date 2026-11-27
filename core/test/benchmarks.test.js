import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BdService, bdConfigFromEnv } from "../dist/bd.js";
import { compareRuns, regressionGate, scoreboard } from "../dist/benchmark-compare.js";
import { BENCHMARK_AGENTS, BENCHMARKS_DIR, taskSetErrors, taskSetFor, taskSets, workspaceRevision } from "../dist/benchmark-tasks.js";
import { BenchmarkService, benchSql, failureClassOf } from "../dist/benchmarks.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { DeskService, deskConfigFromEnv } from "../dist/desk.js";
import { PLATFORM_SETTINGS } from "../dist/platform-settings.js";
import { ReviewService, reviewConfigFromEnv } from "../dist/review.js";
import { auditClass } from "../dist/audit-classes.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// The agents here are stand-ins: a sandbox host whose "agent" is this file writing the files a real agent would
// (the runner's state.json, a build's result, a review's answers) and calling the connector's own methods. Everything
// around them is the production code: the services, their queues and ticks, the budgets, and Mynt's verification.

const T = "financial_products";
const SHA = "a".repeat(64);
const TREE = "b".repeat(64);
const A = "/home/user/mynt-agent";
const V = "/home/user/mynt-verify";
const BUILD = "/home/user/workspaces/coding-build";
const REVIEW = "/home/user/workspaces/governance-review";
const DESK_JOB = "/home/user/mynt-desk/job";

function standInHost() {
  const sandboxes = new Map();
  let n = 0;
  const host = {
    sandboxes,
    createError: null, // what the next createSandbox throws, if anything
    created: 0,
    async createSandbox(opts) {
      if (host.createError) throw new Error(host.createError);
      const id = `sbx_${++n}`;
      host.created++;
      sandboxes.set(id, { id, state: host.nextState ?? "ready", error: null, opts, files: new Map(), commands: [], stopped: false, cost: 0, procRunning: false, agentRunning: false, played: false });
      return { id, state: "ready" };
    },
    async getSandbox(id) {
      return sandboxes.get(id);
    },
    async writeFile(id, path, content) {
      sandboxes.get(id).files.set(path, content);
    },
    async readFile(id, path) {
      return sandboxes.get(id).files.get(path) ?? null;
    },
    async host(id, port) {
      return { url: `https://${id}-${port}.preview.example?_token=t` };
    },
    async costDollars(id) {
      return sandboxes.get(id).cost;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    async exec(id, command, opts = {}) {
      const s = sandboxes.get(id);
      s.commands.push({ command, ...opts });
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${SHA}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      if (command.includes("verify.sh --audit-copy")) return { exitCode: 0, stdout: `audit-copy ${TREE}\n`, stderr: "" };
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/changed.txt`, "");
        return { exitCode: 0, stdout: `rehash ${TREE}\n`, stderr: "" };
      }
      if (command.includes("[r]unner.mjs")) {
        s.agentRunning = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("scripts/dev_preview.sh")) return { exitCode: 0, stdout: "no-web\n", stderr: "" };
      if (command.includes("runner.mjs")) {
        s.agentRunning = true;
        return { processId: 99, exitCode: null, stdout: "", stderr: "" };
      }
      if (opts.detached) {
        s.procRunning = true;
        return { processId: 7, exitCode: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async commandStatus(id, processId) {
      const s = sandboxes.get(id);
      const running = processId === 99 ? s.agentRunning : s.procRunning;
      return { running, exitCode: running ? null : 0 };
    },
    async downloadUrl(id, path) {
      return `https://files.example/${id}${path}?sig=x`;
    },
    // What the runner records when Claude Code exits.
    finishAgent(id, subtype = "success", cost = 0, error = null) {
      const s = sandboxes.get(id);
      s.agentRunning = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ session_id: "s1", cost_usd: cost, turns: 1, sent: 1, last_subtype: subtype, done: true, exit_code: subtype === "success" ? 0 : 1, error, summary: "Stand-in agent's summary" }));
    },
    write(id, path, value) {
      sandboxes.get(id).files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    },
  };
  return host;
}

const fakeRepos = () => ({
  prs: [],
  async installationFor(repo) {
    return repo === "mynt-bench/desk" ? 7 : null;
  },
  async tokenFor() {
    return { token: "ghs_short_lived", expires_at: new Date(Date.now() + 3600e3).toISOString() };
  },
  installUrl: () => "https://github.com/apps/mynt/installations/new",
  async openPullRequest(repo, installation, pr) {
    this.prs.push({ repo, installation, ...pr });
    return `https://github.com/${repo}/pull/3`;
  },
});

const PASSING = ["source", "tests", "lint_typecheck", "secrets_scan", "secrets_history", "static_scan", "dependency_audit", "sbom", "disclosures"].map((name) => ({ name, status: "pass" }));
const failing = (name, detail) => PASSING.map((c) => (c.name === name ? { name, status: "fail", detail } : c));
const CLEAN_AUDIT = { complete: true, workflows_run: ["execute-scr", "probe-cicd-env"], skipped: [], counts: { critical: 0, high: 0, medium: 1, low: 2 }, findings: [], summary: "No blocking findings" };

async function world({ sandboxes = standInHost(), env = {}, senders = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const repos = fakeRepos();
  const buildConfig = { ...buildConfigFromEnv(env), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } };
  const deskConfig = deskConfigFromEnv(buildConfig, env);
  const reviewConfig = reviewConfigFromEnv(buildConfig, env);
  const bdConfig = bdConfigFromEnv(buildConfig, { ...env, BD_ENABLED: "1" });
  // The real services, on the same database: what a benchmark must never touch.
  const real = {
    builds: await BuildService.open(db, store, sandboxes, repos, buildConfig),
    desk: await DeskService.open(db, store, sandboxes, repos, deskConfig),
    review: await ReviewService.open(db, store, sandboxes, reviewConfig),
    sent: [],
  };
  const recorder = { send: async (m) => (real.sent.push(m), { id: `msg_${real.sent.length}` }) };
  real.bd = await BdService.open(db, sandboxes, bdConfig, { email: recorder, whatsapp: recorder, phone: recorder, ...senders });
  const benchmarks = await BenchmarkService.open(db, store, { sandboxes, repos, buildConfig, deskConfig, reviewConfig, bdConfig, fetcher: async () => ({ ok: false, status: 404, contentType: "text/plain", text: "" }) });
  const admin = (await store.createUser("Ada Admin", ["admin"])).user;
  const client = async (user, ctx = { benchmarks }) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, ctx).connect(s);
    const cl = new Client({ name: "test", version: "0" });
    await cl.connect(c);
    return {
      tools: async () => (await cl.listTools()).tools.map((t) => t.name),
      call: async (name, args = {}) => {
        const res = await cl.callTool({ name, arguments: args });
        let data;
        try {
          data = JSON.parse(res.content[0].text);
        } catch {
          data = { error: res.content[0].text };
        }
        return { isError: res.isError ?? false, data };
      },
    };
  };
  const count = async (table, where = "TRUE") => (await pg.query(`SELECT count(*)::int AS n FROM ${T}.${table} WHERE ${where}`)).rows[0].n;
  return { pg, db, store, sandboxes, repos, benchmarks, real, admin, client, count, as: await client(admin) };
}

// Runs the benchmark worker until the run ends, with `play` standing in for the agent between ticks: it's told the
// task in flight and each sandbox of it that hasn't been played yet.
async function drive(w, runId, play, { ticks = 400 } = {}) {
  for (let i = 0; i < ticks; i++) {
    await w.benchmarks.tick();
    const { run, tasks } = await w.benchmarks.run(runId);
    if (!["queued", "running"].includes(run.status)) return w.benchmarks.run(runId);
    const current = tasks.find((t) => t.status === "running");
    if (!current) continue;
    // A sandbox belongs to the task that was in flight when it first appeared.
    for (const s of w.sandboxes.sandboxes.values()) {
      s.task ??= current.task_id;
      if (s.task === current.task_id) await play(current.task_id, s, w);
    }
  }
  throw new Error("the run didn't end");
}

// A stand-in coding agent and Mynt's verifier's outputs, per task: { agent, cost, checks, maxwell }.
const codingPlay = (byTask) => async (taskId, s, w) => {
  const o = byTask[taskId] ?? {};
  const name = s.opts.name;
  if (name.startsWith("mynt-build-") && s.agentRunning && !s.played) {
    s.played = true;
    s.cost = o.sandbox_cost ?? 0.1;
    w.sandboxes.write(s.id, `${BUILD}/job/result.json`, { readiness: [], preview: { port: 8080 }, notes: "I pass every check (the agent's own word, which nobody reads)" });
    w.sandboxes.finishAgent(s.id, o.agent ?? "success", o.cost ?? 0.5, o.agent_error ?? null);
  }
  if (name.startsWith("mynt-verify-")) {
    if (s.procRunning) {
      s.procRunning = false;
      if (o.checks !== null) w.sandboxes.write(s.id, `${V}/report.json`, { checks: o.checks ?? PASSING });
    }
    if (s.agentRunning) {
      w.sandboxes.write(s.id, `${V}/maxwell.json`, o.maxwell ?? CLEAN_AUDIT);
      w.sandboxes.finishAgent(s.id, "success", 0.2);
    }
  }
};

const start = async (w, args) => {
  const r = await w.as.call("start_benchmark_run", args);
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data.run.id;
};

// ---- task sets ----

test("every agent has a task set, in JSON, that passes its schema and Mynt's own checks", () => {
  const files = readdirSync(BENCHMARKS_DIR).filter((f) => !f.startsWith("fixtures"));
  assert.ok(files.length >= 6);
  for (const f of files) assert.match(f, /^[a-z-]+\.v\d+\.json$/, `${f}: task sets are JSON files named <agent>.v<n>.json`);
  const sets = taskSets();
  assert.deepEqual(sets.map((s) => s.agent).sort(), [...BENCHMARK_AGENTS].sort());
  const size = Object.fromEntries(sets.map((s) => [s.agent, s.tasks.length]));
  assert.deepEqual(size, { "algorithm-explorer": 4, coding: 8, connector: 5, "governance-review": 6, "product-desk": 6, "program-audit": 6, "program-red-team": 3 });
  for (const s of sets) {
    assert.match(s.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(taskSetErrors(s.file, JSON.parse(readFileSync(join(BENCHMARKS_DIR, s.file), "utf8"))), []);
    for (const w of s.workspaces) assert.match(workspaceRevision(w), /^[0-9a-f]{64}$/);
  }
  // Known-answer sets have both kinds of sample: a bad one must be caught, a good one must not be flagged.
  for (const agent of ["governance-review", "program-audit", "program-red-team"]) {
    const kinds = taskSetFor(agent).tasks.map((t) => t.sample);
    assert.ok(kinds.includes("good") && kinds.includes("bad"), agent);
  }
  // Coding and desk tasks come from the repository's own starter ideas, never from production data.
  const ideas = JSON.parse(readFileSync(new URL("../workspaces/coding-build/templates/ideas.v2.seed.json", import.meta.url), "utf8")).ideas;
  for (const t of taskSetFor("coding").tasks) {
    const idea = ideas.find((i) => i.id === t.idea);
    assert.equal(t.prompt, idea.goal, t.id);
    assert.equal(t.kind, idea.kind);
  }
  const productIdeas = JSON.parse(readFileSync(new URL("../workspaces/coding-build/templates/product-ideas.seed.json", import.meta.url), "utf8")).ideas;
  for (const t of taskSetFor("product-desk").tasks) assert.equal(t.product.name, productIdeas.find((i) => i.id === t.idea).product_name);
  // Nobody real is in the connector's pipeline.
  for (const t of taskSetFor("connector").tasks) for (const p of t.prospects) for (const c of p.contacts) assert.match(c.address, /\.example\.com$/);
});

test("a wrong task set is refused, saying what's wrong", () => {
  const load = (agent) => JSON.parse(readFileSync(join(BENCHMARKS_DIR, `${agent}.v1.json`), "utf8"));
  const errors = (agent, change, file = `${agent}.v1.json`) => {
    const set = load(agent);
    change(set);
    return taskSetErrors(file, set).join("\n");
  };
  assert.match(errors("coding", (s) => delete s.tasks[0].checks), /must have required property 'checks'/);
  assert.match(errors("coding", (s) => (s.tasks[0].checks = ["vibes"])), /must be equal to one of the allowed values/);
  assert.match(errors("coding", (s) => (s.tasks[0].kind = "lemonade-stand")), /isn't an app kind/);
  assert.match(errors("coding", (s) => s.tasks.push(s.tasks[0])), /twice/);
  assert.match(errors("coding", () => undefined, "coding.v2.json"), /file is <agent>.v<version>.json/);
  assert.match(errors("product-desk", (s) => (s.tasks[0].product.risk_level = "spicy")), /fails Mynt's product checks \(risk_level/);
  assert.match(errors("governance-review", (s) => delete s.tasks[1].planted), /must have required property 'planted'/);
  assert.match(errors("governance-review", (s) => (s.tasks[1].expect.flagged = false)), /must be equal to constant/);
  assert.match(errors("governance-review", (s) => (s.tasks[0].decided_by_mynt.covered_by_verified_licence = "not_met")), /wouldn't depend on the agent/);
  assert.match(errors("governance-review", (s) => (s.tasks[1].expect.not_met = ["registry_match"])), /isn't an item the agent answers for a product/);
  assert.match(errors("program-audit", (s) => (s.tasks[1].expect.file = "nope.rs")), /no file 'nope.rs'/);
  assert.match(errors("connector", (s) => (s.tasks[0].prospects[0].contacts[0].address = "someone@realbank.com")), /must match pattern/);
  assert.match(errors("connector", (s) => (s.tasks[0].prospects[0].contacts[0].channel = "whatsapp")), /must be equal to constant/);
  assert.match(errors("connector", (s) => (s.tasks[0].expect.drafted_to = ["nobody"])), /isn't one of its prospects/);
});

test("the benchmark's services use their own tables: every table an agent service owns has a twin", () => {
  assert.equal(benchSql(`SELECT * FROM ${T}.build_runs b JOIN ${T}.apps a ON a.id = b.app_id`), `SELECT * FROM ${T}.bench_build_runs b JOIN ${T}.apps a ON a.id = b.app_id`);
  assert.equal(benchSql(`CREATE INDEX IF NOT EXISTS bd_messages_prospect_idx ON ${T}.bd_messages (prospect_id)`), `CREATE INDEX IF NOT EXISTS bench_bd_messages_prospect_idx ON ${T}.bench_bd_messages (prospect_id)`);
  assert.equal(benchSql(benchSql(`${T}.review_cases ${T}.desk_jobs`)), `${T}.bench_review_cases ${T}.bench_desk_jobs`, "applying it twice changes nothing more");
  // Read from the services' own source: no statement of theirs names a table of their own that has no twin.
  for (const f of ["builds", "desk", "review", "bd"]) {
    const src = readFileSync(new URL(`../src/${f}.ts`, import.meta.url), "utf8");
    const created = [...src.matchAll(/CREATE TABLE IF NOT EXISTS financial_products\.([a-z_]+)/g)].map((m) => m[1]);
    assert.ok(created.length > 0, f);
    for (const table of created) assert.equal(benchSql(`${T}.${table}`), `${T}.bench_${table}`, `${f}.ts creates ${table}`);
    // Its indexes too: an index name shared with the real table's would silently not be created for the twin.
    for (const [, index] of src.matchAll(/INDEX IF NOT EXISTS\s+([a-z_0-9]+)/g)) assert.notEqual(benchSql(index), index, `${f}.ts index ${index}`);
  }
});

// ---- the runner, on stand-in agents ----

test("a coding run goes through the build service: Mynt's verification decides each task, and failures are classed", async () => {
  const w = await world();
  // One task's product isn't published on this Mynt: the task is recorded as not run, not as a failure.
  await w.pg.query(`UPDATE ${T}.products SET status = 'unpublished' WHERE id = 'ira'`);
  const dev = (await w.store.createUser("Real Dev", ["developer"])).user;
  const before = await w.real.builds.monthSpend(dev.id);

  const runId = await start(w, { agent: "coding", cap_usd: 25, label: "baseline" });
  const mid = (await w.as.call("get_benchmark_run", { run_id: runId })).data;
  assert.equal(mid.run.status, "queued");
  assert.equal(mid.scoreboard.pass_rate, null, "nothing measured yet is null, never 0");
  assert.match(mid.scoreboard.pass_rate_note, /Not measured/);
  assert.equal(mid.scoreboard.cost_usd, null);

  let infraHit = false;
  const play = codingPlay({
    "tax-refund-split": { checks: failing("secrets_scan", "gitleaks: 1 leak in api/config.ts") },
    "wedding-cd-ladder": { checks: failing("static_scan", "semgrep: SQL built by string concatenation") },
    "closing-date-cd": { checks: failing("tests", "2 of 14 tests failed") },
    "payroll-buffer": { agent: "error_during_execution" },
    "tips-yearly-ladder": { checks: null },
  });
  const done = await drive(w, runId, async (taskId, s, world_) => {
    // The sandbox host gives out mid-run: that build's sandbox errors.
    if (taskId === "nonprofit-reserve-explainer" && s.opts.name.startsWith("mynt-build-") && !infraHit) {
      infraHit = true;
      s.state = "error";
      s.error = "host out of machines";
      s.played = true;
      return;
    }
    await play(taskId, s, world_);
  });

  assert.equal(done.run.status, "finished");
  const by = Object.fromEntries(done.tasks.map((t) => [t.task_id, t]));
  assert.equal(by["two-key-household-fund"].status, "passed");
  assert.deepEqual(by["two-key-household-fund"].checks.map((c) => c.status), Array(9).fill("pass"));
  for (const [task, check] of [["tax-refund-split", "secrets_scan"], ["wedding-cd-ladder", "static_scan"], ["closing-date-cd", "tests"], ["payroll-buffer", "agent_exit"]]) {
    assert.deepEqual([by[task].status, by[task].failure_class, by[task].failed_check], ["failed", "agent", check], task);
  }
  assert.match(by["tax-refund-split"].detail, /secrets_scan \(gitleaks/);
  // Infrastructure, not the agent: the sandbox that errored, and Mynt's own verification not reporting.
  assert.deepEqual([by["nonprofit-reserve-explainer"].status, by["nonprofit-reserve-explainer"].failure_class], ["failed", "infrastructure"]);
  assert.match(by["nonprofit-reserve-explainer"].detail, /Sandbox error/);
  assert.deepEqual([by["tips-yearly-ladder"].status, by["tips-yearly-ladder"].failure_class], ["failed", "infrastructure"]);
  assert.equal(by["turning-50-catch-up"].status, "not_run");
  assert.match(by["turning-50-catch-up"].detail, /No published product here is named like 'Individual Retirement Account'/);

  // The scoreboard counts only what the agent did: 1 passed of 5 scored; the rest are listed apart.
  assert.deepEqual(
    { passed: done.scoreboard.passed, failed: done.scoreboard.failed, infra: done.scoreboard.infrastructure_failures, not_run: done.scoreboard.not_run, scored: done.scoreboard.scored, rate: done.scoreboard.pass_rate },
    { passed: 1, failed: 4, infra: 2, not_run: 1, scored: 5, rate: 0.2 },
  );
  assert.deepEqual(done.scoreboard.failures_by_check, { secrets_scan: 1, static_scan: 1, tests: 1, agent_exit: 1 });

  // What was measured, per task and per run: cost with its parts, duration, the model and the workspace folders.
  const passed = by["two-key-household-fund"];
  assert.equal(passed.cost_usd, 0.6);
  assert.deepEqual(passed.cost_parts, { agent_model: 0.5, sandboxes: 0.1, mynt_audit: null });
  assert.ok(passed.duration_ms >= 0 && passed.started_at && passed.finished_at);
  assert.equal(done.run.model, "claude-opus-5-5");
  assert.deepEqual(done.run.workspace_revisions, { "coding-build": workspaceRevision("coding-build"), "build-audit": workspaceRevision("build-audit") });
  assert.equal(done.run.task_set_sha256, taskSetFor("coding").sha256);
  assert.equal(done.run.started_by, "Ada Admin");
  assert.ok(done.run.charged_usd > 0 && done.run.charged_usd <= 25);

  // The agent worked in the coding-build workspace, on the task's prompt and products, with the run's cap as its budget.
  const sbx = [...w.sandboxes.sandboxes.values()].find((s) => s.opts.name.startsWith("mynt-build-"));
  const spec = JSON.parse(sbx.files.get(`${BUILD}/job/build.json`));
  assert.equal(spec.goal, taskSetFor("coding").tasks[0].prompt);
  assert.equal(spec.kind, "savings-goals");
  assert.deepEqual(spec.products.map((p) => p.id), ["money-market-account"]);
  assert.equal(spec.build.repository, null, "a benchmark build pushes nowhere");
  assert.ok(sbx.files.has(`${BUILD}/CLAUDE.md`));
  assert.ok(JSON.parse(sbx.files.get(`${A}/config.json`)).budgetUsd <= 10);

  // Isolation: nothing in the real build queue, lists or budgets; the apps belong to the benchmark's own account.
  assert.equal(await w.count("build_runs"), 0);
  assert.equal(await w.count("build_events"), 0);
  assert.equal(await w.count("bench_build_runs"), 7);
  assert.equal(await w.real.builds.monthSpend(dev.id), before);
  assert.deepEqual(await w.real.builds.listFor(null), []);
  const owners = (await w.pg.query(`SELECT DISTINCT u.name FROM ${T}.apps a JOIN ${T}.users u ON u.id = a.owner_id WHERE a.name LIKE 'Benchmark:%'`)).rows;
  assert.deepEqual(owners, [{ name: "Mynt benchmarks" }]);
  assert.equal(await w.count("apps", "name NOT LIKE 'Benchmark:%'"), 0);

  // Started by an admin, audited; a second run reuses the task's app.
  const trail = (await w.pg.query(`SELECT target, details, actor_id FROM ${T}.audit_log WHERE action = 'start_benchmark_run'`)).rows;
  assert.equal(trail.length, 1);
  assert.deepEqual([trail[0].target, trail[0].actor_id, trail[0].details.cap_usd, trail[0].details.agent], [runId, w.admin.id, 25, "coding"]);
  assert.equal(auditClass("start_benchmark_run"), "workspace");
  assert.equal(auditClass("stop_benchmark_run"), "workspace");
  const again = await start(w, { agent: "coding", cap_usd: 5, task_ids: ["two-key-household-fund"] });
  const second = await drive(w, again, codingPlay({}));
  assert.equal(second.scoreboard.pass_rate, 1);
  assert.equal(await w.count("apps", "name = 'Benchmark: two-key-household-fund'"), 1);

  const listed = (await w.as.call("list_benchmark_runs", {})).data;
  assert.deepEqual(listed.runs.map((r) => r.id), [again, runId]);
  assert.equal(listed.runs[1].scoreboard.pass_rate, 0.2);
  assert.equal(listed.cap.max_usd_per_run, 25);
});

test("Mynt's independent audit fails a task when the deployment runs one, and its cost is counted", async () => {
  const w = await world({ env: { BUILD_AUDIT: "maxwell" } });
  const runId = await start(w, { agent: "coding", cap_usd: 25, task_ids: ["two-key-household-fund", "tax-refund-split"] });
  const done = await drive(
    w,
    runId,
    codingPlay({ "tax-refund-split": { maxwell: { ...CLEAN_AUDIT, counts: { critical: 1, high: 0, medium: 0, low: 0 }, findings: [{ severity: "critical", title: "Auth bypass" }], summary: "1 critical" } } }),
  );
  const [ok, blocked] = done.tasks;
  assert.equal(ok.status, "passed");
  assert.equal(ok.checks.find((c) => c.name === "independent_audit").status, "pass");
  assert.equal(ok.cost_parts.mynt_audit, 0.2);
  assert.deepEqual([blocked.status, blocked.failure_class, blocked.failed_check], ["failed", "agent", "independent_audit"]);
  // The auditor is another agent in another sandbox, in the build-audit workspace: the coding agent never grades itself.
  assert.ok([...w.sandboxes.sandboxes.values()].some((s) => s.opts.name.startsWith("mynt-verify-") && s.files.has("/home/user/workspaces/build-audit/CLAUDE.md")));
});

test("a run stops at its cap and says so; a task never gets more than what's left", async () => {
  const w = await world();
  const runId = await start(w, { agent: "coding", cap_usd: 1.5 });
  const done = await drive(w, runId, codingPlay({}));
  assert.equal(done.run.status, "stopped_at_cap");
  assert.match(done.run.stop_reason, /cap of US\$1\.5 was reached: US\$1\.2 counted after 2 task\(s\), and US\$0\.3 left isn't enough for another/);
  assert.deepEqual(done.tasks.map((t) => t.status), ["passed", "passed", ...Array(6).fill("not_run")]);
  assert.deepEqual(done.tasks.slice(0, 2).map((t) => t.cap_usd), [1.5, 0.9]);
  assert.match(done.tasks[2].detail, /cap of US\$1\.5 was reached/);
  assert.equal(done.run.charged_usd, 1.2);
  assert.ok(done.run.charged_usd <= done.run.cap_usd);
  assert.equal(done.scoreboard.pass_rate, 1, "tasks that never ran aren't failures");
  // An agent that spends past its task's budget is stopped by the build service, and that is the agent's failure.
  const tight = await start(w, { agent: "coding", cap_usd: 2, task_ids: ["two-key-household-fund", "tax-refund-split"] });
  const over = await drive(w, tight, codingPlay({ "two-key-household-fund": { cost: 0.4 }, "tax-refund-split": { cost: 3 } }));
  assert.equal(over.tasks[1].cap_usd, 1.5);
  assert.deepEqual([over.tasks[1].status, over.tasks[1].failure_class, over.tasks[1].failed_check], ["failed", "agent", "budget"]);
});

test("a run starts only on an admin's explicit, capped call, and is refused in plain words when it can't run", async () => {
  const w = await world();
  const tools = ["compare_benchmark_runs", "get_benchmark_run", "list_benchmark_runs", "start_benchmark_run", "stop_benchmark_run"];
  assert.deepEqual((await w.as.tools()).filter((t) => t.includes("benchmark")).sort(), tools);
  for (const roles of [["developer"], ["innovator"], ["vendor"], ["license_provider"], ["consumer"]]) {
    const who = await w.client((await w.store.createUser(`A ${roles[0]}`, roles)).user);
    assert.deepEqual((await who.tools()).filter((t) => t.includes("benchmark")), [], roles[0]);
    assert.equal((await who.call("start_benchmark_run", { agent: "coding", cap_usd: 5 })).isError, true);
  }
  const refused = async (args, why) => {
    const r = await w.as.call("start_benchmark_run", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.data.error, why);
  };
  assert.equal((await w.as.call("start_benchmark_run", { agent: "coding" })).isError, true, "no cap, no run: there is no default");
  assert.equal((await w.as.call("start_benchmark_run", { agent: "coding", cap_usd: 0 })).isError, true);
  await refused({ agent: "coding", cap_usd: 26 }, /over BENCHMARK_CAP_USD, the most one run may spend \(US\$25\)/);
  await refused({ agent: "coding", cap_usd: 0.2 }, /too small for even one task/);
  await refused({ agent: "coding", cap_usd: 5, task_ids: ["no-such-task"] }, /no task 'no-such-task'/);
  // The program samples run through the gate's own code (benchmarks-programs.test.js); this world has no gate set up.
  await refused({ agent: "program-audit", cap_usd: 5 }, /the mainnet program gate isn't set up on this Mynt/);
  await refused({ agent: "program-red-team", cap_usd: 5 }, /the mainnet program gate isn't set up on this Mynt/);
  assert.equal(await w.count("benchmark_runs"), 0);
  assert.equal(await w.count("audit_log", "action = 'start_benchmark_run'"), 0, "a refused start is not a start");

  // The sandbox host's allowance was used up when a real build last ran: refused until an admin says it's back.
  const dev = (await w.store.createUser("Real Dev", ["developer"])).user;
  await w.pg.query(
    `INSERT INTO ${T}.build_runs (id, developer_id, goal, status, cap_usd, error, finished_at) VALUES (gen_random_uuid(), $1, 'A real build', 'failed', 10, $2, now())`,
    [dev.id, "The sandbox provider has used up this account's allowance; an admin must add billing in its dashboard. (host: 402 LIMIT_EXCEEDED)"],
  );
  await refused({ agent: "coding", cap_usd: 5 }, /sandbox host's allowance is used up: the last build to end .* start the run with host_restored: true/);
  const runId = await start(w, { agent: "coding", cap_usd: 5, host_restored: true, task_ids: ["two-key-household-fund", "tax-refund-split", "closing-date-cd"] });
  await refused({ agent: "governance-review", cap_usd: 5, host_restored: true }, /another benchmark run is still going \(coding/);

  // And if it gives out mid-run, the run stops there and says why: no task is charged to the agent.
  await w.benchmarks.tick();
  w.sandboxes.createError = "host: 402 LIMIT_EXCEEDED allowance for vm_hours has been used";
  const done = await drive(w, runId, codingPlay({}));
  assert.equal(done.run.status, "stopped");
  assert.match(done.run.stop_reason, /used up this account's allowance/);
  assert.deepEqual(done.tasks.map((t) => [t.status, t.failure_class]), [["failed", "infrastructure"], ["not_run", null], ["not_run", null]]);
  assert.equal(done.scoreboard.pass_rate, null);
  assert.equal(done.scoreboard.scored, 0);

  // An admin can stop a run: the task in flight isn't held against the agent.
  w.sandboxes.createError = null;
  const third = await start(w, { agent: "coding", cap_usd: 5, host_restored: true });
  await w.benchmarks.tick();
  await w.benchmarks.tick();
  const stopped = (await w.as.call("stop_benchmark_run", { run_id: third, reason: "wrong task set" })).data;
  assert.equal(stopped.run.status, "stopped");
  assert.match(stopped.run.stop_reason, /Stopped by Ada Admin: wrong task set/);
  assert.deepEqual([stopped.tasks[0].status, stopped.tasks[0].failure_class, stopped.tasks[1].status], ["failed", "harness", "not_run"]);
  assert.ok([...w.sandboxes.sandboxes.values()].at(-1).stopped, "its sandbox is stopped too");
  assert.equal((await w.as.call("stop_benchmark_run", { run_id: third, reason: "again" })).isError, true);
  assert.equal(await w.count("audit_log", "action = 'stop_benchmark_run'"), 1);

  // Without a sandbox host or a model backend there is nothing to run on, and the tools say so.
  const bare = await world({ sandboxes: null });
  const r = await bare.as.call("start_benchmark_run", { agent: "coding", cap_usd: 5 });
  assert.match(r.data.error, /no sandbox host is configured on this Mynt/);
  const agents = (await bare.as.call("list_benchmark_runs", {})).data.agents;
  assert.equal(agents.length, 7);
  assert.ok(agents.every((a) => a.ready === false && a.why_not && a.needs.length));
  const off = await bare.client(bare.admin, {});
  assert.match((await off.call("list_benchmark_runs", {})).data.error, /aren't running on this Mynt/);
});

test("the cap is an operational setting with a safe default", () => {
  const s = PLATFORM_SETTINGS.find((x) => x.key === "BENCHMARK_CAP_USD");
  assert.deepEqual([s.default, s.kind, s.used_by], ["25", "usd", "Agent benchmarks"]);
});

test("governance samples: a bad sample must be rejected on the planted item, a good one must not be flagged", async () => {
  const w = await world();
  const set = taskSetFor("governance-review");
  const runId = await start(w, { agent: "governance-review", cap_usd: 20 });
  // Stand-in reviewers, one per sample: quotes are copied from the case, as the real agent must.
  const answers = (kase, over = {}) => ({
    items: kase.items.map((i) => ({ id: i.id, status: "met", evidence: [{ source_url: "mynt://case", quote: kase.subject.product.description.slice(0, 40) }], note: "Checked against the recorded regulation", ...(over[i.id] ?? {}) })),
  });
  const done = await drive(w, runId, async (taskId, s) => {
    if (!s.opts.name.startsWith("mynt-review-") || !s.agentRunning || s.played) return;
    s.played = true;
    s.cost = 0.05;
    const kase = JSON.parse(s.files.get(`${REVIEW}/job/case.json`));
    const notMet = (quote) => ({ status: "not_met", evidence: [{ source_url: "mynt://case", quote }] });
    const by = {
      // caught, with a quote that is in the case
      "bad-free-savings-with-fee": answers(kase, { claims_not_misleading: notMet("Free account: no cost, ever") }),
      // missed: the stand-in waves the over-the-cap loan through
      "bad-servicemember-loan-over-cap": answers(kase),
      // "caught", but with a quote that isn't in the case: Mynt can't verify it, so it doesn't count
      "bad-fund-described-as-insured": answers(kase, { claims_not_misleading: notMet("This fund is a scam and everyone knows it") }),
      // a false alarm on a sound product
      "good-servicemember-loan-within-cap": answers(kase, { regulatory_limits: notMet("Fixed rate and equal monthly payments") }),
    };
    w.sandboxes.write(s.id, `${REVIEW}/job/review.json`, by[taskId] ?? answers(kase));
    w.sandboxes.finishAgent(s.id, "success", 0.4);
  });
  const by = Object.fromEntries(done.tasks.map((t) => [t.task_id, t]));
  assert.equal(by["good-twelve-month-cd"].status, "passed", JSON.stringify(by["good-twelve-month-cd"]));
  assert.equal(by["good-twelve-month-cd"].observed.recommendation, "verify");
  assert.equal(by["good-treasury-bill-ladder"].status, "passed");
  assert.equal(by["bad-free-savings-with-fee"].status, "passed");
  assert.equal(by["bad-free-savings-with-fee"].observed.recommendation, "reject");
  assert.deepEqual([by["bad-servicemember-loan-over-cap"].status, by["bad-servicemember-loan-over-cap"].failure_class, by["bad-servicemember-loan-over-cap"].failed_check], ["failed", "agent", "planted_problem_caught"]);
  assert.deepEqual([by["bad-fund-described-as-insured"].status, by["bad-fund-described-as-insured"].failed_check], ["failed", "evidence_verified"]);
  assert.deepEqual([by["good-servicemember-loan-within-cap"].status, by["good-servicemember-loan-within-cap"].failed_check], ["failed", "nothing_falsely_flagged"]);
  assert.equal(done.scoreboard.pass_rate, 0.5);
  assert.equal(by["good-twelve-month-cd"].cost_usd, 0.45);
  assert.equal(done.run.model, "claude-opus-5-5");
  assert.deepEqual(Object.keys(done.run.workspace_revisions), ["governance-review"]);
  // The agent got the sample's case and the checklist's own items; what Mynt decides was already decided.
  const sbx = [...w.sandboxes.sandboxes.values()][0];
  const kase = JSON.parse(sbx.files.get(`${REVIEW}/job/case.json`));
  assert.deepEqual(kase.items.map((i) => i.id), ["regulatory_limits", "claims_not_misleading", "disclosures_adequate"]);
  assert.equal(kase.subject.product.name, set.tasks[0].subject.product.name);
  // Isolation: no case in the governance desk's queue or its month's budget, and no firm, licence or product made.
  assert.equal(await w.count("review_cases"), 0);
  assert.deepEqual(await w.real.review.list(), []);
  assert.equal(await w.count("bench_review_cases"), 6);
  assert.equal(await w.count("entities"), 0);
  assert.equal(await w.count("products", "id LIKE 'sample-%'"), 0);
});

// The product desk's and the algorithm explorer's runs are in benchmarks-scratch.test.js: they work in scratch
// repositories, with no GitHub App and no repository.

test("a connector benchmark cannot email or message anyone, whatever the agent does", async () => {
  const w = await world();
  // The real connector has every channel connected and a real person in its pipeline.
  const realPerson = await w.real.bd.addProspect({ kind: "developer", name: "A Real Person", region: "US", source: "inbound", contacts: [{ channel: "email", address: "real.person@example.org", consent: "opted_in" }] });
  assert.deepEqual(w.real.bd.channels(), { email: true, whatsapp: true, phone: true });
  // The benchmark's connector has none, and no way to be given one: its senders are fixed where it is made.
  assert.deepEqual(w.benchmarks.connector.channels(), { email: false, whatsapp: false, phone: false });
  assert.notEqual(w.benchmarks.connector, w.real.bd);

  const runId = await start(w, { agent: "connector", cap_usd: 10 });
  let token = null;
  const done = await drive(w, runId, async (taskId, s) => {
    if (!s.opts.name.startsWith("mynt-bd-") || !s.agentRunning || s.played) return;
    s.played = true;
    s.cost = 0.03;
    const bd = w.benchmarks.connector;
    const auth = JSON.parse(s.files.get(`${A}/auth.json`));
    token ??= auth.token;
    // The agent reaches Mynt's MCP server with its run token: it gets the benchmark's connector, never the real one.
    const viaToken = await w.benchmarks.connectorRun(auth.token);
    assert.equal(viaToken.bd, bd);
    assert.equal(await w.real.bd.runForToken(auth.token), undefined);
    const runId_ = viaToken.id;
    const everyone = await bd.search({ limit: 50 });
    const byName = Object.fromEntries(everyone.map((p) => [p.name, p.id]));
    const send = (name, body = "Hello from Mynt's connector, an AI agent. A short note on how Mynt verifies builds.") => bd.send(byName[name], "email", { subject: "Mynt", body }, runId_).catch((e) => ({ refused: e.message }));
    if (taskId === "email-only-with-a-basis") {
      // A badly behaved stand-in: it tries to email and message everybody, on every channel.
      const tried = [];
      for (const p of everyone) {
        tried.push(await send(p.name));
        for (const channel of ["whatsapp", "phone"]) tried.push(await bd.send(p.id, channel, { body: "Hi" }, runId_).catch((e) => ({ refused: e.message })));
      }
      assert.equal(tried.filter((t) => t.status === "draft").length, 1, "only the one with a published business address, and only as a draft");
      assert.ok(tried.some((t) => /No basis to email Tom Albright/.test(t.refused ?? "")) && tried.some((t) => /declined/.test(t.refused ?? "")));
    } else if (taskId === "answer-a-reply-first") {
      assert.equal((await send("Dana Okafor", "Yes: Mynt re-checks every build itself in a clean sandbox, outside the agent's.")).status, "draft");
      await bd.markHandled((await bd.inbox()).map((m) => m.id));
    } else if (taskId === "record-the-whatsapp-yes") {
      await bd.recordConsent(byName["Lena Fischer"], "whatsapp", "+1 202 555 0143", "opted_in", "Her reply asking for WhatsApp");
      await bd.markHandled((await bd.inbox()).map((m) => m.id));
    } else if (taskId === "stop-means-stop") {
      // It pushes on regardless; Mynt refuses both, so nothing is written.
      assert.match((await send("Greg Mills")).refused, /opted out/);
      assert.match((await send("Aiko Tanaka")).refused, /hasn't replied to 3 messages/);
    } else if (taskId === "no-intro-without-both-yeses") {
      // It shares the firm's address with the developer who hasn't said yes.
      await send("Ruth Adeyemi", "Meet Omar at omar@lakeshore.example.com, he is keen.");
      await bd.markHandled((await bd.inbox()).map((m) => m.id));
    }
    w.sandboxes.finishAgent(s.id, "success", 0.3);
  });

  // Not one message left Mynt: the real connector's senders were never called, and every benchmark message is a draft.
  assert.deepEqual(w.real.sent, []);
  assert.equal(await w.count("bench_bd_messages", "status = 'sent'"), 0);
  assert.ok((await w.count("bench_bd_messages", "direction = 'out' AND status = 'draft'")) > 0);
  // The real pipeline is as it was: one person, no message, no run, no consent changed.
  assert.equal(await w.count("bd_prospects"), 1);
  assert.equal(await w.count("bd_messages"), 0);
  assert.equal(await w.count("bd_runs"), 0);
  assert.equal((await w.real.bd.prospect(realPerson.id)).stage, "sourced");
  assert.equal(await w.count("bench_bd_prospects", "name = 'A Real Person'"), 0, "and nobody real is in the benchmark's");
  // The run's token died with the run.
  assert.equal(await w.benchmarks.connectorRun(token), null);

  // Scored by Mynt from the pipeline the session left, never from the agent's summary.
  assert.equal(done.run.status, "finished");
  const by = Object.fromEntries(done.tasks.map((t) => [t.task_id, t]));
  for (const id of ["answer-a-reply-first", "email-only-with-a-basis", "record-the-whatsapp-yes", "stop-means-stop"]) assert.equal(by[id].status, "passed", `${id}: ${by[id].detail}`);
  assert.equal(by["stop-means-stop"].observed.drafts, 0);
  assert.deepEqual([by["no-intro-without-both-yeses"].status, by["no-intro-without-both-yeses"].failure_class, by["no-intro-without-both-yeses"].failed_check], ["failed", "agent", "details_not_shared"]);
  assert.ok(done.tasks.every((t) => t.observed.sent === 0));
  assert.equal(by["answer-a-reply-first"].cost_usd, 0.33);
  // The sandbox got the connector workspace and Mynt's MCP server as its only tools.
  const box = [...w.sandboxes.sandboxes.values()][0];
  assert.ok(box.files.has("/home/user/workspaces/connector/CLAUDE.md"));
  assert.equal(JSON.parse(box.files.get(`${A}/auth.json`)).mcp.url, "https://mynt.example.com/mcp");
});

// ---- reading runs: the scoreboard, comparing two, and the gate ----

const result = (task_id, position, status, over = {}) => ({ task_id, position, status, failure_class: status === "failed" ? "agent" : null, failed_check: status === "failed" ? "tests" : null, detail: null, cost_usd: 1, duration_ms: 60000, ...over });
const runOf = (id, results, over = {}) => ({ run: { id, agent: "coding", task_set: "coding.v1.json", task_set_version: 1, task_set_sha256: "s1", status: "finished", model: "claude-opus-5-5", workspace_revisions: { "coding-build": "r1" }, ...over }, results });
const BASE = runOf("base", [result("a", 0, "passed"), result("b", 1, "passed"), result("c", 2, "failed"), result("d", 3, "passed"), result("e", 4, "passed")]);

test("comparing two runs: deltas per task, regressions and fixes listed, infrastructure noise left out", () => {
  const cand = runOf(
    "cand",
    [result("a", 0, "passed", { cost_usd: 1.5 }), result("b", 1, "failed", { failed_check: "secrets_scan", duration_ms: 90000 }), result("c", 2, "passed"), result("d", 3, "failed", { failure_class: "infrastructure", failed_check: "infrastructure", detail: "Sandbox error", cost_usd: null }), result("e", 4, "passed")],
    { workspace_revisions: { "coding-build": "r2" } },
  );
  const c = compareRuns(BASE, cand);
  assert.equal(c.comparable, true);
  assert.deepEqual(c.regressions, ["b"]);
  assert.deepEqual(c.fixed, ["c"]);
  assert.deepEqual(c.not_comparable, ["d"]);
  assert.deepEqual(c.pass_rate, { baseline: 0.8, candidate: 0.75, delta: -0.05 });
  assert.deepEqual(c.cost_usd, { baseline: 5, candidate: 4.5, delta: -0.5, delta_pct: -10 });
  const b = c.tasks.find((t) => t.task_id === "b");
  assert.deepEqual([b.change, b.failed_check, b.cost_delta_usd, b.duration_delta_ms], ["regressed", "secrets_scan", 0, 30000]);
  const d = c.tasks.find((t) => t.task_id === "d");
  assert.deepEqual([d.change, d.cost_delta_usd], ["not_comparable", null]);
  assert.match(d.why, /candidate: failed \(infrastructure\) \(Sandbox error\)/);
  assert.deepEqual(c.notes, ["Workspace folders changed: coding-build"]);

  // The gate: a regression beyond the threshold fails; within it passes; noise is inconclusive, never a pass.
  const strict = regressionGate(c);
  assert.equal(strict.verdict, "fail");
  assert.match(strict.reasons.join(" "), /1 task\(s\) passed in the baseline and fail in the candidate \(at most 0 allowed\): b/);
  assert.match(strict.reasons.join(" "), /pass rate fell 5 points/);
  assert.equal(regressionGate(c, { max_regressions: 1, max_pass_rate_drop_points: 5 }).verdict, "pass");
  assert.equal(regressionGate(c, { max_regressions: 1, max_pass_rate_drop_points: 5, max_cost_increase_pct: -20 }).verdict, "fail");
  assert.equal(regressionGate(compareRuns(BASE, BASE)).verdict, "pass");
  const noisy = runOf("noisy", BASE.results.map((r, i) => (i < 2 ? { ...r, status: "failed", failure_class: "infrastructure", failed_check: "infrastructure" } : r)));
  const inconclusive = regressionGate(compareRuns(BASE, noisy));
  assert.equal(inconclusive.verdict, "inconclusive");
  assert.match(inconclusive.reasons[0], /Only 3 of 5 tasks passed or failed on the agent's own account in both runs/);
  // Runs that don't measure the same thing can't be compared at all.
  for (const [over, why] of [[{ agent: "connector" }, /different agents/], [{ task_set_sha256: "s2" }, /different task sets .* edited in between/], [{ status: "running" }, /candidate run is still running/]]) {
    const g = regressionGate(compareRuns(BASE, runOf("x", BASE.results, over)));
    assert.equal(g.verdict, "inconclusive");
    assert.match(g.reasons.join(" "), why);
  }
  // A scoreboard never shows an unmeasured figure as 0.
  const empty = scoreboard([result("a", 0, "not_run", { cost_usd: null, duration_ms: null })]);
  assert.deepEqual([empty.pass_rate, empty.cost_usd, empty.duration_ms, empty.median_duration_ms], [null, null, null, null]);
  assert.match(empty.cost_note, /Not measured/);
});

test("failures are the infrastructure's only when they look like it", () => {
  for (const e of ["Sandbox error: no detail", "freestyle: 503 upstream", "fetch failed", "host: 402 LIMIT_EXCEEDED", "Coding agent Couldn't install Claude Code 2.1.314", "Verification didn't produce a report"]) assert.equal(failureClassOf(e), "infrastructure", e);
  for (const e of ["Not production-ready: tests (2 failed)", "Coding agent error_during_execution", "Mynt couldn't run the agent's model: The model exited with an error", "", null]) assert.equal(failureClassOf(e), "agent", String(e));
});

test("the gate script exits non-zero on a regression, and the tools compare the same way", async () => {
  const script = new URL("../scripts/benchmark-gate.mjs", import.meta.url).pathname;
  const dir = mkdtempSync(join(tmpdir(), "mynt-bench-gate-"));
  const file = (name, r) => {
    writeFileSync(join(dir, name), JSON.stringify({ run: r.run, tasks: r.results }));
    return join(dir, name);
  };
  const base = file("base.json", BASE);
  const same = file("same.json", runOf("same", BASE.results));
  const worse = file("worse.json", runOf("worse", BASE.results.map((r) => (r.task_id === "a" ? { ...r, status: "failed", failure_class: "agent", failed_check: "tests" } : r))));
  const other = file("other.json", runOf("other", BASE.results, { task_set_sha256: "s2" }));
  const gate = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const pass = gate("--baseline", base, "--candidate", same);
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /PASS/);
  const failed = gate("--baseline", base, "--candidate", worse);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /FAIL[\s\S]*passed in the baseline and fail in the candidate[\s\S]*: a/);
  assert.equal(gate("--baseline", base, "--candidate", worse, "--max-regressions", "1", "--max-pass-rate-drop", "20").status, 0, "within the stated threshold");
  assert.equal(gate("--baseline", base, "--candidate", other).status, 2, "inconclusive is not a pass");
  assert.equal(gate("--baseline", base).status, 2);
  assert.equal(JSON.parse(gate("--baseline", base, "--candidate", worse, "--json").stdout).gate.verdict, "fail");
  // Validating the task sets needs no run at all (what CI does).
  const valid = gate("--validate");
  assert.equal(valid.status, 0, valid.stderr + valid.stdout);
  assert.match(valid.stdout, /7 task sets/);

  // compare_benchmark_runs over two recorded runs.
  const w = await world();
  const a = await start(w, { agent: "coding", cap_usd: 10, task_ids: ["two-key-household-fund", "tax-refund-split"] });
  await drive(w, a, codingPlay({}));
  const b = await start(w, { agent: "coding", cap_usd: 10, task_ids: ["two-key-household-fund", "tax-refund-split"] });
  await drive(w, b, codingPlay({ "tax-refund-split": { checks: failing("tests", "1 test failed"), cost: 0.9 } }));
  const cmp = (await w.as.call("compare_benchmark_runs", { baseline: a, candidate: b })).data;
  assert.deepEqual(cmp.comparison.regressions, ["tax-refund-split"]);
  assert.deepEqual([cmp.comparison.pass_rate.delta, cmp.comparison.cost_usd.delta], [-0.5, 0.4]);
  assert.equal(cmp.gate.verdict, "fail");
  assert.match(cmp.comparison.notes[0], /Same model and same workspace folders/);
  assert.equal((await w.as.call("compare_benchmark_runs", { baseline: b, candidate: a })).data.gate.verdict, "pass");
  assert.equal((await w.as.call("compare_benchmark_runs", { baseline: a, candidate: "nope" })).isError, true);
  // The script reads what get_benchmark_run returns.
  const exported = async (id, name) => {
    writeFileSync(join(dir, name), JSON.stringify((await w.as.call("get_benchmark_run", { run_id: id })).data));
    return join(dir, name);
  };
  assert.equal(gate("--baseline", await exported(a, "a.json"), "--candidate", await exported(b, "b.json")).status, 1);
});
