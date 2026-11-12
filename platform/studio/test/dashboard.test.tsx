import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardView } from "@/components/dashboard-view";
import { kpis } from "@/components/section-cards";
import { fromAppsAndBuilds, fromDashboardTool, NOT_MEASURED, NOT_TRACKED, usd } from "@/lib/dashboard";

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
    const [money, customers, handoffs, spend, earnings] = kpis(d).map((k) => k.value);
    expect(money).toBe(usd(0));
    expect(customers).toBe(NOT_MEASURED);
    expect(handoffs).toBe(`0 · ${NOT_MEASURED}`);
    expect(spend).toBe(NOT_MEASURED);
    expect(earnings).toBe(NOT_TRACKED);
    expect(d.apps[0].customers).toBeNull();
  });
});

describe("dashboard page", () => {
  it("shows measured figures, the chart and the apps table", () => {
    const html = render(fromDashboardTool(measured));
    expect(html).toContain(usd(125430.5));
    expect(html).toContain("812");
    expect(html).toContain("25%");
    expect(html).toContain("Money moved per day");
    expect(html).toContain("Round-up savings");
    expect(html).toContain('href="/a1/b9"');
    expect(html).toContain(NOT_TRACKED); // earnings
  });

  it("says what isn't measured, and never shows $0 for it", () => {
    const d = fromAppsAndBuilds([{ id: "a1", name: "Cards", status: "draft" }], { builds: [] });
    const html = render(d);
    expect(html).toContain(NOT_MEASURED);
    expect(html).toContain(NOT_TRACKED);
    expect(html).toContain("Not measured yet"); // the chart's card
    expect(html).not.toContain("$0");
    const values = kpis(d).map((k) => k.value);
    expect(values).toEqual([NOT_MEASURED, NOT_MEASURED, NOT_MEASURED, NOT_MEASURED, NOT_TRACKED]);
  });

  it("with no apps: an empty state pointing to New app", () => {
    const html = render(fromAppsAndBuilds([], { builds: [] }));
    expect(html).toContain("No apps yet");
    expect(html).toContain('href="/new"');
    expect(html).not.toContain("Your apps"); // no empty table
  });
});
