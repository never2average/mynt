// @vitest-environment jsdom
// Earn's four right-hand tabs in the narrow, resizable panel: Pools and My strategies as cards, My
// positions and My pools as one table each; one toolbar row that never wraps (the action last and
// inside it), the filters and Export CSV folded into a labelled Filters menu while the panel is
// narrow (a container query on the panel), and nothing that scrolls: the rows (or cards) per page
// follow the list area's height (and, for cards, the columns the panel's width gives).
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PoolsTab, StrategiesTab } from "@/components/earn-assistant";
import { EarnTable, type LiquidityActions } from "@/components/earn-view";
import { CARD_GRID, cardsThatFit, MIN_ROWS, rowsThatFit } from "@/components/list-layout";
import type { Draft } from "@/lib/earn";
import { fromPools, fromPositions, type LiquidityData } from "@/lib/liquidity";

// The ResizeObserver the list area registers, to resize the panel by hand.
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
  // jsdom lays nothing out: the list area's height is what the test says; rows, the header and
  // cards measure 0, so the defaults (41px a row, 40px the header, the tab's card height) apply.
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
  vi.restoreAllMocks();
});

const POOL = "11111111-1111-4111-8111-000000000001";
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
const drafts = (n: number): Draft[] => Array.from({ length: n }, (_, i) => ({ ...draft, id: `d${i}` }));

type TabCase = { id: string; cards: boolean; cta: string | null; filters: string[]; render: () => React.ReactElement };
const TABS: TabCase[] = [
  { id: "pools", cards: true, cta: "commit", filters: ["Show", "Product line", "State", "Money"], render: () => <PoolsTab data={data} poolIds={[POOL]} actions={actions} /> },
  { id: "my-positions", cards: false, cta: "withdraw", filters: ["Show", "Money"], render: () => <EarnTable tab="my-positions" data={data} actions={actions} /> },
  { id: "my-pools", cards: false, cta: "propose", filters: ["State", "Money"], render: () => <EarnTable tab="my-pools" data={data} actions={actions} /> },
  { id: "my-strategies", cards: true, cta: null, filters: ["Kind"], render: () => <StrategiesTab data={data} drafts={[draft]} actions={actions} /> },
];

describe("each Earn tab", () => {
  for (const t of TABS) {
    it(`${t.id}: ${t.cards ? "one flat card grid" : "one table"} filling the panel, one toolbar row that never wraps, its action last and inside it`, () => {
      render(t.render());
      const panel = document.querySelector(`[data-tab-panel="${t.id}"]`)!;
      expect(panel).toBeTruthy();
      expect(panel.className).toContain("@container/list");
      expect(panel.className).toMatch(/\bh-full\b/);
      if (t.cards) {
        expect(document.querySelectorAll("table")).toHaveLength(0);
        const grid = panel.querySelector("[data-card-grid]")!;
        expect(grid.className).toBe(CARD_GRID);
        expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["grid-cols-1", "@xl/list:grid-cols-2"]));
        // Flat cards: a border, rounded-lg, p-3; no card in a card, no shadcn Card, no frame round the grid.
        const cards = [...grid.querySelectorAll("[data-card]")];
        expect(cards.length).toBeGreaterThan(0);
        for (const c of cards) {
          expect(c.className.split(" ")).toEqual(expect.arrayContaining(["rounded-lg", "border", "p-3"]));
          expect(c.className).not.toMatch(/shadow/);
          expect(c.querySelector("[data-card]")).toBeNull();
        }
        expect(document.querySelector("[data-slot='card']")).toBeNull();
        expect(panel.querySelector("[data-table-area]")!.className).not.toContain("border");
      } else {
        expect(document.querySelectorAll("table")).toHaveLength(1);
      }
      // Nothing stacked above or below the list: the toolbar, the list area, the pager.
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
    render(<PoolsTab data={data} poolIds={null} actions={actions} />);
    const button = document.querySelector("[data-filters-menu-button]")!;
    await act(async () => void fireEvent.click(button));
    const menu = document.querySelector("[data-filters-menu]")!;
    expect([...menu.querySelectorAll("[data-filter]")].map((f) => f.textContent)).toEqual(["Product line", "State", "Money"]);
    expect(menu.querySelector("[data-export]")!.textContent).toBe("Export CSV");
  });

  it("an active filter shows its count on the Filters button", () => {
    render(<PoolsTab data={data} poolIds={[POOL]} actions={actions} />);
    // Show · Matched is on until the user picks All pools.
    expect(document.querySelector("[data-filters-menu-button]")!.textContent).toContain("· 1");
  });
});

describe("nothing scrolls", () => {
  it("has no scrolling container: the list area and the tab hide what doesn't fit, and long text truncates", () => {
    for (const t of TABS) {
      render(t.render());
      const panel = document.querySelector(`[data-tab-panel="${t.id}"]`)!;
      const area = panel.querySelector("[data-table-area]")!;
      // shadcn's Table wraps the table in a div with overflow-x-auto; the area turns it to hidden
      // (the [&_[data-slot=table-container]] rule), so it's the one class let through here.
      for (const el of [panel, area, ...area.querySelectorAll("*:not([data-slot=table-container])")]) expect(el.getAttribute("class") ?? "", t.id).not.toMatch(/overflow-(y-|x-)?(auto|scroll)\b/);
      expect(area.className).toContain("overflow-hidden");
      if (!t.cards) {
        expect(area.className).toContain("[&_[data-slot=table-container]]:overflow-hidden");
        expect(area.className).toContain("[&_td]:truncate");
      }
      cleanup();
    }
  });

  it("shows as many table rows a page as fit the table area's height, at least five, and follows a resize", async () => {
    const d: LiquidityData = { ...data, builder: { ...data.builder!, pools: manyPools(30) } };
    areaHeight = 40 + 2 + 41 * 12;
    render(<EarnTable tab="my-pools" data={d} actions={actions} />);
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

  it("shows as many cards a page as fit the card area: rows by its height, columns by the grid at the panel's width", async () => {
    expect(cardsThatFit(500, 140, 1)).toBe(3); // (500 + 12) / (140 + 12)
    expect(cardsThatFit(500, 140, 2)).toBe(6);
    expect(cardsThatFit(50, 140, 2)).toBe(2); // never less than one row
    // My strategies: 124px cards before one is measured, one column (jsdom has no grid layout).
    areaHeight = (124 + 12) * 4 - 12;
    render(<StrategiesTab data={data} drafts={drafts(20)} actions={actions} />);
    const cards = () => document.querySelectorAll("[data-draft-card]").length;
    expect(cards()).toBe(4);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("20 strategies · Page 1 of 5");
    expect(document.querySelector("[data-pager]")!.lastElementChild!.textContent).toBe("Next");
    // A wider panel: the grid has two columns, so twice the cards on a page.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) => (el.hasAttribute("data-card-grid") ? ({ gridTemplateColumns: "300px 300px" } as CSSStyleDeclaration) : real(el)));
    await act(async () => resize!());
    expect(cards()).toBe(8);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("Page 1 of 3");
    // Shorter: fewer rows of cards.
    areaHeight = (124 + 12) * 2 - 12;
    await act(async () => resize!());
    expect(cards()).toBe(4);
    cleanup();
    // Pools: liquidity providers' cards (with Commit capital) are 180px before one is measured.
    vi.restoreAllMocks();
    areaHeight = (180 + 12) * 3 - 12;
    render(<PoolsTab data={{ ...data, provider: { ...data.provider!, pools: manyPools(10) } }} poolIds={null} actions={actions} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(3);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("10 pools · Page 1 of 4");
  });
});
