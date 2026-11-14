import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import type { App, Store, User } from "./store.js";
import { isUuid, workspaceRole } from "./workspaces.js";
import { usageStartedSetting } from "./usage-meter.js";
import { LEDGER_STARTED_SETTING as LEDGER_STARTED } from "./money-rails.js";

// A workspace's profit and loss, for its members: what its apps bring in after launch against what building and
// running them costs, per period (UTC) and as a statement (this period, last period, year to date). Every figure is
// one Mynt records; a line Mynt doesn't record is null with a reason, never 0, and a total is null unless every line
// under it is measured (adding only the measured lines would count the rest as 0).
//
// Revenue is the money Mynt saw settle through each app, live only, per product: the same records, rule and amount
// get_developer_dashboard shows as money moved (money_movements, status settled, not sandbox, the settled amount
// where the rail reported one, dated by when it settled). Sandbox money is left out entirely: it isn't money.
// Costs: each build's metered spend (its coding agents' model use and its sandboxes' machine time while it runs, as
// build_runs.cost_usd counts against BUILD_CAP_USD and the monthly caps), dated by when the build started, as the
// monthly caps count it. Mynt's independent audits are paid by Mynt (their own meter, never in build spend), so they
// cost the workspace nothing. Hosting (each app's VM) and sandboxes after a build (previews kept up, reopened ones)
// come from usage-meter.ts's samples. Each recorded line counts from when Mynt started recording it (the money
// ledger's start, the meters' starts): a period that began before then is null, never a partial figure. Mynt
// charges no fees and sees no app's own cut, so those stay unmeasured.

const T = "financial_products";
const DAY = 86_400_000;

type Granularity = "month" | "week";
type ColumnKey = "this_period" | "last_period" | "year_to_date";
type Values = Record<ColumnKey, number | null>;
interface Line {
  key: string;
  label: string;
  app_id?: string;
  product_id?: string;
  values: Values;
  measured: boolean;
  source: string;
}

const COLUMN_KEYS: ColumnKey[] = ["this_period", "last_period", "year_to_date"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

// The start of the period holding `t` (UTC): the 1st of its month, or the Monday of its week.
export function periodStart(t: number, g: Granularity): number {
  const d = new Date(t);
  if (g === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY;
}
export function shiftPeriod(start: number, g: Granularity, n: number): number {
  if (g === "week") return start + n * 7 * DAY;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1);
}
const label = (start: number, g: Granularity) => {
  const d = new Date(start);
  return g === "month" ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `Week of ${d.getUTCDate()} ${SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const iso = (t: number) => new Date(t).toISOString();

type Row = Record<string, string>;
// A table this Mynt doesn't have (no builds, no hosting): null, so the line is unmeasured rather than 0.
async function optional(db: Db, sql: string, params: unknown[]): Promise<Row[] | null> {
  try {
    return (await db.query(sql, params)).rows as Row[];
  } catch (e) {
    if ((e as { code?: string }).code === "42P01") return null;
    throw e;
  }
}

export interface PnlOptions {
  granularity?: Granularity;
  periods?: number;
  app_id?: string;
  now?: number;
}

export async function workspacePnl(store: Store, workspaceId: string, apps: App[], o: PnlOptions = {}) {
  const g = o.granularity ?? "month";
  const periods = o.periods ?? 6;
  const now = o.now ?? Date.now();
  const thisStart = periodStart(now, g);
  const thisEnd = shiftPeriod(thisStart, g, 1);
  const lastStart = shiftPeriod(thisStart, g, -1);
  const year = new Date(now).getUTCFullYear();
  const ytdStart = Date.UTC(year, 0, 1);
  const ytdEnd = Math.min(thisEnd, Date.UTC(year + 1, 0, 1));
  const seriesStarts = Array.from({ length: periods }, (_, i) => shiftPeriod(thisStart, g, i - periods + 1));
  const from = Math.min(seriesStarts[0], lastStart, ytdStart);
  const columns = [
    { key: "this_period" as const, label: g === "month" ? `This month (${label(thisStart, g)})` : `This week (${label(thisStart, g)})`, start: thisStart, end: thisEnd },
    { key: "last_period" as const, label: g === "month" ? `Last month (${label(lastStart, g)})` : `Last week (${label(lastStart, g)})`, start: lastStart, end: thisStart },
    { key: "year_to_date" as const, label: `${year} to date`, start: ytdStart, end: ytdEnd },
  ];

  // Per-day sums in SQL (bounded by the periods asked for), bucketed here into periods and columns.
  const ids = apps.map((a) => a.id);
  const range = [ids, iso(from), iso(thisEnd)];
  const usage = (kind: string) =>
    optional(
      store.db,
      `SELECT app_id::text AS app_id, to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, (SUM(delta_usd) * 100)::text AS cents
       FROM ${T}.usage_samples WHERE kind = '${kind}' AND app_id = ANY($1::uuid[]) AND sampled_at >= $2::timestamptz AND sampled_at < $3::timestamptz
       GROUP BY 1, 2`,
      range,
    );
  const [money, builds, hosted, tenant, hostingUsage, sandboxUsage, started] = await Promise.all([
    optional(
      store.db,
      `SELECT app_id::text AS app_id, product_id, to_char(COALESCE(settled_at, updated_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
         SUM(COALESCE(settled_amount_cents, amount_cents))::text AS cents
       FROM ${T}.money_movements
       WHERE app_id = ANY($1::uuid[]) AND status = 'settled' AND NOT sandbox
         AND COALESCE(settled_at, updated_at) >= $2::timestamptz AND COALESCE(settled_at, updated_at) < $3::timestamptz
       GROUP BY 1, 2, 3`,
      range,
    ),
    optional(
      store.db,
      `SELECT app_id::text AS app_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, (SUM(cost_usd) * 100)::text AS cents
       FROM ${T}.build_runs WHERE app_id = ANY($1::uuid[]) AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
       GROUP BY 1, 2`,
      range,
    ),
    optional(store.db, `SELECT app_id::text AS app_id, (vm_id IS NOT NULL)::text AS metered FROM ${T}.hosted_apps WHERE app_id = ANY($1::uuid[])`, [ids]),
    optional(store.db, `SELECT 1 AS t FROM ${T}.hosting_tenants WHERE $1::boolean AND workspace_id::text = $2 LIMIT 1`, [!o.app_id, workspaceId]),
    usage("hosting"),
    usage("sandbox"),
    optional(store.db, `SELECT key, value #>> '{}' AS at FROM ${T}.settings WHERE key = ANY($1)`, [
      [LEDGER_STARTED, usageStartedSetting("hosting"), usageStartedSetting("sandbox")],
    ]),
  ]);
  const startOf = (key: string) => {
    const r = started?.find((x) => x.key === key);
    return r ? Date.parse(r.at) : null;
  };

  const dayT = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const seriesIndex = (t: number) => {
    for (let i = seriesStarts.length - 1; i >= 0; i--) if (t >= seriesStarts[i]) return t < shiftPeriod(seriesStarts[i], g, 1) ? i : -1;
    return -1;
  };
  // A line's sums, and when Mynt started recording it: a period that began before then isn't measured (null).
  type Acc = { series: number[]; cols: Record<ColumnKey, number>; from: number };
  const acc = (from = -Infinity): Acc => ({ series: seriesStarts.map(() => 0), cols: { this_period: 0, last_period: 0, year_to_date: 0 }, from });
  const add = (a: Acc, day: string, cents: number) => {
    const t = dayT(day);
    const i = seriesIndex(t);
    if (i >= 0) a.series[i] += cents;
    for (const c of columns) if (t >= c.start && t < c.end) a.cols[c.key] += cents;
  };
  const whole = (n: number) => Math.round(n);
  const colStart = Object.fromEntries(columns.map((c) => [c.key, c.start])) as Record<ColumnKey, number>;
  const colValue = (a: Acc | null, k: ColumnKey) => (a && colStart[k] >= a.from ? whole(a.cols[k]) : null);
  const seriesValue = (a: Acc | null, i: number) => (a && seriesStarts[i] >= a.from ? whole(a.series[i]) : null);
  const valuesOf = (a: Acc | null): Values => Object.fromEntries(COLUMN_KEYS.map((k) => [k, colValue(a, k)])) as Values;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  const unmeasured: { key: string; label: string; reason: string }[] = [];
  // Recording started inside the periods shown: the earlier ones say so.
  const startedNote = (key: string, label: string, a: Acc | null) => {
    if (a && Number.isFinite(a.from) && a.from > Math.min(seriesStarts[0], ...columns.map((c) => c.start)))
      unmeasured.push({ key, label, reason: `Recording started ${day(a.from)}; periods that began before then aren't measured` });
  };

  // ---- revenue: one line per app and product ----
  const names = new Map<string, string>();
  const productName = async (id: string) => {
    if (!names.has(id)) names.set(id, (await store.getProduct(id))?.product.name ?? id);
    return names.get(id)!;
  };
  const ledgerFrom = startOf(LEDGER_STARTED) ?? -Infinity;
  const revenue: (Line & { acc: Acc | null })[] = [];
  for (const app of apps) {
    const products = [...new Set([...app.product_ids, ...(money ?? []).filter((m) => m.app_id === app.id).map((m) => m.product_id)])];
    for (const product_id of products.length ? products : [null]) {
      const a = money === null ? null : acc(ledgerFrom);
      if (a) for (const m of money!) if (m.app_id === app.id && (product_id === null || m.product_id === product_id)) add(a, m.day, Number(m.cents));
      revenue.push({
        key: product_id ? `app:${app.id}:product:${product_id}` : `app:${app.id}`,
        label: product_id ? `${app.name}: ${await productName(product_id)}` : app.name,
        app_id: app.id,
        ...(product_id ? { product_id } : {}),
        values: valuesOf(a),
        measured: a !== null,
        source:
          a === null
            ? "This Mynt has no money rails, so it records no money moving through apps"
            : "Money settled through the app on this product, live only (sandbox excluded), at the settled amount, dated when it settled: the money moved on get_developer_dashboard",
        acc: a,
      });
    }
  }
  if (revenue[0]) startedNote("revenue", "Revenue", revenue[0].acc);

  // ---- costs ----
  const costs: (Line & { acc: Acc | null })[] = [];
  const cost = (key: string, lbl: string, a: Acc | null, source: string) => {
    costs.push({ key, label: lbl, values: valuesOf(a), measured: a !== null, source, acc: a });
    if (a === null) unmeasured.push({ key, label: lbl, reason: source });
    else startedNote(key, lbl, a);
  };
  const fromUsage = (rows: Row[] | null, from: number | null) => {
    if (rows === null || from === null) return null;
    const a = acc(from);
    for (const r of rows) add(a, r.day, Number(r.cents));
    return a;
  };
  let buildAcc: Acc | null = null;
  if (builds !== null) {
    buildAcc = acc();
    for (const b of builds) add(buildAcc, b.day, Number(b.cents));
  }
  cost(
    "build_agents",
    "Building apps (coding agents and their sandboxes)",
    buildAcc,
    buildAcc
      ? "Each build of the workspace's apps, at its metered cost: the coding agents' model use through Mynt's agent proxy plus its sandboxes' machine time while it runs (what counts against BUILD_CAP_USD and the monthly caps), dated when the build started"
      : "This Mynt doesn't run builds, so it records no build spend",
  );
  const sandboxAcc = builds === null ? null : fromUsage(sandboxUsage, startOf(usageStartedSetting("sandbox")));
  cost(
    "sandboxes",
    "Sandboxes after a build",
    sandboxAcc,
    sandboxAcc
      ? "What a build's sandboxes cost after it ends (its preview kept up until their time limit) and sandboxes reopened on a finished build (reopen_sandbox), sampled from the provider's own cost"
      : "Mynt isn't recording sandbox time after builds here (it runs no builds or sandboxes)",
  );
  const auditAcc = acc();
  cost(
    "audits",
    "Independent security audits",
    auditAcc,
    "Mynt pays for its own independent audits (on their own meter and BUILD_AUDIT_CAP_USD budget, never in build spend), so they cost the workspace nothing",
  );
  const hostingFrom = startOf(usageStartedSetting("hosting"));
  const anyHosting = (hosted?.length ?? 0) > 0 || (tenant?.length ?? 0) > 0;
  if (hosted === null || (!anyHosting && hostingFrom === null))
    cost("hosting", "Hosting", acc(), o.app_id ? "Mynt doesn't host this app, so there's no hosting cost" : "Mynt doesn't host any of this workspace's apps, so there's no hosting cost");
  else if (hostingFrom === null || hosted.some((h) => h.metered !== "true"))
    cost(
      "hosting",
      "Hosting",
      null,
      "This workspace's hosting runs on a provider Mynt can't meter per app (only a VM per app reports its run time), so Mynt doesn't record its cost",
    );
  else
    cost(
      "hosting",
      "Hosting",
      fromUsage(hostingUsage, hostingFrom),
      "Each hosted app's VM, its run time sampled from the provider and priced at FREESTYLE_USD_PER_HOUR",
    );
  cost(
    "mynt_fees",
    "Mynt's fees",
    null,
    "Mynt doesn't charge workspaces anything yet: take rates are set per product line (define_take_rate) but there's no billing, so no fee is ever charged or recorded",
  );
  unmeasured.push({
    key: "app_earnings",
    label: "What the apps keep",
    reason:
      "Revenue here is the money settled through the apps. Apps don't charge their customers through Mynt, and a product's fees (its definition) are the provider's, so Mynt has no record of an app's own cut",
  });

  // ---- totals and series: a total is measured only when every line under it is ----
  const sum = (vals: (number | null)[]): number | null => (vals.some((v) => v === null) ? null : vals.reduce<number>((t, v) => t + v!, 0));
  const totalValues = (lines: { acc: Acc | null }[]): Values =>
    Object.fromEntries(COLUMN_KEYS.map((k) => [k, sum(lines.map((l) => colValue(l.acc, k)))])) as Values;
  const net = (r: number | null, c: number | null) => (r === null || c === null ? null : r - c);
  const rev = totalValues(revenue);
  const cst = totalValues(costs);
  const series = seriesStarts.map((start, i) => {
    const r = sum(revenue.map((l) => seriesValue(l.acc, i)));
    const c = sum(costs.map((l) => seriesValue(l.acc, i)));
    return { start: iso(start), end: iso(shiftPeriod(start, g, 1)), revenue_cents: r, costs_cents: c, net_cents: net(r, c) };
  });
  const strip = ({ acc: _, ...l }: Line & { acc: Acc | null }): Line => l;
  return {
    currency: "USD" as const,
    series,
    statement: {
      columns: columns.map((c) => ({ ...c, start: iso(c.start), end: iso(c.end) })),
      revenue: revenue.map(strip),
      costs: costs.map(strip),
      totals: {
        revenue: rev,
        costs: cst,
        net: Object.fromEntries(COLUMN_KEYS.map((k) => [k, net(rev[k], cst[k])])) as Values,
      },
    },
    unmeasured,
  };
}

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export function registerWorkspacePnlTools(server: McpServer, store: Store, user: User) {
  server.registerTool(
    "get_workspace_pnl",
    {
      title: "Workspace profit and loss",
      description:
        "Developer: members of the workspace only. Its profit and loss, in US cents: money settled through its apps (live only, per app and product: the money moved on get_developer_dashboard) against what building and running them costs, per month or week (UTC, oldest first) and as a statement for this period, last period and the year to date. Optionally for one app (app_id). A figure Mynt doesn't record is null with a reason in `unmeasured`, never 0; a total, and net, is null unless every line under it is measured. Readable while the workspace is frozen or being archived.",
      inputSchema: z
        .object({
          workspace_id: z.string(),
          granularity: z.enum(["month", "week"]).default("month"),
          periods: z.number().int().min(1).max(24).default(6),
          app_id: z.string().optional(),
        })
        .strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ workspace_id, granularity, periods, app_id }) => {
      if (!(await workspaceRole(store.db, workspace_id, user.id))) return fail(`No workspace of yours with id '${workspace_id}'`);
      const all = (await store.db.query(`SELECT id::text AS id FROM ${T}.apps WHERE workspace_id::text = $1 ORDER BY created_at`, [workspace_id])).rows as { id: string }[];
      let ids = all.map((r) => r.id);
      if (app_id !== undefined) {
        if (!isUuid(app_id) || !ids.includes(app_id)) return fail(`No app with id '${app_id}' in this workspace`);
        ids = [app_id];
      }
      const apps = (await Promise.all(ids.map((id) => store.getApp(id)))).filter((a): a is App => !!a && a.workspace_id === workspace_id);
      return json(await workspacePnl(store, workspace_id, apps, { granularity, periods, app_id }));
    },
  );
}
