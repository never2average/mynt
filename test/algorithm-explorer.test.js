import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { workspaceFiles } from "../dist/agent-host.js";
import { DeskService, deskConfigFromEnv } from "../dist/desk.js";
import { DATASET_SIZE, datasetInputs, generateDataset, seedsFor } from "../dist/explore-data.js";
import { SCORER_SCRIPT, scoreSet, scoreWithStability } from "../dist/explore-score.js";
import { DECIDE_RUNNER, ExploreService, explorationAngles, exploreConfigFromEnv } from "../dist/explore.js";
import { opsStatus } from "../dist/ops.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

const DIR = "/home/user/mynt-explore";
const JOB = `${DIR}/job`;
const A = "/home/user/mynt-agent";
const WS = "/home/user/workspaces/algorithm-explorer";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const params = { product_line: "credit", segments: ["salaried", "self_employed"], amount_min: 10000, amount_max: 500000, target_pd_pct: 5 };
const spec = (over = {}) => ({
  objective: { maximise: "net_margin" },
  economics: { default_apr_pct: 18, cost_of_funds_pct: 9, lgd_pct: 50, opex_pct: 1, tenor_months: 12 },
  constraints: { max_loss_rate_pct: 10, apr_cap_pct: 24, min_adverse_impact_ratio: 0.8 },
  ...over,
});

// ---- the generator ----

test("the generator is deterministic, and the dev and holdout splits never overlap", () => {
  const a = generateDataset(params, 123, "d", 500);
  const b = generateDataset(params, 123, "d", 500);
  assert.deepEqual(a, b, "same seed, same applicants and truth");
  const seeds = seedsFor("job-1", sha);
  assert.notEqual(seeds.dev, seeds.holdout);
  assert.deepEqual(seedsFor("job-1", sha), seeds, "seeds come from the job id");
  const dev = generateDataset(params, seeds.dev, "d");
  const holdout = generateDataset(params, seeds.holdout, "h");
  assert.equal(dev.applicants.length, DATASET_SIZE);
  const devIds = new Set(dev.applicants.map((x) => x.id));
  assert.ok(holdout.applicants.every((x) => !devIds.has(x.id)), "no id in both splits");
  assert.notDeepEqual(dev.applicants.map((x) => x.monthly_income).slice(0, 50), holdout.applicants.map((x) => x.monthly_income).slice(0, 50));

  for (const set of [dev, holdout]) {
    const x = set.applicants[0];
    assert.deepEqual(Object.keys(x).sort(), ["application_month", "bureau_score", "employment_type", "existing_obligations", "id", "monthly_income", "region", "requested_amount", "segment", "tenure_months"]);
    assert.ok(!("defaulted" in x) && !("protected_group" in x) && !("pd" in x), "applicants carry features only");
    const meanPd = set.truth.reduce((s, t) => s + t.pd, 0) / set.truth.length;
    assert.ok(Math.abs(meanPd - 0.05) < 0.002, `calibrated to the target default probability (${meanPd})`);
    const rate = set.truth.filter((t) => t.defaulted).length / set.truth.length;
    assert.ok(rate > 0.03 && rate < 0.07, `sampled default rate near the target (${rate})`);
    assert.ok(set.applicants.every((y) => y.requested_amount >= 10000 && y.requested_amount <= 500000 && y.application_month >= 1 && y.application_month <= 12));
    const b = set.truth.filter((t) => t.protected_group === "B").length / set.truth.length;
    assert.ok(b > 0.15 && b < 0.35, `a protected minority (${b})`);
  }
  // Riskier features mean more defaults: the low-score quartile defaults more than the high one.
  const scored = holdout.applicants.map((x, i) => ({ s: x.bureau_score, d: holdout.truth[i].defaulted })).filter((x) => x.s !== null).sort((p, q) => p.s - q.s);
  const q = Math.floor(scored.length / 4);
  const rate = (xs) => xs.filter((x) => x.d).length / xs.length;
  assert.ok(rate(scored.slice(0, q)) > 2 * rate(scored.slice(-q)));
});

test("generator inputs come from the definition and term sheet, and every default is stated", () => {
  const p = {
    product: { id: "quick-loan", product_line: "credit" },
    definition: {
      customer_segments: [{ _id: "salaried" }, { _id: "gig" }],
      terms: [{ _id: "loan_amount", type: "money", range: { min: 20000, max: 300000 } }],
      rates: [{ _id: "apr", kind: "lending", rate_type: "fixed", value: 21, cap: 26 }],
    },
  };
  const { params: g, economics, assumptions } = datasetInputs(p, { expected_pd_pct: 4, lgd_pct: 60 });
  assert.deepEqual(g, { product_line: "credit", segments: ["salaried", "gig"], amount_min: 20000, amount_max: 300000, target_pd_pct: 4 });
  assert.equal(economics.default_apr_pct, 21);
  assert.equal(economics.lgd_pct, 60);
  assert.equal(economics.cost_of_funds_pct, 9);
  assert.ok(assumptions.some((a) => /cost of funds %: 9 \(Mynt's default/.test(a)));
  assert.ok(assumptions.some((a) => /amount_min: 20000 \(term loan_amount\)/.test(a)));
  assert.ok(assumptions.some((a) => /protected_group is synthetic/.test(a)));
});

// ---- the scorer ----

// Four applicants, two in each group; a hand-checkable book.
const people = [
  { id: "a1", requested_amount: 1000, application_month: 1 },
  { id: "a2", requested_amount: 2000, application_month: 5 },
  { id: "b1", requested_amount: 1000, application_month: 9 },
  { id: "b2", requested_amount: 1000, application_month: 10 },
];
const truth = [
  { id: "a1", pd: 0.1, defaulted: false, protected_group: "A" },
  { id: "a2", pd: 0.2, defaulted: true, protected_group: "A" },
  { id: "b1", pd: 0.05, defaulted: false, protected_group: "B" },
  { id: "b2", pd: 0.3, defaulted: false, protected_group: "B" },
];

test("the scorer's metrics, on a book small enough to check by hand", () => {
  const decisions = [
    { id: "a1", approve: true, apr_pct: 20 },
    { id: "a2", approve: true, limit: 1500 },
    { id: "b1", approve: true },
    { id: "b2", approve: false, reason_codes: ["HIGH_DTI"] },
  ];
  const s = scoreSet(people, truth, decisions, spec());
  const m = s.metrics;
  assert.equal(m.approved, 3);
  assert.equal(m.approval_rate, 0.75);
  assert.equal(m.approved_volume, 3500, "a2's limit caps its amount");
  // Expected loss: (0.1*1000 + 0.2*1500 + 0.05*1000) * 0.5 = 225; realised: a2 only, 1500 * 0.5 = 750.
  assert.equal(m.expected_loss_rate_pct, Number(((100 * 225) / 3500).toFixed(4)));
  assert.equal(m.realised_loss_rate_pct, Number(((100 * 750) / 3500).toFixed(4)));
  // Interest from non-defaulters: a1 1000 * 20% + b1 1000 * 18% = 380. Costs: 3500 * 10% = 350.
  assert.equal(m.interest_revenue, 380);
  assert.equal(m.net_margin, 380 - 750 - 350);
  assert.equal(m.max_apr_pct, 20);
  assert.equal(m.adverse_impact_ratio, 0.5, "B approved at 1/2, A at 2/2");
  assert.equal(s.objective.metric, "net_margin");
  assert.equal(s.objective.value, -720);
  const status = Object.fromEntries(s.checks.map((c) => [c.name, c.status]));
  assert.deepEqual(status, { complete_decisions: "pass", loss_rate: "fail", apr_cap: "pass", adverse_impact: "fail", reason_codes: "pass" });
  assert.equal(s.eligible, false);
});

test("each constraint fails on its own", () => {
  const all = (over = {}) => people.map((p) => ({ id: p.id, approve: true, ...over }));
  const ok = scoreSet(people, truth.map((t) => ({ ...t, defaulted: false })), all(), spec());
  assert.equal(ok.eligible, true, JSON.stringify(ok.checks));
  const checks = (s) => Object.fromEntries(s.checks.filter((c) => c.status === "fail").map((c) => [c.name, c.value]));

  assert.deepEqual(checks(scoreSet(people, truth, all(), spec())), { loss_rate: 20 }, "a2 defaults: half its 2000 lost, 20% of 5000 approved, over a 10% ceiling");
  const pricey = scoreSet(people, truth.map((t) => ({ ...t, defaulted: false })), all({ apr_pct: 30 }), spec());
  assert.deepEqual(checks(pricey), { apr_cap: 30 });
  const noCap = scoreSet(people, truth.map((t) => ({ ...t, defaulted: false })), all({ apr_pct: 30 }), spec({ constraints: { ...spec().constraints, apr_cap_pct: null } }));
  assert.equal(noCap.checks.find((c) => c.name === "apr_cap").status, "not_set", "no cap: reported as not set, not as a pass");
  assert.equal(noCap.eligible, true);

  const clean = truth.map((t) => ({ ...t, defaulted: false }));
  const oneBDeclined = [{ id: "a1", approve: true }, { id: "a2", approve: true }, { id: "b1", approve: true }, { id: "b2", approve: false, reason_codes: ["X"] }];
  assert.deepEqual(checks(scoreSet(people, clean, oneBDeclined, spec())), { adverse_impact: 0.5 });
  const fairEnough = scoreSet(people, clean, oneBDeclined, spec({ constraints: { ...spec().constraints, min_adverse_impact_ratio: 0.5 } }));
  assert.equal(fairEnough.eligible, true, "the threshold is the job's");

  const silent = scoreSet(people, clean, [{ id: "a1", approve: false, reason_codes: [] }, { id: "a2", approve: false }, { id: "b1", approve: false, reason_codes: ["X"] }, { id: "b2", approve: false, reason_codes: ["X"] }], spec());
  assert.equal(checks(silent).reason_codes, 2);
  const partial = scoreSet(people, clean, all().slice(0, 3), spec());
  assert.equal(checks(partial).complete_decisions, 1);
});

test("stability: the same metrics on three time-like slices", () => {
  const s = scoreWithStability(people, truth.map((t) => ({ ...t, defaulted: false })), people.map((p) => ({ id: p.id, approve: true })), spec());
  assert.deepEqual(s.stability.slices.map((x) => [x.months, x.applicants]), [["1-4", 1], ["5-8", 1], ["9-12", 2]]);
  // Margins: 1000*8% = 80, 2000*8% = 160, 2000*8% = 160; spread (160-80)/mean(133.33).
  assert.deepEqual(s.stability.slices.map((x) => x.objective), [80, 160, 160]);
  assert.equal(s.stability.objective_spread, 0.6);
});

test("the explorers' scorer script is Mynt's scorer: same numbers on the same files", () => {
  const dir = mkdtempSync(join(tmpdir(), "mynt-score-"));
  const set = generateDataset(params, 7, "d", 400);
  const decisions = set.applicants.map((a) => ({ id: a.id, approve: (a.bureau_score ?? 0) >= 680, apr_pct: 19, reason_codes: (a.bureau_score ?? 0) >= 680 ? [] : ["LOW_SCORE"] }));
  const devTruth = set.truth.map(({ id, defaulted, protected_group }) => ({ id, defaulted, protected_group }));
  const lines = (xs) => xs.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(join(dir, "applicants.jsonl"), lines(set.applicants));
  writeFileSync(join(dir, "truth.jsonl"), lines(devTruth));
  writeFileSync(join(dir, "decisions.jsonl"), lines(decisions));
  writeFileSync(join(dir, "explore.json"), JSON.stringify({ scoring: spec() }));
  writeFileSync(join(dir, "score.mjs"), SCORER_SCRIPT);
  const r = spawnSync(process.execPath, [join(dir, "score.mjs"), join(dir, "explore.json"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const fromScript = JSON.parse(r.stdout);
  assert.deepEqual(fromScript, JSON.parse(JSON.stringify(scoreWithStability(set.applicants, devTruth, decisions, spec()))));
  assert.equal(fromScript.metrics.expected_loss_rate_pct, null, "without the latent default probability, expected loss can't be measured: null, never 0");
});

test("the decide runner runs a model's decide on applicants and collects its decisions", () => {
  const repo = mkdtempSync(join(tmpdir(), "mynt-explore-repo-"));
  mkdirSync(join(repo, "models/underwriting"), { recursive: true });
  writeFileSync(join(repo, "models/underwriting/model.json"), JSON.stringify({ name: "underwriting", run: "true", decide: "python3 decide.py" }));
  writeFileSync(
    join(repo, "models/underwriting/decide.py"),
    `import json, os
out = open(os.environ["MYNT_DECISIONS"], "w")
for line in open(os.environ["MYNT_APPLICANTS"]):
    a = json.loads(line)
    ok = (a["bureau_score"] or 0) >= 650
    out.write(json.dumps({"id": a["id"], "approve": ok, "grade": "A" if ok else None, "reason_codes": [] if ok else ["LOW_SCORE"]}) + "\\n")
`,
  );
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "model");
  const job = mkdtempSync(join(tmpdir(), "mynt-explore-job-"));
  const set = generateDataset(params, 9, "h", 50);
  writeFileSync(join(job, "applicants.jsonl"), set.applicants.map((x) => JSON.stringify(x)).join("\n"));
  writeFileSync(join(job, "run-decide.mjs"), DECIDE_RUNNER);
  const run = () => {
    const r = spawnSync(process.execPath, [join(job, "run-decide.mjs"), repo, job, "models/underwriting"], { encoding: "utf8", timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(join(job, "outcome.json"), "utf8"));
  };
  const o = run();
  assert.equal(o.outcome, "ran", o.log);
  assert.equal(o.decisions, 50);
  assert.match(o.commit, /^[0-9a-f]{40}$/);
  const first = JSON.parse(readFileSync(join(job, "decisions.jsonl"), "utf8").split("\n")[0]);
  assert.equal(first.id, set.applicants[0].id);

  writeFileSync(join(repo, "models/underwriting/model.json"), JSON.stringify({ name: "underwriting", run: "true" }));
  assert.equal(run().outcome, "no_decide");
});

// ---- the exploration, end to end, with stand-ins for the sandbox host and GitHub ----

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
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    finishAgent(id, cost = 1, summary = "Tightened the knockouts") {
      const s = sandboxes.get(id);
      s.running = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ done: true, last_subtype: "success", cost_usd: cost, summary }));
    },
    // Mynt's holdout run: decisions from `decide` (a function of the applicant), or a failed clone.
    finishDecide(id, decide) {
      const s = sandboxes.get(id);
      s.running = false;
      if (!decide) return s.files.set(`${JOB}/outcome.json`, s.files.get(`${DIR}/clone-failed.json`));
      const applicants = s.files.get(`${JOB}/applicants.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      s.files.set(`${JOB}/decisions.jsonl`, applicants.map((a) => JSON.stringify({ id: a.id, ...decide(a) })).join("\n"));
      s.files.set(`${JOB}/outcome.json`, JSON.stringify({ outcome: "ran", commit: sha(id).slice(0, 40), decisions: applicants.length, log: "" }));
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
      return { token: "ghs_explore", expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    installUrl: () => "https://github.com/apps/mynt/installations/new",
    async openPullRequest(repo, installation, pr) {
      prs.push({ repo, installation, ...pr });
      return `https://github.com/${repo}/pull/${prs.length}`;
    },
  };
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
const definition = {
  customer_segments: [{ _id: "salaried", name: "Salaried", qualification: {} }],
  terms: [{ _id: "loan_amount", type: "money", range: { min: 10000, max: 500000 }, set_by: ["decision_engine"], negotiable: "decision_engine", post_issue: { rule: "immutable" } }],
  core_algorithms: [
    { _id: "uw", algorithm_name: "Underwriting", description: "Score and knockouts", purpose: "underwriting", repository: "models/underwriting", version: "v1.0.0" },
    { _id: "interest", algorithm_name: "Interest", description: "Daily accrual", purpose: "interest_calculation", repository: "models/interest" },
  ],
};

async function setup() {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const boat = fakeBoat();
  const repos = fakeRepos();
  const host = { agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, model: "claude-opus-5-5", publicUrl: "https://mynt.example.com" };
  const deskConfig = deskConfigFromEnv(host, {});
  const desk = await DeskService.open(db, store, boat, repos, deskConfig);
  const explore = await ExploreService.open(db, store, boat, repos, exploreConfigFromEnv(deskConfig, {}), desk);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { desk, explore }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    let data;
    try {
      data = JSON.parse(res.content[0].text);
    } catch {
      data = { error: res.content[0].text };
    }
    return { isError: res.isError ?? false, data };
  };
  const innovator = async (name) => {
    const { user } = await store.createUser(name, ["innovator"]);
    await licensed(store, user, { region: "IN", category: "personal-loans", action: "issuance" });
    return { user, client: await connect(user) };
  };
  const ready = async () => {
    const { user, client } = await innovator("Ines");
    assert.equal((await call(client, "create_product", loan)).isError, false);
    await store.setDefinition("quick-loan", definition);
    await call(client, "connect_desk_repository", { repository: "acme/desk" });
    await call(client, "set_product_terms", { product_id: "quick-loan", inputs: { apr_pct: 18, apr_cap_pct: 24, expected_pd_pct: 5, lgd_pct: 65, cost_of_funds_pct: 9, opex_pct: 3 } });
    return { user, client };
  };
  return { db, store, desk, explore, boat, repos, connect, call, innovator, ready };
}

const variants = async (explore, id) => (await explore.get(id)).variants;
const sandboxOf = async (db, id, k, column = "sandbox_id") => (await db.query(`SELECT ${column} FROM financial_products.explore_variants WHERE job_id = $1 AND k = $2`, [id, k])).rows[0][column];

test("an exploration: explorers on different angles with the dev set only; Mynt scores every pushed variant and the baseline on the holdout; adopt opens a PR", async () => {
  const { db, store, explore, desk, boat, repos, call, ready } = await setup();
  const { client } = await ready();

  assert.match((await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "nope" })).data.error, /no core algorithm 'nope' \(it has: uw, interest\)/);
  assert.match((await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "interest" })).data.error, /decision algorithms/);
  const started = await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw", objective: "net_margin", explorers: 3, cap_usd: 500 });
  assert.equal(started.isError, false, JSON.stringify(started.data));
  const job = started.data;
  assert.equal(Number(job.cap_usd), 20, "capped by config");
  assert.equal(job.constraints.apr_cap_pct, 24);
  assert.equal(job.constraints.apr_cap_source, "term sheet apr_cap_pct");
  assert.equal(job.constraints.max_loss_rate_pct, 3.25, "default ceiling: the term sheet's expected loss");
  assert.ok(job.dataset.assumptions.length > 5);
  assert.equal(await desk.monthCommitted(job.entity_id), 20, "explorations share the firm's monthly desk budget");
  assert.match((await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw" })).data.error, /already running/);

  // Explorer sandboxes: each with the firm's repo, its own branch, and a push token.
  await explore.tick();
  const explorerSbx = [];
  for (const k of [1, 2, 3]) {
    const id = await sandboxOf(db, job.id, k);
    explorerSbx.push(id);
    assert.equal(boat.sandboxes.get(id).opts.env.MYNT_BRANCH, `mynt/explore-${job.id.slice(0, 8)}-${k}`);
    assert.equal(boat.sandboxes.get(id).opts.env.GITHUB_REPOSITORY, "acme/desk");
    boat.ready(id);
  }
  await explore.tick();
  const specs = explorerSbx.map((id) => JSON.parse(boat.sandboxes.get(id).files.get(`${WS}/job/explore.json`)));
  const angles = explorationAngles().map((a) => a.id);
  assert.deepEqual(specs.map((s) => s.angle.id), angles.slice(0, 3), "a different angle each");
  for (const s of specs) {
    assert.equal(s.model_dir, "models/underwriting");
    assert.equal(s.base_ref, "v1.0.0");
    assert.deepEqual(s.objective, { maximise: "net_margin" });
    assert.deepEqual(Object.keys(s.limits), ["max_iterations", "max_minutes", "experiment_timeout_seconds"]);
    assert.equal(s.experiment_log, "models/underwriting/explore-log.tsv");
  }
  const holdout = generateDataset((await db.query("SELECT dataset FROM financial_products.explore_jobs WHERE id = $1", [job.id])).rows[0].dataset.params, seedsFor(job.id, sha).holdout, "h");
  for (const id of explorerSbx) {
    const files = boat.sandboxes.get(id).files;
    assert.ok(files.get(`${WS}/CLAUDE.md`).includes("autoresearch"));
    assert.ok(files.has(`${WS}/.claude/skills/model-contract/SKILL.md`));
    assert.equal(files.get(`${WS}/scripts/score.mjs`), SCORER_SCRIPT);
    assert.equal(files.get(`${WS}/scripts/run-decide.mjs`), DECIDE_RUNNER);
    const devApplicants = files.get(`${WS}/job/dev/applicants.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(devApplicants.length, DATASET_SIZE);
    assert.ok(devApplicants.every((a) => !("defaulted" in a) && !("protected_group" in a)));
    const devTruth = JSON.parse(files.get(`${WS}/job/dev/truth.jsonl`).split("\n")[0]);
    assert.deepEqual(Object.keys(devTruth).sort(), ["defaulted", "id", "protected_group"], "outcomes for the dev set, never the latent probability");
    // Nothing of the holdout reaches an explorer: no holdout id, and no holdout applicant's exact features.
    const everything = [...files.values()].join("\n");
    assert.ok(!/"h-\d{6}"/.test(everything), "no holdout ids in an explorer sandbox");
    assert.ok(!everything.includes(JSON.stringify(holdout.applicants[0])));
  }
  const auth = JSON.parse(boat.sandboxes.get(explorerSbx[0]).files.get(`${A}/auth.json`));
  assert.deepEqual(await explore.agentRun(auth.token), { key: `explore:${job.id}`, capUsd: 20 }, "every explorer spends against the job's one key and cap");
  assert.equal((await explore.get(job.id)).status, "exploring");

  // Explorers finish (one of them without pushing anything).
  boat.finishAgent(explorerSbx[0], 1, "Added a bureau-score knockout at 650");
  boat.finishAgent(explorerSbx[1], 1, "Priced riskier grades higher");
  await explore.tick();
  assert.equal((await explore.get(job.id)).status, "exploring", "waits for every explorer");
  boat.finishAgent(explorerSbx[2], 1, "Couldn't find an improvement");
  await explore.tick();
  assert.equal((await explore.get(job.id)).status, "scoring");
  assert.equal(await explore.agentTokenActive(auth.token), false, "explorer tokens die when they finish");
  for (const id of explorerSbx) assert.ok(boat.sandboxes.get(id).stopped);

  // Mynt's scoring: a clean sandbox per variant (and the baseline), no credentials, features only.
  const scoreSbx = {};
  for (const k of [0, 1, 2, 3]) {
    scoreSbx[k] = await sandboxOf(db, job.id, k, "score_sandbox_id");
    assert.deepEqual(boat.sandboxes.get(scoreSbx[k]).opts.env, {}, "the scorer gets no credentials in its env");
    boat.ready(scoreSbx[k]);
  }
  await explore.tick();
  assert.match(boat.sandboxes.get(scoreSbx[0]).files.get(`${DIR}/run.sh`), /--branch 'v1\.0\.0'/, "the baseline is the pinned version");
  for (const k of [1, 2, 3]) {
    const s = boat.sandboxes.get(scoreSbx[k]).files;
    assert.match(s.get(`${DIR}/run.sh`), new RegExp(`--branch 'mynt/explore-${job.id.slice(0, 8)}-${k}'`));
    assert.ok(s.get(`${DIR}/run.sh`).indexOf("rm -f /home/user/.mynt-git-credentials") < s.get(`${DIR}/run.sh`).indexOf("run-decide.mjs"), "the clone token is gone before any algorithm code runs");
    const sent = s.get(`${JOB}/applicants.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(sent, holdout.applicants, "the holdout's features, nothing else");
  }

  // Baseline approves everyone at 18%; explorer 1 adds a knockout (better, within every constraint); explorer 2 prices
  // over the APR cap (more margin, but ineligible); explorer 3 never pushed.
  const knockout = (a) => ((a.bureau_score ?? 0) >= 650 ? { approve: true, grade: "A", reason_codes: [] } : { approve: false, reason_codes: ["LOW_BUREAU_SCORE"] });
  boat.finishDecide(scoreSbx[0], () => ({ approve: true, apr_pct: 18, reason_codes: [] }));
  boat.finishDecide(scoreSbx[1], knockout);
  boat.finishDecide(scoreSbx[2], (a) => ({ ...knockout(a), ...((a.bureau_score ?? 0) >= 650 ? { apr_pct: 30 } : {}) }));
  boat.finishDecide(scoreSbx[3], null);
  await explore.tick();

  const done = await explore.get(job.id);
  assert.equal(done.status, "finished", done.error);
  const board = done.leaderboard;
  // Approving everyone loses more than the term sheet's expected loss on this holdout, so the baseline is ineligible
  // too: eligible variants first, then ineligible ones by objective, then what Mynt couldn't run.
  assert.deepEqual(board.map((e) => [e.rank, e.k]), [[1, 1], [2, 2], [3, 0], [null, 3]], JSON.stringify(board.map((e) => [e.k, e.objective, e.constraints])));
  const [first, pricey, baseline, unpushed] = board;
  assert.equal(baseline.constraints.loss_rate, "fail");
  assert.equal(first.eligible, true);
  assert.equal(first.angle, "tighten_knockouts");
  assert.ok(first.objective.value > baseline.objective.value, "the knockout beats approving everyone");
  assert.equal(pricey.eligible, false);
  assert.equal(pricey.constraints.apr_cap, "fail");
  assert.ok(pricey.objective.value > first.objective.value, "more margin, ranked below anyway: it breaks a constraint");
  assert.match(unpushed.error, /wasn't pushed/);
  assert.equal(first.stability.slices.length, 3);
  assert.equal(first.metrics.applicants, DATASET_SIZE);
  assert.ok(typeof first.metrics.expected_loss_rate_pct === "number", "Mynt holds the latent probability, so expected loss is measured on the holdout");
  assert.match(done.phase_message, /^Best: explorer 1/);
  assert.ok(Number(done.cost_usd) >= 3, "the explorers' spend is counted");
  for (const k of [0, 1, 2, 3]) assert.ok(boat.sandboxes.get(scoreSbx[k]).stopped);
  const got = (await call(client, "get_exploration", { job_id: job.id })).data;
  assert.equal(got.leaderboard[0].k, 1);
  assert.match(got.dataset.holdout, /never given to explorers/);
  assert.ok(!JSON.stringify(got).includes("token_hash"));

  // Adoption: a pull request for the branch, with Mynt's holdout numbers; the product itself is untouched.
  assert.match((await call(client, "adopt_variant", { job_id: job.id, explorer: 3 })).data.error, /wasn't scored/);
  const adopted = await call(client, "adopt_variant", { job_id: job.id, explorer: 1 });
  assert.equal(adopted.isError, false, JSON.stringify(adopted.data));
  assert.equal(adopted.data.pr_url, "https://github.com/acme/desk/pull/1");
  assert.equal(repos.prs[0].head, `mynt/explore-${job.id.slice(0, 8)}-1`);
  assert.match(repos.prs[0].body, /scored by Mynt/);
  assert.match(repos.prs[0].body, /\| apr_cap \| pass \|/);
  assert.match(repos.prs[0].body, /Added a bureau-score knockout at 650/);
  assert.match(repos.prs[0].body, /doesn't change the product/);
  assert.match(adopted.data.review_note, /isn't enabled/);
  assert.equal((await call(client, "adopt_variant", { job_id: job.id, explorer: 1 })).data.already_proposed, true);
  assert.equal(repos.prs.length, 1);
  assert.equal((await store.getProduct("quick-loan")).definition.core_algorithms[0].version, "v1.0.0", "the pinned version only changes through the product update path");
  const v1 = (await variants(explore, job.id)).find((v) => v.k === 1);
  assert.equal(v1.pr_url, adopted.data.pr_url);
  assert.ok(v1.proposed_at);

  const ops = await opsStatus(db);
  assert.deepEqual(ops.agents.explorers.last_hours, { finished: 1 });
});

test("the budget is shared and enforced: over the cap, everything stops", async () => {
  const { db, explore, boat, call, ready } = await setup();
  const { client } = await ready();
  const job = (await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw", explorers: 2, cap_usd: 5 })).data;
  await explore.tick();
  const ids = [await sandboxOf(db, job.id, 1), await sandboxOf(db, job.id, 2)];
  for (const id of ids) boat.ready(id);
  await explore.tick();
  const cfg = JSON.parse(boat.sandboxes.get(ids[0]).files.get(`${A}/config.json`));
  assert.equal(cfg.budgetUsd, 2.25, "each explorer gets its share of the cap");
  // Two explorers, each under its own share, together over the job's cap.
  for (const id of ids) boat.sandboxes.get(id).files.set(`${A}/state.json`, JSON.stringify({ done: false, cost_usd: 2.6 }));
  await explore.tick();
  const stopped = await explore.get(job.id);
  assert.equal(stopped.status, "stopped");
  assert.match(stopped.error, /over the US\$5 cap/);
  for (const id of ids) assert.ok(boat.sandboxes.get(id).stopped);
  const auth = JSON.parse(boat.sandboxes.get(ids[0]).files.get(`${A}/auth.json`));
  assert.equal(await explore.agentTokenActive(auth.token), false);
});

test("explorations are the firm's own, and only innovators get the tools", async () => {
  const { store, explore, call, ready, innovator, connect } = await setup();
  const { client } = await ready();
  const job = (await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw" })).data;
  assert.equal(job.explorers, 3, "three explorers by default");
  const { client: other } = await innovator("Omar");
  await call(other, "connect_desk_repository", { repository: "acme/desk" });
  assert.equal((await call(other, "get_exploration", { job_id: job.id })).isError, true);
  assert.equal((await call(other, "stop_exploration", { job_id: job.id })).isError, true);
  assert.equal((await call(other, "adopt_variant", { job_id: job.id, explorer: 1 })).isError, true);
  assert.match((await call(other, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw" })).data.error, /No product of your firm's/);
  const { user: dev } = await store.createUser("Dev", ["developer"]);
  const tools = (await (await connect(dev)).listTools()).tools.map((t) => t.name);
  for (const t of ["start_exploration", "get_exploration", "adopt_variant", "stop_exploration"]) assert.ok(!tools.includes(t));
  assert.equal((await call(client, "get_exploration")).data.length, 1);
  assert.equal((await call(client, "stop_exploration", { job_id: job.id })).data.stopped, job.id);
  assert.equal((await explore.get(job.id)).status, "stopped");
});

test("the explorer workspace: its instructions, the angles, and the desk's skills copied verbatim", () => {
  const files = workspaceFiles("algorithm-explorer");
  for (const rule of [/autoresearch/, /Never use outcome labels or the protected group/, /Change only `model_dir`/, /Do not open a pull request/, /explore-log\.tsv/, /max_iterations/]) assert.match(files["CLAUDE.md"], rule);
  const desk = workspaceFiles("product-desk");
  for (const skill of ["model-contract", "financial-modelling"]) assert.equal(files[`.claude/skills/${skill}/SKILL.md`], desk[`.claude/skills/${skill}/SKILL.md`]);
  assert.match(files[".claude/skills/model-contract/SKILL.md"], /MYNT_APPLICANTS/);
  assert.equal(explorationAngles().length, 5);
  assert.equal(new Set(explorationAngles().map((a) => a.id)).size, 5);
});
