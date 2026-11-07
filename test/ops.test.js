import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { HostingService } from "../dist/hosting.js";
import { backupStatus } from "../dist/ops.js";
import { createServer } from "../dist/server.js";
import { Store } from "../dist/store.js";
import { CATALOG } from "./helpers.js";

// Backup status files as deploy/host/backup.sh writes them; the machine's own file is never read by these tests.
const dir = mkdtempSync(join(tmpdir(), "mynt-ops-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const ago = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
const fixture = (name, value) => {
  const file = join(dir, name);
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
};
const healthy = {
  at: ago(3),
  ok: true,
  local: "7 backup(s) on this server; newest 2026-11-04T023112Z: database 9.1MB, Storage 2.0MB",
  offsite: "uploaded",
  bytes: 11650000,
  error: null,
  last_success_at: ago(3),
  verify: { at: ago(50), ok: true, backup: "2026-11-02T023301Z", tables: { financial_products: 41, auth: 17 }, storage_files: 12, error: null },
};
process.env.MYNT_BACKUP_STATUS_FILE = fixture("healthy.json", healthy);

test("ops_status: admins see failures, stuck runs, spend and hosting trouble at a glance; nobody else gets the tool", async () => {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, {}).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const admin = await connect((await store.createUser("Ada", ["admin"])).user);
  const dev = await connect((await store.createUser("Dev", ["developer"])).user);
  assert.ok(!(await dev.listTools()).tools.some((t) => t.name === "ops_status"));
  const status = async (args = {}) => JSON.parse((await admin.callTool({ name: "ops_status", arguments: args })).content[0].text);

  // A quiet deployment: no agent tables yet, nothing to report.
  assert.deepEqual((await status()).attention, ["Nothing needs attention"]);

  // Builds: one failed today, one stuck for hours, spend this month; an old failure outside the window.
  await pg.exec(`CREATE TABLE financial_products.build_runs (id uuid PRIMARY KEY, status text, error text, cost_usd numeric, created_at timestamptz DEFAULT now())`);
  const add = (status, error, cost, ago) =>
    pg.query("INSERT INTO financial_products.build_runs (id, status, error, cost_usd, created_at) VALUES ($1, $2, $3, $4, now() - $5::interval)", [randomUUID(), status, error, cost, ago]);
  await add("failed", "Coding agent error_max_budget_usd", 3.5, "1 hour");
  await add("coding", null, 1.25, "5 hours");
  await add("succeeded", null, 2, "2 hours");
  await add("failed", "old", 0, "3 days");
  // Hosting: a VM that failed to come up, an app stopped with its error.
  const hosting = await HostingService.open(db, null, null);
  void hosting;
  const devId = (await store.createUser("Host", ["developer"])).user.id;
  const tenant = randomUUID();
  await pg.query("INSERT INTO financial_products.hosting_tenants (id, developer_id, provider, status, error) VALUES ($1, $2, 'freestyle', 'failed', 'VM setup failed: no space left')", [tenant, devId]);

  const s = await status();
  assert.deepEqual(s.attention, ["builds: 1 failed in the last 24h", "builds: 1 running over 120 min", "hosting: 1 VM(s) failed to provision"]);
  assert.deepEqual(s.agents.builds.last_hours, { coding: 1, failed: 1, succeeded: 1 });
  assert.equal(s.agents.builds.failures[0].error, "Coding agent error_max_budget_usd");
  assert.equal(s.agents.builds.stuck[0].status, "coding");
  const month = Number((await pg.query("SELECT coalesce(sum(cost_usd), 0) AS s FROM financial_products.build_runs WHERE created_at >= date_trunc('month', now())")).rows[0].s);
  assert.equal(s.agents.builds.spend_this_month_usd, month, "this calendar month's spend (6.75 unless run just after a month starts)");
  assert.equal(s.hosting.failed_tenants[0].error, "VM setup failed: no space left");
  assert.equal((await status({ hours: 96 })).agents.builds.failures.length, 2, "a wider window reaches the older failure");

  // The sandbox provider out of allowance: said first, with what to do.
  await add("failed", 'The sandbox provider has used up this account\'s allowance; an admin must add billing in its dashboard. (Freestyle POST /vms/vm-1/exec-await: 429 {"code":"LIMIT_EXCEEDED","message":"Cannot start this VM because the allowance for vcpu_time, memory_time has been used."})', 1, "10 minutes");
  assert.match((await status()).attention[0], /^sandbox provider: the account's allowance is used up/);
});

test("ops_status: backups (last run, off-site copy, restore test) and what to do when they need attention", async () => {
  const lines = async (value) => (await backupStatus(value === undefined ? join(dir, "missing.json") : fixture(`${randomUUID()}.json`, value))).attention;

  const ok = await backupStatus(process.env.MYNT_BACKUP_STATUS_FILE);
  assert.deepEqual(ok.attention, []);
  assert.equal(ok.section.offsite, "uploaded");
  assert.equal(ok.section.last_success_at, healthy.last_success_at);
  assert.deepEqual(ok.section.last_verify, { at: healthy.verify.at, ok: true, tables: { financial_products: 41, auth: 17 }, error: null });

  assert.deepEqual(await lines(undefined), ["backups: no backup has run on this server (no status file); see Backups in docs/reference.md"]);
  assert.deepEqual(await lines("{not json"), ["backups: the status file can't be read"]);
  assert.deepEqual(await lines({ ...healthy, at: ago(30), last_success_at: ago(30) }), ["backups: the last successful backup was 30h ago"]);
  assert.deepEqual(await lines({ ...healthy, last_success_at: ago(25) }), [], "a day plus some slack is still fresh");
  assert.deepEqual(await lines({ ...healthy, at: ago(1), ok: false, offsite: "failed", error: "failed while uploading off-site (details in the backup log)" }), [
    "backups: the last run failed: failed while uploading off-site (details in the backup log)",
  ]);
  assert.deepEqual(await lines({ ...healthy, offsite: "local_only" }), ["backups are on this server only; add an off-site bucket"]);
  assert.deepEqual(await lines({ ...healthy, verify: { at: ago(2), ok: false, error: "failed while test-restoring 2026-11-04T023112Z (details in the backup log)" } }), [
    "backups: the last restore test failed: failed while test-restoring 2026-11-04T023112Z (details in the backup log)",
  ]);
  assert.deepEqual(await lines({ at: ago(1), ok: false, offsite: "failed", error: "failed while dumping the database (details in the backup log)" }), [
    "backups: no backup has succeeded yet",
    "backups: the last run failed: failed while dumping the database (details in the backup log)",
  ]);

  // Through the tool: the section is there, and its attention lines join the rest.
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const [c, sv] = InMemoryTransport.createLinkedPair();
  await createServer(store, (await store.createUser("Ada", ["admin"])).user, {}).connect(sv);
  const admin = new Client({ name: "test", version: "0" });
  await admin.connect(c);
  const call = async () => JSON.parse((await admin.callTool({ name: "ops_status", arguments: {} })).content[0].text);
  assert.equal((await call()).backups.offsite, "uploaded");
  const before = process.env.MYNT_BACKUP_STATUS_FILE;
  process.env.MYNT_BACKUP_STATUS_FILE = fixture("local-only.json", { ...healthy, offsite: "local_only" });
  try {
    const s = await call();
    assert.deepEqual(s.attention, ["backups are on this server only; add an off-site bucket"]);
    assert.equal(s.backups.offsite, "local_only");
  } finally {
    process.env.MYNT_BACKUP_STATUS_FILE = before;
  }
});
