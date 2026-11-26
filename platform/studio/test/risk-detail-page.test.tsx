// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall, parseStudioCall, STUDIO_TOOLS } from "@/lib/studio-tools";

// One risk's detail: the platform admin's page (/platform/risk-register/<id>) and the same component in a sheet from
// an app's Security & risk tab and a product's Risk tab. The metadata card's facts in their order, five tabs each a
// table, every change a labelled button opening a sheet that posts to the risk's own route, and each route sending
// that action to its own tool on Mynt (same origin, signed in, the right role, strict bodies).

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined }), usePathname: () => "/platform/risk-register", useSearchParams: () => new URLSearchParams() }));
const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  reply: {} as Record<string, unknown>,
  refuse: null as string | null,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      if (fake.refuse && name !== "get_risk" && !name.startsWith("list_")) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse }) }] };
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const { RiskDetailView, RISK_DETAIL_TABS, riskDetailRoute, riskDetailHref, riskDetailLink } = await import("@/components/risk-detail");
const detail = await import("@/lib/risk-detail");
const adminRoute = await import("@/app/api/admin/risks/[riskId]/route");
const appRoute = await import("@/app/api/apps/[appId]/risks/[riskId]/route");
const productRoute = await import("@/app/api/products/[productId]/risks/[riskId]/route");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const RISK = "aaaaaaaa-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const F1 = "33333333-3333-4333-8333-333333333333";
const F2 = "34343434-3333-4333-8333-333333333333";
const T1 = "44444444-4444-4444-8444-444444444444";
const T2 = "45454545-4444-4444-8444-444444444444";
const C1 = "55555555-5555-4555-8555-555555555555";
const L1 = "66666666-6666-4666-8666-666666666666";
const MODEL = "77777777-7777-4777-8777-777777777777";
const APP = "a1";
const PRODUCT = "card-1";

// get_risk's reply, as Mynt sends it.
const reply = (more: Record<string, unknown> = {}) => ({
  subject: { type: "platform", id: "mynt", name: "Mynt platform" },
  can_manage: true,
  risk: {
    id: RISK,
    subject_type: "platform",
    subject_id: "mynt",
    title: "Ledger outage",
    category: "operational",
    risk_area: "operations",
    description: null,
    likelihood: 4,
    impact: 5,
    score: 20,
    level: "critical",
    inherent: { likelihood: 4, impact: 5, score: 20, level: "critical", level_name: "Critical" },
    control: { effectiveness: "partial", words: "Partial", note: "Failover tested monthly" },
    residual: { score: 10, level: "high", level_name: "High", assessed: true, overridden: false, likelihood: null, impact: null, override: null, words: "10 (High)" },
    owner: { user_id: USER, name: "Boss" },
    mitigation: "Second region",
    status: "mitigating",
    review_by: "2026-01-01",
    overdue: true,
  },
  scoring: {
    grading_version: 0,
    impact: { recorded: 5, average: 4.5, formula: "Impact is scored 1 (negligible) to 5 (severe) by the risk's keeper; these factors explain it. Inherent score = likelihood × impact.", factors: [{ id: F1, kind: "impact", name: "Payments stop", score: 5, rationale: "No transfers settle", source: { kind: "link", url: "https://example.test/incident" } }, { id: F2, kind: "impact", name: "Support load", score: 4, rationale: null, source: { kind: "reference", target_type: "risk_model", target_id: MODEL, type_words: "Risk model", name: "Outage cost model" } }] },
    likelihood: { recorded: 4, average: null, formula: "Likelihood is scored 1 (rare) to 5 (almost certain) by the risk's keeper; these factors explain it. Inherent score = likelihood × impact.", factors: [] },
    control: { recorded: "partial", average: 3, formula: "Control effectiveness is none, weak, partial or strong, set by the risk's keeper; these factors, each scored 1 (not working) to 5 (working fully), explain it. Residual = inherent × (1 − the control's reduction), rounded, never below 1. Reduction: none 0%, weak 25%, partial 50%, strong 75%.", factors: [{ id: "f3", kind: "control", name: "Failover drill", score: 3, rationale: "Passed twice this year", source: null }] },
  },
  treatments: [
    { id: T1, title: "Add a second region", owner: { user_id: USER, name: "Boss" }, due: "2026-02-01", overdue: true, status: "doing", progress_note: "Replica is up", effectiveness: "not_assessed", effectiveness_note: null, done_at: null },
    { id: T2, title: "Run a failover drill", owner: null, due: null, overdue: false, status: "done", progress_note: null, effectiveness: "effective", effectiveness_note: "Cut over in four minutes", done_at: "2026-10-01T00:00:00.000Z" },
  ],
  treatment_due: "2026-02-01",
  controls: [{ id: C1, name: "Hourly ledger backup", kind: "corrective", description: "Restorable within the hour", last_tested_at: "2026-09-01", test_result: "gaps_found", from_treatment: null, retired: null }],
  links: [
    { id: L1, target_type: "risk_model", type_words: "Risk model", target_id: MODEL, name: "Outage cost model", note: "Prices the outage" },
    { id: "l2", target_type: "firm", type_words: "Firm", target_id: "f-9", name: null, note: null },
  ],
  history: [
    { at: "2026-10-01T09:00:00.000Z", action: "add_risk", actor: { user_id: USER, name: "Boss" }, what: "Risk added", changes: null, note: null, score: { before: null, after: { inherent: 20, control: null, residual: 20 } } },
    { at: "2026-10-02T09:00:00.000Z", action: "update_risk", actor: { user_id: USER, name: "Boss" }, what: "Changed control effectiveness (none → partial)", changes: {}, note: "After the drill", score: { before: { inherent: 20, control: null, residual: 20 }, after: { inherent: 20, control: "partial", residual: 10 } } },
    { at: "2026-10-03T09:00:00.000Z", action: "add_risk_control", actor: null, what: "Control added: Hourly ledger backup (corrective)", changes: null, note: null, score: { before: { inherent: 20, control: "partial", residual: 10 }, after: { inherent: 20, control: "partial", residual: 10 } } },
  ],
  ...more,
});
const dataOf = (more: Record<string, unknown> = {}) => ({ detail: detail.riskDetailFrom(reply(more))!, owners: [{ userId: USER, name: "Boss" }], linkChoices: { risk_model: [{ id: MODEL, name: "Outage cost model" }, { id: "88888888-8888-4888-8888-888888888888", name: "Capacity model" }] } });

const fetcher = () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, message: "Done by Mynt." }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
};
const click = async (sel: string) => act(async () => void fireEvent.click(document.querySelector(sel)!));
const submit = (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!));
const change = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } });
const tables = () => [...document.querySelectorAll("[data-detail-table] table")].map((t) => [...t.querySelectorAll("thead th")].map((th) => th.textContent));
const rows = (root = "[data-detail-table]") => [...document.querySelectorAll(`${root} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()));
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (body?: unknown) => new Request("http://studio.test/x", body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);

beforeEach(() => {
  fake.session = session(["admin", "developer"]);
  fake.sameOrigin = true;
  fake.tools = [...new Set([...Object.keys(ADMIN_TOOLS), ...Object.keys(STUDIO_TOOLS)])].map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = null;
  fake.reply = {
    get_risk: reply(),
    list_whitelist: { whitelist: [{ email: "boss@example.com", roles: ["admin"] }], users: [{ id: USER, email: "boss@example.com", name: "Boss" }] },
    list_risk_models: { models: [{ id: MODEL, risk_area: "operations", status: "active", version: 1, name: "Outage cost model", purpose: "p", method: "m", inputs: [], outputs: [], thresholds: [], owner: null, validation: { overdue: false } }], counts: {} },
    list_my_apps: [{ id: APP, name: "Cards", workspace_id: "w1", stage: "staging", product_ids: [PRODUCT] }],
    list_my_products: [{ id: PRODUCT, name: "Card", status: "draft", stage: "staging" }],
    list_workspace_members: { members: [{ user_id: USER, name: "Ines", role: "admin" }] },
  };
});

describe("the metadata card", () => {
  it("the header is ‹short id› · ‹risk area› · ‹title›, with the status in words", () => {
    render(<RiskDetailView data={dataOf()} where="platform" />);
    const card = document.querySelector("[data-metadata-card]")!;
    expect(card.querySelector("h2")!.textContent).toBe("aaaaaaaa · Operations risk · Ledger outage");
    expect(card.querySelector("h2 + p")!.textContent).toBe("Mitigating: work under way · On Mynt's own register");
  });

  it("the facts grid, in its order: Status · Inherent · Control · Residual · Owner · Next review · Treatment due · Linked, every level in words", () => {
    render(<RiskDetailView data={dataOf()} where="platform" />);
    const facts = [...document.querySelectorAll("[data-metadata-card] dl > div")].map((d) => [d.querySelector("dt")!.textContent, d.querySelector("dd")!.textContent]);
    expect(facts).toEqual([
      ["Status", "Mitigating: work under way"],
      ["Inherent", "4 × 5 = 20 (Critical)"],
      ["Control", "Partial"],
      ["Residual", "10 (High)"],
      ["Owner", "Boss"],
      ["Next review", "2026-01-01 (overdue)"],
      ["Treatment due", "2026-02-01 (overdue)"],
      ["Linked", "2 items"],
    ]);
    expect([...detail.FACT_LABELS]).toEqual(facts.map((f) => f[0]));
  });

  it("what isn't recorded says so in words: control not assessed, residual the same as inherent or overridden, no owner, no dates; never a 0", () => {
    const r = reply();
    const bare = detail.riskDetailFrom({
      ...r,
      risk: { ...r.risk, control: { effectiveness: null, words: "Not assessed", note: null }, residual: { score: 20, level: "critical", level_name: "Critical", assessed: false, overridden: false }, owner: null, review_by: null, overdue: false },
      treatments: [],
      treatment_due: null,
      links: [],
    })!;
    expect(detail.riskFacts(bare)).toEqual([
      ["Status", "Mitigating: work under way"],
      ["Inherent", "4 × 5 = 20 (Critical)"],
      ["Control", "Not assessed"],
      ["Residual", "20 (Critical), same as inherent: control not assessed"],
      ["Owner", "No owner"],
      ["Next review", "Not set"],
      ["Treatment due", "No open treatment tasks"],
      ["Linked", "0 items"],
    ]);
    const overridden = detail.riskDetailFrom({ ...r, risk: { ...r.risk, residual: { score: 4, level: "low", level_name: "Low", assessed: true, overridden: true, likelihood: 1, impact: 4, override: { why: "Insured" } } }, treatments: [r.treatments[0]].map((t) => ({ ...t, due: null, overdue: false })), treatment_due: null })!;
    expect(detail.riskFacts(overridden)[3]).toEqual(["Residual", "4 (Low), overridden"]);
    expect(detail.riskFacts(overridden)[6]).toEqual(["Treatment due", "No due date on its open tasks"]);
    // A due date still ahead isn't overdue.
    expect(detail.riskFacts(dataOf().detail, "2026-01-15")[6]).toEqual(["Treatment due", "2026-02-01"]);
  });

  it("the labelled actions, in order; none is icon-only; a closed or accepted risk drops what no longer applies", () => {
    const labels = (more: Record<string, unknown> = {}) => {
      const view = render(<RiskDetailView data={dataOf(more)} where="platform" />);
      const out = [...document.querySelectorAll("[data-detail-actions] button")].map((b) => b.textContent!.trim());
      for (const b of document.querySelectorAll("button, a")) expect(b.textContent!.trim(), b.outerHTML).not.toBe("");
      view.unmount();
      return out;
    };
    expect(labels()).toEqual(["Review risk", "Add treatment task", "Add control", "Link item", "Close risk", "Accept risk", "Copy link"]);
    const r = reply().risk;
    expect(labels({ risk: { ...r, status: "accepted" } })).toEqual(["Review risk", "Add treatment task", "Add control", "Link item", "Close risk", "Copy link"]);
    expect(labels({ risk: { ...r, status: "closed" } })).toEqual(["Review risk", "Add treatment task", "Add control", "Link item", "Copy link"]);
  });

  it("someone who reads the register and doesn't keep it gets Copy link and nothing that changes it", async () => {
    render(<RiskDetailView data={dataOf({ can_manage: false, subject: { type: "app", id: APP, name: "Cards" } })} where="platform" />);
    expect([...document.querySelectorAll("[data-detail-actions] button")].map((b) => b.textContent!.trim())).toEqual(["Copy link"]);
    expect(document.querySelector("[data-metadata-card] h2 + p")!.textContent).toBe("Mitigating: work under way · On the register of the app Cards · Read-only for you");
    for (const tab of RISK_DETAIL_TABS) {
      await click(`[data-detail-tab="${tab}"]`);
      for (const sel of ["[data-add-factor]", "[data-edit-factor]", "[data-remove-factor]", "[data-add-treatment]", "[data-update-treatment]", "[data-make-control]", "[data-add-control]", "[data-update-control]", "[data-retire-control]", "[data-link-item]", "[data-unlink]"]) expect(document.querySelector(sel), `${tab} ${sel}`).toBeNull();
    }
  });

  it("Copy link copies the risk's own address: its page on the platform, the tab with the risk open elsewhere", async () => {
    expect(riskDetailHref("platform", RISK)).toBe(`/platform/risk-register/${RISK}`);
    expect(riskDetailHref("studio", RISK)).toBe(`?risk=${RISK}`);
    // Elsewhere: the tab the reader is on, kept as it is, with the risk named.
    const at = { origin: "https://studio.example", pathname: "/proj-1", search: "?tab=security" };
    expect(riskDetailLink("studio", RISK, at)).toBe(`https://studio.example/proj-1?tab=security&risk=${RISK}`);
    expect(riskDetailLink("platform", RISK, at)).toBe(`https://studio.example/platform/risk-register/${RISK}`);
    const written: string[] = [];
    Object.assign(navigator, { clipboard: { writeText: async (t: string) => void written.push(t) } });
    render(<RiskDetailView data={dataOf()} where="platform" />);
    await click('[data-risk-action="copy-link"]');
    expect(written).toEqual([`${window.location.origin}/platform/risk-register/${RISK}`]);
    expect(document.querySelector('[data-risk-action="copy-link"]')!.textContent!.trim()).toBe("Link copied");
  });
});

describe("the five tabs, each a table", () => {
  it("Scoring, Treatment, Controls, Linked, History, in that order, by their column headers", async () => {
    render(<RiskDetailView data={dataOf()} where="platform" />);
    expect([...document.querySelectorAll("[data-detail-tab]")].map((t) => t.textContent)).toEqual(["Scoring", "Treatment", "Controls", "Linked", "History"]);
    // Scoring: three tables, the same columns.
    expect(tables()).toEqual([
      ["Factor", "Score", "Rationale", "Source", "Action"],
      ["Factor", "Score", "Rationale", "Source", "Action"],
      ["Factor", "Score", "Rationale", "Source", "Action"],
    ]);
    expect([...document.querySelectorAll("[data-factor-table] h3")].map((h) => h.textContent)).toEqual(["Impact factors", "Likelihood factors", "Control factors"]);
    await click('[data-detail-tab="treatment"]');
    expect(tables()).toEqual([["Task", "Owner", "Due", "Status", "Progress", "Effectiveness", "Action"]]);
    await click('[data-detail-tab="controls"]');
    expect(tables()).toEqual([["Control", "Kind", "Last tested", "Result", "From task", "Action"]]);
    await click('[data-detail-tab="linked"]');
    expect(tables()).toEqual([["Type", "Item", "Note", "Action"]]);
    await click('[data-detail-tab="history"]');
    expect(tables()).toEqual([["When", "Who", "What changed", "Score before → after"]]);
  });

  it("Scoring: each table's caption states its formula in words, the score it explains and the factors' average; a source is a link or a named item", () => {
    render(<RiskDetailView data={dataOf()} where="platform" />);
    const caption = (k: string) => document.querySelector(`[data-factor-caption="${k}"]`)!.textContent!;
    expect(caption("impact")).toBe("Impact is scored 1 (negligible) to 5 (severe) by the risk's keeper; these factors explain it. Inherent score = likelihood × impact. Recorded: 5 of 5. Factors' average: 4.5 of 5.");
    expect(caption("likelihood")).toMatch(/Inherent score = likelihood × impact\. Recorded: 4 of 5\. No factors yet, so no average\.$/);
    expect(caption("control")).toMatch(/Residual = inherent × \(1 − the control's reduction\).* Recorded: Partial\. Factors' average: 3 of 5\.$/);
    expect(rows('[data-factor-table="impact"]')).toEqual([
      ["Payments stop", "5 of 5", "No transfers settle", "https://example.test/incident", "Edit factor Remove factor"],
      ["Support load", "4 of 5", "No rationale recorded", "Risk model: Outage cost model", "Edit factor Remove factor"],
    ]);
    expect(document.querySelector('[data-factor-source="link"]')!.getAttribute("href")).toBe("https://example.test/incident");
    expect(rows('[data-factor-table="likelihood"]')).toEqual([["No likelihood factors recorded. Add the first one."]]);
    expect(rows('[data-factor-table="control"]')[0].slice(0, 4)).toEqual(["Failover drill", "3 of 5", "Passed twice this year", "No source"]);
    expect([...document.querySelectorAll("[data-add-factor]")].map((b) => [b.getAttribute("data-add-factor"), b.textContent!.trim()])).toEqual([["impact", "Add factor"], ["likelihood", "Add factor"], ["control", "Add factor"]]);
  });

  it("Treatment: status, due (overdue in words), progress and effectiveness in words; Make this a control only on a done task that isn't one yet", () => {
    render(<RiskDetailView data={dataOf()} where="platform" initialTab="treatment" />);
    expect(rows()).toEqual([
      ["Add a second region", "Boss", "2026-02-01 (overdue)", "Under way", "Replica is up", "Not assessed", "Update task"],
      ["Run a failover drill", "No owner", "Not set", "Done", "No progress noted", "Worked: Cut over in four minutes", "Update task Make this a control"],
    ]);
    expect(document.querySelector("[data-add-treatment]")!.textContent!.trim()).toBe("Add treatment task");
    cleanup();
    const r = reply();
    render(<RiskDetailView data={dataOf({ controls: [{ ...r.controls[0], from_treatment: { id: T2, title: "Run a failover drill" } }] })} where="platform" initialTab="treatment" />);
    expect(document.querySelector("[data-make-control]")).toBeNull();
  });

  it("Controls: kind and test result in words (Not tested until someone says), the task it came from; a retired one stays, with no actions", () => {
    const r = reply();
    render(
      <RiskDetailView
        data={dataOf({ controls: [r.controls[0], { id: "c2", name: "Run a failover drill", kind: "detective", description: null, last_tested_at: null, test_result: null, from_treatment: { id: T2, title: "Run a failover drill" }, retired: null }, { id: "c3", name: "Manual ledger check", kind: "preventive", description: null, last_tested_at: null, test_result: null, from_treatment: null, retired: { at: "2026-10-01T00:00:00.000Z", reason: "Automated" } }] })}
        where="platform"
        initialTab="controls"
      />,
    );
    expect(rows()).toEqual([
      ["Hourly ledger backupRestorable within the hour", "Corrective: puts it right", "2026-09-01", "Gaps found", "Not from a task", "Update control Retire control"],
      ["Run a failover drill", "Detective: notices it", "Not tested", "Not tested", "Run a failover drill", "Update control Retire control"],
      ["Manual ledger checkRetired: Automated", "Preventive: stops it happening", "Not tested", "Not tested", "Not from a task", "Retired"],
    ]);
    expect(document.querySelector("[data-add-control]")!.textContent!.trim()).toBe("Add control");
  });

  it("Linked: type, the item linked where it has a page, its note; a name the reader may not see says so", () => {
    render(<RiskDetailView data={dataOf()} where="platform" initialTab="linked" />);
    expect(rows()).toEqual([
      ["Risk model", "Outage cost model", "Prices the outage", "Remove link"],
      ["Firm", "Name not shown: it isn't yours to read, or it no longer exists", "No note", "Remove link"],
    ]);
    expect([...document.querySelectorAll("[data-linked-item]")].map((a) => a.getAttribute("href"))).toEqual([`/platform/risk-models/${MODEL}`]);
    expect(document.querySelector("[data-link-item]")!.textContent!.trim()).toBe("Link item");
    expect(detail.linkHref({ targetType: "product", targetId: PRODUCT }, "studio")).toBe(`/products/${PRODUCT}`);
    expect(detail.linkHref({ targetType: "risk_model", targetId: MODEL }, "studio")).toBeNull();
  });

  it("History: newest first, who, what changed and the scores before → after, from get_risk's history", () => {
    render(<RiskDetailView data={dataOf()} where="platform" initialTab="history" />);
    expect(rows()).toEqual([
      ["2026-10-03 09:00", "Mynt", "Control added: Hourly ledger backup (corrective)", "No change (inherent 20, residual 10)"],
      ["2026-10-02 09:00", "Boss", "Changed control effectiveness (none → partial)Note: After the drill", "inherent 20, residual 20 → inherent 20, residual 10"],
      ["2026-10-01 09:00", "Boss", "Risk added", "Started at inherent 20, residual 20"],
    ]);
    // An entry from before three-step scoring has no residual on record: said so, never a 0.
    expect(detail.beforeAfterWords({ before: { inherent: 9, control: null, residual: null }, after: { inherent: 12, control: null, residual: null } })).toBe("inherent 9, residual not recorded → inherent 12, residual not recorded");
    expect(detail.beforeAfterWords({ before: null, after: null })).toBe("Not recorded");
  });
});

describe("each action → its route → its tool", () => {
  // Opens the action's sheet, fills it, submits it, and returns what the sheet posted.
  const post = async (open: () => Promise<void>, fill: () => void, form: string, where: "platform" | "studio" = "platform", more: Record<string, unknown> = {}) => {
    const { f, calls } = fetcher();
    const view = render(<RiskDetailView data={dataOf(more)} where={where} fetcher={f} />);
    await open();
    fill();
    await submit(`[data-risk-form="${form}"]`);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Done by Mynt.");
    view.unmount();
    expect(calls).toHaveLength(1);
    return calls[0];
  };
  // Sends that body to the platform admin's route and returns the tool call Mynt got.
  const through = async (body: Record<string, unknown>) => {
    fake.calls = [];
    const res = await adminRoute.POST(req(body), { params: Promise.resolve({ riskId: RISK }) });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    return fake.calls.filter((c) => !c.name.startsWith("list_") && c.name !== "get_risk");
  };
  const URL_ = `/api/admin/risks/${RISK}`;

  it("Add factor, Edit factor and Remove factor → add_risk_factor, update_risk_factor, remove_risk_factor", async () => {
    let sent = await post(
      () => click('[data-add-factor="likelihood"]'),
      () => (change('[data-risk-detail-field="name"]', "Single region"), change('[data-risk-detail-field="score"]', "4"), change('[data-risk-detail-field="source"]', `risk_model:${MODEL}`)),
      "factor",
    );
    expect(sent).toEqual({ url: URL_, body: { action: "add_factor", kind: "likelihood", name: "Single region", score: 4, rationale: "", source: `risk_model:${MODEL}` } });
    expect(await through(sent.body)).toEqual([{ name: "add_risk_factor", args: { risk_id: RISK, kind: "likelihood", name: "Single region", score: 4, source: `risk_model:${MODEL}` } }]);

    sent = await post(() => click(`[data-edit-factor="${F1}"]`), () => change('[data-risk-detail-field="score"]', "3"), "factor");
    expect(sent.body).toEqual({ action: "update_factor", factor_id: F1, name: "Payments stop", score: 3, rationale: "No transfers settle", source: "https://example.test/incident" });
    expect(await through(sent.body)).toEqual([{ name: "update_risk_factor", args: { risk_id: RISK, factor_id: F1, name: "Payments stop", score: 3, rationale: "No transfers settle", source: "https://example.test/incident" } }]);

    sent = await post(() => click(`[data-remove-factor="${F1}"]`), () => undefined, "remove-factor");
    expect(sent.body).toEqual({ action: "remove_factor", factor_id: F1 });
    expect(await through(sent.body)).toEqual([{ name: "remove_risk_factor", args: { risk_id: RISK, factor_id: F1 } }]);
  });

  it("Add treatment task and Update task → add_risk_treatment, update_risk_treatment", async () => {
    let sent = await post(
      () => click('[data-risk-action="add-treatment"]'),
      () => (change('[data-risk-detail-field="title"]', "Write the runbook"), change('[data-risk-detail-field="owner"]', USER), change('[data-risk-detail-field="due"]', "2027-01-01")),
      "treatment",
    );
    expect(sent.body).toEqual({ action: "add_treatment", title: "Write the runbook", owner_user_id: USER, due: "2027-01-01", progress_note: "" });
    expect(await through(sent.body)).toEqual([{ name: "add_risk_treatment", args: { risk_id: RISK, title: "Write the runbook", owner_user_id: USER, due: "2027-01-01" } }]);

    sent = await post(
      async () => (await click('[data-detail-tab="treatment"]'), await click(`[data-update-treatment="${T1}"]`)),
      () => (change('[data-risk-detail-field="status"]', "done"), change('[data-risk-detail-field="effectiveness"]', "partly_effective"), change('[data-risk-detail-field="effectiveness_note"]', "Failover works, slowly")),
      "treatment",
    );
    expect(sent.body).toEqual({ action: "update_treatment", treatment_id: T1, title: "Add a second region", due: "2026-02-01", progress_note: "Replica is up", status: "done", effectiveness: "partly_effective", effectiveness_note: "Failover works, slowly" });
    expect(await through(sent.body)).toEqual([{ name: "update_risk_treatment", args: { risk_id: RISK, treatment_id: T1, title: "Add a second region", due: "2026-02-01", progress_note: "Replica is up", status: "done", effectiveness: "partly_effective", effectiveness_note: "Failover works, slowly" } }]);
  });

  it("Add control, Make this a control, Update control and Retire control → add_risk_control, update_risk_control, retire_risk_control", async () => {
    let sent = await post(() => click('[data-risk-action="add-control"]'), () => (change('[data-risk-detail-field="name"]', "Region health check"), change('[data-risk-detail-field="kind"]', "detective")), "control");
    expect(sent.body).toEqual({ action: "add_control", name: "Region health check", kind: "detective", description: "", last_tested_at: "" });
    expect(await through(sent.body)).toEqual([{ name: "add_risk_control", args: { risk_id: RISK, name: "Region health check", kind: "detective" } }]);

    // From a done task: the sheet starts on the task's title and names the task.
    sent = await post(async () => (await click('[data-detail-tab="treatment"]'), await click(`[data-make-control="${T2}"]`)), () => expect((document.querySelector('[data-risk-detail-field="name"]') as HTMLInputElement).value).toBe("Run a failover drill"), "control");
    expect(sent.body).toEqual({ action: "add_control", name: "Run a failover drill", kind: "preventive", description: "", last_tested_at: "", source_treatment_id: T2 });
    expect(await through(sent.body)).toEqual([{ name: "add_risk_control", args: { risk_id: RISK, name: "Run a failover drill", kind: "preventive", source_treatment_id: T2 } }]);

    sent = await post(
      async () => (await click('[data-detail-tab="controls"]'), await click(`[data-update-control="${C1}"]`)),
      () => (change('[data-risk-detail-field="last_tested_at"]', "2026-11-01"), change('[data-risk-detail-field="test_result"]', "passed")),
      "control",
    );
    expect(sent.body).toEqual({ action: "update_control", control_id: C1, name: "Hourly ledger backup", kind: "corrective", description: "Restorable within the hour", last_tested_at: "2026-11-01", test_result: "passed" });
    expect((await through(sent.body))[0]).toMatchObject({ name: "update_risk_control", args: { risk_id: RISK, control_id: C1, last_tested_at: "2026-11-01", test_result: "passed" } });

    sent = await post(async () => (await click('[data-detail-tab="controls"]'), await click(`[data-retire-control="${C1}"]`)), () => change('[data-risk-detail-field="reason"]', "Replaced by continuous replication"), "retire-control");
    expect(sent.body).toEqual({ action: "retire_control", control_id: C1, reason: "Replaced by continuous replication" });
    expect(await through(sent.body)).toEqual([{ name: "retire_risk_control", args: { risk_id: RISK, control_id: C1, reason: "Replaced by continuous replication" } }]);
  });

  it("Link item (a picker by type, less what is already linked) and Remove link → link_risk, unlink_risk", async () => {
    let sent = await post(
      () => click('[data-risk-action="link"]'),
      () => {
        // The picker starts on a type the route offers choices for, without the model already linked.
        expect((document.querySelector('[data-risk-detail-field="target_type"]') as HTMLSelectElement).value).toBe("risk_model");
        expect([...document.querySelectorAll('[data-risk-detail-field="target_type"] option')].map((o) => o.textContent)).toEqual(["App", "Product", "Vendor service", "Agreement", "Oversight audit", "Audit-trail entry", "Risk model", "Firm"]);
        expect([...document.querySelectorAll('[data-risk-detail-field="target_pick"] option')].map((o) => o.textContent)).toEqual(["Pick one, or give an id below", "Capacity model"]);
        change('[data-risk-detail-field="target_pick"]', "88888888-8888-4888-8888-888888888888");
        change('[data-risk-detail-field="note"]', "Sizes the second region");
      },
      "link",
    );
    expect(sent.body).toEqual({ action: "link", target_type: "risk_model", target_id: "88888888-8888-4888-8888-888888888888", note: "Sizes the second region" });
    expect(await through(sent.body)).toEqual([{ name: "link_risk", args: { risk_id: RISK, target_type: "risk_model", target_id: "88888888-8888-4888-8888-888888888888", note: "Sizes the second region" } }]);
    // A type with nothing to pick takes an id.
    sent = await post(() => click('[data-risk-action="link"]'), () => (change('[data-risk-detail-field="target_type"]', "firm"), change('[data-risk-detail-field="target_id"]', "f-1")), "link");
    expect(sent.body).toEqual({ action: "link", target_type: "firm", target_id: "f-1", note: "" });

    sent = await post(async () => (await click('[data-detail-tab="linked"]'), await click(`[data-unlink="${L1}"]`)), () => undefined, "unlink");
    expect(sent.body).toEqual({ action: "unlink", link_id: L1 });
    expect(await through(sent.body)).toEqual([{ name: "unlink_risk", args: { risk_id: RISK, link_id: L1 } }]);
  });

  it("Close risk and Accept risk need a note → update_risk with the status and why", async () => {
    let sent = await post(
      () => click('[data-risk-action="close"]'),
      () => {
        expect((document.querySelector('[data-risk-detail-submit="status"]') as HTMLButtonElement).disabled).toBe(true);
        change('[data-risk-detail-field="reason"]', "The second region is live");
      },
      "status",
    );
    expect(sent.body).toEqual({ action: "set_status", status: "closed", note: "The second region is live" });
    expect(await through(sent.body)).toEqual([{ name: "update_risk", args: { risk_id: RISK, status: "closed", note: "The second region is live" } }]);
    sent = await post(() => click('[data-risk-action="accept"]'), () => change('[data-risk-detail-field="reason"]', "Cost of a second region outweighs it"), "status");
    expect(sent.body).toEqual({ action: "set_status", status: "accepted", note: "Cost of a second region outweighs it" });
    expect(await through(sent.body)).toEqual([{ name: "update_risk", args: { risk_id: RISK, status: "accepted", note: "Cost of a second region outweighs it" } }]);
  });

  it("Review risk opens the register's own review sheet, which posts to the register's route", async () => {
    const { f, calls } = fetcher();
    render(<RiskDetailView data={dataOf()} where="platform" fetcher={f} />);
    await click('[data-risk-action="review"]');
    expect(document.querySelector("[data-review-risk-sheet]")).not.toBeNull();
    change('[data-risk-field="control_effectiveness"]', "strong");
    await submit(`[data-review-risk-form="${RISK}"]`);
    expect(calls).toEqual([{ url: "/api/admin/risks", body: { action: "review", risk_id: RISK, control_effectiveness: "strong" } }]);
  });

  it("an app's and a product's detail post to the route under that app or product; Mynt's refusal is shown in its words", async () => {
    expect(riskDetailRoute("studio", { type: "app", id: APP }, RISK)).toBe(`/api/apps/${APP}/risks/${RISK}`);
    expect(riskDetailRoute("studio", { type: "product", id: PRODUCT }, RISK)).toBe(`/api/products/${PRODUCT}/risks/${RISK}`);
    expect(riskDetailRoute("platform", { type: "app", id: APP }, RISK)).toBe(`/api/admin/risks/${RISK}`);
    const sent = await post(() => click('[data-risk-action="close"]'), () => change('[data-risk-detail-field="reason"]', "Fixed in the app"), "status", "studio", { subject: { type: "app", id: APP, name: "Cards" } });
    expect(sent.url).toBe(`/api/apps/${APP}/risks/${RISK}`);
    const refusing = vi.fn(async () => new Response(JSON.stringify({ error: "refused", message: "Only the workspace's owners and admins keep its apps' risk registers" }), { status: 422 })) as unknown as typeof fetch;
    render(<RiskDetailView data={dataOf()} where="platform" fetcher={refusing} />);
    await click('[data-risk-action="close"]');
    change('[data-risk-detail-field="reason"]', "Trying");
    await submit('[data-risk-form="status"]');
    expect(document.querySelector("[data-sheet-error]")!.textContent).toBe("Only the workspace's owners and admins keep its apps' risk registers");
  });
});

describe("the routes", () => {
  const admin = (riskId = RISK) => ({ params: Promise.resolve({ riskId }) });
  const app = (appId = APP, riskId = RISK) => ({ params: Promise.resolve({ appId, riskId }) });
  const product = (productId = PRODUCT, riskId = RISK) => ({ params: Promise.resolve({ productId, riskId }) });
  const CLOSE = { action: "set_status", status: "closed", note: "Done with it" };

  it("the platform's: Mynt admins only (anyone else a 404, nothing sent to Mynt), own origin for writes, a uuid in the address, strict bodies", async () => {
    fake.session = session(["developer", "license_provider"]);
    for (const r of [await adminRoute.GET(req(), admin()), await adminRoute.POST(req(CLOSE), admin())]) expect(r.status).toBe(404);
    expect(fake.calls).toEqual([]);
    fake.session = undefined;
    expect((await adminRoute.GET(req(), admin())).status).toBe(401);
    fake.session = session(["admin"]);
    fake.sameOrigin = false;
    expect((await adminRoute.POST(req(CLOSE), admin())).status).toBe(403);
    fake.sameOrigin = true;
    expect((await adminRoute.GET(req(), admin("not-a-uuid"))).status).toBe(400);
    expect((await adminRoute.POST(req(CLOSE), admin("../x"))).status).toBe(400);
    for (const bad of [{}, { action: "delete_risk" }, { ...CLOSE, note: "" }, { ...CLOSE, status: "open" }, { ...CLOSE, risk_id: RISK }, { action: "add_factor", kind: "impact", name: "x", score: 9 }, { action: "link", target_type: "workspace", target_id: "w" }, { action: "add_factor", kind: "impact", name: "Loss", score: 3, source: "http://plain.example.test" }])
      expect((await adminRoute.POST(req(bad), admin())).status, JSON.stringify(bad)).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("the platform's GET: the risk in full, the admins who may own it, and Mynt's live risk models for the Link item picker", async () => {
    const res = await adminRoute.GET(req(), admin());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detail: { risk: { id: string }; canManage: boolean }; owners: unknown[]; linkChoices: Record<string, unknown> };
    expect(body.detail.risk.id).toBe(RISK);
    expect(body.detail.canManage).toBe(true);
    expect(body.owners).toEqual([{ userId: USER, name: "Boss" }]);
    expect(body.linkChoices).toEqual({ risk_model: [{ id: MODEL, name: "Outage cost model" }] });
    expect(called("get_risk")).toEqual([{ risk_id: RISK }]);
    // An older Mynt without the tool says so; an answer that isn't a risk is unreadable, not an empty page.
    fake.tools = [{ name: "list_risks" }];
    expect(await (await adminRoute.GET(req(), admin())).json()).toEqual({ supported: false });
    expect((await adminRoute.POST(req(CLOSE), admin())).status).toBe(422);
    fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
    fake.reply.get_risk = { error: "x" };
    expect((await adminRoute.GET(req(), admin())).status).toBe(502);
  });

  it("an app's: a signed-in developer's own app, and only a risk on that app's register", async () => {
    fake.reply.get_risk = reply({ subject: { type: "app", id: APP, name: "Cards" } });
    const res = await appRoute.GET(req(), app());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { owners: unknown[]; linkChoices: Record<string, unknown> };
    expect(body.owners).toEqual([{ userId: USER, name: "Ines" }]);
    expect(body.linkChoices).toEqual({ app: [{ id: APP, name: "Cards" }], product: [{ id: PRODUCT, name: PRODUCT }] });
    fake.calls = [];
    expect((await appRoute.POST(req(CLOSE), app())).status).toBe(200);
    expect(called("update_risk")).toEqual([{ risk_id: RISK, status: "closed", note: "Done with it" }]);
    // Not this user's app; a risk on another register (Mynt's own, or another app's): not found, and nothing changes.
    fake.calls = [];
    expect((await appRoute.POST(req(CLOSE), app("someone-elses"))).status).toBe(404);
    fake.reply.get_risk = reply();
    expect((await appRoute.GET(req(), app())).status).toBe(404);
    expect((await appRoute.POST(req(CLOSE), app())).status).toBe(404);
    fake.reply.get_risk = reply({ subject: { type: "app", id: "another-app", name: "Other" } });
    expect((await appRoute.POST(req(CLOSE), app())).status).toBe(404);
    expect(called("update_risk")).toEqual([]);
    // Own origin, a signed-in developer, strict bodies, a uuid for the risk.
    fake.reply.get_risk = reply({ subject: { type: "app", id: APP, name: "Cards" } });
    fake.sameOrigin = false;
    expect((await appRoute.POST(req(CLOSE), app())).status).toBe(403);
    fake.sameOrigin = true;
    expect((await appRoute.POST(req({ ...CLOSE, extra: 1 }), app())).status).toBe(400);
    expect((await appRoute.GET(req(), app(APP, "nope"))).status).toBe(400);
    fake.session = session(["consumer"]);
    expect((await appRoute.POST(req(CLOSE), app())).status).toBe(403);
    fake.session = undefined;
    expect((await appRoute.GET(req(), app())).status).toBe(401);
    expect(called("update_risk")).toEqual([]);
  });

  it("a product's: the user's own product, and only a risk on that product's register; Mynt's refusal comes back as the message", async () => {
    fake.reply.get_risk = reply({ subject: { type: "product", id: PRODUCT, name: "Card" }, can_manage: false });
    const res = await productRoute.GET(req(), product());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { linkChoices: unknown }).linkChoices).toEqual({ product: [{ id: PRODUCT, name: "Card" }] });
    expect((await productRoute.GET(req(), product("not-mine"))).status).toBe(404);
    fake.reply.get_risk = reply({ subject: { type: "app", id: APP, name: "Cards" } });
    expect((await productRoute.POST(req(CLOSE), product())).status).toBe(404);
    // A sponsor reads it; a write is Mynt's to refuse, in its words.
    fake.reply.get_risk = reply({ subject: { type: "product", id: PRODUCT, name: "Card" }, can_manage: false });
    fake.refuse = "Only the product's own firm keeps its risk register; its sponsors read it";
    const refused = await productRoute.POST(req(CLOSE), product());
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(((await refused.json()) as { message: string }).message).toBe("Only the product's own firm keeps its risk register; its sponsors read it");
    fake.sameOrigin = false;
    expect((await productRoute.POST(req(CLOSE), product())).status).toBe(403);
  });

  it("the allow-lists: the risk's own tools are on both, each strict; the grading tools are the platform admin's only", () => {
    const TOOLS = ["get_risk", "add_risk_factor", "update_risk_factor", "remove_risk_factor", "add_risk_treatment", "update_risk_treatment", "add_risk_control", "update_risk_control", "retire_risk_control", "link_risk", "unlink_risk"];
    for (const t of TOOLS) {
      expect(Object.keys(STUDIO_TOOLS), t).toContain(t);
      expect(Object.keys(ADMIN_TOOLS), t).toContain(t);
      expect(parseStudioCall(t, { risk_id: RISK, extra: true }), t).toHaveProperty("error");
      expect(parseAdminCall(t, { risk_id: "not-a-uuid" }), t).toHaveProperty("error");
    }
    expect(Object.values(detail.DETAIL_ACTION_TOOLS).sort()).toEqual([...TOOLS.filter((t) => t !== "get_risk"), "update_risk"].sort());
    for (const t of ["get_risk_grading", "set_risk_grading"]) {
      expect(Object.keys(ADMIN_TOOLS)).toContain(t);
      expect(Object.keys(STUDIO_TOOLS)).not.toContain(t);
    }
    expect(renderToStaticMarkup(<RiskDetailView data={dataOf()} where="platform" />)).toContain("data-metadata-card");
  });
});
