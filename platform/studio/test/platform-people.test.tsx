// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// Platform admin → People (/platform/people): the list (its toolbar, filters and columns, statuses in words), a
// person's page (metadata card, Roles, Firms and Activity), and the Invite person, Change roles and Revoke access
// sheets posting to /api/admin/people with exactly what was picked. Mynt's admin role is a separate box, off by default.
// The route itself is in platform-people-routes.test.ts.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { PeopleListView, PersonDetailView, InvitePersonSheet, InvitePersonButton, ChangeRolesSheet, RevokeAccessSheet, emailOk } = await import("@/components/admin-people");
const { PlatformHeader, PLATFORM_SECTIONS } = await import("@/components/platform-shell");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const admin = await import("@/lib/admin");
const { PLATFORM_SEARCH_PAGES } = await import("@/lib/studio-search");
const { legacyRedirect } = await import("@/lib/redirects");
const { personIdOf, addRoles, replaceRoles, changeWords } = await import("@/lib/people");
type Person = import("@/lib/people").Person;

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

const FIRM = "33333333-3333-4333-8333-333333333333";
const LEE: Person = { id: personIdOf("lee@example.com", null), email: "lee@example.com", name: "Lee", roles: ["license_provider"], status: "signed_in", invitedAt: "2026-10-01T00:00:00.000Z", joinedAt: "2026-10-02T00:00:00.000Z", userId: "66666666-6666-4666-8666-666666666666", firms: [{ id: FIRM, name: "Acme Trust" }] }
const NEW: Person = { id: personIdOf("new@example.com", null), email: "new@example.com", name: null, roles: ["developer"], status: "invited", invitedAt: "2026-11-01T00:00:00.000Z", joinedAt: null, userId: null, firms: [] }
const BOSS: Person = { id: personIdOf("boss@example.com", null), email: "boss@example.com", name: "Boss", roles: ["admin"], status: "signed_in", invitedAt: null, joinedAt: "2026-09-01T00:00:00.000Z", userId: "88888888-8888-4888-8888-888888888888", firms: [] }
const DATA = { people: [LEE, NEW, BOSS], firms: [{ id: FIRM, name: "Acme Trust" }], publicSignup: false }

const fetcher = () => {
  const calls: { url: string; body: unknown }[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ ok: true, message: "Done by Mynt." }), { status: 200, headers: { "content-type": "application/json" } })
  })
  return { f: f as unknown as typeof fetch, calls }
}
const type = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } })
const submit = (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!))

describe("where People lives", () => {
  it("a section between Workspaces and Apps, at /platform/people and /platform/people/<id>, titled People", () => {
    expect(PLATFORM_SECTIONS.map((s) => s.tab).slice(0, 3)).toEqual(["overview", "workspaces", "people"])
    expect(admin.adminHref("people")).toBe("/platform/people")
    expect(admin.platformRouteOf(`/platform/people/${LEE.id}`)).toEqual({ tab: "people", id: LEE.id })
    expect(admin.platformRouteOf("/platform/people/66666666-6666-4666-8666-666666666666")?.id).toBe("66666666-6666-4666-8666-666666666666")
    for (const bad of ["/platform/people/lee@example.com", "/platform/people/eZZ", "/platform/people/x/y"]) expect(admin.platformRouteOf(bad), bad).toBeNull()
    expect(admin.platformTitle("/platform/people")).toBe("People")
    expect(PLATFORM_SEARCH_PAGES.some((p) => p.href === "/platform/people")).toBe(true)
    expect(legacyRedirect("/admin", new URLSearchParams(`tab=people&id=${LEE.id}`))).toBe(`/platform/people/${LEE.id}`)
  })

  it("the Overview's header has Invite person as a labelled button; other sections' headers don't", () => {
    const html = (actions: React.ReactNode) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <SidebarProvider>
            <PlatformHeader title="Mynt platform admin" actions={actions} />
          </SidebarProvider>
        </TooltipProvider>,
      )
    const withIt = html(<InvitePersonButton />)
    expect(withIt).toContain("data-header-invite-person")
    expect(withIt).toContain("Invite person")
    expect(html(null)).not.toContain("data-header-invite-person")
  })
})

describe("the list", () => {
  it("one toolbar row (search, Filters, labelled Import disabled with its reason, Export CSV, Invite person) over the table", () => {
    render(<PeopleListView data={DATA} onOpen={() => undefined} />)
    const toolbar = document.querySelector("[data-toolbar]")!
    expect(toolbar.querySelector("input")?.getAttribute("aria-label")).toBe("Search people by name, email or firm")
    expect(toolbar.textContent).toContain("Filters")
    const imp = toolbar.querySelector("[data-import]") as HTMLButtonElement
    expect(imp.disabled).toBe(true)
    expect(imp.textContent).toContain("Import")
    expect(imp.getAttribute("title")).toBeTruthy()
    expect(toolbar.querySelector("[data-export]")?.textContent).toContain("Export CSV")
    expect(toolbar.querySelector("[data-invite-person]")?.textContent).toContain("Invite person")
    const head = [...document.querySelectorAll("thead th")].map((th) => th.textContent)
    expect(head.slice(0, 6)).toEqual(["Name", "Email", "Roles", "Firm(s)", "Status", "Invited or joined"])
  })

  it("statuses and dates in words; a firm where known", () => {
    render(<PeopleListView data={DATA} onOpen={() => undefined} />)
    const row = (id: string) => document.querySelector(`[data-row="${id}"]`)!.textContent
    expect(row(LEE.id)).toContain("Signed in")
    expect(row(LEE.id)).toContain("Acme Trust")
    expect(row(LEE.id)).toContain("Joined 2026-10-02")
    expect(row(LEE.id)).toContain("Licence provider")
    expect(row(NEW.id)).toContain("Invited")
    expect(row(NEW.id)).toContain("Invited 2026-11-01")
    expect(row(NEW.id)).toContain("Innovator")
    expect(document.querySelector("[data-list-note]")?.textContent).toContain("invite-only")
    cleanup()
    render(<PeopleListView data={{ ...DATA, firms: null, people: [NEW] }} onOpen={() => undefined} />)
    expect(document.querySelector(`[data-row="${NEW.id}"]`)!.textContent).toContain("Not known") // no list_entities: never "None"
  })

  it("search and a row click open the person", () => {
    const onOpen = vi.fn()
    render(<PeopleListView data={DATA} onOpen={onOpen} />)
    type("[data-toolbar] input", "acme")
    expect(document.querySelectorAll("tbody [data-row]").length).toBe(1)
    fireEvent.click(document.querySelector(`[data-row="${LEE.id}"]`)!)
    expect(onOpen).toHaveBeenCalledWith(LEE.id)
  })
})

describe("filters", () => {
  it("role and status, as the list's own facets", async () => {
    render(<PeopleListView data={DATA} onOpen={() => undefined} />)
    await act(async () => void fireEvent.click([...document.querySelectorAll("[data-toolbar] button")].find((b) => b.textContent?.includes("Filters"))!))
    const chip = (label: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label)!
    await act(async () => void fireEvent.click(chip("Invited, not yet signed in")))
    expect([...document.querySelectorAll("tbody [data-row]")].map((r) => r.getAttribute("data-row"))).toEqual([NEW.id])
    await act(async () => void fireEvent.click(chip("Invited, not yet signed in")))
    await act(async () => void fireEvent.click(chip("Mynt admin")))
    expect([...document.querySelectorAll("tbody [data-row]")].map((r) => r.getAttribute("data-row"))).toEqual([BOSS.id])
  })
})

describe("Invite person", () => {
  it("Make Mynt admin is a separate box, off by default, with its warning; the sign-in preview shows", () => {
    render(<InvitePersonSheet open data={DATA} onClose={() => undefined} onDone={() => undefined} />)
    expect([...document.querySelectorAll("[data-person-roles] [data-role]")].map((c) => c.getAttribute("data-role"))).not.toContain("admin")
    expect((document.querySelector("[data-make-admin]") as HTMLInputElement).checked).toBe(false)
    expect(document.querySelector("[data-admin-warning]")?.textContent).toContain("Mynt admin can change every workspace")
    expect(document.querySelector("[data-invite-preview]")?.textContent).toContain("They can sign in with this email straight away.")
  })

  it("an email that isn't one is refused before anything is sent", async () => {
    const { f, calls } = fetcher()
    render(<InvitePersonSheet open data={DATA} onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-person-email]", "not-an-email")
    await submit("[data-invite-person-form]")
    expect(calls).toEqual([])
    expect(document.querySelector("[data-email-invalid]")).not.toBeNull()
    expect(emailOk("a@example.com")).toBe(true)
  })

  it("posts the roles picked, the admin box and the firm; an existing person's roles are shown merged", async () => {
    const { f, calls } = fetcher()
    const onDone = vi.fn()
    render(<InvitePersonSheet open data={DATA} onClose={() => undefined} onDone={onDone} fetcher={f} />)
    type("[data-person-email]", "Lee@Example.com")
    fireEvent.click(document.querySelector('[data-role="vendor"]')!)
    expect(document.querySelector("[data-merge-preview]")?.textContent).toContain("Already has: Licence provider; adding: Innovator, Vendor.")
    type("[data-person-firm]", FIRM)
    await submit("[data-invite-person-form]")
    expect(calls).toEqual([{ url: "/api/admin/people", body: { action: "invite", email: "lee@example.com", roles: ["developer", "vendor"], make_admin: false, firm_id: FIRM } }])
    expect(onDone).toHaveBeenCalled()
    expect(document.querySelector("[data-sheet-result]")?.textContent).toBe("Done by Mynt.")
  })

  it("Mynt's refusal is shown in its words", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "mynt_refused", message: "That would remove the last admin; make someone else an admin first" }), { status: 422 })) as unknown as typeof fetch
    render(<InvitePersonSheet open data={DATA} onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    type("[data-person-email]", "x@example.com")
    await submit("[data-invite-person-form]")
    expect(document.querySelector("[data-sheet-error]")?.textContent).toBe("That would remove the last admin; make someone else an admin first")
  })
})

describe("a person's page", () => {
  it("metadata card, labelled Change roles and Revoke access, and Roles, Firms, Activity tabs", async () => {
    render(<PersonDetailView detail={{ person: LEE, firms: DATA.firms, activity: [{ id: "a1", action: "invite_user", target: "lee@example.com", actor: "boss@example.com", createdAt: "2026-10-01T00:00:00.000Z" }] }} onBack={() => undefined} />)
    const card = document.querySelector("[data-metadata-card]")!.textContent
    for (const s of ["Lee", "Signed in", "Licence provider", "Acme Trust", "2026-10-02"]) expect(card).toContain(s)
    expect(document.querySelector("[data-change-roles]")?.textContent).toContain("Change roles")
    expect(document.querySelector("[data-revoke-access]")?.textContent).toContain("Revoke access")
    expect([...document.querySelectorAll("[data-detail-tab]")].map((t) => t.textContent)).toEqual(["Roles", "Firms", "Activity"])
    await act(async () => void fireEvent.click(document.querySelector('[data-detail-tab="activity"]')!))
    expect(document.querySelector("[data-person-activity]")?.textContent).toContain("Invite user")
  })

  it("no audit log on this Mynt: no Activity tab", () => {
    render(<PersonDetailView detail={{ person: NEW, firms: DATA.firms, activity: null }} onBack={() => undefined} />)
    expect([...document.querySelectorAll("[data-detail-tab]")].map((t) => t.textContent)).toEqual(["Roles", "Firms"])
  })
})

describe("Change roles and Revoke access", () => {
  it("adding by default; replacing is chosen explicitly and says what goes, warning when Mynt admin goes", async () => {
    const { f, calls } = fetcher()
    render(<ChangeRolesSheet person={BOSS} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    expect((document.querySelector('[data-mode="add"]') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(document.querySelector('[data-mode="replace"]')!)
    expect((document.querySelector("[data-make-admin]") as HTMLInputElement).checked).toBe(true) // what they have
    fireEvent.click(document.querySelector("[data-make-admin]")!)
    fireEvent.click(document.querySelector('[data-role="vendor"]')!)
    expect(document.querySelector("[data-roles-preview]")?.textContent).toBe("Already has: Mynt admin; adding: Vendor; removing: Mynt admin.")
    expect(document.querySelector("[data-drops-admin]")).not.toBeNull()
    await submit("[data-change-roles-form]")
    expect(calls).toEqual([{ url: "/api/admin/people", body: { action: "set_roles", email: "boss@example.com", roles: ["vendor"], make_admin: false, mode: "replace" } }])
  })

  it("Revoke access: only once their email is typed, then revoke", async () => {
    const { f, calls } = fetcher()
    render(<RevokeAccessSheet person={LEE} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />)
    expect(document.querySelector("[data-revoke-reason]")?.textContent).toContain("What they created stays")
    expect((document.querySelector("[data-revoke-submit]") as HTMLButtonElement).disabled).toBe(true)
    type("[data-revoke-confirm]", "lee@example.com")
    await submit("[data-revoke-form]")
    expect(calls).toEqual([{ url: "/api/admin/people", body: { action: "revoke", email: "lee@example.com", confirm_email: "lee@example.com" } }])
  })

  it("merging never drops a role; developer and innovator are one", () => {
    expect(addRoles(["license_provider", "admin"], ["vendor"]).roles).toEqual(["license_provider", "admin", "vendor"])
    expect(addRoles(["innovator"], ["developer"]).adding).toEqual([])
    expect(replaceRoles(["innovator", "vendor"], ["developer"]).removing).toEqual(["vendor"])
    expect(changeWords(addRoles([], ["vendor"]))).toBe("Adding: Vendor.")
  })
})
