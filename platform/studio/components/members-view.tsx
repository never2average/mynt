"use client"

// The Workspace page's Members and Invitations tabs: the workspace's members and its pending
// invites. Owners and admins invite by email with a role (Invite member), change roles, remove
// members and withdraw invites; everyone else sees the members only (Mynt shows pending invites
// only to owners and admins). Server-renderable, so the tests check the role gating without a
// browser. Mynt checks every change again.
import { useMemo, useState } from "react"
import { Download, Mail, Trash2, UserPlus } from "lucide-react"

import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { downloadCsv, selectClass } from "@/components/licences-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import { ASSIGNABLE_ROLES, type AssignableRole, type Invite, type Member, type Workspace } from "@/lib/workspaces"

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

export const dateOf = (iso: string | null | undefined) =>
  iso && !Number.isNaN(new Date(iso).getTime()) ? new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }) : null

const roleName = (r: string) => r.charAt(0).toUpperCase() + r.slice(1)

/** Invite member: the tab's call to action, and the dialog it opens. Owners and admins only. */
export function InviteMember({ workspace, onInvite }: { workspace: Workspace; onInvite: MembersActions["invite"] }) {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<AssignableRole>("member")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)} data-invite-member>
        <UserPlus />
        Invite member
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite member</DialogTitle>
            <DialogDescription>They join {workspace.name} when they accept. Mynt doesn&apos;t email them, so tell them yourself.</DialogDescription>
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
            <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} aria-label="Role">
              {ASSIGNABLE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {roleName(r)}
                </option>
              ))}
            </select>
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

export function MembersTab({ workspace, data, actions }: { workspace: Workspace; data: MembersData; actions: MembersActions }) {
  const [query, setQuery] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => data.members.filter((m) => matches(query, m.name, m.email, m.role)), [data.members, query])
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
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="members">
      {!data.canManage && (
        <p className="text-sm text-muted-foreground" data-read-only>
          Only the workspace&apos;s owners and admins can invite people or change members.
        </p>
      )}
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
          <Button variant="outline" onClick={exportCsv} disabled={!rows.length}>
            <Download />
            Export CSV
          </Button>
        }
        cta={data.canManage ? <InviteMember workspace={workspace} onInvite={actions.invite} /> : undefined}
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
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">{m.name ?? "No name given"}</TableCell>
                  <TableCell>{m.email ?? "No email given"}</TableCell>
                  <TableCell>
                    {data.canManage && m.role !== "owner" ? (
                      <select
                        className={selectClass}
                        value={m.role}
                        aria-label={`Role for ${m.email ?? m.name ?? m.userId}`}
                        onChange={(e) => void run(() => actions.changeRole(m.userId, e.target.value as AssignableRole))}
                      >
                        {ASSIGNABLE_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {roleName(r)}
                          </option>
                        ))}
                      </select>
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
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const rows = useMemo(() => data.invites.filter((i) => matches(query, i.email, i.role)), [data.invites, query])
  const { page, pages, shown, setPage } = usePaged(rows)
  if (!data.supported) return <NotSupported data={data} />
  if (!data.canManage)
    return (
      <p className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground" data-tab-panel="invitations" data-read-only>
        Only the workspace&apos;s owners and admins see its pending invitations.
      </p>
    )

  const withdraw = async (id: string) => {
    if (busy) return
    setBusy(true)
    setError(await actions.revoke(id))
    setBusy(false)
  }

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
                <TableRow key={i.id}>
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
