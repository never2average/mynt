// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { appLicences, buildsFrom, eventsFrom, fromPnl, NOT_YET, updatedAgo, type AppActivity, type AppSdk, type AppSecurity } from "@/lib/app-panel";
import { parseStudioCall } from "@/lib/studio-tools";

// An app's information tabs (P&L, Licences, Security, SDK, Activity): what each shows with data,
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
];
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
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const route = await import("@/app/api/apps/[appId]/panel/route");
const views = await import("@/components/app-panel-tabs");

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

  it("Licences: the coverage of this app's products only, with the production licences check", async () => {
    const { body } = await get("licences");
    const data = body.data as unknown as ReturnType<typeof appLicences>;
    expect(data.states.map((s) => s.code)).toEqual(["us-ca", "us-ny"]);
    expect(data.states.find((s) => s.code === "us-ca")?.missing).toEqual(["Savings"]);
    expect(data.fullyCovered).toBe(1);
    expect(data.productionCheck?.detail).toBe("Savings isn't covered in California");
    expect(fake.calls.find((c) => c.name === "get_compliance_coverage")?.args).toEqual({ workspace_id: WS });
    scoped();
  });

  it("Security: Mynt's security-class events for this app, and its build checks; without classes it says so", async () => {
    const { body } = await get("security");
    const data = body.data as unknown as AppSecurity;
    expect(fake.calls.find((c) => c.name === "list_workspace_audit")?.args).toEqual({ workspace_id: WS, app_id: APP, class: "security" });
    expect(data.events?.map((e) => e.action)).toEqual(["api_key_created"]); // the other app's event is dropped
    expect(data.checks.map((c) => c.id)).toEqual(["build_verified", "audit_findings"]);
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

  it("Licences: covered and not covered per state, and an app with no products", () => {
    const data = appLicences(COVERAGE, [{ id: "p1", name: "Card" }, { id: "p2", name: "Savings" }], null);
    const html = renderToStaticMarkup(<views.LicencesTabView data={data} />);
    expect(html).toContain('data-state="us-ca" data-covered="partly"');
    expect(html).toContain('data-state="us-ny" data-covered="fully"');
    expect(html).not.toContain("Texas");
    expect(renderToStaticMarkup(<views.LicencesTabView data={appLicences(COVERAGE, [], null)} />)).toContain("uses no regulated products");
    expect(renderToStaticMarkup(<views.LicencesTabView data={appLicences({ states: [] }, [{ id: "p1", name: "Card" }], null)} />)).toContain("None of this app&#x27;s products is covered");
  });

  it("Security, SDK and Activity: empty and not-available-yet states", () => {
    expect(renderToStaticMarkup(<views.SecurityView data={{ available: true, events: [], eventsReason: null, checks: [], checksReason: "The app is in production: there's no next stage to check it for" }} />)).toContain("No security events for this app.");
    expect(renderToStaticMarkup(<views.SecurityView data={{ available: true, events: null, eventsReason: "Security events come with Mynt's next update", checks: [], checksReason: null }} />)).toContain("Not available yet. Security events come");
    expect(renderToStaticMarkup(<views.SdkView data={{ available: true, products: [] }} />)).toContain("uses no products yet");
    expect(renderToStaticMarkup(<views.ActivityView data={{ available: true, builds: [], events: [], eventsReason: null }} />)).toContain("No builds yet.");
    expect(renderToStaticMarkup(<views.InfoTabBody tab="pnl" data={NOT_YET("The app's P&L comes with Mynt's next update.")} />)).toContain("Not available yet. The app&#x27;s P&amp;L comes");
  });

  it("drops other apps' events and builds", () => {
    expect(eventsFrom({ events: [{ at: "x", action: "a", target: { type: "app", id: OTHER } }, { at: "y", action: "b", details: { app_id: OTHER } }, { at: "z", action: "c" }] }, APP).map((e) => e.action)).toEqual(["c"]);
    expect(buildsFrom({ builds: [{ id: "1", app_id: OTHER }, { id: "2", app_id: APP }] }, APP).map((b) => b.id)).toEqual(["2"]);
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
