// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";

// The licence provider's side of app agreements: the Licences page's Agreements tab (what apps' workspaces proposed
// to or made with their firm), its row actions (Review agreement, Accept, Decline, Sign, End agreement), the routes
// behind them (same origin, a signed-in licence provider, only agreements Mynt lists to their firm, strict bodies),
// and who sees the tab.

const PROPOSED = "11111111-1111-4111-8111-111111111111";
const ACCEPTED = "22222222-2222-4222-8222-222222222222";
const SIGNED = "33333333-3333-4333-8333-333333333333";
const ENDED = "44444444-4444-4444-8444-444444444444";
const NOT_OURS = "55555555-5555-4555-8555-555555555555";

const REPLY = {
  entity_id: "e1",
  agreements: [
    { id: PROPOSED, kind: "program", status: "proposed", app: { id: "a1", name: "Cards" }, workspace: { id: "w1", name: "Acme Labs" }, products: [{ id: "p1", name: "Card" }], terms_summary: "Lead Bank's card program, standard terms", document_url: "https://docs.example.com/p.pdf", effective_from: "2026-12-01", effective_to: null, signatures: { app_side: false, counterparty_side: false } },
    { id: ACCEPTED, kind: "program", status: "accepted", app: { id: "a2", name: "Savings" }, workspace: { id: "w2", name: "Beta Co" }, products: [{ id: "p2", name: "Savings" }], terms_summary: "Savings program", document_url: "http://docs.example.com/plain.pdf", effective_from: null, effective_to: null, signatures: { app_side: true, counterparty_side: false } },
    { id: SIGNED, kind: "data_sharing", status: "signed", app: { id: "a1", name: "Cards" }, workspace: { id: "w1", name: "Acme Labs" }, products: [], terms_summary: "Data sharing", signatures: { app_side: true, counterparty_side: true } },
    { id: ENDED, kind: "program", status: "terminated", app: { id: "a3", name: "Old" }, workspace: null, products: [], terms_summary: "Old program", termination_reason: "Program wound down", signatures: { app_side: true, counterparty_side: true } },
  ],
};

const fake = { session: undefined as Session | undefined, sameOrigin: true, tools: [] as { name: string }[], calls: [] as { name: string; args: Record<string, unknown> }[], refuse: null as string | null };
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_app_agreements") return ok(REPLY);
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      return ok({ id: args.agreement_id, status: "accepted" });
    },
    close: async () => undefined,
  }),
}));

const { lpAgreementsFrom, isLicenceProvider } = await import("@/lib/lp-agreements");
const view = await import("@/components/lp-agreements-view");
const listRoute = await import("@/app/api/agreements/route");
const actionRoute = await import("@/app/api/agreements/[agreementId]/route");
const { licencesTabOf, seesLicences } = await import("@/lib/licences-tabs");
const { pageGateFor } = await import("@/components/studio-gates");

const LP_SESSION = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["license_provider"], rolesAt: Date.now() } as Session;
beforeEach(() => {
  fake.session = { ...LP_SESSION };
  fake.sameOrigin = true;
  fake.tools = [{ name: "list_app_agreements" }, { name: "respond_to_app_agreement" }, { name: "sign_app_agreement" }, { name: "terminate_app_agreement" }];
  fake.calls = [];
  fake.refuse = null;
});
afterEach(() => cleanup());

const ROWS = lpAgreementsFrom(REPLY)!;

describe("the provider's agreements", () => {
  it("reads each with its app, developer workspace, products, kind, status in words and what the firm may do now", () => {
    expect(ROWS.map((r) => [r.appName, r.workspace, r.products, r.kind, r.status, r.actions])).toEqual([
      ["Cards", "Acme Labs", ["Card"], "Program agreement", "Proposed: waiting for your answer", ["accept", "decline"]],
      ["Savings", "Beta Co", ["Savings"], "Program agreement", "Accepted: waiting for signatures", ["sign", "end"]],
      ["Cards", "Acme Labs", [], "Data sharing", "Signed", ["end"]],
      ["Old", "Unnamed workspace", [], "Program agreement", "Ended", []],
    ]);
    expect(ROWS[1].signatures).toBe("You haven't signed; the app's side signed");
    // Only https documents are linked.
    expect(ROWS[0].documentUrl).toBe("https://docs.example.com/p.pdf");
    expect(ROWS[1].documentUrl).toBeNull();
    expect(lpAgreementsFrom({ nope: true })).toBeNull();
    expect(isLicenceProvider(["license_provider"])).toBe(true);
    expect(isLicenceProvider(["developer"])).toBe(false);
  });

  it("the tab: one table with labelled actions per row (Review agreement, Accept, Decline, Sign, End agreement), never icon-only", () => {
    const html = renderToStaticMarkup(<view.LpAgreementsView rows={ROWS} />);
    const doc = new DOMParser().parseFromString(html, "text/html");
    expect([...doc.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["App", "Other party", "Products", "Kind", "Status", "Effective", "Document", "Actions"]);
    const labels = (id: string) => [...doc.querySelectorAll(`[data-agreement-actions="${id}"] [data-agreement-action]`)].map((b) => b.textContent);
    expect(labels(PROPOSED)).toEqual(["Accept", "Decline"]);
    expect(labels(ACCEPTED)).toEqual(["Sign", "End agreement"]);
    expect(labels(SIGNED)).toEqual(["End agreement"]);
    expect(labels(ENDED)).toEqual([]);
    // The Business agreements tab lists program and data-sharing agreements: all four here.
    expect(doc.querySelectorAll("[data-review]").length).toBe(4);
    expect(doc.querySelector(`[data-review="${PROPOSED}"]`)?.textContent).toBe("Review agreement");
    expect(doc.querySelector(`[data-lp-document="${PROPOSED}"]`)?.getAttribute("href")).toBe("https://docs.example.com/p.pdf");
    expect(doc.querySelector("[data-lp-waiting]")?.textContent).toContain("2 agreements wait for you");
    expect(html).toContain('aria-label="Search agreements"');
    expect(html).toContain("Export CSV");
    expect(renderToStaticMarkup(<view.LpAgreementsView rows={[]} />)).toContain("No agreements yet");
  });

  it("search and the status filter narrow the rows; Export CSV writes what's shown", () => {
    expect(view.filterLpAgreements(ROWS, { query: "beta" }).map((r) => r.id)).toEqual([ACCEPTED]);
    expect(view.filterLpAgreements(ROWS, { status: ["signed"] }).map((r) => r.id)).toEqual([SIGNED]);
    expect(view.filterLpAgreements(ROWS, { query: "card", status: ["proposed"] }).map((r) => r.id)).toEqual([PROPOSED]);
    expect(view.filterLpAgreements(ROWS, { kind: ["data_sharing"] }).map((r) => r.id)).toEqual([SIGNED]);
    expect(view.lpAgreementsCsv([ROWS[0]]).split("\n")[1]).toContain("Cards,Acme Labs,Your firm's side,Them,Card,Program agreement,Proposed,2026-12-01");
  });

  it("Review agreement shows the terms in full, with the same actions; Accept opens a sheet that posts to the firm's route", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, message: "Accepted." }), { status: 200 });
    }) as unknown as typeof fetch;
    let changed = 0;
    render(<view.LpAgreementsView rows={ROWS} onChanged={() => changed++} fetcher={fetcher} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-review="${PROPOSED}"]`)!));
    expect(screen.getByRole("heading", { name: "Review agreement" })).toBeTruthy();
    expect(document.querySelector("[data-agreement-terms]")?.textContent).toBe("Lead Bank's card program, standard terms");
    const inReview = document.querySelector(`[data-review-agreement="${PROPOSED}"] [data-agreement-action="accept"]`) as HTMLButtonElement;
    await act(async () => void fireEvent.click(inReview));
    expect(screen.getByRole("heading", { name: "Accept agreement" })).toBeTruthy();
    fireEvent.change(document.querySelector("[data-agreement-reason]")!, { target: { value: "Happy to" } });
    await act(async () => void fireEvent.click(document.querySelector('[data-agreement-action-submit="accept"]')!));
    expect(requests).toEqual([{ url: `/api/agreements/${PROPOSED}`, body: { action: "accept", note: "Happy to" } }]);
    expect(document.querySelector("[data-agreement-action-result]")?.textContent).toBe("Accepted.");
    expect(changed).toBe(1);
  });

  it("End agreement needs a reason", async () => {
    const requests: unknown[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ ok: true, message: "Ended." }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<view.LpAgreementsView rows={ROWS} fetcher={fetcher} />);
    await act(async () => void fireEvent.click(document.querySelector(`[data-agreement-actions="${SIGNED}"] [data-agreement-action="end"]`)!));
    const submit = document.querySelector('[data-agreement-action-submit="end"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(document.querySelector("[data-agreement-reason]")!, { target: { value: "Program wound down" } });
    await act(async () => void fireEvent.click(submit));
    expect(requests).toEqual([{ action: "terminate", reason: "Program wound down" }]);
  });
});

describe("the routes", () => {
  const get = () => listRoute.GET(new Request("http://localhost:3000/api/agreements"));
  const post = (body: unknown, id = PROPOSED) =>
    actionRoute.POST(new Request(`http://localhost:3000/api/agreements/${id}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ agreementId: id }) });

  it("GET: a licence provider's own firm's agreements (list_app_agreements without app_id); nobody else's", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.name === "list_app_agreements")?.args).toEqual({});
    expect(((await res.json()) as { agreements: { id: string }[] }).agreements.map((a) => a.id)).toEqual([PROPOSED, ACCEPTED, SIGNED, ENDED]);
    fake.session = { ...LP_SESSION, roles: ["consumer"] };
    expect((await get()).status).toBe(403);
    fake.session = undefined;
    expect((await get()).status).toBe(401);
  });

  it("POST: own origin, a strict body, an agreement Mynt lists to the firm, then the matching tool", async () => {
    fake.sameOrigin = false;
    expect((await post({ action: "accept" })).status).toBe(403);
    fake.sameOrigin = true;
    expect((await post({ action: "approve" })).status).toBe(400);
    expect((await post({ action: "terminate" })).status).toBe(400); // a reason
    expect((await post({ action: "sign", note: "x" })).status).toBe(400);
    expect((await post({ action: "accept" }, "not-a-uuid")).status).toBe(400);
    expect((await post({ action: "accept" }, NOT_OURS)).status).toBe(404);

    expect((await post({ action: "accept", note: "Happy to" })).status).toBe(200);
    expect((await post({ action: "decline" })).status).toBe(200);
    expect((await post({ action: "sign" }, ACCEPTED)).status).toBe(200);
    expect((await post({ action: "terminate", reason: "Program wound down" }, SIGNED)).status).toBe(200);
    expect(fake.calls.filter((c) => c.name !== "list_app_agreements")).toEqual([
      { name: "respond_to_app_agreement", args: { agreement_id: PROPOSED, decision: "accept", note: "Happy to" } },
      { name: "respond_to_app_agreement", args: { agreement_id: PROPOSED, decision: "decline" } },
      { name: "sign_app_agreement", args: { agreement_id: ACCEPTED } },
      { name: "terminate_app_agreement", args: { agreement_id: SIGNED, reason: "Program wound down" } },
    ]);

    fake.refuse = "That agreement is accepted, not waiting for an answer";
    const refused = await post({ action: "decline" });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { message: string }).message).toContain("not waiting for an answer");
    fake.refuse = null;
    fake.session = { ...LP_SESSION, roles: ["consumer"] };
    expect((await post({ action: "accept" })).status).toBe(403);
    fake.session = { ...LP_SESSION };
    fake.tools = [{ name: "list_app_agreements" }];
    expect((await post({ action: "accept" })).status).toBe(501);
  });
});

describe("who sees the Licences page", () => {
  it("licence providers, even without the developer role, and developers; the old Agreements tab is Business agreements", () => {
    expect(seesLicences({ developer: true })).toBe(true);
    expect(seesLicences({ developer: false, licenceProvider: true })).toBe(true);
    expect(seesLicences({ developer: false, licenceProvider: false })).toBe(false);
    expect(licencesTabOf("agreements")).toBe("business-agreements");
    expect(licencesTabOf("coverage")).toBe("business-agreements");
    const lpOnly = { developer: false, licenceProvider: true, liquidity: { builder: false, liquidityProvider: false }, owner: null };
    expect(pageGateFor("/licences", lpOnly, false)).toBe("none");
    expect(pageGateFor("/audits", lpOnly, false)).toBe("developer");
    expect(pageGateFor("/licences", { ...lpOnly, licenceProvider: false }, false)).toBe("developer");
  });
});
