// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The platform admin's screens (/platform; its own layout and the studio sidebar's badge are in platform-admin.test.tsx):
// the studio sidebar without the old Admin group, each section's view and its not-available state, and each action
// sheet posting to its route with exactly what was typed.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { SidebarView } = await import("@/components/app-sidebar");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { pageTitle, isAppPath } = await import("@/lib/studio-search");
const { PlatformSidebarView, PLATFORM_SECTIONS } = await import("@/components/platform-shell");
const { OverviewView } = await import("@/components/admin-overview");
const { OperationalSettingsView } = await import("@/components/admin-settings");
const { WorkspacesListView, WorkspaceDetailView } = await import("@/components/admin-workspaces");
const { AppsListView, AppDetailView, RemoveAppSheet } = await import("@/components/admin-apps");
const { ProductsListView } = await import("@/components/admin-products");
const { FirmsListView, FirmDetailView, RegisterFirmSheet, InviteMemberSheet, FirmStatusSheet } = await import("@/components/admin-firms");
const { LicencesAdminView, ReviewLicenceSheet, decisionsFor } = await import("@/components/admin-licences");
const { VendorsView, AddServiceTypeSheet, SuspendOfferingSheet, schemaOf } = await import("@/components/admin-vendors");
const { AdminNotReady } = await import("@/components/admin-kit");
const { TabSelector } = await import("@/components/workspace-view");
const admin = await import("@/lib/admin");
const { groupByStage } = await import("@/lib/workspaces");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const WS = "11111111-1111-4111-8111-111111111111";
const APP = "22222222-2222-4222-8222-222222222222";
const FIRM = "33333333-3333-4333-8333-333333333333";
const LIC = "44444444-4444-4444-8444-444444444444";
const OFF = "55555555-5555-4555-8555-555555555555";

const sidebar = (pathname: string, isAdmin: boolean) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarView
          workspaces={[{ id: "w1", name: "Acme", role: "owner" }]}
          selected={{ id: "w1", name: "Acme", role: "owner" }}
          supported
          groups={groupByStage([{ id: "app-1", name: "Round-up savings", stage: "production" }])}
          account={{ name: null, email: null }}
          pathname={pathname}
          onSelectWorkspace={() => undefined}
          onCreateWorkspace={async () => null}
          admin={isAdmin}
        />
      </SidebarProvider>
    </TooltipProvider>,
  )

const fetcher = () => {
  const calls: { url: string; body: unknown }[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ ok: true, message: "Done by Mynt." }), { status: 200, headers: { "content-type": "application/json" } })
  })
  return { f: f as unknown as typeof fetch, calls }
}
const click = async (sel: string) => act(async () => void fireEvent.click(document.querySelector(sel)!))
const type = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } })

const FIRM_ROW: import("@/lib/admin").Firm = {
  id: FIRM,
  name: "Acme Trust",
  status: "active",
  legalForm: "company_private",
  country: "us",
  regions: ["US"],
  members: [{ id: "u1", name: "Lee", email: "lee@example.com", roles: ["license_provider"] }],
  licences: [],
  types: ["license_provider"],
  createdAt: "2026-10-01T00:00:00.000Z",
}
const APP_ROW: import("@/lib/admin").AdminApp = { id: APP, name: "Saver", status: "draft", stage: "idea", workspace: { id: WS, name: "Team" }, owner: { id: "u", name: "Ana", email: "ana@example.com" }, productIds: ["p1"], latestBuild: null, builds: 0, hosting: null, createdAt: null }
const LICENCE: import("@/lib/admin").AdminLicence = { id: LIC, entityId: FIRM, firm: "Acme Trust", region: "US", regulator: "occ", licenceType: "trust_charter", jurisdiction: null, number: "T-1", validFrom: null, validTo: "2027-01-01", status: "pending", reviewNote: null, createdAt: null }

describe("the sidebar and header", () => {
  it("the studio sidebar has no Admin group and no All workspaces switcher, for anyone, on any page; admins get the Platform admin badge", () => {
    for (const [pathname, isAdmin] of [["/", false], ["/", true], ["/admin", true], ["/platform", true], ["/admin", false]] as const) {
      const html = sidebar(pathname, isAdmin)
      for (const gone of ["data-admin-group", "data-admin-link", "data-all-workspaces", "All workspaces"]) expect(html).not.toContain(gone)
      expect(html).toContain("Round-up savings") // the workspace's folders stay
      expect(html.includes("data-platform-admin-link")).toBe(isAdmin)
    }
  })

  it("/platform is a fixed page, never an app; the studio header has no scope badge any more", () => {
    expect(isAppPath("/platform")).toBe(false)
    expect(isAppPath("/admin")).toBe(false)
    expect(pageTitle("/platform")).toBe("Mynt platform admin")
  })

  it("workspace Settings has no E-signature tab any more", () => {
    const html = renderToStaticMarkup(<TabSelector tab="members" onTab={() => undefined} />)
    expect(html).not.toContain("E-signature")
    expect(html).not.toContain("esign")
  })
})

describe("each tab", () => {
  it("the platform sidebar names every section; an unknown section opens Overview", () => {
    const html = renderToStaticMarkup(<TooltipProvider><SidebarProvider><PlatformSidebarView pathname="/platform/licences" account={{ name: null, email: null }} /></SidebarProvider></TooltipProvider>)
    for (const t of admin.ADMIN_TABS) expect(html).toContain(admin.ADMIN_TAB_LABELS[t])
    expect(PLATFORM_SECTIONS.map((x) => x.tab)).toEqual([...admin.ADMIN_TABS])
    expect(admin.adminTabOf("nope")).toBe("overview")
    expect(admin.adminHref("firms", FIRM)).toBe(`/platform/firms/${FIRM}`)
  })

  it("Overview: what needs attention first; an agent this server doesn't run is Not measured, never $0", () => {
    const ops = admin.opsFrom({ attention: ["hosting: 1 app(s) stopped"], window_hours: 24, agents: { builds: { failures: [], stuck: [{}], spend_this_month_usd: 0 } }, hosting: { stopped_apps: [{}] }, backups: { status: "no status file" } })!
    const html = renderToStaticMarkup(<OverviewView ops={ops} />)
    expect(html).toContain("hosting: 1 app(s) stopped")
    expect(html).toContain("$0.00") // measured: builds ran and cost nothing
    expect(html).toContain("Not measured") // the desk, explorers, reviews, connector
    expect(html).toContain("no status file")
    expect(html).toContain("Oversight audits overdue")
    const audits = admin.opsFrom({ attention: ["agreement audits: 2 overdue oversight audits (on 1 apps)"], agents: {}, agreement_audits: { overdue: 2, apps_flagged: 1 } })!
    expect(audits.sections.find((x) => x.id === "agreements")!.rows.slice(1).map((r) => r.value)).toEqual(["2", "1"])
    // Overdue risk reviews on apps' and products' risk registers; a server without the register says Not measured.
    expect(admin.opsFrom({ attention: [], agents: {}, risks: { overdue_reviews: 3, overdue: [] } })!.sections.find((x) => x.id === "risks")!.rows[0]).toEqual({ label: "Risk reviews overdue", value: "3" })
    expect(audits.sections.find((x) => x.id === "risks")!.rows[0].value).toBe("Not measured")
    const quiet = admin.opsFrom({ attention: ["Nothing needs attention"], agents: {} })!
    expect(renderToStaticMarkup(<OverviewView ops={quiet} />)).toContain('data-attention="none"')
  })

  it("Platform settings: the operational settings read-only, with where each comes from", () => {
    const html = renderToStaticMarkup(<OperationalSettingsView settings={[{ key: "BUILD_CAP_USD", value: "12", default: "10", source: "environment", description: "Spend cap" }]} />)
    expect(html).toContain("BUILD_CAP_USD")
    expect(html).toContain("The server&#x27;s environment")
    expect(html).not.toContain("<input")
  })

  it("Workspaces: list and detail (metadata card, Members, Apps, Invitations, Activity)", () => {
    const rows = admin.workspacesFrom({ workspaces: [{ id: WS, name: "Team", status: "frozen", members: 2, apps: 1, owner: { id: "u", email: "ana@example.com" } }], total: 3 })!
    const list = renderToStaticMarkup(<WorkspacesListView workspaces={rows.rows} total={rows.total} onOpen={() => undefined} />)
    for (const s of ["Team", "ana@example.com", "Frozen", "Import", "Export CSV", "The newest 1 of 3", `data-open-workspace="${WS}"`]) expect(list).toContain(s)
    const detail = admin.workspaceDetailFrom({ workspace: { id: WS, name: "Team", status: "active" }, members: [{ user_id: "u", email: "ana@example.com", role: "owner" }], apps: [], invitations: [], activity: [] })!
    const html = renderToStaticMarkup(<WorkspaceDetailView detail={detail} onBack={() => undefined} onOpenApp={() => undefined} />)
    for (const s of ["data-metadata-card", "Back to workspaces", "Members", "Apps", "Invitations", "Activity", "ana@example.com"]) expect(html).toContain(s)
  })

  it("Apps: list with stage and hosting; detail with Builds, Hosting, Products and Remove test app", () => {
    const list = renderToStaticMarkup(<AppsListView apps={[APP_ROW]} total={1} onOpen={() => undefined} />)
    for (const s of ["Saver", "Team", "Not hosted", "No builds"]) expect(list).toContain(s)
    const html = renderToStaticMarkup(<AppDetailView detail={{ app: APP_ROW, products: [{ id: "p1", name: "Fixed deposit" }], builds: null, hosting: null }} onBack={() => undefined} onRemoved={() => undefined} />)
    for (const s of ["data-metadata-card", "Remove test app", "Builds", "Hosting", "Products", "runs no coding agents"]) expect(html).toContain(s)
  })

  it("Products: every product with its firm and sponsors; a reference product is Mynt's", () => {
    const page = admin.productsFrom({ products: [{ id: "p1", name: "Fixed deposit", status: "published", stage: "production", firm: null, sponsors: [{ entity_id: FIRM, name: "Acme Trust", status: "pending" }] }], total: 1 })!
    const html = renderToStaticMarkup(<ProductsListView products={page.rows} total={page.total} />)
    for (const s of ["Fixed deposit", "Mynt reference", "Acme Trust (pending)"]) expect(html).toContain(s)
  })

  it("Firms: type from members' roles, Register firm; detail with Invite member and Set firm status, and its tables", () => {
    expect(admin.firmTypes([{ id: "a", name: null, email: null, roles: ["developer", "vendor"] }])).toEqual(["vendor", "builder"])
    const list = renderToStaticMarkup(<FirmsListView firms={[FIRM_ROW]} onOpen={() => undefined} />)
    for (const s of ["Acme Trust", "Licence provider", "Register firm"]) expect(list).toContain(s)
    const html = renderToStaticMarkup(<FirmDetailView detail={{ firm: FIRM_ROW, offerings: null, products: [] }} onBack={() => undefined} />)
    for (const s of ["data-metadata-card", "Invite member", "Set firm status", "Members", "Licences", "Offerings", "Products", "lee@example.com"]) expect(html).toContain(s)
  })

  it("Licences: opens on the ones waiting for review, with Verify licence and Reject licence", () => {
    const html = renderToStaticMarkup(<LicencesAdminView licences={[LICENCE, { ...LICENCE, id: "x", status: "verified" }]} />)
    expect(html).toContain("Verify licence")
    expect(html).toContain("Reject licence")
    expect(html).toContain("Waiting for review")
    expect(decisionsFor("verified")).toEqual(["suspended"])
    expect(decisionsFor("rejected")).toEqual([])
  })

  it("Vendors: service types with Add service type; offerings with conformance and Suspend offering", () => {
    const data = {
      serviceTypes: admin.serviceTypesFrom([{ region: "US", key: "kyc_basic", name: "KYC", category: "kyc", consent_purpose: "kyc", moves_money: false }])!,
      offerings: admin.adminOfferingsFrom([{ offering_id: OFF, name: "Fast KYC", vendor: "Acme Trust", vendor_entity_id: FIRM, region: "US", service_type: { key: "kyc_basic", name: "KYC", category: "kyc" }, status: "suspended", conformance: { passed: false, at: "2026-11-01" } }])!,
    }
    const types = renderToStaticMarkup(<VendorsView data={data} />)
    expect(types).toContain("Add service type")
    expect(types).toContain("kyc_basic")
    const offerings = renderToStaticMarkup(<VendorsView data={data} initialView="offerings" />)
    expect(offerings).toContain("Reinstate offering")
    expect(offerings).toContain("Failed 2026-11-01")
    expect(schemaOf("[]")).toEqual({ ok: false, error: "It must be a JSON object." })
    expect(schemaOf("{nope")).toEqual({ ok: false, error: "That isn't valid JSON." })
  })

  it("Vendors: a Vendor firms tab with each firm's onboarding progress and next step, in words", () => {
    const firms = admin.vendorFirmsFrom({
      firms: [
        { entity_id: FIRM, name: "Acme Trust", status: "active", vendor_members: 2, services: 1, listed: 1, progress: { done: 8, total: 8, next: null, complete: true } },
        { entity_id: LIC, name: "B Bureau", status: "active", vendor_members: 1, services: 1, listed: 0, progress: { done: 4, total: 7, next: { key: "licence", title: "Licence verified by Mynt", status: "blocked" }, complete: false } },
        { entity_id: OFF, name: "C Checks", status: "active", vendor_members: null, services: 0, listed: 0, progress: { done: 2, total: 3, next: { key: "first_service", title: "Create your first service", status: "next" }, complete: false } },
      ],
    })!
    expect(admin.vendorFirmsFrom({})).toBeNull()
    const data = { serviceTypes: [], offerings: [], firms }
    const html = renderToStaticMarkup(<VendorsView data={data} initialView="firms" />)
    expect(html).toContain("Vendor firms")
    for (const h of ["Firm", "Vendor people", "Services", "Listed", "Onboarding", "Next step"]) expect(html).toContain(`>${h}<`)
    expect(html).toContain("All 8 steps done")
    expect(html).toContain("4 of 7 steps done")
    expect(html).toContain("Licence verified by Mynt (waiting for Mynt)")
    expect(html).toContain("Create your first service")
    expect(html).toContain("Not known") // C Checks' vendor people: not given, never 0
    expect(html).toContain('data-onboarding="complete"')
    // A Mynt without the checklist says so, never an empty table.
    expect(renderToStaticMarkup(<VendorsView data={{ ...data, firms: null }} initialView="firms" />)).toContain("data-empty=\"not-available\"")
  })

  it("a tab this Mynt can't answer yet says so; an error is shown as Mynt said it", () => {
    expect(renderToStaticMarkup(<AdminNotReady state={{ kind: "unsupported" }} what="Workspaces" />)).toContain("Workspaces isn&#x27;t available yet")
    expect(renderToStaticMarkup(<AdminNotReady state={{ kind: "error", message: "Couldn't reach Mynt." }} what="Firms" />)).toContain("Couldn&#x27;t reach Mynt.")
  })
})

describe("each action sheet posts to its route", () => {
  it("Register firm", async () => {
    const { f, calls } = fetcher()
    render(<RegisterFirmSheet open onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-firm-name]", "Acme Trust")
    type("[data-firm-lei]", "5493001KJTIIGC8Y1R12")
    await act(async () => void fireEvent.submit(document.querySelector("[data-register-firm-form]")!))
    expect(calls).toEqual([{ url: "/api/admin/firms", body: { name: "Acme Trust", incorporation: { country: "us" }, regions: ["US"], identifiers: [{ scheme: "lei", value: "5493001KJTIIGC8Y1R12" }] } }])
    expect(document.querySelector("[data-sheet-result]")?.textContent).toBe("Done by Mynt.")
  })

  it("Invite member, with the roles picked", async () => {
    const { f, calls } = fetcher()
    render(<InviteMemberSheet firm={FIRM_ROW} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-member-email]", "new@example.com")
    fireEvent.click(document.querySelector('[data-role="vendor"]')!)
    await act(async () => void fireEvent.submit(document.querySelector("[data-invite-member-form]")!))
    expect(calls).toEqual([{ url: `/api/admin/firms/${FIRM}/members`, body: { email: "new@example.com", roles: ["license_provider", "vendor"] } }])
  })

  it("Set firm status", async () => {
    const { f, calls } = fetcher()
    render(<FirmStatusSheet firm={FIRM_ROW} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-firm-status-select]", "suspended")
    type("[data-firm-status-note]", "Registry shows it suspended")
    await act(async () => void fireEvent.submit(document.querySelector("[data-firm-status-form]")!))
    expect(calls).toEqual([{ url: `/api/admin/firms/${FIRM}/status`, body: { status: "suspended", note: "Registry shows it suspended" } }])
  })

  it("Verify licence and Reject licence (which says why)", async () => {
    const { f, calls } = fetcher()
    const { rerender } = render(<ReviewLicenceSheet licence={LICENCE} decision="verified" onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    await act(async () => void fireEvent.submit(document.querySelector("[data-review-licence-form]")!))
    rerender(<ReviewLicenceSheet licence={{ ...LICENCE }} decision="rejected" onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    expect((document.querySelector('[data-review-submit="rejected"]') as HTMLButtonElement).disabled).toBe(true)
    type("[data-review-note]", "Not on the register")
    await act(async () => void fireEvent.submit(document.querySelector("[data-review-licence-form]")!))
    expect(calls).toEqual([
      { url: `/api/admin/licences/${LIC}`, body: { decision: "verified" } },
      { url: `/api/admin/licences/${LIC}`, body: { decision: "rejected", note: "Not on the register" } },
    ])
  })

  it("Add service type, with its schemas as JSON", async () => {
    const { f, calls } = fetcher()
    render(<AddServiceTypeSheet open onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-type-key]", "bank_account_check")
    type("[data-type-name]", "Bank account check")
    type("[data-type-consent]", "account_check")
    type("[data-type-input]", "not json")
    await act(async () => void fireEvent.submit(document.querySelector("[data-service-type-form]")!))
    expect(calls).toEqual([])
    expect(document.querySelector("[data-sheet-error]")?.textContent).toContain("Input schema")
    type("[data-type-input]", '{"type":"object","required":["pan"]}')
    await act(async () => void fireEvent.submit(document.querySelector("[data-service-type-form]")!))
    expect(calls[0].url).toBe("/api/admin/vendors/service-types")
    expect(calls[0].body).toMatchObject({ service_type: { region: "US", key: "bank_account_check", category: "identity", consent_purpose: "account_check", moves_money: false, input_schema: { type: "object", required: ["pan"] } } })
  })

  it("Suspend offering", async () => {
    const { f, calls } = fetcher()
    const o = admin.adminOfferingsFrom([{ offering_id: OFF, name: "Fast KYC", vendor: "Acme Trust", region: "US", service_type: { key: "kyc_basic" }, status: "listed" }])![0]
    render(<SuspendOfferingSheet offering={o} onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-suspend-note]", "Conformance keeps failing")
    await act(async () => void fireEvent.submit(document.querySelector("[data-suspend-offering-form]")!))
    expect(calls).toEqual([{ url: `/api/admin/vendors/offerings/${OFF}`, body: { suspended: true, note: "Conformance keeps failing" } }])
  })

  it("Remove test app: Check what would go, then Remove app with a reason", async () => {
    const calls: unknown[] = []
    const replies = [{ removal: { kind: "plan", rows: [["api_keys", 2]], builds: 1, programs: 0 } }, { removal: { kind: "removed" } }]
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify(replies.shift()), { status: 200 })
    }) as unknown as typeof fetch
    const removed = vi.fn()
    render(<RemoveAppSheet app={APP_ROW} open onClose={() => undefined} onRemoved={removed} fetcher={f} />)
    await click("[data-remove-check]")
    expect(document.querySelector("[data-remove-plan]")?.textContent).toContain("api_keys")
    type("[data-remove-reason]", "Test app from the demo")
    await act(async () => void fireEvent.submit(document.querySelector("[data-remove-plan]")!))
    expect(calls).toEqual([{ confirm: false }, { confirm: true, reason: "Test app from the demo" }])
    expect(removed).toHaveBeenCalled()
    expect(document.querySelector("[data-sheet-result]")?.textContent).toContain("is removed")
  })
})
