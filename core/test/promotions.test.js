import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { BuildService, buildConfigFromEnv } from "../dist/builds.js";
import { HostingService } from "../dist/hosting.js";
import { SolanaService } from "../dist/solana/service.js";
import { seedAppStages } from "../dist/promotion-schema.js";
import { applyRegulatoryModel } from "../scripts/regulatory-model.mjs";
import { loadFixture, runSponsoredProduct } from "../scripts/sponsored-product.mjs";
import { CATALOG } from "./helpers.js";

// Promotion between stages and the workspace attention list. Every check is Mynt's own reading of its records, so
// these tests set those records (builds as the build service ends them, hosting as the VM reports it, keys, webhooks,
// programs) and read what the tools make of them.

const idleSandboxes = {
  async createSandbox() {
    return { id: "sbx", state: "provisioning" };
  },
  async getSandbox() {
    return undefined;
  },
  async stop() {},
  async readFile() {
    return null;
  },
  async exec() {
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  async costDollars() {
    return 0;
  },
};

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

async function setup(store0) {
  const pg = store0?.pg ?? new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = store0?.store ?? (await Store.open(db, CATALOG));
  await BuildService.open(db, store, idleSandboxes, null, { ...buildConfigFromEnv({}), publicUrl: "https://mynt.example.com", agentBackend: { kind: "anthropic", apiKey: "sk-ant-test" } });
  await HostingService.open(db, null, null);
  await SolanaService.open(db, store);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return caller(client);
  };
  const person = async (name, roles = ["developer"]) => {
    const { user } = await store.createUser(name, roles);
    const email = `${name.toLowerCase()}@example.com`;
    await pg.query("UPDATE financial_products.users SET email = $2 WHERE id = $1", [user.id, email]);
    return { user: { ...user, email }, call: await connect({ ...user, email }) };
  };
  const ana = await person("Ana"); // the workspace's owner
  const cara = await person("Cara", ["developer", "admin"]); // its admin, and a Mynt admin
  const mem = await person("Mem"); // a member
  const eve = await person("Eve"); // not in it
  const ada = await person("Ada", ["admin"]); // a Mynt admin outside it
  const ws = (await ana.call("create_workspace", { name: "Team" })).data;
  await pg.query("INSERT INTO financial_products.workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin'), ($1, $3, 'member')", [ws.id, cara.user.id, mem.user.id]);
  // With no products (an app built on none, as for most of these tests): made on one, then cleared.
  const newApp = async (name = "Saver", product_ids = []) => {
    const r = await ana.call("create_app", { name, description: `${name} app`, audience: "Savers", product_ids: product_ids.length ? product_ids : ["fixed-deposit"], workspace_id: ws.id });
    assert.ok(r.data.id, JSON.stringify(r.data));
    if (!product_ids.length) await pg.query("UPDATE financial_products.apps SET product_ids = '{}' WHERE id = $1", [r.data.id]);
    return { ...r.data, product_ids };
  };
  let clock = Date.now() - 3600_000;
  const build = async (appId, status = "succeeded", extra = {}) => {
    const id = randomUUID();
    clock += 1000;
    await pg.query(
      `INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd, source_sha256, maxwell, solana, error, created_at, updated_at, finished_at)
       VALUES ($1, $2, $3, 'build it', $4, 5, $5, $6, $7, $8, $9, $9, CASE WHEN $4 IN ('succeeded', 'blocked', 'failed', 'stopped', 'over_budget') THEN $9::timestamptz END)`,
      [id, ana.user.id, appId, status, "ab".repeat(32), extra.maxwell ? JSON.stringify(extra.maxwell) : null, extra.solana ?? false, extra.error ?? null, new Date(clock).toISOString()],
    );
    return id;
  };
  const host = async (appId, buildId, status = "running") => {
    let tenant = (await pg.query("SELECT id FROM financial_products.hosting_tenants WHERE workspace_id = $1", [ws.id])).rows[0]?.id;
    if (!tenant) {
      tenant = randomUUID();
      await pg.query("INSERT INTO financial_products.hosting_tenants (id, workspace_id, provider, status) VALUES ($1, $2, 'test', 'running')", [tenant, ws.id]);
    }
    await pg.query(
      `INSERT INTO financial_products.hosted_apps (app_id, tenant_id, build_id, repository, commit_sha, port, app_key_sealed, status)
       VALUES ($1, $2, $3, 'acme/app', $4, (SELECT COALESCE(max(port), 3000) + 1 FROM financial_products.hosted_apps), 'sealed', $5)
       ON CONFLICT (app_id) DO UPDATE SET build_id = EXCLUDED.build_id, status = EXCLUDED.status`,
      [appId, tenant, buildId, "c".repeat(40), status],
    );
  };
  const setStage = (appId, stage) =>
    pg.query("INSERT INTO financial_products.app_promotions (app_id, stage) VALUES ($1, $2) ON CONFLICT (app_id) DO UPDATE SET stage = EXCLUDED.stage", [appId, stage]);
  const liveKey = async (appId) => {
    await pg.query("UPDATE financial_products.apps SET status = 'published' WHERE id = $1", [appId]);
    return store.createApiKey(ana.user.id, { app_id: appId, environment: "live", label: "prod", allowed_origins: [] });
  };
  const program = (appId, cluster, status = "deployed") =>
    pg.query(
      "INSERT INTO financial_products.solana_programs (id, name, cluster, program_id, owner_id, app_id, status) VALUES ($1, 'vault', $2, $3, $4, $5, $6)",
      [randomUUID(), cluster, `prog${randomUUID().replace(/-/g, "").slice(0, 20)}`, ana.user.id, appId, status],
    );
  return { pg, db, store, ana, cara, mem, eve, ada, ws, newApp, build, host, setStage, liveKey, program, person };
}

const check = (r, id) => r.data.checks.find((c) => c.id === id);
// A build Mynt's independent audit passed (no critical or high findings).
const AUDITED = { maxwell: { counts: { critical: 0, high: 0, medium: 0, low: 0 } } };
const stageOf = async (call, appId) => (await call("list_my_apps")).data.find((a) => a.id === appId).stage;

test("who may: non-members are refused everything; members see checks but don't promote, demote or ask for sign-off; owners and admins do", async () => {
  const w = await setup();
  const app = await w.newApp();
  for (const [tool, args] of [
    ["get_promotion_checks", { app_id: app.id, to_stage: "staging" }],
    ["promote_app", { app_id: app.id, to_stage: "staging" }],
    ["demote_app", { app_id: app.id, to_stage: "idea", reason: "x" }],
    ["set_app_target_states", { app_id: app.id, states: ["us-ny"] }],
    ["request_promotion_signoff", { app_id: app.id }],
  ])
    assert.match((await w.eve.call(tool, args)).data.error, /No app of yours/, tool);
  assert.match((await w.eve.call("get_workspace_attention", { workspace_id: w.ws.id })).data.error, /No workspace of yours/);
  assert.match((await w.eve.call("get_promotion_checks", { app_id: "not-a-uuid", to_stage: "staging" })).data.error, /No app of yours/);

  const b = await w.build(app.id);
  const seen = await w.mem.call("get_promotion_checks", { app_id: app.id, to_stage: "staging" });
  assert.equal(seen.isError, false, JSON.stringify(seen.data));
  assert.equal(seen.data.can_promote, true);
  for (const [tool, args] of [
    ["promote_app", { app_id: app.id, to_stage: "staging" }],
    ["demote_app", { app_id: app.id, to_stage: "idea", reason: "x" }],
    ["set_app_target_states", { app_id: app.id, states: ["us-ny"] }],
    ["request_promotion_signoff", { app_id: app.id }],
  ])
    assert.match((await w.mem.call(tool, args)).data.error, /Only the workspace's owners and admins/, tool);
  assert.equal((await w.mem.call("get_workspace_attention", { workspace_id: w.ws.id })).isError, false);
  // Only Mynt admins see and decide sign-offs.
  assert.equal((await w.ana.call("list_promotion_signoffs")).isError, true);
  assert.equal((await w.ada.call("list_promotion_signoffs")).isError, false);

  // The workspace's admin promotes; the owner demotes.
  const p = await w.cara.call("promote_app", { app_id: app.id, to_stage: "staging" });
  assert.equal(p.isError, false, JSON.stringify(p.data));
  assert.equal(p.data.promoted, true);
  assert.equal(await stageOf(w.mem.call, app.id), "staging");
  const d = await w.ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "back to the drawing board" });
  assert.equal(d.isError, false, JSON.stringify(d.data));
  assert.equal(await stageOf(w.ana.call, app.id), "idea");
  assert.ok(b);
});

test("staging checks: a build Mynt verified, its audit, that it runs; pending is never pass, and only one step at a time", async () => {
  const w = await setup();
  const app = await w.newApp();
  const get = () => w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "staging" });
  let r = await get();
  assert.equal(r.data.from_stage, "idea");
  assert.equal(r.data.to_stage, "staging");
  assert.deepEqual(r.data.checks.map((c) => c.id), ["build_verified", "audit_passed", "app_runs"]);
  assert.equal(check(r, "build_verified").status, "fail");
  assert.equal(check(r, "build_verified").fix.tool, "start_build");
  assert.equal(check(r, "audit_passed").status, "pending");
  assert.equal(check(r, "app_runs").status, "pending");
  assert.equal(r.data.can_promote, false);
  assert.equal(r.data.needs_admin_signoff, false);
  assert.match((await w.ana.call("promote_app", { app_id: app.id, to_stage: "staging" })).data.error, /Not promoted: Latest build verified by Mynt \(fail\)/);
  // One step at a time.
  assert.match((await w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "production" })).data.error, /one step at a time/);

  // A build still going: pending, not fail.
  const running = await w.build(app.id, "verifying");
  r = await get();
  assert.equal(check(r, "build_verified").status, "pending");
  assert.match(check(r, "build_verified").detail, /verifying/);
  await w.pg.query("UPDATE financial_products.build_runs SET status = 'failed', finished_at = updated_at WHERE id = $1", [running]);

  // A build Mynt verified with no independent audit required: passes; not hosted: a warning that doesn't block.
  const b1 = await w.build(app.id, "succeeded");
  r = await get();
  assert.equal(check(r, "build_verified").status, "pass");
  assert.match(check(r, "build_verified").detail, new RegExp(b1.slice(0, 8)));
  assert.equal(check(r, "audit_passed").status, "pass");
  assert.match(check(r, "audit_passed").detail, /Not required/);
  assert.equal(check(r, "app_runs").status, "warn");
  assert.equal(r.data.can_promote, true);

  // Audited: critical or high findings fail it.
  await w.pg.query("UPDATE financial_products.build_runs SET maxwell = $2 WHERE id = $1", [b1, JSON.stringify({ counts: { critical: 0, high: 1, medium: 2 } })]);
  r = await get();
  assert.equal(check(r, "audit_passed").status, "fail");
  assert.equal(r.data.can_promote, false);
  await w.pg.query("UPDATE financial_products.build_runs SET maxwell = $2 WHERE id = $1", [b1, JSON.stringify({ counts: { critical: 0, high: 0, medium: 2, low: 1 } })]);
  r = await get();
  assert.equal(check(r, "audit_passed").status, "pass");
  assert.match(check(r, "audit_passed").detail, /medium 2, low 1/);

  // A newer build that failed: shown, not blocking.
  await w.build(app.id, "failed", { error: "Not production-ready: tests" });
  r = await get();
  assert.equal(check(r, "build_verified").status, "warn");
  assert.match(check(r, "build_verified").detail, /ended failed/);

  // Hosted: deploying is pending, stopped fails, running passes.
  await w.host(app.id, b1, "deploying");
  r = await get();
  assert.equal(check(r, "app_runs").status, "pending");
  assert.equal(r.data.can_promote, false);
  await w.host(app.id, b1, "stopped");
  assert.equal(check(await get(), "app_runs").status, "fail");
  await w.host(app.id, b1, "running");
  r = await get();
  assert.equal(check(r, "app_runs").status, "pass");
  assert.equal(r.data.can_promote, true);

  // Promoted: the stage moves, and the audit trail has the snapshot it passed with.
  const p = await w.ana.call("promote_app", { app_id: app.id, to_stage: "staging" });
  assert.equal(p.data.promoted, true, JSON.stringify(p.data));
  assert.equal(await stageOf(w.ana.call, app.id), "staging");
  const audit = (await w.pg.query("SELECT actor_id, details FROM financial_products.audit_log WHERE action = 'app_promoted' AND target = $1", [app.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, w.ana.user.id);
  assert.equal(audit[0].details.from_stage, "idea");
  assert.equal(audit[0].details.to_stage, "staging");
  assert.equal(audit[0].details.build_id, b1);
  assert.deepEqual(audit[0].details.checks.map((c) => c.id), ["build_verified", "audit_passed", "app_runs"]);
  assert.match((await w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "staging" })).data.error, /already in staging/);
});

test("promotion checks again at that moment: what changed after someone looked stops it", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await w.host(app.id, b, "running");
  const looked = await w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "staging" });
  assert.equal(looked.data.can_promote, true);
  // The deployment stops between the look and the promotion.
  await w.host(app.id, b, "stopped");
  const r = await w.ana.call("promote_app", { app_id: app.id, to_stage: "staging" });
  assert.equal(r.isError, true);
  assert.match(r.data.error, /App builds and runs \(fail\)/);
  assert.equal(await stageOf(w.ana.call, app.id), "idea");
  assert.equal((await w.pg.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'app_promoted'")).rows[0].n, 0);
});

test("production checks: hosting, a live key, webhooks verified, no open findings, the program gate", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await w.setStage(app.id, "staging");
  const get = () => w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "production" });
  let r = await get();
  assert.equal(r.data.from_stage, "staging");
  assert.deepEqual(r.data.checks.map((c) => c.id), ["build_verified", "audit_passed", "hosting_healthy", "licences", "webhooks", "audit_findings", "program_gate"]);
  assert.equal(check(r, "hosting_healthy").status, "fail", "production runs on Mynt's hosting");
  // No target states: production fails it, even for an app on no regulated products.
  assert.equal(check(r, "licences").status, "fail");
  assert.match(check(r, "licences").detail, /Set the states this app serves/);
  assert.equal(check(r, "licences").fix.tool, "set_app_target_states");
  assert.equal(check(r, "webhooks").status, "pass");
  // No independent audit ran: no findings to read, so a warning (advisory for an app that moves no value), never a pass.
  assert.equal(check(r, "audit_passed").status, "warn");
  assert.equal(check(r, "audit_findings").status, "warn");
  assert.equal(check(r, "program_gate").status, "pass");
  assert.match(check(r, "program_gate").detail, /Not applicable/);
  assert.equal(r.data.needs_admin_signoff, false);
  assert.deepEqual(r.data.signoff, { status: "none" });
  assert.equal(r.data.can_promote, false);

  await w.host(app.id, b, "running");
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
  r = await get();
  assert.equal(check(r, "hosting_healthy").status, "pass");
  assert.equal(check(r, "licences").status, "pass");
  assert.equal(r.data.can_promote, true, JSON.stringify(r.data.checks.filter((c) => c.status !== "pass")));

  // Production promotes what runs: a newer verified build that isn't deployed fails hosting (not a warning).
  const newer = await w.build(app.id);
  r = await get();
  assert.equal(check(r, "hosting_healthy").status, "fail");
  assert.match(check(r, "hosting_healthy").detail, new RegExp(`not the latest verified build ${newer.slice(0, 8)}`));
  assert.equal(r.data.can_promote, false);
  await w.host(app.id, newer, "running");
  assert.equal((await get()).data.can_promote, true);

  // A webhook: pending until a delivery reaches it; failing or off fails; a secret nobody in the workspace holds fails.
  const { webhook } = await w.store.createWebhook(w.ana.user.id, { app_id: app.id, url: "https://hooks.example.com/a", events: ["handoff.completed"] });
  r = await get();
  assert.equal(check(r, "webhooks").status, "pending");
  assert.equal(r.data.can_promote, false);
  const deliver = (status) =>
    w.pg.query(
      "INSERT INTO financial_products.webhook_deliveries (id, webhook_id, event_id, type, payload, sandbox, status, created_at) VALUES (gen_random_uuid(), $1, gen_random_uuid(), 't', '{}', true, $2, clock_timestamp())",
      [webhook.id, status],
    );
  await deliver("delivered");
  assert.equal(check(await get(), "webhooks").status, "pass");
  await deliver("failed");
  assert.equal(check(await get(), "webhooks").status, "fail");
  await deliver("delivered");
  await w.store.rotateWebhookSecret(webhook.id, null);
  r = await get();
  assert.equal(check(r, "webhooks").status, "fail");
  assert.match(check(r, "webhooks").detail, /no current member holds its signing secret/);
  await w.store.rotateWebhookSecret(webhook.id, w.ana.user.id);
  await w.pg.query("UPDATE financial_products.webhooks SET disabled_at = now() WHERE id = $1", [webhook.id]);
  assert.equal(check(await get(), "webhooks").status, "fail");
  await w.pg.query("UPDATE financial_products.webhooks SET disabled_at = NULL WHERE id = $1", [webhook.id]);
  assert.equal(check(await get(), "webhooks").status, "pass");

  // A newer build blocked on critical findings: open blocking findings, though the verified build had none.
  const blocked = await w.build(app.id, "blocked", { maxwell: { counts: { critical: 1, high: 0 } }, error: "Security gate: 1 critical/high Maxwell finding(s)" });
  r = await get();
  assert.equal(check(r, "audit_findings").status, "fail");
  assert.match(check(r, "audit_findings").detail, new RegExp(blocked.slice(0, 8)));
  await w.pg.query("UPDATE financial_products.build_runs SET status = 'stopped', maxwell = NULL, error = NULL WHERE id = $1", [blocked]);
  assert.equal(check(await get(), "audit_findings").status, "warn");

  // Programs: devnet only fails the gate; on mainnet, a review in progress is pending, deployed passes and needs sign-off.
  await w.program(app.id, "devnet");
  r = await get();
  assert.equal(check(r, "program_gate").status, "fail");
  assert.match(check(r, "program_gate").detail, /devnet only/);
  await w.program(app.id, "mainnet", "reserved");
  r = await get();
  assert.equal(check(r, "program_gate").status, "fail");
  await w.pg.query("UPDATE financial_products.solana_programs SET status = 'deployed' WHERE cluster = 'mainnet'");
  r = await get();
  assert.equal(check(r, "program_gate").status, "pass");
  assert.equal(r.data.needs_admin_signoff, true);
  assert.equal(check(r, "admin_signoff").status, "fail");
  assert.equal(check(r, "admin_signoff").fix.tool, "request_promotion_signoff");
  assert.equal(r.data.can_promote, false);
});

test("sign-off: owners and admins ask, another Mynt admin decides, for that build only; a new build needs a new one", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b1 = await w.build(app.id, "succeeded", AUDITED);
  await w.setStage(app.id, "staging");
  await w.host(app.id, b1);
  await w.program(app.id, "mainnet");
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
  const get = () => w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "production" });
  assert.equal((await get()).data.needs_admin_signoff, true);
  // An app that needs none can't ask.
  const plain = await w.newApp("Plain");
  await w.build(plain.id);
  await w.setStage(plain.id, "staging");
  assert.match((await w.ana.call("request_promotion_signoff", { app_id: plain.id })).data.error, /doesn't need/);

  // The workspace's admin (a Mynt admin too) asks: pending; they can't decide their own request.
  const asked = await w.cara.call("request_promotion_signoff", { app_id: app.id });
  assert.equal(asked.isError, false, JSON.stringify(asked.data));
  assert.equal(asked.data.signoff.build_id, b1);
  assert.equal(asked.data.signoff.source_sha256, "ab".repeat(32));
  const again = await w.ana.call("request_promotion_signoff", { app_id: app.id });
  assert.equal(again.data.already, true);
  assert.equal(again.data.signoff.id, asked.data.signoff.id);
  let r = await get();
  assert.equal(r.data.signoff.status, "requested");
  assert.equal(r.data.signoff.by, w.cara.user.id);
  assert.equal(check(r, "admin_signoff").status, "pending");
  const listed = (await w.ada.call("list_promotion_signoffs", { status: "requested" })).data.signoffs;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].current, true);
  assert.equal(listed[0].app_name, "Saver");
  assert.match((await w.cara.call("decide_promotion_signoff", { id: asked.data.signoff.id, approve: true })).data.error, /another Mynt admin decides/);

  // Another admin approves: it passes, and the app goes to production.
  const ok = await w.ada.call("decide_promotion_signoff", { id: asked.data.signoff.id, approve: true, note: "Reviewed" });
  assert.equal(ok.data.status, "approved", JSON.stringify(ok.data));
  r = await get();
  assert.deepEqual({ status: r.data.signoff.status, by: r.data.signoff.by }, { status: "approved", by: w.ada.user.id });
  assert.equal(check(r, "admin_signoff").status, "pass");
  assert.equal(r.data.can_promote, true, JSON.stringify(r.data.checks.filter((c) => c.status !== "pass")));
  assert.match((await w.ada.call("decide_promotion_signoff", { id: asked.data.signoff.id, approve: false })).data.error, /already approved/);

  // A new verified build: the sign-off was for b1, so none for this one.
  const b2 = await w.build(app.id, "succeeded", AUDITED);
  await w.host(app.id, b2);
  r = await get();
  assert.equal(r.data.signoff.status, "none");
  assert.equal(check(r, "admin_signoff").status, "fail");
  assert.match(check(r, "admin_signoff").detail, new RegExp(`last one was for build ${b1.slice(0, 8)}`));
  assert.equal(r.data.can_promote, false);
  assert.match((await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" })).data.error, /Mynt admin sign-off \(fail\)/);

  // Asked for b2, then b3 lands before anyone decides: the decision is refused and the request is superseded.
  const ask2 = (await w.ana.call("request_promotion_signoff", { app_id: app.id })).data.signoff;
  assert.equal(ask2.build_id, b2);
  const b3 = await w.build(app.id, "succeeded", AUDITED);
  const stale = await w.ada.call("decide_promotion_signoff", { id: ask2.id, approve: true });
  assert.match(stale.data.error, /newer build, or a change to its programs or money rails, replaced/);
  assert.equal((await w.pg.query("SELECT status FROM financial_products.promotion_signoffs WHERE id = $1", [ask2.id])).rows[0].status, "superseded");

  // A rejection fails the check; asked again and approved for b3, the promotion goes through.
  await w.host(app.id, b3);
  const ask3 = (await w.ana.call("request_promotion_signoff", { app_id: app.id })).data.signoff;
  await w.ada.call("decide_promotion_signoff", { id: ask3.id, approve: false, note: "Show the vault's limits" });
  r = await get();
  assert.equal(r.data.signoff.status, "rejected");
  assert.match(check(r, "admin_signoff").detail, /Show the vault's limits/);
  const ask4 = (await w.ana.call("request_promotion_signoff", { app_id: app.id })).data.signoff;
  // A Mynt admin who is in the app's workspace (here its admin) never decides it, even someone else's request.
  assert.match((await w.cara.call("decide_promotion_signoff", { id: ask4.id, approve: true })).data.error, /member of this app's workspace/);
  await w.ada.call("decide_promotion_signoff", { id: ask4.id, approve: true });
  const p = await w.ana.call("promote_app", { app_id: app.id, to_stage: "production" });
  assert.equal(p.data.promoted, true, JSON.stringify(p.data));
  assert.equal(await stageOf(w.ana.call, app.id), "production");
  const audit = (await w.pg.query("SELECT details FROM financial_products.audit_log WHERE action = 'app_promoted' AND target = $1", [app.id])).rows[0].details;
  assert.equal(audit.signoff.status, "approved");
  assert.equal(audit.build_id, b3);
  assert.equal(audit.hosted_build_id, b3, "the build that runs is the one signed off");
  assert.equal(audit.source_sha256, "ab".repeat(32));
  const stored = (await w.pg.query("SELECT build_id::text AS b, hosted_build_id::text AS h, source_sha256 FROM financial_products.app_promotions WHERE app_id = $1", [app.id])).rows[0];
  assert.deepEqual(stored, { b: b3, h: b3, source_sha256: "ab".repeat(32) });
});

test("demotion: owners and admins, one step down, always allowed, with the reason in the audit trail", async () => {
  const w = await setup();
  const app = await w.newApp();
  await w.setStage(app.id, "production");
  assert.match((await w.ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "x" })).data.error, /one step at a time/);
  assert.match((await w.mem.call("demote_app", { app_id: app.id, to_stage: "staging", reason: "x" })).data.error, /owners and admins/);
  const d = await w.ana.call("demote_app", { app_id: app.id, to_stage: "staging", reason: "Licence lapsed in New York" });
  assert.deepEqual(d.data, { app_id: app.id, from_stage: "production", to_stage: "staging", reason: "Licence lapsed in New York" });
  assert.equal((await w.cara.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "Rework" })).isError, false);
  assert.match((await w.ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "x" })).data.error, /first stage/);
  const rows = (await w.pg.query("SELECT actor_id, details FROM financial_products.audit_log WHERE action = 'app_demoted' ORDER BY created_at")).rows;
  assert.deepEqual(
    rows.map((r) => [r.actor_id, r.details.from_stage, r.details.to_stage, r.details.reason]),
    [
      [w.ana.user.id, "production", "staging", "Licence lapsed in New York"],
      [w.cara.user.id, "staging", "idea", "Rework"],
    ],
  );
});

test("stages: a new app starts as an idea however far its builds get; apps from before promotions keep the stage they had", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await w.host(app.id, b);
  await w.pg.query("UPDATE financial_products.apps SET status = 'published' WHERE id = $1", [app.id]);
  assert.equal(await stageOf(w.ana.call, app.id), "idea");
  const other = await w.newApp("Built");
  await w.build(other.id);
  // As if these apps were there before promotions: the seed gives each the stage Mynt derived, once.
  await w.pg.query("DELETE FROM financial_products.app_promotions_seeded");
  assert.equal(await seedAppStages(w.db), 2);
  assert.equal(await stageOf(w.ana.call, app.id), "production");
  assert.equal(await stageOf(w.ana.call, other.id), "staging");
  assert.equal(await seedAppStages(w.db), 0);
});

test("target states: US states only, owners and admins", async () => {
  const w = await setup();
  const app = await w.newApp();
  assert.match((await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-zz"] })).data.error, /Not a US state/);
  const r = await w.ana.call("set_app_target_states", { app_id: app.id, states: ["US-NY", "us-ca", "us-ny"] });
  assert.deepEqual(r.data, { app_id: app.id, target_states: ["us-ca", "us-ny"] });
  assert.equal(await stageOf(w.ana.call, app.id), "idea", "setting states doesn't move it");
});

test("attention: for the caller's role in that workspace only", async () => {
  const w = await setup();
  const app = await w.newApp();
  const items = async (who) => (await who.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items;
  const kinds = async (who) => (await items(who)).map((i) => i.kind).sort();
  assert.deepEqual(await kinds(w.ana), []);

  // A failed and a blocked build (latest per app; a later success clears it).
  const failedApp = await w.newApp("Failing");
  await w.build(failedApp.id, "failed", { error: "Not production-ready: tests" });
  await w.build(app.id, "blocked", { error: "Waiting for an admin to approve access to acme/app; no pull request was opened" });
  // The caller's own repository connection waiting for an admin.
  await w.pg.query("INSERT INTO financial_products.app_repositories (app_id, repository, managed) VALUES ($1, 'acme/app', false)", [app.id]);
  await w.pg.query("INSERT INTO financial_products.repo_connections (developer_id, repository, installation_id, approval) VALUES ($1, 'acme/app', 1, 'pending_approval')", [w.mem.user.id]);
  // A production app whose checks now fail (not hosted, no live key).
  const live = await w.newApp("Live");
  await w.build(live.id);
  await w.setStage(live.id, "production");
  // Owner-only: a failed offboarding, a webhook whose secret nobody here holds, a decided sign-off.
  await w.pg.query("INSERT INTO financial_products.workspace_offboards (workspace_id, user_id, status, error) VALUES ($1, $2, 'failed', 'VM provider down')", [w.ws.id, w.eve.user.id]);
  const { webhook } = await w.store.createWebhook(w.ana.user.id, { app_id: app.id, url: "https://hooks.example.com/a", events: ["handoff.completed"] });
  await w.store.rotateWebhookSecret(webhook.id, null);
  const sid = randomUUID();
  await w.pg.query(
    "INSERT INTO financial_products.promotion_signoffs (id, app_id, workspace_id, build_id, status, requested_by, decided_by, decided_at, note) VALUES ($1, $2, $3, $4, 'rejected', $5, $6, now(), 'No')",
    [sid, live.id, w.ws.id, randomUUID(), w.ana.user.id, w.ada.user.id],
  );
  const asked = randomUUID();
  await w.pg.query("INSERT INTO financial_products.promotion_signoffs (id, app_id, workspace_id, build_id, status, requested_by) VALUES ($1, $2, $3, $4, 'requested', $5)", [
    asked,
    failedApp.id,
    w.ws.id,
    randomUUID(),
    w.ana.user.id,
  ]);

  // Another workspace's trouble never shows here.
  const theirs = (await w.eve.call("create_workspace", { name: "Elsewhere" })).data;
  const theirApp = (await w.eve.call("create_app", { name: "Theirs", description: "d", audience: "a", product_ids: ["fixed-deposit"], workspace_id: theirs.id })).data;
  await w.pg.query("INSERT INTO financial_products.build_runs (id, developer_id, app_id, goal, status, cap_usd, finished_at) VALUES ($1, $2, $3, 'g', 'failed', 5, now())", [randomUUID(), w.eve.user.id, theirApp.id]);

  assert.deepEqual(await kinds(w.mem), ["build_blocked", "build_failed", "promotion_checks_failing", "repository_approval_pending"]);
  assert.deepEqual(await kinds(w.ana), ["build_blocked", "build_failed", "offboard_failed", "promotion_checks_failing", "signoff_decided", "signoff_requested", "webhook_secret_rotation"]);
  // The workspace's admin is a Mynt admin too, but nobody in the workspace decides its sign-offs: never shown as awaiting them.
  assert.deepEqual(await kinds(w.cara), ["build_blocked", "build_failed", "offboard_failed", "promotion_checks_failing", "signoff_decided", "signoff_requested", "webhook_secret_rotation"]);
  const all = await items(w.cara);
  assert.ok(all.every((i) => ["high", "medium", "low"].includes(i.severity) && i.href.startsWith("/") && !Number.isNaN(Date.parse(i.at)) && i.id && i.title && i.detail));
  const rank = { high: 0, medium: 1, low: 2 };
  assert.deepEqual(all.map((i) => rank[i.severity]), [...all.map((i) => rank[i.severity])].sort(), "most severe first");
  assert.equal(all.find((i) => i.kind === "promotion_checks_failing").href, `/${live.id}`);
  assert.equal(all.find((i) => i.kind === "offboard_failed").href, "/workspace?tab=members");
  assert.ok(!JSON.stringify(all).includes(theirApp.id));
  assert.match((await items(w.mem)).find((i) => i.kind === "repository_approval_pending").title, /acme\/app/, "the member's own pending connection");
  assert.equal((await items(w.ana)).some((i) => i.kind === "repository_approval_pending"), false, "only the caller's own connections");
  assert.match((await w.ana.call("get_workspace_attention", { workspace_id: theirs.id })).data.error, /No workspace of yours/);
  // A later success clears a failed build.
  await w.build(failedApp.id);
  assert.equal((await kinds(w.mem)).includes("build_failed"), false);
});

test("apps that need sign-off need the independent audit; an approval lapses when its programs or rails change; requests only for the build that runs", async () => {
  const w = await setup();
  const app = await w.newApp();
  const unaudited = await w.build(app.id);
  await w.setStage(app.id, "staging");
  await w.host(app.id, unaudited);
  await w.program(app.id, "mainnet");
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
  const get = () => w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "production" });
  let r = await get();
  assert.equal(r.data.needs_admin_signoff, true);
  assert.equal(check(r, "audit_passed").status, "fail", "moves value: no audit fails");
  assert.equal(check(r, "audit_findings").status, "fail");

  // An audited build, verified but not deployed yet: no sign-off can be asked for it.
  const audited = await w.build(app.id, "succeeded", AUDITED);
  assert.match((await w.ana.call("request_promotion_signoff", { app_id: app.id })).data.error, /deploy build .* first/);
  await w.host(app.id, audited);
  r = await get();
  assert.equal(check(r, "audit_passed").status, "pass");
  assert.equal(check(r, "audit_findings").status, "pass");
  const asked = (await w.ana.call("request_promotion_signoff", { app_id: app.id })).data.signoff;
  assert.equal(asked.basis.programs.length, 1);
  assert.match(asked.basis.programs[0], /^mainnet:prog/);
  await w.ada.call("decide_promotion_signoff", { id: asked.id, approve: true });
  r = await get();
  assert.equal(check(r, "admin_signoff").status, "pass");
  assert.equal(r.data.can_promote, true, JSON.stringify(r.data.checks.filter((c) => c.status !== "pass")));

  // Another mainnet program, same build: the approval no longer counts, and owners are told.
  await w.program(app.id, "mainnet");
  r = await get();
  assert.equal(r.data.signoff.status, "none");
  assert.equal(check(r, "admin_signoff").status, "fail");
  assert.match(check(r, "admin_signoff").detail, /changed since it was approved/);
  assert.equal(r.data.can_promote, false);
  const att = (await w.ana.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items;
  assert.ok(att.some((i) => i.kind === "signoff_stale" && i.href === `/${app.id}`), JSON.stringify(att));
  assert.equal((await w.mem.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items.some((i) => i.kind === "signoff_stale"), false);

  // Asked again: a new request (the stale approval is superseded). A change before the decision makes it moot too.
  const again = await w.ana.call("request_promotion_signoff", { app_id: app.id });
  assert.equal(again.data.already, false, JSON.stringify(again.data));
  assert.equal((await w.pg.query("SELECT status FROM financial_products.promotion_signoffs WHERE id = $1", [asked.id])).rows[0].status, "superseded");
  await w.pg.query("UPDATE financial_products.solana_programs SET cluster = 'devnet' WHERE id = (SELECT id FROM financial_products.solana_programs WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1)", [app.id]);
  assert.match((await w.ada.call("decide_promotion_signoff", { id: again.data.signoff.id, approve: true })).data.error, /change to its programs or money rails/);
});

test("attention: a production app with no target states, or that lost licence coverage, is flagged", async () => {
  const w = await setup();
  const app = await w.newApp("Live");
  const b = await w.build(app.id);
  await w.host(app.id, b);
  await w.setStage(app.id, "production");
  const failing = async () => (await w.mem.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items.find((i) => i.kind === "promotion_checks_failing");
  assert.match((await failing()).detail, /Set the states this app serves/);
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
  assert.equal(await failing(), undefined, "advisory warnings alone don't flag it");
});

test("frozen or archiving workspaces: no stage changes or sign-off requests, and everyone is told; join requests go to owners and admins", async () => {
  const w = await setup();
  const app = await w.newApp();
  const b = await w.build(app.id);
  await w.host(app.id, b);
  const kinds = async (who) => (await who.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items.map((i) => i.kind);

  // Someone not on Mynt joined the organization: owners and admins see it, members don't.
  await w.pg.query("INSERT INTO financial_products.workspace_join_requests (workspace_id, subject, email) VALUES ($1, 'user_ext', 'newcomer@example.com')", [w.ws.id]);
  assert.ok((await kinds(w.ana)).includes("join_request"));
  assert.ok((await kinds(w.cara)).includes("join_request"));
  assert.equal((await kinds(w.mem)).includes("join_request"), false);

  // Frozen: its organization deleted in the identity provider.
  await w.pg.query("UPDATE financial_products.workspaces SET org_missing_at = now() WHERE id = $1", [w.ws.id]);
  assert.equal((await w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "staging" })).data.can_promote, true, "the checks still read");
  assert.match((await w.ana.call("promote_app", { app_id: app.id, to_stage: "staging" })).data.error, /frozen/);
  await w.setStage(app.id, "staging");
  await w.program(app.id, "mainnet");
  assert.match((await w.ana.call("request_promotion_signoff", { app_id: app.id })).data.error, /frozen/);
  assert.match((await w.ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "x" })).data.error, /frozen/);
  const frozen = (await w.mem.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items[0];
  assert.deepEqual([frozen.kind, frozen.severity], ["workspace_frozen", "high"]);

  // Being archived: the same, until it's undone.
  await w.pg.query("UPDATE financial_products.workspaces SET org_missing_at = NULL, archived_at = now(), archive_offboard_at = now() + interval '7 days' WHERE id = $1", [w.ws.id]);
  assert.match((await w.ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "x" })).data.error, /archived/);
  const archiving = (await w.mem.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items[0];
  assert.deepEqual([archiving.kind, archiving.severity], ["workspace_archiving", "high"]);
  assert.equal((await kinds(w.mem)).includes("workspace_frozen"), false);
  await w.pg.query("UPDATE financial_products.workspaces SET archived_at = NULL, archive_offboard_at = NULL WHERE id = $1", [w.ws.id]);
  assert.equal((await w.ana.call("demote_app", { app_id: app.id, to_stage: "idea", reason: "x" })).isError, false);
  assert.equal((await w.pg.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'app_demoted'")).rows[0].n, 1, "only the one after it was undone");
});

// ---- licences, against a real sponsored US product (as workspace-compliance.test.js builds it) ----

process.env.SPONSOR_LEGITIMACY_RULE = "off";
const MODEL = JSON.parse(readFileSync(new URL("../schemas/regulatory/us.json", import.meta.url), "utf8"));
const PRODUCT = "example-dollar-transfer";

test("licences: every product covered by a licence in force in each target state; money rails need sign-off; expiring licences are flagged", async () => {
  const pg = new PGlite();
  const store = await Store.open({ query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() }, CATALOG);
  const sessionOf = async (u) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, u).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return { client, call: caller(client) };
  };
  const { user: modelAdmin } = await store.createUser("Root", ["admin"]);
  const root = await sessionOf(modelAdmin);
  assert.equal((await applyRegulatoryModel({ call: root.call, listTools: async () => (await root.client.listTools()).tools, model: MODEL })).applied, true);
  const fixture = loadFixture();
  const lp = await store.upsertClerkUser("clerk_lp", fixture.licence_provider.member_email, "Lena", ["license_provider"]);
  const { user: builder } = await store.createUser("Neo", ["developer"]);
  const sessions = { admin: root.call, licence_provider: (await sessionOf(lp)).call, builder: (await sessionOf(builder)).call };
  const run = await runSponsoredProduct({ call: (n, i, actor) => sessions[actor](n, i), staging: true });
  assert.equal(run.done, true, JSON.stringify(run));

  const w = await setup({ pg, store });
  const app = await w.newApp("Dollar transfers", [PRODUCT]);
  const b = await w.build(app.id);
  await w.setStage(app.id, "staging");
  await w.host(app.id, b);
  const get = () => w.ana.call("get_promotion_checks", { app_id: app.id, to_stage: "production" });
  // No target states: production can't say where it serves, so it fails (even though New York and California are covered).
  let r = await get();
  assert.equal(check(r, "licences").status, "fail", JSON.stringify(check(r, "licences")));
  assert.equal(r.data.can_promote, false);
  assert.equal(check(r, "licences").fix.tool, "set_app_target_states");
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny", "us-ca"] });
  r = await get();
  assert.equal(check(r, "licences").status, "pass", check(r, "licences").detail);
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny", "us-tx"] });
  r = await get();
  assert.equal(check(r, "licences").status, "fail");
  assert.match(check(r, "licences").detail, /isn't covered in Texas/);
  // New York's licence suspended: not covered there any more.
  await w.ana.call("set_app_target_states", { app_id: app.id, states: ["us-ny"] });
  const ny = (await pg.query("SELECT id::text AS id FROM financial_products.held_licenses WHERE entity_id = $1 AND license_id = 'nydfs_money_transmitter'", [run.provider_entity_id])).rows[0];
  await pg.query("UPDATE financial_products.held_licenses SET status = 'suspended' WHERE id = $1", [ny.id]);
  assert.equal(check(await get(), "licences").status, "fail");
  await pg.query("UPDATE financial_products.held_licenses SET status = 'verified' WHERE id = $1", [ny.id]);
  r = await get();
  assert.equal(check(r, "licences").status, "pass");
  assert.equal(r.data.needs_admin_signoff, false);

  // The sponsoring firm's approved money rail: the app moves money, so an admin signs off.
  await pg.query(
    `INSERT INTO financial_products.money_rails (id, entity_id, kind, provider, direction, states, per_transfer_limit_cents, daily_limit_cents, status)
     VALUES ($1, $2, 'ach', 'bank-co', 'deposit', '{us-ny}', 1000, 10000, 'approved')`,
    [randomUUID(), run.provider_entity_id],
  );
  r = await get();
  assert.equal(r.data.needs_admin_signoff, true);
  assert.match(check(r, "admin_signoff").detail, /moves money/);

  // A licence lapsing within 30 days shows in every member's attention list.
  const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
  await pg.query("UPDATE financial_products.held_licenses SET valid_to = $2 WHERE id = $1", [ny.id, soon]);
  const att = (await w.mem.call("get_workspace_attention", { workspace_id: w.ws.id })).data.items;
  const exp = att.find((i) => i.kind === "licence_expiring");
  assert.ok(exp, JSON.stringify(att));
  assert.equal(exp.href, "/licences");
  assert.equal(exp.severity, "medium");
});
