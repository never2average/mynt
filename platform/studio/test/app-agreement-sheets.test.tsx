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
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      return ok({ id: "g1", status: "proposed" });
    },
    close: async () => undefined,
  }),
}));

const sheets = await import("@/components/app-agreement-sheets");
const agreementsRoute = await import("@/app/api/apps/[appId]/agreements/route");
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
    fireEvent.click(submit);
    expect(sent).toEqual([{ counterparty_entity_id: SPONSOR, kind: "program", products: ["p1"], terms_summary: "Lead Bank's card program, standard terms", document_url: "https://docs.example.com/p.pdf", effective_from: "2026-12-01" }]);
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
    await act(async () => void fireEvent.click(document.querySelector("[data-propose-agreement-submit]")!));
    expect(requests[0].url).toBe(`/api/apps/${APP}/agreements`);
    expect(document.querySelector("[data-agreement-error]")?.textContent).toBe("Lead Bank doesn't sponsor 'p2'");
    expect(done).toBe(0);
    reply = { status: 200, body: { ok: true, message: "Agreement proposed." } };
    await act(async () => void fireEvent.click(document.querySelector("[data-propose-agreement-submit]")!));
    expect(document.querySelector("[data-agreement-result]")?.textContent).toBe("Agreement proposed.");
    expect(done).toBe(1);
  });

  it("the route: own origin, valid arguments, the user's app, then propose_app_agreement", async () => {
    const body = { counterparty_entity_id: SPONSOR, kind: "program", products: ["p1"], terms_summary: "Lead Bank's card program", document_url: "", effective_to: "" };
    fake.sameOrigin = false;
    expect((await post(agreementsRoute, body)).status).toBe(403);
    fake.sameOrigin = true;
    expect((await post(agreementsRoute, { ...body, kind: "licence" })).status).toBe(400);
    expect((await post(agreementsRoute, { ...body, app_id: "a9" })).status).toBe(400); // the app is the route's
    expect((await post(agreementsRoute, body, "not-mine")).status).toBe(404);
    const res = await post(agreementsRoute, body);
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.name === "propose_app_agreement")?.args).toEqual({ app_id: APP, counterparty_entity_id: SPONSOR, kind: "program", products: ["p1"], terms_summary: "Lead Bank's card program" });
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
