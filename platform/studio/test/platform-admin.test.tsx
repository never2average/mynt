// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The platform admin at its own base path (/platform), in its own layout: the studio sidebar's "Platform admin" badge
// above the account (Mynt admins only, expanded and collapsed), the platform admin's own sidebar and header (no studio
// sidebar, no workspace switcher, no app folders), each section's address, the old /admin?tab=…&id=… and
// /settings?tab=esign addresses redirecting, and signed-out visits going to sign-in.

const nav = { pathname: "/platform", search: "", pushed: [] as string[] };
vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
  useRouter: () => ({ push: (href: string) => void nav.pushed.push(href), replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { SidebarView, PLATFORM_ADMIN_LABEL } = await import("@/components/app-sidebar");
const { PlatformShell, PlatformSidebarView, PLATFORM_SECTIONS, BACK_TO_STUDIO } = await import("@/components/platform-shell");
const { PlatformSection } = await import("@/components/platform-view");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const admin = await import("@/lib/admin");
const { legacyRedirect } = await import("@/lib/redirects");
const { pageNeedsSignIn, signInPathFor } = await import("@/lib/page-gate");
const { isAppPath, platformSearchIndex, searchIndex, searchPlatform, searchStudio } = await import("@/lib/studio-search");
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

  it("its sidebar is titled Mynt platform admin and lists the eight sections, in order, each its own address; Licences is no longer one", () => {
    const html = platformSidebar("/platform")
    expect(html).toContain(admin.PLATFORM_NAME)
    expect(PLATFORM_SECTIONS.map((s) => s.label)).toEqual(admin.ADMIN_TABS.map((t) => admin.ADMIN_TAB_LABELS[t]))
    expect(PLATFORM_SECTIONS.map((s) => s.label)).toEqual(["Overview", "Workspaces", "Regulated firms", "Vendors", "Audit trails", "Risk models", "Risk register", "Platform settings"])
    expect(html).not.toContain('data-platform-link="licences"')
    expect(html).not.toContain(">Licences<")
    // The title has no "All workspaces and firms" line under it any more.
    expect(html).not.toContain("All workspaces")
    const hrefs = [...html.matchAll(/<a[^>]*data-platform-link="([a-z-]+)"[^>]*>/g)].map((m) => [m[1], m[0].match(/href="([^"]+)"/)?.[1]])
    expect(Object.fromEntries(hrefs)).toEqual({
      overview: "/platform",
      workspaces: "/platform/workspaces",
      firms: "/platform/firms",
      vendors: "/platform/vendors",
      audit: "/platform/audit",
      "risk-models": "/platform/risk-models",
      "risk-register": "/platform/risk-register",
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

  it("/platform renders its own shell: its sidebar and header, not the studio's; the header has no scope tag and no Back to Studio", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ signedIn: true, name: "Ana Admin", email: "ana@example.com" }), { status: 200 })))
    for (const [pathname, title] of [["/platform", "Mynt platform admin"], ["/platform/settings", "Platform settings"], ["/platform/audit", "Audit trails"], [`/platform/audit/${FIRM}`, "Audit trails"], ["/platform/risk-models", "Risk models"], [`/platform/risk-models/${FIRM}`, "Risk models"], ["/platform/risk-register", "Risk register"]]) {
      nav.pathname = pathname
      render(<PlatformShell><p data-page>Page</p></PlatformShell>)
      await act(async () => undefined)
      expect(document.querySelector("[data-platform-sidebar]")).not.toBeNull()
      expect(document.querySelector("[data-platform-header] h1")!.textContent).toBe(title)
      const header = document.querySelector("[data-platform-header]")!
      expect(header.querySelector("[data-header-back-to-studio]")).toBeNull()
      expect(header.querySelector("[data-header-scope]")).toBeNull()
      expect(header.textContent).not.toContain(BACK_TO_STUDIO)
      expect(header.textContent).not.toContain("All workspaces")
      // Back to Studio is the sidebar foot's, once.
      expect(document.querySelectorAll("[data-back-to-studio]")).toHaveLength(1)
      expect(document.querySelector("[data-back-to-studio]")!.textContent).toContain(BACK_TO_STUDIO)
      // The Overview's header keeps Invite person.
      expect(Boolean(header.querySelector("[data-header-invite-person]"))).toBe(pathname === "/platform")
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
    // Licences is the firms section's tab now, not a section: its old address isn't a page (the proxy sends it on).
    expect(admin.firmsHref("licences")).toBe("/platform/firms?tab=licences")
    expect(admin.firmsHref("firms")).toBe("/platform/firms?tab=firms")
    expect([admin.firmsTabOf("licences"), admin.firmsTabOf("firms"), admin.firmsTabOf(null), admin.firmsTabOf("members")]).toEqual(["licences", "firms", "firms", "firms"])
    expect(admin.platformRouteOf("/platform/licences")).toBeNull()
    expect(admin.platformRouteOf(`/platform/licences/${FIRM}`)).toBeNull()
    expect(admin.platformRouteOf("/platform/firms")).toEqual({ tab: "firms", id: null })
    expect(admin.adminHref("firms", FIRM)).toBe(`/platform/firms/${FIRM}`)
    expect(admin.platformRouteOf("/platform")).toEqual({ tab: "overview", id: null })
    expect(admin.platformRouteOf("/platform/vendors")).toEqual({ tab: "vendors", id: null })
    expect(admin.platformRouteOf(`/platform/workspaces/${FIRM}`)).toEqual({ tab: "workspaces", id: FIRM })
    expect(admin.platformRouteOf(`/platform/audit/${FIRM}`)).toEqual({ tab: "audit", id: FIRM })
    expect(admin.platformRouteOf("/platform/risk-register")).toEqual({ tab: "risk-register", id: null })
    expect(admin.platformRouteOf("/platform/risk-models")).toEqual({ tab: "risk-models", id: null })
    expect(admin.platformRouteOf(`/platform/risk-models/${FIRM}`)).toEqual({ tab: "risk-models", id: FIRM })
    // Security & risk moved: its old address isn't a section any more (the proxy sends it on to the Risk register).
    expect(admin.platformRouteOf("/platform/risks")).toBeNull()
    // Apps, People and Products are no longer sections: their pages and details aren't platform admin pages (404).
    for (const p of ["/platform/apps", `/platform/apps/${FIRM}`, "/platform/people", `/platform/people/${FIRM}`, "/platform/products", `/platform/products/${FIRM}`, `/platform/risks/${FIRM}`])
      expect(admin.platformRouteOf(p), p).toBeNull()
    // A risk on the Risk register has its own page.
    expect(admin.platformRouteOf(`/platform/risk-register/${FIRM}`)).toEqual({ tab: "risk-register", id: FIRM })
    expect(admin.adminHref("risk-register", FIRM)).toBe(`/platform/risk-register/${FIRM}`)
    expect(admin.platformRouteOf("/platform/risk-register/..%2Fx")).toBeNull()
    for (const p of ["/platform/nope", "/platform/overview", "/platform/firms/a%2Fb", `/platform/firms/${FIRM}/more`, "/platforms", "/admin"]) expect(admin.platformRouteOf(p), p).toBeNull()
    expect(admin.platformTitle("/platform")).toBe("Mynt platform admin")
    expect(admin.platformTitle(`/platform/firms/${FIRM}`)).toBe("Regulated firms")
    expect(admin.platformTitle("/platform/firms")).toBe("Regulated firms")
  })

  it("the old /admin?tab=…&id=… and /settings?tab=esign addresses go to /platform", () => {
    const to = (path: string) => {
      const u = new URL(path, "http://studio.test")
      return legacyRedirect(u.pathname, u.searchParams)
    }
    expect(to("/admin")).toBe("/platform")
    expect(to("/admin?tab=overview")).toBe("/platform")
    expect(to("/admin?tab=settings")).toBe("/platform/settings")
    expect(to("/admin?tab=licences")).toBe("/platform/firms?tab=licences")
    expect(to(`/admin?tab=firms&id=${FIRM}`)).toBe(`/platform/firms/${FIRM}`)
    expect(to(`/admin?tab=apps&id=${FIRM}`)).toBe("/platform") // Apps, People and Products are no longer sections
    expect(to("/admin?tab=apps")).toBe("/platform")
    expect(to(`/admin?tab=people&id=e616e61`)).toBe("/platform")
    expect(to("/admin?tab=products")).toBe("/platform")
    expect(to(`/admin?tab=workspaces&id=${FIRM}`)).toBe(`/platform/workspaces/${FIRM}`)
    expect(to("/admin?tab=nope")).toBe("/platform")
    expect(to("/admin?tab=firms&id=..%2Fx")).toBe("/platform/firms") // an id that isn't one is dropped
    expect(to(`/admin?tab=licences&id=${FIRM}`)).toBe("/platform/firms?tab=licences")
    // Licences is the firms section's Licences tab now: its old address, and anything under it, goes there.
    for (const p of ["/platform/licences", "/platform/licences/", `/platform/licences/${FIRM}`, "/platform/licences/a/b", "/platform/licences?status=pending"]) expect(to(p), p).toBe("/platform/firms?tab=licences")
    for (const p of ["/platform/firms", "/platform/firms?tab=licences", `/platform/firms/${FIRM}?tab=licences`, "/platform/licencesx", "/licences"]) expect(to(p), p).toBeNull()
    expect(to("/settings?tab=esign")).toBe("/platform/settings")
    // Security & risk is the Risk register now: its old addresses go there.
    expect(to("/platform/risks")).toBe("/platform/risk-register")
    expect(to("/platform/risks/")).toBe("/platform/risk-register")
    expect(to("/admin?tab=risks")).toBe("/platform/risk-register")
    expect(to(`/admin?tab=risks&id=${FIRM}`)).toBe("/platform/risk-register")
    for (const p of ["/platform/risk-register", "/platform/risk-models", `/platform/risks/${FIRM}`]) expect(to(p), p).toBeNull()
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
      res = await visit("/platform/risks")
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe("https://mynt.example.test/platform/risk-register")
      res = await visit("/settings?tab=esign")
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe("https://mynt.example.test/platform/settings")
      // The old Licences section, and anything under it, goes to the firms section's Licences tab (a redirect, not a 404).
      for (const old of ["/platform/licences", `/platform/licences/${FIRM}`, "/admin?tab=licences", "/platform/licences?x=1"]) {
        res = await visit(old)
        expect(res.status, old).toBe(307)
        expect(res.headers.get("location"), old).toBe("https://mynt.example.test/platform/firms?tab=licences")
      }
      // Signed out, /platform itself goes to sign-in and comes back.
      res = await visit("/platform/firms?tab=licences")
      expect(res.status).toBe(307)
      expect(res.headers.get("location")).toBe(`https://mynt.example.test/api/auth/login?next=${encodeURIComponent("/platform/firms?tab=licences")}`)
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
    expect(found).toEqual(["/platform", "/platform/workspaces", "/platform/firms", "/platform/vendors", "/platform/audit", "/platform/risk-models", "/platform/risk-register", "/platform/settings"].filter((h) => found.includes(h)))
    for (const gone of ["/platform/apps", "/platform/people", "/platform/products"]) expect(searchIndex({ admin: true }).some((i) => i.href === gone)).toBe(false)
    expect(searchStudio(searchIndex({ admin: true }), "audit trails").map((h) => h.href)).toContain("/platform/audit")
    expect(searchStudio(searchIndex({ admin: true }), "security risk").map((h) => h.href)).toContain("/platform/risk-register")
    expect(searchStudio(searchIndex({ admin: true }), "risk models validation").map((h) => h.href)).toContain("/platform/risk-models")
    expect(searchIndex({ admin: true }).some((i) => i.href === "/platform/risks")).toBe(false)
    // Licences isn't a section any more: no entry at its old address; its words find Regulated firms → Licences.
    expect(searchIndex({ admin: true }).some((i) => i.href === "/platform/licences" || i.label === "Platform admin: Licences")).toBe(false)
    expect(searchIndex({ admin: true }).some((i) => i.label === "Platform admin: Regulated firms")).toBe(true)
    for (const q of ["licences", "licence review", "verify licence"]) {
      const hits = searchStudio(searchIndex({ admin: true }), q).filter((h) => h.href.startsWith("/platform"))
      expect(hits.map((h) => [h.label, h.href]), q).toEqual([["Platform admin: Regulated firms → Licences", "/platform/firms?tab=licences"]])
      expect(searchStudio(searchIndex({ admin: false }), q).some((h) => h.href.startsWith("/platform")), q).toBe(false)
    }
    expect(searchIndex({ admin: false }).some((i) => i.href.startsWith("/platform") || i.href.startsWith("/admin"))).toBe(false)
  })
})

describe("the platform admin's header: Docs and search, as the studio's header has them", () => {
  const WS = "44444444-4444-4444-8444-444444444444"
  // The admin list routes and a session; every request recorded.
  const stubApi = () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        const body = url === "/api/admin/workspaces"
          ? { workspaces: [{ id: WS, name: "Harbor Lending", personal: false, status: "active", owner: null, members: 2, apps: 1, createdAt: null }], total: 1 }
          : url === "/api/admin/firms"
            ? { firms: [{ id: FIRM, name: "Atlas Trust Bank", status: "active", legalForm: null, country: "US", regions: [], members: [], licences: [], types: [], createdAt: null }] }
            : { signedIn: true, name: "Ana Admin", email: "ana@example.com" }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    return urls
  }
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= function () {}
  })

  it("the sidebar has no Sections label above Overview; the eight sections are still listed", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>
          <PlatformSidebarView pathname="/platform" account={{ name: null, email: null }} />
        </SidebarProvider>
      </TooltipProvider>,
    )
    expect(html).not.toContain("Sections")
    expect(html).not.toContain('data-sidebar="group-label"')
    expect([...html.matchAll(/data-platform-link="([a-z-]+)"/g)]).toHaveLength(8)
  })

  it("every page's header has the labelled Docs button to /docs and the labelled search field; Invite person stays on the Overview", async () => {
    stubApi()
    for (const pathname of ["/platform", "/platform/firms", `/platform/workspaces/${WS}`]) {
      nav.pathname = pathname
      render(<PlatformShell><p data-page>Page</p></PlatformShell>)
      await act(async () => undefined)
      const header = document.querySelector("[data-platform-header]")!
      const docs = header.querySelector("a[data-docs-open]")!
      expect(docs.getAttribute("href")).toBe("/docs")
      expect(docs.textContent).toBe("Docs")
      const search = header.querySelector("[data-search-trigger]")!
      expect(search.textContent).toContain("Search")
      expect(search.textContent).not.toContain("ask AI")
      expect(Boolean(header.querySelector("[data-header-invite-person]"))).toBe(pathname === "/platform")
      cleanup()
    }
    nav.pathname = "/platform"
  })

  it("search opens with Cmd+K, lists the sections first and the studio's pages after, and finds workspaces and firms by name", async () => {
    const urls = stubApi()
    render(<PlatformShell><p data-page>Page</p></PlatformShell>)
    await act(async () => undefined)
    // Nothing of the admin lists is loaded before search opens.
    expect(urls.filter((u) => u.startsWith("/api/admin"))).toEqual([])
    await act(async () => {
      fireEvent.keyDown(document, { key: "k", metaKey: true })
    })
    expect(document.querySelector("[data-platform-search]")).not.toBeNull()
    await act(async () => undefined)
    expect(urls.filter((u) => u.startsWith("/api/admin")).sort()).toEqual(["/api/admin/firms", "/api/admin/workspaces"])
    // No workspace is read (nothing of the studio's workspace-scoped routes) and there's no Ask AI.
    expect(urls.some((u) => u.startsWith("/api/workspaces") || u.startsWith("/api/projects") || u.startsWith("/api/ask"))).toBe(false)
    expect(document.querySelector("[data-ask-ai]")).toBeNull()
    const shown = () => [...document.querySelectorAll("[data-result]")].map((e) => [e.getAttribute("data-result"), e.textContent])
    const groups = () => [...new Set(shown().map(([g]) => g))]
    expect(groups()).toEqual(["Platform admin", "Studio"])
    expect(shown().filter(([g]) => g === "Platform admin").map(([, t]) => t)).toEqual(PLATFORM_SECTIONS.map((s) => s.label))
    expect(shown().some(([g, t]) => g === "Studio" && t === "Studio: Dashboard")).toBe(true)

    const input = document.querySelector("[data-platform-search] input")!
    await act(async () => {
      fireEvent.change(input, { target: { value: "harbor" } })
    })
    expect(shown()).toEqual([["Workspaces", "Harbor Lendingactive"]])
    await act(async () => {
      fireEvent.change(input, { target: { value: "atlas" } })
    })
    expect(shown()).toEqual([["Regulated firms", "Atlas Trust BankUS · active"]])
    await act(async () => {
      fireEvent.change(input, { target: { value: "licences" } })
    })
    expect(groups()).toEqual(["Platform admin", "Studio"])
    expect(shown().filter(([g]) => g === "Platform admin")).toEqual([["Platform admin", "Regulated firms → Licences"]])
  })

  it("its index: sections at /platform/…, workspaces and firms at their detail pages, studio pages labelled Studio", () => {
    const index = platformSearchIndex({ workspaces: [{ id: WS, name: "Harbor Lending" }], firms: [{ id: FIRM, name: "Atlas Trust Bank" }] })
    expect(searchPlatform(index, "harbor").map((h) => h.href)).toEqual([`/platform/workspaces/${WS}`])
    expect(searchPlatform(index, "atlas").map((h) => h.href)).toEqual([`/platform/firms/${FIRM}`])
    const audit = searchPlatform(index, "audit")
    expect(audit[0]).toMatchObject({ group: "Platform admin", label: "Audit trails", href: "/platform/audit" })
    expect(audit.some((h) => h.group === "Studio" && h.href === "/audits")).toBe(true)
    expect(searchPlatform(index, "docs").map((h) => [h.label, h.href])).toContainEqual(["Studio: Docs", "/docs"])
    // Licences is found as the firms section's tab, never as a section; an empty search lists the eight sections only.
    for (const q of ["licences", "licence review", "verify licence"])
      expect(searchPlatform(index, q).filter((h) => h.group === "Platform admin").map((h) => [h.label, h.href]), q).toEqual([["Regulated firms → Licences", "/platform/firms?tab=licences"]])
    expect(searchPlatform(index, "").filter((h) => h.group === "Platform admin").map((h) => h.label)).toEqual(PLATFORM_SECTIONS.map((x) => x.label))
    expect(index.some((i) => i.href === "/platform/licences")).toBe(false)
    expect(searchPlatform(index, "regulated firms")[0]).toMatchObject({ group: "Platform admin", label: "Regulated firms", href: "/platform/firms" })
  })
})

describe("the firms section's own tabs: Regulated firms and Licences", () => {
  const LIC = "55555555-5555-4555-8555-555555555555"
  const licence = (id: string, status: string) => ({ id, entityId: FIRM, firm: "Atlas Trust Bank", region: "US", regulator: "occ", licenceType: "trust_charter", jurisdiction: null, number: "T-1", validFrom: null, validTo: "2027-01-01", status, reviewNote: null, createdAt: null })
  const firm = { id: FIRM, name: "Atlas Trust Bank", status: "active", legalForm: null, country: "US", regions: [], members: [], licences: [licence(LIC, "pending")], awaitingReview: 1, types: [], createdAt: null }
  const stub = () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null })
        const body = init?.method === "POST"
          ? { ok: true, message: "Verified. The firm may now rely on it." }
          : url === "/api/admin/firms"
            ? { firms: [firm, { ...firm, id: "66666666-6666-4666-8666-666666666666", name: "Unknown Co", licences: [], awaitingReview: null }] }
            : url === "/api/admin/licences"
              ? { licences: [licence(LIC, "pending"), licence("77777777-7777-4777-8777-777777777777", "verified")] }
              : { firm, offerings: null, products: null }
        return new Response(JSON.stringify(body), { status: 200 })
      }),
    )
    return calls
  }
  const show = async (search: string, id: string | null = null) => {
    nav.search = search
    nav.pushed = []
    render(<PlatformSection tab="firms" id={id} />)
    await act(async () => undefined)
    await act(async () => undefined)
  }
  const tabs = () => [...document.querySelectorAll("[data-firms-tab]")].map((t) => [t.textContent, t.getAttribute("aria-selected")])

  it("/platform/firms opens on Regulated firms: the list with Register regulated firm and each firm's licences awaiting review", async () => {
    const calls = stub()
    await show("")
    expect(tabs()).toEqual([["Regulated firms", "true"], ["Licences", "false"]])
    expect(document.querySelector('[data-slot="tabs-row"][data-variant="line"]')).not.toBeNull() // the shared line tabs
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/firms"]) // the licences aren't read until their tab opens
    expect(document.querySelector("[data-register-firm]")!.textContent).toBe("Register regulated firm")
    expect([...document.querySelectorAll("th")].map((h) => h.textContent)).toContain("Awaiting review")
    expect([...document.querySelectorAll("[data-awaiting-review]")].map((c) => c.textContent)).toEqual(["1", "Not available"])
    // Its tabs go to their own address.
    await act(async () => void fireEvent.click(document.querySelector('[data-firms-tab="licences"]')!))
    expect(nav.pushed).toEqual(["/platform/firms?tab=licences"])
    cleanup()
    await show("tab=firms")
    expect(tabs()).toEqual([["Regulated firms", "true"], ["Licences", "false"]])
  })

  it("?tab=licences shows the review queue: waiting for review first, its figures, filters, Export CSV, the firm linked, and the three actions posting to the existing route", async () => {
    const calls = stub()
    await show("tab=licences")
    expect(tabs()).toEqual([["Regulated firms", "false"], ["Licences", "true"]])
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/licences"])
    expect(document.querySelector("[data-register-firm]")).toBeNull()
    const view = document.querySelector("[data-admin-licences]")!
    expect(view.querySelector('[data-row="admin-licence-figures"] [data-kpi="pending"]')).not.toBeNull()
    for (const s of ["Waiting for review", "Verified", "Rejected", "Suspended", "Export CSV", "Filters"]) expect(view.textContent).toContain(s)
    // Opens filtered to the ones waiting for review: the verified one isn't listed until the filter is cleared.
    expect([...view.querySelectorAll("tbody tr[data-row]")].map((r) => r.getAttribute("data-row"))).toEqual([LIC])
    expect([...view.querySelectorAll("th")].map((h) => h.textContent)[0]).toBe("Firm")
    const link = view.querySelector<HTMLAnchorElement>(`[data-licence-firm="${FIRM}"]`)!
    expect(link.textContent).toBe("Atlas Trust Bank")
    expect(link.getAttribute("href")).toBe(`/platform/firms/${FIRM}?tab=licences`)
    expect([...view.querySelectorAll("[data-review]")].map((b) => b.textContent)).toEqual(["Verify licence", "Reject licence"])
    await act(async () => void fireEvent.click(view.querySelector('[data-review="verified"]')!))
    await act(async () => void fireEvent.submit(document.querySelector("[data-review-licence-form]")!))
    expect(calls.filter((c) => c.method === "POST")).toEqual([{ url: `/api/admin/licences/${LIC}`, method: "POST", body: { decision: "verified" } }])
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Verified. The firm may now rely on it.")
    await act(async () => void fireEvent.click(document.querySelector('[data-firms-tab="firms"]')!))
    expect(nav.pushed).toEqual(["/platform/firms?tab=firms"])
  })

  it("a firm's page keeps its own tabs (?tab=licences is the firm's Licences), with the review actions there too", async () => {
    stub()
    nav.pathname = `/platform/firms/${FIRM}`
    await show("tab=licences", FIRM)
    expect(document.querySelector("[data-firms-tab]")).toBeNull()
    expect(document.querySelector('[data-detail-tab="licences"]')!.getAttribute("aria-selected")).toBe("true")
    expect(document.querySelector("[data-back]")!.textContent).toBe("Back to regulated firms")
    expect([...document.querySelectorAll("[data-detail-table] [data-review]")].map((b) => b.textContent)).toEqual(["Verify licence", "Reject licence"])
    nav.pathname = "/platform"
    nav.search = ""
  })
})
