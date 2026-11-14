// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRef } from "react";

// The sidebar's icon rail, the toggle separators, the Apps folders (one open at a time), and
// the Licences page: only the table, with the coverage map in its place.

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to}` });
  },
}));

const { Sidebar, SidebarProvider, SidebarContent } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { NavFolders, FOLDER_KEY, initialFolder } = await import("@/components/nav-folders");
const { SiteHeader } = await import("@/components/site-header");
const { AppTopBar } = await import("@/components/app-top-bar");
const { LicencesPageView } = await import("@/components/licences-page-view");
const { licencesViewOf, regionOf } = await import("@/lib/licences-tabs");
const { groupByStage } = await import("@/lib/workspaces");
const { fromCoverage, fromLicences } = await import("@/lib/compliance");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

const groups = groupByStage([
  { id: "app-p", name: "Round-up savings", stage: "production" },
  { id: "app-s", name: "Budgeting", stage: "staging" },
  { id: "app-i", name: "Crypto vault", stage: "idea" },
]);
const withSidebar = (ui: React.ReactNode, open = true) => (
  <TooltipProvider>
    <SidebarProvider defaultOpen={open}>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarContent>{ui}</SidebarContent>
      </Sidebar>
    </SidebarProvider>
  </TooltipProvider>
);
const openFolders = (c: HTMLElement) => [...c.querySelectorAll("[data-active-folder=true]")].map((e) => e.getAttribute("data-folder"));

describe("the collapsed sidebar", () => {
  it("is exactly the icon width (3rem) for the inset variant, with no side padding, so icons are centred", () => {
    const { container } = render(withSidebar(<p>x</p>, false));
    const gap = container.querySelector("[data-slot=sidebar-gap]")!.className;
    const rail = container.querySelector("[data-slot=sidebar-container]")!.className;
    expect(gap).toContain("group-data-[collapsible=icon]:w-(--sidebar-width-icon)");
    expect(gap).not.toContain("spacing(4)");
    expect(rail).toContain("group-data-[collapsible=icon]:w-(--sidebar-width-icon)");
    expect(rail).toContain("group-data-[collapsible=icon]:px-0");
    expect(rail).not.toContain("+2px");
    expect((container.querySelector("[data-slot=sidebar-wrapper]") as HTMLElement).style.getPropertyValue("--sidebar-width-icon")).toBe("3rem");
  });
});

describe("the toggle's separator", () => {
  it("sits between the sidebar toggle and the page title, as in shadcn's site-header", () => {
    const { container } = render(withSidebar(<SiteHeader title="Audits" />));
    const sep = container.querySelector("[data-toggle-separator]")!;
    expect(sep.getAttribute("data-orientation")).toBe("vertical");
    expect(sep.className).toContain("mx-2");
    expect(sep.className).toContain("data-[orientation=vertical]:h-4");
    expect(sep.previousElementSibling?.getAttribute("data-sidebar")).toBe("trigger");
    expect(sep.nextElementSibling?.tagName).toBe("H1");
  });

  it("and in the app top bar, between the toggle and back / the app's name", () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ supported: false }), { status: 200 }));
    const { container } = render(
      withSidebar(<AppTopBar appName="Cards" stage="staging" backLabel="All apps" onBack={() => undefined} previewUrl={null} iframeRef={createRef()} device="desktop" onDevice={() => undefined} />),
    );
    const sep = container.querySelector("[data-app-top-bar] [data-toggle-separator]")!;
    expect(sep.className).toContain("mx-2");
    expect(sep.previousElementSibling?.getAttribute("data-sidebar")).toBe("trigger");
    expect(sep.nextElementSibling?.getAttribute("aria-label")).toBe("All apps");
    vi.unstubAllGlobals();
  });
});

describe("the Apps folders", () => {
  it("sit under an Apps label (hidden when collapsed, like shadcn's group labels)", () => {
    const html = renderToStaticMarkup(withSidebar(<NavFolders groups={groups} />));
    expect(html).toMatch(/data-sidebar="group-label"[^>]*>Apps</);
    expect(html).toContain("group-data-[collapsible=icon]:opacity-0");
  });

  it("start on the open app's stage, else the one remembered, else Production", () => {
    expect(initialFolder(groups, "app-s", "idea")).toBe("staging");
    expect(initialFolder(groups, undefined, "idea")).toBe("idea");
    expect(initialFolder(groups, undefined, null)).toBe("production");
    const { container } = render(withSidebar(<NavFolders groups={groups} />));
    expect(openFolders(container)).toEqual(["production"]);
    cleanup();
    window.localStorage.setItem(FOLDER_KEY, "idea");
    const again = render(withSidebar(<NavFolders groups={groups} />));
    expect(openFolders(again.container)).toEqual(["idea"]);
    cleanup();
    const inApp = render(withSidebar(<NavFolders groups={groups} activeAppId="app-s" />));
    expect(openFolders(inApp.container)).toEqual(["staging"]);
    expect(screen.getByText("Budgeting")).toBeTruthy();
  });

  it("keep exactly one open: opening one closes the others, and the open one can't be closed", async () => {
    const { container } = render(withSidebar(<NavFolders groups={groups} />));
    fireEvent.click(screen.getByRole("button", { name: /Staging/ }));
    await act(async () => undefined);
    expect(openFolders(container)).toEqual(["staging"]);
    expect(screen.getByText("Budgeting")).toBeTruthy();
    expect(screen.queryByText("Round-up savings")).toBeNull();
    expect(window.localStorage.getItem(FOLDER_KEY)).toBe("staging");
    fireEvent.click(screen.getByRole("button", { name: /Staging/ })); // the open one, again
    await act(async () => undefined);
    expect(openFolders(container)).toEqual(["staging"]);
  });

  it("collapsed: keep the three icons, mark the open one selected, and clicking one picks it and expands the sidebar", async () => {
    const { container } = render(withSidebar(<NavFolders groups={groups} />, false));
    for (const s of ["production", "staging", "idea"]) expect(container.querySelector(`[data-folder-icon=${s}]`)).not.toBeNull();
    const active = () => [...container.querySelectorAll("[data-folder] > [data-sidebar=menu-button][data-active=true]")].map((b) => b.closest("[data-folder]")!.getAttribute("data-folder"));
    expect(active()).toEqual(["production"]);
    fireEvent.click(container.querySelector("[data-folder=idea] [data-sidebar=menu-button]")!);
    await act(async () => undefined);
    expect(openFolders(container)).toEqual(["idea"]);
    expect(container.querySelector("[data-slot=sidebar]")?.getAttribute("data-state")).toBe("expanded");
  });
});

const coverage = fromCoverage({ states: [{ code: "CA", status: "unlocked", partners: [{ name: "Harbor Bank" }] }, { code: "NY", status: "available" }] });
const licences = fromLicences({ licences: [{ partner: "Harbor Bank", number: "MT-1", states: ["CA"], status: "verified", expires_at: "2020-01-01" }] });

describe("Licences: only the table, the map in its place", () => {
  const view = (v: "table" | "map", c: Parameters<typeof LicencesPageView>[0]["coverage"] = { kind: "ready", data: coverage }) =>
    renderToStaticMarkup(<LicencesPageView view={v} onView={() => undefined} coverage={c} licences={{ kind: "ready", data: licences }} />);

  it("has no summary card and no tabs: the table, with the view toggle", () => {
    const html = view("table");
    expect(html).not.toContain("data-licences-summary");
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain('data-slot="card"');
    expect(html).toContain("data-table-view");
    expect(html).toContain("MT-1");
    expect(html).toMatch(/aria-label="Map view"/);
  });

  it("the map view replaces the table in the same place; ?tab=coverage and ?view=map open it", () => {
    expect([licencesViewOf({}), licencesViewOf({ tab: "coverage" }), licencesViewOf({ tab: "licences" }), licencesViewOf({ view: "map" }), licencesViewOf({ view: "table", tab: "coverage" })]).toEqual(["table", "map", "table", "map", "table"]);
    expect([regionOf(undefined), regionOf("world"), regionOf("mars")]).toEqual(["us", "world", "us"]);
    const html = view("map");
    expect(html).toContain("data-map-view");
    expect(html).not.toContain("data-table-view");
    expect(html).toContain('data-region-shown="us"');
  });

  it("says what isn't available yet, never an empty map", () => {
    const html = view("map", { kind: "unsupported" });
    expect(html).toContain('data-empty="not-available"');
    expect(html).not.toContain("data-map-view");
  });

  it("/coverage opens the map view (US)", async () => {
    const { default: CoveragePage } = await import("@/app/(studio)/coverage/page");
    let to: string | undefined;
    try {
      CoveragePage();
    } catch (e) {
      to = (e as { digest?: string }).digest;
    }
    expect(to).toContain("/licences?view=map&region=us");
  });
});
