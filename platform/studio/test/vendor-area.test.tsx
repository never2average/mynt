// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// My services (/vendor), a service provider's own area: the sidebar's My services entry (only for the vendor role),
// the onboarding checklist (each step's status in words, a labelled button where the studio can do it, what waits on
// Mynt), the services table and a service's details (a metadata card, then tabs, each a table), and each sheet posting
// to its route with exactly what was typed, the standard terms' SHA-256 computed in the browser.

vi.mock("next/navigation", () => ({
  usePathname: () => "/vendor",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { SidebarView } = await import("@/components/app-sidebar");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { pageGateFor } = await import("@/components/studio-gates");
const { pageTitle, isAppPath } = await import("@/lib/studio-search");
const { VendorView, OfferingDetailView, OnboardingChecklist } = await import("@/components/vendor-area");
const { ServiceSheet, TermsSheet, ConformanceSheet, ListingSheet } = await import("@/components/vendor-sheets");
const v = await import("@/lib/vendor-area");
const { groupByStage } = await import("@/lib/workspaces");
const { NO_ACCESS } = await import("@/lib/liquidity");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const FIRM = "33333333-3333-4333-8333-333333333333";
const OFF = "55555555-5555-4555-8555-555555555555";
const LIC = "44444444-4444-4444-8444-444444444444";

const step = (key: string, status: string, extra: Record<string, unknown> = {}) => ({ key, title: key, status, detail: `${key} in words.`, tool: null, by: "vendor", informational: false, facts: {}, ...extra });
const ONBOARDING = v.fromOnboarding({
  entity: { id: FIRM, name: "KYC Works", status: "active" },
  firm_steps: [step("firm_registered", "done", { title: "Your firm is registered with Mynt", by: "admin" }), step("vendor_members", "done", { by: "admin" }), step("first_service", "done", { tool: "create_vendor_offering" })],
  offerings: [
    {
      offering_id: OFF,
      name: "KYC Works CKYC",
      region: "US",
      service_type: "identity_verification",
      service_name: "Identity verification",
      status: "draft",
      steps: [
        step("service_created", "done"),
        step("licence", "blocked", { title: "Licence verified by Mynt", by: "admin", tool: "review_license", detail: "Waiting for Mynt to verify your licence us_mtl (MT-1)." }),
        step("conformance", "blocked", { title: "Pass Mynt's conformance test", tool: "run_conformance", detail: "Waits for Mynt to verify your licence first." }),
        step("terms", "next", { title: "Set your standard terms", tool: "update_vendor_offering", detail: "No standard terms yet." }),
        step("listed", "not_started", { title: "List the service", tool: "update_vendor_offering" }),
        step("first_subscriber", "not_started", { title: "First subscriber", by: "subscriber", informational: true }),
      ],
      progress: { done: 1, total: 5, next: { key: "terms", title: "Set your standard terms", status: "next", offering_id: OFF }, complete: false },
    },
  ],
  progress: { done: 4, total: 8, next: { key: "terms", title: "Set your standard terms", status: "next", offering_id: OFF }, complete: false },
})!;
const OFFERING = v.fromMyOfferings([
  {
    id: OFF,
    name: "KYC Works CKYC",
    region: "US",
    service_type: "identity_verification",
    status: "conformance_passed",
    test_base_url: "https://test.example.com",
    live_base_url: null,
    price: { amount: 0.4, currency: "USD", per: "call" },
    sla_notes: "",
    licence_ids: [LIC],
    requires_credential: true,
    terms: { version: 2, document_url: "https://example.com/terms.pdf", document_sha256: "a".repeat(64), summary: "Our standard terms.", pricing_summary: "$0.40 per check" },
    last_conformance: { passed: true, at: "2026-11-20T10:00:00Z" },
    subscribers: 3,
  },
])[0]!;
const DATA = {
  onboarding: ONBOARDING,
  offerings: [OFFERING],
  serviceTypes: v.serviceTypeOptions([{ region: "US", key: "identity_verification", name: "Identity verification", category: "identity", vendor_licences: ["us_mtl"] }]),
  licences: v.licenceOptions({ licenses: [{ id: LIC, region: "US", license_id: "us_mtl", registration_number: "MT-1", status: "verified" }] }),
};

const fetcher = (reply: Record<string, unknown> = { ok: true, message: "Done by Mynt." }) => {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
};
const type = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } });
const submit = async (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!));

const sidebar = (vendor: boolean, developer = true) =>
  renderToStaticMarkup(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarView
          workspaces={[{ id: "w1", name: "Acme", role: "owner" }]}
          selected={{ id: "w1", name: "Acme", role: "owner" }}
          supported
          groups={groupByStage([])}
          account={{ name: null, email: null }}
          pathname="/vendor"
          onSelectWorkspace={() => undefined}
          onCreateWorkspace={async () => null}
          developer={developer}
          vendor={vendor}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );

describe("the sidebar's My services", () => {
  it("is there only for accounts with the vendor role, marked current on /vendor", () => {
    expect(sidebar(true)).toMatch(/href="\/vendor"[^>]*>[\s\S]*?My services/);
    expect(sidebar(true)).toMatch(/data-active="true"[^>]*href="\/vendor"|href="\/vendor"[^>]*data-active="true"/);
    expect(sidebar(false)).not.toContain('href="/vendor"');
    expect(sidebar(false)).not.toContain("My services");
    // A service provider without the developer role: Dashboard and My services, no workspaces or apps.
    const vendorOnly = sidebar(true, false);
    expect(vendorOnly).toContain("My services");
    expect(vendorOnly).not.toContain('href="/marketplace"');
  });

  it("opens for vendors without the developer role or a workspace; it's a fixed page titled My services, never an app", () => {
    const vendorOnly = { developer: false, liquidity: NO_ACCESS, owner: null, vendor: true };
    expect(pageGateFor("/vendor", vendorOnly, false)).toBe("none");
    expect(pageGateFor("/", vendorOnly, false)).toBe("developer");
    expect(pageGateFor("/vendor", { ...vendorOnly, vendor: false }, false)).toBe("developer");
    expect(pageGateFor("/vendor", { ...vendorOnly, developer: true }, true)).toBe("none");
    expect(pageTitle("/vendor")).toBe("My services");
    expect(isAppPath("/vendor")).toBe(false);
  });
});

describe("the onboarding checklist", () => {
  it("shows each step's status in words with a mark, never colour alone", () => {
    const html = renderToStaticMarkup(<OnboardingChecklist onboarding={ONBOARDING} />);
    expect(html).toContain("Getting your services listed");
    expect(html).toContain("4 of 8 steps done · Next: Set your standard terms");
    for (const s of ["done", "next", "not_started", "blocked"]) expect(html).toContain(`data-step-status="${s}"`);
    for (const w of ["Done", "Do this next", "Not started", "Waiting"]) expect(html).toContain(`</svg>${w}</span>`);
    expect(html).toContain("Waiting for Mynt to verify your licence us_mtl (MT-1).");
    expect(html).toContain("(for information)");
  });

  it("offers a labelled action where the studio can do the step; none where it waits on Mynt or is done", () => {
    const html = renderToStaticMarkup(<OnboardingChecklist onboarding={ONBOARDING} onAction={() => undefined} />);
    expect(html).toMatch(/data-step="terms"[\s\S]*?data-step-action="terms"[\s\S]*?Set standard terms/);
    expect(html).not.toMatch(/data-step="licence"[^]*?data-step-action[^]*?data-step="conformance"/);
    expect(html.match(/data-step-action=/g)).toHaveLength(1);
    const s = (key: string, status: string, extra = {}) => v.fromOnboarding({ firm_steps: [step(key, status, extra)] })!.firmSteps[0]!;
    expect(v.stepAction(s("first_service", "next"))).toBe("create");
    expect(v.stepAction(s("conformance", "next"))).toBe("conformance");
    expect(v.stepAction(s("conformance", "not_started"))).toBe("conformance");
    expect(v.stepAction(s("conformance", "blocked"))).toBeNull();
    expect(v.stepAction(s("listed", "next"))).toBe("list");
    expect(v.stepAction(s("listed", "not_started"))).toBeNull();
    expect(v.stepAction(s("licence", "next", { tool: "update_vendor_offering" }))).toBe("edit");
    expect(v.stepAction(s("licence", "next", { tool: "register_license" }))).toBeNull();
    expect(v.stepAction(s("terms", "done"))).toBeNull();
    expect(v.stepAction(s("vendor_members", "blocked", { by: "admin" }))).toBeNull();
    expect(Object.values(v.STEP_ACTION_LABELS)).toEqual(["Create service", "Edit service", "Set standard terms", "Run conformance", "List service"]);
  });

  it("a step's button opens its sheet", async () => {
    render(<VendorView data={DATA} onOpen={() => undefined} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-step-action="terms"]')!));
    expect(document.querySelector('[data-admin-sheet="set-terms"]')).not.toBeNull();
  });
});

describe("the services list and a service's details", () => {
  it("lists the firm's services in the list layout: search, labelled Import and Export CSV, Create service, then the table", () => {
    const html = renderToStaticMarkup(<VendorView data={DATA} onOpen={() => undefined} />);
    expect(html).toMatch(/data-toolbar[\s\S]*?Search your services[\s\S]*?Import[\s\S]*?Export CSV[\s\S]*?Create service/);
    for (const h of ["Service", "Type", "Regions", "Conformance", "Terms version", "Listed", "Subscribers"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain("Passed 2026-11-20");
    expect(html).toContain(">v2<");
    expect(html).toContain(">Not listed<");
    expect(v.offeringsCsv([OFFERING]).split("\n")[1]).toBe("KYC Works CKYC,identity_verification,US,\"Passed, not listed\",Passed 2026-11-20,v2,No,3");
  });

  it("a service's details: the metadata card with its labelled actions, then Conformance runs, Terms versions and Subscribers, each a table", () => {
    const detail = {
      offering: OFFERING,
      runs: [{ runId: "r1", passed: false, at: "2026-11-19T09:00:00Z", runBy: "Vera", failures: [{ case: "fixture_1", problems: ["output /status must be string"] }] }],
      termsVersions: [
        { version: 2, current: true, documentUrl: "https://example.com/terms.pdf", documentSha256: "a".repeat(64), summary: "Ours.", pricing: "$0.40 per check", setAt: "2026-11-21T00:00:00Z", setBy: "Vera", agreements: 1 },
        { version: 1, current: false, documentUrl: null, documentSha256: "b".repeat(64), summary: null, pricing: null, setAt: null, setBy: null, agreements: 0 },
      ],
      subscribers: [{ subscriptionId: "s1", subscriber: "Ines Bank", status: "active", live: false, since: "2026-11-22T00:00:00Z", termsVersions: [1, 2], calls: null }],
    };
    const runs = renderToStaticMarkup(<OfferingDetailView detail={detail} data={DATA} onBack={() => undefined} />);
    expect(runs).toContain("data-metadata-card");
    for (const a of ["Edit service", "Set standard terms", "Run conformance", "List service"]) expect(runs).toContain(a);
    for (const t of ["Conformance runs", "Terms versions", "Subscribers"]) expect(runs).toContain(t);
    expect(runs).toContain("Didn&#x27;t pass");
    expect(runs).toContain("fixture 1: output /status must be string");
    const terms = renderToStaticMarkup(<OfferingDetailView detail={detail} data={DATA} onBack={() => undefined} initialTab="terms" />);
    expect(terms).toContain(">v1<");
    expect(terms).toContain("Not kept"); // an earlier version's summary Mynt doesn't have: said so, never made up
    const subs = renderToStaticMarkup(<OfferingDetailView detail={detail} data={DATA} onBack={() => undefined} initialTab="subscribers" />);
    expect(subs).toContain("Ines Bank");
    expect(subs).toContain("v1, v2");
    expect(subs).toContain("Not known"); // calls Mynt didn't give: never 0
    expect(renderToStaticMarkup(<OfferingDetailView detail={{ ...detail, subscribers: null }} data={DATA} onBack={() => undefined} initialTab="subscribers" />)).toContain("data-subscribers-unknown");
    // Listed: Unlist service instead.
    expect(renderToStaticMarkup(<OfferingDetailView detail={{ ...detail, offering: { ...OFFERING, status: "listed" } }} data={DATA} onBack={() => undefined} />)).toContain("Unlist service");
  });
});

describe("each sheet posts to its route with what was typed", () => {
  it("Create service: the service type, endpoints, price and licences; the signing secret shown once", async () => {
    const { f, calls } = fetcher({ ok: true, offering_id: OFF, signing_secret: "mvs_once", message: "Service created as a draft." });
    render(<ServiceSheet mode="create" open serviceTypes={DATA.serviceTypes} licences={DATA.licences} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    type("[data-service-type]", "US/identity_verification");
    type("[data-service-name]", "KYC Works ID");
    type("[data-service-test-url]", "http://test.example.com");
    type("[data-service-price]", "0.4");
    await submit("[data-service-form]");
    expect(calls).toEqual([]);
    expect(document.querySelector("[data-sheet-error]")?.textContent).toBe("The test endpoint must be an https link.");
    type("[data-service-test-url]", "https://test.example.com");
    fireEvent.click(document.querySelector(`[data-service-licence="${LIC}"]`)!);
    await submit("[data-service-form]");
    expect(calls).toEqual([
      {
        url: "/api/vendor/offerings",
        method: "POST",
        body: { region: "US", service_type: "identity_verification", name: "KYC Works ID", test_base_url: "https://test.example.com", price: { amount: 0.4, currency: "USD" }, sla_notes: "", licence_ids: [LIC], requires_credential: false },
      },
    ]);
    expect(document.querySelector("[data-signing-secret] code")?.textContent).toBe("mvs_once");
  });

  it("Edit service posts to the service's own route", async () => {
    const { f, calls } = fetcher();
    render(<ServiceSheet mode="edit" open offering={OFFERING} serviceTypes={DATA.serviceTypes} licences={DATA.licences} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    type("[data-service-name]", "KYC Works ID v2");
    await submit("[data-service-form]");
    expect(calls[0]!.url).toBe(`/api/vendor/offerings/${OFF}`);
    expect(calls[0]!.body).toEqual({ name: "KYC Works ID v2", test_base_url: "https://test.example.com", price: { amount: 0.4, currency: "USD" }, sla_notes: "", licence_ids: [LIC], requires_credential: true });
  });

  it("Set standard terms: the SHA-256 computed from the chosen file in the browser, or pasted", async () => {
    const { f, calls } = fetcher();
    const noTerms = { ...OFFERING, terms: null };
    render(<TermsSheet offering={noTerms} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    expect(document.querySelector('[data-admin-sheet="set-terms"]')?.textContent).toContain("Saving a change makes version 1");
    type("[data-terms-url]", "https://example.com/terms.pdf");
    const file = new File(["abc"], "terms.pdf", { type: "application/pdf" });
    if (typeof file.arrayBuffer !== "function") Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("abc").buffer });
    await act(async () => void fireEvent.change(document.querySelector("[data-terms-file]")!, { target: { files: [file] } }));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    const sha = (document.querySelector("[data-terms-sha]") as HTMLInputElement).value;
    expect(sha).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"); // SHA-256("abc")
    type("[data-terms-summary]", "Our standard terms for identity checks.");
    type("[data-terms-pricing]", "$0.40 per check, invoiced monthly");
    await submit("[data-terms-form]");
    expect(calls).toEqual([
      {
        url: `/api/vendor/offerings/${OFF}/terms`,
        method: "POST",
        body: { standard_terms: { document_url: "https://example.com/terms.pdf", document_sha256: sha, summary: "Our standard terms for identity checks.", pricing_summary: "$0.40 per check, invoiced monthly" } },
      },
    ]);
    // Pasted: upper case is accepted and sent lower case; anything else is refused before it's sent.
    expect(v.sha256Of(` ${"AB".repeat(32)} `)).toBe("ab".repeat(32));
    expect(v.sha256Of("not a hash")).toBeNull();
    expect(await v.sha256Hex(new TextEncoder().encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("Set standard terms on terms already set: the next version, pre-filled", () => {
    render(<TermsSheet offering={OFFERING} onClose={() => undefined} onDone={() => undefined} />);
    expect(document.querySelector('[data-admin-sheet="set-terms"]')?.textContent).toContain("makes version 3");
    expect((document.querySelector("[data-terms-sha]") as HTMLInputElement).value).toBe("a".repeat(64));
  });

  it("Run conformance: the test credential sent once and cleared, then the result and each failure", async () => {
    const { f, calls } = fetcher({ ok: true, passed: false, failures: [{ case: "bad_signature_refused", problems: ["a request with a bad Mynt-Signature wasn't refused (answer 401)"] }], message: "Didn't pass: 1 of 3 checks failed." });
    render(<ConformanceSheet offering={OFFERING} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    type("[data-conformance-credential]", "test-cred");
    await submit("[data-conformance-form]");
    expect(calls).toEqual([{ url: `/api/vendor/offerings/${OFF}/conformance`, method: "POST", body: { test_credential: "test-cred" } }]);
    expect((document.querySelector("[data-conformance-credential]") as HTMLInputElement).value).toBe("");
    expect(document.querySelector("[data-conformance-outcome]")?.getAttribute("data-conformance-outcome")).toBe("failed");
    expect(document.querySelector("[data-conformance-failures]")?.textContent).toContain("bad signature refused: a request with a bad Mynt-Signature wasn't refused");
  });

  it("List service and Unlist service", async () => {
    const { f, calls } = fetcher();
    render(<ListingSheet offering={OFFERING} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-listing-submit="list"]')!));
    cleanup();
    render(<ListingSheet offering={{ ...OFFERING, status: "listed" }} onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    await act(async () => void fireEvent.click(document.querySelector('[data-listing-submit="unlist"]')!));
    expect(calls.map((c) => [c.url, c.body])).toEqual([
      [`/api/vendor/offerings/${OFF}/listing`, { listed: true }],
      [`/api/vendor/offerings/${OFF}/listing`, { listed: false }],
    ]);
  });
});
