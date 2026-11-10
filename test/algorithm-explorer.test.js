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
import { DATASET_SIZE, datasetInputs, generateDataset, newDatasetSecret, splitKeys } from "../dist/explore-data.js";
import { SCORER_SCRIPT, scoreSet, scoreWithStability } from "../dist/explore-score.js";
import { DECIDE_RUNNER, ExploreService, TOKEN_FILE, explorationAngles, exploreConfigFromEnv } from "../dist/explore.js";
import { startRepoRun } from "../dist/repo-run.js";
import { opsStatus } from "../dist/ops.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG, licensed } from "./helpers.js";

const DIR = "/home/user/mynt-explore";
const JOB = `${DIR}/job`;
const A = "/home/user/mynt-agent";
const WS = "/home/user/workspaces/algorithm-explorer";
const sha = (s) => createHash("sha256").update(s).digest("hex");
const KEY = "ab".repeat(32);
const params = { product_line: "credit", segments: ["salaried", "self_employed"], amount_min: 10000, amount_max: 500000, target_pd_pct: 5 };
const spec = (over = {}) => ({
  objective: { maximise: "net_margin" },
  economics: { default_apr_pct: 18, cost_of_funds_pct: 9, lgd_pct: 50, opex_pct: 1, tenor_months: 12 },
  constraints: { max_loss_rate_pct: 10, apr_cap_pct: 24, min_adverse_impact_ratio: 0.8 },
  ...over,
});

// ---- the generator ----

test("the generator is deterministic, and the dev and holdout splits never overlap", () => {
  const a = generateDataset(params, KEY, "d", 500);
  const b = generateDataset(params, KEY, "d", 500);
  assert.deepEqual(a, b, "same key, same applicants and truth");
  const secret = newDatasetSecret();
  assert.match(secret, /^[0-9a-f]{64}$/, "32 random bytes");
  const keys = splitKeys(secret);
  assert.notEqual(keys.dev, keys.holdout);
  assert.deepEqual(splitKeys(secret), keys, "the splits come from the job's secret, deterministically");
  const dev = generateDataset(params, keys.dev, "d");
  const holdout = generateDataset(params, keys.holdout, "h");
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

test("the holdout can't be rebuilt from what an explorer gets, and two jobs never share one", () => {
  const jobId = "6f1c2a8e-0000-4000-8000-000000000001";
  const secret = newDatasetSecret();
  const holdout = generateDataset(params, splitKeys(secret).holdout, "h", 300);
  // What an explorer could try: keys made from the job id (the old derivation), or from its dev files.
  const dev = generateDataset(params, splitKeys(secret).dev, "d", 300);
  for (const guess of [sha(`${jobId}:holdout`), sha(jobId), sha(JSON.stringify(dev.truth)), splitKeys(sha(jobId)).holdout]) {
    const attempt = generateDataset(params, guess, "h", 300);
    assert.notDeepEqual(attempt.applicants.map((x) => x.monthly_income), holdout.applicants.map((x) => x.monthly_income));
  }
  // Two jobs with the same inputs get different holdouts.
  const other = generateDataset(params, splitKeys(newDatasetSecret()).holdout, "h", 300);
  assert.notDeepEqual(other.truth.map((t) => t.defaulted), holdout.truth.map((t) => t.defaulted));
  // Features and outcomes come from separate streams: the same features key with another outcomes stream would be
  // a different key altogether, so knowing every feature still says nothing about who defaulted.
  const flips = holdout.truth.filter((t, i) => t.defaulted !== other.truth[i].defaulted).length;
  assert.ok(flips > 0);
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
  assert.equal(noCap.checks.find((c) => c.name === "apr_cap").status, "fail", "no cap: no variant can be eligible");
  assert.equal(noCap.eligible, false);
  // Absurd or malformed prices and limits aren't decisions Mynt can use.
  const clean0 = truth.map((t) => ({ ...t, defaulted: false }));
  for (const bad of [{ apr_pct: 1e6 }, { apr_pct: -5 }, { apr_pct: Infinity }, { apr_pct: "20" }, { limit: -1 }, { limit: 0 }, { limit: "lots" }]) {
    const s = scoreSet(people, clean0, all(bad), spec({ constraints: { ...spec().constraints, apr_cap_pct: null } }));
    assert.equal(s.metrics.missing_decisions, 4, JSON.stringify(bad));
    assert.equal(s.metrics.interest_revenue, 0, "no revenue from an invalid decision");
    assert.equal(s.eligible, false);
  }

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
  const set = generateDataset(params, KEY, "d", 400);
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
  const set = generateDataset(params, "cd".repeat(32), "h", 50);
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
    finishDecide(id, decide, commit) {
      const s = sandboxes.get(id);
      s.running = false;
      if (!decide) return s.files.set(`${JOB}/outcome.json`, s.files.get(`${DIR}/clone-failed.json`));
      const applicants = s.files.get(`${JOB}/applicants.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
      s.files.set(`${JOB}/decisions.jsonl`, applicants.map((a) => JSON.stringify({ id: a.id, ...decide(a) })).join("\n"));
      s.files.set(`${JOB}/outcome.json`, JSON.stringify({ outcome: "ran", commit, decisions: applicants.length, log: "" }));
    },
  };
}

const BASE = "b".repeat(40);
function fakeRepos() {
  const prs = [];
  const created = [];
  // What each branch, tag or SHA points at in the firm's repository.
  const refs = new Map([["v1.0.0", BASE], ["HEAD", "a".repeat(40)]]);
  let minted = 0;
  return {
    prs,
    created,
    refs,
    async installationFor(repo) {
      return repo === "acme/desk" ? 7 : null;
    },
    async tokenFor() {
      return { token: `ghs_explore_${++minted}`, expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    async resolveRef(repo, installation, ref) {
      return refs.get(ref) ?? null;
    },
    async createBranch(repo, installation, branch, commit) {
      created.push({ branch, commit });
      refs.set(branch, commit);
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

// A fixed dataset secret for the exploration test. On its holdout the knockout at 650 is within every constraint
// (realised loss about 1.8% against the 3.25% ceiling), approving everyone goes over the loss ceiling (about 3.4%),
// and the knockout earns well above it; "the scenario holds on the pinned holdout" checks this, so a generator change
// that breaks it fails there, saying why, instead of making the exploration test flaky.
const PINNED_SECRET = createHash("sha256").update("mynt algorithm-explorer test: a fixed holdout").digest("hex");

test("the scenario holds on the pinned holdout: the knockout is eligible and beats approving everyone; pricing over the cap isn't", () => {
  const { params, economics } = datasetInputs({ product: loan, definition }, { apr_pct: 18, apr_cap_pct: 24, expected_pd_pct: 5, lgd_pct: 65, cost_of_funds_pct: 9, opex_pct: 3 });
  const spec = { objective: { maximise: "net_margin" }, economics, constraints: { max_loss_rate_pct: 3.25, apr_cap_pct: 24, min_adverse_impact_ratio: 0.8 } };
  const h = generateDataset(params, splitKeys(PINNED_SECRET).holdout, "h");
  const score = (decide) => scoreWithStability(h.applicants, h.truth, h.applicants.map((a) => ({ id: a.id, ...decide(a) })), spec);
  const knockout = (a) => ((a.bureau_score ?? 0) >= 650 ? { approve: true, grade: "A", reason_codes: [] } : { approve: false, reason_codes: ["LOW_BUREAU_SCORE"] });
  const k = score(knockout);
  const base = score(() => ({ approve: true, apr_pct: 18, reason_codes: [] }));
  const pricey = score((a) => ({ ...knockout(a), ...((a.bureau_score ?? 0) >= 650 ? { apr_pct: 30 } : {}) }));
  assert.ok(k.eligible, JSON.stringify(k.checks));
  assert.ok(k.objective.value > base.objective.value);
  assert.equal(pricey.eligible, false);
  assert.ok(pricey.objective.value > k.objective.value);
});

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

  assert.equal(job.base_sha, BASE, "the pinned version, resolved to a commit at the start");

  // Each job's dataset secret is random on purpose (no two jobs share a holdout: tested above), so on a random holdout
  // the scenario below doesn't always hold: on some draws approving everyone stays under the loss ceiling and earns
  // more than the knockout, on others the knockout itself goes over it. Pin this job's secret (before the first tick
  // makes the dev set) to one where the scenario holds, so what's asserted is the ranking, not the luck of the draw.
  await db.query("UPDATE financial_products.explore_jobs SET dataset = jsonb_set(dataset, '{secret}', to_jsonb($2::text)) WHERE id = $1", [job.id, PINNED_SECRET]);

  // Explorer sandboxes: each with the firm's repo and its own hard-to-guess branch; no token in the environment.
  await explore.tick();
  await explore.tick(); // a second tick before they're ready creates nothing new
  assert.equal(boat.sandboxes.size, 3);
  const explorerSbx = [];
  const branches = {};
  for (const k of [1, 2, 3]) {
    const id = await sandboxOf(db, job.id, k);
    explorerSbx.push(id);
    const env = boat.sandboxes.get(id).opts.env;
    branches[k] = env.MYNT_BRANCH;
    assert.match(env.MYNT_BRANCH, new RegExp(`^mynt/explore-${job.id.slice(0, 8)}-${k}-[0-9a-f]{12}$`));
    assert.equal(env.GITHUB_REPOSITORY, "acme/desk");
    assert.ok(!("GITHUB_TOKEN" in env), "the push token isn't in the environment");
    assert.ok(!boat.sandboxes.get(id).files.has(TOKEN_FILE), "nor minted before the explorer starts");
    boat.ready(id);
  }
  await explore.tick();
  // Minted just before launch, as a file for the credential helper.
  assert.match(boat.sandboxes.get(explorerSbx[0]).files.get(TOKEN_FILE), /^ghs_explore_\d+$/);
  const specs = explorerSbx.map((id) => JSON.parse(boat.sandboxes.get(id).files.get(`${WS}/job/explore.json`)));
  const angles = explorationAngles().map((a) => a.id);
  assert.deepEqual(specs.map((s) => s.angle.id), angles.slice(0, 3), "a different angle each");
  for (const s of specs) {
    assert.equal(s.model_dir, "models/underwriting");
    assert.equal(s.base_ref, BASE);
    assert.deepEqual(s.objective, { maximise: "net_margin" });
    assert.deepEqual(Object.keys(s.limits), ["max_iterations", "max_minutes", "experiment_timeout_seconds"]);
    assert.equal(s.experiment_log, "models/underwriting/explore-log.tsv");
  }
  const stored = (await db.query("SELECT dataset FROM financial_products.explore_jobs WHERE id = $1", [job.id])).rows[0].dataset;
  const holdout = generateDataset(stored.params, splitKeys(stored.secret).holdout, "h");
  assert.ok(!JSON.stringify(job).includes(stored.secret), "the dataset secret is never shown");
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
    assert.ok(!everything.includes(stored.secret), "nor the secret that would rebuild it");
  }
  // Tokens last an hour: Mynt replaces an explorer's well before then.
  const before = boat.sandboxes.get(explorerSbx[0]).files.get(TOKEN_FILE);
  await db.query("UPDATE financial_products.explore_variants SET token_minted_at = now() - interval '41 minutes' WHERE job_id = $1 AND k = 1", [job.id]);
  await explore.tick();
  assert.notEqual(boat.sandboxes.get(explorerSbx[0]).files.get(TOKEN_FILE), before, "a fresh token for late pushes");
  const auth = JSON.parse(boat.sandboxes.get(explorerSbx[0]).files.get(`${A}/auth.json`));
  assert.deepEqual(await explore.agentRun(auth.token), { key: `explore:${job.id}`, capUsd: 20 }, "every explorer spends against the job's one key and cap");
  assert.equal((await explore.get(job.id)).status, "exploring");

  // Explorers finish (one of them without pushing anything).
  const C1 = "1".repeat(40);
  const C2 = "2".repeat(40);
  repos.refs.set(branches[1], C1);
  repos.refs.set(branches[2], C2);
  boat.finishAgent(explorerSbx[0], 1, "Added a bureau-score knockout at 650");
  boat.finishAgent(explorerSbx[1], 1, "Priced riskier grades higher");
  await explore.tick();
  assert.equal((await explore.get(job.id)).status, "exploring", "waits for every explorer");
  boat.finishAgent(explorerSbx[2], 1, "Couldn't find an improvement");
  await explore.tick();
  assert.equal((await explore.get(job.id)).status, "scoring");
  assert.equal(await explore.agentTokenActive(auth.token), false, "explorer tokens die when they finish");
  for (const id of explorerSbx) assert.ok(boat.sandboxes.get(id).stopped);
  // A push after the explorer finished (by it, or another explorer with the same repository access) changes nothing.
  repos.refs.set(branches[1], "f".repeat(40));
  repos.refs.set("v1.0.0", "e".repeat(40));
  assert.deepEqual((await variants(explore, job.id)).map((v) => v.commit_sha), [BASE, C1, C2, null]);

  // Mynt's scoring: a clean sandbox per pushed variant (and the baseline), no credentials, features only.
  const scoreSbx = {};
  assert.equal(await sandboxOf(db, job.id, 3, "score_sandbox_id"), null, "nothing pushed, nothing to run");
  for (const k of [0, 1, 2]) {
    scoreSbx[k] = await sandboxOf(db, job.id, k, "score_sandbox_id");
    assert.deepEqual(boat.sandboxes.get(scoreSbx[k]).opts.env, {}, "the scorer gets no credentials in its env");
    boat.ready(scoreSbx[k]);
  }
  await explore.tick();
  const pinned = { 0: BASE, 1: C1, 2: C2 };
  for (const k of [0, 1, 2]) {
    const s = boat.sandboxes.get(scoreSbx[k]).files;
    assert.ok(s.get(`${DIR}/run.sh`).includes(`fetch -q --depth 1 origin ${pinned[k]}`), "exactly the commit pinned when the explorer finished");
    assert.ok(!s.get(`${DIR}/run.sh`).includes("--branch"));
    assert.ok(s.get(`${DIR}/run.sh`).indexOf("rm -f /home/user/.mynt-git-credentials") < s.get(`${DIR}/run.sh`).indexOf("run-decide.mjs"), "the clone token is gone before any algorithm code runs");
    const sent = s.get(`${JOB}/applicants.jsonl`).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    assert.deepEqual(sent, holdout.applicants, "the holdout's features, nothing else");
  }

  // Baseline approves everyone at 18%; explorer 1 adds a knockout (better, within every constraint); explorer 2 prices
  // over the APR cap (more margin, but ineligible); explorer 3 never pushed.
  const knockout = (a) => ((a.bureau_score ?? 0) >= 650 ? { approve: true, grade: "A", reason_codes: [] } : { approve: false, reason_codes: ["LOW_BUREAU_SCORE"] });
  boat.finishDecide(scoreSbx[0], () => ({ approve: true, apr_pct: 18, reason_codes: [] }), BASE);
  boat.finishDecide(scoreSbx[1], knockout, C1);
  boat.finishDecide(scoreSbx[2], (a) => ({ ...knockout(a), ...((a.bureau_score ?? 0) >= 650 ? { apr_pct: 30 } : {}) }), C2);
  await explore.tick();

  const done = await explore.get(job.id);
  assert.equal(done.status, "finished", done.error);
  const board = done.leaderboard;
  // Every eligible variant ranks above every ineligible one, each group by objective, and what Mynt couldn't run
  // comes last, unranked.
  const why = JSON.stringify(board.map((e) => [e.k, e.objective, e.constraints]));
  const scoredRows = board.filter((e) => e.scored);
  assert.deepEqual(scoredRows.map((e) => e.rank), [1, 2, 3], why);
  const lastEligible = scoredRows.map((e) => e.eligible).lastIndexOf(true);
  assert.ok(scoredRows.slice(0, lastEligible + 1).every((e) => e.eligible), `eligible before ineligible: ${why}`);
  for (const group of [scoredRows.filter((e) => e.eligible), scoredRows.filter((e) => !e.eligible)])
    for (let i = 1; i < group.length; i++) assert.ok(group[i - 1].objective.value >= group[i].objective.value, `by objective: ${why}`);
  const byK = Object.fromEntries(board.map((e) => [e.k, e]));
  const [first, pricey, baseline, unpushed] = [byK[1], byK[2], byK[0], byK[3]];
  assert.equal(board[0].k, 1, `the knockout wins: ${why}`);
  assert.deepEqual([unpushed.rank, board.at(-1).k], [null, 3], "the unpushed variant is last, unranked");
  assert.ok(scoredRows.filter((e) => e.eligible).every((e) => e.rank < pricey.rank), "the over-cap variant ranks below every eligible one");
  assert.equal(baseline.scored, true);
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
  for (const k of [0, 1, 2]) assert.ok(boat.sandboxes.get(scoreSbx[k]).stopped);
  assert.equal(first.commit, C1);
  const got = (await call(client, "get_exploration", { job_id: job.id })).data;
  assert.equal(got.leaderboard[0].k, 1);
  assert.match(got.dataset.holdout, /never given to explorers/);
  assert.ok(!JSON.stringify(got).includes("token_hash"));

  // Adoption: a pull request for the branch, with Mynt's holdout numbers; the product itself is untouched.
  assert.match((await call(client, "adopt_variant", { job_id: job.id, explorer: 3 })).data.error, /wasn't scored/);
  // A pull request GitHub refuses the first time: the retry reuses Mynt's branch rather than leaving another behind.
  const open = repos.openPullRequest;
  repos.openPullRequest = async () => {
    throw new Error("GitHub refused the pull request (502)");
  };
  assert.match((await call(client, "adopt_variant", { job_id: job.id, explorer: 1 })).data.error, /502/);
  repos.openPullRequest = open;
  const adopted = await call(client, "adopt_variant", { job_id: job.id, explorer: 1 });
  assert.equal(adopted.isError, false, JSON.stringify(adopted.data));
  assert.equal(adopted.data.pr_url, "https://github.com/acme/desk/pull/1");
  // From a branch Mynt made at the scored commit, not the explorer's branch (which has moved since).
  assert.equal(repos.created.length, 1);
  assert.equal(repos.created[0].commit, C1);
  assert.equal(repos.created[0].branch, `mynt/adopt-${job.id.slice(0, 8)}-1-${C1.slice(0, 12)}`);
  assert.equal(repos.prs[0].head, repos.created[0].branch);
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
  assert.equal(stopped.status, "over_budget");
  assert.match(stopped.error, /over the US\$5 cap/);
  assert.match((await opsStatus(db)).attention.join("\n"), /explorers: 1 failed/, "over-cap stops show up for admins");
  for (const id of ids) assert.ok(boat.sandboxes.get(id).stopped);
  const auth = JSON.parse(boat.sandboxes.get(ids[0]).files.get(`${A}/auth.json`));
  assert.equal(await explore.agentTokenActive(auth.token), false);
});

test("explorations are the firm's own, and only builders get the tools", async () => {
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
  // Innovator and developer are one builder role: a developer gets the tools, a consumer doesn't.
  const { user: dev } = await store.createUser("Dev", ["developer"]);
  const devTools = (await (await connect(dev)).listTools()).tools.map((t) => t.name);
  const { user: consumer } = await store.createUser("Casey", ["consumer"]);
  const tools = (await (await connect(consumer)).listTools()).tools.map((t) => t.name);
  for (const t of ["start_exploration", "get_exploration", "adopt_variant", "stop_exploration"]) {
    assert.ok(devTools.includes(t), `developers are builders: ${t}`);
    assert.ok(!tools.includes(t), `consumers don't explore: ${t}`);
  }
  assert.equal((await call(client, "get_exploration")).data.length, 1);
  assert.equal((await call(client, "stop_exploration", { job_id: job.id })).data.stopped, job.id);
  assert.equal((await explore.get(job.id)).status, "stopped");
});

test("starting: an APR cap is required, one exploration at a time even when two starts race, and the pinned version must exist", async () => {
  const { explore, repos, call, ready } = await setup();
  const { user, client } = await ready();
  await call(client, "set_product_terms", { product_id: "quick-loan", inputs: { apr_pct: 18 } });
  assert.match((await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw" })).data.error, /Set an APR cap/);
  repos.refs.delete("v1.0.0");
  assert.match((await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw", apr_cap_pct: 30 })).data.error, /pinned version 'v1.0.0' isn't in acme\/desk/);
  repos.refs.set("v1.0.0", BASE);
  const results = await Promise.allSettled([1, 2, 3].map(() => explore.start(user, { product_id: "quick-loan", algorithm_id: "uw", constraints: { apr_cap_pct: 30 } })));
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.reason?.message)));
  for (const r of results.filter((x) => x.status === "rejected")) assert.match(r.reason.message, /already running/);
});

test("a passing provider error doesn't fail an exploration; a lasting one does", async () => {
  const { explore, boat, call, ready } = await setup();
  const { client } = await ready();
  const job = (await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw", explorers: 1 })).data;
  await explore.tick();
  const cost = boat.costDollars;
  boat.costDollars = async () => {
    throw new Error("boat: 503 Service Unavailable");
  };
  await explore.tick();
  assert.equal((await explore.get(job.id)).status, "exploring", "ridden out");
  const grace = ExploreService.TRANSIENT_GRACE_MS;
  ExploreService.TRANSIENT_GRACE_MS = 0;
  await explore.tick();
  ExploreService.TRANSIENT_GRACE_MS = grace;
  const failed = await explore.get(job.id);
  assert.equal(failed.status, "failed", "past the grace period it fails");
  assert.match(failed.error, /503/);
  boat.costDollars = cost;
});

test("an explorer's end is recorded before its sandbox stops, so a GitHub hiccup reading its branch is retried", async () => {
  const { db, explore, boat, repos, call, ready } = await setup();
  const { client } = await ready();
  const job = (await call(client, "start_exploration", { product_id: "quick-loan", algorithm_id: "uw", explorers: 1 })).data;
  await explore.tick();
  const sbx = await sandboxOf(db, job.id, 1);
  boat.ready(sbx);
  await explore.tick();
  const branch = boat.sandboxes.get(sbx).opts.env.MYNT_BRANCH;
  repos.refs.set(branch, "1".repeat(40));
  boat.finishAgent(sbx, 1, "Re-cut the grades");
  const resolve = repos.resolveRef;
  repos.resolveRef = async () => {
    throw new Error("GitHub couldn't resolve the branch (502)");
  };
  await explore.tick();
  assert.equal((await explore.get(job.id)).status, "exploring", "ridden out, not failed");
  const v = (await variants(explore, job.id)).find((x) => x.k === 1);
  assert.equal(v.status, "finishing");
  assert.equal(v.summary, "Re-cut the grades", "the agent's result is kept");
  assert.ok(boat.sandboxes.get(sbx).stopped);
  // The sandbox is gone now; reading the agent again would fail. The next tick only asks GitHub.
  boat.sandboxes.get(sbx).files.delete(`${A}/state.json`);
  repos.resolveRef = resolve;
  await explore.tick();
  const after = (await variants(explore, job.id)).find((x) => x.k === 1);
  assert.equal(after.status, "scoring");
  assert.equal(after.commit_sha, "1".repeat(40));
  assert.equal((await explore.get(job.id)).status, "scoring");
});

test("Mynt's checkout of a pinned commit works on a real repository (a SHA can't be cloned with --branch)", async () => {
  const origin = mkdtempSync(join(tmpdir(), "mynt-explore-origin-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd }).toString().trim();
  git(origin, "init", "-q", "-b", "main");
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(origin, "f.txt"), "pinned");
  git(origin, "add", "-A");
  git(origin, "commit", "-q", "-m", "pinned");
  const pinned = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "f.txt"), "moved on");
  git(origin, "commit", "-q", "-am", "later");
  // Capture the script Mynt writes, then run it against the local repository instead of GitHub.
  const files = new Map();
  const boat = { writeFile: async (_s, path, content) => void files.set(path, content), exec: async () => ({ processId: 1 }) };
  const base = mkdtempSync(join(tmpdir(), "mynt-explore-run-"));
  await startRepoRun(boat, { tokenFor: async () => ({ token: "t" }) }, "s", {
    repository: "acme/desk",
    installationId: 7,
    ref: pinned,
    dir: base,
    outcome: join(base, "outcome.json"),
    cloneFailure: { outcome: "error" },
    files: {},
    command: `git -C /home/user/workspace rev-parse HEAD > ${join(base, "head.txt")}; cat /home/user/workspace/f.txt >> ${join(base, "head.txt")}`,
  });
  const repoDir = join(base, "repo");
  const script = files
    .get(`${base}/run.sh`)
    .replaceAll("/home/user/workspace", repoDir)
    .replaceAll("https://github.com/acme/desk.git", `file://${origin}`)
    .replaceAll("/home/user/.mynt-git-credentials", join(base, "creds"));
  writeFileSync(join(base, "run.sh"), script);
  writeFileSync(join(base, "clone-failed.json"), "{}");
  const r = spawnSync("bash", [join(base, "run.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(base, "head.txt"), "utf8"), `${pinned}\npinned`, `checked out the pinned commit: ${readFileSync(join(base, "clone.log"), "utf8")}`);
});

test("the explorer workspace: its instructions, the angles, and the desk's skills copied verbatim", () => {
  const files = workspaceFiles("algorithm-explorer");
  for (const rule of [/autoresearch/, /Never use outcome labels or the protected group/, /Change only `model_dir`/, /Do not open a pull request/, /explore-log\.tsv/, /max_iterations/, /MYNT_GIT_TOKEN_FILE/, /push\*\* every kept state/]) assert.match(files["CLAUDE.md"], rule);
  const desk = workspaceFiles("product-desk");
  for (const skill of ["model-contract", "financial-modelling"]) assert.equal(files[`.claude/skills/${skill}/SKILL.md`], desk[`.claude/skills/${skill}/SKILL.md`]);
  assert.match(files[".claude/skills/model-contract/SKILL.md"], /MYNT_APPLICANTS/);
  assert.equal(explorationAngles().length, 5);
  assert.equal(new Set(explorationAngles().map((a) => a.id)).size, 5);
});
