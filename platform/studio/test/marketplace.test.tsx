// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { filterOfferings, filtersFromSearch, fromOfferings, marketplaceCsv, marketplaceHref, NO_MARKETPLACE_FILTERS } from "@/lib/marketplace";
import { fromAgreements } from "@/lib/app-panel";
import { isAppPath, pageTitle, searchIndex, searchStudio } from "@/lib/studio-search";

// The Marketplace: service providers' standard services under their standard terms, the list (search, Filters,
// Import, Export CSV, the paged table), a service's side peek (a card of key facts, then tabs, each a table), the
// Subscribe sheet (apps, a test credential, accepting the terms' version) and the routes behind it (same origin, a
// signed-in developer, strict arguments, never a credential back); and the app's Agreements tab's Browse vendors and
// End subscription.

const OFFERING = "11111111-1111-4111-8111-111111111111";
const PLAIN = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";
const APP2 = "44444444-4444-4444-8444-444444444444";
const SUB = "55555555-5555-4555-8555-555555555555";
const SECRET = "provider-test-credential-9f2c";
const REPLY = [
  {
    offering_id: OFFERING,
    name: "Verify identity",
    vendor: "Verify Co",
    vendor_entity_id: "e1",
    region: "US",
    service_type: { key: "identity_check", name: "Identity check", category: "identity", consent_purpose: "kyc", fills: ["full_name"], innovator_licences: [] },
    standard_terms: { version: 2, document_url: "https://vendor.example.com/terms.pdf", document_sha256: "a".repeat(64), summary: "Standard checks, data kept 30 days.", pricing_summary: "$0.40 per check", scopes: ["manpower", "technology"], set_at: "2026-11-01T00:00:00.000Z" },
    price: { amount: 0.4, currency: "USD", per: "call" },
    sla_notes: "99.9% monthly",
    live_available: true,
    requires_credential: true,
    vendor_licences: [],
    conformance: { passed: true, at: "2026-11-02T10:00:00.000Z" },
    your_subscription_id: null,
    you_can_subscribe: true,
  },
  {
    offering_id: PLAIN,
    name: "Bureau pull",
    vendor: "Bureau Inc",
    region: "IN",
    service_type: { key: "bureau_report", name: "Credit bureau report", category: "credit_bureau", fills: [], innovator_licences: ["rbi_nbfc"] },
    standard_terms: null,
    price: { amount: 12, currency: "INR", per: "call" },
    conformance: null,
    you_can_subscribe: false,
    prerequisite: "Credit bureau report in IN needs your firm to hold a verified licence of one of: rbi_nbfc",
  },
];
const OFFERINGS = fromOfferings(REPLY);
const APPS = [
  { id: APP, name: "Pay app", productIds: ["p1", "p2"], canManage: null },
  { id: APP2, name: "Second app", productIds: ["p1"], canManage: null },
];

const fake = { session: undefined as Session | undefined, sameOrigin: true, tools: [] as { name: string; inputSchema?: unknown }[], calls: [] as { name: string; args: Record<string, unknown> }[], refuse: null as string | null };
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_my_apps") return ok([{ id: APP, name: "Pay app", workspace_id: "w1", stage: "staging", product_ids: ["p1", "p2"] }]);
      if (name === "list_vendor_offerings") return ok(REPLY);
      if (name === "get_product") return ok({ id: args.id, region: args.id === "p1" ? "US" : "global" });
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      // Mynt never returns the credential; even if it did, the route answers only its own message and the id.
      if (name === "subscribe_vendor_service") return ok({ subscription_id: SUB, credentials: { test: { key_id: "k", label: "x" } }, echo: args.test_credential });
      return ok({ subscription_id: SUB, status: "ended" });
    },
    close: async () => undefined,
  }),
}));

const view = await import("@/components/marketplace-view");
const sheet = await import("@/components/marketplace-subscribe-sheet");
const endSheet = await import("@/components/end-subscription-sheet");
const tabs = await import("@/components/app-panel-tabs");
const listRoute = await import("@/app/api/marketplace/route");
const subscribeRoute = await import("@/app/api/marketplace/subscribe/route");
const endRoute = await import("@/app/api/marketplace/end/route");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
});
const SUBSCRIBE_SCHEMA = { properties: { offering_id: {}, accept_terms_version: {}, app_ids: {} } };
beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.sameOrigin = true;
  fake.tools = [{ name: "list_my_apps" }, { name: "get_product" }, { name: "list_vendor_offerings" }, { name: "subscribe_vendor_service", inputSchema: SUBSCRIBE_SCHEMA }, { name: "unsubscribe_vendor_service" }];
  fake.calls = [];
  fake.refuse = null;
});
afterEach(() => cleanup());

describe("reading the offerings", () => {
  it("keeps the standard terms, the pricing in words, conformance and prerequisites; none on file is null", () => {
    expect(OFFERINGS[0].terms?.version).toBe(2);
    expect(OFFERINGS[0].terms?.scopes).toEqual(["technology", "manpower"]); // in the list's order
    expect(OFFERINGS[0].terms?.scopeLabel).toBe("Technology, Manpower");
    // Terms from before scopes were recorded: none, "Not set", never invented.
    const legacy = fromOfferings([{ ...REPLY[0], standard_terms: { ...REPLY[0].standard_terms, scopes: undefined } }])[0]!;
    expect([legacy.terms?.scopes, legacy.terms?.scopeLabel]).toEqual([[], "Not set"]);
    expect(OFFERINGS[0].pricing).toBe("$0.40 per check");
    expect(OFFERINGS[1].terms).toBeNull();
    expect(OFFERINGS[1].pricing).toMatch(/per call/);
    expect(OFFERINGS[1].conformance).toBeNull();
    expect(OFFERINGS[1].canSubscribe).toBe(false);
    expect(filterOfferings(OFFERINGS, { ...NO_MARKETPLACE_FILTERS, region: ["US"] }).map((o) => o.id)).toEqual([OFFERING]);
    expect(filterOfferings(OFFERINGS, { ...NO_MARKETPLACE_FILTERS, category: ["credit_bureau"] }).map((o) => o.id)).toEqual([PLAIN]);
    expect(filterOfferings(OFFERINGS, { ...NO_MARKETPLACE_FILTERS, query: "verify co" }).map((o) => o.id)).toEqual([OFFERING]);
    expect(marketplaceCsv(OFFERINGS).split("\n")[0]).toBe("Provider,Service,Category,Region,Pricing,Standard terms,Conformance,Prerequisites");
    expect(filtersFromSearch("?app=a1&region=us,in&category=kyc&offering=o1")).toEqual({ filters: { query: "", region: ["US", "IN"], category: ["kyc"], service: [] }, appId: "a1", offeringId: "o1" });
    expect(filtersFromSearch("?app=../x").appId).toBeNull();
    expect(marketplaceHref("a b")).toBe("/marketplace?app=a%20b");
  });
});

describe("finding the Marketplace", () => {
  it("is a fixed page titled Marketplace, found by searching for vendors, service providers or terms", () => {
    expect(isAppPath("/marketplace")).toBe(false);
    expect(pageTitle("/marketplace")).toBe("Marketplace");
    const items = searchIndex({});
    for (const q of ["marketplace", "vendors", "service providers", "standard terms", "kyc"]) expect(searchStudio(items, q).map((i) => i.href), q).toContain("/marketplace");
  });
});

describe("the Marketplace page", () => {
  it("is the list layout: one toolbar (search, Filters, Import, Export CSV), the table and the pager; no icon-only buttons", () => {
    const html = renderToStaticMarkup(<view.MarketplaceView offerings={OFFERINGS} apps={APPS} />);
    for (const h of ["Provider", "Service", "Category", "Regions", "Pricing", "Conformance", "Prerequisites"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toContain('aria-label="Search the marketplace"');
    expect(html).toContain("data-filters-menu-button");
    expect(html).toMatch(/data-import[^>]*>.*Import/);
    expect(html).toMatch(/data-export[^>]*>.*Export CSV/);
    expect(html).toContain("Passed Mynt&#x27;s test");
    expect(html).toContain("Not tested yet");
    expect(html).toContain("2 services · Page 1 of 1");
    // (the first is split so the repository's wording check doesn't flag this line)
    for (const word of ["mer" + "chant", "shop", "seller", " buy", "store"]) expect(html.toLowerCase()).not.toContain(word);
  });

  it("opens a service's side peek: the key facts, then tabs each a table, and Subscribe", async () => {
    render(<view.MarketplaceView offerings={OFFERINGS} apps={APPS} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-open-offering="${OFFERING}"]`)!));
    const peek = document.querySelector(`[data-offering-detail="${OFFERING}"]`)!;
    expect(peek.querySelector("[data-offering-card]")?.textContent).toContain("Standard termsv2");
    expect([...peek.querySelectorAll("[data-peek-tab]")].map((t) => t.textContent)).toEqual(["Overview", "Standard terms", "Pricing", "Prerequisites", "Conformance", "Regions"]);
    expect(peek.querySelector("[data-peek-table=overview]")).toBeTruthy();
    await act(async () => void fireEvent.click(peek.querySelector("[data-peek-tab=terms]")!));
    const terms = document.querySelector("[data-peek-table=terms]")!;
    expect(terms.textContent).toContain("v2");
    expect(terms.textContent).toContain("Standard checks, data kept 30 days.");
    expect(terms.querySelector("[data-terms-scope]")?.textContent).toBe("Technology, Manpower");
    expect(terms.querySelector("[data-terms-document]")?.getAttribute("href")).toBe("https://vendor.example.com/terms.pdf");
    await act(async () => void fireEvent.click(document.querySelector("[data-peek-tab=pricing]")!));
    expect(document.querySelector("[data-peek-table=pricing]")?.textContent).toContain("bills you directly");
    await act(async () => void fireEvent.click(document.querySelector(`[data-subscribe="${OFFERING}"]`)!));
    expect(screen.getByRole("heading", { name: "Subscribe to Verify identity" })).toBeTruthy();
  });

  it("can't subscribe without standard terms on file, or without the prerequisites", () => {
    const html = renderToStaticMarkup(<view.OfferingDetail offering={OFFERINGS[1]} tab="terms" onTab={() => undefined} onSubscribe={() => undefined} />);
    expect(html).toContain("No standard terms on file");
    expect(html).toMatch(/data-subscribe="[^"]+"[^>]*disabled|disabled[^>]*data-subscribe=/);
    expect(renderToStaticMarkup(<sheet.SubscribeView offering={OFFERINGS[1]} apps={APPS} onSubmit={() => undefined} />)).toContain("data-no-terms");
  });
});

describe("the Subscribe sheet", () => {
  it("chooses apps and products, takes the test credential, and accepts the terms' version", () => {
    const sent: unknown[] = [];
    render(<sheet.SubscribeView offering={OFFERINGS[0]} apps={APPS} preselect={APP} onSubmit={(r) => sent.push(r)} />);
    const submit = document.querySelector("[data-subscribe-submit]") as HTMLButtonElement;
    expect((document.querySelector(`[data-subscribe-app="${APP}"]`) as HTMLInputElement).checked).toBe(true);
    expect(document.querySelector("[data-accept-terms]")?.parentElement?.textContent).toBe("I accept Verify Co's standard terms v2");
    expect(document.querySelector("[data-subscribe-terms-scope]")?.textContent?.trim()).toBe("You accept Verify Co's standard terms v2 — Scope: Technology, Manpower");
    expect(submit.disabled).toBe(true);
    fireEvent.click(document.querySelector("[data-accept-terms]")!);
    expect(submit.disabled).toBe(true); // the provider needs a test credential
    const credential = document.querySelector("[data-subscribe-test-credential]") as HTMLInputElement;
    expect(credential.type).toBe("password");
    fireEvent.change(credential, { target: { value: SECRET } });
    fireEvent.click(document.querySelector(`[data-subscribe-product="p2"]`)!);
    fireEvent.click(submit);
    expect(sent).toEqual([{ offering_id: OFFERING, accept_terms_version: 2, app_ids: [APP], products: ["p2"], test_credential: SECRET }]);
  });

  it("posts to the subscribe route, shows Mynt's refusal in its words, and clears the credential once sent", async () => {
    let reply: { status: number; body: unknown } = { status: 422, body: { error: "mynt_refused", message: "Those aren't Verify identity's current terms: version 3 is current" } };
    const requests: unknown[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    let done = 0;
    render(<sheet.SubscribeSheet offering={OFFERINGS[0]} apps={APPS} preselect={APP} onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    await act(async () => undefined);
    fireEvent.click(document.querySelector("[data-accept-terms]")!);
    fireEvent.change(document.querySelector("[data-subscribe-test-credential]")!, { target: { value: SECRET } });
    await act(async () => void fireEvent.click(document.querySelector("[data-subscribe-submit]")!));
    expect((requests[0] as { url: string }).url).toBe("/api/marketplace/subscribe");
    expect(document.querySelector("[data-subscribe-error]")?.textContent).toContain("version 3 is current");
    reply = { status: 200, body: { ok: true, message: "Subscribed." } };
    await act(async () => void fireEvent.click(document.querySelector("[data-subscribe-submit]")!));
    expect(document.querySelector("[data-subscribe-result]")?.textContent).toBe("Subscribed.");
    expect(done).toBe(1);
    expect((document.querySelector("[data-subscribe-test-credential]") as HTMLInputElement).value).toBe("");
  });
});

const postJson = (route: { POST: (r: Request) => Promise<Response> }, body: unknown) => route.POST(new Request("http://localhost:3000/api/marketplace/x", { method: "POST", body: JSON.stringify(body) }));

describe("the routes", () => {
  it("GET lists offerings and apps, and for ?app= the app's products' regions", async () => {
    const res = await listRoute.GET(new Request(`http://localhost:3000/api/marketplace?app=${APP}`));
    const body = (await res.json()) as { supported: boolean; offerings: unknown[]; apps: { id: string }[]; forApp: { regions: string[] }; canSubscribe: boolean };
    expect(body.supported).toBe(true);
    expect(body.offerings).toHaveLength(2);
    expect(body.apps.map((a) => a.id)).toEqual([APP]);
    expect(body.forApp.regions).toEqual(["US"]);
    expect(body.canSubscribe).toBe(true);
    expect((await listRoute.GET(new Request("http://localhost:3000/api/marketplace?app=../etc"))).status).toBe(400);
    fake.tools = [{ name: "list_my_apps" }];
    expect(((await (await listRoute.GET(new Request("http://localhost:3000/api/marketplace"))).json()) as { supported: boolean }).supported).toBe(false);
    fake.session = undefined;
    expect((await listRoute.GET(new Request("http://localhost:3000/api/marketplace"))).status).toBe(401);
  });

  it("subscribe: own origin, strict arguments with the terms' version and apps, then subscribe_vendor_service; never the credential back", async () => {
    const body = { offering_id: OFFERING, accept_terms_version: 2, app_ids: [APP], test_credential: SECRET, credential_label: "" };
    fake.sameOrigin = false;
    expect((await postJson(subscribeRoute, body)).status).toBe(403);
    fake.sameOrigin = true;
    expect((await postJson(subscribeRoute, { ...body, accept_terms_version: undefined })).status).toBe(400);
    expect((await postJson(subscribeRoute, { ...body, app_ids: [] })).status).toBe(400);
    expect((await postJson(subscribeRoute, { ...body, live_credential: "x" })).status).toBe(400);
    const res = await postJson(subscribeRoute, body);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toEqual({ ok: true, subscription_id: SUB, message: expect.any(String) });
    expect(fake.calls.find((c) => c.name === "subscribe_vendor_service")?.args).toEqual({ offering_id: OFFERING, accept_terms_version: 2, app_ids: [APP], test_credential: SECRET });
    fake.refuse = "Those aren't Verify identity's current terms: version 3 is current";
    const refused = await postJson(subscribeRoute, body);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("version 3 is current");
    fake.tools = [{ name: "subscribe_vendor_service", inputSchema: { properties: { offering_id: {} } } }];
    expect((await postJson(subscribeRoute, body)).status).toBe(501);
  });

  it("end: own origin, a subscription id, then unsubscribe_vendor_service", async () => {
    fake.sameOrigin = false;
    expect((await postJson(endRoute, { subscription_id: SUB })).status).toBe(403);
    fake.sameOrigin = true;
    expect((await postJson(endRoute, { subscription_id: "nope" })).status).toBe(400);
    expect((await postJson(endRoute, { subscription_id: SUB, reason: "Switching providers" })).status).toBe(200);
    expect(fake.calls.find((c) => c.name === "unsubscribe_vendor_service")?.args).toEqual({ subscription_id: SUB, reason: "Switching providers" });
  });
});

describe("the app's Agreements tab", () => {
  const data = fromAgreements({
    can_manage: true,
    agreements: [],
    products: [],
    vendor_contracts: [
      { subscription_id: SUB, vendor: { entity_id: "e1", name: "Verify Co" }, offering: "Verify identity", environment: "test", since: "2026-11-02T00:00:00.000Z", terms_version: 2, no_standard_terms: false, scopes: ["technology"] },
      { subscription_id: "s2", vendor: { name: "Old KYC" }, offering: "KYC", environment: "live", since: null, terms_version: null, no_standard_terms: true, scopes: null },
    ],
    introductions: null,
  })!;

  it("has Browse vendors (the Marketplace for this app) and each vendor contract's terms and End subscription", async () => {
    render(<tabs.AgreementsTabView appId={APP} data={data} />);
    expect(document.querySelector("[data-browse-vendors]")?.getAttribute("href")).toBe(`/marketplace?app=${APP}`);
    expect(document.querySelector("[data-browse-vendors]")?.textContent?.trim()).toBe("Browse vendors");
    expect(document.querySelector(`[data-vendor-contract="${SUB}"] [data-vendor-terms]`)?.textContent).toBe("Standard terms v2");
    expect(document.querySelector(`[data-vendor-contract="s2"] [data-vendor-terms]`)?.textContent).toBe("No standard terms on file");
    // Each contract's scope, from the terms version accepted for this app; none recorded: a dash, never invented.
    expect(document.querySelector(`[data-vendor-scope="${SUB}"]`)?.textContent).toBe("Technology");
    expect(document.querySelector(`[data-vendor-scope="s2"]`)?.textContent).toBe("—");
    await act(async () => void fireEvent.click(document.querySelector(`[data-end-subscription="${SUB}"]`)!));
    expect(screen.getByRole("heading", { name: "End subscription" })).toBeTruthy();
  });

  it("a member who can't manage the app sees no End subscription", () => {
    const html = renderToStaticMarkup(<tabs.AgreementsTabView appId={APP} data={{ ...data, canManage: false }} />);
    expect(html).not.toContain("data-end-subscription=");
    expect(html).toContain("data-browse-vendors");
  });

  it("End subscription posts the reason", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, message: "Subscription ended." }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<endSheet.EndSubscriptionSheet contract={data.vendorContracts[0]} onClose={() => undefined} onDone={() => undefined} fetcher={fetcher} />);
    await act(async () => undefined);
    fireEvent.change(document.querySelector("[data-end-subscription-reason]")!, { target: { value: "Switching providers" } });
    await act(async () => void fireEvent.click(document.querySelector("[data-end-subscription-submit]")!));
    expect(requests).toEqual([{ url: "/api/marketplace/end", body: { subscription_id: SUB, reason: "Switching providers" } }]);
    expect(document.querySelector("[data-end-subscription-result]")?.textContent).toBe("Subscription ended.");
  });
});
