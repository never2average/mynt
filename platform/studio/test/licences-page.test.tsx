// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";

// The Licences page: four tabs in the page body (Business Agreements, MSA, SLA, Audit Obligations), no row of
// figures, each tab role-aware (either side proposes, the other accepts or declines, both sign); an SLA's
// Commitments and Breaches with their sheets, routes and tools; Audit obligations only presented.

const A_PROGRAM = "11111111-1111-4111-8111-111111111111";
const A_MSA = "22222222-2222-4222-8222-222222222222";
const A_SLA = "33333333-3333-4333-8333-333333333333";
const SLA = "44444444-4444-4444-8444-444444444444";
const BREACH = "55555555-5555-4555-8555-555555555555";
const FIRM = "66666666-6666-4666-8666-666666666666";
const AUDIT = "77777777-7777-4777-8777-777777777777";

const agreement = (over: Record<string, unknown>) => ({
  kind: "program",
  status: "proposed",
  proposed_by_side: "app",
  app: { id: "a1", name: "Cards" },
  workspace: { id: "w1", name: "Acme Labs" },
  counterparty: { entity_id: FIRM, name: "Lead Bank" },
  products: [{ id: "p1", name: "Card" }],
  terms_summary: "The terms",
  signatures: { app_side: false, counterparty_side: false },
  ...over,
});
const FIRM_REPLY = {
  agreements: [
    agreement({ id: A_PROGRAM, proposed_by_side: "counterparty" }),
    agreement({ id: A_MSA, kind: "msa", app: null, products: [], status: "accepted", signatures: { app_side: true, counterparty_side: false } }),
    agreement({ id: A_SLA, kind: "sla", app: null, products: [], status: "signed", signatures: { app_side: true, counterparty_side: true } }),
  ],
  proposable_workspaces: [{ workspace: { id: "w1", name: "Acme Labs" }, apps: [{ id: "a1", name: "Cards", product_ids: ["p1"] }] }],
};
const SLA_REPLY = {
  agreements: [{ id: A_SLA, kind: "sla", status: "signed", can_add_slas: false }],
  slas: [
    {
      id: SLA,
      agreement_id: A_SLA,
      metric: "Ledger API availability",
      target: "99.9",
      unit: "%",
      measurement_window: "monthly",
      measurement_source: "Status page",
      remedy: "Service credit",
      status: "active",
      app: null,
      counterparty: { name: "Lead Bank" },
      open_breaches: 1,
      breaches: [{ id: BREACH, sla_id: SLA, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: "99.1", recorded_side: "app", recorded_by: { id: "u1", name: "Dana" }, created_at: "2026-11-02T00:00:00Z", resolved_at: null, open: true, actions: ["resolve"] }],
      actions: ["record_breach", "retire"],
    },
  ],
};
const AUDITS = {
  agreements: [{ id: A_PROGRAM, kind: "program", status: "signed", app: { id: "a1", name: "Cards" }, counterparty: { entity_id: FIRM, name: "Lead Bank" }, your_side: "counterparty", can_add_requirements: true }],
  requirements: [],
  audits: [
    {
      id: AUDIT,
      agreement_id: A_PROGRAM,
      requirement_id: "r1",
      app_id: "a1",
      due_at: "2026-11-20T23:59:59.000Z",
      status: "scheduled",
      overdue: true,
      findings_open: 0,
      findings: [],
      evidence: [],
      requirement: { id: "r1", name: "Quarterly complaints review", kind: "complaints_review", cadence: "quarterly" },
      agreement: { id: A_PROGRAM, kind: "program", status: "signed" },
      app: { id: "a1", name: "Cards" },
      counterparty: { entity_id: FIRM, name: "Lead Bank" },
      your_side: "counterparty",
      actions: ["open", "fail", "waive"],
    },
  ],
  counts: { audits: 1, open: 1, overdue: 1 },
};

const fake = { session: undefined as Session | undefined, tools: [] as { name: string; inputSchema?: unknown }[], calls: [] as { name: string; args: Record<string, unknown> }[] };
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => true, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_app_agreements") return ok(FIRM_REPLY);
      if (name === "list_agreement_slas") return ok(SLA_REPLY);
      if (name === "list_workspaces") return ok({ workspaces: [{ id: "w1", name: "Acme Labs", role: "owner" }] });
      return ok({ ok: true });
    },
    close: async () => undefined,
  }),
}));

// The page's data, as its routes answer (useComplianceData), and the person's roles.
const pageData = { access: { developer: false, licenceProvider: true } };
vi.mock("@/lib/use-liquidity-access", () => ({ useStudioAccess: () => ({ ...pageData.access, liquidity: { builder: false, liquidityProvider: false }, owner: null }) }));
vi.mock("@/lib/use-compliance", async () => {
  const { lpAgreementsFrom, proposeTargetsFrom } = await import("@/lib/lp-agreements");
  const { fromSlaList } = await import("@/lib/agreement-slas");
  const { fromAgreementAuditList } = await import("@/lib/agreement-audits");
  const bodies: Record<string, Record<string, unknown>> = {
    "/api/agreements": { agreements: lpAgreementsFrom(FIRM_REPLY), targets: proposeTargetsFrom(FIRM_REPLY, "counterparty") },
    "/api/agreement-slas": { supported: true, list: fromSlaList(SLA_REPLY) },
    "/api/agreement-audits": { supported: true, list: fromAgreementAuditList(AUDITS), canAddRequirement: true },
  };
  return {
    useComplianceData: (path: string, pick: (b: Record<string, unknown>) => unknown) => {
      const data = pick(bodies[path] ?? {});
      return { state: data === undefined ? { kind: "error", message: "nope" } : { kind: "ready", data }, reload: () => undefined };
    },
  };
});

const { LicencesPage } = await import("@/app/(studio)/licences/licences-page");
const { LpAgreementsView } = await import("@/components/lp-agreements-view");
const { lpAgreementsFrom, appAgreementsFrom, proposeTargetsFrom } = await import("@/lib/lp-agreements");
const { ProposeView } = await import("@/components/propose-agreement-sheet");
const { slaRequest, SlaSheet } = await import("@/components/agreement-slas-view");
const { fromSlaList } = await import("@/lib/agreement-slas");
const { fromAgreementAudit } = await import("@/lib/agreement-audits");
const agreementsRoute = await import("@/app/api/agreements/route");
const slaRoute = await import("@/app/api/agreement-slas/route");
const slaActionRoute = await import("@/app/api/agreement-slas/[slaId]/route");
const { HEADER_TABS_ID } = await import("@/components/site-header");

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
beforeEach(() => {
  fake.session = session(["license_provider"]);
  fake.tools = ["list_app_agreements", "propose_workspace_agreement", "propose_app_agreement", "list_agreement_slas", "add_agreement_sla", "record_sla_breach", "resolve_sla_breach", "retire_agreement_sla"].map((name) => ({ name }));
  fake.calls = [];
  pageData.access = { developer: false, licenceProvider: true };
  window.history.replaceState(null, "", "/licences");
});
afterEach(() => cleanup());

const click = async (el: Element | null) => act(async () => void fireEvent.click(el!));

describe("the page", () => {
  it("has exactly four tabs in the page body, none in the header row, and no row of figures", () => {
    const header = document.createElement("div");
    header.id = HEADER_TABS_ID;
    document.body.appendChild(header);
    const { container } = render(<LicencesPage />);
    const tabs = [...container.querySelectorAll('[role="tablist"][aria-label="Licences"] [role="tab"]')].map((t) => t.textContent);
    expect(tabs).toEqual(["Business Agreements", "MSA", "SLA", "Audit Obligations"]);
    expect(header.innerHTML).toBe("");
    for (const gone of ["licence-figures", "data-licences-summary", 'data-slot="card"', "data-view-toggle", "data-map-view"]) expect(container.innerHTML).not.toContain(gone);
    header.remove();
  });

  it("each tab lists its kinds: Business agreements program and data sharing, MSA its MSAs, SLA its SLAs; the address follows the tab", async () => {
    const { container } = render(<LicencesPage />);
    const rows = () => [...container.querySelectorAll("[data-lp-agreement]")].map((r) => r.getAttribute("data-lp-agreement"));
    expect(rows()).toEqual([A_PROGRAM]);
    expect(container.querySelector("[data-propose-agreement]")?.textContent).toBe("Propose agreement");
    await click(container.querySelector('[data-tab="msa"]'));
    expect(window.location.search).toBe("?tab=msa");
    expect(rows()).toEqual([A_MSA]);
    expect(container.querySelector("[data-propose-agreement]")?.textContent).toBe("Propose MSA");
    await click(container.querySelector('[data-tab="sla"]'));
    expect(rows()).toEqual([A_SLA]);
    expect(container.querySelector("[data-propose-agreement]")?.textContent).toBe("Propose SLA");
    await click(container.querySelector('[data-tab="business-agreements"]'));
    expect(window.location.pathname + window.location.search).toBe("/licences");
  });

  it("Audit obligations only presents: no Add audit requirement, and the audit's sheet has no actions", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ audit: fromAgreementAudit({ ...AUDITS.audits[0], history: [] }) }), { status: 200 }));
    // Mynt would let this licence provider open, fail or waive it: the tab still shows none of that.
    expect(fromAgreementAudit({ ...AUDITS.audits[0], history: [] })?.actions).toEqual(["open", "fail", "waive"]);
    const { container } = render(<LicencesPage initialTab="audit-obligations" />);
    expect(container.querySelector('[data-tab="audit-obligations"]')?.getAttribute("data-state")).toBe("active");
    expect(container.querySelector(`[data-agreement-audit="${AUDIT}"]`)?.textContent).toContain("Overdue");
    expect(container.querySelector("[data-add-audit-requirement]")).toBeNull();
    await click(container.querySelector(`[data-open-audit="${AUDIT}"]`));
    await act(async () => undefined);
    expect(document.querySelector("[data-agreement-audit-sheet]")?.textContent).toContain("Quarterly");
    await waitFor(() => expect(document.querySelector("[data-agreement-audit-sheet]")?.textContent).toContain("Cadence"));
    expect(document.querySelector("[data-audit-actions]")).toBeNull();
    fetcher.mockRestore();
  });
});


describe("either side proposes; the other answers", () => {
  it("a licence provider's proposal waits for the app's side: Accept and Decline there, Withdraw for the firm", () => {
    const lp = lpAgreementsFrom(FIRM_REPLY)!;
    expect(lp[0].actions).toEqual(["withdraw"]);
    expect(lp[0].status).toBe("Proposed: waiting for them");
    const dev = appAgreementsFrom({ can_manage: true, agreements: [FIRM_REPLY.agreements[0]] })!;
    expect(dev.rows[0].actions).toEqual(["accept", "decline"]);
    expect(dev.rows[0].status).toBe("Proposed: waiting for your answer");
    // A member who doesn't manage the workspace reads them only.
    expect(appAgreementsFrom({ can_manage: false, agreements: [FIRM_REPLY.agreements[0]] })!.rows[0].actions).toEqual([]);
    // Mynt's own list of actions wins where it gives one.
    expect(lpAgreementsFrom({ agreements: [agreement({ id: A_PROGRAM, actions: ["sign", "bogus"] })] })![0].actions).toEqual(["sign"]);
    // An MSA binds the whole workspace.
    expect(lp[1].appName).toBe("Whole workspace");
  });

  it("the developer's table shows Accept and Decline on the firm's proposal, posting to the agreement's route", async () => {
    const rows = appAgreementsFrom({ can_manage: true, agreements: [FIRM_REPLY.agreements[0]] })!.rows;
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ message: "Accepted." }), { status: 200 });
    }) as unknown as typeof fetch;
    render(<LpAgreementsView rows={rows} fetcher={fetcher} />);
    const labels = [...document.querySelectorAll(`[data-agreement-actions="${A_PROGRAM}"] [data-agreement-action]`)].map((b) => b.textContent);
    expect(labels).toEqual(["Accept", "Decline"]);
    await click(document.querySelector(`[data-agreement-actions="${A_PROGRAM}"] [data-agreement-action="accept"]`));
    await click(document.querySelector('[data-agreement-action-submit="accept"]'));
    expect(requests).toEqual([{ url: `/api/agreements/${A_PROGRAM}`, body: { action: "accept" } }]);
  });

  it("Propose agreement: a licence provider picks the workspace, the app and its products, and a template as the starting document", async () => {
    const sent: unknown[] = [];
    const templates = [{ id: "88888888-8888-4888-8888-888888888888", name: "Program MSA", version: 2, attachedTo: "Your firm's default", file: "msa.pdf", sha256: null, active: true, createdAt: null, notes: null }];
    render(<ProposeView targets={proposeTargetsFrom(FIRM_REPLY, "counterparty")} kinds={["program", "data_sharing"]} templates={templates} onSubmit={(b) => sent.push(b)} />);
    expect(document.querySelector("[data-propose-target]")?.textContent).toBe("Acme Labs");
    fireEvent.change(document.querySelector("[data-propose-app]")!, { target: { value: "a1" } });
    fireEvent.click(document.querySelector('[data-propose-products] input[type="checkbox"]')!);
    fireEvent.change(document.querySelector("[data-propose-terms]")!, { target: { value: "Lead Bank's card program terms" } });
    fireEvent.change(document.querySelector("[data-propose-template]")!, { target: { value: templates[0].id } });
    await click(document.querySelector("[data-propose-submit]"));
    expect(sent).toEqual([{ side: "counterparty", target_id: "w1", app_id: "a1", kind: "program", products: ["p1"], terms_summary: "Lead Bank's card program terms", template_id: templates[0].id }]);
  });

  it("the route: a licence provider's proposal is propose_workspace_agreement; a developer's is propose_app_agreement; nobody proposes from a side they don't hold", async () => {
    const post = (body: unknown) => agreementsRoute.POST(new Request("http://localhost:3000/api/agreements", { method: "POST", body: JSON.stringify(body) }));
    const base = { kind: "msa", products: [], terms_summary: "Master services terms for both" };
    expect((await post({ ...base, side: "counterparty", target_id: "w1", template_id: "88888888-8888-4888-8888-888888888888" })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "propose_workspace_agreement", args: { workspace_id: "w1", kind: "msa", terms_summary: "Master services terms for both", template_id: "88888888-8888-4888-8888-888888888888" } });
    expect((await post({ ...base, side: "app", target_id: FIRM, app_id: "a1" })).status).toBe(403);
    fake.session = session(["developer"]);
    expect((await post({ ...base, side: "app", target_id: FIRM, app_id: "a1", kind: "program", products: ["p1"] })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "propose_app_agreement", args: { app_id: "a1", counterparty_entity_id: FIRM, kind: "program", products: ["p1"], terms_summary: "Master services terms for both" } });
    // A program agreement names its app; templates are the licence provider's.
    expect((await post({ ...base, kind: "program", side: "app", target_id: FIRM })).status).toBe(400);
    expect((await post({ ...base, side: "app", target_id: FIRM, app_id: "a1", template_id: "88888888-8888-4888-8888-888888888888" })).status).toBe(400);
  });

  it("GET: a licence provider's firm agreements with the workspaces it may propose to", async () => {
    const body = await (await agreementsRoute.GET(new Request("http://localhost:3000/api/agreements"))).json();
    expect(body.agreements.map((a: { id: string }) => a.id)).toEqual([A_PROGRAM, A_MSA, A_SLA]);
    expect(body.targets).toEqual([{ side: "counterparty", id: "w1", name: "Acme Labs", apps: [{ id: "a1", name: "Cards", productIds: ["p1"] }] }]);
    expect(fake.calls[0]).toEqual({ name: "list_app_agreements", args: {} });
  });
});

describe("an SLA's commitments and breaches", () => {
  const list = fromSlaList(SLA_REPLY)!;

  it("reads each commitment with its target and unit, window, open breaches and actions", () => {
    expect(list.slas[0]).toMatchObject({ metric: "Ledger API availability", target: "99.9 %", window: "Monthly", openBreaches: 1, actions: ["record_breach", "retire"] });
    expect(list.slas[0].breaches[0]).toMatchObject({ measured: "99.1", recordedBy: "Dana", open: true, canResolve: true });
    expect(fromSlaList({ nope: 1 })).toBeNull();
  });

  it("the SLA agreement's detail: Commitments and Breaches tabs, each a table, with labelled actions", async () => {
    const { container } = render(<LicencesPage initialTab="sla" />);
    await click(container.querySelector(`[data-review="${A_SLA}"]`));
    const tabs = [...document.querySelectorAll("[data-detail-tab]")].map((t) => t.textContent);
    expect(tabs).toEqual(["Commitments", "Breaches", "Products", "Signatures"]);
    expect(document.querySelector('[data-detail-table="commitments"]')?.textContent).toContain("Ledger API availability");
    expect(document.querySelector(`[data-record-breach="${SLA}"]`)?.textContent).toBe("Record breach");
    expect(document.querySelector(`[data-retire-sla="${SLA}"]`)?.textContent).toBe("Retire commitment");
    await click(document.querySelector('[data-detail-tab="breaches"]'));
    expect(document.querySelector(`[data-resolve-breach="${BREACH}"]`)?.textContent).toBe("Resolve breach");
    // Signed: no Add commitment (Mynt says it can't take more).
    expect(document.querySelector("[data-add-sla]")).toBeNull();
  });

  it("each sheet posts to its route", () => {
    const s = list.slas[0];
    expect(slaRequest({ kind: "add", agreementId: A_SLA, title: "" }, { metric: "Uptime", target: "99.9", unit: "%", window: "monthly", source: "Status page" })).toEqual({
      url: "/api/agreement-slas",
      body: { agreement_id: A_SLA, metric: "Uptime", target: 99.9, unit: "%", measurement_window: "monthly", measurement_source: "Status page", remedy: "" },
    });
    expect(slaRequest({ kind: "record_breach", sla: s }, { from: "2026-10-01", to: "2026-10-31", measured: "99.1" }).body).toEqual({ action: "record_breach", period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 99.1, note: "" });
    expect(slaRequest({ kind: "resolve_breach", sla: s, breach: s.breaches[0] }, {}).body).toEqual({ action: "resolve_breach", breach_id: BREACH, note: "" });
    expect(slaRequest({ kind: "retire", sla: s }, { reason: "Replaced" })).toEqual({ url: `/api/agreement-slas/${SLA}`, body: { action: "retire", reason: "Replaced" } });
  });

  it("Record breach: the sheet sends the period and the measured value", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ message: "Breach recorded." }), { status: 200 });
    }) as unknown as typeof fetch;
    let done = 0;
    render(<SlaSheet mode={{ kind: "record_breach", sla: list.slas[0] }} onClose={() => undefined} onDone={() => done++} fetcher={fetcher} />);
    const submit = document.querySelector('[data-sla-submit="record_breach"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(document.querySelector("[data-breach-from]")!, { target: { value: "2026-10-01" } });
    fireEvent.change(document.querySelector("[data-breach-to]")!, { target: { value: "2026-10-31" } });
    fireEvent.change(document.querySelector("[data-breach-measured]")!, { target: { value: "98.7" } });
    await click(submit);
    expect(requests).toEqual([{ url: `/api/agreement-slas/${SLA}`, body: { action: "record_breach", period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 98.7, note: "" } }]);
    expect(done).toBe(1);
    expect(document.querySelector("[data-sla-result]")?.textContent).toBe("Breach recorded.");
  });

  it("the routes call Mynt's tools, strictly", async () => {
    const list = await (await slaRoute.GET(new Request("http://localhost:3000/api/agreement-slas"))).json();
    expect(list.list.slas[0].id).toBe(SLA);
    expect(fake.calls.at(-1)).toEqual({ name: "list_agreement_slas", args: { side: "counterparty", include_retired: true } });
    const add = (body: unknown) => slaRoute.POST(new Request("http://localhost:3000/api/agreement-slas", { method: "POST", body: JSON.stringify(body) }));
    expect((await add({ agreement_id: A_SLA, metric: "Uptime", target: 99.9, unit: "%", measurement_window: "monthly", measurement_source: "Status page", remedy: "" })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "add_agreement_sla", args: { agreement_id: A_SLA, metric: "Uptime", target: 99.9, unit: "%", measurement_window: "monthly", measurement_source: "Status page" } });
    expect((await add({ agreement_id: A_SLA, metric: "Uptime", target: 99.9, measurement_window: "hourly", measurement_source: "x" })).status).toBe(400);
    const act = (body: unknown, id = SLA) => slaActionRoute.POST(new Request(`http://localhost:3000/api/agreement-slas/${id}`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ slaId: id }) });
    expect((await act({ action: "record_breach", period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 99.1 })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "record_sla_breach", args: { sla_id: SLA, period_start: "2026-10-01", period_end: "2026-10-31", measured_value: 99.1 } });
    expect((await act({ action: "resolve_breach", breach_id: BREACH, note: "Credited" })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "resolve_sla_breach", args: { breach_id: BREACH, note: "Credited" } });
    expect((await act({ action: "retire", reason: "Replaced" })).status).toBe(200);
    expect(fake.calls.at(-1)).toEqual({ name: "retire_agreement_sla", args: { sla_id: SLA, reason: "Replaced" } });
    expect((await act({ action: "retire" })).status).toBe(400);
    expect((await act({ action: "retire", reason: "Replaced" }, "nope")).status).toBe(400);
    fake.session = session(["consumer"]);
    expect((await act({ action: "retire", reason: "Replaced" })).status).toBe(403);
  });
});

describe("renders on the server", () => {
  it("the Business agreements table, with Import disabled and saying why", () => {
    const html = renderToStaticMarkup(<LpAgreementsView rows={lpAgreementsFrom(FIRM_REPLY)!} />);
    expect(html).toContain("data-import");
    expect(html).toContain("there&#x27;s nothing to import");
    expect(html).toContain("Export CSV");
  });
});
