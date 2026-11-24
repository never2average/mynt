// The platform admin's Security & risk (/platform/risks): Mynt's own risk register (risk_register with subject
// "platform", kept and read by Mynt admins only), and the platform's signals, each a table or "Not available." with
// why (never an empty table, or 0, for something Mynt didn't measure):
// - what needs attention (ops_status's attention lines),
// - security events in the last 30 days (audit_log's entries of class security),
// - open risks across every app and product (admin_list_risks: counts by level, and the 20 highest scored, each
//   linked to its workspace's or firm's page in the platform admin),
// - agreements (ops_status: production apps without a signed program agreement, overdue oversight audits),
// - vendors' failed conformance runs (ops_status), and backups (ops_status: off-site copy, last run, restore test).
// Pure, for the route, the views and the tests.

import { adminHref, words } from "./admin"
import type { AuditEntry } from "./admin-audit"
import { actionLabel, actorWords, whenWords } from "./admin-audit"
import { peopleFrom } from "./people"
import { RISK_LEVEL_LABELS, riskLevel, unavailable, type RiskRegister, type Signal, type Unavailable } from "./risk-register"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export const PLATFORM_SUBJECT = { type: "platform", id: "mynt" } as const
export const SECURITY_DAYS = 30
export const TOP_RISKS = 20
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—")

// ---- open risks across apps and products (admin_list_risks) ----

export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]
export type CrossRisk = {
  id: string
  title: string
  subjectType: "app" | "product" | "platform"
  subjectName: string | null
  href: string | null // where it lives in the platform admin: the app's workspace, the product's firm (its Products tab)
  score: number
  level: RiskLevel
  status: string
  reviewBy: string | null
  overdue: boolean
}
export type CrossRisks = { available: true; counts: Record<RiskLevel, number>; overdue: number; total: number; risks: CrossRisk[] } | Unavailable

export function crossRisksFrom(reply: unknown): CrossRisks {
  if (!isObj(reply) || !Array.isArray(reply.risks)) return unavailable("Mynt didn't answer with the risks across apps and products.")
  const c = isObj(reply.counts) ? reply.counts : {}
  const risks = reply.risks.filter(isObj).flatMap((r): CrossRisk[] => {
    const id = str(r.id)
    const title = str(r.title)
    const type = r.subject_type === "app" || r.subject_type === "product" || r.subject_type === "platform" ? r.subject_type : null
    if (!id || !title || !type) return []
    const score = num(r.score) ?? (num(r.likelihood) ?? 0) * (num(r.impact) ?? 0)
    const ws = str(r.workspace_id)
    const firm = str(r.firm_id)
    const href = type === "app" && ws ? adminHref("workspaces", ws) : type === "product" && firm ? `${adminHref("firms", firm)}?tab=products` : type === "platform" ? adminHref("risks") : null
    return [{ id, title, subjectType: type, subjectName: str(r.subject_name), href, score, level: riskLevel(score) as RiskLevel, status: str(r.status) ?? "open", reviewBy: str(r.review_by), overdue: r.overdue === true }]
  })
  return {
    available: true,
    counts: { critical: num(c.critical) ?? 0, high: num(c.high) ?? 0, medium: num(c.medium) ?? 0, low: num(c.low) ?? 0 },
    overdue: num(reply.overdue) ?? risks.filter((r) => r.overdue).length,
    total: num(reply.total) ?? risks.length,
    risks,
  }
}
export const levelWords = (l: RiskLevel) => RISK_LEVEL_LABELS[l]
export const subjectWords = (r: CrossRisk) => `${r.subjectType === "app" ? "App" : r.subjectType === "product" ? "Financial product" : "Mynt"}: ${r.subjectName ?? "Unnamed"}`

// ---- signals from ops_status ----

export type PlatformSignals = { attention: Signal; agreements: Signal; vendors: Signal; backups: Signal; windowHours: number | null }
const rowsOf = (rows: { key: string; cells: string[] }[]): Signal => ({ available: true, rows })

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

export function platformSignalsFrom(ops: unknown): PlatformSignals {
  if (!isObj(ops) || !Array.isArray(ops.attention)) {
    const none = unavailable("This Mynt has no operations status (ops_status) to read.")
    return { attention: none, agreements: none, vendors: none, backups: none, windowHours: null }
  }
  const lines = ops.attention.filter((x): x is string => typeof x === "string")
  const quiet = lines.length === 1 && lines[0] === "Nothing needs attention"
  const apps = isObj(ops.apps) ? ops.apps : null
  const audits = isObj(ops.agreement_audits) ? ops.agreement_audits : null
  const vendors = isObj(ops.vendors) ? ops.vendors : null
  const backups = isObj(ops.backups) ? ops.backups : null
  const missing = apps && Array.isArray(apps.production_without_program_agreements) ? apps.production_without_program_agreements.filter(isObj) : null
  return {
    windowHours: num(ops.window_hours),
    attention: rowsOf(quiet ? [] : lines.map((l, i) => ({ key: `a${i}`, cells: [l] }))),
    agreements:
      missing === null && !audits
        ? unavailable("This Mynt doesn't report program agreements or oversight audits yet.")
        : rowsOf([
            ...(missing ?? []).map((a, i) => ({ key: `m${i}`, cells: [str(a.app_name) ?? str(a.app_id) ?? "App", "In production without a signed program agreement", `${num(a.missing) ?? "Some"} missing`] })),
            ...(audits && (num(audits.overdue) ?? 0) > 0 ? [{ key: "audits", cells: ["Oversight audits", "Overdue: past their due date and not closed", `${num(audits.overdue)} on ${num(audits.apps_flagged) ?? "?"} apps`] }] : []),
          ]),
    vendors:
      !vendors || !Array.isArray(vendors.failed_conformance)
        ? unavailable("This Mynt doesn't report vendors' conformance runs yet.")
        : rowsOf(vendors.failed_conformance.filter(isObj).map((r, i) => ({ key: `v${i}`, cells: [str(r.offering) ?? str(r.offering_id) ?? "Offering", "Conformance run failed", when(str(r.created_at))] }))),
    backups: !backups
      ? unavailable("This Mynt doesn't report its backups.")
      : rowsOf(Object.entries(backups).filter(([k]) => k !== "local").map(([k, v]) => ({ key: k, cells: [BACKUP_LABELS[k] ?? words(k), backupValue(k, v)] }))),
  }
}

// ---- security events (audit_log, class security, the last 30 days) ----

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
export const SECURITY_COLUMNS = ["When", "Action", "Actor", "Target"] as const
export const ATTENTION_COLUMNS = ["What needs attention"] as const
export const AGREEMENT_COLUMNS = ["App", "Issue", "Detail"] as const
export const VENDOR_COLUMNS = ["Offering", "Issue", "When"] as const
export const BACKUP_COLUMNS = ["Backup", "Value"] as const

export type RisksData = { register: RiskRegister | Unavailable; cross: CrossRisks; signals: PlatformSignals; security: Signal }

/** The register's owner choices: Mynt admins who have signed in (list_whitelist). */
export function adminOwnersFrom(whitelist: unknown): { userId: string; name: string }[] {
  return (peopleFrom(whitelist)?.people ?? []).filter((p) => p.status === "signed_in" && p.userId && p.roles.includes("admin")).map((p) => ({ userId: p.userId!, name: p.name ?? p.email ?? "Mynt admin" }))
}
