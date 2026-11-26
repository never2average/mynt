// The platform's risk grading (Platform settings → Risk grading; Mynt's get_risk_grading and set_risk_grading): how
// every risk on every register is graded. Four levels with their names; the score bands of the inherent score
// (likelihood × impact, 1-25) and of the residual score; and the residual method: "reduce" (residual = inherent ×
// (1 − the control step's reduction)) or "matrix" (inherent level × control step → residual level). Versioned: every
// change is a new version, and an old one can be restored (as a new version). Mynt's admins only. Pure: the route
// reads Mynt's reply into these shapes, and the view, its sheets and the tests share them.

import { CONTROL_STEP_LABELS, CONTROL_STEPS, isControlStep, isLevel, RISK_LEVELS_ASC, type ControlStep, type RiskLevelKey } from "./risk-register"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export const MAX_SCORE = 25
export type Band = { level: RiskLevelKey; from: number; to: number }
// As Mynt sends and takes it.
export type Grading = {
  levels: Record<RiskLevelKey, string>
  inherent_bands: Band[]
  residual_bands: Band[]
  residual_method: "reduce" | "matrix"
  reduce: Record<ControlStep, number>
  matrix: Record<RiskLevelKey, Record<ControlStep, RiskLevelKey>>
}
export type HeatCell = { impact: number; score: number; level: RiskLevelKey; levelName: string }
export type HeatRow = { likelihood: number; cells: HeatCell[] }
export type GradingVersion = { version: number; note: string | null; restoredFrom: number | null; residualsChanged: number | null; by: string | null; at: string | null; grading: Grading | null }
export type GradingData = { version: number; grading: Grading; methodWords: string; heatMap: HeatRow[]; history: GradingVersion[] }

const bandsFrom = (v: unknown): Band[] | null => {
  if (!Array.isArray(v) || v.length !== RISK_LEVELS_ASC.length) return null
  const out = v.filter(isObj).flatMap((b): Band[] => (isLevel(b.level) && num(b.from) !== null && num(b.to) !== null ? [{ level: b.level, from: num(b.from)!, to: num(b.to)! }] : []))
  return out.length === RISK_LEVELS_ASC.length ? out : null
}
export function gradingOf(v: unknown): Grading | null {
  if (!isObj(v) || !isObj(v.levels) || !isObj(v.reduce) || !isObj(v.matrix)) return null
  const inherent = bandsFrom(v.inherent_bands)
  const residual = bandsFrom(v.residual_bands)
  if (!inherent || !residual || (v.residual_method !== "reduce" && v.residual_method !== "matrix")) return null
  const levels = {} as Grading["levels"]
  const matrix = {} as Grading["matrix"]
  const reduce = {} as Grading["reduce"]
  for (const l of RISK_LEVELS_ASC) {
    const name = str((v.levels as Obj)[l])
    const row = (v.matrix as Obj)[l]
    if (!name || !isObj(row)) return null
    levels[l] = name
    matrix[l] = {} as Record<ControlStep, RiskLevelKey>
    for (const s of CONTROL_STEPS) {
      if (!isLevel(row[s])) return null
      matrix[l][s] = row[s] as RiskLevelKey
    }
  }
  for (const s of CONTROL_STEPS) {
    const share = num((v.reduce as Obj)[s])
    if (share === null) return null
    reduce[s] = share
  }
  return { levels, inherent_bands: inherent, residual_bands: residual, residual_method: v.residual_method, reduce, matrix }
}

/** The level a score falls in. */
export const levelOf = (bands: Band[], score: number): RiskLevelKey => (bands.find((b) => score >= b.from && score <= b.to) ?? bands[bands.length - 1]).level
/** The 5×5 likelihood × impact grid, the likeliest row first: each cell's score and its inherent level. */
export const heatMapOf = (g: Grading): HeatRow[] =>
  [5, 4, 3, 2, 1].map((likelihood) => ({
    likelihood,
    cells: [1, 2, 3, 4, 5].map((impact) => {
      const level = levelOf(g.inherent_bands, likelihood * impact)
      return { impact, score: likelihood * impact, level, levelName: g.levels[level] }
    }),
  }))
/** The residual score the grading derives, as Mynt does (core/src/risk-grading.ts): for the method table's example. */
export function deriveResidual(g: Grading, inherent: number, step: ControlStep): number {
  if (g.residual_method === "reduce") return Math.max(1, Math.round(inherent * (1 - g.reduce[step])))
  const target = g.matrix[levelOf(g.inherent_bands, inherent)][step]
  return Math.min(inherent, g.residual_bands.find((b) => b.level === target)!.to)
}

/** get_risk_grading's reply, or null when it isn't one. */
export function gradingFrom(reply: unknown): GradingData | null {
  if (!isObj(reply)) return null
  const grading = gradingOf(reply.grading)
  if (!grading) return null
  const history = (Array.isArray(reply.history) ? reply.history : []).filter(isObj).flatMap((v): GradingVersion[] => {
    const version = num(v.version)
    if (version === null) return []
    const by = isObj(v.created_by) ? (str(v.created_by.name) ?? "Unnamed admin") : null
    return [{ version, note: str(v.note), restoredFrom: num(v.restored_from), residualsChanged: num(v.residuals_changed), by, at: str(v.created_at), grading: gradingOf(v.grading) }]
  })
  return { version: num(reply.version) ?? 0, grading, methodWords: str(reply.method_in_words) ?? "", heatMap: heatMapOf(grading), history }
}

// ---- words ----

export const bandWords = (b: Band) => (b.from === b.to ? `${b.from}` : `${b.from} to ${b.to}`)
export const percentWords = (share: number) => `${Math.round(share * 100)}%`
export const METHOD_LABELS: Record<Grading["residual_method"], string> = { reduce: "Reduce: take a share off the inherent score", matrix: "Matrix: inherent level and control effectiveness pick the residual level" }
export const versionWords = (v: number) => (v === 0 ? "Mynt's defaults (never changed)" : `Version ${v}`)
export const stepWords = (s: ControlStep) => CONTROL_STEP_LABELS[s]
export const isStep = isControlStep

// ---- the editor: three upper bounds make four contiguous bands covering 1-25 ----

/** The top of the low, medium and high bands (critical always ends at 25). */
export const boundsOf = (bands: Band[]): [number, number, number] => [bands[0].to, bands[1].to, bands[2].to]
/** Bands from their three upper bounds; null with why when they don't rise or don't leave room for each level. */
export function bandsOf(bounds: number[]): { ok: true; bands: Band[] } | { ok: false; error: string } {
  const [a, b, c] = bounds
  if (![a, b, c].every((n) => Number.isInteger(n))) return { ok: false, error: "Each band ends at a whole number." }
  if (!(a >= 1 && a < b && b < c && c < MAX_SCORE)) return { ok: false, error: `The bands must rise: low ends at 1 or more, medium after low, high after medium, and high before ${MAX_SCORE} so critical has room.` }
  return {
    ok: true,
    bands: [
      { level: "low", from: 1, to: a },
      { level: "medium", from: a + 1, to: b },
      { level: "high", from: b + 1, to: c },
      { level: "critical", from: c + 1, to: MAX_SCORE },
    ],
  }
}

/** What the Risk grading section's sheets send. */
export type GradingChange = ({ action: "set"; note: string } & Partial<Grading>) | { action: "restore"; version: number; note: string }
