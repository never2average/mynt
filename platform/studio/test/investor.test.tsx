// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import { InvestorView, BALANCES_UNAVAILABLE } from "@/components/investor-view";
import { ModeSwitch } from "@/components/mode-switch";
import { comingUp, depositRows, flowSeries, modesFor, MODE_KEY, portfolioOf, rememberedMode, rememberMode, statusText } from "@/lib/investor";
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
  it("offers only the views the user's roles allow; one view means no switch", () => {
    expect(modesFor({ builder: true, liquidityProvider: true })).toEqual(["builder", "investor"]);
    expect(modesFor({ builder: true, liquidityProvider: false })).toEqual(["builder"]);
    expect(modesFor({ builder: false, liquidityProvider: true })).toEqual(["investor"]);
    expect(renderToStaticMarkup(<ModeSwitch modes={["builder"]} mode="builder" onMode={() => undefined} />)).toBe("");
    const picked: string[] = [];
    render(<ModeSwitch modes={["builder", "investor"]} mode="builder" onMode={(m) => picked.push(m)} />);
    expect(screen.getByRole("button", { name: "Builder" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Investor" }));
    expect(picked).toEqual(["investor"]);
    expect(document.querySelector("[data-mode-switch]")!.innerHTML).not.toMatch(/primary|mint/);
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
});

describe("the investor view", () => {
  const wallets = { supported: true, balancesSupported: false, owner: "o", wallets: [{ address: "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV", chain: "solana" as const, network: "Solana", balances: null }], manageUrl: null, treasury: { deposit: true, withdraw: true, status: true } };
  const activity = fromClassAudit({ rows: [{ id: "f1", at: "2026-11-14T10:00:00Z", class: "financial", kind: "liquidity.commit", summary: "Committed $5,000.00", status: "settled" }] }).rows;

  it("shows the portfolio, the chart, positions, coming up, wallets and financial activity in statement style", () => {
    const html = renderToStaticMarkup(
      <InvestorView liquidity={{ kind: "ready", data: liquidity }} wallets={{ kind: "ready", data: wallets }} activity={{ kind: "ready", data: activity }} attention={{ kind: "ready", data: [] }} now={NOW} />,
    );
    expect(html).not.toContain('data-slot="card"');
    for (const s of ["portfolio", "pnl-chart", "positions", "coming-up", "wallets", "financial-activity"]) expect(html).toContain(`data-section="${s}"`);
    expect(html).toMatch(/data-stat="committed"[\s\S]*?\$6,250\.00/);
    expect(html).toMatch(/data-stat="committed"[\s\S]*?data-split[^>]*>Devnet \$1,250\.00 · Rails \$5,000\.00</);
    expect(html).toMatch(/data-stat="returns"[\s\S]*?>Not measured</);
    expect(html).toContain("Capital in and paid out");
    expect(html).toMatch(/data-deposit="Dep1"[\s\S]*?data-source="devnet"[\s\S]*?Locked until 2026-11-25/);
    expect(html).toMatch(/data-deposit="rails-p-rails"[\s\S]*?data-source="rails"[\s\S]*?Verified · #7/);
    expect(html).toContain('href="/earn?tab=my-positions"');
    expect(html.match(/data-coming-up=/g)).toHaveLength(4);
    expect(html).toContain(BALANCES_UNAVAILABLE);
    expect(html).toContain("liquidity.commit");
    expect(html).toContain('href="/audits?tab=financial"');
    expect(html).not.toContain("$0.00</dd>"); // nothing unmeasured shown as $0
  });

  it("degrades without the tools: positions, wallets and activity each say they aren't available yet", () => {
    const html = renderToStaticMarkup(<InvestorView liquidity={{ kind: "unsupported" }} wallets={{ kind: "unsupported" }} activity={{ kind: "unsupported" }} attention={{ kind: "unsupported" }} now={NOW} />);
    expect(html.match(/data-empty="not-available"/g)!.length).toBeGreaterThanOrEqual(5);
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
