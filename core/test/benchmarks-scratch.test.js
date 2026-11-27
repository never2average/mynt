import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BdService, bdConfigFromEnv } from "../dist/bd.js";
import { BENCHMARKS_DIR, baselineFiles, taskSetErrors, taskSetFor } from "../dist/benchmark-tasks.js";
import { BenchmarkService, benchSql, failureClassOf } from "../dist/benchmarks.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { DeskService, deskConfigFromEnv } from "../dist/desk.js";
import { datasetInputs, generateDataset, splitKeys } from "../dist/explore-data.js";
import { scoreWithStability } from "../dist/explore-score.js";
import { DECIDE_RUNNER, ExploreService, TOKEN_FILE, explorationAngles, exploreConfigFromEnv } from "../dist/explore.js";
import { PLATFORM_SETTINGS } from "../dist/platform-settings.js";
import { ReviewService, reviewConfigFromEnv } from "../dist/review.js";
import { SCRATCH_BARE, SCRATCH_REPOSITORY, SCRATCH_TOKEN, scratchAddresses, scratchCheckoutScript, scratchHeadCommand, scratchPackScript, scratchSetupScript } from "../dist/scratch-repo.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// Scratch workspaces: a product-desk or algorithm-explorer benchmark needs no GitHub App and no repository. The agents
// here are stand-ins (this file plays them); the services, their ticks, budgets and Mynt's own verification are the
// production code. Nothing here starts a real agent or a real sandbox.

const T = "financial_products";
const A = "/home/user/mynt-agent";
const DESK = "/home/user/mynt-desk";
const EXPLORE = "/home/user/mynt-explore";
const SETUP = "bash /home/user/.mynt-scratch/setup.sh";
const SEEDED = "5eed".repeat(10); // the scratch repository's first commit, as the stand-in host reports it
const BUNDLE_SHA = "b".repeat(64);
const CUSTOMER_REPO = "acme-bank/core-models"; // a firm's repository the GitHub App is installed on

function standInHost() {
  const sandboxes = new Map();
  let n = 0;
  const host = {
    sandboxes,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "ready", error: null, opts, files: new Map(), commands: [], refs: new Map(), stopped: false, cost: 0, procRunning: false, agentRunning: false, played: false });
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
      // Mynt making the scratch repository: its first commit is on the default branch.
      if (command === SETUP) {
        s.refs.set("main", SEEDED);
        return { exitCode: 0, stdout: `${SEEDED}\n`, stderr: "" };
      }
      // Mynt reading what a branch holds: git's answer for a branch nobody pushed is exit 1 and nothing.
      const asked = /rev-parse -q --verify 'refs\/heads\/([^']+)\^\{commit\}'/.exec(command);
      if (asked) return s.refs.has(asked[1]) ? { exitCode: 0, stdout: `${s.refs.get(asked[1])}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
      if (command.includes("bundle create")) return { exitCode: 0, stdout: `${BUNDLE_SHA}  ${/bundle create '([^']+)'/.exec(command)[1]}\n`, stderr: "" };
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
    finishAgent(id, subtype = "success", cost = 0) {
      const s = sandboxes.get(id);
      s.agentRunning = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ session_id: "s1", cost_usd: cost, turns: 1, sent: 1, last_subtype: subtype, done: true, exit_code: subtype === "success" ? 0 : 1, error: null, summary: "I am sure this is excellent (the agent's own word, which nobody reads)" }));
    },
    write(id, path, value) {
      sandboxes.get(id).files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    },
  };
  return host;
}

// GitHub, with Mynt's App installed on a firm's repository. Every call is recorded: a benchmark must make none.
function recordingRepos() {
  const calls = [];
  const note = (name, ...args) => calls.push([name, ...args]);
  return {
    calls,
    prs: [],
    async installationFor(repo) {
      note("installationFor", repo);
      return repo === CUSTOMER_REPO ? 7 : null;
    },
    async tokenFor(repo) {
      note("tokenFor", repo);
      return { token: "ghs_for_the_firm", expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    async resolveRef(repo, installation, ref) {
      note("resolveRef", repo, ref);
      return "a".repeat(40);
    },
    async createBranch(repo, installation, branch) {
      note("createBranch", repo, branch);
    },
    installUrl: () => "https://github.com/apps/mynt/installations/new",
    async openPullRequest(repo, installation, pr) {
      note("openPullRequest", repo);
      this.prs.push({ repo, ...pr });
      return `https://github.com/${repo}/pull/${this.prs.length}`;
    },
  };
}

async function world({ withApp = true, env = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const sandboxes = standInHost();
  const repos = withApp ? recordingRepos() : null;
  const buildConfig = { ...buildConfigFromEnv(env), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } };
  const deskConfig = deskConfigFromEnv(buildConfig, env);
  const reviewConfig = reviewConfigFromEnv(buildConfig, env);
  const bdConfig = bdConfigFromEnv(buildConfig, { ...env, BD_ENABLED: "1" });
  // The real services, on the same database: what a benchmark must never touch.
  const real = {
    builds: await BuildService.open(db, store, sandboxes, repos, buildConfig),
    desk: await DeskService.open(db, store, sandboxes, repos, deskConfig),
    review: await ReviewService.open(db, store, sandboxes, reviewConfig),
    bd: await BdService.open(db, sandboxes, bdConfig, {}),
  };
  real.explore = await ExploreService.open(db, store, sandboxes, repos, exploreConfigFromEnv(deskConfig, env), real.desk);
  const benchmarks = await BenchmarkService.open(db, store, { sandboxes, repos, buildConfig, deskConfig, reviewConfig, bdConfig, exploreConfig: exploreConfigFromEnv(deskConfig, env), fetcher: async () => ({ ok: false, status: 404, contentType: "text/plain", text: "" }) });
  const admin = (await store.createUser("Ada Admin", ["admin"])).user;
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(store, admin, { benchmarks }).connect(s);
  const cl = new Client({ name: "test", version: "0" });
  await cl.connect(c);
  const call = async (name, args = {}) => {
    const res = await cl.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const count = async (table, where = "TRUE") => (await pg.query(`SELECT count(*)::int AS n FROM ${T}.${table} WHERE ${where}`)).rows[0].n;
  const boxes = (prefix) => [...sandboxes.sandboxes.values()].filter((b) => b.opts.name.startsWith(prefix));
  return { pg, db, store, sandboxes, repos, benchmarks, real, admin, call, count, boxes };
}

const start = async (w, args) => {
  const r = await w.call("start_benchmark_run", args);
  assert.equal(r.isError, false, JSON.stringify(r.data));
  return r.data.run.id;
};

// Runs the benchmark worker until the run ends; `play` stands in for the agent (and for what Mynt's own sandboxes
// produce) between ticks, and `before` runs ahead of every tick.
async function drive(w, runId, play, { ticks = 300, before = async () => undefined } = {}) {
  for (let i = 0; i < ticks; i++) {
    await before();
    await w.benchmarks.tick();
    const { run, tasks } = await w.benchmarks.run(runId);
    if (!["queued", "running"].includes(run.status)) return w.benchmarks.run(runId);
    const current = tasks.find((t) => t.status === "running");
    if (!current) continue;
    for (const s of w.sandboxes.sandboxes.values()) {
      s.task ??= current.task_id;
      if (s.task === current.task_id) await play(current.task_id, s);
    }
  }
  throw new Error("the run didn't end");
}

const deskReport = (verdict = "feasible") => ({ outcome: "ran", model: "cd-economics", commit: "c".repeat(40), report: { verdict, summary: "Margin 0.55% per account", metrics: { margin_pct: 0.55, breakeven_balance_usd: 2100 }, checks: [{ name: "reg_dd_disclosures", status: "pass", detail: "ok" }] }, log: "" });

// A stand-in desk agent: it pushes its branch to wherever git sends it (unless told not to) and exits; then Mynt's
// own run in the clean sandbox writes the outcome given for the task.
const deskPlay = (w, byTask) => async (taskId, s) => {
  const o = byTask[taskId] ?? {};
  if (s.opts.name.startsWith("mynt-desk-agent-") && s.agentRunning && !s.played) {
    s.played = true;
    s.cost = 0.05;
    if (o.push !== false) s.refs.set(s.opts.env.MYNT_BRANCH, o.commit ?? "c".repeat(40));
    w.sandboxes.finishAgent(s.id, "success", o.cost ?? 1.2);
  }
  if (s.opts.name.startsWith("mynt-desk-verify-") && s.procRunning) {
    s.procRunning = false;
    s.cost = 0.02;
    w.sandboxes.write(s.id, `${DESK}/job/outcome.json`, o.outcome ?? deskReport());
  }
};

// ---- Job 1: the product desk ----

test("a product-desk benchmark needs no GitHub App and no repository: the agent pushes to a scratch repository in its own sandbox, and Mynt moves the branch to its clean sandbox itself", async () => {
  // This Mynt has the GitHub App, installed on a firm's repository. The benchmark must never go near it.
  const w = await world();
  const desk = (await w.call("list_benchmark_runs", {})).data.agents.find((a) => a.agent === "product-desk");
  assert.equal(desk.ready, true, desk.why_not);
  assert.ok(desk.needs.some((n) => /No repository and no GitHub App/.test(n)));

  const runId = await start(w, { agent: "product-desk", cap_usd: 20, task_ids: ["gig-worker-no-penalty-cd", "goal-locked-mma", "rate-reset-cd"] });
  const done = await drive(
    w,
    runId,
    deskPlay(w, {
      "goal-locked-mma": { push: false },
      "rate-reset-cd": { outcome: { outcome: "error", model: "cd", error: "The model exited with an error", log: "Traceback" } },
    }),
  );
  assert.equal(done.run.status, "finished");
  const [ok, silent, broken] = done.tasks;

  // The task that passed: scored from Mynt's own run, nothing else.
  assert.equal(ok.status, "passed", JSON.stringify(ok));
  assert.deepEqual(ok.checks.map((c) => [c.name, c.status]), [["product_checks", "pass"], ["agent_finished", "pass"], ["mynt_model_run", "pass"], ["report_expectations", "pass"]]);
  assert.equal(ok.cost_usd, 1.27);
  assert.equal(ok.observed.verdict, "feasible");
  assert.ok(!("pr_url" in ok.observed), "there is no pull request to speak of");

  // What the agent's sandbox got: the unchanged workspace, a scratch repository, and a placeholder where a token goes.
  const [agentBox] = w.boxes("mynt-desk-agent-");
  assert.deepEqual(Object.keys(agentBox.opts.env).sort(), ["GITHUB_REPOSITORY", "GITHUB_TOKEN", "MYNT_BRANCH"]);
  assert.equal(agentBox.opts.env.GITHUB_REPOSITORY, SCRATCH_REPOSITORY);
  assert.equal(agentBox.opts.env.GITHUB_TOKEN, SCRATCH_TOKEN, "a placeholder with no power, not a token");
  assert.match(agentBox.opts.env.MYNT_BRANCH, /^mynt\/desk-[0-9a-f]{8}$/);
  const instructions = agentBox.files.get("/home/user/workspaces/product-desk/CLAUDE.md");
  assert.equal(instructions, readFileSync(new URL("../workspaces/product-desk/CLAUDE.md", import.meta.url), "utf8"), "the agent's instructions are the workspace's own, unchanged");
  const ran = agentBox.commands.map((c) => c.command);
  assert.ok(ran.indexOf(SETUP) >= 0 && ran.indexOf(SETUP) < ran.findIndex((c) => c.includes("runner.mjs")), "Mynt made the scratch repository before the agent started");
  const setup = agentBox.files.get("/home/user/.mynt-scratch/setup.sh");
  assert.equal(setup, scratchSetupScript());
  for (const address of [`https://github.com/${SCRATCH_REPOSITORY}.git`, `https://github.com/${SCRATCH_REPOSITORY}`]) assert.ok(setup.includes(`git config --global --add 'url.file://${SCRATCH_BARE}.insteadOf' '${address}'`), address);
  assert.equal(JSON.parse(agentBox.files.get("/home/user/workspaces/product-desk/job/spec.json")).product.name, "6-Month No-Penalty CD");

  // Mynt, not the agent, read the branch, packed it and handed it to the clean sandbox, which checks what it got.
  const branch = agentBox.opts.env.MYNT_BRANCH;
  assert.ok(ran.some((c) => c === scratchHeadCommand(branch)));
  const pack = ran.find((c) => c.includes("bundle create"));
  assert.ok(pack.includes(`update-ref refs/mynt/desk-${branch.slice(-8)} ${"c".repeat(40)}`), pack);
  const [verifyBox] = w.boxes("mynt-desk-verify-");
  assert.deepEqual(verifyBox.opts.env, {}, "the clean sandbox has no credentials, and there are none to give");
  const run = verifyBox.files.get(`${DESK}/run.sh`);
  assert.ok(run.includes(`curl -fsSL 'https://files.example/${agentBox.id}/home/user/.mynt-scratch/out/desk-${branch.slice(-8)}.bundle?sig=x'`), run);
  assert.ok(run.includes(`= "${BUNDLE_SHA}" ]`), "the bundle's sha256 is checked before anything is run");
  assert.ok(run.includes(`checkout -q --detach ${"c".repeat(40)}`), "exactly the commit Mynt read from the branch");
  assert.ok(run.indexOf("checkout -q --detach") < run.indexOf("desk-runner.mjs"), "then the same desk runner as for any firm");
  assert.ok(!run.includes("github.com") && !run.includes("credential"), "no GitHub, no credentials");
  assert.ok(!verifyBox.files.has("/home/user/.mynt-git-credentials"));

  // An agent that never pushed: its own failure, said plainly, and no second sandbox was spent on it.
  assert.deepEqual([silent.status, silent.failure_class, silent.failed_check], ["failed", "agent", "agent_finished"]);
  assert.match(silent.detail, /The desk agent never pushed its branch mynt\/desk-[0-9a-f]{8}, so there is no model for Mynt to run/);
  assert.equal(w.sandboxes.sandboxes.size, 5, "two sandboxes for each task Mynt could verify, one for the task with nothing pushed");
  // A model Mynt couldn't run: also the agent's, from Mynt's run.
  assert.deepEqual([broken.status, broken.failure_class, broken.failed_check], ["failed", "agent", "mynt_model_run"]);
  assert.deepEqual([done.scoreboard.passed, done.scoreboard.failed], [1, 2]);

  // No token was minted, no installation looked up, no pull request opened: GitHub was never called.
  assert.deepEqual(w.repos.calls, []);
  assert.equal(w.benchmarks.desk.repos, null, "the benchmark's desk was never given the GitHub App");
  assert.equal(w.benchmarks.explore.repos, null);
  const jobs = (await w.pg.query(`SELECT pr_url, workspace_repository, cap_usd FROM ${T}.bench_desk_jobs ORDER BY created_at`)).rows;
  assert.deepEqual(jobs.map((j) => [j.pr_url, j.workspace_repository]), Array(3).fill([null, SCRATCH_REPOSITORY]));
  // No workspace was connected or approved anywhere, and the real desk has nothing of the benchmark's.
  for (const table of ["desk_workspaces", "bench_desk_workspaces", "desk_jobs", "desk_reports", "product_terms"]) assert.equal(await w.count(table), 0, table);
  assert.equal(await w.count("bench_desk_reports"), 1, "one report: from the one model Mynt could run");
  const drafts = (await w.pg.query(`SELECT p.status, e.name FROM ${T}.products p JOIN ${T}.entities e ON e.id = p.entity_id WHERE p.id LIKE 'benchmark-%'`)).rows;
  assert.deepEqual(drafts.map((d) => [d.status, d.name]), Array(3).fill(["draft", "Mynt benchmarks (not a firm)"]));
  const trail = (await w.pg.query(`SELECT details FROM ${T}.audit_log WHERE action = 'start_benchmark_run'`)).rows[0].details;
  assert.ok(!("repository" in trail));
  assert.deepEqual(done.run.options, { task_ids: ["gig-worker-no-penalty-cd", "goal-locked-mma", "rate-reset-cd"] });
});

test("a Mynt with no GitHub App at all (repos: null) runs a product-desk benchmark all the same; if the branch can't be moved, that is the infrastructure's failure", async () => {
  const w = await world({ withApp: false });
  assert.equal(w.real.desk.enabled, false, "a firm's desk still needs the GitHub App");
  assert.equal(w.benchmarks.desk.enabled, true);
  const runId = await start(w, { agent: "product-desk", cap_usd: 10, task_ids: ["gig-worker-no-penalty-cd", "rate-reset-cd"] });
  let lost = null;
  const play = deskPlay(w, {});
  const done = await drive(w, runId, async (taskId, s) => {
    // The second task's clean sandbox can't fetch the bundle: its run script writes the clone failure Mynt gave it.
    if (taskId === "rate-reset-cd" && s.opts.name.startsWith("mynt-desk-verify-") && s.procRunning) {
      s.procRunning = false;
      lost = JSON.parse(s.files.get(`${DESK}/clone-failed.json`));
      return w.sandboxes.write(s.id, `${DESK}/job/outcome.json`, lost);
    }
    await play(taskId, s);
  });
  assert.equal(done.tasks[0].status, "passed", JSON.stringify(done.tasks[0]));
  assert.equal(lost.error, "Couldn't move the agent's branch to Mynt's verification sandbox");
  assert.deepEqual([done.tasks[1].status, done.tasks[1].failure_class, done.tasks[1].failed_check], ["failed", "infrastructure", "infrastructure"]);
  assert.equal(done.scoreboard.pass_rate, 1, "an infrastructure failure isn't held against the agent");
  assert.equal(failureClassOf("Couldn't prepare the benchmark's scratch repository: git: not found"), "infrastructure");
  assert.equal(failureClassOf("The desk agent never pushed its branch mynt/desk-12345678, so there is no model for Mynt to run"), "agent");
});

test("a run takes no repository: the argument is gone, and naming one is refused", async () => {
  const w = await world();
  const tool = (await w.call("list_benchmark_runs", {})).data;
  assert.ok(tool.agents.every((a) => !/GitHub App installed/.test(a.needs.join(" "))));
  const r = await w.call("start_benchmark_run", { agent: "product-desk", cap_usd: 5, repository: CUSTOMER_REPO });
  assert.equal(r.isError, true);
  assert.match(JSON.stringify(r.data), /repository/, "the unknown argument is named");
  assert.equal(await w.count("benchmark_runs"), 0);
  assert.equal(await w.count("audit_log", "action = 'start_benchmark_run'"), 0);
  // Passed straight to the service (no tool in between), it changes nothing: no workspace, no call to GitHub.
  const started = await w.benchmarks.start(w.admin, { agent: "product-desk", cap_usd: 5, repository: CUSTOMER_REPO, task_ids: ["gig-worker-no-penalty-cd"] });
  assert.deepEqual(started.run.options, { task_ids: ["gig-worker-no-penalty-cd"] });
  await drive(w, started.run.id, deskPlay(w, {}));
  assert.deepEqual(w.repos.calls, []);
  assert.equal(w.boxes("mynt-desk-agent-")[0].opts.env.GITHUB_REPOSITORY, SCRATCH_REPOSITORY);
  for (const table of ["desk_workspaces", "bench_desk_workspaces"]) assert.equal(await w.count(table), 0, table);
});

test("scratch mode can't be switched on from outside, and a real firm's desk job is what it always was", async () => {
  // Not an environment variable, not an operational setting: only code that builds a DeskConfig can set it.
  const host = { agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, model: "m", publicUrl: "https://mynt.example.com" };
  const fromEnv = deskConfigFromEnv(host, { SCRATCH_WORKSPACE: "1", DESK_SCRATCH_WORKSPACE: "true", scratchWorkspace: "1", MYNT_SCRATCH_WORKSPACE: "1" });
  assert.equal(fromEnv.scratchWorkspace, undefined);
  assert.ok(!Object.keys(PLATFORM_SETTINGS).some((k) => /scratch/i.test(k)) && !JSON.stringify(PLATFORM_SETTINGS).toLowerCase().includes("scratch"));
  const src = readFileSync(new URL("../src/desk.ts", import.meta.url), "utf8");
  assert.equal([...src.matchAll(/scratchWorkspace/g)].length, 2, "declared once and read once in desk.ts; set only in benchmarks.ts");

  const w = await world();
  assert.equal(w.real.desk.config.scratchWorkspace, undefined);
  assert.equal(w.benchmarks.desk.config.scratchWorkspace, true);
  const user = (await w.store.createUser("Ines Innovator", ["innovator"])).user;
  const entity = await w.store.createEntity(user.id, { name: "Acme Bank", registration_numbers: {}, regions: ["US"] });
  user.entity_id = entity.id;
  const product = { id: "acme-cd", ...taskSetFor("product-desk").tasks[0].product };
  await w.store.insertDraft(user.id, product, { entity_id: entity.id });
  await w.real.desk.setTerms("acme-cd", user.id, { inputs: { apy_pct: 4 } });
  // Without a connected, approved workspace a firm's job doesn't start: there is no scratch for a firm.
  await assert.rejects(w.real.desk.start(user, { kind: "agent", product_id: "acme-cd", goal: "Build a feasibility model" }), /Connect your firm's workspace repository first/);
  await w.real.desk.connectWorkspace(entity.id, user.id, CUSTOMER_REPO);
  await assert.rejects(w.real.desk.start(user, { kind: "agent", product_id: "acme-cd", goal: "Build a feasibility model" }), /Waiting for an admin to approve/);
  await w.pg.query(`UPDATE ${T}.desk_workspaces SET approval = 'approved' WHERE entity_id = $1`, [entity.id]);
  const job = await w.real.desk.start(user, { kind: "agent", product_id: "acme-cd", goal: "Build a feasibility model" });
  assert.equal(job.workspace_repository, CUSTOMER_REPO);
  await w.real.desk.tick();
  const [agentBox] = w.boxes("mynt-desk-agent-");
  assert.deepEqual(agentBox.opts.env, { GITHUB_REPOSITORY: CUSTOMER_REPO, GITHUB_TOKEN: "ghs_for_the_firm", MYNT_BRANCH: `mynt/desk-${job.id.slice(0, 8)}` });
  await w.real.desk.tick();
  assert.ok(agentBox.agentRunning);
  assert.ok(!agentBox.commands.some((c) => c.command === SETUP) && ![...agentBox.files.keys()].some((f) => f.includes(".mynt-scratch")), "no scratch repository in a firm's sandbox");
  w.sandboxes.finishAgent(agentBox.id, "success", 1);
  await w.real.desk.tick();
  await w.real.desk.tick();
  const [verifyBox] = w.boxes("mynt-desk-verify-");
  const run = verifyBox.files.get(`${DESK}/run.sh`);
  assert.ok(run.includes(`clone -q --depth 1 --branch 'mynt/desk-${job.id.slice(0, 8)}' https://github.com/${CUSTOMER_REPO}.git /home/user/workspace`), run);
  assert.ok(run.includes("rm -f /home/user/.mynt-git-credentials") && !run.includes("bundle"));
  assert.ok(!agentBox.commands.some((c) => /rev-parse|bundle create/.test(c.command)), "nothing is packed out of a firm's agent sandbox");
  verifyBox.procRunning = false;
  w.sandboxes.write(verifyBox.id, `${DESK}/job/outcome.json`, deskReport());
  await w.real.desk.tick();
  const finished = await w.real.desk.job(job.id);
  assert.equal(finished.status, "finished");
  assert.equal(finished.pr_url, `https://github.com/${CUSTOMER_REPO}/pull/1`, "Mynt opened the firm's pull request");
  assert.deepEqual(w.repos.calls.map((c) => c[0]), ["installationFor", "tokenFor", "tokenFor", "openPullRequest"]);
  assert.equal(await w.count("bench_desk_jobs"), 0);
});

// ---- the scratch repository's commands, against real git ----

test("the scratch repository's commands work with real git: clone by the GitHub address with and without .git, push a branch, pack it, check it out from the bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "mynt-scratch-"));
  const home = join(root, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file" };
  const sh = (script, cwd = root) => spawnSync("bash", ["-c", script], { cwd, env, encoding: "utf8", timeout: 60000 });
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=agent", "-c", "user.email=agent@example.com", ...args], { cwd, env, encoding: "utf8", timeout: 60000 }).trim();
  const bare = join(root, "scratch.git");
  const seed = join(root, "seed");
  mkdirSync(join(seed, "models/underwriting"), { recursive: true });
  writeFileSync(join(seed, "models/underwriting/model.json"), JSON.stringify({ name: "underwriting", decide: "python3 decide.py" }));

  // Mynt makes the repository. Twice gives the same first commit (the same files always do) and one set of rules.
  const first = sh(scratchSetupScript({ bare, seedDir: seed }));
  assert.equal(first.status, 0, first.stderr);
  const base = first.stdout.trim().split("\n").pop();
  assert.match(base, /^[0-9a-f]{40}$/);
  const again = sh(scratchSetupScript({ bare, seedDir: seed }));
  assert.equal(again.stdout.trim().split("\n").pop(), base, "a fixed author and date: the baseline is the same commit in every sandbox");
  const rules = git(root, "config", "--global", "--get-all", `url.file://${bare}.insteadOf`).split("\n");
  assert.deepEqual(rules, scratchAddresses());
  assert.ok(existsSync(join(seed, "models/underwriting/model.json")) && !existsSync(join(seed, ".git")));

  // The agent follows its unchanged instructions: clone the GitHub address (either spelling), branch, commit, push.
  for (const [n, address] of [`https://github.com/${SCRATCH_REPOSITORY}.git`, `https://github.com/${SCRATCH_REPOSITORY}`, `https://x-access-token:${SCRATCH_TOKEN}@github.com/${SCRATCH_REPOSITORY}.git`, `git@github.com:${SCRATCH_REPOSITORY}.git`].entries()) {
    const dir = join(root, `clone-${n}`);
    git(root, "clone", "-q", address, dir);
    assert.equal(git(dir, "rev-parse", "HEAD"), base, address);
    assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.ok(existsSync(join(dir, "models/underwriting/model.json")));
  }
  const work = join(root, "clone-1");
  const branch = "mynt/desk-1a2b3c4d";
  assert.equal(sh(scratchHeadCommand(branch, bare)).status, 1, "before the push Mynt finds no branch");
  git(work, "checkout", "-q", "-b", branch);
  mkdirSync(join(work, "models/cd-economics"), { recursive: true });
  writeFileSync(join(work, "models/cd-economics/model.json"), JSON.stringify({ name: "cd-economics", run: "python3 main.py" }));
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "A feasibility model");
  git(work, "push", "-q", "origin", branch);
  const head = git(work, "rev-parse", "HEAD");

  // Mynt reads the branch, packs that commit, and its clean sandbox checks out exactly it from the bundle.
  const read = sh(scratchHeadCommand(branch, bare));
  assert.equal(read.status, 0, read.stderr);
  assert.equal(read.stdout.trim(), head);
  const file = join(root, "out", "desk.bundle");
  const packed = sh(scratchPackScript({ bare, commit: head, ref: "refs/mynt/desk-1a2b3c4d", file }));
  assert.equal(packed.status, 0, packed.stderr);
  const sha256 = packed.stdout.trim().split("\n").pop().split(/\s+/)[0];
  assert.equal(sha256, createHash("sha256").update(readFileSync(file)).digest("hex"));
  const clean = join(root, "clean");
  mkdirSync(clean);
  const bundle = { url: "https://files.example/desk.bundle", sha256, commit: head, ref: "refs/mynt/desk-1a2b3c4d" };
  const checkout = (b, repoDir) => sh(`${scratchCheckoutScript(b, { dir: clean, repoDir, fetch: `cp '${file}' ${clean}/source.bundle` }).join("\n")}\nexit $status`);
  const out = checkout(bundle, join(clean, "workspace"));
  assert.equal(out.status, 0, readFileSync(join(clean, "clone.log"), "utf8"));
  assert.equal(git(join(clean, "workspace"), "rev-parse", "HEAD"), head);
  assert.ok(existsSync(join(clean, "workspace/models/cd-economics/model.json")) && existsSync(join(clean, "workspace/models/underwriting/model.json")));
  // The baseline can be packed out of the same repository (the explorer's baseline is scored this way).
  const baseFile = join(root, "out", "score-0.bundle");
  const basePacked = sh(scratchPackScript({ bare, commit: base, ref: "refs/mynt/score-0", file: baseFile }));
  assert.equal(basePacked.status, 0, basePacked.stderr);
  // A bundle that isn't the one Mynt packed, or doesn't hold the commit Mynt pinned, is refused before anything runs.
  assert.notEqual(checkout({ ...bundle, sha256: "0".repeat(64) }, join(clean, "tampered")).status, 0);
  assert.notEqual(checkout({ ...bundle, commit: "d".repeat(40) }, join(clean, "other")).status, 0);
  // The script the sandbox really runs fetches over https and nothing else.
  assert.ok(scratchCheckoutScript(bundle, { dir: clean }).join("\n").includes(`curl -fsSL '${bundle.url}' -o ${clean}/source.bundle`));
});

// ---- Job 2: the algorithm explorer ----

const EXPLORER_TASKS = ["knockouts-for-net-margin", "risk-pricing-for-margin-rate", "wider-eligibility-under-a-loss-ceiling", "limits-for-approved-volume"];
// One fixed holdout for every exploration here (each job's secret is random on purpose; a test pins it so that what
// is asserted is the scoring rule, not the luck of the draw).
const PINNED_SECRET = createHash("sha256").update("mynt benchmarks-scratch test: a fixed holdout, second draw").digest("hex");
const declined = (reason) => ({ approve: false, reason_codes: [reason] });
// What each baseline fixture decides (decide.py, in JavaScript), and a stand-in explorer's better variant.
const BASELINES = {
  "approve-everyone": (a) => ({ approve: true, limit: a.requested_amount, reason_codes: [] }),
  "flat-price": (a) => (a.bureau_score === null ? declined("NO_CREDIT_HISTORY") : a.bureau_score < 650 ? declined("LOW_BUREAU_SCORE") : { approve: true, apr_pct: 18, grade: "A", reason_codes: [] }),
  "strict-eligibility": (a) => {
    const reasons = [...(a.bureau_score === null ? ["NO_CREDIT_HISTORY"] : a.bureau_score < 740 ? ["LOW_BUREAU_SCORE"] : []), ...(a.tenure_months < 36 ? ["SHORT_TENURE"] : [])];
    return reasons.length ? { approve: false, reason_codes: reasons } : { approve: true, reason_codes: [] };
  },
  "flat-limit": (a) => (a.bureau_score === null ? declined("NO_CREDIT_HISTORY") : a.bureau_score < 650 ? declined("LOW_BUREAU_SCORE") : { approve: true, limit: Math.min(50000, a.requested_amount), reason_codes: [] }),
};
const knockout = (a) => ((a.bureau_score ?? 0) >= 650 ? { approve: true, grade: "A", reason_codes: [] } : declined("LOW_BUREAU_SCORE"));
const explorerTask = (id) => taskSetFor("algorithm-explorer").tasks.find((t) => t.id === id);
const baselineOf = (id) => BASELINES[explorerTask(id).baseline_dir.split("/").pop()];
const holdoutScore = (id, decide) => {
  const t = explorerTask(id);
  const { params, economics } = datasetInputs({ product: t.product, definition: { core_algorithms: [t.algorithm] } }, t.terms.inputs);
  const h = generateDataset(params, splitKeys(PINNED_SECRET).holdout, "h");
  return scoreWithStability(h.applicants, h.truth, h.applicants.map((a) => ({ id: a.id, ...decide(a) })), { objective: { maximise: t.objective }, economics, constraints: t.constraints });
};

test("the explorer task set is built from the repository's own seed data, and each baseline fixture runs as Mynt runs it", () => {
  const set = taskSetFor("algorithm-explorer");
  assert.deepEqual(set.tasks.map((t) => t.id), EXPLORER_TASKS);
  assert.deepEqual(set.workspaces, ["algorithm-explorer"]);
  const ideas = JSON.parse(readFileSync(new URL("../workspaces/coding-build/templates/product-ideas.seed.json", import.meta.url), "utf8")).ideas;
  assert.equal(new Set(set.tasks.map((t) => t.angle)).size, 4, "a different angle each");
  assert.equal(new Set(set.tasks.map((t) => t.objective)).size, 4, "and a different objective");
  for (const t of set.tasks) {
    assert.equal(t.product.name, ideas.find((i) => i.id === t.idea).product_name, t.id);
    assert.ok(explorationAngles().some((a) => a.id === t.angle));
    const files = baselineFiles(t.baseline_dir);
    assert.deepEqual(Object.keys(files).sort(), [`${t.algorithm.repository}/decide.py`, `${t.algorithm.repository}/model.json`]);
  }
  const load = () => JSON.parse(readFileSync(join(BENCHMARKS_DIR, "algorithm-explorer.v1.json"), "utf8"));
  const errors = (change) => {
    const data = load();
    change(data);
    return taskSetErrors("algorithm-explorer.v1.json", data).join("\n");
  };
  assert.equal(errors(() => undefined), "");
  assert.match(errors((s) => (s.tasks[0].angle = "guess_harder")), /isn't an exploration angle/);
  assert.match(errors((s) => (s.tasks[0].objective = "vibes")), /must be equal to one of the allowed values/);
  assert.match(errors((s) => (s.tasks[0].algorithm.purpose = "interest_calculation")), /must be equal to one of the allowed values/);
  assert.match(errors((s) => (s.tasks[0].algorithm.repository = "models/nowhere")), /no readable models\/nowhere\/model.json/);
  assert.match(errors((s) => delete s.tasks[0].constraints.apr_cap_pct), /must have required property 'apr_cap_pct'/);
  assert.match(errors((s) => (s.tasks[0].baseline_dir = "../somewhere")), /must match pattern/);
  assert.match(errors((s) => (s.tasks[0].product.risk_level = "spicy")), /fails Mynt's product checks/);

  // Each fixture, run by Mynt's own decide runner in a real repository, decides exactly what this file says it does.
  const t0 = explorerTask(EXPLORER_TASKS[0]);
  const { params } = datasetInputs({ product: t0.product, definition: {} }, t0.terms.inputs);
  const applicants = generateDataset(params, "cd".repeat(32), "h", 300).applicants;
  for (const t of set.tasks) {
    const repo = mkdtempSync(join(tmpdir(), "mynt-baseline-"));
    for (const [path, text] of Object.entries(baselineFiles(t.baseline_dir))) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    const job = mkdtempSync(join(tmpdir(), "mynt-baseline-job-"));
    writeFileSync(join(job, "applicants.jsonl"), applicants.map((x) => JSON.stringify(x)).join("\n"));
    writeFileSync(join(job, "run-decide.mjs"), DECIDE_RUNNER);
    const r = spawnSync(process.execPath, [join(job, "run-decide.mjs"), repo, job, t.algorithm.repository], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const outcome = JSON.parse(readFileSync(join(job, "outcome.json"), "utf8"));
    assert.equal(outcome.outcome, "ran", `${t.id}: ${outcome.error} ${outcome.log}`);
    const decisions = readFileSync(join(job, "decisions.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(decisions, applicants.map((a) => ({ id: a.id, ...baselineOf(t.id)(a) })), t.id);
  }
});

test("the benchmark's explorer has its own tables", () => {
  assert.equal(benchSql(`${T}.explore_jobs j JOIN ${T}.explore_variants v`), `${T}.bench_explore_jobs j JOIN ${T}.bench_explore_variants v`);
  const src = readFileSync(new URL("../src/explore.ts", import.meta.url), "utf8");
  for (const [, table] of src.matchAll(/CREATE TABLE IF NOT EXISTS financial_products\.([a-z_]+)/g)) assert.equal(benchSql(`${T}.${table}`), `${T}.bench_${table}`, table);
  for (const [, index] of src.matchAll(/INDEX IF NOT EXISTS\s+([a-z_0-9]+)/g)) assert.notEqual(benchSql(index), index, index);
});

// A stand-in explorer and Mynt's scoring sandboxes. `explorer[task]`: { push: false } or { decide } (what the pushed
// variant decides) or { error } (the pushed variant doesn't run); the baseline is always the fixture's own decisions.
const PUSHED = "e".repeat(40);
const explorerPlay = (w, byTask) => async (taskId, s) => {
  const o = byTask[taskId] ?? {};
  const name = s.opts.name;
  if (name.startsWith("mynt-explore-explorer-") && s.agentRunning && !s.played) {
    s.played = true;
    s.cost = 0.1;
    if (o.push !== false) s.refs.set(s.opts.env.MYNT_BRANCH, PUSHED);
    w.sandboxes.finishAgent(s.id, o.exit ?? "success", o.cost ?? 2);
  }
  if (name.startsWith("mynt-explore-score-") && s.procRunning) {
    s.procRunning = false;
    s.cost = 0.03;
    const k = Number(/^mynt-explore-score-(\d)/.exec(name)[1]);
    const commit = /checkout -q --detach ([0-9a-f]{40})/.exec(s.files.get(`${EXPLORE}/run.sh`))[1];
    if (o.lost === k) return w.sandboxes.write(s.id, `${EXPLORE}/job/outcome.json`, s.files.get(`${EXPLORE}/clone-failed.json`));
    if (k === 1 && o.error) return w.sandboxes.write(s.id, `${EXPLORE}/job/outcome.json`, { outcome: "error", commit, error: o.error, log: "" });
    const decide = k === 0 ? baselineOf(taskId) : o.decide;
    const applicants = s.files.get(`${EXPLORE}/job/applicants.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    w.sandboxes.write(s.id, `${EXPLORE}/job/decisions.jsonl`, applicants.map((a) => JSON.stringify({ id: a.id, ...decide(a) })).join("\n"));
    w.sandboxes.write(s.id, `${EXPLORE}/job/outcome.json`, { outcome: "ran", commit, decisions: applicants.length, log: "" });
  }
};
const pinHoldout = (w) => () => w.pg.query(`UPDATE ${T}.bench_explore_jobs SET dataset = jsonb_set(dataset, '{secret}', to_jsonb($1::text)) WHERE status = 'queued'`, [PINNED_SECRET]);

test("an algorithm-explorer run: Mynt seeds the baseline into a scratch repository, pins and scores what was pushed on the holdout, and only that decides each task", async () => {
  const w = await world();
  const listed = (await w.call("list_benchmark_runs", {})).data.agents.find((a) => a.agent === "algorithm-explorer");
  assert.deepEqual([listed.ready, listed.tasks, listed.max_task_usd], [true, 4, 6.66], "one explorer's share of EXPLORE_CAP_USD (20 over 3)");

  // The scenario, on the pinned holdout, by Mynt's own scorer: what the stand-in explorers push below.
  const t1 = { base: holdoutScore(EXPLORER_TASKS[0], baselineOf(EXPLORER_TASKS[0])), mine: holdoutScore(EXPLORER_TASKS[0], knockout) };
  assert.equal(t1.base.eligible, false, "approving everyone goes over the task's loss ceiling");
  assert.equal(t1.mine.eligible, true, JSON.stringify(t1.mine.checks));
  const greedy = (a) => ({ ...baselineOf(EXPLORER_TASKS[1])(a), ...((a.bureau_score ?? 0) >= 650 ? { apr_pct: 30 } : {}) });
  const t2 = { base: holdoutScore(EXPLORER_TASKS[1], baselineOf(EXPLORER_TASKS[1])), mine: holdoutScore(EXPLORER_TASKS[1], greedy) };
  assert.ok(t2.base.eligible && !t2.mine.eligible && t2.mine.objective.value > t2.base.objective.value, "pricing over the cap earns more and isn't eligible");
  assert.equal(holdoutScore(EXPLORER_TASKS[2], baselineOf(EXPLORER_TASKS[2])).eligible, true);

  const runId = await start(w, { agent: "algorithm-explorer", cap_usd: 25 });
  const done = await drive(
    w,
    runId,
    explorerPlay(w, {
      [EXPLORER_TASKS[0]]: { decide: knockout, exit: "error_max_turns" }, // it ran out of turns; what it pushed still counts
      [EXPLORER_TASKS[1]]: { decide: greedy },
      [EXPLORER_TASKS[2]]: { decide: baselineOf(EXPLORER_TASKS[2]) }, // pushes the baseline back unchanged
      [EXPLORER_TASKS[3]]: { push: false },
    }),
    { before: pinHoldout(w) },
  );
  assert.equal(done.run.status, "finished");
  const [better, overCap, unchanged, silent] = done.tasks;

  // Passed: eligible on the holdout, above a baseline that isn't. The figures are Mynt's scorer's, to the digit.
  assert.equal(better.status, "passed", JSON.stringify(better));
  assert.deepEqual(better.checks.map((c) => [c.name, c.status]), [["product_checks", "pass"], ["explorer_exit", "warn"], ["branch_pushed", "pass"], ["baseline_scored", "pass"], ["mynt_holdout_run", "pass"], ["constraints_hold", "pass"], ["beats_baseline", "pass"]]);
  assert.deepEqual(better.observed, {
    job_status: "finished",
    objective: "net_margin",
    explorer: { commit: PUSHED, scored: true, eligible: true, value: t1.mine.objective.value },
    baseline: { commit: SEEDED, scored: true, eligible: false, value: t1.base.objective.value },
  });
  assert.equal(better.cost_usd, 2.16, "the explorer's model spend, its sandbox, and Mynt's two scoring sandboxes");
  assert.equal(better.cap_usd, 6.66);
  // Failed on the agent's account, each by a check of Mynt's.
  assert.deepEqual([overCap.status, overCap.failure_class, overCap.failed_check], ["failed", "agent", "constraints_hold"]);
  assert.match(overCap.detail, /Fails on the holdout: apr_cap/);
  assert.deepEqual([unchanged.status, unchanged.failure_class, unchanged.failed_check], ["failed", "agent", "beats_baseline"]);
  assert.match(unchanged.detail, /approval_rate ([\d.]+) against the baseline's \1/, "an unchanged copy of an eligible baseline doesn't pass");
  assert.deepEqual([silent.status, silent.failure_class, silent.failed_check], ["failed", "agent", "branch_pushed"]);
  assert.equal(silent.observed.explorer.scored, false);
  assert.equal(silent.observed.baseline.scored, true);
  assert.equal(done.scoreboard.pass_rate, 0.25);
  assert.ok(done.run.charged_usd <= done.run.cap_usd);

  // The explorer's sandbox: the unchanged workspace, the baseline as the scratch repository's first commit, no token.
  const [box] = w.boxes("mynt-explore-explorer-1-");
  assert.deepEqual(Object.keys(box.opts.env).sort(), ["GITHUB_REPOSITORY", "MYNT_BRANCH", "MYNT_GIT_TOKEN_FILE"]);
  assert.equal(box.opts.env.GITHUB_REPOSITORY, SCRATCH_REPOSITORY);
  assert.equal(box.files.get(TOKEN_FILE), SCRATCH_TOKEN);
  assert.equal(box.files.get("/home/user/workspaces/algorithm-explorer/CLAUDE.md"), readFileSync(new URL("../workspaces/algorithm-explorer/CLAUDE.md", import.meta.url), "utf8"));
  const ran = box.commands.map((c) => c.command);
  assert.ok(ran.indexOf(SETUP) >= 0 && ran.indexOf(SETUP) < ran.findIndex((c) => c.includes("runner.mjs")));
  for (const [path, text] of Object.entries(baselineFiles(explorerTask(EXPLORER_TASKS[0]).baseline_dir))) assert.equal(box.files.get(`/home/user/.mynt-scratch/seed/${path}`), text, path);
  const spec = JSON.parse(box.files.get("/home/user/workspaces/algorithm-explorer/job/explore.json"));
  assert.equal(spec.base_ref, SEEDED, "the explorer starts from the commit Mynt made");
  assert.deepEqual([spec.angle.id, spec.objective.maximise, spec.model_dir, spec.explorer], ["tighten_knockouts", "net_margin", "models/underwriting", 1]);
  assert.deepEqual(spec.constraints, { max_loss_rate_pct: 2.5, max_loss_rate_source: "the job", apr_cap_pct: 24, apr_cap_source: "the job", min_adverse_impact_ratio: 0.8 });
  const everything = [...box.files.values()].join("\n");
  assert.ok(!/"h-\d{6}"/.test(everything) && !everything.includes(PINNED_SECRET), "nothing of the holdout reaches the explorer");
  // Mynt stopped the explorer, kept its sandbox until the commits were out, and stopped it when the job ended.
  assert.ok(ran.some((c) => c.includes("pkill -KILL -f '/home/user/mynt-agent/[r]unner.mjs'")));
  assert.ok(box.stopped);
  // Scoring: the baseline and the pushed commit, each packed out of the explorer's sandbox by Mynt and checked out
  // by sha256 and commit in a clean sandbox with only the holdout's features.
  for (const [k, commit] of [[0, SEEDED], [1, PUSHED]]) {
    assert.ok(ran.some((c) => c.includes(`update-ref refs/mynt/score-${k} ${commit}`)), `score-${k}`);
    const [score] = w.boxes(`mynt-explore-score-${k}-`);
    assert.deepEqual(score.opts.env, {});
    const run = score.files.get(`${EXPLORE}/run.sh`);
    assert.ok(run.includes(`/home/user/.mynt-scratch/out/score-${k}.bundle?sig=x`) && run.includes(`= "${BUNDLE_SHA}" ]`) && run.includes(`checkout -q --detach ${commit}`), run);
    assert.ok(!run.includes("github.com"));
    assert.ok(!score.files.get(`${EXPLORE}/job/applicants.jsonl`).includes("defaulted"));
  }
  assert.equal(w.boxes("mynt-explore-score-1-").length, 3, "nothing pushed, nothing of the explorer's to score");

  // No GitHub, no real firm's records or budget, no real exploration.
  assert.deepEqual(w.repos.calls, []);
  for (const table of ["explore_jobs", "explore_variants", "desk_workspaces", "bench_desk_workspaces", "product_terms", "desk_jobs"]) assert.equal(await w.count(table), 0, table);
  assert.equal(await w.count("bench_explore_jobs"), 4);
  assert.equal(await w.count("bench_explore_variants", "pr_url IS NOT NULL"), 0);
  const drafts = (await w.pg.query(`SELECT p.id, p.status, e.name FROM ${T}.products p JOIN ${T}.entities e ON e.id = p.entity_id WHERE p.id LIKE 'benchmark-explore-%' ORDER BY p.id`)).rows;
  assert.deepEqual(drafts.map((d) => [d.status, d.name]), Array(4).fill(["draft", "Mynt benchmarks (not a firm)"]));
  const firm = (await w.store.getSetting("benchmarks:identity")).entity_id;
  assert.equal(await w.real.desk.monthCommitted(firm), 0, "nothing is counted in any real month's desk budget");
  await assert.rejects(w.benchmarks.explore.adopt({ entity_id: firm }, (await w.pg.query(`SELECT id FROM ${T}.bench_explore_jobs LIMIT 1`)).rows[0].id, 1), /no repository to open a pull request in/);
});

test("an explorer task never gets more than the run's cap has left; spending past it is the agent's failure, and failures that aren't the explorer's aren't held against it", async () => {
  const w = await world();
  const runId = await start(w, { agent: "algorithm-explorer", cap_usd: 3, task_ids: [EXPLORER_TASKS[0], EXPLORER_TASKS[1]] });
  let seen = null;
  const play = explorerPlay(w, { [EXPLORER_TASKS[0]]: { decide: knockout, cost: 5 } });
  const done = await drive(
    w,
    runId,
    async (taskId, s) => {
      if (s.opts.name.startsWith("mynt-explore-explorer-") && s.agentRunning && !seen) {
        // What the service itself wrote and handed over, before the stand-in explorer does anything.
        const job = (await w.pg.query(`SELECT id, cap_usd FROM ${T}.bench_explore_jobs`)).rows[0];
        const token = JSON.parse(s.files.get(`${A}/auth.json`)).token;
        seen = { cap: Number(job.cap_usd), budget: JSON.parse(s.files.get(`${A}/config.json`)).budgetUsd, run: await w.benchmarks.agentRun(token), real: await w.real.explore.agentRun(token), key: `explore:${job.id}` };
      }
      await play(taskId, s);
    },
    { before: pinHoldout(w) },
  );
  assert.equal(seen.cap, 3, "the job's own cap is what the run had left, not the explorer's usual share");
  assert.equal(seen.budget, 2.7, "the explorer is launched with nine tenths of it; the rest is for Mynt's scoring sandboxes");
  assert.deepEqual(seen.run, { key: seen.key, capUsd: 3 }, "the agent proxy meters the explorer's token against that same cap");
  assert.equal(seen.real, null, "a benchmark explorer's token is nothing to the real explorer service");
  assert.deepEqual([done.tasks[0].status, done.tasks[0].failure_class, done.tasks[0].failed_check], ["failed", "agent", "budget"]);
  assert.match(done.tasks[0].detail, /over the US\$3 cap/);
  assert.equal(done.run.status, "stopped_at_cap");
  assert.equal(done.tasks[1].status, "not_run");
  // Asked for more than an exploration may spend, the service clamps it.
  const firm = await w.store.getSetting("benchmarks:identity");
  const user = { ...(await w.store.getUser(firm.user_id)), entity_id: firm.entity_id };
  const t = explorerTask(EXPLORER_TASKS[0]);
  const big = await w.benchmarks.explore.start(user, { product_id: `benchmark-explore-${t.id}`, algorithm_id: t.algorithm._id, constraints: t.constraints, explorers: 1, cap_usd: 999, angles: [t.angle] });
  assert.equal(Number(big.cap_usd), 20, "EXPLORE_CAP_USD");
  await w.benchmarks.explore.stop(big.id, "test over");
  await assert.rejects(w.benchmarks.explore.start(user, { product_id: `benchmark-explore-${t.id}`, algorithm_id: t.algorithm._id, angles: ["guess_harder"] }), /No exploration angle 'guess_harder'/);
  assert.equal(await w.count("bench_explore_jobs"), 2, "a refused start leaves no job behind");

  // Mynt couldn't get the pushed commit into its scoring sandbox, then couldn't score its own baseline: neither is
  // the explorer's failure.
  const w2 = await world();
  const second = await start(w2, { agent: "algorithm-explorer", cap_usd: 20, task_ids: [EXPLORER_TASKS[0], EXPLORER_TASKS[2]] });
  const out = await drive(w2, second, explorerPlay(w2, { [EXPLORER_TASKS[0]]: { decide: knockout, lost: 1 }, [EXPLORER_TASKS[2]]: { decide: knockout, lost: 0 } }), { before: pinHoldout(w2) });
  assert.deepEqual([out.tasks[0].status, out.tasks[0].failure_class, out.tasks[0].failed_check], ["failed", "infrastructure", "infrastructure"]);
  assert.match(out.tasks[0].detail, /mynt_holdout_run \(Couldn't check out commit eeeeeee\)/);
  assert.deepEqual([out.tasks[1].status, out.tasks[1].failure_class], ["failed", "infrastructure"]);
  assert.match(out.tasks[1].detail, /baseline_scored/);
  assert.equal(out.scoreboard.pass_rate, null, "nothing was scored on the agent's account: null, never 0");
});

// ---- a sandbox host that refuses every VM ----

test("a sandbox host that refuses every VM: a desk job or an exploration that never got a sandbox charges nothing, with no 0 shown as a measured cost, and the next run is refused", async () => {
  for (const agent of ["product-desk", "algorithm-explorer"]) {
    const w = await world();
    w.sandboxes.createSandbox = async () => {
      throw new Error("host: 429 LIMIT_EXCEEDED on creating a VM");
    };
    const runId = await start(w, { agent, cap_usd: 20 });
    const done = await drive(w, runId, async () => undefined);
    assert.deepEqual([done.run.status, done.run.stop_reason], ["stopped", "The sandbox provider has used up this account's allowance; an admin must add billing in its dashboard."], agent);
    const [first, ...rest] = done.tasks;
    assert.deepEqual([first.status, first.failure_class, first.sandbox_started], ["failed", "infrastructure", false], agent);
    assert.ok(first.cap_usd > 0 && rest.every((t) => t.status === "not_run"), agent);
    assert.deepEqual([first.cost_usd, first.reserved_usd, first.cost_note], [null, null, "Not measured: no sandbox started for this task, so nothing ran, and nothing is counted against the run's cap"], agent);
    assert.deepEqual([done.run.charged_usd, done.run.measured_usd, done.run.reserved_usd, done.run.charged_note, done.scoreboard.cost_usd], [0, 0, 0, null, null], agent);
    assert.equal(w.sandboxes.sandboxes.size, 0, agent);
    const again = await w.call("start_benchmark_run", { agent: agent === "product-desk" ? "algorithm-explorer" : "product-desk", cap_usd: 20 });
    assert.equal(again.isError, true, agent);
    assert.match(again.data.error, /sandbox host's allowance is used up: the last benchmark run to ask it for a sandbox .* start the run with host_restored: true/, agent);
  }
});

// ---- a task's cap is clamped inside the services themselves ----

test("a task's cap is the service's own job cap, the budget the agent is launched with and the cap the agent proxy meters against: builds, the desk and the connector", async () => {
  const launched = (box) => ({ budget: JSON.parse(box.files.get(`${A}/config.json`)).budgetUsd, token: JSON.parse(box.files.get(`${A}/auth.json`)).token });
  const until = async (w, prefix) => {
    for (let i = 0; i < 40; i++) {
      await w.benchmarks.tick();
      const box = w.boxes(prefix).find((b) => b.files.has(`${A}/config.json`));
      if (box) return box;
    }
    throw new Error(`no ${prefix} agent was launched`);
  };
  const stop = (w, runId) => w.call("stop_benchmark_run", { run_id: runId, reason: "seen what was needed" });
  const identity = async (w) => {
    const kept = await w.store.getSetting("benchmarks:identity");
    return { ...(await w.store.getUser(kept.user_id)), entity_id: kept.entity_id ?? null };
  };

  // Builds: BUILD_CAP_USD is 10; the run has 2.
  const w = await world();
  let runId = await start(w, { agent: "coding", cap_usd: 2, task_ids: ["two-key-household-fund"] });
  let box = await until(w, "mynt-build-");
  const build = (await w.pg.query(`SELECT id, cap_usd, app_id FROM ${T}.bench_build_runs`)).rows[0];
  assert.equal(Number(build.cap_usd), 2);
  assert.equal(launched(box).budget, 2);
  assert.deepEqual(await w.benchmarks.agentRun(launched(box).token), { key: `build:${build.id}`, capUsd: 2 });
  assert.equal(await w.real.builds.agentRun(launched(box).token), null);
  await stop(w, runId);
  const more = await w.benchmarks.builds.start(await identity(w), { goal: "A second build of the same benchmark app, asking for far too much", app_id: build.app_id, cap_usd: 999 });
  assert.equal(more.cap_usd, 10, "the build service clamps to BUILD_CAP_USD");
  await w.benchmarks.builds.stop(more, "test over");

  // The desk: DESK_JOB_CAP_USD is 5; the run has 2.
  runId = await start(w, { agent: "product-desk", cap_usd: 2, task_ids: ["gig-worker-no-penalty-cd"] });
  box = await until(w, "mynt-desk-agent-");
  const job = (await w.pg.query(`SELECT id, cap_usd, product_id FROM ${T}.bench_desk_jobs`)).rows[0];
  assert.equal(Number(job.cap_usd), 2);
  assert.equal(launched(box).budget, 2);
  assert.deepEqual(await w.benchmarks.agentRun(launched(box).token), { key: `desk:${job.id}`, capUsd: 2 });
  assert.equal(await w.real.desk.agentRun(launched(box).token), null);
  await stop(w, runId);
  const greedy = await w.benchmarks.desk.start(await identity(w), { kind: "agent", product_id: job.product_id, goal: "The same model again, asking for far too much", cap_usd: 999 });
  assert.equal(Number(greedy.cap_usd), 5, "the desk clamps to DESK_JOB_CAP_USD");
  await w.benchmarks.desk.stop(greedy.id, "test over");

  // The connector: BD_RUN_CAP_USD is 3; the run has 2, of which 0.5 is kept for the overshoot the connector allows.
  runId = await start(w, { agent: "connector", cap_usd: 2, task_ids: [taskSetFor("connector").tasks[0].id] });
  box = await until(w, "mynt-bd-");
  const session = (await w.pg.query(`SELECT id, cap_usd FROM ${T}.bench_bd_runs`)).rows[0];
  assert.equal(Number(session.cap_usd), 1.5);
  assert.equal(launched(box).budget, 1.5);
  assert.deepEqual(await w.benchmarks.agentRun(launched(box).token), { key: `bd:${session.id}`, capUsd: 1.5 });
  await stop(w, runId);
  // Whatever the harness asked for, the benchmark's connector never gives a session more than BD_RUN_CAP_USD.
  w.benchmarks.connectorCapUsd = 999;
  assert.equal(w.benchmarks.connector.config.runCapUsd, 3);
  await w.pg.query(`DELETE FROM ${T}.bench_bd_runs`);
  await w.benchmarks.connector.requestRun();
  await w.benchmarks.connector.tick();
  assert.equal(Number((await w.pg.query(`SELECT cap_usd FROM ${T}.bench_bd_runs`)).rows[0].cap_usd), 3);
  assert.equal(await w.count("build_runs") + (await w.count("desk_jobs")) + (await w.count("bd_runs")), 0, "none of it is in a real queue");
});
