// @vitest-environment jsdom
// Where services show outside their own workspace: the sidebar's stage folders (their own icon, "Service: <name>" to
// screen readers, /services/<id>, never as an app), search's Services group, My services (rows built on Mynt say so
// and open the service's workspace; the requester's Requested service types), and the platform admin's Vendors →
// Requested service types tab (the table, a request's details, Define from request, Decline).
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/services/svc-1",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { SidebarView, stagedItems } = await import("@/components/app-sidebar");
const { Sidebar, SidebarContent, SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { NavFolders, initialFolder } = await import("@/components/nav-folders");
const { VendorView } = await import("@/components/vendor-area");
const { VendorsView, RequestedTypes, typeFormFromRequest } = await import("@/components/admin-vendors");
const { searchActions } = await import("@/components/kbar/actions");
const { isAppPath, isServicePath, pageTitle, searchIndex, searchStudio, SEARCH_GROUPS } = await import("@/lib/studio-search");
const v = await import("@/lib/vendor-area");
const s = await import("@/lib/services");
const { groupByStage } = await import("@/lib/workspaces");
type StagedApp = import("@/lib/workspaces").StagedApp;

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
let posted: { url: string; body: unknown }[];
beforeEach(() => {
  posted = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") posted.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ ok: true, message: "Done." }), { status: 200 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});
const settle = async (ms = 20) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const ITEMS: StagedApp[] = [
  { id: "app-1", name: "Budgeting", stage: "staging", conversationId: "b1" },
  { id: "svc-1", name: "Swift ID", stage: "staging", kind: "service" },
  { id: "svc-2", name: "Ledger Check", stage: "production", kind: "service" },
];
const groups = groupByStage(ITEMS);
const withSidebar = (ui: React.ReactNode) => (
  <TooltipProvider>
    <SidebarProvider>
      <Sidebar collapsible="icon" variant="inset">
        <SidebarContent>{ui}</SidebarContent>
      </Sidebar>
    </SidebarProvider>
  </TooltipProvider>
);

describe("the sidebar's stage folders", () => {
  it("list services with their own icon and a screen-reader label, linking to /services/<id>", () => {
    const { container } = render(withSidebar(<NavFolders groups={groups} activeServiceId="svc-1" />));
    const item = container.querySelector('[data-thread-item="service:svc-1"]')!;
    expect(item.getAttribute("href")).toBe("/services/svc-1");
    expect(item.getAttribute("aria-label")).toBe("Service: Swift ID");
    expect(item.getAttribute("data-kind")).toBe("service");
    expect(item.querySelector('[data-thread-icon="service"]')).not.toBeNull();
    expect(item.textContent).toBe("Swift ID");
    // The app beside it keeps its own icon, label and address.
    const app = container.querySelector('[data-thread-item="app:app-1"]')!;
    expect(app.getAttribute("href")).toBe("/app-1/b1");
    expect(app.getAttribute("aria-label")).toBe("App: Budgeting");
    expect(app.querySelector('[data-thread-icon="app"]')).not.toBeNull();
    // A service is never listed as an app, and never opens the app workspace.
    expect(container.querySelector('[data-thread-item="app:svc-1"]')).toBeNull();
    expect(container.querySelector('a[href="/svc-1"]')).toBeNull();
  });

  it("open on the stage of the service on screen", () => {
    expect(initialFolder(groups, undefined, null, undefined, "svc-1")).toBe("staging");
    expect(initialFolder(groups, undefined, null, undefined, "svc-2")).toBe("production");
    // A service's id is not an app's: an app workspace address never marks it.
    expect(initialFolder(groups, "svc-1", "idea")).toBe("idea");
    const { container } = render(withSidebar(<NavFolders groups={groups} activeServiceId="svc-1" />));
    expect([...container.querySelectorAll("[data-active-folder=true]")].map((e) => e.getAttribute("data-folder"))).toEqual(["staging"]);
    expect(container.querySelector('[data-thread-item="service:svc-1"]')!.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-thread-item="app:app-1"]')!.getAttribute("data-active")).not.toBe("true");
  });

  it("keep services beside the apps and the user's products", () => {
    const all = stagedItems(groups, [{ id: "green-savings", name: "Green Savings", status: "draft", stage: "idea", updatedAt: null }])!;
    expect(all.staging.map((i) => `${i.kind}:${i.id}`)).toEqual(["app:app-1", "service:svc-1"]);
    expect(all.production.map((i) => `${i.kind}:${i.id}`)).toEqual(["service:svc-2"]);
    expect(all.idea.map((i) => `${i.kind}:${i.id}`)).toEqual(["product:green-savings"]);
  });

  it("the whole sidebar marks the service on screen, from its address", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SidebarProvider>
          <SidebarView workspaces={[]} selected={{ id: "personal", name: "Personal", personal: true, implicit: true, role: "owner" } as never} supported={false} groups={groups} account={{ name: "Vera", email: null }} pathname="/services/svc-1" onSelectWorkspace={() => undefined} onCreateWorkspace={async () => null} vendor />
        </SidebarProvider>
      </TooltipProvider>,
    );
    expect(html).toContain('href="/services/svc-1"');
    expect(html).toContain('aria-label="Service: Swift ID"');
    expect(html).toContain("My services");
  });
});

describe("a service's address", () => {
  it("is its own: never an app's, and its header names it", () => {
    expect(isServicePath("/services/svc-1")).toBe(true);
    expect(isServicePath("/services/svc-1/build-1")).toBe(true);
    expect(isServicePath("/services")).toBe(false);
    expect(isAppPath("/services/svc-1")).toBe(false);
    expect(isAppPath("/app-1")).toBe(true);
    expect(pageTitle("/services/svc-1")).toBeNull();
  });
});

describe("search", () => {
  const sources = { apps: [{ id: "app-1", name: "Budgeting", stage: "staging" as const }], services: [{ id: "svc-1", name: "Swift ID", stage: "staging" as const, typeName: "Identity verification" }] };
  it("has a Services group, after Financial products", () => {
    expect(SEARCH_GROUPS).toEqual(["Pages", "Apps", "Financial products", "Services", "Members", "Audit actions"]);
    const found = searchStudio(searchIndex(sources), "swift");
    expect(found.map((i) => [i.group, i.label, i.href, i.hint])).toEqual([["Services", "Swift ID", "/services/svc-1", "Staging"]]);
    // Found as a service, by what it is and by its type; never among the apps.
    expect(searchStudio(searchIndex(sources), "identity").filter((i) => i.group !== "Pages").map((i) => i.id)).toEqual(["service:svc-1"]);
    expect(searchIndex(sources).filter((i) => i.group === "Apps").every((i) => !i.href.includes("svc-1"))).toBe(true);
    expect(searchIndex(sources).some((i) => i.href === "/svc-1")).toBe(false);
  });

  it("finds a service's tabs by what they hold, and lists services when nothing is typed", () => {
    const items = searchIndex(sources);
    expect(searchStudio(items, "swift conformance").map((i) => [i.label, i.href])).toEqual([["Swift ID: Conformance", "/services/svc-1?tab=conformance"]]);
    expect(searchStudio(items, "").filter((i) => i.group === "Services").map((i) => i.id)).toEqual(["service:svc-1"]);
    const actions = searchActions("studio", items);
    expect(actions.find((a) => a.id === "service:svc-1")).toMatchObject({ name: "Swift ID", section: { name: "Services" }, href: "/services/svc-1" });
    expect(actions.find((a) => a.id === "servicetab:svc-1:contract")).toMatchObject({ name: "Contract", parent: "service:svc-1" });
  });
});

const FIRM = "33333333-3333-4333-8333-333333333333";
const OFF_OWN = "55555555-5555-4555-8555-555555555555";
const OFF_BUILT = "66666666-6666-4666-8666-666666666666";
const REQ = "88888888-8888-4888-8888-888888888888";
const REQUESTS = s.typeRequestsFrom([
  { id: REQ, name: "Proof of address", region: "US", what_it_does: "Checks a customer's address against a utility bill.", example_input: { line1: "1 Main St", floor: 3, flat: null }, example_output: { verified: true, score: 0.91, matches: ["line1"] }, status: "requested", status_words: "Waiting for Mynt", decision_note: null, service_type_key: null, requested_by: { id: "u1", name: "Vera" }, firm: { id: FIRM, name: "KYC Works" }, requested_at: "2026-11-20T10:00:00Z", decided_at: null },
  { id: "99999999-9999-4999-8999-999999999999", name: "Sanctions screen", region: "US", what_it_does: "Screens a name.", example_input: {}, example_output: {}, status: "declined", status_words: "Declined", decision_note: "Covered by an existing type", service_type_key: null, requested_by: { id: "u2", name: null }, firm: null, requested_at: "2026-11-18T10:00:00Z", decided_at: "2026-11-19T10:00:00Z" },
]);

describe("My services", () => {
  const offering = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, region: "US", service_type: "identity_verification", status: "draft", test_base_url: "https://test.example.com", price: { amount: 1, currency: "USD" }, licence_ids: [], ...extra });
  const data = {
    onboarding: v.fromOnboarding({ entity: { id: FIRM, name: "KYC Works", status: "active" }, firm_steps: [], offerings: [], progress: { done: 0, total: 0, next: null, complete: false } })!,
    offerings: v.fromMyOfferings([offering(OFF_OWN, "KYC Works ID"), offering(OFF_BUILT, "Swift ID", { service: { id: "svc-1", name: "Swift ID" } })]),
    serviceTypes: [],
    licences: [],
    requests: REQUESTS,
  };

  it("lists services built on Mynt beside externally hosted ones: the built ones say so and open their workspace", () => {
    expect(data.offerings.map((o) => o.service ?? null)).toEqual([null, { id: "svc-1", name: "Swift ID" }]);
    const opened: string[] = [];
    const { container } = render(<VendorView data={data} onOpen={(id) => void opened.push(id)} />);
    const built = container.querySelector(`[data-built-on-mynt="${OFF_BUILT}"]`)!;
    expect(built.textContent).toBe("Swift IDBuilt on Mynt");
    expect(built.querySelector("a")!.getAttribute("href")).toBe("/services/svc-1");
    // The externally hosted one opens its details here, as before.
    expect(container.querySelector(`[data-built-on-mynt="${OFF_OWN}"]`)).toBeNull();
    fireEvent.click(container.querySelector(`[data-open-service="${OFF_OWN}"]`)!);
    expect(opened).toEqual([OFF_OWN]);
    expect(container.querySelector(`[data-open-service="${OFF_BUILT}"]`)).toBeNull();
  });

  it("shows the requester where their requested service types stand", () => {
    const { container } = render(<VendorView data={data} onOpen={() => undefined} />);
    const section = container.querySelector("[data-requested-types]") as HTMLElement;
    expect(within(section).getByRole("heading", { name: "Requested service types" })).toBeTruthy();
    expect([...section.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["Requested", "Name", "Region", "Status", "Mynt's answer"]);
    expect([...section.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([
      ["2026-11-20", "Proof of address", "US", "Waiting for Mynt", "Not answered yet"],
      ["2026-11-18", "Sanctions screen", "US", "Declined", "Covered by an existing type"],
    ]);
    expect(section.querySelector("[data-request-service-type]")!.textContent).toBe("Request a service type");
    // A Mynt without requests has no such table.
    cleanup();
    const { requests: _none, ...older } = data;
    expect(render(<VendorView data={older} onOpen={() => undefined} />).container.querySelector("[data-requested-types]")).toBeNull();
  });
});

describe("Platform admin → Vendors → Requested service types", () => {
  const data = { serviceTypes: [], offerings: [], firms: [], requests: REQUESTS };

  it("is a tab with the requests as a table", () => {
    const html = renderToStaticMarkup(<VendorsView data={data} />);
    expect(html).toContain('data-vendors-view="requests"');
    expect(html).toContain("Requested service types");
    const { container } = render(<VendorsView data={data} initialView="requests" />);
    expect([...container.querySelectorAll("thead th")].map((h) => h.textContent)).toEqual(["Requested", "Name", "Region", "Firm", "Requested by", "Status"]);
    expect([...container.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([
      ["2026-11-20", "Proof of address", "US", "KYC Works", "Vera", "Waiting for Mynt"],
      ["2026-11-18", "Sanctions screen", "US", "No firm", "Not known", "Declined"],
    ]);
    // On a Mynt without requests the tab says so.
    cleanup();
    expect(renderToStaticMarkup(<VendorsView data={{ serviceTypes: [], offerings: [], firms: [] }} initialView="requests" />)).toContain('data-empty="not-available"');
  });

  it("a row opens the request: what it does, its examples, and its two labelled actions", async () => {
    render(<RequestedTypes requests={REQUESTS} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-open-type-request="${REQ}"]`)!));
    const sheet = document.querySelector('[data-admin-sheet="type-request"]') as HTMLElement;
    expect(sheet.querySelector("[data-request-what]")!.textContent).toBe("Checks a customer's address against a utility bill.");
    expect(sheet.querySelector('[data-request-example="input"]')!.textContent).toContain('"line1": "1 Main St"');
    expect(sheet.querySelector('[data-request-example="output"]')!.textContent).toContain('"verified": true');
    expect([...sheet.querySelectorAll("[data-request-actions] button")].map((b) => b.textContent)).toEqual(["Define from request", "Decline"]);
  });

  it("an answered request has no actions", async () => {
    render(<RequestedTypes requests={REQUESTS} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-open-type-request="99999999-9999-4999-8999-999999999999"]')!));
    const sheet = document.querySelector('[data-admin-sheet="type-request"]') as HTMLElement;
    expect(sheet.textContent).toContain("Covered by an existing type");
    expect(sheet.querySelector("[data-request-actions]")).toBeNull();
  });

  it("Define from request opens Add service type filled from the request, schemas inferred from its examples, and sends from_request", async () => {
    const form = typeFormFromRequest(REQUESTS[0]);
    expect(form).toMatchObject({ region: "US", key: "proof_of_address", name: "Proof of address", description: "Checks a customer's address against a utility bill.", consent: "" });
    expect(JSON.parse(form.input)).toEqual({ type: "object", properties: { line1: { type: "string" }, floor: { type: "integer" }, flat: { type: "null" } }, required: ["line1", "floor", "flat"] });
    expect(JSON.parse(form.output)).toEqual({ type: "object", properties: { verified: { type: "boolean" }, score: { type: "number" }, matches: { type: "array" } }, required: ["verified", "score", "matches"] });

    render(<RequestedTypes requests={REQUESTS} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-open-type-request="${REQ}"]`)!));
    await act(async () => void fireEvent.click(document.querySelector("[data-define-from-request]")!));
    const sheet = document.querySelector('[data-admin-sheet="add-service-type"]') as HTMLElement;
    expect(sheet.textContent).toContain("Define from request");
    expect((sheet.querySelector("[data-type-name]") as HTMLInputElement).value).toBe("Proof of address");
    expect((sheet.querySelector("[data-type-key]") as HTMLInputElement).value).toBe("proof_of_address");
    expect((sheet.querySelector("[data-type-region]") as HTMLInputElement).value).toBe("US");
    expect(JSON.parse((sheet.querySelector("[data-type-input]") as HTMLTextAreaElement).value).properties.line1).toEqual({ type: "string" });
    // The admin edits before adding: the consent is theirs to name.
    expect((sheet.querySelector("[data-add-service-type-submit]") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(sheet.querySelector("[data-type-consent]")!, { target: { value: "address_check" } });
    await act(async () => void fireEvent.submit(sheet.querySelector("[data-service-type-form]")!));
    await settle();
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/admin/vendors/service-types");
    expect(posted[0].body).toMatchObject({ from_request: REQ, service_type: { region: "US", key: "proof_of_address", name: "Proof of address", category: "other", consent_purpose: "address_check", description: "Checks a customer's address against a utility bill." } });
    expect((posted[0].body as { service_type: { output_schema: unknown } }).service_type.output_schema).toEqual(JSON.parse(form.output));
  });

  it("Decline needs a reason, then posts it", async () => {
    render(<RequestedTypes requests={REQUESTS} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-open-type-request="${REQ}"]`)!));
    await act(async () => void fireEvent.click(document.querySelector("[data-decline-request]")!));
    const sheet = document.querySelector('[data-admin-sheet="decline-type-request"]') as HTMLElement;
    const submit = sheet.querySelector("[data-decline-request-submit]") as HTMLButtonElement;
    expect(submit.textContent).toBe("Decline request");
    expect(submit.disabled).toBe(true);
    fireEvent.change(sheet.querySelector("[data-decline-reason]")!, { target: { value: "Covered by identity verification" } });
    expect(submit.disabled).toBe(false);
    await act(async () => void fireEvent.submit(sheet.querySelector("[data-decline-request-form]")!));
    await settle();
    expect(posted).toEqual([{ url: `/api/admin/vendors/requests/${REQ}`, body: { reason: "Covered by identity verification" } }]);
  });

  it("an Add service type opened on its own names no request", () => {
    expect(s.keyFromName("  KYC: Level 2! ")).toBe("kyc_level_2");
    expect(s.keyFromName("3D check")).toBe("s_3d_check");
    expect(s.schemaFromExample({})).toEqual({ type: "object", properties: {}, required: [] });
  });
});
