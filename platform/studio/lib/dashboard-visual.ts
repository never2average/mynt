// The figures behind the dashboard's charts, from what the dashboard already reads: the P&L
// (get_workspace_pnl), the dashboard (get_developer_dashboard or apps and builds), the apps by
// stage and their promotion checks. Pure, for the components and the tests. Amounts are integer
// cents; anything Mynt doesn't measure stays null (a gap, "Not measured"), never 0.
import { DATE_RANGES, type DateRangeKey } from "@/lib/pnl";
import type { StageApp } from "@/components/dashboard-panels";
import type { Pnl, PnlLine, Values } from "./pnl";
import type { Stage } from "./workspaces";

export type Delta = { direction: "up" | "down" | "flat"; text: string; good: boolean | null } | null;
export type Kpi = { key: string; label: string; value: number | null; unit: "money" | "count"; delta: Delta; spark: (number | null)[] | null; note?: string };

const pct = (a: number, b: number) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

/** This period against last: arrow, words and whether the move is good (more cost is bad). */
export function deltaOf(v: Values | null, costLike = false): Delta {
  if (!v || v.this_period === null || v.last_period === null) return null;
  const d = v.this_period - v.last_period;
  if (d === 0) return { direction: "flat", text: "Same as last period", good: null };
  const p = pct(v.this_period, v.last_period);
  const up = d > 0;
  return { direction: up ? "up" : "down", text: `${p === null ? "" : `${Math.abs(p)}% `}${up ? "more" : "less"} than last period`, good: costLike ? !up : up };
}

const line = (lines: PnlLine[], ...keys: string[]) => lines.find((l) => keys.includes(l.key)) ?? null;

/** The KPI row: money moved, build spend, hosting and apps live, each with its change and history. */
export function builderKpis(pnl: Pnl | null, appsLive: number | null): Kpi[] {
  const build = pnl ? line(pnl.costs, "coding_agents", "build_spend", "builds") : null;
  const hosting = pnl ? line(pnl.costs, "hosting") : null;
  return [
    {
      key: "money-moved",
      label: "Money moved",
      value: pnl?.totals.revenue.this_period ?? null,
      unit: "money",
      delta: deltaOf(pnl?.totals.revenue ?? null),
      spark: pnl?.series.length ? pnl.series.map((p) => p.revenue) : null,
    },
    // Per-period history is only reported for the totals; a line's sparkline would be a guess.
    { key: "build-spend", label: "Build spend", value: build?.values.this_period ?? null, unit: "money", delta: deltaOf(build?.values ?? null, true), spark: null, note: build ? undefined : "Mynt hasn't reported build spend" },
    { key: "hosting", label: "Hosting", value: hosting?.values.this_period ?? null, unit: "money", delta: deltaOf(hosting?.values ?? null, true), spark: null, note: hosting ? undefined : "Mynt hasn't reported hosting" },
    { key: "apps-live", label: "Apps live", value: appsLive, unit: "count", delta: null, spark: null },
  ];
}

export type Slice = { key: string; label: string; value: number };
/** The cost breakdown: each measured cost line this period; unmeasured ones are listed apart. */
export function costSlices(pnl: Pnl | null): { slices: Slice[]; unmeasured: string[] } {
  if (!pnl) return { slices: [], unmeasured: [] };
  const slices = pnl.costs.filter((l) => l.values.this_period !== null && l.values.this_period > 0).map((l) => ({ key: l.key, label: l.label, value: l.values.this_period! }));
  const unmeasured = pnl.costs.filter((l) => l.values.this_period === null).map((l) => l.label);
  return { slices, unmeasured };
}

/** Money moved per app this period: the top `top`, the rest as "Other apps". */
export function moneyByApp(pnl: Pnl | null, top = 8): Slice[] {
  if (!pnl) return [];
  const rows = pnl.revenue.filter((l) => l.values.this_period !== null).map((l) => ({ key: l.key, label: l.label, value: l.values.this_period! }));
  rows.sort((a, b) => b.value - a.value);
  if (rows.length <= top) return rows;
  const rest = rows.slice(top - 1);
  return [...rows.slice(0, top - 1), { key: "other", label: `Other apps (${rest.length})`, value: rest.reduce((n, r) => n + r.value, 0) }];
}

export const FUNNEL: Stage[] = ["idea", "staging", "production"];
export type FunnelStep = { stage: Stage; count: number; apps: { id: string; name: string; passing: number | null; total: number | null }[] };
/** Ideas → Staging → Production, each with its apps and their checks passing. */
export function pipeline(apps: StageApp[]): FunnelStep[] {
  return FUNNEL.map((stage) => {
    const mine = apps.filter((a) => a.stage === stage);
    return {
      stage,
      count: mine.length,
      apps: mine.map((a) => {
        const r = a.readiness && a.readiness !== "not_checked" ? a.readiness : null;
        return { id: a.id, name: a.name, passing: r?.passing ?? null, total: r?.total ?? null };
      }),
    };
  });
}

/** "3 h ago", "2 d ago": for the activity timeline. */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(t).toISOString().slice(0, 10);
}

/** A chart's summary for screen readers: what it shows, with its figures in words. */
export function seriesSummary(label: string, points: { label: string; value: number | null }[], format: (v: number | null) => string): string {
  if (!points.length) return `${label}: no data.`;
  return `${label}: ${points.map((p) => `${p.label} ${format(p.value)}`).join(", ")}.`;
}

// ---- the builder dashboard's chart filters: app, app stage, date range ----

export type ChartFilter = { appId: string; stage: Stage | "all"; range: DateRangeKey };
export const DEFAULT_CHART_FILTER: ChartFilter = { appId: "all", stage: "all", range: "6m" };

export const dateRange = (key: DateRangeKey) => DATE_RANGES.find((r) => r.key === key) ?? DATE_RANGES[1];

// The apps the app picker offers: those in the chosen stage (all apps for every stage).
export const appsForStage = (apps: readonly { id: string; name: string; stage: Stage }[], stage: ChartFilter["stage"]) => (stage === "all" ? [...apps] : apps.filter((a) => a.stage === stage));

// The P&L route for a filter: one app (?app=), a stage's apps added up (?apps=), or the whole workspace.
export function chartPnlUrl(f: ChartFilter, apps: readonly { id: string; stage: Stage }[]): string {
  const r = dateRange(f.range);
  const base = `/api/pnl?granularity=${r.granularity}&periods=${r.periods}`;
  if (f.appId !== "all") return `${base}&app=${encodeURIComponent(f.appId)}`;
  if (f.stage !== "all") return `${base}&apps=${apps.filter((a) => a.stage === f.stage).map((a) => encodeURIComponent(a.id)).join(",")}`;
  return base;
}
