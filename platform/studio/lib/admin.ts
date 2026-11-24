// The platform admin (/platform), for Mynt's own staff: its sections, and what each shows of Mynt's admin tools'
// answers. Every list is platform-wide (all workspaces, all firms), never scoped to a workspace picked in the studio. Pure, for
// the routes, the views and the tests. A figure Mynt didn't measure is null here and "Not measured" on screen, never 0.

export const ADMIN_TABS = ["overview", "workspaces", "firms", "licences", "vendors", "audit", "risks", "settings"] as const
export type AdminTab = (typeof ADMIN_TABS)[number]
export const ADMIN_TAB_LABELS: Record<AdminTab, string> = {
  overview: "Overview",
  workspaces: "Workspaces",
  firms: "Firms",
  licences: "Licences",
  vendors: "Vendors",
  audit: "Audit trails",
  risks: "Security & risk",
  settings: "Platform settings",
}
// A section that isn't one (an old address's apps, people or products, which the platform admin no longer has) is the Overview.
export const adminTabOf = (v: unknown): AdminTab => (ADMIN_TABS.includes(v as AdminTab) ? (v as AdminTab) : "overview")

// Where it lives: its own base path and layout (app/(platform)), never inside the studio's shell. Overview is
// /platform, each other section /platform/<section>, and a row opened in Workspaces, Firms or Audit trails
// /platform/<section>/<id>. People are each firm's and each workspace's Members, not a section of their own.
export const PLATFORM_BASE = "/platform"
export const PLATFORM_NAME = "Mynt platform admin"
// The sections whose rows open a detail page.
export const ADMIN_DETAIL_TABS: readonly AdminTab[] = ["workspaces", "firms", "audit"]
// An id in the address: letters, digits and dashes (Mynt's uuids), nothing that could leave the path.
export const ADMIN_ID = /^[A-Za-z0-9-]{1,100}$/
/** Whether an id may be opened in a section: a detail section, and an id of its kind. */
export const adminIdOk = (tab: AdminTab, id: string) => ADMIN_DETAIL_TABS.includes(tab) && ADMIN_ID.test(id)
export const adminHref = (tab: AdminTab, id?: string) =>
  tab === "overview" ? PLATFORM_BASE : `${PLATFORM_BASE}/${tab}${id ? `/${encodeURIComponent(id)}` : ""}`
export const isPlatformPath = (pathname: string) => pathname === PLATFORM_BASE || pathname.startsWith(`${PLATFORM_BASE}/`)

/** The section and item a /platform address shows; null when it isn't one (the page answers 404). */
export function platformRouteOf(pathname: string): { tab: AdminTab; id: string | null } | null {
  if (!isPlatformPath(pathname)) return null
  const [section, id, ...rest] = pathname.slice(PLATFORM_BASE.length).split("/").filter(Boolean)
  if (section === undefined) return { tab: "overview", id: null }
  if (section === "overview" || !ADMIN_TABS.includes(section as AdminTab) || rest.length) return null
  const tab = section as AdminTab
  if (id === undefined) return { tab, id: null }
  return adminIdOk(tab, id) ? { tab, id } : null
}

/** The header's and the tab's title for a /platform address: the section's name, or the platform admin's own. */
export function platformTitle(pathname: string): string {
  const route = platformRouteOf(pathname)
  return route && route.tab !== "overview" ? ADMIN_TAB_LABELS[route.tab] : PLATFORM_NAME
}

export const NOT_MEASURED = "Not measured"

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === "string")
const count = (v: unknown): number => (Array.isArray(v) ? v.length : (num(v) ?? 0))
export const dateOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")
export const whenOf = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—")
export const words = (s: string | null) => (s ? s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : "—")

// ---- Overview: ops_status ----

export type OpsAgent = { name: string; label: string; failed: number; stuck: number; spend: number | null; measured: boolean }
export type OpsSection = { id: string; title: string; rows: { label: string; value: string }[] }
export type Ops = { attention: string[]; quiet: boolean; windowHours: number; agents: OpsAgent[]; sections: OpsSection[] }

// The agents ops_status reports on; one whose table this server doesn't have isn't measured.
const AGENTS: [string, string][] = [
  ["builds", "Coding agents (builds)"],
  ["desk", "Product desk"],
  ["explorers", "Algorithm explorers"],
  ["reviews", "Governance reviews"],
  ["connector", "Business-development connector"],
]
const yesNo = (v: unknown) => (v ? "Yes" : "No")
const counts = (v: unknown) => (isObj(v) ? Object.entries(v).map(([k, n]) => `${words(k)}: ${num(n) ?? "?"}`).join(", ") || "None" : NOT_MEASURED)

export function opsFrom(reply: unknown): Ops | null {
  if (!isObj(reply) || !Array.isArray(reply.attention)) return null
  const attention = strs(reply.attention)
  const quiet = attention.length === 1 && attention[0] === "Nothing needs attention"
  const agentsIn = isObj(reply.agents) ? reply.agents : {}
  const agents: OpsAgent[] = AGENTS.map(([name, label]) => {
    const a = agentsIn[name]
    if (!isObj(a)) return { name, label, failed: 0, stuck: 0, spend: null, measured: false }
    return { name, label, failed: count(a.failures), stuck: count(a.stuck), spend: num(a.spend_this_month_usd), measured: true }
  })
  const h = isObj(reply.hosting) ? reply.hosting : null
  const v = isObj(reply.vendors) ? reply.vendors : {}
  const s = isObj(reply.solana) ? reply.solana : {}
  const ph = isObj(reply.product_health) ? reply.product_health : {}
  const c = isObj(reply.covenants) ? reply.covenants : {}
  const w = isObj(reply.workspaces) ? reply.workspaces : {}
  const apps = isObj(reply.apps) ? reply.apps : {}
  const b = isObj(reply.backups) ? reply.backups : {}
  const sections: OpsSection[] = [
    {
      id: "hosting",
      title: "Hosting",
      rows: h
        ? [
            { label: "VMs by status", value: "tenants" in h ? counts(h.tenants) : NOT_MEASURED },
            { label: "VMs that failed to provision", value: "failed_tenants" in h ? String(count(h.failed_tenants)) : NOT_MEASURED },
            { label: "Hosted apps by status", value: "apps" in h ? counts(h.apps) : NOT_MEASURED },
            { label: "Apps stopped", value: "stopped_apps" in h ? String(count(h.stopped_apps)) : NOT_MEASURED },
            { label: "Deploys running over 45 min", value: "stuck_deploys" in h ? String(count(h.stuck_deploys)) : NOT_MEASURED },
          ]
        : [{ label: "Hosting", value: NOT_MEASURED }],
    },
    {
      id: "vendors",
      title: "Vendors",
      rows: [
        { label: "Conformance runs failed in the window", value: String(count(v.failed_conformance)) },
        { label: "Subscriptions whose calls mostly fail", value: String(count(v.erroring_subscriptions)) },
        { label: "Service types named as moving money but declared not to", value: strs(v.money_name_mismatches).join(", ") || "None" },
      ],
    },
    {
      id: "solana",
      title: "Solana",
      rows: [
        { label: "Mainnet programs flagged by the vulnerability database", value: String(count(s.flagged_programs)) },
        { label: "Mainnet reviews awaiting approval", value: String(count(s.reviews_awaiting_approval)) },
      ],
    },
    {
      id: "product-health",
      title: "Product health",
      rows: [
        { label: "Sponsored products", value: String(count(ph.sponsored_products)) },
        { label: "Records stalled against the chain", value: String(count(ph.stalled)) },
        { label: "Snapshots past their deadline", value: String(count(ph.overdue)) },
        { label: "Worker last ran", value: whenOf(str(ph.worker_last_ran)) === "—" ? "Never" : whenOf(str(ph.worker_last_ran)) },
      ],
    },
    {
      id: "covenants",
      title: "Covenants",
      rows: [
        { label: "Active rules", value: String(count(c.active_rules)) },
        { label: "Products paused by a licence provider's rule", value: String(count(c.paused_products)) },
        { label: "Open breaches on live figures", value: String(count(c.open_breaches)) },
        { label: "Open breaches in sandboxes", value: String(count(c.open_sandbox_breaches)) },
        { label: "Rules unknown past their limit", value: String(count(c.unknown_too_long)) },
        { label: "Firm webhooks blocked", value: String(count(c.blocked_webhooks)) },
      ],
    },
    {
      id: "workspaces",
      title: "Workspaces",
      rows: [
        { label: "Offboardings that gave up", value: String(count(w.failed_offboards)) },
        { label: "Frozen (organization deleted in the identity provider)", value: String(count(w.org_missing)) },
        { label: "Part-way through getting an organization", value: String(count(w.org_backfill_pending)) },
        { label: "Organization reconcile stopped itself", value: yesNo(isObj(w.org_sync) && w.org_sync.halted_at) },
      ],
    },
    {
      id: "agreements",
      title: "Agreements",
      rows: [
        { label: "Production apps without a signed program agreement in force", value: String(count(apps.production_without_program_agreements)) },
        // Oversight audits licence providers run under program agreements: past due and not closed (agreement-audits.ts).
        { label: "Oversight audits overdue", value: isObj(reply.agreement_audits) ? String(count(reply.agreement_audits.overdue)) : NOT_MEASURED },
        { label: "Apps with an overdue oversight audit", value: isObj(reply.agreement_audits) ? String(count(reply.agreement_audits.apps_flagged)) : NOT_MEASURED },
      ],
    },
    {
      id: "risks",
      title: "Risk registers",
      rows: [
        // Apps' and products' risks whose review date passed and that aren't closed (risk-register.ts).
        { label: "Risk reviews overdue", value: isObj(reply.risks) ? String(count(reply.risks.overdue_reviews)) : NOT_MEASURED },
      ],
    },
    {
      id: "backups",
      title: "Backups",
      rows: Object.entries(b).map(([k, x]) => ({ label: words(k), value: typeof x === "string" || typeof x === "number" || typeof x === "boolean" ? String(x) : x === null ? "—" : "See ops_status" })),
    },
  ]
  return { attention, quiet, windowHours: num(reply.window_hours) ?? 24, agents, sections }
}

// ---- Platform settings ----

export type PlatformSetting = { key: string; value: string; default: string; source: "environment" | "default"; description: string }
export function settingsFrom(reply: unknown): PlatformSetting[] | null {
  if (!isObj(reply) || !Array.isArray(reply.settings)) return null
  return reply.settings.filter(isObj).map((s) => ({
    key: String(s.key ?? ""),
    value: String(s.value ?? ""),
    default: String(s.default ?? ""),
    source: s.source === "environment" ? "environment" : "default",
    description: String(s.description ?? ""),
  }))
}

// ---- Workspaces and products across Mynt (list_all_workspaces, list_all_products; a workspace's apps from admin_get_workspace) ----

export type Person = { id: string; name: string | null; email: string | null }
const person = (v: unknown): Person | null => (isObj(v) && str(v.id) ? { id: String(v.id), name: str(v.name), email: str(v.email) } : null)
export type Paged<T> = { rows: T[]; total: number }

export type AdminWorkspace = { id: string; name: string; personal: boolean; status: string; owner: Person | null; members: number; apps: number; createdAt: string | null }
const workspaceOf = (w: Obj): AdminWorkspace => ({
  id: String(w.id),
  name: String(w.name ?? w.id),
  personal: w.personal === true,
  status: str(w.status) ?? "active",
  owner: person(w.owner),
  members: num(w.members) ?? 0,
  apps: num(w.apps) ?? 0,
  createdAt: str(w.created_at),
})
export function workspacesFrom(reply: unknown): Paged<AdminWorkspace> | null {
  if (!isObj(reply) || !Array.isArray(reply.workspaces)) return null
  return { rows: reply.workspaces.filter(isObj).map(workspaceOf), total: num(reply.total) ?? reply.workspaces.length }
}

export type AdminBuild = { id: string; status: string; createdAt: string | null }
export type AdminApp = {
  id: string
  name: string
  status: string
  stage: string
  workspace: { id: string; name: string | null } | null
  owner: Person | null
  productIds: string[]
  latestBuild: AdminBuild | null
  builds: number | null
  hosting: { status: string; updatedAt: string | null } | null
  createdAt: string | null
}
const appOf = (a: Obj): AdminApp => {
  const b = isObj(a.latest_build) ? a.latest_build : null
  const h = isObj(a.hosting) ? a.hosting : null
  const w = isObj(a.workspace) ? a.workspace : null
  return {
    id: String(a.id),
    name: String(a.name ?? a.id),
    status: str(a.status) ?? "draft",
    stage: str(a.stage) ?? "idea",
    workspace: w && str(w.id) ? { id: String(w.id), name: str(w.name) } : null,
    owner: person(a.owner),
    productIds: strs(a.product_ids),
    latestBuild: b ? { id: String(b.id), status: String(b.status), createdAt: str(b.created_at) } : null,
    builds: num(a.builds),
    hosting: h ? { status: String(h.status), updatedAt: str(h.updated_at) } : null,
    createdAt: str(a.created_at),
  }
}
export type WorkspaceMember = { userId: string; name: string | null; email: string | null; role: string; joinedAt: string | null }
export type WorkspaceInvitation = { id: string; email: string; role: string; myntRole: string; status: string; invitedBy: string | null; createdAt: string | null }
export type ActivityEvent = { id: string; action: string; target: string; actor: string | null; createdAt: string | null }
export type WorkspaceDetail = { workspace: AdminWorkspace; members: WorkspaceMember[]; apps: AdminApp[]; invitations: WorkspaceInvitation[]; activity: ActivityEvent[] }
const activityOf = (e: Obj): ActivityEvent => ({ id: String(e.id ?? ""), action: String(e.action ?? ""), target: String(e.target ?? ""), actor: str(e.actor), createdAt: str(e.created_at) })
export function workspaceDetailFrom(reply: unknown): WorkspaceDetail | null {
  if (!isObj(reply) || !isObj(reply.workspace)) return null
  return {
    workspace: workspaceOf(reply.workspace),
    members: arr(reply.members).filter(isObj).map((m) => ({ userId: String(m.user_id), name: str(m.name), email: str(m.email), role: String(m.role ?? "member"), joinedAt: str(m.joined_at) })),
    apps: arr(reply.apps).filter(isObj).map(appOf),
    invitations: arr(reply.invitations)
      .filter(isObj)
      .map((i) => ({ id: String(i.id), email: String(i.email ?? ""), role: String(i.role ?? "member"), myntRole: String(i.mynt_role ?? "developer"), status: String(i.status ?? "open"), invitedBy: str(i.invited_by), createdAt: str(i.created_at) })),
    activity: arr(reply.activity).filter(isObj).map(activityOf),
  }
}

export type AdminProduct = {
  id: string
  name: string
  productLine: string | null
  region: string | null
  status: string
  stage: string
  archived: boolean
  firm: { id: string; name: string } | null
  sponsors: { entityId: string; name: string; status: string }[]
  createdAt: string | null
}
export function productsFrom(reply: unknown): Paged<AdminProduct> | null {
  if (!isObj(reply) || !Array.isArray(reply.products)) return null
  return {
    rows: reply.products.filter(isObj).map((p) => ({
      id: String(p.id),
      name: String(p.name ?? p.id),
      productLine: str(p.product_line),
      region: str(p.region),
      status: str(p.status) ?? "draft",
      stage: str(p.stage) ?? "idea",
      archived: p.archived === true,
      firm: isObj(p.firm) && str(p.firm.id) ? { id: String(p.firm.id), name: String(p.firm.name ?? p.firm.id) } : null,
      sponsors: arr(p.sponsors).filter(isObj).map((s) => ({ entityId: String(s.entity_id), name: String(s.name ?? s.entity_id), status: String(s.status ?? "") })),
      createdAt: str(p.created_at),
    })),
    total: num(reply.total) ?? reply.products.length,
  }
}

// ---- Firms (list_entities) and licences (list_license_reviews) ----

export const FIRM_TYPES = ["license_provider", "vendor", "liquidity_provider", "builder"] as const
export type FirmType = (typeof FIRM_TYPES)[number]
export const FIRM_TYPE_LABELS: Record<FirmType, string> = { license_provider: "Licence provider", vendor: "Vendor", liquidity_provider: "Liquidity provider", builder: "Innovator" }
export type FirmMember = { id: string; name: string | null; email: string | null; roles: string[] }
export type AdminLicence = {
  id: string
  entityId: string
  firm: string | null
  region: string
  regulator: string
  licenceType: string
  jurisdiction: string | null
  number: string | null
  validFrom: string | null
  validTo: string | null
  status: string
  reviewNote: string | null
  createdAt: string | null
}
export type Firm = { id: string; name: string; status: string; legalForm: string | null; country: string | null; regions: string[]; members: FirmMember[]; licences: AdminLicence[]; types: FirmType[]; createdAt: string | null }

// What a firm is, from its members' roles (a firm with nobody in it yet is none of them).
export function firmTypes(members: FirmMember[]): FirmType[] {
  const roles = new Set(members.flatMap((m) => m.roles))
  return FIRM_TYPES.filter((t) => (t === "builder" ? roles.has("developer") || roles.has("innovator") : roles.has(t)))
}

const licenceOf = (l: Obj, firm: string | null = null): AdminLicence => ({
  id: String(l.id),
  entityId: String(l.entity_id ?? ""),
  firm: str(l.entity) ?? firm,
  region: String(l.region ?? ""),
  regulator: String(l.regulator_id ?? ""),
  licenceType: String(l.license_id ?? ""),
  jurisdiction: str(l.jurisdiction),
  number: str(l.registration_number),
  validFrom: str(l.valid_from),
  validTo: str(l.valid_to),
  status: str(l.status) ?? "pending",
  reviewNote: str(l.review_note),
  createdAt: str(l.created_at),
})

export function firmsFrom(reply: unknown): Firm[] | null {
  if (!Array.isArray(reply)) return null
  return reply.filter(isObj).map((e) => {
    const members = arr(e.members).filter(isObj).map((m) => ({ id: String(m.id), name: str(m.name), email: str(m.email), roles: strs(m.roles) }))
    const inc = isObj(e.incorporation) ? e.incorporation : null
    return {
      id: String(e.id),
      name: String(e.name ?? e.id),
      status: str(e.status) ?? "active",
      legalForm: str(e.legal_form),
      country: inc ? str(inc.country) : null,
      regions: strs(e.regions),
      members,
      licences: arr(e.licenses).filter(isObj).map((l) => licenceOf(l, String(e.name ?? ""))),
      types: firmTypes(members),
      createdAt: str(e.created_at),
    }
  })
}

export function licencesFrom(reply: unknown): AdminLicence[] | null {
  return Array.isArray(reply) ? reply.filter(isObj).map((l) => licenceOf(l)) : null
}

// ---- Vendors (list_service_types, list_vendor_offerings with include_unlisted) ----

export type ServiceTypeRow = { region: string; key: string; name: string; category: string; description: string; consentPurpose: string; movesMoney: boolean; fills: string[]; updatedAt: string | null }
export function serviceTypesFrom(reply: unknown): ServiceTypeRow[] | null {
  if (!Array.isArray(reply)) return null
  return reply.filter(isObj).map((t) => ({
    region: String(t.region ?? ""),
    key: String(t.key ?? ""),
    name: String(t.name ?? t.key ?? ""),
    category: String(t.category ?? "other"),
    description: String(t.description ?? ""),
    consentPurpose: String(t.consent_purpose ?? ""),
    movesMoney: t.moves_money !== false,
    fills: strs(t.fills),
    updatedAt: str(t.updated_at),
  }))
}

export type AdminOffering = { id: string; name: string; vendor: string; vendorEntityId: string; region: string; serviceKey: string; serviceName: string; category: string; status: string; conformance: { passed: boolean; at: string | null } | null; liveAvailable: boolean }
export function adminOfferingsFrom(reply: unknown): AdminOffering[] | null {
  if (!Array.isArray(reply)) return null
  return reply.filter(isObj).map((o) => {
    const t = isObj(o.service_type) ? o.service_type : {}
    const c = isObj(o.conformance) ? o.conformance : null
    return {
      id: String(o.offering_id ?? o.id),
      name: String(o.name ?? ""),
      vendor: String(o.vendor ?? ""),
      vendorEntityId: String(o.vendor_entity_id ?? ""),
      region: String(o.region ?? ""),
      serviceKey: String(t.key ?? ""),
      serviceName: String(t.name ?? t.key ?? ""),
      category: String(t.category ?? "other"),
      status: str(o.status) ?? "listed",
      conformance: c ? { passed: c.passed === true, at: str(c.at) } : null,
      liveAvailable: o.live_available === true,
    }
  })
}
// Each vendor firm's onboarding progress (get_vendor_onboarding { all_firms }): steps done of those counted, and the
// next one (the firm's own, or one waiting on Mynt). A count Mynt didn't give stays null, never 0.
export type VendorFirmRow = {
  entityId: string
  name: string
  status: string
  vendorMembers: number | null
  services: number | null
  listed: number | null
  done: number | null
  total: number | null
  complete: boolean
  next: { title: string; waitingOnMynt: boolean } | null
}
export function vendorFirmsFrom(reply: unknown): VendorFirmRow[] | null {
  if (!isObj(reply) || !Array.isArray(reply.firms)) return null
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null)
  return reply.firms.filter(isObj).map((f) => {
    const p = isObj(f.progress) ? f.progress : {}
    const next = isObj(p.next) ? p.next : null
    return {
      entityId: String(f.entity_id ?? ""),
      name: String(f.name ?? ""),
      status: str(f.status) ?? "active",
      vendorMembers: n(f.vendor_members),
      services: n(f.services),
      listed: n(f.listed),
      done: n(p.done),
      total: n(p.total),
      complete: p.complete === true,
      next: next ? { title: String(next.title ?? next.key ?? ""), waitingOnMynt: next.status === "blocked" } : null,
    }
  })
}
/** A firm's onboarding progress in words: "4 of 6 steps done", "All 6 steps done", or "Not known". */
export const onboardingWords = (f: VendorFirmRow) => (f.done === null || f.total === null ? "Not known" : f.complete ? `All ${f.total} steps done` : `${f.done} of ${f.total} steps done`)

export const conformanceWords = (c: AdminOffering["conformance"]) => (c ? `${c.passed ? "Passed" : "Failed"}${c.at ? ` ${dateOf(c.at)}` : ""}` : "Not run yet")

// ---- CSV export ----

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export const csvOf = (head: string[], rows: unknown[][]) => [head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n"
