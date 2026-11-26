// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

// The platform admin's Risk models (/platform/risk-models): seven risk-area tabs, each a list of Mynt's own models in
// that area (status in words, owner, version, last validated, next validation due with "overdue" in words) with a
// labelled Add risk model; a model's page (/platform/risk-models/<id>) has its metadata card with Edit model, Record
// validation and Retire model (each a sheet posting to its route), then Definition, Validations and Versions. Each
// tab is ONE table; the Regulated product risk tab's also holds financial products' own risk models, read-only, with
// a Source column linked to their firm.

vi.mock("next/navigation", () => ({
  usePathname: () => "/platform/risk-models",
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined }),
}));

const { RiskModelsView, RiskModelsAreaView, RiskModelDetailView, AddRiskModelSheet, EditRiskModelSheet, RecordValidationSheet, RetireRiskModelSheet } = await import("@/components/admin-risk-models");
const models = await import("@/lib/risk-models");
type Data = import("@/components/admin-risk-models").RiskModelsData;

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const FIRM = "44444444-4444-4444-8444-444444444444";
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
const heads = (sel: string) => [...document.querySelectorAll(`${sel} thead th`)].map((th) => th.textContent);
const bodyRows = (sel: string) => [...document.querySelectorAll(`${sel} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));

const MYNT_MODEL = {
  id: M1,
  risk_area: "financial",
  status: "active",
  version: 2,
  name: "Pool liquidity coverage",
  purpose: "Whether pools can meet withdrawals",
  method: "Liquid assets over 30-day expected outflows",
  inputs: [{ name: "liquid_assets", source: "pool ledger" }],
  outputs: [{ name: "coverage_ratio", description: "Liquid assets over outflows" }],
  thresholds: [{ name: "minimum", value: 1.5, meaning: "Below it, new commitments pause" }],
  owner: { user_id: USER, name: "Boss" },
  validation: { last_validated_at: "2026-06-01T10:00:00.000Z", validated_by: { user_id: USER, name: "Boss" }, outcome: "passed_with_findings", notes: "Back-tested", next_validation_due: "2026-09-01", overdue: true },
  retired: null,
};
const LIST = models.modelListFrom({
  models: [MYNT_MODEL, { ...MYNT_MODEL, id: M2, name: "Treasury drawdown", status: "draft", version: 1, owner: null, validation: { last_validated_at: null, validated_by: null, outcome: null, notes: null, next_validation_due: null, overdue: false } }],
  counts: { draft: 1, active: 1, retired: 0, overdue: 1 },
})!;
const data = (area: Data["area"] = "financial", productModels: Data["productModels"] = null): Data => ({ area, models: LIST, owners: [{ userId: USER, name: "Boss" }], productModels });
const DETAIL = models.modelDetailFrom({
  model: MYNT_MODEL,
  versions: [
    { version: 1, name: "Pool liquidity coverage", purpose: "p", method: "m", inputs: [], outputs: [], thresholds: [{ name: "minimum", value: 1.2 }], change_note: null, created_by: { user_id: USER, name: "Boss" }, created_at: "2026-01-01T00:00:00.000Z" },
    { version: 2, name: "Pool liquidity coverage", purpose: "p", method: "m", inputs: [], outputs: [], thresholds: [{ name: "minimum", value: 1.5 }], change_note: "Tighter after review", created_by: { user_id: USER, name: "Boss" }, created_at: "2026-03-01T00:00:00.000Z" },
  ],
  validations: [{ id: "v1", version: 1, outcome: "passed_with_findings", notes: "Back-tested on 2025 data", next_validation_due: "2026-09-01", validated_by: { user_id: USER, name: "Boss" }, validated_at: "2026-06-01T10:00:00.000Z" }],
})!;

describe("what Mynt answers, in words", () => {
  it("models: status, owner, last validation and the next due date, overdue in words; retired is never due", () => {
    const [a, b] = LIST.available ? LIST.models : [];
    expect(models.statusWords(a)).toBe("Active: in use");
    expect(models.statusWords(b)).toBe("Draft: not yet in use");
    expect(models.ownerWords(b.owner)).toBe("No owner");
    expect(models.lastValidatedWords(a)).toBe("2026-06-01: Passed with findings");
    expect(models.lastValidatedWords(b)).toBe("Never validated");
    expect(models.dueWords(a)).toBe("2026-09-01 (overdue)");
    expect(models.dueWords(b)).toBe("Not set");
    expect(models.dueWords({ ...a, status: "retired" })).toBe("Not due: retired");
    expect(models.modelListFrom({ nope: true })).toBeNull();
    expect(models.areaFromQuery("technology")).toBe("technology");
    expect(models.areaFromQuery("security")).toBe("financial");
  });

  it("products' own risk models: product, firm, model and type in words, linked to the firm's Products tab", () => {
    const p = models.productModelsFrom({ models: [{ product: { id: "fd", name: "Fixed deposit" }, firm: { id: FIRM, name: "Builder Inc" }, model: { id: "pd", name: "PD scorecard", purpose: "pd_scorecard", version: "3" } }, { product: { id: "ref", name: "Reference" }, firm: null, model: { id: "x", name: null, purpose: null } }] });
    expect(p).toEqual({
      available: true,
      rows: [
        { key: "fd:pd", productId: "fd", productName: "Fixed deposit", firmId: FIRM, firmName: "Builder Inc", modelName: "PD scorecard", type: "Probability of default scorecard", version: "3", href: `/platform/firms/${FIRM}?tab=products` },
        { key: "ref:x", productId: "ref", productName: "Reference", firmId: null, firmName: null, modelName: "x", type: "Not stated", version: null, href: null },
      ],
    });
    expect(models.productModelsFrom(null)).toMatchObject({ available: false });
  });

  it("the sheets' lists are JSON only: a list of objects with a name", () => {
    expect(models.listOf("", "Inputs")).toEqual({ ok: true, value: [] });
    expect(models.listOf('[{"name":"a"}]', "Inputs")).toEqual({ ok: true, value: [{ name: "a" }] });
    expect(models.listOf("name: a", "Inputs")).toEqual({ ok: false, error: "Inputs: that isn't valid JSON." });
    expect(models.listOf('[{"value":1}]', "Thresholds")).toMatchObject({ ok: false });
    expect(models.thresholdsForMynt([{ name: "m", value: "1.5" }, { name: "n", value: "high" }])).toEqual([{ name: "m", value: 1.5 }, { name: "n", value: "high" }]);
  });
});

describe("the list", () => {
  it("seven line tabs in order; a tab click asks for its area", () => {
    const picked: string[] = [];
    render(<RiskModelsView area="financial" onArea={(a) => picked.push(a)} body={null} />);
    expect([...document.querySelectorAll("[data-risk-area-tab]")].map((t) => t.textContent)).toEqual(["Financial risk", "Compliance risk", "Third-party risk", "Operations risk", "Business process risk", "Technology risk", "Regulated product risk"]);
    fireEvent.click(document.querySelector('[data-risk-area-tab="regulated_product"]')!);
    expect(picked).toEqual(["regulated_product"]);
  });

  it("a tab's table: name, status in words, owner, version, last validated, next due with overdue in words; a labelled Add risk model and Open", () => {
    const html = renderToStaticMarkup(<RiskModelsAreaView data={data()} />);
    for (const s of ["Pool liquidity coverage", "Active: in use", "Draft: not yet in use", "Boss", "No owner", "Version 2", "2026-06-01: Passed with findings", "Never validated", "2026-09-01 (overdue)", "1 model is overdue for validation.", "data-add-risk-model", "Add risk model</button>", `data-open-model="${M1}"`, "Open</button>", "Export CSV", "Search financial risk models"]) expect(html).toContain(s);
    // Only the Regulated product risk tab lists products' own models.
    expect(html).not.toContain("data-model-source");
  });

  it("a row opens the model's page; the status filter narrows the table", async () => {
    const opened: string[] = [];
    render(<RiskModelsAreaView data={data()} onOpen={(id) => opened.push(id)} />);
    await click(`[data-open-model="${M2}"]`);
    await click(`[data-row="${M1}"]`);
    expect(opened).toEqual([M2, M1]);
    change('input[aria-label^="Search"]', "treasury");
    expect(document.querySelectorAll("[data-row]")).toHaveLength(1);
  });

  it("every tab is exactly one table under one toolbar, filling the page: no section headings, no second table", () => {
    const rows = models.productModelsFrom({ models: [{ product: { id: "fd", name: "Fixed deposit" }, firm: { id: FIRM, name: "Builder Inc" }, model: { id: "pd", name: "PD scorecard", purpose: "fraud_score" } }] });
    for (const area of ["financial", "compliance", "third_party", "operations", "business_process", "technology", "regulated_product"] as const) {
      const view = render(<RiskModelsView area={area} onArea={() => undefined} body={<RiskModelsAreaView data={data(area, area === "regulated_product" ? rows : null)} />} />);
      expect(document.querySelectorAll("table"), area).toHaveLength(1);
      expect(document.querySelectorAll("[data-toolbar]"), area).toHaveLength(1);
      expect(document.querySelectorAll("[data-pager]"), area).toHaveLength(1);
      expect(document.querySelectorAll("h1, h2, h3, section"), area).toHaveLength(0);
      expect(heads("[data-risk-models-area]"), area).toEqual(area === "regulated_product" ? ["Model", "Source", "Type", "Status", "Owner", "Version", "Last validated", "Next validation due", "Action"] : ["Model", "Status", "Owner", "Version", "Last validated", "Next validation due", "Action"]);
      for (const sel of ["[data-platform-risk-models]", "[data-risk-models-area]", "[data-admin-list]"]) {
        expect(document.querySelector(sel)!.className, `${area} ${sel}`).toContain("min-h-0");
        expect(document.querySelector(sel)!.className, `${area} ${sel}`).toContain("flex-1");
      }
      expect(document.querySelector("[data-table-view]")!.className).toContain("overflow-auto");
      expect([...document.querySelectorAll("[data-toolbar] button")].map((b) => b.textContent!.trim()), area).toEqual(["Filters", "Import", "Export CSV", "Add risk model"]);
      for (const b of document.querySelectorAll("button, a")) expect(b.textContent!.trim(), b.outerHTML).not.toBe("");
      view.unmount();
    }
  });

  it("the Regulated product risk tab's one table also holds products' own risk models, read-only, each with its source linked to its firm", async () => {
    const rows = models.productModelsFrom({
      models: [
        { product: { id: "fd", name: "Fixed deposit" }, firm: { id: FIRM, name: "Builder Inc" }, model: { id: "pd", name: "PD scorecard", purpose: "fraud_score", version: "3" } },
        { product: { id: "ref", name: "Reference loan" }, firm: null, model: { id: "lgd", name: "Loss model", purpose: "lgd" } },
      ],
    });
    const opened: string[] = [];
    render(<RiskModelsAreaView data={data("regulated_product", rows)} onOpen={(id) => opened.push(id)} />);
    expect(document.querySelectorAll("table")).toHaveLength(1);
    expect(bodyRows("[data-risk-models-area]")).toEqual([
      ["Pool liquidity coverage", "Mynt model", "Not stated", "Active: in use", "Boss", "Version 2", "2026-06-01: Passed with findings", "2026-09-01 (overdue)", "Open"],
      ["Treasury drawdown", "Mynt model", "Not stated", "Draft: not yet in use", "No owner", "Version 1", "Never validated", "Not set", "Open"],
      ["PD scorecard", "Product: Fixed deposit (Builder Inc)", "Fraud score", "Declared in the product's definition", "Builder Inc", "3", "Not recorded", "Not recorded", "Open"],
      ["Loss model", "Product: Reference loan (Mynt's reference product)", "Loss given default", "Declared in the product's definition", "Mynt's reference product", "Not stated", "Not recorded", "Not recorded", ""],
    ]);
    expect(document.querySelector("[data-pager]")!.textContent).toContain("4 rows · Page 1 of 1");
    expect([...document.querySelectorAll("[data-risk-models-area] table a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")])).toEqual([
      ["Product: Fixed deposit (Builder Inc)", `/platform/firms/${FIRM}?tab=products`],
      ["Open", `/platform/firms/${FIRM}?tab=products`],
    ]);
    expect(document.querySelector("[data-list-note]")!.textContent).toBe("1 model is overdue for validation. Product models are the ones financial products declare in their own definitions. Read-only: each product's firm keeps them.");
    // A product's row opens no model page: only Mynt's own do.
    await click('[data-row="product:fd:pd"]');
    expect(opened).toEqual([]);
    expect(document.querySelector('[data-row="product:fd:pd"]')!.className).not.toContain("cursor-pointer");
    await click(`[data-row="${M1}"]`);
    expect(opened).toEqual([M1]);
    // Search covers the product and the type; Filters narrow by source and by status.
    const names = () => bodyRows("[data-risk-models-area]").map((r) => r[0]);
    change('input[aria-label^="Search regulated product risk models"]', "loss given");
    expect(names()).toEqual(["Loss model"]);
    change('input[aria-label^="Search regulated product risk models"]', "fixed deposit");
    expect(names()).toEqual(["PD scorecard"]);
    change('input[aria-label^="Search regulated product risk models"]', "nothing like it");
    expect(names()).toEqual(["No models match this search and these filters."]);
    change('input[aria-label^="Search regulated product risk models"]', "");
    await click("[data-filters-menu-button]");
    expect([...document.querySelectorAll("[data-facet-heading]")].map((h) => h.textContent)).toEqual(["Source", "Status"]);
    expect([...document.querySelectorAll('[data-facet="source"] [data-chip]')].map((c) => c.textContent)).toEqual(["Mynt models", "Product models"]);
    await click('[data-facet="source"] [data-chip="product"]');
    expect(names()).toEqual(["PD scorecard", "Loss model"]);
    await click('[data-facet="source"] [data-chip="product"]');
    await click('[data-facet="status"] [data-chip="draft"]');
    expect(names()).toEqual(["Treasury drawdown"]);
  });

  it("what Mynt can't answer is one row in the same table, Not available with why", () => {
    render(<RiskModelsAreaView data={{ ...data("regulated_product", { available: false, reason: "Reading financial products' own risk models comes with Mynt's next update." }), models: { available: false, reason: "Mynt didn't answer with its risk models." } }} />);
    expect(document.querySelectorAll("table")).toHaveLength(1);
    expect(heads("[data-risk-models-area]")).toEqual(["Model", "Source", "Type", "Status", "Owner", "Version", "Last validated", "Next validation due", "Action"]);
    expect(bodyRows("[data-risk-models-area]")).toEqual([
      ["Not available. Mynt didn't answer with its risk models.", "Mynt model", "Not available", "Not available", "Not available", "Not available", "Not available", "Not available", ""],
      ["Not available. Reading financial products' own risk models comes with Mynt's next update.", "Product models", "Not available", "Not available", "Not available", "Not available", "Not available", "Not available", ""],
    ]);
    expect(document.querySelector("[data-add-risk-model]")).toBeNull();
    expect((document.querySelector("[data-export]") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    // Another tab has no Source column; Mynt's models it can't read are still one row with why, never an empty table.
    render(<RiskModelsAreaView data={{ ...data("financial"), models: { available: false, reason: "Mynt didn't answer with its risk models." } }} />);
    expect(bodyRows("[data-risk-models-area]")).toEqual([["Not available. Mynt didn't answer with its risk models.", "Not available", "Not available", "Not available", "Not available", "Not available", ""]]);
  });

  it("what Mynt can't answer is Not available, with why; an empty area says so in words", () => {
    const html = renderToStaticMarkup(<RiskModelsAreaView data={{ ...data(), models: { available: false, reason: "Mynt didn't answer with its risk models." } }} />);
    expect(html).toContain("Not available. Mynt didn&#x27;t answer with its risk models.");
    const empty = renderToStaticMarkup(<RiskModelsAreaView data={{ ...data("technology"), models: { available: true, models: [], counts: { draft: 0, active: 0, retired: 0, overdue: 0 } } }} />);
    expect(empty).toContain("No technology risk models yet. Add the first one.");
    expect(empty).not.toContain("overdue for validation");
  });

  it("Add risk model: starts on the tab's area, sends the definition with its JSON lists to the route", async () => {
    const { f, calls } = fetcher();
    render(<AddRiskModelSheet area="third_party" owners={[{ userId: USER, name: "Boss" }]} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    expect((document.querySelector('[data-model-field="risk_area"]') as HTMLSelectElement).value).toBe("third_party");
    change('[data-model-field="name"]', "Vendor concentration");
    change('[data-model-field="purpose"]', "How much rides on one vendor");
    change('[data-model-field="method"]', "Share of calls per vendor");
    change('[data-model-field="inputs"]', "not json");
    await submit("[data-add-risk-model-form]");
    expect(calls).toEqual([]);
    expect(document.querySelector("[data-sheet-error]")!.textContent).toBe("Inputs: that isn't valid JSON.");
    change('[data-model-field="inputs"]', '[{ "name": "calls", "source": "vendor usage" }]');
    change('[data-model-field="thresholds"]', '[{ "name": "share", "value": "0.4" }]');
    change('[data-model-field="next_validation_due"]', "2099-01-01");
    await submit("[data-add-risk-model-form]");
    expect(calls).toEqual([
      {
        url: "/api/admin/risk-models",
        body: { risk_area: "third_party", name: "Vendor concentration", purpose: "How much rides on one vendor", method: "Share of calls per vendor", inputs: [{ name: "calls", source: "vendor usage" }], outputs: [], thresholds: [{ name: "share", value: 0.4 }], status: "draft", next_validation_due: "2099-01-01" },
      },
    ]);
  });
});

describe("a model's page", () => {
  it("metadata card, the labelled actions, then Definition (method, inputs, outputs, thresholds as tables)", () => {
    const html = renderToStaticMarkup(<RiskModelDetailView data={{ detail: DETAIL, owners: [] }} />);
    for (const s of ["data-metadata-card", "Pool liquidity coverage", "Financial risk", "Active: in use", "Version 2", "2026-09-01 (overdue)", "Edit model", "Record validation", "Retire model", 'data-detail-tab="definition"', 'data-detail-tab="validations"', 'data-detail-tab="versions"', "Liquid assets over 30-day expected outflows", "liquid_assets", "pool ledger", "coverage_ratio", "minimum", "1.5", "Below it, new commitments pause", "Back to financial risk models"]) expect(html).toContain(s);
  });

  it("every tab is tables: Definition's method, inputs, outputs and thresholds, then Validations and Versions, by their column headers", async () => {
    render(<RiskModelDetailView data={{ detail: DETAIL, owners: [] }} />);
    const tables = () => [...document.querySelectorAll("[data-detail-table] table")].map((t) => [...t.querySelectorAll("thead th")].map((th) => th.textContent));
    expect(tables()).toEqual([
      ["Part", "What it says"],
      ["Input", "Description", "Source"],
      ["Output", "Description"],
      ["Threshold", "Value", "What happens"],
    ]);
    expect([...document.querySelectorAll("[data-model-definition] table")[0].querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["Purpose", "Whether pools can meet withdrawals"],
      ["Method", "Liquid assets over 30-day expected outflows"],
    ]);
    // Nothing in the tab but headings and tables.
    expect(document.querySelector("[data-model-definition] p")).toBeNull();
    await click('[data-detail-tab="validations"]');
    expect(tables()).toEqual([["Validated", "Version", "Outcome", "Validated by", "Notes", "Next due"]]);
    await click('[data-detail-tab="versions"]');
    expect(tables()).toEqual([["Version", "Name", "Made", "By", "Why it changed"]]);
  });

  it("Validations and Versions: every one kept, newest version first", async () => {
    render(<RiskModelDetailView data={{ detail: DETAIL, owners: [] }} />);
    await click('[data-detail-tab="validations"]');
    expect(document.querySelector("[data-detail-table]")!.textContent).toContain("Back-tested on 2025 data");
    expect(document.querySelector("[data-detail-table]")!.textContent).toContain("Passed with findings");
    await click('[data-detail-tab="versions"]');
    const rows = [...document.querySelectorAll("[data-detail-table] tbody tr")].map((r) => r.textContent);
    expect(rows[0]).toContain("Version 2 (current)");
    expect(rows[0]).toContain("Tighter after review");
    expect(rows[1]).toContain("First version");
  });

  it("each action opens its sheet and posts its own action to the model's route", async () => {
    const model = DETAIL.model;
    const url = `/api/admin/risk-models/${M1}`;
    let { f, calls } = fetcher();
    render(<EditRiskModelSheet model={model} owners={[]} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    await submit(`[data-edit-risk-model-form="${M1}"]`);
    expect(calls).toEqual([]); // nothing changed: nothing sent
    change('[data-model-field="method"]', "Liquid assets over 45-day outflows");
    change('[data-model-field="note"]', "Longer horizon");
    await submit(`[data-edit-risk-model-form="${M1}"]`);
    expect(calls).toEqual([{ url, body: { action: "edit", method: "Liquid assets over 45-day outflows", note: "Longer horizon" } }]);
    cleanup();

    ({ f, calls } = fetcher());
    render(<RecordValidationSheet model={model} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    change('[data-model-field="outcome"]', "failed");
    change('[data-model-field="notes"]', "Outflows understated");
    change('[data-model-field="next_validation_due"]', "2099-01-01");
    await submit(`[data-record-validation-form="${M1}"]`);
    expect(calls).toEqual([{ url, body: { action: "validate", outcome: "failed", notes: "Outflows understated", next_validation_due: "2099-01-01" } }]);
    cleanup();

    ({ f, calls } = fetcher());
    render(<RetireRiskModelSheet model={model} open onClose={() => undefined} onDone={() => undefined} fetcher={f} />);
    change('[data-model-field="reason"]', "Replaced by the treasury model");
    await submit(`[data-retire-risk-model-form="${M1}"]`);
    expect(calls).toEqual([{ url, body: { action: "retire", reason: "Replaced by the treasury model" } }]);
  });

  it("the detail's buttons open the sheets; a retired model has no actions", async () => {
    render(<RiskModelDetailView data={{ detail: DETAIL, owners: [] }} />);
    await click('[data-model-action="validate"]');
    expect(document.querySelector('[data-admin-sheet="record-validation"]')).not.toBeNull();
    cleanup();
    const retired = { ...DETAIL, model: { ...DETAIL.model, status: "retired" as const, retiredReason: "Replaced" } };
    const html = renderToStaticMarkup(<RiskModelDetailView data={{ detail: retired, owners: [] }} />);
    expect(html).toContain("Retired: no longer used");
    expect(html).toContain("Why it was retired");
    expect(html).toContain("Not due: retired");
    expect(html).not.toContain("data-model-action");
  });
});
