"use client"

// Pending invitations to other people's workspaces: who invited the user, to which workspace,
// with what role, and what accepting grants on Mynt, with Accept and Decline. Joining is always
// this explicit choice. Shown as a banner on the dashboard and in the switcher's Invitations
// dialog; server-renderable for the tests.
import { useState } from "react"
import { Check, Mail, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { Invitation } from "@/lib/invitations"

type Answer = (id: string, action: "accept" | "decline") => Promise<string | null>

export function InvitationItem({ invitation, onAnswer }: { invitation: Invitation; onAnswer: Answer }) {
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const answer = async (action: "accept" | "decline") => {
    if (busy) return
    setBusy(action)
    const failed = await onAnswer(invitation.id, action)
    setBusy(null)
    setError(failed)
  }
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between" data-invitation={invitation.id}>
      <div className="min-w-0 space-y-1.5">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {invitation.workspaceName}
          <Badge variant="outline" className="capitalize">
            {invitation.role}
          </Badge>
        </p>
        <p className="text-sm text-muted-foreground">
          {invitation.inviter ? `Invited by ${invitation.inviter}` : "You've been invited"}
          {invitation.expiresAt ? ` · until ${invitation.expiresAt.slice(0, 10)}` : ""}
        </p>
        <div className="text-sm">
          <p className="text-muted-foreground">Accepting lets you:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {invitation.grants.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" onClick={() => void answer("accept")} disabled={busy !== null}>
          <Check />
          Accept
        </Button>
        <Button size="sm" variant="outline" onClick={() => void answer("decline")} disabled={busy !== null}>
          <X />
          Decline
        </Button>
      </div>
    </li>
  )
}

export function InvitationsList({ invitations, onAnswer }: { invitations: Invitation[]; onAnswer: Answer }) {
  if (!invitations.length) return <p className="text-sm text-muted-foreground">No pending invitations.</p>
  return (
    <ul className="space-y-3">
      {invitations.map((i) => (
        <InvitationItem key={i.id} invitation={i} onAnswer={onAnswer} />
      ))}
    </ul>
  )
}

// The dashboard's banner; nothing when there are no invitations.
export function InvitationsBanner({ invitations, onAnswer }: { invitations: Invitation[]; onAnswer: Answer }) {
  if (!invitations.length) return null
  return (
    <div className="px-4 pt-4 lg:px-6 lg:pt-6">
      <Card data-banner="invitations">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4" />
            {invitations.length === 1 ? "You've been invited to a workspace" : `You've been invited to ${invitations.length} workspaces`}
          </CardTitle>
          <CardDescription>You join a workspace only if you accept.</CardDescription>
        </CardHeader>
        <CardContent>
          <InvitationsList invitations={invitations} onAnswer={onAnswer} />
        </CardContent>
      </Card>
    </div>
  )
}
