// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { appProductsFrom, buildsFrom, buildStatusLabel, buildTone, eventsFrom, fromAgreements, fromCustomers, fromPnl, NOT_YET, updatedAgo, type AppActivity, type AppAgreements, type AppCustomers, type AppProducts, type AppSdk, type AppSecurity } from "@/lib/app-panel";
import { ProjectConversationsProvider } from "@/lib/project-conversations-context";
import { parseStudioCall } from "@/lib/studio-tools";

// An app's information tabs (Products, Agreements, Customers, Security & risk, P&L, SDK, Activity; no Licences tab: an app
// holds no licences, its products do): what each shows with data,
// with none, and before Mynt has its tool; that every read is for this app only; and that they're live.

const APP = "a1";
const OTHER = "a2";
const WS = "w1";
const fake = {
  session: undefined as Session | undefined,
  tools: [] as { name: string; inputSchema?: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
};
const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const ALL = [
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "get_product", inputSchema: props("id") },
  { name: "get_compliance_coverage", inputSchema: props("workspace_id") },
  { name: "get_promotion_checks", inputSchema: props("app_id", "to_stage") },
  { name: "list_workspace_audit", inputSchema: props("workspace_id", "app_id", "class") },
  { name: "list_builds", inputSchema: props("app_id") },
  { name: "get_product_sdk", inputSchema: props("product_id") },
  { name: "get_workspace_pnl", inputSchema: props("workspace_id", "app_id") },
  { name: "list_app_agreements", inputSchema: props("app_id", "status") },
  { name: "get_app_customers", inputSchema: props("app_id") },
];
const SPONSOR = "11111111-1111-4111-8111-111111111111";
// Security & risk before Mynt has risk registers: the register and every signal say so.
const NOT_HERE = { available: false as const, reason: "Risk registers come with Mynt's next update." };
const NO_RISK = { register: NOT_HERE, signals: { fraud: NOT_HERE, vendors: NOT_HERE, conduct: NOT_HERE, products: NOT_HERE } };
const AGREEMENTS = {
  app: { id: APP, name: "Cards" },
  can_manage: true,
  agreements: [
    { id: "g1", kind: "program", status: "accepted", counterparty: { entity_id: SPONSOR, name: "Lead Bank" }, products: [{ id: "p1", name: "Card" }], effective_from: "2026-12-01", effective_to: null, signatures: { app_side: true, counterparty_side: false } },
    { id: "g2", kind: "data_sharing", status: "terminated", counterparty: { entity_id: SPONSOR, name: "Lead Bank" }, products: [], effective_from: null, effective_to: null, signatures: { app_side: false, counterparty_side: false } },
  ],
  products: [
    { id: "p1", name: "Card", stage: "production", sponsors: [{ entity_id: SPONSOR, name: "Lead Bank", jurisdictions: ["us-ny", "us-ca"] }], states: ["us-ca", "us-ny"] },
    { id: "p2", name: "Savings", stage: "staging", sponsors: [], states: [] },
  ],
  vendor_contracts: [{ subscription_id: "v1", vendor: { entity_id: "e9", name: "KYC Works" }, offering: "Identity check", service_type: "kyc", environment: "test", since: "2026-11-01T00:00:00.000Z" }],
  introductions: [{ id: "i1", status: "proposed", counterparty: null, since: "2026-11-10T00:00:00.000Z" }],
};
const CUSTOMERS = {
  app: { id: APP, name: "Cards" },
  can_manage: true,
  products: [
    { id: "p1", name: "Card", segments: [{ id: "retail", name: "Retail savers", customer_kind: "individual", targeted: true }, { id: "students", name: "Students", customer_kind: null, targeted: false }] },
    { id: "p2", name: "Savings", segments: [] },
  ],
  customers: {
    live: { customers_with_sessions: null, customers_in_vault: null, reason: "No live client sessions yet, so Mynt hasn't measured customers here" },
    sandbox: { customers_with_sessions: 3, customers_in_vault: 2, reason: null },
  },
};
const PNL = {
  series: [
    { start: "2026-10-01T00:00:00.000Z", revenue_cents: 50_000, costs_cents: 20_000, net_cents: 30_000 },
    { start: "2026-11-01T00:00:00.000Z", revenue_cents: null, costs_cents: 10_000, net_cents: null },
  ],
  statement: {
    columns: [{ key: "this_period", label: "This month (Nov)" }, { key: "year_to_date", label: "2026 to date" }],
    revenue: [{ key: "settled", label: "Money settled", values: { this_period: null, year_to_date: 50_000 }, measured: false }],
    costs: [{ key: "builds", label: "Builds", values: { this_period: 10_000, year_to_date: 30_000 }, measured: true }],
    totals: { revenue: { this_period: null, year_to_date: 50_000 }, costs: { this_period: 10_000, year_to_date: 30_000 }, net: { this_period: null, year_to_date: 20_000 } },
  },
  unmeasured: [{ key: "fees", label: "Take-rate fees", reason: "Mynt doesn't record fees charged yet" }],
};
const COVERAGE = {
  states: [
    { code: "us-ny", name: "New York", status: "unlocked", products: [{ id: "p1", name: "Card" }, { id: "p2", name: "Savings" }], licences: [{ type: "MTL", regulator: "NYDFS", number: "1", status: "active" }] },
    { code: "us-ca", name: "California", status: "unlocked", products: [{ id: "p1", name: "Card" }], licences: [{ type: "MTL", regulator: "DFPI", number: "2", status: "active" }] },
    // Another app's product only: never shown for this app.
    { code: "us-tx", name: "Texas", status: "unlocked", products: [{ id: "p9", name: "Other" }], licences: [{ type: "MTL", regulator: "TDB", number: "9" }] },
  ],
};

vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => true, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      switch (name) {
        case "list_my_apps":
          return ok([
            { id: APP, name: "Cards", workspace_id: WS, stage: "staging", product_ids: ["p1", "p2"] },
            { id: OTHER, name: "Other", workspace_id: WS, stage: "idea", product_ids: ["p9"] },
          ]);
        case "get_product":
          return ok({ id: args.id, name: args.id === "p1" ? "Card" : "Savings" });
        case "get_compliance_coverage":
          return ok(COVERAGE);
        case "get_promotion_checks":
          return ok({
            app_id: APP,
            from_stage: "staging",
            to_stage: "production",
            can_promote: false,
            checks: [
              { id: "build_verified", label: "Latest build verified", status: "pass" },
              { id: "audit_findings", label: "No open critical findings", status: "fail", detail: "1 high finding" },
              { id: "licences", label: "Every product licensed where the app serves", status: "fail", detail: "Savings isn't covered in California", fix: { label: "See licences", href: "/licences" } },
              { id: "webhooks", label: "Webhooks verified", status: "pass" },
            ],
          });
        case "list_workspace_audit":
          return ok({ events: [{ at: "2026-11-13T10:00:00Z", action: "api_key_created", actor: { name: "Ines" }, target: { type: "app", id: APP } }, { at: "2026-11-13T11:00:00Z", action: "api_key_created", target: { type: "app", id: OTHER } }] });
        case "list_builds":
          return ok({ builds: [{ id: "b1", app_id: APP, status: "succeeded", goal: "Add a card screen", created_at: "2026-11-12T00:00:00Z" }, { id: "b9", app_id: OTHER, status: "failed" }] });
        case "get_product_sdk":
          return ok({ product: { id: args.product_id, name: args.product_id === "p1" ? "Card" : "Savings" }, version: 3, action: "issuance", access: { status: "public" }, contract: null, integration: { data_shape: { name: "string", apr: "number" }, actions: { deep_link: "permitted", initiate_onboarding: "not permitted" }, hand_off: "Onboarding happens in the innovator's flow." } });
        case "get_workspace_pnl":
          return ok(PNL);
        case "list_app_agreements":
          return ok(AGREEMENTS);
        case "get_app_customers":
          return ok(CUSTOMERS);
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const route = await import("@/app/api/apps/[appId]/panel/route");
const views = await import("@/components/app-panel-tabs");
const { ProjectWelcome } = await import("@/components/assistant-ui/project-welcome");

const get = async (tab: string, app = APP) => {
  const res = await route.GET(new Request(`http://localhost:3000/api/apps/${app}/panel?tab=${tab}`), { params: Promise.resolve({ appId: app }) });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> & { available: boolean } } };
};
// Every call after the app lookup names this app, its products or its workspace, never another app.
const scoped = () => {
  for (const c of fake.calls.filter((c) => c.name !== "list_my_apps")) {
    const text = JSON.stringify(c.args);
    expect(text, c.name).not.toContain(OTHER);
    expect(text, c.name).not.toContain("p9");
  }
};

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.tools = ALL;
  fake.calls = [];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the app panel route", () => {
  it("refuses another user's app and an unknown tab", async () => {
    expect((await get("pnl", "not-mine")).status).toBe(404);
    expect((await get("promote")).status).toBe(400);
    expect((await get("preview")).status).toBe(400);
  });

  it("P&L: this app's, from get_workspace_pnl; not available yet without the tool", async () => {
    const { body } = await get("pnl");
    expect(fake.calls.find((c) => c.name === "get_workspace_pnl")?.args).toEqual({ workspace_id: WS, granularity: "month", periods: 6, app_id: APP });
    expect(body.data).toMatchObject({ available: true, unmeasured: [{ label: "Take-rate fees" }] });
    scoped();
    fake.tools = ALL.filter((t) => t.name !== "get_workspace_pnl");
    expect((await get("pnl")).body.data).toEqual({ available: false, reason: "The app's P&L comes with Mynt's next update." });
  });

  it("Products: this app's products with their stage, sponsors and states, and the production licences check; no Licences tab", async () => {
    expect((await get("licences")).status).toBe(400);
    const data = (await get("products")).body.data as unknown as AppProducts;
    expect(fake.calls.find((c) => c.name === "list_app_agreements")?.args).toEqual({ app_id: APP });
    expect(data.products.map((p) => [p.name, p.stage, p.sponsors.map((x) => x.name), p.states])).toEqual([
      ["Card", "production", ["Lead Bank"], ["us-ca", "us-ny"]],
      ["Savings", "staging", [], []],
    ]);
    expect(data.productionCheck?.detail).toBe("Savings isn't covered in California");
    scoped();
    fake.tools = ALL.filter((t) => t.name !== "list_app_agreements");
    expect((await get("products")).body.data?.available).toBe(false);
  });

  it("Agreements: this app's agreements, vendor contracts and introductions, and the sponsors to propose to", async () => {
    const data = (await get("agreements")).body.data as unknown as AppAgreements;
    expect(fake.calls.find((c) => c.name === "list_app_agreements")?.args).toEqual({ app_id: APP });
    expect(data.agreements.map((a) => [a.counterparty, a.kind, a.status, a.products])).toEqual([
      ["Lead Bank", "Program agreement", "Accepted: waiting for signatures", ["Card"]],
      ["Lead Bank", "Data sharing", "Ended", []],
    ]);
    expect(data.sponsors).toEqual([{ entityId: SPONSOR, name: "Lead Bank", productIds: ["p1"] }]);
    expect(data.vendorContracts.map((v) => v.vendor)).toEqual(["KYC Works"]);
    expect(data.introductions?.map((i) => i.status)).toEqual(["Asked: waiting for both to say yes"]);
    scoped();
    fake.tools = ALL.filter((t) => t.name !== "list_app_agreements");
    expect((await get("agreements")).body.data).toEqual({ available: false, reason: "Agreements come with Mynt's next update." });
  });

  it("Customers: the personas from this app's products, and counts only where measured", async () => {
    const data = (await get("customers")).body.data as unknown as AppCustomers;
    expect(fake.calls.find((c) => c.name === "get_app_customers")?.args).toEqual({ app_id: APP });
    expect(data.products[0].personas.map((s) => [s.id, s.targeted])).toEqual([["retail", true], ["students", false]]);
    expect(data.live).toEqual({ withSessions: null, inVault: null, reason: "No live client sessions yet, so Mynt hasn't measured customers here" });
    expect(data.sandbox.withSessions).toBe(3);
    scoped();
  });

  it("Security: Mynt's security-class events for this app, and its build checks; without classes it says so", async () => {
    const { body } = await get("security");
    const data = body.data as unknown as AppSecurity;
    expect(fake.calls.find((c) => c.name === "list_workspace_audit")?.args).toEqual({ workspace_id: WS, app_id: APP, class: "security" });
    expect(data.events?.map((e) => e.action)).toEqual(["api_key_created"]); // the other app's event is dropped
    expect(data.checks.map((c) => c.id)).toEqual(["build_verified", "audit_findings"]);
    // Without list_risks on this Mynt, the register and its signals are not available yet, with why.
    expect(data.register).toEqual({ available: false, reason: "Risk registers come with Mynt's next update." });
    expect(data.signals.fraud.available).toBe(false);
    scoped();
    fake.tools = ALL.map((t) => (t.name === "list_workspace_audit" ? { ...t, inputSchema: props("workspace_id", "app_id") } : t));
    fake.calls = [];
    const before = (await get("security")).body.data as unknown as AppSecurity;
    expect(before.events).toBeNull();
    expect(before.eventsReason).toContain("next update");
    expect(fake.calls.some((c) => c.name === "list_workspace_audit")).toBe(false);
    expect(before.checks).toHaveLength(2);
  });

  it("SDK: each of this app's products' integration kit", async () => {
    const data = (await get("sdk")).body.data as unknown as AppSdk;
    expect(fake.calls.filter((c) => c.name === "get_product_sdk").map((c) => c.args)).toEqual([{ product_id: "p1" }, { product_id: "p2" }]);
    expect(data.products[0]).toMatchObject({ name: "Card", version: "3", permitted: ["deep_link"], fields: ["name", "apr"], hasContract: false });
    fake.tools = ALL.filter((t) => t.name !== "get_product_sdk");
    expect((await get("sdk")).body.data?.available).toBe(false);
  });

  it("Activity: this app's builds and events", async () => {
    const data = (await get("activity")).body.data as unknown as AppActivity;
    expect(fake.calls.find((c) => c.name === "list_builds")?.args).toEqual({ app_id: APP });
    expect(fake.calls.find((c) => c.name === "list_workspace_audit")?.args).toEqual({ workspace_id: WS, app_id: APP });
    expect(data.builds?.map((b) => b.id)).toEqual(["b1"]);
    expect(data.events?.map((e) => e.action)).toEqual(["api_key_created"]);
    scoped();
    fake.tools = [{ name: "list_my_apps" }];
    expect((await get("activity")).body.data?.available).toBe(false);
  });

  it("the allow-list takes the new reads strictly", () => {
    expect(parseStudioCall("get_workspace_pnl", { workspace_id: WS, granularity: "month", periods: 6, app_id: APP })).toHaveProperty("tool");
    expect(parseStudioCall("get_workspace_pnl", { app_id: APP })).toHaveProperty("error");
    expect(parseStudioCall("get_product_sdk", { product_id: "p1" })).toHaveProperty("tool");
    expect(parseStudioCall("list_workspace_audit", { app_id: APP, class: "security" })).toHaveProperty("tool");
    expect(parseStudioCall("list_workspace_audit", { app_id: APP, class: "everything" })).toHaveProperty("error");
    expect(parseStudioCall("list_app_agreements", { app_id: APP })).toHaveProperty("tool");
    expect(parseStudioCall("list_app_agreements", { app_id: APP, status: "whatever" })).toHaveProperty("error");
    expect(parseStudioCall("get_app_customers", { app_id: APP, extra: 1 })).toHaveProperty("error");
    expect(parseStudioCall("set_app_target_segments", { app_id: APP, segments: [{ product_id: "p1", segment_id: "retail" }] })).toHaveProperty("tool");
    expect(parseStudioCall("set_app_target_segments", { app_id: APP, segments: [{ product_id: "p1" }] })).toHaveProperty("error");
    const proposal = { app_id: APP, counterparty_entity_id: SPONSOR, kind: "program", products: ["p1"], terms_summary: "Lead Bank's card program" };
    expect(parseStudioCall("propose_app_agreement", proposal)).toHaveProperty("tool");
    expect(parseStudioCall("propose_app_agreement", { ...proposal, counterparty_entity_id: "not-a-firm" })).toHaveProperty("error");
    expect(parseStudioCall("propose_app_agreement", { ...proposal, kind: "licence" })).toHaveProperty("error");
    expect(parseStudioCall("propose_app_agreement", { ...proposal, document_url: "http://plain.example.com/x" })).toHaveProperty("error");
  });
});

describe("the tabs' content", () => {
  it("P&L: a chart and statement where an unmeasured figure says so, never 0", () => {
    const html = renderToStaticMarkup(<views.PnlView pnl={fromPnl(PNL)!} />);
    expect(html).toContain("Not measured");
    expect(html).toContain("$200.00"); // 2026 to date net
    expect(html).not.toContain("$0.00");
    expect(html).toContain("Take-rate fees: Mynt doesn&#x27;t record fees charged yet");
    expect(fromPnl({ nope: true })).toBeNull();
  });

  it("Products: each product links to its page, with stage, sponsor and states; an app with none says so", () => {
    const html = renderToStaticMarkup(<views.ProductsTabView data={{ available: true, products: appProductsFrom(AGREEMENTS), productionCheck: null }} />);
    expect(html).toContain('href="/products/p1"');
    expect(html).toContain("Lead Bank");
    expect(html).toContain("CA, NY");
    expect(html).toContain("No sponsor on record");
    expect(html).toMatch(/data-app-product="p2"[^]*Staging/);
    expect(renderToStaticMarkup(<views.ProductsTabView data={{ available: true, products: [], productionCheck: null }} />)).toContain("uses no financial products yet");
  });

  it("Agreements: rows with status in words, a labelled Propose agreement button for owners and admins only", () => {
    const data = fromAgreements(AGREEMENTS)!;
    const html = renderToStaticMarkup(<views.AgreementsTabView appId={APP} data={data} />);
    expect(html).toContain("Propose agreement");
    expect(html).toContain("data-propose-agreement");
    expect(html).toMatch(/data-agreement="g1" data-status="accepted"[^]*Accepted: waiting for signatures[^]*You signed; they haven&#x27;t signed/);
    expect(html).toContain("2026-12-01 to open-ended");
    expect(html).toContain("KYC Works");
    expect(html).toContain("Named once both say yes");
    expect(html).not.toContain('data-slot="badge"');
    const viewer = renderToStaticMarkup(<views.AgreementsTabView appId={APP} data={{ ...data, canManage: false, agreements: [], introductions: null }} />);
    expect(viewer).not.toContain("data-propose-agreement");
    expect(viewer).toContain("No agreements yet.");
    expect(viewer).toContain("business-development agent isn&#x27;t running here");
    expect(fromAgreements({ nope: true })).toBeNull();
  });

  it("Customers: counts read Not measured, never 0; targeted personas; a labelled Choose personas button", () => {
    const data = fromCustomers(CUSTOMERS)!;
    const html = renderToStaticMarkup(<views.CustomersTabView appId={APP} data={data} />);
    expect(html).toContain("Choose personas");
    expect(html).toContain("data-choose-personas");
    expect(html).toContain('data-targeted-persona="retail"');
    expect(html).not.toContain('data-targeted-persona="students"');
    expect(html).toContain("In the customer vault: Not measured live, 2 sandbox.");
    const el = document.createElement("div");
    el.innerHTML = html;
    expect(el.querySelector('[data-kpi="live-customers"] dd')?.textContent).toBe("Not measured");
    expect(el.querySelector('[data-kpi="sandbox-customers"] dd')?.textContent).toBe("3");
    expect(renderToStaticMarkup(<views.CustomersTabView appId={APP} data={{ ...data, canManage: false }} />)).not.toContain("data-choose-personas");
  });

  it("Security, SDK and Activity: empty and not-available-yet states", () => {
    expect(renderToStaticMarkup(<views.SecurityView data={{ available: true, ...NO_RISK, events: [], eventsReason: null, checks: [], checksReason: "The app is in production: there's no next stage to check it for" }} />)).toContain("No security events for this app.");
    expect(renderToStaticMarkup(<views.SecurityView data={{ available: true, ...NO_RISK, events: null, eventsReason: "Security events come with Mynt's next update", checks: [], checksReason: null }} />)).toContain("Not available yet. Security events come");
    expect(renderToStaticMarkup(<views.SdkView data={{ available: true, products: [] }} />)).toContain("uses no products yet");
    expect(renderToStaticMarkup(<views.ActivityView data={{ available: true, builds: [], events: [], eventsReason: null }} />)).toContain("No builds yet.");
    expect(renderToStaticMarkup(<views.InfoTabBody tab="pnl" data={NOT_YET("The app's P&L comes with Mynt's next update.")} />)).toContain("Not available yet. The app&#x27;s P&amp;L comes");
  });

  it("drops other apps' events and builds", () => {
    expect(eventsFrom({ events: [{ at: "x", action: "a", target: { type: "app", id: OTHER } }, { at: "y", action: "b", details: { app_id: OTHER } }, { at: "z", action: "c" }] }, APP).map((e) => e.action)).toEqual(["c"]);
    expect(buildsFrom({ builds: [{ id: "1", app_id: OTHER }, { id: "2", app_id: APP }] }, APP).map((b) => b.id)).toEqual(["2"]);
  });
});

describe("the tabs' layout, as the dashboard's", () => {
  const event = (i: number) => ({ at: `2026-11-${String(10 + (i % 10)).padStart(2, "0")}T10:00:00Z`, action: `action_${i}`, actor: "Ines", details: null });
  const build = (i: number, status = "succeeded") => ({ id: `b${i}`, status, goal: `Goal ${i}`, at: "2026-11-12T00:00:00Z" });
  const kpi = (html: string, key: string) => {
    const el = document.createElement("div");
    el.innerHTML = html;
    return el.querySelector(`[data-kpi="${key}"] dd`)?.textContent;
  };

  it("P&L: key figures this period (unmeasured reads Not measured, never 0), two charts and the statement in a box", () => {
    const html = renderToStaticMarkup(<views.PnlView pnl={fromPnl(PNL)!} />);
    expect(html).toContain('data-row="app-pnl-kpis"');
    expect(html).toContain("This month (Nov)");
    expect(kpi(html, "money-moved")).toBe("Not measured");
    expect(kpi(html, "costs")).toBe("$100.00");
    expect(kpi(html, "net")).toBe("Not measured");
    expect(html).toContain('data-section="app-pnl-revenue"');
    expect(html).toContain('data-section="app-pnl-costs"');
    expect(html).not.toContain('role="group"'); // no period or range controls on the charts
    expect(html).not.toContain("n/m");
    expect(html).toContain('rounded-lg border"><div data-slot="table-container"');
    expect(html).toContain('<h2 id="section-app-pnl-statement" class="text-sm font-semibold">Statement</h2>');
    expect(html).not.toContain("<h4");
    // Nothing measured: each chart says so instead of drawing zeros.
    const empty = fromPnl({ ...PNL, series: [{ start: "2026-11-01T00:00:00.000Z", revenue_cents: null, costs_cents: null, net_cents: null }] })!;
    expect(renderToStaticMarkup(<views.PnlView pnl={empty} />).match(/data-pnl-empty="unmeasured"/g)).toHaveLength(2);
  });

  it("Products: the production check as a section with a status dot, the table in a box", () => {
    const check = { id: "licences", label: "Every product licensed", status: "fail" as const, detail: "Savings isn't covered in California", fix: { label: "See licences", href: "/licences", external: false, tool: null } };
    const html = renderToStaticMarkup(<views.ProductsTabView data={{ available: true, products: appProductsFrom(AGREEMENTS), productionCheck: check }} />);
    expect(html).toContain('data-section="app-production-check"');
    expect(html).toMatch(/data-production-check="fail".*data-tone="red"/);
    expect(html).not.toContain('data-slot="badge"');
    expect(html).toContain('rounded-lg border"><div data-slot="table-container"');
  });

  it("Security: build checks as status dots, at most 10 events, View all to the security audits", () => {
    const data: AppSecurity = {
      available: true,
      ...NO_RISK,
      events: Array.from({ length: 14 }, (_, i) => event(i)),
      eventsReason: null,
      checks: [
        { id: "build_verified", label: "Latest build verified", status: "pass", detail: null, fix: null },
        { id: "audit_findings", label: "No open critical findings", status: "fail", detail: "1 high finding", fix: null },
      ],
      checksReason: null,
    };
    const html = renderToStaticMarkup(<views.SecurityView data={data} />);
    expect(html).toContain('<h2 id="section-app-build-checks" class="text-sm font-semibold">Build checks</h2>');
    expect(html).toMatch(/data-check="build_verified"[^]*data-tone="green"[^]*Passed/);
    expect(html).toMatch(/data-check="audit_findings"[^]*data-tone="red"[^]*Failing/);
    expect(html).not.toContain('data-slot="badge"');
    expect(html.match(/data-event=/g)).toHaveLength(10);
    expect(html).toContain('href="/audits?tab=security"');
  });

  it("SDK: each product is a panel with a section heading", () => {
    const data = { available: true as const, products: [{ productId: "p1", name: "Card", version: "3", action: "issuance", access: "public", permitted: ["deep_link"], notPermitted: [], fields: ["name"], handOff: null, generatedClients: null, hasContract: false, error: null }] };
    const html = renderToStaticMarkup(<views.SdkView data={data} />);
    expect(html).toContain('data-row="sdk-p1"');
    expect(html).toContain('<h2 id="section-sdk-p1" class="text-sm font-semibold">Card</h2>');
    expect(html).toContain("v3");
    expect(html).not.toContain("<h4");
  });

  it("Activity: at most 10 builds with status dots and View all to Builds; recent events with View all to the audits", () => {
    const html = renderToStaticMarkup(
      <views.ActivityView data={{ available: true, builds: [build(0, "failed"), ...Array.from({ length: 13 }, (_, i) => build(i + 1))], events: [event(1)], eventsReason: null }} />,
    );
    expect(html.match(/data-build=/g)).toHaveLength(10);
    expect(html).toMatch(/data-build="b0"[^]*data-tone="red"[^]*Failed/);
    expect(html).toContain('href="/builds"');
    expect(html).toContain('<h2 id="section-app-recent-events" class="text-sm font-semibold">Recent events</h2>');
    expect(html).toContain('href="/audits?tab=workspace"');
  });

  it("a build's status reads as a dot and a word", () => {
    expect(buildTone("succeeded")).toBe("green");
    expect(buildTone("failed")).toBe("red");
    expect(buildTone("over_budget")).toBe("red");
    expect(buildTone("coding")).toBe("amber");
    expect(buildTone("unknown")).toBeNull();
    expect(buildStatusLabel("over_budget")).toBe("Over budget");
  });

  it("loading shows skeleton blocks, not text", async () => {
    vi.stubGlobal("fetch", () => new Promise(() => undefined));
    const { container } = render(<views.AppInfoTab appId={APP} tab="pnl" active />);
    await act(async () => undefined);
    expect(container.querySelector("[data-loading]")?.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Loading");
    expect(container.textContent).toContain("Refresh");
  });

  it("the builder's welcome lists up to 5 builds with status dots and a View all to Builds", () => {
    const conversations = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, title: `Build ${i}`, status: i === 0 ? "failed" : "succeeded", phaseMessage: null, previewUrl: null, createdAt: "", updatedAt: "" }));
    const html = renderToStaticMarkup(
      <ProjectConversationsProvider value={{ projectId: APP, conversations, onSelectConversation: () => undefined }}>
        <ProjectWelcome />
      </ProjectConversationsProvider>,
    );
    expect(html).toContain('<h2 id="section-welcome-builds" class="text-sm font-semibold">Builds</h2>');
    expect(html.match(/data-build=/g)).toHaveLength(5);
    expect(html).toMatch(/data-build="b0"[^]*data-tone="red"[^]*Failed/);
    expect(html).toContain('href="/builds"');
  });
});

describe("live tabs", () => {
  it("read when opened, every 30 seconds while shown, never while the page is hidden or the tab isn't open", async () => {
    vi.useFakeTimers();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ tab: "activity", data: { available: true, builds: [], events: [], eventsReason: null } }), { status: 200 });
    });
    let hidden = false;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });

    const { rerender, container } = render(<views.AppInfoTab appId={APP} tab="activity" active={false} />);
    await act(async () => undefined);
    expect(urls).toEqual([]);
    rerender(<views.AppInfoTab appId={APP} tab="activity" active />);
    await act(async () => undefined);
    expect(urls).toEqual([`/api/apps/${APP}/panel?tab=activity`]);
    expect(container.querySelector("[data-updated]")?.textContent).toBe("Updated 0s ago");
    await act(async () => void vi.advanceTimersByTime(30_000));
    expect(urls).toHaveLength(2);
    hidden = true;
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(urls).toHaveLength(2);
    hidden = false;
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(urls).toHaveLength(3);
    rerender(<views.AppInfoTab appId={APP} tab="activity" active={false} />);
    await act(async () => void vi.advanceTimersByTime(90_000));
    expect(urls).toHaveLength(3);
    expect(urls.every((u) => u.startsWith(`/api/apps/${APP}/`))).toBe(true);
  });

  it("says when it was last read", () => {
    expect(updatedAgo(null, 0)).toBe("Not loaded yet");
    expect(updatedAgo(1000, 6000)).toBe("Updated 5s ago");
    expect(updatedAgo(0, 180_000)).toBe("Updated 3m ago");
  });
});
