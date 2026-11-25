// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";

// The platform admin's Risk register (/platform/risk-register): seven risk-area tabs; on each, every section is a
// table. Mynt's own register in that area: the list toolbar (search, Filters for status, level and Unassigned, Import,
// Export CSV, Add risk starting on the tab's area) over one table with a labelled Review risk on each row (each a
// labelled button opening its sheet, posting to /api/admin/risks); the open risks across apps and products in that
// area (read-only, linked, searched and paged); and that area's signals, each a table with its own columns. What Mynt
// can't answer is one table row, "Not available." with why.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/risk-register",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { RiskRegisterAreaView, RiskRegisterView } = await import("@/components/admin-risk-register");
const risks = await import("@/lib/admin-risks");
const { RISK_AREAS, RISK_AREA_LABELS, RISK_AREA_OF_CATEGORY, areaOfRisk } = await import("@/lib/risk-register");
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
// Each section's table, by its column headers, and one table's rows as text.
const heads = (root: ParentNode, sel: string) => [...root.querySelectorAll(`${sel} thead th`)].map((th) => th.textContent);
const bodyRows = (root: ParentNode, sel: string) => [...root.querySelectorAll(`${sel} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
const REGISTER = '[data-risk-register="platform"]';
const CROSS = '[data-signal="cross-risks"]';
const data = (area: (typeof RISK_AREAS)[number] = "technology"): Data => ({
  area,
  register: {
    available: true,
    canManage: true,
    overdue: 1,
    owners: [{ userId: USER, name: "Boss" }],
    risks: [
      { id: R1, title: "Key leak", category: "security", riskArea: "technology", description: null, likelihood: 2, impact: 5, score: 10, owner: null, mitigation: MITIGATION, status: "open", reviewBy: "2026-01-01", overdue: true },
      { id: R3, title: "Laptop theft", category: "security", riskArea: "technology", description: null, likelihood: 1, impact: 3, score: 3, owner: { userId: USER, name: "Boss" }, mitigation: null, status: "mitigating", reviewBy: null, overdue: false },
    ],
  },
  unassigned: { available: true, canManage: true, overdue: 0, owners: [], risks: [{ id: R2, title: "Something else", category: "other", riskArea: null, description: null, likelihood: 1, impact: 2, score: 2, owner: null, mitigation: null, status: "open", reviewBy: null, overdue: false }] },
  cross: risks.crossRisksFrom(
    {
      risks: [
        { id: "x1", subject_type: "app", subject_name: "Saver", workspace_id: WS, title: "Session hijack", category: "security", score: 16, status: "open" },
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

  it("a tab: Mynt's own register in that area (labelled Add risk and Review risk), the risks across apps and products in that area linked to their pages, the area's signals", () => {
    const html = renderToStaticMarkup(<RiskRegisterAreaView data={data("technology")} />);
    for (const s of ["Mynt&#x27;s own register: technology risk", 'data-risk-register="platform"', "data-add-risk", "</svg> Add risk</button>", `data-review-risk="${R1}"`, "</svg> Review risk</button>", "Key leak", "1 risk is overdue for review.", "Across apps and products", "Session hijack", "16 (Critical)", "Patch lag", "Security events in the last 30 days", "Uploaded off-site"]) expect(html).toContain(s);
    expect(html).toContain(`href="/platform/workspaces/${WS}"`);
    expect(html).toContain(`href="/platform/firms/${FIRM}?tab=products"`);
    // Another area's risk and Mynt's own aren't in the cross table.
    expect(html).not.toContain("Rate shock");
    expect(html).not.toContain(">Ours<");
    // Status in words; no icon-only buttons.
    expect(html).toContain("Open: not yet mitigated");
    expect(html).toContain("Mitigating: work under way");
    for (const b of html.match(/<button[^>]*>.*?<\/button>/g) ?? []) expect(b.replace(/<[^>]+>/g, "").trim(), b).not.toBe("");
  });

  it("the register is one table under the list toolbar: search, Filters, Import (off, with why), Export CSV and Add risk", () => {
    render(<RiskRegisterAreaView data={data("technology")} />);
    expect(heads(document, REGISTER)).toEqual(["Risk", "Category", "Likelihood", "Impact", "Score", "Owner", "Status", "Review by", "Mitigation", "Action"]);
    expect(document.querySelectorAll(`${REGISTER} table`)).toHaveLength(1);
    expect(bodyRows(document, REGISTER)).toEqual([
      ["Key leak", "Security", "2: Unlikely", "5: Severe", "10 (High)", "No owner", "Open: not yet mitigated", "2026-01-01 (overdue)", MITIGATION, " Review risk"],
      ["Laptop theft", "Security", "1: Rare", "3: Moderate", "3 (Low)", "Boss", "Mitigating: work under way", "Not set", "None recorded", " Review risk"],
    ]);
    // The mitigation is cut short in its cell (the whole of it is the cell's title, and in the review sheet).
    const cell = document.querySelector(`[data-row="${R1}"] [data-risk-mitigation]`)!;
    expect(cell.className).toContain("truncate");
    expect(cell.getAttribute("title")).toBe(MITIGATION);
    // One toolbar row, in the list kit's order; every button labelled.
    const bar = document.querySelector(`${REGISTER} [data-toolbar]`)!;
    expect(bar.querySelector("input")!.getAttribute("aria-label")).toBe("Search technology risk by risk, category, owner or mitigation");
    expect([...bar.querySelectorAll("button")].map((b) => b.textContent!.trim())).toEqual(["Filters", "Import", "Export CSV", "Add risk"]);
    expect((bar.querySelector("[data-import]") as HTMLButtonElement).disabled).toBe(true);
    expect(bar.querySelector("[data-import]")!.getAttribute("title")).toBe("Importing a CSV comes with Mynt's next update.");
    expect((bar.querySelector("[data-export]") as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector(`${REGISTER} [data-pager]`)!.textContent).toContain("2 rows · Page 1 of 1");
    // No chips as content, and no cards: chips are only the Filters popover's controls (closed here).
    expect(document.querySelector("[data-chip]")).toBeNull();
    expect(document.querySelector("[data-register-filters]")).toBeNull();
    expect(document.querySelector(`${REGISTER} [data-list-note]`)!.textContent).toBe("1 risk is overdue for review. 1 risk has no area yet: choose Unassigned in Filters to see it.");
  });

  it("the register's search and its Filters (status, level, Unassigned) narrow the table; a row's Review risk opens its sheet with the whole mitigation", async () => {
    function Harness() {
      const [filter, setFilter] = useState<"area" | "unassigned">("area");
      return <RiskRegisterAreaView data={data("technology")} filter={filter} onFilter={setFilter} />;
    }
    render(<Harness />);
    const titles = () => bodyRows(document, REGISTER).map((r) => r[0]);
    change(`${REGISTER} [data-toolbar] input`, "laptop");
    expect(titles()).toEqual(["Laptop theft"]);
    change(`${REGISTER} [data-toolbar] input`, "no such risk");
    expect(titles()).toEqual(["No risks match this search and these filters."]);
    change(`${REGISTER} [data-toolbar] input`, "");
    await click(`${REGISTER} [data-filters-menu-button]`);
    expect([...document.querySelectorAll("[data-facet-heading]")].map((h) => h.textContent)).toEqual(["Status", "Level", "Risk area"]);
    expect([...document.querySelectorAll('[data-facet="level"] [data-chip]')].map((c) => c.textContent)).toEqual(["Critical", "High", "Medium", "Low"]);
    expect([...document.querySelectorAll('[data-facet="area"] [data-chip]')].map((c) => c.textContent)).toEqual(["Unassigned (no area yet)"]);
    await click('[data-facet="level"] [data-chip="high"]');
    expect(titles()).toEqual(["Key leak"]);
    await click('[data-facet="level"] [data-chip="high"]');
    await click('[data-facet="status"] [data-chip="mitigating"]');
    expect(titles()).toEqual(["Laptop theft"]);
    await click("[data-filters-clear]");
    expect(titles()).toEqual(["Key leak", "Laptop theft"]);
    // Unassigned: the risks with no area yet, in the same table.
    await click('[data-facet="area"] [data-chip="unassigned"]');
    expect(titles()).toEqual(["Something else"]);
    expect(document.body.textContent).toContain("Mynt's own register: unassigned risks");
    await click('[data-facet="area"] [data-chip="unassigned"]');
    expect(titles()).toEqual(["Key leak", "Laptop theft"]);
    await click(`[data-review-risk="${R1}"]`);
    expect((document.querySelector('[data-review-risk-sheet] [data-risk-field="mitigation"]') as HTMLTextAreaElement).value).toBe(MITIGATION);
  });

  it("Export CSV writes the rows shown, the mitigation in full", async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => (blobs.push(b), "blob:x"));
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    render(<RiskRegisterAreaView data={data("technology")} />);
    await click(`${REGISTER} [data-export]`);
    expect(clicked).toHaveBeenCalledTimes(1);
    const csv = await new Promise<string>((done) => {
      const reader = new FileReader();
      reader.onload = () => done(String(reader.result));
      reader.readAsText(blobs[0]);
    });
    expect(csv.split("\r\n")[0]).toBe("Risk,Category,Risk area,Likelihood,Impact,Score,Level,Owner,Status,Review by,Overdue,Mitigation");
    expect(csv).toContain(`Key leak,Security,Technology risk,2,5,10,High,No owner,Open: not yet mitigated,2026-01-01,Yes,"${MITIGATION}"`);
    clicked.mockRestore();
  });

  it("Across apps and products is a table with its own search and pager: the subject linked, who keeps it, the risk, its score and level, status, review by", () => {
    render(<RiskRegisterAreaView data={data("technology")} />);
    expect(heads(document, CROSS)).toEqual(["Subject", "Workspace / firm", "Risk", "Score", "Status", "Review by"]);
    expect(bodyRows(document, CROSS)).toEqual([
      ["App: Saver", "The app's workspace", "Session hijack", "16 (Critical)", "Open: not yet mitigated", "Not set"],
      ["Financial product: Fixed deposit", "The product's firm", "Patch lag", "9 (Medium)", "Mitigating: work under way", "Not set"],
    ]);
    expect([...document.querySelectorAll(`${CROSS} a`)].map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Saver", `/platform/workspaces/${WS}`],
      ["Fixed deposit", `/platform/firms/${FIRM}?tab=products`],
    ]);
    expect(document.querySelector(`${CROSS} [data-pager]`)!.textContent).toContain("2 rows · Page 1 of 1");
    // Read-only: a search and a pager, no action on it.
    expect([...document.querySelectorAll(`${CROSS} button`)].map((b) => b.textContent!.trim())).toEqual(["Previous", "Next"]);
    change(`${CROSS} input[aria-label^="Search"]`, "patch");
    expect(bodyRows(document, CROSS).map((r) => r[2])).toEqual(["Patch lag"]);
    change(`${CROSS} input[aria-label^="Search"]`, "nothing like it");
    expect(bodyRows(document, CROSS)).toEqual([["No risks match this search."]]);
  });

  it("the cross table pages 25 rows at a time", async () => {
    const many = { risks: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, subject_type: "app", subject_name: `App ${i}`, workspace_id: WS, title: `Risk ${i}`, category: "security", score: 4, status: "open" })) };
    render(<RiskRegisterAreaView data={{ ...data("technology"), cross: risks.crossRisksFrom(many, "technology") }} />);
    expect(bodyRows(document, CROSS)).toHaveLength(25);
    expect(document.querySelector(`${CROSS} [data-pager]`)!.textContent).toContain("30 rows · Page 1 of 2");
    await act(async () => void fireEvent.click([...document.querySelectorAll(`${CROSS} [data-pager] button`)].find((b) => b.textContent === "Next")!));
    expect(bodyRows(document, CROSS)).toHaveLength(5);
  });

  it("each area's signals, each a table with its own columns", () => {
    const specs = (area: (typeof RISK_AREAS)[number]) => risks.areaSignalsFrom(area, OPS, []).map((s) => [s.title, [...s.columns]]);
    expect(specs("financial")).toEqual([["Liquidity and treasury pools", ["Area", "What needs attention"]]]);
    expect(specs("compliance")).toEqual([
      ["Apps missing a program agreement", ["App", "Missing agreements"]],
      ["Overdue oversight audits", ["Overdue audits", "Apps flagged"]],
    ]);
    expect(specs("third_party")).toEqual([["Vendor conformance", ["Service", "Last conformance", "Result"]]]);
    expect(specs("operations")).toEqual([["Agents and hosting", ["Area", "Item", "Since"]]]);
    expect(specs("business_process")).toEqual([
      ["Covenants", ["Area", "What needs attention"]],
      ["Drifted products", ["Product", "Detail"]],
    ]);
    expect(specs("technology")).toEqual([
      ["Security events in the last 30 days", ["When", "Action", "Actor", "Target"]],
      ["Backups", ["Last run", "Result", "Off-site", "Last success", "Last restore test"]],
    ]);
    expect(specs("regulated_product")).toEqual([
      ["Covenants", ["Area", "What needs attention"]],
      ["Product health", ["Area", "What needs attention"]],
      ["Drifted products", ["Product", "Detail"]],
    ]);
    // Every signal of every area renders as a table whose headers are its columns.
    for (const area of RISK_AREAS) {
      const view = render(<RiskRegisterAreaView data={data(area)} />);
      for (const spec of risks.areaSignalsFrom(area, OPS, [])) {
        expect(document.querySelectorAll(`[data-signal="${spec.id}"] table`), `${area} ${spec.id}`).toHaveLength(1);
        expect(heads(document, `[data-signal="${spec.id}"]`), `${area} ${spec.id}`).toEqual([...spec.columns]);
      }
      view.unmount();
    }
  });

  it("the signals' rows: what ops_status and the audit log say, in columns", () => {
    const rowsOf = (area: (typeof RISK_AREAS)[number], id: string, ops: unknown = OPS, entries: Parameters<typeof risks.areaSignalsFrom>[2] = []) => {
      const view = render(<RiskRegisterAreaView data={{ ...data(area), signals: risks.areaSignalsFrom(area, ops, entries, new Date("2026-11-25T00:00:00.000Z")) }} />);
      const rows = bodyRows(document, `[data-signal="${id}"]`);
      view.unmount();
      return rows;
    };
    expect(rowsOf("financial", "pools")).toEqual([["Liquidity pools", "1 open over_withdrawal flag(s) on real money: list_pool_flags, then resolve_pool_flag"]]);
    expect(rowsOf("third_party", "vendors")).toEqual([["Fast KYC", "2026-11-20 10:00", "Failed"]]);
    // Operations: the line when ops_status has no list behind it, a row per run or app when it has.
    expect(rowsOf("operations", "operations")).toEqual([["Hosting", "1 app(s) stopped", "Not recorded"]]);
    const detailed = {
      ...OPS,
      attention: ["builds: 1 failed in the last 24h", "hosting: 1 app(s) stopped", "sandbox provider: the account's allowance is used up"],
      agents: { builds: { failures: [{ id: "b1", status: "failed", error: "tests failed", created_at: "2026-11-24T08:00:00.000Z" }], stuck: [{ id: "b2", status: "running", created_at: "2026-11-24T06:30:00.000Z" }] } },
      hosting: { failed_tenants: [], stopped_apps: [{ app_id: "saver", error: "", updated_at: "2026-11-23T12:00:00.000Z" }], stuck_deploys: [] },
    };
    expect(rowsOf("operations", "operations", detailed)).toEqual([
      ["Builds", "Run b1 failed: tests failed", "2026-11-24 08:00"],
      ["Builds", "Run b2 still running (running)", "2026-11-24 06:30"],
      ["Hosting", "App saver stopped", "2026-11-23 12:00"],
      ["Sandbox provider", "the account's allowance is used up", "Not recorded"],
    ]);
    // Compliance: apps missing agreements, and overdue audits, each its own table.
    const comp = { ...OPS, apps: { production_without_program_agreements: [{ app_id: "a1", app_name: "Saver", missing: 2 }] }, agreement_audits: { overdue: 3, apps_flagged: 2 } };
    expect(rowsOf("compliance", "agreements", comp)).toEqual([["Saver", "2 signed program agreements missing"]]);
    expect(rowsOf("compliance", "audits", comp)).toEqual([["3", "2"]]);
    // Measured and nothing there: one row saying so in words, never an empty table or a 0.
    expect(rowsOf("compliance", "agreements")).toEqual([["Every production app has its program agreements."]]);
    expect(rowsOf("compliance", "audits")).toEqual([["No oversight audit is overdue."]]);
    // Technology: security events from the audit log, and the backups as one row.
    const entry = { id: "e1", at: "2026-11-20T09:00:00.000Z", action: "reveal_secret", class: "security", actor: { id: USER, name: "Boss", email: null }, target: "app-1" } as unknown as NonNullable<Parameters<typeof risks.areaSignalsFrom>[2]>[number];
    const events = rowsOf("technology", "security", OPS, [entry]);
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveLength(4);
    expect(events[0][3]).toBe("app-1");
    const backups = { last_run_at: "2026-11-24T02:00:00.000Z", ok: true, last_success_at: "2026-11-24T02:00:00.000Z", offsite: "local_only", bytes: 10, local: "x", error: null, last_verify: { at: "2026-11-22T03:00:00.000Z", ok: false, tables: {}, error: "row counts differ" } };
    expect(rowsOf("technology", "backups", { ...OPS, backups })).toEqual([["2026-11-24 02:00", "Succeeded", "On this server only", "2026-11-24 02:00", "Failed: row counts differ"]]);
    expect(rowsOf("technology", "backups")).toEqual([["Not recorded", "Not recorded", "Uploaded off-site", "Not recorded", "Not recorded"]]);
    // A server with no backup status file: not available, with why.
    expect(rowsOf("technology", "backups", { ...OPS, backups: { status: "no status file" } })).toEqual([["Not available. No backup has run on this server: there is no backup status file to read."]]);
    // Drifted products aren't counted across firms: the table says so, under its own headers.
    expect(rowsOf("business_process", "drift")).toEqual([["Not available. Mynt's operations status doesn't count drifted products across firms yet; each app's Security & risk tab shows its own."]]);
  });

  it("what Mynt can't answer is one table row, Not available with why, under the table's headers: never a 0 or an empty table", () => {
    for (const area of RISK_AREAS) {
      const none: Data = {
        area,
        register: { available: false, reason: "Mynt's own risk register comes with Mynt's next update." },
        unassigned: { available: false, reason: "Mynt's own risk register comes with Mynt's next update." },
        cross: { available: false, reason: "Risks across apps and products come with Mynt's next update." },
        signals: risks.areaSignalsFrom(area, null, null),
      };
      const html = renderToStaticMarkup(<RiskRegisterAreaView data={none} />);
      expect(html.match(/Not available\./g)!.length, area).toBe(2 + none.signals.length);
      expect(html).not.toContain("data-add-risk");
      expect(html).not.toMatch(/\(0\)/);
      const view = render(<RiskRegisterAreaView data={none} />);
      // Every section is still a table with its headers, and each has exactly the one row with the reason.
      expect(heads(document, REGISTER)).toEqual(["Risk", "Category", "Likelihood", "Impact", "Score", "Owner", "Status", "Review by", "Mitigation"]);
      expect(bodyRows(document, REGISTER)).toEqual([["Not available. Mynt's own risk register comes with Mynt's next update."]]);
      expect(heads(document, CROSS)).toEqual(["Subject", "Workspace / firm", "Risk", "Score", "Status", "Review by"]);
      expect(bodyRows(document, CROSS)).toEqual([["Not available. Risks across apps and products come with Mynt's next update."]]);
      for (const spec of none.signals) {
        expect(heads(document, `[data-signal="${spec.id}"]`)).toEqual([...spec.columns]);
        expect(bodyRows(document, `[data-signal="${spec.id}"]`), `${area} ${spec.id}`).toEqual([["Not available. This Mynt has no operations status (ops_status) to read."]].map((r) => (spec.id === "security" ? ["Not available. This Mynt has no audit log to read."] : spec.id === "drift" ? ["Not available. Mynt's operations status doesn't count drifted products across firms yet; each app's Security & risk tab shows its own."] : r)));
        expect(document.querySelectorAll(`[data-signal="${spec.id}"] tbody tr[data-not-available] td[colspan="${spec.columns.length}"]`)).toHaveLength(1);
      }
      expect((document.querySelector(`${REGISTER} [data-export]`) as HTMLButtonElement).disabled).toBe(true);
      view.unmount();
    }
    expect(risks.areaSignalsFrom("technology", OPS, null)[0].signal).toMatchObject({ available: false, reason: "This Mynt has no audit log to read." });
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
