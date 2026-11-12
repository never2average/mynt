// The dashboard (the studio's home page): how the user's apps are doing, from Mynt's
// get_developer_dashboard. Pure, so the API route, the page and the tests share it.
//
// A figure Mynt doesn't measure is null and is shown as such ("Not measured", "Not tracked
// yet"), never as 0. Until Mynt offers get_developer_dashboard, the dashboard is built from
// list_my_apps and list_builds: apps, their last builds and build spend, with the money
// figures not measured.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rate = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 && n <= 1 ? n : null;
};

export type Figure = number | null;

export type DashboardApp = {
  id: string;
  name: string;
  status: string;
  moneyMoved: Figure;
  customers: Figure;
  conversion: Figure; // 0..1
  lastBuild: { id: string; status: string; at: string | null } | null;
};

export type Dashboard = {
  source: "mynt" | "apps-and-builds"; // the dashboard tool, or the fallback before it exists
  periodDays: number | null;
  moneyMoved: Figure; // settled, live
  live: boolean;
  customers: Figure; // active enrollments
  handoffs: Figure;
  converted: Figure;
  conversion: Figure;
  buildSpend: Figure; // this month
  buildCap: Figure;
  earnings: Figure; // null: not tracked
  daily: { date: string; value: number }[] | null; // money moved per day; null when not measured
  apps: DashboardApp[];
};

function lastBuild(v: unknown): DashboardApp["lastBuild"] {
  if (!isObj(v) || !str(v.id)) return null;
  return { id: str(v.id)!, status: str(v.status) ?? "unknown", at: str(v.at) ?? str(v.updated_at) ?? null };
}

// get_developer_dashboard's reply.
export function fromDashboardTool(reply: unknown): Dashboard {
  const r = isObj(reply) ? reply : {};
  const money = isObj(r.money_moved) ? r.money_moved : {};
  const customers = isObj(r.customers) ? r.customers : {};
  const handoffs = isObj(r.handoffs) ? r.handoffs : {};
  const spend = isObj(r.build_spend) ? r.build_spend : {};
  const earnings = isObj(r.earnings) ? r.earnings : {};
  const period = isObj(r.period) ? r.period : {};
  const daily = Array.isArray(r.daily)
    ? r.daily.filter(isObj).flatMap((d) => (str(d.date) && num(d.money_moved_usd) !== null ? [{ date: str(d.date)!, value: num(d.money_moved_usd)! }] : []))
    : null;
  return {
    source: "mynt",
    periodDays: num(period.days),
    moneyMoved: num(money.settled_usd),
    live: money.live === true,
    customers: num(customers.active_enrollments),
    handoffs: num(handoffs.total),
    converted: num(handoffs.converted),
    conversion: rate(handoffs.conversion_rate),
    buildSpend: num(spend.month_usd),
    buildCap: num(spend.monthly_cap_usd),
    earnings: earnings.tracked === true ? num(earnings.usd) : null,
    daily: daily && daily.length ? daily.sort((a, b) => a.date.localeCompare(b.date)) : null,
    apps: (Array.isArray(r.apps) ? r.apps : []).filter(isObj).flatMap((a) =>
      str(a.app_id)
        ? [
            {
              id: str(a.app_id)!,
              name: str(a.name) ?? "Untitled app",
              status: str(a.status) ?? "draft",
              moneyMoved: num(a.money_moved_usd),
              customers: num(a.customers),
              conversion: rate(a.conversion_rate),
              lastBuild: lastBuild(a.last_build),
            },
          ]
        : [],
    ),
  };
}

// Before Mynt has get_developer_dashboard: the apps, their newest builds and build spend.
export function fromAppsAndBuilds(appsReply: unknown, buildsReply: unknown): Dashboard {
  const builds = isObj(buildsReply) && Array.isArray(buildsReply.builds) ? buildsReply.builds.filter(isObj) : [];
  const newest = new Map<string, Obj>();
  for (const b of builds) {
    const appId = str(b.app_id);
    if (!appId) continue;
    const seen = newest.get(appId);
    if (!seen || (str(b.updated_at) ?? "") > (str(seen.updated_at) ?? "")) newest.set(appId, b);
  }
  const apps = (Array.isArray(appsReply) ? appsReply : []).filter(isObj).flatMap((a) => {
    const id = str(a.id);
    if (!id) return [];
    const b = newest.get(id);
    return [
      {
        id,
        name: str(a.name) ?? "Untitled app",
        status: str(a.status) ?? "draft",
        moneyMoved: null,
        customers: null,
        conversion: null,
        lastBuild: b ? { id: str(b.id) ?? "", status: str(b.status) ?? "unknown", at: str(b.updated_at) ?? null } : null,
      },
    ];
  });
  const r = isObj(buildsReply) ? buildsReply : {};
  return {
    source: "apps-and-builds",
    periodDays: null,
    moneyMoved: null,
    live: false,
    customers: null,
    handoffs: null,
    converted: null,
    conversion: null,
    buildSpend: num(r.month_spend_usd),
    buildCap: num(r.monthly_cap_usd),
    earnings: null,
    daily: null,
    apps,
  };
}

// --- shown as -----------------------------------------------------------------------------------

export const NOT_MEASURED = "Not measured";
export const NOT_TRACKED = "Not tracked yet";

export function usd(v: Figure, missing = NOT_MEASURED): string {
  if (v === null) return missing;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v);
}

export function count(v: Figure, missing = NOT_MEASURED): string {
  return v === null ? missing : new Intl.NumberFormat("en-US").format(v);
}

export function percent(v: Figure, missing = NOT_MEASURED): string {
  return v === null ? missing : `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
}
