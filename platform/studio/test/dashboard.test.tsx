import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardView } from "@/components/dashboard-view";
import { PnlChart, PnlStatement, PNL_NOT_AVAILABLE } from "@/components/pnl";
import { facts, fromAppsAndBuilds, fromDashboardTool, NOT_MEASURED, usd } from "@/lib/dashboard";
import { chartRows, fromPnl, MINUS, money, changeText, sumSeries } from "@/lib/pnl";
import { chartPnlUrl } from "@/lib/dashboard-visual";

// The dashboard never shows 0 for something Mynt doesn't measure.
const render = (d: ReturnType<typeof fromDashboardTool>) => renderToStaticMarkup(<DashboardView dashboard={d} />);

const measured = {
  currency: "USD",
  period: { from: "2026-10-14", to: "2026-11-12", days: 30 },
  money_moved: { settled_usd: 125430.5, live: true },
  customers: { active_enrollments: 812 },
  handoffs: { total: 300, converted: 75, conversion_rate: 0.25 },
  build_spend: { month_usd: 42.1, monthly_cap_usd: 200 },
  earnings: { usd: null, tracked: false },
  daily: [
    { date: "2026-11-02", money_moved_usd: 1200 },
    { date: "2026-11-01", money_moved_usd: 800 },
  ],
  apps: [
    { app_id: "a1", name: "Round-up savings", status: "published", money_moved_usd: 125430.5, customers: 812, conversion_rate: 0.25, last_build: { id: "b9", status: "succeeded", at: "2026-11-10T12:00:00Z" } },
  ],
};

describe("dashboard model", () => {
  it("reads Mynt's dashboard, keeping unmeasured figures null", () => {
    const d = fromDashboardTool(measured);
    expect(d.moneyMoved).toBe(125430.5);
    expect(d.conversion).toBe(0.25);
    expect(d.earnings).toBeNull(); // not tracked, whatever number came with it
    expect(d.daily?.map((x) => x.date)).toEqual(["2026-11-01", "2026-11-02"]);
    expect(fromDashboardTool({ ...measured, earnings: { usd: 0, tracked: false } }).earnings).toBeNull();
    expect(fromDashboardTool({ handoffs: { conversion_rate: 7 } }).conversion).toBeNull(); // not a rate
    expect(fromDashboardTool(null).apps).toEqual([]);
  });

  it("before Mynt has the dashboard tool: apps, last builds and build spend, money not measured", () => {
    const d = fromAppsAndBuilds([{ id: "a1", name: "Cards", status: "draft" }], {
      month_spend_usd: 12.5,
      monthly_cap_usd: 100,
      builds: [
        { id: "b1", app_id: "a1", status: "failed", updated_at: "2026-11-01" },
        { id: "b2", app_id: "a1", status: "coding", updated_at: "2026-11-05" },
      ],
    });
    expect(d.source).toBe("apps-and-builds");
    expect(d.apps[0].lastBuild).toEqual({ id: "b2", status: "coding", at: "2026-11-05" });
    expect(d.buildSpend).toBe(12.5);
    expect([d.moneyMoved, d.customers, d.handoffs, d.earnings, d.daily]).toEqual([null, null, null, null, null]);
  });
});

describe("Mynt's dashboard reply (#153)", () => {
  // As Mynt answers for a developer with an app and no money moved yet.
  const empty = {
    period: { from: "2026-10-14", to: "2026-11-12", days: 30 },
    money_moved: { settled_usd: 0, live: true },
    customers: { active_enrollments: null },
    handoffs: { total: 0, converted: 0, conversion_rate: null },
    build_spend: { month_usd: null, monthly_cap_usd: null },
    earnings: { usd: null, tracked: false },
    daily: [{ date: "2026-11-12", money_moved_usd: 0 }],
    apps: [{ app_id: "a1", name: "Cards", status: "draft", money_moved_usd: 0, customers: null, conversion_rate: null, last_build: null }],
  };

  it("shows a measured zero as $0.00, and customers (not linked to apps yet) as not measured", () => {
    const d = fromDashboardTool(empty);
    const [money, customers, handoffs, spend] = facts(d).map((k) => k.value);
    expect(money).toBe(usd(0));
    expect(customers).toBe(NOT_MEASURED);
    expect(handoffs).toBe(`0 · ${NOT_MEASURED}`);
    expect(spend).toBe(NOT_MEASURED);
    expect(d.apps[0].customers).toBeNull();
  });
});

const pnlReply = {
  currency: "USD",
  series: [
    { start: "2026-09-01", end: "2026-09-30", revenue_cents: null, costs_cents: 12000, net_cents: null },
    { start: "2026-10-01", end: "2026-10-31", revenue_cents: 50000, costs_cents: 80000, net_cents: -30000 },
    { start: "2026-11-01", end: "2026-11-30", revenue_cents: 150000, costs_cents: 40000, net_cents: 110000 },
  ],
  statement: {
    columns: [
      { key: "this_period", label: "This month", start: "2026-11-01", end: "2026-11-30" },
      { key: "last_period", label: "Last month", start: "2026-10-01", end: "2026-10-31" },
      { key: "year_to_date", label: "Year to date", start: "2026-01-01", end: "2026-11-30" },
    ],
    revenue: [{ key: "app:a1", label: "Round-up savings", app_id: "a1", values: { this_period: 150000, last_period: 50000, year_to_date: 200000 }, measured: true, source: "settled fees" }],
    costs: [
      { key: "coding_agents", label: "Coding agents", values: { this_period: 30000, last_period: 70000, year_to_date: 100000 }, measured: true, source: "builds" },
      { key: "hosting", label: "Hosting", values: { this_period: null, last_period: null, year_to_date: null }, measured: false, source: null },
    ],
    totals: {
      revenue: { this_period: 150000, last_period: 50000, year_to_date: 200000 },
      costs: { this_period: 40000, last_period: 80000, year_to_date: 120000 },
      net: { this_period: 110000, last_period: -30000, year_to_date: 80000 },
    },
  },
  unmeasured: [{ key: "hosting", label: "Hosting", reason: "Hosting costs aren't metered per workspace yet." }],
};

describe("the P&L", () => {
  const pnl = fromPnl(pnlReply);

  it("reads Mynt's answer in cents, keeping unmeasured figures null, and formats USD with a minus sign", () => {
    expect(pnl.series.map((p) => p.revenue)).toEqual([null, 50000, 150000]);
    expect(pnl.costs[1]).toMatchObject({ key: "hosting", measured: false, values: { this_period: null, last_period: null, year_to_date: null } });
    expect(fromPnl({ series: [{ start: "a", end: "b", revenue_cents: 1.5, costs_cents: "3", net_cents: 0 }] }).series[0]).toMatchObject({ revenue: null, costs: null, netIncome: 0 });
    expect(money(123456)).toBe("$1,234.56");
    expect(money(-30000)).toBe(`${MINUS}$300.00`);
    expect(money(null)).toBe(NOT_MEASURED);
    expect(money(0)).toBe("$0.00"); // a measured zero is a zero
    expect(changeText(pnl.totals.netIncome)).toBe("+$1,400.00 vs last period");
    expect(changeText(pnl.totals.revenue)).toBe("+$1,000.00 (+200%) vs last period");
    expect(changeText({ this_period: 1, last_period: null, year_to_date: null })).toBe("No comparison yet");
  });

  it("chart: one row per period, an unmeasured value stays null (a gap), never 0", () => {
    const rows = chartRows(pnl.series, "month");
    expect(rows.map((r) => r.period)).toEqual(["Sep 26", "Oct 26", "Nov 26"]);
    expect(rows[0]).toMatchObject({ revenue: null, costs: 12000, netIncome: null });
    const html = renderToStaticMarkup(<PnlChart state={{ kind: "ready", data: pnl }} granularity="month" periods={6} />);
    expect(html).toMatch(/data-pnl-gaps[^>]*>Gaps are periods Mynt didn.{1,6}t measure: Sep 26\.</);
    expect(html).toContain("data-pnl-chart");
    // The period and range toggles.
    expect(html).toMatch(/aria-pressed="true"[^>]*data-option="month"/);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-option="6"/);
    for (const o of ["week", "3", "12"]) expect(html).toContain(`data-option="${o}"`);
    // Nothing measured at all: says so, no chart of zeros.
    const none = fromPnl({ series: [{ start: "2026-11-01", end: "2026-11-30", revenue_cents: null, costs_cents: null, net_cents: null }] });
    const empty = renderToStaticMarkup(<PnlChart state={{ kind: "ready", data: none }} granularity="week" periods={3} />);
    expect(empty).toContain("Not measured yet");
    expect(empty).not.toContain("data-pnl-chart");
    expect(empty).not.toContain("$0");
  });

  it("statement: revenue and cost lines, totals, Not measured cells and the footnote; negative net in red", () => {
    const html = renderToStaticMarkup(<PnlStatement state={{ kind: "ready", data: pnl }} />);
    for (const label of ["This month", "Last month", "Year to date", "Round-up savings", "Coding agents", "Hosting", "Money moved through your apps", "Total money moved", "Total costs", "Net"]) expect(html).toContain(label);
    expect(html).not.toContain("Total revenue"); // money moved isn't earnings
    const hosting = html.slice(html.indexOf('data-line="hosting"'), html.indexOf("</tr>", html.indexOf('data-line="hosting"')));
    expect(hosting.match(/>Not measured</g)).toHaveLength(3);
    expect(hosting).not.toContain("$0");
    const net = html.slice(html.indexOf('data-total="net"'));
    expect(net).toMatch(/data-negative="true"[^>]*>−\$300\.00</);
    expect(net).toMatch(/class="[^"]*text-destructive[^"]*"[^>]*data-measured="true" data-negative="true"/);
    expect(html).toMatch(/data-pnl-footnote[\s\S]*Hosting[\s\S]*Hosting costs aren.{1,6}t metered per workspace yet\./);
  });
});

const dashboardWithApps = fromDashboardTool(measured);
const stages = { kind: "ready" as const, data: { checks: false, apps: [{ id: "a1", name: "Round-up savings", stage: "production" as const, readiness: null }] } };

describe("dashboard page", () => {
  it("is the key figures, Money moved and Costs under one set of filters, and recent activity; no cards", () => {
    const html = renderToStaticMarkup(<DashboardView dashboard={dashboardWithApps} stages={stages} pnl={{ kind: "ready", data: fromPnl(pnlReply) }} />);
    expect(html).not.toContain('data-slot="card"');
    expect(html).not.toContain('data-tile="wallet"');
    for (const s of ["kpis", "money-moved", "costs", "recent-activity"]) expect(html).toContain(`data-section="${s}"`);
    // Gone: where the money goes, money moved by app, apps by stage, the workspace facts, the statement.
    for (const s of ["pnl-chart", "cost-breakdown", "money-by-app", "apps-by-stage", "summary", "pnl-statement"]) expect(html).not.toContain(`data-section="${s}"`);
    expect(html).not.toContain('data-facts="workspace"');
    // In order: key figures, the filters, Money moved, then Costs below it.
    const at = (m: string) => html.indexOf(m);
    expect(at('data-section="kpis"')).toBeLessThan(at("data-chart-filters"));
    expect(at("data-chart-filters")).toBeLessThan(at('data-section="money-moved"'));
    expect(at('data-section="money-moved"')).toBeLessThan(at('data-section="costs"'));
    expect(html).toMatch(/data-kpi="money-moved"[\s\S]*?\$1,500\.00/);
    // One set of filters: app, app stage, date range; neither chart has its own controls.
    expect(html.match(/data-chart-filters/g)).toHaveLength(1);
    for (const f of ["app", "stage", "range"]) expect(html).toContain(`data-filter="${f}"`);
    expect(html).not.toContain('aria-label="Period"');
    // Each row is its own outlined panel.
    for (const row of ["kpis", "money", "activity"]) expect(html).toMatch(new RegExp(`data-row="${row}"[^>]*data-panel`));
  });

  it("filters the charts by app (within the stage picked), app stage and date range", () => {
    const apps = [
      { id: "a1", name: "Cards", stage: "production" as const, readiness: null },
      { id: "a2", name: "Savings", stage: "staging" as const, readiness: null },
    ];
    const html = renderToStaticMarkup(<DashboardView dashboard={dashboardWithApps} stages={{ kind: "ready", data: { checks: false, apps } }} filter={{ appId: "all", stage: "staging", range: "12w" }} />);
    const appSelect = html.slice(html.indexOf('data-filter="app"'), html.indexOf('data-filter="stage"'));
    expect(appSelect).toContain(">Savings<");
    expect(appSelect).not.toContain(">Cards<");
    for (const label of ["All stages", "Production", "Staging", "Ideas", "Last 3 months", "Last 6 months", "Last 12 months", "Last 12 weeks"]) expect(html).toContain(`>${label}<`);
    // What each filter asks the P&L route for.
    expect(chartPnlUrl({ appId: "all", stage: "all", range: "6m" }, apps)).toBe("/api/pnl?granularity=month&periods=6");
    expect(chartPnlUrl({ appId: "a1", stage: "all", range: "3m" }, apps)).toBe("/api/pnl?granularity=month&periods=3&app=a1");
    expect(chartPnlUrl({ appId: "all", stage: "staging", range: "12w" }, apps)).toBe("/api/pnl?granularity=week&periods=12&apps=a2");
    expect(chartPnlUrl({ appId: "all", stage: "idea", range: "12m" }, apps)).toBe("/api/pnl?granularity=month&periods=12&apps=");
  });

  it("adds up a stage's apps period by period, never filling an unmeasured one", () => {
    const p = (start: string, revenue: number | null, costs: number | null) => ({ start, end: start, revenue, costs, netIncome: revenue === null || costs === null ? null : revenue - costs });
    const sum = sumSeries([
      [p("2026-10", 100, 40), p("2026-11", 50, 10)],
      [p("2026-10", 20, 5), p("2026-11", null, 10)],
    ]);
    expect(sum).toEqual([p("2026-10", 120, 45), { start: "2026-11", end: "2026-11", revenue: null, costs: 20, netIncome: null }]);
    expect(sumSeries([])).toEqual([]);
  });

  it("degrades without get_workspace_pnl: the P&L says it isn't available, the rest works", () => {
    const html = renderToStaticMarkup(<DashboardView dashboard={dashboardWithApps} stages={stages} attention={{ kind: "ready", data: [] }} activity={{ kind: "ready", data: [] }} pnl={{ kind: "unsupported" }} />);
    expect(html.match(/data-pnl-empty="unsupported"/g)).toHaveLength(2); // Money moved and Costs
    expect(html).toContain(PNL_NOT_AVAILABLE.replace("&", "&amp;").replaceAll("'", "&#x27;"));
    expect(html).toContain("Round-up savings");
    expect(html).not.toContain("Nothing needs you right now"); // nothing at all when nothing needs you
    expect(html).toContain("Nothing has happened in this workspace yet");
    expect(html).not.toContain("$0");
  });

  it("says what isn't measured, and never shows $0 for it", () => {
    const d = fromAppsAndBuilds([{ id: "a1", name: "Cards", status: "draft" }], { builds: [] });
    const html = renderToStaticMarkup(<DashboardView dashboard={d} />);
    expect(html).toContain(NOT_MEASURED);
    expect(html).not.toContain("$0");
    expect(facts(d).map((k) => k.value)).toEqual([NOT_MEASURED, NOT_MEASURED, NOT_MEASURED, NOT_MEASURED]);
  });

  it("with no apps: an empty state pointing to New app", () => {
    const html = render(fromAppsAndBuilds([], { builds: [] }));
    expect(html).toContain("No apps yet");
    expect(html).toContain('href="/new"');
  });
});
