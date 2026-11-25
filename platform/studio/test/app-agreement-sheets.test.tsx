// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { fromAgreements, fromCustomers } from "@/lib/app-panel";

// The Agreements tab's Propose agreement sheet and the Customers tab's Choose personas sheet: what
// they offer, what they send, and the routes behind them (same origin, a signed-in developer, this
// user's app only, strict arguments).

const APP = "a1";
const SPONSOR = "11111111-1111-4111-8111-111111111111";
const OTHER_SPONSOR = "22222222-2222-4222-8222-222222222222";
const AGREEMENT = "33333333-3333-4333-8333-333333333333";
const AGREEMENTS = fromAgreements({
  can_manage: true,
  agreements: [],
  products: [
    { id: "p1", name: "Card", stage: "production", sponsors: [{ entity_id: SPONSOR, name: "Lead Bank", jurisdictions: ["us-ny"] }], states: ["us-ny"] },
    { id: "p2", name: "Savings", stage: "production", sponsors: [{ entity_id: OTHER_SPONSOR, name: "Harbor Bank", jurisdictions: ["us-ca"] }], states: ["us-ca"] },
  ],
  vendor_contracts: [],
  introductions: null,
})!;
const CUSTOMERS = fromCustomers({
  can_manage: true,
  products: [{ id: "p1", name: "Card", segments: [{ id: "retail", name: "Retail savers", targeted: true }, { id: "students", name: "Students", targeted: false }] }],
  customers: { live: {}, sandbox: {} },
})!;

const fake = { session: undefined as Session | undefined, sameOrigin: true, tools: [] as { name: string }[], calls: [] as { name: string; args: Record<string, unknown> }[], refuse: null as string | null };
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_my_apps") return ok([{ id: APP, name: "Cards", workspace_id: "w1", stage: "staging", product_ids: ["p1", "p2"] }]);
      if (name === "list_app_agreements") return ok({ agreements: [{ id: AGREEMENT, status: "accepted" }] });
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      return ok({ id: "g1", status: "proposed" });
    },
    close: async () => undefined,
  }),
}));

const sheets = await import("@/components/app-agreement-sheets");
const agreementsRoute = await import("@/app/api/apps/[appId]/agreements/route");
const agreementRoute = await import("@/app/api/apps/[appId]/agreements/[agreementId]/route");
const panelTabs = await import("@/components/app-panel-tabs");
const { agreementActions } = await import("@/lib/app-panel");
const { fromPromotionChecks } = await import("@/lib/promotions");
const { CheckList } = await import("@/components/promotion-view");
const customersRoute = await import("@/app/api/apps/[appId]/customers/route");

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.sameOrigin = true;
  fake.tools = [{ name: "list_my_apps" }, { name: "propose_app_agreement" }, { name: "set_app_target_segments" }];
  fake.calls = [];
  fake.refuse = null;
});
afterEach(() => cleanup());

const post = (route: { POST: (r: Request, p: { params: Promise<{ appId: string }> }) => Promise<Response> }, body: unknown, app = APP) =>
  route.POST(new Request(`http://localhost:3000/api/apps/${app}/x`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ appId: app }) });

describe("Propose agreement", () => {
  it("picks the counterparty from the sponsors of the app's products, and a program covers only what it sponsors", () => {
    const sent: unknown[] = [];
    render(<sheets.ProposeAgreementView data={AGREEMENTS} onSubmit={(p) => sent.push(p)} />);
    const options = [...document.querySelectorAll("[data-agreement-counterparty] option")].map((o) => o.textContent);
    expect(options).toEqual(["Lead Bank (sponsors Card)", "Harbor Bank (sponsors Savings)"]);
    expect([...document.querySelectorAll("[data-agreement-product]")].map((e) => e.getAttribute("data-agreement-product"))).toEqual(["p1"]);
    const submit = document.querySelector("[data-propose-agreement-submit]") as HTMLButtonElement;
    expect(submit.textContent).toBe("Propose agreement");
    expect(submit.disabled).toBe(true); // no terms yet
    fireEvent.change(document.querySelector("[data-agreement-terms]")!, { target: { value: "Lead Bank's card program, standard terms" } });
    fireEvent.change(document.querySelector("[data-agreement-document]")!, { target: { value: "https://docs.example.com/p.pdf" } });
    fireEvent.change(document.querySelector("[data-agreement-from]")!, { target: { value: "2026-12-01" } });
    // The scope is required: a labelled checkbox group, at least one ticked.
    expect([...document.querySelectorAll("[data-propose-scopes] label")].map((l) => l.textContent)).toEqual(["Technology", "Manpower", "Financial regulatory operations"]);
    expect(submit.disabled).toBe(true);
    fireEvent.click(document.querySelector('[data-propose-scope="manpower"]')!);
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(sent).toEqual([{ counterparty_entity_id: SPONSOR, kind: "program", scopes: ["manpower"], products: ["p1"], terms_summary: "Lead Bank's card program, standard terms", document_url: "https://docs.example.com/p.pdf", effective_from: "2026-12-01" }]);
    // Another sponsor: its products only.
    fireEvent.change(document.querySelector("[data-agreement-counterparty]")!, { target: { value: OTHER_SPONSOR } });
    expect([...document.querySelectorAll("[data-agreement-product]")].map((e) => e.getAttribute("data-agreement-product"))).toEqual(["p2"]);
  });

  it("says so when no product has a sponsor", () => {
    expect(renderToStaticMarkup(<sheets.ProposeAgreementView data={{ sponsors: [], products: AGREEMENTS.products }} onSubmit={() => undefined} />)).toContain("data-no-sponsors");
  });

  it("the sheet posts to this app's route and shows Mynt's refusal in its words", async () => {
    const requests: { url: string; body: unknown }[] = [];
    let reply: { status: number; body: unknown } = { status: 422, body: { error: "mynt_refused", message: "Lead Bank doesn't sponsor 'p2'" } };
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    }) as unknown as typeof fetch;
    let done = 0;
    render(<sheets.ProposeAgreementSheet appId={APP} data={AGREEMENTS} open onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Propose agreement" })).toBeTruthy();
    fireEvent.change(document.querySelector("[data-agreement-terms]")!, { target: { value: "Lead Bank's card program" } });
    fireEvent.click(document.querySelector('[data-propose-scope="technology"]')!);
    await act(async () => void fireEvent.click(document.querySelector("[data-propose-agreement-submit]")!));
    expect(requests[0].url).toBe(`/api/apps/${APP}/agreements`);
    expect((requests[0].body as { scopes: string[] }).scopes).toEqual(["technology"]);
    expect(document.querySelector("[data-agreement-error]")?.textContent).toBe("Lead Bank doesn't sponsor 'p2'");
    expect(done).toBe(0);
    reply = { status: 200, body: { ok: true, message: "Agreement proposed." } };
    await act(async () => void fireEvent.click(document.querySelector("[data-propose-agreement-submit]")!));
    expect(document.querySelector("[data-agreement-result]")?.textContent).toBe("Agreement proposed.");
    expect(done).toBe(1);
  });

  it("the route: own origin, valid arguments, the user's app, then propose_app_agreement", async () => {
    const body = { counterparty_entity_id: SPONSOR, kind: "program", scopes: ["technology", "manpower"], products: ["p1"], terms_summary: "Lead Bank's card program", document_url: "", effective_to: "" };
    fake.sameOrigin = false;
    expect((await post(agreementsRoute, body)).status).toBe(403);
    fake.sameOrigin = true;
    expect((await post(agreementsRoute, { ...body, kind: "licence" })).status).toBe(400);
    expect((await post(agreementsRoute, { ...body, app_id: "a9" })).status).toBe(400); // the app is the route's
    // The scope is required: at least one, from the fixed list, each once.
    for (const scopes of [undefined, [], ["catering"], ["manpower", "manpower"]]) expect((await post(agreementsRoute, { ...body, scopes })).status, JSON.stringify(scopes)).toBe(400);
    expect((await post(agreementsRoute, body, "not-mine")).status).toBe(404);
    const res = await post(agreementsRoute, body);
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.name === "propose_app_agreement")?.args).toEqual({ app_id: APP, counterparty_entity_id: SPONSOR, kind: "program", scopes: ["technology", "manpower"], products: ["p1"], terms_summary: "Lead Bank's card program" });
    fake.refuse = "Only the workspace's owners and admins make agreements for its apps";
    const refused = await post(agreementsRoute, body);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("owners and admins");
    fake.session = undefined;
    expect((await post(agreementsRoute, body)).status).toBe(401);
  });
});

describe("Choose personas", () => {
  it("lists its products' segments with the current choice ticked, and sends the whole choice", () => {
    const sent: unknown[] = [];
    render(<sheets.ChoosePersonasView data={CUSTOMERS} onSubmit={(s) => sent.push(s)} />);
    const box = (k: string) => document.querySelector(`[data-persona="${k}"]`) as HTMLInputElement;
    expect(box("p1/retail").checked).toBe(true);
    expect(box("p1/students").checked).toBe(false);
    fireEvent.click(box("p1/students"));
    fireEvent.click(box("p1/retail"));
    expect((document.querySelector("[data-choose-personas-submit]") as HTMLButtonElement).textContent).toBe("Save personas");
    fireEvent.click(document.querySelector("[data-choose-personas-submit]")!);
    expect(sent).toEqual([[{ product_id: "p1", segment_id: "students" }]]);
  });

  it("says so when its products declare no segments", () => {
    expect(renderToStaticMarkup(<sheets.ChoosePersonasView data={{ products: [{ id: "p1", name: "Card", personas: [] }] }} onSubmit={() => undefined} />)).toContain("data-no-personas");
  });

  it("the route: own origin, strict segments, the user's app, then set_app_target_segments", async () => {
    fake.sameOrigin = false;
    expect((await post(customersRoute, { segments: [] })).status).toBe(403);
    fake.sameOrigin = true;
    expect((await post(customersRoute, { segments: [{ product_id: "p1" }] })).status).toBe(400);
    expect((await post(customersRoute, { segments: [], extra: true })).status).toBe(400);
    expect((await post(customersRoute, { segments: [] }, "not-mine")).status).toBe(404);
    const res = await post(customersRoute, { segments: [{ product_id: "p1", segment_id: "retail" }] });
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.name === "set_app_target_segments")?.args).toEqual({ app_id: APP, segments: [{ product_id: "p1", segment_id: "retail" }] });
    fake.tools = [{ name: "list_my_apps" }];
    expect((await post(customersRoute, { segments: [] })).status).toBe(501);
  });
});

// ---- the app side's row actions, and production's program agreements ----

const WITH_ROWS = fromAgreements({
  app: { id: APP, name: "Cards", stage: "production" },
  can_manage: true,
  agreements: [
    { id: "g-proposed", status: "proposed", kind: "program", counterparty: { name: "Lead Bank" }, products: [{ id: "p1", name: "Card" }], signatures: { app_side: false, counterparty_side: false } },
    { id: "g-accepted", status: "accepted", kind: "program", counterparty: { name: "Lead Bank" }, products: [{ id: "p1", name: "Card" }], signatures: { app_side: false, counterparty_side: true }, document_url: "https://docs.example.com/p.pdf" },
    { id: "g-half", status: "accepted", kind: "program", counterparty: { name: "Harbor Bank" }, products: [{ id: "p2", name: "Savings" }], signatures: { app_side: true, counterparty_side: false }, document_url: "javascript:alert(1)" },
    { id: "g-signed", status: "signed", kind: "data_sharing", counterparty: { name: "Harbor Bank" }, products: [], signatures: { app_side: true, counterparty_side: true } },
    { id: "g-ended", status: "terminated", kind: "program", counterparty: { name: "Lead Bank" }, products: [], termination_reason: "Program wound down" },
  ],
  products: AGREEMENTS.products.map((p) => ({ id: p.id, name: p.name, sponsors: [] })),
  program_coverage: [
    { product_id: "p1", product_name: "Card", sponsor_entity_id: SPONSOR, sponsor_name: "Lead Bank", covered: false, agreement_id: "g-ended", note: "it was ended on 2026-11-20: Program wound down" },
    { product_id: "p2", product_name: "Savings", sponsor_entity_id: OTHER_SPONSOR, sponsor_name: "Harbor Bank", covered: true, agreement_id: "g-x", note: null },
  ],
  production_gate: { met: false, missing: ["No signed program agreement with Lead Bank for Card (it was ended on 2026-11-20: Program wound down)"], flagged: true },
  vendor_contracts: [],
  introductions: null,
})!;

describe("Agreements tab: each row's labelled actions", () => {
  it("offers Withdraw on our proposal, Sign while our side hasn't signed, End agreement once accepted or signed, nothing once ended", () => {
    const html = renderToStaticMarkup(<panelTabs.AgreementsTabView appId={APP} data={WITH_ROWS} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    const labels = (id: string) => [...doc.querySelectorAll(`[data-agreement-actions="${id}"] [data-agreement-action]`)].map((b) => b.textContent);
    expect(labels("g-proposed")).toEqual(["Withdraw"]);
    expect(labels("g-accepted")).toEqual(["Sign", "End agreement"]);
    expect(labels("g-half")).toEqual(["End agreement"]);
    expect(labels("g-signed")).toEqual(["End agreement"]);
    expect(labels("g-ended")).toEqual([]);
    expect(html).toContain("Reason: Program wound down");
    // Only an https document is linked.
    expect(doc.querySelector('[data-agreement-document="g-accepted"]')?.getAttribute("href")).toBe("https://docs.example.com/p.pdf");
    expect(doc.querySelector('[data-agreement-document="g-half"]')).toBeNull();
    // A member (not an owner or admin) sees no actions.
    expect(renderToStaticMarkup(<panelTabs.AgreementsTabView appId={APP} data={{ ...WITH_ROWS, canManage: false }} />)).not.toContain("data-agreement-action=");
    expect(agreementActions({ statusKey: "proposed", appSigned: false, counterpartySigned: false }, "counterparty")).toEqual(["accept", "decline"]);
  });

  it("flags an app in production that lost a program agreement, and lists what production needs with a Propose agreement shortcut", () => {
    const html = renderToStaticMarkup(<panelTabs.AgreementsTabView appId={APP} data={WITH_ROWS} />);
    expect(html).toContain("data-production-flag");
    expect(html).toContain("No signed program agreement with Lead Bank for Card (it was ended on 2026-11-20: Program wound down)");
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect(doc.querySelector(`[data-coverage="p1/${SPONSOR}"]`)?.getAttribute("data-covered")).toBe("false");
    expect(doc.querySelector(`[data-coverage="p2/${OTHER_SPONSOR}"]`)?.textContent).toContain("Signed and in force");
    expect([...doc.querySelectorAll("[data-propose-for]")].map((b) => b.getAttribute("data-propose-for"))).toEqual([`p1/${SPONSOR}`]);
  });

  it("the shortcut opens Propose agreement pre-filled with that sponsor and product", async () => {
    const coverage = WITH_ROWS.coverage!;
    const { ProgramCoverage } = sheets;
    render(<ProgramCoverage appId={APP} coverage={coverage} canPropose sheetData={AGREEMENTS} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-propose-for="p1/${SPONSOR}"]`)!));
    expect((document.querySelector("[data-agreement-counterparty]") as HTMLSelectElement).value).toBe(SPONSOR);
    expect((document.querySelector('[data-agreement-product="p1"]') as HTMLInputElement).checked).toBe(true);
    expect((document.querySelector("[data-agreement-kind]") as HTMLSelectElement).value).toBe("program");
  });

  it("Sign and End agreement each open a sheet that says what it does and posts to this app's agreement route", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, message: "Done." }), { status: 200 });
    }) as unknown as typeof fetch;
    const summary = { id: AGREEMENT, title: "Program agreement with Lead Bank", lines: ["Covers: Card"] };
    let done = 0;
    const { rerender } = render(<sheets.AgreementActionSheet url={`/api/apps/${APP}/agreements/${AGREEMENT}`} action="sign" agreement={summary} onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    await act(async () => undefined);
    expect(screen.getByRole("heading", { name: "Sign agreement" })).toBeTruthy();
    await act(async () => void fireEvent.click(document.querySelector('[data-agreement-action-submit="sign"]')!));
    expect(requests.at(-1)).toEqual({ url: `/api/apps/${APP}/agreements/${AGREEMENT}`, body: { action: "sign" } });
    expect(done).toBe(1);
    rerender(<sheets.AgreementActionSheet url={`/api/apps/${APP}/agreements/${AGREEMENT}`} action="end" agreement={summary} onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    await act(async () => undefined);
    const submit = document.querySelector('[data-agreement-action-submit="end"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // the reason first
    fireEvent.change(document.querySelector("[data-agreement-reason]")!, { target: { value: "We're closing the card" } });
    await act(async () => void fireEvent.click(submit));
    expect(requests.at(-1)?.body).toEqual({ action: "terminate", reason: "We're closing the card" });
  });

  it("the route: own origin, a strict body, the user's app and one of its agreements, then sign or terminate", async () => {
    fake.tools = [{ name: "list_my_apps" }, { name: "list_app_agreements" }, { name: "sign_app_agreement" }, { name: "terminate_app_agreement" }];
    const call = (body: unknown, app = APP, id = AGREEMENT) =>
      agreementRoute.POST(new Request(`http://localhost:3000/api/apps/${app}/agreements/${id}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ appId: app, agreementId: id }) });
    fake.sameOrigin = false;
    expect((await call({ action: "sign" })).status).toBe(403);
    fake.sameOrigin = true;
    expect((await call({ action: "approve" })).status).toBe(400);
    // Accept and Decline: a proposal the other firm made (either side proposes); this Mynt has no respond tool for the app side yet.
    expect((await call({ action: "accept" })).status).toBe(501);
    expect((await call({ action: "terminate" })).status).toBe(400); // a reason
    expect((await call({ action: "sign", extra: 1 })).status).toBe(400);
    expect((await call({ action: "sign" }, APP, "not-a-uuid")).status).toBe(400);
    expect((await call({ action: "sign" }, "not-mine")).status).toBe(404);
    expect((await call({ action: "sign" }, APP, "44444444-4444-4444-8444-444444444444")).status).toBe(404); // not one of this app's
    expect((await call({ action: "sign" })).status).toBe(200);
    expect(fake.calls.find((c) => c.name === "sign_app_agreement")?.args).toEqual({ agreement_id: AGREEMENT });
    expect((await call({ action: "terminate", reason: "Closing it" })).status).toBe(200);
    expect(fake.calls.find((c) => c.name === "terminate_app_agreement")?.args).toEqual({ agreement_id: AGREEMENT, reason: "Closing it" });
    fake.refuse = "Your side has already signed it";
    const refused = await call({ action: "sign" });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("already signed");
  });
});

describe("Move to production: the program agreements check", () => {
  const checks = fromPromotionChecks(
    {
      app_id: APP,
      from_stage: "staging",
      to_stage: "production",
      can_promote: false,
      checks: [
        {
          id: "program_agreements",
          label: "Signed program agreement with each product's sponsor",
          status: "fail",
          detail: "No signed program agreement with Lead Bank for Card",
          fix: { label: "Propose agreement", href: `/${APP}?tab=agreements`, tool: "propose_app_agreement" },
          coverage: [{ product_id: "p1", product_name: "Card", sponsor_entity_id: SPONSOR, sponsor_name: "Lead Bank", covered: false, agreement_id: null, note: null }],
        },
      ],
    },
    "production",
  )!;

  it("shows the check in Mynt's words with each missing sponsor's Propose agreement shortcut, for owners and admins", () => {
    expect(checks.checks[0].coverage).toEqual([{ productId: "p1", productName: "Card", sponsorId: SPONSOR, sponsorName: "Lead Bank", covered: false, agreementId: null, note: null }]);
    const html = renderToStaticMarkup(<CheckList checks={checks.checks} name="Cards" to="Production" appId={APP} canPropose />);
    expect(html).toContain("No signed program agreement with Lead Bank for Card");
    expect(html).toContain(`data-propose-for="p1/${SPONSOR}"`);
    // Members see the rows, not the shortcut; without the app (a product's checks) it's the plain fix link.
    expect(renderToStaticMarkup(<CheckList checks={checks.checks} name="Cards" to="Production" appId={APP} />)).not.toContain("data-propose-for");
    expect(renderToStaticMarkup(<CheckList checks={checks.checks} name="Cards" to="Production" />)).toContain(`href="/${APP}?tab=agreements"`);
  });
});
