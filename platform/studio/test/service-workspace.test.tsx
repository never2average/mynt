// @vitest-environment jsdom
// A service's own workspace (/services/<id>): Mynt's get_service as the studio reads it, its header (stage, the
// offering's status in words, Archive / Restore), and its tabs, each tables: Overview (the checklist with the labelled
// action each step maps to), Contract (field tables, the endpoint Mynt derives, the signing rule, fixtures),
// Conformance (practice and real runs in one table, with Run practice test and Run conformance), Terms & pricing,
// Subscribers, Reliability ("Not measured" with its reason, never 0) and Activity. No app tabs.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const nav = { pushed: [] as string[] };
vi.mock("next/navigation", () => ({
  usePathname: () => "/services/svc-1",
  useRouter: () => ({ push: (p: string) => void nav.pushed.push(p), replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { ServiceWorkspace, ServiceHeader, ServiceTabBody, ServiceChecklist, stageActionLabel } = await import("@/components/service-workspace");
const { SidebarProvider } = await import("@/components/ui/sidebar");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { PUT_ONLINE_EVENT } = await import("@/components/hosting-control");
const { OPEN_PROMOTION_EVENT } = await import("@/components/promotion-view");
const s = await import("@/lib/services");
type ServiceView = import("@/lib/services").ServiceView;

vi.setConfig({ testTimeout: 20_000 });

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

const OFF = "55555555-5555-4555-8555-555555555555";
const BUILD = "77777777-7777-4777-8777-777777777777";
const step = (key: string, status: string, tool: string, extra: Record<string, unknown> = {}) => ({ key, title: `Step ${key}`, status, detail: `Detail of ${key}.`, tool, by: "vendor", informational: false, facts: {}, ...extra });

// get_service's reply, as core/src/services.ts serviceView gives it.
const REPLY = {
  id: "svc-1",
  kind: "service",
  name: "Swift ID",
  description: "Verifies identity documents.",
  workspace_id: "ws-1",
  workspace_role: "owner",
  stage: "staging",
  archived: false,
  firm: { id: "f1", name: "KYC Works" },
  vendor_role: true,
  service_type: { key: "identity_verification", name: "Identity verification", region: "US", category: "identity", description: "Checks a person is who they say." },
  offering: { id: OFF, name: "Swift ID", status: "draft", status_words: "Needs conformance", status_note: null, price: { amount: 0.5, currency: "USD", per: "call" }, sla_notes: "", licence_ids: [], terms: { version: 2, document_url: "https://example.com/terms-v2.pdf", document_sha256: "a".repeat(64), summary: "Our standard terms.", pricing_summary: "$0.50 per check", scopes: ["technology"], set_at: "2026-11-21T09:00:00Z" }, build_id: BUILD },
  hosted: { status: "running", online: true, build_id: BUILD, address: "https://swift-id.example.com" },
  contract: {
    contract_version: 1,
    endpoint: { method: "POST", app_path: "/mynt/services/identity_verification", note: "Mynt derives the address.", address: "https://swift-id.example.com/mynt/services/identity_verification" },
    signature: { header: "Mynt-Signature", format: "t=<unix seconds>,v1=<hex>", algorithm: "HMAC-SHA256", tolerance_seconds: 300, compare: "constant-time", refuse_with: 401, secret_setting: "MYNT_VENDOR_SIGNING_SECRET", rule: "Verify the signature over the raw body before reading it." },
    request: { input_schema: {}, params_schema: null },
    response: { output_schema: {}, limits: "Answer within 10 seconds, with at most 256 KiB." },
    fixtures: [{ input: { full_name: "Ada Lovelace", document_number: "X123" } }],
    example_output: { verified: true, score: 0.98 },
    input_fields: [
      { field: "full_name", type: "string", required: true, description: "The person's name" },
      { field: "document_number", type: "string (matches ^[A-Z0-9]+$)", required: false, description: "" },
    ],
    params_fields: [],
    output_fields: [{ field: "verified", type: "boolean", required: true, description: "Whether the person matched" }],
  },
  conformance: {
    runs: [
      { run_id: "p2", kind: "practice", passed: true, at: "2026-11-22T12:00:00Z", run_by: "Vera", failures: [] },
      { run_id: "c2", kind: "conformance", passed: false, at: "2026-11-22T10:00:00Z", run_by: null, failures: [{ case: "fixture_1", problems: ["answered 500"] }], cases: [{ case: "fixture_1", passed: false, http_status: 500, problems: ["answered 500"] }, { case: "bad_signature_refused", passed: true, http_status: 401, problems: [] }], passed_cases: 1, total_cases: 2 },
      { run_id: "c1", kind: "conformance", passed: true, at: "2026-11-20T10:00:00Z", run_by: "Vera", failures: [], cases: [{ case: "fixture_1", passed: true, http_status: 200, problems: [] }], passed_cases: 1, total_cases: 1 },
    ],
    needed: true,
    tested_build_id: null,
  },
  terms: {
    current: { version: 2, document_url: "https://example.com/terms-v2.pdf", document_sha256: "a".repeat(64), summary: "Our standard terms.", pricing_summary: "$0.50 per check", scopes: ["technology"], set_at: "2026-11-21T09:00:00Z" },
    versions: [
      { version: 2, current: true, document_url: "https://example.com/terms-v2.pdf", document_sha256: "a".repeat(64), summary: "Our standard terms.", pricing_summary: "$0.50 per check", scopes: ["technology"], set_at: "2026-11-21T09:00:00Z", set_by: "Vera", agreements: 1 },
      { version: 1, current: false, document_url: null, document_sha256: null, summary: null, pricing_summary: null, scopes: null, set_at: "2026-11-01T09:00:00Z", set_by: "Vera", agreements: 0 },
    ],
  },
  subscribers: [
    { subscription_id: "sub-1", firm: "Lead Trust", app: "Budgeting", terms_version: 2, since: "2026-11-23T08:00:00Z", environment: "Live", subscription_status: "active", agreement_id: "ag-1", agreement_status: "in_force" },
    { subscription_id: "sub-2", firm: "Harbor Bank", app: null, terms_version: null, since: "2026-11-24T08:00:00Z", environment: "Sandbox", subscription_status: "active", agreement_id: null, agreement_status: null },
  ],
  reliability: {
    window_days: 30,
    calls: { value: null, not_measured: "No subscriber called it in the last 30 days" },
    error_rate: { value: null, not_measured: "No subscriber called it in the last 30 days" },
    response_time_ms: { value: null, not_measured: "Mynt doesn't record how long each subscriber's call took, only whether it succeeded", in_last_conformance_run: { median: 42, max: 90, requests: 3, at: "2026-11-22T10:00:00Z" } },
    by_day: [],
    incidents: [{ at: "2026-11-22T10:00:00Z", kind: "service_conformance_after_deploy", what: "Mynt's conformance test failed" }],
  },
  activity: [
    { at: "2026-11-22T10:00:00Z", action: "service_conformance_after_deploy", what: "Mynt tested the new build", detail: "Failed", by: "Mynt" },
    { at: "2026-11-19T10:00:00Z", action: "create_service", what: "Service created", detail: "", by: "Vera" },
  ],
  checklist: [
    { ...step("vendor_role", "done", "invite_user"), by: "admin" },
    step("app_online", "done", "deploy_app"),
    step("service_endpoint", "next", "start_build"),
    step("practice", "done", "run_practice_conformance", { informational: true }),
    step("conformance", "not_started", "run_conformance"),
    step("terms", "done", "update_vendor_offering"),
    step("listed", "not_started", "promote_app"),
  ],
  progress: { done: 3, total: 6 },
};
const service = (patch: Record<string, unknown> = {}): ServiceView => s.serviceFrom({ ...REPLY, ...patch })!;

let reply: Record<string, unknown>;
let posted: { url: string; body: unknown }[];
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  reply = REPLY;
  posted = [];
  nav.pushed.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(String(init.body)) });
      if (url === "/api/services/svc-1") return ok({ ok: true, archived: true, message: "Archived. It's off the Marketplace and Mynt has stopped calling it." });
      if (url === `/api/vendor/offerings/${OFF}/conformance`) return ok({ ok: true, passed: true, failures: [], message: "Passed Mynt's conformance test." });
      return ok({}, 404);
    }
    if (url === "/api/services/svc-1") return ok({ supported: true, service: s.serviceFrom(reply) });
    if (url === "/api/projects") return ok({ projects: [], services: [] });
    return ok({}, 404);
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settle = async (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const withProviders = (ui: React.ReactNode) => (
  <TooltipProvider>
    <SidebarProvider>{ui}</SidebarProvider>
  </TooltipProvider>
);
const noAction = () => undefined;
const table = (id: string) => document.querySelector(`[data-service-table="${id}"]`) as HTMLElement;
const head = (id: string) => [...table(id).querySelectorAll("thead th")].map((h) => h.textContent);
const rows = (id: string) => [...table(id).querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
const fact = (label: string) => document.querySelector(`[data-fact="${label}"] dd`)!.textContent;
const tab = (t: Exclude<import("@/lib/services").ServiceTab, "security">, sv = service(), onAction: (a: string) => void = noAction) => render(<ServiceTabBody tab={t} service={sv} onAction={onAction} />);

describe("get_service, as the studio reads it", () => {
  it("keeps what Mynt measured and what it didn't: null with the reason, never 0", () => {
    const sv = service();
    expect(sv.reliability.calls).toEqual({ value: null, notMeasured: "No subscriber called it in the last 30 days" });
    expect(sv.reliability.responseTimeMs.value).toBeNull();
    expect(s.measuredWords(sv.reliability.calls)).toBe("Not measured: No subscriber called it in the last 30 days");
    expect(s.measuredWords({ value: 12, notMeasured: null })).toBe("12");
    expect(s.measuredWords({ value: 0.025, notMeasured: null }, s.percent)).toBe("2.5%");
    expect(sv.offering).toMatchObject({ id: OFF, statusWords: "Needs conformance", status: "draft" });
    expect(sv.subscribers[0]).toMatchObject({ firm: "Lead Trust", appName: "Budgeting", termsVersion: 2, environment: "Live", agreementStatus: "in_force" });
    expect(sv.conformance.runs.map((r) => [r.runId, r.kind, r.passed])).toEqual([["p2", "practice", true], ["c2", "conformance", false], ["c1", "conformance", true]]);
    // Anything that isn't a service is not one: an app's record never reads as a service.
    expect(s.serviceFrom({ ...REPLY, kind: "app" })).toBeNull();
    expect(s.serviceFrom(null)).toBeNull();
  });

  it("gives My services' sheets the service's offering, with Mynt's endpoint and no credential", () => {
    const o = s.offeringForSheets(service());
    expect(o).toMatchObject({ id: OFF, name: "Swift ID", serviceKey: "identity_verification", region: "US", requiresCredential: false, testBaseUrl: "https://swift-id.example.com/mynt/services/identity_verification" });
    expect(o.terms?.version).toBe(2);
    expect(s.offeringForSheets(service({ hosted: null, contract: { ...REPLY.contract, endpoint: { ...REPLY.contract.endpoint, address: null } } })).testBaseUrl).toBe("");
  });

  it("has its own tabs and none of an app's", () => {
    expect(s.SERVICE_TABS.map((t) => s.SERVICE_TAB_LABELS[t])).toEqual(["Overview", "Contract", "Conformance", "Terms & pricing", "Subscribers", "Reliability", "Security & risk", "Activity"]);
    for (const appTab of ["products", "agreements", "customers", "pnl", "sdk", "preview"]) expect(s.isServiceTab(appTab)).toBe(false);
  });
});

describe("Contract", () => {
  it("shows what it takes in and gives back as field tables: Field, Type, Required, Description", () => {
    tab("contract");
    expect(head("input")).toEqual(["Field", "Type", "Required", "Description"]);
    expect(rows("input")).toEqual([
      ["full_name", "string", "Yes", "The person's name"],
      ["document_number", "string (matches ^[A-Z0-9]+$)", "No", "Not described"],
    ]);
    expect(rows("output")).toEqual([["verified", "boolean", "Yes", "Whether the person matched"]]);
    // No parameters on this service type: no empty table for them.
    expect(table("params")).toBeNull();
    expect(fact("Region")).toBe("US");
    expect(fact("Service type")).toBe("identity_verification");
  });

  it("shows the endpoint Mynt derives: the address once online, else the path and that Mynt sets it", () => {
    tab("contract");
    expect(fact("Endpoint")).toBe("POST https://swift-id.example.com/mynt/services/identity_verification");
    cleanup();
    tab("contract", service({ hosted: null, contract: { ...REPLY.contract, endpoint: { ...REPLY.contract.endpoint, address: null } } }));
    expect(fact("Endpoint")).toBe("POST /mynt/services/identity_verification · Set by Mynt when the service is online");
    expect(document.querySelector("[data-endpoint-pending]")).not.toBeNull();
  });

  it("shows the signing rule and the fixtures, and names the secret's setting without any secret", () => {
    const { container } = tab("contract");
    const rule = Object.fromEntries(rows("signature").map(([k, v]) => [k, v]));
    expect(rule.Header).toBe("Mynt-Signature");
    expect(rule.Algorithm).toBe("HMAC-SHA256");
    expect(rule.Tolerance).toBe("300 seconds");
    expect(rule["Refuse with"]).toBe("HTTP 401");
    expect(rule.Secret).toContain("MYNT_VENDOR_SIGNING_SECRET");
    expect(rule.Secret).toContain("never shown");
    expect(container.textContent).not.toMatch(/mvs_/);
    expect(rows("fixtures")[0][0]).toBe("Fixture 1");
    expect(rows("fixtures")[0][1]).toContain('"full_name": "Ada Lovelace"');
    expect(document.querySelector("[data-example-output]")!.textContent).toContain('"verified": true');
  });
});

describe("Conformance", () => {
  it("lists practice and real runs in one table, and never invents a build", () => {
    tab("conformance");
    expect(head("runs")).toEqual(["When", "Kind", "Build", "Result", "Cases passed", "Run by"]);
    expect(rows("runs")).toEqual([
      ["2026-11-22 12:00", "Practice", "Not recorded", "Passed", "Not recorded", "Vera"],
      ["2026-11-22 10:00", "Conformance", "Not recorded", "Didn't pass", "1 of 2", "Mynt"],
      ["2026-11-20 10:00", "Conformance", "Not recorded", "Passed", "1 of 1", "Vera"],
    ]);
    expect(document.querySelector("[data-conformance-needed]")!.textContent).toContain("Yes");
    expect(fact("Status")).toBe("Needs conformance");
    expect(fact("Build tested")).toBe("Not recorded");
  });

  it("names the build only on the passing run that stands", () => {
    const passed = service({
      offering: { ...REPLY.offering, status: "conformance_passed", status_words: "Conformance passed" },
      conformance: { needed: false, tested_build_id: BUILD, runs: [{ ...REPLY.conformance.runs[2], run_id: "c3", at: "2026-11-25T10:00:00Z" }, REPLY.conformance.runs[0], REPLY.conformance.runs[2]] },
    });
    tab("conformance", passed);
    expect(rows("runs").map((r) => r[2])).toEqual(["77777777", "Not recorded", "Not recorded"]);
    expect(document.querySelector("[data-conformance-needed]")!.textContent).toBe("No");
  });

  it("has the labelled actions Run practice test and Run conformance", () => {
    const asked: string[] = [];
    tab("conformance", service(), (a) => void asked.push(a));
    const actions = document.querySelector("[data-tab-actions]") as HTMLElement;
    expect([...actions.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Run practice test", "Run conformance"]);
    fireEvent.click(within(actions).getByRole("button", { name: "Run practice test" }));
    fireEvent.click(within(actions).getByRole("button", { name: "Run conformance" }));
    expect(asked).toEqual(["practice", "conformance"]);
  });

  it("a row opens the run's cases; a practice run says where its transcript shows", async () => {
    const asked: string[] = [];
    tab("conformance", service(), (a) => void asked.push(a));
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="c2"]')!));
    const sheet = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    expect(sheet.textContent).toContain("Conformance run");
    expect([...sheet.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent))).toEqual([
      ["fixture 1", "Failed", "500", "answered 500"],
      ["bad signature refused", "Passed", "401", "None"],
    ]);
    cleanup();
    tab("conformance", service(), (a) => void asked.push(a));
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="p2"]')!));
    const practice = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    expect(practice.textContent).toContain("It never counts as conformance");
    expect(practice.querySelector("[data-practice-transcript-note]")!.textContent).toContain("Run practice test shows it, with the signing secret left out");
    await act(async () => void fireEvent.click(within(practice).getByRole("button", { name: "Run practice test" })));
    expect(asked).toEqual(["practice"]);
  });
});

describe("Terms & pricing, Subscribers, Activity", () => {
  it("lists the standard terms versions with Set standard terms", () => {
    const asked: string[] = [];
    tab("terms", service(), (a) => void asked.push(a));
    expect(head("terms-versions")).toEqual(["Version", "Scope", "Summary", "Pricing", "Set on", "Set by", "Document"]);
    expect(rows("terms-versions")[0].slice(0, 6)).toEqual(["v2 (current)", "Technology", "Our standard terms.", "$0.50 per check", "2026-11-21 09:00", "Vera"]);
    expect(rows("terms-versions")[1].slice(0, 4)).toEqual(["v1", "Not kept", "Not kept", "Not kept"]);
    expect(table("terms-versions").querySelector("a")!.getAttribute("href")).toBe("https://example.com/terms-v2.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Set standard terms" }));
    expect(asked).toEqual(["terms"]);
  });

  it("lists who subscribes: firm, app, the terms version accepted, since, live or sandbox, and the agreement", () => {
    tab("subscribers");
    expect(head("subscribers")).toEqual(["Firm", "App", "Terms version accepted", "Since", "Live / sandbox", "Agreement status"]);
    expect(rows("subscribers")).toEqual([
      ["Lead Trust", "Budgeting", "v2", "2026-11-23 08:00", "Live", "in force"],
      ["Harbor Bank", "Not named", "Before standard terms", "2026-11-24 08:00", "Sandbox", "No agreement recorded"],
    ]);
  });

  it("lists the activity: When, What, Detail, By", () => {
    tab("activity");
    expect(head("activity")).toEqual(["When", "What", "Detail", "By"]);
    expect(rows("activity")).toEqual([
      ["2026-11-22 10:00", "Mynt tested the new build", "Failed", "Mynt"],
      ["2026-11-19 10:00", "Service created", "—", "Vera"],
    ]);
  });
});

describe("Reliability", () => {
  it("says Not measured with the reason for what Mynt doesn't record, and never shows a 0 for it", () => {
    const { container } = tab("reliability");
    expect(fact("Calls")).toBe("Not measured: No subscriber called it in the last 30 days");
    expect(fact("Error rate")).toBe("Not measured: No subscriber called it in the last 30 days");
    expect(fact("Response time")).toBe("Not measured: Mynt doesn't record how long each subscriber's call took, only whether it succeeded");
    expect(fact("In Mynt's last conformance run")).toBe("Median 42 ms, slowest 90 ms over 3 requests (2026-11-22 10:00)");
    expect([...container.querySelectorAll("[data-measured]")].map((m) => m.getAttribute("data-measured"))).toEqual(["no", "no", "no"]);
    // No figure stands in for a missing measurement: not "0", "0%" or "0 ms" anywhere in the card.
    const card = container.querySelector('[data-metadata-card="reliability"]')!;
    for (const dd of card.querySelectorAll("dd")) expect(dd.textContent).not.toMatch(/^0(\.0)?(%| ms)?$/);
    expect(rows("by-day")).toEqual([["Not measured: No subscriber called it in the last 30 days"]]);
    expect(rows("incidents")).toEqual([["2026-11-22 10:00", "Mynt's conformance test failed"]]);
  });

  it("shows what Mynt did measure, by day", () => {
    tab(
      "reliability",
      service({
        reliability: {
          ...REPLY.reliability,
          calls: { value: 40 },
          error_rate: { value: 0.025 },
          by_day: [{ day: "2026-11-24", environment: "live", calls: 40, errors: 1, error_rate: 0.025 }],
          incidents: [],
        },
      }),
    );
    expect(fact("Calls")).toBe("40");
    expect(fact("Error rate")).toBe("2.5%");
    expect(fact("Response time")).toContain("Not measured");
    expect(head("by-day")).toEqual(["Day", "Live / sandbox", "Calls", "Errors", "Error rate"]);
    expect(rows("by-day")).toEqual([["2026-11-24", "Live", "40", "1", "2.5%"]]);
    expect(rows("incidents")).toEqual([["No incidents in the last 30 days."]]);
  });
});

describe("the checklist", () => {
  const actionOf = (key: string) => document.querySelector(`[data-step="${key}"] [data-service-action]`);
  it("shows each step's status in words and the labelled action it maps to", () => {
    const asked: string[] = [];
    render(<ServiceChecklist service={service()} onAction={(a) => void asked.push(a)} />);
    expect(document.querySelector("[data-checklist-progress]")!.textContent).toBe("3 of 6 steps done");
    expect([...document.querySelectorAll("[data-step]")].map((li) => [li.getAttribute("data-step"), li.querySelector("[data-step-status]")!.textContent, actionOf(li.getAttribute("data-step")!)?.textContent ?? null])).toEqual([
      ["vendor_role", "Done", null],
      ["app_online", "Done", null],
      ["service_endpoint", "Do this next", "Ask the builder to add it"],
      ["practice", "Done", "Run practice test"],
      ["conformance", "Not started", "Run conformance"],
      ["terms", "Done", null],
      ["listed", "Not started", "Move to production"],
    ]);
    for (const key of ["service_endpoint", "practice", "conformance", "listed"]) fireEvent.click(actionOf(key)!);
    expect(asked).toEqual(["builder", "practice", "conformance", "production"]);
  });

  it("maps the remaining steps: Put online, Set standard terms, Restore, and Ask a Mynt admin for the role", () => {
    const sv = service({
      stage: "idea",
      checklist: [
        { ...step("vendor_role", "blocked", "invite_user"), by: "admin", detail: "Ask a Mynt admin for the vendor role." },
        step("app_online", "next", "deploy_app"),
        step("conformance", "blocked", "run_conformance"),
        step("terms", "not_started", "update_vendor_offering"),
        step("listed", "not_started", "promote_app"),
      ],
    });
    render(<ServiceChecklist service={sv} onAction={noAction} />);
    expect(document.querySelector('[data-step="vendor_role"] [data-step-ask-admin]')!.textContent).toBe("Ask a Mynt admin");
    expect(actionOf("vendor_role")).toBeNull();
    expect(actionOf("app_online")!.textContent).toBe("Put online");
    expect(actionOf("conformance")).toBeNull(); // waiting: nothing to press
    expect(actionOf("terms")!.textContent).toBe("Set standard terms");
    // A service in Ideas goes to Staging first: the button says where it goes.
    expect(stageActionLabel(sv)).toBe("Move to staging");
    expect(actionOf("listed")!.textContent).toBe("Move to staging");
    expect(s.serviceStepAction({ ...sv.checklist[1], tool: "archive_service" })).toBe("restore");
    expect(s.SERVICE_STEP_LABELS).toMatchObject({ online: "Put online", practice: "Run practice test", conformance: "Run conformance", terms: "Set standard terms", production: "Move to production", builder: "Ask the builder to add it" });
    expect(s.builderEndpointMessage("Identity verification")).toBe("Add Mynt's vendor service endpoint for Identity verification");
  });
});

describe("the header", () => {
  const header = (sv: ServiceView | null, onAction: (a: string) => void = noAction) => render(withProviders(<ServiceHeader service={sv} onAction={onAction} onBack={noAction} />));
  it("shows the stage and the offering's status in words, with labelled Archive", () => {
    const asked: string[] = [];
    header(service(), (a) => void asked.push(a));
    expect(document.querySelector("[data-service-name]")!.textContent).toBe("Swift ID");
    expect(document.querySelector("[data-service-stage]")!.getAttribute("data-service-stage")).toBe("staging");
    expect(document.querySelector("[data-service-status]")!.textContent).toBe("Needs conformance");
    const archive = document.querySelector("[data-service-archive]")!;
    expect(archive.textContent).toBe("Archive");
    fireEvent.click(archive);
    expect(asked).toEqual(["archive"]);
    expect(document.querySelector("[data-service-restore]")).toBeNull();
  });

  it("an archived service offers Restore, and no stage or hosting actions", () => {
    const asked: string[] = [];
    header(service({ archived: true, offering: { ...REPLY.offering, status: "suspended", status_words: "Archived" } }), (a) => void asked.push(a));
    expect(document.querySelector("[data-service-status]")!.textContent).toBe("Archived");
    const restore = document.querySelector("[data-service-restore]")!;
    expect(restore.textContent).toBe("Restore");
    fireEvent.click(restore);
    expect(asked).toEqual(["restore"]);
    expect(document.querySelector("[data-service-archive]")).toBeNull();
    expect(document.querySelector("[data-stage-control]")).toBeNull();
  });

  it("says it's loading until the service is read", () => {
    header(null);
    expect(document.querySelector("[data-service-name]")!.textContent).toBe("Loading service…");
  });
});

describe("the workspace", () => {
  const open = async () => {
    render(
      withProviders(
        <ServiceWorkspace serviceId="svc-1" isMobile={false}>
          <p data-chat>the builder chat</p>
        </ServiceWorkspace>,
      ),
    );
    await settle();
    await settle();
  };
  const panelTab = (t: string) => document.querySelector(`[data-panel-tab="${t}"]`) as HTMLElement;

  it("is the chat beside the service's tabs: no Products, Agreements, Customers, P&L, SDK or preview", async () => {
    await open();
    expect(document.querySelector("[data-chat]")!.textContent).toBe("the builder chat");
    expect([...document.querySelectorAll("[data-panel-tab]")].map((t) => t.textContent)).toEqual(["Overview", "Contract", "Conformance", "Terms & pricing", "Subscribers", "Reliability", "Security & risk", "Activity"]);
    expect(document.querySelector("[data-service-header] [data-service-status]")!.textContent).toBe("Needs conformance");
    expect(document.querySelector("[data-service-overview] [data-service-checklist]")).not.toBeNull();
    expect(fact("Endpoint")).toBe("POST https://swift-id.example.com/mynt/services/identity_verification");
    await act(async () => void fireEvent.click(panelTab("reliability")));
    expect(fact("Calls")).toContain("Not measured");
  });

  it("Archive opens a confirm sheet and posts to the service's route", async () => {
    await open();
    await act(async () => void fireEvent.click(document.querySelector("[data-service-archive]")!));
    const sheet = document.querySelector('[data-admin-sheet="archive-service"]') as HTMLElement;
    expect(sheet.textContent).toContain("Archive service");
    expect(sheet.textContent).toContain("comes off the Marketplace");
    expect(sheet.textContent).toContain("2 subscriptions");
    expect(posted).toEqual([]); // nothing until confirmed
    fireEvent.change(sheet.querySelector("[data-archive-reason]")!, { target: { value: "Replaced by v2" } });
    await act(async () => void fireEvent.submit(sheet.querySelector("[data-archive-service-form]")!));
    await settle();
    expect(posted).toEqual([{ url: "/api/services/svc-1", body: { archived: true, reason: "Replaced by v2" } }]);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toContain("Archived.");
  });

  it("Run conformance opens My services' sheet for the service's offering, in the service's words", async () => {
    await open();
    await act(async () => void fireEvent.click(panelTab("conformance")));
    await act(async () => void fireEvent.click(within(document.querySelector("[data-service-conformance] [data-tab-actions]") as HTMLElement).getByRole("button", { name: "Run conformance" })));
    const sheet = document.querySelector('[data-admin-sheet="run-conformance"]') as HTMLElement;
    expect(sheet.textContent).toContain("at its hosted address");
    expect(sheet.querySelector("[data-conformance-credential]")).toBeNull();
    await act(async () => void fireEvent.submit(sheet.querySelector("[data-conformance-form]")!));
    await settle();
    expect(posted).toEqual([{ url: `/api/vendor/offerings/${OFF}/conformance`, body: {} }]);
  });

  it("the checklist's actions reach the page: the builder gets the prepared message, Put online and the promotion sheet are asked for", async () => {
    await open();
    const heard: { type: string; detail: unknown }[] = [];
    const listen = (e: Event) => void heard.push({ type: e.type, detail: (e as CustomEvent).detail });
    for (const type of [s.BUILDER_MESSAGE_EVENT, PUT_ONLINE_EVENT, OPEN_PROMOTION_EVENT]) window.addEventListener(type, listen);
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Ask the builder to add it" })));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Move to production" })));
    for (const type of [s.BUILDER_MESSAGE_EVENT, PUT_ONLINE_EVENT, OPEN_PROMOTION_EVENT]) window.removeEventListener(type, listen);
    expect(heard).toEqual([
      { type: s.BUILDER_MESSAGE_EVENT, detail: { projectId: "svc-1", text: "Add Mynt's vendor service endpoint for Identity verification" } },
      { type: OPEN_PROMOTION_EVENT, detail: { appId: "svc-1" } },
    ]);
  });

  it("says so when the service can't be read", async () => {
    vi.stubGlobal("fetch", async () => ok({ error: "not_found", message: "That isn't one of your services." }, 404));
    await open();
    expect(screen.getByRole("alert").textContent).toBe("That isn't one of your services.");
    expect(document.querySelector("[data-service-name]")!.textContent).toBe("Service");
  });
});

describe("Transcripts, a new build beside the serving one, sandbox testing, and what is the firm's", () => {
  const SECRET = `mvs_${"s".repeat(43)}`;
  const exchange = (name: string, status: number, body: unknown) => ({
    case: name,
    request: { method: "POST", path: "/mynt/services/identity_verification", headers: { "Content-Type": "application/json", "User-Agent": "Mynt-Vendor-Client/1", "Mynt-Signature": "t=1764000000,v1=<redacted>" }, body: { request_id: "r-1", environment: "test", input: { full_name: "Ada Lovelace" } } },
    response: { http_status: status, body },
    expected: name === "fixture_1" ? '200 with the same request_id, status "ok" and an output valid against the service type\'s output schema.' : "Refused: 401.",
  });
  const TRANSCRIPT = [exchange("fixture_1", 200, { request_id: "r-1", status: "ok", output: { verified: true } }), exchange("bad_signature_refused", 401, { error: "bad_signature" })];
  const withTranscripts = () =>
    service({
      conformance: {
        needed: false,
        tested_build_id: BUILD,
        runs: [
          { ...REPLY.conformance.runs[0], total_cases: 2, passed_cases: 2, cases: [], transcript: TRANSCRIPT },
          { ...REPLY.conformance.runs[1], transcript: TRANSCRIPT, build_id: BUILD },
          { ...REPLY.conformance.runs[2], transcript: null, transcript_note: "Not recorded: this run is from before Mynt kept transcripts" },
        ],
      },
    });
  const transcriptRows = (sheet: HTMLElement) => [...sheet.querySelectorAll("[data-run-transcript] tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));

  it("a real run's row opens its cases and then its transcript, as a table", async () => {
    tab("conformance", withTranscripts());
    expect(rows("runs").map((r) => r[2])).toEqual(["Not recorded", "77777777", "Not recorded"]);
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="c2"]')!));
    const sheet = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    expect([...sheet.querySelectorAll("[data-run-transcript] thead th")].map((h) => h.textContent)).toEqual(["Case", "Mynt sent", "It answered", "Mynt expected"]);
    const t = transcriptRows(sheet);
    expect(t.map((r) => r[0])).toEqual(["fixture 1", "bad signature refused"]);
    expect(t[0][1]).toContain("POST /mynt/services/identity_verification");
    expect(t[0][1]).toContain("Mynt-Signature: t=1764000000,v1=<redacted>");
    expect(t[0][1]).toContain('"full_name": "Ada Lovelace"');
    expect(t[0][2]).toContain("HTTP 200");
    expect(t[0][2]).toContain('"verified": true');
    expect(t[1][2]).toContain("HTTP 401");
    expect(t[0][3]).toContain("200 with the same request_id");
    expect(sheet.textContent).toContain("The signing secret, the signature's digest and any credential are left out");
  });

  it("a practice run's row opens its transcript too, with no pointer elsewhere", async () => {
    tab("conformance", withTranscripts());
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="p2"]')!));
    const sheet = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    expect(sheet.textContent).toContain("It never counts as conformance");
    expect(transcriptRows(sheet).map((r) => r[0])).toEqual(["fixture 1", "bad signature refused"]);
    expect(sheet.querySelector("[data-practice-transcript-note]")).toBeNull();
  });

  it("a run from before transcripts were kept says so, and shows no empty transcript", async () => {
    tab("conformance", withTranscripts());
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="c1"]')!));
    const sheet = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    expect(sheet.querySelector("[data-run-transcript]")).toBeNull();
    expect(sheet.querySelector("[data-transcript-note]")!.textContent).toBe("Transcript: Not recorded: this run is from before Mynt kept transcripts");
  });

  it("never shows a signing secret, a key, a bearer credential or a signature's digest, even if a reply carried one", async () => {
    const leaky = service({
      conformance: {
        needed: false,
        tested_build_id: null,
        runs: [
          {
            ...REPLY.conformance.runs[1],
            transcript: [
              {
                ...TRANSCRIPT[0],
                request: { ...TRANSCRIPT[0].request, headers: { "Mynt-Signature": `t=1764000000,v1=${"ab".repeat(32)}`, Authorization: "Bearer abcdefghijklmnop" } },
                response: { http_status: 200, body: { debug: { secret: SECRET, key: "mynt_test_abcdefghijkl" } } },
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(leaky)).not.toContain(SECRET);
    const { container } = tab("conformance", leaky);
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="c2"]')!));
    const sheet = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    const text = `${container.textContent}${sheet.textContent}`;
    expect(text).not.toMatch(/mvs_|mynt_test_abc|abcdefghijklmnop|v1=[0-9a-f]{32}/);
    expect(sheet.textContent).toContain("v1=<redacted>");
    expect(sheet.textContent).toContain('"secret": "<redacted>"');
  });

  it("shows a new build being tested beside the serving one, and one that didn't take over, plainly", async () => {
    const sv = service({
      stage: "production",
      offering: { ...REPLY.offering, status: "listed", status_words: "Listed in the Marketplace" },
      hosted: { status: "running", online: true, build_id: BUILD, address: "https://x.example.com" },
      new_build: { build_id: "99999999-0000-4000-8000-000000000000", status: "testing", status_words: "Being tested by Mynt", serving_build_id: BUILD, note: "The serving build keeps answering. Mynt switches to this build only if it passes; otherwise it is removed." },
      conformance: {
        needed: false,
        tested_build_id: BUILD,
        runs: [
          {
            run_id: "n1",
            kind: "conformance",
            passed: false,
            at: "2026-11-26T10:00:00Z",
            run_by: null,
            failures: [{ case: "fixture_1", problems: ["output /score must be integer"] }],
            cases: [{ case: "fixture_1", passed: false, http_status: 200, problems: ["output /score must be integer"] }],
            passed_cases: 0,
            total_cases: 1,
            transcript: [TRANSCRIPT[0]],
            build_id: "88888888-0000-4000-8000-000000000000",
            new_build: true,
            switched: false,
            outcome: "Mynt's conformance test failed on it. It was removed; the build that was serving kept serving",
          },
          {
            run_id: "n0",
            kind: "conformance",
            passed: false,
            at: "2026-11-25T12:00:00Z",
            run_by: null,
            failures: [],
            cases: [],
            passed_cases: 0,
            total_cases: 0,
            transcript: null,
            transcript_note: "Nothing was sent: the build never answered, so there was nothing to test",
            build_id: "66666666-0000-4000-8000-000000000000",
            new_build: true,
            switched: false,
            outcome: "The build didn't start on Mynt's hosting, so there was nothing to test. It was removed; the build that was serving kept serving",
          },
          { ...REPLY.conformance.runs[2], run_id: "c9", at: "2026-11-25T10:00:00Z", build_id: BUILD },
        ],
      },
    });
    tab("conformance", sv);
    expect(rows("runs")).toEqual([
      ["2026-11-26 10:00", "Conformance, new build", "88888888", "Didn't pass: removed", "0 of 1", "Mynt"],
      ["2026-11-25 12:00", "Conformance, new build", "66666666", "Didn't pass: removed", "None run", "Mynt"],
      ["2026-11-25 10:00", "Conformance", "77777777", "Passed", "1 of 1", "Vera"],
    ]);
    // The run that stands is the serving build's, not the failed new build's.
    expect(fact("Last real run")).toBe("Passed 2026-11-25 10:00");
    expect(fact("Build tested")).toBe("77777777");
    expect(fact("New build")).toBe("99999999 · Being tested by Mynt");
    expect(fact("Last new build that didn't take over")).toBe("88888888 · 2026-11-26 10:00");
    await act(async () => void fireEvent.click(document.querySelector('[data-open-run="n1"]')!));
    const sheet = document.querySelector('[data-admin-sheet="service-run"]') as HTMLElement;
    expect(sheet.textContent).toContain("Conformance run on a new build");
    expect(sheet.querySelector("[data-run-outcome]")!.textContent).toBe("Mynt's conformance test failed on it. It was removed; the build that was serving kept serving");
    cleanup();
    tab("overview", sv);
    expect(fact("Status")).toBe("Listed in the Marketplace");
    expect(fact("Build serving")).toBe("77777777");
    expect(fact("New build")).toBe("99999999 · Being tested by Mynt");
    expect(document.querySelector("[data-new-build-note]")!.textContent).toContain("Build 99999999 is online beside build 77777777. The serving build keeps answering.");
  });

  it("says when a service in Staging is open to sandbox testing, with the offering id to share", () => {
    const open = service({
      stage: "staging",
      testing: { open: true, offering_id: OFF, words: "In testing: sandbox only until its builder moves it to Production", how: "Give this offering id to a builder who should test it." },
    });
    tab("overview", open);
    expect(document.querySelector('[data-sandbox-testing="open"]')!.textContent).toBe(`Open. Offering id ${OFF}`);
    expect(document.querySelector("[data-sandbox-testing-note]")!.textContent).toBe("In testing: sandbox only until its builder moves it to Production. Give this offering id to a builder who should test it.");
    cleanup();
    tab("overview", service({ testing: { open: false, offering_id: OFF, words: "Opens once the service is in Staging and a build has passed Mynt's conformance test" } }));
    expect(document.querySelector('[data-sandbox-testing="closed"]')!.textContent).toBe("Opens once the service is in Staging and a build has passed Mynt's conformance test");
    expect(document.querySelector("[data-sandbox-testing-note]")).toBeNull();
  });

  it("a member from another firm isn't shown who subscribes: Not shown with the reason, never 0", () => {
    const outside = service({ subscribers: null, checklist: [], progress: { done: 0, total: 0 }, firm_only: "Who subscribes and what is left to list it are shown to Swift ID Ltd's people only" });
    expect(outside.subscribers).toEqual([]);
    tab("subscribers", outside);
    expect(fact("Subscriptions")).toBe("Not shown");
    expect(fact("Live")).toBe("Not shown");
    expect(rows("subscribers")).toEqual([["Not available. Who subscribes and what is left to list it are shown to Swift ID Ltd's people only"]]);
    cleanup();
    tab("overview", outside);
    expect(document.querySelector("[data-firm-only]")!.textContent).toBe("Who subscribes and what is left to list it are shown to Swift ID Ltd's people only");
  });
});
