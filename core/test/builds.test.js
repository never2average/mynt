import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AUDITOR_KILL, BuildService, MAXWELL_COMMIT, auditOutcome, buildConfigFromEnv, modelRefusal } from "../dist/builds.js";
import { workspaceFiles } from "../dist/agent-host.js";
import { redact } from "../dist/boxes.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const SHA = "a".repeat(64);
const TREE = "b".repeat(64);
const COMMIT = "c".repeat(40);
const V = "/home/user/mynt-verify";
const A = "/home/user/mynt-agent";
const BUILD = "/home/user/workspaces/coding-build";
const AUDIT = "/home/user/workspaces/build-audit";

// A fake sandbox host: sandboxes become ready when told to, files live in memory, the agents' work
// is simulated by writing files (the runner's state.json among them), and shell commands are matched by
// what they do.
function fakeSandboxHost() {
  const sandboxes = new Map();
  let n = 0;
  const host = {
    sandboxes,
    branchMatches: true,
    tamperDuringAudit: false,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), commands: [], stopped: false, cost: 0, checksRunning: true, agentRunning: false });
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
    hosted: [],
    async host(id, port) {
      host.hosted.push({ id, port });
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
      // Mynt puts inbox items in place with a rename.
      const mv = command.match(/^mv -f '([^']+)' '([^']+)'$/);
      if (mv) {
        if (host.failMv) return { exitCode: 1, stdout: "", stderr: "sandbox unreachable" };
        if (!s.files.has(mv[1])) return { exitCode: 1, stdout: "", stderr: "no such file" };
        s.files.set(mv[2], s.files.get(mv[1]));
        s.files.delete(mv[1]);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // The packaged source. With host.sourcePackage (bytes), packaging reports their real hash, Mynt can read them
      // back in pieces (to keep the source of a build that didn't ship) and unpack a kept source in a new sandbox.
      if (command.includes("tar --exclude")) {
        if (host.sourcePackage) s.package = host.sourcePackage;
        const sha = s.package ? createHash("sha256").update(s.package).digest("hex") : SHA;
        return { exitCode: 0, stdout: `${sha}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      }
      if (command.endsWith("stat -c %s /home/user/mynt-out/app.tgz")) return s.package ? { exitCode: 0, stdout: `${s.package.length}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
      const piece = command.match(/tail -c \+(\d+) \/home\/user\/mynt-out\/app\.tgz \| head -c (\d+) \| base64 -w0$/);
      if (piece) {
        if (!s.package) return { exitCode: 1, stdout: "", stderr: "" };
        const from = Number(piece[1]) - 1;
        return { exitCode: 0, stdout: s.package.subarray(from, from + Number(piece[2])).toString("base64"), stderr: "" };
      }
      const unpack = command.match(/^set -e; cat (.+?) \| base64 -d > (\S+); .*sha256sum \S+ \| cut -d' ' -f1\)" = "([0-9a-f]{64})" \]; mkdir -p (\S+); tar -xzf/);
      if (unpack) {
        const data = Buffer.concat(unpack[1].split(" ").map((part) => Buffer.from(s.files.get(part), "base64")));
        if (createHash("sha256").update(data).digest("hex") !== unpack[3]) return { exitCode: 1, stdout: "", stderr: "checksum mismatch" };
        s.unpacked = { dest: unpack[4], data };
        return { exitCode: 0, stdout: "restored\n", stderr: "" };
      }
      // The auditor's read-only copy of the source, and Mynt's hash of it before and after the audit.
      if (command.includes("verify.sh --audit-copy")) return { exitCode: 0, stdout: `audit-copy ${TREE}\n`, stderr: "" };
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/changed.txt`, host.tamperDuringAudit ? "./api/index.ts\n" : "");
        return { exitCode: 0, stdout: `rehash ${host.tamperDuringAudit ? "e".repeat(64) : TREE}\n`, stderr: "" };
      }
      // Mynt ending an auditor that ran out of time or budget.
      if (command.includes("[r]unner.mjs")) {
        s.agentRunning = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      const rm = command.match(/^rm -f (.+)$/);
      if (rm) {
        for (const path of rm[1].split(" ")) s.files.delete(path);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("verify.sh")) return { processId: 7, exitCode: null, stdout: "", stderr: "" };
      // Mynt's live-preview script says what it did: no-web, waiting, running or started (the test sets it).
      if (command.includes("scripts/dev_preview.sh")) return { exitCode: 0, stdout: `${s.devPreview ?? "no-web"}\n`, stderr: "" };
      if (command.includes("runner.mjs")) {
        s.agentRunning = true;
        return { processId: 99, exitCode: null, stdout: "", stderr: "" };
      }
      // Mynt reading the agent's stream-json log from a byte offset, base64-encoded.
      const read = command.match(/agent\.jsonl; if \[ -f "\$f" \]; then tail -c \+(\d+) "\$f" \| head -c (\d+) \| base64 -w0; fi$/);
      if (read) {
        if (s.stopped) throw new Error("sandbox stopped");
        const log = s.files.get(`${A}/agent.jsonl`);
        const from = Number(read[1]) - 1;
        return { exitCode: 0, stdout: log == null ? "" : Buffer.from(log).subarray(from, from + Number(read[2])).toString("base64"), stderr: "" };
      }
      if (command.includes("git rev-parse")) return host.branchMatches ? { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async commandStatus(id, processId) {
      const running = processId === 99 ? sandboxes.get(id).agentRunning : sandboxes.get(id).checksRunning;
      return { running, exitCode: running ? null : 0 };
    },
    async downloadUrl(id, path, ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 3600) throw new Error("ttlSeconds must be an integer between 1 and 3600.");
      return `https://files.example/${id}${path}?sig=x`;
    },
    // Test controls
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    write(id, path, value) {
      sandboxes.get(id).files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    // The runner appending Claude Code's output to agent.jsonl: objects become lines, strings go as they are.
    log(id, ...items) {
      const files = sandboxes.get(id).files;
      files.set(`${A}/agent.jsonl`, (files.get(`${A}/agent.jsonl`) ?? "") + items.map((i) => (typeof i === "string" ? i : `${JSON.stringify(i)}\n`)).join(""));
    },
    // What the runner records when Claude Code exits: "success" or an error subtype, and its spend.
    finishAgent(id, subtype = "success", cost = 0) {
      const s = sandboxes.get(id);
      s.agentRunning = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ session_id: "s1", cost_usd: cost, turns: 1, sent: 1, last_subtype: subtype, done: true, exit_code: 0, error: null }));
    },
    agentConfig(id) {
      return JSON.parse(sandboxes.get(id).files.get(`${A}/config.json`));
    },
  };
  return host;
}

function fakeRepos() {
  const prs = [];
  return {
    prs,
    async installationFor(repo) {
      return repo === "acme/savings-app" ? 42 : null;
    },
    async tokenFor() {
      return { token: "ghs_short_lived", expires_at: new Date(Date.now() + 3600e3).toISOString() };
    },
    installUrl: () => "https://github.com/apps/mynt-builder/installations/new",
    async installationAccount(id) {
      return id === 42 ? { login: "acme", type: "Organization" } : null;
    },
    async openPullRequest(repo, installation, pr) {
      prs.push({ repo, installation, ...pr });
      return `https://github.com/${repo}/pull/7`;
    },
  };
}

// A stand-in for the git host Mynt keeps apps' managed repositories on (src/git-host.ts).
function fakeManagedHost() {
  return {
    name: "fake",
    created: [],
    reachable: true,
    owns: (r) => r.toLowerCase().startsWith("mynt-apps/"),
    async access() {
      return this.reachable ? 77 : null;
    },
    async create(name) {
      if (!this.reachable) throw new Error("the host's app isn't installed");
      this.created.push(name);
      await this.onCreate?.(); // a test's concurrent request, landing while the repository is being created
      return { repository: `mynt-apps/${name}`, access: 77 };
    },
    async readCredentials() {
      return { username: "x-access-token", password: "ghs_readonly_short_lived" };
    },
    cloneUrl: (r) => `https://git.example/${r}.git`,
  };
}

// `approve`: tests that aren't about repository approvals act as if an admin approved each connection as it's made.
async function setup({ sandboxes = fakeSandboxHost(), config = {}, managed = null, refuse = null, approve = true } = {}) {
  const pg = new PGlite();
  // `refuse`: stands in for a database that rejects some statements (those it returns true for).
  const db = { query: (s, p) => (refuse?.(s, p) ? Promise.reject(new Error("refused by the test")) : pg.query(s, p)), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const repos = fakeRepos();
  const builds = await BuildService.open(db, store, sandboxes, repos, { ...buildConfigFromEnv({ BUILD_AUDIT: "maxwell", BUILD_AUDIT_WORKFLOWS: "execute-scr,probe-cicd-env" }), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, ...config });
  builds.managedHost = managed;
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    client.user = user; // whose client it is, for the harness's auto-approval
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
    if (approve && name === "connect_repository" && data.connected === true)
      await pg.query("UPDATE financial_products.repo_connections SET approval = 'approved' WHERE developer_id = $1 AND repository = $2", [client.user.id, args.repository.toLowerCase()]);
    return { isError: res.isError ?? false, data };
  };
  return { pg, store, builds, sandboxes, repos, as, connect, call };
}

const passingChecks = [
  { name: "source", status: "pass" },
  { name: "tests", status: "pass" },
  { name: "secrets_scan", status: "pass" },
  { name: "dependency_audit", status: "pass" },
  { name: "sbom", status: "pass" },
  { name: "disclosures", status: "pass" },
];
const cleanAudit = { complete: true, workflows_run: ["execute-scr", "probe-cicd-env"], skipped: [], counts: { critical: 0, high: 0, medium: 2, low: 5 }, findings: [], summary: "No blocking findings" };
const agentReport = { maxwell: { counts: { critical: 0, high: 0 } }, readiness: [], preview: { port: 8080 }, push: { branch: "mynt/build-x" } };

// Drives one build from start through the agent's work into verification, then lets `verification`
// shape what the clean sandbox reports, and returns the final build.
async function runBuild(ctx, { dev, startArgs, agent = agentReport, verification = {} }) {
  const { builds, sandboxes, call } = ctx;
  const started = (await call(dev, "start_build", startArgs)).data;
  assert.ok(started.id, JSON.stringify(started));
  assert.ok(!("source_url" in started) && !("agent_report" in started), "start_build shows the build as get_build does");
  const INTERNAL = ["source_url", "agent_report", "developer_id", "sandbox_id", "sandbox_key_id", "verify_sandbox_id", "verify_step", "verify_process_id", "verify_prompt_id", "audit_started_at", "source_sha256", "prompt_id", "box_sandbox_id", "box_until"];
  for (const k of INTERNAL) assert.ok(!(k in started), `start_build hides ${k}`);
  for (const k of INTERNAL) assert.ok(!(k in (await call(dev, "list_builds", {})).data.builds[0]), `list_builds hides ${k}`);
  for (const k of ["id", "goal", "status", "phase_message", "cost_usd", "cap_usd", "sandbox_open_until", "created_at"]) assert.ok(k in started, `start_build shows ${k}`);
  await builds.tick(); // sandbox requested
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick(); // agent prompted
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agent);
  sandboxes.finishAgent(sbx);
  await builds.tick(); // source packaged, verifier requested
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  sandboxes.ready(vid);
  await builds.tick(); // checks started
  sandboxes.sandboxes.get(vid).checksRunning = false;
  sandboxes.write(vid, `${V}/before.sha`, "tree\n");
  sandboxes.write(vid, `${V}/report.json`, { checks: verification.checks ?? passingChecks });
  await builds.tick(); // auditor prompted
  if (verification.maxwell !== null) sandboxes.write(vid, `${V}/maxwell.json`, verification.maxwell ?? cleanAudit);
  sandboxes.finishAgent(vid, verification.auditStatus ?? "success");
  await builds.tick(); // decided
  return { started, sbx, vid, build: (await call(dev, "get_build", { build_id: started.id })).data };
}

test("a build is verified by Mynt in a clean sandbox, then Mynt opens the PR", async () => {
  const ctx = await setup();
  const { sandboxes, repos, as, connect, call, builds } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.connected, true);

  const { started, sbx, vid, build } = await runBuild(ctx, {
    dev,
    startArgs: { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" },
  });

  // The coding sandbox: secrets only in its env, the task and SDK in files, no PR from the agent.
  const coding = sandboxes.sandboxes.get(sbx);
  // Mynt runs a pinned Claude Code itself, budgeted from the build's cap, through Mynt's proxy: no
  // Anthropic key in the sandbox, and the build's proxy token dies with the build.
  const config = sandboxes.agentConfig(sbx);
  assert.equal(config.model, "claude-opus-5-5");
  assert.ok(config.budgetUsd > 0 && config.budgetUsd <= 10);
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  assert.match(coding.files.get(`${A}/runner.mjs`), /--max-budget-usd/);
  const auth = JSON.parse(coding.files.get(`${A}/auth.json`));
  assert.deepEqual(auth.env, { ANTHROPIC_BASE_URL: "https://mynt.example.com/agent", ANTHROPIC_AUTH_TOKEN: auth.token });
  assert.ok(!JSON.stringify(coding.opts.env).includes("sk-ant") && !coding.opts.env.ANTHROPIC_API_KEY);
  assert.equal(await builds.agentTokenActive(auth.token), false, "the coding agent's token was replaced for the audit");
  const auditAuth = JSON.parse(sandboxes.sandboxes.get(vid).files.get(`${A}/auth.json`));
  assert.equal(await builds.agentTokenActive(auditAuth.token), false, "and that one died with the build");
  assert.equal(coding.opts.env.GITHUB_TOKEN, "ghs_short_lived");
  assert.match(coding.opts.env.MYNT_SANDBOX_KEY, /^mynt_test_/);
  // The coding agent works in Mynt's coding-build workspace: its instructions, skills and scripts, plus job files.
  const instructions = coding.files.get(`${BUILD}/CLAUDE.md`);
  assert.match(instructions, /Do not open a pull request/);
  assert.match(instructions, /re-runs the audit and the checks itself/);
  assert.ok(coding.files.has(`${BUILD}/.claude/skills/secure/SKILL.md`) && coding.files.has(`${BUILD}/scripts/report_status.py`));
  assert.ok(![...coding.files.keys()].some((p) => p.includes("maxwell")), "Maxwell runs once, in Mynt's verification, not in the coding agent's sandbox");
  assert.match(instructions, /Don't install or run Maxwell/);
  assert.equal(config.cwd, BUILD);
  assert.equal(JSON.parse(coding.files.get(`${BUILD}/job/build.json`)).build.repository, "acme/savings-app");
  assert.equal(JSON.parse(coding.files.get(`${BUILD}/job/build.json`)).build.maxwell_repo, undefined);
  assert.ok(coding.files.has(`${BUILD}/job/sdk/openapi.json`));

  // The verifier: a fresh sandbox with no secrets, Mynt's own script, and an audit-only agent.
  const verifier = sandboxes.sandboxes.get(vid);
  assert.deepEqual(verifier.opts.env, {});
  assert.match(verifier.files.get(`${V}/verify.sh`), /gitleaks/);
  assert.match(verifier.commands.find((c) => c.detached).command, new RegExp(`verify\\.sh 'https://files\\.example/${sbx}/home/user/mynt-out/app\\.tgz\\?sig=x' ${SHA}`));
  assert.match(verifier.files.get(`${AUDIT}/CLAUDE.md`), /Do not modify anything inside `app_dir`/);
  assert.deepEqual(JSON.parse(verifier.files.get(`${AUDIT}/job/audit.json`)), {
    // The auditor reads its own read-only copy of the verified source, not the folder Mynt's checks ran in.
    app_dir: "/home/user/audit-src",
    maxwell_repo: "https://github.com/OnFinance/Maxwell",
    // A known-good commit of the tool, not whatever its default branch holds today.
    maxwell_commit: MAXWELL_COMMIT,
    output: `${V}/maxwell.json`,
    workflows: ["execute-scr", "probe-cicd-env"],
    minutes: 20,
    // What the audit's script may spend on Maxwell's own runs, and the model they are sent to.
    budget_usd: 5,
    model: "claude-sonnet-5-5",
    attempt: 1,
    attempts: 2,
  });
  assert.match(MAXWELL_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(verifier.files.get(`${AUDIT}/scripts/audit.mjs`), /run-headless\.mjs/, "the script that launches and watches the workflows is in the auditor's workspace");
  // Mynt's own record of the pipeline the source went through is in the auditor's job folder, written before it
  // starts, and its workspace says what the record is.
  const evidence = JSON.parse(verifier.files.get(`${AUDIT}/job/pipeline-evidence.json`));
  assert.equal(evidence.kind, "mynt.pipeline-evidence");
  assert.equal(evidence.build_id, started.id);
  assert.equal(evidence.source.sha256, SHA);
  assert.deepEqual(evidence.gates.map((g) => [g.check, g.result]), passingChecks.map((c) => [c.name, c.status]));
  assert.match(verifier.files.get(`${AUDIT}/CLAUDE.md`), /job\/pipeline-evidence\.json/);
  assert.ok(verifier.commands.some((c) => c.command === `bash ${V}/verify.sh --audit-copy ${SHA}`), "the copy is made from the hash-checked archive");
  assert.equal(sandboxes.agentConfig(vid).cwd, AUDIT);
  // Mynt's audit runs on its own model and budget, not the developer's: the coding agent's runs on the deployment's.
  assert.equal(sandboxes.agentConfig(vid).model, "claude-sonnet-5-5");
  assert.equal(sandboxes.agentConfig(vid).budgetUsd, 5);
  assert.notEqual(sandboxes.agentConfig(sbx).model, "claude-sonnet-5-5");
  assert.ok(verifier.stopped, "the verifier is stopped once it has reported");

  assert.equal(build.status, "succeeded");
  assert.equal(build.pr_url, "https://github.com/acme/savings-app/pull/7");
  assert.equal(build.commit_sha, COMMIT);
  assert.equal((await builds.get(build.id)).source_sha256, SHA, "the source hash is kept on the record");
  for (const k of ["source_url", "agent_report", "source_sha256", "sandbox_key_id", "verify_sandbox_id", "verify_step", "audit_started_at", "box_sandbox_id"]) assert.ok(!(k in build), `get_build hides ${k}`);
  assert.match(build.preview_url, /-8080\./);
  assert.equal(repos.prs.length, 1);
  assert.match(repos.prs[0].body, /verified by Mynt/);
  assert.match(repos.prs[0].body, /\| secrets_scan \| pass \|/);
  const phases = build.timeline.map((e) => e.phase).filter((p, i, a) => p !== a[i - 1]);
  assert.deepEqual(phases, ["queued", "provisioning", "coding", "verifying", "succeeded"]);
  assert.equal((await builds.get(started.id)).agent_report.preview.port, 8080, "the agent's report is kept as advice");
});

for (const [label, opts, status, pattern] of [
  ["the agent's own report can't hide findings: Mynt's audit decides", { agent: { ...agentReport, maxwell: { counts: { high: 0 } } }, verification: { maxwell: { ...cleanAudit, counts: { critical: 0, high: 2 }, findings: [{ severity: "high", title: "SQL injection", file: "api/db.ts", workflow: "execute-scr" }] } } }, "blocked", /^Security gate: 2 critical\/high Maxwell finding\(s\) \(high: SQL injection in api\/db\.ts; …\)$/],
  [
    "an audit that ran out of its budget doesn't count, even with a partial report",
    { verification: { maxwell: { ...cleanAudit, complete: false, workflows_run: ["execute-scr"] }, auditStatus: "error_max_budget_usd" } },
    "blocked",
    /^Mynt's audit didn't finish: the auditor used up its US\$5 budget \(Mynt's, not this build's cap\); its report so far covers execute-scr; a build can't ship without a complete audit$/,
  ],
  ["a failing check from Mynt's script fails the build", { verification: { checks: [...passingChecks, { name: "secrets_scan", status: "fail", detail: "1 secret(s)" }] } }, "failed", /secrets_scan/],
]) {
  test(label, async () => {
    const ctx = await setup();
    const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
    const { build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, ...opts });
    assert.equal(build.status, status);
    assert.match(build.error, pattern);
    assert.equal(build.pr_url, null);
  });
}

test("a build is blocked if the audit changed the code, or the pushed branch isn't the verified source", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  await ctx.call(dev, "connect_repository", { repository: "acme/savings-app" });

  ctx.sandboxes.tamperDuringAudit = true;
  let r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", repository: "acme/savings-app" } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /source changed during the audit: \.\/api\/index\.ts;/);

  ctx.sandboxes.tamperDuringAudit = false;
  ctx.sandboxes.branchMatches = false;
  r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", repository: "acme/savings-app" } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /pushed branch doesn't match/);
  assert.equal(ctx.repos.prs.length, 0, "no PR for either");
});

test("a build that doesn't ship revokes its Mynt sandbox key", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const { started } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", app_id: app.id }, verification: { maxwell: { ...cleanAudit, counts: { critical: 1 } } } });
  const b = await ctx.builds.get(started.id);
  assert.equal(b.status, "blocked");
  assert.equal((await ctx.store.getApiKey(b.sandbox_key_id)).status, "revoked");
});

test("the verifier is told which disclosures to find", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  await ctx.store.setProductAccess("fixed-deposit", "open", { required_disclosures: ["Deposits are insured up to the statutory limit"] });
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const { vid } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", app_id: app.id } });
  assert.deepEqual(JSON.parse(ctx.sandboxes.sandboxes.get(vid).files.get(`${V}/disclosures.json`)), [
    { product_id: "fixed-deposit", text: "Deposits are insured up to the statutory limit" },
  ]);
});

test("spend caps count both sandboxes, and the monthly budget refuses new builds", async () => {
  const ctx = await setup({ config: { capUsd: 5, monthlyCapUsd: 8 } });
  const { builds, sandboxes, as, connect, call } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", cap_usd: 50 })).data;
  assert.equal(started.cap_usd, 5, "capped at the platform maximum");
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx, "success", 1);
  sandboxes.sandboxes.get(sbx).cost = 2;
  await builds.tick(); // verifying
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  sandboxes.sandboxes.get(vid).cost = 2.5;
  await builds.tick();
  const b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "over_budget");
  assert.equal(b.cost_usd, 5.5);
  assert.ok(sandboxes.sandboxes.get(sbx).stopped && sandboxes.sandboxes.get(vid).stopped);
  // US$2.50 of the US$8 month is left: list_builds says so (a cap picker defaults to it)...
  assert.deepEqual((await call(dev, "list_builds", {})).data.budget, { default_cap_usd: 5, month_left_usd: 2.5, workspace_left_usd: null, min_cap_usd: 0.5, session_cap_above_usd: 2 });
  // ...and the default US$5 cap doesn't fit, and the error says how much would.
  assert.equal(
    (await call(dev, "start_build", { goal: "Another build please" })).data.error,
    "This build's cap (US$5) is more than this month's remaining build budget (US$2.50 of US$8); start it with cap_usd of at most 2.5",
  );
  const small = (await call(dev, "start_build", { goal: "A smaller build please", cap_usd: 2.5 })).data;
  assert.equal(small.cap_usd, 2.5, "a cap within what's left is accepted");
  await builds.stop(await builds.get(small.id), "test");
});

test("a used-up month says so", async () => {
  const ctx = await setup({ config: { capUsd: 5, monthlyCapUsd: 0.25 } });
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  assert.match((await ctx.call(dev, "start_build", { goal: "Build a savings page please" })).data.error, /^Monthly build budget used up \(US\$0\.00 of US\$0\.25/);
});

test("build cost and time: get_build and list_builds report measured cents and seconds, null with a reason when unmeasured", async () => {
  const ctx = await setup();
  const { builds, sandboxes, call, pg } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  let b = (await call(dev, "get_build", { build_id: started.id })).data;
  // Queued: nothing has run, so US$0 is measured; coding and verifying haven't started.
  assert.equal(b.cost_cents, 0);
  assert.equal(b.cap_cents, 1000);
  assert.deepEqual(b.cost_parts_cents, { coding_agents: 0, sandboxes: 0 });
  assert.equal(b.audit_cost_cents, null);
  assert.equal(b.durations_seconds.coding, null);
  assert.equal(b.not_measured["durations_seconds.coding"], "The coding agent hasn't started");
  assert.equal(typeof b.durations_seconds.total, "number");

  await builds.tick(); // sandbox requested
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.cost_cents, null, "a sandbox is up but its cost isn't read yet: not measured, never 0");
  assert.equal(b.not_measured.cost_cents, "Measured once the coding agent starts");
  await builds.tick(); // agent prompted
  sandboxes.sandboxes.get(sbx).cost = 1.25;
  sandboxes.sandboxes.get(sbx).agentRunning = true;
  sandboxes.write(sbx, `${A}/state.json`, { cost_usd: 2, turns: 1, sent: 1, done: false });
  await builds.tick();
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "coding");
  assert.equal(b.cost_cents, 325);
  assert.deepEqual(b.cost_parts_cents, { coding_agents: 200, sandboxes: 125 });
  assert.ok(b.timing.coding_started_at && b.timing.started_at);
  assert.equal(typeof b.durations_seconds.coding, "number");

  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx, "success", 2);
  await builds.tick(); // verifying
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  sandboxes.ready(vid);
  sandboxes.sandboxes.get(vid).cost = 0.5;
  await builds.tick(); // checks
  sandboxes.sandboxes.get(vid).checksRunning = false;
  sandboxes.write(vid, `${V}/before.sha`, "tree\n");
  sandboxes.write(vid, `${V}/report.json`, { checks: passingChecks });
  await builds.tick(); // auditor started
  sandboxes.write(vid, `${A}/state.json`, { cost_usd: 4, turns: 1, sent: 1, last_subtype: "success", done: false });
  await builds.tick();
  assert.equal((await call(dev, "get_build", { build_id: started.id })).data.audit_cost_cents, 400, "Mynt's audit spend, outside the cap");
  sandboxes.write(vid, `${V}/maxwell.json`, cleanAudit);
  sandboxes.finishAgent(vid, "success", 4.5);
  await builds.tick(); // decided
  // Pushed back ten minutes, so the durations add up to something worth checking.
  await pg.query("UPDATE financial_products.build_runs SET created_at = created_at - interval '10 minutes' WHERE id = $1", [started.id]);
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.ok(["succeeded", "blocked"].includes(b.status), b.status);
  assert.equal(b.cost_cents, 375);
  assert.equal(b.cost_usd, 3.75, "the old field is unchanged");
  assert.deepEqual(b.cost_parts_cents, { coding_agents: 200, sandboxes: 175 });
  assert.equal(b.audit_cost_cents, 450);
  assert.ok(b.timing.verify_started_at && b.timing.finished_at);
  for (const k of ["queued", "coding", "verify", "total"]) assert.equal(typeof b.durations_seconds[k], "number", k);
  assert.ok(b.durations_seconds.total >= 600 && b.durations_seconds.queued >= 600);
  assert.deepEqual(b.not_measured, {});
  const listed = (await call(dev, "list_builds", {})).data.builds[0];
  assert.deepEqual([listed.cost_cents, listed.cap_cents, listed.durations_seconds], [375, 1000, b.durations_seconds]);

  // A build measured before the parts were kept: its total stands, its parts are not measured. One that ended
  // before its cost was read: not measured, never 0.
  await pg.query("UPDATE financial_products.build_runs SET agent_cost_usd = NULL, sandbox_cost_usd = NULL WHERE id = $1", [started.id]);
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.cost_cents, 375);
  assert.deepEqual(b.cost_parts_cents, { coding_agents: null, sandboxes: null });
  assert.match(b.not_measured["cost_parts_cents.sandboxes"], /before Mynt kept the parts/);
  await pg.query("UPDATE financial_products.build_runs SET cost_usd = 0 WHERE id = $1", [started.id]);
  b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.cost_cents, null);
  assert.equal(b.not_measured.cost_cents, "Mynt didn't measure this build's cost before it ended");
});

test("developers track, steer and stop their own builds; admins see all", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  sandboxes.write(sbx, `${BUILD}/job/status.json`, { phase: "auditing", message: "Running Maxwell" });
  sandboxes.log(sbx, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  await builds.tick();
  let b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "auditing");
  const activity = (await call(dev, "get_build_activity", { build_id: started.id })).data.activity;
  assert.deepEqual({ type: activity[0].type, summary: activity[0].summary }, { type: "tool_use", summary: 'Bash {"command":"npm test"}' });
  assert.equal((await call(dev, "steer_build", { build_id: started.id, message: "Use the existing design system" })).data.steered, true);
  const inbox = [...sandboxes.sandboxes.get(sbx).files].filter(([path]) => path.startsWith(`${A}/inbox/`));
  assert.deepEqual(inbox.map(([, v]) => JSON.parse(v)), [{ message: "Use the existing design system" }], "steering goes to the runner's inbox");
  const token = JSON.parse(sandboxes.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;
  assert.equal(await builds.agentTokenActive(token), true);
  assert.equal((await call(other, "get_build", { build_id: started.id })).isError, true);
  assert.equal((await call(other, "stop_build", { build_id: started.id })).isError, true);
  b = (await call(dev, "stop_build", { build_id: started.id })).data;
  assert.equal(b.status, "stopped");
  assert.ok(sandboxes.sandboxes.get(sbx).stopped);
  assert.equal(await builds.agentTokenActive(token), false, "stopping a build kills its proxy token");
  const all = (await call(admin, "list_all_builds")).data;
  assert.equal(all.builds.length, 1);
  assert.equal(all.builds[0].source_url, undefined);
  assert.match((await call(dev, "steer_build", { build_id: started.id, message: "go on" })).data.error, /only a running agent/);
});

test("while the agents code, Mynt starts the app's dev server itself and serves port 5173 at a private link", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  assert.equal(started.live_preview_url, null);
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick(); // agent started
  const s = sandboxes.sandboxes.get(sbx);
  const get = async () => (await call(dev, "get_build", { build_id: started.id })).data;

  // Mynt's script, from the coding workspace it wrote, on the app's directory.
  assert.match(s.files.get(`${BUILD}/scripts/dev_preview.sh`), /--host 127\.0\.0\.1 --port '"\$PORT_WEB"' --strictPort/);
  assert.match(s.files.get(`${BUILD}/scripts/dev_preview.sh`), /never installs anything itself/);
  const scriptRuns = () => s.commands.filter((c) => c.command === `bash ${BUILD}/scripts/dev_preview.sh /home/user/workspace/app`).length;
  // No web/ yet: tried again only every 6th tick.
  s.devPreview = "no-web";
  await builds.tick();
  assert.equal(scriptRuns(), 1);
  s.devPreview = "waiting";
  for (let i = 0; i < 4; i++) await builds.tick();
  assert.equal(scriptRuns(), 1, "backs off after no-web");
  await builds.tick();
  assert.equal(scriptRuns(), 2);
  assert.equal((await get()).live_preview_url, null, "no link while the script says waiting");
  // Waiting for the agents' install: every tick.
  await builds.tick();
  assert.equal(scriptRuns(), 3);
  // The dev server is up but doesn't answer yet: every 6th tick again.
  s.devPreview = "starting";
  await builds.tick();
  assert.equal(scriptRuns(), 4);
  for (let i = 0; i < 3; i++) await builds.tick();
  assert.equal(scriptRuns(), 4, "backs off while starting");
  assert.deepEqual(sandboxes.hosted, []);
  s.devPreview = "started"; // Vite answers by the next try
  await builds.tick(); // the 12th: tried again
  assert.equal(scriptRuns(), 5);
  assert.equal(s.commands.filter((c) => c.command.includes("dev_preview.sh /home")).at(-1).timeoutSeconds, 45);

  s.devPreview = "started";
  await builds.tick();
  let b = await get();
  assert.equal(b.live_preview_url, `https://${sbx}-5173.preview.example?_token=t`);
  assert.deepEqual(sandboxes.hosted, [{ id: sbx, port: 5173 }]);
  const event = b.timeline.find((e) => /Live preview started/.test(e.message));
  assert.ok(event, "on the timeline");
  assert.ok(!JSON.stringify(b.timeline).includes("5173.preview"), "the link itself is never on the timeline");

  // Once up, the script runs every 6th tick (restarting a dev server that died), behind the same link.
  const runs = scriptRuns();
  for (let i = 0; i < 6; i++) await builds.tick();
  assert.equal(scriptRuns(), runs + 1);
  assert.equal(sandboxes.hosted.length, 1, "never another link");
  s.devPreview = "waiting"; // the dev server is down for now: the link stays, and the next check restarts it
  for (let i = 0; i < 6; i++) await builds.tick();
  assert.equal((await get()).live_preview_url, `https://${sbx}-5173.preview.example?_token=t`);

  // A script that fails, or a host that errors, never fails the build.
  const other = (await call(dev, "start_build", { goal: "Build another savings page" })).data;
  await builds.tick();
  const sbx2 = (await builds.get(other.id)).sandbox_id;
  sandboxes.ready(sbx2);
  await builds.tick();
  const host = sandboxes.host;
  sandboxes.host = async () => {
    throw new Error("host API down");
  };
  sandboxes.sandboxes.get(sbx2).devPreview = "started";
  await builds.tick();
  sandboxes.host = host;
  assert.equal((await builds.get(other.id)).status, "coding");
  assert.equal((await builds.get(other.id)).live_preview_url, null);
  // Only while the agents code: once they've moved on to auditing, it isn't started.
  sandboxes.write(sbx2, `${BUILD}/job/status.json`, { phase: "auditing", message: "Reviewing" });
  await builds.tick();
  assert.equal((await builds.get(other.id)).status, "auditing");
  assert.equal((await builds.get(other.id)).live_preview_url, null);
  assert.equal(sandboxes.hosted.length, 1);

  // Gone from a stopped build.
  await call(dev, "stop_build", { build_id: started.id });
  b = await get();
  assert.equal(b.live_preview_url, null);
});

test("a live preview started while coding stays shown through the agent's review, checks and push, until verification", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick(); // agent started
  sandboxes.sandboxes.get(sbx).devPreview = "started";
  await builds.tick();
  const link = `https://${sbx}-5173.preview.example?_token=t`;
  const get = async () => (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal((await get()).live_preview_url, link);
  // The dev servers keep running while the agent reviews, checks and pushes: the link is still shown.
  for (const phase of ["auditing", "checking", "previewing", "pushing"]) {
    sandboxes.write(sbx, `${BUILD}/job/status.json`, { phase, message: phase });
    await builds.tick();
    const b = await get();
    assert.equal(b.status, phase);
    assert.equal(b.live_preview_url, link, phase);
    assert.equal((await call(dev, "list_builds", {})).data.builds[0].live_preview_url, link);
  }
  // Mynt stops them when the agent is done and verification starts: the link goes.
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx);
  await builds.tick();
  assert.equal((await get()).status, "verifying");
  assert.equal((await get()).live_preview_url, null);
});

test("a build's phase says each verification step, and an ended build says why it ended there", async () => {
  const ctx = await setup();
  const { builds, sandboxes, call } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx);
  await builds.tick();
  const phase = async () => (await call(dev, "get_build_activity", { build_id: started.id })).data.phase_message;
  assert.equal(await phase(), "Source packaged; independent verification started");
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  sandboxes.ready(vid);
  await builds.tick();
  assert.match(await phase(), /^Running Mynt's checks: tests/);
  sandboxes.sandboxes.get(vid).checksRunning = false;
  sandboxes.write(vid, `${V}/before.sha`, "tree\n");
  const failing = [
    ...passingChecks.filter((c) => c.name !== "secrets_scan"),
    { name: "secrets_scan", status: "fail", detail: "1 secret(s): generic-api-key in api/.env.example" },
    { name: "static_scan", status: "fail", detail: `high-severity: ${"x".repeat(400)}` },
  ];
  sandboxes.write(vid, `${V}/report.json`, { checks: failing });
  await builds.tick();
  assert.match(await phase(), /^Checks finished; independent Maxwell audit started \(.*up to \d+ min\)/);
  sandboxes.write(vid, `${V}/maxwell.json`, cleanAudit);
  sandboxes.finishAgent(vid, "success");
  await builds.tick();
  const b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "failed");
  // Which checks failed and what they found, cut short, as the error and as the phase.
  assert.match(b.error, /^Not production-ready: secrets_scan \(1 secret\(s\): generic-api-key in api\/\.env\.example\); static_scan \(high-severity: x+…\)$/);
  assert.ok(b.error.length < 500);
  assert.equal(b.phase_message, b.error);
  assert.equal(await phase(), b.error);

  // Stopped, or over budget: the phase says so too.
  const other = (await call(dev, "start_build", { goal: "Build another savings page" })).data;
  await builds.tick();
  await call(dev, "stop_build", { build_id: other.id });
  const stopped = (await call(dev, "get_build", { build_id: other.id })).data;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.phase_message, stopped.error);
});

test("Mynt's live preview: the template's Vite config is behind the forwarder only when Mynt starts it", async () => {
  const files = workspaceFiles("coding-build");
  const vite = files["templates/mynt-app/web/vite.config.ts"];
  assert.match(vite, /const live = process\.env\.MYNT_LIVE_PREVIEW === "1"/);
  assert.match(vite, /allowedHosts: true/);
  assert.match(vite, /hmr: \{ protocol: "wss", clientPort: 443 \}/);
  assert.match(vite, /\.\.\.\(live \? \{/, "a developer's own dev server keeps Vite's localhost-only defaults");
  assert.match(vite, /host: "127\.0\.0\.1"/);
  assert.match(vite, /cacheDir: process\.env\.MYNT_VITE_CACHE/, "Vite's cache stays out of the app's source");
  assert.match(files["scripts/dev_preview.sh"], /MYNT_LIVE_PREVIEW=1/);
  assert.match(files["scripts/dev_preview.sh"], /export MYNT_VITE_CACHE="\$STATE\/vite-cache"/);
  assert.equal(JSON.parse(files["templates/mynt-app/api/package.json"]).scripts.dev, "tsx watch src/server.ts", "the api's dev server comes from the app's own dependencies");
  assert.ok(JSON.parse(files["templates/mynt-app/api/package.json"]).devDependencies.tsx);
  assert.match(files["CLAUDE.md"], /live preview/i);
  assert.match(files["CLAUDE.md"], /5173/);
});

test("when coding ends Mynt stops the live preview, then packages the source without any node_modules, at any depth", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const { sbx, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" } });
  assert.equal(build.status, "succeeded");
  assert.equal(build.live_preview_url, null, "no live link once coding is over");
  const commands = ctx.sandboxes.sandboxes.get(sbx).commands.map((c) => c.command);
  const stop = commands.findIndex((c) => c.includes("scripts/dev_preview.sh --stop"));
  const pack = commands.findIndex((c) => c.includes("tar --exclude"));
  assert.ok(stop >= 0 && stop < pack, "the dev servers stop before the source is packaged");

  // Mynt's own packaging command, run for real on an app with dependencies and Vite's cache nested in web/.
  const root = mkdtempSync(join(tmpdir(), "mynt-pack-"));
  const app = join(root, "app");
  for (const d of ["node_modules/x", "web/node_modules/.vite/deps", "web/src", "packages/mynt-sdk/node_modules/y"]) mkdirSync(join(app, d), { recursive: true });
  for (const f of ["node_modules/x/i.js", "web/node_modules/.vite/deps/react.js", "web/src/App.tsx", "packages/mynt-sdk/node_modules/y/i.js", "package.json"]) writeFileSync(join(app, f), "x");
  const command = commands[pack].replaceAll("/home/user/workspace/app", app).replaceAll("/home/user/mynt-out", join(root, "out"));
  execFileSync("bash", ["-c", command]);
  const listed = execFileSync("tar", ["-tzf", join(root, "out", "app.tgz")], { encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(listed.includes("./web/src/App.tsx") && listed.includes("./package.json"), listed.join(" "));
  assert.deepEqual(listed.filter((p) => p.includes("node_modules")), []);
});

const say = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const run = (command) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

test("the agent's activity is stored as the build runs: paged with a cursor, and kept after the sandbox stops", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  const activity = async (args = {}) => (await call(dev, "get_build_activity", { build_id: started.id, ...args })).data;
  assert.deepEqual((await activity()).activity, [], "nothing before the agent starts");
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();

  // Complete lines only: a line still being written waits for its newline. Lines Mynt doesn't show (tool results)
  // are read past.
  sandboxes.log(sbx, say("Reading the spec"), { type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(500) }] } }, run("npm test"), '{"type":"assistant","message":{"content":[{"type":"text","text":"Half');
  await builds.tick();
  let all = await activity({ after: 0 });
  assert.deepEqual(all.activity.map((a) => [a.seq, a.type, a.summary]), [[1, "message", "Reading the spec"], [2, "tool_use", 'Bash {"command":"npm test"}']]);
  assert.equal(all.cursor, 2);
  assert.ok(all.activity.every((a) => !Number.isNaN(Date.parse(a.at))));
  sandboxes.log(sbx, ' written"}]}}\n', { type: "result", subtype: "success", total_cost_usd: 0.42 });
  await builds.tick();
  await builds.tick(); // nothing new: nothing stored twice

  // Paging: oldest first after a cursor, a new cursor each time; it stays put when there's nothing new.
  const page1 = await activity({ after: 0, limit: 2 });
  assert.deepEqual(page1.activity.map((a) => a.seq), [1, 2]);
  const page2 = await activity({ after: page1.cursor, limit: 2 });
  assert.deepEqual(page2.activity.map((a) => [a.seq, a.summary]), [[3, "Half written"], [4, "success, US$0.42"]]);
  assert.deepEqual(await activity({ after: page2.cursor }).then((r) => [r.activity, r.cursor]), [[], 4]);
  // Without a cursor: the latest, newest first.
  assert.deepEqual((await activity({ limit: 2 })).activity.map((a) => a.seq), [4, 3]);
  assert.equal((await activity()).cursor, 4);

  // What the agent did just before the developer stopped it is kept, and all of it outlives the sandbox.
  sandboxes.log(sbx, run("git status"));
  await call(dev, "stop_build", { build_id: started.id });
  assert.ok(sandboxes.sandboxes.get(sbx).stopped);
  all = await activity({ after: 0 });
  assert.deepEqual(all.activity.map((a) => a.summary), ["Reading the spec", 'Bash {"command":"npm test"}', "Half written", "success, US$0.42", 'Bash {"command":"git status"}']);
  assert.equal(all.status, "stopped");
  assert.match((await call(other, "get_build_activity", { build_id: started.id })).data.error, /No build of yours/);
});

test("a line too long to keep is skipped, across reads, without losing the lines around it; each build keeps its latest entries", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  // A 600 KB tool result (more than two reads), with multi-byte text before and after it.
  sandboxes.log(sbx, say("Café – first"), { type: "user", message: { content: [{ type: "tool_result", content: "é".repeat(300_000) }] } }, say("naïve – after"));
  await builds.tick();
  const got = (await call(dev, "get_build_activity", { build_id: started.id, after: 0 })).data.activity;
  assert.deepEqual(got.map((a) => a.summary), ["Café – first", "naïve – after"]);
  assert.equal((await builds.get(started.id)).activity_offset, Buffer.byteLength(sandboxes.sandboxes.get(sbx).files.get(`${A}/agent.jsonl`)));

  // Over the per-build limit, the oldest entries go; seq keeps counting.
  sandboxes.log(sbx, ...Array.from({ length: 5003 }, (_, i) => say(`step ${i}`)));
  for (let i = 0; i < 3; i++) await builds.tick();
  const { ACTIVITY_KEEP } = await import("../dist/builds.js");
  const count = (await builds.activity({ id: started.id }, { after: 0, limit: 200 })).activity;
  assert.equal(count[0].seq, 2 + 5003 - ACTIVITY_KEEP + 1);
  const latest = (await call(dev, "get_build_activity", { build_id: started.id, limit: 1 })).data;
  assert.deepEqual([latest.activity[0].seq, latest.activity[0].summary, latest.cursor], [5005, "step 5002", 5005]);
  assert.equal(latest.first_seq, count[0].seq, "first_seq says where the kept entries start, so a follower can tell some were trimmed");
});

test("one bad line never stalls activity: NULs are stripped, and an entry the database refuses is dropped, not retried forever", async () => {
  let poisoned = 0;
  const refuse = (sql, params) => sql.includes("INSERT INTO financial_products.build_activity") && (params ?? []).some((p) => typeof p === "string" && p.includes("POISON") && ++poisoned);
  const { builds, sandboxes, as, connect, call } = await setup({ refuse });
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const summaries = async () => (await call(dev, "get_build_activity", { build_id: started.id, after: 0 })).data.activity.map((a) => a.summary);

  // A NUL (which Postgres text refuses) between good lines: all three are kept, the NUL gone.
  sandboxes.log(sbx, say("before"), say("bad\u0000text"), say("after"));
  await builds.tick();
  assert.deepEqual(await summaries(), ["before", "bad text", "after"]);

  // An entry the database refuses for any other reason: the rest of its chunk is kept, and the offset moves on.
  sandboxes.log(sbx, say("good one"), say("POISON"), say("good two"));
  await builds.tick();
  assert.ok(poisoned >= 2, "the batch, then the entry on its own, were refused");
  sandboxes.log(sbx, say("later"));
  await builds.tick();
  assert.deepEqual(await summaries(), ["before", "bad text", "after", "good one", "good two", "later"]);
  assert.equal((await builds.get(started.id)).activity_offset, Buffer.byteLength(sandboxes.sandboxes.get(sbx).files.get(`${A}/agent.jsonl`)));
});

test("activity is scrubbed of secrets before it is cut to length", async () => {
  const { activitySummary } = await import("../dist/builds.js");
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const gh = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
  sandboxes.log(sbx, say(`the token is ${gh}, don't share it`), run("GITHUB_TOKEN=supersecretvalue123 git push"), say(`${"x".repeat(385)} ${gh}`));
  await builds.tick();
  const got = (await call(dev, "get_build_activity", { build_id: started.id, after: 0 })).data.activity.map((a) => a.summary);
  assert.equal(got[0], "the token is [redacted], don't share it");
  assert.equal(got[1], 'Bash {"command":"GITHUB_TOKEN=[redacted] git push"}');
  // The token straddles the 400-character cut: scrubbed first, so no prefix of it survives.
  assert.ok(!got[2].includes("ghs_") && got[2].length <= 400, got[2]);
  assert.ok(got.every((s) => !s.includes("supersecret") && !s.includes("abcdefghij")));
  // A cut never leaves half a surrogate pair.
  assert.equal(activitySummary("a".repeat(399) + "😀"), "a".repeat(399));
});

test("activity streams the agent's words as it writes them, to a follower that asks, scrubbed, and read fresh when followed", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const ev = (event) => ({ type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event });
  const delta = (text) => ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  const gh = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
  // The token arrives in two pieces, in two reads.
  sandboxes.log(sbx, ev({ type: "message_start", message: { id: "msg_1" } }), ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }), delta("Pushing with "), delta(gh.slice(0, 12)));
  await builds.tick();
  sandboxes.log(sbx, delta(gh.slice(12) + " now"));
  await builds.tick();
  const follow = async (args) => (await call(dev, "get_build_activity", { build_id: started.id, ...args })).data;
  let got = await follow({ after: 0, text_deltas: true });
  assert.deepEqual(got.activity.map((a) => [a.type, a.summary, a.stream]), [["text_delta", "Pushing with ", "msg_1:0"], ["text_delta", "[redacted] ", "msg_1:0"]]);

  // Followed with no tick: get_build_activity reads the log itself once the last read is over a second old.
  sandboxes.log(sbx, { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: `Pushing with ${gh} now` }] } });
  await new Promise((r) => setTimeout(r, 1100));
  got = await follow({ after: got.cursor, text_deltas: true });
  assert.deepEqual(got.activity.map((a) => [a.type, a.summary, a.stream]), [["text_delta", "now", "msg_1:0"], ["message", "Pushing with [redacted] now", "msg_1:0"]]);

  // A caller that doesn't ask for them sees what it always did: the message, without its deltas.
  const plain = await follow({ after: 0 });
  assert.deepEqual(plain.activity.map((a) => [a.seq, a.type, a.summary]), [[4, "message", "Pushing with [redacted] now"]]);
  assert.equal(plain.cursor, 4);
  assert.deepEqual((await follow({ limit: 5 })).activity.map((a) => a.type), ["message"]);
});

test("activity returns the agent's reasoning, scrubbed, only to a caller that asks for it", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const ev = (event) => ({ type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event });
  const think = (thinking) => ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } });
  const gh = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
  // The token arrives in two pieces, in two reads.
  sandboxes.log(sbx, ev({ type: "message_start", message: { id: "msg_1" } }), ev({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }), think("The env has "), think(gh.slice(0, 12)));
  await builds.tick();
  sandboxes.log(sbx, think(gh.slice(12) + " in it"));
  await builds.tick();
  sandboxes.log(
    sbx,
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "thinking", thinking: `The env has ${gh} in it`, signature: "sig" }] } },
    { type: "assistant", parent_tool_use_id: null, message: { id: "msg_1", content: [{ type: "text", text: "Removing a token." }] } },
  );
  await builds.tick();
  const follow = async (args) => (await call(dev, "get_build_activity", { build_id: started.id, ...args })).data;
  const shape = (got) => got.activity.map((a) => [a.type, a.summary, a.stream ?? null]);

  assert.deepEqual(shape(await follow({ after: 0, text_deltas: true, reasoning: true })), [
    ["thinking_delta", "The env has ", "msg_1:0"],
    ["thinking_delta", "[redacted] in ", "msg_1:0"], // the token held back until whole, then scrubbed
    ["thinking_delta", "it", "msg_1:0"],
    ["thinking", "The env has [redacted] in it", "msg_1:0"],
    ["message", "Removing a token.", null],
  ]);
  // Reasoning without deltas: the whole thinking entries only.
  assert.deepEqual(shape(await follow({ after: 0, reasoning: true })).map((a) => a[0]), ["thinking", "message"]);
  // A caller that doesn't ask (the sample chat, the SDKs) sees no reasoning at all, with deltas or without.
  assert.deepEqual(shape(await follow({ after: 0, text_deltas: true })).map((a) => a[0]), ["message"]);
  assert.deepEqual(shape(await follow({ after: 0 })).map((a) => a[0]), ["message"]);
  assert.deepEqual((await follow({ limit: 5 })).activity.map((a) => a.type), ["message"]);
  const stored = JSON.stringify(await follow({ after: 0, text_deltas: true, reasoning: true }));
  assert.ok(!stored.includes("abcdefghij") && !stored.includes("sig"), stored);
});

test("remove_app deletes a removed app's stored build activity", async () => {
  const { builds, sandboxes, as, connect, call, pg } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  sandboxes.log(sbx, say("hello"));
  await builds.tick();
  await call(dev, "stop_build", { build_id: started.id });
  const rows = async () => (await pg.query("SELECT count(*)::int AS n FROM financial_products.build_activity WHERE build_id = $1", [started.id])).rows[0].n;
  assert.equal(await rows(), 1);
  const dry = (await call(admin, "remove_app", { app_id: app.id })).data;
  assert.equal(dry.would_remove.rows.build_activity, 1, JSON.stringify(dry));
  const done = await call(admin, "remove_app", { app_id: app.id, confirm: true, reason: "test" });
  assert.equal(done.isError, false, JSON.stringify(done.data));
  assert.equal(await rows(), 0);
});

test("activityLines: complete lines only, a line being skipped is dropped to its end, an over-long one is skipped", async () => {
  const { activityLines } = await import("../dist/builds.js");
  const b = (s) => Buffer.from(s);
  assert.deepEqual(activityLines(b('{"a":1}\n{"b":'), false, 100), { consumed: 8, lines: ['{"a":1}'] });
  assert.deepEqual(activityLines(b('\n{"b":2}\n'), true, 100), { consumed: 8, lines: ['{"b":2}'] });
  assert.deepEqual(activityLines(b('\n{"b":'), true, 100), { consumed: 0, lines: [] }, "a short partial line waits");
  assert.deepEqual(activityLines(b("x".repeat(10)), false, 10), { consumed: 10, lines: [] }, "a line longer than a read is skipped");
  assert.deepEqual(activityLines(b('xxxx\n{"c":3}\n'), true, 100), { consumed: 12, lines: ['{"c":3}'] }, "the rest of a skipped line is dropped");
  assert.deepEqual(activityLines(b("xxxx"), true, 100), { consumed: 3, lines: [] }, "still inside the skipped line");
  assert.deepEqual(activityLines(b(""), true, 100), { consumed: 0, lines: [] });
});

test("start_build kind: listed by list_app_kinds, checked, stored with the build and given to the agent", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const kinds = (await call(dev, "list_app_kinds")).data.kinds;
  const goals = kinds.find((k) => k.id === "savings-goals");
  assert.ok(goals && goals.title === "Savings goals" && goals.product_lines.length && goals.goal_template && goals.screens.length);
  const refused = await call(dev, "start_build", { goal: "Build a savings page please", kind: "lemonade" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.error, /No app kind 'lemonade'; list_app_kinds lists them/);
  assert.deepEqual((await call(dev, "list_builds", {})).data.builds, [], "nothing was queued");

  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const started = (await call(dev, "start_build", { goal: goals.goal_template, app_id: app.id, kind: "savings-goals" })).data;
  assert.equal(started.kind, "savings-goals");
  assert.equal((await call(dev, "get_build", { build_id: started.id })).data.kind, "savings-goals");
  assert.equal((await builds.get(started.id)).kind, "savings-goals");
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const files = sandboxes.sandboxes.get(sbx).files;
  assert.equal(JSON.parse(files.get(`${BUILD}/job/build.json`)).kind, "savings-goals");
  assert.ok(files.get(`${BUILD}/templates/kinds/savings-goals.json`), "the kind's file is in the agent's workspace");

  // Without one, the build has none.
  const plain = (await call(dev, "start_build", { goal: "Build something unrelated please" })).data;
  assert.equal(plain.kind, null);
});

test("list_builds filters by app", async () => {
  const { as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const mine = (await call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id })).data;
  await call(dev, "start_build", { goal: "Build something unrelated please" });
  assert.equal((await call(dev, "list_builds", {})).data.builds.length, 2);
  assert.deepEqual((await call(dev, "list_builds", { app_id: app.id })).data.builds.map((b) => b.id), [mine.id]);
  assert.deepEqual((await call(dev, "list_builds", { app_id: "00000000-0000-0000-0000-000000000000" })).data.builds, []);
});

test("a session build stays open for the developer's requests; finish_build ships it and Mynt verifies it as usual", async () => {
  const ctx = await setup();
  const { builds, sandboxes, as, connect, call, repos } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const started = (await call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app", mode: "session" })).data;
  assert.equal(started.mode, "session");
  assert.equal(started.finish_requested_at, null);
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const s = sandboxes.sandboxes.get(sbx);

  // The runner is held open, with the 15-minute idle default, and knows how to finish; the agent is told it's a session.
  const launch = s.commands.find((c) => c.command.includes("runner.mjs")).command;
  assert.match(launch, /^MYNT_AGENT_HOLD=1 MYNT_AGENT_IDLE_MS=900000 node /);
  assert.match(sandboxes.agentConfig(sbx).finishPrompt, /steps 2 to 6/);
  assert.match(sandboxes.agentConfig(sbx).prompt, /session mode/);
  assert.equal(JSON.parse(s.files.get(`${BUILD}/job/build.json`)).build.mode, "session");
  assert.match(s.files.get(`${BUILD}/CLAUDE.md`), /## Session mode/);
  assert.match(s.files.get(`${BUILD}/CLAUDE.md`), /Waiting for your next message/);

  // Between requests the agent waits (still coding); each request is a steer.
  sandboxes.write(sbx, `${BUILD}/job/status.json`, { phase: "coding", message: "Waiting for your next message" });
  await builds.tick();
  assert.equal((await builds.get(started.id)).phase_message, "Waiting for your next message");
  assert.equal((await call(dev, "steer_build", { build_id: started.id, message: "Add a rates table" })).data.steered, true);

  // Only the owner, only a session, and only once.
  assert.match((await call(other, "finish_build", { build_id: started.id })).data.error, /No build of yours/);
  const once = (await call(dev, "start_build", { goal: "Build another savings page" })).data;
  assert.match((await call(dev, "finish_build", { build_id: once.id })).data.error, /Only a session build/);
  const fin = (await call(dev, "finish_build", { build_id: started.id })).data;
  assert.equal(fin.finishing, true);
  const finishes = [...s.files].filter(([p]) => p.startsWith(`${A}/inbox/`) && p.endsWith("-finish.json")).map(([, v]) => JSON.parse(v));
  assert.deepEqual(finishes.map((f) => f.finish), [true]);
  assert.match(finishes[0].message, /Finish the session/);
  assert.equal((await call(dev, "finish_build", { build_id: started.id })).data.since, fin.since, "finishing twice is a no-op");
  assert.match((await call(dev, "steer_build", { build_id: started.id, message: "One more" })).data.error, /finishing/);
  assert.ok((await call(dev, "get_build", { build_id: started.id })).data.finish_requested_at);

  // The agent ships and exits; Mynt verifies in a clean sandbox exactly as for any build.
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx);
  await builds.tick();
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  assert.ok(vid, "verification started");
  sandboxes.ready(vid);
  await builds.tick();
  sandboxes.sandboxes.get(vid).checksRunning = false;
  sandboxes.write(vid, `${V}/before.sha`, "tree\n");
  sandboxes.write(vid, `${V}/report.json`, { checks: passingChecks });
  await builds.tick();
  sandboxes.write(vid, `${V}/maxwell.json`, cleanAudit);
  sandboxes.finishAgent(vid);
  await builds.tick();
  const done = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(done.status, "succeeded");
  assert.equal(repos.prs.length, 1);
  assert.match((await call(dev, "finish_build", { build_id: started.id })).data.error, /succeeded/);
});

test("a session's idle machine time counts against its cap", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", mode: "session", cap_usd: 3 })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  sandboxes.sandboxes.get(sbx).cost = 3.5; // the sandbox sat waiting; no model spend at all
  await builds.tick();
  const b = await builds.get(started.id);
  assert.equal(b.status, "over_budget");
  assert.ok(sandboxes.sandboxes.get(sbx).stopped);
});

test("by default an app's builds push to a private repository Mynt creates and manages for it: PRs, continue_from and hosting's source token work", async () => {
  const managed = fakeManagedHost();
  const ctx = await setup({ managed });
  const { builds, sandboxes, as, connect, call, repos, pg } = ctx;
  const devUser = await as("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const expected = `mynt-apps/mynt-app-${app.id}`;
  assert.equal((await call(dev, "get_app_repository", { app_id: app.id })).data.repository, null, "none until the first build");

  // No repository named, no GitHub of the developer's: Mynt's own, named by the app's id only.
  const { started, sbx, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings comparison page", app_id: app.id } });
  assert.equal(started.repository, expected);
  assert.deepEqual(managed.created, [`mynt-app-${app.id}`]);
  const coding = sandboxes.sandboxes.get(sbx);
  assert.equal(coding.opts.env.GITHUB_REPOSITORY, expected);
  assert.equal(coding.opts.env.GITHUB_TOKEN, "ghs_short_lived");
  const spec = JSON.parse(coding.files.get(`${BUILD}/job/build.json`)).build;
  assert.equal(spec.managed_repository, true);
  assert.match(coding.files.get(`${BUILD}/CLAUDE.md`), /build\.managed_repository/);
  // Verified, then Mynt opens the PR there, as for any repository, with the managed repositories' access.
  assert.equal(build.status, "succeeded");
  assert.equal(build.commit_sha, COMMIT);
  assert.deepEqual([repos.prs[0].repo, repos.prs[0].installation], [expected, 77]);
  // Hosting fetches a verified commit with a read token found through the developer's repository connections.
  const conn = (await pg.query("SELECT installation_id FROM financial_products.repo_connections WHERE developer_id = $1 AND repository = $2", [devUser.id, expected])).rows;
  assert.equal(Number(conn[0].installation_id), 77);
  assert.deepEqual((await call(dev, "list_repositories")).data.map((r) => [r.repository, r.managed]), [[expected, true]]);

  // The app's next builds reuse it; continue_from carries on in it.
  const next = (await call(dev, "start_build", { goal: "Now add a rates table to it", app_id: app.id, continue_from: started.id })).data;
  assert.equal(next.repository, expected);
  const again = (await call(dev, "start_build", { goal: "Another change to the same app", app_id: app.id })).data;
  assert.equal(again.repository, expected);
  assert.equal(managed.created.length, 1, "created once per app");

  // The developer can clone their code with a short-lived, read-only token.
  const repo = (await call(dev, "get_app_repository", { app_id: app.id })).data;
  assert.equal(repo.managed, true);
  assert.deepEqual([repo.clone.url, repo.clone.username, repo.clone.password, repo.clone.expires_in_minutes], [`https://git.example/${expected}.git`, "x-access-token", "ghs_readonly_short_lived", 60]);

  // After moving the app to their own repository: continuing a managed build says what to do, and the managed
  // repository can still be cloned to carry its branch over.
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  await call(dev, "set_app_repository", { app_id: app.id, repository: "acme/savings-app" });
  for (const b of (await call(dev, "list_builds", {})).data.builds) await call(dev, "stop_build", { build_id: b.id });
  assert.match(
    (await call(dev, "start_build", { goal: "Carry on in my own repository", continue_from: started.id })).data.error,
    /in the app's previous managed repository .*push its branch .* to your own repository first/,
  );
  const after = (await call(dev, "get_app_repository", { app_id: app.id })).data;
  assert.deepEqual([after.repository, after.managed, after.clone.repository], ["acme/savings-app", false, expected]);
});

test("a managed repository created while the developer set their own keeps the developer's choice, and never gets the managed access", async () => {
  const managed = fakeManagedHost();
  const { builds, as, connect, call, pg } = await setup({ managed });
  const devUser = await as("Dev", ["developer"]);
  const dev = await connect(devUser);
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  managed.onCreate = () => builds.setAppRepository(devUser, app.id, "acme/savings-app");
  const b = (await call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id })).data;
  assert.equal(b.repository, "acme/savings-app");
  const conns = (await pg.query("SELECT repository, installation_id FROM financial_products.repo_connections WHERE developer_id = $1 ORDER BY repository", [devUser.id])).rows;
  assert.deepEqual(conns.map((r) => [r.repository, Number(r.installation_id)]), [["acme/savings-app", 42]], "the developer's own repository keeps its own installation");
  // The managed one is still recorded as Mynt's: never connectable by name.
  assert.equal((await builds.appRepository(app.id)).managed_repository, `mynt-apps/mynt-app-${app.id}`);
});

test("managed repositories belong to their app: never connected by name, never used by another app or developer; developers can switch to their own", async () => {
  const managed = fakeManagedHost();
  const { builds, as, connect, call, pg } = await setup({ managed });
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const app2 = (await call(dev, "create_app", { name: "Other", description: "Other ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const first = (await call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id })).data;
  const repo = first.repository;

  assert.match((await call(dev, "connect_repository", { repository: repo })).data.error, /Mynt's managed repositories/);
  assert.match((await call(other, "connect_repository", { repository: repo })).data.error, /Mynt's managed repositories/);
  assert.match((await call(dev, "start_build", { goal: "Push into another app's repository", app_id: app2.id, repository: repo })).data.error, /isn't this app's/);
  assert.match((await call(other, "get_app_repository", { app_id: app.id })).data.error, /No app of yours/);
  assert.match((await call(other, "set_app_repository", { app_id: app.id, repository: "acme/savings-app" })).data.error, /No app of yours/);

  // Their own repository, later: it must be connected, and it can't be a managed one.
  assert.match((await call(dev, "set_app_repository", { app_id: app.id, repository: "acme/savings-app" })).data.error, /isn't connected/);
  assert.match((await call(dev, "set_app_repository", { app_id: app.id, repository: "mynt-apps/mynt-app-someone-else" })).data.error, /of your own/);
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const set = (await call(dev, "set_app_repository", { app_id: app.id, repository: "acme/savings-app" })).data;
  assert.deepEqual([set.repository, set.managed, set.previous], ["acme/savings-app", false, repo]);
  assert.equal((await call(dev, "start_build", { goal: "Build the next version please", app_id: app.id })).data.repository, "acme/savings-app");
  // And back to its own managed repository (the only managed one it can name), then to theirs again.
  const back = (await call(dev, "set_app_repository", { app_id: app.id, repository: repo })).data;
  assert.deepEqual([back.repository, back.managed, back.previous], [repo, true, "acme/savings-app"]);
  assert.equal((await call(dev, "start_build", { goal: "Build in the managed one again", app_id: app.id })).data.repository, repo);
  await call(dev, "set_app_repository", { app_id: app.id, repository: "acme/savings-app" });
  assert.deepEqual((await call(dev, "get_app_repository", { app_id: app.id })).data.managed, false);

  // A host that can't create one says what to do instead; without managed repositories, builds work as before.
  managed.reachable = false;
  assert.match((await call(dev, "start_build", { goal: "Build the second app please", app_id: app2.id })).data.error, /connect your own with connect_repository/);
  builds.managedHost = null;
  assert.equal((await call(dev, "start_build", { goal: "Build the second app please", app_id: app2.id })).data.repository, null);

  // remove_app drops the app's repository record (the repository itself stays on the host).
  const admin = await connect(await as("Ada", ["admin"]));
  await call(dev, "stop_build", { build_id: first.id });
  for (const b of (await call(dev, "list_builds", {})).data.builds) await call(dev, "stop_build", { build_id: b.id });
  const removed = await call(admin, "remove_app", { app_id: app.id, confirm: true, reason: "test" });
  assert.equal(removed.isError, false, JSON.stringify(removed.data));
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.app_repositories WHERE app_id = $1", [app.id])).rows[0].n, 0);
  // And the developer's access to its managed repository; their own repository stays connected.
  const left = (await pg.query("SELECT repository FROM financial_products.repo_connections ORDER BY repository")).rows.map((r) => r.repository);
  assert.ok(!left.includes(repo) && left.includes("acme/savings-app"), left.join(", "));
  // Its name stays refused, even with the managed organization no longer configured (as after a rename).
  assert.equal(builds.managedHost, null);
  assert.match((await call(other, "connect_repository", { repository: repo })).data.error, /Mynt's managed repositories/);
});

test("the managed-repository guard fails closed: only a missing table means none recorded", async () => {
  const { isManagedRepository } = await import("../dist/git-host.js");
  const failing = (code) => ({ query: async () => Promise.reject(Object.assign(new Error("db"), { code })) });
  assert.equal(await isManagedRepository(failing("42P01"), null, "acme/x"), false);
  await assert.rejects(isManagedRepository(failing("57P01"), null, "acme/x"), /db/);
  await assert.rejects(isManagedRepository(failing(undefined), null, "acme/x"), /db/);
});

test("scaffold_app.py starts an app in a fresh clone that holds only a README", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const root = mkdtempSync(join(tmpdir(), "mynt-scaffold-"));
  const sdk = join(root, "sdk");
  mkdirSync(join(sdk, "typescript"), { recursive: true });
  writeFileSync(join(sdk, "typescript", "package.json"), JSON.stringify({ name: "x" }));
  writeFileSync(join(sdk, "openapi.json"), "{}");
  const clone = join(root, "app");
  mkdirSync(join(clone, ".git"), { recursive: true });
  writeFileSync(join(clone, "README.md"), "# mynt-app-x\n");
  const script = new URL("../workspaces/coding-build/scripts/scaffold_app.py", import.meta.url).pathname;
  execFileSync("python3", [script, clone, "--sdk", sdk, "--no-mobile"]);
  assert.ok(existsSync(join(clone, "web", "package.json")) && existsSync(join(clone, ".git")));
  assert.match(readFileSync(join(clone, "README.md"), "utf8"), /One Docker Compose project/);
  // Anything else in it is the developer's work: refused.
  writeFileSync(join(root, "keep.txt"), "x");
  const other = join(root, "other");
  mkdirSync(other);
  writeFileSync(join(other, "server.js"), "x");
  assert.throws(() => execFileSync("python3", [script, other, "--sdk", sdk, "--no-mobile"], { stdio: "pipe" }), /isn't empty/);
});

// A session build with its agent running, for the tests below.
async function runningSession(ctx, args = {}) {
  const dev = await ctx.connect(await ctx.as(`Dev ${randomUUID().slice(0, 6)}`, ["developer"]));
  const started = (await ctx.call(dev, "start_build", { goal: "Build a savings page please", mode: "session", ...args })).data;
  await ctx.builds.tick();
  const sbx = (await ctx.builds.get(started.id)).sandbox_id;
  ctx.sandboxes.ready(sbx);
  await ctx.builds.tick();
  return { dev, started, sbx, s: ctx.sandboxes.sandboxes.get(sbx) };
}
// Finish items in place in the runner's inbox (a dot-name is one still being written, which the runner skips).
const finishItems = (s) => [...s.files].filter(([p]) => p.startsWith(`${A}/inbox/`) && !p.startsWith(`${A}/inbox/.`) && p.endsWith("-finish.json")).map(([, v]) => JSON.parse(v));

test("a session the runner finished on its own (idle) takes no more steers; nor does one finished after the steer loaded it", async () => {
  const ctx = await setup();
  const { builds, sandboxes, call } = ctx;
  const { dev, started, sbx, s } = await runningSession(ctx);
  // The runner went idle and sent the finish prompt itself: Mynt records it on the next tick.
  sandboxes.write(sbx, `${A}/state.json`, { session_id: "s1", cost_usd: 0.5, turns: 2, sent: 2, last_subtype: "success", done: false, exit_code: null, error: null, summary: null, finish: "idle", undelivered: 0 });
  await builds.tick();
  const b = await builds.get(started.id);
  assert.ok(b.finish_requested_at);
  assert.ok((await call(dev, "get_build", { build_id: started.id })).data.timeline.some((e) => /idle too long/.test(e.message)));
  assert.match((await call(dev, "steer_build", { build_id: started.id, message: "One more thing" })).data.error, /finishing/);
  assert.equal((await call(dev, "finish_build", { build_id: started.id })).data.finishing, true);
  assert.deepEqual(finishItems(s), [], "the runner is already finishing: no second finish item");

  // The race: a steer that loaded the build before finish_build recorded the finish is still refused.
  const second = await runningSession(ctx);
  const stale = await builds.get(second.started.id);
  await builds.finish(stale);
  await assert.rejects(builds.steer(stale, "Sneak this in"), /finishing/);
  // And concurrent finishes write one finish item.
  const third = await runningSession(ctx);
  const t = await builds.get(third.started.id);
  await Promise.all([builds.finish(t), builds.finish(t), builds.finish(t)]);
  assert.equal(finishItems(third.s).length, 1);
  // Inbox items are put in place whole, by a rename.
  assert.ok(third.s.commands.some((c) => /^mv -f '\/home\/user\/mynt-agent\/inbox\/\.[^']+-finish\.json' '\/home\/user\/mynt-agent\/inbox\/[^.][^']+-finish\.json'$/.test(c.command)));

  // Messages the runner held back while finishing are reported when it exits.
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx);
  sandboxes.write(sbx, `${A}/state.json`, { session_id: "s1", cost_usd: 0.5, turns: 3, sent: 3, last_subtype: "success", done: true, exit_code: 0, error: null, summary: "shipped", finish: "idle", undelivered: 2 });
  // Moving on to verification fails once (a provider's passing 503), so the tick is retried: the report is made once.
  const exec = sandboxes.exec;
  let failed = false;
  sandboxes.exec = async (id, command, opts) => {
    if (!failed && command.includes("tar --exclude")) {
      failed = true;
      throw new Error('Freestyle POST /vms/vm-1/exec-await: 503 {"code":"INTERNAL_ERROR"}');
    }
    return exec(id, command, opts);
  };
  await builds.tick();
  assert.equal((await builds.get(started.id)).status, "coding", "a passing 503 is ridden out");
  await builds.tick();
  sandboxes.exec = exec;
  const timeline = (await call(dev, "get_build", { build_id: started.id })).data.timeline;
  assert.equal(timeline.filter((e) => /2 message\(s\) arrived while the session was finishing/.test(e.message)).length, 1);
  assert.equal((await builds.get(started.id)).status, "verifying", "and Mynt verifies the work as usual");
});

test("Mynt finishes a session itself before its sandbox's time limit or its cap would end it unshipped", async () => {
  // Time limit: with a 30-minute sandbox the margin has already passed.
  const ctx = await setup({ config: { ttlSeconds: 1800 } });
  const { started, s } = await runningSession(ctx);
  await ctx.builds.tick();
  assert.deepEqual(finishItems(s).map((f) => f.reason), ["ttl"]);
  assert.ok((await ctx.builds.get(started.id)).finish_requested_at);

  // Cap: at 70% of it, or earlier so US$2 is left for the finish turn (on a US$5 cap: at US$3).
  const c2 = await setup();
  const second = await runningSession(c2, { cap_usd: 5 });
  second.s.cost = 2.9;
  await c2.builds.tick();
  assert.deepEqual(finishItems(second.s), []);
  second.s.cost = 3.1;
  await c2.builds.tick();
  assert.deepEqual(finishItems(second.s).map((f) => f.reason), ["cap"]);
  await c2.builds.tick();
  assert.equal(finishItems(second.s).length, 1, "once");
  assert.ok((await c2.call(second.dev, "get_build", { build_id: second.started.id })).data.timeline.some((e) => /spent most of its cap/.test(e.message)));
  const { sessionCapThreshold } = await import("../dist/builds.js");
  assert.deepEqual([sessionCapThreshold(10), sessionCapThreshold(5), sessionCapThreshold(1)], [7, 3, 0]);

  // The time limit counts from the sandbox, not from when the build was queued.
  const c3 = await setup({ config: { ttlSeconds: 7200 } });
  const third = await runningSession(c3);
  await c3.pg.query("UPDATE financial_products.build_runs SET created_at = now() - interval '3 hours' WHERE id = $1", [third.started.id]);
  await c3.builds.tick();
  assert.deepEqual(finishItems(third.s), [], "an old build in a new sandbox has its sandbox's full time");
  await c3.pg.query("UPDATE financial_products.build_runs SET sandbox_started_at = now() - interval '91 minutes' WHERE id = $1", [third.started.id]);
  await c3.builds.tick();
  assert.deepEqual(finishItems(third.s).map((f) => f.reason), ["ttl"]);
});

test("a finish stands even when the agent can't be reached at that moment: Mynt delivers it on the next tick", async () => {
  const ctx = await setup();
  const { started, s, dev } = await runningSession(ctx);
  ctx.sandboxes.failMv = true;
  const r = (await ctx.call(dev, "finish_build", { build_id: started.id })).data;
  assert.equal(r.finishing, true);
  assert.deepEqual(finishItems(s), []);
  let b = await ctx.builds.get(started.id);
  assert.ok(b.finish_requested_at && !b.finish_delivered_at, "claimed, not yet delivered");
  assert.match((await ctx.call(dev, "steer_build", { build_id: started.id, message: "One more" })).data.error, /finishing/);
  await ctx.builds.tick();
  assert.deepEqual(finishItems(s), [], "still unreachable: still pending");
  ctx.sandboxes.failMv = false;
  await ctx.builds.tick();
  assert.deepEqual(finishItems(s).map((f) => f.reason), ["developer"]);
  b = await ctx.builds.get(started.id);
  assert.ok(b.finish_delivered_at);
  await ctx.builds.tick();
  assert.equal(finishItems(s).length, 1, "delivered once");
});

test("a session build needs a cap above the finish reserve; a one-off build doesn't", async () => {
  const { as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please", mode: "session", cap_usd: 2 })).data.error, /cap above US\$2/);
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please", mode: "session", cap_usd: 1.5 })).data.error, /cap above US\$2/);
  assert.equal((await call(dev, "start_build", { goal: "Build a savings page please", mode: "session", cap_usd: 2.5 })).isError, false);
  assert.equal((await call(dev, "start_build", { goal: "Build a savings page please", cap_usd: 2 })).isError, false);
});

test("BUILD_SESSION_IDLE_MS must be a sensible number of milliseconds, or the 15-minute default applies", () => {
  for (const [v, want] of [[undefined, 900000], ["120000", 120000], ["abc", 900000], ["5", 900000], ["1e12", 900000], ["Infinity", 900000]])
    assert.equal(buildConfigFromEnv(v === undefined ? {} : { BUILD_SESSION_IDLE_MS: v }).sessionIdleMs, want, String(v));
});

test("continue_from starts a build from an earlier build's pushed branch, on the same app and repository", async () => {
  const ctx = await setup();
  const { builds, sandboxes, as, connect, call } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const { started: first, build: shipped } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" } });
  assert.equal(shipped.status, "succeeded");

  const next = (await call(dev, "start_build", { goal: "Now add a rates table to it", continue_from: first.id, mode: "session" })).data;
  assert.equal(next.continued_from, first.id);
  assert.equal(next.app_id, app.id, "the app is carried over");
  assert.equal(next.repository, "acme/savings-app", "and the repository");
  await builds.tick();
  const sbx = (await builds.get(next.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const spec = JSON.parse(sandboxes.sandboxes.get(sbx).files.get(`${BUILD}/job/build.json`)).build;
  assert.deepEqual(spec.base, { branch: shipped.branch, commit_sha: COMMIT, build_id: first.id });
  assert.notEqual(spec.branch, shipped.branch, "it pushes a branch of its own");
  assert.match(sandboxes.sandboxes.get(sbx).files.get(`${BUILD}/CLAUDE.md`), /build\.base\.branch/);

  // Only the developer's own, finished builds that pushed a branch, on the same app and repository.
  assert.match((await call(other, "start_build", { goal: "Continue someone else's work", continue_from: first.id })).data.error, /No build of yours/);
  assert.match((await call(dev, "start_build", { goal: "Continue a running build", continue_from: next.id })).data.error, /still coding/);
  const plain = (await call(dev, "start_build", { goal: "Build without a repository" })).data;
  await call(dev, "stop_build", { build_id: plain.id });
  assert.match((await call(dev, "start_build", { goal: "Continue a build with no branch", continue_from: plain.id })).data.error, /pushed no verified branch/);
  // A branch name alone isn't enough: Mynt must have confirmed the push (a verified commit or its pull request).
  const unpushed = (await call(dev, "start_build", { goal: "Build that never pushed", app_id: app.id, repository: "acme/savings-app" })).data;
  await builds.tick();
  await call(dev, "stop_build", { build_id: unpushed.id });
  assert.ok((await builds.get(unpushed.id)).branch, "it had a branch name");
  assert.match((await call(dev, "start_build", { goal: "Continue a build that never pushed", continue_from: unpushed.id })).data.error, /pushed no verified branch/);
  const app2 = (await call(dev, "create_app", { name: "Other", description: "Other ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  assert.match((await call(dev, "start_build", { goal: "Continue on another app", continue_from: first.id, app_id: app2.id })).data.error, /another app/);
});

test("developers work in their build's sandbox: VS Code, commands, files and the diff, scrubbed and on the timeline", async () => {
  const { builds, sandboxes, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  assert.match((await call(dev, "sandbox_run", { build_id: started.id, command: "ls" })).data.error, /sandbox is provisioning/);
  sandboxes.ready(sbx);
  await builds.tick();

  // VS Code in the browser: a token-gated URL plus a password that never goes on a command line.
  const editor = (await call(dev, "open_sandbox_editor", { build_id: started.id })).data;
  assert.equal(editor.url, `https://${sbx}-8443.preview.example?_token=t`);
  assert.match(editor.password, /^[A-Za-z0-9_-]{24}$/);
  const s = sandboxes.sandboxes.get(sbx);
  assert.match(s.files.get("/home/user/.config/mynt-editor.yaml"), new RegExp(`bind-addr: 127\\.0\\.0\\.1:8443\\nauth: password\\npassword: ${editor.password}`));
  const start = s.commands.find((c) => c.command.includes("code-server --config"));
  assert.match(start.command, /code-server\/releases\/download\/v4\.96\.4\//, "a pinned release");
  assert.ok(!s.commands.some((c) => c.command.includes(editor.password)), "the password is never in a command");

  // Commands run in the app's directory; output is scrubbed of credentials.
  const exec = sandboxes.exec;
  sandboxes.exec = async (id, command, opts) => {
    const r = await exec(id, command, opts);
    return command.includes("npm test") ? { exitCode: 1, stdout: "GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz123456 key mynt_test_0123456789abcdef\n1 failing", stderr: "" } : r;
  };
  const ran = (await call(dev, "sandbox_run", { build_id: started.id, command: "npm test", timeout_seconds: 300 })).data;
  assert.equal(ran.exit_code, 1);
  assert.doesNotMatch(ran.stdout, /ghs_|mynt_test_0123/);
  assert.match(ran.stdout, /GITHUB_TOKEN=\[redacted\] key \[redacted\]\n1 failing/);
  sandboxes.exec = exec;
  const last = s.commands.at(-1);
  assert.ok(last.command.startsWith("cd /home/user/workspace/app 2>/dev/null || cd ~; npm test") && last.timeoutSeconds === 300);

  const files = (await call(dev, "sandbox_files", { build_id: started.id, path: "api/src/server.ts" })).data;
  assert.equal(files.path, "/home/user/workspace/app/api/src/server.ts");
  assert.match(s.commands.at(-1).command, /head -c 64000 '\/home\/user\/workspace\/app\/api\/src\/server\.ts'/);
  assert.equal((await call(dev, "sandbox_diff", { build_id: started.id })).isError, false);

  // Only the build's developer, and it's all on the timeline.
  assert.match((await call(other, "sandbox_run", { build_id: started.id, command: "id" })).data.error, /No build of yours/);
  assert.match((await call(other, "open_sandbox_editor", { build_id: started.id })).data.error, /No build of yours/);
  const timeline = (await call(dev, "get_build", { build_id: started.id })).data.timeline.filter((e) => e.phase === "box");
  assert.deepEqual(timeline.map((e) => e.message), ["The developer opened the editor", "The developer ran a command in the sandbox"]);

  await call(dev, "stop_build", { build_id: started.id });
  assert.match((await call(dev, "sandbox_run", { build_id: started.id, command: "ls" })).data.error, /its sandbox is gone/);
});

test("a finished build's sandbox reopens on its branch for the developer, with the coding workspace, until closed", async () => {
  const ctx = await setup();
  const { sandboxes, as, connect, call } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const { started, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" } });
  assert.equal(build.status, "succeeded");
  assert.match((await call(other, "reopen_sandbox", { build_id: started.id })).data.error, /No build of yours/);

  const first = (await call(dev, "reopen_sandbox", { build_id: started.id, hours: 2 })).data;
  assert.equal(first.ready, false);
  const box = [...sandboxes.sandboxes.values()].find((s) => s.opts.labels.mynt_role === "box");
  assert.equal(box.opts.ttlSeconds, 7200);
  assert.equal(box.opts.env.GITHUB_TOKEN, "ghs_short_lived");
  assert.equal(box.opts.env.GITHUB_REPOSITORY, "acme/savings-app");
  assert.ok(!Object.keys(box.opts.env).some((k) => /ANTHROPIC|MYNT_SANDBOX_KEY|AGENT/.test(k)), "no model or app keys in a developer's box");
  assert.equal(box.opts.env.MYNT_BRANCH, build.branch);
  assert.match((await call(dev, "sandbox_run", { build_id: started.id, command: "ls" })).data.error, /still starting/);

  sandboxes.ready(box.id);
  const second = (await call(dev, "reopen_sandbox", { build_id: started.id })).data;
  assert.equal(second.ready, true);
  const clone = box.commands.find((c) => c.command.includes("git clone"));
  assert.match(clone.command, /git clone --quiet --branch "\$MYNT_BRANCH" "https:\/\/github\.com\/\$GITHUB_REPOSITORY\.git" \/home\/user\/workspace\/app/);
  assert.ok(!clone.command.includes("ghs_"), "the token is never in the command or the remote URL");
  assert.ok(box.files.has("/home/user/workspaces/coding-build/CLAUDE.md") && box.files.has("/home/user/workspaces/coding-build/.claude/agents/architect.md"), "the coding team's workspace is there");

  // The box tools now work on it.
  assert.equal((await call(dev, "sandbox_run", { build_id: started.id, command: "git status" })).isError, false);
  assert.ok(box.commands.at(-1).command.endsWith("git status"));
  const editor = (await call(dev, "open_sandbox_editor", { build_id: started.id })).data;
  assert.match(editor.url, new RegExp(`^https://${box.id}-8443\\.`));

  assert.equal((await call(dev, "close_sandbox", { build_id: started.id })).data.closed, true);
  assert.ok(box.stopped);
  const timeline = (await call(dev, "get_build", { build_id: started.id })).data.timeline.filter((e) => e.phase === "box").map((e) => e.message);
  assert.ok(timeline.includes("The developer reopened the build's sandbox on its branch") && timeline.includes("The developer closed the reopened sandbox"));
});

test("a repository connection waits for an admin's approval, per developer; until then no path gives out a token", async () => {
  const ctx = await setup({ approve: false });
  const { builds, as, connect, call, store } = ctx;
  const aliceUser = await as("Alice", ["developer"]);
  const alice = await connect(aliceUser);
  const bob = await connect(await as("Bob", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));

  const connected = (await call(alice, "connect_repository", { repository: "acme/savings-app" })).data;
  assert.deepEqual([connected.connected, connected.approval], [true, "pending_approval"]);
  assert.match((await call(alice, "start_build", { goal: "Build a savings comparison page", repository: "acme/savings-app" })).data.error, /Waiting for an admin to approve access to acme\/savings-app/);
  assert.equal(await builds.sourceInstallation(aliceUser.id, "acme/savings-app"), null, "hosting can't fetch through it either");

  // The admin sees who asked, their firm, the repository and whose account the App's installation is on.
  const [req] = (await call(admin, "list_repository_requests")).data;
  assert.deepEqual([req.kind, req.repository, req.status, req.requested_by.name, req.installation_account], ["developer", "acme/savings-app", "pending_approval", "Alice", { login: "acme", type: "Organization" }]);
  assert.ok(!(await alice.listTools()).tools.some((t) => t.name === "list_repository_requests"), "admins only");
  assert.equal(req.installation_id, 42);
  const named = (r) => ({ id: r.id, repository: r.repository, installation_id: r.installation_id });
  assert.equal((await call(admin, "approve_repository_connection", { ...named(req), note: "acme is Alice's firm" })).data.status, "approved");
  const { build: shipped, started } = await runBuild(ctx, { dev: alice, startArgs: { goal: "Build a savings comparison page", repository: "acme/savings-app" } });
  assert.equal(shipped.status, "succeeded");
  assert.equal(await builds.sourceInstallation(aliceUser.id, "acme/savings-app"), 42);
  assert.deepEqual((await call(alice, "repository_access_notices")).data.map((n) => [n.repository, n.decision]), [["acme/savings-app", "approved"]]);

  // Bob's connection to the same repository is his own request: Alice's approval doesn't cover it.
  await call(bob, "connect_repository", { repository: "acme/savings-app" });
  assert.match((await call(bob, "start_build", { goal: "Build in the same repository", repository: "acme/savings-app" })).data.error, /Waiting for an admin/);
  const bobs = (await call(admin, "list_repository_requests")).data;
  assert.deepEqual(bobs.map((r) => r.requested_by.name), ["Bob"]);
  await call(admin, "reject_repository_connection", { ...named(bobs[0]), reason: "Bob isn't at acme" });
  assert.match((await call(bob, "start_build", { goal: "Build in the same repository", repository: "acme/savings-app" })).data.error, /An admin rejected access to acme\/savings-app/);
  assert.equal((await call(bob, "repository_access_notices")).data[0].decision, "rejected");

  // A build queued while approved, then rejected: the worker refuses it before the push token.
  const queued = (await call(alice, "start_build", { goal: "Build another page while approved", repository: "acme/savings-app" })).data;
  const all = (await call(admin, "list_repository_requests", { status: "approved" })).data;
  await call(admin, "reject_repository_connection", { ...named(all.find((r) => r.requested_by.name === "Alice")), reason: "ownership in doubt" });
  await builds.tick();
  const failed = await builds.get(queued.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /rejected access to acme\/savings-app/);
  assert.equal(failed.sandbox_id, null, "no sandbox, no token");
  // continue_from, reopen_sandbox and hosting refuse it too.
  assert.match((await call(alice, "start_build", { goal: "Carry on from the shipped build", continue_from: started.id })).data.error, /rejected access/);
  assert.match((await call(alice, "reopen_sandbox", { build_id: started.id })).data.error, /rejected access/);
  assert.equal(await builds.sourceInstallation(aliceUser.id, "acme/savings-app"), null);
  // Reconnecting doesn't undo an admin's rejection (repeatedly, whatever else would approve it); only an admin lifts it.
  for (let i = 0; i < 2; i++) assert.equal((await call(alice, "connect_repository", { repository: "acme/savings-app" })).data.approval, "rejected");
  const rejected = (await call(admin, "list_repository_requests", { status: "rejected" })).data.find((r) => r.requested_by.name === "Alice");
  assert.equal((await call(admin, "approve_repository_connection", { ...named(rejected), note: "cleared up" })).data.status, "approved");
  // Every decision is audited.
  const actions = (await store.db.query("SELECT action FROM financial_products.audit_log WHERE action LIKE '%repository_connection' ORDER BY created_at")).rows.map((r) => r.action);
  assert.deepEqual(actions, ["approve_repository_connection", "reject_repository_connection", "reject_repository_connection", "approve_repository_connection"]);
});

test("an approval applies only to the connection as it was listed; a new installation is a new request", async () => {
  const ctx = await setup({ approve: false });
  const { as, connect, call, repos, pg } = ctx;
  const devUser = await as("Dev", ["developer"]);
  const dev = await connect(devUser);
  const admin = await connect(await as("Ada", ["admin"]));
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const [req] = (await call(admin, "list_repository_requests")).data;
  // A different repository or installation than listed: nothing is approved.
  assert.match((await call(admin, "approve_repository_connection", { id: req.id, repository: "acme/other", installation_id: 42, note: "wrong repo" })).data.error, /may have changed/);
  assert.match((await call(admin, "approve_repository_connection", { id: req.id, repository: req.repository, installation_id: 43, note: "wrong installation" })).data.error, /may have changed/);
  const ok = (await call(admin, "approve_repository_connection", { id: req.id, repository: req.repository, installation_id: 42, note: "acme is theirs" })).data;
  assert.equal(ok.status, "approved", JSON.stringify(ok));
  assert.match((await call(admin, "approve_repository_connection", { id: req.id, repository: req.repository, installation_id: 42, note: "again" })).data.error, /No pending connection/);
  // The App reinstalled (a new installation): the approval doesn't carry over.
  const installed = repos.installationFor;
  repos.installationFor = async (repo) => (repo === "acme/savings-app" ? 99 : installed(repo));
  assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.approval, "pending_approval");
  const row = (await pg.query("SELECT installation_id, approval FROM financial_products.repo_connections WHERE developer_id = $1", [devUser.id])).rows[0];
  assert.deepEqual([Number(row.installation_id), row.approval], [99, "pending_approval"]);
});

test("existing repository connections become pending when the check arrives; Mynt's managed ones stay usable", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const { user } = await store.createUser("Old", ["developer"]);
  // As a deployment from before approvals has them.
  await pg.exec(`CREATE TABLE financial_products.repo_connections (developer_id uuid NOT NULL, repository text NOT NULL, installation_id bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (developer_id, repository))`);
  await pg.exec(`CREATE TABLE financial_products.managed_repository_names (repository text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now())`);
  await pg.query("INSERT INTO financial_products.managed_repository_names (repository) VALUES ('mynt-apps/mynt-app-old')");
  await pg.query("INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id) VALUES ($1, 'someone/else', 42), ($1, 'mynt-apps/mynt-app-old', 77)", [user.id]);
  const builds = await BuildService.open(db, store, fakeSandboxHost(), fakeRepos(), { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com" });
  const rows = (await pg.query("SELECT repository, approval FROM financial_products.repo_connections ORDER BY repository")).rows.map((r) => [r.repository, r.approval]);
  assert.deepEqual(rows, [["mynt-apps/mynt-app-old", "approved"], ["someone/else", "pending_approval"]]);
  await assert.rejects(builds.requireApprovedConnection(user.id, "someone/else"), /Waiting for an admin/);
});

test("Mynt's managed repositories need no approval", async () => {
  const ctx = await setup({ managed: fakeManagedHost(), approve: false });
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const b = (await ctx.call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id })).data;
  assert.equal(b.repository, `mynt-apps/mynt-app-${app.id}`);
  await ctx.builds.tick();
  assert.equal((await ctx.builds.get(b.id)).status, "provisioning");
});

test("builds stay off without a model backend for the proxy", async () => {
  const { as, connect, call } = await setup({ config: { agentBackend: null } });
  const dev = await connect(await as("Dev", ["developer"]));
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please" })).data.error, /aren't enabled/);
});

test("the agent proxy forwards only an active build's calls, with Mynt's key", async () => {
  const { createServer: createHttp } = await import("node:http");
  const { agentProxy } = await import("../dist/agent-proxy.js");
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await ctx.call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await ctx.builds.tick();
  const sbx = (await ctx.builds.get(started.id)).sandbox_id;
  ctx.sandboxes.ready(sbx);
  await ctx.builds.tick();
  const token = JSON.parse(ctx.sandboxes.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers, body: Buffer.from(init.body).toString() });
    return new Response('event: message_stop\ndata: {}\n\n', { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1" } });
  };
  const server = createHttp((req, res) => void agentProxy(ctx.builds.config.agentBackend, (t) => ctx.builds.agentRun(t), req, res, new URL(req.url, "http://x")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/agent`;
  const post = (path, auth, body = '{"model":"claude-opus-5-5"}') =>
    realFetch(`${base}${path}`, { method: "POST", headers: { authorization: auth, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body });
  try {
    const ok = await post("/v1/messages?beta=true", `Bearer ${token}`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /message_stop/);
    assert.equal(ok.headers.get("request-id"), "req_1");
    assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages?beta=true");
    assert.equal(seen[0].headers["x-api-key"], "sk-ant-test");
    assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
    assert.equal(seen[0].headers.authorization, undefined, "the build token never goes upstream");
    assert.equal((await post("/v1/messages", "Bearer mynt_agent_wrong")).status, 401);
    assert.equal((await post("/v1/models", `Bearer ${token}`)).status, 404, "only the messages endpoints");
    await ctx.call(dev, "stop_build", { build_id: started.id });
    assert.equal((await post("/v1/messages", `Bearer ${token}`)).status, 401, "a stopped build's token is dead");
    assert.equal(seen.length, 1);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test("on Vertex AI, the agent's calls carry its token in the path and Mynt signs them for the pinned project", async () => {
  const { createServer: createHttp } = await import("node:http");
  const { agentProxy } = await import("../dist/agent-proxy.js");
  const vertex = { kind: "vertex", projectId: "acme-prod", region: "global", auth: { accessToken: async () => "ya29.mynt" } };
  const ctx = await setup({ config: { agentBackend: vertex } });
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await ctx.call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await ctx.builds.tick();
  const sbx = (await ctx.builds.get(started.id)).sandbox_id;
  ctx.sandboxes.ready(sbx);
  await ctx.builds.tick();
  const { token, env } = JSON.parse(ctx.sandboxes.sandboxes.get(sbx).files.get(`${A}/auth.json`));
  assert.deepEqual(env, {
    CLAUDE_CODE_USE_VERTEX: "1",
    CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    ANTHROPIC_VERTEX_BASE_URL: `https://mynt.example.com/agent/t/${token}/v1`,
    ANTHROPIC_VERTEX_PROJECT_ID: "mynt",
    CLOUD_ML_REGION: "global",
  });

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, headers: init.headers });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const server = createHttp((req, res) => void agentProxy(ctx.builds.config.agentBackend, (t) => ctx.builds.agentRun(t), req, res, new URL(req.url, "http://x")));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path) => realFetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "anthropic-beta": "x-2026" }, body: "{}" });
  const model = "/v1/projects/mynt/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict";
  try {
    assert.equal((await post(`/agent/t/${token}${model}`)).status, 200);
    assert.equal(seen[0].url, "https://aiplatform.googleapis.com/v1/projects/acme-prod/locations/global/publishers/anthropic/models/claude-opus-5-5:streamRawPredict");
    assert.equal(seen[0].headers.authorization, "Bearer ya29.mynt");
    assert.equal(seen[0].headers["anthropic-beta"], "x-2026");
    assert.equal((await post(`/agent/t/${token}/v1/projects/mynt/locations/global/publishers/anthropic/models/count-tokens:rawPredict`)).status, 200);
    assert.equal((await post(`/agent/t/mynt_agent_wrong${model}`)).status, 401);
    assert.equal((await post(`/agent/t/${token}/v1/projects/mynt/locations/global/publishers/google/models/gemini:generateContent`)).status, 404, "Claude models only");
    assert.equal((await post(`/agent/v1/messages`)).status, 404, "no Anthropic API route on a Vertex Mynt");
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    server.close();
  }
});

test("the runner drives Claude Code headless, records its spend, steers and exits cleanly", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { AGENT_RUNNER } = await import("../dist/agent-runner.js");
  const home = mkdtempSync(join(tmpdir(), "mynt-runner-"));
  const dir = join(home, "mynt-agent");
  mkdirSync(join(home, ".mynt-claude", "node_modules", ".bin"), { recursive: true });
  // A stand-in for Claude Code: one stream-json turn per user message, and it logs its args and env.
  const fake = join(home, ".mynt-claude", "node_modules", ".bin", "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
fs.writeFileSync(process.env.HOME + "/claude-args.json", JSON.stringify({ args: process.argv.slice(2), base: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN, key: process.env.ANTHROPIC_API_KEY ?? null }));
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_1" }));
let turns = 0, buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.type !== "user") continue;
    turns++;
    const ev = (event) => console.log(JSON.stringify({ type: "stream_event", event, session_id: "sess_1", parent_tool_use_id: null, uuid: "u", api_message_id: "msg_1" }));
    ev({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 9 } } });
    ev({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "on it" } });
    ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "npm" } });
    ev({ type: "content_block_start", index: 2, content_block: { type: "thinking", thinking: "", signature: "" } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "weighing it" } });
    ev({ type: "content_block_delta", index: 2, delta: { type: "signature_delta", signature: "sig" } });
    ev({ type: "message_stop" });
    console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "on it: " + m.message.content }] } }));
    console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.25 * turns }));
  }
});
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner.mjs"), AGENT_RUNNER);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ prompt: "Build it", cwd: join(home, "work"), model: "claude-opus-5-5", budgetUsd: 4.5, version: "0.0.0" }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "mynt_agent_t", env: { ANTHROPIC_BASE_URL: "https://mynt.example.com/agent", ANTHROPIC_AUTH_TOKEN: "mynt_agent_t" } }));
  const child = spawn(process.execPath, [join(dir, "runner.mjs"), dir], { env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "sk-ant-leak" }, stdio: "ignore" });
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0);
  assert.equal(existsSync(join(dir, "auth.json")), false, "the token file is read once and deleted");
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.deepEqual({ ...state, exit_code: undefined }, { session_id: "sess_1", cost_usd: 0.25, turns: 1, sent: 1, last_subtype: "success", done: true, exit_code: undefined, error: null, summary: null });
  const ran = JSON.parse(readFileSync(join(home, "claude-args.json"), "utf8"));
  assert.deepEqual(ran.args.slice(ran.args.indexOf("--max-budget-usd"), ran.args.indexOf("--max-budget-usd") + 2), ["--max-budget-usd", "4.5"]);
  assert.ok(ran.args.includes("--model") && ran.args.includes("stream-json"));
  assert.equal(ran.base, "https://mynt.example.com/agent");
  assert.equal(ran.token, "mynt_agent_t");
  assert.equal(ran.key, null, "an Anthropic key in the sandbox is never passed to the agent");
  assert.match(readFileSync(join(dir, "agent.jsonl"), "utf8"), /on it: Build it/);
  // The agent's words (and thinking) as it writes them: asked for, and only their text kept, cut down to what Mynt
  // reads (no tool input as it's written, no thinking signature).
  assert.ok(ran.args.includes("--include-partial-messages"));
  // Thinking summaries asked for, so the reasoning shown isn't empty where the API would redact it.
  const settings = ran.args[ran.args.indexOf("--settings") + 1];
  assert.equal(settings, join(dir, "settings.json"));
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { showThinkingSummaries: true });
  const events =readFileSync(join(dir, "agent.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.type === "stream_event");
  assert.deepEqual(events, [
    { type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event: { type: "message_start", message: { id: "msg_1" } } },
    { type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event: { type: "content_block_start", index: 0, content_block: { type: "text" } } },
    { type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "on it" } } },
    { type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event: { type: "content_block_start", index: 2, content_block: { type: "thinking" } } },
    { type: "stream_event", parent_tool_use_id: null, api_message_id: "msg_1", event: { type: "content_block_delta", index: 2, delta: { type: "thinking_delta", thinking: "weighing it" } } },
  ]);
});

test("the runner ends a Claude Code that a background task keeps alive after its last result, keeping that result", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { AGENT_RUNNER } = await import("../dist/agent-runner.js");
  const home = mkdtempSync(join(tmpdir(), "mynt-runner-"));
  const dir = join(home, "mynt-agent");
  mkdirSync(join(home, ".mynt-claude", "node_modules", ".bin"), { recursive: true });
  // A stand-in Claude Code with a "preview server" running in the background: its stdin closing doesn't end it,
  // and it keeps reporting on the background task.
  const fake = join(home, ".mynt-claude", "node_modules", ".bin", "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_bg" }));
process.stdin.on("data", () => console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1.5, result: "pushed" })));
let n = 0;
setInterval(() => { if (++n <= 2) console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1.5 })); }, 100);
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner.mjs"), AGENT_RUNNER);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ prompt: "Build it", cwd: join(home, "work"), budgetUsd: 4, version: "0.0.0" }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "t", env: {} }));
  const started = Date.now();
  const child = spawn(process.execPath, [join(dir, "runner.mjs"), dir], { env: { ...process.env, HOME: home, MYNT_AGENT_SETTLE_MS: "400" }, stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  assert.ok(Date.now() - started < 15_000, "the runner didn't wait forever");
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.done, true);
  assert.equal(state.last_subtype, "success", "its last result stands, so the build moves on to verification");
  assert.equal(state.cost_usd, 1.5);
  assert.equal(state.summary, "pushed");
});

test("the runner never cuts off an agent whose sub-agents are still working after the lead's turn ends", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { AGENT_RUNNER } = await import("../dist/agent-runner.js");
  const home = mkdtempSync(join(tmpdir(), "mynt-runner-"));
  const dir = join(home, "mynt-agent");
  mkdirSync(join(home, ".mynt-claude", "node_modules", ".bin"), { recursive: true });
  // The lead delegates, ends its turn (a result), then its sub-agents stream work for longer than the settle
  // window before the lead's real final result; then it exits on its own.
  const fake = join(home, ".mynt-claude", "node_modules", ".bin", "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_team" }));
process.stdin.once("data", () => {
  console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.5, result: "delegated to the team" }));
  let n = 0;
  const t = setInterval(() => {
    console.log(JSON.stringify({ type: "assistant", parent_tool_use_id: "toolu_team", message: { content: [{ type: "text", text: "sub-agent step " + ++n }] } }));
    if (n === 15) {
      clearInterval(t);
      console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 3, result: "built, checked and pushed" }));
      process.exit(0);
    }
  }, 100);
});
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner.mjs"), AGENT_RUNNER);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ prompt: "Build it", cwd: join(home, "work"), budgetUsd: 4, version: "0.0.0" }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "t", env: {} }));
  // Settle after 400 ms of silence: the sub-agents' 1.5 s of output must keep the agent alive.
  const child = spawn(process.execPath, [join(dir, "runner.mjs"), dir], { env: { ...process.env, HOME: home, MYNT_AGENT_SETTLE_MS: "400" }, stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.summary, "built, checked and pushed", "the agent finished; it wasn't cut off after the lead's first turn");
  assert.equal(state.cost_usd, 3);
  assert.equal(state.exit_code, 0);
  assert.match(readFileSync(join(dir, "agent.jsonl"), "utf8"), /sub-agent step 15/);
});

// A held session runner against a stand-in Claude Code that takes `turnMs` per user message and records every
// message it receives (interrupts too). Returns the runner's process and helpers to drive and read it.
async function sessionRunner({ turnMs = 100, env = {} } = {}) {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { AGENT_RUNNER } = await import("../dist/agent-runner.js");
  const home = mkdtempSync(join(tmpdir(), "mynt-runner-"));
  const dir = join(home, "mynt-agent");
  mkdirSync(join(home, ".mynt-claude", "node_modules", ".bin"), { recursive: true });
  const fake = join(home, ".mynt-claude", "node_modules", ".bin", "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_s" }));
// One turn at a time, as Claude Code does; an interrupt ends the running turn at once with error_during_execution.
let turns = 0, buf = "", queue = [], current = null;
const result = (subtype, text) => {
  turns++;
  console.log(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }));
  console.log(JSON.stringify({ type: "result", subtype, total_cost_usd: 0.1 * turns, result: text }));
};
const next = () => {
  if (current || !queue.length) return;
  const content = queue.shift();
  current = { content, timer: setTimeout(() => { current = null; result("success", "did: " + content); next(); }, ${turnMs}) };
};
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    fs.appendFileSync(process.env.HOME + "/received.jsonl", JSON.stringify(m) + "\\n");
    if (m.type === "control_request" && m.request && m.request.subtype === "interrupt" && current) {
      clearTimeout(current.timer);
      const c = current.content;
      current = null;
      result("error_during_execution", "interrupted: " + c);
      next();
    }
    if (m.type !== "user") continue;
    queue.push(m.message.content);
    next();
  }
});
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(join(dir, "inbox"), { recursive: true });
  writeFileSync(join(dir, "runner.mjs"), AGENT_RUNNER);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ prompt: "First request", cwd: join(home, "work"), budgetUsd: 4, version: "0.0.0", finishPrompt: "Finish the session now" }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "t", env: {} }));
  const child = spawn(process.execPath, [join(dir, "runner.mjs"), dir], { env: { ...process.env, HOME: home, MYNT_AGENT_HOLD: "1", ...env }, stdio: "ignore" });
  let exited = false;
  const exit = new Promise((r) => child.on("exit", (code) => ((exited = true), r(code))));
  const state = () => (existsSync(join(dir, "state.json")) ? JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) : {});
  const until = async (f, ms = 15000) => {
    const end = Date.now() + ms;
    while (!f()) {
      if (Date.now() > end) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  let n = 0;
  // An inbox item (a string is written as it is), under `name` if given; rewrite() replaces its contents.
  const inbox = (item, name) => {
    const path = join(dir, "inbox", name ?? `${Date.now()}-${++n}.json`);
    const write = (v) => writeFileSync(path, typeof v === "string" ? v : JSON.stringify(v));
    write(item);
    return { rewrite: write };
  };
  const received = () => (existsSync(join(home, "received.jsonl")) ? readFileSync(join(home, "received.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { child, exit, isExited: () => exited, state, until, inbox, received };
}

test("a session runner stays open between messages and finishes, without interrupting, when the developer ships", async () => {
  const r = await sessionRunner({ turnMs: 1500 });
  await r.until(() => r.state().turns === 1);
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(r.isExited(), false, "held open after the first request's turn, with nothing to do");
  assert.equal(r.state().finish, null);
  r.inbox({ message: "Second request" });
  await r.until(() => r.received().filter((m) => m.type === "user").length === 2);
  // Shipping while that turn runs: the finish message waits for it, and never interrupts it.
  r.inbox({ finish: true, message: "Finish the session now (shipping)" });
  const code = await r.exit;
  assert.equal(code, 0);
  const got = r.received();
  assert.deepEqual(got.filter((m) => m.type === "user").map((m) => m.message.content), ["First request", "Second request", "Finish the session now (shipping)"]);
  assert.ok(!got.some((m) => m.type === "control_request"), "finishing never interrupts a turn");
  const s = r.state();
  assert.deepEqual([s.finish, s.turns, s.last_subtype, s.done, s.summary], ["developer", 3, "success", true, "did: Finish the session now (shipping)"]);
});

test("a session runner finishes on its own once idle, with the finish prompt as its last message", async () => {
  const r = await sessionRunner({ env: { MYNT_AGENT_IDLE_MS: "800" } });
  await r.until(() => r.state().turns === 1);
  // A message before the idle window ends resets it.
  r.inbox({ message: "One more thing" });
  const code = await r.exit;
  assert.equal(code, 0);
  assert.deepEqual(r.received().filter((m) => m.type === "user").map((m) => m.message.content), ["First request", "One more thing", "Finish the session now"]);
  assert.equal(r.state().finish, "idle");
  assert.equal(r.state().last_subtype, "success");
});

test("once a session is finishing, a steer never interrupts the finish turn: it is held back and counted as undelivered", async () => {
  const r = await sessionRunner({ turnMs: 3000 });
  await r.until(() => r.state().turns === 1);
  // A steer during an ordinary request interrupts it (the stand-in honours interrupts).
  r.inbox({ message: "Second request" });
  await r.until(() => r.received().filter((m) => m.type === "user").length === 2);
  r.inbox({ message: "Change of plan" });
  await r.until(() => r.received().some((m) => m.type === "control_request"));
  await r.until(() => r.state().turns === 3, 20000);
  // Now finish, then steer while the finish turn runs.
  r.inbox({ finish: true, message: "Finish the session now (shipping)" });
  await r.until(() => r.state().finish === "developer");
  r.inbox({ message: "One more tweak" });
  r.inbox({ finish: true, message: "Finish again" });
  const code = await r.exit;
  assert.equal(code, 0);
  const got = r.received();
  assert.deepEqual(got.filter((m) => m.type === "user").map((m) => m.message.content), ["First request", "Second request", "Change of plan", "Finish the session now (shipping)"]);
  assert.equal(got.filter((m) => m.type === "control_request").length, 1, "only the ordinary steer interrupted");
  const s = r.state();
  assert.deepEqual([s.finish, s.undelivered, s.last_subtype, s.summary], ["developer", 1, "success", "did: Finish the session now (shipping)"]);
});

test("a session runner holds an idle setting beyond setTimeout's range to its maximum, rather than finishing at once", async () => {
  const r = await sessionRunner({ env: { MYNT_AGENT_IDLE_MS: "99999999999" } });
  await r.until(() => r.state().turns === 1);
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(r.isExited(), false);
  assert.equal(r.state().finish, null);
  r.inbox({ finish: true, message: "Finish" });
  assert.equal(await r.exit, 0);
});

test("a session runner ignores a non-numeric idle setting, skips dot-files and retries an inbox file it can't parse yet", async () => {
  const r = await sessionRunner({ env: { MYNT_AGENT_IDLE_MS: "soon" } });
  await r.until(() => r.state().turns === 1);
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(r.isExited(), false, "NaN falls back to the 15-minute default rather than finishing at once");
  r.inbox({ message: "Never read: still being written" }, ".partial.json");
  const half = r.inbox('{"message": "Half');
  await new Promise((res) => setTimeout(res, 2500));
  assert.equal(r.received().filter((m) => m.type === "user").length, 1);
  half.rewrite({ message: "Now whole" });
  await r.until(() => r.received().some((m) => m.type === "user" && m.message.content === "Now whole"));
  r.inbox({ finish: true, message: "Finish" });
  assert.equal(await r.exit, 0);
  assert.ok(!r.received().some((m) => m.type === "user" && /Never read/.test(m.message.content)));
});

test("without a sandbox provider key builds are disabled cleanly, and agents never connect outside services", async () => {
  const { as, connect, call } = await setup({ sandboxes: null });
  const dev = await connect(await as("Dev", ["developer"]));
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please" })).data.error, /aren't enabled/);
  assert.match(workspaceFiles("build-audit")["CLAUDE.md"], /Don't connect any external service or sign in anywhere/);
});

test("Mynt's Google service account signs a JWT for a cloud-platform token, and caches it", async () => {
  const { generateKeyPairSync, createVerify } = await import("node:crypto");
  const { GoogleServiceAccount } = await import("../dist/google-auth.js");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = new GoogleServiceAccount({ client_email: "mynt@acme.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), project_id: "acme-prod" });
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body.toString()) });
    return new Response(JSON.stringify({ access_token: "ya29.x", expires_in: 3600 }), { status: 200 });
  };
  try {
    assert.equal(await sa.accessToken(), "ya29.x");
    assert.equal(await sa.accessToken(), "ya29.x");
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(calls.length, 1, "cached until near expiry");
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  const [head, body, sig] = calls[0].body.get("assertion").split(".");
  const claims = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(claims.iss, "mynt@acme.iam.gserviceaccount.com");
  assert.ok(createVerify("RSA-SHA256").update(`${head}.${body}`).verify(publicKey, Buffer.from(sig, "base64url")));
  assert.equal(sa.projectId, "acme-prod");
});

test("boat.dev's file API: a file that isn't there yet reads as null, other errors still throw", async () => {
  const { BoatDevSandboxes } = await import("../dist/sandbox-providers/boatdev.js");
  const sandboxes = new BoatDevSandboxes("boat_test", "https://boat.example/api/v1");
  const realFetch = globalThis.fetch;
  let answer;
  globalThis.fetch = async () => new Response(JSON.stringify(answer.body), { status: answer.status });
  try {
    answer = { status: 500, body: { ok: false, message: "ENOENT: no such file or directory, stat '/home/user/mynt/status.json'" } };
    assert.equal(await sandboxes.readFile("sbx", "/home/user/mynt/status.json"), null);
    answer = { status: 404, body: { ok: false, message: "Not found" } };
    assert.equal(await sandboxes.readFile("sbx", "/home/user/x"), null);
    answer = { status: 200, body: { content: "hi" } };
    assert.equal(await sandboxes.readFile("sbx", "/home/user/x"), "hi");
    answer = { status: 403, body: { ok: false, message: "Path must resolve under /home/user or /tmp" } };
    await assert.rejects(sandboxes.readFile("sbx", "/root/x"), /Path must resolve/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("boat.dev's host forwards to the sandbox's 127.0.0.1, where previews and the editor listen", async () => {
  const { BoatDevSandboxes } = await import("../dist/sandbox-providers/boatdev.js");
  const sandboxes = new BoatDevSandboxes("boat_test", "https://boat.example/api/v1");
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ url: "https://sbx-5173.boat.example?_token=t" }), { status: 200 });
  };
  try {
    assert.equal((await sandboxes.host("sbx", 5173)).url, "https://sbx-5173.boat.example?_token=t");
    assert.deepEqual(sent.body, { port: 5173, public: false, localhost: true });
    assert.match(sent.url, /\/sandboxes\/sbx\/host$/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("dev_preview.sh: any package manager's install record counts, a shell that merely mentions an install doesn't hold it up, a running install does", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync, spawn } = await import("node:child_process");
  const script = new URL("../workspaces/coding-build/scripts/dev_preview.sh", import.meta.url).pathname;
  const root = mkdtempSync(join(tmpdir(), "mynt-preview-"));
  const app = join(root, "app");
  mkdirSync(join(app, "web"), { recursive: true });
  writeFileSync(join(app, "web", "package.json"), JSON.stringify({ name: "web", scripts: {} })); // no dev script: Vite never answers
  const run = () => execFileSync("bash", [script, app], { env: { ...process.env, HOME: root }, encoding: "utf8" }).trim().split("\n").at(-1);
  try {
    assert.equal(run(), "waiting", "nothing installed yet");
    mkdirSync(join(app, "node_modules"));
    writeFileSync(join(app, "node_modules", ".modules.yaml"), "x"); // pnpm's record
    // A shell whose command line merely mentions an install (like a CI step's) doesn't count as one running. Two
    // commands, so bash stays the parent and keeps that command line (with one, it would exec sleep in its place).
    const decoy = spawn("bash", ["-c", "sleep 30; true # then npm ci"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    try {
      assert.ok(execFileSync("pgrep", ["-f", "then npm ci"], { encoding: "utf8" }).trim(), "the decoy's command line is there to match");
      assert.equal(run(), "starting", "installed: it starts the dev server, which here never answers");
    } finally {
      decoy.kill();
    }
    execFileSync("bash", [script, "--stop", app], { env: { ...process.env, HOME: root } });
    // An install that is running (its command line starts with it) holds the preview back.
    const install = spawn("bash", ["-c", 'exec -a "npm install" sleep 30'], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    try {
      assert.equal(run(), "waiting");
    } finally {
      install.kill();
    }
    // A dev server that accepts connections but never answers: the start path is still bounded by the clock.
    writeFileSync(join(app, "web", "silent.js"), 'require("net").createServer(() => {}).listen(5173, "127.0.0.1");');
    writeFileSync(join(app, "web", "package.json"), JSON.stringify({ name: "web", scripts: { dev: "node silent.js" } }));
    const started = Date.now();
    assert.equal(run(), "starting");
    const took = (Date.now() - started) / 1000;
    assert.ok(took < 32, `the start path took ${took.toFixed(1)} s`);
  } finally {
    execFileSync("bash", [script, "--stop", app], { env: { ...process.env, HOME: root } });
  }
});

test("a build that fails stops its sandboxes and kills its proxy token", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await ctx.call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await ctx.builds.tick();
  const sbx = (await ctx.builds.get(started.id)).sandbox_id;
  ctx.sandboxes.ready(sbx);
  await ctx.builds.tick();
  const token = JSON.parse(ctx.sandboxes.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;
  ctx.sandboxes.finishAgent(sbx, "error_max_budget_usd", 9.9);
  await ctx.builds.tick();
  const b = await ctx.builds.get(started.id);
  assert.equal(b.status, "failed");
  assert.match(b.error, /error_max_budget_usd/);
  assert.ok(ctx.sandboxes.sandboxes.get(sbx).stopped, "the coding sandbox is stopped");
  assert.equal(await ctx.builds.agentTokenActive(token), false);
});

test("a provider's passing 5xx doesn't fail a build; a persistent one, or a real error, does", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const start = async () => (await ctx.call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id })).data;
  const real = ctx.sandboxes.getSandbox;
  const failWith = (msg) => { ctx.sandboxes.getSandbox = async () => { throw new Error(msg); }; };
  const heal = () => { ctx.sandboxes.getSandbox = real; };
  const outage = 'Freestyle POST /vms/vm-1/exec-await: 503 {"code":"INTERNAL_ERROR"}';

  // A passing outage: the build rides it out and carries on.
  const a = await start();
  await ctx.builds.tick(); // sandbox requested
  ctx.sandboxes.ready((await ctx.builds.get(a.id)).sandbox_id);
  failWith(outage);
  await ctx.builds.tick();
  await ctx.builds.tick();
  assert.equal((await ctx.builds.get(a.id)).status, "provisioning");
  heal();
  await ctx.builds.tick(); // agent prompted
  assert.notEqual((await ctx.builds.get(a.id)).status, "failed");
  assert.notEqual((await ctx.builds.get(a.id)).status, "provisioning");

  // An outage that outlasts the grace period fails the build, with the provider's error.
  const grace = BuildService.TRANSIENT_GRACE_MS;
  BuildService.TRANSIENT_GRACE_MS = 30;
  const b = await start();
  await ctx.builds.tick();
  ctx.sandboxes.ready((await ctx.builds.get(b.id)).sandbox_id);
  failWith(outage);
  await ctx.builds.tick();
  assert.equal((await ctx.builds.get(b.id)).status, "provisioning");
  await new Promise((r) => setTimeout(r, 50));
  await ctx.builds.tick();
  BuildService.TRANSIENT_GRACE_MS = grace;
  heal();
  assert.equal((await ctx.builds.get(b.id)).status, "failed");
  assert.match((await ctx.builds.get(b.id)).error, /503/);

  // A provider out of allowance fails at once, saying what to do; retrying wouldn't help.
  const q = await start();
  await ctx.builds.tick();
  ctx.sandboxes.ready((await ctx.builds.get(q.id)).sandbox_id);
  failWith('Freestyle POST /vms/vm-1/exec-await: 429 {"code":"LIMIT_EXCEEDED","message":"Cannot start this VM because the allowance for vcpu_time, memory_time has been used."}');
  await ctx.builds.tick();
  heal();
  assert.equal((await ctx.builds.get(q.id)).status, "failed");
  assert.match((await ctx.builds.get(q.id)).error, /^The sandbox provider has used up this account's allowance; an admin must add billing/);

  // A real error fails at once.
  const c = await start();
  await ctx.builds.tick();
  ctx.sandboxes.ready((await ctx.builds.get(c.id)).sandbox_id);
  failWith('Freestyle POST /vms/vm-1/exec-await: 400 {"code":"BAD_REQUEST"}');
  await ctx.builds.tick();
  heal();
  assert.equal((await ctx.builds.get(c.id)).status, "failed");
});

// A stand-in Claude Code that ends its turn while a background task of its own (a long scan) runs silently, then
// writes its report once the task finishes. `taskMs` is how long the scan stays silent.
async function runWithBackgroundTask({ taskMs, env }) {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { AGENT_RUNNER } = await import("../dist/agent-runner.js");
  const home = mkdtempSync(join(tmpdir(), "mynt-runner-"));
  const dir = join(home, "mynt-agent");
  mkdirSync(join(home, ".mynt-claude", "node_modules", ".bin"), { recursive: true });
  const fake = join(home, ".mynt-claude", "node_modules", ".bin", "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: "sess_scan" }));
process.stdin.once("data", () => {
  console.log(JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "scan" }] }));
  console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 1, result: "scans running; I'll write the report when they finish" }));
  setTimeout(() => {
    console.log(JSON.stringify({ type: "system", subtype: "background_tasks_changed", tasks: [] }));
    console.log(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 2, result: "report written" }));
    process.exit(0);
  }, ${taskMs});
});
`,
  );
  chmodSync(fake, 0o755);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "runner.mjs"), AGENT_RUNNER);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ prompt: "Audit it", cwd: join(home, "work"), budgetUsd: 4, version: "0.0.0" }));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ token: "t", env: {} }));
  const child = spawn(process.execPath, [join(dir, "runner.mjs"), dir], { env: { ...process.env, HOME: home, ...env }, stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  return JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
}

test("the runner waits out a silent background task the agent is waiting on, up to a ceiling", async () => {
  // The scan is silent for 1.5 s against a 0.4 s settle window: the agent finishes and writes its report.
  const waited = await runWithBackgroundTask({ taskMs: 1500, env: { MYNT_AGENT_SETTLE_MS: "400" } });
  assert.equal(waited.summary, "report written", "the agent wasn't cut off while its scan ran");
  assert.equal(waited.exit_code, 0);
  assert.equal(waited.cost_usd, 2);

  // A background task that outlasts the ceiling is ended; the last result stands.
  const capped = await runWithBackgroundTask({ taskMs: 60000, env: { MYNT_AGENT_SETTLE_MS: "300", MYNT_AGENT_BACKGROUND_MAX_MS: "1000" } });
  assert.notEqual(capped.exit_code, 0);
  assert.match(capped.summary, /scans running/);
});

test("Mynt's audit has its own token, budget and model, isn't charged to the developer, and times out", async () => {
  const ctx = await setup();
  const { builds, sandboxes, call, pg } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const coderToken = JSON.parse(sandboxes.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;
  sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
  sandboxes.finishAgent(sbx);
  await builds.tick();
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  sandboxes.ready(vid);
  await builds.tick();
  sandboxes.sandboxes.get(vid).checksRunning = false;
  sandboxes.write(vid, `${V}/before.sha`, "tree\n");
  sandboxes.write(vid, `${V}/report.json`, { checks: passingChecks });
  await builds.tick(); // auditor started

  // Its own token: its own meter key, Mynt's budget, the audit model; the coding agent's token is retired.
  const auditToken = JSON.parse(sandboxes.sandboxes.get(vid).files.get(`${A}/auth.json`)).token;
  assert.deepEqual(await builds.agentRun(auditToken), { key: `audit:${started.id}`, capUsd: 5, model: "claude-sonnet-5-5" });
  assert.equal(await builds.agentRun(coderToken), null);

  // What the audit spends on the model isn't the developer's: its runner reports US$4 so far.
  sandboxes.write(vid, `${A}/state.json`, { cost_usd: 4, turns: 1, sent: 1, last_subtype: "success", done: false });
  const before = (await builds.get(started.id)).cost_usd;
  await builds.tick();
  assert.equal((await builds.get(started.id)).cost_usd, before);

  // Nor are the sandboxes' machine hours while it runs: far past the build's cap here, and the build carries on.
  sandboxes.sandboxes.get(vid).cost = 40;
  await builds.tick();
  let b = await builds.get(started.id);
  assert.equal(b.status, "verifying", b.error ?? "");
  assert.equal(b.cost_usd, before, "the cap counts machine time only up to the audit's start");
  assert.equal(b.audit_cost_usd, 44, "the audit's own record: US$4 of model, US$40 of machine time");

  // Still running past its time limit, with a partial report: Mynt ends it, says so plainly, doesn't try again
  // (the time is spent), and the build doesn't ship.
  sandboxes.write(vid, `${V}/maxwell.json`, { ...cleanAudit, complete: false, workflows_run: ["execute-scr"], skipped: [{ workflow: "probe-cicd-env", reason: "not run yet" }] });
  await pg.query("UPDATE financial_products.build_runs SET audit_state = jsonb_set(audit_state, '{started_at}', to_jsonb((now() - interval '25 minutes')::text)) WHERE id = $1", [started.id]);
  await builds.tick();
  b = await builds.get(started.id);
  assert.equal(b.status, "blocked");
  assert.equal(b.error, "Mynt's audit didn't finish: the auditor ran out of time (20 min); its report so far covers execute-scr; a build can't ship without a complete audit");
  assert.match(b.next_step, /BUILD_AUDIT_MINUTES/);
  assert.ok(sandboxes.sandboxes.get(vid).commands.some((c) => c.command.includes("[r]unner.mjs")), "the auditor is ended before the source is re-hashed");
  assert.equal(sandboxes.sandboxes.get(vid).commands.filter((c) => c.command.includes("runner.mjs ")).length, 1, "no second attempt");
  const got = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(got.next_step, b.next_step, "get_build says what to do");
  assert.equal(await builds.agentRun(auditToken), null, "the audit token dies with the build");
});

test("an auditor that ends without its report gets one more attempt, with what's left of the audit's budget", async () => {
  const ctx = await setup();
  const { builds, sandboxes, call } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  // The first attempt ends its turn (a clean "success") without writing a report: the run is retried once.
  const { started, vid, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, verification: { maxwell: null } });
  assert.equal(build.status, "verifying");
  assert.match(build.phase_message, /^Mynt's audit ended without a complete report \(the auditor ended its turn without writing its report\); running it once more \(attempt 2 of 2, up to 20 min\)$/);
  const job = JSON.parse(sandboxes.sandboxes.get(vid).files.get(`${AUDIT}/job/audit.json`));
  assert.deepEqual([job.attempt, job.attempts], [2, 2]);
  assert.equal(sandboxes.agentConfig(vid).budgetUsd, 5, "nothing metered yet, so the whole budget is left");
  assert.equal((await builds.get(started.id)).audit_state.attempt, 2);

  // The second ends the same way: blocked, plainly, with what to do.
  sandboxes.finishAgent(vid, "success");
  await builds.tick();
  const b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "blocked");
  assert.equal(b.error, "Mynt's audit didn't finish: the auditor ended its turn without writing its report, on both attempts; a build can't ship without a complete audit");
  assert.match(b.next_step, /continue_from/);

  // A second attempt that writes its complete report ships.
  const ctx2 = await setup();
  const dev2 = await ctx2.connect(await ctx2.as("Dev", ["developer"]));
  const r = await runBuild(ctx2, { dev: dev2, startArgs: { goal: "Build a savings page please" }, verification: { maxwell: null, auditStatus: "error_during_execution" } });
  assert.equal(r.build.status, "verifying");
  assert.match(r.build.phase_message, /stopped without writing its report \(error_during_execution, exit 0\)/);
  ctx2.sandboxes.write(r.vid, `${V}/maxwell.json`, cleanAudit);
  ctx2.sandboxes.finishAgent(r.vid, "success");
  await ctx2.builds.tick();
  assert.equal((await ctx2.builds.get(r.started.id)).status, "succeeded");
});

test("a report that isn't complete never counts as a pass", async () => {
  for (const [maxwell, pattern] of [
    [{ counts: { critical: 0, high: 0 }, summary: "clean" }, /^Mynt's audit is incomplete: execute-scr, probe-cicd-env not run, on both attempts; a build can't ship/],
    [{ ...cleanAudit, complete: false }, /^Mynt's audit is incomplete: not marked complete, on both attempts;/],
    [
      { ...cleanAudit, workflows_run: ["execute-scr"], skipped: [{ workflow: "probe-cicd-env", reason: "asks for a CI login" }] },
      /^Mynt's audit is incomplete: probe-cicd-env not run; skipped: probe-cicd-env: asks for a CI login, on both attempts;/,
    ],
  ]) {
    const ctx = await setup();
    const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
    const r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, verification: { maxwell } });
    assert.equal(r.build.status, "verifying", "tried once more");
    ctx.sandboxes.write(r.vid, `${V}/maxwell.json`, maxwell);
    ctx.sandboxes.finishAgent(r.vid, "success");
    await ctx.builds.tick();
    const b = await ctx.builds.get(r.started.id);
    assert.equal(b.status, "blocked");
    assert.match(b.error, pattern);
    assert.match(b.next_step, /BUILD_AUDIT_WORKFLOWS/);
  }
});

test("an audit that can't finish for a reason of Mynt's isn't run twice, and the build says what an admin must do", async () => {
  const stopped = (workflow, kind, reason) => ({ workflow, kind, reason });
  const partial = { ...cleanAudit, complete: false, workflows_run: [], written_by: "scripts/audit.mjs" };
  for (const [maxwell, error, next] of [
    // The build of 2026-11-28: the workflow was still going at the limit, the next one never started. It ran twice then.
    [
      { ...partial, skipped: [stopped("execute-scr", "time", "stopped at the 20-minute limit after running 14 min (9 agent run(s) so far)"), stopped("probe-cicd-env", "time", "not started: 0 min of the 20-minute limit was left")] },
      "Mynt's audit didn't finish: the auditor ran out of time (20 min); its report so far covers no workflow; a build can't ship without a complete audit",
      /a Mynt admin must raise BUILD_AUDIT_MINUTES or run fewer workflows \(BUILD_AUDIT_WORKFLOWS\)/,
    ],
    // Out of time with findings already in the ledger: they are said, and kept on the build.
    [
      { ...partial, workflows_run: ["probe-cicd-env"], counts: { critical: 0, high: 1, medium: 0, low: 0 }, findings: [{ severity: "high", title: "Unpinned base image", file: "web/Dockerfile", workflow: "execute-scr" }], skipped: [stopped("execute-scr", "time", "stopped at the 20-minute limit")] },
      "Mynt's audit didn't finish: the auditor ran out of time (20 min); its report so far covers probe-cicd-env, with 1 critical/high finding(s) so far; a build can't ship without a complete audit",
      /BUILD_AUDIT_MINUTES/,
    ],
    [
      { ...partial, workflows_run: ["probe-cicd-env"], skipped: [stopped("execute-scr", "budget", "stopped at its US$4.25 share of the audit's budget")] },
      "Mynt's audit didn't finish: the auditor used up its US$5 budget (Mynt's, not this build's cap); its report so far covers probe-cicd-env; a build can't ship without a complete audit",
      /a Mynt admin must raise BUILD_AUDIT_CAP_USD or run fewer workflows/,
    ],
    // The tool itself is broken at the commit fetched: nothing ran, and no second attempt could do better.
    [
      { ...partial, tool_problem: "Maxwell's own checks (npm run validate) fail at commit 1f843c2: validate FAILED: validate:layout, validate:workflows. Pin a commit that passes them with BUILD_MAXWELL_COMMIT", skipped: [stopped("execute-scr", "tool", "not started"), stopped("probe-cicd-env", "tool", "not started")] },
      "Mynt's audit couldn't run: Maxwell couldn't be used (Maxwell's own checks (npm run validate) fail at commit 1f843c2: validate FAILED: validate:layout, validate:workflows. Pin a commit that passes them with BUILD_MAXWELL_COMMIT); a build can't ship without a complete audit",
      /verifying again won't help until it's fixed: a Mynt admin must put right what the message names. Most often that is BUILD_MAXWELL_COMMIT/,
    ],
  ]) {
    const ctx = await setup();
    const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
    const r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, verification: { maxwell } });
    assert.equal(r.build.status, "blocked", "blocked at once");
    assert.equal(r.build.error, error);
    assert.match(r.build.next_step, next);
    assert.match(r.build.next_step, /Nothing in your code needs changing/);
    const verifier = ctx.sandboxes.sandboxes.get(r.vid);
    assert.equal(verifier.commands.filter((c) => c.command.includes("runner.mjs ")).length, 1, "no second attempt");
    assert.deepEqual((await ctx.builds.get(r.started.id)).maxwell.counts, maxwell.counts, "what it found so far is kept on the build");
    // Whatever the auditor's script left running in the background is ended before its report is read.
    assert.ok(verifier.commands.some((c) => c.command === AUDITOR_KILL));
  }
  assert.match(AUDITOR_KILL, /scripts\/\[a\]udit\.mjs/);
  assert.match(AUDITOR_KILL, /\[r\]un-headless\.mjs/);
});

test("a model that refuses the security review is said plainly, with the request id, and never tried again", async () => {
  const said = "API Error: Opus 4.8 can't help with this. Start a new session to continue. Learn more: https://example.test/legal/aup Details: `[cyber]` Request ID: req_vrtx_011AbC";
  assert.deepEqual(modelRefusal(said), { category: "cyber", request_id: "req_vrtx_011AbC" });
  assert.equal(modelRefusal("Audit finished; no API errors."), null);
  const base = { workflows: ["execute-scr", "probe-cicd-env"], timedOut: false, outOfBudget: false, minutes: 20, capUsd: 5, spentUsd: 0.2, attempt: 1 };
  // The auditor's own session was refused: Claude Code ends "success" with the refusal as its last message, no report.
  let p = auditOutcome({ ...base, report: null, runner: { last_subtype: "success", exit_code: 0, error: null, summary: said } });
  assert.deepEqual([p.kind, p.retry], ["refused", false]);
  assert.equal(p.reason, "Mynt's audit didn't finish: the audit's model refused the security review in the auditor's own session [cyber] (request id req_vrtx_011AbC); a build can't ship without a complete audit");
  assert.match(p.next_step, /will be refused again.*provider's approval for security work.*BUILD_AUDIT_MODEL.*BUILD_AUDIT_WORKFLOWS/);
  // Maxwell's run was refused: the audit's script found it in that run's records and says where.
  const report = {
    complete: false,
    counts: { critical: 0, high: 0, medium: 0, low: 0 },
    workflows_run: ["probe-cicd-env"],
    skipped: [{ workflow: "execute-scr", kind: "refused", reason: "the audit's model refused the security review: 3 refused request(s) [cyber], request id req_vrtx_9 (Maxwell's run didn't complete: 3 agents failed)" }],
    model_refusal: { workflows: ["execute-scr"], count: 3, category: "cyber", request_ids: ["req_vrtx_9", "not an id; rm -rf"] },
  };
  p = auditOutcome({ ...base, report, runner: { last_subtype: "success", exit_code: 0, error: null, summary: "FINISHED" } });
  assert.deepEqual([p.kind, p.retry], ["refused", false]);
  assert.equal(p.reason, "Mynt's audit didn't finish: the audit's model refused the security review in execute-scr [cyber] (request id req_vrtx_9); its report so far covers probe-cicd-env; a build can't ship without a complete audit");

  // In a build: blocked at once, one attempt, the kind kept on the timeline for whoever reads it.
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, verification: { maxwell: { ...report, findings: [], summary: "" } } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /the audit's model refused the security review in execute-scr \[cyber\] \(request id req_vrtx_9\)/);
  assert.match(r.build.next_step, /Nothing in your code needs changing/);
  assert.equal(ctx.sandboxes.sandboxes.get(r.vid).commands.filter((c) => c.command.includes("runner.mjs ")).length, 1, "no second attempt");
  assert.equal(r.build.timeline.at(-1).data.audit_problem, "refused");
});

test("a second attempt runs only when it could do better than the first", () => {
  const base = { workflows: ["probe-cicd-env"], timedOut: false, outOfBudget: false, minutes: 20, capUsd: 5, spentUsd: 0.4, attempt: 1, runner: { last_subtype: "success", exit_code: 0, error: null } };
  const stuck = { complete: false, counts: { critical: 0, high: 0 }, workflows_run: [], skipped: [{ workflow: "probe-cicd-env", kind: "stalled", reason: "stopped as stuck: Maxwell's Claude Code run made no model call in the 121 s after it was launched" }] };
  // A run that got stuck early, with most of the budget left: once more.
  let p = auditOutcome({ ...base, report: stuck });
  assert.deepEqual([p.kind, p.retry], ["stalled", true]);
  assert.match(p.reason, /^Mynt's audit is incomplete: probe-cicd-env not run; skipped: probe-cicd-env: stopped as stuck/);
  assert.match(p.next_step, /stopped making progress in Mynt's verification sandbox/);
  // The same end after most of the budget went on it: a second run would have less than the first and end the same way.
  assert.equal(auditOutcome({ ...base, report: stuck, spentUsd: 3 }).retry, false);
  assert.equal(auditOutcome({ ...base, report: null, spentUsd: 3 }).retry, false, "no report either");
  assert.equal(auditOutcome({ ...base, report: null, spentUsd: 2.5 }).retry, true, "as much left as was spent");
  assert.equal(auditOutcome({ ...base, report: stuck, attempt: 2 }).retry, false, "never a third");
  // Time, budget and a broken tool are never worth a second attempt, whatever is left.
  for (const kind of ["time", "budget", "tool"]) {
    p = auditOutcome({ ...base, report: { ...stuck, skipped: [{ workflow: "probe-cicd-env", kind, reason: "…" }] } });
    assert.deepEqual([p.kind, p.retry], [kind, false]);
  }
  // A workflow whose run failed, or that was still going when the auditor ended its turn: once more.
  for (const kind of ["failed", "pending"]) assert.deepEqual(((x) => [x.kind, x.retry])(auditOutcome({ ...base, report: { ...stuck, skipped: [{ workflow: "probe-cicd-env", kind, reason: "…" }] } })), ["incomplete", true]);
  // Complete is complete.
  assert.equal(auditOutcome({ ...base, report: { complete: true, counts: { critical: 0, high: 0 }, workflows_run: ["probe-cicd-env"], skipped: [] } }), null);
});

test("an audit that changed the source isn't tried again", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  ctx.sandboxes.tamperDuringAudit = true;
  const r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, verification: { maxwell: null } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /^The source changed during the audit: \.\/api\/index\.ts; the result can't be trusted$/);
  assert.match(r.build.next_step, /read-only copy/);
});

test("by default a build ships on Mynt's own checks, with no agent audit; a failing static scan stops it", async () => {
  for (const [checks, status] of [
    [passingChecks.concat({ name: "static_scan", status: "pass" }), "succeeded"],
    [passingChecks.concat({ name: "static_scan", status: "fail", detail: "high-severity: node_eval in api/server.js" }), "failed"],
  ]) {
    const ctx = await setup({ config: { audit: buildConfigFromEnv({}).audit } });
    assert.equal(ctx.builds.config.audit.mode, "none");
    const { builds, sandboxes, call } = ctx;
    const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
    const app = (await call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
    assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.connected, true);
    const started = (await call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id, repository: "acme/savings-app" })).data;
    await builds.tick();
    const sbx = (await builds.get(started.id)).sandbox_id;
    sandboxes.ready(sbx);
    await builds.tick();
    sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
    sandboxes.finishAgent(sbx);
    await builds.tick();
    const vid = (await builds.get(started.id)).verify_sandbox_id;
    sandboxes.ready(vid);
    await builds.tick();
    sandboxes.sandboxes.get(vid).checksRunning = false;
    sandboxes.write(vid, `${V}/report.json`, { checks });
    await builds.tick(); // decided on the checks alone
    const b = await builds.get(started.id);
    assert.equal(b.status, status, b.error ?? "");
    assert.ok(!sandboxes.sandboxes.get(vid).files.has(`${A}/auth.json`), "no auditor was started");
    if (status === "failed") assert.match(b.error, /Not production-ready: static_scan/);
  }
});

test("redact scrubs every token Mynt mints, provider keys, URL passwords and secret-named values", () => {
  const b64 = "Zm9vYmFyYmF6cXV4LXF1dXhfY29yZ2U-"; // base64url, ending in a dash
  for (const kind of ["live", "test", "agent", "bd", "explore", "desk", "review", "paudit", "predteam"]) {
    assert.equal(redact(`token mynt_${kind}_${b64} end`), "token [redacted] end", kind);
  }
  assert.equal(redact(`ANTHROPIC_BASE_URL=https://mynt.example/agent/t/mynt_agent_${b64}/v1`), "ANTHROPIC_BASE_URL=https://mynt.example/agent/t/[redacted]/v1");

  // NAME=value, where the name says it's secret.
  assert.equal(redact("STRIPE_SECRET_KEY=sk_live_51Habcdefghijklmnop"), "STRIPE_SECRET_KEY=[redacted]");
  assert.equal(redact("STRIPE_SECRET_KEY=whatever123"), "STRIPE_SECRET_KEY=[redacted]");
  assert.equal(redact("OPENAI_API_KEY=abcdef123456 next"), "OPENAI_API_KEY=[redacted] next");
  assert.equal(redact("SIGNING_PRIVATE_KEY=abcdef123456"), "SIGNING_PRIVATE_KEY=[redacted]");
  assert.equal(redact("SENDGRID_KEY=abcdef123456"), "SENDGRID_KEY=[redacted]");
  assert.equal(redact("DB_PASS='hunter2hunter2'"), "DB_PASS='[redacted]'");
  assert.equal(redact("db_pass=hunter2hunter2"), "db_pass=[redacted]");
  // Quoted values go whole, spaces and all, whatever their length.
  assert.equal(redact("DB_PASSWORD='correct horse battery staple' next"), "DB_PASSWORD='[redacted]' next");
  assert.equal(redact(`DB_PASSWORD="a b c"`), `DB_PASSWORD="[redacted]"`);
  assert.equal(redact(`SENDGRID_KEY="abc def"`), `SENDGRID_KEY="[redacted]"`);
  assert.equal(redact(`db:\n  password: "a b c"\n  user: demo`), `db:\n  password: "[redacted]"\n  user: demo`);
  assert.equal(redact("PASSWORD=hunter2hunter2\r\nnext"), "PASSWORD=[redacted]\r\nnext");
  assert.equal(redact("env:GITHUB_TOKEN=abcdef123456"), "env:GITHUB_TOKEN=[redacted]", "an assignment inside another value");
  // Authorization headers and bare JWTs.
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.equal(redact("Authorization: Bearer abc123def456"), "Authorization: Bearer [redacted]");
  assert.equal(redact(`curl -H "Authorization: Basic dXNlcjpwYXNz" https://x`), `curl -H "Authorization: Basic [redacted]" https://x`);
  assert.equal(redact(`{"authorization": "Bearer abc123def456"}`), `{"authorization": "Bearer [redacted]"}`);
  assert.equal(redact(`authorization: Bearer ${jwt}`), "authorization: Bearer [redacted]");
  assert.equal(redact(`session ${jwt} ok`), "session [redacted] ok");
  // Long quoted values go whole: a service account's private key in JSON, long passwords and API keys.
  const pemBody = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(60);
  const account = `{"type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\n${pemBody}\\n-----END PRIVATE KEY-----\\n", "client_email": "x@y"}`;
  assert.ok(account.length > 2000);
  assert.equal(redact(account), `{"type": "service_account", "private_key": "[redacted]", "client_email": "x@y"}`);
  assert.equal(redact(`{"password": "${"p".repeat(600)}"}`), `{"password": "[redacted]"}`);
  assert.equal(redact(`api_key: '${"k".repeat(600)}' done`), "api_key: '[redacted]' done");
  assert.equal(redact(`PASSWORD="${"x ".repeat(300)}`), `PASSWORD="[redacted]`, "an unclosed quote goes to the end of the line");
  assert.equal(redact(`PASSWORD="abc def\r\nnext`), `PASSWORD="[redacted]\r\nnext`, "and keeps the line's \\r\\n");
  assert.equal(redact(`API_KEY=abc"defghijkl" next`), "API_KEY=[redacted] next", "a quote inside an unquoted value");
  assert.equal(redact("PASS=12345678"), "PASS=[redacted]", "digits are a password unless the name is a lower-case pass:");
  assert.equal(redact("Authorization: Bearer null-abc123def456"), "Authorization: Bearer [redacted]");
  assert.equal(redact("authorization: required-token-abc123"), "authorization: [redacted]");
  // Secret, API, access, auth and private keys are redacted even when they look like paths.
  assert.equal(redact("SECRET_KEY=/abcdefghij"), "SECRET_KEY=[redacted]");
  assert.equal(redact("API_KEY=./abcdefghij"), "API_KEY=[redacted]");
  assert.equal(redact("SSH_PRIVATE_KEY=~/.ssh/id_ed25519"), "SSH_PRIVATE_KEY=[redacted]");
  assert.equal(redact("SIGNING_KEY=/AbCdEfGh/IjKl+MnOp=="), "SIGNING_KEY=[redacted]", "base64, not a path");
  assert.equal(redact("PASS=hunter2hunter2"), "PASS=[redacted]");
  assert.equal(redact("DB_PASSWORD=hunter2hunter2"), "DB_PASSWORD=[redacted]");
  assert.equal(redact("aws_secret_access_key = wJalrXUtnFEMIK7MDENG"), "aws_secret_access_key = [redacted]");

  // Provider key shapes, wherever they appear.
  for (const key of [
    "sk_live_51Habcdefghijklmnop", "sk_test_51Habcdefghijklmnop", "rk_live_51Habcdefghijklmnop",
    "ghp_abcdefghijklmnopqrstuvwxyz0123", "gho_abcdefghijklmnopqrstuvwxyz0123", "ghu_abcdefghijklmnopqrstuvwxyz0123",
    "ghr_abcdefghijklmnopqrstuvwxyz0123", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "xoxb-123456789012-abcdefghijkl", "xoxp-123456789012-abcdefghijkl", "AKIAIOSFODNN7EXAMPLE",
    "sk-ant-api03-abcdefghijkl", "whsec_abcdefghijkl",
    // Stripe keys with _ in the body, OpenAI, npm, Google and Slack app tokens (assembled so no scanner takes them for real).
    "sk_live_" + "51H_abc_defghijklmnop", "sk-" + "proj-abcdefghij_klmnopqrst-uvwxyz012345", "sk-" + "a".repeat(20) + "0123456789AB",
    "npm_" + "aB3".repeat(12), "AIza" + "Sy" + "b".repeat(33), "xapp-" + "1-A0123456789-0123456789-abcdef",
  ]) assert.equal(redact(`using ${key} now`), "using [redacted] now", key);
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcd==\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(`key:\n${pem}\ndone`), "key:\n[redacted]\ndone");
  assert.equal(redact("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg"), "[redacted]", "a key cut off mid-way");
  assert.equal(redact("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r\n-----END OPENSSH PRIVATE KEY-----"), "[redacted]");
  assert.equal(redact("x\n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGRk\n=abcd\n-----END PGP PRIVATE KEY BLOCK-----\ny"), "x\n[redacted]\ny");

  // Passwords in URLs keep the user (even an empty one) and host.
  assert.equal(redact("DATABASE_URL=postgres://mynt:s3cr3tpw@db.internal:5432/mynt"), "DATABASE_URL=postgres://mynt:[redacted]@db.internal:5432/mynt");
  assert.equal(redact("git clone https://x-access-token:abc123@github.com/o/r"), "git clone https://x-access-token:[redacted]@github.com/o/r");
  assert.equal(redact("REDIS_URL=redis://:s3cr3tpw@cache:6379"), "REDIS_URL=redis://:[redacted]@cache:6379");

  // JSON and YAML.
  assert.equal(redact(`{"api_key": "abcdef123456", "name": "demo"}`), `{"api_key": "[redacted]", "name": "demo"}`);
  assert.equal(redact(`{"password":"hunter2hunter2"}`), `{"password":"[redacted]"}`);
  assert.equal(redact(`{'clientSecret': 'abcdef123456'}`), `{'clientSecret': '[redacted]'}`);
  assert.equal(redact(`{"accessToken": "abc\\"def123"}`), `{"accessToken": "[redacted]"}`);
  assert.equal(redact("auth:\n  token: abcdef123456\n  user: demo"), "auth:\n  token: [redacted]\n  user: demo");
});

test("redact leaves ordinary text alone", () => {
  for (const text of [
    "Enter your password to continue",
    "The token is valid and the secret is safe",
    "password:\nEnter something here",
    `{"password": ""}`,
    "password: ",
    `{"bypass": "everything ok", "primary": "abcdef123456"}`,
    "SOLANA_PUBLIC_KEY=7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    "SSH_KEY=~/.ssh/id_ed25519",
    "SIGNING_KEY=/run/secrets/signing.pem",
    "pass: 1234567 fail: 0",
    "authorization: required",
    "GOOGLE_APPLICATION_CREDENTIALS=./service-account.json",
    `if (pem.startsWith("-----BEGIN PRIVATE KEY-----")) return pem;\nconst rest = 1;`,
    "Authorization: Bearer $TOKEN",
    "sk-loading-spinner-component",
    "PASSWORD=short",
    "API_KEY=",
    "BYPASS_MODE=enabled",
    "COMPASS=northward",
    "PWD=/home/user/workspace/app",
    "mynt_gave_up and mynt_conformance_unknown_ab12cd34",
    "https://example.com:8443/path@v2",
    "see https://user@example.com/docs",
    "sk_live_ abc ghp_short AKIA123",
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----",
    "ready on 8080",
  ]) assert.equal(redact(text), text, text);
});

// redact() runs synchronously on uncapped sandbox output: a pattern that backtracks quadratically stalls Mynt for
// everyone. Each input is 100 KB, built to make a careless pattern retry a long run from every position inside it.
test("redact stays linear on adversarial output", () => {
  const N = 100_000;
  const rep = (s) => s.repeat(Math.ceil(N / s.length)).slice(0, N);
  const inputs = [
    "a+", "a-", "a.", "some-kebab-case-words-here ", "a://a:", "a://", ":", "a:", "key:", "token=", 'token="', "password: 'x ",
    '"password":"\\', "A_", "A_ ", "AAAA_KEY", "db_pass", "x".repeat(47) + " ", "eyJ-", "eyJabcde.eyJabcde.", "-ghp_",
    "-sk_live_", "sk-", "xoxb-", "-mynt_agent_", "Authorization: Bearer ", "-----BEGIN PRIVATE KEY-----",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n", "-----BEGIN A ",
  ].map(rep);
  inputs.push(`x://u:${"p".repeat(N)}`, '"'.repeat(N / 2) + "a".repeat(N / 2), "-----BEGIN " + rep("A "));
  // Values skipped or already redacted, with names hiding inside them.
  inputs.push("PRIVATE_KEY=" + rep("/A_KEY="), "private_key=" + rep("/private_key="), rep("token=[redacted]"), "token=" + rep("[redacted]token="));
  inputs.push(rep("SSH_KEY=/a.b "), rep('password="'), rep("password: 'x\n"));
  inputs.push(rep('API_KEY=ab"'), rep('API_KEY=ab" '), rep('password="x\r\n'));
  for (const text of inputs) redact(text.slice(0, 10_000)); // warm up the regex engine and JIT on a tenth of each
  // CPU time, not wall time, so a busy machine doesn't fail the test.
  const cpuMs = (start) => {
    const d = process.cpuUsage(start);
    return (d.user + d.system) / 1000;
  };
  const slowest = [];
  const started = process.cpuUsage();
  for (const text of inputs) {
    const t = process.cpuUsage();
    redact(text);
    slowest.push([cpuMs(t), JSON.stringify(text.slice(0, 24))]);
  }
  const total = cpuMs(started);
  slowest.sort((a, b) => b[0] - a[0]);
  // Linear patterns take a few ms per input (about 100-250 ms of CPU for all of them on a busy 4-core machine); the
  // quadratic ones this replaced took 3 to 60 seconds on a single input. The bounds leave room for slow CI runners.
  assert.ok(slowest[0][0] < 150, `redact took ${slowest[0][0].toFixed(0)} ms of CPU on ${slowest[0][1]}`);
  assert.ok(total < 1000, `redact took ${total.toFixed(0)} ms of CPU over ${inputs.length} inputs; slowest: ${slowest.slice(0, 3).map(([ms, s]) => `${s} ${ms.toFixed(0)} ms`).join(", ")}`);
});

test("push access lost while a build ran: Mynt checks again before opening the pull request, opens none, and keeps the work on its branch", async () => {
  const ctx = await setup();
  const { builds, sandboxes, repos, as, connect, call, pg } = ctx;
  // The developer's own push permission, as GitHub answers it (repo-ownership.ts), and their linked account.
  let perm = "write";
  Object.assign(repos, {
    async repositoryInfo(repo) {
      return { id: "555", full_name: repo };
    },
    async loginOf() {
      return "octo";
    },
    async permissionOf() {
      return perm;
    },
  });
  builds.identity = { forUser: async () => ({ git: { provider: "github", username: "octo", user_id: "42", verified: true }, wallets: [], manage_url: null }) };
  const ttl = BuildService.OWNERSHIP_TTL_MS;
  BuildService.OWNERSHIP_TTL_MS = 0; // every token checks GitHub again
  try {
    const dev = await connect(await as("Dev", ["developer"]));
    const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
    assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.approval, "approved");
    const row = (await pg.query("SELECT approved_via FROM financial_products.repo_connections WHERE developer_id = $1", [dev.user.id])).rows[0];
    assert.equal(row.approved_via, "github");
    const started = (await call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" })).data;
    await builds.tick();
    const sbx = (await builds.get(started.id)).sandbox_id;
    sandboxes.ready(sbx);
    await builds.tick();
    sandboxes.write(sbx, `${BUILD}/job/result.json`, agentReport);
    sandboxes.finishAgent(sbx);
    await builds.tick();
    const vid = (await builds.get(started.id)).verify_sandbox_id;
    sandboxes.ready(vid);
    await builds.tick();
    sandboxes.sandboxes.get(vid).checksRunning = false;
    sandboxes.write(vid, `${V}/before.sha`, "tree\n");
    sandboxes.write(vid, `${V}/report.json`, { checks: passingChecks });
    await builds.tick();
    sandboxes.write(vid, `${V}/maxwell.json`, cleanAudit);
    sandboxes.finishAgent(vid, "success");
    // Their push access goes while the build is being verified.
    perm = "read";
    await builds.tick();
    const b = await builds.get(started.id);
    assert.equal(b.status, "blocked");
    assert.match(b.error ?? b.phase_message, /can't push to acme\/savings-app.*no pull request was opened \(the verified work is on branch mynt\/build-/);
    assert.equal(repos.prs.length, 0, "no pull request");
    const now = (await pg.query("SELECT approval FROM financial_products.repo_connections WHERE developer_id = $1", [dev.user.id])).rows[0];
    assert.equal(now.approval, "pending_approval", "back with an admin");
  } finally {
    BuildService.OWNERSHIP_TTL_MS = ttl;
  }
});

test("the auditor is shown Mynt's own pipeline record: each check's tool, version, bar and result, and each image's scan and SBOM", async () => {
  const { pipelineEvidence, writePipelineEvidence } = await import("../dist/pipeline-evidence.js");
  const checks = [
    { name: "source", status: "pass", detail: `sha256 ${SHA}` },
    { name: "dependency_audit", status: "pass", detail: "no high or critical advisories" },
    { name: "sbom", status: "pass", detail: "CycloneDX SBOM generated: source (412 components); images: api (61 components), web (140 components)" },
    { name: "image_scan", status: "warn", detail: "no fixable high or critical vulnerability (grype 0.121.3; api 0 critical / 0 high, web 0 critical / 1 high); 1 high or critical with no fix published yet: web: GHSA-x high in pgproto3 v2.3.3 (no fix published)" },
    { name: "secrets_history", status: "warn", detail: "1 secret(s) in history" },
  ];
  const runs = [
    { check: "dependency_audit", tool: "npm audit", tool_version: "10.9.4", command: "npm audit --omit=dev --audit-level=high, on the lockfile of the verified source", threshold: "a high or critical advisory in a production dependency fails", started_at: "2026-11-28T10:00:00Z", finished_at: "2026-11-28T10:00:04Z" },
    { check: "image_scan", tool: "grype", tool_version: "0.121.3", command: "docker build …", threshold: "a high or critical vulnerability with a fix available fails; one with no fix yet is a warning", started_at: "2026-11-28T10:01:00Z", finished_at: "2026-11-28T10:05:00Z" },
  ];
  const images = {
    applicable: true,
    built: true,
    compose_file: "compose.yaml",
    coverage: "every image Mynt's hosting starts",
    images: [{ service: "web", source: "build", dockerfile: "web/Dockerfile", base_images: [{ ref: "caddy:2@sha256:" + "d".repeat(64), pinned: true, final: true }], image_id: "sha256:" + "e".repeat(64), sbom: { path: `${V}/sbom-images/web.cdx.json`, format: "CycloneDX", components: 140 }, scan: { tool: "grype", tool_version: "0.121.3", critical: 0, high: 1, medium: 2, low: 0, unknown: 0, blocking: [], unfixable: ["GHSA-x high in pgproto3 v2.3.3 (no fix published)"] } }],
    skipped: [{ service: "mobile", reason: "only in profile mobile: Mynt's hosting doesn't start it" }],
    problems: [],
  };
  const e = pipelineEvidence({ build_id: "b1", source_sha256: SHA, checks, runs, images, generated_at: "2026-11-28T10:06:00Z" });
  // What ran, with what, to which bar, with what result, and when: for every check, in order.
  assert.deepEqual(e.gates.map((g) => g.check), checks.map((c) => c.name));
  const sca = e.gates.find((g) => g.check === "dependency_audit");
  assert.deepEqual(
    [sca.gate, sca.result, sca.blocking, sca.tool, sca.tool_version, sca.threshold, sca.started_at, sca.finished_at],
    ["dependency vulnerabilities (SCA)", "pass", true, "npm audit", "10.9.4", "a high or critical advisory in a production dependency fails", "2026-11-28T10:00:00Z", "2026-11-28T10:00:04Z"],
  );
  // A check Mynt has no tool record for is still listed with its result, and says nothing it doesn't know.
  assert.deepEqual([e.gates[0].result, e.gates[0].tool, e.gates[0].started_at], ["pass", null, null]);
  // Nothing is softened: a warning stays a warning with its detail, and the only check that never blocks is named so.
  assert.equal(e.gates.find((g) => g.check === "image_scan").result, "warn");
  assert.match(e.gates.find((g) => g.check === "image_scan").detail, /no fix published/);
  assert.deepEqual(e.gates.filter((g) => !g.blocking).map((g) => g.check), ["secrets_history"]);
  // The images, their SBOMs and what wasn't scanned, as Mynt's image stage recorded them.
  assert.equal(e.images[0].sbom.path, `${V}/sbom-images/web.cdx.json`);
  assert.equal(e.images[0].scan.high, 1);
  assert.deepEqual(e.images_not_scanned, images.skipped);
  assert.equal(e.sbom.source, `${V}/sbom.json`);
  // It says whose record this is, and what the scanned images are not.
  assert.match(e.produced_by, /agent that wrote the application had no part/);
  assert.match(e.deployment, /builds these images again on the app's own machine/);
  assert.match(e.deployment, /not the deployed bytes/);
  // An app with nothing to ship as a container says so instead of listing nothing.
  assert.match(pipelineEvidence({ build_id: "b1", source_sha256: SHA, checks, runs, images: { applicable: false, images: [], skipped: [] }, generated_at: "x" }).image_coverage, /nothing ships as a container image/);
  assert.equal(pipelineEvidence({ build_id: "b1", source_sha256: SHA, checks, runs, images: null, generated_at: "x" }).image_coverage, "Mynt's image stage wrote no record");

  // Written from Mynt's own files in the verification sandbox, into the auditor's job folder. A solana_build row in
  // the checks' report is never used: Mynt's own record of that build is.
  const files = new Map([
    [`${V}/report.json`, JSON.stringify({ checks: [{ name: "solana_build", status: "pass", detail: "from the report" }, ...checks] })],
    [`${V}/pipeline.jsonl`, runs.map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n"],
    [`${V}/images.json`, JSON.stringify(images)],
  ]);
  const host = { readFile: async (_id, path) => files.get(path) ?? null, writeFile: async (_id, path, text) => void files.set(path, text) };
  await writePipelineEvidence(host, "sbx", { build_id: "b1", source_sha256: SHA, solana_check: { name: "solana_build", status: "fail", detail: "Mynt's own record" } });
  const written = JSON.parse(files.get(`${AUDIT}/job/pipeline-evidence.json`));
  assert.deepEqual([written.gates[0].check, written.gates[0].result, written.gates[0].detail], ["solana_build", "fail", "Mynt's own record"]);
  assert.equal(written.gates.length, checks.length + 1);
  assert.equal(written.gates.find((g) => g.check === "image_scan").tool, "grype");
  assert.equal(written.images.length, 1);
});

test("a build Mynt blocks keeps the source it verified, and continue_from starts the next build from it: no repository needed", async () => {
  const ctx = await setup();
  const { pg, builds, sandboxes, call } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const other = await ctx.connect(await ctx.as("Other", ["developer"]));
  // A package bigger than one read, so it comes back in pieces.
  sandboxes.sourcePackage = Buffer.alloc(450_000, 7);
  const sha = createHash("sha256").update(sandboxes.sourcePackage).digest("hex");
  const blocking = { ...cleanAudit, counts: { critical: 0, high: 3 }, findings: [{ severity: "high", title: "No image scan", file: "compose.yaml", workflow: "probe-cicd-env" }] };
  const { started, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" }, verification: { maxwell: blocking } });
  assert.equal(build.status, "blocked");
  assert.equal(build.repository, null, "nothing was pushed anywhere");
  const kept = (await pg.query("SELECT sha256, size, kept_until > now() + interval '6 days' AS week FROM financial_products.build_sources WHERE build_id = $1", [started.id])).rows[0];
  assert.deepEqual(kept, { sha256: sha, size: 450_000, week: true });
  const events = (await pg.query("SELECT message FROM financial_products.build_events WHERE build_id = $1 ORDER BY at", [started.id])).rows.map((r) => r.message);
  assert.ok(events.some((m) => /^Mynt kept this build's source until \d{4}-\d{2}-\d{2}: a new build with continue_from starts from it$/.test(m)), events.join(" | "));

  // Only its own developer continues from it; the next build starts with that exact source unpacked.
  assert.match((await call(other, "start_build", { goal: "Continue someone else's work", continue_from: started.id })).data.error, /No build of yours/);
  sandboxes.sourcePackage = null;
  const next = (await call(dev, "start_build", { goal: "Fix the three findings the audit raised", continue_from: started.id })).data;
  assert.equal(next.continued_from, started.id);
  assert.equal(next.repository, null);
  await builds.tick();
  const sbx = (await builds.get(next.id)).sandbox_id;
  sandboxes.ready(sbx);
  await builds.tick();
  const box = sandboxes.sandboxes.get(sbx);
  assert.equal(box.unpacked.dest, "/home/user/workspace/app", "unpacked where the agents work, before the agent starts");
  assert.equal(createHash("sha256").update(box.unpacked.data).digest("hex"), sha, "the exact package Mynt verified");
  assert.ok(box.commands.findIndex((c) => c.command.includes("base64 -d")) < box.commands.findIndex((c) => c.command.includes("runner.mjs")));
  const spec = JSON.parse(box.files.get(`${BUILD}/job/build.json`)).build;
  assert.deepEqual(spec.base, { source: "~/workspace/app", build_id: started.id, why_it_stopped: build.error });
  assert.match(box.files.get(`${BUILD}/CLAUDE.md`), /build\.base\.source/);
  assert.equal((await builds.get(next.id)).status, "coding");

  // Kept for a bounded time: afterwards the refusal says so, and what to do.
  await pg.query("UPDATE financial_products.build_sources SET kept_until = now() - interval '1 minute'");
  const late = (await call(dev, "start_build", { goal: "Fix it a week later", continue_from: started.id })).data.error;
  assert.match(late, /pushed no verified branch, and Mynt isn't keeping its source \(kept for 7 days when verification blocks or fails a build\), so there's nothing to continue from: start a new build without continue_from/);
});

test("a kept source is only ever the package Mynt hashed, and a build that shipped keeps none", async () => {
  const { keepSource, KEPT_SOURCE_MAX_BYTES } = await import("../dist/build-sources.js");
  const ctx = await setup();
  const { pg, builds, sandboxes, call } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  sandboxes.sourcePackage = Buffer.from("the verified source");
  const { started, sbx, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please" } });
  assert.equal(build.status, "succeeded");
  assert.equal((await pg.query("SELECT count(*)::int AS n FROM financial_products.build_sources")).rows[0].n, 0);

  // Changed in the sandbox since Mynt hashed it, too big, or gone: not kept, with the reason.
  const db = { query: (q, a) => pg.query(q, a) };
  const o = { build_id: started.id, sandbox_id: sbx, path: "/home/user/mynt-out/app.tgz", sha256: (await builds.get(started.id)).source_sha256 };
  assert.equal((await keepSource(db, sandboxes, o)).kept.size, 19);
  sandboxes.sandboxes.get(sbx).package = Buffer.from("something else entirely");
  assert.deepEqual(await keepSource(db, sandboxes, o), { kept: null, reason: "the packaged source no longer matches the hash Mynt verified" });
  sandboxes.sandboxes.get(sbx).package = Buffer.alloc(KEPT_SOURCE_MAX_BYTES + 1);
  assert.match((await keepSource(db, sandboxes, o)).reason, /over the 24 MB Mynt keeps/);
  sandboxes.sandboxes.get(sbx).package = null;
  assert.deepEqual(await keepSource(db, sandboxes, o), { kept: null, reason: "the packaged source is no longer in the build's sandbox" });
});
