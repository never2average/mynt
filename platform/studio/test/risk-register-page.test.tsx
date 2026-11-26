// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";

// The platform admin's Risk register (/platform/risk-register): seven risk-area tabs; each is ONE table filling the
// page under the list toolbar (search, Filters for source, status, level and Unassigned, Import, Export CSV, Add risk
// starting on the tab's area). Its rows are the area's risk items from three sources, said in words: Mynt's own
// register (a labelled Review risk on each row, opening its sheet, posting to /api/admin/risks), the open risks across
// apps and products (read-only, linked), and the area's signals. A signal that is clear is one row saying so; what
// Mynt can't answer is one row, "Not available", with why.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/risk-register",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { RiskRegisterAreaView, RiskRegisterView } = await import("@/components/admin-risk-register");
const risks = await import("@/lib/admin-risks");
const { RISK_AREAS, RISK_AREA_LABELS, RISK_AREA_OF_CATEGORY, areaOfRisk, scoresFrom } = await import("@/lib/risk-register");
type Data = import("@/lib/admin-risks").RegisterAreaData;

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const FIRM = "33333333-3333-4333-8333-333333333333";
const R1 = "44444444-4444-4444-8444-444444444444";
const R2 = "55555555-5555-4555-8555-555555555555";
const R3 = "66666666-6666-4666-8666-666666666666";
const fetcher = () => {
  const calls: { url: string; body: unknown }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, message: "Done by Mynt." }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
};
const click = async (sel: string) => act(async () => void fireEvent.click(document.querySelector(sel)!));
const submit = (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!));
const change = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } });

const OPS = {
  attention: ["hosting: 1 app(s) stopped", "liquidity pools: 1 open over_withdrawal flag(s) on real money: list_pool_flags, then resolve_pool_flag", "backups are on this server only; add an off-site bucket"],
  window_hours: 24,
  vendors: { failed_conformance: [{ offering: "Fast KYC", created_at: "2026-11-20T10:00:00.000Z" }] },
  apps: { production_without_program_agreements: [] },
  agreement_audits: { overdue: 0, apps_flagged: 0 },
  covenants: { open_breaches: 0 },
  product_health: { stalled: [] },
  backups: { offsite: "uploaded" },
};
const MITIGATION = "Rotate every key each quarter, keep them in the vault only, and page the on-call admin when one is read outside a deploy.";
// The tab's table, by its column headers, and its rows as text.
const heads = (root: ParentNode, sel: string) => [...root.querySelectorAll(`${sel} thead th`)].map((th) => th.textContent);
const bodyRows = (root: ParentNode, sel: string) => [...root.querySelectorAll(`${sel} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
const TABLE = "[data-risk-register-area]";
// A register row with its three scores, as Mynt graded them (mynt: its inherent, control and residual; left out, an
// older Mynt: the control not assessed and the residual the same as inherent).
const scored = <T extends { likelihood: number; impact: number }>(r: T, mynt: Record<string, unknown> = {}) => ({ ...r, ...scoresFrom(mynt, r.likelihood, r.impact) });
const PARTIAL = { control: { effectiveness: "partial", note: null }, residual: { score: 5, level: "medium", level_name: "Medium", assessed: true, overridden: false } };
const data = (area: (typeof RISK_AREAS)[number] = "technology"): Data => ({
  area,
  register: {
    available: true,
    canManage: true,
    overdue: 1,
    owners: [{ userId: USER, name: "Boss" }],
    risks: [
      scored({ id: R1, title: "Key leak", category: "security", riskArea: "technology", description: null, likelihood: 2, impact: 5, score: 10, owner: null, mitigation: MITIGATION, status: "open", reviewBy: "2026-01-01", overdue: true } as const, PARTIAL),
      scored({ id: R3, title: "Laptop theft", category: "security", riskArea: "technology", description: null, likelihood: 1, impact: 3, score: 3, owner: { userId: USER, name: "Boss" }, mitigation: null, status: "mitigating", reviewBy: null, overdue: false } as const),
    ],
  },
  unassigned: { available: true, canManage: true, overdue: 0, owners: [], risks: [scored({ id: R2, title: "Something else", category: "other", riskArea: null, description: null, likelihood: 1, impact: 2, score: 2, owner: null, mitigation: null, status: "open", reviewBy: null, overdue: false } as const)] },
  cross: risks.crossRisksFrom(
    {
      risks: [
        { id: "x1", subject_type: "app", subject_name: "Saver", workspace_id: WS, title: "Session hijack", category: "security", likelihood: 4, impact: 4, score: 16, inherent: { score: 16, level: "critical", level_name: "Critical" }, control: { effectiveness: "strong" }, residual: { score: 4, level: "low", level_name: "Low", assessed: true, overridden: true, likelihood: 1, impact: 4, override: { why: "Sessions are short-lived" } }, owner: { user_id: USER, name: "Dana" }, mitigation: "Short sessions", status: "open", review_by: "2026-12-01" },
        { id: "x2", subject_type: "product", subject_name: "Fixed deposit", firm_id: FIRM, title: "Patch lag", category: "operational", risk_area: "technology", score: 9, status: "mitigating" },
        { id: "x3", subject_type: "product", subject_name: "Loan", firm_id: FIRM, title: "Rate shock", category: "credit", score: 9, status: "open" },
        { id: "x4", subject_type: "platform", subject_name: "Mynt platform", title: "Ours", category: "security", score: 9, status: "open" },
      ],
    },
    area,
  ),
  signals: risks.areaSignalsFrom(area, OPS, []),
});

describe("the categories' areas", () => {
  it("credit and liquidity are financial, compliance and conduct compliance, vendor third-party, operational and fraud operations, security technology, other none", () => {
    expect([...RISK_AREAS]).toEqual(["financial", "compliance", "third_party", "operations", "business_process", "technology", "regulated_product"]);
    expect(RISK_AREA_OF_CATEGORY).toEqual({ credit: "financial", liquidity: "financial", compliance: "compliance", conduct: "compliance", vendor: "third_party", operational: "operations", fraud: "operations", security: "technology", other: null });
    // Mynt's own area wins; an older Mynt's risk (no area at all) is mapped from its category.
    expect(areaOfRisk({ category: "security", riskArea: "operations" })).toBe("operations");
    expect(areaOfRisk({ category: "security", riskArea: null })).toBeNull();
    expect(areaOfRisk({ category: "vendor" })).toBe("third_party");
  });
});

describe("the page", () => {
  it("seven line tabs, in order, the address's selected; a tab click asks for its area", () => {
    const picked: string[] = [];
    render(<RiskRegisterView area="compliance" onArea={(a) => picked.push(a)} body={null} />);
    const tabs = [...document.querySelectorAll("[data-risk-area-tab]")];
    expect(tabs.map((t) => t.textContent)).toEqual(["Financial risk", "Compliance risk", "Third-party risk", "Operations risk", "Business process risk", "Technology risk", "Regulated product risk"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false", "false", "false", "false", "false"]);
    expect(document.querySelector("[data-risk-area-tabs]")!.getAttribute("data-variant")).toBe("line");
    fireEvent.click(document.querySelector('[data-risk-area-tab="technology"]')!);
    expect(picked).toEqual(["technology"]);
  });

  it("every tab is exactly one table under one toolbar, filling the page: no stacked sections, no section headings, no second table", () => {
    for (const area of RISK_AREAS) {
      const view = render(<RiskRegisterView area={area} onArea={() => undefined} body={<RiskRegisterAreaView data={data(area)} />} />);
      expect(document.querySelectorAll("table"), area).toHaveLength(1);
      expect(document.querySelectorAll("[data-toolbar]"), area).toHaveLength(1);
      expect(document.querySelectorAll("[data-pager]"), area).toHaveLength(1);
      expect(document.querySelectorAll("h1, h2, h3, section"), area).toHaveLength(0);
      expect(document.querySelector("[data-signal]"), area).toBeNull();
      expect(heads(document, TABLE), area).toEqual(["Risk", "Source", "Category", "Inherent", "Control", "Residual", "Owner", "Status", "Review by / When", "Detail", "Action"]);
      // The table takes the height the tabs and the toolbar leave, and it is what scrolls; its header stays in view.
      for (const sel of ["[data-platform-risk-register]", "[data-risk-register-area]", "[data-admin-list]"]) {
        expect(document.querySelector(sel)!.className, `${area} ${sel}`).toContain("min-h-0");
        expect(document.querySelector(sel)!.className, `${area} ${sel}`).toContain("flex-1");
      }
      expect(document.querySelector("[data-table-view]")!.className).toContain("flex-1");
      expect(document.querySelector("[data-table-view]")!.className).toContain("overflow-auto");
      expect(document.querySelector("thead")!.className).toContain("sticky");
      view.unmount();
    }
  });

  it("the one toolbar row: search, Filters, Import (off, with why), Export CSV and Add risk, every button labelled", () => {
    render(<RiskRegisterAreaView data={data("technology")} />);
    const bar = document.querySelector("[data-toolbar]")!;
    expect(bar.querySelector("input")!.getAttribute("aria-label")).toBe("Search technology risk by risk, source or detail");
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["Filters", "Import", "Export CSV", "Add risk"]);
    expect((bar.querySelector("[data-import]") as HTMLButtonElement).disabled).toBe(true);
    expect(bar.querySelector("[data-import]")!.getAttribute("title")).toBe("Importing a CSV comes with Mynt's next update.");
    expect((bar.querySelector("[data-export]") as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector("[data-list-note]")!.textContent).toBe("1 risk on Mynt's register is overdue for review. 1 risk has no area yet: choose Unassigned in Filters to see it.");
    // No chips as content: chips are only the Filters popover's controls (closed here). No icon-only buttons or links.
    expect(document.querySelector("[data-chip]")).toBeNull();
    for (const b of document.querySelectorAll("button, a")) expect(b.textContent!.trim(), b.outerHTML).not.toBe("");
  });

  it("the table's rows come from all three sources, each with its three scores in words: Mynt's register by residual score, then apps' and products' by residual score, then the signals, what needs attention first", () => {
    render(<RiskRegisterAreaView data={data("technology")} />);
    expect(bodyRows(document, TABLE)).toEqual([
      ["Key leak", "Mynt", "Security", "2 × 5 = 10 (High)", "Partial", "5 (Medium)", "Not assigned", "Open: not yet mitigated", "2026-01-01 (overdue)", MITIGATION, " Open Review risk"],
      // Not assessed: the residual is the inherent score, said in words, never a blank or a 0.
      ["Laptop theft", "Mynt", "Security", "1 × 3 = 3 (Low)", "Not assessed", "3 (Low), same as inherent: control not assessed", "Boss", "Mitigating: work under way", "Not set", "None recorded", " Open Review risk"],
      // Highest residual first: the product's 9 before the app's critical risk a strong control (and an override) took to 4.
      ["Patch lag", "Product: Fixed deposit", "Operational", "9 (Medium)", "Not assessed", "9 (Medium), same as inherent: control not assessed", "Not assigned", "Mitigating: work under way", "Not set", "None recorded", " Open"],
      ["Session hijack", "App: Saver", "Security", "4 × 4 = 16 (Critical)", "Strong", "4 (Low), overridden", "Dana", "Open: not yet mitigated", "2026-12-01", "Short sessions", " Open"],
      ["Server backups: the last run's result isn't recorded", "Signal: Backup", "Backup", "Not scored", "Not scored", "Not scored", "Mynt", "Needs attention", "Not recorded", "Last run: Not recorded. Result: Not recorded. Off-site: Uploaded off-site. Last success: Not recorded. Last restore test: Not recorded.", ""],
      ["No security events in the last 30 days among the newest audit entries.", "Signal: Security event", "Security event", "Not scored", "Not scored", "Not scored", "Mynt", "Clear", "Not recorded", "Audit trail entries of the security class: build audits, the mainnet gate, secrets revealed or rotated, machine access, people cut off.", ""],
    ]);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("6 rows · Page 1 of 1");
    // Another area's risk and Mynt's own on admin_list_risks aren't app or product rows.
    expect(document.body.textContent).not.toContain("Rate shock");
    expect(document.body.textContent).not.toContain("Ours");
    // Every risk's labelled Open goes to its page; an app's or a product's also links its subject (in Source) to its workspace's or firm's page.
    expect([...document.querySelectorAll(`${TABLE} a`)].map((a) => [a.textContent!.trim(), a.getAttribute("href")])).toEqual([
      ["Open", `/platform/risk-register/${R1}`],
      ["Open", `/platform/risk-register/${R3}`],
      ["Fixed deposit", `/platform/firms/${FIRM}?tab=products`],
      ["Open", "/platform/risk-register/x2"],
      ["Saver", `/platform/workspaces/${WS}`],
      ["Open", "/platform/risk-register/x1"],
    ]);
    // Each score cell says its level in words beside the number: colour is never the only signal.
    expect([...document.querySelectorAll("[data-risk-residual]")].map((c) => [c.getAttribute("data-risk-residual"), c.getAttribute("data-residual-level")])).toEqual([["5", "medium"], ["3", "low"], ["9", "medium"], ["4", "low"]]); // a signal has no score
    // The detail is cut short in its cell: the whole of it is the cell's title (and the review sheet's, and the CSV's).
    const cell = document.querySelector(`[data-row="mynt:${R1}"] [data-risk-detail]`)!;
    expect(cell.className).toContain("truncate");
    expect(cell.getAttribute("title")).toBe(MITIGATION);
    // Status is in words on every row, and each row says its source.
    expect([...document.querySelectorAll("[data-risk-source]")].map((s) => s.getAttribute("data-risk-source"))).toEqual(["mynt", "mynt", "subjects", "subjects", "signals", "signals"]);
    expect([...document.querySelectorAll("[data-risk-status]")].map((s) => s.getAttribute("data-risk-status"))).toEqual(["open", "mitigating", "mitigating", "open", "needs_attention", "clear"]);
  });

  it("each area's signals are rows: Source 'Signal: <name>', what needs attention, when it was seen, its detail", () => {
    const signalRows = (area: (typeof RISK_AREAS)[number], ops: unknown = OPS, entries: Parameters<typeof risks.areaSignalsFrom>[2] = []) => {
      const view = render(<RiskRegisterAreaView data={{ ...data(area), signals: risks.areaSignalsFrom(area, ops, entries, new Date("2026-11-25T00:00:00.000Z")) }} />);
      const rows = bodyRows(document, TABLE)
        .filter((r) => r[1].startsWith("Signal: "))
        .map((r) => [r[0], r[1], r[2], r[7], r[8]]);
      expect(document.querySelectorAll("table")).toHaveLength(1);
      view.unmount();
      return rows;
    };
    expect(signalRows("financial")).toEqual([["1 open over_withdrawal flag(s) on real money: list_pool_flags, then resolve_pool_flag", "Signal: Pool flag", "Liquidity pools", "Needs attention", "Not recorded"]]);
    expect(signalRows("third_party")).toEqual([["Fast KYC: conformance run failed", "Signal: Vendor conformance", "Vendor conformance", "Needs attention", "2026-11-20 10:00"]]);
    // Operations: the line when ops_status has no list behind it, a row per run or app when it has.
    expect(signalRows("operations")).toEqual([["1 app(s) stopped", "Signal: Agent/hosting failure", "Hosting", "Needs attention", "Not recorded"]]);
    const detailed = {
      ...OPS,
      attention: ["builds: 1 failed in the last 24h", "hosting: 1 app(s) stopped", "sandbox provider: the account's allowance is used up"],
      agents: { builds: { failures: [{ id: "b1", status: "failed", error: "tests failed", created_at: "2026-11-24T08:00:00.000Z" }], stuck: [{ id: "b2", status: "running", created_at: "2026-11-24T06:30:00.000Z" }] } },
      hosting: { failed_tenants: [], stopped_apps: [{ app_id: "saver", error: "", updated_at: "2026-11-23T12:00:00.000Z" }], stuck_deploys: [] },
    };
    expect(signalRows("operations", detailed)).toEqual([
      ["Run b1 failed: tests failed", "Signal: Agent/hosting failure", "Builds", "Needs attention", "2026-11-24 08:00"],
      ["Run b2 still running (running)", "Signal: Agent/hosting failure", "Builds", "Needs attention", "2026-11-24 06:30"],
      ["App saver stopped", "Signal: Agent/hosting failure", "Hosting", "Needs attention", "2026-11-23 12:00"],
      ["The account's allowance is used up", "Signal: Agent/hosting failure", "Sandbox provider", "Needs attention", "Not recorded"],
    ]);
    // Compliance: apps missing agreements and overdue audits; measured and nothing there is one row, Clear, in words.
    const comp = { ...OPS, apps: { production_without_program_agreements: [{ app_id: "a1", app_name: "Saver", missing: 2 }] }, agreement_audits: { overdue: 3, apps_flagged: 2 } };
    expect(signalRows("compliance", comp)).toEqual([
      ["Saver: in production without its program agreements", "Signal: Missing program agreement", "Program agreement", "Needs attention", "Not recorded"],
      ["3 oversight audits are overdue", "Signal: Overdue agreement audit", "Oversight audit", "Needs attention", "Not recorded"],
    ]);
    expect(signalRows("compliance")).toEqual([
      ["Every production app has its program agreements.", "Signal: Missing program agreement", "Missing program agreement", "Clear", "Not recorded"],
      ["No oversight audit is overdue.", "Signal: Overdue agreement audit", "Overdue agreement audit", "Clear", "Not recorded"],
    ]);
    const compItems = risks.areaSignalsFrom("compliance", comp, []).flatMap(risks.signalItems);
    expect(compItems.map((i) => i.detail)).toEqual([expect.stringMatching(/^2 signed program agreements missing\. Production apps without/), expect.stringMatching(/^Apps flagged: 2\. Oversight audits/)]);
    // Technology: a security event from the audit log, and the backups as one row (clear when the last run succeeded
    // and nothing failed; needing attention, saying what, otherwise).
    const entry = { id: "e1", at: "2026-11-20T09:00:00.000Z", action: "reveal_secret", class: "security", actor: { id: USER, name: "Boss", email: null }, target: "app-1" } as unknown as NonNullable<Parameters<typeof risks.areaSignalsFrom>[2]>[number];
    const good = { last_run_at: "2026-11-24T02:00:00.000Z", ok: true, last_success_at: "2026-11-24T02:00:00.000Z", offsite: "uploaded", last_verify: { at: "2026-11-22T03:00:00.000Z", ok: true } };
    const tech = signalRows("technology", { ...OPS, backups: good }, [entry]);
    expect(tech).toHaveLength(2);
    expect(tech[0].slice(1, 4)).toEqual(["Signal: Security event", "Security event", "Needs attention"]);
    expect(tech[1]).toEqual(["Server backups: the last run succeeded", "Signal: Backup", "Backup", "Clear", "2026-11-24 02:00"]);
    const event = risks.areaSignalsFrom("technology", OPS, [entry], new Date("2026-11-25T00:00:00.000Z")).flatMap(risks.signalItems)[0];
    expect(event.detail).toMatch(/^Actor: .*\. Target: app-1\.$/);
    expect(event.when).not.toBe("Not recorded");
    const bad = { ...good, offsite: "local_only", last_verify: { at: "2026-11-22T03:00:00.000Z", ok: false, error: "row counts differ" } };
    expect(signalRows("technology", { ...OPS, backups: bad }).find((r) => r[1] === "Signal: Backup")).toEqual(["Server backups: the last restore test failed", "Signal: Backup", "Backup", "Needs attention", "2026-11-24 02:00"]);
    // A signal Mynt doesn't measure is ONE row, Not available, its detail the reason.
    expect(signalRows("technology", { ...OPS, backups: { status: "no status file" } }).find((r) => r[1] === "Signal: Backup")).toEqual(["Backups", "Signal: Backup", "Backup", "Not available", "Not recorded"]);
    expect(risks.areaSignalsFrom("technology", { ...OPS, backups: { status: "no status file" } }, []).flatMap(risks.signalItems)[1].detail).toBe("No backup has run on this server: there is no backup status file to read.");
    const bp = render(<RiskRegisterAreaView data={data("business_process")} />);
    expect(bodyRows(document, TABLE).filter((r) => r[1] === "Signal: Drifted product")).toEqual([
      ["Drifted products", "Signal: Drifted product", "Drifted product", "Not scored", "Not scored", "Not scored", "Mynt", "Not available", "Not recorded", "Mynt's operations status doesn't count drifted products across firms yet; each app's Security & risk tab shows its own.", ""],
    ]);
    bp.unmount();
    // Every signal of every area is in the table, never left out; signals come needs-attention first, then clear, then not available.
    for (const area of RISK_AREAS) {
      const items = risks.registerItemsFrom(data(area));
      for (const spec of risks.areaSignalsFrom(area, OPS, [])) expect(items.filter((i) => i.sourceWords === `Signal: ${risks.signalName(spec)}`).length, `${area} ${spec.id}`).toBeGreaterThanOrEqual(1);
      const order = items.filter((i) => i.source === "signals").map((i) => ["needs_attention", "clear", "not_available"].indexOf(i.status));
      expect(order, area).toEqual([...order].sort((a, b) => a - b));
      const sources = items.map((i) => i.source).filter((s, n, list) => s !== list[n - 1]);
      expect(["mynt,subjects,signals", "mynt,signals"], area).toContain(sources.join(","));
    }
  });

  it("what Mynt can't answer is one row per part, Not available with why in Detail: never a 0, never left out, still one table", () => {
    for (const area of RISK_AREAS) {
      const none: Data = {
        area,
        register: { available: false, reason: "Mynt's own risk register comes with Mynt's next update." },
        unassigned: { available: false, reason: "Mynt's own risk register comes with Mynt's next update." },
        cross: { available: false, reason: "Risks across apps and products come with Mynt's next update." },
        signals: risks.areaSignalsFrom(area, null, null),
      };
      const html = renderToStaticMarkup(<RiskRegisterAreaView data={none} />);
      expect(html).not.toContain("data-add-risk");
      expect(html).not.toMatch(/\(0\)/);
      const view = render(<RiskRegisterAreaView data={none} />);
      expect(document.querySelectorAll("table")).toHaveLength(1);
      const rows = bodyRows(document, TABLE);
      expect(rows, area).toHaveLength(2 + none.signals.length);
      expect(rows[0]).toEqual(["Mynt's own register", "Mynt", "Risk register", "Not available", "Not available", "Not available", "Mynt", "Not available", "Not recorded", "Mynt's own risk register comes with Mynt's next update.", ""]);
      expect(rows[1]).toEqual(["Open risks across apps and products", "Apps and products", "Risk register", "Not available", "Not available", "Not available", "Their workspaces and firms", "Not available", "Not recorded", "Risks across apps and products come with Mynt's next update.", ""]);
      none.signals.forEach((spec, n) => {
        const reason = spec.id === "security" ? "This Mynt has no audit log to read." : spec.id === "drift" ? "Mynt's operations status doesn't count drifted products across firms yet; each app's Security & risk tab shows its own." : "This Mynt has no operations status (ops_status) to read.";
        expect(rows[2 + n], `${area} ${spec.id}`).toEqual([spec.title, `Signal: ${risks.signalName(spec)}`, risks.signalName(spec), "Not scored", "Not scored", "Not scored", "Mynt", "Not available", "Not recorded", reason, ""]);
      });
      for (const r of rows) for (const c of r) expect(c).not.toBe("0");
      view.unmount();
    }
    expect(risks.areaSignalsFrom("technology", OPS, null)[0].signal).toMatchObject({ available: false, reason: "This Mynt has no audit log to read." });
  });

  it("search covers the risk, its source and its detail; Filters narrow by source, status and residual level; Unassigned shows Mynt's risks with no area yet", async () => {
    function Harness() {
      const [filter, setFilter] = useState<"area" | "unassigned">("area");
      return <RiskRegisterAreaView data={data("technology")} filter={filter} onFilter={setFilter} />;
    }
    render(<Harness />);
    const titles = () => bodyRows(document, TABLE).map((r) => r[0]);
    const ALL = ["Key leak", "Laptop theft", "Patch lag", "Session hijack", "Server backups: the last run's result isn't recorded", "No security events in the last 30 days among the newest audit entries."];
    expect(titles()).toEqual(ALL);
    const search = (q: string) => change("[data-toolbar] input", q);
    search("laptop");
    expect(titles()).toEqual(["Laptop theft"]);
    search("saver"); // the source
    expect(titles()).toEqual(["Session hijack"]);
    search("signal: backup");
    expect(titles()).toEqual(["Server backups: the last run's result isn't recorded"]);
    search("on-call admin"); // the detail, past where its cell cuts it short
    expect(titles()).toEqual(["Key leak"]);
    search("no such risk");
    expect(titles()).toEqual(["No risks match this search and these filters."]);
    search("");
    await click("[data-filters-menu-button]");
    expect([...document.querySelectorAll("[data-facet-heading]")].map((h) => h.textContent)).toEqual(["Source", "Status", "Residual level", "Risk area"]);
    expect([...document.querySelectorAll('[data-facet="source"] [data-chip]')].map((c) => c.textContent)).toEqual(["Mynt", "Apps and products", "Signals"]);
    expect([...document.querySelectorAll('[data-facet="status"] [data-chip]')].map((c) => c.textContent)).toEqual(["Open: not yet mitigated", "Mitigating: work under way", "Accepted: living with it", "Closed", "Needs attention", "Clear", "Not available"]);
    expect([...document.querySelectorAll('[data-facet="level"] [data-chip]')].map((c) => c.textContent)).toEqual(["Critical", "High", "Medium", "Low"]);
    expect([...document.querySelectorAll('[data-facet="area"] [data-chip]')].map((c) => c.textContent)).toEqual(["Unassigned (no area yet)"]);
    // Source.
    await click('[data-facet="source"] [data-chip="mynt"]');
    expect(titles()).toEqual(ALL.slice(0, 2));
    await click('[data-facet="source"] [data-chip="subjects"]');
    expect(titles()).toEqual(ALL.slice(0, 4));
    await click('[data-facet="source"] [data-chip="mynt"]');
    expect(titles()).toEqual(ALL.slice(2, 4));
    await click('[data-facet="source"] [data-chip="subjects"]');
    await click('[data-facet="source"] [data-chip="signals"]');
    expect(titles()).toEqual(ALL.slice(4));
    await click('[data-facet="source"] [data-chip="signals"]');
    // Residual level: what a risk stands at after its controls, not its inherent level (Session hijack is critical
    // before its control, low after). A signal has no score, so no level.
    await click('[data-facet="level"] [data-chip="critical"]');
    expect(titles()).toEqual(["No risks match this search and these filters."]);
    await click('[data-facet="level"] [data-chip="critical"]');
    await click('[data-facet="level"] [data-chip="medium"]');
    expect(titles()).toEqual(["Key leak", "Patch lag"]);
    await click('[data-facet="level"] [data-chip="low"]');
    expect(titles()).toEqual(["Key leak", "Laptop theft", "Patch lag", "Session hijack"]);
    await click("[data-filters-clear]");
    expect(titles()).toEqual(ALL);
    // Status.
    await click('[data-facet="status"] [data-chip="mitigating"]');
    expect(titles()).toEqual(["Laptop theft", "Patch lag"]);
    await click('[data-facet="status"] [data-chip="mitigating"]');
    await click('[data-facet="status"] [data-chip="needs_attention"]');
    expect(titles()).toEqual([ALL[4]]);
    await click('[data-facet="status"] [data-chip="clear"]');
    expect(titles()).toEqual(ALL.slice(4));
    await click("[data-filters-clear]");
    // Unassigned: Mynt's risks with no area yet, in the same table.
    await click('[data-facet="area"] [data-chip="unassigned"]');
    expect(bodyRows(document, TABLE)).toEqual([["Something else", "Mynt", "Other", "1 × 2 = 2 (Low)", "Not assessed", "2 (Low), same as inherent: control not assessed", "Not assigned", "Open: not yet mitigated", "Not set", "None recorded", " Open Review risk"]]);
    expect(document.querySelectorAll("table")).toHaveLength(1);
    expect(document.querySelector("[data-toolbar] input")!.getAttribute("aria-label")).toBe("Search unassigned risks by risk, source or detail");
    await click('[data-facet="area"] [data-chip="unassigned"]');
    expect(titles()).toEqual(ALL);
  });

  it("a risk's row opens its page, by a click or its labelled Open; Review risk stays a labelled button opening its sheet; a signal's row opens nothing", async () => {
    const opened: string[] = [];
    render(<RiskRegisterAreaView data={data("technology")} onOpen={(id) => opened.push(id)} />);
    const sheet = () => document.querySelector('[data-review-risk-sheet] [data-risk-field="mitigation"]') as HTMLTextAreaElement | null;
    await click('[data-row^="signal:backups"]');
    expect(opened).toEqual([]);
    expect(document.querySelector('[data-row^="signal:backups"]')!.className).not.toContain("cursor-pointer");
    // Mynt's own risk and an app's or a product's both open the risk's page.
    expect(document.querySelector(`[data-row="mynt:${R1}"]`)!.className).toContain("cursor-pointer");
    await click(`[data-row="mynt:${R1}"]`);
    await click('[data-row="subject:x2"]');
    expect(opened).toEqual([R1, "x2"]);
    expect(sheet()).toBeNull();
    expect(document.querySelector(`[data-open-risk="${R1}"]`)!.getAttribute("href")).toBe(`/platform/risk-register/${R1}`);
    expect(document.querySelector('[data-open-risk="x2"]')!.getAttribute("aria-label")).toBe("Open the risk Patch lag");
    // Review risk is its own labelled action: its sheet, with the whole mitigation, and the page doesn't open too.
    await click(`[data-review-risk="${R1}"]`);
    expect(sheet()!.value).toBe(MITIGATION);
    expect(opened).toEqual([R1, "x2"]);
    expect(document.querySelector(`[data-review-risk-form="${R1}"]`)).not.toBeNull();
    // Only Mynt's own risks are reviewed here: an app's or a product's has no Review risk.
    expect([...document.querySelectorAll("[data-review-risk]")].map((b) => b.getAttribute("data-review-risk"))).toEqual([R1, R3]);
    // Read-only (not an admin who keeps it): no Add risk, no Review risk.
    cleanup();
    const d = data("technology");
    render(<RiskRegisterAreaView data={{ ...d, register: { ...d.register, canManage: false } as Data["register"] }} />);
    expect(document.querySelector("[data-add-risk]")).toBeNull();
    expect(document.querySelector("[data-review-risk]")).toBeNull();
    expect(document.querySelector("[data-list-note]")!.textContent).toContain("Read-only: Mynt's admins keep Mynt's register.");
  });

  it("Export CSV writes the rows shown, from every source, the detail in full", async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:x"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<RiskRegisterAreaView data={data("technology")} />);
    await click("[data-export]");
    expect(clicked).toHaveBeenCalledTimes(1);
    const csv = await new Promise<string>((done) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Risk,Source,Category,Risk area,Likelihood,Impact,Inherent score,Inherent level,Control,Residual score,Residual level,Residual,Owner,Status,Review by / When,Overdue,Detail");
    expect(lines.filter(Boolean)).toHaveLength(7);
    expect(lines[1]).toBe(`Key leak,Mynt,Security,Technology risk,2,5,10,High,Partial,5,Medium,5 (Medium),Not assigned,Open: not yet mitigated,2026-01-01,Yes,"${MITIGATION}"`);
    expect(lines[3]).toBe('Patch lag,Product: Fixed deposit,Operational,Technology risk,Not recorded,Not recorded,9,Medium,Not assessed,9,Medium,"9 (Medium), same as inherent: control not assessed",Not assigned,Mitigating: work under way,Not set,No,None recorded');
    expect(lines[4]).toBe('Session hijack,App: Saver,Security,Technology risk,4,4,16,Critical,Strong,4,Low,"4 (Low), overridden",Dana,Open: not yet mitigated,2026-12-01,No,Short sessions');
    expect(lines[5]).toBe("Server backups: the last run's result isn't recorded,Signal: Backup,Backup,Technology risk,Not scored,Not scored,Not scored,Not scored,Not scored,Not scored,Not scored,Not scored,Mynt,Needs attention,Not recorded,Not applicable,Last run: Not recorded. Result: Not recorded. Off-site: Uploaded off-site. Last success: Not recorded. Last restore test: Not recorded.");
    clicked.mockRestore();
  });

  it("the table pages 25 rows at a time, across its sources", async () => {
    const many = { risks: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, subject_type: "app", subject_name: `App ${i}`, workspace_id: WS, title: `Risk ${i}`, category: "security", score: 4, status: "open" })) };
    render(<RiskRegisterAreaView data={{ ...data("technology"), cross: risks.crossRisksFrom(many, "technology") }} />);
    expect(bodyRows(document, TABLE)).toHaveLength(25);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("34 rows · Page 1 of 2");
    expect(bodyRows(document, TABLE)[0][0]).toBe("Key leak");
    await act(async () => void fireEvent.click([...document.querySelectorAll("[data-pager] button")].find((b) => b.textContent === "Next")!));
    const last = bodyRows(document, TABLE);
    expect(last).toHaveLength(9);
    expect(last.slice(-2).map((r) => r[1])).toEqual(["Signal: Backup", "Signal: Security event"]);
    expect(document.querySelectorAll("table")).toHaveLength(1);
  });
});

describe("Add risk and Review risk", () => {
  it("Add risk starts on the tab's area and a category under it, and posts it to Mynt's own register", async () => {
    const { f, calls } = fetcher();
    const { AddRiskSheet } = await import("@/components/risk-register");
    render(<AddRiskSheet subject={{ type: "platform", id: "mynt" }} owners={[]} open onClose={() => undefined} onDone={() => undefined} fetcher={f} area="third_party" />);
    expect((document.querySelector('[data-risk-field="risk_area"]') as HTMLSelectElement).value).toBe("third_party");
    expect((document.querySelector('[data-risk-field="category"]') as HTMLSelectElement).value).toBe("vendor");
    expect([...document.querySelectorAll('[data-risk-field="risk_area"] option')].map((o) => o.textContent)).toEqual(RISK_AREAS.map((a) => RISK_AREA_LABELS[a]));
    change('[data-risk-field="title"]', "Card processor outage");
    await submit("[data-add-risk-form]");
    expect(calls).toEqual([{ url: "/api/admin/risks", body: { action: "add", title: "Card processor outage", category: "vendor", risk_area: "third_party", likelihood: 3, impact: 3 } }]);
  });

  it("Review risk gives an unassigned risk its area", async () => {
    const { f, calls } = fetcher();
    const { ReviewRiskSheet } = await import("@/components/risk-register");
    const risk = data().unassigned;
    if (!risk.available) throw new Error("fixture");
    render(<ReviewRiskSheet subject={{ type: "platform", id: "mynt" }} risk={risk.risks[0]} owners={[]} onClose={() => undefined} onDone={() => undefined} fetcher={f} withArea />);
    const select = document.querySelector('[data-risk-field="risk_area"]') as HTMLSelectElement;
    expect(select.value).toBe("");
    expect(select.options[0].textContent).toBe("Unassigned: pick one");
    change('[data-risk-field="risk_area"]', "business_process");
    await submit(`[data-review-risk-form="${R2}"]`);
    expect(calls).toEqual([{ url: "/api/admin/risks", body: { action: "review", risk_id: R2, risk_area: "business_process" } }]);
  });

  it("an app's and a product's sheets don't ask for an area (Mynt gives the category's)", async () => {
    const { AddRiskSheet } = await import("@/components/risk-register");
    render(<AddRiskSheet subject={{ type: "app", id: "app-1" }} owners={[]} open onClose={() => undefined} onDone={() => undefined} />);
    expect(document.querySelector('[data-risk-field="risk_area"]')).toBeNull();
  });
});
