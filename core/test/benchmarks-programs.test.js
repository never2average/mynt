import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { bdConfigFromEnv } from "../dist/bd.js";
import { programSample, taskSetFor } from "../dist/benchmark-tasks.js";
import { BenchmarkService } from "../dist/benchmarks.js";
import { buildConfigFromEnv } from "../dist/builds.js";
import { deskConfigFromEnv } from "../dist/desk.js";
import { reviewConfigFromEnv } from "../dist/review.js";
import { gateConfigFromEnv, MainnetGateService } from "../dist/solana/mainnet-gate.js";
import { SolanaService } from "../dist/solana/service.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// The mainnet gate's two agents on benchmark samples. The agents here are stand-ins: a sandbox host whose "agent" is
// this file writing the files a real auditor or red team would. Everything around them is the production code: the
// gate's own steps, scripts, agent launch and verdict logic, and the benchmark's scoring of what Mynt recorded.

const T = "financial_products";
const A = "/home/user/mynt-agent";
const SAMPLE = "/home/user/mynt-sample";
const GATE = "/home/user/mynt-gate";
const CONFIRM = "/home/user/mynt-confirm";
const AUDIT_JOB = "/home/user/workspaces/program-audit/job";
const RED_JOB = "/home/user/workspaces/program-red-team/job";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("a stand-in program, never run"), Buffer.alloc(64)]);
// Mynt's build records a program's hash without its zero padding (solana-verify.sh).
const padless = (b) => sha(b.subarray(0, b.length - 64));
const STATIC_OK = { tools: [{ name: "cargo-audit", version: "0", status: "ran", detail: "", findings: [] }, { name: "radar", version: "0", status: "ran", detail: "", findings: [] }] };

// `play` says what each stand-in writes: { prep, static, findings, report, pocs, results } per sample name.
function standInHost(play) {
  const sandboxes = new Map();
  let n = 0;
  const put = (s, path, value) => s.files.set(path, Buffer.isBuffer(value) ? value : Buffer.from(typeof value === "string" ? value : JSON.stringify(value)));
  const host = {
    sandboxes,
    commands: [],
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, opts, files: new Map(), stopped: false, cost: 0.05, agentDone: true });
      return { id, state: "ready" };
    },
    async getSandbox(id) {
      return { id, state: "ready" };
    },
    async writeFile(id, path, content) {
      put(sandboxes.get(id), path, content);
    },
    async readFile(id, path) {
      return sandboxes.get(id).files.get(path)?.toString("utf8") ?? null;
    },
    async costDollars(id) {
      return sandboxes.get(id).cost;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    async downloadUrl() {
      throw new Error("not used");
    },
    async host() {
      throw new Error("not used");
    },
    async commandStatus() {
      return { running: false, exitCode: 0 };
    },
    async exec(id, command) {
      const s = sandboxes.get(id);
      host.commands.push({ id, role: s.opts.labels?.mynt_role, command });
      // Mynt reading a file back in chunks.
      const chunk = /tail -c \+(\d+) (\S+) \| head -c (\d+) \| base64/.exec(command);
      if (chunk) {
        const file = s.files.get(chunk[2]);
        if (!file) return { exitCode: 1, stdout: "", stderr: "" };
        return { exitCode: 0, stdout: file.subarray(Number(chunk[1]) - 1, Number(chunk[1]) - 1 + Number(chunk[3])).toString("base64"), stderr: "" };
      }
      const sample = /sample\.sh \S+ (\S+) (\S+) (capture|build)/.exec(command);
      if (sample) {
        const [, name, programId, mode] = sample;
        s.sample = name;
        const p = play[name] ?? {};
        if (p.prep === "error") put(s, `${SAMPLE}/prep.json`, { error: "the starter program couldn't be scaffolded: stand-in" });
        else {
          // What the real script leaves: the starter program with the sample's files over it.
          const files = { "Cargo.toml": "[workspace]\nmembers = [\"programs/*\"]\n", "Anchor.toml": `[programs.localnet]\n${name} = "${programId}"\n` };
          for (const [path, buf] of s.files) if (path.startsWith(`${SAMPLE}/sample/`)) files[path.slice(`${SAMPLE}/sample/`.length)] = buf.toString("utf8");
          const raw = Buffer.from(JSON.stringify({ files }));
          if (mode === "capture") {
            put(s, `${SAMPLE}/build/out/sample.sources.json`, raw);
            put(s, `${SAMPLE}/prep.json`, { captured: true, sources_size: raw.length, sources_sha256: sha(raw) });
          } else {
            const idl = Buffer.from(JSON.stringify({ address: programId, metadata: { name }, instructions: [] }));
            put(s, `${SAMPLE}/build/out/${name}.so`, ELF);
            put(s, `${SAMPLE}/build/out/solana.sources.json`, raw);
            put(s, `${SAMPLE}/build/out/${name}.build-idl.json`, idl);
            put(s, `${SAMPLE}/build/out/programs.json`, [{ name, size: ELF.length, sha256: padless(ELF), declared_id: p.declared_id ?? programId, sources: "solana.sources.json", sources_size: raw.length, sources_sha256: sha(raw), idl: `${name}.build-idl.json`, idl_size: idl.length, idl_sha256: sha(idl) }]);
            put(s, `${SAMPLE}/build/out/checks.jsonl`, JSON.stringify({ name: "solana_build", status: "pass", detail: "" }));
            put(s, `${SAMPLE}/prep.json`, { built: true });
          }
        }
        return { processId: 7, exitCode: null, stdout: "", stderr: "" };
      }
      if (command.includes("analysis.sh")) {
        put(s, `${GATE}/out/static.json`, play[s.sample]?.static ?? STATIC_OK);
        return { processId: 8, exitCode: null, stdout: "", stderr: "" };
      }
      if (command.includes("runner.mjs")) {
        // The stand-in agent: it finishes at once, having written what `play` says.
        const config = JSON.parse(s.files.get(`${A}/config.json`).toString("utf8"));
        host.launched.push({ id, role: s.opts.labels?.mynt_role, config, files: [...s.files.keys()] });
        const red = s.opts.labels?.mynt_role === "program-red-team";
        const target = red ? JSON.parse(s.files.get(`${RED_JOB}/target.json`).toString("utf8")).name : s.sample;
        s.sample = target;
        const p = play[target] ?? {};
        if (red) {
          if (p.report) put(s, `${RED_JOB}/report.json`, p.report);
          for (const [poc, files] of Object.entries(p.pocs ?? {})) for (const [path, text] of Object.entries(files)) put(s, `${RED_JOB}/poc/${poc}/${path}`, text);
        } else if (p.findings) put(s, `${AUDIT_JOB}/findings.json`, p.findings);
        put(s, `${A}/state.json`, { session_id: "s", cost_usd: p.cost ?? 0.4, turns: 1, sent: 1, last_subtype: p.exit ?? "success", done: true, exit_code: 0, error: null, summary: "I found everything (the agent's own word, which nobody reads)" });
        return { processId: 99, exitCode: null, stdout: "", stderr: "" };
      }
      const find = /^cd (\S+) 2>\/dev\/null && find /.exec(command);
      if (find) return { exitCode: 0, stdout: [...s.files.keys()].filter((f) => f.startsWith(`${find[1]}/`)).map((f) => `./${f.slice(find[1].length + 1)}`).join("\n"), stderr: "" };
      if (command.includes("confirm.py")) {
        const job = JSON.parse(s.files.get(`${CONFIRM}/job.json`).toString("utf8"));
        host.confirmed.push({ id, job, files: [...s.files.keys()] });
        const name = host.launched.findLast((l) => l.role === "program-red-team") ? sandboxes.get(host.launched.findLast((l) => l.role === "program-red-team").id).sample : null;
        const results = play[name]?.results;
        if (results) put(s, `${CONFIRM}/results.json`, { results });
        return { processId: 9, exitCode: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    launched: [],
    confirmed: [],
  };
  return host;
}

async function world(play, env = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const sandboxes = standInHost(play);
  const buildConfig = { ...buildConfigFromEnv(env), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } };
  const deskConfig = deskConfigFromEnv(buildConfig, env);
  // The real program registry and the real gate, on the same database: what a benchmark must never touch.
  const solana = await SolanaService.open(db, store, {});
  const gateConfig = gateConfigFromEnv(buildConfig, env);
  const realGate = await MainnetGateService.open(db, store, solana, sandboxes, gateConfig);
  const benchmarks = await BenchmarkService.open(db, store, { sandboxes, repos: null, buildConfig, deskConfig, reviewConfig: reviewConfigFromEnv(buildConfig, env), bdConfig: bdConfigFromEnv(buildConfig, env), gateConfig });
  const admin = (await store.createUser("Ada Admin", ["admin"])).user;
  const count = async (table, where = "TRUE") => (await pg.query(`SELECT count(*)::int AS n FROM ${T}.${table} WHERE ${where}`)).rows[0].n;
  const drive = async (runId) => {
    for (let i = 0; i < 300; i++) {
      await benchmarks.tick();
      const r = await benchmarks.run(runId);
      if (!["queued", "running"].includes(r.run.status)) return r;
    }
    throw new Error("the run didn't end");
  };
  return { pg, db, store, sandboxes, benchmarks, realGate, solana, admin, count, drive };
}

const FLAW = "pub authority: UncheckedAccount<'info>,";
const finding = (o = {}) => ({ id: "A1", severity: "critical", title: "The current authority never signs the hand-over", vulnerability: "AC-MISSING-SIGNER", file: "programs/unsigned_authority/src/lib.rs", line: 61, quote: FLAW, description: "Anyone can name the stored authority and take the ledger.", recommendation: "Make it a Signer.", ...o });
const byId = (r) => Object.fromEntries(r.tasks.map((t) => [t.task_id, t]));

test("the program samples: each names its program, and the two an outsider can exploit differ from the starter by one planted flaw", () => {
  for (const agent of ["program-audit", "program-red-team"]) {
    const set = taskSetFor(agent);
    for (const task of set.tasks) {
      const sample = programSample(task.source_dir);
      assert.ok(sample, `${agent} ${task.id}`);
      assert.match(sample.files[`programs/${sample.name}/src/lib.rs`], new RegExp(`pub mod ${sample.name}\\b`));
    }
    assert.equal(set.tasks.filter((t) => t.sample === "good").length, 1);
  }
  // A red-team sample must be attackable by someone without the owner's keys: the gate's hard-rule fixtures aren't.
  assert.deepEqual(taskSetFor("program-red-team").tasks.map((t) => t.id), ["good-starter-ledger", "bad-unsigned-authority", "bad-unchecked-ledger"]);
  assert.ok(programSample("benchmarks/fixtures/programs/unsigned_authority").files["programs/unsigned_authority/src/lib.rs"].includes(FLAW));
});

test("program audit: a bad sample passes only on a verified critical or high finding in the planted file; the good one only when nothing blocks; no program or mainnet review is ever created", async () => {
  const w = await world({
    // Sound: nothing reported.
    mynt_program: { findings: { findings: [], summary: "Nothing found" } },
    // The planted flaw, quoted from the file.
    unsigned_authority: { findings: { findings: [finding()], summary: "One critical" } },
    // A critical finding whose quote isn't in the file: it doesn't count.
    unchecked_ledger: { findings: { findings: [finding({ file: "programs/unchecked_ledger/src/lib.rs", quote: "this text is nowhere in the source" })] } },
    // The hard-rule fixture, with a medium finding only: the planted problem wasn't caught.
    hidden_admin: { findings: { findings: [finding({ severity: "medium", file: "programs/hidden_admin/src/lib.rs", quote: "require_keys_eq!(ctx.accounts.admin.key(), ADMIN);" })] } },
    // The auditor wrote nothing.
    lamport_drain: {},
    // Falsely confident static tools don't decide a sample: the auditor still runs, and here catches it.
    token_vault: { static: { tools: [{ name: "cargo-audit", version: "0", status: "error", detail: "no network", findings: [] }] }, findings: { findings: [finding({ file: "programs/token_vault/src/lib.rs", quote: "use anchor_spl::token::{self, Token, TokenAccount, Transfer};", severity: "high" })] } },
  });
  const started = await w.benchmarks.start(w.admin, { agent: "program-audit", cap_usd: 25 });
  assert.equal(started.tasks.length, 6);
  const done = await w.drive(started.run.id);
  assert.equal(done.run.status, "finished");
  const t = byId(done);

  assert.equal(t["good-starter-ledger"].status, "passed");
  assert.equal(t["bad-unsigned-authority"].status, "passed");
  assert.match(t["bad-unsigned-authority"].checks.find((c) => c.name === "planted_problem_caught").detail, /critical The current authority never signs/);
  assert.deepEqual([t["bad-unchecked-ledger"].status, t["bad-unchecked-ledger"].failure_class, t["bad-unchecked-ledger"].failed_check], ["failed", "agent", "evidence_verified"]);
  assert.deepEqual([t["bad-hidden-admin"].status, t["bad-hidden-admin"].failure_class, t["bad-hidden-admin"].failed_check], ["failed", "agent", "planted_problem_caught"]);
  assert.deepEqual([t["bad-lamport-drain"].status, t["bad-lamport-drain"].failure_class, t["bad-lamport-drain"].failed_check], ["failed", "agent", "audit_complete"]);
  assert.equal(t["bad-token-vault"].status, "passed");
  assert.equal(t["bad-token-vault"].checks.find((c) => c.name === "static_analysis").status, "warn");
  // Mynt's own hard rules would have refused the fixtures outright; that is recorded, and counts for nobody.
  assert.equal(t["bad-hidden-admin"].checks.find((c) => c.name === "mynt_hard_rules").status, "warn");
  assert.equal(t["good-starter-ledger"].checks.find((c) => c.name === "mynt_hard_rules").status, "pass");
  assert.deepEqual(done.scoreboard.passed, 3);
  // Cost: the sandbox host's figure, never 0 for something measured.
  assert.ok(t["good-starter-ledger"].cost_usd > 0);

  // What the auditor was handed: the whole workspace, its checklist, and nothing of Mynt's hard-rule results.
  // One launch per sample, and one more for the auditor that wrote nothing: the gate runs it a second time before
  // counting the audit as missing, and tells it how the first attempt ended.
  const audits = w.sandboxes.launched.filter((l) => l.role === "program-sample");
  assert.equal(new Set(audits.map((l) => l.id)).size, 6);
  assert.equal(audits.length, 7);
  const silent = audits.filter((l) => w.sandboxes.sandboxes.get(l.id).sample === "lamport_drain");
  assert.equal(silent.length, 2);
  assert.match(JSON.parse(w.sandboxes.sandboxes.get(silent[0].id).files.get(`${AUDIT_JOB}/review.json`).toString("utf8")).previous_attempt, /^the program-audit agent ended its turn without a valid findings\.json: findings\.json doesn't exist$/);
  assert.match(t["bad-lamport-drain"].checks.find((c) => c.name === "audit_complete").detail, /^The auditor: the program-audit agent ended its turn without a valid findings\.json, on both attempts: findings\.json doesn't exist; its last message: "I found everything/);
  for (const l of audits) {
    assert.equal(l.config.workspace ?? "program-audit", "program-audit");
    const review = JSON.parse(w.sandboxes.sandboxes.get(l.id).files.get(`${AUDIT_JOB}/review.json`).toString("utf8"));
    assert.equal(review.deterministic_rules, null);
    assert.ok(review.files.includes("Cargo.toml") && review.files.some((f) => f.endsWith("/src/lib.rs")));
    assert.ok(w.sandboxes.sandboxes.get(l.id).files.has(`${AUDIT_JOB}/vulnerabilities.json`));
    // The starter program and the coding agents' own scaffold script, as shipped.
    assert.ok(l.files.includes(`${SAMPLE}/kit/scripts/scaffold_program.py`) && l.files.includes(`${SAMPLE}/kit/templates/solana-program/Anchor.toml`));
  }
  // The task's budget is the agent's: at most the gate's audit cap, and what was left of the run's.
  assert.ok(audits.every((l) => l.config.budgetUsd <= 5));

  // Nothing real: no program, no mainnet review, no review log, no flag, no audit entry of a review request.
  for (const table of ["solana_programs", "solana_mainnet_reviews", "solana_mainnet_review_log", "solana_program_flags"]) assert.equal(await w.count(table), 0, table);
  assert.equal(await w.count("bench_solana_mainnet_reviews"), 6);
  assert.equal(await w.count("audit_log", "action = 'request_mainnet_review'"), 0);
  assert.deepEqual(await w.realGate.list(), []);
  // Every sandbox was stopped.
  assert.ok([...w.sandboxes.sandboxes.values()].every((s) => s.stopped));
});

test("program red team: Mynt builds the sample, the red team gets only bytes and IDL, and only an exploit Mynt's own re-run confirms counts", async () => {
  const report = (poc) => ({ findings: [{ id: "R1", title: "Anyone takes the ledger", severity: "critical", category: "access_control", description: "…", poc }], summary: "One exploit", attacks_tried: ["wrong signer"] });
  const poc = { "run.sh": "#!/usr/bin/env bash\necho stand-in\n" };
  const w = await world({
    // Sound: a proof of concept is claimed, and Mynt's re-run doesn't confirm it.
    mynt_program: { report: report("p1"), pocs: { p1: poc }, results: { p1: { confirmed: false, reason: "attack exited 1" } } },
    // Exploitable, and confirmed by Mynt.
    unsigned_authority: { report: report("p1"), pocs: { p1: poc }, results: { p1: { confirmed: true, reason: "the victim's ledger changed" } } },
    // Exploitable, but the red team only says so: no proof, so nothing is confirmed.
    unchecked_ledger: { report: { findings: [{ id: "R1", title: "I am sure it is exploitable", severity: "critical", category: "access_control", description: "…" }], summary: "One finding, unproved", attacks_tried: ["wrong signer"] } },
  });
  const started = await w.benchmarks.start(w.admin, { agent: "program-red-team", cap_usd: 25 });
  const done = await w.drive(started.run.id);
  const t = byId(done);
  assert.equal(t["good-starter-ledger"].status, "passed");
  assert.equal(t["bad-unsigned-authority"].status, "passed");
  assert.match(t["bad-unsigned-authority"].checks.find((c) => c.name === "exploit_confirmed").detail, /Mynt's own re-run confirmed: p1/);
  assert.deepEqual([t["bad-unchecked-ledger"].status, t["bad-unchecked-ledger"].failure_class, t["bad-unchecked-ledger"].failed_check], ["failed", "agent", "exploit_confirmed"]);

  // The build was Mynt's verifiable build of the sample laid over the starter program.
  const builds = w.sandboxes.commands.filter((c) => c.command.includes("sample.sh"));
  assert.equal(builds.length, 3);
  assert.ok(builds.every((c) => / build$/.test(c.command) && c.role === "program-sample"));
  // The red team's sandbox holds the bytes and the IDL, and none of the source.
  const reds = w.sandboxes.launched.filter((l) => l.role === "program-red-team");
  assert.equal(reds.length, 3);
  for (const l of reds) {
    assert.ok(!l.files.some((f) => f.endsWith(".rs") || f.includes("/sample/")), "no source in the red team's sandbox");
    assert.ok(l.files.includes(`${RED_JOB}/program.so.b64`) && l.files.includes(`${RED_JOB}/target.json`));
  }
  // Mynt re-ran the proofs in sandboxes of its own.
  assert.equal(w.sandboxes.confirmed.length, 2);
  assert.ok(w.sandboxes.confirmed.every((c) => c.files.includes(`${CONFIRM}/pocs/p1/run.sh`) && c.files.includes(`${CONFIRM}/confirm.py`)));
  for (const table of ["solana_programs", "solana_mainnet_reviews", "solana_program_artifacts"]) assert.equal(await w.count(table), 0, table);
});

test("a sample Mynt can't prepare, or whose build declares another address, is the harness's failure and never the agent's", async () => {
  const w = await world({ mynt_program: { prep: "error" }, unsigned_authority: { declared_id: "11111111111111111111111111111111" } });
  const started = await w.benchmarks.start(w.admin, { agent: "program-red-team", cap_usd: 25, task_ids: ["good-starter-ledger", "bad-unsigned-authority"] });
  const done = await w.drive(started.run.id);
  const t = byId(done);
  assert.deepEqual([t["good-starter-ledger"].status, t["good-starter-ledger"].failure_class], ["failed", "harness"]);
  assert.match(t["good-starter-ledger"].detail, /couldn't prepare the sample/);
  assert.deepEqual([t["bad-unsigned-authority"].status, t["bad-unsigned-authority"].failure_class], ["failed", "harness"]);
  assert.match(t["bad-unsigned-authority"].detail, /declares 1{32}, not/);
  // Neither counts against the agent.
  assert.equal(done.scoreboard.pass_rate, null);
  assert.equal(w.sandboxes.launched.length, 0);
});

// The first real runs in production: the host refused every VM, and each sample's whole budget was counted as spent.
test("a sandbox host that refuses every VM: a program sample that never got a sandbox charges nothing, and the next run is refused until the host is back", async () => {
  for (const agent of ["program-audit", "program-red-team"]) {
    const w = await world({});
    const create = w.sandboxes.createSandbox;
    w.sandboxes.createSandbox = async () => {
      throw new Error("host: 429 LIMIT_EXCEEDED on creating a VM");
    };
    const started = await w.benchmarks.start(w.admin, { agent, cap_usd: 25 });
    const done = await w.drive(started.run.id);
    assert.deepEqual([done.run.status, done.run.stop_reason], ["stopped", "The sandbox provider has used up this account's allowance; an admin must add billing in its dashboard."], agent);
    const [first, ...rest] = done.tasks;
    assert.deepEqual([first.status, first.failure_class, first.sandbox_started], ["failed", "infrastructure", false], agent);
    assert.ok(first.cap_usd > 0 && rest.every((t) => t.status === "not_run"), agent);
    // The task had a budget, and none of it is counted: no sandbox started, so nothing was spent or measured.
    assert.deepEqual([first.cost_usd, first.reserved_usd, first.cost_note], [null, null, "Not measured: no sandbox started for this task, so nothing ran, and nothing is counted against the run's cap"], agent);
    assert.deepEqual([done.run.charged_usd, done.run.measured_usd, done.run.reserved_usd, done.run.charged_note, done.scoreboard.cost_usd], [0, 0, 0, null, null], agent);
    assert.equal(w.sandboxes.sandboxes.size, 0, agent);

    // Both gate agents are held back, in the same words as a run refused after a real build; host_restored overrides.
    for (const other of ["program-audit", "program-red-team"]) await assert.rejects(w.benchmarks.start(w.admin, { agent: other, cap_usd: 25 }), /sandbox host's allowance is used up: the last benchmark run to ask it for a sandbox .* start the run with host_restored: true/, other);
    const listed = (await w.benchmarks.agents()).filter((a) => a.agent.startsWith("program-"));
    assert.deepEqual(listed.map((a) => [a.ready, a.can_start, a.host_allowance_used_up]), [[false, false, true], [false, false, true]], agent);
    w.sandboxes.createSandbox = create;
    const again = await w.benchmarks.start(w.admin, { agent, cap_usd: 25, host_restored: true, task_ids: ["good-starter-ledger"] });
    const ran = await w.drive(again.run.id);
    // This time the sample's sandbox started. The stand-in's review ends unscored, and what ran is counted.
    assert.equal(ran.tasks[0].sandbox_started, true, agent);
    assert.ok(ran.run.charged_usd > 0 && ran.run.charged_usd === ran.run.measured_usd + ran.run.reserved_usd, agent);
    assert.ok((await w.benchmarks.agents()).filter((a) => a.agent.startsWith("program-")).every((a) => a.ready && a.can_start && !a.host_allowance_used_up), agent);
  }
});

test("the sample gate can't review, approve or deploy a program, and the real gate takes no samples", async () => {
  const w = await world({});
  const gate = w.benchmarks.gate;
  const anyone = { id: w.admin.id, roles: ["admin"] };
  await assert.rejects(gate.request(anyone, "HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw", "b"), /only reviews benchmark samples/);
  await assert.rejects(gate.decide(anyone, "x", "approve", "note"), /only reviews benchmark samples/);
  await assert.rejects(gate.cancel(anyone, "x", true), /only reviews benchmark samples/);
  await assert.rejects(gate.check({ id: "p" }, "0".repeat(64), "deploy"), /only reviews benchmark samples/);
  await assert.rejects(gate.claim({ id: "p" }, "0".repeat(64), "deploy"), /only reviews benchmark samples/);
  const sample = programSample("benchmarks/fixtures/programs/unsigned_authority");
  await assert.rejects(w.realGate.requestSample({ mode: "audit", ...sample, ref: "x", requested_by: w.admin.id, cap_usd: 1 }), /only by the benchmark's own gate/);
  // The real gate isn't the registry's gate any less for the benchmark's existing.
  assert.equal(w.solana.gate, w.realGate);
  // A sample's agent token is live only while its review runs, and is the benchmark's own.
  assert.equal(await w.realGate.agentRun("mynt_paudit_made_up"), null);
  assert.equal(await w.benchmarks.agentRun("mynt_paudit_made_up"), null);
});
