// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The platform admin at its own base path (/platform), in its own layout: the studio sidebar's "Platform admin" badge
// above the account (Mynt admins only, expanded and collapsed), the platform admin's own sidebar and header (no studio
// sidebar, no workspace switcher, no app folders), each section's address, the old /admin?tab=…&id=… and
// /settings?tab=esign addresses redirecting, and signed-out visits going to sign-in.

const nav = { pathname: "/platform" };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { SidebarView, PLATFORM_ADMIN_LABEL } = await import("@/components/app-sidebar");
const { PlatformShell, PlatformSidebarView, PLATFORM_SECTIONS, BACK_TO_STUDIO } = await import("@/components/platform-shell");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const admin = await import("@/lib/admin");
const { legacyRedirect } = await import("@/lib/redirects");
const { pageNeedsSignIn, signInPathFor } = await import("@/lib/page-gate");
const { isAppPath, searchIndex, searchStudio } = await import("@/lib/studio-search");
const { pageGateFor } = await import("@/components/studio-gates");
const { groupByStage } = await import("@/lib/workspaces");

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

const FIRM = "33333333-3333-4333-8333-333333333333";

const studioSidebar = (isAdmin: boolean, open = true, pathname = "/") => (
  <TooltipProvider>
    <SidebarProvider defaultOpen={open}>
      <SidebarView
        workspaces={[{ id: "w1", name: "Acme", role: "owner" }]}
        selected={{ id: "w1", name: "Acme", role: "owner" }}
        supported
        groups={groupByStage([{ id: "app-1", name: "Round-up savings", stage: "production" }])}
        account={{ name: "Ana Admin", email: "ana@example.com" }}
        pathname={pathname}
        onSelectWorkspace={() => undefined}
        onCreateWorkspace={async () => null}
        admin={isAdmin}
      />
    </SidebarProvider>
  </TooltipProvider>
);

describe("the studio sidebar's Platform admin badge", () => {
  it("only Mynt admins get it: a labelled link to /platform, above their name; there's no Admin group any more", () => {
    const notAdmin = renderToStaticMarkup(studioSidebar(false))
    expect(notAdmin).not.toContain("data-platform-admin-link")
    expect(notAdmin).not.toContain(PLATFORM_ADMIN_LABEL)
    expect(notAdmin).not.toContain('href="/platform')
    const html = renderToStaticMarkup(studioSidebar(true))
    const link = html.match(/<a[^>]*data-platform-admin-link[^>]*>.*?<\/a>/)?.[0] ?? ""
    expect(link).toContain('href="/platform"')
    expect(link).toContain("<svg") // an icon
    expect(link).toContain(`<span>${PLATFORM_ADMIN_LABEL}</span>`) // and its words
    // In the footer, above the account's name.
    const footer = html.slice(html.indexOf('data-sidebar="footer"'))
    expect(footer.indexOf("data-platform-admin-link")).toBeGreaterThan(-1)
    expect(footer.indexOf("data-platform-admin-link")).toBeLessThan(footer.indexOf("data-account-name"))
    for (const gone of ["data-admin-group", "data-admin-link", "data-all-workspaces", "All workspaces"]) expect(html).not.toContain(gone)
    // The studio's own switcher and folders stay, on every page.
    expect(html).toContain("Acme")
    expect(html).toContain("Round-up savings")
  })

  it("collapsed to the icon rail it's still there, with the tooltip Platform admin", async () => {
    expect(renderToStaticMarkup(studioSidebar(false, false))).not.toContain("data-platform-admin-link")
    render(studioSidebar(true, false))
    const link = document.querySelector<HTMLAnchorElement>("[data-platform-admin-link]")!
    expect(link.getAttribute("href")).toBe("/platform")
    expect(link.textContent).toContain(PLATFORM_ADMIN_LABEL)
    await act(async () => void fireEvent.focus(link))
    const tip = await vi.waitFor(() => {
      const t = [...document.querySelectorAll('[data-slot="tooltip-content"], [role="tooltip"]')].find((el) => el.textContent?.includes(PLATFORM_ADMIN_LABEL))
      if (!t) throw new Error("no tooltip yet")
      return t
    })
    expect(tip.textContent).toContain(PLATFORM_ADMIN_LABEL)
  })
})

describe("the platform admin's own layout", () => {
  const platformSidebar = (pathname: string) =>
    renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>
          <PlatformSidebarView pathname={pathname} account={{ name: "Ana Admin", email: "ana@example.com" }} />
        </SidebarProvider>
      </TooltipProvider>,
    )

  it("its sidebar is titled Mynt platform admin and lists the nine sections, each its own address", () => {
    const html = platformSidebar("/platform")
    expect(html).toContain(admin.PLATFORM_NAME)
    expect(PLATFORM_SECTIONS.map((s) => s.label)).toEqual(admin.ADMIN_TABS.map((t) => admin.ADMIN_TAB_LABELS[t]))
    const hrefs = [...html.matchAll(/<a[^>]*data-platform-link="([a-z]+)"[^>]*>/g)].map((m) => [m[1], m[0].match(/href="([^"]+)"/)?.[1]])
    expect(Object.fromEntries(hrefs)).toEqual({
      overview: "/platform",
      workspaces: "/platform/workspaces",
      people: "/platform/people",
      apps: "/platform/apps",
      products: "/platform/products",
      firms: "/platform/firms",
      licences: "/platform/licences",
      vendors: "/platform/vendors",
      settings: "/platform/settings",
    })
  })

  it("Back to Studio (labelled) and the signed-in account at its foot; no workspace switcher and no app folders", () => {
    const html = platformSidebar("/platform/firms")
    const footer = html.slice(html.indexOf('data-sidebar="footer"'))
    const back = footer.match(/<a[^>]*data-back-to-studio[^>]*>.*?<\/a>/)?.[0] ?? ""
    expect(back).toContain('href="/"')
    expect(back).toContain("<svg")
    expect(back).toContain(`<span>${BACK_TO_STUDIO}</span>`)
    expect(footer).toContain("Ana Admin")
    expect(footer.indexOf("data-back-to-studio")).toBeLessThan(footer.indexOf("data-account-name"))
    for (const gone of ["data-folder", "Create workspace", "data-platform-admin-link", "Dashboard", "Marketplace"]) expect(html).not.toContain(gone)
  })

  it("marks the section on screen, a detail page under its section", () => {
    const tag = (html: string, t: string) => html.match(new RegExp(`<a[^>]*data-platform-link="${t}"[^>]*>`))?.[0] ?? ""
    expect(tag(platformSidebar("/platform"), "overview")).toContain('data-active="true"')
    expect(tag(platformSidebar("/platform"), "firms")).toContain('data-active="false"')
    expect(tag(platformSidebar(`/platform/firms/${FIRM}`), "firms")).toContain('data-active="true"')
    expect(tag(platformSidebar(`/platform/firms/${FIRM}`), "overview")).toContain('data-active="false"')
  })

  it("/platform renders its own shell: its sidebar and header, not the studio's", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ signedIn: true, name: "Ana Admin", email: "ana@example.com" }), { status: 200 })))
    for (const [pathname, title] of [["/platform", "Mynt platform admin"], ["/platform/settings", "Platform settings"], [`/platform/apps/${FIRM}`, "Apps"]]) {
      nav.pathname = pathname
      render(<PlatformShell><p data-page>Page</p></PlatformShell>)
      await act(async () => undefined)
      expect(document.querySelector("[data-platform-sidebar]")).not.toBeNull()
      expect(document.querySelector("[data-platform-header] h1")!.textContent).toBe(title)
      expect(document.querySelector("[data-header-back-to-studio]")!.textContent).toContain(BACK_TO_STUDIO)
      expect(document.querySelector("[data-page]")).not.toBeNull()
      expect(document.querySelector("[data-site-header]")).toBeNull()
      expect(document.querySelector("[data-folder]")).toBeNull()
      expect(document.body.textContent).not.toContain("Acme")
      cleanup()
    }
    nav.pathname = "/platform"
  })
})

describe("addresses", () => {
  it("each section and detail has its own address; anything else isn't a platform admin page", () => {
    expect(admin.adminHref("overview")).toBe("/platform")
    expect(admin.adminHref("licences")).toBe("/platform/licences")
    expect(admin.adminHref("firms", FIRM)).toBe(`/platform/firms/${FIRM}`)
    expect(admin.platformRouteOf("/platform")).toEqual({ tab: "overview", id: null })
    expect(admin.platformRouteOf("/platform/vendors")).toEqual({ tab: "vendors", id: null })
    expect(admin.platformRouteOf(`/platform/workspaces/${FIRM}`)).toEqual({ tab: "workspaces", id: FIRM })
    for (const p of ["/platform/nope", "/platform/overview", `/platform/products/${FIRM}`, "/platform/firms/a%2Fb", `/platform/firms/${FIRM}/more`, "/platforms", "/admin"]) expect(admin.platformRouteOf(p), p).toBeNull()
    expect(admin.platformTitle("/platform")).toBe("Mynt platform admin")
    expect(admin.platformTitle(`/platform/firms/${FIRM}`)).toBe("Firms")
  })

  it("the old /admin?tab=…&id=… and /settings?tab=esign addresses go to /platform", () => {
    const to = (path: string) => {
      const u = new URL(path, "http://studio.test")
      return legacyRedirect(u.pathname, u.searchParams)
    }
    expect(to("/admin")).toBe("/platform")
    expect(to("/admin?tab=overview")).toBe("/platform")
    expect(to("/admin?tab=settings")).toBe("/platform/settings")
    expect(to("/admin?tab=licences")).toBe("/platform/licences")
    expect(to(`/admin?tab=firms&id=${FIRM}`)).toBe(`/platform/firms/${FIRM}`)
    expect(to(`/admin?tab=apps&id=${FIRM}`)).toBe(`/platform/apps/${FIRM}`)
    expect(to(`/admin?tab=workspaces&id=${FIRM}`)).toBe(`/platform/workspaces/${FIRM}`)
    expect(to("/admin?tab=nope")).toBe("/platform")
    expect(to("/admin?tab=firms&id=..%2Fx")).toBe("/platform/firms") // an id that isn't one is dropped
    expect(to(`/admin?tab=products&id=${FIRM}`)).toBe("/platform/products") // Products has no detail page
    expect(to("/settings?tab=esign")).toBe("/platform/settings")
    for (const p of ["/settings", "/settings?tab=members", "/administer", "/platform", "/"]) expect(to(p), p).toBeNull()
  })

  it("the proxy sends them on (a temporary redirect, the old query left behind), before sign-in", async () => {
    const saved = { ...process.env }
    process.env.APP_URL = "https://mynt.example.test"
    try {
      const { NextRequest } = await import("next/server")
      const { proxy } = await import("@/proxy")
      const visit = (path: string) => proxy(new NextRequest(new URL(path, "https://mynt.example.test"), { headers: { host: "mynt.example.test" } }))
      let res = await visit(`/admin?tab=firms&id=${FIRM}`)
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe(`https://mynt.example.test/platform/firms/${FIRM}`)
      res = await visit("/settings?tab=esign")
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe("https://mynt.example.test/platform/settings")
      // Signed out, /platform itself goes to sign-in and comes back.
      res = await visit("/platform/licences")
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe(`https://mynt.example.test/api/auth/login?next=${encodeURIComponent("/platform/licences")}`)
    } finally {
      process.env = saved
    }
  })

  it("the /platform pages need sign-in like every studio page (lib/page-gate.ts); a signed-in non-admin gets the 404 (admin-routes.test.ts)", () => {
    for (const p of ["/platform", "/platform/firms", `/platform/firms/${FIRM}`]) expect(pageNeedsSignIn(p), p).toBe(true)
    expect(signInPathFor("/platform/settings", "")).toEqual({ pathname: "/api/auth/login", search: `?next=${encodeURIComponent("/platform/settings")}` })
  })

  it("/platform and /admin are never an app's id; the studio's gates don't treat them specially any more", () => {
    expect(isAppPath("/platform")).toBe(false)
    expect(isAppPath("/admin")).toBe(false)
    const access = { developer: true, admin: true, liquidity: { builder: false, liquidityProvider: false }, owner: null }
    expect(pageGateFor("/", access, true)).toBe("workspace")
  })

  it("search lists the platform admin's sections only for Mynt admins, at /platform/…", () => {
    const urls = (isAdmin: boolean) => searchStudio(searchIndex({ admin: isAdmin }), "platform admin").map((h) => h.href)
    expect(urls(false)).toEqual([])
    const found = urls(true)
    expect(found).toContain("/platform")
    expect(found.every((h) => h.startsWith("/platform"))).toBe(true)
    expect(searchStudio(searchIndex({ admin: true }), "esign").map((h) => h.href)).toContain("/platform/settings")
    expect(searchIndex({ admin: false }).some((i) => i.href.startsWith("/platform") || i.href.startsWith("/admin"))).toBe(false)
  })
})
