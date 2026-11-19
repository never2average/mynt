// The workspace's P&L (get_workspace_pnl): what its apps earn against what building and running
// them costs, per period and as a statement (this period, last period, year to date). Pure, for
// the route, the dashboard and the tests.
//
// Amounts are integer cents from Mynt. A figure Mynt doesn't measure is null and reads
// "Not measured" (a gap in the chart), never $0.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const cents = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);

export const GRANULARITIES = ["month", "week"] as const;
export type Granularity = (typeof GRANULARITIES)[number];
export const RANGES = [3, 6, 12] as const;
export type Range = (typeof RANGES)[number];

// The dashboard's date ranges: each a granularity and a number of periods.
export const DATE_RANGES = [
  { key: "3m", label: "Last 3 months", granularity: "month", periods: 3 },
  { key: "6m", label: "Last 6 months", granularity: "month", periods: 6 },
  { key: "12m", label: "Last 12 months", granularity: "month", periods: 12 },
  { key: "12w", label: "Last 12 weeks", granularity: "week", periods: 12 },
] as const satisfies readonly { key: string; label: string; granularity: Granularity; periods: Range }[];
export type DateRangeKey = (typeof DATE_RANGES)[number]["key"];

// Several apps' series (the same periods, asked with the same granularity and count) added up. A period
// is measured only if it is for every app: one unmeasured app leaves the total unmeasured, never a smaller sum.
export function sumSeries(all: PnlPeriod[][]): PnlPeriod[] {
  if (!all.length) return [];
  const add = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : (xs as number[]).reduce((a, b) => a + b, 0));
  return all[0].map((p, i) => {
    const at = all.map((s) => s[i]);
    if (at.some((x) => !x || x.start !== p.start)) return { ...p, revenue: null, costs: null, netIncome: null };
    return { start: p.start, end: p.end, revenue: add(at.map((x) => x.revenue)), costs: add(at.map((x) => x.costs)), netIncome: add(at.map((x) => x.netIncome)) };
  });
}

export const COLUMN_KEYS = ["this_period", "last_period", "year_to_date"] as const;
export type ColumnKey = (typeof COLUMN_KEYS)[number];
export type Values = Record<ColumnKey, number | null>;

export type PnlPeriod = { start: string; end: string; revenue: number | null; costs: number | null; netIncome: number | null };
export type PnlLine = { key: string; label: string; appId: string | null; productId: string | null; values: Values; measured: boolean; source: string | null };
export type PnlColumn = { key: ColumnKey; label: string; start: string | null; end: string | null };
export type Pnl = {
  currency: "USD";
  series: PnlPeriod[];
  columns: PnlColumn[];
  revenue: PnlLine[];
  costs: PnlLine[];
  totals: { revenue: Values; costs: Values; netIncome: Values };
  unmeasured: { key: string; label: string; reason: string }[];
};

const DEFAULT_LABELS: Record<ColumnKey, string> = { this_period: "This period", last_period: "Last period", year_to_date: "Year to date" };

function values(v: unknown): Values {
  const o = isObj(v) ? v : {};
  return { this_period: cents(o.this_period), last_period: cents(o.last_period), year_to_date: cents(o.year_to_date) };
}

function lines(v: unknown): PnlLine[] {
  return (Array.isArray(v) ? v : []).filter(isObj).flatMap((l) => {
    const key = str(l.key);
    if (!key) return [];
    const vals = values(l.values);
    return [
      {
        key,
        label: str(l.label) ?? key,
        appId: str(l.app_id) ?? null,
        productId: str(l.product_id) ?? null,
        values: vals,
        // Measured only when Mynt says so; its numbers are shown either way, a null as Not measured.
        measured: l.measured === true,
        source: str(l.source) ?? null,
      },
    ];
  });
}

export function fromPnl(reply: unknown): Pnl {
  const r = isObj(reply) ? reply : {};
  const st = isObj(r.statement) ? r.statement : {};
  const given = (Array.isArray(st.columns) ? st.columns : []).filter(isObj);
  const columns = COLUMN_KEYS.map((key) => {
    const c = given.find((g) => g.key === key);
    return { key, label: str(c?.label) ?? DEFAULT_LABELS[key], start: str(c?.start) ?? null, end: str(c?.end) ?? null };
  });
  const totals = isObj(st.totals) ? st.totals : {};
  return {
    currency: "USD",
    series: (Array.isArray(r.series) ? r.series : []).filter(isObj).flatMap((p) =>
      str(p.start) && str(p.end) ? [{ start: str(p.start)!, end: str(p.end)!, revenue: cents(p.revenue_cents), costs: cents(p.costs_cents), netIncome: cents(p.net_cents) }] : [],
    ).sort((a, b) => a.start.localeCompare(b.start)),
    columns,
    revenue: lines(st.revenue),
    costs: lines(st.costs),
    totals: { revenue: values(totals.revenue), costs: values(totals.costs), netIncome: values(totals["net"]) },
    unmeasured: (Array.isArray(r.unmeasured) ? r.unmeasured : []).filter(isObj).flatMap((u) =>
      str(u.key) ? [{ key: str(u.key)!, label: str(u.label) ?? str(u.key)!, reason: str(u.reason) ?? "Mynt doesn't measure it yet." }] : [],
    ),
  };
}

// ---- shown as ----

export const NOT_MEASURED = "Not measured";
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const USD_SHORT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
export const MINUS = "−";

/** Cents as US dollars, a negative amount with a minus sign; null reads Not measured, never $0. */
export function money(c: number | null, missing = NOT_MEASURED): string {
  if (c === null) return missing;
  const s = USD.format(Math.abs(c) / 100);
  return c < 0 ? `${MINUS}${s}` : s;
}

/** For the chart's axis: $1.2K. */
export function moneyShort(c: number): string {
  const s = USD_SHORT.format(Math.abs(c) / 100);
  return c < 0 ? `${MINUS}${s}` : s;
}

/** The change from last period to this one, or null when either isn't measured. A percentage
 * only from a positive base (from a loss or from zero it would mislead). */
export function change(v: Values): { delta: number; percent: number | null } | null {
  if (v.this_period === null || v.last_period === null) return null;
  const delta = v.this_period - v.last_period;
  return { delta, percent: v.last_period > 0 ? delta / v.last_period : null };
}

export function changeText(v: Values): string {
  const c = change(v);
  if (!c) return "No comparison yet";
  const sign = c.delta > 0 ? "+" : "";
  const pct = c.percent === null ? "" : ` (${c.percent > 0 ? "+" : c.percent < 0 ? MINUS : ""}${Math.abs(c.percent * 100).toFixed(0)}%)`;
  return `${c.delta < 0 ? money(c.delta) : `${sign}${money(c.delta)}`}${pct} vs last period`;
}

const periodFmt = (g: Granularity) => (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return g === "month"
    ? d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

/** The chart's rows: one per period; an unmeasured value stays null (a gap), never 0. */
export function chartRows(series: PnlPeriod[], g: Granularity) {
  const label = periodFmt(g);
  return series.map((p) => ({ period: label(p.start), start: p.start, revenue: p.revenue, costs: p.costs, netIncome: p.netIncome }));
}

export const hasGaps = (series: PnlPeriod[]) => series.some((p) => p.revenue === null || p.costs === null || p.netIncome === null);
export const anyMeasured = (series: PnlPeriod[]) => series.some((p) => p.revenue !== null || p.costs !== null || p.netIncome !== null);
