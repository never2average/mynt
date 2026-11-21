// @vitest-environment jsdom
// Earn's three right-hand tabs in the narrow, resizable panel: Pools and My pools as one table
// each, and My strategies too; one toolbar row that never wraps (the action last and inside it),
// one labelled Filters popover of facet chips (Export CSV joins it while the panel is narrow), and
// nothing that scrolls down: the rows per page follow the list area's height. A table shows every
// column at every width, each with a min width, and scrolls sideways when it's wider than the panel.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { PoolsTab, StrategiesTab } from "@/components/earn-assistant";
import { EarnTable, type LiquidityActions } from "@/components/earn-view";
import { MIN_ROWS, rowsThatFit } from "@/components/list-layout";
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

type TabCase = { id: string; columns: number; cta: string | null; facets: string[]; view: boolean; render: () => React.ReactElement };
const TABS: TabCase[] = [
  { id: "pools", columns: 9, cta: "commit", facets: ["Product line", "State", "Money"], view: true, render: () => <PoolsTab data={data} poolIds={[POOL]} actions={actions} /> },
  { id: "my-pools", columns: 9, cta: "propose", facets: ["State", "Money"], view: false, render: () => <EarnTable tab="my-pools" data={data} actions={actions} /> },
  { id: "my-strategies", columns: 6, cta: null, facets: ["Kind"], view: false, render: () => <StrategiesTab data={data} drafts={[draft]} actions={actions} /> },
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
      expect(document.querySelector("[data-card], [data-card-grid], [data-slot='card']")).toBeNull();
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
    const cards = () => document.querySelectorAll("[data-pool-row]").length;
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

describe("nothing scrolls down; a wide table scrolls sideways", () => {
  it("a table's area is the one sideways scroller and never scrolls down", () => {
    for (const t of TABS) {
      render(t.render());
      const panel = document.querySelector(`[data-tab-panel="${t.id}"]`)!;
      const area = panel.querySelector("[data-table-area]")!;
      const classes = area.className.split(" ");
      // The area scrolls across, never down; shadcn's own overflow-x-auto wrapper is turned off
      // (the [&_[data-slot=table-container]] rule), so there is one scroller and the pinned
      // first column sticks to it. Cells are px-3.
      expect(classes, t.id).toEqual(expect.arrayContaining(["overflow-x-auto", "overflow-y-hidden", "[&_[data-slot=table-container]]:overflow-visible", "[&_td]:px-3", "[&_th]:px-3"]));
      // Nothing inside scrolls (shadcn's wrapper is the one class let through, turned off above).
      for (const el of [panel, ...area.querySelectorAll("*:not([data-slot=table-container])")]) expect(el.getAttribute("class") ?? "", t.id).not.toMatch(/overflow-(y-|x-)?(auto|scroll)\b/);
      expect(area.className).not.toMatch(/overflow-y-(auto|scroll)/);
      cleanup();
    }
  });

  it("every column of each Earn table shows at every width, with a min width; the first is pinned; headers don't wrap", () => {
    for (const t of TABS) {
      render(t.render());
      const panel = document.querySelector(`[data-tab-panel="${t.id}"]`)!;
      const heads = [...panel.querySelectorAll("thead th")];
      expect(heads.length, t.id).toBeGreaterThanOrEqual(t.columns);
      for (const th of heads) {
        expect(th.className, `${t.id} ${th.textContent}`).toMatch(/\bmin-w-\d+\b/);
        expect(th.className).toContain("whitespace-nowrap");
      }
      for (const el of panel.querySelectorAll("th, td")) expect(el.className, t.id).not.toMatch(/(^|\s)hidden(\s|$)|table-cell/);
      expect(heads[0].className.split(" ")).toEqual(expect.arrayContaining(["sticky", "left-0", "bg-card"]));
      for (const td of panel.querySelectorAll("tbody tr:not([data-empty-row]) > td:first-child")) expect(td.className.split(" ")).toEqual(expect.arrayContaining(["sticky", "left-0", "bg-card"]));
      // Money columns are right-aligned figures.
      const money = heads.filter((th) => th.className.includes("min-w-32"));
      expect(money.length, t.id).toBeGreaterThan(0);
      for (const th of money) expect(th.className.split(" ")).toEqual(expect.arrayContaining(["text-right", "tabular-nums"]));
      cleanup();
    }
  });

  it("Pools pages its table rows by the area's height, like My pools, and follows a resize", async () => {
    areaHeight = 40 + 2 + 41 * 6;
    render(<PoolsTab data={{ ...data, provider: { ...data.provider!, pools: manyPools(20) } }} poolIds={null} actions={actions} />);
    const rows = () => document.querySelectorAll("tr[data-pool-row]").length;
    expect(rows()).toBe(6);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("20 pools · Page 1 of 4");
    areaHeight = 40 + 2 + 41 * 10;
    await act(async () => resize!());
    expect(rows()).toBe(10);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("Page 1 of 2");
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

  it("My strategies pages its table rows by the area's height too, and follows a resize", async () => {
    areaHeight = 40 + 2 + 41 * 4;
    render(<StrategiesTab data={data} drafts={drafts(20)} actions={actions} />);
    const rows = () => document.querySelectorAll("tr[data-draft-row]").length;
    expect(rows()).toBe(MIN_ROWS);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("20 strategies · Page 1 of 4");
    expect(document.querySelector("[data-pager]")!.lastElementChild!.textContent).toBe("Next");
    areaHeight = 40 + 2 + 41 * 8;
    await act(async () => resize!());
    expect(rows()).toBe(8);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("Page 1 of 3");
  });
});
