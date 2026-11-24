"use client"

// Platform admin → People (/platform/people): everyone who may sign in to Mynt (sign-in is invite-only) and everyone who
// has, with their roles, their firm, and whether they've signed in yet (list_whitelist, list_entities). Invite person
// (a labelled button here and in the Overview's header) lets an email sign in with the roles picked, keeping any roles
// they already have, and can add them to a firm. A row opens the person: their metadata card with Change roles (add,
// or replace when chosen explicitly) and Revoke access, then Roles, Firms and Activity (Mynt's audit log), each a
// table. Mynt's admin role is never a role checkbox: it's a separate "Make Mynt admin" box, off by default, with a
// warning. Server-renderable.
import { useCallback, useEffect, useMemo, useState } from "react"
import { UserCog, UserMinus, UserPlus } from "lucide-react"

import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { csvOf, dateOf, whenOf, words } from "@/lib/admin"
import {
  ADMIN_WARNING,
  addRoles,
  changeWords,
  PERSON_ROLE_OPTIONS,
  PERSON_STATUS_FILTERS,
  PERSON_STATUS_LABELS,
  replaceRoles,
  ROLE_LABELS,
  rolesWords,
  SIGN_IN_PREVIEW,
  type Person,
  type PersonActivity,
  type PersonFirm,
  type PersonStatus,
} from "@/lib/people"

export type PeopleData = { people: Person[]; firms: PersonFirm[] | null; publicSignup: boolean | null }
export type PersonDetail = { person: Person; firms: PersonFirm[] | null; activity: PersonActivity[] | null; activityLimit?: number }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const emailOk = (v: string) => v.trim().length <= 320 && EMAIL.test(v.trim())
export const EMAIL_HINT = "An email address, like name@example.com"

// What each role lets someone do, for the Roles tab.
const ROLE_MEANS: Record<string, string> = {
  consumer: "Uses apps built on Mynt.",
  developer: "Builds financial products and apps on them in Mynt Studio.",
  innovator: "Builds financial products and apps on them in Mynt Studio.",
  vendor: "Offers standard services (for example identity checks) to products on Mynt.",
  license_provider: "Holds the licences that sponsor innovators' products.",
  liquidity_provider: "Puts capital into products' pools.",
  admin: "Runs Mynt itself: every workspace, firm, product and setting.",
}

export function PersonStatusMark({ status }: { status: PersonStatus }) {
  return <StatusDot tone={status === "signed_in" ? "green" : status === "invited" ? "blue" : "gray"} label={PERSON_STATUS_LABELS[status]} data-person-status={status} />
}

const firmsWords = (p: Person, firms: PersonFirm[] | null) => (p.firms.length ? p.firms.map((f) => f.name).join(", ") : firms === null ? "Not known" : "None")
const dateWords = (p: Person) => (p.joinedAt ? `Joined ${dateOf(p.joinedAt)}` : p.invitedAt ? `Invited ${dateOf(p.invitedAt)}` : "—")
const asPicks = (roles: string[]) => [...new Set(roles.map((r) => (r === "innovator" ? "developer" : r)).filter((r) => r !== "admin"))]

/** The role checkboxes (never Mynt's admin role) and, apart, "Make Mynt admin" with its warning. */
function RolePicker({ roles, onRoles, admin, onAdmin }: { roles: string[]; onRoles: (r: string[]) => void; admin: boolean; onAdmin: (a: boolean) => void }) {
  return (
    <>
      <fieldset className="flex flex-col gap-2 text-sm" data-person-roles>
        <legend className="mb-1">Roles</legend>
        {PERSON_ROLE_OPTIONS.map((r) => (
          <label key={r.value} className="flex items-center gap-2">
            <input type="checkbox" checked={roles.includes(r.value)} onChange={() => onRoles(roles.includes(r.value) ? roles.filter((x) => x !== r.value) : [...roles, r.value])} data-role={r.value} />
            {r.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-1 rounded-md border p-3 text-sm" data-make-admin-box>
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={admin} onChange={(e) => onAdmin(e.target.checked)} data-make-admin />
          Make Mynt admin
        </label>
        <span className="text-xs text-muted-foreground" data-admin-warning>
          {ADMIN_WARNING} Only tick this for Mynt&apos;s own staff.
        </span>
      </fieldset>
    </>
  )
}

/** Invite person: lets an email sign in with the roles picked (keeping any they have), and optionally adds them to a firm. */
export function InvitePersonSheet({
  open,
  onClose,
  onDone,
  data,
  initialEmail = "",
  fetcher,
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
  data?: PeopleData | null // undefined: the sheet reads who's on the list itself, when it opens (the Overview's header)
  initialEmail?: string
  fetcher?: typeof fetch
}) {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.people) ? (b as unknown as PeopleData) : undefined), [])
  const own = useAdminData(open && data === undefined ? "/api/admin/people" : null, pick)
  const known = data ?? (own.state.kind === "ready" ? own.state.data : null)
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [email, setEmail] = useState(initialEmail)
  const [touched, setTouched] = useState(false)
  const [roles, setRoles] = useState<string[]>(["developer"])
  const [admin, setAdmin] = useState(false)
  const [firmId, setFirmId] = useState("")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const clean = email.trim().toLowerCase()
  const valid = emailOk(clean)
  const existing = valid ? (known?.people.find((p) => p.email === clean && p.status !== "no_access") ?? null) : null
  const picked = [...roles, ...(admin ? ["admin"] : [])]
  return (
    <AdminSheet id="invite-person" open={open} onClose={onClose} title="Invite person" description="Lets someone sign in to Mynt with the roles you pick. Sign-in is invite-only, so this is what lets them in." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-invite-person-form
        onSubmit={async (e) => {
          e.preventDefault()
          setTouched(true)
          if (!valid || !picked.length) return
          const r = await run("/api/admin/people", { action: "invite", email: clean, roles, make_admin: admin, ...(firmId ? { firm_id: firmId } : {}) })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Email" hint={EMAIL_HINT}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => setTouched(true)} maxLength={320} required aria-invalid={touched && !valid} data-person-email />
        </Field>
        {touched && !valid && (
          <p className="text-sm text-destructive" data-email-invalid>
            That isn&apos;t an email address.
          </p>
        )}
        <RolePicker roles={roles} onRoles={setRoles} admin={admin} onAdmin={setAdmin} />
        {known?.firms && known.firms.length > 0 && (
          <Field label="Firm (optional)" hint="Adds them to the firm too. Someone who hasn't signed in yet is added from the firm's page once they have.">
            <select className={fieldClass} value={firmId} onChange={(e) => setFirmId(e.target.value)} data-person-firm>
              <option value="">No firm</option>
              {known.firms.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="flex flex-col gap-1 rounded-md bg-muted/50 p-3 text-sm" data-invite-preview>
          {existing ? <p data-merge-preview>{changeWords(addRoles(existing.roles, picked))} Nothing they have is taken away.</p> : null}
          <p>{SIGN_IN_PREVIEW}</p>
        </div>
        <div>
          <Button type="submit" disabled={busy || !clean || !picked.length} data-invite-person-submit>
            <UserPlus />
            {busy ? "Inviting…" : "Invite person"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** Change roles: add to what they have, or (chosen explicitly) replace it with exactly what's picked. */
export function ChangeRolesSheet({ person, open, onClose, onDone, fetcher }: { person: Person; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [mode, setMode] = useState<"add" | "replace">("add")
  const [roles, setRoles] = useState<string[]>([])
  const [admin, setAdmin] = useState(false)
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const choose = (m: "add" | "replace") => {
    setMode(m)
    // Replacing starts from what they have, so only what's unticked goes; adding starts from nothing.
    setRoles(m === "replace" ? asPicks(person.roles) : [])
    setAdmin(m === "replace" && person.roles.includes("admin"))
  }
  const picked = [...roles, ...(admin ? ["admin"] : [])]
  const change = mode === "add" ? addRoles(person.roles, picked) : replaceRoles(person.roles, picked)
  const dropsAdmin = change.removing.includes("admin")
  return (
    <AdminSheet id="change-roles" open={open} onClose={onClose} title="Change roles" description={`What ${person.email ?? "this person"} may do on Mynt. Adding keeps every role they have; replacing sets exactly the roles you tick.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-change-roles-form
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run("/api/admin/people", { action: "set_roles", email: person.email, roles, make_admin: admin, mode })
          if (r?.ok) onDone()
        }}
      >
        <fieldset className="flex flex-col gap-2 text-sm" data-roles-mode>
          <legend className="mb-1">How</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="roles-mode" checked={mode === "add"} onChange={() => choose("add")} data-mode="add" />
            Add to their roles
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="roles-mode" checked={mode === "replace"} onChange={() => choose("replace")} data-mode="replace" />
            Replace their roles with exactly these
          </label>
        </fieldset>
        <RolePicker roles={roles} onRoles={setRoles} admin={admin} onAdmin={setAdmin} />
        <p className="rounded-md bg-muted/50 p-3 text-sm" data-roles-preview>
          {changeWords(change)}
        </p>
        {dropsAdmin && (
          <p className="text-sm text-destructive" data-drops-admin>
            This takes away their Mynt admin role.
          </p>
        )}
        <div>
          <Button type="submit" disabled={busy || !picked.length || (!change.adding.length && !change.removing.length)} data-change-roles-submit>
            <UserCog />
            {busy ? "Saving…" : "Change roles"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** Revoke access: they can't use Mynt from their next request (revoke_user). Confirmed by typing their email. */
export function RevokeAccessSheet({ person, open, onClose, onDone, fetcher }: { person: Person; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [confirm, setConfirm] = useState("")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const email = person.email ?? ""
  return (
    <AdminSheet id="revoke-access" open={open} onClose={onClose} title="Revoke access" description="Stops them using Mynt." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-revoke-form
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run("/api/admin/people", { action: "revoke", email, confirm_email: confirm.trim().toLowerCase() })
          if (r?.ok) onDone()
        }}
      >
        <p className="text-sm" data-revoke-reason>
          {email} can no longer sign in or use Mynt, from their next request, and public sign-up won&apos;t let them back in. What they created stays, and they can be invited again later.
        </p>
        <Field label="Type their email to confirm">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} maxLength={320} data-revoke-confirm />
        </Field>
        <div>
          <Button type="submit" variant="destructive" disabled={busy || confirm.trim().toLowerCase() !== email} data-revoke-submit>
            <UserMinus />
            {busy ? "Revoking…" : "Revoke access"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

const ROLE_FILTERS = [...PERSON_ROLE_OPTIONS.map((r) => ({ value: r.value, label: ROLE_LABELS[r.value] })), { value: "admin", label: ROLE_LABELS.admin }]
const hasRole = (p: Person, r: string) => p.roles.includes(r) || (r === "developer" && p.roles.includes("innovator"))

export function PeopleListView({ data, onOpen, onChanged = () => undefined, sheetOpen = false }: { data: PeopleData; onOpen: (id: string) => void; onChanged?: () => void; sheetOpen?: boolean }) {
  const [query, setQuery] = useState("")
  const [role, setRole] = useState<string[]>([])
  const [status, setStatus] = useState<string[]>([])
  const [inviting, setInviting] = useState(sheetOpen)
  const [dirty, setDirty] = useState(false)
  const shown = useMemo(
    () =>
      data.people.filter(
        (p) => matches(query, p.name, p.email, ...p.firms.map((f) => f.name)) && (!role.length || role.some((r) => hasRole(p, r))) && (!status.length || status.includes(p.status)),
      ),
    [data.people, query, role, status],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv(
      "people.csv",
      csvOf(
        ["Name", "Email", "Roles", "Firms", "Status", "Invited", "Joined"],
        shown.map((p) => [p.name ?? "", p.email ?? "", rolesWords(p.roles), p.firms.map((f) => f.name).join("; "), PERSON_STATUS_LABELS[p.status], dateOf(p.invitedAt), dateOf(p.joinedAt)]),
      ),
    )
  const note =
    data.publicSignup === true
      ? "Public sign-up is on: anyone with a verified email can also sign in, as a consumer."
      : data.publicSignup === false
        ? "Sign-in is invite-only: only the people invited here can sign in."
        : null
  return (
    <>
      <AdminList
        id="people"
        search={query}
        onSearch={(q) => (setQuery(q), setPage(1))}
        searchLabel="Search people by name, email or firm"
        facets={[
          { id: "role", label: "Role", options: ROLE_FILTERS, selected: role, onChange: (v) => (setRole(v), setPage(1)) },
          { id: "status", label: "Status", options: (Object.keys(PERSON_STATUS_FILTERS) as PersonStatus[]).map((s) => ({ value: s, label: PERSON_STATUS_FILTERS[s] })), selected: status, onChange: (v) => (setStatus(v), setPage(1)) },
        ]}
        onClearFilters={() => (setRole([]), setStatus([]))}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        cta={
          <Button onClick={() => setInviting(true)} data-invite-person>
            <UserPlus />
            Invite person
          </Button>
        }
        note={note}
        page={page}
        pages={pages}
        total={shown.length}
        onPage={setPage}
      >
        <AdminTable
          head={["Name", "Email", "Roles", "Firm(s)", "Status", "Invited or joined", ""]}
          rowKeys={onPage.map((p) => p.id)}
          onRow={(i) => onOpen(onPage[i].id)}
          rows={onPage.map((p) => [
            p.name ?? "—",
            p.email ?? "—",
            rolesWords(p.roles) || "—",
            firmsWords(p, data.firms),
            <PersonStatusMark key="s" status={p.status} />,
            dateWords(p),
            <Button
              key="o"
              size="sm"
              variant="outline"
              onClick={(e) => {
                e.stopPropagation()
                onOpen(p.id)
              }}
              data-open-person={p.id}
            >
              Open
            </Button>,
          ])}
          empty={data.people.length ? "Nobody matches these filters." : "Nobody may sign in yet. Invite the first person."}
        />
      </AdminList>
      <InvitePersonSheet
        open={inviting}
        data={data}
        onClose={() => {
          setInviting(false)
          if (dirty) onChanged()
        }}
        onDone={() => setDirty(true)}
      />
    </>
  )
}

type DetailTab = "roles" | "firms" | "activity"

export function PersonDetailView({
  detail,
  onBack,
  onChanged = () => undefined,
  initialTab = "roles",
  sheet = null,
}: {
  detail: PersonDetail
  onBack: () => void
  onChanged?: () => void
  initialTab?: DetailTab
  sheet?: "roles" | "revoke" | "invite" | null
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [open, setOpen] = useState<"roles" | "revoke" | "invite" | null>(sheet)
  const [done, setDone] = useState<"roles" | "revoke" | "invite" | null>(null)
  const p = detail.person
  const close = () => {
    setOpen(null)
    // Revoking someone who never signed in takes them off the list altogether: back to People.
    if (done === "revoke" && p.status === "invited") onBack()
    else if (done) onChanged()
    setDone(null)
  }
  const tabs: { id: DetailTab; label: string }[] = [
    { id: "roles", label: "Roles" },
    { id: "firms", label: "Firms" },
    ...(detail.activity === null ? [] : [{ id: "activity" as const, label: "Activity" }]),
  ]
  return (
    <>
      <AdminDetail
        backLabel="Back to people"
        onBack={onBack}
        title={p.name ?? p.email ?? "Unnamed account"}
        subtitle={p.name ? p.email : null}
        fields={[
          ["Status", <PersonStatusMark key="s" status={p.status} />],
          ["Roles", rolesWords(p.roles) || "None"],
          ["Firm(s)", firmsWords(p, detail.firms)],
          ["Email", p.email ?? "—"],
          ["Invited", dateOf(p.invitedAt)],
          ["First signed in", p.joinedAt ? dateOf(p.joinedAt) : "Not yet"],
          ["Account id", p.userId ? <code key="i" className="text-xs">{p.userId}</code> : "No account yet"],
        ]}
        actions={
          p.email ? (
            p.status === "no_access" ? (
              <Button size="sm" onClick={() => setOpen("invite")} data-invite-again>
                <UserPlus />
                Invite again
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => setOpen("roles")} data-change-roles>
                  <UserCog />
                  Change roles
                </Button>
                <Button size="sm" variant="outline" onClick={() => setOpen("revoke")} data-revoke-access>
                  <UserMinus />
                  Revoke access
                </Button>
              </>
            )
          ) : null
        }
        tabs={tabs}
        tab={tab}
        onTab={setTab}
      >
        {tab === "roles" && <AdminTable head={["Role", "What it lets them do"]} rowKeys={p.roles} rows={p.roles.map((r) => [ROLE_LABELS[r] ?? words(r), ROLE_MEANS[r] ?? "—"])} empty="No roles: they can't use Mynt." />}
        {tab === "firms" &&
          (detail.firms === null && !p.firms.length ? (
            <p className="p-4 text-sm text-muted-foreground">Firms aren&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["Firm", "Id"]}
              rowKeys={p.firms.map((f) => f.id)}
              rows={p.firms.map((f) => [f.name, <code key="i" className="text-xs">{f.id}</code>])}
              empty={p.userId ? "Not a member of any firm." : "Not a member of any firm. Someone is added to a firm once they've signed in."}
            />
          ))}
        {tab === "activity" && detail.activity && (
          <div className="flex flex-col" data-person-activity>
            <p className="px-4 pt-3 text-xs text-muted-foreground">
              What was done to or by them, from the newest {detail.activityLimit ?? 500} entries of Mynt&apos;s audit log.
            </p>
            <AdminTable
              head={["When", "Action", "Target", "By"]}
              rowKeys={detail.activity.map((a, i) => a.id || String(i))}
              rows={detail.activity.map((a) => [whenOf(a.createdAt), words(a.action), a.target || "—", a.actor ?? "—"])}
              empty="Nothing recorded."
            />
          </div>
        )}
      </AdminDetail>
      {p.email && (
        <>
          <ChangeRolesSheet person={p} open={open === "roles"} onClose={close} onDone={() => setDone("roles")} />
          <RevokeAccessSheet person={p} open={open === "revoke"} onClose={close} onDone={() => setDone("revoke")} />
          <InvitePersonSheet open={open === "invite"} initialEmail={p.email} onClose={close} onDone={() => setDone("invite")} />
        </>
      )}
    </>
  )
}

/** Invite person as a labelled button with its sheet, for the Overview's header. */
export function InvitePersonButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-header-invite-person>
        <UserPlus />
        Invite person
      </Button>
      <InvitePersonSheet open={open} onClose={() => setOpen(false)} onDone={() => undefined} />
    </>
  )
}

export function PeopleTab({ id, onOpen, onBack }: { id: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const pickList = useCallback((b: Record<string, unknown>) => (Array.isArray(b.people) ? (b as unknown as PeopleData) : undefined), [])
  const pickOne = useCallback((b: Record<string, unknown>) => (b.person ? (b as unknown as PersonDetail) : undefined), [])
  const list = useAdminData(id ? null : "/api/admin/people", pickList)
  const one = useAdminData(id ? `/api/admin/people?id=${encodeURIComponent(id)}` : null, pickOne)
  if (id) return one.state.kind === "ready" ? <PersonDetailView detail={one.state.data} onBack={onBack} onChanged={one.reload} /> : <AdminNotReady state={one.state} what="This person" />
  return list.state.kind === "ready" ? <PeopleListView data={list.state.data} onOpen={onOpen} onChanged={list.reload} /> : <AdminNotReady state={list.state} what="People" />
}
