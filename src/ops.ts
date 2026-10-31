// What admins check first: is anything failing, stuck or costing more than it should, across the agents (builds,
// the product desk, governance review, the connector) and developers' hosting. Read-only.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

// Each agent's runs: its table, the statuses that mean it's finished, and the ones that mean it went wrong.
const RUNS = [
  { name: "builds", table: "build_runs", done: ["succeeded", "blocked", "failed", "stopped", "over_budget"], bad: ["failed", "blocked", "over_budget"] },
  { name: "desk", table: "desk_jobs", done: ["succeeded", "failed", "stopped", "over_budget", "done"], bad: ["failed", "over_budget"] },
  { name: "reviews", table: "review_cases", done: ["ready", "decided", "failed", "stopped", "over_budget"], bad: ["failed", "over_budget"] },
  { name: "connector", table: "bd_runs", done: ["succeeded", "failed", "stopped", "over_budget", "done"], bad: ["failed", "over_budget"] },
] as const;

export async function opsStatus(db: Db, opts: { hours?: number; stuckMinutes?: number } = {}) {
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
  const attention = [
    ...Object.entries(agents).flatMap(([name, a]) => {
      const x = a as { failures: unknown[]; stuck: unknown[] };
      return [...(x.failures.length ? [`${name}: ${x.failures.length} failed in the last ${hours}h`] : []), ...(x.stuck.length ? [`${name}: ${x.stuck.length} running over ${stuck} min`] : [])];
    }),
    ...((hosting.failed_tenants as unknown[] | undefined)?.length ? [`hosting: ${(hosting.failed_tenants as unknown[]).length} VM(s) failed to provision`] : []),
    ...((hosting.stopped_apps as unknown[] | undefined)?.length ? [`hosting: ${(hosting.stopped_apps as unknown[]).length} app(s) stopped`] : []),
    ...((hosting.stuck_deploys as unknown[] | undefined)?.length ? [`hosting: ${(hosting.stuck_deploys as unknown[]).length} deploy(s) running over 45 min`] : []),
  ];
  return { attention: attention.length ? attention : ["Nothing needs attention"], window_hours: hours, agents, hosting };
}

export function registerOpsTools(server: McpServer, db: Db) {
  server.registerTool(
    "ops_status",
    {
      title: "What needs attention",
      description:
        "Admin: failures, stuck runs and this month's spend across builds, the product desk, governance reviews and the connector, plus developers' hosting (VMs that failed, apps stopped or stuck deploying). Read-only.",
      inputSchema: { hours: z.number().int().min(1).max(24 * 30).default(24) },
      annotations: { readOnlyHint: true },
    },
    async ({ hours }) => json(await opsStatus(db, { hours })),
  );
}
