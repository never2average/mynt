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
    conduct: { available: true, rows: [{ audit_id: "au1", agreement_id: "g1", kind: "marketing", requirement: "Ad review", finding: "Rate shown without APR", severity: "high", since: "2026-11-01T00:00:00.000Z" }] },
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
  reviews: { available: false, reason: "Production code reviews come with Mynt's next update." },
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
    expect(html).toContain("Rate shown without APR");
    expect(html).toContain("Marketing audit: Ad review");
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
    expect(data.signals.conduct.available && data.signals.conduct.rows[0].cells.slice(0, 3)).toEqual(["Rate shown without APR", "Marketing audit: Ad review", "high"]);
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

describe("three-step scoring in an app's and a product's register", () => {
  const A = "66666666-6666-4666-8666-666666666666";
  const B = "77777777-7777-4777-8777-777777777777";
  const C = "88888888-8888-4888-8888-888888888888";
  // As Mynt sends them now: each risk with its inherent, control and residual.
  const SCORED = {
    ...LIST,
    risks: [
      { id: A, title: "Card testing", category: "fraud", likelihood: 5, impact: 4, owner: null, mitigation: null, status: "open", review_by: null, overdue: false, inherent: { likelihood: 5, impact: 4, score: 20, level: "critical", level_name: "Critical" }, control: { effectiveness: "strong", words: "Strong", note: "Velocity limits" }, residual: { score: 5, level: "medium", level_name: "Medium", assessed: true, overridden: false, likelihood: null, impact: null, override: null } },
      { id: B, title: "Vendor outage", category: "vendor", likelihood: 3, impact: 3, owner: null, mitigation: null, status: "open", review_by: null, overdue: false, inherent: { likelihood: 3, impact: 3, score: 9, level: "medium", level_name: "Medium" }, control: { effectiveness: null, words: "Not assessed", note: null }, residual: { score: 9, level: "medium", level_name: "Medium", assessed: false, overridden: false, likelihood: null, impact: null, override: null } },
      { id: C, title: "Key leak", category: "security", likelihood: 2, impact: 5, owner: null, mitigation: null, status: "open", review_by: null, overdue: false, inherent: { likelihood: 2, impact: 5, score: 10, level: "high", level_name: "High" }, control: { effectiveness: "weak", words: "Weak", note: null }, residual: { score: 2, level: "low", level_name: "Low", assessed: true, overridden: true, likelihood: 1, impact: 2, override: { by: OWNER, at: "2026-11-01T00:00:00.000Z", why: "Keys are in the vault" } } },
    ],
  };
  const scored = registerFrom(SCORED, [])!;
  const table = () => ({
    head: [...document.querySelectorAll("[data-risk-register] thead th")].map((th) => th.textContent),
    rows: [...document.querySelectorAll("[data-risk-register] tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim())),
  });

  it("the app's table: Inherent, Control and Residual, each level in words with its number, highest residual first", () => {
    render(<risk.RiskRegisterSection subject={{ type: "app", id: APP }} data={scored} />);
    const t = table();
    expect(t.head).toEqual(["Risk", "Category", "Inherent", "Control", "Residual", "Owner", "Status", "Review by", "Action"]);
    expect(t.rows.map((r) => [r[0], r[2], r[3], r[4]])).toEqual([
      // Not assessed: the residual is the inherent score, said in words; never a blank, never a 0.
      ["Vendor outage", "3 × 3 = 9 (Medium)", "Not assessed", "9 (Medium), same as inherent: control not assessed"],
      ["Card testing", "5 × 4 = 20 (Critical)", "Strong", "5 (Medium)"],
      ["Key leak", "2 × 5 = 10 (High)", "Weak", "2 (Low), overridden"],
    ]);
    expect([...document.querySelectorAll("[data-risk-residual]")].map((c) => [c.getAttribute("data-risk-residual"), c.getAttribute("data-residual-level")])).toEqual([["9", "medium"], ["5", "medium"], ["2", "low"]]);
    expect(t.rows.map((r) => r[8])).toEqual(["Open Review risk", "Open Review risk", "Open Review risk"]);
  });

  it("the product's table has the same three columns; a reader gets Open, not Review risk", () => {
    render(<ProductTabBody productId={PRODUCT} data={{ available: true, sections: [], register: { ...scored, canManage: false } }} />);
    const t = table();
    expect(t.head).toEqual(["Risk", "Category", "Inherent", "Control", "Residual", "Owner", "Status", "Review by", "Action"]);
    expect(t.rows.map((r) => [r[2], r[3], r[4], r[8]])).toEqual([
      ["3 × 3 = 9 (Medium)", "Not assessed", "9 (Medium), same as inherent: control not assessed", "Open"],
      ["5 × 4 = 20 (Critical)", "Strong", "5 (Medium)", "Open"],
      ["2 × 5 = 10 (High)", "Weak", "2 (Low), overridden", "Open"],
    ]);
  });

  it("an older Mynt's risk (likelihood and impact only) is graded here: control not assessed, residual the same as inherent", () => {
    const old = registerFrom(LIST, [])!;
    expect(old.risks.map((r) => [r.title, r.inherent.score, r.inherent.levelName, r.control.effectiveness, r.residual.score, r.residual.assessed])).toEqual([
      ["Session tokens could leak in logs", 12, "High", null, 12, false],
      ["Card testing on sign-up", 2, "Low", null, 2, false],
    ]);
  });

  it("a row opens the risk's detail in a sheet, by a click or its labelled Open, from the risk's own route", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (fetched.push(url), new Response(JSON.stringify({ error: "unsupported", message: "A risk's detail comes with Mynt's next update." }), { status: 501 }))));
    render(<risk.RiskRegisterSection subject={{ type: "app", id: APP }} data={scored} />);
    expect(document.querySelector("[data-risk-detail-sheet]")).toBeNull();
    await act(async () => void fireEvent.click(document.querySelector(`[data-open-risk="${A}"]`)!));
    expect(document.querySelector(`[data-risk-detail-sheet="${A}"]`)).not.toBeNull();
    expect(fetched).toEqual([`/api/apps/${APP}/risks/${A}`]);
    cleanup();
    fetched.length = 0;
    render(<risk.RiskRegisterSection subject={{ type: "product", id: PRODUCT }} data={scored} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-risk="${B}"]`)!));
    expect(document.querySelector(`[data-risk-detail-sheet="${B}"]`)).not.toBeNull();
    expect(fetched).toEqual([`/api/products/${PRODUCT}/risks/${B}`]);
    // Review risk is its own labelled action: it opens its sheet, not the detail.
    cleanup();
    fetched.length = 0;
    render(<risk.RiskRegisterSection subject={{ type: "app", id: APP }} data={scored} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-review-risk="${A}"]`)!));
    expect(document.querySelector("[data-review-risk-sheet]")).not.toBeNull();
    expect(fetched).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("Review risk sets the control's effectiveness, and overrides or re-derives the residual, sending only what changed", () => {
    const sent: unknown[] = [];
    const view = render(<risk.ReviewRiskView risk={scored.risks.find((r) => r.id === B)!} owners={[]} onSubmit={(c) => sent.push(c)} />);
    const field = (name: string) => document.querySelector(`[data-risk-field="${name}"]`) as HTMLSelectElement | HTMLTextAreaElement;
    expect([...field("control_effectiveness").querySelectorAll("option")].map((o) => o.textContent)).toEqual(["Not assessed", "None", "Weak", "Partial", "Strong"]);
    expect((field("residual_mode") as HTMLSelectElement).value).toBe("derived");
    fireEvent.change(field("control_effectiveness"), { target: { value: "partial" } });
    fireEvent.change(field("control_note"), { target: { value: "A second vendor is on standby" } });
    fireEvent.submit(document.querySelector(`[data-review-risk-form="${B}"]`)!);
    expect(sent).toEqual([{ action: "review", risk_id: B, control_effectiveness: "partial", control_note: "A second vendor is on standby" }]);
    // An override: the keeper's own residual likelihood and impact, with why (needed).
    fireEvent.change(field("residual_mode"), { target: { value: "override" } });
    fireEvent.change(field("residual_likelihood"), { target: { value: "1" } });
    fireEvent.change(field("residual_impact"), { target: { value: "3" } });
    expect((document.querySelector('[data-risk-submit="review"]') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field("residual_override_reason"), { target: { value: "Failover is tested monthly" } });
    fireEvent.submit(document.querySelector(`[data-review-risk-form="${B}"]`)!);
    expect(sent[1]).toEqual({ action: "review", risk_id: B, control_effectiveness: "partial", control_note: "A second vendor is on standby", residual_likelihood: 1, residual_impact: 3, residual_override_reason: "Failover is tested monthly" });
    view.unmount();
    // A risk already overridden: choosing the derived score again drops the override.
    sent.length = 0;
    render(<risk.ReviewRiskView risk={scored.risks.find((r) => r.id === C)!} owners={[]} onSubmit={(c) => sent.push(c)} />);
    expect((field("residual_mode") as HTMLSelectElement).value).toBe("override");
    expect((field("residual_override_reason") as HTMLTextAreaElement).value).toBe("Keys are in the vault");
    fireEvent.change(field("residual_mode"), { target: { value: "derived" } });
    fireEvent.submit(document.querySelector(`[data-review-risk-form="${C}"]`)!);
    expect(sent).toEqual([{ action: "review", risk_id: C, clear_residual_override: true }]);
  });

  it("the routes take the new review fields strictly, and the allow-list the risk's own tools", async () => {
    const post = (body: unknown) => appRisks.POST(new Request(`https://studio.example.test/api/apps/${APP}/risks`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ appId: APP }) });
    expect((await post({ action: "review", risk_id: RISK, control_effectiveness: "strong", control_note: "" })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "update_risk", args: { risk_id: RISK, control_effectiveness: "strong" } });
    expect((await post({ action: "review", risk_id: RISK, residual_likelihood: 1, residual_impact: 2, residual_override_reason: "Measured losses are small" })).status).toBe(200);
    expect((await post({ action: "review", risk_id: RISK, control_effectiveness: "excellent" })).status).toBe(400);
    expect((await post({ action: "review", risk_id: RISK, residual_likelihood: 6 })).status).toBe(400);
    expect((await post({ action: "review", risk_id: RISK, clear_residual_override: false })).status).toBe(400);
    expect(parseStudioCall("get_risk", { risk_id: RISK })).toHaveProperty("tool");
    expect(parseStudioCall("get_risk", { risk_id: RISK, subject_type: "platform" })).toHaveProperty("error");
    expect(parseStudioCall("add_risk_factor", { risk_id: RISK, kind: "impact", name: "Losses", score: 4, source: "https://example.test/x" })).toHaveProperty("tool");
    expect(parseStudioCall("add_risk_factor", { risk_id: RISK, kind: "impact", name: "Losses", score: 6 })).toHaveProperty("error");
    expect(parseStudioCall("add_risk_factor", { risk_id: RISK, kind: "impact", name: "Losses", score: 4, source: "javascript:alert(1)" })).toHaveProperty("error");
    expect(parseStudioCall("link_risk", { risk_id: RISK, target_type: "app", target_id: APP })).toHaveProperty("tool");
    expect(parseStudioCall("link_risk", { risk_id: RISK, target_type: "workspace", target_id: APP })).toHaveProperty("error");
    expect(parseStudioCall("update_risk_treatment", { risk_id: RISK, treatment_id: RISK, status: "finished" })).toHaveProperty("error");
    // The platform's grading isn't a studio tool: only Mynt's admins change it, from the platform admin.
    for (const t of ["get_risk_grading", "set_risk_grading"]) expect(parseStudioCall(t, {})).toHaveProperty("error");
  });
});
