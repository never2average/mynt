// @vitest-environment jsdom
// What a visual pass over every screen (light and dark, desktop and phone) found, pinned: one-row
// page toolbars that scroll sideways on a phone instead of wrapping; a header and an app top bar
// that fit a phone; the expiring-licence badge readable in light mode; KPI deltas that don't
// squeeze into a column beside their sparkline; the coverage map inside its panel; and the
// phone's chat/panel switch clear of the composer.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { DashboardView } = await import("@/components/dashboard-view");
const { InvestorView } = await import("@/components/investor-view");
const { BuildsView } = await import("@/components/builds-view");
const { ExpiryBadge, LicencesView } = await import("@/components/licences-view");
const { AuditsView, NO_AUDIT_FILTERS, ObligationsView } = await import("@/components/audits-view");
const { AgreementAuditsView } = await import("@/components/agreement-audits-view");
const { KpiRow } = await import("@/components/charts");
const { ChatWorkspaceShell } = await import("@/components/chat-workspace-shell");
const { SiteHeader } = await import("@/components/site-header");
const { AppTopBar } = await import("@/components/app-top-bar");
const { ModeSwitch } = await import("@/components/mode-switch");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { fromDashboardTool } = await import("@/lib/dashboard");
const { fromCoverage, fromLicences } = await import("@/lib/compliance");
const { resetStudioAccess } = await import("@/lib/use-liquidity-access");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-11-13T00:00:00Z");
const licences = fromLicences({
  licences: [
    { partner: "Harbor Bank", type: "Lender", regulator: "NY DFS", number: "L-2", states: ["NY"], status: "active", expires_at: "2026-12-01" },
    { partner: "Prairie Trust", type: "Lender", regulator: "TX DOB", number: "MT-3", states: ["TX"], status: "active", expires_at: "2027-06-01" },
  ],
});
const coverage = fromCoverage({ states: [{ code: "CA", status: "unlocked" }] });
const toolbarOf = (html: string) => /<div class="([^"]*)" data-toolbar/.exec(html)?.[1] ?? "";

describe("page toolbars", () => {
  it("stay one row on every page: no wrapping; a phone scrolls the row sideways, labels kept", () => {
    const pages: [string, string][] = [
      ["dashboard", renderToStaticMarkup(<DashboardView dashboard={fromDashboardTool({})} />)],
      ["investor", renderToStaticMarkup(<InvestorView liquidity={{ kind: "ready", data: { supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools: [], positions: [], withdrawals: [], canCommit: true, canWithdraw: true } } }} now={NOW} />)],
      ["builds", renderToStaticMarkup(<BuildsView rows={[]} />)],
      ["licences", renderToStaticMarkup(<LicencesView licences={licences} now={NOW} />)],
      ["audits", renderToStaticMarkup(<AuditsView auditClass="security" rows={[]} filters={NO_AUDIT_FILTERS} onFilters={() => undefined} members={[]} apps={[]} actions={[]} page={1} hasNext={false} onPrev={() => undefined} onNext={() => undefined} />)],
      ["obligations", renderToStaticMarkup(<ObligationsView obligations={[]} />)],
      ["agreement audits", renderToStaticMarkup(<AgreementAuditsView list={{ agreements: [], requirements: [], audits: [], counts: { audits: null, open: null, overdue: null } }} onOpen={() => undefined} />)],
    ];
    for (const [page, html] of pages) {
      const row = toolbarOf(html).split(" ");
      expect(row, page).toEqual(expect.arrayContaining(["flex", "flex-nowrap", "overflow-x-auto", "[&amp;&gt;*]:shrink-0"])); // every control keeps its width
      expect(row, page).not.toContain("flex-wrap");
      // The search fills what's left, never narrower than it reads.
      expect(html, page).toMatch(/data-toolbar[^>]*><div class="relative min-w-48 flex-1 sm:min-w-64">/);
    }
  });
});

describe("the page header on a phone", () => {
  it("has Search and New app as icons and leaves GitHub and the wallet to wider screens, so the title keeps its room", async () => {
    resetStudioAccess();
    vi.stubGlobal("fetch", async (url: string) => new Response(JSON.stringify(url.startsWith("/api/liquidity/access") ? { developer: true, access: { builder: true, liquidityProvider: false }, owner: "o" } : {}), { status: 200 }));
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <SiteHeader title="Dashboard" />
        </SidebarProvider>
      </TooltipProvider>,
    );
    await act(async () => undefined);
    const header = container.querySelector("[data-site-header]")!;
    const phone = (sel: string) => [...header.querySelectorAll(sel)].filter((e) => e.closest(".md\\:hidden"));
    const wide = (sel: string) => [...header.querySelectorAll(sel)].filter((e) => e.closest(".hidden")?.className.includes("md:flex"));
    for (const sel of ["[data-search-trigger]", "[data-new-app]"]) {
      expect(phone(sel), sel).toHaveLength(1);
      expect(phone(sel)[0].textContent?.trim(), sel).toBe(""); // an icon, named by its aria-label
      expect(phone(sel)[0].getAttribute("aria-label"), sel).toBeTruthy();
      expect(wide(sel), sel).toHaveLength(1);
    }
    expect(header.querySelector("[data-header-wallet]")!.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "md:flex"]));
    // What a page puts beside its title is clipped, never drawn under the controls.
    expect(header.querySelector("[data-header-slot]")!.className.split(" ")).toEqual(expect.arrayContaining(["min-w-0", "overflow-hidden"]));
  });
});

describe("the dashboard's view switch on a phone", () => {
  it("drops its icon below sm, so \"Dashboard / Builder\" never runs under the header's controls", async () => {
    render(<ModeSwitch modes={["builder", "investor"]} mode="builder" onMode={() => undefined} />);
    await act(async () => undefined);
    const icon = document.querySelector("[data-mode-trigger] [data-mode-icon]")!;
    expect(icon.getAttribute("class")!.split(" ")).toEqual(expect.arrayContaining(["hidden", "sm:block"]));
  });
});

describe("an app's top bar on a phone", () => {
  it("never runs the app's name or stage under the controls on the right", async () => {
    const { container } = render(
      <TooltipProvider>
        <SidebarProvider>
          <AppTopBar appName="Round-up savings" stage="production" backLabel="All apps" onBack={() => undefined} previewUrl={null} iframeRef={createRef()} device="desktop" onDevice={() => undefined} isMobile />
        </SidebarProvider>
      </TooltipProvider>,
    );
    await act(async () => undefined);
    expect(container.querySelector("[data-app-title]")!.className).toContain("overflow-hidden");
    expect(container.querySelector("[data-app-stage]")!.className.split(" ")).toEqual(expect.arrayContaining(["hidden", "sm:inline-flex"]));
  });
});

describe("readable in both themes", () => {
  it("the Expires soon badge is dark amber in light mode and light amber only in dark mode", () => {
    const html = renderToStaticMarkup(<ExpiryBadge licence={licences[0]} now={NOW} />);
    const cls = /class="([^"]*)"/.exec(html)![1].split(" ");
    expect(cls).toContain("text-amber-700");
    expect(cls).toContain("dark:text-amber-300");
    expect(cls).not.toContain("text-amber-300");
  });
});

describe("key figures", () => {
  it("let the change line take the cell's width on narrow screens (the sparkline goes under it), side by side from @3xl", () => {
    const html = renderToStaticMarkup(<KpiRow kpis={[{ key: "money-moved", label: "Money moved", value: 150000, unit: "money", delta: { direction: "up", text: "200% more than last period", good: true }, spark: [1, 2, 3] }]} />);
    const foot = /<dd class="([^"]*)" data-kpi-foot/.exec(html)![1].split(" ");
    expect(foot).toEqual(expect.arrayContaining(["flex", "flex-wrap", "@3xl/main:flex-nowrap", "justify-between"]));
  });
});

describe("the coverage map", () => {
  it("fits its panel's height (scaled down whole), never cut off at the panel's bottom", async () => {
    const { container } = render(<LicencesView licences={licences} now={NOW} view="map" region="us" coverage={{ kind: "ready", data: coverage }} />);
    await act(async () => undefined);
    const panel = container.querySelector('[data-row="coverage-map"]')!;
    expect(panel.className).toContain("grid-rows-[minmax(0,1fr)]");
    const area = container.querySelector("[data-map-area]")!;
    expect(area.className.split(" ")).toEqual(expect.arrayContaining(["min-h-0", "flex-1"]));
    expect(area.querySelector("svg")!.getAttribute("class")).toContain("h-full");
    expect(area.querySelector("svg")!.getAttribute("class")).not.toContain("h-auto");
  });
});

describe("the phone's chat / panel switch", () => {
  it("floats above the composer, not on its send button", () => {
    const { container } = render(<ChatWorkspaceShell chat={<div />} showPanel tabs={[{ id: "pools", label: "Pools", content: null }]} tab="pools" onTab={() => undefined} isMobile />);
    const button = container.querySelector("[data-mobile-switch]")!;
    expect(button.className).toContain("bottom-44");
    expect(button.className).not.toContain("bottom-20");
  });
});
