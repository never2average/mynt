// The platform admin's People section (/platform/people): everyone who may sign in to Mynt (its invites) and everyone
// who has, from Mynt's list_whitelist, with their firm from list_entities. Sign-in is invite-only, so inviting someone
// is what lets them in. Pure, for the route, the views and the tests.
//
// invite_user sets an email's roles outright, so every change here starts from the roles the person already has:
// inviting someone already on the list adds the roles picked (never drops one), and only Change roles with
// "Replace" chosen explicitly sets them to exactly what was picked. Mynt's admin role is never one of the role
// checkboxes: it's a separate "Make Mynt admin" box, off by default.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null)
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])

// The roles Mynt supports (core's store.ts ROLES; lib/studio-tools.ts MYNT_ROLES), as people see them. Developer and
// innovator are two names for the builder role.
export const ROLE_LABELS: Record<string, string> = {
  consumer: "Consumer",
  developer: "Innovator",
  innovator: "Innovator",
  vendor: "Vendor",
  license_provider: "Licence provider",
  liquidity_provider: "Liquidity provider",
  admin: "Mynt admin",
}
// The role checkboxes: every role but Mynt's admin role (and innovator, the builder role's other name).
export const PERSON_ROLES = ["developer", "vendor", "license_provider", "liquidity_provider", "consumer"] as const
export type PersonRole = (typeof PERSON_ROLES)[number]
export const PERSON_ROLE_OPTIONS: { value: PersonRole; label: string }[] = [
  { value: "developer", label: "Innovator (builds products and apps)" },
  { value: "vendor", label: "Vendor (offers standard services)" },
  { value: "license_provider", label: "Licence provider (sponsors products)" },
  { value: "liquidity_provider", label: "Liquidity provider (puts capital into pools)" },
  { value: "consumer", label: "Consumer (uses apps built on Mynt)" },
]
export const ADMIN_WARNING = "A Mynt admin can change every workspace, firm, product and setting on Mynt, and let anyone else in."
export const SIGN_IN_PREVIEW = "They can sign in with this email straight away."

const roleLabel = (r: string) => ROLE_LABELS[r] ?? r.replace(/_/g, " ")
/** Roles in words, each once (developer and innovator are one role). */
export const rolesWords = (roles: string[]) => [...new Set(roles.map(roleLabel))].join(", ")

export type PersonStatus = "signed_in" | "invited" | "no_access"
export const PERSON_STATUS_LABELS: Record<PersonStatus, string> = { signed_in: "Signed in", invited: "Invited", no_access: "No access" }
// The Status filter's words, longer than the column's.
export const PERSON_STATUS_FILTERS: Record<PersonStatus, string> = { signed_in: "Signed in", invited: "Invited, not yet signed in", no_access: "No access (removed from the list)" }

export type PersonFirm = { id: string; name: string }
export type Person = {
  id: string // "e" and the email's hex, or the account's id when it has no email: stable from invite to sign-in
  email: string | null
  name: string | null
  roles: string[] // the roles Mynt lets them sign in with (the invite's), or the account's when it has no invite
  status: PersonStatus
  invitedAt: string | null
  joinedAt: string | null
  userId: string | null
  firms: PersonFirm[]
}

const hex = (s: string) => Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("")
export const personIdOf = (email: string | null, userId: string | null) => (email ? `e${hex(email.toLowerCase())}` : (userId ?? ""))
// A person's id in the address: an account's uuid, or "e" and an email's hex (an email is at most 320 characters).
export const PERSON_ID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|e(?:[0-9a-f]{2}){3,320})$/

export type Whitelist = { publicSignup: boolean | null; people: Person[] }

/** list_whitelist's answer (and list_entities', when this Mynt has it) as one row per person. */
export function peopleFrom(whitelist: unknown, entities: unknown = null): Whitelist | null {
  if (!isObj(whitelist) || !Array.isArray(whitelist.whitelist)) return null
  // Each account's firm: its members as list_entities lists them.
  const firmOf = new Map<string, PersonFirm[]>()
  for (const e of Array.isArray(entities) ? entities.filter(isObj) : []) {
    const firm = { id: String(e.id), name: String(e.name ?? e.id) }
    for (const m of Array.isArray(e.members) ? e.members.filter(isObj) : []) {
      for (const key of [str(m.id), str(m.email)?.toLowerCase()].filter((k): k is string => !!k)) firmOf.set(key, [...(firmOf.get(key) ?? []), firm])
    }
  }
  const firmsFor = (userId: string | null, email: string | null) => {
    const all = [...(userId ? (firmOf.get(userId) ?? []) : []), ...(email ? (firmOf.get(email) ?? []) : [])]
    return all.filter((f, i) => all.findIndex((g) => g.id === f.id) === i)
  }
  const users = Array.isArray(whitelist.users) ? whitelist.users.filter(isObj) : []
  const byEmail = new Map(users.filter((u) => str(u.email)).map((u) => [String(u.email).toLowerCase(), u]))
  const seen = new Set<string>()
  const people: Person[] = []
  for (const i of whitelist.whitelist.filter(isObj)) {
    const email = str(i.email)?.toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    const u = byEmail.get(email) ?? null
    const userId = u ? str(u.id) : null
    people.push({
      id: personIdOf(email, userId),
      email,
      name: u ? str(u.name) : null,
      roles: strs(i.roles),
      status: u ? "signed_in" : "invited",
      invitedAt: str(i.created_at),
      joinedAt: u ? str(u.created_at) : null,
      userId,
      firms: firmsFor(userId, email),
    })
  }
  // Accounts with no invite: removed from the list (revoke_user), so they can't sign in again.
  for (const u of users) {
    const email = str(u.email)?.toLowerCase() ?? null
    const userId = str(u.id)
    if ((email && seen.has(email)) || (!email && !userId)) continue
    if (email) seen.add(email)
    people.push({ id: personIdOf(email, userId), email, name: str(u.name), roles: strs(u.held_roles).length ? strs(u.held_roles) : strs(u.roles), status: "no_access", invitedAt: null, joinedAt: str(u.created_at), userId, firms: firmsFor(userId, email) })
  }
  return { publicSignup: typeof whitelist.public_signup === "boolean" ? whitelist.public_signup : null, people }
}

export type RoleChange = { roles: string[]; already: string[]; adding: string[]; removing: string[] }

/** Adding roles to what someone has: nothing they had is dropped. */
export function addRoles(had: string[], picked: string[]): RoleChange {
  const roles = [...new Set([...had, ...picked])]
  const known = (r: string) => had.includes(r) || (r === "developer" && had.includes("innovator")) || (r === "innovator" && had.includes("developer"))
  return { roles, already: had, adding: [...new Set(picked)].filter((r) => !known(r)), removing: [] }
}

/** Setting someone's roles to exactly what was picked (chosen explicitly): says what goes. */
export function replaceRoles(had: string[], picked: string[]): RoleChange {
  const roles = [...new Set(picked)]
  const same = (a: string, b: string) => a === b || (["developer", "innovator"].includes(a) && ["developer", "innovator"].includes(b))
  return { roles, already: had, adding: roles.filter((r) => !had.some((h) => same(h, r))), removing: had.filter((h) => !roles.some((r) => same(h, r))) }
}

/** "Already has: …; adding: …." in words. */
export function changeWords(c: RoleChange): string {
  const parts = [c.already.length ? `Already has: ${rolesWords(c.already)}` : null, c.adding.length ? `adding: ${rolesWords(c.adding)}` : "nothing new to add", c.removing.length ? `removing: ${rolesWords(c.removing)}` : null]
  const line = parts.filter(Boolean).join("; ")
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`
}

export type PersonActivity = { id: string; action: string; target: string; actor: string | null; createdAt: string | null }

/** audit_log's entries about a person (its target, or the email in its details) or by them. */
export function personActivityFrom(log: unknown, person: Pick<Person, "email" | "userId">): PersonActivity[] | null {
  if (!Array.isArray(log)) return null
  const email = person.email?.toLowerCase() ?? null
  return log
    .filter(isObj)
    .filter((e) => {
      const d = isObj(e.details) ? e.details : {}
      const about = (email && (String(e.target ?? "").toLowerCase() === email || String(d.email ?? "").toLowerCase() === email)) || (person.userId && e.target === person.userId)
      const by = (email && String(e.actor_email ?? "").toLowerCase() === email) || (person.userId && e.actor_id === person.userId)
      return Boolean(about || by)
    })
    .map((e) => ({ id: String(e.id ?? ""), action: String(e.action ?? ""), target: String(e.target ?? ""), actor: str(e.actor_email), createdAt: str(e.created_at) }))
}
