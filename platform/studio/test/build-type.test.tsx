// @vitest-environment jsdom
// The Build page's Type dropdown: one labelled button ("Type: App") with three choices, each with a line saying what it
// is. Service puts the service type and region picker in place of the products, needs Mynt's vendor role (said plainly,
// and nothing can be created without it), creates the service and its first build, and lands on /services/<id>. The
// choice is kept in the address (?type=) and remembered per browser; the page works without either.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { openTypeMenu, pickType, typeOption, typeTrigger } from "./build-type-helper";

const pushed: string[] = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: (p: string) => void pushed.push(p), replace: () => undefined }) }));

const { default: NewAppPage } = await import("@/app/(studio)/new/page");
const s = await import("@/lib/services");

const TYPES = [
  { region: "US", key: "identity_verification", name: "Identity verification", category: "identity", description: "Checks a person is who they say.", vendorLicences: [] },
  { region: "US", key: "bank_account_check", name: "Bank account check", category: "account_data", description: "Confirms an account is open.", vendorLicences: ["us-msb", "us-state-mtl"] },
];
const REQUESTS = [{ id: "r1", name: "Proof of address", region: "US", whatItDoes: "Checks an address", exampleInput: {}, exampleOutput: {}, status: "declined", statusWords: "Declined", decisionNote: "Covered by identity verification", serviceTypeKey: null, requestedBy: "Vera", firm: "KYC Works", requestedAt: "2026-11-20T10:00:00Z", decidedAt: null }];

let vendor = true;
let posted: { url: string; body: unknown }[] = [];
let created: { status: number; body: unknown } = { status: 201, body: { serviceId: "svc-1", buildId: "build-1" } };

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function () {};
  Element.prototype.scrollIntoView ??= function () {};
});
beforeEach(() => {
  vendor = true;
  posted = [];
  pushed.length = 0;
  created = { status: 201, body: { serviceId: "svc-1", buildId: "build-1" } };
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "/api/services") return new Response(JSON.stringify(created.body), { status: created.status });
      if (url === "/api/services/types") return new Response(JSON.stringify({ ok: true, message: "Sent to Mynt." }), { status: 200 });
      return new Response("{}", { status: 404 });
    }
    if (url.startsWith("/api/products")) return new Response(JSON.stringify({ products: [] }), { status: 200 });
    if (url.startsWith("/api/app-kinds")) return new Response(JSON.stringify({ kinds: [] }), { status: 200 });
    if (url === "/api/services/types") return new Response(JSON.stringify({ supported: true, vendor, canRequest: true, serviceTypes: TYPES, requests: REQUESTS }), { status: 200 });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/new");
});

const settle = async (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const loaded = async (search = "") => {
  window.history.replaceState(null, "", `/new${search}`);
  render(<NewAppPage />);
  await settle();
};
const input = () => screen.getByLabelText("Message input") as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(input(), { target: { value: v } });
const sendButton = () => screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement;
const typeOf = () => document.querySelector("[data-new-app-chat]")!.getAttribute("data-type");
const pickServiceType = async (id: string) => {
  await act(async () => void fireEvent.click(document.querySelector("[data-service-type-picker]")!));
  await act(async () => void fireEvent.click(document.querySelector(`[data-service-type-option="${id}"]`)!));
};

describe("the Type dropdown", () => {
  it("is one labelled button with three choices, each saying what it is", async () => {
    await loaded();
    // Labelled, never an icon alone.
    expect(typeTrigger().textContent).toBe("Type: App");
    expect(typeTrigger().getAttribute("aria-label")).toBe("Type: App");
    // The two-way switch is gone.
    expect(document.querySelector("[data-mode-toggle]")).toBeNull();
    await openTypeMenu();
    const choices = (["app", "product", "service"] as const).map((t) => [typeOption(t)!.querySelector("[data-type-option-label]")!.textContent, typeOption(t)!.querySelector("[data-type-option-description]")!.textContent]);
    expect(choices).toEqual([
      ["App", "An app for customers, built on financial products"],
      ["Financial product", "A regulated product composed from primitives"],
      ["Service", "A service other builders plug in, listed in the Marketplace"],
    ]);
    expect(typeOption("app")!.getAttribute("role")).toBe("menuitemradio");
    expect(typeOption("app")!.getAttribute("aria-checked")).toBe("true");
    expect(typeOption("service")!.getAttribute("aria-checked")).toBe("false");
  });

  it("Service puts the service type and region picker in place of the products, with each type's licence prerequisite", async () => {
    await loaded();
    expect(document.querySelector("[data-product-picker]")).not.toBeNull();
    await pickType("service");
    await settle();
    expect(typeOf()).toBe("service");
    expect(typeTrigger().textContent).toBe("Type: Service");
    expect(screen.getByRole("heading", { name: "What service do you want to build?" })).toBeTruthy();
    expect(input().placeholder).toBe("Describe the service: what it takes in and what it gives back…");
    expect(document.querySelector("[data-product-picker]")).toBeNull();
    expect(document.querySelector("[data-service-type-label]")!.textContent).toBe("Pick a service type");
    await act(async () => void fireEvent.click(document.querySelector("[data-service-type-picker]")!));
    const option = (id: string) => document.querySelector(`[data-service-type-option="${id}"]`)!;
    expect(option("US/identity_verification").querySelector("[data-licence-prerequisite]")!.textContent).toBe("No licence needed");
    expect(option("US/bank_account_check").querySelector("[data-licence-prerequisite]")!.textContent).toBe("Needs one of: us-msb, us-state-mtl");
    expect(document.querySelector("[data-picker-region]")!.textContent).toContain("Region: US");
    // The picker's last item asks Mynt for a type that doesn't exist yet.
    expect(document.querySelector("[data-picker-request-type]")!.textContent).toBe("Request a service type");
    await act(async () => void fireEvent.click(option("US/bank_account_check")));
    expect(document.querySelector("[data-service-type-label]")!.textContent).toBe("Bank account check · US");
    // Its tabs: the service types, and the ones this account asked for.
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open Service types" })));
    expect([...document.querySelectorAll("[data-panel-tab]")].map((t) => t.textContent)).toEqual(["Service types", "Requested service types"]);
    expect(document.querySelector('[data-use-service-type="US/bank_account_check"]')!.textContent).toBe("Picked");
    await act(async () => void fireEvent.click(document.querySelector('[data-panel-tab="products"]')!));
    expect(document.querySelector('[data-request-status="declined"]')!.textContent).toBe("Declined");
    expect(document.querySelector('[data-panel-list="service-type-requests"]')!.textContent).toContain("Covered by identity verification");
  });

  it("keeps the choice in the address and remembers it in this browser; the address wins", async () => {
    await loaded();
    expect(typeOf()).toBe("app");
    await pickType("service");
    await settle();
    expect(new URLSearchParams(window.location.search).get("type")).toBe("service");
    expect(window.localStorage.getItem(s.BUILD_TYPE_KEY)).toBe("service");
    cleanup();
    // A later visit with nothing in the address: the last choice.
    await loaded();
    expect(typeOf()).toBe("service");
    cleanup();
    // The address says otherwise.
    await loaded("?type=product");
    expect(typeOf()).toBe("product");
    cleanup();
    await loaded("?type=app");
    expect(typeOf()).toBe("app");
    cleanup();
    // Something that isn't a type is ignored.
    window.localStorage.clear();
    await loaded("?type=widget");
    expect(typeOf()).toBe("app");
  });

  it("opens on the type the address names", async () => {
    await loaded("?type=service");
    expect(typeOf()).toBe("service");
    expect(document.querySelector("[data-service-type-picker]")).not.toBeNull();
  });

  it("renders and switches with the browser's storage blocked", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await loaded();
    expect(typeOf()).toBe("app");
    await pickType("service");
    await settle();
    expect(typeOf()).toBe("service");
    expect(new URLSearchParams(window.location.search).get("type")).toBe("service");
  });

  it("older links still work: a product chat's link opens Financial product", async () => {
    window.localStorage.setItem(s.BUILD_TYPE_KEY, "service");
    await loaded("?thread=11111111-1111-4111-8111-111111111111");
    expect(typeOf()).toBe("product");
  });
});

describe("building a service", () => {
  it("needs Mynt's vendor role: the choice is there, the plain message shows, and nothing can be created", async () => {
    vendor = false;
    await loaded();
    await pickType("service");
    await settle();
    expect(document.querySelector("[data-needs-vendor-role]")!.textContent).toBe("Ask a Mynt admin for the vendor role");
    await pickServiceType("US/identity_verification");
    type("A service that verifies identity documents for lenders");
    await settle(0);
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe("Ask a Mynt admin for the vendor role");
    await act(async () => void fireEvent.keyDown(input(), { key: "Enter" }));
    await settle();
    expect(posted).toEqual([]);
    expect(pushed).toEqual([]);
  });

  it("with the role: Send waits for a service type, then creates the service and opens its workspace on its first build", async () => {
    await loaded("?type=service");
    expect(document.querySelector("[data-needs-vendor-role]")).toBeNull();
    type("A service that verifies identity documents for lenders");
    await settle(0);
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe("Pick a service type to build.");
    await pickServiceType("US/identity_verification");
    await settle(0);
    expect(sendButton().disabled).toBe(false);
    await act(async () => void fireEvent.click(sendButton()));
    await settle();
    expect(posted).toEqual([{ url: "/api/services", body: { prompt: "A service that verifies identity documents for lenders", service_type: "identity_verification", region: "US" } }]);
    expect(pushed).toEqual(["/services/svc-1/build-1"]);
  });

  it("says why when Mynt refuses, and keeps what was typed", async () => {
    created = { status: 403, body: { error: "not_vendor", message: "Ask a Mynt admin for the vendor role." } };
    await loaded("?type=service");
    await pickServiceType("US/identity_verification");
    type("A service that verifies identity documents for lenders");
    await settle(0);
    await act(async () => void fireEvent.click(sendButton()));
    await settle();
    expect(document.querySelector("[data-new-app-error]")!.textContent).toBe("Ask a Mynt admin for the vendor role.");
    expect(input().value).toBe("A service that verifies identity documents for lenders");
    expect(pushed).toEqual([]);
  });
});

describe("Request a service type", () => {
  const field = (name: string) => document.querySelector(`[data-request-${name}]`) as HTMLInputElement | HTMLTextAreaElement;
  it("is a labelled button opening a sheet; the examples must be JSON objects", async () => {
    await loaded("?type=service");
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Open Service types" })));
    const button = document.querySelector("[data-request-service-type]")!;
    expect(button.textContent).toBe("Request a service type");
    await act(async () => void fireEvent.click(button));
    expect(document.querySelector('[data-admin-sheet="request-service-type"]')).not.toBeNull();
    fireEvent.change(field("name"), { target: { value: "Proof of address" } });
    fireEvent.change(field("what"), { target: { value: "Checks a customer's address against a utility bill" } });
    fireEvent.change(field("input"), { target: { value: '["not", "an", "object"]' } });
    fireEvent.change(field("output"), { target: { value: '{ "verified": true }' } });
    await act(async () => void fireEvent.submit(document.querySelector("[data-request-type-form]")!));
    expect(document.querySelector("[data-sheet-error]")!.textContent).toContain("Example input: It must be a JSON object");
    fireEvent.change(field("input"), { target: { value: "{ nope" } });
    await act(async () => void fireEvent.submit(document.querySelector("[data-request-type-form]")!));
    expect(document.querySelector("[data-sheet-error]")!.textContent).toBe("Example input: That isn't valid JSON.");
    expect(posted).toEqual([]);
    fireEvent.change(field("input"), { target: { value: '{ "line1": "1 Main St", "postcode": "10001" }' } });
    await act(async () => void fireEvent.submit(document.querySelector("[data-request-type-form]")!));
    await settle();
    expect(posted).toEqual([
      { url: "/api/services/types", body: { name: "Proof of address", what_it_does: "Checks a customer's address against a utility bill", region: "US", example_input: { line1: "1 Main St", postcode: "10001" }, example_output: { verified: true } } },
    ]);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Sent to Mynt.");
  });
});

describe("the type helpers", () => {
  it("read only the three types from the address, and say why a service can't be sent yet", () => {
    expect(s.buildTypeFromSearch("?type=service")).toBe("service");
    expect(s.buildTypeFromSearch("?type=product&x=1")).toBe("product");
    expect(s.buildTypeFromSearch("?type=Service")).toBeNull();
    expect(s.buildTypeFromSearch("")).toBeNull();
    expect(s.serviceBlockedReason(false, "US/identity_verification", "long enough text")).toBe("Ask a Mynt admin for the vendor role");
    expect(s.serviceBlockedReason(true, null, "")).toBe("Pick a service type to build.");
    expect(s.serviceBlockedReason(true, "US/identity_verification", "short")).toContain("at least 10 characters");
    expect(s.serviceBlockedReason(true, "US/identity_verification", "long enough text")).toBeNull();
    expect(s.serviceHref("svc 1")).toBe("/services/svc%201");
    expect(s.serviceIdOfPath("/services/svc-1/build-1")).toBe("svc-1");
    expect(s.serviceIdOfPath("/services")).toBeUndefined();
    expect(s.serviceIdOfPath("/svc-1")).toBeUndefined();
  });
});
