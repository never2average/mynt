import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DESK_RUNNER } from "../dist/desk-runner.js";
import { DeskService, deskConfigFromEnv, termsHash } from "../dist/desk.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

const DIR = "/home/user/mynt-desk";
const JOB = `${DIR}/job`;
const A = "/home/user/mynt-agent";

// A small consumer-loan model, as a firm's workspace would hold it.
const LOAN_MODEL = {
  "model.json": JSON.stringify({
    name: "loan-pricing",
    description: "Pricing build-up and RAROC for unsecured loans",
    applies_to: { product_lines: ["credit"] },
    inputs: [
      { key: "apr_pct", required: true, unit: "%" },
      { key: "cost_of_funds_pct", required: true, unit: "%" },
      { key: "expected_pd_pct", required: true, unit: "%" },
      { key: "lgd_pct", required: true, unit: "%" },
      { key: "opex_pct", required: true, unit: "%" },
    ],
    run: "python3 main.py",
  }),
  "main.py": `import json, os
d = json.load(open(os.environ["MYNT_INPUT"]))
i = d["inputs"]
el = i["expected_pd_pct"] * i["lgd_pct"] / 100
margin = i["apr_pct"] - i["cost_of_funds_pct"] - el - i["opex_pct"]
stress = i["apr_pct"] - i["cost_of_funds_pct"] - 2 * el - i["opex_pct"]
cap = next((r for r in d["regulatory"] if isinstance(r, dict) and r.get("legal_ref") == "rbi_fair_practices"), None)
json.dump({
  "verdict": "feasible" if stress > 0 else ("marginal" if margin > 0 else "infeasible"),
  "summary": f"Margin {margin:.2f}% after expected loss {el:.2f}%",
  "metrics": {"expected_loss_pct": round(el, 4), "net_margin_pct": round(margin, 4)},
  "checks": [{"name": "fair_pricing", "status": "pass" if cap else "warn", "detail": "Fair practices code applies" if cap else "Limit not in the model", "legal_ref": "rbi_fair_practices"}],
  "scenarios": [{"name": "pd_x2", "metrics": {"net_margin_pct": round(stress, 4)}}],
}, open(os.environ["MYNT_OUTPUT"], "w"))
`,
};

function workspaceRepo(files = { "models/loan-pricing": LOAN_MODEL }) {
  const repo = mkdtempSync(join(tmpdir(), "mynt-desk-repo-"));
  for (const [dir, content] of Object.entries(files)) {
    mkdirSync(join(repo, dir), { recursive: true });
    for (const [name, text] of Object.entries(content)) writeFileSync(join(repo, dir, name), text);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "models");
  return repo;
}

function runRunner(repo, { product, terms, model }) {
  const job = mkdtempSync(join(tmpdir(), "mynt-desk-job-"));
  const runner = join(job, "desk-runner.mjs");
  writeFileSync(runner, DESK_RUNNER);
  writeFileSync(join(job, "product.json"), JSON.stringify(product));
  writeFileSync(join(job, "terms.json"), JSON.stringify(terms));
  if (model) writeFileSync(join(job, "model.txt"), model);
  const r = spawnSync(process.execPath, [runner, repo, job], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(readFileSync(join(job, "outcome.json"), "utf8"));
}

const loanProduct = { id: "quick-loan", name: "Quick Loan", product_line: "credit", category: "personal-loans", region: "IN" };
const loanTerms = { inputs: { apr_pct: 18, cost_of_funds_pct: 8, expected_pd_pct: 4, lgd_pct: 60, opex_pct: 3 }, regulatory: [{ legal_ref: "rbi_fair_practices", title: "Fair Practices Code" }] };

test("the desk runner executes the workspace's model as code and checks its report", () => {
  const repo = workspaceRepo();
  const ran = runRunner(repo, { product: loanProduct, terms: loanTerms });
  assert.equal(ran.outcome, "ran", ran.log);
  assert.equal(ran.model, "loan-pricing");
  assert.match(ran.commit, /^[0-9a-f]{40}$/);
  assert.equal(ran.report.verdict, "feasible");
  assert.equal(ran.report.metrics.expected_loss_pct, 2.4);
  assert.equal(ran.report.metrics.net_margin_pct, 4.6);
  assert.equal(ran.report.checks[0].legal_ref, "rbi_fair_practices");

  const thin = runRunner(repo, { product: loanProduct, terms: { inputs: { ...loanTerms.inputs, apr_pct: 14 } } });
  assert.equal(thin.report.verdict, "marginal", "positive margin, negative under stress");

  const missing = runRunner(repo, { product: loanProduct, terms: { inputs: { apr_pct: 18 } } });
  assert.equal(missing.outcome, "missing_inputs");
  assert.deepEqual(missing.missing.map((m) => m.key), ["cost_of_funds_pct", "expected_pd_pct", "lgd_pct", "opex_pct"]);

  const none = runRunner(repo, { product: { ...loanProduct, product_line: "insurance" }, terms: loanTerms });
  assert.deepEqual({ outcome: none.outcome, models: none.models }, { outcome: "no_model", models: ["loan-pricing"] });

  const broken = workspaceRepo({ "models/bad": { "model.json": JSON.stringify({ name: "bad", inputs: [], run: "python3 -c \"import json,os; json.dump({'verdict':'great'}, open(os.environ['MYNT_OUTPUT'],'w'))\"" }) } });
  const bad = runRunner(broken, { product: loanProduct, terms: loanTerms });
  assert.equal(bad.outcome, "error");
  assert.match(bad.error, /expected shape/);
});

// ---- the service, with stand-ins for boat.dev and GitHub ----

function fakeBoat() {
  const sandboxes = new Map();
  let n = 0;
  return {
    sandboxes,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), commands: [], running: false, stopped: false, cost: 0.02 });
      return { id, state: "provisioning" };
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
    async exec(id, command) {
      const s = sandboxes.get(id);
      s.commands.push(command);
      s.running = true;
      return { processId: 99, exitCode: null, stdout: "", stderr: "" };
    },
    async commandStatus(id) {
      return { running: sandboxes.get(id).running, exitCode: 0 };
    },
    async costDollars(id) {
      return sandboxes.get(id).cost;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    // Test controls
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    finishRun(id, outcome) {
      const s = sandboxes.get(id);
      s.running = false;
      s.files.set(`${JOB}/outcome.json`, JSON.stringify({ log: "", ...outcome }));
    },
    finishAgent(id, cost = 1.5) {
      const s = sandboxes.get(id);
      s.running = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ done: true, last_subtype: "success", cost_usd: cost, summary: "Built loan-pricing with stress scenarios" }));
    },
  };
}

function fakeRepos() {
  const prs = [];
  return {
    prs,
    async installationFor(repo) {
      return repo === "acme/desk" ? 7 : null;
    },
    async tokenFor() {
      return { token: "ghs_desk", expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    installUrl: () => "https://github.com/apps/mynt/installations/new",
    async openPullRequest(repo, installation, pr) {
      prs.push({ repo, installation, ...pr });
      return `https://github.com/${repo}/pull/3`;
    },
  };
}

const ranOutcome = (over = {}) => ({
  outcome: "ran",
  model: "loan-pricing",
  commit: "c".repeat(40),
  report: { verdict: "feasible", summary: "Margin 4.60% after expected loss 2.40%", metrics: { net_margin_pct: 4.6 }, checks: [{ name: "fair_pricing", status: "pass", detail: "ok", legal_ref: "rbi_fair_practices" }] },
  ...over,
});

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const boat = fakeBoat();
  const repos = fakeRepos();
  const host = { agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, model: "claude-opus-5-5", publicUrl: "https://mynt.example.com" };
  const desk = await DeskService.open(db, store, boat, repos, deskConfigFromEnv(host, {}));
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { desk }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
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
  const innovator = async (name) => {
    const { user } = await store.createUser(name, ["innovator"]);
    await licensed(store, user, { region: "IN", category: "personal-loans", action: "issuance" });
    const client = await connect(user);
    return { user, client };
  };
  return { store, desk, boat, repos, connect, call, innovator };
}

const loan = {
  id: "quick-loan",
  name: "Quick Loan",
  product_line: "credit",
  category: "personal-loans",
  region: "IN",
  risk_level: "not_applicable",
  liquidity: "not_applicable",
  typical_horizon: "short",
  return_type: "cost_of_credit",
  regulator: "RBI",
  description: "An unsecured personal loan for salaried borrowers, priced by risk band.",
  key_features: ["No collateral", "Disbursal in a day"],
};

test("analyze_product runs the workspace's model as code: no agent, report on the term sheet, advisory in test_product", async () => {
  const { desk, boat, call, innovator } = await setup();
  const { client } = await innovator("Ines");
  assert.equal((await call(client, "create_product", loan)).isError, false);

  assert.match((await call(client, "analyze_product", { product_id: "quick-loan" })).data.error, /Connect your firm's workspace/);
  assert.match((await call(client, "connect_desk_repository", { repository: "acme/other" })).data.error, /Install the Mynt GitHub App/);
  assert.equal((await call(client, "connect_desk_repository", { repository: "acme/desk" })).data.connected, "acme/desk");
  assert.match((await call(client, "analyze_product", { product_id: "quick-loan" })).data.error, /term sheet first/);
  const terms = (await call(client, "set_product_terms", { product_id: "quick-loan", inputs: loanTerms.inputs })).data;
  assert.equal(terms.terms_hash, termsHash({ inputs: loanTerms.inputs }));

  const job = (await call(client, "analyze_product", { product_id: "quick-loan" })).data;
  assert.equal(job.kind, "run");
  await desk.tick();
  const sbx = (await desk.job(job.id)).sandbox_id;
  assert.deepEqual(boat.sandboxes.get(sbx).opts.env, {}, "a run sandbox gets no credentials in its env");
  boat.ready(sbx);
  await desk.tick();
  const files = boat.sandboxes.get(sbx).files;
  const script = files.get(`${DIR}/run.sh`);
  assert.ok(script.indexOf("rm -f /home/user/.mynt-git-credentials") < script.indexOf("desk-runner.mjs"), "the clone token is gone before any model code runs");
  assert.ok(!script.includes("ghs_desk"), "and never on a command line");
  assert.equal(JSON.parse(files.get(`${JOB}/terms.json`)).inputs.apr_pct, 18);
  assert.ok(!files.has(`${A}/auth.json`), "no agent for a code run");

  boat.finishRun(sbx, ranOutcome());
  await desk.tick();
  const done = (await call(client, "get_desk_job", { job_id: job.id })).data;
  assert.equal(done.status, "finished");
  assert.match(done.phase_message, /^feasible/);
  assert.ok(boat.sandboxes.get(sbx).stopped);

  const tested = (await call(client, "test_product", { id: "quick-loan" })).data;
  assert.deepEqual(tested.checks.find((c) => c.name === "feasibility").status, "pass");

  await call(client, "set_product_terms", { product_id: "quick-loan", inputs: { ...loanTerms.inputs, apr_pct: 12 } });
  const stale = (await call(client, "test_product", { id: "quick-loan" })).data.checks.find((c) => c.name === "feasibility");
  assert.equal(stale.status, "warn");
  assert.match(stale.message, /term sheet changed/);
});

test("missing inputs come back as a list to fill in, not an agent run", async () => {
  const { desk, boat, call, innovator } = await setup();
  const { client } = await innovator("Ines");
  await call(client, "create_product", loan);
  await call(client, "connect_desk_repository", { repository: "acme/desk" });
  await call(client, "set_product_terms", { product_id: "quick-loan", inputs: { apr_pct: 18 } });
  const job = (await call(client, "analyze_product", { product_id: "quick-loan" })).data;
  await desk.tick();
  const sbx = (await desk.job(job.id)).sandbox_id;
  boat.ready(sbx);
  await desk.tick();
  boat.finishRun(sbx, { outcome: "missing_inputs", model: "loan-pricing", missing: [{ key: "cost_of_funds_pct", unit: "%" }, { key: "lgd_pct", unit: "%" }] });
  await desk.tick();
  const done = await desk.job(job.id);
  assert.equal(done.status, "finished");
  assert.match(done.phase_message, /needs: cost_of_funds_pct \(%\), lgd_pct \(%\)/);
  assert.equal((await desk.jobs(done.entity_id)).length, 1, "no agent job");
});

test("with no model for the product, the agent writes one; Mynt runs the agent's branch itself and opens the PR", async () => {
  const { desk, boat, repos, call, innovator } = await setup();
  const { client } = await innovator("Ines");
  await call(client, "create_product", loan);
  await call(client, "connect_desk_repository", { repository: "acme/desk" });
  await call(client, "set_product_terms", { product_id: "quick-loan", inputs: loanTerms.inputs });
  const run = (await call(client, "analyze_product", { product_id: "quick-loan" })).data;
  await desk.tick();
  const runSbx = (await desk.job(run.id)).sandbox_id;
  boat.ready(runSbx);
  await desk.tick();
  boat.finishRun(runSbx, { outcome: "no_model", models: [] });
  await desk.tick();

  const jobs = await desk.jobs(run.entity_id);
  const agentJob = jobs.find((j) => j.kind === "agent");
  assert.ok(agentJob, "handed to the desk agent");
  assert.match(agentJob.goal, /Build a feasibility model/);
  await desk.tick();
  const coding = (await desk.job(agentJob.id)).sandbox_id;
  const env = boat.sandboxes.get(coding).opts.env;
  assert.equal(env.GITHUB_REPOSITORY, "acme/desk");
  assert.match(env.MYNT_BRANCH, /^mynt\/desk-/);
  boat.ready(coding);
  await desk.tick();
  const files = boat.sandboxes.get(coding).files;
  const spec = JSON.parse(files.get("/home/user/workspaces/product-desk/job/spec.json"));
  assert.equal(spec.terms.inputs.apr_pct, 18);
  assert.ok(Array.isArray(spec.regulatory));
  const auth = JSON.parse(files.get(`${A}/auth.json`));
  assert.match(files.get("/home/user/workspaces/product-desk/CLAUDE.md"), /All arithmetic happens in code/);
  assert.ok(files.has("/home/user/workspaces/product-desk/.claude/skills/model-contract/SKILL.md"));
  assert.equal(JSON.parse(files.get(`${A}/config.json`)).cwd, "/home/user/workspaces/product-desk");
  assert.equal(await desk.agentTokenActive(auth.token), true);

  boat.finishAgent(coding, 1.5);
  await desk.tick();
  const verifying = await desk.job(agentJob.id);
  assert.equal(verifying.status, "verifying");
  const vid = verifying.verify_sandbox_id;
  assert.deepEqual(boat.sandboxes.get(vid).opts.env, {}, "the verifier gets no credentials in its env");
  boat.ready(vid);
  await desk.tick();
  assert.match(boat.sandboxes.get(vid).files.get(`${DIR}/run.sh`), new RegExp(`--branch '${verifying.branch}'`), "Mynt runs the agent's branch");
  boat.finishRun(vid, ranOutcome({ report: { ...ranOutcome().report, verdict: "marginal", summary: "Thin under stress" } }));
  await desk.tick();

  const done = await desk.job(agentJob.id);
  assert.equal(done.status, "finished");
  assert.equal(done.pr_url, "https://github.com/acme/desk/pull/3");
  assert.match(repos.prs[0].body, /run by Mynt/);
  assert.match(repos.prs[0].body, /marginal: Thin under stress/);
  assert.match(repos.prs[0].body, /\| fair_pricing \| pass \| ok \(rbi_fair_practices\) \|/);
  assert.equal(await desk.agentTokenActive(auth.token), false, "the agent's token dies with the job");
  assert.ok(Number(done.cost_usd) >= 1.5);
  const f = (await call(client, "get_product_terms", { product_id: "quick-loan" })).data;
  assert.equal(f.current.report.verdict, "marginal");
  assert.equal(f.current.ref, done.branch);
});

test("the desk is the firm's: other firms can't use your products or jobs, and budgets hold", async () => {
  const { store, desk, call, innovator, connect } = await setup();
  const { client } = await innovator("Ines");
  await call(client, "create_product", loan);
  await call(client, "connect_desk_repository", { repository: "acme/desk" });
  await call(client, "set_product_terms", { product_id: "quick-loan", inputs: loanTerms.inputs });
  const job = (await call(client, "analyze_product", { product_id: "quick-loan" })).data;

  const { client: other } = await innovator("Omar");
  assert.equal((await call(other, "set_product_terms", { product_id: "quick-loan", inputs: { apr_pct: 1 } })).isError, true);
  assert.equal((await call(other, "get_desk_job", { job_id: job.id })).isError, true);
  assert.equal((await call(other, "stop_desk_job", { job_id: job.id })).isError, true);

  const { user: dev } = await store.createUser("Dev", ["developer"]);
  const devTools = (await (await connect(dev)).listTools()).tools.map((t) => t.name);
  // Innovator and developer are one builder role (2026-11-08), so a developer gets the desk too.
  assert.ok(devTools.includes("analyze_product"), "developers are builders, with the desk");

  // US$50 a month: the run reserves US$1, nine agent tasks US$5 each; a tenth would go over.
  for (let i = 0; i < 9; i++) assert.equal((await call(client, "desk_task", { goal: `Model scenario ${i} for our loan book` })).isError, false);
  assert.match((await call(client, "desk_task", { goal: "One task too many for this month" })).data.error, /monthly desk budget/);
  assert.equal((await call(client, "stop_desk_job", { job_id: job.id })).data.stopped, job.id);
  assert.equal((await desk.job(job.id)).status, "stopped");
});
