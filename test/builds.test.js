import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { workspaceFiles } from "../dist/agent-host.js";
import { redact } from "../dist/boxes.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

const SHA = "a".repeat(64);
const COMMIT = "c".repeat(40);
const V = "/home/user/mynt-verify";
const A = "/home/user/mynt-agent";
const BUILD = "/home/user/workspaces/coding-build";
const AUDIT = "/home/user/workspaces/build-audit";

// A stand-in for boat.dev: sandboxes become ready when told to, files live in memory, the agents' work
// is simulated by writing files (the runner's state.json among them), and shell commands are matched by
// what they do.
function fakeBoat() {
  const sandboxes = new Map();
  let n = 0;
  const boat = {
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
      // Mynt puts inbox items in place with a rename.
      const mv = command.match(/^mv -f '([^']+)' '([^']+)'$/);
      if (mv) {
        if (boat.failMv) return { exitCode: 1, stdout: "", stderr: "sandbox unreachable" };
        if (!s.files.has(mv[1])) return { exitCode: 1, stdout: "", stderr: "no such file" };
        s.files.set(mv[2], s.files.get(mv[1]));
        s.files.delete(mv[1]);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${SHA}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/after.sha`, boat.tamperDuringAudit ? "changed\n" : s.files.get(`${V}/before.sha`));
        s.files.set(`${V}/changed.txt`, boat.tamperDuringAudit ? "./api/index.ts\n" : "");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("verify.sh")) return { processId: 7, exitCode: null, stdout: "", stderr: "" };
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
      if (command.includes("git rev-parse")) return boat.branchMatches ? { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" } : { exitCode: 1, stdout: "", stderr: "" };
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
  return boat;
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
    async openPullRequest(repo, installation, pr) {
      prs.push({ repo, installation, ...pr });
      return `https://github.com/${repo}/pull/7`;
    },
  };
}

async function setup({ boat = fakeBoat(), config = {}, refuse = null } = {}) {
  const pg = new PGlite();
  // `refuse`: stands in for a database that rejects some statements (those it returns true for).
  const db = { query: (s, p) => (refuse?.(s, p) ? Promise.reject(new Error("refused by the test")) : pg.query(s, p)), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const repos = fakeRepos();
  const builds = await BuildService.open(db, store, boat, repos, { ...buildConfigFromEnv({ BUILD_AUDIT: "maxwell" }), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, ...config });
  const as = async (name, roles) => (await store.createUser(name, roles)).user;
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds }).connect(s);
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
  return { pg, store, builds, boat, repos, as, connect, call };
}

const passingChecks = [
  { name: "source", status: "pass" },
  { name: "tests", status: "pass" },
  { name: "secrets_scan", status: "pass" },
  { name: "dependency_audit", status: "pass" },
  { name: "sbom", status: "pass" },
  { name: "disclosures", status: "pass" },
];
const cleanAudit = { counts: { critical: 0, high: 0, medium: 2, low: 5 }, findings: [], summary: "No blocking findings" };
const agentReport = { maxwell: { counts: { critical: 0, high: 0 } }, readiness: [], preview: { port: 8080 }, push: { branch: "mynt/build-x" } };

// Drives one build from start through the agent's work into verification, then lets `verification`
// shape what the clean sandbox reports, and returns the final build.
async function runBuild(ctx, { dev, startArgs, agent = agentReport, verification = {} }) {
  const { builds, boat, call } = ctx;
  const started = (await call(dev, "start_build", startArgs)).data;
  assert.ok(started.id, JSON.stringify(started));
  assert.ok(!("source_url" in started) && !("agent_report" in started), "start_build shows the build as get_build does");
  const INTERNAL = ["source_url", "agent_report", "developer_id", "sandbox_id", "sandbox_key_id", "verify_sandbox_id", "verify_step", "verify_process_id", "verify_prompt_id", "audit_started_at", "source_sha256", "prompt_id", "box_sandbox_id", "box_until"];
  for (const k of INTERNAL) assert.ok(!(k in started), `start_build hides ${k}`);
  for (const k of INTERNAL) assert.ok(!(k in (await call(dev, "list_builds", {})).data.builds[0]), `list_builds hides ${k}`);
  for (const k of ["id", "goal", "status", "phase_message", "cost_usd", "cap_usd", "sandbox_open_until", "created_at"]) assert.ok(k in started, `start_build shows ${k}`);
  await builds.tick(); // sandbox requested
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick(); // agent prompted
  boat.write(sbx, `${BUILD}/job/result.json`, agent);
  boat.finishAgent(sbx);
  await builds.tick(); // source packaged, verifier requested
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  boat.ready(vid);
  await builds.tick(); // checks started
  boat.sandboxes.get(vid).checksRunning = false;
  boat.write(vid, `${V}/before.sha`, "tree\n");
  boat.write(vid, `${V}/report.json`, { checks: verification.checks ?? passingChecks });
  await builds.tick(); // auditor prompted
  if (verification.maxwell !== null) boat.write(vid, `${V}/maxwell.json`, verification.maxwell ?? cleanAudit);
  boat.finishAgent(vid, verification.auditStatus ?? "success");
  await builds.tick(); // decided
  return { started, sbx, vid, build: (await call(dev, "get_build", { build_id: started.id })).data };
}

test("a build is verified by Mynt in a clean sandbox, then Mynt opens the PR", async () => {
  const ctx = await setup();
  const { boat, repos, as, connect, call, builds } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.connected, true);

  const { started, sbx, vid, build } = await runBuild(ctx, {
    dev,
    startArgs: { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" },
  });

  // The coding sandbox: secrets only in its env, the task and SDK in files, no PR from the agent.
  const coding = boat.sandboxes.get(sbx);
  // Mynt runs a pinned Claude Code itself, budgeted from the build's cap, through Mynt's proxy: no
  // Anthropic key in the sandbox, and the build's proxy token dies with the build.
  const config = boat.agentConfig(sbx);
  assert.equal(config.model, "claude-opus-5-5");
  assert.ok(config.budgetUsd > 0 && config.budgetUsd <= 10);
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  assert.match(coding.files.get(`${A}/runner.mjs`), /--max-budget-usd/);
  const auth = JSON.parse(coding.files.get(`${A}/auth.json`));
  assert.deepEqual(auth.env, { ANTHROPIC_BASE_URL: "https://mynt.example.com/agent", ANTHROPIC_AUTH_TOKEN: auth.token });
  assert.ok(!JSON.stringify(coding.opts.env).includes("sk-ant") && !coding.opts.env.ANTHROPIC_API_KEY);
  assert.equal(await builds.agentTokenActive(auth.token), false, "the coding agent's token was replaced for the audit");
  const auditAuth = JSON.parse(boat.sandboxes.get(vid).files.get(`${A}/auth.json`));
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
  const verifier = boat.sandboxes.get(vid);
  assert.deepEqual(verifier.opts.env, {});
  assert.match(verifier.files.get(`${V}/verify.sh`), /gitleaks/);
  assert.match(verifier.commands.find((c) => c.detached).command, new RegExp(`verify\\.sh 'https://files\\.example/${sbx}/home/user/mynt-out/app\\.tgz\\?sig=x' ${SHA}`));
  assert.match(verifier.files.get(`${AUDIT}/CLAUDE.md`), /Do not modify anything inside `app_dir`/);
  assert.deepEqual(JSON.parse(verifier.files.get(`${AUDIT}/job/audit.json`)), {
    app_dir: "/home/user/app",
    maxwell_repo: "https://github.com/OnFinance/Maxwell",
    output: `${V}/maxwell.json`,
    workflows: ["execute-scr", "probe-cicd-env"],
    minutes: 20,
  });
  assert.equal(boat.agentConfig(vid).cwd, AUDIT);
  // Mynt's audit runs on its own model and budget, not the developer's: the coding agent's runs on the deployment's.
  assert.equal(boat.agentConfig(vid).model, "claude-sonnet-5-5");
  assert.equal(boat.agentConfig(vid).budgetUsd, 5);
  assert.notEqual(boat.agentConfig(sbx).model, "claude-sonnet-5-5");
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
  ["the agent's own report can't hide findings: Mynt's audit decides", { agent: { ...agentReport, maxwell: { counts: { high: 0 } } }, verification: { maxwell: { counts: { critical: 0, high: 2 } } } }, "blocked", /Security gate: 2/],
  ["no independent audit, no ship", { verification: { maxwell: null } }, "blocked", /No independent Maxwell audit result \(the auditor finished without writing its report\)/],
  ["an audit that didn't finish doesn't count", { verification: { auditStatus: "error_max_budget_usd" } }, "blocked", /No independent Maxwell audit result \(auditor: error_max_budget_usd/],
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

  ctx.boat.tamperDuringAudit = true;
  let r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", repository: "acme/savings-app" } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /source changed during the audit: \.\/api\/index\.ts;/);

  ctx.boat.tamperDuringAudit = false;
  ctx.boat.branchMatches = false;
  r = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", repository: "acme/savings-app" } });
  assert.equal(r.build.status, "blocked");
  assert.match(r.build.error, /pushed branch doesn't match/);
  assert.equal(ctx.repos.prs.length, 0, "no PR for either");
});

test("a build that doesn't ship revokes its Mynt sandbox key", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const { started } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings page please", app_id: app.id }, verification: { maxwell: { counts: { critical: 1 } } } });
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
  assert.deepEqual(JSON.parse(ctx.boat.sandboxes.get(vid).files.get(`${V}/disclosures.json`)), [
    { product_id: "fixed-deposit", text: "Deposits are insured up to the statutory limit" },
  ]);
});

test("spend caps count both sandboxes, and the monthly budget refuses new builds", async () => {
  const ctx = await setup({ config: { capUsd: 5, monthlyCapUsd: 8 } });
  const { builds, boat, as, connect, call } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", cap_usd: 50 })).data;
  assert.equal(started.cap_usd, 5, "capped at the platform maximum");
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  boat.write(sbx, `${BUILD}/job/result.json`, agentReport);
  boat.finishAgent(sbx, "success", 1);
  boat.sandboxes.get(sbx).cost = 2;
  await builds.tick(); // verifying
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  boat.sandboxes.get(vid).cost = 2.5;
  await builds.tick();
  const b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "over_budget");
  assert.equal(b.cost_usd, 5.5);
  assert.ok(boat.sandboxes.get(sbx).stopped && boat.sandboxes.get(vid).stopped);
  // US$2.50 of the US$8 month is left: the default US$5 cap doesn't fit, and the error says how much would.
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

test("developers track, steer and stop their own builds; admins see all", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  boat.write(sbx, `${BUILD}/job/status.json`, { phase: "auditing", message: "Running Maxwell" });
  boat.log(sbx, { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } });
  await builds.tick();
  let b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "auditing");
  const activity = (await call(dev, "get_build_activity", { build_id: started.id })).data.activity;
  assert.deepEqual({ type: activity[0].type, summary: activity[0].summary }, { type: "tool_use", summary: 'Bash {"command":"npm test"}' });
  assert.equal((await call(dev, "steer_build", { build_id: started.id, message: "Use the existing design system" })).data.steered, true);
  const inbox = [...boat.sandboxes.get(sbx).files].filter(([path]) => path.startsWith(`${A}/inbox/`));
  assert.deepEqual(inbox.map(([, v]) => JSON.parse(v)), [{ message: "Use the existing design system" }], "steering goes to the runner's inbox");
  const token = JSON.parse(boat.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;
  assert.equal(await builds.agentTokenActive(token), true);
  assert.equal((await call(other, "get_build", { build_id: started.id })).isError, true);
  assert.equal((await call(other, "stop_build", { build_id: started.id })).isError, true);
  b = (await call(dev, "stop_build", { build_id: started.id })).data;
  assert.equal(b.status, "stopped");
  assert.ok(boat.sandboxes.get(sbx).stopped);
  assert.equal(await builds.agentTokenActive(token), false, "stopping a build kills its proxy token");
  const all = (await call(admin, "list_all_builds")).data;
  assert.equal(all.builds.length, 1);
  assert.equal(all.builds[0].source_url, undefined);
  assert.match((await call(dev, "steer_build", { build_id: started.id, message: "go on" })).data.error, /only a running agent/);
});

const say = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const run = (command) => ({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] } });

test("the agent's activity is stored as the build runs: paged with a cursor, and kept after the sandbox stops", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  const activity = async (args = {}) => (await call(dev, "get_build_activity", { build_id: started.id, ...args })).data;
  assert.deepEqual((await activity()).activity, [], "nothing before the agent starts");
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();

  // Complete lines only: a line still being written waits for its newline. Lines Mynt doesn't show (tool results)
  // are read past.
  boat.log(sbx, say("Reading the spec"), { type: "user", message: { content: [{ type: "tool_result", content: "x".repeat(500) }] } }, run("npm test"), '{"type":"assistant","message":{"content":[{"type":"text","text":"Half');
  await builds.tick();
  let all = await activity({ after: 0 });
  assert.deepEqual(all.activity.map((a) => [a.seq, a.type, a.summary]), [[1, "message", "Reading the spec"], [2, "tool_use", 'Bash {"command":"npm test"}']]);
  assert.equal(all.cursor, 2);
  assert.ok(all.activity.every((a) => !Number.isNaN(Date.parse(a.at))));
  boat.log(sbx, ' written"}]}}\n', { type: "result", subtype: "success", total_cost_usd: 0.42 });
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
  boat.log(sbx, run("git status"));
  await call(dev, "stop_build", { build_id: started.id });
  assert.ok(boat.sandboxes.get(sbx).stopped);
  all = await activity({ after: 0 });
  assert.deepEqual(all.activity.map((a) => a.summary), ["Reading the spec", 'Bash {"command":"npm test"}', "Half written", "success, US$0.42", 'Bash {"command":"git status"}']);
  assert.equal(all.status, "stopped");
  assert.match((await call(other, "get_build_activity", { build_id: started.id })).data.error, /No build of yours/);
});

test("a line too long to keep is skipped, across reads, without losing the lines around it; each build keeps its latest entries", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  // A 600 KB tool result (more than two reads), with multi-byte text before and after it.
  boat.log(sbx, say("Café – first"), { type: "user", message: { content: [{ type: "tool_result", content: "é".repeat(300_000) }] } }, say("naïve – after"));
  await builds.tick();
  const got = (await call(dev, "get_build_activity", { build_id: started.id, after: 0 })).data.activity;
  assert.deepEqual(got.map((a) => a.summary), ["Café – first", "naïve – after"]);
  assert.equal((await builds.get(started.id)).activity_offset, Buffer.byteLength(boat.sandboxes.get(sbx).files.get(`${A}/agent.jsonl`)));

  // Over the per-build limit, the oldest entries go; seq keeps counting.
  boat.log(sbx, ...Array.from({ length: 5003 }, (_, i) => say(`step ${i}`)));
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
  const { builds, boat, as, connect, call } = await setup({ refuse });
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  const summaries = async () => (await call(dev, "get_build_activity", { build_id: started.id, after: 0 })).data.activity.map((a) => a.summary);

  // A NUL (which Postgres text refuses) between good lines: all three are kept, the NUL gone.
  boat.log(sbx, say("before"), say("bad\u0000text"), say("after"));
  await builds.tick();
  assert.deepEqual(await summaries(), ["before", "bad text", "after"]);

  // An entry the database refuses for any other reason: the rest of its chunk is kept, and the offset moves on.
  boat.log(sbx, say("good one"), say("POISON"), say("good two"));
  await builds.tick();
  assert.ok(poisoned >= 2, "the batch, then the entry on its own, were refused");
  boat.log(sbx, say("later"));
  await builds.tick();
  assert.deepEqual(await summaries(), ["before", "bad text", "after", "good one", "good two", "later"]);
  assert.equal((await builds.get(started.id)).activity_offset, Buffer.byteLength(boat.sandboxes.get(sbx).files.get(`${A}/agent.jsonl`)));
});

test("activity is scrubbed of secrets before it is cut to length", async () => {
  const { activitySummary } = await import("../dist/builds.js");
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  const gh = "ghs_abcdefghijklmnopqrstuvwxyz0123456789";
  boat.log(sbx, say(`the token is ${gh}, don't share it`), run("GITHUB_TOKEN=supersecretvalue123 git push"), say(`${"x".repeat(385)} ${gh}`));
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

test("remove_app deletes a removed app's stored build activity", async () => {
  const { builds, boat, as, connect, call, pg } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const admin = await connect(await as("Ada", ["admin"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  boat.log(sbx, say("hello"));
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
  const { builds, boat, as, connect, call, repos } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const started = (await call(dev, "start_build", { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app", mode: "session" })).data;
  assert.equal(started.mode, "session");
  assert.equal(started.finish_requested_at, null);
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  const s = boat.sandboxes.get(sbx);

  // The runner is held open, with the 15-minute idle default, and knows how to finish; the agent is told it's a session.
  const launch = s.commands.find((c) => c.command.includes("runner.mjs")).command;
  assert.match(launch, /^MYNT_AGENT_HOLD=1 MYNT_AGENT_IDLE_MS=900000 node /);
  assert.match(boat.agentConfig(sbx).finishPrompt, /steps 2 to 6/);
  assert.match(boat.agentConfig(sbx).prompt, /session mode/);
  assert.equal(JSON.parse(s.files.get(`${BUILD}/job/build.json`)).build.mode, "session");
  assert.match(s.files.get(`${BUILD}/CLAUDE.md`), /## Session mode/);
  assert.match(s.files.get(`${BUILD}/CLAUDE.md`), /Waiting for your next message/);

  // Between requests the agent waits (still coding); each request is a steer.
  boat.write(sbx, `${BUILD}/job/status.json`, { phase: "coding", message: "Waiting for your next message" });
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
  boat.write(sbx, `${BUILD}/job/result.json`, agentReport);
  boat.finishAgent(sbx);
  await builds.tick();
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  assert.ok(vid, "verification started");
  boat.ready(vid);
  await builds.tick();
  boat.sandboxes.get(vid).checksRunning = false;
  boat.write(vid, `${V}/before.sha`, "tree\n");
  boat.write(vid, `${V}/report.json`, { checks: passingChecks });
  await builds.tick();
  boat.write(vid, `${V}/maxwell.json`, cleanAudit);
  boat.finishAgent(vid);
  await builds.tick();
  const done = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(done.status, "succeeded");
  assert.equal(repos.prs.length, 1);
  assert.match((await call(dev, "finish_build", { build_id: started.id })).data.error, /succeeded/);
});

test("a session's idle machine time counts against its cap", async () => {
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please", mode: "session", cap_usd: 2 })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  boat.sandboxes.get(sbx).cost = 2.5; // the sandbox sat waiting; no model spend at all
  await builds.tick();
  const b = await builds.get(started.id);
  assert.equal(b.status, "over_budget");
  assert.ok(boat.sandboxes.get(sbx).stopped);
});

// A session build with its agent running, for the tests below.
async function runningSession(ctx, args = {}) {
  const dev = await ctx.connect(await ctx.as(`Dev ${randomUUID().slice(0, 6)}`, ["developer"]));
  const started = (await ctx.call(dev, "start_build", { goal: "Build a savings page please", mode: "session", ...args })).data;
  await ctx.builds.tick();
  const sbx = (await ctx.builds.get(started.id)).sandbox_id;
  ctx.boat.ready(sbx);
  await ctx.builds.tick();
  return { dev, started, sbx, s: ctx.boat.sandboxes.get(sbx) };
}
// Finish items in place in the runner's inbox (a dot-name is one still being written, which the runner skips).
const finishItems = (s) => [...s.files].filter(([p]) => p.startsWith(`${A}/inbox/`) && !p.startsWith(`${A}/inbox/.`) && p.endsWith("-finish.json")).map(([, v]) => JSON.parse(v));

test("a session the runner finished on its own (idle) takes no more steers; nor does one finished after the steer loaded it", async () => {
  const ctx = await setup();
  const { builds, boat, call } = ctx;
  const { dev, started, sbx, s } = await runningSession(ctx);
  // The runner went idle and sent the finish prompt itself: Mynt records it on the next tick.
  boat.write(sbx, `${A}/state.json`, { session_id: "s1", cost_usd: 0.5, turns: 2, sent: 2, last_subtype: "success", done: false, exit_code: null, error: null, summary: null, finish: "idle", undelivered: 0 });
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
  boat.write(sbx, `${BUILD}/job/result.json`, agentReport);
  boat.finishAgent(sbx);
  boat.write(sbx, `${A}/state.json`, { session_id: "s1", cost_usd: 0.5, turns: 3, sent: 3, last_subtype: "success", done: true, exit_code: 0, error: null, summary: "shipped", finish: "idle", undelivered: 2 });
  // Moving on to verification fails once (a provider's passing 503), so the tick is retried: the report is made once.
  const exec = boat.exec;
  let failed = false;
  boat.exec = async (id, command, opts) => {
    if (!failed && command.includes("tar --exclude")) {
      failed = true;
      throw new Error('Freestyle POST /vms/vm-1/exec-await: 503 {"code":"INTERNAL_ERROR"}');
    }
    return exec(id, command, opts);
  };
  await builds.tick();
  assert.equal((await builds.get(started.id)).status, "coding", "a passing 503 is ridden out");
  await builds.tick();
  boat.exec = exec;
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
  ctx.boat.failMv = true;
  const r = (await ctx.call(dev, "finish_build", { build_id: started.id })).data;
  assert.equal(r.finishing, true);
  assert.deepEqual(finishItems(s), []);
  let b = await ctx.builds.get(started.id);
  assert.ok(b.finish_requested_at && !b.finish_delivered_at, "claimed, not yet delivered");
  assert.match((await ctx.call(dev, "steer_build", { build_id: started.id, message: "One more" })).data.error, /finishing/);
  await ctx.builds.tick();
  assert.deepEqual(finishItems(s), [], "still unreachable: still pending");
  ctx.boat.failMv = false;
  await ctx.builds.tick();
  assert.deepEqual(finishItems(s).map((f) => f.reason), ["developer"]);
  b = await ctx.builds.get(started.id);
  assert.ok(b.finish_delivered_at);
  await ctx.builds.tick();
  assert.equal(finishItems(s).length, 1, "delivered once");
});

test("BUILD_SESSION_IDLE_MS must be a sensible number of milliseconds, or the 15-minute default applies", () => {
  for (const [v, want] of [[undefined, 900000], ["120000", 120000], ["abc", 900000], ["5", 900000], ["1e12", 900000], ["Infinity", 900000]])
    assert.equal(buildConfigFromEnv(v === undefined ? {} : { BUILD_SESSION_IDLE_MS: v }).sessionIdleMs, want, String(v));
});

test("continue_from starts a build from an earlier build's pushed branch, on the same app and repository", async () => {
  const ctx = await setup();
  const { builds, boat, as, connect, call } = ctx;
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
  boat.ready(sbx);
  await builds.tick();
  const spec = JSON.parse(boat.sandboxes.get(sbx).files.get(`${BUILD}/job/build.json`)).build;
  assert.deepEqual(spec.base, { branch: shipped.branch, commit_sha: COMMIT, build_id: first.id });
  assert.notEqual(spec.branch, shipped.branch, "it pushes a branch of its own");
  assert.match(boat.sandboxes.get(sbx).files.get(`${BUILD}/CLAUDE.md`), /build\.base\.branch/);

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
  const { builds, boat, as, connect, call } = await setup();
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  assert.match((await call(dev, "sandbox_run", { build_id: started.id, command: "ls" })).data.error, /sandbox is provisioning/);
  boat.ready(sbx);
  await builds.tick();

  // VS Code in the browser: a token-gated URL plus a password that never goes on a command line.
  const editor = (await call(dev, "open_sandbox_editor", { build_id: started.id })).data;
  assert.equal(editor.url, `https://${sbx}-8443.preview.example?_token=t`);
  assert.match(editor.password, /^[A-Za-z0-9_-]{24}$/);
  const s = boat.sandboxes.get(sbx);
  assert.match(s.files.get("/home/user/.config/mynt-editor.yaml"), new RegExp(`bind-addr: 127\\.0\\.0\\.1:8443\\nauth: password\\npassword: ${editor.password}`));
  const start = s.commands.find((c) => c.command.includes("code-server --config"));
  assert.match(start.command, /code-server\/releases\/download\/v4\.96\.4\//, "a pinned release");
  assert.ok(!s.commands.some((c) => c.command.includes(editor.password)), "the password is never in a command");

  // Commands run in the app's directory; output is scrubbed of credentials.
  const exec = boat.exec;
  boat.exec = async (id, command, opts) => {
    const r = await exec(id, command, opts);
    return command.includes("npm test") ? { exitCode: 1, stdout: "GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz123456 key mynt_test_0123456789abcdef\n1 failing", stderr: "" } : r;
  };
  const ran = (await call(dev, "sandbox_run", { build_id: started.id, command: "npm test", timeout_seconds: 300 })).data;
  assert.equal(ran.exit_code, 1);
  assert.doesNotMatch(ran.stdout, /ghs_|mynt_test_0123/);
  assert.match(ran.stdout, /GITHUB_TOKEN=\[redacted\] key \[redacted\]\n1 failing/);
  boat.exec = exec;
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
  const { boat, as, connect, call } = ctx;
  const dev = await connect(await as("Dev", ["developer"]));
  const other = await connect(await as("Other", ["developer"]));
  const app = (await call(dev, "create_app", { name: "Saver", description: "Savings ideas", audience: "Savers", product_ids: ["fixed-deposit"] })).data;
  await call(dev, "connect_repository", { repository: "acme/savings-app" });
  const { started, build } = await runBuild(ctx, { dev, startArgs: { goal: "Build a savings comparison page", app_id: app.id, repository: "acme/savings-app" } });
  assert.equal(build.status, "succeeded");
  assert.match((await call(other, "reopen_sandbox", { build_id: started.id })).data.error, /No build of yours/);

  const first = (await call(dev, "reopen_sandbox", { build_id: started.id, hours: 2 })).data;
  assert.equal(first.ready, false);
  const box = [...boat.sandboxes.values()].find((s) => s.opts.labels.mynt_role === "box");
  assert.equal(box.opts.ttlSeconds, 7200);
  assert.equal(box.opts.env.GITHUB_TOKEN, "ghs_short_lived");
  assert.equal(box.opts.env.GITHUB_REPOSITORY, "acme/savings-app");
  assert.ok(!Object.keys(box.opts.env).some((k) => /ANTHROPIC|MYNT_SANDBOX_KEY|AGENT/.test(k)), "no model or app keys in a developer's box");
  assert.equal(box.opts.env.MYNT_BRANCH, build.branch);
  assert.match((await call(dev, "sandbox_run", { build_id: started.id, command: "ls" })).data.error, /still starting/);

  boat.ready(box.id);
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
  ctx.boat.ready(sbx);
  await ctx.builds.tick();
  const token = JSON.parse(ctx.boat.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;

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
  ctx.boat.ready(sbx);
  await ctx.builds.tick();
  const { token, env } = JSON.parse(ctx.boat.sandboxes.get(sbx).files.get(`${A}/auth.json`));
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

test("without a boat.dev key builds are disabled cleanly, and agents never connect outside services", async () => {
  const { as, connect, call } = await setup({ boat: null });
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

test("boat's file API: a file that isn't there yet reads as null, other errors still throw", async () => {
  const { HttpBoatClient } = await import("../dist/boat.js");
  const boat = new HttpBoatClient("boat_test", "https://boat.example/api/v1");
  const realFetch = globalThis.fetch;
  let answer;
  globalThis.fetch = async () => new Response(JSON.stringify(answer.body), { status: answer.status });
  try {
    answer = { status: 500, body: { ok: false, message: "ENOENT: no such file or directory, stat '/home/user/mynt/status.json'" } };
    assert.equal(await boat.readFile("sbx", "/home/user/mynt/status.json"), null);
    answer = { status: 404, body: { ok: false, message: "Not found" } };
    assert.equal(await boat.readFile("sbx", "/home/user/x"), null);
    answer = { status: 200, body: { content: "hi" } };
    assert.equal(await boat.readFile("sbx", "/home/user/x"), "hi");
    answer = { status: 403, body: { ok: false, message: "Path must resolve under /home/user or /tmp" } };
    await assert.rejects(boat.readFile("sbx", "/root/x"), /Path must resolve/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a build that fails stops its sandboxes and kills its proxy token", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await ctx.call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await ctx.builds.tick();
  const sbx = (await ctx.builds.get(started.id)).sandbox_id;
  ctx.boat.ready(sbx);
  await ctx.builds.tick();
  const token = JSON.parse(ctx.boat.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;
  ctx.boat.finishAgent(sbx, "error_max_budget_usd", 9.9);
  await ctx.builds.tick();
  const b = await ctx.builds.get(started.id);
  assert.equal(b.status, "failed");
  assert.match(b.error, /error_max_budget_usd/);
  assert.ok(ctx.boat.sandboxes.get(sbx).stopped, "the coding sandbox is stopped");
  assert.equal(await ctx.builds.agentTokenActive(token), false);
});

test("a provider's passing 5xx doesn't fail a build; a persistent one, or a real error, does", async () => {
  const ctx = await setup();
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const app = (await ctx.call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
  const start = async () => (await ctx.call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id })).data;
  const real = ctx.boat.getSandbox;
  const failWith = (msg) => { ctx.boat.getSandbox = async () => { throw new Error(msg); }; };
  const heal = () => { ctx.boat.getSandbox = real; };
  const outage = 'Freestyle POST /vms/vm-1/exec-await: 503 {"code":"INTERNAL_ERROR"}';

  // A passing outage: the build rides it out and carries on.
  const a = await start();
  await ctx.builds.tick(); // sandbox requested
  ctx.boat.ready((await ctx.builds.get(a.id)).sandbox_id);
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
  ctx.boat.ready((await ctx.builds.get(b.id)).sandbox_id);
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
  ctx.boat.ready((await ctx.builds.get(q.id)).sandbox_id);
  failWith('Freestyle POST /vms/vm-1/exec-await: 429 {"code":"LIMIT_EXCEEDED","message":"Cannot start this VM because the allowance for vcpu_time, memory_time has been used."}');
  await ctx.builds.tick();
  heal();
  assert.equal((await ctx.builds.get(q.id)).status, "failed");
  assert.match((await ctx.builds.get(q.id)).error, /^The sandbox provider has used up this account's allowance; an admin must add billing/);

  // A real error fails at once.
  const c = await start();
  await ctx.builds.tick();
  ctx.boat.ready((await ctx.builds.get(c.id)).sandbox_id);
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
  const { builds, boat, call, pg } = ctx;
  const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
  const started = (await call(dev, "start_build", { goal: "Build a savings page please" })).data;
  await builds.tick();
  const sbx = (await builds.get(started.id)).sandbox_id;
  boat.ready(sbx);
  await builds.tick();
  const coderToken = JSON.parse(boat.sandboxes.get(sbx).files.get(`${A}/auth.json`)).token;
  boat.write(sbx, `${BUILD}/job/result.json`, agentReport);
  boat.finishAgent(sbx);
  await builds.tick();
  const vid = (await builds.get(started.id)).verify_sandbox_id;
  boat.ready(vid);
  await builds.tick();
  boat.sandboxes.get(vid).checksRunning = false;
  boat.write(vid, `${V}/before.sha`, "tree\n");
  boat.write(vid, `${V}/report.json`, { checks: passingChecks });
  await builds.tick(); // auditor started

  // Its own token: its own meter key, Mynt's budget, the audit model; the coding agent's token is retired.
  const auditToken = JSON.parse(boat.sandboxes.get(vid).files.get(`${A}/auth.json`)).token;
  assert.deepEqual(await builds.agentRun(auditToken), { key: `audit:${started.id}`, capUsd: 5, model: "claude-sonnet-5-5" });
  assert.equal(await builds.agentRun(coderToken), null);

  // What the audit spends on the model isn't the developer's: its runner reports US$4 so far.
  boat.write(vid, `${A}/state.json`, { cost_usd: 4, turns: 1, sent: 1, last_subtype: "success", done: false });
  const before = (await builds.get(started.id)).cost_usd;
  await builds.tick();
  assert.equal((await builds.get(started.id)).cost_usd, before);

  // Still running past its time limit: Mynt stops waiting, and the build doesn't ship without its report.
  await pg.query("UPDATE financial_products.build_runs SET audit_started_at = now() - interval '25 minutes' WHERE id = $1", [started.id]);
  await builds.tick();
  const b = await builds.get(started.id);
  assert.equal(b.status, "blocked");
  assert.match(b.error, /No independent Maxwell audit result \(auditor: timed out after 20 min/);
  assert.equal(await builds.agentRun(auditToken), null, "the audit token dies with the build");
});

test("by default a build ships on Mynt's own checks, with no agent audit; a failing static scan stops it", async () => {
  for (const [checks, status] of [
    [passingChecks.concat({ name: "static_scan", status: "pass" }), "succeeded"],
    [passingChecks.concat({ name: "static_scan", status: "fail", detail: "high-severity: node_eval in api/server.js" }), "failed"],
  ]) {
    const ctx = await setup({ config: { audit: buildConfigFromEnv({}).audit } });
    assert.equal(ctx.builds.config.audit.mode, "none");
    const { builds, boat, call } = ctx;
    const dev = await ctx.connect(await ctx.as("Dev", ["developer"]));
    const app = (await call(dev, "create_app", { name: "Saver", description: "S", audience: "S", product_ids: ["fixed-deposit"] })).data;
    assert.equal((await call(dev, "connect_repository", { repository: "acme/savings-app" })).data.connected, true);
    const started = (await call(dev, "start_build", { goal: "Build a savings page please", app_id: app.id, repository: "acme/savings-app" })).data;
    await builds.tick();
    const sbx = (await builds.get(started.id)).sandbox_id;
    boat.ready(sbx);
    await builds.tick();
    boat.write(sbx, `${BUILD}/job/result.json`, agentReport);
    boat.finishAgent(sbx);
    await builds.tick();
    const vid = (await builds.get(started.id)).verify_sandbox_id;
    boat.ready(vid);
    await builds.tick();
    boat.sandboxes.get(vid).checksRunning = false;
    boat.write(vid, `${V}/report.json`, { checks });
    await builds.tick(); // decided on the checks alone
    const b = await builds.get(started.id);
    assert.equal(b.status, status, b.error ?? "");
    assert.ok(!boat.sandboxes.get(vid).files.has(`${A}/auth.json`), "no auditor was started");
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
