// @vitest-environment jsdom
// Earn's three right-hand tabs in the narrow, resizable panel: Pools and My strategies as cards, My
// pools as one table; one toolbar row that never wraps (the action last and inside it), one
// labelled Filters popover of facet chips (Export CSV joins it while the panel is narrow), and
// nothing that scrolls: the rows (or cards) per page
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

type TabCase = { id: string; cards: boolean; cta: string | null; facets: string[]; view: boolean; render: () => React.ReactElement };
const TABS: TabCase[] = [
  { id: "pools", cards: true, cta: "commit", facets: ["Product line", "State", "Money"], view: true, render: () => <PoolsTab data={data} poolIds={[POOL]} actions={actions} /> },
  { id: "my-pools", cards: false, cta: "propose", facets: ["State", "Money"], view: false, render: () => <EarnTable tab="my-pools" data={data} actions={actions} /> },
  { id: "my-strategies", cards: true, cta: null, facets: ["Kind"], view: false, render: () => <StrategiesTab data={data} drafts={[draft]} actions={actions} /> },
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
      // One Filters button at every width, and no filter dropdowns in the row; Export CSV shows in
      // the row only in a wide panel (a narrow one has it in the Filters popover).
      expect(toolbar.querySelector("[data-filters-inline], [data-filter]")).toBeNull();
      const folded = toolbar.querySelector("[data-filters-folded]")!;
      expect(folded.className.split(" ")).toContain("shrink-0");
      expect(folded.className).not.toContain("hidden");
      expect(folded.querySelector("[data-filters-menu-button]")!.textContent).toBe("Filters");
      expect(toolbar.querySelectorAll("[data-filters-menu-button]")).toHaveLength(1);
      expect(toolbar.querySelector("[data-export-inline]")!.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "@3xl/list:block"]));
      // Pools' view switch comes right after the search; the other tabs have none.
      const view = toolbar.querySelector("[data-toolbar-view]");
      if (t.view) expect(view?.previousElementSibling?.querySelector("input")).toBeTruthy();
      else expect(view).toBeNull();
    });

    it(`${t.id}: the Filters popover has one heading per facet (${t.facets.join(", ")}), chips and one Clear all; no dropdowns inside`, async () => {
      render(t.render());
      await act(async () => void fireEvent.click(document.querySelector("[data-filters-menu-button]")!));
      const menu = document.querySelector("[data-filters-menu]")!;
      expect([...menu.querySelectorAll("[data-facet-heading]")].map((h) => h.textContent)).toEqual(t.facets);
      expect(menu.querySelectorAll("[data-chip]").length).toBeGreaterThan(0);
      expect(menu.querySelector("[data-filter], [data-slot='dropdown-menu-trigger'], select, [role='menu']")).toBeNull();
      expect([...menu.querySelectorAll("button")].filter((b) => b.textContent === "Clear all")).toHaveLength(1);
      // In a narrow panel (jsdom lays nothing out, so the row's Export CSV has no width) Export CSV is here, beside Clear all.
      expect(menu.querySelector("[data-export]")!.textContent).toBe("Export CSV");
    });
  }

  it("chips pick any number per facet, the Filters button counts them, and Clear all clears them", async () => {
    const two = manyPools(2).map((p, i) => ({ ...p, sandbox: i === 1, offeringCleared: i === 0 ? p.offeringCleared : false }));
    render(<PoolsTab data={{ ...data, provider: { ...data.provider!, pools: two }, builder: undefined }} poolIds={null} actions={actions} />);
    const button = () => document.querySelector("[data-filters-menu-button]")!;
    const cards = () => document.querySelectorAll("[data-pool-card]").length;
    expect(cards()).toBe(2);
    await act(async () => void fireEvent.click(button()));
    const chip = (facet: string, value: string) => document.querySelector(`[data-filters-menu] [data-facet="${facet}"] [data-chip="${value}"]`) as HTMLButtonElement;
    await act(async () => void fireEvent.click(chip("money", "real")));
    expect(chip("money", "real").getAttribute("aria-pressed")).toBe("true");
    expect(button().textContent).toBe("Filters· 1");
    expect(button().getAttribute("aria-label")).toBe("Filters: 1 on");
    expect(cards()).toBe(1);
    // A second choice in the same facet widens it (either one).
    await act(async () => void fireEvent.click(chip("money", "sandbox")));
    expect(button().textContent).toBe("Filters· 2");
    expect(cards()).toBe(2);
    // Another facet narrows it (both facets must match).
    await act(async () => void fireEvent.click(chip("state", "cleared")));
    expect(button().textContent).toBe("Filters· 3");
    expect(cards()).toBe(1);
    await act(async () => void fireEvent.click(document.querySelector("[data-filters-menu] [data-filters-clear]")!));
    expect(button().textContent).toBe("Filters");
    expect(cards()).toBe(2);
    expect((document.querySelector("[data-filters-menu] [data-filters-clear]") as HTMLButtonElement).disabled).toBe(true);
  });

  it("the view switch (Matched · All · Invested) isn't a filter: it doesn't count on the Filters button", () => {
    render(<PoolsTab data={data} poolIds={[POOL]} actions={actions} />);
    expect([...document.querySelectorAll("[data-view-switch] [data-view-option]")].map((o) => o.textContent)).toEqual(["Matched", "All", "Invested"]);
    expect(document.querySelector('[data-view-switch] [aria-checked="true"]')!.textContent).toBe("Matched");
    expect(document.querySelector("[data-filters-menu-button]")!.textContent).toBe("Filters");
    // Below 36rem it folds to one compact button naming the view, with no heading inside.
    const compact = document.querySelector("[data-view-compact]")!;
    expect(compact.className).toContain("@xl/list:hidden");
    expect(document.querySelector("[data-view-switch]")!.className).toContain("@xl/list:inline-flex");
    expect(compact.querySelector("button")!.textContent).toBe("Matched");
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
    // Pools: liquidity providers' cards (with their position line and buttons) are 200px before one is measured.
    vi.restoreAllMocks();
    areaHeight = (200 + 12) * 3 - 12;
    render(<PoolsTab data={{ ...data, provider: { ...data.provider!, pools: manyPools(10) } }} poolIds={null} actions={actions} />);
    expect(document.querySelectorAll("[data-pool-card]")).toHaveLength(3);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("10 pools · Page 1 of 4");
  });
});
