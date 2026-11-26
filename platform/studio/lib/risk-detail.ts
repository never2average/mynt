// One risk in full (Mynt's get_risk), as its detail shows it: on the platform admin's Risk register
// (/platform/risk-register/<id>), and in a sheet from an app's Security & risk tab and a product's Risk tab. The
// metadata card's facts in their order, then five tabs, each a table: Scoring (the impact, likelihood and control
// factors that explain the three scores), Treatment (the tasks that bring it down), Controls (what keeps it down),
// Linked (what it's about) and History (every change, with the scores before → after). Levels, statuses and results
// are always in words; whatever isn't recorded says so ("Not assessed", "Not tested", "Not set"), never 0. Pure: the
// routes read Mynt's reply into these shapes, and the view, its sheets and the tests share them.

import { areaOfRisk, areaWords, controlWords, inherentWords, residualWords, riskRowsFrom, RISK_STATUS_LABELS, type RiskRow } from "./risk-register"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const oneOf = <T extends string>(xs: readonly T[], v: unknown): T | null => (typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : null)

export const FACTOR_KINDS = ["impact", "likelihood", "control"] as const
export type FactorKind = (typeof FACTOR_KINDS)[number]
export const FACTOR_KIND_LABELS: Record<FactorKind, string> = { impact: "Impact factors", likelihood: "Likelihood factors", control: "Control factors" }
export const TREATMENT_STATUSES = ["todo", "doing", "done", "dropped"] as const
export type TreatmentStatus = (typeof TREATMENT_STATUSES)[number]
export const TREATMENT_STATUS_LABELS: Record<TreatmentStatus, string> = { todo: "To do", doing: "Under way", done: "Done", dropped: "Dropped" }
export const TREATMENT_EFFECTIVENESS = ["not_assessed", "ineffective", "partly_effective", "effective"] as const
export type TreatmentEffectiveness = (typeof TREATMENT_EFFECTIVENESS)[number]
export const TREATMENT_EFFECTIVENESS_LABELS: Record<TreatmentEffectiveness, string> = { not_assessed: "Not assessed", ineffective: "Didn't work", partly_effective: "Partly worked", effective: "Worked" }
export const CONTROL_KINDS = ["preventive", "detective", "corrective"] as const
export type ControlKind = (typeof CONTROL_KINDS)[number]
export const CONTROL_KIND_LABELS: Record<ControlKind, string> = { preventive: "Preventive: stops it happening", detective: "Detective: notices it", corrective: "Corrective: puts it right" }
export const CONTROL_TEST_RESULTS = ["passed", "gaps_found", "failed"] as const
export type ControlTestResult = (typeof CONTROL_TEST_RESULTS)[number]
export const CONTROL_TEST_LABELS: Record<ControlTestResult, string> = { passed: "Passed", gaps_found: "Gaps found", failed: "Failed" }
export const LINK_TARGETS = ["app", "product", "vendor_offering", "agreement", "agreement_audit", "audit_entry", "risk_model", "firm"] as const
export type LinkTarget = (typeof LINK_TARGETS)[number]
export const LINK_TARGET_LABELS: Record<LinkTarget, string> = {
  app: "App",
  product: "Product",
  vendor_offering: "Vendor service",
  agreement: "Agreement",
  agreement_audit: "Oversight audit",
  audit_entry: "Audit-trail entry",
  risk_model: "Risk model",
  firm: "Firm",
}
export const NOT_TESTED = "Not tested"
export const NOT_SET = "Not set"
export const NAME_HIDDEN = "Name not shown: it isn't yours to read, or it no longer exists"

export type FactorSource = { kind: "link"; url: string } | { kind: "reference"; targetType: LinkTarget; targetId: string; name: string | null }
export type Factor = { id: string; kind: FactorKind; name: string; score: number; rationale: string | null; source: FactorSource | null }
export type FactorList = { recorded: string; average: number | null; formula: string; factors: Factor[] }
export type Treatment = {
  id: string
  title: string
  owner: { userId: string; name: string | null } | null
  due: string | null
  overdue: boolean
  status: TreatmentStatus
  progressNote: string | null
  effectiveness: TreatmentEffectiveness
  effectivenessNote: string | null
  doneAt: string | null
  isControl: boolean // a control was already made from it
}
export type Control = { id: string; name: string; kind: ControlKind; description: string | null; lastTestedAt: string | null; testResult: ControlTestResult | null; fromTask: string | null; retired: { at: string | null; reason: string | null } | null }
export type RiskLink = { id: string; targetType: LinkTarget; targetId: string; name: string | null; note: string | null }
export type Scores = { inherent: number | null; control: string | null; residual: number | null }
export type HistoryEntry = { key: string; at: string | null; who: string; what: string; note: string | null; before: Scores | null; after: Scores | null }
export type RiskDetail = {
  subject: { type: "app" | "product" | "platform"; id: string; name: string }
  canManage: boolean
  risk: RiskRow
  scoring: Record<FactorKind, FactorList>
  treatments: Treatment[]
  treatmentDue: string | null
  controls: Control[]
  links: RiskLink[]
  history: HistoryEntry[]
}

const sourceFrom = (v: unknown): FactorSource | null => {
  if (!isObj(v)) return null
  if (v.kind === "link" && str(v.url)?.startsWith("https://")) return { kind: "link", url: str(v.url)! }
  const type = oneOf(LINK_TARGETS, v.target_type)
  return v.kind === "reference" && type && str(v.target_id) ? { kind: "reference", targetType: type, targetId: str(v.target_id)!, name: str(v.name) } : null
}
const person = (v: unknown) => (isObj(v) && str(v.user_id) ? { userId: str(v.user_id)!, name: str(v.name) } : null)
const scoresOf = (v: unknown): Scores | null => (isObj(v) ? { inherent: num(v.inherent), control: str(v.control), residual: num(v.residual) } : null)

/** get_risk's reply, or null when it isn't one. */
export function riskDetailFrom(reply: unknown): RiskDetail | null {
  if (!isObj(reply) || !isObj(reply.subject)) return null
  const risk = riskRowsFrom([reply.risk])[0]
  const type = oneOf(["app", "product", "platform"] as const, reply.subject.type)
  if (!risk || !type || !str(reply.subject.id)) return null
  const scoring = isObj(reply.scoring) ? reply.scoring : {}
  const list = (kind: FactorKind, recorded: string): FactorList => {
    const s = isObj(scoring[kind]) ? (scoring[kind] as Obj) : {}
    return {
      recorded,
      average: num(s.average),
      formula: str(s.formula) ?? "",
      factors: arr(s.factors).flatMap((f): Factor[] => (str(f.id) && str(f.name) && num(f.score) !== null ? [{ id: str(f.id)!, kind, name: str(f.name)!, score: num(f.score)!, rationale: str(f.rationale), source: sourceFrom(f.source) }] : [])),
    }
  }
  const controls = arr(reply.controls).flatMap((c): Control[] => {
    const kind = oneOf(CONTROL_KINDS, c.kind)
    if (!str(c.id) || !str(c.name) || !kind) return []
    const from = isObj(c.from_treatment) ? c.from_treatment : null
    const retired = isObj(c.retired) ? c.retired : null
    return [{ id: str(c.id)!, name: str(c.name)!, kind, description: str(c.description), lastTestedAt: str(c.last_tested_at), testResult: oneOf(CONTROL_TEST_RESULTS, c.test_result), fromTask: from ? (str(from.title) ?? "A treatment task") : null, retired: retired ? { at: str(retired.at), reason: str(retired.reason) } : null }]
  })
  const made = new Set(arr(reply.controls).map((c) => (isObj(c.from_treatment) ? str(c.from_treatment.id) : null)))
  return {
    subject: { type, id: str(reply.subject.id)!, name: str(reply.subject.name) ?? "Unnamed" },
    canManage: reply.can_manage === true,
    risk,
    scoring: { impact: list("impact", `${risk.impact} of 5`), likelihood: list("likelihood", `${risk.likelihood} of 5`), control: list("control", controlWords(risk)) },
    treatments: arr(reply.treatments).flatMap((t): Treatment[] => {
      const status = oneOf(TREATMENT_STATUSES, t.status)
      if (!str(t.id) || !str(t.title) || !status) return []
      return [{ id: str(t.id)!, title: str(t.title)!, owner: person(t.owner), due: str(t.due), overdue: t.overdue === true, status, progressNote: str(t.progress_note), effectiveness: oneOf(TREATMENT_EFFECTIVENESS, t.effectiveness) ?? "not_assessed", effectivenessNote: str(t.effectiveness_note), doneAt: str(t.done_at), isControl: made.has(str(t.id)) }]
    }),
    treatmentDue: str(reply.treatment_due),
    controls,
    links: arr(reply.links).flatMap((l): RiskLink[] => {
      const targetType = oneOf(LINK_TARGETS, l.target_type)
      return str(l.id) && targetType && str(l.target_id) ? [{ id: str(l.id)!, targetType, targetId: str(l.target_id)!, name: str(l.name), note: str(l.note) }] : []
    }),
    history: arr(reply.history).map((h, i) => {
      const score = isObj(h.score) ? h.score : {}
      const actor = isObj(h.actor) ? h.actor : null
      return { key: `${str(h.at) ?? ""}:${i}`, at: str(h.at), who: actor ? (str(actor.name) ?? "Unnamed member") : "Mynt", what: str(h.what) ?? "Changed", note: str(h.note), before: scoresOf(score.before), after: scoresOf(score.after) }
    }),
  }
}

// ---- words ----

/** "‹short id› · ‹risk area› · ‹title›": the detail's header. */
export const shortId = (id: string) => id.slice(0, 8)
export const riskHeading = (r: RiskRow) => `${shortId(r.id)} · ${areaWords(areaOfRisk(r))} · ${r.title}`
export const reviewWords = (r: { reviewBy: string | null; overdue: boolean }) => (r.reviewBy ? `${r.reviewBy}${r.overdue ? " (overdue)" : ""}` : NOT_SET)
export const dueWords = (t: { due: string | null; overdue: boolean }) => (t.due ? `${t.due}${t.overdue ? " (overdue)" : ""}` : NOT_SET)
export const ownerWords = (o: { name: string | null } | null) => (o ? (o.name ?? "Unnamed member") : "No owner")
export const whenWords = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "Not recorded")
const today = () => new Date().toISOString().slice(0, 10)

export const FACT_LABELS = ["Status", "Inherent", "Control", "Residual", "Owner", "Next review", "Treatment due", "Linked"] as const
/** The metadata card's facts, in their order. */
export function riskFacts(d: RiskDetail, now: string = today()): [(typeof FACT_LABELS)[number], string][] {
  const r = d.risk
  const openTasks = d.treatments.filter((t) => t.status === "todo" || t.status === "doing").length
  return [
    ["Status", RISK_STATUS_LABELS[r.status]],
    ["Inherent", inherentWords(r)],
    ["Control", controlWords(r)],
    ["Residual", residualWords(r)],
    ["Owner", ownerWords(r.owner)],
    ["Next review", reviewWords(r)],
    ["Treatment due", d.treatmentDue ? `${d.treatmentDue}${d.treatmentDue < now ? " (overdue)" : ""}` : openTasks ? "No due date on its open tasks" : "No open treatment tasks"],
    ["Linked", d.links.length === 1 ? "1 item" : `${d.links.length} items`],
  ]
}

/** A factor list's caption: its formula in words, then the score it explains beside the factors' average. */
export const factorCaption = (l: FactorList) => `${l.formula} Recorded: ${l.recorded}. ${l.average === null ? "No factors yet, so no average." : `Factors' average: ${l.average} of 5.`}`.trim()
export const sourceWords = (s: FactorSource | null) => (!s ? "No source" : s.kind === "link" ? s.url : `${LINK_TARGET_LABELS[s.targetType]}: ${s.name ?? NAME_HIDDEN}`)
const scoreWords = (s: Scores | null) =>
  !s ? null : `inherent ${s.inherent ?? "not recorded"}, residual ${s.residual ?? "not recorded"}`
/** "inherent 12, residual 12 → inherent 12, residual 3"; "No change" when a change moved no score. */
export function beforeAfterWords(h: Pick<HistoryEntry, "before" | "after">): string {
  const after = scoreWords(h.after)
  if (!after) return "Not recorded"
  const before = scoreWords(h.before)
  if (!before) return `Started at ${after}`
  return before === after ? `No change (${after})` : `${before} → ${after}`
}

/** Where a linked item opens in the studio, when it has a page the reader can reach from here; null otherwise. */
export function linkHref(l: { targetType: LinkTarget; targetId: string }, where: "platform" | "studio"): string | null {
  const id = encodeURIComponent(l.targetId)
  if (where === "platform") {
    if (l.targetType === "risk_model") return `/platform/risk-models/${id}`
    if (l.targetType === "firm") return `/platform/firms/${id}`
    if (l.targetType === "audit_entry") return `/platform/audit/${id}`
    return null
  }
  if (l.targetType === "product") return `/products/${id}`
  return null
}

/** What the detail's sheets send; the route adds the risk. */
export type RiskDetailChange =
  | { action: "add_factor"; kind: FactorKind; name: string; score: number; rationale?: string; source?: string }
  | { action: "update_factor"; factor_id: string; name?: string; score?: number; rationale?: string; source?: string }
  | { action: "remove_factor"; factor_id: string }
  | { action: "add_treatment"; title: string; owner_user_id?: string; due?: string; progress_note?: string }
  | { action: "update_treatment"; treatment_id: string; title?: string; owner_user_id?: string; due?: string; status?: TreatmentStatus; progress_note?: string; effectiveness?: TreatmentEffectiveness; effectiveness_note?: string }
  | { action: "add_control"; name?: string; kind: ControlKind; description?: string; last_tested_at?: string; test_result?: ControlTestResult; source_treatment_id?: string }
  | { action: "update_control"; control_id: string; name?: string; kind?: ControlKind; description?: string; last_tested_at?: string; test_result?: ControlTestResult }
  | { action: "retire_control"; control_id: string; reason: string }
  | { action: "link"; target_type: LinkTarget; target_id: string; note?: string }
  | { action: "unlink"; link_id: string }
  | { action: "set_status"; status: "accepted" | "closed"; note: string }

/** The tool each of the detail's actions calls on Mynt. */
export const DETAIL_ACTION_TOOLS = {
  add_factor: "add_risk_factor",
  update_factor: "update_risk_factor",
  remove_factor: "remove_risk_factor",
  add_treatment: "add_risk_treatment",
  update_treatment: "update_risk_treatment",
  add_control: "add_risk_control",
  update_control: "update_risk_control",
  retire_control: "retire_risk_control",
  link: "link_risk",
  unlink: "unlink_risk",
  set_status: "update_risk",
} as const
export type DetailAction = keyof typeof DETAIL_ACTION_TOOLS

/** A choice the Link item picker offers for a type (the route lists what it cheaply can; any other id is typed). */
export type LinkChoice = { id: string; name: string }
export type LinkChoices = Partial<Record<LinkTarget, LinkChoice[]>>
export type RiskDetailData = { detail: RiskDetail; owners: { userId: string; name: string }[]; linkChoices: LinkChoices }
