// The platform admin's Audit trails (/platform/audit): Mynt's own audit log across every workspace and firm, from
// the admin tool audit_log (newest first, at most 500 entries; it takes no other filter and no cursor, so the
// section filters, searches and pages the entries it fetched, here, and says how many that is). Each entry is an
// action, its target, who did it and when, its details, and its class (security, financial, obligations or workspace:
// core/src/audit-classes.ts), which Mynt sends with it. Pure, for the route, the views and the tests.
//
// Secrets are never in Mynt's audit log; as a second guard, a detail whose name reads like one (secret, token, key,
// password…) is shown as "Hidden", never its value.

import { AUDIT_CLASSES, AUDIT_CLASS_LABELS, type AuditClass } from "./audit-classes"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

export const AUDIT_LIMIT = 500
export const RELATED_LIMIT = 50
export const AUDIT_ID = /^[A-Za-z0-9-]{1,100}$/

export { AUDIT_CLASSES, AUDIT_CLASS_LABELS, type AuditClass }

// What a target is. Mynt's audit log doesn't record it: it's read from the action's words and the target's shape.
export const TARGET_TYPES = ["workspace", "app", "product", "firm", "licence", "person", "vendor", "pool", "program", "setting", "other"] as const
export type TargetType = (typeof TARGET_TYPES)[number]
export const TARGET_TYPE_LABELS: Record<TargetType, string> = {
  workspace: "Workspace",
  app: "App",
  product: "Financial product",
  firm: "Firm",
  licence: "Licence",
  person: "Person",
  vendor: "Vendor service",
  pool: "Liquidity pool",
  program: "On-chain program",
  setting: "Setting",
  other: "Other",
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export function targetTypeOf(action: string, target: string): TargetType {
  if (EMAIL.test(target)) return "person"
  const a = action.toLowerCase()
  const has = (...w: string[]) => w.some((x) => a.includes(x))
  if (has("workspace", "member_role", "invite_to")) return "workspace"
  if (has("licen", "sponsor")) return "licence"
  if (has("entity", "firm")) return "firm"
  if (has("pool", "treasury", "commit_to")) return "pool"
  if (has("program", "mainnet", "solana")) return "program"
  if (has("vendor", "offering", "service_type", "subscription")) return "vendor"
  if (has("product", "composition")) return "product"
  if (has("app", "build", "hosting", "deploy", "tenant", "promotion", "release")) return "app"
  if (has("setting", "signup", "esign", "take_rate", "region", "regulator", "legislation")) return "setting"
  if (has("user", "admin")) return "person"
  return "other"
}

// A detail whose name reads like a secret is never shown.
const SECRETISH = /(secret|token|password|passphrase|api_?key|private|seed|credential|mnemonic|signature)/i
const detailValue = (v: unknown): string => (v === null || v === undefined ? "—" : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v))
export function detailPairs(details: unknown): [string, string][] {
  if (!isObj(details)) return str(details) ? [["Details", String(details)]] : []
  return Object.entries(details).map(([k, v]) => [k, SECRETISH.test(k) ? "Hidden" : detailValue(v)])
}

export type AuditEntry = {
  id: string
  at: string
  action: string
  class: AuditClass | null // null: an older Mynt that doesn't send it
  actor: { id: string | null; email: string | null }
  target: string
  targetType: TargetType
  workspace: { id: string; name: string | null } | null
  firm: { id: string; name: string | null } | null
  details: [string, string][]
}

export type AuditNames = { workspaces: Record<string, string>; firms: Record<string, string> }
export const NO_NAMES: AuditNames = { workspaces: {}, firms: {} }

/** audit_log's answer (a list), with the workspaces' and firms' names where Mynt gave them; null when it isn't one. */
export function auditEntriesFrom(reply: unknown, names: AuditNames = NO_NAMES): AuditEntry[] | null {
  if (!Array.isArray(reply)) return null
  return reply.filter(isObj).flatMap((e): AuditEntry[] => {
    const id = str(e.id)
    const at = str(e.created_at)
    const action = str(e.action)
    if (!id || !at || !action) return []
    const target = String(e.target ?? "")
    const d = isObj(e.details) ? e.details : {}
    const targetType = targetTypeOf(action, target)
    const wsId = str(d.workspace_id) ?? (targetType === "workspace" ? str(target) : null)
    const firmId = str(d.entity_id) ?? str(d.firm_id) ?? (targetType === "firm" ? str(target) : null)
    return [
      {
        id,
        at,
        action,
        class: AUDIT_CLASSES.includes(e.class as AuditClass) ? (e.class as AuditClass) : null,
        actor: { id: str(e.actor_id), email: str(e.actor_email) },
        target,
        targetType,
        workspace: wsId ? { id: wsId, name: names.workspaces[wsId] ?? null } : null,
        firm: firmId ? { id: firmId, name: names.firms[firmId] ?? str(d.entity) ?? null } : null,
        details: detailPairs(e.details),
      },
    ]
  })
}

/** An action in words: "revoke_user" is "Revoke user". */
export const actionLabel = (action: string) => {
  const s = action.replace(/_/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—"
}
export const classLabel = (c: AuditClass | null) => (c ? AUDIT_CLASS_LABELS[c] : "Not classified")
export const actorWords = (e: AuditEntry) => e.actor.email ?? (e.actor.id ? e.actor.id : "Mynt")
export const placeWords = (e: AuditEntry) =>
  [e.workspace ? `Workspace: ${e.workspace.name ?? e.workspace.id}` : null, e.firm ? `Firm: ${e.firm.name ?? e.firm.id}` : null].filter(Boolean).join(" · ") || "—"
/** A short line of the details, for the table (the detail page has them all). */
export const detailsShort = (e: AuditEntry, max = 80) => {
  const s = e.details.map(([k, v]) => `${k}: ${v}`).join(", ")
  return s ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : "—"
}
export const whenWords = (iso: string) => iso.slice(0, 16).replace("T", " ")

// ---- filters ----

export type AuditFilters = { query: string; action: string[]; class: string[]; actor: string[]; workspace: string[]; firm: string[]; targetType: string[]; from: string; to: string }
export const NO_AUDIT_FILTERS: AuditFilters = { query: "", action: [], class: [], actor: [], workspace: [], firm: [], targetType: [], from: "", to: "" }

const any = (picks: string[], v: string | null) => !picks.length || (v !== null && picks.includes(v))

export function filterAudit(entries: AuditEntry[], f: AuditFilters): AuditEntry[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((e) => {
    const day = e.at.slice(0, 10)
    if (f.from && day < f.from) return false
    if (f.to && day > f.to) return false
    if (!any(f.action, e.action) || !any(f.class, e.class) || !any(f.actor, actorWords(e)) || !any(f.workspace, e.workspace?.id ?? null) || !any(f.firm, e.firm?.id ?? null) || !any(f.targetType, e.targetType)) return false
    if (!words.length) return true
    const text = [e.action, actionLabel(e.action), classLabel(e.class), actorWords(e), e.target, placeWords(e), ...e.details.flat()].join(" ").toLowerCase()
    return words.every((w) => text.includes(w))
  })
}

type Option = { value: string; label: string }
const sorted = (m: Map<string, string>): Option[] => [...m].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))

/** The Filters popover's choices, from the entries fetched (only what's there). */
export function auditFacetOptions(entries: AuditEntry[]): Record<"action" | "class" | "actor" | "workspace" | "firm" | "targetType", Option[]> {
  const action = new Map<string, string>()
  const actor = new Map<string, string>()
  const workspace = new Map<string, string>()
  const firm = new Map<string, string>()
  const types = new Set<TargetType>()
  for (const e of entries) {
    action.set(e.action, actionLabel(e.action))
    actor.set(actorWords(e), actorWords(e))
    if (e.workspace) workspace.set(e.workspace.id, e.workspace.name ?? e.workspace.id)
    if (e.firm) firm.set(e.firm.id, e.firm.name ?? e.firm.id)
    types.add(e.targetType)
  }
  return {
    action: sorted(action),
    class: AUDIT_CLASSES.map((c) => ({ value: c, label: AUDIT_CLASS_LABELS[c] })),
    actor: sorted(actor),
    workspace: sorted(workspace),
    firm: sorted(firm),
    targetType: TARGET_TYPES.filter((t) => types.has(t)).map((t) => ({ value: t, label: TARGET_TYPE_LABELS[t] })),
  }
}

/** The other entries about the same target, newest first, at most 50. */
export const relatedEntries = (entries: AuditEntry[], entry: AuditEntry) => entries.filter((e) => e.id !== entry.id && e.target === entry.target && entry.target !== "").slice(0, RELATED_LIMIT)

export const AUDIT_CSV_HEAD = ["When", "Action", "Class", "Actor", "Workspace", "Firm", "Target type", "Target", "Details", "Id"]
export const auditCsvRow = (e: AuditEntry) => [e.at, actionLabel(e.action), classLabel(e.class), actorWords(e), e.workspace?.name ?? e.workspace?.id ?? "", e.firm?.name ?? e.firm?.id ?? "", TARGET_TYPE_LABELS[e.targetType], e.target, e.details.map(([k, v]) => `${k}: ${v}`).join("; "), e.id]

// ---- the section's two views ----
//
// Audit trails has two tabs, the tab in the address: the audit log (the default) and Production reviews
// (?tab=reviews): every workspace's production code reviews (lib/production-reviews.ts), which belong beside the
// audit log because each one, and each exception to one, is a record of what Mynt checked before a build went live.
export const AUDIT_VIEWS = ["log", "reviews"] as const;
export type AuditView = (typeof AUDIT_VIEWS)[number];
export const AUDIT_VIEW_LABELS: Record<AuditView, string> = { log: "Audit log", reviews: "Production reviews" };
export const auditViewOf = (v: unknown): AuditView => (v === "reviews" ? "reviews" : "log");
export const auditHref = (view: AuditView, id?: string) => `/platform/audit${id ? `/${encodeURIComponent(id)}` : ""}${view === "reviews" ? "?tab=reviews" : ""}`;
