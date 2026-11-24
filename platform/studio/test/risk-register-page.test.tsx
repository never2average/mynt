// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { useState } from "react";

// The platform admin's Risk register (/platform/risk-register): seven risk-area tabs; on each, Mynt's own register in
// that area with filter chips (the area's risks, the unassigned ones), Add risk starting on the tab's area and Review
// risk (each a labelled button opening its sheet, posting to /api/admin/risks), the open risks across apps and products
// in that area (read-only, linked), and that area's signals, each a table or "Not available." with why.

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
const data = (area: (typeof RISK_AREAS)[number] = "technology"): Data => ({
  area,
  register: { available: true, canManage: true, overdue: 1, owners: [{ userId: USER, name: "Boss" }], risks: [{ id: R1, title: "Key leak", category: "security", riskArea: "technology", description: null, likelihood: 2, impact: 5, score: 10, owner: null, mitigation: null, status: "open", reviewBy: "2026-01-01", overdue: true }] },
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
  });

  it("filter chips: the area's risks, or the unassigned ones (no area yet)", async () => {
    function Harness() {
      const [filter, setFilter] = useState<"area" | "unassigned">("area");
      return <RiskRegisterAreaView data={data("technology")} filter={filter} onFilter={setFilter} />;
    }
    render(<Harness />);
    const chips = [...document.querySelectorAll("[data-register-filter]")];
    expect(chips.map((c) => c.textContent)).toEqual(["Technology risk (1)", "Unassigned (1)"]);
    expect(chips.map((c) => c.getAttribute("aria-pressed"))).toEqual(["true", "false"]);
    expect(document.body.textContent).toContain("Key leak");
    await click('[data-register-filter="unassigned"]');
    expect(document.body.textContent).toContain("Something else");
    expect(document.body.textContent).not.toContain("Key leak");
    expect(document.body.textContent).toContain("Mynt's own register: unassigned risks");
  });

  it("each area's signals", () => {
    const titles = (area: (typeof RISK_AREAS)[number]) => risks.areaSignalsFrom(area, OPS, []).map((s) => s.title);
    expect(titles("financial")).toEqual(["Liquidity and treasury pools"]);
    expect(titles("compliance")).toEqual(["Agreements"]);
    expect(titles("third_party")).toEqual(["Vendor conformance"]);
    expect(titles("operations")).toEqual(["Agents and hosting"]);
    expect(titles("business_process")).toEqual(["Covenants", "Drifted products"]);
    expect(titles("technology")).toEqual(["Security events in the last 30 days", "Backups"]);
    expect(titles("regulated_product")).toEqual(["Covenants", "Product health", "Drifted products"]);
    const ops = renderToStaticMarkup(<RiskRegisterAreaView data={data("operations")} />);
    expect(ops).toContain("hosting: 1 app(s) stopped");
    expect(ops).not.toContain("liquidity pools:");
    const fin = renderToStaticMarkup(<RiskRegisterAreaView data={data("financial")} />);
    expect(fin).toContain("liquidity pools: 1 open");
    expect(fin).toContain("Rate shock");
    // Measured and nothing there: said in words, never an empty table or a 0.
    const comp = renderToStaticMarkup(<RiskRegisterAreaView data={data("compliance")} />);
    expect(comp).toContain("Every production app has its program agreements, and no oversight audit is overdue.");
  });

  it("what Mynt can't answer is Not available, with why, never a 0 or an empty table", () => {
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
      expect(html).toContain("Unassigned (not available)");
      expect(html).not.toMatch(/\(0\)/);
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
