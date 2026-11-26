// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall } from "@/lib/studio-tools";

// Platform settings → Risk grading: ONE table filling the tab under one toolbar. Its rows are the level bands, the
// residual method's steps and the likelihood × impact heat map (25 rows, each its score and its level in words);
// Edit bands, Version history (every version a row, in a sheet) and Restore this version are labelled buttons
// opening sheets; and the route behind them (Mynt admins only, own origin, strict bodies, set_risk_grading).

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  reply: {} as Record<string, unknown>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const { RiskGradingView, gradingRows, changeOf } = await import("@/components/admin-risk-grading");
const grading = await import("@/lib/risk-grading");
const route = await import("@/app/api/admin/risk-grading/route");

beforeAll(() => {
  window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const BANDS = [
  { level: "low", from: 1, to: 4 },
  { level: "medium", from: 5, to: 9 },
  { level: "high", from: 10, to: 14 },
  { level: "critical", from: 15, to: 25 },
];
const DEFAULTS = {
  levels: { low: "Low", medium: "Medium", high: "High", critical: "Critical" },
  inherent_bands: BANDS,
  residual_bands: BANDS,
  residual_method: "reduce",
  reduce: { none: 0, weak: 0.25, partial: 0.5, strong: 0.75 },
  matrix: {
    low: { none: "low", weak: "low", partial: "low", strong: "low" },
    medium: { none: "medium", weak: "medium", partial: "low", strong: "low" },
    high: { none: "high", weak: "high", partial: "medium", strong: "low" },
    critical: { none: "critical", weak: "critical", partial: "high", strong: "medium" },
  },
};
const TIGHT = { ...DEFAULTS, reduce: { none: 0, weak: 0.2, partial: 0.4, strong: 0.8 } };
// get_risk_grading's reply, as Mynt sends it: version 3 in force, restored from 1.
const REPLY = {
  version: 3,
  grading: DEFAULTS,
  method_in_words: "Residual = inherent × (1 − the control's reduction), rounded, never below 1. Reduction: none 0%, weak 25%, partial 50%, strong 75%.",
  history: [
    { version: 3, grading: DEFAULTS, note: "Back to the defaults", restored_from: 1, residuals_changed: 2, created_by: { user_id: "u1", name: "Ada" }, created_at: "2026-11-20T10:00:00.000Z" },
    { version: 2, grading: TIGHT, note: "Partial controls count for less", restored_from: null, residuals_changed: 2, created_by: { user_id: "u1", name: "Ada" }, created_at: "2026-11-10T10:00:00.000Z" },
    { version: 1, grading: DEFAULTS, note: "Mynt's defaults", restored_from: null, residuals_changed: null, created_by: null, created_at: "2026-11-10T10:00:00.000Z" },
  ],
};
const data = (reply: Record<string, unknown> = REPLY) => grading.gradingFrom(reply)!;
const fetcher = () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify({ ok: true, message: "Grading changed: it is version 4 now. 2 residual scores were derived again and moved." }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { f: f as unknown as typeof fetch, calls };
};
const click = async (sel: string) => act(async () => void fireEvent.click(document.querySelector(sel)!));
const submit = (sel: string) => act(async () => void fireEvent.submit(document.querySelector(sel)!));
const change = (sel: string, value: string) => fireEvent.change(document.querySelector(sel)!, { target: { value } });
const cellsOf = (root: string) => [...document.querySelectorAll(`${root} tbody tr`)].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent!.trim()));
const tableHead = () => [...document.querySelectorAll("[data-risk-grading] thead th")].map((th) => th.textContent);
const tableRows = () => cellsOf("[data-risk-grading]");
const historyHead = () => [...document.querySelectorAll("[data-grading-history] thead th")].map((th) => th.textContent);
const historyRows = () => cellsOf("[data-grading-history]");
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (body?: unknown) => new Request("http://studio.test/api/admin/risk-grading", body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.reply = { get_risk_grading: REPLY, set_risk_grading: { version: 4, residuals_changed: 2 } };
});

describe("the tab is one table", () => {
  it("one toolbar and exactly one table filling the page: no cards, no stacked sections; Edit bands and Version history are labelled buttons", () => {
    render(<RiskGradingView data={data()} />);
    const root = document.querySelector("[data-risk-grading]")!;
    expect(root.querySelectorAll("table")).toHaveLength(1);
    expect(root.querySelectorAll("[data-toolbar]")).toHaveLength(1);
    expect(root.querySelectorAll("section, [data-metadata-card], [data-slot=card], h2, h3, form")).toHaveLength(0);
    expect(root.className).toContain("min-h-0");
    expect(root.className).toContain("flex-1");
    expect(root.querySelector("[data-table-view]")!.className).toContain("flex-1");
    expect(root.querySelector("thead")!.className).toContain("sticky");
    expect(root.querySelector("[data-pager]")).not.toBeNull();
    expect(tableHead()).toEqual(["Rule", "Applies to", "Inherent", "Residual", "Level"]);
    expect([...root.querySelectorAll("[data-toolbar] button")].map((b) => b.textContent!.trim())).toEqual(["Filters", "Export CSV", "Version history", "Edit bands"]);
    for (const b of document.querySelectorAll("button")) expect(b.textContent!.trim()).not.toBe("");
    expect(root.querySelector("[data-list-note]")!.textContent).toMatch(/^In force: Version 3\. Inherent score = likelihood × impact; .*Reduce: take a share off the inherent score\. Residual = inherent × \(1 − the control's reduction\).*A risk whose control isn't assessed stands at its inherent score; .*override.* is never derived again\.$/);
    // 4 bands, 4 method steps and the 25 scores: 33 rows, paged 25 at a time.
    expect(root.querySelector("[data-pager]")!.textContent).toContain("33 rows · Page 1 of 2");
  });

  it("the bands and the reduce method are rows: each level's bands, each control step's share with a worked example graded by the residual bands", () => {
    const rows = gradingRows(data());
    expect(rows.filter((r) => r.rule === "band").map((r) => [r.appliesTo, r.inherent, r.residual, r.levelName])).toEqual([
      ["Level 1: Low", "1 to 4", "1 to 4", "Low"],
      ["Level 2: Medium", "5 to 9", "5 to 9", "Medium"],
      ["Level 3: High", "10 to 14", "10 to 14", "High"],
      ["Level 4: Critical", "15 to 25", "15 to 25", "Critical"],
    ]);
    expect(rows.filter((r) => r.rule === "method").map((r) => [r.appliesTo, r.inherent, r.residual, r.levelName])).toEqual([
      ["None control", "0% taken off", "Inherent 20 becomes 20", "Critical"],
      ["Weak control", "25% taken off", "Inherent 20 becomes 15", "Critical"],
      ["Partial control", "50% taken off", "Inherent 20 becomes 10", "High"],
      ["Strong control", "75% taken off", "Inherent 20 becomes 5", "Medium"],
    ]);
    render(<RiskGradingView data={data()} />);
    expect(tableRows().slice(0, 5)).toEqual([
      ["Level band", "Level 1: Low", "1 to 4", "1 to 4", "Low"],
      ["Level band", "Level 2: Medium", "5 to 9", "5 to 9", "Medium"],
      ["Level band", "Level 3: High", "10 to 14", "10 to 14", "High"],
      ["Level band", "Level 4: Critical", "15 to 25", "15 to 25", "Critical"],
      ["Residual method", "None control", "0% taken off", "Inherent 20 becomes 20", "Critical"],
    ]);
  });

  it("the heat map is 25 rows, the likeliest first: likelihood × impact, the score, and the level in words AND colour", () => {
    const scores = gradingRows(data()).filter((r) => r.rule === "score");
    expect(scores).toHaveLength(25);
    expect(scores.slice(0, 5).map((r) => [r.appliesTo, r.inherent, r.levelName])).toEqual([
      ["Likelihood 5: Almost certain × Impact 1: Negligible", "5", "Medium"],
      ["Likelihood 5: Almost certain × Impact 2: Minor", "10", "High"],
      ["Likelihood 5: Almost certain × Impact 3: Moderate", "15", "Critical"],
      ["Likelihood 5: Almost certain × Impact 4: Major", "20", "Critical"],
      ["Likelihood 5: Almost certain × Impact 5: Severe", "25", "Critical"],
    ]);
    expect(scores.at(-1)).toMatchObject({ appliesTo: "Likelihood 1: Rare × Impact 5: Severe", inherent: "5", levelName: "Medium" });
    // Every score from 1×1 to 5×5, each graded by the inherent bands.
    for (const r of scores) expect(r.levelName).toBe(DEFAULTS.levels[BANDS.find((b) => Number(r.inherent) >= b.from && Number(r.inherent) <= b.to)!.level as keyof typeof DEFAULTS.levels]);
    // Coloured by level and labelled: each level's chip has its own colour and always its name.
    render(<RiskGradingView data={data()} />);
    const chips = [...document.querySelectorAll("[data-risk-grading] td [data-level]")];
    expect(chips.length).toBe(25);
    for (const c of chips) {
      expect(c.textContent).toBe(DEFAULTS.levels[c.getAttribute("data-level") as keyof typeof DEFAULTS.levels]);
      expect(c.className).toMatch(/\bbg-/);
    }
    const colour = (level: string) => new Set(chips.filter((c) => c.getAttribute("data-level") === level).map((c) => c.className));
    for (const level of ["low", "medium", "high", "critical"]) expect(colour(level).size, level).toBe(1);
    expect(new Set(["low", "medium", "high", "critical"].map((l) => [...colour(l)][0])).size).toBe(4);
  });

  it("follows the bands and the level names in force", () => {
    const renamed = { ...REPLY, grading: { ...DEFAULTS, levels: { low: "Minor", medium: "Moderate", high: "Major", critical: "Severe" }, inherent_bands: [{ level: "low", from: 1, to: 2 }, { level: "medium", from: 3, to: 6 }, { level: "high", from: 7, to: 12 }, { level: "critical", from: 13, to: 25 }] } };
    const rows = gradingRows(data(renamed));
    const cell = (k: string) => rows.find((r) => r.key === `score-${k}`)!;
    expect(["1x1", "1x2", "1x3", "1x4", "1x5"].map((k) => `${cell(k).inherent} · ${cell(k).levelName}`)).toEqual(["1 · Minor", "2 · Minor", "3 · Moderate", "4 · Moderate", "5 · Moderate"]);
    expect(`${cell("3x4").inherent} · ${cell("3x4").levelName}`).toBe("12 · Major");
    expect(`${cell("5x3").inherent} · ${cell("5x3").levelName}`).toBe("15 · Severe");
    expect(rows[0].appliesTo).toBe("Level 1: Minor");
  });

  it("the matrix method is rows too: the residual level per inherent level and control effectiveness, in words", () => {
    const matrix = data({ ...REPLY, grading: { ...DEFAULTS, residual_method: "matrix" }, method_in_words: "Residual level = the matrix's cell." });
    const rows = gradingRows(matrix).filter((r) => r.rule === "method");
    expect(rows).toHaveLength(16);
    expect(rows.filter((r) => r.inherent === "Critical").map((r) => [r.appliesTo, r.residual])).toEqual([
      ["Critical risk with a none control", "Critical"],
      ["Critical risk with a weak control", "Critical"],
      ["Critical risk with a partial control", "High"],
      ["Critical risk with a strong control", "Medium"],
    ]);
    expect(grading.deriveResidual(matrix.grading, 20, "partial")).toBe(14);
  });

  it("version history is a labelled button opening a sheet: every version a row, newest first, who, when and why, how many residual scores it moved; the one in force can't be restored onto itself", async () => {
    render(<RiskGradingView data={data()} />);
    expect(document.querySelector("[data-grading-history]")).toBeNull();
    await click("[data-grading-history-open]");
    expect(document.querySelectorAll("[data-risk-grading] table")).toHaveLength(1);
    expect(historyHead()).toEqual(["Version", "When", "Who", "Why", "Residual scores moved", "Action"]);
    expect(historyRows()).toEqual([
      ["Version 3 (in force)", "2026-11-20 10:00", "Ada", "Back to the defaults (restored version 1)", "2", "In force"],
      ["Version 2", "2026-11-10 10:00", "Ada", "Partial controls count for less", "2", "Restore this version"],
      // Unmeasured is said, never a 0.
      ["Version 1", "2026-11-10 10:00", "Mynt", "Mynt's defaults", "Not recorded", "Restore this version"],
    ]);
    expect([...document.querySelectorAll("[data-restore-version]")].map((b) => b.getAttribute("data-restore-version"))).toEqual(["2", "1"]);
  });

  it("never changed: Mynt's defaults are in force, and the history says so in words", () => {
    render(<RiskGradingView data={data({ ...REPLY, version: 0, history: [] })} sheet="history" />);
    expect(document.querySelector("[data-list-note]")!.textContent).toMatch(/^In force: Mynt's defaults \(never changed\)\./);
    expect(historyRows()).toEqual([["No versions yet: these are Mynt's defaults. The first change keeps them as version 1."]]);
    expect(grading.gradingFrom({ version: 1 })).toBeNull();
    expect(grading.gradingFrom({ ...REPLY, grading: { ...DEFAULTS, inherent_bands: BANDS.slice(0, 3) } })).toBeNull();
  });
});

describe("Restore this version", () => {
  it("opens its sheet, needs why, and posts the version to restore", async () => {
    const { f, calls } = fetcher();
    let changed = 0;
    render(<RiskGradingView data={data()} fetcher={f} onChanged={() => (changed += 1)} />);
    expect(document.querySelector('[data-admin-sheet="restore-grading"]')).toBeNull();
    // Version history's sheet first, then the version's own labelled button.
    await click("[data-grading-history-open]");
    await click('[data-restore-version="2"]');
    const sheet = document.querySelector('[data-admin-sheet="restore-grading"]')!;
    expect(sheet.textContent).toContain("Restore version 2: “Partial controls count for less”?");
    expect((document.querySelector('[data-grading-submit="restore"]') as HTMLButtonElement).disabled).toBe(true);
    change('[data-grading-field="restore-note"]', "The tighter shares suit this quarter");
    expect((document.querySelector('[data-grading-submit="restore"]') as HTMLButtonElement).disabled).toBe(false);
    await submit('[data-restore-form="2"]');
    expect(calls).toEqual([{ url: "/api/admin/risk-grading", body: { action: "restore", version: 2, note: "The tighter shares suit this quarter" } }]);
    expect(document.querySelector("[data-sheet-result]")!.textContent).toBe("Grading changed: it is version 4 now. 2 residual scores were derived again and moved.");
    // Closing the sheet after a change reloads the section.
    await act(async () => void fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" }));
    expect(changed).toBe(1);
  });

  it("→ the route → set_risk_grading with restore_version", async () => {
    const res = await route.POST(req({ action: "restore", version: 2, note: "The tighter shares suit this quarter" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 4, message: "Version 2 restored: it is version 4 now. 2 residual scores were derived again and moved." });
    expect(fake.calls).toEqual([{ name: "set_risk_grading", args: { restore_version: 2, note: "The tighter shares suit this quarter" } }]);
  });
});

describe("Edit bands", () => {
  it("the bands editor takes each band's end: the bands stay contiguous and cover 1 to 25 by construction; only what changed is sent", async () => {
    const { f, calls } = fetcher();
    render(<RiskGradingView data={data()} fetcher={f} />);
    await click("[data-edit-grading]");
    const value = (name: string) => (document.querySelector(`[data-grading-field="${name}"]`) as HTMLInputElement).value;
    expect(["low", "medium", "high", "critical"].map((l) => [value(`name-${l}`), value(`inherent-${l}`), value(`residual-${l}`)])).toEqual([["Low", "4", "4"], ["Medium", "9", "9"], ["High", "14", "14"], ["Critical", "25", "25"]]);
    expect((document.querySelector('[data-grading-field="inherent-critical"]') as HTMLInputElement).readOnly).toBe(true);
    expect(["none", "weak", "partial", "strong"].map((s) => value(`reduce-${s}`))).toEqual(["0", "25", "50", "75"]);
    // Bands that don't rise are refused here, before anything is sent.
    change('[data-grading-field="inherent-medium"]', "3");
    change('[data-grading-field="note"]', "Stricter on medium");
    await submit("[data-grading-form]");
    expect(calls).toEqual([]);
    expect(document.querySelector("[data-sheet-error]")!.textContent).toMatch(/^Inherent bands: The bands must rise/);
    change('[data-grading-field="inherent-medium"]', "8");
    change('[data-grading-field="name-critical"]', "Severe");
    change('[data-grading-field="reduce-strong"]', "80");
    await submit("[data-grading-form]");
    expect(calls).toEqual([
      {
        url: "/api/admin/risk-grading",
        body: {
          action: "set",
          note: "Stricter on medium",
          levels: { low: "Low", medium: "Medium", high: "High", critical: "Severe" },
          inherent_bands: [{ level: "low", from: 1, to: 4 }, { level: "medium", from: 5, to: 8 }, { level: "high", from: 9, to: 14 }, { level: "critical", from: 15, to: 25 }],
          reduce: { none: 0, weak: 0.25, partial: 0.5, strong: 0.8 },
        },
      },
    ]);
  });

  it("the residual method: reduce's shares or the matrix's cells; nothing changed sends nothing", async () => {
    const { f, calls } = fetcher();
    render(<RiskGradingView data={data()} fetcher={f} sheet="edit" />);
    change('[data-grading-field="note"]', "No change at all");
    await submit("[data-grading-form]");
    expect(calls).toEqual([]);
    expect(document.querySelector("[data-sheet-error]")!.textContent).toBe("Nothing changed yet.");
    change('[data-grading-field="method"]', "matrix");
    expect(document.querySelector("[data-grading-reduce]")).toBeNull();
    expect(document.querySelectorAll("[data-grading-matrix] select")).toHaveLength(16);
    change('[data-grading-field="matrix-critical-strong"]', "low");
    change('[data-grading-field="note"]', "Strong controls take critical to low");
    await submit("[data-grading-form]");
    expect(calls[0].body).toEqual({ action: "set", note: "Strong controls take critical to low", residual_method: "matrix", matrix: { ...DEFAULTS.matrix, critical: { ...DEFAULTS.matrix.critical, strong: "low" } } });
  });

  it("bands from their ends, and what a draft sends", () => {
    expect(grading.bandsOf([4, 9, 14])).toEqual({ ok: true, bands: BANDS });
    expect(grading.boundsOf(data().grading.inherent_bands)).toEqual([4, 9, 14]);
    for (const bad of [[0, 9, 14], [4, 4, 14], [9, 4, 14], [4, 9, 25], [4, 9.5, 14], [4, NaN, 14]]) expect(grading.bandsOf(bad), String(bad)).toMatchObject({ ok: false });
    expect(grading.bandWords({ level: "low", from: 1, to: 1 })).toBe("1");
    const g = data().grading;
    const draft = { names: { ...g.levels }, inherent: ["4", "9", "14"], residual: ["3", "8", "12"], method: "reduce" as const, reduce: { none: "0", weak: "25", partial: "50", strong: "75" }, matrix: g.matrix, note: " Residual graded harder " };
    expect(changeOf(draft, g)).toEqual({ ok: true, change: { action: "set", note: "Residual graded harder", residual_bands: [{ level: "low", from: 1, to: 3 }, { level: "medium", from: 4, to: 8 }, { level: "high", from: 9, to: 12 }, { level: "critical", from: 13, to: 25 }] } });
    expect(changeOf({ ...draft, reduce: { ...draft.reduce, weak: "140" } }, g)).toEqual({ ok: false, error: "Each reduction is a percentage from 0 to 100." });
    expect(changeOf({ ...draft, names: { ...draft.names, high: " " } }, g)).toEqual({ ok: false, error: "Each level needs a name." });
  });

  it("→ the route → set_risk_grading with what changed and why", async () => {
    const body = { action: "set", note: "Stricter on medium", reduce: { none: 0, weak: 0.25, partial: 0.5, strong: 0.8 } };
    const res = await route.POST(req(body));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { message: string }).message).toBe("Grading changed: it is version 4 now. 2 residual scores were derived again and moved.");
    expect(fake.calls).toEqual([{ name: "set_risk_grading", args: { note: "Stricter on medium", reduce: { none: 0, weak: 0.25, partial: 0.5, strong: 0.8 } } }]);
  });
});

describe("the route", () => {
  it("Mynt admins only: anyone else a 404 and nothing sent to Mynt; own origin for writes; strict bodies", async () => {
    const set = { action: "set", note: "A reason", residual_method: "matrix" };
    fake.session = session(["developer", "license_provider"]);
    for (const r of [await route.GET(), await route.POST(req(set))]) expect(r.status).toBe(404);
    expect(fake.calls).toEqual([]);
    fake.session = undefined;
    expect((await route.GET()).status).toBe(401);
    fake.session = session(["admin"]);
    fake.sameOrigin = false;
    expect((await route.POST(req(set))).status).toBe(403);
    fake.sameOrigin = true;
    for (const bad of [{}, { action: "set", residual_method: "matrix" }, { ...set, note: "" }, { ...set, residual_method: "average" }, { ...set, restore_version: 1 }, { action: "restore", version: 0, note: "A reason" }, { action: "restore", version: 2 }, { ...set, inherent_bands: BANDS.slice(0, 3) }, { ...set, reduce: { none: 0, weak: 2, partial: 0.5, strong: 0.75 } }, { ...set, extra: true }])
      expect((await route.POST(req(bad))).status, JSON.stringify(bad)).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("GET reads the grading in force and its versions; an older Mynt without it says so", async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { grading: { version: number; history: unknown[]; heatMap: unknown[] } };
    expect(body.grading.version).toBe(3);
    expect(body.grading.history).toHaveLength(3);
    expect(body.grading.heatMap).toHaveLength(5);
    expect(fake.calls).toEqual([{ name: "get_risk_grading", args: {} }]);
    fake.tools = [{ name: "ops_status" }];
    expect(await (await route.GET()).json()).toEqual({ supported: false });
    expect((await route.POST(req({ action: "set", note: "A reason", residual_method: "matrix" }))).status).toBe(422);
    fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
    fake.reply.get_risk_grading = { nothing: true };
    expect((await route.GET()).status).toBe(502);
  });

  it("the allow-list keeps set_risk_grading strict", () => {
    expect(parseAdminCall("get_risk_grading", {})).toHaveProperty("tool");
    expect(parseAdminCall("get_risk_grading", { version: 1 })).toHaveProperty("error");
    expect(parseAdminCall("set_risk_grading", { note: "A reason", restore_version: 2 })).toHaveProperty("tool");
    expect(parseAdminCall("set_risk_grading", { restore_version: 2 })).toHaveProperty("error");
    expect(parseAdminCall("set_risk_grading", { note: "A reason", levels: { low: "Low", medium: "Medium", high: "High" } })).toHaveProperty("error");
    expect(parseAdminCall("set_risk_grading", { note: "A reason", matrix: { ...DEFAULTS.matrix, low: { none: "low", weak: "low", partial: "low", strong: "none" } } })).toHaveProperty("error");
    expect(renderToStaticMarkup(<RiskGradingView data={data()} />)).toContain("Likelihood × impact");
  });
});
