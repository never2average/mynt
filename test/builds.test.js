import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { workspaceFiles } from "../dist/agent-host.js";
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
      if (command.includes("tar --exclude")) return { exitCode: 0, stdout: `${SHA}  /home/user/mynt-out/app.tgz\n`, stderr: "" };
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/after.sha`, boat.tamperDuringAudit ? "changed\n" : s.files.get(`${V}/before.sha`));
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("verify.sh")) return { processId: 7, exitCode: null, stdout: "", stderr: "" };
      if (command.includes("runner.mjs")) {
        s.agentRunning = true;
        return { processId: 99, exitCode: null, stdout: "", stderr: "" };
      }
      if (command.startsWith("tail -n")) {
        const line = { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } };
        return { exitCode: 0, stdout: `${JSON.stringify(line)}\n`, stderr: "" };
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

async function setup({ boat = fakeBoat(), config = {} } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const repos = fakeRepos();
  const builds = await BuildService.open(db, store, boat, repos, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" }, ...config });
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
  assert.ok(coding.files.has(`${BUILD}/.claude/skills/maxwell-audit/SKILL.md`) && coding.files.has(`${BUILD}/scripts/report_status.py`));
  assert.equal(config.cwd, BUILD);
  assert.equal(JSON.parse(coding.files.get(`${BUILD}/job/build.json`)).build.repository, "acme/savings-app");
  assert.ok(coding.files.has(`${BUILD}/job/sdk/openapi.json`));

  // The verifier: a fresh sandbox with no secrets, Mynt's own script, and an audit-only agent.
  const verifier = boat.sandboxes.get(vid);
  assert.deepEqual(verifier.opts.env, {});
  assert.match(verifier.files.get(`${V}/verify.sh`), /gitleaks/);
  assert.match(verifier.commands.find((c) => c.detached).command, new RegExp(`verify\\.sh 'https://files\\.example/${sbx}/home/user/mynt-out/app\\.tgz\\?sig=x' ${SHA}`));
  assert.match(verifier.files.get(`${AUDIT}/CLAUDE.md`), /Do not modify anything inside `app_dir`/);
  assert.deepEqual(JSON.parse(verifier.files.get(`${AUDIT}/job/audit.json`)), { app_dir: "/home/user/app", maxwell_repo: "https://github.com/OnFinance/Maxwell", output: `${V}/maxwell.json` });
  assert.equal(boat.agentConfig(vid).cwd, AUDIT);
  assert.ok(verifier.stopped, "the verifier is stopped once it has reported");

  assert.equal(build.status, "succeeded");
  assert.equal(build.pr_url, "https://github.com/acme/savings-app/pull/7");
  assert.equal(build.commit_sha, COMMIT);
  assert.equal(build.source_sha256, SHA);
  assert.equal(build.source_url, undefined, "the signed URL is never shown");
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
  ["no independent audit, no ship", { verification: { maxwell: null } }, "blocked", /No independent Maxwell audit/],
  ["an audit that didn't finish doesn't count", { verification: { auditStatus: "error_max_budget_usd" } }, "blocked", /No independent Maxwell audit/],
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
  assert.match(r.build.error, /source changed during the audit/);

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
  assert.match((await call(dev, "start_build", { goal: "Another build please" })).data.error, /Monthly build budget/);
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
  await builds.tick();
  let b = (await call(dev, "get_build", { build_id: started.id })).data;
  assert.equal(b.status, "auditing");
  const activity = (await call(dev, "get_build_activity", { build_id: started.id })).data.activity;
  assert.deepEqual(activity[0], { type: "tool_use", summary: 'Bash {"command":"npm test"}' });
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

test("without a boat.dev key builds are disabled cleanly, and agents never connect outside services", async () => {
  const { as, connect, call } = await setup({ boat: null });
  const dev = await connect(await as("Dev", ["developer"]));
  assert.match((await call(dev, "start_build", { goal: "Build a savings page please" })).data.error, /aren't enabled/);
  assert.match(workspaceFiles("coding-build")[".claude/skills/maxwell-audit/SKILL.md"], /Do not connect any external service or sign in anywhere/);
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
