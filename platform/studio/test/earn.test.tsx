import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarView } from "@/components/app-sidebar";
import { PoolsTab } from "@/components/earn-assistant";
import { CommitForm, commitOutcome, EarnTable, positionFigures, ProposeForm, requestRows, WithdrawForm, withdrawalOutcome, type LiquidityActions } from "@/components/earn-view";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  accessFrom,
  commitRefusal,
  earnTabFromQuery,
  fromPools,
  fromPoolsWithHealth,
  fromPositions,
  fromProductHealth,
  fromSponsorships,
  fromWithdrawals,
  healthFor,
  pageOf,
  poolsShowAllFromQuery,
  parseUsd,
  proposalFrom,
  STAGE_LABELS,
  stageOf,
  tabOpensPanel,
  tabsFor,
  usd,
  walletLinksFor,
  withdrawalRefusal,
  type LiquidityData,
  type PoolRow,
} from "@/lib/liquidity";
import { pageTitle } from "@/lib/studio-search";
import { groupByStage } from "@/lib/workspaces";

// Mynt's list_pools rows (core/src/liquidity.ts toPool).
const poolRow = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  product_id: "card-credit",
  component_key: "lending",
  sponsor_entity_id: "22222222-2222-4222-8222-222222222222",
  name: "Card float",
  currency: "USD",
  sandbox: false,
  status: "open",
  pause_kind: null,
  pause_reason: null,
  hold_reason: null,
  min_reserve_bps: 2000,
  min_reserve_floor_cents: 100_000,
  notice_period_days: 30,
  min_commitment_cents: 100_000,
  max_commitment_cents: 10_000_000,
  deposit_rail_id: "33333333-3333-4333-8333-333333333333",
  withdrawal_rail_id: "44444444-4444-4444-8444-444444444444",
  approved_at: "2026-11-01T00:00:00.000Z",
  offering_cleared: true,
  created_at: "2026-10-30T00:00:00.000Z",
  ...over,
});
const row = (over: Record<string, unknown> = {}): PoolRow => ({ ...fromPools([poolRow(over)])[0], queueLength: 2, health: null });
const CLEARED = row();
const UNCLEARED = row({ id: "11111111-1111-4111-8111-111111111112", name: "Uncleared", offering_cleared: false });
const SANDBOX = row({ id: "11111111-1111-4111-8111-111111111113", name: "Test pool", sandbox: true, offering_cleared: false });
const PROPOSED = row({ id: "11111111-1111-4111-8111-111111111114", name: "New pool", approved_at: null, status: "paused", pause_kind: "awaiting_approval", deposit_rail_id: null, withdrawal_rail_id: null });

const positionReply = { pool_id: CLEARED.id, name: "Card float", product_id: "card-credit", sandbox: false, pool_status: "open", state: "us-ny", contributed_cents: 500_000, withdrawn_cents: 100_000, balance_cents: 400_000, pending_in_cents: 50_000, pending_out_cents: 0, queued_withdrawal_cents: 100_000, available_to_withdraw_cents: 300_000, exited: false };
const POSITION = fromPositions([positionReply])[0];

const noActions: LiquidityActions = { propose: async () => ({ ok: true, reply: null }), commit: async () => ({ ok: true, reply: null }), withdraw: async () => ({ ok: true, reply: null }) };
const data = (over: Partial<LiquidityData> & { access: LiquidityData["access"] }): LiquidityData => ({
  supported: true,
  builder: over.access.builder ? { pools: [PROPOSED, UNCLEARED], proposable: [{ productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "22222222-2222-4222-8222-222222222222", sponsorName: "Harbor Bank" }], withdrawalsShown: true } : undefined,
  provider: over.access.liquidityProvider ? { pools: [CLEARED, UNCLEARED, SANDBOX], positions: [POSITION], withdrawals: [], canCommit: true, canWithdraw: true } : undefined,
  ...over,
});
// One of Earn's tabs: Pools (cards, every pool open to the user, with Commit capital; it took in
// Opportunities), or the table tabs My positions and My pools.
const view = (d: LiquidityData, tab?: "pools" | "my-positions" | "my-pools", form: Parameters<typeof EarnTable>[0]["initialForm"] = null) => {
  const t = tab ?? (d.access.liquidityProvider ? "pools" : "my-pools");
  return renderToStaticMarkup(t === "pools" ? <PoolsTab data={d} poolIds={null} actions={noActions} initialForm={form} /> : <EarnTable data={d} actions={noActions} tab={t} initialForm={form} />);
};

describe("Earn by role", () => {
  it("everyone with a liquidity role gets Pools; builders (developer or innovator) My pools; liquidity providers My positions and My strategies", () => {
    expect(accessFrom(["developer", "consumer", "innovator"])).toEqual({ builder: true, liquidityProvider: false });
    expect(accessFrom(["liquidity_provider"])).toEqual({ builder: false, liquidityProvider: true });
    expect(tabsFor(accessFrom(["innovator"]))).toEqual(["pools", "my-pools"]);
    expect(tabsFor(accessFrom(["liquidity_provider"]))).toEqual(["pools", "my-positions", "my-strategies"]);
    expect(tabsFor(accessFrom(["developer", "liquidity_provider"]))).toEqual(["pools", "my-positions", "my-pools", "my-strategies"]);
    expect(tabsFor(accessFrom(["consumer"]))).toEqual([]);
    expect(view(data({ access: { builder: false, liquidityProvider: true } }), "my-positions")).toContain('data-tab-panel="my-positions"');
  });

  it("maps ?tab= (and /liquidity's, the old Opportunities', Drafts' and Assistant's tabs) to the right-hand tab", () => {
    expect(["pools", "opportunities", "open-pools", "my-positions", "my-pools", "drafts", "my-strategies", "assistant", "nope", undefined].map(earnTabFromQuery)).toEqual([
      "pools",
      "pools",
      "pools",
      "my-positions",
      "my-pools",
      "my-strategies",
      "my-strategies",
      "pools",
      "pools",
      "pools",
    ]);
    // The old Opportunities is Pools showing all pools, opened at once.
    expect(["opportunities", "open-pools", "pools", "drafts", undefined].map(poolsShowAllFromQuery)).toEqual([true, true, false, false, false]);
    expect(["opportunities", "drafts", "my-strategies", "pools", "assistant", undefined].map(tabOpensPanel)).toEqual([true, true, true, false, false, false]);
  });

  it("the header's wallet control links to /earn by role (test/wallet-control.test.tsx renders it)", () => {
    expect(walletLinksFor({ builder: true, liquidityProvider: true })).toEqual([
      { label: "Manage pools", href: "/earn?tab=my-pools" },
      { label: "Provide liquidity", href: "/earn?tab=opportunities" },
    ]);
    expect(walletLinksFor({ builder: false, liquidityProvider: true }).map((l) => l.label)).toEqual(["Provide liquidity"]);
    expect(walletLinksFor({ builder: false, liquidityProvider: false })).toEqual([]);
    expect(walletLinksFor(null)).toEqual([]);
  });

  it("the sidebar has Search chats (an icon with a tooltip when collapsed) and, open, the five most recent chats", () => {
    const at = (i: number) => `2026-11-${String(10 + i).padStart(2, "0")}T10:00:00Z`;
    const threads = Array.from({ length: 7 }, (_, i) => ({ id: `t${i}`, title: `Question ${i}`, updatedAt: at(i), messages: [], outcomes: {} }));
    const sidebar = (open: boolean, chats: { threads: typeof threads; onPick: () => void; onNew: () => void } | null) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <SidebarProvider defaultOpen={open}>
            <SidebarView
              workspaces={[{ id: "w1", name: "Acme", role: "owner" }]}
              selected={{ id: "w1", name: "Acme", role: "owner" }}
              supported
              groups={groupByStage([])}
              account={{ name: null, email: null }}
              pathname="/"
              onSelectWorkspace={() => undefined}
              onCreateWorkspace={async () => null}
              liquidity
              chats={chats}
            />
          </SidebarProvider>
        </TooltipProvider>,
      );
    const chats = { threads, onPick: () => undefined, onNew: () => undefined };
    for (const open of [true, false]) {
      const html = sidebar(open, chats);
      // In both states: Search chats, first above the pages, with its label (shown as a tooltip when collapsed).
      expect(html).toMatch(/data-search-chats[^>]*>[\s\S]*?Search chats/);
      expect(html.indexOf("data-search-chats")).toBeLessThan(html.indexOf('href="/"'));
      // Recent chats: five, newest as given; hidden while collapsed.
      expect((html.match(/data-recent-chat=/g) ?? []).length).toBe(5);
      expect(html.match(/<[^>]*data-recent-chats[^>]*>/)![0]).toContain("group-data-[collapsible=icon]:hidden");
    }
    // No chats to search without Earn or a known user.
    const none = sidebar(true, null);
    expect(none).not.toContain("data-search-chats");
    expect(none).not.toContain("data-recent-chats");
  });

  it("the sidebar lists Earn (in place of Liquidity) after Settings only for builders and liquidity providers", () => {
    const sidebar = (liquidity: boolean) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <SidebarProvider>
            <SidebarView
              workspaces={[{ id: "w1", name: "Acme", role: "owner" }]}
              selected={{ id: "w1", name: "Acme", role: "owner" }}
              supported
              groups={groupByStage([])}
              account={{ name: null, email: null }}
              pathname="/earn"
              onSelectWorkspace={() => undefined}
              onCreateWorkspace={async () => null}
              liquidity={liquidity}
            />
          </SidebarProvider>
        </TooltipProvider>,
      );
    const on = sidebar(true);
    expect(on).toContain('href="/earn"');
    expect(on).toMatch(/href="\/earn"[\s\S]*?>Earn</);
    expect(on).not.toContain('href="/liquidity"');
    expect(on.indexOf('href="/settings"')).toBeLessThan(on.indexOf('href="/earn"'));
    expect(sidebar(false)).not.toContain('href="/earn"');
    // /earn is a studio page with its own title, not an app; /liquidity redirects there.
    expect(pageTitle("/earn")).toBe("Earn");
    expect(pageTitle("/liquidity")).toBe("Earn");
  });
});

describe("a pool's state", () => {
  it("tells proposed, sandbox, uncleared and cleared pools apart", () => {
    expect([PROPOSED, SANDBOX, UNCLEARED, CLEARED].map(stageOf)).toEqual(["awaiting_approval", "sandbox", "uncleared", "cleared"]);
    expect(STAGE_LABELS.uncleared).toBe("Sandbox only — not yet cleared for real commitments");
    const html = view(data({ access: { builder: false, liquidityProvider: true } }));
    // A dot and its words (it was an outlined badge).
    expect(html).toMatch(/data-stage="cleared"[^>]*data-tone="green"><span aria-hidden="true"[^>]*><\/span>Cleared for real commitments</);
    expect(html).toMatch(/data-stage="uncleared"[^>]*data-tone="amber"><span aria-hidden="true"[^>]*><\/span>Sandbox only — not yet cleared for real commitments</);
    expect(html).toMatch(/data-stage="sandbox"[^>]*data-tone="blue"><span aria-hidden="true"[^>]*><\/span>Sandbox — test money only</);
    expect(html).not.toContain('data-slot="badge"');
  });

  it("the builder sees each pool's state, rails, terms, health and queue, and the sponsor-approval requirement", () => {
    const health = fromProductHealth([
      { product_id: "card-credit", pool_id: UNCLEARED.id, snapshots: [{ sequence: 7, status: "pending_signature", verified: false, period_end: "2026-11-13T00:00:00Z" }, { sequence: 6, status: "published", verified: true, period_end: "2026-11-12T00:00:00Z" }] },
    ]);
    const d = data({ access: { builder: true, liquidityProvider: false } });
    d.builder!.pools = [PROPOSED, { ...UNCLEARED, health: healthFor(health, UNCLEARED) }];
    const html = view(d);
    expect(html).toContain("Proposed — awaiting sponsor approval");
    expect(html).toContain("Waiting for approval");
    expect(html).toContain("None yet");
    expect(html).toContain("Deposit and withdrawal rails approved");
    expect(html).toContain("20% of obligations, at least $1,000.00");
    expect(html).toContain("30 days");
    expect(html).toContain("$1,000.00 – $100,000.00 per firm");
    expect(html).toContain("Not verified · #7 to 2026-11-13");
    expect(html).toContain("Last verified to 2026-11-12");
    expect(html).toMatch(/data-queue="true"[^>]*>2</);
    // Capital isn't shown to builders by Mynt, so there's no column that only ever said so (never 0 either).
    expect(html).not.toContain("Not shown to builders yet");
    expect(html).not.toContain("Committed / settled");
    // No explainer under the pools when nothing stops a proposal (only a reason it can't be proposed shows there).
    expect(html).not.toContain("data-sponsor-note");
    expect(html).not.toContain("Pools can be proposed only on a component");
    expect(html).toMatch(/data-cta="propose"[^>]*>Propose pool</);
    expect(html).not.toMatch(/data-cta="propose"[^>]*disabled/);
  });

  it("Propose pool is disabled, and says why, without an approved sponsorship or the tool", () => {
    const d = data({ access: { builder: true, liquidityProvider: false } });
    d.builder!.proposable = [];
    expect(view(d)).toMatch(/disabled=""[^>]*data-cta="propose"|data-cta="propose"[^>]*disabled/);
    expect(view(d)).toContain("A licence provider must sponsor a component of one of your products before it can have a pool.");
    d.builder!.proposable = null;
    expect(view(d)).toContain("Proposing pools comes with Mynt&#x27;s next update.");
  });

  it("the proposal form names the sponsor's approval and sends cents and basis points", () => {
    const d = data({ access: { builder: true, liquidityProvider: false } });
    // The form opens in a sheet from Propose pool (test/earn-assistant.test.tsx opens it); its one line says what proposing does.
    const option = d.builder!.proposable![0];
    const html = renderToStaticMarkup(<ProposeForm options={[option]} actions={noActions} onDone={() => undefined} />);
    expect(html).toContain("Harbor Bank must approve it and name the money rails");
    expect(html).toContain("real-money commitments also wait for a Mynt admin to clear it");
    expect(proposalFrom({ option, name: " Float ", sandbox: true, reservePercent: "12.5", reserveFloor: "1,000", noticeDays: "14", minCommit: "500", maxCommit: "250,000.50" }, [option])).toEqual({
      product_id: "card-credit",
      component_key: "lending",
      name: "Float",
      sandbox: true,
      min_reserve_bps: 1250,
      min_reserve_floor_cents: 100_000,
      notice_period_days: 14,
      min_commitment_cents: 50_000,
      max_commitment_cents: 25_000_050,
    });
    expect(proposalFrom({ option, name: "x", sandbox: false, reservePercent: "20", reserveFloor: "0", noticeDays: "0", minCommit: "900", maxCommit: "100" }, [option])).toEqual({ error: "The smallest commitment can't be more than the largest." });
    // Two sponsors of the same component: the sponsor is named.
    const other = { ...option, sponsorId: "55555555-5555-4555-8555-555555555555" };
    expect(proposalFrom({ option: other, name: "x", sandbox: true, reservePercent: "20", reserveFloor: "0", noticeDays: "0", minCommit: "1", maxCommit: "2" }, [option, other])).toMatchObject({ sponsor_entity_id: other.sponsorId });
  });
});

describe("committing capital", () => {
  it("is refused outside the pool's limits, before approval, while uncleared, paused or closed", () => {
    expect(commitRefusal(CLEARED, null, 500_000)).toBeNull();
    expect(commitRefusal(CLEARED, null, 50_000)).toBe("A firm's position in this pool must be at least $1,000.00.");
    expect(commitRefusal(CLEARED, null, 10_000_001)).toMatch(/over this pool's limit of \$100,000\.00 per firm/);
    // Settled plus on its way in counts toward the limit.
    expect(commitRefusal(CLEARED, POSITION, 9_550_001)).toMatch(/over this pool's limit/);
    expect(commitRefusal(CLEARED, POSITION, 9_550_000)).toBeNull();
    expect(commitRefusal(CLEARED, null, null)).toBe("Enter an amount in dollars.");
    expect(commitRefusal(UNCLEARED, null, 500_000)).toMatch(/^Sandbox only — not yet cleared for real commitments/);
    expect(commitRefusal(SANDBOX, null, 500_000)).toBeNull();
    expect(commitRefusal(PROPOSED, null, 500_000)).toMatch(/isn't approved yet/);
    expect(commitRefusal(row({ status: "paused", pause_kind: "manual", pause_reason: "Rail review" }), null, 500_000)).toBe("This pool is paused: Rail review.");
    expect(commitRefusal(row({ status: "closed" }), null, 500_000)).toMatch(/closed/);
    // A health pause is Mynt's to judge (a pool short of its reserve may still take capital).
    expect(commitRefusal(row({ status: "paused", pause_kind: "health" }), null, 500_000)).toBeNull();
  });

  it("disables Commit capital on an uncleared pool and says why", () => {
    const html = view(data({ access: { builder: false, liquidityProvider: true } }));
    expect(html).toMatch(new RegExp(`disabled=""[^>]*title="Sandbox only — not yet cleared for real commitments[^"]*"[^>]*data-commit="${UNCLEARED.id}"`));
    expect(html).not.toMatch(new RegExp(`disabled=""[^>]*data-commit="${CLEARED.id}"`));
    expect(html).not.toMatch(new RegExp(`disabled=""[^>]*data-commit="${SANDBOX.id}"`));
    const form = renderToStaticMarkup(<CommitForm pools={[UNCLEARED]} positions={[]} poolId={UNCLEARED.id} canCommit actions={noActions} onDone={() => undefined} newKey={() => "key-12345678"} />);
    expect(form).toMatch(/disabled=""[^>]*data-submit="commit"/);
    expect(form).toContain("Sandbox only — not yet cleared for real commitments. A Mynt admin must clear this pool&#x27;s offering");
  });

  it("locks the US state to the position's, shows the terms, and words the outcome as a deposit asked for, not a transfer done", () => {
    const form = renderToStaticMarkup(<CommitForm pools={[CLEARED]} positions={[POSITION]} poolId={CLEARED.id} canCommit actions={noActions} onDone={() => undefined} newKey={() => "key-12345678"} />);
    expect(form).toMatch(/disabled=""[^>]*aria-label="US state"|aria-label="US state"[^>]*disabled/);
    expect(form).toContain("$1,000.00 – $100,000.00 per firm; notice period 30 days");
    expect(form).toContain("Mynt never holds your funds");
    const out = commitOutcome({ movement_id: "m-1", movement_status: "requested" }, false);
    expect(out).toContain("Deposit requested (movement m-1, requested).");
    expect(out).toContain("counts it only once it has settled");
    expect(commitOutcome({}, true)).toContain("Sandbox pool: no real money moves.");
  });

  it("is off everywhere when this Mynt doesn't offer commit_to_pool", () => {
    const d = data({ access: { builder: false, liquidityProvider: true } });
    d.provider!.canCommit = false;
    const html = view(d);
    expect(html).toMatch(/disabled=""[^>]*data-cta="commit"|data-cta="commit"[^>]*disabled/);
    const rowButtons = [...html.matchAll(/<button[^>]*data-commit="[^"]+"[^>]*>/g)].map((m) => m[0]);
    expect(rowButtons).toHaveLength(3);
    for (const b of rowButtons) expect(b).toContain('disabled=""');
  });
});

describe("withdrawals", () => {
  it("shows committed, settled, queued and paid per position, and the firm's queue", () => {
    expect(POSITION).toMatchObject({ committedCents: 550_000, settledCents: 400_000, queuedCents: 100_000, paidCents: 100_000, availableCents: 300_000, state: "us-ny" });
    const d = data({ access: { builder: false, liquidityProvider: true } });
    d.provider!.withdrawals = fromWithdrawals([{ id: "w-1", seq: 3, pool_id: CLEARED.id, pool_name: "Card float", amount_cents: 100_000, status: "queued", eligible_at: "2026-12-14T00:00:00Z", settled_cents: 0, waiting_reason: "Waiting out the notice period until 2026-12-14T00:00:00.000Z", sandbox: false }]);
    const html = view(d, "my-positions");
    for (const amount of ["$5,500.00", "$4,000.00", "$1,000.00", "$3,000.00"]) expect(html).toContain(amount);
    // The queue is the same table's Show · Withdrawal requests (it was a section under the table).
    expect(html).toMatch(/data-filter="Show"[^>]*>Show<span[^>]*>· Positions/);
    expect(requestRows(d.provider!.withdrawals, d.provider!.positions)).toEqual([
      { key: "w-1", pool: "Card float", sandbox: false, onChain: false, wallet: null, place: "#3", asked: "$1,000.00", paid: "$0.00", status: "queued", payableFrom: "2026-12-14", why: "Waiting out the notice period until 2026-12-14T00:00:00.000Z" },
    ]);
  });

  it("the request form shows the notice period and that payment depends on verified health; it can't ask for more than is available", () => {
    const form = renderToStaticMarkup(<WithdrawForm positions={[POSITION]} pools={[CLEARED]} poolId={CLEARED.id} canWithdraw actions={noActions} onDone={() => undefined} newKey={() => "key-12345678"} />);
    expect(form).toContain("first in, first out, no sooner than 30 days after you ask");
    expect(form).toContain("latest verified health snapshot keeps it above its minimum reserve");
    expect(form).toContain("Mynt never holds it");
    expect(withdrawalRefusal(POSITION, 300_000)).toBeNull();
    expect(withdrawalRefusal(POSITION, 300_001)).toBe("You can ask for at most $3,000.00 from this pool right now.");
    expect(withdrawalRefusal({ ...POSITION, availableCents: 0 }, 1)).toMatch(/Nothing in this pool is available/);
    expect(withdrawalOutcome({ seq: 4, eligible_at: "2026-12-14T00:00:00Z", status: "queued" }, false)).toBe(
      "Added to the withdrawal queue as request #4, payable from 2026-12-14 at the earliest. It's paid in queue order, and only as far as the pool's latest verified health snapshot keeps it above its minimum reserve.",
    );
  });
});

describe("the tables' layout (the dashboard's)", () => {
  const order = (html: string, marks: string[]) => marks.map((m) => html.indexOf(m));
  const inOrder = (at: number[]) => at.every((i) => i >= 0) && at.every((i, n) => n === 0 || at[n - 1] < i);

  it("each tab has one toolbar row: search, filter buttons, Export CSV, then its CTA; no native select filters", () => {
    const lp = data({ access: { builder: false, liquidityProvider: true } });
    const opp = view(lp, "pools");
    expect(inOrder(order(opp, ['aria-label="Search pools"', 'data-filter="Product line"', 'data-filter="State"', 'data-filter="Money"', "data-export", 'data-cta="commit"']))).toBe(true);
    expect(opp).not.toContain("<select");
    expect(opp).toContain("data-list-layout");
    expect(opp).not.toContain('data-slot="card"');
    const pos = view(lp, "my-positions");
    expect(inOrder(order(pos, ['aria-label="Search positions"', 'data-filter="Money"', "data-export", 'data-cta="withdraw"']))).toBe(true);
    const pools = view(data({ access: { builder: true, liquidityProvider: false } }), "my-pools");
    expect(inOrder(order(pools, ['aria-label="Search pools"', 'data-filter="State"', 'data-filter="Money"', "data-export", 'data-cta="propose"']))).toBe(true);
    expect(pools).not.toContain('data-filter="Product line"');
    for (const html of [pos, pools]) {
      expect(html).toContain("data-list-layout");
      expect(html).toContain("sticky top-0 bg-card");
      expect(html).not.toContain('data-slot="card"');
    }
  });

  it("pages with the list pager: 25 rows of a table, and six cards before the panel is measured", () => {
    const d = data({ access: { builder: true, liquidityProvider: true } });
    const many = Array.from({ length: 30 }, (_, i) => row({ id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, name: `Pool ${i}` }));
    d.builder!.pools = many;
    const table = view(d, "my-pools");
    expect([...table.matchAll(/<tr[^>]*data-pool="/g)]).toHaveLength(25);
    expect(table).toContain("30 rows · Page 1 of 2");
    d.provider!.pools = many;
    const cards = view(d, "pools");
    expect([...cards.matchAll(/data-pool-card="/g)]).toHaveLength(6);
    expect(cards).toContain("30 pools · Page 1 of 5");
  });

  it("My positions is one table: no key figures or sections; each position's amounts are its columns", () => {
    const html = view(data({ access: { builder: false, liquidityProvider: true } }), "my-positions");
    expect(html).not.toContain("data-kpi");
    expect(html).not.toContain("<h2");
    expect([...html.matchAll(/<table/g)]).toHaveLength(1);
    expect(positionFigures(POSITION)).toEqual({ committed: 550_000, settled: 400_000, queued: 100_000, paid: 100_000, available: 300_000 });
    // An on-chain deposit Mynt gave no amount for: Not measured in its row, never 0.
    const unmeasured = fromPositions([{ source: "on-chain", pool_id: CLEARED.id, name: "Chain", product_id: "p", wallet: "W", deposits: [{ deposit: "D1" }], requests: [] }]);
    expect(positionFigures(unmeasured[0])).toMatchObject({ committed: null, settled: null });
    const d = data({ access: { builder: false, liquidityProvider: true } });
    d.provider!.positions = unmeasured;
    const chain = view(d, "my-positions");
    expect(chain).toMatch(/data-committed="true">Not measured</);
    expect(chain).toMatch(/data-settled="true">Not measured</);
  });
});

describe("reading Mynt's replies", () => {
  it("reads health rows, sponsorships, dollars and pages", () => {
    const h = fromPoolsWithHealth([{ pool_id: CLEARED.id, verified: true, coverage_bps: 12_500, headroom_cents: 5000, snapshot: { sequence: 9, status: "published", period_end: "2026-11-13T00:00:00Z" } }, { pool_id: SANDBOX.id, verified: null, verified_reason: "Commit to a pool of this product to read its health", snapshot: null }]);
    expect(h.get(CLEARED.id)).toMatchObject({ verified: true, coverageBps: 12_500, sequence: 9, latestVerifiedEnd: "2026-11-13T00:00:00Z" });
    expect(h.get(SANDBOX.id)).toMatchObject({ sequence: null, reason: "Commit to a pool of this product to read its health" });
    const s = fromSponsorships([
      { id: "s1", status: "approved", product_id: "card-credit", component_key: "lending", provider_entity_id: "22222222-2222-4222-8222-222222222222", product: { id: "card-credit", name: "Card credit" }, provider: { name: "Harbor Bank" } },
      { id: "s2", status: "pending", product_id: "savings", component_key: "deposit", provider_entity_id: "22222222-2222-4222-8222-222222222222" },
    ]);
    expect(s.approved).toEqual([{ productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "22222222-2222-4222-8222-222222222222", sponsorName: "Harbor Bank" }]);
    expect([...s.productIds].sort()).toEqual(["card-credit", "savings"]);
    expect([parseUsd("1,250.50"), parseUsd("$10"), parseUsd("0"), parseUsd("1.234"), parseUsd("-5")]).toEqual([125_050, 1000, null, null, null]);
    expect(usd(125_050)).toBe("$1,250.50");
    expect(pageOf([...Array(23).keys()], 2)).toEqual({ items: [20, 21, 22], page: 2, pages: 3 });
  });
});

describe("/liquidity", () => {
  it("redirects to Earn on the matching tab (Open pools is Pools showing all pools, through the old Opportunities link)", async () => {
    const { default: LiquidityPage } = await import("@/app/(studio)/liquidity/page");
    const to = async (tab?: string) => {
      try {
        await LiquidityPage({ searchParams: Promise.resolve(tab ? { tab } : {}) });
      } catch (e) {
        return (e as { digest?: string }).digest;
      }
    };
    expect(await to("open-pools")).toContain("/earn?tab=opportunities");
    expect(await to("my-positions")).toContain("/earn?tab=my-positions");
    expect(await to("my-pools")).toContain("/earn?tab=my-pools");
    expect(await to()).toContain("/earn?tab=pools");
  });
});
