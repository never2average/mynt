// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { csvRow, filterAgreementAudits, findingsText, fromAgreementAudit, fromAgreementAuditList, NO_AGREEMENT_AUDIT_FILTERS, summariesByAgreement } from "@/lib/agreement-audits";
import { parseStudioCall } from "@/lib/studio-tools";

// The Audits page's Agreement audits tab: oversight audits licence providers run on apps under
// program agreements. The table (toolbar, status in words, filters), the detail sheet (a card,
// labelled actions for the caller's side, Findings / Evidence / History tables), Add audit
// requirement, and the routes (same origin, developers and licence providers only, small strict
// bodies, each action one of Mynt's tools).

const AG1 = "11111111-1111-4111-8111-111111111111";
const AG2 = "22222222-2222-4222-8222-222222222222";
const AUDIT = "33333333-3333-4333-8333-333333333333";
const FINDING = "44444444-4444-4444-8444-444444444444";
const LP_FIRM = "55555555-5555-4555-8555-555555555555";
const SHA = "a".repeat(64);

const audit = (over: Record<string, unknown> = {}) => ({
  id: AUDIT,
  agreement_id: AG1,
  requirement_id: "r1",
  app_id: "app1",
  due_at: "2026-11-20T23:59:59.000Z",
  status: "submitted",
  overdue: true,
  findings_open: 1,
  findings: [{ id: FINDING, severity: "high", title: "Complaints unanswered", detail: "Tickets 12 and 19", status: "open", recorded_by: "u-lp", recorded_at: "2026-11-01T10:00:00Z", responses: [{ by: "u-dev", at: "2026-11-02T10:00:00Z", text: "Answered both" }] }],
  evidence: [{ id: "e1", name: "Complaints log", url: "https://files.example.com/log.csv", sha256: SHA, submitted_by: "u-dev", submitted_at: "2026-11-02T09:00:00Z" }],
  requirement: { id: "r1", name: "Quarterly complaints review", kind: "complaints_review", cadence: "quarterly", evidence_required: "The complaints log" },
  agreement: { id: AG1, kind: "program", status: "signed" },
  app: { id: "app1", name: "Pay app" },
  counterparty: { entity_id: LP_FIRM, name: "Sponsor Bank" },
  your_side: "app",
  actions: ["submit_evidence", "respond_to_finding"],
  ...over,
});
const LIST = {
  agreements: [
    { id: AG1, kind: "program", status: "signed", app: { id: "app1", name: "Pay app" }, counterparty: { entity_id: LP_FIRM, name: "Sponsor Bank" }, your_side: "app", can_add_requirements: false },
    { id: AG2, kind: "program", status: "proposed", app: { id: "app2", name: "Card app" }, counterparty: { entity_id: LP_FIRM, name: "Sponsor Bank" }, your_side: "counterparty", can_add_requirements: true },
  ],
  requirements: [{ id: "r1", agreement_id: AG1, name: "Quarterly complaints review", kind: "complaints_review", cadence: "quarterly", next_due: "2026-11-20T23:59:59.000Z", audits: 3, overdue: true, retired_at: null }],
  audits: [
    audit(),
    audit({ id: "66666666-6666-4666-8666-666666666666", agreement_id: AG2, app_id: "app2", app: { id: "app2", name: "Card app" }, status: "passed", overdue: false, findings: [], findings_open: 0, due_at: "2026-08-20T23:59:59.000Z", requirement: { id: "r2", name: "Annual compliance review", kind: "compliance_review", cadence: "annual" } }),
  ],
  counts: { audits: 4, open: 1, overdue: 1 },
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
      if (fake.refuse) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      if (name === "list_workspaces") return ok({ workspaces: [{ id: "w1", name: "Team", role: "owner" }] });
      if (name === "list_agreement_audits") return ok(LIST);
      if (name === "get_agreement_audit") return ok({ ...audit(), people: { "u-lp": "Lena", "u-dev": "Dana" }, history: [{ id: "h1", action: "agreement_audit_scheduled", at: "2026-10-01T00:00:00Z", actor: null }, { id: "h2", action: "submit_agreement_audit_evidence", at: "2026-11-02T09:00:00Z", actor: { id: "u-dev", name: "Dana" } }] });
      if (name === "add_agreement_audit_requirement") return ok({ requirement: { id: "r9" }, opened: [] });
      return ok({ id: AUDIT, status: "in_progress" });
    },
    close: async () => undefined,
  }),
}));

const views = await import("@/components/agreement-audits-view");
const listRoute = await import("@/app/api/agreement-audits/route");
const auditRoute = await import("@/app/api/agreement-audits/[auditId]/route");

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
beforeEach(() => {
  fake.session = session(["developer"]);
  fake.sameOrigin = true;
  fake.tools = ["list_workspaces", "list_agreement_audits", "get_agreement_audit", "add_agreement_audit_requirement", "open_agreement_audit", "record_agreement_audit_finding", "resolve_agreement_audit_finding", "close_agreement_audit", "submit_agreement_audit_evidence", "respond_to_agreement_audit_finding"].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = null;
});
afterEach(() => cleanup());

const list = fromAgreementAuditList(LIST)!;
const detail = (over: Record<string, unknown> = {}) => fromAgreementAudit({ ...audit(over), people: { "u-lp": "Lena", "u-dev": "Dana" }, history: [{ id: "h1", action: "agreement_audit_scheduled", at: "2026-10-01T00:00:00Z", actor: null }] })!;

describe("reading Mynt's answers", () => {
  it("lists audits with agreement, app, counterparty, kind, due, status and findings; unknown counts aren't 0", () => {
    expect(list.audits.map((a) => [a.appName, a.counterparty, a.name, a.kind, a.status, a.overdue, findingsText(a)])).toEqual([
      ["Pay app", "Sponsor Bank", "Quarterly complaints review", "complaints_review", "submitted", true, "1 open of 1"],
      ["Card app", "Sponsor Bank", "Annual compliance review", "compliance_review", "passed", false, "None"],
    ]);
    expect(list.agreements.map((a) => [a.label, a.canAddRequirements])).toEqual([["Pay app with Sponsor Bank", false], ["Card app with Sponsor Bank", true]]);
    const bare = fromAgreementAuditList({ audits: [{ id: AUDIT, agreement_id: AG1, status: "scheduled" }] })!;
    expect(findingsText(bare.audits[0])).toBe("Not available");
    expect(bare.counts).toEqual({ audits: null, open: null, overdue: null });
    expect(fromAgreementAuditList({ nope: true })).toBeNull();
    expect(csvRow(list.audits[0])).toEqual([AG1, "Pay app", "Sponsor Bank", "Quarterly complaints review", "Complaints review", "Quarterly", "2026-11-20", "Submitted, waiting for review", "Yes", "1", "1", "1"]);
  });

  it("filters by agreement, kind, status (overdue too) and due date; summarises per agreement", () => {
    const f = NO_AGREEMENT_AUDIT_FILTERS;
    expect(filterAgreementAudits(list.audits, { ...f, agreement: [AG2] }).map((a) => a.appName)).toEqual(["Card app"]);
    expect(filterAgreementAudits(list.audits, { ...f, status: ["overdue"] }).map((a) => a.appName)).toEqual(["Pay app"]);
    expect(filterAgreementAudits(list.audits, { ...f, kind: ["compliance_review"] }).map((a) => a.appName)).toEqual(["Card app"]);
    expect(filterAgreementAudits(list.audits, f, { from: "2026-11-01", to: "2026-12-31" }).map((a) => a.appName)).toEqual(["Pay app"]);
    expect(filterAgreementAudits(list.audits, { ...f, query: "card" }).map((a) => a.appName)).toEqual(["Card app"]);
    expect(Object.fromEntries(summariesByAgreement(list))).toEqual({ [AG1]: { count: 1, nextDue: "2026-11-20T23:59:59.000Z", overdue: 1 }, [AG2]: { count: 1, nextDue: null, overdue: 0 } });
  });

  it("reads one audit's findings, evidence (https only) and history, naming people", () => {
    const d = detail({ evidence: [{ id: "e1", name: "Log", url: "http://files.example.com/x", sha256: SHA }] });
    expect(d.findings[0]).toMatchObject({ title: "Complaints unanswered", status: "open", recordedBy: "Lena", responses: [{ by: "Dana", text: "Answered both" }] });
    expect(d.evidenceItems[0].url).toBeNull();
    expect(d.history).toEqual([{ id: "h1", action: "agreement_audit_scheduled", at: "2026-10-01T00:00:00Z", by: "Mynt's schedule" }]);
    expect(fromAgreementAudit({ nope: 1 })).toBeNull();
  });
});

describe("the Agreement audits table", () => {
  it("has the same toolbar (search, Filters, a forward-looking due range, Export CSV), statuses in words, paged", () => {
    const html = renderToStaticMarkup(<views.AgreementAuditsView list={list} onOpen={() => undefined} />);
    const bar = html.slice(html.indexOf("data-toolbar"), html.indexOf("<table"));
    expect(bar).toContain("Search agreement audits");
    expect(bar).toContain("Filters");
    expect(bar).toContain("Due");
    expect(bar).toContain("Export CSV");
    expect(bar).not.toContain("Add audit requirement");
    for (const h of ["Agreement", "App", "Audit", "Kind", "Due", "Status", "Findings"]) expect(html).toContain(`>${h}</th>`);
    expect(html).toMatch(/data-agreement-audit="33333333[^"]*" data-status="submitted"[^]*Submitted, waiting for review[^]*Overdue/);
    expect(html).toContain("Passed");
    expect(html).toContain("data-pager");
    expect(html).toContain("2 audits · Page 1 of 1");
  });

  it("opens filtered to one agreement (?agreement=), and a row opens its sheet", () => {
    const opened: string[] = [];
    render(<views.AgreementAuditsView list={list} initial={{ ...NO_AGREEMENT_AUDIT_FILTERS, agreement: [AG2] }} onOpen={(r) => opened.push(r.id)} />);
    expect([...document.querySelectorAll("[data-agreement-audit]")].map((r) => r.getAttribute("data-status"))).toEqual(["passed"]);
    fireEvent.click(document.querySelector("[data-open-audit]")!);
    expect(opened).toEqual(["66666666-6666-4666-8666-666666666666"]);
  });

  it("offers Add audit requirement to a licence provider with an agreement that can take one", () => {
    const html = renderToStaticMarkup(<views.AgreementAuditsView list={list} canAddRequirement onOpen={() => undefined} onAddRequirement={() => undefined} />);
    expect(html).toContain("data-add-audit-requirement");
    expect(html).toContain("Add audit requirement");
    const none = { ...list, agreements: list.agreements.map((a) => ({ ...a, canAddRequirements: false })) };
    expect(renderToStaticMarkup(<views.AgreementAuditsView list={none} canAddRequirement onOpen={() => undefined} onAddRequirement={() => undefined} />)).not.toContain("data-add-audit-requirement");
  });
});

describe("the audit sheet", () => {
  it("shows a card, then labelled actions for the app's side, then Findings, Evidence and History tables", () => {
    const sent: unknown[] = [];
    render(<views.AgreementAuditDetailView detail={detail()} onAction={(b) => sent.push(b)} />);
    expect(document.querySelector("[data-audit-card]")!.textContent).toContain("Pay app with Sponsor Bank");
    expect([...document.querySelectorAll("[data-audit-action]")].map((b) => b.textContent)).toEqual(["Submit evidence", "Respond to finding"]);
    expect([...document.querySelectorAll("[data-detail-tab]")].map((b) => b.textContent)).toEqual(["Findings", "Evidence", "History"]);
    expect(document.querySelector('[data-finding] ')!.textContent).toContain("Dana: Answered both");
    fireEvent.click(document.querySelector('[data-detail-tab="evidence"]')!);
    expect(document.querySelector("[data-evidence] a")!.getAttribute("href")).toBe("https://files.example.com/log.csv");
    fireEvent.click(document.querySelector('[data-detail-tab="history"]')!);
    expect(document.querySelector("[data-history]")!.textContent).toContain("Mynt's schedule");

    // Submit evidence: an https link and its SHA-256, nothing sent until both are right.
    fireEvent.click(document.querySelector('[data-audit-action="submit_evidence"]')!);
    const submit = document.querySelector('[data-action-submit="submit_evidence"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(document.querySelector("[data-action-evidence-name]")!, { target: { value: "Q4 log" } });
    fireEvent.change(document.querySelector("[data-action-evidence-url]")!, { target: { value: "https://files.example.com/q4.csv" } });
    fireEvent.change(document.querySelector("[data-action-evidence-sha]")!, { target: { value: "B".repeat(64) } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(sent).toEqual([{ action: "submit_evidence", evidence: [{ name: "Q4 log", url: "https://files.example.com/q4.csv", sha256: "b".repeat(64) }] }]);

    fireEvent.click(document.querySelector('[data-audit-action="respond_to_finding"]')!);
    fireEvent.change(document.querySelector("[data-action-note]")!, { target: { value: "Fixed with an SLA alert" } });
    fireEvent.click(document.querySelector('[data-action-submit="respond_to_finding"]')!);
    expect(sent[1]).toEqual({ action: "respond_to_finding", finding_id: FINDING, response: "Fixed with an SLA alert" });
  });

  it("gives the licence provider Open audit, Record finding, Pass, Fail and Waive; Fail needs a reason", () => {
    const sent: unknown[] = [];
    render(<views.AgreementAuditDetailView detail={detail({ your_side: "counterparty", status: "scheduled", actions: ["open", "record_finding", "fail", "waive"] })} onAction={(b) => sent.push(b)} />);
    expect([...document.querySelectorAll("[data-audit-action]")].map((b) => b.textContent)).toEqual(["Open audit", "Record finding", "Fail", "Waive"]);
    fireEvent.click(document.querySelector('[data-audit-action="fail"]')!);
    const fail = document.querySelector('[data-action-submit="fail"]') as HTMLButtonElement;
    expect(fail.disabled).toBe(true);
    fireEvent.change(document.querySelector("[data-action-note]")!, { target: { value: "No log submitted" } });
    fireEvent.click(fail);
    fireEvent.click(document.querySelector('[data-audit-action="record_finding"]')!);
    fireEvent.change(document.querySelector("[data-action-severity]")!, { target: { value: "critical" } });
    fireEvent.change(document.querySelector("[data-action-title]")!, { target: { value: "Marketing claims a rate" } });
    fireEvent.click(document.querySelector('[data-action-submit="record_finding"]')!);
    expect(sent).toEqual([
      { action: "fail", note: "No log submitted" },
      { action: "record_finding", severity: "critical", title: "Marketing claims a rate" },
    ]);
    const passable = renderToStaticMarkup(<views.AgreementAuditDetailView detail={detail({ your_side: "counterparty", actions: ["record_finding", "pass", "fail", "waive"] })} onAction={() => undefined} />);
    expect(passable).toContain('data-audit-action="pass"');
    // A plain member reads only.
    expect(renderToStaticMarkup(<views.AgreementAuditDetailView detail={detail({ actions: [] })} onAction={() => undefined} />)).not.toContain("data-audit-actions");
  });

  it("Add audit requirement: only agreements that can take one, a first due date unless on each change", () => {
    const sent: unknown[] = [];
    render(<views.AddRequirementView agreements={list.agreements} onSubmit={(r) => sent.push(r)} />);
    expect([...document.querySelectorAll("[data-requirement-agreement] option")].map((o) => o.textContent)).toEqual(["Card app with Sponsor Bank"]);
    fireEvent.change(document.querySelector("[data-requirement-name]")!, { target: { value: "Marketing material review" } });
    fireEvent.change(document.querySelector("[data-requirement-kind]")!, { target: { value: "marketing_review" } });
    const submit = document.querySelector("[data-add-requirement-submit]") as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // annual needs a first due date
    fireEvent.change(document.querySelector("[data-requirement-cadence]")!, { target: { value: "on_change" } });
    expect(document.querySelector("[data-requirement-first-due]")).toBeNull();
    fireEvent.click(submit);
    expect(sent).toEqual([{ agreement_id: AG2, name: "Marketing material review", kind: "marketing_review", cadence: "on_change" }]);
    expect(renderToStaticMarkup(<views.AddRequirementView agreements={[]} onSubmit={() => undefined} />)).toContain("data-no-agreements");
  });
});

const req = (url: string, body?: unknown) => new Request(`http://localhost:3000${url}`, body === undefined ? {} : { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
const params = (auditId = AUDIT) => ({ params: Promise.resolve({ auditId }) });

describe("the routes", () => {
  it("list: the selected workspace's for a developer, the firm's side for a licence provider; others refused", async () => {
    const res = await listRoute.GET(req("/api/agreement-audits?workspace=w1"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.name === "list_agreement_audits")?.args).toEqual({ workspace_id: "w1" });
    expect(body.list.audits).toHaveLength(2);
    expect(body.canAddRequirement).toBe(true);
    fake.calls = [];
    fake.session = session(["license_provider"]);
    expect((await listRoute.GET(req("/api/agreement-audits"))).status).toBe(200);
    expect(fake.calls.find((c) => c.name === "list_agreement_audits")?.args).toEqual({ side: "counterparty" });
    fake.session = session(["consumer"]);
    expect((await listRoute.GET(req("/api/agreement-audits"))).status).toBe(403);
    fake.session = session(["developer"]);
    fake.tools = [{ name: "list_workspaces" }];
    expect(await (await listRoute.GET(req("/api/agreement-audits"))).json()).toEqual({ supported: false });
  });

  it("detail and actions: same origin, a real audit id, strict bodies, each action one of Mynt's tools", async () => {
    expect((await auditRoute.GET(req(`/api/agreement-audits/x`), params("not-an-id"))).status).toBe(400);
    const got = await (await auditRoute.GET(req(`/api/agreement-audits/${AUDIT}`), params())).json();
    expect(got.audit.history.map((h: { by: string }) => h.by)).toEqual(["Mynt's schedule", "Dana"]);

    fake.sameOrigin = false;
    expect((await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, { action: "open" }), params())).status).toBe(403);
    fake.sameOrigin = true;
    expect((await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, { action: "delete" }), params())).status).toBe(400);
    expect((await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, { action: "fail" }), params())).status).toBe(400); // a reason
    expect((await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, { action: "submit_evidence", evidence: [{ name: "x", url: "http://files.example.com/x", sha256: SHA }] }), params())).status).toBe(400);
    expect((await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, "x".repeat(70 * 1024)), params())).status).toBe(413);

    const cases: [Record<string, unknown>, string, Record<string, unknown>][] = [
      [{ action: "open" }, "open_agreement_audit", { audit_id: AUDIT }],
      [{ action: "pass" }, "close_agreement_audit", { audit_id: AUDIT, outcome: "passed" }],
      [{ action: "waive", note: "Launch month" }, "close_agreement_audit", { audit_id: AUDIT, outcome: "waived", note: "Launch month" }],
      [{ action: "record_finding", severity: "high", title: "Late answers" }, "record_agreement_audit_finding", { audit_id: AUDIT, severity: "high", title: "Late answers" }],
      [{ action: "resolve_finding", finding_id: FINDING }, "resolve_agreement_audit_finding", { audit_id: AUDIT, finding_id: FINDING }],
      [{ action: "submit_evidence", evidence: [{ name: "Log", url: "https://files.example.com/log.csv", sha256: SHA }] }, "submit_agreement_audit_evidence", { audit_id: AUDIT, evidence: [{ name: "Log", url: "https://files.example.com/log.csv", sha256: SHA }] }],
      [{ action: "respond_to_finding", finding_id: FINDING, response: "Answered both" }, "respond_to_agreement_audit_finding", { audit_id: AUDIT, finding_id: FINDING, response: "Answered both" }],
    ];
    for (const [body, tool, args] of cases) {
      fake.calls = [];
      const res = await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, body), params());
      expect(res.status, JSON.stringify(body)).toBe(200);
      expect(fake.calls.find((c) => c.name === tool)?.args).toEqual(args);
    }
    // Mynt's refusal comes back in its own words.
    fake.refuse = "Only the workspace's owners and admins submit evidence for its apps";
    const refused = await auditRoute.POST(req(`/api/agreement-audits/${AUDIT}`, cases[5][0]), params());
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toContain("owners and admins");
  });

  it("add requirement: same origin, strict, empty optional fields left out", async () => {
    fake.sameOrigin = false;
    expect((await listRoute.POST(req("/api/agreement-audits", {}))).status).toBe(403);
    fake.sameOrigin = true;
    expect((await listRoute.POST(req("/api/agreement-audits", { agreement_id: AG2, name: "Review", kind: "nope", cadence: "annual" }))).status).toBe(400);
    const res = await listRoute.POST(req("/api/agreement-audits", { agreement_id: AG2, name: "Annual compliance review", kind: "compliance_review", cadence: "annual", first_due: "2027-01-31", description: " " }));
    expect(res.status).toBe(200);
    expect(fake.calls.find((c) => c.name === "add_agreement_audit_requirement")?.args).toEqual({ agreement_id: AG2, name: "Annual compliance review", kind: "compliance_review", cadence: "annual", first_due: "2027-01-31" });
  });

  it("the allow-list takes the agreement-audit tools strictly", () => {
    expect(parseStudioCall("list_agreement_audits", { workspace_id: "w1", overdue: true })).toHaveProperty("tool");
    expect(parseStudioCall("list_agreement_audits", { everything: true })).toHaveProperty("error");
    expect(parseStudioCall("close_agreement_audit", { audit_id: AUDIT, outcome: "deleted" })).toHaveProperty("error");
    expect(parseStudioCall("submit_agreement_audit_evidence", { audit_id: AUDIT, evidence: [{ name: "x", url: "https://files.example.com/x", sha256: "short" }] })).toHaveProperty("error");
    expect(parseStudioCall("get_agreement_audit", { audit_id: "not-a-uuid" })).toHaveProperty("error");
    expect(parseStudioCall("retire_agreement_audit_requirement", { requirement_id: AUDIT, reason: "x" })).toHaveProperty("error"); // not from the studio
  });
});
