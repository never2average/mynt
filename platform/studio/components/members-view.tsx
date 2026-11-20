"use client"

// The Workspace page's Members and Invitations tabs: the workspace's members and its pending
// invites. Members starts with its key figures (counted from the members Mynt listed); each tab
// then has one toolbar row (search, Role, Export CSV, Invite member) over a paged table. Owners
// and admins invite by email with a role, change roles, remove members and withdraw invites;
// everyone else sees the members only, with Invite member disabled (Mynt shows pending invites
// only to owners and admins). Server-renderable, so the tests check the role gating without a
// browser. Mynt checks every change again.
import { useMemo, useState } from "react"
import { ChevronDown, Download, Mail, Trash2, UserPlus } from "lucide-react"

import { KpiRow } from "@/components/charts"
import { Panel } from "@/components/dashboard-panels"
import { FilterSelect } from "@/components/filter-controls"
import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { downloadCsv } from "@/components/licences-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import type { Kpi } from "@/lib/dashboard-visual"
import { ASSIGNABLE_ROLES, ROLES, type AssignableRole, type Invite, type Member, type Role, type Workspace } from "@/lib/workspaces"

export type MembersData = {
  supported: boolean
  canManage: boolean
  members: Member[]
  invites: Invite[]
  manageUrl?: string | null
  message?: string
}

export type MembersActions = {
  invite(email: string, role: AssignableRole): Promise<string | null>
  changeRole(userId: string, role: AssignableRole): Promise<string | null>
  remove(userId: string): Promise<string | null>
  revoke(inviteId: string): Promise<string | null>
}

export { dateOf } from "@/lib/format-date"
import { dateOf } from "@/lib/format-date"

const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1)
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: roleName(r) }))
const ASSIGNABLE_OPTIONS = ASSIGNABLE_ROLES.map((r) => ({ value: r, label: roleName(r) }))

/** A compact role picker: a labelled button showing the role, opening the roles that can be given. */
export function RoleSelect({ value, onChange, label, disabled = false }: { value: AssignableRole; onChange: (role: AssignableRole) => void; label: string; disabled?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" aria-label={label} disabled={disabled} data-role-select>
          {roleName(value)}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-36" data-role-menu>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as AssignableRole)}>
          {ASSIGNABLE_ROLES.map((r) => (
            <DropdownMenuRadioItem key={r} value={r} data-role-option={r}>
              {roleName(r)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Invite member: the tab's call to action, and the dialog it opens. Owners and admins only (disabled for everyone else). */
export function InviteMember({ onInvite, disabled = false }: { workspace?: Workspace; onInvite: MembersActions["invite"]; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<AssignableRole>("member")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} disabled={disabled} data-invite-member>
        <UserPlus />
        Invite member
      </Button>
      {!disabled && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="sm:max-w-md" aria-describedby={undefined}>
            <DialogHeader>
              <DialogTitle>Invite member</DialogTitle>
            </DialogHeader>
            <form
              data-invite-form
              className="flex flex-col gap-3"
              onSubmit={async (e) => {
                e.preventDefault()
                if (busy) return
                setBusy(true)
                const failed = await onInvite(email, role)
                setBusy(false)
                setError(failed)
                if (!failed) {
                  setEmail("")
                  setOpen(false)
                }
              }}
            >
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label="Email" required />
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Role</span>
                <RoleSelect value={role} onChange={setRole} label="Role" />
              </div>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || !email.trim()}>
                  Send invite
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function NotSupported({ data }: { data: MembersData }) {
  return (
    <p className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground" data-empty="not-available">
      {data.message ?? "Workspace members come with Mynt's next update."}
    </p>
  )
}

const countKpi = (key: string, label: string, value: number, note = ""): Kpi => ({ key, label, value, unit: "count", delta: null, spark: null, note })

/** The Members tab's key figures, counted from the members Mynt listed. Developers are the members with the Member role. */
export function memberKpis(members: Member[]): Kpi[] {
  const count = (r: Role) => members.filter((m) => m.role === r).length
  return [
    countKpi("members", "Members", members.length),
    countKpi("owners", "Owners", count("owner")),
    countKpi("admins", "Admins", count("admin")),
    countKpi("developers", "Developers", count("member"), "Member role"),
  ]
}

function ExportCsv({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <Button variant="outline" onClick={onClick} disabled={disabled}>
      <Download />
      Export CSV
    </Button>
  )
}

export function MembersTab({ workspace, data, actions }: { workspace: Workspace; data: MembersData; actions: MembersActions }) {
  const [query, setQuery] = useState("")
  const [role, setRole] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => data.members.filter((m) => (!role || m.role === role) && matches(query, m.name, m.email, m.role)), [data.members, query, role])
  const { page, pages, shown, setPage } = usePaged(rows)
  if (!data.supported) return <NotSupported data={data} />

  const run = async (act: () => Promise<string | null>) => {
    if (busy) return
    setBusy(true)
    setError(await act())
    setBusy(false)
  }
  const exportCsv = () =>
    downloadCsv(`${workspace.name}-members.csv`, toCsv(["Name", "Email", "Role", "Joined"], rows.map((m) => [m.name, m.email, m.role, m.joinedAt?.slice(0, 10) ?? null])))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:gap-5" data-tab-panel="members">
      <Panel id="member-kpis">
        <section className="flex flex-col gap-3" data-section="kpis" aria-label="Key figures">
          <KpiRow kpis={memberKpis(data.members)} />
        </section>
      </Panel>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ListLayout
        search={query}
        onSearch={setQuery}
        searchLabel="Search members by name, email or role"
        actions={
          <>
            <FilterSelect label="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} />
            <ExportCsv onClick={exportCsv} disabled={!rows.length} />
          </>
        }
        cta={<InviteMember workspace={workspace} onInvite={actions.invite} disabled={!data.canManage} />}
        page={page}
        pages={pages}
        total={rows.length}
        onPage={setPage}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              {data.canManage && <TableHead className="text-right">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((m) => (
                <TableRow key={m.userId} data-member-row={m.userId}>
                  <TableCell className="font-medium">{m.name ?? "No name given"}</TableCell>
                  <TableCell>{m.email ?? "No email given"}</TableCell>
                  <TableCell>
                    {data.canManage && m.role !== "owner" ? (
                      <RoleSelect
                        value={m.role}
                        label={`Role for ${m.email ?? m.name ?? m.userId}`}
                        disabled={busy}
                        onChange={(r) => {
                          if (r !== m.role) void run(() => actions.changeRole(m.userId, r))
                        }}
                      />
                    ) : (
                      <Badge variant="outline">{roleName(m.role)}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{dateOf(m.joinedAt) ?? "Not recorded"}</TableCell>
                  {data.canManage && (
                    <TableCell className="text-right">
                      {m.role !== "owner" && (
                        <Button variant="outline" size="sm" onClick={() => void run(() => actions.remove(m.userId))} disabled={busy}>
                          <Trash2 />
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {data.members.length ? "No member matches the search." : "No members yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
    </div>
  )
}

export function InvitationsTab({ workspace, data, actions }: { workspace: Workspace; data: MembersData; actions: MembersActions }) {
  const [query, setQuery] = useState("")
  const [role, setRole] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => data.invites.filter((i) => (!role || i.role === role) && matches(query, i.email, i.role)), [data.invites, query, role])
  const { page, pages, shown, setPage } = usePaged(rows)
  if (!data.supported) return <NotSupported data={data} />
  if (!data.canManage)
    return (
      <p className="py-3 text-sm text-muted-foreground" data-tab-panel="invitations" data-read-only>
        Only the workspace&apos;s owners and admins see its pending invitations.
      </p>
    )

  const withdraw = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(await actions.revoke(id))
    setBusy(false)
  }
  const exportCsv = () =>
    downloadCsv(`${workspace.name}-invitations.csv`, toCsv(["Email", "Role", "Sent"], rows.map((i) => [i.email, i.role, i.sentAt?.slice(0, 10) ?? null])))

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="invitations">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ListLayout
        search={query}
        onSearch={setQuery}
        searchLabel="Search invitations by email or role"
        actions={
          <>
            <FilterSelect label="Role" value={role} options={ASSIGNABLE_OPTIONS} onChange={setRole} />
            <ExportCsv onClick={exportCsv} disabled={!rows.length} />
          </>
        }
        cta={<InviteMember workspace={workspace} onInvite={actions.invite} />}
        page={page}
        pages={pages}
        total={rows.length}
        onPage={setPage}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Sent</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((i) => (
                <TableRow key={i.id} data-invite-row={i.id}>
                  <TableCell className="font-medium">
                    <Mail className="mr-2 inline size-4 text-muted-foreground" />
                    {i.email}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{roleName(i.role)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{dateOf(i.sentAt) ?? "Not recorded"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => void withdraw(i.id)} disabled={busy}>
                      Withdraw
                    </Button>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                  {data.invites.length ? "No invitation matches the search." : "No pending invitations."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
    </div>
  )
}
