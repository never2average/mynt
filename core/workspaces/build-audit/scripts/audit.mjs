#!/usr/bin/env node
// Runs Maxwell's workflows for a Mynt build audit and keeps the report at job/audit.json's `output` up to date.
//
//   node scripts/audit.mjs prepare                         fetch Maxwell at the pinned commit, install it, check it
//   node scripts/audit.mjs run --company <id> --app <id>   start the workflows in the background; returns at once
//   node scripts/audit.mjs wait [--seconds 100]            follow them; says whether they are still running
//   node scripts/audit.mjs status                          one line per workflow
//
// Why a script: a workflow is a long headless Claude Code run of Maxwell's own (run-headless.mjs), far longer than one
// shell command may take. So it runs detached, and this script watches it: a run that produces no model activity is
// ended in minutes, a run still going at the time limit is ended there, and after every look the report is rewritten
// from Maxwell's ledger, so whatever was found so far is reported even when the audit doesn't finish.
// Nothing here reads or writes the application: Maxwell's agents read it through the application record.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
const HOME = env.HOME || homedir();
const JOB_FILE = resolve(env.MYNT_AUDIT_JOB || "job/audit.json");
const STATE_DIR = env.MYNT_AUDIT_HOME || join(HOME, "mynt-audit");
const TOOL_DIR = env.MYNT_AUDIT_TOOL_DIR || join(HOME, "maxwell");
// Mynt's pinned Claude Code (the one this audit itself runs on): Maxwell's launcher calls `claude` from PATH.
const CLAUDE_DIR = env.MYNT_AUDIT_CLAUDE_DIR || join(HOME, ".mynt-claude", "node_modules", ".bin");
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);
const POLL_MS = num(env.MYNT_AUDIT_POLL_MS, 5000);
// No model activity at all this long after launch, or none for this long later on: the run is stuck. The second is
// longer than the ten minutes one command of a Maxwell agent (a scanner, say) may take, when nothing else is written.
const STALL_START_S = num(env.MYNT_AUDIT_STALL_START_S, 120);
const STALL_S = num(env.MYNT_AUDIT_STALL_S, 660);
// Kept back from the time limit to write the last report and end cleanly before Mynt stops waiting.
const RESERVE_S = num(env.MYNT_AUDIT_RESERVE_S, 90);
// A workflow isn't started with less than this left.
const MIN_START_S = num(env.MYNT_AUDIT_MIN_START_S, 180);
const MIN_START_USD = 0.5;
const SEVERITIES = ["critical", "high", "medium", "low"];

const now = () => Date.now();
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const writeJson = (file, value) => {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
};
const fail = (code, message) => {
  console.error(message);
  process.exit(code);
};

const job = readJson(JOB_FILE);
if (!job || !Array.isArray(job.workflows) || typeof job.output !== "string") fail(1, `No usable job file at ${JOB_FILE}`);
const STATE_FILE = join(STATE_DIR, "state.json");
const loadState = () => readJson(STATE_FILE);
const saveState = (s) => writeJson(STATE_FILE, s);
// The audit's clock starts when Mynt wrote the job file, which is when it started counting.
const startedMs = () => {
  try {
    return statSync(JOB_FILE).mtimeMs;
  } catch {
    return now();
  }
};
const deadlineMs = () => startedMs() + num(job.minutes, 20) * 60_000 - RESERVE_S * 1000;
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const killGroup = (pid) => {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

// ---- Maxwell's ledger: the only source of findings and counts ----

const ledgerFile = (company) => join(TOOL_DIR, "company-profile", company, "soc", "main.jsonl");
const ledgerSize = (company) => {
  try {
    return statSync(ledgerFile(company)).size;
  } catch {
    return 0;
  }
};
// Findings appended since `from` bytes: the latest record per fingerprint, without those Maxwell closed or refuted.
function ledgerFindings(company, from) {
  let text = "";
  try {
    text = readFileSync(ledgerFile(company)).subarray(from).toString("utf8");
  } catch {
    return { records: 0, findings: [] };
  }
  const latest = new Map();
  let records = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    records += 1;
    if (rec.kind !== "finding") continue;
    latest.set(rec.fingerprint || rec.id || `line-${records}`, rec);
  }
  const findings = [...latest.values()]
    .filter((r) => !/^(closed|false|refuted|withdrawn)/i.test(String(r.status ?? "")))
    .map((r) => ({
      severity: String(r.severity ?? "").toLowerCase(),
      title: clip(oneLine(r.title), 200),
      file: String(r.location?.path ?? r.target?.path ?? ""),
      workflow: String(r.provenance?.workflow ?? ""),
    }));
  return { records, findings };
}

// ---- The report Mynt reads ----

function writeReport(state, final = false) {
  const { records, findings } = state.company ? ledgerFindings(state.company, state.ledger_base ?? 0) : { records: 0, findings: [] };
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length]));
  const runs = state.workflows ?? {};
  const ran = job.workflows.filter((w) => runs[w]?.state === "ran");
  const skipped = job.workflows
    .filter((w) => runs[w]?.state !== "ran")
    .map((w) => {
      const r = runs[w];
      if (state.tool_problem) return { workflow: w, kind: "tool", reason: `not started: ${state.tool_problem}` };
      if (!r || r.state === "pending") return { workflow: w, kind: "pending", reason: "not run yet" };
      if (r.state === "running") return { workflow: w, kind: "pending", reason: `still running after ${Math.round((now() - r.started_ms) / 60_000)} min (${r.agents ?? 0} agent run(s) so far)` };
      return { workflow: w, kind: r.kind, reason: r.reason };
    });
  const complete = final && !state.tool_problem && ran.length === job.workflows.length;
  const empty = ran.filter((w) => runs[w].records === 0);
  // The model provider refused the work in some run: which workflows, how many requests, their ids.
  const refusedIn = job.workflows.filter((w) => runs[w]?.refusal);
  const refusal = refusedIn.length ? { workflows: refusedIn, count: refusedIn.reduce((n, w) => n + runs[w].refusal.count, 0), category: runs[refusedIn[0]].refusal.category, request_ids: refusedIn.flatMap((w) => runs[w].refusal.request_ids).slice(0, 3) } : null;
  const report = {
    complete,
    counts,
    findings,
    workflows_run: ran,
    skipped,
    summary: state.tool_problem
      ? `Maxwell couldn't be used: ${state.tool_problem}`
      : `${ran.length} of ${job.workflows.length} workflow(s) finished; ${findings.length} finding(s) in ${records} ledger record(s) so far.` +
        (skipped.length ? ` Not finished: ${skipped.map((s) => `${s.workflow} (${s.kind})`).join(", ")}.` : "") +
        (empty.length ? ` Finished without recording anything, so found nothing of theirs to examine in this application: ${empty.join(", ")}.` : ""),
    ...(state.tool_problem ? { tool_problem: state.tool_problem } : {}),
    ...(refusal ? { model_refusal: refusal } : {}),
    tool: { repository: job.maxwell_repo ?? null, commit: state.tool_commit ?? null, checks: state.tool_checks ?? "not run" },
    progress: job.workflows.map((w) => ({ workflow: w, state: runs[w]?.state ?? "pending", minutes: runs[w]?.started_ms ? Math.round(((runs[w].ended_ms ?? now()) - runs[w].started_ms) / 6000) / 10 : 0, agents: runs[w]?.agents ?? 0, ledger_records: runs[w]?.records ?? null, cost_usd: runs[w]?.cost_usd ?? null })),
    written_by: "scripts/audit.mjs",
  };
  mkdirSync(resolve(job.output, ".."), { recursive: true });
  writeJson(job.output, report);
  return report;
}

// ---- prepare: Maxwell at the pinned commit, installed and checked, before a cent is spent on a workflow ----

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error ? r.error.message : "" };
}

function prepare() {
  mkdirSync(STATE_DIR, { recursive: true });
  const old = loadState();
  if (old?.worker_pid && alive(old.worker_pid)) killGroup(old.worker_pid);
  for (const r of Object.values(old?.workflows ?? {})) if (r.pid && alive(r.pid)) killGroup(r.pid);
  const state = { prepared: false, tool_commit: null, tool_checks: "not run", tool_problem: null, workflows: {}, company: null, app: null, ledger_base: 0, worker_pid: null, finished: false };
  saveState(state);
  writeReport(state);
  const problem = (text) => {
    state.tool_problem = clip(oneLine(text), 400);
    state.finished = true;
    saveState(state);
    writeReport(state, true);
    console.log(`TOOL PROBLEM: ${state.tool_problem}`);
    console.log("The report says so. This is Mynt's to fix, not the application's: stop here, run nothing else, and end your turn.");
    process.exit(4);
  };
  try {
    accessSync(join(CLAUDE_DIR, "claude"), constants.X_OK);
  } catch {
    problem(`Claude Code isn't installed at ${CLAUDE_DIR}, so Maxwell's launcher has nothing to run`);
  }
  // An earlier attempt's checkout is kept, with what it registered.
  const fresh = !existsSync(join(TOOL_DIR, ".git"));
  if (fresh) {
    const c = sh("git", ["clone", "--quiet", String(job.maxwell_repo), TOOL_DIR], { timeout: 180_000 });
    if (!c.ok) problem(`couldn't fetch Maxwell from ${job.maxwell_repo}: ${c.out.slice(-300) || c.error}`);
    if (job.maxwell_commit) {
      const k = sh("git", ["-C", TOOL_DIR, "checkout", "--quiet", "--detach", String(job.maxwell_commit)], { timeout: 60_000 });
      if (!k.ok) problem(`Maxwell has no commit ${job.maxwell_commit} (BUILD_MAXWELL_COMMIT): ${k.out.slice(-300) || k.error}`);
    }
  }
  state.tool_commit = sh("git", ["-C", TOOL_DIR, "rev-parse", "HEAD"]).out.trim().slice(0, 40) || null;
  if (job.maxwell_commit && state.tool_commit !== job.maxwell_commit) problem(`Maxwell's checkout is at ${state.tool_commit}, not the pinned ${job.maxwell_commit}`);
  if (!existsSync(join(TOOL_DIR, "node_modules"))) {
    const i = sh("npm", ["ci", "--no-audit", "--no-fund"], { cwd: TOOL_DIR, timeout: 420_000 });
    if (!i.ok) problem(`Maxwell's dependencies didn't install (npm ci): ${i.out.slice(-300) || i.error}`);
  }
  const launcher = join(TOOL_DIR, ".claude", "scripts", "run-headless.mjs");
  if (!existsSync(launcher)) problem("this Maxwell commit has no headless launcher (.claude/scripts/run-headless.mjs)");
  const known = readJson(join(TOOL_DIR, ".claude", "schemas", "vocab", "workflows.schema.json"))?.enum;
  const unknown = Array.isArray(known) ? job.workflows.filter((w) => !known.includes(w)) : [];
  if (unknown.length) problem(`Maxwell at ${state.tool_commit?.slice(0, 7)} has no workflow named ${unknown.join(", ")} (BUILD_AUDIT_WORKFLOWS)`);
  // Maxwell's own checks, on the commit as fetched. One that fails them can't be relied on to record what it finds,
  // so nothing is run on it. (On a kept checkout a failure may be the earlier registration's: `run` checks that.)
  const v = sh("npm", ["run", "--silent", "validate"], { cwd: TOOL_DIR, timeout: 300_000 });
  state.tool_checks = v.ok ? "passed" : fresh ? "failed" : "failed with an earlier attempt's registration";
  if (!v.ok && fresh) {
    const failed = /validate FAILED:[^\n]*/.exec(v.out)?.[0] ?? v.out.slice(-300);
    problem(`Maxwell's own checks (npm run validate) fail at commit ${state.tool_commit?.slice(0, 7)}: ${failed}. Pin a commit that passes them with BUILD_MAXWELL_COMMIT`);
  }
  state.prepared = true;
  saveState(state);
  writeReport(state);
  console.log(`Maxwell is ready at ${TOOL_DIR} (commit ${state.tool_commit}); its own checks ${v.ok ? "pass" : "fail with what an earlier attempt registered there: put that registration right in step 2"}. The report at ${job.output} is started.`);
  console.log("Next: register the company and the application (the skill's step 2), then `node scripts/audit.mjs run --company <company_id> --app <app_id>`.");
}

// A headless Claude Code ignores a folder's own permissions.allow entries (for Maxwell: the Workflow tool, its agents
// and its scripts) until the folder is trusted, and nobody can answer its trust dialog here. Mynt pinned and checked
// this commit, so its folder is marked trusted the way Claude Code's own message says to: in the user's .claude.json.
function trustTool() {
  const file = join(env.CLAUDE_CONFIG_DIR || HOME, ".claude.json");
  const config = readJson(file) ?? {};
  const dir = realpathSync(TOOL_DIR);
  config.projects = { ...(config.projects ?? {}) };
  config.projects[dir] = { ...(config.projects[dir] ?? {}), hasTrustDialogAccepted: true };
  writeJson(file, config);
}

// ---- run: start the worker, detached ----

function run(argv) {
  const opt = (f) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const state = loadState();
  if (!state?.prepared) fail(2, state?.tool_problem ? `Not started: ${state.tool_problem}` : "Run `node scripts/audit.mjs prepare` first.");
  if (state.worker_pid && alive(state.worker_pid)) return console.log("Already running. Follow it with `node scripts/audit.mjs wait`.");
  if (state.finished) return console.log("Already finished; the report is written. Nothing more to run.");
  const company = opt("--company");
  const app = opt("--app");
  const slug = /^[a-z0-9][a-z0-9-]{1,62}$/;
  if (!slug.test(company ?? "") || !slug.test(app ?? "")) fail(2, "usage: audit.mjs run --company <company_id> --app <app_id> (lower-case ids, as registered in Maxwell)");
  if (!existsSync(ledgerFile(company))) fail(2, `Maxwell has no company '${company}' yet (${ledgerFile(company)} is missing). Register it first (the skill's step 2).`);
  const repos = join(TOOL_DIR, "applications", app, "repos");
  let records = [];
  try {
    records = readdirSync(repos).filter((f) => f.endsWith(".json"));
  } catch {
    // no application yet
  }
  if (!records.length) fail(2, `Maxwell has no application '${app}' with a repository record (${repos}/<repo_id>.json). Register it first (the skill's step 2).`);
  const checkouts = records.filter((f) => {
    try {
      return readdirSync(join(repos, f.replace(/\.json$/, ""))).length > 0;
    } catch {
      return false;
    }
  });
  if (!checkouts.length) fail(2, `Application '${app}' has no local checkout under ${repos}/<repo_id>/, so every workflow would find nothing to read. Give it one (a copy or a clone of app_dir; never a change to app_dir itself).`);
  // The registration must pass Maxwell's own checks: its hooks reject every record written beside an invalid one.
  const v = sh("npm", ["run", "--silent", "validate"], { cwd: TOOL_DIR, timeout: 300_000 });
  if (!v.ok) fail(2, `Maxwell's checks (npm run validate) fail with this registration; fix what they name, then run this again:\n${v.out.slice(-1500)}`);
  Object.assign(state, { company, app, ledger_base: ledgerSize(company), workflows: Object.fromEntries(job.workflows.map((w) => [w, { state: "pending" }])) });
  trustTool();
  const log = openSync(join(STATE_DIR, "worker.log"), "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "worker"], { detached: true, stdio: ["ignore", log, log], env });
  closeSync(log);
  child.unref();
  state.worker_pid = child.pid;
  saveState(state);
  writeReport(state);
  console.log(`Started ${job.workflows.join(", ")} for ${company}/${app} in the background (worker ${child.pid}).`);
  console.log("Now run `node scripts/audit.mjs wait` again and again until it says FINISHED. Don't end your turn before that.");
}

// ---- worker: one workflow after another, watched ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const projectSlug = (dir) => dir.replace(/[^A-Za-z0-9]/g, "-");
// Claude Code's transcripts for runs started in Maxwell's folder (the lead's and every agent's): their growth is the
// sign a workflow is alive. This audit's own transcript (another project folder) is left out.
function transcripts(sinceMs) {
  const root = join(env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"), "projects");
  const mine = projectSlug(process.cwd());
  let count = 0;
  let latest = 0;
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 5 && !(depth === 0 && e.name === mine)) walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl") || e.name.endsWith(".json") || e.name.endsWith(".output")) {
        let m = 0;
        try {
          m = statSync(p).mtimeMs;
        } catch {
          continue;
        }
        if (m < sinceMs) continue;
        if (e.name.endsWith(".jsonl")) count += 1;
        if (m > latest) latest = m;
      }
    }
  };
  walk(root, 0);
  return { count, latest };
}

async function worker() {
  const state = loadState();
  const done = (w, patch) => {
    Object.assign(state.workflows[w], { ended_ms: now(), pid: null }, patch);
    saveState(state);
    writeReport(state);
  };
  // What's left of the audit's budget for Maxwell's own runs: a share stays with the agent that waits on them.
  const budget = num(job.budget_usd, 0);
  let left = budget > 0 ? budget - Math.max(0.5, budget * 0.15) : Infinity;
  const path = `${CLAUDE_DIR}${delimiter}${env.PATH ?? ""}`;
  for (const w of job.workflows) {
    const secondsLeft = (deadlineMs() - now()) / 1000;
    if (secondsLeft < MIN_START_S) {
      done(w, { state: "skipped", kind: "time", reason: `not started: ${Math.max(0, Math.round(secondsLeft / 60))} min of the ${job.minutes}-minute limit was left` });
      continue;
    }
    if (left < MIN_START_USD) {
      done(w, { state: "skipped", kind: "budget", reason: `not started: US$${Math.max(0, left).toFixed(2)} of the audit's US$${budget} budget was left` });
      continue;
    }
    const resultFile = join(STATE_DIR, `result.${w}.json`);
    const args = [".claude/scripts/run-headless.mjs", "--workflow", w, "--company", state.company, "--app", state.app, "--result-file", resultFile, "--limit-waits", "0", "--permission-mode", "bypassPermissions"];
    if (job.model) args.push("--model", String(job.model));
    if (Number.isFinite(left)) args.push("--budget-usd", left.toFixed(2));
    const out = openSync(join(STATE_DIR, `${w}.log`), "w");
    const allotted = left;
    const recordsFrom = ledgerSize(state.company);
    const started = now();
    // MAXWELL_CONFIG_READONLY: a hosted run, so Maxwell's agents can't change its settings. Its own group, so the
    // launcher and the Claude Code it starts can be ended together.
    const child = spawn(process.execPath, args, { cwd: TOOL_DIR, detached: true, stdio: ["ignore", out, out], env: { ...env, PATH: path, MAXWELL_CONFIG_READONLY: "1" } });
    closeSync(out);
    let exit = null;
    child.on("exit", (code) => (exit = code ?? 1));
    child.on("error", () => (exit = 127));
    Object.assign(state.workflows[w], { state: "running", started_ms: started, pid: child.pid, agents: 0 });
    saveState(state);
    let stopped = null;
    while (exit === null) {
      await sleep(POLL_MS);
      const t = transcripts(started);
      let ledgerAt = 0;
      try {
        ledgerAt = statSync(ledgerFile(state.company)).mtimeMs;
      } catch {
        // no ledger write yet
      }
      const last = Math.max(t.latest, ledgerAt >= started ? ledgerAt : 0);
      state.workflows[w].agents = t.count;
      state.workflows[w].last_activity_ms = last || null;
      saveState(state);
      writeReport(state);
      if (exit !== null) break;
      const ran = Math.round((now() - started) / 1000);
      if (now() >= deadlineMs()) stopped = { kind: "time", reason: `stopped at the ${job.minutes}-minute limit after running ${Math.round(ran / 60)} min (${t.count} agent run(s) so far)` };
      else if (!last && ran > STALL_START_S) stopped = { kind: "stalled", reason: `stopped as stuck: Maxwell's Claude Code run made no model call in the ${ran} s after it was launched` };
      else if (last && now() - last > STALL_S * 1000) stopped = { kind: "stalled", reason: `stopped as stuck: no model activity for ${Math.round((now() - last) / 1000)} s, ${Math.round(ran / 60)} min in (${t.count} agent run(s) so far)` };
      if (stopped) {
        killGroup(child.pid);
        break;
      }
    }
    const result = readJson(resultFile);
    const cost = typeof result?.reportedCostUsd === "number" ? result.reportedCostUsd : null;
    if (cost !== null) left -= cost;
    // What this workflow added to the ledger: one that finishes having recorded nothing found nothing to examine.
    state.workflows[w].records = ledgerFindings(state.company, recordsFrom).records;
    // The model provider refusing the work (its usage-policy safeguards) is its own kind of end: no rerun changes it,
    // and Maxwell's launcher never quotes the session's text, so it is read from the run's own records here.
    const refused = result?.outcome === "success" ? null : refusals(started, [typeof result?.result === "string" ? result.result : "", tail(join(STATE_DIR, `${w}.log`), 20_000)]);
    if (refused) {
      state.workflows[w].refusal = refused;
      const was = stopped ? stopped.reason : result?.outcomeReason ? `Maxwell's run didn't complete: ${oneLine(result.outcomeReason)}` : `Maxwell's launcher exited ${exit}`;
      done(w, { state: "skipped", kind: "refused", reason: clip(`the audit's model refused the security review: ${refused.count} refused request(s)${refused.category ? ` [${refused.category}]` : ""}${refused.request_ids.length ? `, request id ${refused.request_ids.join(", ")}` : ""} (${was})`, 400), cost_usd: cost });
    } else if (stopped) done(w, { state: "skipped", ...stopped, cost_usd: cost });
    else if (result?.outcome === "success") done(w, { state: "ran", cost_usd: cost });
    else if (result?.outcome === "max-budget") done(w, { state: "skipped", kind: "budget", reason: `stopped at ${Number.isFinite(allotted) ? `its US$${allotted.toFixed(2)} share of ` : ""}the audit's budget: ${clip(oneLine(result.outcomeReason), 200)}`, cost_usd: cost });
    else done(w, { state: "skipped", kind: "failed", reason: clip(oneLine(result?.outcomeReason ? `Maxwell's run didn't complete: ${result.outcomeReason}` : `Maxwell's launcher exited ${exit} without a result: ${tail(join(STATE_DIR, `${w}.log`))}`), 400), cost_usd: cost });
  }
  state.finished = true;
  state.worker_pid = null;
  saveState(state);
  writeReport(state, true);
}

// A refusal as Claude Code reports it: "API Error: <model> can't help with this. Start a new session to continue.
// Learn more: …/legal/aup Details: `[cyber]` Request ID: req_…". Looked for in the texts given and in every
// transcript of Maxwell's runs written since `sinceMs` (the lead's and each agent's).
const REFUSAL = /API Error:[^"\n]{0,200}?(?:can't help with this|can(?:’|\\u2019)t help with this|legal\/aup)[^"\n]{0,400}/g;
function refusals(sinceMs, texts) {
  const found = [...texts];
  const root = join(env.CLAUDE_CONFIG_DIR || join(HOME, ".claude"), "projects");
  const mine = projectSlug(process.cwd());
  let budget = 64 * 1024 * 1024;
  const walk = (dir, depth) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 5 && !(depth === 0 && e.name === mine)) walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl") && budget > 0) {
        try {
          const s = statSync(p);
          if (s.mtimeMs < sinceMs || s.size > 16 * 1024 * 1024) continue;
          budget -= s.size;
          found.push(readFileSync(p, "utf8"));
        } catch {
          // gone or unreadable
        }
      }
    }
  };
  walk(root, 0);
  const ids = new Set();
  let count = 0;
  let category = null;
  for (const text of found) {
    for (const m of text.matchAll(REFUSAL)) {
      const id = /Request ID:\s*(req_[A-Za-z0-9_-]+)/.exec(m[0])?.[1];
      // One refusal is written to a transcript more than once (the error, then the result that quotes it).
      if (id && ids.has(id)) continue;
      if (id) ids.add(id);
      count += 1;
      category ??= /Details:\s*\\?`?\[([a-z_ -]{1,40})\]/i.exec(m[0])?.[1] ?? null;
    }
  }
  return count ? { count, category, request_ids: [...ids].slice(0, 3) } : null;
}

function tail(file, n = 240) {
  try {
    return oneLine(readFileSync(file, "utf8").slice(-n));
  } catch {
    return "";
  }
}

// ---- wait / status ----

function lines(state) {
  return job.workflows.map((w) => {
    const r = state.workflows?.[w] ?? { state: "pending" };
    if (r.state === "running") {
      const quiet = r.last_activity_ms ? `${Math.round((now() - r.last_activity_ms) / 1000)} s since the last model activity` : "no model activity yet";
      return `  ${w}: running ${Math.round((now() - r.started_ms) / 60_000)} min, ${r.agents ?? 0} agent run(s), ${quiet}`;
    }
    if (r.state === "ran") return `  ${w}: finished in ${Math.round((r.ended_ms - r.started_ms) / 60_000)} min`;
    if (r.state === "skipped") return `  ${w}: NOT finished (${r.kind}): ${r.reason}`;
    return `  ${w}: waiting its turn`;
  });
}

async function wait(argv) {
  const i = argv.indexOf("--seconds");
  // 100 s by default: inside a shell command's usual two-minute limit. Up to 540 s where that limit is raised.
  const seconds = Math.min(540, Math.max(1, num(i >= 0 ? argv[i + 1] : undefined, 100)));
  const until = now() + seconds * 1000;
  for (;;) {
    const state = loadState();
    if (!state) fail(2, "Nothing to wait for: run `node scripts/audit.mjs prepare` first.");
    if (!state.finished && state.worker_pid && !alive(state.worker_pid)) {
      // The worker died: say so in the report rather than leave workflows "running" for ever.
      for (const r of Object.values(state.workflows)) if (r.state === "running" || r.state === "pending") Object.assign(r, { state: "skipped", kind: "failed", reason: `the audit's worker stopped unexpectedly: ${tail(join(STATE_DIR, "worker.log")) || "nothing logged"}` });
      state.finished = true;
      state.worker_pid = null;
      saveState(state);
      writeReport(state, true);
    }
    if (state.finished) {
      const report = writeReport(state, true);
      console.log(`FINISHED. complete: ${report.complete}. ${report.summary}`);
      console.log(lines(state).join("\n"));
      console.log(`The report is at ${job.output}; it is final. Don't edit it. End your turn now.`);
      return;
    }
    if (!state.worker_pid) fail(2, "Nothing is running: start the workflows with `node scripts/audit.mjs run --company <id> --app <id>`.");
    if (now() >= until) {
      console.log(`STILL RUNNING (${Math.max(0, Math.round((deadlineMs() - now()) / 60_000))} min of the limit left):`);
      console.log(lines(state).join("\n"));
      console.log("Run `node scripts/audit.mjs wait` again. Don't end your turn, and don't start or stop anything yourself.");
      return;
    }
    await sleep(Math.min(POLL_MS, 2000));
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "prepare") prepare();
else if (command === "run") run(rest);
else if (command === "worker") await worker();
else if (command === "wait") await wait(rest);
else if (command === "status") console.log(lines(loadState() ?? {}).join("\n"));
else fail(1, "usage: audit.mjs prepare | run --company <id> --app <id> | wait [--seconds n] | status");
