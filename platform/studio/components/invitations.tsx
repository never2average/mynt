"use client"

// Pending invitations to other people's workspaces: who invited the user, to which workspace,
// with what role, and what accepting grants on Mynt, with Accept and Decline. Joining is always
// this explicit choice. Each invitation is a row; the dashboard shows them as one flat panel (the
// dashboard's Panel and Section) inside its page frame, and the switcher's Invitations dialog
// lists the same rows. Server-renderable for the tests.
import { useState } from "react"
import { Check, X } from "lucide-react"

import { Panel, Section } from "@/components/dashboard-panels"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between" data-invitation={invitation.id}>
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {invitation.workspaceName}
          <Badge variant="outline" className="capitalize">
            {invitation.role}
          </Badge>
        </p>
        <p className="text-sm text-muted-foreground">
          {invitation.inviter ? `Invited by ${invitation.inviter}` : "You've been invited"}
          {invitation.expiresAt ? ` · until ${invitation.expiresAt.slice(0, 10)}` : ""}
        </p>
        {invitation.grants.length > 0 && (
          <div className="text-xs text-muted-foreground" data-grants>
            <p>Accepting lets you:</p>
            <ul className="list-disc pl-4">
              {invitation.grants.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          </div>
        )}
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
    <ul className="divide-y" data-invitations>
      {invitations.map((i) => (
        <InvitationItem key={i.id} invitation={i} onAnswer={onAnswer} />
      ))}
    </ul>
  )
}

// The dashboard's banner: one flat panel, a row per invitation; nothing when there are none. The
// page places it inside its frame's padding.
export function InvitationsBanner({ invitations, onAnswer }: { invitations: Invitation[]; onAnswer: Answer }) {
  if (!invitations.length) return null
  return (
    <Panel id="invitations">
      <div data-banner="invitations">
        <Section id="invitations" title={invitations.length === 1 ? "You've been invited to a workspace" : `You've been invited to ${invitations.length} workspaces`}>
          <InvitationsList invitations={invitations} onAnswer={onAnswer} />
        </Section>
      </div>
    </Panel>
  )
}
