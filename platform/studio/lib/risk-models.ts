// The platform admin's Risk models (/platform/risk-models): Mynt's own risk models, one risk area per tab
// (list_risk_models), each opened at /platform/risk-models/<id> with its definition, validations and versions, and
// the risk models financial products declare in their own definitions (admin_list_product_risk_models), read-only on
// the Regulated product risk tab. Status is always in words; whatever Mynt can't answer says so with why, never 0 or
// an empty table. Pure: the routes read Mynt's replies into these shapes, and the views, sheets and tests share them.

import { adminHref } from "./admin"
import { isRiskArea, RISK_AREAS, type RiskArea, type Unavailable } from "./risk-register"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

export const MODEL_STATUSES = ["draft", "active", "retired"] as const
export type ModelStatus = (typeof MODEL_STATUSES)[number]
export const MODEL_STATUS_LABELS: Record<ModelStatus, string> = { draft: "Draft: not yet in use", active: "Active: in use", retired: "Retired: no longer used" }
export const MODEL_OUTCOMES = ["passed", "passed_with_findings", "failed"] as const
export type ModelOutcome = (typeof MODEL_OUTCOMES)[number]
export const MODEL_OUTCOME_LABELS: Record<ModelOutcome, string> = { passed: "Passed", passed_with_findings: "Passed with findings", failed: "Failed" }
const isStatus = (v: unknown): v is ModelStatus => typeof v === "string" && (MODEL_STATUSES as readonly string[]).includes(v)
const isOutcome = (v: unknown): v is ModelOutcome => typeof v === "string" && (MODEL_OUTCOMES as readonly string[]).includes(v)

export type ModelInput = { name: string; description: string | null; source: string | null }
export type ModelOutput = { name: string; description: string | null }
export type ModelThreshold = { name: string; value: string; meaning: string | null }
export type Person = { userId: string; name: string | null }

export type RiskModel = {
  id: string
  riskArea: RiskArea
  status: ModelStatus
  version: number
  name: string
  purpose: string
  method: string
  inputs: ModelInput[]
  outputs: ModelOutput[]
  thresholds: ModelThreshold[]
  owner: Person | null
  lastValidatedAt: string | null
  validatedBy: Person | null
  outcome: ModelOutcome | null
  validationNotes: string | null
  nextValidationDue: string | null
  overdue: boolean
  retiredReason: string | null
}
export type ModelVersion = { version: number; name: string; purpose: string; method: string; inputs: ModelInput[]; outputs: ModelOutput[]; thresholds: ModelThreshold[]; changeNote: string | null; createdBy: Person | null; createdAt: string | null }
export type ModelValidation = { id: string; version: number; outcome: ModelOutcome; notes: string; nextValidationDue: string | null; validatedBy: Person | null; validatedAt: string | null }
export type ModelDetail = { model: RiskModel; versions: ModelVersion[]; validations: ModelValidation[] }

const person = (v: unknown): Person | null => (isObj(v) && str(v.user_id) ? { userId: str(v.user_id)!, name: str(v.name) } : null)
const inputsOf = (v: unknown): ModelInput[] => arr(v).filter(isObj).flatMap((x) => (str(x.name) ? [{ name: str(x.name)!, description: str(x.description), source: str(x.source) }] : []))
const outputsOf = (v: unknown): ModelOutput[] => arr(v).filter(isObj).flatMap((x) => (str(x.name) ? [{ name: str(x.name)!, description: str(x.description) }] : []))
const thresholdsOf = (v: unknown): ModelThreshold[] =>
  arr(v)
    .filter(isObj)
    .flatMap((x) => (str(x.name) && (num(x.value) !== null || str(x.value)) ? [{ name: str(x.name)!, value: num(x.value) !== null ? String(x.value) : str(x.value)!, meaning: str(x.meaning) }] : []))

export function modelFrom(v: unknown): RiskModel | null {
  if (!isObj(v)) return null
  const id = str(v.id)
  const name = str(v.name)
  if (!id || !name || !isRiskArea(v.risk_area) || !isStatus(v.status)) return null
  const val = isObj(v.validation) ? v.validation : {}
  const retired = isObj(v.retired) ? v.retired : null
  return {
    id,
    riskArea: v.risk_area,
    status: v.status,
    version: num(v.version) ?? 1,
    name,
    purpose: str(v.purpose) ?? "",
    method: str(v.method) ?? "",
    inputs: inputsOf(v.inputs),
    outputs: outputsOf(v.outputs),
    thresholds: thresholdsOf(v.thresholds),
    owner: person(v.owner),
    lastValidatedAt: str(val.last_validated_at),
    validatedBy: person(val.validated_by),
    outcome: isOutcome(val.outcome) ? val.outcome : null,
    validationNotes: str(val.notes),
    nextValidationDue: str(val.next_validation_due),
    overdue: val.overdue === true,
    retiredReason: retired ? str(retired.reason) : null,
  }
}

export type ModelCounts = { draft: number; active: number; retired: number; overdue: number }
export type ModelList = { available: true; models: RiskModel[]; counts: ModelCounts } | Unavailable

/** list_risk_models' reply (one area's), or null when it isn't one. */
export function modelListFrom(reply: unknown): ModelList | null {
  if (!isObj(reply) || !Array.isArray(reply.models)) return null
  const models = reply.models.map(modelFrom).filter((m): m is RiskModel => m !== null)
  const c = isObj(reply.counts) ? reply.counts : {}
  return {
    available: true,
    models,
    counts: {
      draft: num(c.draft) ?? models.filter((m) => m.status === "draft").length,
      active: num(c.active) ?? models.filter((m) => m.status === "active").length,
      retired: num(c.retired) ?? models.filter((m) => m.status === "retired").length,
      overdue: num(c.overdue) ?? models.filter((m) => m.overdue).length,
    },
  }
}

/** list_risk_models with model_id: the model, its versions and its validations; null when it isn't one. */
export function modelDetailFrom(reply: unknown): ModelDetail | null {
  if (!isObj(reply)) return null
  const model = modelFrom(reply.model)
  if (!model) return null
  const versions = arr(reply.versions)
    .filter(isObj)
    .flatMap((v): ModelVersion[] =>
      num(v.version) === null || !str(v.name)
        ? []
        : [{ version: num(v.version)!, name: str(v.name)!, purpose: str(v.purpose) ?? "", method: str(v.method) ?? "", inputs: inputsOf(v.inputs), outputs: outputsOf(v.outputs), thresholds: thresholdsOf(v.thresholds), changeNote: str(v.change_note), createdBy: person(v.created_by), createdAt: str(v.created_at) }],
    )
  const validations = arr(reply.validations)
    .filter(isObj)
    .flatMap((x): ModelValidation[] =>
      str(x.id) && isOutcome(x.outcome)
        ? [{ id: str(x.id)!, version: num(x.version) ?? model.version, outcome: x.outcome, notes: str(x.notes) ?? "", nextValidationDue: str(x.next_validation_due), validatedBy: person(x.validated_by), validatedAt: str(x.validated_at) }]
        : [],
    )
  return { model, versions, validations }
}

// ---- financial products' own risk models (their definitions' risk_models) ----

export type ProductRiskModel = { key: string; productId: string; productName: string; firmId: string | null; firmName: string | null; modelName: string; type: string; version: string | null; href: string | null }
export type ProductRiskModels = { available: true; rows: ProductRiskModel[] } | Unavailable

const PURPOSE_WORDS: Record<string, string> = {
  pd_scorecard: "Probability of default scorecard",
  affordability: "Affordability",
  fraud_score: "Fraud score",
  behaviour_score: "Behaviour score",
  lgd: "Loss given default",
  fx_risk: "Foreign exchange risk",
  aml_risk: "Anti-money-laundering risk",
  other: "Other",
}

export function productModelsFrom(reply: unknown): ProductRiskModels {
  if (!isObj(reply) || !Array.isArray(reply.models)) return { available: false, reason: "Mynt didn't answer with the products' risk models." }
  const rows = reply.models.filter(isObj).flatMap((r, i): ProductRiskModel[] => {
    const p = isObj(r.product) ? r.product : null
    const m = isObj(r.model) ? r.model : null
    const f = isObj(r.firm) ? r.firm : null
    if (!p || !m || !str(p.id)) return []
    const firmId = f ? str(f.id) : null
    const purpose = str(m.purpose)
    return [
      {
        key: `${str(p.id)}:${str(m.id) ?? i}`,
        productId: str(p.id)!,
        productName: str(p.name) ?? str(p.id)!,
        firmId,
        firmName: f ? str(f.name) : null,
        modelName: str(m.name) ?? str(m.id) ?? "Unnamed model",
        type: purpose ? (PURPOSE_WORDS[purpose] ?? purpose) : "Not stated",
        version: str(m.version),
        // A product lives on its firm's Products tab; a reference product (no firm) has no page in the platform admin.
        href: firmId ? `${adminHref("firms", firmId)}?tab=products` : null,
      },
    ]
  })
  return { available: true, rows }
}

// ---- words ----

export const statusWords = (m: { status: ModelStatus }) => MODEL_STATUS_LABELS[m.status]
export const ownerWords = (p: Person | null) => (p ? (p.name ?? "Unnamed admin") : "No owner")
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : null)
export const lastValidatedWords = (m: RiskModel) => (m.lastValidatedAt ? `${dayOf(m.lastValidatedAt)}${m.outcome ? `: ${MODEL_OUTCOME_LABELS[m.outcome]}` : ""}` : "Never validated")
export const dueWords = (m: RiskModel) =>
  m.status === "retired" ? "Not due: retired" : m.nextValidationDue ? `${m.nextValidationDue}${m.overdue ? " (overdue)" : ""}` : "Not set"

/** A risk-model tab in the address (?tab=…), or the first area. */
export const areaFromQuery = (v: string | null | undefined): RiskArea => (isRiskArea(v) ? v : RISK_AREAS[0])

// ---- the sheets' JSON lists (JSON only: a list of objects, each with a name) ----

export function listOf(text: string, what: string): { ok: true; value: Obj[] } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: [] }
  try {
    const v = JSON.parse(text) as unknown
    if (!Array.isArray(v) || !v.every((x) => isObj(x) && typeof x.name === "string" && x.name.trim())) return { ok: false, error: `${what}: a JSON list of objects, each with a name.` }
    return { ok: true, value: v as Obj[] }
  } catch {
    return { ok: false, error: `${what}: that isn't valid JSON.` }
  }
}
/** A list as the sheets show it to edit: JSON, two-space indented, without the empty fields. */
export const listText = (rows: object[]) =>
  rows.length ? JSON.stringify(rows.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== ""))), null, 2) : ""
/** A threshold's value as Mynt takes it: a number when it reads as one, else its words. */
export const thresholdsForMynt = (rows: Obj[]) => rows.map((r) => ({ ...r, value: typeof r.value === "string" && r.value.trim() !== "" && Number.isFinite(Number(r.value)) ? Number(r.value) : r.value }))
