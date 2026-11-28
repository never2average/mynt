import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { BuildService, MAXWELL_COMMIT, buildConfigFromEnv } from "../dist/builds.js";
import { HostingService } from "../dist/hosting.js";
import { ProductionReviewService, productionReviewConfigFromEnv, reviewCoverage } from "../dist/production-reviews.js";
import { productionBlockers, productionDeployBlockers } from "../dist/promotions.js";
import { workspaceFiles } from "../dist/agent-host.js";
import { CATALOG } from "./helpers.js";

// The production code review, with a stand-in sandbox host and a stand-in reviewer: sandboxes become ready when told
// to, files live in memory, and the reviewer's work is what the test writes (the report file its script would write,
// the runner's state). No model, no sandbox and no review tool runs here.

const TREE = "b".repeat(64);
const COMMIT = "c".repeat(40);
const V = "/home/user/mynt-verify";
const A = "/home/user/mynt-agent";
const AUDIT = "/home/user/workspaces/build-audit";
const TOKEN = "ghs_short_lived_for_the_review";

function fakeSandboxHost() {
  const sandboxes = new Map();
  let n = 0;
  const host = {
    sandboxes,
    tamper: false,
    fetchFails: false,
    async createSandbox(opts) {
      const id = `sbx_${++n}`;
      sandboxes.set(id, { id, state: "provisioning", opts, files: new Map(), commands: [], stopped: false, cost: 0, agentRunning: false });
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
    async costDollars(id) {
      return sandboxes.get(id).cost;
    },
    async stop(id) {
      sandboxes.get(id).stopped = true;
    },
    async exec(id, command, opts = {}) {
      const s = sandboxes.get(id);
      s.commands.push({ command, ...opts });
      if (command.includes("verify.sh --review-copy")) {
        // The script deletes the header file whatever happens.
        s.headerSeen = s.files.get(`${V}/source.header`);
        s.files.delete(`${V}/source.header`);
        return host.fetchFails ? { exitCode: 2, stdout: "", stderr: "could not download the source" } : { exitCode: 0, stdout: `audit-copy ${TREE}\n`, stderr: "" };
      }
      if (command.includes("verify.sh --rehash")) {
        s.files.set(`${V}/changed.txt`, host.tamper ? "./api/index.ts\n" : "");
        return { exitCode: 0, stdout: `rehash ${host.tamper ? "e".repeat(64) : TREE}\n`, stderr: "" };
      }
      if (command.includes("[r]unner.mjs")) {
        s.agentRunning = false;
        s.killed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.includes("runner.mjs")) {
        s.agentRunning = true;
        return { processId: 99, exitCode: null, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async commandStatus(id) {
      const running = sandboxes.get(id).agentRunning;
      return { running, exitCode: running ? null : 0 };
    },
    // Test controls
    ready(id) {
      sandboxes.get(id).state = "ready";
    },
    write(id, path, value) {
      sandboxes.get(id).files.set(path, typeof value === "string" ? value : JSON.stringify(value));
    },
    finishAgent(id, subtype = "success", cost = 0, extra = {}) {
      const s = sandboxes.get(id);
      s.agentRunning = false;
      s.files.set(`${A}/state.json`, JSON.stringify({ session_id: "s1", cost_usd: cost, turns: 1, sent: 1, last_subtype: subtype, done: true, exit_code: 0, error: null, ...extra }));
    },
  };
  return host;
}

const fakeRepos = () => ({
  tokens: [],
  reachable: true,
  async installationFor() {
    return this.reachable ? 42 : null;
  },
  async tokenFor(repo, installation) {
    this.tokens.push({ repo, installation });
    return { token: TOKEN, expires_at: new Date(Date.now() + 3600e3).toISOString() };
  },
  installUrl: () => "https://github.com/apps/mynt-builder/installations/new",
});

const caller = (client) => async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  let data;
  try {
    data = JSON.parse(res.content[0].text);
  } catch {
    data = { error: res.content[0].text };
  }
  return { isError: res.isError ?? false, data };
};

async function setup(env = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const sandboxes = fakeSandboxHost();
  const repos = fakeRepos();
  const builds = await BuildService.open(db, store, sandboxes, repos, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } });
  await HostingService.open(db, null, null);
  const reviews = await ProductionReviewService.open(db, store, builds, productionReviewConfigFromEnv(env));
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds, productionReviews: reviews }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return caller(client);
  };
  const person = async (name, roles = ["developer"]) => {
    const { user } = await store.createUser(name, roles);
    return { user, call: await connect(user) };
  };
  const ana = await person("Ana"); // the workspace's owner
  const mem = await person("Mem"); // a member
  const eve = await person("Eve"); // not in it
  const ada = await person("Ada", ["admin"]); // a Mynt admin outside it
  const cara = await person("Cara", ["developer", "admin"]); // a Mynt admin who is also the workspace's admin
  const ws = (await ana.call("create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'admin')", [ws.id, mem.user.id, cara.user.id]);
  const newApp = async (name = "Saver") => {
    const r = await ana.call("create_app", { name, description: `${name} app`, audience: "Savers", product_ids: ["fixed-deposit"], workspace_id: ws.id });
    assert.ok(r.data.id, JSON.stringify(r.data));
    await pg.query("UPDATE financial_products.apps SET product_ids = '{}' WHERE id = $1", [r.data.id]);
    return r.data;
  };
  let clock = Date.now() - 3600_000;
  // A build as the build service ends it: verified, pushed to the app's repository at a commit.
  const build = async (appId, status = "succeeded", extra = {}) => {
    const id = randomUUID();
    clock += 1000;
    await pg.query(
      `INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd, source_sha256, repository, commit_sha, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, 'build it', $4, 5, $5, $6, $7, $8, $8, $8)`,
      [id, ana.user.id, appId, status, "ab".repeat(32), "repository" in extra ? extra.repository : "acme/app", "commit_sha" in extra ? extra.commit_sha : COMMIT, new Date(clock).toISOString()],
    );
    return id;
  };
  const host = async (appId, buildId) => {
    let tenant = (await pg.query("SELECT id FROM financial_products.hosting_tenants WHERE workspace_id = $1", [ws.id])).rows[0]?.id;
    if (!tenant) {
      tenant = randomUUID();
      await pg.query("INSERT INTO financial_products.hosting_tenants (id, workspace_id, provider, status) VALUES ($1, $2, 'test', 'running')", [tenant, ws.id]);
    }
    await pg.query(
      `INSERT INTO financial_products.hosted_apps (app_id, tenant_id, build_id, repository, commit_sha, port, app_key_sealed, status)
       VALUES ($1, $2, $3, 'acme/app', $4, (SELECT COALESCE(max(port), 3000) + 1 FROM financial_products.hosted_apps), 'sealed', 'running')
       ON CONFLICT (app_id) DO UPDATE SET build_id = EXCLUDED.build_id, status = EXCLUDED.status`,
      [appId, tenant, buildId, COMMIT],
    );
  };
  const setStage = (appId, stage) => pg.query("INSERT INTO financial_products.app_promotions (app_id, stage) VALUES ($1, $2) ON CONFLICT (app_id) DO UPDATE SET stage = EXCLUDED.stage", [appId, stage]);
  const row = async (id) => (await pg.query("SELECT * FROM financial_products.production_reviews WHERE id = $1", [id])).rows[0];
  const audits = async (action) => (await pg.query("SELECT actor_id, target, details FROM financial_products.audit_log WHERE action = $1 ORDER BY created_at", [action])).rows;
  // Asks for a review and takes it to the point where the reviewer is running in its sandbox.
  const started = async (who, appId, buildId) => {
    const asked = await who.call("request_production_review", { app_id: appId, ...(buildId ? { build_id: buildId } : {}) });
    assert.equal(asked.isError, false, JSON.stringify(asked.data));
    await reviews.tick();
    const sid = (await row(asked.data.id)).sandbox_id;
    sandboxes.ready(sid);
    await reviews.tick();
    return { id: asked.data.id, sid, sandbox: sandboxes.sandboxes.get(sid) };
  };
  // The reviewer ends its turn having written `report` (the script's report from the tool's ledger).
  const finish = async (sid, report, o = {}) => {
    if (report !== null) sandboxes.write(sid, `${V}/maxwell.json`, report);
    sandboxes.sandboxes.get(sid).cost = o.machine ?? 1.25;
    sandboxes.finishAgent(sid, o.subtype ?? "success", o.model ?? 20, o.state ?? {});
    await reviews.tick();
  };
  return { pg, db, store, sandboxes, repos, builds, reviews, ana, mem, eve, ada, cara, ws, newApp, build, host, setStage, row, audits, started, finish, person };
}

const clean = { complete: true, counts: { critical: 0, high: 0, medium: 1, low: 2 }, findings: [{ severity: "medium", title: "Session cookie lacks SameSite", file: "api/session.ts", workflow: "execute-scr" }], workflows_run: ["execute-scr"], skipped: [], summary: "1 of 1 workflow(s) finished", progress: [{ workflow: "execute-scr", state: "ran", minutes: 71.5, agents: 34, ledger_records: 12, cost_usd: 19.4 }] };
const partial = (kind, reason, extra = {}) => ({ complete: false, counts: { critical: 0, high: 0, medium: 0, low: 1 }, findings: [{ severity: "low", title: "Verbose error", file: "api/x.ts", workflow: "execute-scr" }], workflows_run: [], skipped: [{ workflow: "execute-scr", kind, reason }], summary: "0 of 1 workflow(s) finished", ...extra });
const check = (r, id) => r.data.checks.find((c) => c.id === id);
const REVIEW = "production_code_review";
// Everything a production promotion needs besides the review.
async function readyForProduction(w, app, buildId) {
  await w.setStage(app.id, "staging");
  await w.host(app.id, buildId);
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
}
const checks = (w, app) => w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "production" });

test("who may ask: owners and admins of the app's workspace and Mynt admins; for a verified build of the app with a pushed commit; one at a time", async () => {
  const w = await setup();
  const app = await w.newApp();
  assert.match((await w.eve.call("request_production_review", { app_id: app.id })).data.error, /No app of yours/);
  assert.match((await w.mem.call("request_production_review", { app_id: app.id })).data.error, /Only the workspace's owners and admins request a production code review/);
  assert.match((await w.ana.call("request_production_review", { app_id: app.id })).data.error, /no build that passed Mynt's verification yet/);

  const failed = await w.build(app.id, "failed");
  assert.match((await w.ana.call("request_production_review", { app_id: app.id, build_id: failed })).data.error, /is failed: a production code review is for a build that passed Mynt's verification/);
  const unpushed = await w.build(app.id, "succeeded", { commit_sha: null });
  assert.match((await w.ana.call("request_production_review", { app_id: app.id, build_id: unpushed })).data.error, /pushed no commit/);
  const other = await w.newApp("Other");
  const theirs = await w.build(other.id);
  assert.match((await w.ana.call("request_production_review", { app_id: app.id, build_id: theirs })).data.error, /isn't a build of this app/);

  const first = await w.build(app.id);
  const latest = await w.build(app.id);
  // The default is the latest verified build; the review keeps the limits in force when it was asked for.
  const asked = await w.ana.call("request_production_review", { app_id: app.id });
  assert.equal(asked.isError, false, JSON.stringify(asked.data));
  assert.equal(asked.data.build_id, latest);
  assert.equal(asked.data.status, "queued");
  assert.equal(asked.data.commit_sha, COMMIT);
  assert.deepEqual(asked.data.limits, { workflows: ["execute-scr"], minutes: 180, cap_usd: 60, model: "claude-sonnet-5-5" });
  // Nothing measured yet: null, never 0.
  assert.equal(asked.data.cost_usd, null);
  assert.equal(asked.data.seconds, null);
  assert.equal(asked.data.findings, null);
  assert.equal(asked.data.coverage, null);
  assert.equal(asked.data.requested_by.name, "Ana");
  for (const k of ["sandbox_id", "process_id", "token_hash", "tree_sha256", "run"]) assert.ok(!(k in asked.data), `a review never shows ${k}`);
  assert.match((await w.ana.call("request_production_review", { app_id: app.id, build_id: first })).data.error, /is already queued for this app .*stop it first \(stop_production_review\)/);
  const [audit] = await w.audits("request_production_review");
  assert.equal(audit.actor_id, w.ana.user.id);
  assert.equal(audit.details.build_id, latest);
  assert.equal(audit.details.by_mynt_admin, false);

  // Members read it; outsiders don't. A Mynt admin sees every workspace's.
  assert.equal((await w.mem.call("get_production_review", { id: asked.data.id })).data.status, "queued");
  assert.match((await w.eve.call("get_production_review", { id: asked.data.id })).data.error, /No production code review of yours/);
  assert.equal((await w.mem.call("list_production_reviews", { app_id: app.id })).data.reviews.length, 1);
  assert.match((await w.eve.call("list_production_reviews", { app_id: app.id })).data.error, /No app of yours/);
  assert.deepEqual((await w.eve.call("list_production_reviews")).data.reviews, []);
  const all = (await w.ada.call("list_production_reviews")).data;
  assert.equal(all.reviews.length, 1);
  assert.equal(all.reviews[0].workspace_name, "Team");
  assert.equal(all.reviews[0].app_name, "Saver");
  assert.deepEqual(all.limits, { workflows: ["execute-scr"], model: "claude-sonnet-5-5", minutes: 180, cap_usd: 60, workspace_monthly_reviews: 4, workspace_monthly_usd: 200 });
  // Only Mynt admins have the exception tool.
  assert.match((await w.ana.call("waive_production_review", { app_id: app.id, build_id: latest, reason: "The provider refuses this security review" })).data.error, /not found|Unknown tool|waive_production_review/i);
});

test("a review runs through the build audit's machinery: a clean sandbox, the build's commit read-only, the build-audit workspace, its own budget and model", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  const { id, sid, sandbox } = await w.started(w.ana, app.id);
  // A machine of its own with no secrets, kept a little longer than the review may take.
  assert.deepEqual(sandbox.opts.env, {});
  assert.equal(sandbox.opts.ttlSeconds, 180 * 60 + 1800);
  assert.deepEqual(sandbox.opts.labels, { mynt_review: id, mynt_role: "review" });
  // The source is the commit the build pushed; the token is in a file the script deletes, never in a command.
  const copy = sandbox.commands.find((c) => c.command.includes("--review-copy"));
  assert.equal(copy.command, `bash ${V}/verify.sh --review-copy 'https://api.github.com/repos/acme/app/tarball/${COMMIT}' ${V}/source.header`);
  assert.equal(sandbox.headerSeen, `Authorization: Bearer ${TOKEN}\n`);
  for (const c of sandbox.commands) assert.ok(!c.command.includes(TOKEN), "the token is in no command");
  for (const [path, content] of sandbox.files) assert.ok(!String(content).includes(TOKEN), `the token isn't left in ${path}`);
  assert.deepEqual(w.repos.tokens, [{ repo: "acme/app", installation: 42 }]);
  // The reviewer is the build auditor: the same workspace folder and script, and the same job file with the review's
  // workflows and limits.
  for (const [path, content] of Object.entries(workspaceFiles("build-audit"))) assert.equal(sandbox.files.get(`${AUDIT}/${path}`), content, path);
  assert.deepEqual(JSON.parse(sandbox.files.get(`${AUDIT}/job/audit.json`)), {
    app_dir: "/home/user/audit-src",
    maxwell_repo: "https://github.com/OnFinance/Maxwell",
    maxwell_commit: MAXWELL_COMMIT,
    output: `${V}/maxwell.json`,
    workflows: ["execute-scr"],
    minutes: 180,
    budget_usd: 60,
    model: "claude-sonnet-5-5",
    attempt: 1,
    attempts: 1,
  });
  const run = JSON.parse(sandbox.files.get(`${A}/config.json`));
  assert.equal(run.model, "claude-sonnet-5-5");
  assert.equal(run.budgetUsd, 60);
  assert.equal(run.cwd, AUDIT);
  // Its model calls are metered under its own key, capped at the review's budget, on the review's model.
  const token = JSON.parse(sandbox.files.get(`${A}/auth.json`)).token;
  assert.deepEqual(await w.reviews.agentRun(token), { key: `production-review:${id}`, capUsd: 60, model: "claude-sonnet-5-5" });
  assert.equal(await w.builds.agentRun(token), null);
  assert.equal((await w.row(id)).tree_sha256, TREE);

  // Findings are reported as they are recorded, while it runs.
  w.sandboxes.write(sid, `${V}/maxwell.json`, partial("pending", "still running after 12 min (9 agent run(s) so far)", { progress: [{ workflow: "execute-scr", state: "running", minutes: 12, agents: 9, ledger_records: 1 }] }));
  w.sandboxes.sandboxes.get(sid).cost = 0.4;
  await w.reviews.tick();
  let r = (await w.mem.call("get_production_review", { id })).data;
  assert.equal(r.status, "running");
  assert.deepEqual(r.findings, { critical: 0, high: 0, medium: 0, low: 1 });
  assert.deepEqual(r.finding_list, [{ severity: "low", title: "Verbose error", file: "api/x.ts", workflow: "execute-scr" }]);
  assert.deepEqual(r.coverage.reviewed, []);
  assert.deepEqual(r.coverage.progress, [{ workflow: "execute-scr", state: "running", minutes: 12, agent_runs: 9, ledger_records: 1 }]);
  assert.equal(r.cost_usd, 0.4);
  assert.equal((await checks(w, app)).data.error?.includes("one step") ?? false, true, "the app is still an idea");

  await w.finish(sid, clean, { model: 20, machine: 1.25 });
  r = (await w.mem.call("get_production_review", { id })).data;
  assert.equal(r.status, "complete");
  assert.deepEqual(r.findings, { critical: 0, high: 0, medium: 1, low: 2 });
  assert.deepEqual(r.coverage, { reviewed: ["execute-scr"], not_reviewed: [], progress: [{ workflow: "execute-scr", state: "ran", minutes: 71.5, agent_runs: 34, ledger_records: 12 }] });
  assert.equal(r.cost_usd, 21.25, "the model's spend and the sandbox's machine time, as measured");
  assert.equal(typeof r.seconds, "number");
  assert.equal(r.reason, null);
  assert.ok(r.finished_at);
  assert.ok(!("run" in r), "the reviewer's own log is for Mynt admins");
  assert.equal(sandbox.stopped, true);
  assert.equal(sandbox.killed, true, "whatever the reviewer left running is ended before the report is read");
  assert.equal(await w.reviews.agentRun(token), null, "its token dies with it");
  const [done] = await w.audits("production_review_finished");
  assert.equal(done.details.status, "complete");
  assert.equal(done.details.build_id, b);
  // A build with a complete review isn't reviewed again.
  assert.match((await w.ana.call("request_production_review", { app_id: app.id })).data.error, /already has a complete production code review/);
});

test("a complete review with no critical or high finding passes the production check, for that build only", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await readyForProduction(w, app, b);
  let r = await checks(w, app);
  assert.deepEqual(r.data.checks.map((c) => c.id), ["build_verified", "audit_passed", "hosting_healthy", "licences", "program_agreements", "webhooks", "audit_findings", REVIEW, "program_gate"]);
  assert.equal(check(r, REVIEW).label, "Production code review passed");
  assert.equal(check(r, REVIEW).status, "fail");
  assert.match(check(r, REVIEW).detail, new RegExp(`^No production code review of build ${b.slice(0, 8)} yet: an owner or admin of the workspace requests one`));
  assert.deepEqual(check(r, REVIEW).fix, { label: "Request production review", href: `/${app.id}?tab=security`, tool: "request_production_review" });
  assert.equal(r.data.can_promote, false);
  assert.match((await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" })).data.error, /Not promoted: Production code review passed \(fail\)/);

  const { sid } = await w.started(w.ana, app.id);
  r = await checks(w, app);
  assert.equal(check(r, REVIEW).status, "pending", "a review in progress is never a pass");
  assert.match(check(r, REVIEW).detail, /is running \(started .* UTC; up to 180 min\)/);
  assert.match((await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" })).data.error, /Production code review passed \(pending\)/);

  await w.finish(sid, clean);
  r = await checks(w, app);
  assert.equal(check(r, REVIEW).status, "pass");
  assert.match(check(r, REVIEW).detail, new RegExp(`^Mynt's code review of build ${b.slice(0, 8)} finished on \\d{4}-\\d{2}-\\d{2} with no critical or high finding \\(medium 1, low 2; execute-scr\\)$`));
  assert.equal(r.data.can_promote, true, JSON.stringify(r.data.checks.filter((c) => c.status !== "pass")));

  // The review is for the exact build: a newer verified build, once it is the one online, needs its own.
  const newer = await w.build(app.id);
  await w.host(app.id, newer);
  r = await checks(w, app);
  assert.equal(check(r, REVIEW).status, "fail");
  assert.match(check(r, REVIEW).detail, new RegExp(`No production code review of build ${newer.slice(0, 8)} yet`));
  assert.equal(r.data.can_promote, false);
  // Back on the reviewed build, it promotes, and the snapshot it passed with is in the audit trail.
  await w.pg.query("DELETE FROM financial_products.build_runs WHERE id = $1", [newer]);
  await w.host(app.id, b);
  const p = await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" });
  assert.equal(p.data.promoted, true, JSON.stringify(p.data));
  const [promoted] = await w.audits("app_promoted");
  assert.equal(promoted.details.checks.find((c) => c.id === REVIEW).status, "pass");
});

test("a critical or high finding blocks, in a complete review and in one that didn't finish", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await readyForProduction(w, app, b);
  const { sid, id } = await w.started(w.ana, app.id);
  await w.finish(sid, { ...clean, counts: { critical: 1, high: 1, medium: 0, low: 0 }, findings: [{ severity: "critical", title: "SQL injection in the transfer lookup", file: "api/transfers.ts", workflow: "execute-scr" }, { severity: "high", title: "Missing authorization on export", file: "api/export.ts", workflow: "execute-scr" }] });
  assert.equal((await w.row(id)).status, "complete", "the review finished; what it found is what blocks");
  let r = await checks(w, app);
  assert.equal(check(r, REVIEW).status, "fail");
  assert.match(check(r, REVIEW).detail, /found 2 critical or high finding\(s\): fix them and build again; the new build needs its own review/);
  // They feed the open-findings check too.
  assert.equal(check(r, "audit_findings").status, "fail");
  assert.match(check(r, "audit_findings").detail, /2 critical or high finding\(s\) in the production code review of build/);
  assert.equal(r.data.can_promote, false);
  // No exception covers a finding.
  assert.match((await w.ada.call("waive_production_review", { app_id: app.id, build_id: b, reason: "We accept these two findings for now" })).data.error, /recorded 2 critical or high finding\(s\)\. An exception is for a review that can't finish, never for its findings/);

  // The same when the review was cut short after recording one.
  const app2 = await w.newApp("Second");
  const b2 = await w.build(app2.id);
  await readyForProduction(w, app2, b2);
  const second = await w.started(w.ana, app2.id);
  await w.finish(second.sid, partial("time", "ended at the time limit", { counts: { critical: 0, high: 1, medium: 0, low: 0 } }));
  r = await checks(w, app2);
  assert.equal(check(r, REVIEW).status, "fail");
  assert.match(check(r, REVIEW).detail, /recorded 1 critical or high finding\(s\) before it ended incomplete/);
  assert.equal(check(r, "audit_findings").status, "fail");
});

test("a review that didn't finish never passes, and says why and what to do: time, budget, a model refusal, a broken tool, a changed source", async () => {
  const w = await setup();
  const cases = [
    {
      name: "time (the script stopped the workflow at the limit)",
      report: partial("time", "ended at the time limit after 178 min"),
      status: "incomplete",
      problem: "time",
      reason: /^The review ran out of time \(180 min\) before it finished; so far it covers no workflow$/,
      next: /ask a Mynt admin to raise PRODUCTION_REVIEW_MINUTES, then request the review again/,
    },
    {
      name: "budget (the runner ended at its budget)",
      report: partial("pending", "still running after 40 min"),
      finish: { subtype: "error_max_budget_usd", model: 60 },
      status: "incomplete",
      problem: "budget",
      reason: /^The review used up its US\$60 budget before it finished; so far it covers no workflow$/,
      next: /ask a Mynt admin to raise PRODUCTION_REVIEW_CAP_USD/,
    },
    {
      name: "refused by the model provider, in the tool's runs",
      report: partial("refused", "the model refused the work", { model_refusal: { workflows: ["execute-scr"], count: 3, category: "cyber", request_ids: ["req_011CabcDEF"] } }),
      status: "refused",
      problem: "refused",
      reason: /^The review didn't finish: its model refused the security review in execute-scr \[cyber\] \(request id req_011CabcDEF\); so far it covers no workflow$/,
      next: /asking again will be refused again.*PRODUCTION_REVIEW_MODEL.*waive_production_review/,
    },
    {
      name: "refused in the reviewer's own session",
      report: null,
      finish: { state: { summary: "API Error: claude-sonnet-5-5 can't help with this. Start a new session to continue. Details: `[cyber]` Request ID: req_011Cown" } },
      status: "refused",
      problem: "refused",
      reason: /its model refused the security review in the auditor's own session \[cyber\] \(request id req_011Cown\)$/,
      next: /waive_production_review/,
    },
    {
      name: "the review tool is broken at its pinned commit",
      report: { complete: false, counts: { critical: 0, high: 0, medium: 0, low: 0 }, findings: [], workflows_run: [], skipped: [{ workflow: "execute-scr", kind: "tool", reason: "not started" }], tool_problem: "npm run validate failed at d1c155b" },
      status: "failed",
      problem: "tool",
      reason: /^The review couldn't run: Maxwell couldn't be used \(npm run validate failed at d1c155b\)/,
      next: /BUILD_MAXWELL_COMMIT.*PRODUCTION_REVIEW_WORKFLOWS/,
    },
    {
      name: "no report at all",
      report: null,
      status: "incomplete",
      problem: "no_report",
      reason: /^The review didn't finish: the auditor ended its turn without writing its report$/,
      next: /Request the review again/,
    },
    {
      name: "the read-only source changed",
      report: clean,
      tamper: true,
      status: "failed",
      problem: "changed",
      reason: /^The reviewer's read-only copy of the source changed during the review \(\.\/api\/index\.ts\); the result can't be trusted$/,
      next: /Request the review again/,
    },
  ];
  for (const c of cases) {
    const app = await w.newApp(`App ${cases.indexOf(c)}`);
    const b = await w.build(app.id);
    await readyForProduction(w, app, b);
    // A Mynt admin starts these, so the workspace's monthly limit isn't what is being tested.
    const { id, sid, sandbox } = await w.started(w.ada, app.id);
    w.sandboxes.tamper = !!c.tamper;
    await w.finish(sid, c.report, c.finish);
    w.sandboxes.tamper = false;
    const r = (await w.ada.call("get_production_review", { id })).data;
    assert.equal(r.status, c.status, c.name);
    assert.equal(r.problem, c.problem, c.name);
    assert.match(r.reason, c.reason, c.name);
    assert.match(r.next_step, c.next, c.name);
    assert.equal(sandbox.stopped, true, c.name);
    // Never run again by itself: one sandbox, one reviewer, and the review has ended.
    await w.reviews.tick();
    await w.reviews.tick();
    assert.equal(sandbox.commands.filter((x) => /node .*runner\.mjs/.test(x.command)).length, 1, `${c.name}: no second attempt`);
    assert.equal((await w.row(id)).status, c.status);
    // The reviewer's own account is kept for admins, and only shown to them.
    if (c.problem !== "changed") assert.ok(r.run && "report_written" in r.run, c.name);
    assert.ok(!("run" in (await w.ana.call("get_production_review", { id })).data), c.name);
    const got = await checks(w, app);
    assert.equal(check(got, REVIEW).status, "fail", c.name);
    assert.match(check(got, REVIEW).detail, new RegExp(c.reason.source.replace(/\$$/, "")), c.name);
    assert.match(check(got, REVIEW).detail, c.next, `${c.name}: the check says what to do`);
    assert.equal(got.data.can_promote, false, c.name);
  }
  // Mynt's own time limit ends a reviewer that is still going.
  const app = await w.newApp("Slow");
  await w.build(app.id);
  const { id, sid, sandbox } = await w.started(w.ada, app.id);
  await w.pg.query("UPDATE financial_products.production_reviews SET review_started_at = now() - interval '181 minutes' WHERE id = $1", [id]);
  w.sandboxes.write(sid, `${V}/maxwell.json`, partial("pending", "still running after 180 min"));
  await w.reviews.tick();
  const slow = (await w.ada.call("get_production_review", { id })).data;
  assert.equal(slow.status, "incomplete");
  assert.equal(slow.problem, "time");
  assert.equal(slow.run.result, "timed out after 180 min");
  assert.equal(sandbox.killed, true);
  assert.deepEqual(slow.findings, { critical: 0, high: 0, medium: 0, low: 1 }, "what it had found is kept");
});

test("a source Mynt can't fetch, or a sandbox that fails, ends the review as failed with the reason", async () => {
  const w = await setup();
  const app = await w.newApp();
  await w.build(app.id);
  w.sandboxes.fetchFails = true;
  let asked = (await w.ada.call("request_production_review", { app_id: app.id })).data;
  await w.reviews.tick();
  w.sandboxes.ready((await w.row(asked.id)).sandbox_id);
  await w.reviews.tick();
  let r = (await w.ada.call("get_production_review", { id: asked.id })).data;
  assert.equal(r.status, "failed");
  assert.equal(r.problem, "source");
  assert.match(r.reason, /couldn't fetch the commit build .* pushed \(could not download the source\)/);
  assert.equal(r.cost_usd, null, "nothing was measured, so no figure");
  assert.equal(r.findings, null);
  w.sandboxes.fetchFails = false;

  w.repos.reachable = false;
  await w.pg.query("DELETE FROM financial_products.repo_connections");
  asked = (await w.ada.call("request_production_review", { app_id: app.id })).data;
  await w.reviews.tick();
  w.sandboxes.ready((await w.row(asked.id)).sandbox_id);
  await w.reviews.tick();
  r = (await w.ada.call("get_production_review", { id: asked.id })).data;
  assert.equal(r.problem, "source");
  assert.match(r.reason, /Mynt can't read acme\/app any more/);
  w.repos.reachable = true;

  asked = (await w.ada.call("request_production_review", { app_id: app.id })).data;
  await w.reviews.tick();
  w.sandboxes.sandboxes.get((await w.row(asked.id)).sandbox_id).state = "error";
  await w.reviews.tick();
  r = (await w.ada.call("get_production_review", { id: asked.id })).data;
  assert.equal(r.status, "failed");
  assert.equal(r.problem, "error");
  assert.match(r.reason, /The review couldn't run: The review's sandbox ended as error/);
});

test("the deploy gate: on an app in Production a build goes online only with its own complete review", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await readyForProduction(w, app, b);
  const first = await w.started(w.ana, app.id);
  await w.finish(first.sid, clean);
  assert.equal((await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" })).data.promoted, true);
  const full = await w.store.getApp(app.id);
  assert.deepEqual(await productionDeployBlockers(w.store, full, b), [], "the reviewed build may go online again");

  const next = await w.build(app.id);
  let blockers = await productionDeployBlockers(w.store, full, next);
  assert.deepEqual(blockers.map((c) => c.id), [REVIEW]);
  assert.match(blockers[0].detail, new RegExp(`No production code review of build ${next.slice(0, 8)} yet`));
  // In progress stops it too; incomplete stops it with the reason; complete lets it through.
  const second = await w.started(w.ana, app.id, next);
  blockers = await productionDeployBlockers(w.store, full, next);
  assert.equal(blockers[0].status, "pending");
  await w.finish(second.sid, partial("time", "ended at the time limit"));
  blockers = await productionDeployBlockers(w.store, full, next);
  assert.equal(blockers[0].status, "fail");
  assert.match(blockers[0].detail, /The review ran out of time \(180 min\).*PRODUCTION_REVIEW_MINUTES/);
  const third = await w.started(w.ana, app.id, next);
  await w.finish(third.sid, clean);
  assert.deepEqual(await productionDeployBlockers(w.store, full, next), []);
});

test("grandfathered: an app already in Production with a build that never had a review stays online, with a warning; its next build needs one", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await w.host(app.id, b);
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
  await w.setStage(app.id, "production");
  const attention = (await w.ana.call("get_workspace_attention", { workspace_id: w.ws.id })).data;
  assert.ok(!attention.items.some((i) => i.kind === "promotion_checks_failing"), JSON.stringify(attention.items));
  assert.equal((await w.pg.query("SELECT stage FROM financial_products.app_promotions WHERE app_id = $1", [app.id])).rows[0].stage, "production", "nothing is taken offline");
  const full = await w.store.getApp(app.id);
  const next = await w.build(app.id);
  assert.deepEqual((await productionDeployBlockers(w.store, full, next)).map((c) => c.id), [REVIEW]);
  // Moved back to Staging, it meets the check like any other app on its way up.
  await w.pg.query("DELETE FROM financial_products.build_runs WHERE id = $1", [next]);
  await w.setStage(app.id, "staging");
  assert.equal(check(await checks(w, app), REVIEW).status, "fail");
});

test("an exception: only a Mynt admin outside the workspace, for one build, with a reason; audited and shown as it is", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await readyForProduction(w, app, b);
  const { id, sid } = await w.started(w.ana, app.id);
  await w.finish(sid, partial("refused", "the model refused the work", { model_refusal: { workflows: ["execute-scr"], count: 2, category: "cyber", request_ids: ["req_011Cxyz"] } }));
  assert.equal(check(await checks(w, app), REVIEW).status, "fail");

  const reason = "The model provider's safeguards refuse the security review (request req_011Cxyz); its approval is pending";
  // Not the workspace's own people, a Mynt admin among them; not without a reason; not for another app's build.
  assert.match((await w.cara.call("waive_production_review", { app_id: app.id, build_id: b, reason })).data.error, /You're a member of this app's workspace; a Mynt admin outside it records the exception/);
  assert.equal((await w.ada.call("waive_production_review", { app_id: app.id, build_id: b, reason: "ok" })).isError, true);
  const other = await w.newApp("Other");
  const theirs = await w.build(other.id);
  assert.match((await w.ada.call("waive_production_review", { app_id: app.id, build_id: theirs, reason })).data.error, /isn't a build of this app that passed Mynt's verification/);

  const waived = await w.ada.call("waive_production_review", { app_id: app.id, build_id: b, reason });
  assert.equal(waived.isError, false, JSON.stringify(waived.data));
  assert.equal(waived.data.waiver.reason, reason);
  assert.equal(waived.data.waiver.waived_by.name, "Ada");
  const [audit] = await w.audits("waive_production_review");
  assert.equal(audit.actor_id, w.ada.user.id);
  assert.deepEqual({ build_id: audit.details.build_id, reason: audit.details.reason, review_id: audit.details.review_id, review_status: audit.details.review_status, review_problem: audit.details.review_problem }, { build_id: b, reason, review_id: id, review_status: "refused", review_problem: "refused" });

  // Shown plainly on the promotion checks, never as an ordinary pass.
  const r = await checks(w, app);
  assert.equal(check(r, REVIEW).status, "pass");
  assert.match(check(r, REVIEW).detail, new RegExp(`^Waived by a Mynt admin: ${reason.replace(/[()]/g, "\\$&")} \\(Ada, \\d{4}-\\d{2}-\\d{2}\\)\\. No complete code review ran on build ${b.slice(0, 8)}; the last one ended refused$`));
  assert.equal(r.data.can_promote, true, JSON.stringify(r.data.checks.filter((c) => c.status !== "pass")));
  // And beside the reviews, for every member.
  const listed = (await w.mem.call("list_production_reviews", { app_id: app.id })).data;
  assert.deepEqual(listed.waivers.map((x) => [x.build_id, x.reason, x.waived_by.name]), [[b, reason, "Ada"]]);
  assert.equal((await w.mem.call("get_production_review", { id })).data.waiver.reason, reason);
  assert.equal((await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" })).data.promoted, true);
  const [promoted] = await w.audits("app_promoted");
  assert.match(promoted.details.checks.find((c) => c.id === REVIEW).detail, /^Waived by a Mynt admin/);

  // For that build only: the next build needs its own review or its own exception.
  const next = await w.build(app.id);
  const full = await w.store.getApp(app.id);
  assert.deepEqual((await productionDeployBlockers(w.store, full, next)).map((c) => c.id), [REVIEW]);
  // Nothing to waive on a build that passed.
  const passing = await w.started(w.ana, app.id, next);
  await w.finish(passing.sid, clean);
  assert.match((await w.ada.call("waive_production_review", { app_id: app.id, build_id: next, reason })).data.error, /already passed its production code review: there is nothing to waive/);
});

test("the workspace's monthly limits bound what its own people start; a Mynt admin's start isn't refused by them", async () => {
  const w = await setup({ PRODUCTION_REVIEW_WORKSPACE_MONTHLY: "2", PRODUCTION_REVIEW_WORKSPACE_MONTHLY_USD: "150" });
  const apps = [];
  for (const name of ["One", "Two", "Three"]) {
    const app = await w.newApp(name);
    await w.build(app.id);
    apps.push(app);
  }
  const first = await w.started(w.ana, apps[0].id);
  await w.finish(first.sid, partial("time", "ended at the time limit"), { model: 58.75, machine: 1.25 });
  let usage = (await w.ana.call("list_production_reviews", { app_id: apps[0].id })).data.workspace_usage;
  assert.equal(usage.reviews, 1);
  assert.equal(usage.usd, 60);
  // One in progress counts at its cap: 60 spent + 60 reserved + 60 more is over 150.
  const second = await w.ana.call("request_production_review", { app_id: apps[1].id });
  assert.equal(second.isError, false, JSON.stringify(second.data));
  usage = (await w.ana.call("list_production_reviews", { app_id: apps[1].id })).data.workspace_usage;
  assert.deepEqual({ reviews: usage.reviews, usd: usage.usd }, { reviews: 2, usd: 120 }, "a review waiting or running counts, at its cap");
  assert.match((await w.cara.call("list_production_reviews", { app_id: apps[1].id })).data.limits.workspace_monthly_reviews.toString(), /^2$/);
  // Stopped before it started: it doesn't count as one of the month's reviews, and frees its reservation.
  assert.equal((await w.ana.call("stop_production_review", { id: second.data.id })).data.status, "stopped");
  usage = (await w.ana.call("list_production_reviews", { app_id: apps[1].id })).data.workspace_usage;
  assert.deepEqual({ reviews: usage.reviews, usd: usage.usd }, { reviews: 1, usd: 60 });

  const again = await w.started(w.ana, apps[1].id);
  await w.finish(again.sid, partial("time", "ended at the time limit"), { model: 28.75, machine: 1.25 });
  // Two started this month: the count stops the third.
  const refused = await w.ana.call("request_production_review", { app_id: apps[2].id });
  assert.match(refused.data.error, /^This workspace has started 2 of its 2 production code reviews for [A-Z][a-z]+ \d{4} \(PRODUCTION_REVIEW_WORKSPACE_MONTHLY\)\. The count starts again on the 1st; before then, ask a Mynt admin/);
  // With room in the count, the dollars stop it: 90 spent, and one more may spend 60 of the 150.
  const roomy = await setup({ PRODUCTION_REVIEW_WORKSPACE_MONTHLY: "10", PRODUCTION_REVIEW_WORKSPACE_MONTHLY_USD: "100" });
  const a = await roomy.newApp("A");
  await roomy.build(a.id);
  const one = await roomy.started(roomy.ana, a.id);
  await roomy.finish(one.sid, partial("time", "ended at the time limit"), { model: 48.75, machine: 1.25 });
  assert.match((await roomy.ana.call("request_production_review", { app_id: a.id })).data.error, /have used US\$50\.00 of its US\$100 for .* and one more may spend up to US\$60 \(PRODUCTION_REVIEW_WORKSPACE_MONTHLY_USD\)/);

  // A Mynt admin's start is Mynt's own decision, and doesn't use up the workspace's.
  const byAdmin = await w.ada.call("request_production_review", { app_id: apps[2].id });
  assert.equal(byAdmin.isError, false, JSON.stringify(byAdmin.data));
  assert.equal(byAdmin.data.requested_by.mynt_admin, true);
  assert.equal((await w.ana.call("list_production_reviews", { app_id: apps[2].id })).data.workspace_usage.reviews, 2);
  // Earlier months don't count.
  await w.pg.query("UPDATE financial_products.production_reviews SET created_at = created_at - interval '40 days' WHERE NOT by_admin");
  await w.ada.call("stop_production_review", { id: byAdmin.data.id });
  assert.equal((await w.ana.call("request_production_review", { app_id: apps[2].id })).isError, false);
});

test("stop: owners, admins and Mynt admins; the sandbox ends, what was found and spent is kept, and it doesn't pass", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await readyForProduction(w, app, b);
  const { id, sid, sandbox } = await w.started(w.ana, app.id);
  w.sandboxes.write(sid, `${V}/maxwell.json`, partial("pending", "still running after 30 min"));
  sandbox.cost = 0.5;
  w.sandboxes.write(sid, `${A}/state.json`, { cost_usd: 7.5, last_subtype: null, done: false });
  assert.match((await w.mem.call("stop_production_review", { id })).data.error, /Only the workspace's owners and admins stop a production code review/);
  assert.match((await w.eve.call("stop_production_review", { id })).data.error, /No production code review of yours/);
  const stopped = (await w.ana.call("stop_production_review", { id })).data;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.reason, "Stopped by Ana before it finished");
  assert.equal(stopped.stopped_by.name, "Ana");
  assert.equal(stopped.cost_usd, 8, "measured as it was stopped");
  assert.deepEqual(stopped.findings, { critical: 0, high: 0, medium: 0, low: 1 });
  assert.equal(sandbox.stopped, true);
  assert.equal(sandbox.killed, true);
  assert.match((await w.ana.call("stop_production_review", { id })).data.error, /already ended \(stopped\)/);
  await w.reviews.tick();
  assert.equal((await w.row(id)).status, "stopped", "the worker leaves an ended review alone");
  const r = await checks(w, app);
  assert.equal(check(r, REVIEW).status, "fail");
  assert.match(check(r, REVIEW).detail, /^Stopped by Ana before it finished\. A stopped review doesn't count/);
  assert.equal((await w.audits("stop_production_review")).length, 1);
  // A Mynt admin stops any workspace's.
  const again = await w.started(w.ana, app.id);
  assert.equal((await w.ada.call("stop_production_review", { id: again.id })).data.reason, "Stopped by a Mynt admin before it finished");
});

test("reviews wait their turn: only so many run at once", async () => {
  const w = await setup({ PRODUCTION_REVIEW_CONCURRENCY: "1" });
  const ids = [];
  for (const name of ["One", "Two"]) {
    const app = await w.newApp(name);
    await w.build(app.id);
    ids.push((await w.ada.call("request_production_review", { app_id: app.id })).data.id);
  }
  await w.reviews.tick();
  assert.deepEqual([(await w.row(ids[0])).status, (await w.row(ids[1])).status], ["running", "queued"]);
  assert.equal(w.sandboxes.sandboxes.size, 1);
  await w.ada.call("stop_production_review", { id: ids[0] });
  await w.reviews.tick();
  assert.equal((await w.row(ids[1])).status, "running");
});

test("a service in Production: a new build takes over only with its own complete review", async () => {
  const w = await setup();
  const app = await w.newApp("Ledger sync");
  await w.pg.query("UPDATE financial_products.apps SET kind = 'service' WHERE id = $1", [app.id]);
  const b = await w.build(app.id);
  const blockers = await productionBlockers(w.store, app.id, b);
  assert.ok(blockers.some((x) => x.startsWith(`Production code review passed: No production code review of build ${b.slice(0, 8)} yet`)), JSON.stringify(blockers));
  const { sid } = await w.started(w.ada, app.id);
  assert.ok((await productionBlockers(w.store, app.id, b)).some((x) => /^Production code review passed: Mynt's code review of build .* is running/.test(x)));
  await w.finish(sid, clean);
  assert.ok(!(await productionBlockers(w.store, app.id, b)).some((x) => x.startsWith("Production code review passed")));
});

test("coverage is read from the report alone: what finished, what didn't and why", () => {
  assert.equal(reviewCoverage(null, ["execute-scr"]), null);
  assert.deepEqual(reviewCoverage({ workflows_run: ["execute-scr"], skipped: [{ workflow: "probe-cicd-env", kind: "time", reason: "ended at the  time limit" }] }, ["execute-scr", "probe-cicd-env", "other"]), {
    reviewed: ["execute-scr"],
    not_reviewed: [{ workflow: "probe-cicd-env", kind: "time", reason: "ended at the time limit" }, { workflow: "other", kind: null, reason: null }],
    progress: [],
  });
});
