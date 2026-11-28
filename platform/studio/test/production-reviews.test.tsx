// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall, parseStudioCall } from "@/lib/studio-tools";

// Production code reviews in the studio: the Security & risk tab's table with its Request production review sheet
// and a review's findings sheet, the platform admin's Audit trails → Production reviews (list, one review, Stop
// review, Record exception), and the routes behind them (same origin, this user's app only, Mynt admins only for
// the admin's, strict arguments). What Mynt didn't measure says "Not measured", never 0.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/audit",
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
  useSearchParams: () => new URLSearchParams("tab=reviews"),
}));

const APP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_APP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WS = "11111111-1111-4111-8111-111111111111";
const B1 = "c1c1c1c1-0000-4000-8000-000000000001";
const B2 = "c2c2c2c2-0000-4000-8000-000000000002";
const R1 = "d1d1d1d1-0000-4000-8000-000000000001";
const R2 = "d2d2d2d2-0000-4000-8000-000000000002";
const R3 = "d3d3d3d3-0000-4000-8000-000000000003";
const LIMITS = { workflows: ["execute-scr"], minutes: 180, cap_usd: 60, model: "claude-sonnet-5-5" };
const REASON = "The review ran out of time (180 min) before it finished; so far it covers no workflow";
const NEXT = "Nothing in your code needs changing for this. Ask a Mynt admin to raise PRODUCTION_REVIEW_MINUTES, then request the review again.";
const row = (o: Record<string, unknown>) => ({ app_id: APP, app_name: "Saver", app_kind: "app", workspace_id: WS, workspace_name: "Team", commit_sha: "c".repeat(40), limits: LIMITS, requested_by: { id: "u1", name: "Ana", mynt_admin: false }, ...o });
const COMPLETE = row({ id: R1, build_id: B1, status: "complete", findings: { critical: 0, high: 0, medium: 1, low: 2 }, coverage: { reviewed: ["execute-scr"], not_reviewed: [], progress: [] }, cost_usd: 21.25, seconds: 4290, created_at: "2026-11-20T10:00:00.000Z", finished_at: "2026-11-20T11:11:30.000Z" });
// Ended before it wrote a report: nothing was measured.
const INCOMPLETE = row({ id: R2, build_id: B2, status: "incomplete", findings: null, coverage: null, cost_usd: null, seconds: null, problem: "time", reason: REASON, next_step: NEXT, created_at: "2026-11-22T10:00:00.000Z" });
const RUNNING = row({ id: R3, build_id: B2, status: "running", findings: { critical: 0, high: 1, medium: 0, low: 0 }, coverage: { reviewed: [], not_reviewed: [{ workflow: "execute-scr", kind: "pending", reason: "still running after 12 min" }] }, cost_usd: 3.5, seconds: 720, requested_by: { id: "u9", name: "Ada", mynt_admin: true }, created_at: "2026-11-23T10:00:00.000Z" });
const WAIVER = { app_id: APP, build_id: B2, reason: "The model provider refuses the security review (req_011C); approval pending", waived_by: { id: "u9", name: "Ada" }, at: "2026-11-23T12:00:00.000Z" };
const LIST = {
  reviews: [INCOMPLETE, COMPLETE],
  waivers: [],
  limits: { ...LIMITS, workspace_monthly_reviews: 4, workspace_monthly_usd: 200 },
  available: true,
  builds: [
    { id: B2, verified_at: "2026-11-22T09:00:00.000Z", commit_sha: "c".repeat(40), review_status: "incomplete" },
    { id: B1, verified_at: "2026-11-20T09:00:00.000Z", commit_sha: "d".repeat(40), review_status: "complete" },
  ],
  can_request: true,
  workspace_usage: { month: "November 2026", reviews: 2, usd: 81.25 },
};
const DETAIL = { ...COMPLETE, finding_list: [{ severity: "medium", title: "Session cookie lacks SameSite", file: "api/session.ts", workflow: "execute-scr" }], summary: "1 of 1 workflow(s) finished", waiver: null };

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string; inputSchema?: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: {} as Record<string, string>,
  reply: {} as Record<string, unknown>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse[name] }) }] };
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const lib = await import("@/lib/production-reviews");
const views = await import("@/components/production-reviews");
const adminViews = await import("@/components/admin-production-reviews");
const { AuditTab, AuditViewTabs } = await import("@/components/admin-audit");
const { SecurityView } = await import("@/components/app-panel-tabs");
const { loadPanelTab } = await import("@/lib/app-panel-server");
const { auditHref, auditViewOf } = await import("@/lib/admin-audit");
const appRoute = await import("@/app/api/apps/[appId]/production-reviews/route");
const adminRoute = await import("@/app/api/admin/production-reviews/route");
const adminOne = await import("@/app/api/admin/production-reviews/[reviewId]/route");

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);
const req = (path: string, body?: unknown) =>
  new Request(`http://studio.test${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const forApp = (id = APP) => ({ params: Promise.resolve({ appId: id }) });

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  fake.session = session(["developer"]);
  fake.sameOrigin = true;
  fake.tools = ["list_my_apps", "list_production_reviews", "get_production_review", "request_production_review", "stop_production_review", "waive_production_review", "get_promotion_checks", "list_workspace_audit"].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = {};
  fake.reply = {
    list_my_apps: [{ id: APP, name: "Saver", workspace_id: WS, stage: "staging", product_ids: [] }],
    list_production_reviews: LIST,
    get_production_review: DETAIL,
    request_production_review: row({ id: R3, build_id: B2, status: "queued", findings: null, coverage: null, cost_usd: null, seconds: null, created_at: "2026-11-23T10:00:00.000Z" }),
    stop_production_review: { ...RUNNING, status: "stopped" },
    waive_production_review: { waiver: WAIVER, review: INCOMPLETE },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DATA = lib.reviewsFrom(LIST)!;

describe("what Mynt answered, in the studio's words", () => {
  it("reads each review field by field; what wasn't measured is null and says Not measured, never 0", () => {
    expect(DATA.reviews.map((r) => r.id)).toEqual([R2, R1]);
    const [incomplete, complete] = DATA.reviews;
    expect([complete.costUsd, complete.seconds, complete.findings, complete.coverage?.reviewed]).toEqual([21.25, 4290, { critical: 0, high: 0, medium: 1, low: 2 }, ["execute-scr"]]);
    expect([incomplete.costUsd, incomplete.seconds, incomplete.findings, incomplete.coverage]).toEqual([null, null, null, null]);
    expect(lib.usdText(incomplete.costUsd)).toBe("Not measured");
    expect(lib.durationText(incomplete.seconds)).toBe("Not measured");
    expect(lib.findingsText(incomplete.findings)).toBe("Not measured");
    expect(lib.coverageText(incomplete.coverage)).toBe("Not measured");
    expect(lib.usdText(complete.costUsd)).toBe("$21.25");
    expect(lib.durationText(complete.seconds)).toBe("1 h 12 min");
    expect(lib.findingsText(complete.findings)).toBe("0 critical, 0 high, 1 medium, 2 low");
    expect(lib.coverageText(complete.coverage)).toBe("Reviewed: execute-scr");
    expect(lib.coverageText(lib.reviewFrom(RUNNING)!.coverage)).toBe("Not finished: execute-scr (pending)");
    expect(lib.reviewFrom(RUNNING)!.startedBy).toBe("Ada (Mynt admin)");
    // A measured zero is a zero.
    expect(lib.usdText(0)).toBe("$0.00");
    expect(lib.limitWords(DATA.limits)).toEqual({ time: "Up to 3 h 0 min", cost: "At most $60.00, paid by Mynt (not your build budget)", what: "execute-scr", monthly: "4 reviews and $200.00 per workspace per calendar month" });
    expect(lib.reviewsFrom({ nothing: true })).toBeNull();
    expect(lib.reviewFrom({ id: R1, status: "made-up" })).toBeNull();
    expect(lib.waiverWords(lib.reviewsFrom({ ...LIST, waivers: [WAIVER] })!.waivers[0])).toBe(`Waived by a Mynt admin: ${WAIVER.reason} (Ada, 2026-11-23)`);
  });

  it("the studio may call the review tools only with their own arguments; the exception is an admin tool", () => {
    expect(parseStudioCall("list_production_reviews", { app_id: APP })).toEqual({ tool: "list_production_reviews", args: { app_id: APP } });
    expect(parseStudioCall("request_production_review", { app_id: APP, build_id: B1 })).toHaveProperty("tool");
    expect(parseStudioCall("request_production_review", { app_id: APP, build_id: "latest" })).toHaveProperty("error");
    expect(parseStudioCall("request_production_review", { app_id: APP, cap_usd: 500 })).toHaveProperty("error");
    expect(parseStudioCall("stop_production_review", { id: R1 })).toHaveProperty("tool");
    expect(parseStudioCall("waive_production_review", { app_id: APP, build_id: B1, reason: "The provider refuses this review entirely" })).toHaveProperty("error");
    expect(Object.keys(ADMIN_TOOLS)).toEqual(expect.arrayContaining(["list_production_reviews", "get_production_review", "stop_production_review", "waive_production_review"]));
    expect(parseAdminCall("waive_production_review", { app_id: APP, build_id: B1, reason: "The provider refuses this review entirely" })).toHaveProperty("tool");
    expect(parseAdminCall("waive_production_review", { app_id: APP, build_id: B1, reason: "too short" })).toHaveProperty("error");
    expect(parseAdminCall("waive_production_review", { app_id: APP, build_id: B1 })).toHaveProperty("error");
  });
});

describe("the Security & risk tab", () => {
  it("is a read view: one table of reviews, with a labelled Request production review button for owners and admins", () => {
    const html = renderToStaticMarkup(<views.ProductionReviewsView appId={APP} data={DATA} onRequest={() => undefined} onOpen={() => undefined} />);
    const el = document.createElement("div");
    el.innerHTML = html;
    expect([...el.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Build", "Status", "Findings by severity", "Coverage", "Cost", "Time", "Started by", "When"]);
    const rows = [...el.querySelectorAll("[data-review]")];
    expect(rows.map((r) => r.getAttribute("data-status"))).toEqual(["incomplete", "complete"]);
    expect([...rows[1].querySelectorAll("td")].map((t) => t.textContent)).toEqual(["c1c1c1c1", "Complete", "0 critical, 0 high, 1 medium, 2 low", "Reviewed: execute-scr", "$21.25", "1 h 12 min", "Ana", "2026-11-20 10:00 UTC"]);
    // Nothing measured for the one that wrote no report: said so in each cell, never 0.
    expect([...rows[0].querySelectorAll("td")].slice(2, 6).map((t) => t.textContent)).toEqual(["Not measured", "Not measured", "Not measured", "Not measured"]);
    const button = el.querySelector("[data-request-review]")!;
    expect(button.textContent?.trim()).toBe("Request production review");
    // No icon-only button anywhere in it.
    for (const b of el.querySelectorAll("button")) expect(b.textContent?.trim().length).toBeGreaterThan(0);
    expect(html).not.toContain("data-reviews-read-only");

    const member = renderToStaticMarkup(<views.ProductionReviewsView appId={APP} data={{ ...DATA, canRequest: false }} onRequest={() => undefined} />);
    expect(member).not.toContain("data-request-review");
    expect(member).toContain("Read-only: the workspace&#x27;s owners and admins request a review.");
    expect(renderToStaticMarkup(<views.ProductionReviewsView appId={APP} data={{ ...DATA, reviews: [] }} />)).toContain("No production code review yet.");
    expect(renderToStaticMarkup(<views.ProductionReviewsView appId={APP} data={{ available: false, reason: lib.NO_REVIEWS_YET }} />)).toContain("Not available. Production code reviews come with Mynt&#x27;s next update.");
    expect(renderToStaticMarkup(<views.ProductionReviewsView appId={APP} noun="service" data={DATA} />)).toContain("Before a build of this service goes to Production");
  });

  it("an exception a Mynt admin recorded is shown as it is, with its reason", () => {
    const html = renderToStaticMarkup(<views.ProductionReviewsView appId={APP} data={lib.reviewsFrom({ ...LIST, waivers: [WAIVER, { ...WAIVER, app_id: OTHER_APP }] })!} />);
    const el = document.createElement("div");
    el.innerHTML = html;
    const notes = [...el.querySelectorAll("[data-review-waiver]")];
    expect(notes.length).toBe(1);
    expect(notes[0].textContent).toBe(`Build c2c2c2c2: Waived by a Mynt admin: ${WAIVER.reason} (Ada, 2026-11-23). No complete code review ran on this build.`);
  });

  it("sits in the app's Security & risk view, with the production review among the build checks", async () => {
    const data = (await loadPanelTab((await (await import("@/lib/tokens")).connectStudio({} as never)) as never, { id: APP, name: "Saver", stage: "staging", workspaceId: WS, productIds: [] }, "security")) as import("@/lib/app-panel").AppSecurity;
    expect(called("list_production_reviews")).toEqual([{ app_id: APP }]);
    expect(data.reviews.available && data.reviews.reviews.length).toBe(2);
    const html = renderToStaticMarkup(<SecurityView appId={APP} data={{ ...data, checks: [{ id: "production_code_review", label: "Production code review passed", status: "fail", detail: REASON, fix: null }] }} />);
    expect(html).toContain("data-production-reviews");
    expect(html).toContain('data-check="production_code_review"');
    expect(html.indexOf("data-production-reviews")).toBeLessThan(html.indexOf('data-section="app-security-events"'));
    // An older Mynt without the tool: not available, with why.
    fake.tools = fake.tools.filter((t) => t.name !== "list_production_reviews");
    const before = (await loadPanelTab((await (await import("@/lib/tokens")).connectStudio({} as never)) as never, { id: APP, name: "Saver", stage: "staging", workspaceId: WS, productIds: [] }, "security")) as import("@/lib/app-panel").AppSecurity;
    expect(before.reviews).toEqual({ available: false, reason: "Production code reviews come with Mynt's next update." });
  });

  it("the request sheet says which build, how long it may take and what it costs at most, then asks", () => {
    const sent: string[] = [];
    render(<views.RequestReviewView data={DATA} onConfirm={(b) => sent.push(b)} />);
    const text = (id: string) => document.querySelector(`[data-summary-row="${id}"] dd`)?.textContent;
    expect(text("time")).toBe("Up to 3 h 0 min");
    expect(text("cost")).toBe("At most $60.00, paid by Mynt (not your build budget)");
    expect(text("what")).toContain("execute-scr");
    expect(text("monthly")).toBe("4 reviews and $200.00 per workspace per calendar month");
    expect(text("used")).toBe("2 review(s), $81.25 (November 2026; a review in progress counts at its cap)");
    const options = [...document.querySelectorAll("[data-review-build] option")].map((o) => o.textContent);
    expect(options).toEqual(["Build c2c2c2c2 (latest verified), verified 2026-11-22, last review incomplete", "Build c1c1c1c1, verified 2026-11-20, last review complete"]);
    const confirm = document.querySelector("[data-request-review-confirm]") as HTMLButtonElement;
    expect(confirm.textContent).toBe("Request review");
    expect(confirm.disabled).toBe(false);
    fireEvent.submit(document.querySelector("[data-request-review-form]")!);
    expect(sent).toEqual([B2]);
    // A build that already has a complete review isn't reviewed again.
    fireEvent.change(document.querySelector("[data-review-build]")!, { target: { value: B1 } });
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector("[data-request-review-why]")?.textContent).toBe("This build already has a complete review. A new build needs its own.");
    cleanup();
    // One at a time; and not at all where reviews can't run.
    render(<views.RequestReviewView data={lib.reviewsFrom({ ...LIST, reviews: [RUNNING, COMPLETE] })!} onConfirm={() => undefined} />);
    expect(document.querySelector("[data-request-review-why]")?.textContent).toBe("A review of build c2c2c2c2 is running: one review runs at a time.");
    cleanup();
    render(<views.RequestReviewView data={lib.reviewsFrom({ ...LIST, available: false })!} onConfirm={() => undefined} />);
    expect((document.querySelector("[data-request-review-confirm]") as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-request-review-why]")?.textContent).toBe("Production code reviews can't run on this Mynt yet.");
    cleanup();
    // Usage Mynt didn't send isn't shown as 0.
    render(<views.RequestReviewView data={lib.reviewsFrom({ ...LIST, workspace_usage: undefined })!} onConfirm={() => undefined} />);
    expect(document.querySelector('[data-summary-row="used"] dd')?.textContent).toBe("Not measured");
  });

  it("Request production review opens the sheet and posts to this app's route; a row opens its findings table; Stop review is a labelled button", async () => {
    const calls: { url: string; body: unknown }[] = [];
    let refuse: string | null = null;
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (init?.method === "POST") return refuse ? new Response(JSON.stringify({ message: refuse }), { status: 422 }) : new Response(JSON.stringify({ ok: true, message: "Review of build c2c2c2c2 requested." }), { status: 200 });
      return new Response(JSON.stringify({ review: lib.reviewFrom(String(url).includes(R3) ? { ...RUNNING, finding_list: [] } : DETAIL) }), { status: 200 });
    }) as unknown as typeof fetch;
    let changed = 0;
    render(<views.ProductionReviewsSection appId={APP} data={lib.reviewsFrom({ ...LIST, reviews: [RUNNING, COMPLETE] })!} fetcher={f} onChanged={() => changed++} />);
    expect(document.querySelector("[data-request-review-sheet]")).toBeNull();
    await act(async () => void fireEvent.click(document.querySelector("[data-request-review]")!));
    expect(document.querySelector("[data-request-review-sheet]")?.textContent).toContain("Request production review");
    cleanup();

    render(<views.ProductionReviewsSection appId={APP} data={DATA} fetcher={f} onChanged={() => changed++} />);
    await act(async () => void fireEvent.click(document.querySelector("[data-request-review]")!));
    refuse = "This workspace has started 4 of its 4 production code reviews for November 2026";
    await act(async () => void fireEvent.submit(document.querySelector("[data-request-review-form]")!));
    expect(document.querySelector("[data-request-review-error]")?.textContent).toBe(refuse);
    expect(changed).toBe(0);
    refuse = null;
    await act(async () => void fireEvent.submit(document.querySelector("[data-request-review-form]")!));
    expect(calls.filter((c) => c.body).at(-1)).toEqual({ url: `/api/apps/${APP}/production-reviews`, body: { action: "request", build_id: B2 } });
    expect(document.querySelector("[data-request-review-result]")?.textContent).toBe("Review of build c2c2c2c2 requested.");
    expect(changed).toBe(1);
    cleanup();

    // A row opens that review: its findings as a table, read from this app's route.
    render(<views.ProductionReviewsSection appId={APP} data={DATA} fetcher={f} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-review="${R1}"]`)!));
    expect(calls.at(-1)?.url).toBe(`/api/apps/${APP}/production-reviews?id=${R1}`);
    const sheet = document.querySelector("[data-review-sheet]")!;
    expect([...sheet.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Severity", "Finding", "File", "Workflow"]);
    expect([...sheet.querySelectorAll("[data-finding] td")].map((t) => t.textContent)).toEqual(["medium", "Session cookie lacks SameSite", "api/session.ts", "execute-scr"]);
    expect(sheet.querySelector("[data-stop-review]")).toBeNull();
    cleanup();

    // A review in progress has Stop review, for those who may ask for one.
    render(<views.ProductionReviewsSection appId={APP} data={lib.reviewsFrom({ ...LIST, reviews: [RUNNING] })!} fetcher={f} onChanged={() => changed++} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-review="${R3}"]`)!));
    const stop = document.querySelector("[data-stop-review]") as HTMLButtonElement;
    expect(stop.textContent).toBe("Stop review");
    await act(async () => void fireEvent.click(stop));
    expect(calls.at(-1)).toEqual({ url: `/api/apps/${APP}/production-reviews`, body: { action: "stop", id: R3 } });
    expect(changed).toBe(2);
  });

  it("a review that didn't finish says why and what to do; one that wrote no report says its findings weren't measured", () => {
    const html = renderToStaticMarkup(<views.ReviewDetailView review={{ ...lib.reviewFrom(INCOMPLETE)!, findingList: [] }} />);
    const el = document.createElement("div");
    el.innerHTML = html;
    const text = (id: string) => el.querySelector(`[data-summary-row="${id}"] dd`)?.textContent;
    expect(text("status")).toBe("Incomplete");
    expect(text("reason")).toBe(REASON);
    expect(text("next")).toBe(NEXT);
    expect([text("findings"), text("coverage"), text("cost"), text("time")]).toEqual(["Not measured", "Not measured", "Not measured", "Not measured"]);
    expect(el.querySelector("[data-findings-empty]")?.textContent).toBe("Not measured: this review wrote no report.");
    expect(html).not.toContain("data-stop-review");
    const waived = renderToStaticMarkup(<views.ReviewDetailView review={{ ...lib.reviewFrom({ ...INCOMPLETE, waiver: WAIVER })!, findingList: [] }} />);
    expect(waived).toContain(`Waived by a Mynt admin: ${WAIVER.reason.replace("(", "(")}`);
  });
});

describe("the app's route", () => {
  it("asks Mynt for this app only, from the same origin, and answers with Mynt's refusal in its words", async () => {
    const ok = await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "request", build_id: B2 }), forApp());
    expect(ok.status).toBe(200);
    expect(called("request_production_review")).toEqual([{ app_id: APP, build_id: B2 }]);
    expect(((await ok.json()) as { message: string }).message).toMatch(/^Review of build c2c2c2c2 requested\./);
    // The default build is Mynt's to choose: nothing is sent for it.
    await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "request" }), forApp());
    expect(called("request_production_review")[1]).toEqual({ app_id: APP });

    fake.calls = [];
    for (const body of [{ action: "request", build_id: "latest" }, { action: "request", cap_usd: 500 }, { action: "waive", build_id: B2, reason: "x".repeat(30) }, { action: "stop" }, null])
      expect((await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, body), forApp())).status).toBe(400);
    fake.sameOrigin = false;
    expect((await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "request" }), forApp())).status).toBe(403);
    fake.sameOrigin = true;
    expect((await appRoute.POST(req(`/api/apps/${OTHER_APP}/production-reviews`, { action: "request" }), forApp(OTHER_APP))).status).toBe(404);
    fake.session = undefined;
    expect((await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "request" }), forApp())).status).toBe(401);
    expect(called("request_production_review")).toEqual([]);

    fake.session = session(["developer"]);
    fake.refuse = { request_production_review: "Only the workspace's owners and admins request a production code review" };
    const refused = await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "request" }), forApp());
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("Only the workspace's owners and admins request a production code review");
  });

  it("reads and stops only this app's reviews", async () => {
    const got = await appRoute.GET(req(`/api/apps/${APP}/production-reviews?id=${R1}`), forApp());
    expect(got.status).toBe(200);
    expect(((await got.json()) as { review: { findingList: unknown[] } }).review.findingList).toHaveLength(1);
    expect((await appRoute.GET(req(`/api/apps/${APP}/production-reviews?id=nope`), forApp())).status).toBe(400);
    // A review of another app, though Mynt let this person read it, isn't shown or stopped from this app's page.
    fake.reply.get_production_review = { ...DETAIL, app_id: OTHER_APP };
    expect((await appRoute.GET(req(`/api/apps/${APP}/production-reviews?id=${R1}`), forApp())).status).toBe(404);
    expect((await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "stop", id: R1 }), forApp())).status).toBe(404);
    expect(called("stop_production_review")).toEqual([]);
    fake.reply.get_production_review = RUNNING;
    const stopped = await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "stop", id: R3 }), forApp());
    expect(stopped.status).toBe(200);
    expect(called("stop_production_review")).toEqual([{ id: R3 }]);
    // An older Mynt.
    fake.tools = fake.tools.filter((t) => !t.name.includes("production_review"));
    expect((await appRoute.POST(req(`/api/apps/${APP}/production-reviews`, { action: "request" }), forApp())).status).toBe(501);
  });
});

describe("platform admin: Audit trails → Production reviews", () => {
  const ALL = lib.reviewsFrom({ ...LIST, reviews: [RUNNING, INCOMPLETE, COMPLETE, row({ id: "d4d4d4d4-0000-4000-8000-000000000004", app_id: OTHER_APP, app_name: "Ledger sync", app_kind: "service", workspace_id: "22222222-2222-4222-8222-222222222222", workspace_name: "Elsewhere", build_id: B1, status: "refused", findings: null, coverage: null, cost_usd: 4, seconds: 300, created_at: "2026-11-19T10:00:00.000Z" })], waivers: [WAIVER], builds: undefined })!;

  it("is a tab of Audit trails, named in the address", () => {
    expect([auditViewOf("reviews"), auditViewOf(null), auditViewOf("else")]).toEqual(["reviews", "log", "log"]);
    expect([auditHref("log"), auditHref("reviews"), auditHref("reviews", R1), auditHref("log", "a1")]).toEqual(["/platform/audit", "/platform/audit?tab=reviews", `/platform/audit/${R1}?tab=reviews`, "/platform/audit/a1"]);
    const picked: string[] = [];
    render(<AuditViewTabs view="log" onView={(v) => picked.push(v)} />);
    expect([...document.querySelectorAll("[data-audit-view]")].map((t) => t.textContent)).toEqual(["Audit log", "Production reviews"]);
    fireEvent.click(document.querySelector('[data-audit-view="reviews"]')!);
    expect(picked).toEqual(["reviews"]);
  });

  it("loads every workspace's reviews from the admin route when its tab is open", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ reviews: ALL }), { status: 200 });
    }));
    await act(async () => void render(<AuditTab id={null} view="reviews" onOpen={() => undefined} onBack={() => undefined} />));
    await act(async () => undefined);
    expect(urls).toEqual(["/api/admin/production-reviews"]);
    expect(document.querySelector('[data-admin-list="production-reviews"]')).not.toBeNull();
    expect(document.querySelectorAll("[data-open-review]").length).toBe(4);
  });

  it("the list: one table across workspaces, searchable and filterable, each row with a labelled Open", () => {
    const opened: string[] = [];
    render(<adminViews.ProductionReviewsListView data={ALL} onOpen={(id) => opened.push(id)} />);
    expect([...document.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Workspace", "App or service", "Build", "Status", "Findings by severity", "Coverage", "Cost", "Time", "Started by", "When", ""]);
    const rows = [...document.querySelectorAll("tbody tr")];
    expect(rows.length).toBe(4);
    expect(rows[3].textContent).toContain("Elsewhere");
    expect(rows[3].textContent).toContain("Ledger sync");
    expect(rows[3].textContent).toContain("Service");
    expect(rows[3].textContent).toContain("Refused by the model provider");
    expect(rows[1].textContent).toContain("Not measured");
    // The build with an exception says so in its rows.
    expect(document.querySelectorAll("[data-row-waiver]").length).toBe(2);
    for (const b of document.querySelectorAll("button")) expect((b.textContent?.trim() || b.getAttribute("aria-label") || "").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-import]")).toBeNull();
    expect(document.querySelector("[data-export]")?.textContent).toContain("Export CSV");
    fireEvent.click(document.querySelector(`[data-open-review="${R2}"]`)!);
    expect(opened).toEqual([R2]);
    fireEvent.change(document.querySelector('input[aria-label^="Search production reviews"]')!, { target: { value: "ledger" } });
    expect(document.querySelectorAll("tbody tr").length).toBe(1);
  });

  it("one review: a metadata card, Findings and Coverage as tables, and Stop review and Record exception as labelled buttons", () => {
    const stopped: string[] = [];
    const running = { ...lib.reviewFrom({ ...RUNNING, finding_list: [{ severity: "high", title: "Missing authorization on export", file: "api/export.ts", workflow: "execute-scr" }] })! };
    render(<adminViews.ProductionReviewDetailView review={running} onBack={() => undefined} onStop={() => stopped.push("stop")} onWaive={() => stopped.push("waive")} />);
    expect(document.querySelector("[data-metadata-card]")?.textContent).toContain("Saver: build c2c2c2c2");
    expect([...document.querySelectorAll("[data-detail-tab]")].map((t) => t.textContent)).toEqual(["Findings", "Coverage"]);
    expect([...document.querySelectorAll("[data-detail-table] tbody td")].map((t) => t.textContent)).toEqual(["high", "Missing authorization on export", "api/export.ts", "execute-scr"]);
    expect(document.querySelector("[data-stop-review]")?.textContent?.trim()).toBe("Stop review");
    expect(document.querySelector("[data-waive-review]")).toBeNull(); // still running
    fireEvent.click(document.querySelector("[data-stop-review]")!);
    expect(stopped).toEqual(["stop"]);
    fireEvent.click(document.querySelector('[data-detail-tab="coverage"]')!);
    expect([...document.querySelectorAll("[data-detail-table] tbody td")].map((t) => t.textContent)).toEqual(["execute-scr", "No", "pending: still running after 12 min"]);
    cleanup();

    // Ended without a complete report: Record exception; what wasn't measured says so.
    render(<adminViews.ProductionReviewDetailView review={{ ...lib.reviewFrom(INCOMPLETE)!, findingList: [] }} onBack={() => undefined} onStop={() => undefined} onWaive={() => stopped.push("waive")} />);
    expect(document.querySelector("[data-stop-review]")).toBeNull();
    expect(document.querySelector("[data-waive-review]")?.textContent?.trim()).toBe("Record exception");
    expect(document.querySelector("[data-review-reason]")?.textContent).toBe(REASON);
    expect(document.querySelector("[data-detail-table] [data-not-available]")?.textContent).toBe("Not available. This review wrote no report, so its findings weren't measured.");
    fireEvent.click(document.querySelector("[data-waive-review]")!);
    expect(stopped).toEqual(["stop", "waive"]);
    cleanup();
    // Never for a review that passed, or one with a critical or high finding.
    render(<adminViews.ProductionReviewDetailView review={{ ...lib.reviewFrom(COMPLETE)!, findingList: [] }} onBack={() => undefined} onWaive={() => undefined} />);
    expect(document.querySelector("[data-waive-review]")).toBeNull();
    cleanup();
    render(<adminViews.ProductionReviewDetailView review={{ ...lib.reviewFrom({ ...INCOMPLETE, findings: { critical: 1, high: 0, medium: 0, low: 0 } })!, findingList: [] }} onBack={() => undefined} onWaive={() => undefined} />);
    expect(document.querySelector("[data-waive-review]")).toBeNull();
  });

  it("Record exception needs a reason, and says where it will be shown", () => {
    const sent: string[] = [];
    render(<adminViews.WaiveReviewForm review={lib.reviewFrom(INCOMPLETE)!} busy={false} onSubmit={(r) => sent.push(r)} />);
    const confirm = document.querySelector("[data-waive-confirm]") as HTMLButtonElement;
    expect(confirm.textContent).toBe("Record exception");
    expect(confirm.disabled).toBe(true);
    expect(document.querySelector("[data-waive-form]")?.textContent).toContain("Waived by a Mynt admin");
    fireEvent.change(document.querySelector("[data-waive-reason]")!, { target: { value: "provider refuses" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.submit(document.querySelector("[data-waive-form]")!);
    expect(sent).toEqual([]);
    fireEvent.change(document.querySelector("[data-waive-reason]")!, { target: { value: `  ${WAIVER.reason}  ` } });
    expect(confirm.disabled).toBe(false);
    fireEvent.submit(document.querySelector("[data-waive-form]")!);
    expect(sent).toEqual([WAIVER.reason]);
  });

  it("the routes are for Mynt admins only, take strict bodies, and send Stop and the exception to their own tools", async () => {
    // A developer: 404 from each, and nothing reaches Mynt.
    expect((await adminRoute.GET(req("/api/admin/production-reviews"))).status).toBe(404);
    expect((await adminOne.GET(req(`/api/admin/production-reviews/${R1}`), { params: Promise.resolve({ reviewId: R1 }) })).status).toBe(404);
    expect((await adminRoute.POST(req("/api/admin/production-reviews", { action: "waive", app_id: APP, build_id: B2, reason: WAIVER.reason }))).status).toBe(404);
    expect(fake.calls.filter((c) => c.name.includes("production_review"))).toEqual([]);

    fake.session = session(["admin"]);
    const list = await adminRoute.GET(req("/api/admin/production-reviews"));
    expect(list.status).toBe(200);
    expect(called("list_production_reviews")).toEqual([{ limit: 300 }]);
    expect(((await list.json()) as { reviews: { reviews: unknown[] } }).reviews.reviews).toHaveLength(2);
    expect((await adminRoute.GET(req("/api/admin/production-reviews?app_id=x"))).status).toBe(400);
    const one = await adminOne.GET(req(`/api/admin/production-reviews/${R1}`), { params: Promise.resolve({ reviewId: R1 }) });
    expect(((await one.json()) as { review: { id: string } }).review.id).toBe(R1);
    expect((await adminOne.GET(req("/api/admin/production-reviews/nope"), { params: Promise.resolve({ reviewId: "nope" }) })).status).toBe(400);

    for (const body of [{ action: "waive", app_id: APP, build_id: B2 }, { action: "waive", app_id: APP, build_id: B2, reason: "too short" }, { action: "waive", app_id: APP, build_id: B2, reason: WAIVER.reason, extra: 1 }, { action: "start", app_id: APP }, { action: "stop" }])
      expect((await adminRoute.POST(req("/api/admin/production-reviews", body))).status).toBe(400);
    expect(called("waive_production_review")).toEqual([]);
    const waived = await adminRoute.POST(req("/api/admin/production-reviews", { action: "waive", app_id: APP, build_id: B2, reason: WAIVER.reason }));
    expect(waived.status).toBe(200);
    expect(called("waive_production_review")).toEqual([{ app_id: APP, build_id: B2, reason: WAIVER.reason }]);
    expect(((await waived.json()) as { message: string }).message).toBe("Exception recorded for build c2c2c2c2. It is in the audit trail and on the app's promotion checks.");
    await adminRoute.POST(req("/api/admin/production-reviews", { action: "stop", id: R3 }));
    expect(called("stop_production_review")).toEqual([{ id: R3 }]);
    fake.sameOrigin = false;
    expect((await adminRoute.POST(req("/api/admin/production-reviews", { action: "stop", id: R3 }))).status).toBe(403);
    fake.sameOrigin = true;
    // Mynt's refusal comes back in its words.
    fake.refuse = { waive_production_review: "You're a member of this app's workspace; a Mynt admin outside it records the exception" };
    const refused = await adminRoute.POST(req("/api/admin/production-reviews", { action: "waive", app_id: APP, build_id: B2, reason: WAIVER.reason }));
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("a Mynt admin outside it records the exception");
    // An older Mynt.
    fake.tools = [];
    expect(await (await adminRoute.GET(req("/api/admin/production-reviews"))).json()).toEqual({ supported: false });
  });
});
