// What admins check first: is anything failing, stuck or costing more than it should, across the agents (builds,
// the product desk and its algorithm explorers, governance review, the connector), developers' hosting and the
// server's backups. Read-only.
import { readFile } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { namesMoneyMovement } from "./money-rails.js";
import { QUOTA_PATTERN } from "./transient.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

// Each agent's runs: its table, the statuses that mean it's finished, and the ones that mean it went wrong.
const RUNS = [
  { name: "builds", table: "build_runs", done: ["succeeded", "blocked", "failed", "stopped", "over_budget"], bad: ["failed", "blocked", "over_budget"] },
  { name: "desk", table: "desk_jobs", done: ["succeeded", "failed", "stopped", "over_budget", "done"], bad: ["failed", "over_budget"] },
  { name: "reviews", table: "review_cases", done: ["ready", "decided", "failed", "stopped", "over_budget"], bad: ["failed", "over_budget"] },
  { name: "explorers", table: "explore_jobs", done: ["finished", "failed", "stopped", "over_budget"], bad: ["failed", "over_budget"] },
  { name: "connector", table: "bd_runs", done: ["succeeded", "failed", "stopped", "over_budget", "done"], bad: ["failed", "over_budget"] },
] as const;

// Backups of Supabase are made on the host by deploy/host/backup.sh, which writes a small status file for this.
export const DEFAULT_BACKUP_STATUS_FILE = "/var/lib/mynt/backup-status.json";
const BACKUP_STALE_HOURS = 26;

type BackupFile = {
  at?: string;
  ok?: boolean;
  local?: string | null;
  offsite?: "uploaded" | "local_only" | "failed" | null;
  bytes?: number | null;
  error?: string | null;
  last_success_at?: string;
  verify?: { at?: string; ok?: boolean; backup?: string | null; tables?: Record<string, number>; storage_files?: number | null; error?: string | null };
};

export async function backupStatus(file = process.env.MYNT_BACKUP_STATUS_FILE || DEFAULT_BACKUP_STATUS_FILE, now = Date.now()) {
  let s: BackupFile;
  try {
    s = JSON.parse(await readFile(file, "utf8")) as BackupFile;
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    return {
      section: { status: missing ? "no status file" : "status file unreadable" },
      attention: [missing ? "backups: no backup has run on this server (no status file); see Backups in docs/reference.md" : "backups: the status file can't be read"],
    };
  }
  const age = s.last_success_at ? (now - Date.parse(s.last_success_at)) / 3_600_000 : null;
  const attention = [
    ...(age === null || Number.isNaN(age)
      ? ["backups: no backup has succeeded yet"]
      : age > BACKUP_STALE_HOURS
        ? [`backups: the last successful backup was ${Math.floor(age)}h ago`]
        : []),
    ...(s.ok === false ? [`backups: the last run failed${s.error ? `: ${s.error}` : ""}`] : []),
    ...(s.offsite === "local_only" ? ["backups are on this server only; add an off-site bucket"] : []),
    ...(s.verify?.ok === false ? [`backups: the last restore test failed${s.verify.error ? `: ${s.verify.error}` : ""}`] : []),
  ];
  return {
    section: {
      last_run_at: s.at ?? null,
      ok: s.ok ?? null,
      last_success_at: s.last_success_at ?? null,
      offsite: s.offsite ?? null,
      bytes: s.bytes ?? null,
      local: s.local ?? null,
      error: s.error ?? null,
      last_verify: s.verify ? { at: s.verify.at ?? null, ok: s.verify.ok ?? null, tables: s.verify.tables ?? {}, error: s.verify.error ?? null } : null,
    },
    attention,
  };
}

export async function opsStatus(db: Db, opts: { hours?: number; stuckMinutes?: number; backupStatusFile?: string } = {}) {
  const hours = opts.hours ?? 24;
  const stuck = opts.stuckMinutes ?? 120;
  const exists = async (table: string) => !!(await db.query(`SELECT to_regclass('financial_products.${table}') AS t`)).rows[0]?.t;
  const agents: Record<string, unknown> = {};
  for (const r of RUNS) {
    if (!(await exists(r.table))) continue;
    const t = `financial_products.${r.table}`;
    const byStatus = Object.fromEntries(
      (await db.query(`SELECT status, count(*)::int AS n FROM ${t} WHERE created_at > now() - make_interval(hours => $1) GROUP BY status ORDER BY status`, [hours])).rows.map(
        (x) => [x.status as string, x.n as number],
      ),
    );
    const failures = (
      await db.query(
        `SELECT id, status, left(coalesce(error, ''), 300) AS error, created_at FROM ${t} WHERE status = ANY($1) AND created_at > now() - make_interval(hours => $2) ORDER BY created_at DESC LIMIT 10`,
        [r.bad, hours],
      )
    ).rows;
    const stuckRuns = (
      await db.query(`SELECT id, status, created_at FROM ${t} WHERE NOT (status = ANY($1)) AND created_at < now() - make_interval(mins => $2) ORDER BY created_at LIMIT 10`, [r.done, stuck])
    ).rows;
    const spend = Number((await db.query(`SELECT coalesce(sum(cost_usd), 0) AS s FROM ${t} WHERE created_at >= date_trunc('month', now())`)).rows[0]?.s ?? 0);
    agents[r.name] = { last_hours: byStatus, failures, stuck: stuckRuns, spend_this_month_usd: Math.round(spend * 100) / 100 };
  }
  const hosting: Record<string, unknown> = {};
  if (await exists("hosting_tenants")) {
    hosting.tenants = Object.fromEntries(
      (await db.query("SELECT status, count(*)::int AS n FROM financial_products.hosting_tenants GROUP BY status ORDER BY status")).rows.map((x) => [x.status as string, x.n as number]),
    );
    hosting.failed_tenants = (await db.query("SELECT id, left(coalesce(error, ''), 300) AS error, updated_at FROM financial_products.hosting_tenants WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 10")).rows;
  }
  if (await exists("hosted_apps")) {
    const hasError = !!(await db.query("SELECT 1 FROM information_schema.columns WHERE table_schema = 'financial_products' AND table_name = 'hosted_apps' AND column_name = 'error'")).rows.length;
    hosting.apps = Object.fromEntries(
      (await db.query("SELECT status, count(*)::int AS n FROM financial_products.hosted_apps GROUP BY status ORDER BY status")).rows.map((x) => [x.status as string, x.n as number]),
    );
    hosting.stopped_apps = (
      await db.query(
        `SELECT app_id, ${hasError ? "left(coalesce(error, ''), 300)" : "''"} AS error, updated_at FROM financial_products.hosted_apps WHERE status = 'stopped' ORDER BY updated_at DESC LIMIT 10`,
      )
    ).rows;
    hosting.stuck_deploys = (
      await db.query("SELECT app_id, updated_at FROM financial_products.hosted_apps WHERE status = 'deploying' AND updated_at < now() - make_interval(mins => $1) LIMIT 10", [45])
    ).rows;
  }
  // Vendors' standard services: Mynt's conformance runs that failed, and subscriptions whose calls mostly err.
  const vendors: { failed_conformance: unknown[]; erroring_subscriptions: { subscription_id: string; calls: number; errors: number }[] } = {
    failed_conformance: [],
    erroring_subscriptions: [],
  };
  if (await exists("vendor_conformance_runs")) {
    vendors.failed_conformance = (
      await db.query(
        `SELECT r.offering_id, o.name AS offering, r.created_at FROM financial_products.vendor_conformance_runs r JOIN financial_products.vendor_offerings o ON o.id = r.offering_id
         WHERE NOT r.passed AND r.created_at > now() - make_interval(hours => $1) ORDER BY r.created_at DESC LIMIT 10`,
        [hours],
      )
    ).rows;
    vendors.erroring_subscriptions = (
      await db.query(
        `SELECT subscription_id, sum(ok + errors)::int AS calls, sum(errors)::int AS errors FROM financial_products.vendor_usage
         WHERE day > current_date - $1::int GROUP BY subscription_id HAVING sum(ok + errors) >= 10 AND sum(errors) * 5 > sum(ok + errors) ORDER BY sum(errors) DESC LIMIT 10`,
        [Math.max(1, Math.ceil(hours / 24))],
      )
    ).rows as typeof vendors.erroring_subscriptions;
  }
  // The mainnet program gate: programs a newer vulnerability database flagged, and reviews waiting for an admin.
  const solana: { flagged_programs: unknown[]; reviews_awaiting_approval: number } = { flagged_programs: [], reviews_awaiting_approval: 0 };
  if (await exists("solana_program_flags"))
    solana.flagged_programs = (await db.query("SELECT id, program_id, db_version, created_at FROM financial_products.solana_program_flags WHERE status = 'open' ORDER BY created_at LIMIT 20")).rows;
  if (await exists("solana_mainnet_reviews"))
    solana.reviews_awaiting_approval = Number((await db.query("SELECT count(*)::int AS n FROM financial_products.solana_mainnet_reviews WHERE status = 'awaiting_approval'")).rows[0]?.n ?? 0);
  // Product health: records that can't move on, snapshots overdue for the chain, and a worker that isn't running.
  const productHealth: { stalled: unknown[]; overdue: number; sponsored_products: number; worker_last_ran: string | null } = { stalled: [], overdue: 0, sponsored_products: 0, worker_last_ran: null };
  if (await exists("product_health_snapshots")) {
    const s = "financial_products.product_health_snapshots";
    productHealth.stalled = (await db.query(`SELECT product_id, pool_id, sequence, stalled_reason FROM ${s} WHERE stalled_reason IS NOT NULL ORDER BY created_at LIMIT 20`)).rows;
    productHealth.overdue = Number(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM ${s} r WHERE NOT r.on_chain AND r.publish_deadline < now() AND (r.status = 'ready' OR r.status = 'missed')
             AND r.epoch = (SELECT COALESCE(MAX(a.epoch), 0) FROM financial_products.product_health_anchors a WHERE a.subject = r.subject)`,
        )
      ).rows[0]?.n ?? 0,
    );
    if (await exists("sponsorships")) productHealth.sponsored_products = Number((await db.query("SELECT count(DISTINCT product_id)::int AS n FROM financial_products.sponsorships WHERE status = 'approved'")).rows[0]?.n ?? 0);
    const tick = (await db.query("SELECT last_tick_at FROM financial_products.product_health_worker WHERE id = 'worker'")).rows[0]?.last_tick_at as string | Date | undefined;
    productHealth.worker_last_ran = tick ? new Date(tick).toISOString() : null;
  }
  const workerIdle = productHealth.sponsored_products > 0 && (!productHealth.worker_last_ran || Date.now() - new Date(productHealth.worker_last_ran).getTime() > 60 * 60 * 1000);
  // A provider out of allowance stops everything that needs a machine: say so first, with what to do.
  const hit = (rows: unknown) => ((rows as { error?: string }[] | undefined) ?? []).some((f) => QUOTA_PATTERN.test(f.error ?? ""));
  const backups = await backupStatus(opts.backupStatusFile);
  const quota = Object.values(agents).some((a) => hit((a as { failures: unknown }).failures)) || hit(hosting.failed_tenants) || hit(hosting.stopped_apps);
  // A stored service type named as if it moves money, declared as not: it runs outside the money rails.
  const { rows: undeclared } = await db.query<{ region: string; key: string; name: string }>("SELECT region, key, name FROM financial_products.service_types WHERE moves_money = false AND NOT quote");
  const moneyNameMismatches = undeclared.filter((t) => namesMoneyMovement(t.key) || namesMoneyMovement(t.name)).map((t) => `${t.region}/${t.key}`);
  // A sponsor reported more than was asked, or settled a withdrawal already paid another way: a person should look.
  const poolFlags = (await exists("audit_log"))
    ? Number((await db.query(`SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action IN ('pool_movement_over_settlement', 'pool_late_settlement_refused') AND COALESCE(details->>'sandbox', 'false') <> 'true' AND created_at > now() - make_interval(hours => $1)`, [hours])).rows[0]?.n ?? 0)
    : 0;
  const attention = [
    ...(quota ? ["sandbox provider: the account's allowance is used up, so no build, agent run or hosted app can start; add billing in the provider's dashboard"] : []),
    ...Object.entries(agents).flatMap(([name, a]) => {
      const x = a as { failures: unknown[]; stuck: unknown[] };
      return [...(x.failures.length ? [`${name}: ${x.failures.length} failed in the last ${hours}h`] : []), ...(x.stuck.length ? [`${name}: ${x.stuck.length} running over ${stuck} min`] : [])];
    }),
    ...((hosting.failed_tenants as unknown[] | undefined)?.length ? [`hosting: ${(hosting.failed_tenants as unknown[]).length} VM(s) failed to provision`] : []),
    ...((hosting.stopped_apps as unknown[] | undefined)?.length ? [`hosting: ${(hosting.stopped_apps as unknown[]).length} app(s) stopped`] : []),
    ...((hosting.stuck_deploys as unknown[] | undefined)?.length ? [`hosting: ${(hosting.stuck_deploys as unknown[]).length} deploy(s) running over 45 min`] : []),
    ...(vendors.failed_conformance.length ? [`vendors: ${vendors.failed_conformance.length} conformance run(s) failed in the last ${hours}h`] : []),
    ...vendors.erroring_subscriptions.map((v) => `vendors: subscription ${v.subscription_id} erred on ${v.errors} of ${v.calls} calls`),
    ...(moneyNameMismatches.length ? [`vendors: service type(s) named as moving money but declared moves_money: false: ${moneyNameMismatches.join(", ")}`] : []),
    ...backups.attention,
    ...(poolFlags ? [`liquidity pools: ${poolFlags} movement report(s) refused in the last ${hours}h as over-settled or already re-paid; see audit_log (pool_movement_over_settlement, pool_late_settlement_refused)`] : []),
    ...(solana.flagged_programs.length ? [`solana: ${solana.flagged_programs.length} mainnet program(s) flagged by the vulnerability database; review with list_program_flags`] : []),
    ...(solana.reviews_awaiting_approval ? [`solana: ${solana.reviews_awaiting_approval} mainnet review(s) awaiting approval (list_mainnet_reviews)`] : []),
    ...(productHealth.stalled.length ? [`product health: ${productHealth.stalled.length} record(s) stalled against the chain; see list_product_health, and reanchor_product_health after a chain reset`] : []),
    ...(productHealth.overdue ? [`product health: ${productHealth.overdue} snapshot(s) past their deadline and not on chain; the RPC or the publisher's balance may be the cause`] : []),
    ...(workerIdle ? [`product health: ${productHealth.sponsored_products} sponsored product(s), but the worker ${productHealth.worker_last_ran ? `last ran ${productHealth.worker_last_ran}` : "has never run"} (it needs PRODUCT_HEALTH_PROGRAM_ID and MYNT_VAULT_KEY)`] : []),
  ];
  return { attention: attention.length ? attention : ["Nothing needs attention"], window_hours: hours, agents, hosting, vendors: { ...vendors, money_name_mismatches: moneyNameMismatches }, solana, product_health: productHealth, backups: backups.section };
}

export function registerOpsTools(server: McpServer, db: Db) {
  server.registerTool(
    "ops_status",
    {
      title: "What needs attention",
      description:
        "Admin: failures, stuck runs and this month's spend across builds, the product desk and its algorithm explorations, governance reviews and the connector, plus developers' hosting (VMs that failed, apps stopped or stuck deploying), vendors' services (failed conformance runs, subscriptions whose calls mostly fail) and the server's Supabase backups (last run, off-site copy, last restore test). Read-only.",
      inputSchema: { hours: z.number().int().min(1).max(24 * 30).default(24) },
      annotations: { readOnlyHint: true },
    },
    async ({ hours }) => json(await opsStatus(db, { hours })),
  );
}
