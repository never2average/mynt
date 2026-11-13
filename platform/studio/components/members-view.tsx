"use client"

// The Members page's content: the workspace's members and pending invites. Owners and admins
// can invite by email with a role, revoke invites, change roles and remove members; everyone
// else sees the list only. Server-renderable, so the tests check the role gating without a
// browser. Mynt checks every change again.
import { useState } from "react"
import { Mail, Trash2, UserPlus } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ASSIGNABLE_ROLES, type AssignableRole, type Invite, type Member, type Workspace } from "@/lib/workspaces"

export type MembersData = {
  supported: boolean
  canManage: boolean
  members: Member[]
  invites: Invite[]
  message?: string
}

export type MembersActions = {
  invite(email: string, role: AssignableRole): Promise<string | null>
  changeRole(userId: string, role: AssignableRole): Promise<string | null>
  remove(userId: string): Promise<string | null>
  revoke(inviteId: string): Promise<string | null>
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20"

export function MembersView({ workspace, data, actions }: { workspace: Workspace; data: MembersData; actions: MembersActions }) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<AssignableRole>("member")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (act: () => Promise<string | null>) => {
    if (busy) return
    setBusy(true)
    setError(await act())
    setBusy(false)
  }

  if (!data.supported) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{workspace.name}</CardTitle>
          <CardDescription>{data.message ?? "Workspace members come with Mynt's next update."}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {data.canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Invite someone</CardTitle>
            <CardDescription>They join {workspace.name} when they accept the email invite.</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              data-invite-form
              className="flex flex-col gap-2 sm:flex-row"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  const failed = await actions.invite(email, role)
                  if (!failed) setEmail("")
                  return failed
                })
              }}
            >
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label="Email" required />
              <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} aria-label="Role">
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r === "admin" ? "Admin" : "Member"}
                  </option>
                ))}
              </select>
              <Button type="submit" disabled={busy || !email.trim()}>
                <UserPlus />
                Invite
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground" data-read-only>
          Only the workspace&apos;s owners and admins can invite people or change members.
        </p>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                {data.canManage && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.members.map((m) => (
                <TableRow key={m.userId}>
                  <TableCell className="font-medium">{m.name ?? "—"}</TableCell>
                  <TableCell>{m.email ?? "—"}</TableCell>
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
                            {r === "admin" ? "Admin" : "Member"}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <Badge variant="outline" className="capitalize">
                        {m.role}
                      </Badge>
                    )}
                  </TableCell>
                  {data.canManage && (
                    <TableCell className="text-right">
                      {m.role !== "owner" && (
                        <Button variant="ghost" size="sm" onClick={() => void run(() => actions.remove(m.userId))}>
                          <Trash2 />
                          Remove
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {data.invites.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Pending invites</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  {data.canManage && <TableHead className="text-right">Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.invites.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-medium">
                      <Mail className="mr-2 inline size-4 text-muted-foreground" />
                      {i.email}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {i.role}
                      </Badge>
                    </TableCell>
                    {data.canManage && (
                      <TableCell className="text-right">
                        <Button variant="ghost" size="sm" onClick={() => void run(() => actions.revoke(i.id))}>
                          Revoke
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
