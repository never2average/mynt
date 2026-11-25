// The platform admin's Risk register (/platform/risk-register), one tab per risk area (lib/risk-register.ts
// RISK_AREAS): Mynt's own risk register filtered to that area (risk_register with subject "platform", kept and read by
// Mynt admins only; the risks with no area under an Unassigned filter), the open risks across every app and product in
// that area (admin_list_risks, each risk's area as Mynt gave it, else its category's), and that area's signals, each a
// table or "Not available." with why (never an empty table, or 0, for something Mynt didn't measure):
// - Financial: liquidity pools' and treasury pools' flags (ops_status's attention lines),
// - Compliance: production apps without a signed program agreement, and overdue oversight audits (ops_status),
// - Third-party: vendors' failed conformance runs (ops_status),
// - Operations: the agents' and hosting's failures (ops_status's attention lines),
// - Business process and Regulated product: covenants (products paused, breaches) and product health (ops_status);
//   drifted products, which ops_status doesn't count across firms, not available,
// - Technology: security events in the last 30 days (audit_log's entries of class security) and backups (ops_status).
// Pure, for the route, the views and the tests.

import { adminHref, words } from "./admin"
import type { AuditEntry } from "./admin-audit"
import { actionLabel, actorWords, whenWords } from "./admin-audit"
import { peopleFrom } from "./people"
import { areaOfRisk, isRiskArea, RISK_LEVEL_LABELS, riskLevel, unavailable, type RiskArea, type RiskRegister, type Signal, type Unavailable } from "./risk-register"

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
  score: number
  level: RiskLevel
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
    return [{ id, title, subjectType: type, subjectName: str(r.subject_name), href, riskArea, score, level: riskLevel(score) as RiskLevel, status: str(r.status) ?? "open", reviewBy: str(r.review_by), overdue: r.overdue === true }]
  })
  return { available: true, risks }
}
export const levelWords = (l: RiskLevel) => RISK_LEVEL_LABELS[l]
export const subjectWords = (r: CrossRisk) => `${r.subjectType === "app" ? "App" : r.subjectType === "product" ? "Financial product" : "Mynt"}: ${r.subjectName ?? "Unnamed"}`

// ---- each area's signals ----

export type SignalSpec = { id: string; title: string; description: string; columns: readonly string[]; signal: Signal; empty: string }
const rowsOf = (rows: { key: string; cells: string[] }[]): Signal => ({ available: true, rows })
const NO_OPS = "This Mynt has no operations status (ops_status) to read."

const BACKUP_LABELS: Record<string, string> = {
  status: "Status",
  last_run_at: "Last run",
  ok: "Last run succeeded",
  last_success_at: "Last success",
  offsite: "Off-site copy",
  bytes: "Size (bytes)",
  error: "Error",
  verify: "Last restore test",
}
const OFFSITE: Record<string, string> = { uploaded: "Uploaded off-site", local_only: "On this server only", failed: "Upload failed" }
const backupValue = (k: string, v: unknown): string => {
  if (v === null || v === undefined) return "Not recorded"
  if (k === "offsite") return OFFSITE[String(v)] ?? String(v)
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (k.endsWith("_at") && typeof v === "string") return when(v)
  if (isObj(v)) return v.ok === true ? `Passed${str(v.at) ? ` ${when(str(v.at))}` : ""}` : v.ok === false ? `Failed${str(v.error) ? `: ${str(v.error)}` : ""}` : "Not recorded"
  return String(v)
}

// ops_status's attention lines start with what they're about ("hosting: …", "covenants: …").
const OPERATIONS_PREFIXES = ["builds:", "desk:", "reviews:", "explorers:", "connector:", "hosting:", "sandbox provider:"]
const FINANCIAL_PREFIXES = ["liquidity pools:", "treasury pools:"]
const COVENANT_PREFIXES = ["covenants:"]
const HEALTH_PREFIXES = ["product health:"]
function attentionLines(ops: Obj, prefixes: string[]): Signal {
  const lines = (ops.attention as unknown[]).filter((x): x is string => typeof x === "string")
  return rowsOf(lines.filter((l) => prefixes.some((p) => l.startsWith(p))).map((l, i) => ({ key: `l${i}`, cells: [l] })))
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
      { id: "pools", title: "Liquidity and treasury pools", description: "Flags on real money in pools, and treasuries Mynt stopped approving deposits to, from Mynt's operations status.", columns: ["What needs attention"], signal: attention(FINANCIAL_PREFIXES), empty: "No pool or treasury flags." },
    ]
  if (area === "compliance") {
    const apps = o && isObj(o.apps) ? o.apps : null
    const audits = o && isObj(o.agreement_audits) ? o.agreement_audits : null
    const missing = apps && Array.isArray(apps.production_without_program_agreements) ? apps.production_without_program_agreements.filter(isObj) : null
    return [
      {
        id: "agreements",
        title: "Agreements",
        description: "Production apps without a signed program agreement with a product's sponsor, and overdue oversight audits.",
        columns: ["App", "Issue", "Detail"],
        signal: !o
          ? none
          : missing === null && !audits
            ? unavailable("This Mynt doesn't report program agreements or oversight audits yet.")
            : rowsOf([
                ...(missing ?? []).map((a, i) => ({ key: `m${i}`, cells: [str(a.app_name) ?? str(a.app_id) ?? "App", "In production without a signed program agreement", `${num(a.missing) ?? "Some"} missing`] })),
                ...(audits && (num(audits.overdue) ?? 0) > 0 ? [{ key: "audits", cells: ["Oversight audits", "Overdue: past their due date and not closed", `${num(audits.overdue)} on ${num(audits.apps_flagged) ?? "?"} apps`] }] : []),
              ]),
        empty: "Every production app has its program agreements, and no oversight audit is overdue.",
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
        columns: ["Offering", "Issue", "When"],
        signal: !o
          ? none
          : !vendors || !Array.isArray(vendors.failed_conformance)
            ? unavailable("This Mynt doesn't report vendors' conformance runs yet.")
            : rowsOf(vendors.failed_conformance.filter(isObj).map((r, i) => ({ key: `v${i}`, cells: [str(r.offering) ?? str(r.offering_id) ?? "Offering", "Conformance run failed", when(str(r.created_at))] }))),
        empty: `No conformance run failed ${span}.`,
      },
    ]
  }
  if (area === "operations")
    return [
      { id: "operations", title: "Agents and hosting", description: `Builds, the product desk, reviews, explorations, the connector and hosting: failures and stuck runs ${span}, from Mynt's operations status.`, columns: ["What needs attention"], signal: attention(OPERATIONS_PREFIXES), empty: `No agent or hosting failures ${span}.` },
    ]
  if (area === "business_process" || area === "regulated_product") {
    const drift = unavailable("Mynt's operations status doesn't count drifted products across firms yet; each app's Security & risk tab shows its own.")
    return [
      { id: "covenants", title: "Covenants", description: "Products whose new sales a licence provider's covenant paused, open breaches, and rules that can't be measured.", columns: ["What needs attention"], signal: o && isObj(o.covenants) ? attentionLines(o, COVENANT_PREFIXES) : o ? unavailable("This Mynt doesn't report covenants yet.") : none, empty: "No products paused and no open breaches." },
      ...(area === "regulated_product"
        ? [{ id: "product-health", title: "Product health", description: "Product health records stalled against the chain, or snapshots past their deadline.", columns: ["What needs attention"] as const, signal: o && isObj(o.product_health) ? attentionLines(o, HEALTH_PREFIXES) : o ? unavailable("This Mynt doesn't report product health yet.") : none, empty: "Every product health record is on time." }]
        : []),
      { id: "drift", title: "Drifted products", description: "Products that drifted from their published composition (new sales paused until fixed).", columns: ["Product", "Detail"], signal: drift, empty: "No product has drifted." },
    ]
  }
  // technology
  const backups = o && isObj(o.backups) ? o.backups : null
  return [
    { id: "security", title: `Security events in the last ${SECURITY_DAYS} days`, description: "Audit trail entries of the security class: build audits, the mainnet gate, secrets revealed or rotated, machine access, people cut off.", columns: ["When", "Action", "Actor", "Target"], signal: securityEventsFrom(auditEntries, now), empty: `No security events in the last ${SECURITY_DAYS} days among the newest audit entries.` },
    {
      id: "backups",
      title: "Backups",
      description: "The server's backups: the last run, the off-site copy and the last restore test.",
      columns: ["Backup", "Value"],
      signal: !o ? none : !backups ? unavailable("This Mynt doesn't report its backups.") : rowsOf(Object.entries(backups).filter(([k]) => k !== "local").map(([k, v]) => ({ key: k, cells: [BACKUP_LABELS[k] ?? words(k), backupValue(k, v)] }))),
      empty: "Nothing recorded.",
    },
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
