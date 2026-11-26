import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { CONTROL_STEPS, RISK_LEVEL_KEYS } from "./risk-register-schema.js";
import { effectiveRoles, type Store, type User } from "./store.js";

// How the platform grades every risk on every register (apps', products' and Mynt's own), in three steps:
//
// 1. Inherent score = likelihood × impact (1-5 each, so 1-25), graded into a level by the inherent bands.
// 2. Control effectiveness, in four steps: none, weak, partial, strong (not assessed until someone says).
// 3. Residual score, derived from the two by the residual method and graded into a level by the residual bands:
//    - "reduce": residual = inherent × (1 − the step's reduction), rounded to the nearest whole number, never below 1
//      (defaults: none 0, weak 0.25, partial 0.5, strong 0.75);
//    - "matrix": the inherent level and the step pick a residual level from a table; the residual score is the top
//      of that level's residual band, or the inherent score when that is lower. A control never raises a level.
//    A risk whose control isn't assessed has no derived residual: it stands at its inherent score, and says so. A
//    keeper may set the residual likelihood and impact themselves instead (an override, with who, when and why); the
//    grading never re-derives an overridden risk.
//
// The grading is one platform setting (risk_grading), versioned: every change is a new version, every version is kept,
// and restoring an old one adds a new version with its content. Only Mynt's admins read and change it. A change
// re-derives every residual score that isn't overridden, and the audit trail says how many moved.

const T = "financial_products";
const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

export type RiskLevelKey = (typeof RISK_LEVEL_KEYS)[number];
export type ControlStep = (typeof CONTROL_STEPS)[number];
export type Band = { level: RiskLevelKey; from: number; to: number };
export interface RiskGrading {
  levels: Record<RiskLevelKey, string>;
  inherent_bands: Band[];
  residual_bands: Band[];
  residual_method: "reduce" | "matrix";
  reduce: Record<ControlStep, number>;
  matrix: Record<RiskLevelKey, Record<ControlStep, RiskLevelKey>>;
}

export const RISK_GRADING_SETTING = "risk_grading";
export const MAX_SCORE = 25;
const DEFAULT_BANDS: Band[] = [
  { level: "low", from: 1, to: 4 },
  { level: "medium", from: 5, to: 9 },
  { level: "high", from: 10, to: 14 },
  { level: "critical", from: 15, to: 25 },
];
export const DEFAULT_RISK_GRADING: RiskGrading = {
  levels: { low: "Low", medium: "Medium", high: "High", critical: "Critical" },
  inherent_bands: DEFAULT_BANDS,
  residual_bands: DEFAULT_BANDS,
  residual_method: "reduce",
  reduce: { none: 0, weak: 0.25, partial: 0.5, strong: 0.75 },
  // No control and a weak one leave the level where it is; a partial one takes it one level down, a strong one two.
  matrix: {
    low: { none: "low", weak: "low", partial: "low", strong: "low" },
    medium: { none: "medium", weak: "medium", partial: "low", strong: "low" },
    high: { none: "high", weak: "high", partial: "medium", strong: "low" },
    critical: { none: "critical", weak: "critical", partial: "high", strong: "medium" },
  },
};
export const CONTROL_STEP_WORDS: Record<ControlStep, string> = { none: "None", weak: "Weak", partial: "Partial", strong: "Strong" };
export const NOT_ASSESSED = "Not assessed";

const LEVEL = z.enum(RISK_LEVEL_KEYS);
const BAND = z.object({ level: LEVEL, from: z.number().int().min(1).max(MAX_SCORE), to: z.number().int().min(1).max(MAX_SCORE) }).strict();
const BANDS = z.array(BAND).length(RISK_LEVEL_KEYS.length);
const perStep = <S extends z.ZodTypeAny>(s: S) => z.object({ none: s, weak: s, partial: s, strong: s }).strict();
const perLevel = <S extends z.ZodTypeAny>(s: S) => z.object({ low: s, medium: s, high: s, critical: s }).strict();
export const GRADING_SHAPE = {
  levels: perLevel(z.string().trim().min(1).max(40)).describe("Each level's name, as registers show it"),
  inherent_bands: BANDS.describe("The inherent score's bands, lowest level first: together they cover 1-25 with no gap or overlap"),
  residual_bands: BANDS.describe("The residual score's bands, the same way"),
  residual_method: z.enum(["reduce", "matrix"]),
  reduce: perStep(z.number().min(0).max(1)).describe("reduce: the share of the inherent score each control step takes away (0-1)"),
  matrix: perLevel(perStep(LEVEL)).describe("matrix: the residual level for each inherent level and control step"),
};
const GRADING = z.object(GRADING_SHAPE).strict();

/** Why a grading can't be used, in words; null when it can. */
export function gradingProblem(g: RiskGrading): string | null {
  for (const [what, bands] of [["inherent", g.inherent_bands], ["residual", g.residual_bands]] as const) {
    if (bands.length !== RISK_LEVEL_KEYS.length || bands.some((b, i) => b.level !== RISK_LEVEL_KEYS[i])) return `The ${what} bands must be the four levels in order: ${RISK_LEVEL_KEYS.join(", ")}`;
    if (bands[0].from !== 1) return `The ${what} bands must start at 1`;
    if (bands[bands.length - 1].to !== MAX_SCORE) return `The ${what} bands must end at ${MAX_SCORE}`;
    for (let i = 0; i < bands.length; i++) {
      if (bands[i].from > bands[i].to) return `The ${what} band for ${bands[i].level} starts after it ends`;
      if (i > 0 && bands[i].from !== bands[i - 1].to + 1) return `The ${what} bands must be contiguous: ${bands[i].level} must start at ${bands[i - 1].to + 1}, right after ${bands[i - 1].level} ends`;
    }
  }
  const names = RISK_LEVEL_KEYS.map((k) => g.levels[k].toLowerCase());
  if (new Set(names).size !== names.length) return "Each level needs its own name";
  const order = (l: RiskLevelKey) => RISK_LEVEL_KEYS.indexOf(l);
  for (let i = 1; i < CONTROL_STEPS.length; i++) if (g.reduce[CONTROL_STEPS[i]] < g.reduce[CONTROL_STEPS[i - 1]]) return `A ${CONTROL_STEPS[i]} control can't reduce less than a ${CONTROL_STEPS[i - 1]} one`;
  for (const level of RISK_LEVEL_KEYS)
    for (let i = 0; i < CONTROL_STEPS.length; i++) {
      const cell = g.matrix[level][CONTROL_STEPS[i]];
      if (order(cell) > order(level)) return `A control never raises a risk: the matrix puts ${level} with a ${CONTROL_STEPS[i]} control at ${cell}`;
      if (i > 0 && order(cell) > order(g.matrix[level][CONTROL_STEPS[i - 1]])) return `In the matrix, a ${CONTROL_STEPS[i]} control can't leave ${level} higher than a ${CONTROL_STEPS[i - 1]} one does`;
    }
  return null;
}

/** The level a score falls in. */
export function levelOf(bands: Band[], score: number): RiskLevelKey {
  return (bands.find((b) => score >= b.from && score <= b.to) ?? bands[bands.length - 1]).level;
}

/** The residual score the grading derives from an inherent score and a control step. */
export function deriveResidual(g: RiskGrading, inherent: number, step: ControlStep): number {
  if (g.residual_method === "reduce") return Math.max(1, Math.round(inherent * (1 - g.reduce[step])));
  const target = g.matrix[levelOf(g.inherent_bands, inherent)][step];
  return Math.min(inherent, g.residual_bands.find((b) => b.level === target)!.to);
}

/** The residual method, as a sentence. */
export function methodWords(g: RiskGrading): string {
  return g.residual_method === "reduce"
    ? `Residual = inherent × (1 − the control's reduction), rounded, never below 1. Reduction: ${CONTROL_STEPS.map((s) => `${CONTROL_STEP_WORDS[s].toLowerCase()} ${Math.round(g.reduce[s] * 100)}%`).join(", ")}.`
    : "Residual level = the matrix's cell for the inherent level and the control's effectiveness; the residual score is the top of that level's residual band, or the inherent score when that is lower.";
}

/** The grading in force: the setting, or the defaults when it was never changed (or can't be read as one). */
export async function loadRiskGrading(store: Pick<Store, "getSetting">): Promise<{ grading: RiskGrading; version: number }> {
  const stored = await store.getSetting<{ version?: number; grading?: unknown }>(RISK_GRADING_SETTING);
  const parsed = stored ? GRADING.safeParse(stored.grading) : null;
  if (parsed?.success && !gradingProblem(parsed.data)) return { grading: parsed.data, version: Number(stored!.version ?? 1) };
  return { grading: DEFAULT_RISK_GRADING, version: 0 };
}

/** Re-derives every residual score that isn't overridden and whose control is assessed; returns the risks that moved. */
export async function rederiveResiduals(db: Db, g: RiskGrading): Promise<{ id: string; from: number | null; to: number }[]> {
  const { rows } = await db.query(
    `SELECT id, likelihood, impact, control_effectiveness, residual_score FROM ${T}.risk_register WHERE control_effectiveness IS NOT NULL AND residual_likelihood IS NULL ORDER BY created_at`,
  );
  const moved: { id: string; from: number | null; to: number }[] = [];
  for (const r of rows) {
    const to = deriveResidual(g, Number(r.likelihood) * Number(r.impact), r.control_effectiveness as ControlStep);
    const from = r.residual_score == null ? null : Number(r.residual_score);
    if (from === to) continue;
    await db.query(`UPDATE ${T}.risk_register SET residual_score = $2 WHERE id = $1`, [r.id, to]);
    moved.push({ id: r.id as string, from, to });
  }
  return moved;
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

export function registerRiskGradingTools(server: McpServer, store: Store, user: User) {
  const isAdmin = async () => {
    const u = await store.getUser(user.id);
    return Boolean(u && effectiveRoles(u.roles).includes("admin"));
  };
  const NOT_ADMIN = "Only Mynt's admins read and change the platform's risk grading";
  const versions = async () =>
    (await store.db.query(`SELECT v.*, u.name AS author FROM ${T}.risk_grading_versions v LEFT JOIN ${T}.users u ON u.id = v.created_by ORDER BY v.version DESC`)).rows.map((v) => ({
      version: Number(v.version),
      grading: v.grading as RiskGrading,
      note: (v.note as string | null) ?? null,
      restored_from: v.restored_from == null ? null : Number(v.restored_from),
      residuals_changed: v.residuals_changed == null ? null : Number(v.residuals_changed),
      created_by: v.created_by ? { user_id: v.created_by as string, name: (v.author as string | null) ?? null } : null,
      created_at: iso(v.created_at),
    }));
  // The 5×5 grid, the likeliest row first, each cell with its score and inherent level.
  const heatMap = (g: RiskGrading) =>
    [5, 4, 3, 2, 1].map((likelihood) => ({
      likelihood,
      cells: [1, 2, 3, 4, 5].map((impact) => {
        const level = levelOf(g.inherent_bands, likelihood * impact);
        return { impact, score: likelihood * impact, level, level_name: g.levels[level] };
      }),
    }));

  server.registerTool(
    "get_risk_grading",
    {
      title: "The platform's risk grading",
      description:
        "Admin: how Mynt grades every risk on every register. Each level's name (low, medium, high, critical), the score bands of the inherent score (likelihood × impact, 1-25) and of the residual score, the control steps (none, weak, partial, strong), and the residual method: reduce (residual = inherent × (1 − the step's reduction), rounded, never below 1) or matrix (inherent level × control step → residual level; the score is the top of that level's residual band, or the inherent score when lower). With it: the method in words, the 5×5 likelihood × impact grid with each cell's score and level, the version in force (0: Mynt's defaults, never changed), the defaults, and every version kept (newest first: who, when, why, which version it restored, how many residual scores it moved).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const { grading, version } = await loadRiskGrading(store);
      return json({ version, grading, method_in_words: methodWords(grading), control_steps: CONTROL_STEPS, heat_map: heatMap(grading), defaults: DEFAULT_RISK_GRADING, history: await versions() });
    },
  );

  server.registerTool(
    "set_risk_grading",
    {
      title: "Change the platform's risk grading",
      description:
        "Admin: change how Mynt grades risks, saying why (note). Pass what changes of: levels (each level's name), inherent_bands and residual_bands (the four levels in order, each { level, from, to }: together they must cover 1-25 with no gap or overlap), residual_method (reduce or matrix), reduce (each control step's reduction, 0-1, never smaller for a stronger step) and matrix (the residual level per inherent level and control step: a control never raises a level); the rest carries over. Or restore_version: bring back a kept version's content. Either way it becomes a new version (the old ones stay), every residual score that isn't overridden and whose control is assessed is derived again, and the audit trail records how many moved (each moved risk's history shows it too).",
      inputSchema: {
        levels: GRADING_SHAPE.levels.optional(),
        inherent_bands: GRADING_SHAPE.inherent_bands.optional(),
        residual_bands: GRADING_SHAPE.residual_bands.optional(),
        residual_method: GRADING_SHAPE.residual_method.optional(),
        reduce: GRADING_SHAPE.reduce.optional(),
        matrix: GRADING_SHAPE.matrix.optional(),
        restore_version: z.number().int().min(1).optional().describe("A kept version to bring back, instead of the fields above"),
        note: z.string().trim().min(3).max(2000).describe("Why the grading changes"),
      },
    },
    async ({ restore_version, note, ...fields }) => {
      if (!(await isAdmin())) return fail(NOT_ADMIN);
      const current = await loadRiskGrading(store);
      const passed = Object.entries(fields).filter(([, v]) => v !== undefined);
      if (restore_version !== undefined && passed.length) return fail("Pass restore_version or the fields to change, not both");
      let next: RiskGrading;
      if (restore_version !== undefined) {
        const row = (await store.db.query(`SELECT grading FROM ${T}.risk_grading_versions WHERE version = $1`, [restore_version])).rows[0];
        const kept = row ? GRADING.safeParse(row.grading) : null;
        if (!kept?.success) return fail(`No risk grading version ${restore_version} to restore`);
        next = kept.data;
      } else {
        if (!passed.length) return fail("Nothing to change: pass what's different, or restore_version");
        next = { ...current.grading, ...(Object.fromEntries(passed) as Partial<RiskGrading>) };
      }
      const problem = gradingProblem(next);
      if (problem) return fail(problem);
      if (JSON.stringify(next) === JSON.stringify(current.grading)) return fail("Nothing to change: that is the grading in force");
      // The first change keeps what was in force before it (Mynt's defaults) as version 1, so it can be restored.
      let last = Number((await store.db.query(`SELECT coalesce(max(version), 0)::int AS n FROM ${T}.risk_grading_versions`)).rows[0]?.n ?? 0);
      if (last === 0) {
        await store.db.query(`INSERT INTO ${T}.risk_grading_versions (version, grading, note) VALUES (1, $1::jsonb, $2)`, [JSON.stringify(current.grading), "Mynt's defaults"]);
        last = 1;
      }
      const version = last + 1;
      const moved = await rederiveResiduals(store.db, next);
      await store.db.query(`INSERT INTO ${T}.risk_grading_versions (version, grading, note, restored_from, residuals_changed, created_by) VALUES ($1, $2::jsonb, $3, $4, $5, $6)`, [
        version,
        JSON.stringify(next),
        note,
        restore_version ?? null,
        moved.length,
        user.id,
      ]);
      await store.setSetting(RISK_GRADING_SETTING, { version, grading: next }, user.id);
      const changed = (Object.keys(next) as (keyof RiskGrading)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(current.grading[k]));
      await store.audit(user.id, "set_risk_grading", RISK_GRADING_SETTING, { platform: true, version, from_version: current.version, restored_from: restore_version ?? null, changed, residual_method: next.residual_method, residuals_changed: moved.length, note });
      for (const m of moved)
        await store.audit(user.id, "rederive_risk_residual", m.id, { platform: true, grading_version: version, what: `Residual score derived again under risk grading version ${version}`, residual: { from: m.from, to: m.to } });
      return json({ version, grading: next, method_in_words: methodWords(next), changed, residuals_changed: moved.length, restored_from: restore_version ?? null });
    },
  );
}
