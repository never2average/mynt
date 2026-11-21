// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { InvestorView } from "@/components/investor-view";
import { ModeSwitch } from "@/components/mode-switch";
import { comingUp, defaultInvestorFilter, depositRows, filterPositions, flowSeries, modesFor, MODE_KEY, portfolioOf, rememberedMode, rememberMode, statusText } from "@/lib/investor";
import { fromPositions, fromWithdrawals, type LiquidityData } from "@/lib/liquidity";
import { fromClassAudit } from "@/lib/audit-classes";

afterEach(cleanup);

const NOW = Date.parse("2026-11-15T12:00:00Z");
const USDC = (dollars: number) => String(dollars * 1_000_000); // base units

// One rails position and one on-chain devnet position (core #190's list_my_positions rows).
const positions = fromPositions({
  positions: [
    { pool_id: "p-rails", name: "Harbor credit pool", product_id: "prod1", pool_status: "cleared", contributed_cents: 500000, pending_in_cents: 0, balance_cents: 400000, queued_withdrawal_cents: 50000, withdrawn_cents: 100000, available_to_withdraw_cents: 0 },
    {
      source: "on-chain",
      cluster: "devnet",
      pool_id: "p-chain",
      name: "Cards treasury",
      product_id: "prod2",
      sandbox: true,
      deposits: [
        { deposit: "Dep1", amount: USDC(1000), remaining: USDC(1000), queued: "0", settled_at: "2026-10-03T00:00:00Z", review_until: "2026-10-04T00:00:00Z", unlock_at: "2026-11-25T00:00:00Z", unlocked: false, rejected: false },
        { deposit: "Dep2", amount: USDC(200), remaining: USDC(200), queued: USDC(200), settled_at: "2026-09-10T00:00:00Z", review_until: "2026-09-11T00:00:00Z", unlocks_at: "2026-10-10T00:00:00Z", unlocked: true, rejected: false },
        { deposit: "Dep3", amount: USDC(50), remaining: USDC(50), queued: "0", settled_at: "2026-11-15T00:00:00Z", review_until: "2026-11-16T00:00:00Z", unlock_at: "2027-02-15T00:00:00Z", unlocked: false, rejected: false },
        { deposit: "Dep4", amount: USDC(70), remaining: "0", queued: "0", settled_at: "2026-11-01T00:00:00Z", review_until: "2026-11-02T00:00:00Z", unlock_at: "2026-11-02T00:00:00Z", unlocked: true, rejected: true },
      ],
      requests: [{ address: "Req1", deposit: "Dep2", amount: USDC(200), remaining: USDC(200), paid: USDC(0), payable_at: "2026-12-01T00:00:00Z", status: "open" }],
    },
  ],
});
const withdrawals = fromWithdrawals({ withdrawals: [{ id: "w1", pool_id: "p-rails", pool_name: "Harbor credit pool", amount_cents: 50000, status: "queued", eligible_at: "2026-11-20T00:00:00Z", settled_cents: 0 }] });
const pools = [
  { id: "p-rails", health: { verified: true, snapshotStatus: "ok", sequence: 7, periodEnd: "2026-11-01", latestVerifiedEnd: "2026-11-01", coverageBps: 12000, headroomCents: 1, reason: null } },
  { id: "p-chain", health: null },
] as unknown as NonNullable<LiquidityData["provider"]>["pools"];
const liquidity: LiquidityData = { supported: true, access: { builder: true, liquidityProvider: true }, provider: { pools, positions, withdrawals, canCommit: true, canWithdraw: true } };

describe("the Builder / Investor switch", () => {
  it("offers only the views the user's roles allow; one view means no switch", async () => {
    expect(modesFor({ builder: true, liquidityProvider: true })).toEqual(["builder", "investor"]);
    expect(modesFor({ builder: true, liquidityProvider: false })).toEqual(["builder"]);
    expect(modesFor({ builder: false, liquidityProvider: true })).toEqual(["investor"]);
    expect(renderToStaticMarkup(<ModeSwitch modes={["builder"]} mode="builder" onMode={() => undefined} />)).toBe("");
    const picked: string[] = [];
    render(<ModeSwitch modes={["builder", "investor"]} mode="builder" onMode={(m) => picked.push(m)} />);
    await act(async () => undefined);
    // A breadcrumb: "/" then a plain dropdown showing the current view; no tabs.
    const sw = document.querySelector("[data-mode-switch]")!;
    expect(sw.querySelector("[data-breadcrumb-separator]")?.textContent?.trim()).toBe("/");
    expect(sw.querySelector('[role="tab"], [role="tablist"]')).toBeNull();
    const trigger = screen.getByRole("button", { name: "Dashboard view: Builder" });
    expect(trigger.textContent).toContain("Builder");
    expect(trigger.getAttribute("data-variant")).toBe("ghost");
    expect(sw.outerHTML).not.toMatch(/primary|mint/);
    // The menu (opened from the keyboard) lists both, with a check on the current one.
    await act(async () => {
      fireEvent.keyDown(trigger, { key: "Enter" });
    });
    const menu = document.querySelector("[data-mode-menu]")!;
    expect([...menu.querySelectorAll("[data-mode]")].map((i) => i.textContent)).toEqual(["Builder", "Investor"]);
    expect(menu.querySelector('[data-mode="builder"]')!.getAttribute("aria-current")).toBe("true");
    expect(menu.querySelector('[data-mode="builder"] [aria-label="Current view"]')).not.toBeNull();
    expect(menu.querySelector('[data-mode="investor"] [aria-label="Current view"]')).toBeNull();
    await act(async () => {
      fireEvent.click(menu.querySelector('[data-mode="investor"]')!);
    });
    expect(picked).toEqual(["investor"]);
  });

  it("remembers the choice per user in this browser, only while the roles still allow it, and survives blocked storage", () => {
    localStorage.clear();
    rememberMode("investor", "u1");
    expect(localStorage.getItem(`${MODE_KEY}.u1`)).toBe("investor");
    expect(rememberedMode(["builder", "investor"], "u1")).toBe("investor");
    expect(rememberedMode(["builder", "investor"], "u2")).toBe("builder"); // another user
    expect(rememberedMode(["builder"], "u1")).toBe("builder"); // no longer allowed
    const blocked = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(rememberedMode(["investor", "builder"], "u1", blocked)).toBe("investor");
    expect(() => rememberMode("builder", "u1", blocked)).not.toThrow();
  });
});

describe("the investor model", () => {
  it("reads on-chain deposits and requests in cents, alongside rails positions", () => {
    const chain = positions.find((p) => p.onChain)!;
    expect(chain.deposits.map((d) => [d.deposit, d.amountCents])).toEqual([["Dep1", 100000], ["Dep2", 20000], ["Dep3", 5000], ["Dep4", 7000]]);
    expect(chain.deposits[1].unlockAt).toBe("2026-10-10T00:00:00Z"); // from unlocks_at
    expect(chain.requests[0]).toMatchObject({ address: "Req1", remainingCents: 20000, paidCents: 0, status: "open" });
    expect(positions.find((p) => !p.onChain)!.deposits).toEqual([]);
  });

  it("totals the portfolio, split by source; returns are not measured", () => {
    const p = portfolioOf(positions);
    expect(p.bySource.rails).toEqual({ committed: 500000, settled: 400000, queued: 50000, paid: 100000 });
    expect(p.bySource.devnet).toEqual({ committed: 125000, settled: 125000, queued: 20000, paid: 0 }); // the rejected deposit isn't counted
    expect(p.all).toEqual({ committed: 625000, settled: 525000, queued: 70000, paid: 100000 });
    expect(p.returns).toBeNull();
  });

  it("gives each deposit its status: in review, locked until, available, queued, rejected", () => {
    const rows = depositRows(positions, pools, NOW);
    expect(rows.map((r) => [r.key, r.source, statusText(r)])).toEqual([
      ["rails-p-rails", "rails", "Queued"],
      ["Dep1", "devnet", "Locked until 2026-11-25"],
      ["Dep2", "devnet", "Queued"],
      ["Dep3", "devnet", "In review until 2026-11-16"],
      ["Dep4", "devnet", "Rejected"],
    ]);
    expect(rows[0].health?.sequence).toBe(7);
  });

  it("lists what comes up in the next 30 days, soonest first", () => {
    expect(comingUp(positions, withdrawals, NOW).map((c) => [c.at.slice(0, 10), c.kind, c.source, c.amountCents])).toEqual([
      ["2026-11-16", "review_ends", "devnet", 5000],
      ["2026-11-20", "payable", "rails", 50000],
      ["2026-11-25", "unlock", "devnet", 100000],
      ["2026-12-01", "payable", "devnet", 20000],
    ]);
    // Dep3 unlocks in February: outside the window.
    expect(comingUp(positions, withdrawals, NOW).some((c) => c.key === "Dep3-unlock")).toBe(false);
  });

  it("counts capital in and paid out per period from dated on-chain history; rails-only is a gap, never 0", () => {
    const { series, railsUnmeasured } = flowSeries(positions, "month", 3, NOW);
    expect(series.map((s) => [s.start, s.revenue, s.costs, s.netIncome])).toEqual([
      ["2026-09-01", 20000, 0, 20000],
      ["2026-10-01", 100000, 0, 100000],
      ["2026-11-01", 5000, 0, 5000],
    ]);
    expect(railsUnmeasured).toBe(true);
    const rails = flowSeries(positions.filter((p) => !p.onChain), "week", 3, NOW);
    expect(rails.series.every((s) => s.revenue === null && s.costs === null && s.netIncome === null)).toBe(true);
  });

  it("dates rails positions by their settled movements once Mynt sends them", () => {
    const dated = fromPositions({
      positions: [
        {
          source: "rails",
          pool_id: "p-dated",
          name: "Dated rails pool",
          contributed_cents: 300000,
          balance_cents: 250000,
          withdrawn_cents: 50000,
          entries: [
            { kind: "deposit", settled_amount_cents: 300000, settled_at: "2026-10-05T10:00:00Z" },
            { kind: "withdrawal", settled_amount_cents: 50000, settled_at: "2026-11-02T10:00:00Z" },
            { kind: "deposit", settled_amount_cents: null, settled_at: null }, // still on its way: not counted
          ],
        },
      ],
    });
    const { series, railsUnmeasured } = flowSeries(dated, "month", 3, NOW);
    expect(railsUnmeasured).toBe(false);
    expect(series.map((s) => [s.start, s.revenue, s.costs])).toEqual([
      ["2026-09-01", 0, 0],
      ["2026-10-01", 300000, 0],
      ["2026-11-01", 0, 50000],
    ]);
  });
});

describe("returns", () => {
  it("measures returns: the wind-down surplus claimed on chain, and a real 0 for rails pools", () => {
    const withSurplus = fromPositions({
      positions: [
        { source: "on-chain", pool_id: "p-chain", name: "Chain pool", wallet: "W1", principal: "4000000", deposited: "4000000", paid: "0", queued: "0", available_to_request: "0", surplus_claimed: "1250000", deposits: [], requests: [] },
        { source: "rails", pool_id: "p-rails", name: "Rails pool", contributed_cents: 100000, balance_cents: 100000, withdrawn_cents: 0 },
      ],
    });
    expect(portfolioOf(withSurplus).returns).toBe(125); // 1.25 USDC in cents
    expect(portfolioOf(withSurplus.filter((p) => !p.onChain)).returns).toBe(0); // rails pay back no more than went in
    // One on-chain position whose surplus isn't known: unmeasured, never a partial sum.
    const unknown = fromPositions({
      positions: [
        { source: "on-chain", pool_id: "p-chain", name: "Chain pool", wallet: "W1", principal: "4000000", deposited: "4000000", paid: "0", queued: "0", available_to_request: "0", surplus_claimed: "1250000", deposits: [], requests: [] },
        { source: "on-chain", pool_id: "p-chain-2", name: "Chain pool 2", wallet: "W2", principal: "1000000", deposited: "1000000", paid: "0", queued: "0", available_to_request: "0", surplus_claimed: null, deposits: [], requests: [] },
      ],
    });
    expect(portfolioOf(unknown).returns).toBeNull();
  });
});

describe("the investor view", () => {
  const wallets = { supported: true, balancesSupported: false, owner: "o", wallets: [{ address: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", chain: "solana" as const, network: "Solana", balances: null }], manageUrl: null, treasury: { deposit: true, withdraw: true, status: true } };
  const activity = fromClassAudit({ rows: [{ id: "f1", at: "2026-11-14T10:00:00Z", class: "financial", kind: "liquidity.commit", summary: "Committed $5,000.00", status: "settled" }] }).rows;

  it("is laid out as the builder view: key figures, one toolbar over Capital in and Paid out, then financial activity", () => {
    const html = renderToStaticMarkup(
      <InvestorView liquidity={{ kind: "ready", data: liquidity }} wallets={{ kind: "ready", data: wallets }} activity={{ kind: "ready", data: activity }} attention={{ kind: "ready", data: [] }} now={NOW} />,
    );
    expect(html).not.toContain('data-slot="card"');
    for (const s of ["portfolio", "capital-in", "paid-out", "financial-activity"]) expect(html).toContain(`data-section="${s}"`);
    // Capital in and Paid out are two panels, side by side on wide screens.
    const pair = html.match(/<div[^>]*data-chart-pair[^>]*>/)![0];
    expect(pair).toContain("@4xl/main:grid-cols-2");
    expect(html.indexOf('data-row="money"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-row="paid-out"')).toBeGreaterThan(html.indexOf('data-row="money"'));
    expect(html.indexOf('data-row="money"')).toBeGreaterThan(html.indexOf("data-chart-pair"));
    // Gone, as on the builder view: allocation, unlocks, pool health, positions, coming up, wallets, the combined chart.
    for (const s of ["allocation", "unlocks", "pool-health", "positions", "coming-up", "wallets", "pnl-chart"]) expect(html).not.toContain(`data-section="${s}"`);
    // In order: key figures, the toolbar, Capital in, Paid out below it, then activity.
    const at = (m: string) => html.indexOf(m);
    expect(at('data-section="portfolio"')).toBeLessThan(at("data-chart-filters"));
    expect(at("data-chart-filters")).toBeLessThan(at('data-section="capital-in"'));
    expect(at('data-section="capital-in"')).toBeLessThan(at('data-section="paid-out"'));
    expect(at('data-section="paid-out"')).toBeLessThan(at('data-section="financial-activity"'));
    // One toolbar: search pools, Pool, Source, Date range; no chart has its own controls.
    expect(html.match(/data-chart-filters/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Search pools"');
    for (const f of ["Pool", "Source", "Date range"]) expect(html).toContain(`data-filter="${f}"`);
    expect(html).not.toContain('aria-label="Period"');
    // The key figures: a 4 x 2 grid, money in across the top, money out and the rest below.
    expect(html).toContain('data-kpi-grid="4x2"');
    const order = [...html.matchAll(/data-kpi="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["committed", "settled", "pending", "available", "queued", "paid", "pools", "returns"]);
    expect(html).toMatch(/data-kpi="pools"[\s\S]*?>2</);
    expect(html).toMatch(/data-kpi="committed"[\s\S]*?\$6,250\.00/);
    expect(html).toMatch(/data-split[\s\S]*?Devnet: committed \$1,250\.00[\s\S]*?Rails: committed \$5,000\.00/);
    // The fixture's on-chain position doesn't say what surplus it claimed, so Returns can't be measured: said so, never $0.
    expect(html).toMatch(/data-kpi="returns"[\s\S]*?>Not measured<[\s\S]*?A surplus claim.{1,6}s amount isn.{1,6}t known/);
    expect(html).toMatch(/data-kpi="committed"[\s\S]*?data-sparkline="6"/);
    // Activity, with View all on its own row to the financial audit trail.
    expect(html).toContain("liquidity.commit");
    expect(html).toMatch(/data-view-all[\s\S]*?href="\/audits\?tab=financial"[\s\S]*?View all/);
    // Nothing unmeasured shows as $0: Returns reads Not measured; a $0.00 is only ever a measured zero
    // (nothing pending in: devnet deposits settle at once).
    const returnsCell = /data-kpi="returns"[\s\S]*?<\/div>/.exec(html)![0];
    expect(returnsCell).toContain("Not measured");
    expect(returnsCell).not.toContain("$0");
    for (const m of html.matchAll(/<dd[^>]*data-measured="(true|false)"[^>]*>\$0\.00</g)) expect(m[1]).toBe("true");
  });

  it("narrows the charts by pool, source, search and dates", () => {
    const positions = liquidity.provider!.positions;
    const f = (o: Partial<ReturnType<typeof defaultInvestorFilter>>) => ({ ...defaultInvestorFilter(new Date(NOW)), ...o });
    expect(filterPositions(positions, f({})).length).toBe(positions.length);
    expect(filterPositions(positions, f({ source: "devnet" })).every((p) => p.onChain)).toBe(true);
    expect(filterPositions(positions, f({ source: "rails" })).every((p) => !p.onChain)).toBe(true);
    const one = positions[0];
    expect(filterPositions(positions, f({ poolId: one.poolId })).map((p) => p.poolId)).toEqual([one.poolId]);
    expect(filterPositions(positions, f({ query: one.name.slice(0, 3).toUpperCase() })).some((p) => p.poolId === one.poolId)).toBe(true);
    expect(filterPositions(positions, f({ query: "no such pool" }))).toEqual([]);
    const html = renderToStaticMarkup(<InvestorView liquidity={{ kind: "ready", data: liquidity }} now={NOW} filter={f({ source: "devnet", from: "2026-10-01", to: "2026-11-15" })} />);
    expect(html).toMatch(/Source[\s\S]*?· Devnet/);
    expect(html).toMatch(/Date range[\s\S]*?· 2026-10-01 – 2026-11-15/);
  });

  it("degrades without the tools: the portfolio, both charts and activity each say they aren't available yet", () => {
    const html = renderToStaticMarkup(<InvestorView liquidity={{ kind: "unsupported" }} wallets={{ kind: "unsupported" }} activity={{ kind: "unsupported" }} attention={{ kind: "unsupported" }} now={NOW} />);
    expect(html.match(/data-empty="not-available"/g)!.length).toBeGreaterThanOrEqual(2);
    expect(html.match(/data-pnl-empty=/g)!.length).toBe(2);
    expect(html).not.toContain("$0");
  });

  it("keeps only investing items in Needs attention", () => {
    const items = [
      { id: "a", kind: "withdrawal", severity: "high" as const, title: "Withdrawal parked", detail: null, href: "/earn?tab=my-positions", linkText: null, at: null },
      { id: "b", kind: "build", severity: "high" as const, title: "Build failed", detail: null, href: "/a1", linkText: null, at: null },
    ];
    const html = renderToStaticMarkup(<InvestorView liquidity={{ kind: "ready", data: liquidity }} attention={{ kind: "ready", data: items }} now={NOW} />);
    expect(html).toContain("Withdrawal parked");
    expect(html).not.toContain("Build failed");
  });
});
