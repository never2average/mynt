import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The build audit's script (workspaces/build-audit/scripts/audit.mjs), run for real against a stand-in for Maxwell:
// a local git repository with Maxwell's layout, whose headless launcher does what a test tells it to instead of
// starting Claude Code. No model, no network.

const SCRIPT = fileURLToPath(new URL("../workspaces/build-audit/scripts/audit.mjs", import.meta.url));

// The stand-in launcher: the arguments and environment it was given are kept for the test; `behaviour.json` says how
// each workflow's run goes.
const LAUNCHER = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
const opt = (f) => argv[argv.indexOf(f) + 1];
const workflow = opt("--workflow");
const company = opt("--company");
const how = JSON.parse(readFileSync("behaviour.json", "utf8"))[workflow] ?? "ok";
appendFileSync("pids.txt", process.pid + "\\n");
appendFileSync("launches.jsonl", JSON.stringify({ argv, claude: (process.env.PATH ?? "").split(":")[0], readonly: process.env.MAXWELL_CONFIG_READONLY }) + "\\n");
const transcript = join(process.env.HOME, ".claude", "projects", "-maxwell", workflow + ".jsonl");
const active = () => { mkdirSync(join(transcript, ".."), { recursive: true }); appendFileSync(transcript, "{}\\n"); };
const finding = (severity) => appendFileSync(join("company-profile", company, "soc", "main.jsonl"), JSON.stringify({ kind: "finding", id: "fnd_" + workflow, fingerprint: workflow + severity, title: "Unpinned base image", severity, status: "open", location: { path: "web/Dockerfile" }, provenance: { workflow } }) + "\\n");
const result = (doc) => writeFileSync(opt("--result-file"), JSON.stringify({ workflow, reportedCostUsd: 1, ...doc }));
const forever = () => setInterval(() => {}, 1000);
if (how === "ok") { active(); finding("medium"); result({ outcome: "success" }); }
else if (how === "refused") { mkdirSync(join(transcript, ".."), { recursive: true }); for (const id of ["req_vrtx_1", "req_vrtx_2"]) for (const type of ["assistant", "result"]) appendFileSync(transcript, JSON.stringify({ type, text: "API Error: Opus 4.8 can't help with this. Start a new session to continue. Learn more: https://example.test/legal/aup Details: \`[cyber]\` Request ID: " + id }) + "\\n"); result({ outcome: "error", outcomeReason: "2 agents failed (review web, refute web)" }); process.exit(1); }
else if (how === "nothing") { active(); result({ outcome: "success" }); }
else if (how === "fail") { active(); result({ outcome: "error", outcomeReason: "2 agents failed (scout, ledger)" }); process.exit(1); }
else if (how === "budget") { active(); result({ outcome: "max-budget", outcomeReason: "the budget of 4.25 USD was reached while the workflow was still running" }); process.exit(1); }
else if (how === "never-starts") forever();
else if (how === "goes-quiet") { active(); finding("high"); forever(); }
else if (how === "busy") { finding("high"); setInterval(active, 200); }
`;

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `${cmd} ${args.join(" ")}: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

// A Maxwell stand-in with two commits: one whose own checks pass, and a later tip whose checks fail.
function fixture({ workflows = ["scan-a", "scan-b"], minutes = 20, pin = true, behaviour = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mynt-audit-"));
  const origin = join(root, "origin");
  mkdirSync(join(origin, ".claude", "scripts"), { recursive: true });
  mkdirSync(join(origin, ".claude", "schemas", "vocab"), { recursive: true });
  writeFileSync(join(origin, "package.json"), JSON.stringify({ name: "maxwell-standin", version: "1.0.0", private: true, type: "module", scripts: { validate: "node validate.mjs" } }));
  writeFileSync(join(origin, "package-lock.json"), JSON.stringify({ name: "maxwell-standin", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "maxwell-standin", version: "1.0.0" } } }));
  writeFileSync(join(origin, "validate.mjs"), `import { existsSync } from "node:fs";\nif (existsSync("BROKEN") || existsSync("applications/bad")) { console.log("validate FAILED: validate:layout, validate:workflows"); process.exit(2); }\nconsole.log("validate OK: all stages passed");\n`);
  writeFileSync(join(origin, ".claude", "scripts", "run-headless.mjs"), LAUNCHER);
  writeFileSync(join(origin, ".claude", "schemas", "vocab", "workflows.schema.json"), JSON.stringify({ enum: ["scan-a", "scan-b", "scan-c"] }));
  writeFileSync(join(origin, ".gitignore"), "node_modules\nbehaviour.json\nlaunches.jsonl\napplications\ncompany-profile\n");
  const git = (...args) => sh("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], origin);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "good");
  const good = git("rev-parse", "HEAD");
  writeFileSync(join(origin, "BROKEN"), "a later merge broke the tool's own checks\n");
  git("add", "-A");
  git("commit", "-q", "-m", "broken tip");

  const home = join(root, "home");
  const work = join(root, "workspace");
  const claude = join(home, ".mynt-claude", "node_modules", ".bin");
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, "claude"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(claude, "claude"), 0o755);
  mkdirSync(join(work, "job"), { recursive: true });
  const output = join(root, "verify", "maxwell.json");
  const job = { app_dir: join(root, "audit-src"), maxwell_repo: origin, maxwell_commit: pin ? good : "", output, workflows, minutes, budget_usd: 5, model: "audit-model", attempt: 1, attempts: 2 };
  writeFileSync(join(work, "job", "audit.json"), JSON.stringify(job));
  const tool = join(home, "maxwell");
  const env = { ...process.env, HOME: home, MYNT_AUDIT_POLL_MS: "100", MYNT_AUDIT_STALL_START_S: "2", MYNT_AUDIT_STALL_S: "2", MYNT_AUDIT_RESERVE_S: "0", MYNT_AUDIT_MIN_START_S: "1" };
  delete env.CLAUDE_CONFIG_DIR;
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: work, env, encoding: "utf8" });
  return {
    root,
    home,
    tool,
    good,
    claude,
    run,
    report: () => JSON.parse(readFileSync(output, "utf8")),
    launches: () => readFileSync(join(tool, "launches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)),
    // What the auditor does by hand (the skill's step 2): the company's ledger and the application with its checkout.
    register() {
      mkdirSync(join(tool, "company-profile", "mynt-verify", "soc"), { recursive: true });
      writeFileSync(join(tool, "company-profile", "mynt-verify", "soc", "main.jsonl"), JSON.stringify({ kind: "control", id: "c-1" }) + "\n");
      mkdirSync(join(tool, "applications", "app", "repos", "web"), { recursive: true });
      writeFileSync(join(tool, "applications", "app", "repos", "web.json"), "{}");
      writeFileSync(join(tool, "applications", "app", "repos", "web", "index.ts"), "export {};\n");
      writeFileSync(join(tool, "behaviour.json"), JSON.stringify(behaviour));
    },
    // Follows the workflows the way the auditor does: `wait` again and again until it says FINISHED.
    finish() {
      let out = "";
      for (let i = 0; i < 40; i++) {
        out = run("wait", "--seconds", "5").stdout;
        if (/^FINISHED/m.test(out)) return out;
        assert.match(out, /^STILL RUNNING/m, out);
      }
      assert.fail(`never finished: ${out}`);
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("the audit runs Maxwell at the pinned commit through its own launcher, and reports from its ledger", () => {
  const f = fixture();
  try {
    const prepared = f.run("prepare");
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    assert.equal(sh("git", ["-C", f.tool, "rev-parse", "HEAD"]), f.good, "the pinned commit, not the broken tip");
    // The report exists from the first step, saying nothing has run.
    let r = f.report();
    assert.deepEqual([r.complete, r.workflows_run, r.skipped.map((s) => s.kind)], [false, [], ["pending", "pending"]]);
    assert.deepEqual(r.tool, { repository: join(f.root, "origin"), commit: f.good, checks: "passed" });

    // Nothing starts until the application is registered with a checkout to read.
    const early = f.run("run", "--company", "mynt-verify", "--app", "app");
    assert.equal(early.status, 2);
    assert.match(early.stderr, /no company 'mynt-verify' yet/);
    f.register();
    const started = f.run("run", "--company", "mynt-verify", "--app", "app");
    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /in the background/);
    assert.match(f.finish(), /^FINISHED\. complete: true/m);

    r = f.report();
    assert.equal(r.complete, true);
    assert.deepEqual(r.workflows_run, ["scan-a", "scan-b"]);
    assert.deepEqual(r.skipped, []);
    // Counts and findings are Maxwell's ledger records, added since the audit began (the control before it isn't one).
    assert.deepEqual(r.counts, { critical: 0, high: 0, medium: 2, low: 0 });
    assert.deepEqual(r.findings[0], { severity: "medium", title: "Unpinned base image", file: "web/Dockerfile", workflow: "scan-a" });

    // Launched the way Maxwell's launcher supports headless runs: one application, the audit's model, a budget that
    // leaves the waiting agent its share and falls by what the first run reported, no waiting out an account limit,
    // no permission prompt nobody can answer, a result file outside the workspace, Mynt's Claude Code on PATH.
    const [a, b] = f.launches();
    const arg = (l, flag) => l.argv[l.argv.indexOf(flag) + 1];
    assert.deepEqual([arg(a, "--workflow"), arg(a, "--company"), arg(a, "--app"), arg(a, "--model"), arg(a, "--limit-waits"), arg(a, "--permission-mode")], ["scan-a", "mynt-verify", "app", "audit-model", "0", "bypassPermissions"]);
    assert.equal(arg(a, "--budget-usd"), "4.25");
    assert.equal(arg(b, "--budget-usd"), "3.25");
    assert.ok(!arg(a, "--result-file").startsWith(f.tool));
    assert.equal(a.claude, f.claude);
    assert.equal(a.readonly, "1");
    // Maxwell's folder is trusted for Claude Code, or its own permission rules (the Workflow tool, its agents) are ignored.
    const trusted = JSON.parse(readFileSync(join(f.home, ".claude.json"), "utf8")).projects;
    assert.equal(Object.values(trusted)[0].hasTrustDialogAccepted, true);
    assert.match(Object.keys(trusted)[0], /maxwell$/);
    assert.match(f.run("run", "--company", "mynt-verify", "--app", "app").stdout, /Already finished/);
  } finally {
    f.cleanup();
  }
});

test("a Maxwell commit that fails its own checks is reported at once, before anything is spent", () => {
  const f = fixture({ pin: false });
  try {
    const prepared = f.run("prepare");
    assert.equal(prepared.status, 4);
    assert.match(prepared.stdout, /^TOOL PROBLEM: Maxwell's own checks \(npm run validate\) fail at commit [0-9a-f]{7}: validate FAILED: validate:layout, validate:workflows\. Pin a commit that passes them with BUILD_MAXWELL_COMMIT/m);
    const r = f.report();
    assert.equal(r.complete, false);
    assert.match(r.tool_problem, /npm run validate/);
    assert.deepEqual(r.skipped.map((s) => s.kind), ["tool", "tool"]);
    assert.equal(r.tool.checks, "failed");
    // Nothing can be started on it.
    const started = f.run("run", "--company", "mynt-verify", "--app", "app");
    assert.equal(started.status, 2);
    assert.ok(!existsSync(join(f.tool, "launches.jsonl")));
  } finally {
    f.cleanup();
  }

  // A workflow the pinned commit doesn't have is the same kind of problem: a setting to correct.
  const g = fixture({ workflows: ["scan-a", "execute-everything"] });
  try {
    assert.equal(g.run("prepare").status, 4);
    assert.match(g.report().tool_problem, /no workflow named execute-everything \(BUILD_AUDIT_WORKFLOWS\)/);
  } finally {
    g.cleanup();
  }
});

test("a run the model refused is reported as refused, with how many requests and their ids", () => {
  const f = fixture({ behaviour: { "scan-a": "refused" } });
  try {
    assert.equal(f.run("prepare").status, 0);
    f.register();
    assert.equal(f.run("run", "--company", "mynt-verify", "--app", "app").status, 0);
    f.finish();
    const r = f.report();
    assert.equal(r.complete, false);
    assert.deepEqual(r.workflows_run, ["scan-b"]);
    assert.deepEqual(r.skipped, [{ workflow: "scan-a", kind: "refused", reason: "the audit's model refused the security review: 2 refused request(s) [cyber], request id req_vrtx_1, req_vrtx_2 (Maxwell's run didn't complete: 2 agents failed (review web, refute web))" }]);
    assert.deepEqual(r.model_refusal, { workflows: ["scan-a"], count: 2, category: "cyber", request_ids: ["req_vrtx_1", "req_vrtx_2"] });
  } finally {
    f.cleanup();
  }
});

test("a registration Maxwell's checks reject, or one with no checkout, starts nothing", () => {
  const f = fixture();
  try {
    assert.equal(f.run("prepare").status, 0);
    f.register();
    rmSync(join(f.tool, "applications", "app", "repos", "web"), { recursive: true });
    const none = f.run("run", "--company", "mynt-verify", "--app", "app");
    assert.equal(none.status, 2);
    assert.match(none.stderr, /no local checkout/);
    f.register();
    mkdirSync(join(f.tool, "applications", "bad"));
    const invalid = f.run("run", "--company", "mynt-verify", "--app", "app");
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Maxwell's checks \(npm run validate\) fail with this registration/);
    assert.ok(!existsSync(join(f.tool, "launches.jsonl")));
  } finally {
    f.cleanup();
  }
});

test("a stuck workflow is ended in seconds, not waited on, and what it had found is still reported", () => {
  const f = fixture({ workflows: ["scan-a", "scan-b", "scan-c"], behaviour: { "scan-a": "never-starts", "scan-b": "goes-quiet", "scan-c": "ok" } });
  try {
    assert.equal(f.run("prepare").status, 0);
    f.register();
    assert.equal(f.run("run", "--company", "mynt-verify", "--app", "app").status, 0);
    const began = Date.now();
    const out = f.finish();
    assert.ok(Date.now() - began < 30_000, "ended by the script's own watch");
    assert.match(out, /^FINISHED\. complete: false/m);
    const r = f.report();
    assert.equal(r.complete, false);
    assert.deepEqual(r.workflows_run, ["scan-c"], "the next workflow still gets its turn");
    assert.deepEqual(r.skipped.map((s) => [s.workflow, s.kind]), [["scan-a", "stalled"], ["scan-b", "stalled"]]);
    assert.match(r.skipped[0].reason, /made no model call in the \d+ s after it was launched/);
    assert.match(r.skipped[1].reason, /no model activity for \d+ s/);
    // scan-b's finding reached the ledger before it went quiet: it is in the report, with scan-c's.
    assert.deepEqual(r.counts, { critical: 0, high: 1, medium: 1, low: 0 });
    assert.deepEqual(r.findings.map((x) => x.workflow), ["scan-b", "scan-c"]);
    for (const pid of readFileSync(join(f.tool, "pids.txt"), "utf8").trim().split("\n")) assert.throws(() => process.kill(Number(pid), 0), `the stuck run ${pid} was ended`);
  } finally {
    f.cleanup();
  }
});

test("at the time limit the running workflow is stopped, the rest aren't started, and the report says which and why", () => {
  // Twelve seconds in all: scan-a keeps working past them.
  const f = fixture({ minutes: 0.2, behaviour: { "scan-a": "busy" } });
  try {
    assert.equal(f.run("prepare").status, 0);
    f.register();
    writeFileSync(join(f.root, "workspace", "job", "audit.json"), readFileSync(join(f.root, "workspace", "job", "audit.json"))); // the clock starts now
    assert.equal(f.run("run", "--company", "mynt-verify", "--app", "app").status, 0);
    // While it runs, the report already carries what the ledger holds.
    let mid = null;
    for (let i = 0; i < 40 && !(mid = f.report()).findings.length; i++) spawnSync("sleep", ["0.1"]);
    assert.deepEqual([mid.complete, mid.counts.high, mid.skipped[0].kind], [false, 1, "pending"]);
    assert.match(mid.skipped[0].reason, /still running/);
    f.finish();
    const r = f.report();
    assert.equal(r.complete, false);
    assert.deepEqual(r.skipped.map((s) => [s.workflow, s.kind]), [["scan-a", "time"], ["scan-b", "time"]]);
    assert.match(r.skipped[0].reason, /stopped at the 0\.2-minute limit/);
    assert.match(r.skipped[1].reason, /^not started: 0 min of the 0\.2-minute limit was left$/);
    assert.equal(r.counts.high, 1, "found before the limit, reported after it");
    assert.equal(f.launches().length, 1);
  } finally {
    f.cleanup();
  }
});

test("a run that fails or spends its share says so in Maxwell's own words, and a budget that's gone starts nothing", () => {
  const f = fixture({ workflows: ["scan-a", "scan-b", "scan-c"], behaviour: { "scan-a": "fail", "scan-b": "budget", "scan-c": "nothing" } });
  try {
    assert.equal(f.run("prepare").status, 0);
    f.register();
    assert.equal(f.run("run", "--company", "mynt-verify", "--app", "app").status, 0);
    f.finish();
    const r = f.report();
    assert.deepEqual(r.skipped.map((s) => [s.workflow, s.kind]), [["scan-a", "failed"], ["scan-b", "budget"]]);
    assert.equal(r.skipped[0].reason, "Maxwell's run didn't complete: 2 agents failed (scout, ledger)");
    assert.match(r.skipped[1].reason, /^stopped at its US\$3\.25 share of the audit's budget: the budget of 4\.25 USD was reached/);
    assert.deepEqual(r.workflows_run, ["scan-c"]);
    // A workflow that finished without recording anything counts as run, and the report says it had nothing to examine.
    assert.match(r.summary, /Finished without recording anything, so found nothing of theirs to examine in this application: scan-c\./);
    assert.equal(r.progress[2].ledger_records, 0);
    assert.equal(r.complete, false);
  } finally {
    f.cleanup();
  }

  // US$0.60 for the attempt: the waiting agent's share leaves too little to start a workflow on.
  const g = fixture();
  try {
    const jobFile = join(g.root, "workspace", "job", "audit.json");
    writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(readFileSync(jobFile, "utf8")), budget_usd: 0.6 }));
    assert.equal(g.run("prepare").status, 0);
    g.register();
    assert.equal(g.run("run", "--company", "mynt-verify", "--app", "app").status, 0);
    g.finish();
    assert.deepEqual(g.report().skipped.map((s) => s.kind), ["budget", "budget"]);
    assert.ok(!existsSync(join(g.tool, "launches.jsonl")));
  } finally {
    g.cleanup();
  }
});
