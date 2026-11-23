// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import type { AppSecurity } from "@/lib/app-panel";
import { registerFrom, signalsFrom, type RiskRegister } from "@/lib/risk-register";
import { parseStudioCall } from "@/lib/studio-tools";

// An app's "Security & risk" tab (its risk register, infosec, and the fraud, vendor, conduct and product signals) and a
// product's Risk tab's register: what each section shows, what says "Not available." and why, the Add risk and Review
// risk sheets, and the routes behind them (same origin, a signed-in developer, this user's app or product only,
// strict arguments).

const APP = "a1";
const PRODUCT = "card-1";
const RISK = "33333333-3333-4333-8333-333333333333";
const OWNER = "44444444-4444-4444-8444-444444444444";
const LIST = {
  subject: { type: "app", id: APP, name: "Cards" },
  can_manage: true,
  risks: [
    { id: RISK, title: "Session tokens could leak in logs", category: "security", likelihood: 3, impact: 4, owner: { user_id: OWNER, name: "Ines" }, mitigation: "Scrub logs", status: "mitigating", review_by: "2026-01-01", overdue: true },
    { id: "55555555-5555-4555-8555-555555555555", title: "Card testing on sign-up", category: "fraud", likelihood: 1, impact: 2, owner: null, mitigation: null, status: "closed", review_by: null, overdue: false },
  ],
  counts: { open: 0, mitigating: 1, accepted: 0, closed: 1, overdue: 1 },
  signals: {
    fraud: { available: false, reason: "Not measured yet: Mynt records no fraud or velocity signals from customer sessions." },
    vendors: { available: true, rows: [{ subscription_id: "v1", agreement_id: null, vendor: "KYC Works", offering: "Identity check", issue: "conformance_failed", detail: "The service's latest conformance run failed", since: "2026-11-12T00:00:00.000Z" }] },
    conduct: { available: false, reason: "Not available yet: oversight audits of agreements come with Mynt's next update." },
    products: { available: true, rows: [] },
  },
};

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string; inputSchema?: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: null as string | null,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_my_apps") return ok([{ id: APP, name: "Cards", workspace_id: "w1", stage: "staging", product_ids: [PRODUCT] }]);
      if (name === "list_my_products") return ok([{ id: PRODUCT, name: "Card", status: "draft", stage: "staging" }]);
      if (name === "list_workspace_members") return ok({ members: [{ user_id: OWNER, name: "Ines", role: "admin" }] });
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      if (name === "list_risks") return ok(args.subject_type === "product" ? { ...LIST, subject: { type: "product", id: PRODUCT }, can_manage: false, signals: undefined } : LIST);
      return ok({ risk: { id: RISK } });
    },
    close: async () => undefined,
  }),
}));

const views = await import("@/components/app-panel-tabs");
const risk = await import("@/components/risk-register");
const { ProductTabBody } = await import("@/components/product-workspace");
const appRisks = await import("@/app/api/apps/[appId]/risks/route");
const productRisks = await import("@/app/api/products/[productId]/risks/route");
const appPanel = await import("@/app/api/apps/[appId]/panel/route");
const productPanel = await import("@/app/api/products/[productId]/panel/route");

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.sameOrigin = true;
  fake.tools = ["list_my_apps", "list_my_products", "list_risks", "add_risk", "update_risk", "list_workspace_members"].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = null;
});
afterEach(() => cleanup());

const REGISTER = registerFrom(LIST, [{ userId: OWNER, name: "Ines" }])!;
const SECURITY: AppSecurity = {
  available: true,
  register: REGISTER,
  signals: signalsFrom(LIST),
  events: [],
  eventsReason: null,
  checks: [{ id: "build_verified", label: "Latest build verified", status: "pass", detail: null, fix: null }],
  checksReason: null,
};

describe("the Security & risk tab", () => {
  it("shows the register, Infosec, then Fraud, Vendors, Conduct and From products, in that order", () => {
    const html = renderToStaticMarkup(<views.SecurityView appId={APP} data={SECURITY} />);
    const order = ["data-risk-register", "data-infosec", 'data-signal="fraud"', 'data-signal="vendors"', 'data-signal="conduct"', 'data-signal="products"'].map((m) => html.indexOf(m));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("Build checks");
    expect(html).toContain("No security events for this app.");
  });

  it("the register: score as likelihood × impact with its level, status and owner in words, overdue said in words", () => {
    const html = renderToStaticMarkup(<views.SecurityView appId={APP} data={SECURITY} />);
    expect(html).toContain("3 × 4 = 12 (High)");
    expect(html).toContain("1 × 2 = 2 (Low)");
    expect(html).toContain("Mitigating: work under way");
    expect(html).toContain(">Closed<");
    expect(html).toContain("Ines");
    expect(html).toContain("No owner");
    expect(html).toContain("2026-01-01 (overdue)");
    expect(html).toContain("1 risk is overdue for review.");
    // Labelled actions, never icon-only: Add risk once, Review risk on each row.
    expect(html.match(/data-add-risk=/g)).toHaveLength(1);
    expect(html).toContain("Add risk");
    expect(html.match(/data-review-risk=/g)).toHaveLength(2);
    expect(html).toContain("Review risk");
  });

  it("signals: a table, an empty answer, or Not available with why; never 0", () => {
    const html = renderToStaticMarkup(<views.SecurityView appId={APP} data={SECURITY} />);
    expect(html).toContain("Not available. Not measured yet: Mynt records no fraud or velocity signals from customer sessions.");
    expect(html).toContain("KYC Works");
    expect(html).toContain("Conformance failing");
    expect(html).toContain("Not available. Not available yet: oversight audits of agreements come with Mynt&#x27;s next update.");
    expect(html).toContain("None of this app&#x27;s products is paused or drifted.");
  });

  it("a member who doesn't keep the register reads it, without the actions", () => {
    const html = renderToStaticMarkup(<views.SecurityView appId={APP} data={{ ...SECURITY, register: { ...REGISTER, canManage: false } }} />);
    expect(html).not.toContain("data-add-risk");
    expect(html).not.toContain("data-review-risk");
    expect(html).toContain("Read-only: the workspace&#x27;s owners and admins keep this register.");
  });

  it("before Mynt has risk registers, the register and every signal say Not available with why", () => {
    const none = { available: false as const, reason: "Risk registers come with Mynt's next update." };
    const html = renderToStaticMarkup(<views.SecurityView appId={APP} data={{ ...SECURITY, register: none, signals: { fraud: none, vendors: none, conduct: none, products: none } }} />);
    expect(html.match(/Not available\. Risk registers come with Mynt&#x27;s next update\./g)).toHaveLength(5);
    expect(html).not.toContain("data-add-risk");
  });

  it("the panel route reads the register for this app, with the workspace's members as owners", async () => {
    const res = await appPanel.GET(new Request(`http://localhost:3000/api/apps/${APP}/panel?tab=security`), { params: Promise.resolve({ appId: APP }) });
    const data = ((await res.json()) as { data: AppSecurity }).data;
    expect(fake.calls.find((c) => c.name === "list_risks")?.args).toEqual({ subject_type: "app", subject_id: APP });
    expect(fake.calls.find((c) => c.name === "list_workspace_members")?.args).toEqual({ workspace_id: "w1" });
    expect(data.register.available && data.register.risks.length).toBe(2);
    expect(data.register.available && data.register.owners).toEqual([{ userId: OWNER, name: "Ines" }]);
    expect(data.signals.vendors.available).toBe(true);
    expect(data.signals.conduct.available).toBe(false);
  });
});

describe("the product's Risk tab", () => {
  it("shows the register first; a sponsor (or anyone who doesn't keep it) reads it without actions", () => {
    const register: RiskRegister = { ...REGISTER, canManage: false };
    const html = renderToStaticMarkup(<ProductTabBody productId={PRODUCT} data={{ available: true, sections: [{ id: "risk-models", title: "Risk models", columns: ["Model"], rows: [], empty: "None." }], register }} />);
    expect(html.indexOf("data-risk-register")).toBeLessThan(html.indexOf('data-tab-section="risk-models"'));
    expect(html).toContain("Read-only: the product&#x27;s own firm keeps this register.");
    expect(html).not.toContain("data-add-risk");
    const mine = renderToStaticMarkup(<ProductTabBody productId={PRODUCT} data={{ available: true, sections: [], register: REGISTER }} />);
    expect(mine).toContain("data-add-risk");
  });

  it("the panel route adds the product's register to its Risk tab", async () => {
    const res = await productPanel.GET(new Request(`http://localhost:3000/api/products/${PRODUCT}/panel?tab=risk`), { params: Promise.resolve({ productId: PRODUCT }) });
    const body = (await res.json()) as { data: { register: RiskRegister } };
    expect(fake.calls.find((c) => c.name === "list_risks")?.args).toEqual({ subject_type: "product", subject_id: PRODUCT });
    expect(body.data.register.canManage).toBe(false);
    fake.tools = fake.tools.filter((t) => t.name !== "list_risks");
    const before = (await (await productPanel.GET(new Request(`http://localhost:3000/api/products/${PRODUCT}/panel?tab=risk`), { params: Promise.resolve({ productId: PRODUCT }) })).json()) as { data: { register: { available: boolean; reason: string } } };
    expect(before.data.register).toEqual({ available: false, reason: "Risk registers come with Mynt's next update." });
  });
});

describe("Add risk and Review risk", () => {
  it("Add risk sends the risk, with a score preview; empty optional fields are left out", () => {
    const sent: unknown[] = [];
    render(<risk.AddRiskView owners={[{ userId: OWNER, name: "Ines" }]} onSubmit={(c) => sent.push(c)} />);
    const submit = document.querySelector('[data-risk-submit="add"]') as HTMLButtonElement;
    expect(submit.textContent).toBe("Add risk");
    expect(submit.disabled).toBe(true);
    fireEvent.change(document.querySelector('[data-risk-field="title"]')!, { target: { value: "KYC vendor outage" } });
    fireEvent.change(document.querySelector('[data-risk-field="category"]')!, { target: { value: "vendor" } });
    fireEvent.change(document.querySelector('[data-risk-field="likelihood"]')!, { target: { value: "4" } });
    fireEvent.change(document.querySelector('[data-risk-field="impact"]')!, { target: { value: "5" } });
    expect(document.querySelector("[data-risk-score-preview]")?.textContent).toBe("Score: 4 × 5 = 20 (Critical)");
    fireEvent.change(document.querySelector('[data-risk-field="owner"]')!, { target: { value: OWNER } });
    fireEvent.click(submit);
    expect(sent).toEqual([{ action: "add", title: "KYC vendor outage", category: "vendor", likelihood: 4, impact: 5, owner_user_id: OWNER }]);
  });

  it("Review risk sends only what changed, and closing it needs a note", () => {
    const sent: unknown[] = [];
    render(<risk.ReviewRiskView risk={REGISTER.risks[0]} owners={[]} onSubmit={(c) => sent.push(c)} />);
    const submit = document.querySelector('[data-risk-submit="review"]') as HTMLButtonElement;
    expect(submit.textContent).toBe("Save review");
    expect(submit.disabled).toBe(true); // nothing changed yet
    fireEvent.change(document.querySelector('[data-risk-field="status"]')!, { target: { value: "closed" } });
    expect(submit.disabled).toBe(true); // closing needs a why
    fireEvent.change(document.querySelector('[data-risk-field="note"]')!, { target: { value: "Logs scrubbed" } });
    fireEvent.change(document.querySelector('[data-risk-field="impact"]')!, { target: { value: "2" } });
    fireEvent.click(submit);
    expect(sent).toEqual([{ action: "review", risk_id: RISK, status: "closed", impact: 2, note: "Logs scrubbed" }]);
  });

  it("each sheet posts to its subject's route and shows Mynt's refusal in its words", async () => {
    const requests: { url: string; body: unknown }[] = [];
    let reply: { status: number; body: unknown } = { status: 422, body: { error: "mynt_refused", message: "Only the workspace's owners and admins keep its apps' risk registers" } };
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    let done = 0;
    render(<risk.AddRiskSheet subject={{ type: "app", id: APP }} owners={[]} open onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Add risk" })).toBeTruthy();
    fireEvent.change(document.querySelector('[data-risk-field="title"]')!, { target: { value: "KYC vendor outage" } });
    await act(async () => void fireEvent.click(document.querySelector('[data-risk-submit="add"]')!));
    expect(requests[0].url).toBe(`/api/apps/${APP}/risks`);
    expect(document.querySelector("[data-risk-error]")?.textContent).toContain("owners and admins");
    expect(done).toBe(0);
    reply = { status: 200, body: { ok: true, message: "Risk added." } };
    await act(async () => void fireEvent.click(document.querySelector('[data-risk-submit="add"]')!));
    expect(document.querySelector("[data-risk-result]")?.textContent).toBe("Risk added.");
    expect(done).toBe(1);
    cleanup();

    render(<risk.ReviewRiskSheet subject={{ type: "product", id: PRODUCT }} risk={REGISTER.risks[0]} owners={[]} onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Review risk" })).toBeTruthy();
    fireEvent.change(document.querySelector('[data-risk-field="status"]')!, { target: { value: "open" } });
    await act(async () => void fireEvent.click(document.querySelector('[data-risk-submit="review"]')!));
    expect(requests[2]).toEqual({ url: `/api/products/${PRODUCT}/risks`, body: { action: "review", risk_id: RISK, status: "open" } });
  });
});

const postApp = (body: unknown, app = APP) =>
  appRisks.POST(new Request(`http://localhost:3000/api/apps/${app}/risks`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ appId: app }) });
const postProduct = (body: unknown, product = PRODUCT) =>
  productRisks.POST(new Request(`http://localhost:3000/api/products/${product}/risks`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ productId: product }) });

describe("the routes", () => {
  const add = { action: "add", title: "KYC vendor outage", category: "vendor", likelihood: 2, impact: 3, description: "", review_by: "" };

  it("an app's: own origin, strict arguments, the user's app, then add_risk for it", async () => {
    fake.sameOrigin = false;
    expect((await postApp(add)).status).toBe(403);
    fake.sameOrigin = true;
    expect((await postApp({ ...add, category: "weather" })).status).toBe(400);
    expect((await postApp({ ...add, likelihood: 6 })).status).toBe(400);
    expect((await postApp({ ...add, subject_id: "a9" })).status).toBe(400); // the subject is the route's
    expect((await postApp(add, "not-mine")).status).toBe(404);
    expect((await postApp(add)).status).toBe(200);
    expect(fake.calls.find((c) => c.name === "add_risk")?.args).toEqual({ subject_type: "app", subject_id: APP, title: "KYC vendor outage", category: "vendor", likelihood: 2, impact: 3 });
    fake.refuse = "Only the workspace's owners and admins keep its apps' risk registers";
    const refused = await postApp(add);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("owners and admins");
    fake.session = undefined;
    expect((await postApp(add)).status).toBe(401);
  });

  it("a review: only of a risk on this register (list_risks with risk_id first), then update_risk", async () => {
    const res = await postApp({ action: "review", risk_id: RISK, status: "accepted", note: "Within appetite", mitigation: "" });
    expect(res.status).toBe(200);
    expect(fake.calls.filter((c) => c.name !== "list_my_apps").map((c) => [c.name, c.args])).toEqual([
      ["list_risks", { subject_type: "app", subject_id: APP, risk_id: RISK }],
      ["update_risk", { risk_id: RISK, status: "accepted", note: "Within appetite" }],
    ]);
    expect((await postApp({ action: "review", risk_id: "not-a-uuid" })).status).toBe(400);
  });

  it("a product's: the user's own product only, and Mynt without the tools says so", async () => {
    expect((await postProduct(add, "not-mine")).status).toBe(404);
    expect((await postProduct(add)).status).toBe(200);
    expect(fake.calls.find((c) => c.name === "add_risk")?.args).toMatchObject({ subject_type: "product", subject_id: PRODUCT });
    fake.tools = [{ name: "list_my_products" }];
    expect((await postProduct(add)).status).toBe(501);
  });

  it("the allow-list keeps the register tools strict", () => {
    expect(parseStudioCall("add_risk", { subject_type: "app", subject_id: APP, title: "x risk", category: "security", likelihood: 1, impact: 1 })).toHaveProperty("tool");
    expect(parseStudioCall("add_risk", { subject_type: "workspace", subject_id: APP, title: "x risk", category: "security", likelihood: 1, impact: 1 })).toHaveProperty("error");
    expect(parseStudioCall("update_risk", { risk_id: RISK, status: "closed", extra: 1 })).toHaveProperty("error");
    expect(parseStudioCall("list_risks", { subject_type: "product", subject_id: PRODUCT, overdue_only: true })).toHaveProperty("tool");
  });
});
