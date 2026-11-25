"use client"

// The platform admin's people, where they belong (lib/admin-members.ts): each firm's and each workspace's Members tab,
// a table (name, email, role, status in words) with a labelled Change role and Remove on each row, each opening its
// sheet, and Invite member on the page. The Overview's header keeps Invite person: an email, what they join (a firm or
// a workspace, picked by typing its name) and their role there; it does what that page's Invite member does.
// Mynt's admin role is never given from here. Server-renderable for the tests.
import { useCallback, useEffect, useMemo, useState } from "react"
import { UserCog, UserMinus, UserPlus } from "lucide-react"

import { AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { dateOf, type AdminWorkspace, type Firm, type FirmMember, type WorkspaceDetail } from "@/lib/admin"
import {
  firmRoleChange,
  firmRoleOptions,
  firmRolesWords,
  joinTargets,
  MEMBER_STATUS_LABELS,
  WORKSPACE_MEMBER_ROLES,
  WORKSPACE_ROLE_HELP,
  WORKSPACE_ROLE_LABELS,
  workspaceMemberRows,
  type JoinTarget,
  type MemberStatus,
  type WorkspaceMemberRole,
  type WorkspaceMemberRow,
} from "@/lib/admin-members"
import { changeWords, SIGN_IN_PREVIEW } from "@/lib/people"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const emailOk = (v: string) => v.trim().length <= 320 && EMAIL.test(v.trim())
export const EMAIL_HINT = "An email address, like name@example.com"

export const firmMembersUrl = (firmId: string) => `/api/admin/firms/${encodeURIComponent(firmId)}/members`
export const workspaceMembersUrl = (workspaceId: string) => `/api/admin/workspaces/${encodeURIComponent(workspaceId)}/members`

export function MemberStatusMark({ status }: { status: MemberStatus }) {
  return <StatusDot tone={status === "signed_in" ? "green" : "blue"} label={MEMBER_STATUS_LABELS[status]} data-member-status={status} />
}

function RoleChecks({ options, picked, onPicked }: { options: { value: string; label: string }[]; picked: string[]; onPicked: (r: string[]) => void }) {
  const toggle = (r: string) => onPicked(picked.includes(r) ? picked.filter((x) => x !== r) : [...picked, r])
  return (
    <fieldset className="flex flex-col gap-2 text-sm" data-member-roles>
      <legend className="mb-1">Role for this firm</legend>
      {options.map((r) => (
        <label key={r.value} className="flex items-center gap-2">
          <input type="checkbox" checked={picked.includes(r.value)} onChange={() => toggle(r.value)} data-role={r.value} />
          {r.label}
        </label>
      ))}
    </fieldset>
  )
}

function WorkspaceRoleSelect({ role, onRole }: { role: WorkspaceMemberRole; onRole: (r: WorkspaceMemberRole) => void }) {
  return (
    <Field label="Role in this workspace">
      <select className={fieldClass} value={role} onChange={(e) => onRole(e.target.value as WorkspaceMemberRole)} data-workspace-role>
        {WORKSPACE_MEMBER_ROLES.map((r) => (
          <option key={r} value={r}>
            {WORKSPACE_ROLE_HELP[r]}
          </option>
        ))}
      </select>
    </Field>
  )
}

// ---- a firm's members ----

/** Invite member at a firm: an email allowed to sign in with the firm's role(s) picked (keeping any roles they have), then added to it. */
export function InviteFirmMemberSheet({ firm, open, onClose, onDone, fetcher }: { firm: Pick<Firm, "id" | "name" | "types">; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const options = firmRoleOptions(firm)
  const [email, setEmail] = useState("")
  const [roles, setRoles] = useState<string[]>(() => (options.length === 1 ? [options[0].value] : []))
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const clean = email.trim().toLowerCase()
  return (
    <AdminSheet id="invite-member" open={open} onClose={onClose} title="Invite member" description={`Lets someone sign in to Mynt with the role you pick, and makes them a member of ${firm.name}. Roles they already have are kept. Its members are told.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-invite-member-form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!emailOk(clean) || !roles.length) return
          const r = await run(firmMembersUrl(firm.id), { action: "invite", email: clean, roles })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Email" hint={EMAIL_HINT}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} required data-member-email />
        </Field>
        <RoleChecks options={options} picked={roles} onPicked={setRoles} />
        <p className="rounded-md bg-muted/50 p-3 text-sm">{SIGN_IN_PREVIEW}</p>
        <div>
          <Button type="submit" disabled={busy || !emailOk(clean) || !roles.length} data-invite-member-submit>
            <UserPlus />
            {busy ? "Inviting…" : "Invite member"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** Change role at a firm: its roles become exactly the ones picked; any other role they hold stays. */
export function ChangeFirmRoleSheet({ firm, member, onClose, onDone, fetcher }: { firm: Pick<Firm, "id" | "name" | "types">; member: FirmMember | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const options = firmRoleOptions(firm)
  const [roles, setRoles] = useState<string[]>([])
  useEffect(() => {
    if (!member) return
    reset()
    setRoles(member.roles.map((r) => (r === "innovator" ? "developer" : r)).filter((r) => options.some((o) => o.value === r)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [member, reset])
  const preview = member ? firmRoleChange(member.roles, roles) : null
  return (
    <AdminSheet id="change-firm-role" open={member !== null} onClose={onClose} title="Change role" description={`${member?.email ?? member?.name ?? "This member"}'s role at ${firm.name}. Roles they hold outside the firm (Mynt admin, user) stay.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-change-firm-role-form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!member?.email || !roles.length) return
          const r = await run(firmMembersUrl(firm.id), { action: "change_role", email: member.email.toLowerCase(), roles })
          if (r?.ok) onDone()
        }}
      >
        <RoleChecks options={options} picked={roles} onPicked={setRoles} />
        {preview && roles.length > 0 && (
          <p className="rounded-md bg-muted/50 p-3 text-sm" data-role-preview>
            {changeWords(preview)}
          </p>
        )}
        <div>
          <Button type="submit" disabled={busy || !member?.email || !roles.length} data-change-firm-role-submit>
            <UserCog />
            {busy ? "Changing…" : "Change role"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** Remove from a firm, once their email is typed again. They keep their sign-in and roles. */
export function RemoveFirmMemberSheet({ firm, member, onClose, onDone, fetcher }: { firm: Pick<Firm, "id" | "name">; member: FirmMember | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [typed, setTyped] = useState("")
  useEffect(() => {
    if (!member) return
    reset()
    setTyped("")
  }, [member, reset])
  const email = member?.email?.toLowerCase() ?? ""
  const confirmed = Boolean(email) && typed.trim().toLowerCase() === email
  return (
    <AdminSheet id="remove-firm-member" open={member !== null} onClose={onClose} title="Remove from firm" description={`Takes ${email || "them"} out of ${firm.name}: they stop acting for it at once, and a licence provider loses its standing there. They can still sign in to Mynt. Its members are told.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-remove-firm-member-form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!confirmed) return
          const r = await run(firmMembersUrl(firm.id), { action: "remove", email, confirm_email: typed.trim().toLowerCase() })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Type their email to confirm">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={320} data-confirm-email />
        </Field>
        <div>
          <Button type="submit" variant="destructive" disabled={busy || !confirmed} data-remove-firm-member-submit>
            <UserMinus />
            {busy ? "Removing…" : "Remove from firm"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** A firm's Members tab: name, email, roles, status, and each row's Change role and Remove. */
export function FirmMembersTable({ firm, onChanged = () => undefined, fetcher }: { firm: Firm; onChanged?: () => void; fetcher?: typeof fetch }) {
  const [changing, setChanging] = useState<FirmMember | null>(null)
  const [removing, setRemoving] = useState<FirmMember | null>(null)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setChanging(null)
    setRemoving(null)
    if (dirty) {
      setDirty(false)
      onChanged()
    }
  }
  return (
    <>
      <AdminTable
        head={["Name", "Email", "Role", "Status", "Actions"]}
        rowKeys={firm.members.map((m) => m.id)}
        rows={firm.members.map((m) => [
          m.name ?? "—",
          m.email ?? "—",
          firmRolesWords(m.roles),
          // A firm's members are accounts that have signed in: add_entity_member takes nobody else.
          <MemberStatusMark key="s" status="signed_in" />,
          <span key="a" className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setChanging(m)} disabled={!m.email} title={m.email ? undefined : "Mynt has no email for this account"} data-change-role={m.id}>
              <UserCog />
              Change role
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRemoving(m)} disabled={!m.email} title={m.email ? undefined : "Mynt has no email for this account"} data-remove-member={m.id}>
              <UserMinus />
              Remove
            </Button>
          </span>,
        ])}
        empty="No members yet. Invite its people."
      />
      <ChangeFirmRoleSheet firm={firm} member={changing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <RemoveFirmMemberSheet firm={firm} member={removing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </>
  )
}

// ---- a workspace's members ----

/** Invite member to a workspace: the same invitation its owners send (and its organization's), with the role picked. */
export function InviteWorkspaceMemberSheet({ workspace, open, onClose, onDone, fetcher }: { workspace: Pick<AdminWorkspace, "id" | "name">; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<WorkspaceMemberRole>("member")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const clean = email.trim().toLowerCase()
  return (
    <AdminSheet id="invite-workspace-member" open={open} onClose={onClose} title="Invite member" description={`Invites someone to ${workspace.name}, as its owners do: they can sign in to Mynt and accept the invitation.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-invite-workspace-member-form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!emailOk(clean)) return
          const r = await run(workspaceMembersUrl(workspace.id), { action: "invite", email: clean, role })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Email" hint={EMAIL_HINT}>
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} required data-member-email />
        </Field>
        <WorkspaceRoleSelect role={role} onRole={setRole} />
        <div>
          <Button type="submit" disabled={busy || !emailOk(clean)} data-invite-workspace-member-submit>
            <UserPlus />
            {busy ? "Inviting…" : "Invite member"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

export function ChangeWorkspaceRoleSheet({ workspace, row, onClose, onDone, fetcher }: { workspace: Pick<AdminWorkspace, "id" | "name">; row: Extract<WorkspaceMemberRow, { kind: "member" }> | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [role, setRole] = useState<WorkspaceMemberRole>("member")
  useEffect(() => {
    if (!row) return
    reset()
    setRole((WORKSPACE_MEMBER_ROLES as readonly string[]).includes(row.role) ? (row.role as WorkspaceMemberRole) : "member")
  }, [row, reset])
  return (
    <AdminSheet id="change-workspace-role" open={row !== null} onClose={onClose} title="Change role" description={`${row?.email ?? row?.name ?? "This member"}'s role in ${workspace.name}. A workspace always keeps an owner.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-change-workspace-role-form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!row) return
          const r = await run(workspaceMembersUrl(workspace.id), { action: "change_role", user_id: row.userId, role })
          if (r?.ok) onDone()
        }}
      >
        <WorkspaceRoleSelect role={role} onRole={setRole} />
        <div>
          <Button type="submit" disabled={busy || !row || role === row.role} data-change-workspace-role-submit>
            <UserCog />
            {busy ? "Changing…" : "Change role"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** Remove from a workspace (they lose its apps and builds at once), or withdraw an invitation not yet accepted. */
export function RemoveWorkspaceMemberSheet({ workspace, row, onClose, onDone, fetcher }: { workspace: Pick<AdminWorkspace, "id" | "name">; row: WorkspaceMemberRow | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [sure, setSure] = useState(false)
  useEffect(() => {
    if (!row) return
    reset()
    setSure(false)
  }, [row, reset])
  const invite = row?.kind === "invite"
  const who = row?.email ?? row?.name ?? "them"
  return (
    <AdminSheet
      id="remove-workspace-member"
      open={row !== null}
      onClose={onClose}
      title={invite ? "Withdraw invitation" : "Remove from workspace"}
      description={invite ? `Withdraws ${who}'s invitation to ${workspace.name}. They can be invited again.` : `Takes ${who} out of ${workspace.name}: they lose its apps and builds at once. A workspace can't lose its last owner.`}
      error={error}
      result={result}
    >
      <form
        className="flex flex-col gap-3"
        data-remove-workspace-member-form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!row || !sure) return
          const r = await run(workspaceMembersUrl(workspace.id), row.kind === "invite" ? { action: "revoke_invite", invite_id: row.inviteId } : { action: "remove", user_id: row.userId, confirm: true })
          if (r?.ok) onDone()
        }}
      >
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} data-confirm-remove />
          {invite ? `Withdraw ${who}'s invitation` : `Remove ${who} from ${workspace.name}`}
        </label>
        <div>
          <Button type="submit" variant="destructive" disabled={busy || !sure} data-remove-workspace-member-submit>
            <UserMinus />
            {busy ? "Working…" : invite ? "Withdraw invitation" : "Remove from workspace"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

/** A workspace's Members tab: its members (signed in) and its open invitations (not yet signed in), each with Change role and Remove. */
export function WorkspaceMembersTable({ detail, onChanged = () => undefined, fetcher }: { detail: WorkspaceDetail; onChanged?: () => void; fetcher?: typeof fetch }) {
  const rows = useMemo(() => workspaceMemberRows(detail), [detail])
  const [changing, setChanging] = useState<Extract<WorkspaceMemberRow, { kind: "member" }> | null>(null)
  const [removing, setRemoving] = useState<WorkspaceMemberRow | null>(null)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setChanging(null)
    setRemoving(null)
    if (dirty) {
      setDirty(false)
      onChanged()
    }
  }
  const roleWords = (r: string) => WORKSPACE_ROLE_LABELS[r as WorkspaceMemberRole] ?? r
  return (
    <>
      <AdminTable
        head={["Name", "Email", "Role", "Status", "Since", "Actions"]}
        rowKeys={rows.map((r) => r.key)}
        rows={rows.map((r) => [
          r.name ?? "—",
          r.email ?? "—",
          roleWords(r.role),
          <MemberStatusMark key="s" status={r.status} />,
          dateOf(r.since),
          <span key="a" className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={r.kind === "invite"}
              title={r.kind === "invite" ? "Withdraw the invitation and invite them again with another role" : undefined}
              onClick={() => r.kind === "member" && setChanging(r)}
              data-change-role={r.key}
            >
              <UserCog />
              Change role
            </Button>
            <Button size="sm" variant="outline" onClick={() => setRemoving(r)} data-remove-member={r.key}>
              <UserMinus />
              Remove
            </Button>
          </span>,
        ])}
        empty="No members yet."
      />
      <ChangeWorkspaceRoleSheet workspace={detail.workspace} row={changing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <RemoveWorkspaceMemberSheet workspace={detail.workspace} row={removing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </>
  )
}

// ---- Invite person (the Overview's header) ----

type Places = { firms: Firm[]; workspaces: AdminWorkspace[] }

/** Invite person: email, then what they join (a firm or a workspace, found by typing), then their role there. */
export function InvitePersonSheet({ open, onClose, onDone = () => undefined, places, fetcher }: { open: boolean; onClose: () => void; onDone?: () => void; places?: Places | null; fetcher?: typeof fetch }) {
  // The firms and workspaces to pick from: given (tests), or read when the sheet opens.
  const pickFirms = useCallback((b: Record<string, unknown>) => (Array.isArray(b.firms) ? (b.firms as Firm[]) : undefined), [])
  const pickWorkspaces = useCallback((b: Record<string, unknown>) => (Array.isArray(b.workspaces) ? (b.workspaces as AdminWorkspace[]) : undefined), [])
  const firms = useAdminData(open && places === undefined ? "/api/admin/firms" : null, pickFirms)
  const workspaces = useAdminData(open && places === undefined ? "/api/admin/workspaces" : null, pickWorkspaces)
  const known: Places = places ?? { firms: firms.state.kind === "ready" ? firms.state.data : [], workspaces: workspaces.state.kind === "ready" ? workspaces.state.data : [] }
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [email, setEmail] = useState("")
  const [touched, setTouched] = useState(false)
  const [query, setQuery] = useState("")
  const [target, setTarget] = useState<JoinTarget | null>(null)
  const [firmRoles, setFirmRoles] = useState<string[]>([])
  const [wsRole, setWsRole] = useState<WorkspaceMemberRole>("member")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  const clean = email.trim().toLowerCase()
  const valid = emailOk(clean)
  const choices = joinTargets(known.firms, known.workspaces, query).slice(0, 8)
  const firm = target?.kind === "firm" ? (known.firms.find((f) => f.id === target.id) ?? null) : null
  const ready = valid && target !== null && (target.kind === "workspace" || firmRoles.length > 0)
  const choose = (t: JoinTarget) => {
    setTarget(t)
    setQuery(t.name)
    const f = t.kind === "firm" ? known.firms.find((x) => x.id === t.id) : null
    const opts = f ? firmRoleOptions(f) : []
    setFirmRoles(opts.length === 1 ? [opts[0].value] : [])
  }
  return (
    <AdminSheet id="invite-person" open={open} onClose={onClose} title="Invite person" description="Invites someone to a firm or a workspace, as that page's Invite member does. Sign-in is invite-only, so this is what lets them in." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-invite-person-form
        onSubmit={async (e) => {
          e.preventDefault()
          setTouched(true)
          if (!ready || !target) return
          const r =
            target.kind === "firm"
              ? await run(firmMembersUrl(target.id), { action: "invite", email: clean, roles: firmRoles })
              : await run(workspaceMembersUrl(target.id), { action: "invite", email: clean, role: wsRole })
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
        <Field label="Joins" hint="A regulated firm or a workspace: type part of its name.">
          <Input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setTarget(null)
            }}
            maxLength={200}
            role="combobox"
            aria-expanded={!target}
            aria-controls="joins-choices"
            data-joins-search
          />
        </Field>
        {!target && (
          <ul id="joins-choices" role="listbox" aria-label="Regulated firms and workspaces" className="flex max-h-56 flex-col overflow-y-auto rounded-md border" data-joins-choices>
            {choices.length ? (
              choices.map((t) => (
                <li key={`${t.kind}:${t.id}`} role="option" aria-selected={false}>
                  <button type="button" className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent" onClick={() => choose(t)} data-join={`${t.kind}:${t.id}`}>
                    <span className="truncate">{t.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{t.hint}</span>
                  </button>
                </li>
              ))
            ) : (
              <li className="px-3 py-2 text-sm text-muted-foreground">No regulated firm or workspace matches.</li>
            )}
          </ul>
        )}
        {target?.kind === "firm" && firm && <RoleChecks options={firmRoleOptions(firm)} picked={firmRoles} onPicked={setFirmRoles} />}
        {target?.kind === "workspace" && <WorkspaceRoleSelect role={wsRole} onRole={setWsRole} />}
        <div>
          <Button type="submit" disabled={busy || !ready} data-invite-person-submit>
            <UserPlus />
            {busy ? "Inviting…" : "Invite person"}
          </Button>
        </div>
      </form>
    </AdminSheet>
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
      <InvitePersonSheet open={open} onClose={() => setOpen(false)} />
    </>
  )
}
