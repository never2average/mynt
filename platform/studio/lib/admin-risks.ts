// The platform admin's Risk register (/platform/risk-register), one tab per risk area (lib/risk-register.ts
// RISK_AREAS). A tab is ONE table of risk items (registerItemsFrom), each with its three scores in words (Inherent:
// likelihood × impact; Control: how well its controls work, or "Not assessed"; Residual: derived by the platform's
// grading or overridden; a signal is "Not scored"), highest residual first, and its source in words:
// - "Mynt": Mynt's own risk register filtered to that area (risk_register with subject "platform", kept and read by
//   Mynt admins only; the risks with no area under the Unassigned filter),
// - "App: <name>" / "Product: <name>": the open risks across every app and product in that area (admin_list_risks,
//   each risk's area as Mynt gave it, else its category's),
// - "Signal: <name>": that area's signals, one row per thing that needs attention. A signal measured and clear is one
//   row, "Clear"; one Mynt doesn't measure is one row, "Not available", with why (never 0, never left out).
// The signals, as the route sends them (each with its own columns, which the table reads into items):
// - Financial: liquidity pools' and treasury pools' flags (ops_status's attention lines): Area, What needs attention,
// - Compliance: production apps without a signed program agreement (App, Missing agreements), and overdue oversight
//   audits (Overdue audits, Apps flagged); ops_status counts both, without naming the sponsor, product or audit,
// - Third-party: vendors' failed conformance runs (ops_status): Service, Last conformance, Result,
// - Operations: the agents' and hosting's failures and stuck runs (ops_status): Area, Item, Since,
// - Business process and Regulated product: covenants (products paused, breaches) and product health (ops_status's
//   attention lines); drifted products, which ops_status doesn't count across firms, not available,
// - Technology: security events in the last 30 days (audit_log's entries of class security: When, Action, Actor,
//   Target) and backups (ops_status: Last run, Result, Off-site, Last success, Last restore test).
// Pure, for the route, the views and the tests.

import { adminHref, words } from "./admin"
import type { AuditEntry } from "./admin-audit"
import { actionLabel, actorWords, whenWords } from "./admin-audit"
import { peopleFrom } from "./people"
import { areaOfRisk, controlWords, isRiskArea, residualWords, RISK_CATEGORY_LABELS, RISK_LEVEL_LABELS, RISK_STATUS_LABELS, RISK_STATUSES, scoresFrom, unavailable, type RiskArea, type RiskCategory, type RiskRegister, type RiskRow, type RiskScores, type RiskStatus, type Signal, type Unavailable } from "./risk-register"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export const PLATFORM_SUBJECT = { type: "platform", id: "mynt" } as const
export const SECURITY_DAYS = 30
export const TOP_RISKS = 100
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—")

// ---- open risks across apps and products in one area (admin_list_risks) ----

export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]
export type CrossRisk = {
  id: string
  title: string
  subjectType: "app" | "product" | "platform"
  subjectName: string | null
  href: string | null // where it lives in the platform admin: the app's workspace, the product's firm (its Products tab)
  riskArea: RiskArea | null
  category: string | null
  likelihood: number | null
  impact: number | null
  score: number
  level: RiskLevel
  scores: RiskScores // inherent, control and residual, as Mynt graded them
  owner: string | null // the owner's name, when the risk has one
  mitigation: string | null
  status: string
  reviewBy: string | null
  overdue: boolean
}
export type CrossRisks = { available: true; risks: CrossRisk[] } | Unavailable

/** admin_list_risks' reply: the apps' and products' open risks in this area (Mynt's own are the register above). */
export function crossRisksFrom(reply: unknown, area: RiskArea): CrossRisks {
  if (!isObj(reply) || !Array.isArray(reply.risks)) return unavailable("Mynt didn't answer with the risks across apps and products.")
  const risks = reply.risks.filter(isObj).flatMap((r): CrossRisk[] => {
    const id = str(r.id)
    const title = str(r.title)
    const type = r.subject_type === "app" || r.subject_type === "product" || r.subject_type === "platform" ? r.subject_type : null
    if (!id || !title || !type || type === "platform") return []
    const riskArea = areaOfRisk({ category: String(r.category ?? ""), ...("risk_area" in r ? { riskArea: isRiskArea(r.risk_area) ? r.risk_area : null } : {}) })
    if (riskArea !== area) return []
    const score = num(r.score) ?? (num(r.likelihood) ?? 0) * (num(r.impact) ?? 0)
    const ws = str(r.workspace_id)
    const firm = str(r.firm_id)
    const href = type === "app" && ws ? adminHref("workspaces", ws) : type === "product" && firm ? `${adminHref("firms", firm)}?tab=products` : null
    const owner = isObj(r.owner) ? (str(r.owner.name) ?? (str(r.owner.user_id) ? "Unnamed member" : null)) : null
    const scores = scoresFrom({ ...r, inherent: isObj(r.inherent) ? r.inherent : { score } }, num(r.likelihood) ?? 0, num(r.impact) ?? 0)
    return [{ id, title, subjectType: type, subjectName: str(r.subject_name), href, riskArea, category: str(r.category), likelihood: num(r.likelihood), impact: num(r.impact), score, level: scores.inherent.level, scores, owner, mitigation: str(r.mitigation), status: str(r.status) ?? "open", reviewBy: str(r.review_by), overdue: r.overdue === true }]
  })
  return { available: true, risks }
}
export const levelWords = (l: RiskLevel) => RISK_LEVEL_LABELS[l]
export const reviewWords = (r: { reviewBy: string | null; overdue: boolean }) => (r.reviewBy ? `${r.reviewBy}${r.overdue ? " (overdue)" : ""}` : "Not set")

// ---- each area's signals ----

export type SignalSpec = { id: string; title: string; description: string; columns: readonly string[]; signal: Signal; empty: string }
const rowsOf = (rows: { key: string; cells: string[] }[]): Signal => ({ available: true, rows })
const NO_OPS = "This Mynt has no operations status (ops_status) to read."

const OFFSITE: Record<string, string> = { uploaded: "Uploaded off-site", local_only: "On this server only", failed: "Upload failed" }
const NOT_RECORDED = "Not recorded"
export const BACKUP_COLUMNS = ["Last run", "Result", "Off-site", "Last success", "Last restore test"] as const
/** ops_status's backups as one row; not available when the server has no backup status to read. */
function backupsFrom(backups: Obj | null): Signal {
  if (!backups) return unavailable("This Mynt doesn't report its backups.")
  const status = str(backups.status)
  if (status && !("last_run_at" in backups) && !("offsite" in backups) && !("ok" in backups))
    return unavailable(status === "no status file" ? "No backup has run on this server: there is no backup status file to read." : "The server's backup status file can't be read.")
  const verify = isObj(backups.last_verify) ? backups.last_verify : isObj(backups.verify) ? backups.verify : null
  const at = (v: unknown) => (str(v) ? when(str(v)) : NOT_RECORDED)
  return rowsOf([
    {
      key: "backups",
      cells: [
        at(backups.last_run_at),
        backups.ok === true ? "Succeeded" : backups.ok === false ? `Failed${str(backups.error) ? `: ${str(backups.error)}` : ""}` : NOT_RECORDED,
        str(backups.offsite) ? (OFFSITE[str(backups.offsite)!] ?? str(backups.offsite)!) : NOT_RECORDED,
        at(backups.last_success_at),
        !verify ? NOT_RECORDED : verify.ok === true ? `Passed${str(verify.at) ? ` ${when(str(verify.at))}` : ""}` : verify.ok === false ? `Failed${str(verify.error) ? `: ${str(verify.error)}` : ""}` : NOT_RECORDED,
      ],
    },
  ])
}

// ops_status's attention lines start with what they're about ("hosting: …", "covenants: …"): that is the row's Area.
const OPERATIONS_PREFIXES = ["builds:", "desk:", "reviews:", "explorers:", "connector:", "hosting:", "sandbox provider:"]
const FINANCIAL_PREFIXES = ["liquidity pools:", "treasury pools:"]
const COVENANT_PREFIXES = ["covenants:"]
const HEALTH_PREFIXES = ["product health:"]
const AREA_WORDS: Record<string, string> = { builds: "Builds", desk: "Product desk", reviews: "Governance reviews", explorers: "Explorations", connector: "Connector", hosting: "Hosting", "sandbox provider": "Sandbox provider" }
const areaName = (prefix: string) => AREA_WORDS[prefix] ?? words(prefix)
export const ATTENTION_COLUMNS = ["Area", "What needs attention"] as const
const linesOf = (ops: Obj, prefixes: string[]) => (ops.attention as unknown[]).filter((x): x is string => typeof x === "string").filter((l) => prefixes.some((p) => l.startsWith(p)))
const splitLine = (l: string): [string, string] => {
  const i = l.indexOf(":")
  return [areaName(l.slice(0, i)), l.slice(i + 1).trim()]
}
function attentionLines(ops: Obj, prefixes: string[]): Signal {
  return rowsOf(linesOf(ops, prefixes).map((l, i) => ({ key: `l${i}`, cells: splitLine(l) })))
}

export const OPERATIONS_COLUMNS = ["Area", "Item", "Since"] as const
const AGENTS = ["builds", "desk", "reviews", "explorers", "connector"] as const
/** The agents' failed and stuck runs and hosting's failures, one row each with when it started (ops_status's own
 * lists); an area ops_status only has a line for (no list behind it) keeps the line, its Since not recorded. */
function operationsFrom(ops: Obj): Signal {
  const rows: { key: string; cells: string[] }[] = []
  const detailed = new Set<string>()
  const list = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : null)
  const why = (r: Obj) => (str(r.error) ? `: ${str(r.error)}` : "")
  const agents = isObj(ops.agents) ? ops.agents : {}
  for (const name of AGENTS) {
    const a = isObj(agents[name]) ? (agents[name] as Obj) : null
    const failures = a ? list(a.failures) : null
    const stuck = a ? list(a.stuck) : null
    if (!failures || !stuck) continue
    detailed.add(`${name}:`)
    failures.forEach((r, i) => rows.push({ key: `${name}-f${i}`, cells: [areaName(name), `Run ${str(r.id) ?? "(no id)"} ${words(str(r.status) ?? "failed").toLowerCase()}${why(r)}`, when(str(r.created_at))] }))
    stuck.forEach((r, i) => rows.push({ key: `${name}-s${i}`, cells: [areaName(name), `Run ${str(r.id) ?? "(no id)"} still running (${words(str(r.status) ?? "running").toLowerCase()})`, when(str(r.created_at))] }))
  }
  const hosting = isObj(ops.hosting) ? ops.hosting : {}
  const [vms, stopped, deploys] = [list(hosting.failed_tenants), list(hosting.stopped_apps), list(hosting.stuck_deploys)]
  if (vms || stopped || deploys) {
    detailed.add("hosting:")
    ;(vms ?? []).forEach((r, i) => rows.push({ key: `vm${i}`, cells: ["Hosting", `Machine ${str(r.id) ?? "(no id)"} failed to provision${why(r)}`, when(str(r.updated_at))] }))
    ;(stopped ?? []).forEach((r, i) => rows.push({ key: `st${i}`, cells: ["Hosting", `App ${str(r.app_id) ?? "(no id)"} stopped${why(r)}`, when(str(r.updated_at))] }))
    ;(deploys ?? []).forEach((r, i) => rows.push({ key: `dp${i}`, cells: ["Hosting", `App ${str(r.app_id) ?? "(no id)"} has been deploying for over 45 minutes`, when(str(r.updated_at))] }))
  }
  linesOf(ops, OPERATIONS_PREFIXES.filter((p) => !detailed.has(p))).forEach((l, i) => rows.push({ key: `l${i}`, cells: [...splitLine(l), NOT_RECORDED] }))
  return rowsOf(rows)
}

export function securityEventsFrom(entries: AuditEntry[] | null, now: Date = new Date()): Signal {
  if (entries === null) return unavailable("This Mynt has no audit log to read.")
  if (entries.length && entries.every((e) => e.class === null)) return unavailable("This Mynt's audit log doesn't say each entry's class yet, so security events can't be picked out.")
  const since = new Date(now.getTime() - SECURITY_DAYS * 86_400_000).toISOString()
  return rowsOf(
    entries
      .filter((e) => e.class === "security" && e.at >= since)
      .map((e) => ({ key: e.id, cells: [whenWords(e.at), actionLabel(e.action), actorWords(e), e.target || "—"] })),
  )
}

/** The signals Mynt measures for one area, from ops_status and (Technology) the audit log's security events. */
export function areaSignalsFrom(area: RiskArea, ops: unknown, auditEntries: AuditEntry[] | null, now: Date = new Date()): SignalSpec[] {
  const o = isObj(ops) && Array.isArray(ops.attention) ? ops : null
  const hours = o ? num(o.window_hours) : null
  const span = hours ? `in the last ${hours} hours` : "recently"
  const none = unavailable(NO_OPS)
  const attention = (prefixes: string[]) => (o ? attentionLines(o, prefixes) : none)
  if (area === "financial")
    return [
      { id: "pools", title: "Liquidity and treasury pools", description: "Flags on real money in pools, and treasuries Mynt stopped approving deposits to, from Mynt's operations status.", columns: ATTENTION_COLUMNS, signal: attention(FINANCIAL_PREFIXES), empty: "No pool or treasury flags." },
    ]
  if (area === "compliance") {
    const apps = o && isObj(o.apps) ? o.apps : null
    const audits = o && isObj(o.agreement_audits) ? o.agreement_audits : null
    const missing = apps && Array.isArray(apps.production_without_program_agreements) ? apps.production_without_program_agreements.filter(isObj) : null
    const overdue = audits ? num(audits.overdue) : null
    return [
      {
        id: "agreements",
        title: "Apps missing a program agreement",
        description: "Production apps without a signed program agreement in force with a product's sponsor. Mynt's operations status counts them per app; it doesn't name the sponsor or the product.",
        columns: ["App", "Missing agreements"],
        signal: !o
          ? none
          : missing === null
            ? unavailable("This Mynt doesn't report program agreements yet.")
            : rowsOf(missing.map((a, i) => ({ key: `m${i}`, cells: [str(a.app_name) ?? str(a.app_id) ?? "Unnamed app", num(a.missing) === null ? "Count not recorded" : num(a.missing) === 1 ? "1 signed program agreement missing" : `${num(a.missing)} signed program agreements missing`] }))),
        empty: "Every production app has its program agreements.",
      },
      {
        id: "audits",
        title: "Overdue oversight audits",
        description: "Oversight audits under app agreements past their due date and not closed. Mynt's operations status counts them; the licence provider and the app's side see each one.",
        columns: ["Overdue audits", "Apps flagged"],
        signal: !o
          ? none
          : overdue === null
            ? unavailable("This Mynt doesn't report oversight audits yet.")
            : rowsOf(overdue > 0 ? [{ key: "audits", cells: [String(overdue), num(audits!.apps_flagged) === null ? NOT_RECORDED : String(num(audits!.apps_flagged))] }] : []),
        empty: "No oversight audit is overdue.",
      },
    ]
  }
  if (area === "third_party") {
    const vendors = o && isObj(o.vendors) ? o.vendors : null
    return [
      {
        id: "vendors",
        title: "Vendor conformance",
        description: `Vendors' conformance runs that failed ${span}.`,
        columns: ["Service", "Last conformance", "Result"],
        signal: !o
          ? none
          : !vendors || !Array.isArray(vendors.failed_conformance)
            ? unavailable("This Mynt doesn't report vendors' conformance runs yet.")
            : rowsOf(vendors.failed_conformance.filter(isObj).map((r, i) => ({ key: `v${i}`, cells: [str(r.offering) ?? str(r.offering_id) ?? "Unnamed service", when(str(r.created_at)), "Failed"] }))),
        empty: `No conformance run failed ${span}.`,
      },
    ]
  }
  if (area === "operations")
    return [
      { id: "operations", title: "Agents and hosting", description: `Builds, the product desk, reviews, explorations, the connector and hosting: failures and stuck runs ${span}, from Mynt's operations status.`, columns: OPERATIONS_COLUMNS, signal: o ? operationsFrom(o) : none, empty: `No agent or hosting failures ${span}.` },
    ]
  if (area === "business_process" || area === "regulated_product") {
    const drift = unavailable("Mynt's operations status doesn't count drifted products across firms yet; each app's Security & risk tab shows its own.")
    return [
      { id: "covenants", title: "Covenants", description: "Products whose new sales a licence provider's covenant paused, open breaches, and rules that can't be measured.", columns: ATTENTION_COLUMNS, signal: o && isObj(o.covenants) ? attentionLines(o, COVENANT_PREFIXES) : o ? unavailable("This Mynt doesn't report covenants yet.") : none, empty: "No products paused and no open breaches." },
      ...(area === "regulated_product"
        ? [{ id: "product-health", title: "Product health", description: "Product health records stalled against the chain, or snapshots past their deadline.", columns: ATTENTION_COLUMNS, signal: o && isObj(o.product_health) ? attentionLines(o, HEALTH_PREFIXES) : o ? unavailable("This Mynt doesn't report product health yet.") : none, empty: "Every product health record is on time." }]
        : []),
      { id: "drift", title: "Drifted products", description: "Products that drifted from their published composition (new sales paused until fixed).", columns: ["Product", "Detail"], signal: drift, empty: "No product has drifted." },
    ]
  }
  // technology
  const backups = o && isObj(o.backups) ? o.backups : null
  return [
    { id: "security", title: `Security events in the last ${SECURITY_DAYS} days`, description: "Audit trail entries of the security class: build audits, the mainnet gate, secrets revealed or rotated, machine access, people cut off.", columns: ["When", "Action", "Actor", "Target"], signal: securityEventsFrom(auditEntries, now), empty: `No security events in the last ${SECURITY_DAYS} days among the newest audit entries.` },
    { id: "backups", title: "Backups", description: "The server's backups: the last run and whether it succeeded, the off-site copy, the last success and the last restore test.", columns: BACKUP_COLUMNS, signal: !o ? none : backupsFrom(backups), empty: "Nothing recorded." },
  ]
}

/** The area an address's ?area= asks for: one of the seven, the first when none is given; null when it isn't one. */
export function areaParam(v: string | null): RiskArea | null {
  if (v === null) return "financial"
  return isRiskArea(v) ? v : null
}

export type RegisterAreaData ={ area: RiskArea; register: RiskRegister | Unavailable; unassigned: RiskRegister | Unavailable; cross: CrossRisks; signals: SignalSpec[] }

/** The register's owner choices: Mynt admins who have signed in (list_whitelist). */
export function adminOwnersFrom(whitelist: unknown): { userId: string; name: string }[] {
  return (peopleFrom(whitelist)?.people ?? []).filter((p) => p.status === "signed_in" && p.userId && p.roles.includes("admin")).map((p) => ({ userId: p.userId!, name: p.name ?? p.email ?? "Mynt admin" }))
}

// ---- a tab's one table: every risk item of the area, whatever its source ----

export const REGISTER_SOURCES = ["mynt", "subjects", "signals"] as const
export type RegisterSource = (typeof REGISTER_SOURCES)[number]
export const REGISTER_SOURCE_LABELS: Record<RegisterSource, string> = { mynt: "Mynt", subjects: "Apps and products", signals: "Signals" }
export const SIGNAL_STATUSES = ["needs_attention", "clear", "not_available"] as const
export const ITEM_STATUSES = [...RISK_STATUSES, ...SIGNAL_STATUSES] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]
export const ITEM_STATUS_LABELS: Record<ItemStatus, string> = { ...RISK_STATUS_LABELS, needs_attention: "Needs attention", clear: "Clear", not_available: "Not available" }
export const NOT_SCORED = "Not scored"
export const NOT_ASSIGNED = "Not assigned"
export const NO_MITIGATION = "None recorded"

export type RegisterItem = {
  key: string
  source: RegisterSource
  sourceWords: string // "Mynt", "App: Saver", "Product: Fixed deposit", "Signal: Backup"
  subject: { kind: string; name: string; href: string | null } | null // an app's or a product's risk: what it is on
  title: string
  category: string
  likelihood: number | null
  impact: number | null
  score: number | null // the inherent score; null: not scored (a signal), or not available
  level: RiskLevel | null
  scoreWords: string // Inherent: "4 × 3 = 12 (High)", "Not scored" or "Not available"
  controlWords: string // "Strong", "Not assessed", "Not scored" or "Not available"
  residual: number | null
  residualLevel: RiskLevel | null // what the table sorts and filters by
  residualWords: string // "6 (Medium)", with "overridden" or "same as inherent" in words
  riskId: string | null // a risk on a register: its page (/platform/risk-register/<id>) opens
  owner: string
  status: ItemStatus
  when: string // a register risk's review date ("(overdue)" in words); when a signal was observed
  reviewBy: string | null
  overdue: boolean
  detail: string // the mitigation, the signal's detail, or why it isn't available: in full
  risk: RiskRow | null // Mynt's own: what Review risk opens
}

// Each signal's name for one of its rows ("Signal: Backup"); a signal this doesn't know keeps its title.
const SIGNAL_NAMES: Record<string, string> = {
  pools: "Pool flag",
  agreements: "Missing program agreement",
  audits: "Overdue agreement audit",
  vendors: "Vendor conformance",
  operations: "Agent/hosting failure",
  covenants: "Covenant",
  "product-health": "Product health",
  drift: "Drifted product",
  security: "Security event",
  backups: "Backup",
}
export const signalName = (spec: { id: string; title: string }) => SIGNAL_NAMES[spec.id] ?? spec.title
const seen = (v: string | undefined) => (v && v !== "—" ? v : NOT_RECORDED)
const upper = (v: string) => (v ? v[0].toUpperCase() + v.slice(1) : v)

type SignalPart = Pick<RegisterItem, "title" | "category" | "when" | "detail"> & { status?: ItemStatus }
/** One signal row as a risk item: what needs attention, its kind, when it was observed, and the rest in words. */
function signalPart(spec: SignalSpec, cells: string[]): SignalPart {
  const [a = "", b = "", c = ""] = cells
  switch (spec.id) {
    case "pools":
    case "covenants":
    case "product-health":
      return { title: upper(b), category: a, when: NOT_RECORDED, detail: spec.description }
    case "operations":
      return { title: upper(b), category: a, when: seen(c), detail: spec.description }
    case "agreements":
      return { title: `${a}: in production without its program agreements`, category: "Program agreement", when: NOT_RECORDED, detail: `${upper(b)}. ${spec.description}` }
    case "audits":
      return { title: a === "1" ? "1 oversight audit is overdue" : `${a} oversight audits are overdue`, category: "Oversight audit", when: NOT_RECORDED, detail: `Apps flagged: ${b}. ${spec.description}` }
    case "vendors":
      return { title: `${a}: conformance run failed`, category: "Vendor conformance", when: seen(b), detail: spec.description }
    case "security":
      return { title: b, category: "Security event", when: seen(a), detail: `Actor: ${c}. Target: ${cells[3] ?? "—"}.` }
    case "backups": {
      const failed = [b.startsWith("Failed") ? "the last run failed" : null, c === OFFSITE.failed ? "the off-site upload failed" : null, (cells[4] ?? "").startsWith("Failed") ? "the last restore test failed" : null].filter((x): x is string => x !== null)
      const problem = failed.length ? failed.join(", ") : b === "Succeeded" ? null : "the last run's result isn't recorded"
      return { title: `Server backups: ${problem ?? "the last run succeeded"}`, category: "Backup", when: seen(a), detail: `${spec.columns.map((h, i) => `${h}: ${cells[i] ?? NOT_RECORDED}`).join(". ")}.`, status: problem ? "needs_attention" : "clear" }
    }
    default:
      return { title: a, category: spec.title, when: NOT_RECORDED, detail: spec.columns.slice(1).map((h, i) => `${h}: ${cells[i + 1] ?? NOT_RECORDED}`).join(". ") }
  }
}

const blank = { subject: null, likelihood: null, impact: null, score: null, level: null, residual: null, residualLevel: null, riskId: null, reviewBy: null, overdue: false, risk: null } as const
const scored = (s: RiskScores) => ({ controlWords: controlWords(s), residual: s.residual.score, residualLevel: s.residual.level as RiskLevel, residualWords: residualWords(s) })
const unscored = (words: string) => ({ scoreWords: words, controlWords: words, residualWords: words })

/** A signal's rows as risk items: one per thing that needs attention; one "Clear" row when it is measured and nothing
 * does; one "Not available" row, with why, when Mynt doesn't measure it. Never no row, never a 0. */
export function signalItems(spec: SignalSpec): RegisterItem[] {
  const base = { ...blank, source: "signals" as const, sourceWords: `Signal: ${signalName(spec)}`, ...unscored(NOT_SCORED), owner: "Mynt" }
  if (!spec.signal.available) return [{ ...base, key: `signal:${spec.id}:none`, title: spec.title, category: signalName(spec), status: "not_available", when: NOT_RECORDED, detail: spec.signal.reason }]
  if (!spec.signal.rows.length) return [{ ...base, key: `signal:${spec.id}:clear`, title: spec.empty, category: signalName(spec), status: "clear", when: NOT_RECORDED, detail: spec.description }]
  return spec.signal.rows.map((r) => {
    const { status = "needs_attention", ...part } = signalPart(spec, r.cells)
    return { ...base, key: `signal:${spec.id}:${r.key}`, status, ...part }
  })
}

// Highest residual score first, then the highest inherent score.
const byScore = (a: RegisterItem, b: RegisterItem) => (b.residual ?? -1) - (a.residual ?? -1) || (b.score ?? -1) - (a.score ?? -1)
const registerItems = (reg: RiskRegister | Unavailable, what: string): RegisterItem[] =>
  reg.available
    ? reg.risks
        .map(
          (r): RegisterItem => ({
            key: `mynt:${r.id}`,
            source: "mynt",
            sourceWords: "Mynt",
            subject: null,
            title: r.title,
            category: RISK_CATEGORY_LABELS[r.category],
            likelihood: r.likelihood,
            impact: r.impact,
            score: r.inherent.score,
            level: r.inherent.level,
            scoreWords: `${r.likelihood} × ${r.impact} = ${r.inherent.score} (${r.inherent.levelName})`,
            ...scored(r),
            riskId: r.id,
            owner: r.owner ? (r.owner.name ?? "Unnamed member") : NOT_ASSIGNED,
            status: r.status,
            when: reviewWords(r),
            reviewBy: r.reviewBy,
            overdue: r.overdue,
            detail: r.mitigation ?? NO_MITIGATION,
            risk: r,
          }),
        )
        .sort(byScore)
    : [{ ...blank, key: "mynt:none", source: "mynt", sourceWords: "Mynt", title: what, category: "Risk register", ...unscored("Not available"), owner: "Mynt", status: "not_available", when: NOT_RECORDED, detail: reg.reason }]

const crossItems = (cross: CrossRisks): RegisterItem[] =>
  cross.available
    ? cross.risks
        .map((r): RegisterItem => {
          const kind = r.subjectType === "app" ? "App" : "Product"
          const name = r.subjectName ?? "Unnamed"
          return {
            key: `subject:${r.id}`,
            source: "subjects",
            sourceWords: `${kind}: ${name}`,
            subject: { kind, name, href: r.href },
            title: r.title,
            category: r.category ? (RISK_CATEGORY_LABELS[r.category as RiskCategory] ?? words(r.category)) : NOT_RECORDED,
            likelihood: r.likelihood,
            impact: r.impact,
            score: r.score,
            level: r.level,
            scoreWords: r.likelihood !== null && r.impact !== null && r.likelihood * r.impact === r.score ? `${r.likelihood} × ${r.impact} = ${r.score} (${r.scores.inherent.levelName})` : `${r.score} (${r.scores.inherent.levelName})`,
            ...scored(r.scores),
            riskId: r.id,
            owner: r.owner ?? NOT_ASSIGNED,
            status: (RISK_STATUSES as readonly string[]).includes(r.status) ? (r.status as RiskStatus) : "open",
            when: reviewWords(r),
            reviewBy: r.reviewBy,
            overdue: r.overdue,
            detail: r.mitigation ?? NO_MITIGATION,
            risk: null,
          }
        })
        .sort(byScore)
    : [{ ...blank, key: "subject:none", source: "subjects", sourceWords: REGISTER_SOURCE_LABELS.subjects, title: "Open risks across apps and products", category: "Risk register", ...unscored("Not available"), owner: "Their workspaces and firms", status: "not_available", when: NOT_RECORDED, detail: cross.reason }]

/** A tab's one table: Mynt's own risks in the area (highest residual first), then the apps' and products' (highest
 * residual first), then the signals (what needs attention first, then what is clear, then what isn't available). With
 * unassigned, Mynt's own risks that have no area yet instead: only Mynt's register has those. */
export function registerItemsFrom(data: RegisterAreaData, unassigned = false): RegisterItem[] {
  if (unassigned) return registerItems(data.unassigned, "Mynt's own register: unassigned risks")
  const signals = data.signals.flatMap(signalItems)
  return [...registerItems(data.register, "Mynt's own register"), ...crossItems(data.cross), ...SIGNAL_STATUSES.flatMap((s) => signals.filter((i) => i.status === s))]
}
