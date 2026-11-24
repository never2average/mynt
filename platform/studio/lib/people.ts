// Who may sign in to Mynt (its invites) and who has, from Mynt's list_whitelist, with their firm from list_entities,
// for the platform admin's Members tabs and Security & risk's owner choices (lib/admin-members.ts, lib/admin-risks.ts).
// Sign-in is invite-only. invite_user sets an email's roles outright, so every change starts from the roles the
// person already has and says what it adds and removes; Mynt's admin role is never given from the Members tabs.
// Pure, for the routes, the views and the tests.

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
export const SIGN_IN_PREVIEW = "They can sign in with this email straight away."

const roleLabel = (r: string) => ROLE_LABELS[r] ?? r.replace(/_/g, " ")
/** Roles in words, each once (developer and innovator are one role). */
export const rolesWords = (roles: string[]) => [...new Set(roles.map(roleLabel))].join(", ")

export type PersonStatus = "signed_in" | "invited" | "no_access"
type PersonFirm = { id: string; name: string }
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
const personIdOf = (email: string | null, userId: string | null) => (email ? `e${hex(email.toLowerCase())}` : (userId ?? ""))
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

/** "Already has: …; adding: …." in words. */
export function changeWords(c: RoleChange): string {
  const parts = [c.already.length ? `Already has: ${rolesWords(c.already)}` : null, c.adding.length ? `adding: ${rolesWords(c.adding)}` : "nothing new to add", c.removing.length ? `removing: ${rolesWords(c.removing)}` : null]
  const line = parts.filter(Boolean).join("; ")
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`
}
