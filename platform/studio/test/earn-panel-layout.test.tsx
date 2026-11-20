// @vitest-environment jsdom
// Earn's five right-hand tabs in the narrow, resizable panel: one table each, one toolbar row that
// never wraps (the action last and inside it), the filters and Export CSV folded into a labelled
// Filters menu while the panel is narrow (a container query on the panel), and a table that never
// scrolls: the rows per page follow the table area's height.
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { DraftsTab, PoolsTab } from "@/components/earn-assistant";
import { EarnTable, type LiquidityActions } from "@/components/earn-view";
import { MIN_ROWS, rowsThatFit } from "@/components/list-layout";
import type { Draft } from "@/lib/earn";
import { fromPools, fromPositions, type LiquidityData } from "@/lib/liquidity";

// The ResizeObserver the table area registers, to resize the panel by hand.
let resize: (() => void) | null = null;
let areaHeight = 0;
beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) {
      resize = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
  // jsdom lays nothing out: the table area's height is what the test says; rows and the header
  // measure 0, so the defaults (41px a row, 40px the header) apply.
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute("data-table-area") ? areaHeight : 0;
    },
  });
});
afterEach(() => {
  cleanup();
  areaHeight = 0;
});

const POOL = "11111111-1111-4111-8111-111111111111";
const base = {
  product_id: "card-credit",
  sponsor_entity_id: "22222222-2222-4222-8222-222222222222",
  sandbox: false,
  status: "open",
  min_reserve_bps: 2000,
  min_reserve_floor_cents: 0,
  notice_period_days: 90,
  min_commitment_cents: 100_000,
  max_commitment_cents: 10_000_000,
  deposit_rail_id: "33333333-3333-4333-8333-333333333333",
  withdrawal_rail_id: "44444444-4444-4444-8444-444444444444",
  approved_at: "2026-11-01T00:00:00Z",
  offering_cleared: true,
};
const manyPools = (n: number) => fromPools(Array.from({ length: n }, (_, i) => ({ ...base, id: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, name: `Pool ${i}` }))).map((p) => ({ ...p, productLine: "credit", queueLength: null, health: null }));
const pools = manyPools(3);
const positions = fromPositions([{ pool_id: POOL, name: "Pool 0", product_id: "card-credit", state: "us-ny", balance_cents: 500_000, available_to_withdraw_cents: 200_000 }]);
const data: LiquidityData = {
  supported: true,
  access: { builder: true, liquidityProvider: true },
  provider: { pools, positions, withdrawals: [], canCommit: true, canWithdraw: true },
  builder: { pools, proposable: [{ productId: "card-credit", productName: "Card credit", componentKey: "lending", sponsorId: "s1", sponsorName: "Harbor Bank" }], withdrawalsShown: true },
};
const actions: LiquidityActions = { propose: async () => ({ ok: true, reply: null }), commit: async () => ({ ok: true, reply: null }), withdraw: async () => ({ ok: true, reply: null }) };
const draft: Draft = { kind: "commit", id: "d1", poolId: POOL, poolName: "Pool 0", amountCents: 500_000, state: "us-ny", sandbox: false };

const TABS: { id: string; cta: string | null; filters: string[]; render: () => React.ReactElement }[] = [
  { id: "pools", cta: null, filters: ["Show", "Product line", "State", "Money"], render: () => <PoolsTab data={data} poolIds={[POOL]} /> },
  { id: "opportunities", cta: "commit", filters: ["Product line", "State", "Money"], render: () => <EarnTable tab="opportunities" data={data} actions={actions} /> },
  { id: "my-positions", cta: "withdraw", filters: ["Show", "Money"], render: () => <EarnTable tab="my-positions" data={data} actions={actions} /> },
  { id: "my-pools", cta: "propose", filters: ["State", "Money"], render: () => <EarnTable tab="my-pools" data={data} actions={actions} /> },
  { id: "drafts", cta: null, filters: ["Kind"], render: () => <DraftsTab data={data} drafts={[draft]} actions={actions} /> },
];

describe("each Earn tab", () => {
  for (const t of TABS) {
    it(`${t.id}: one table filling the panel, one toolbar row that never wraps, its action last and inside it`, () => {
      render(t.render());
      const panel = document.querySelector(`[data-tab-panel="${t.id}"]`)!;
      expect(panel).toBeTruthy();
      expect(panel.className).toContain("@container/list");
      expect(panel.className).toMatch(/\bh-full\b/);
      expect(document.querySelectorAll("table")).toHaveLength(1);
      // Nothing stacked above or below the table: the toolbar, the table area, the pager.
      expect([...panel.children].map((c) => [...c.attributes].map((a) => a.name).find((n) => ["data-toolbar", "data-table-area", "data-pager"].includes(n)))).toEqual(["data-toolbar", "data-table-area", "data-pager"]);
      expect(document.querySelector("[data-kpi], [data-panel], [data-view-all], h2")).toBeNull();

      const toolbar = panel.querySelector("[data-toolbar]")!;
      expect(toolbar.className.split(" ")).toEqual(expect.arrayContaining(["flex", "flex-nowrap"]));
      expect(toolbar.className).not.toContain("flex-wrap ");
      const search = toolbar.querySelector("input")!.parentElement!;
      expect(search.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "flex-1"]));
      if (t.cta) {
        const cta = toolbar.querySelector(`[data-cta="${t.cta}"]`)!;
        expect(cta).toBeTruthy();
        expect(cta.closest("[data-toolbar]")).toBe(toolbar);
        const slot = toolbar.lastElementChild!;
        expect(slot.hasAttribute("data-toolbar-cta")).toBe(true);
        expect(slot.contains(cta)).toBe(true);
        expect(slot.className).toContain("shrink-0");
      }
      // The filters show inline only in a wide panel; a narrow one has the Filters menu instead.
      const inline = toolbar.querySelector("[data-filters-inline]")!;
      expect(inline.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@3xl/list:flex", "shrink-0"]));
      expect([...inline.querySelectorAll("[data-filter]")].map((f) => f.getAttribute("data-filter"))).toEqual(t.filters);
      expect(toolbar.querySelector("[data-export-inline]")!.className).toContain("@3xl/list:block");
      const folded = toolbar.querySelector("[data-filters-folded]")!;
      expect(folded.className.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "@3xl/list:hidden"]));
      expect(folded.querySelector("[data-filters-menu-button]")!.textContent).toContain("Filters");
    });
  }

  it("the folded Filters menu holds every filter and Export CSV, each labelled", async () => {
    render(<EarnTable tab="opportunities" data={data} actions={actions} />);
    const button = document.querySelector("[data-filters-menu-button]")!;
    await act(async () => void fireEvent.click(button));
    const menu = document.querySelector("[data-filters-menu]")!;
    expect([...menu.querySelectorAll("[data-filter]")].map((f) => f.textContent)).toEqual(["Product line", "State", "Money"]);
    expect(menu.querySelector("[data-export]")!.textContent).toBe("Export CSV");
  });

  it("an active filter shows its count on the Filters button", () => {
    render(<PoolsTab data={data} poolIds={[POOL]} />);
    // Show · Matched is on until the user picks All pools.
    expect(document.querySelector("[data-filters-menu-button]")!.textContent).toContain("· 1");
  });
});

describe("the table never scrolls", () => {
  it("has no scrolling container: the table area and the tab hide what doesn't fit, and long text truncates", () => {
    for (const t of TABS) {
      render(t.render());
      const panel = document.querySelector(`[data-tab-panel="${t.id}"]`)!;
      const area = panel.querySelector("[data-table-area]")!;
      // shadcn's Table wraps the table in a div with overflow-x-auto; the area turns it to hidden
      // (the [&_[data-slot=table-container]] rule), so it's the one class let through here.
      for (const el of [panel, area, ...area.querySelectorAll("*:not([data-slot=table-container])")]) expect(el.getAttribute("class") ?? "", t.id).not.toMatch(/overflow-(y-|x-)?(auto|scroll)\b/);
      expect(area.className).toContain("overflow-hidden");
      expect(area.className).toContain("[&_[data-slot=table-container]]:overflow-hidden");
      expect(area.className).toContain("[&_td]:truncate");
      cleanup();
    }
  });

  it("shows as many rows a page as fit the table area's height, at least five, and follows a resize", async () => {
    const d: LiquidityData = { ...data, provider: { ...data.provider!, pools: manyPools(30) } };
    areaHeight = 40 + 2 + 41 * 12;
    render(<EarnTable tab="opportunities" data={d} actions={actions} />);
    const rows = () => document.querySelectorAll("tr[data-pool]").length;
    expect(rows()).toBe(12);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("30 rows · Page 1 of 3");
    // The panel is made shorter: fewer rows, more pages.
    areaHeight = 40 + 2 + 41 * 7;
    await act(async () => resize!());
    expect(rows()).toBe(7);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("Page 1 of 5");
    // Collapsed (no height): the last page size stays until it opens again.
    areaHeight = 0;
    await act(async () => resize!());
    expect(rows()).toBe(7);
    // Very short: never fewer than five rows.
    areaHeight = 60;
    await act(async () => resize!());
    expect(rows()).toBe(MIN_ROWS);
    expect(rowsThatFit(1000, 40, 53)).toBe(18); // (1000 - 40 - 2) / 53 two-line rows
  });
});
