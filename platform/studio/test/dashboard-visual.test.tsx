// @vitest-environment jsdom
// The visual dashboard: KPIs with deltas and sparklines, the cost donut, money by app, the
// pipeline funnel, the activity timeline, the investor's allocation, unlock timeline and pool
// health, and the header (Builder / Investor tabs beside the title, a square theme button).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { KpiRow, Donut, HBars, PipelineFunnel, Sparkline } = await import("@/components/charts");
const { builderKpis, costSlices, deltaOf, moneyByApp, pipeline, relativeTime } = await import("@/lib/dashboard-visual");
const { fromPnl } = await import("@/lib/pnl");
const { allocation, healthState, unlockBars } = await import("@/lib/investor");
const { fromPositions } = await import("@/lib/liquidity");
const { RecentActivity } = await import("@/components/dashboard-panels");
const { fromAudit } = await import("@/lib/compliance");
const { SiteHeader } = await import("@/components/site-header");
const { HeaderTabs } = await import("@/components/header-tabs");
const { ModeSwitch } = await import("@/components/mode-switch");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

const NOW = Date.parse("2026-11-15T12:00:00Z");
const vals = (t: number | null, l: number | null, y: number | null = null) => ({ this_period: t, last_period: l, year_to_date: y });
const pnlReply = {
  series: [
    { start: "2026-09-01", end: "2026-09-30", revenue_cents: null, costs_cents: 1000, net_cents: null },
    { start: "2026-10-01", end: "2026-10-31", revenue_cents: 50000, costs_cents: 9000, net_cents: 41000 },
    { start: "2026-11-01", end: "2026-11-30", revenue_cents: 150000, costs_cents: 12000, net_cents: 138000 },
  ],
  statement: {
    revenue: Array.from({ length: 10 }, (_, i) => ({ key: `app:a${i}`, label: `App ${i}`, app_id: `a${i}`, values: vals((10 - i) * 1000, null), measured: true })),
    costs: [
      { key: "coding_agents", label: "Coding agents", values: vals(8000, 6000), measured: true },
      { key: "sandboxes", label: "Sandboxes", values: vals(2000, 2000), measured: true },
      { key: "hosting", label: "Hosting", values: vals(2000, 4000), measured: true },
      { key: "audits", label: "Audits", values: vals(0, 0), measured: true },
      { key: "mynt_fees", label: "Mynt fees", values: vals(null, null), measured: false },
    ],
    totals: { revenue: vals(150000, 50000), costs: vals(null, null), net: vals(null, null) },
  },
};
const pnl = fromPnl(pnlReply);

describe("the builder's KPIs", () => {
  it("reads build spend from the line Mynt sends (build_agents)", () => {
    const real = fromPnl({
      ...pnlReply,
      statement: { ...pnlReply.statement, costs: pnlReply.statement.costs.map((c) => (c.key === "coding_agents" ? { ...c, key: "build_agents" } : c)) },
    });
    expect(builderKpis(real, 2).find((k) => k.key === "build-spend")!.value).toBe(8000);
  });

  it("money moved, build spend, hosting and apps live, with their change; more cost is bad", () => {
    const kpis = builderKpis(pnl, 2);
    expect(kpis.map((k) => [k.key, k.value])).toEqual([["money-moved", 150000], ["build-spend", 8000], ["hosting", 2000], ["apps-live", 2]]);
    expect(kpis[0].delta).toEqual({ direction: "up", text: "200% more than last period", good: true });
    expect(kpis[1].delta).toMatchObject({ direction: "up", good: false });
    expect(kpis[2].delta).toMatchObject({ direction: "down", good: true });
    expect(kpis[0].spark).toEqual([null, 50000, 150000]);
    expect(deltaOf(vals(5, null))).toBeNull();
  });

  it("unmeasured reads Not measured, with a gap sparkline, never $0", () => {
    const kpis = builderKpis(null, null);
    expect(kpis.every((k) => k.value === null)).toBe(true);
    const html = renderToStaticMarkup(<KpiRow kpis={kpis} />);
    expect(html.match(/>Not measured</g)).toHaveLength(4);
    expect(html).not.toContain("$0");
    expect(html).toMatch(/data-kpi="money-moved"[\s\S]*?data-sparkline="none"/);
    expect(html).not.toContain('data-slot="card"');
    // A sparkline with a missing period keeps the gap.
    const spark = renderToStaticMarkup(<Sparkline points={[null, 5, 7]} label="Money moved" />);
    expect(spark).toContain('data-gaps="true"');
    expect(spark).toContain("Money moved by period: #1 Not measured, #2 $0.05, #3 $0.07.");
  });
});

describe("the cost breakdown and money by app", () => {
  it("donut slices are this period's measured costs; unmeasured ones are named apart", () => {
    const c = costSlices(pnl);
    expect(c.slices.map((s) => s.key)).toEqual(["coding_agents", "sandboxes", "hosting"]);
    expect(c.unmeasured).toEqual(["Mynt fees"]);
    const html = renderToStaticMarkup(<Donut title="Costs this period" slices={c.slices} unmeasured={c.unmeasured} empty="none" />);
    expect(html).toMatch(/data-slice="coding_agents"[\s\S]*?\$80\.00[\s\S]*?67%/);
    expect(html).toMatch(/data-unmeasured-note[^>]*>Mynt fees: not measured</);
    expect(html).toContain("Costs this period: Coding agents $80.00, Sandboxes $20.00, Hosting $20.00.");
    expect(renderToStaticMarkup(<Donut title="x" slices={[]} empty="No costs measured this period" />)).toContain('data-empty="unmeasured"');
  });

  it("horizontal bars: the top 8 apps, the rest grouped", () => {
    const rows = moneyByApp(pnl);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ label: "App 0", value: 10000 });
    expect(rows[7]).toMatchObject({ key: "other", label: "Other apps (3)", value: 3000 + 2000 + 1000 });
    const html = renderToStaticMarkup(<HBars title="Money moved by app" rows={rows} empty="none" />);
    expect(html.match(/data-bar=/g)).toHaveLength(8);
    expect(renderToStaticMarkup(<HBars title="x" rows={[]} empty="No money moved through your apps yet" />)).toContain("No money moved through your apps yet");
  });
});

describe("the pipeline funnel and the activity timeline", () => {
  it("Ideas → Staging → Production with counts and chips", () => {
    const steps = pipeline([
      { id: "a1", name: "Cards", stage: "production", readiness: null },
      { id: "a2", name: "Vault", stage: "staging", readiness: { toStage: "production", canPromote: false, failing: 1, open: 0, needsSignoff: false, signoff: null, passing: 3, total: 4 } },
      { id: "a3", name: "Allowance", stage: "idea", readiness: "not_checked" },
    ]);
    expect(steps.map((s) => [s.stage, s.count])).toEqual([["idea", 1], ["staging", 1], ["production", 1]]);
    const html = renderToStaticMarkup(<PipelineFunnel steps={steps} />);
    expect(html).toMatch(/data-chip="a2"[\s\S]*?title="3 of 4 checks passing"[\s\S]*?>3\/4</);
    expect(html).toContain('aria-label="Apps by stage, from idea to production"');
  });

  it("activity is a timeline with relative times", () => {
    expect([relativeTime("2026-11-15T11:59:30Z", NOW), relativeTime("2026-11-15T09:00:00Z", NOW), relativeTime("2026-11-12T12:00:00Z", NOW)]).toEqual(["just now", "3 h ago", "3 d ago"]);
    const events = fromAudit({ events: [{ at: "2026-11-15T09:00:00Z", actor: { name: "Ines" }, action: "app.created", target: { type: "app", name: "Cards" } }] }).events;
    const html = renderToStaticMarkup(<RecentActivity state={{ kind: "ready", data: events }} now={NOW} />);
    expect(html).toMatch(/<ol[^>]*data-timeline/);
    expect(html).toMatch(/<time[^>]*dateTime="2026-11-15T09:00:00Z"[^>]*>3 h ago</);
    expect(html).not.toContain("<table");
  });
});

describe("the investor's charts", () => {
  const positions = fromPositions({
    positions: [
      { pool_id: "p-rails", name: "Harbor", contributed_cents: 500000, balance_cents: 400000 },
      {
        source: "on-chain",
        pool_id: "p-chain",
        name: "Cards treasury",
        deposits: [
          { deposit: "D1", amount: "1000000000", remaining: "1000000000", queued: "0", settled_at: "2026-10-01T00:00:00Z", review_until: "2026-10-03T00:00:00Z", unlock_at: "2026-12-01T00:00:00Z", unlocked: false },
          { deposit: "D2", amount: "50000000", remaining: "50000000", queued: "0", settled_at: "2026-11-15T00:00:00Z", review_until: "2026-11-16T00:00:00Z", unlock_at: "2027-01-15T00:00:00Z", unlocked: false },
        ],
        requests: [],
      },
    ],
  });

  it("allocation: what's settled, by pool", () => {
    expect(allocation(positions)).toEqual([
      { key: "p-rails", label: "Harbor", value: 400000 },
      { key: "p-chain", label: "Cards treasury", value: 105000 },
    ]);
  });

  it("unlock timeline: review, then lock-in, then available, with now on the bar", () => {
    const bars = unlockBars(positions, NOW);
    expect(bars.map((b) => [b.key, b.status])).toEqual([["D1", "locked"], ["D2", "in_review"]]);
    const [d1] = bars;
    expect(d1.start < d1.reviewEnd && d1.reviewEnd < d1.now && d1.now < d1.unlock && d1.unlock < d1.end).toBe(true);
  });

  it("pool health: healthy, at risk, paused or no verified snapshot, never guessed", () => {
    const h = (o: object) => ({ verified: true, snapshotStatus: "ok", sequence: 1, periodEnd: null, latestVerifiedEnd: null, coverageBps: 12000, headroomCents: 10, reason: null, ...o });
    expect(healthState({ status: "open", pauseKind: null, health: h({}) })).toBe("healthy");
    expect(healthState({ status: "open", pauseKind: null, health: h({ coverageBps: 9000 }) })).toBe("at_risk");
    expect(healthState({ status: "paused", pauseKind: null, health: h({}) })).toBe("paused");
    expect(healthState({ status: "open", pauseKind: null, health: null })).toBe("unknown");
  });
});

describe("the header", () => {
  it("puts the dashboard's view beside the title as a breadcrumb: Dashboard / Builder ▾", async () => {
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <SiteHeader title="Dashboard" />
          <HeaderTabs>
            <ModeSwitch modes={["builder", "investor"]} mode="builder" onMode={() => undefined} />
          </HeaderTabs>
        </SidebarProvider>
      </TooltipProvider>,
    );
    await act(async () => undefined);
    const header = container.querySelector("[data-site-header]")!;
    const slot = header.querySelector("[data-header-slot]")!;
    expect(slot.previousElementSibling?.tagName).toBe("H1");
    expect(slot.querySelector('[role="tablist"], [role="tab"]')).toBeNull();
    expect(slot.textContent).toMatch(/^\s*\/\s*Builder/);
    expect(slot.querySelector("[data-mode-trigger]")).not.toBeNull();
    // The trigger shows the current view's icon.
    expect(slot.querySelector("[data-mode-trigger] [data-mode-icon]")).not.toBeNull();
  });

  it("the theme button is square, centred, with the same padding on the header's right as its left", () => {
    const theme = readFileSync(join(process.cwd(), "components/theme-switcher.tsx"), "utf8");
    expect(theme).toMatch(/variant="outline" size="icon" className="relative size-8 shrink-0 p-0"/);
    expect(theme).toMatch(/<Moon className="absolute inset-0 m-auto /);
    const header = readFileSync(join(process.cwd(), "components/site-header.tsx"), "utf8");
    expect(header).toContain('className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6"');
    expect(header).not.toContain('<SidebarTrigger className="-ml-1" />');
  });
});
