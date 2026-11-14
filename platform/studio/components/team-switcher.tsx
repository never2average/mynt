"use client"

// From shadcn/ui's sidebar-07 block (team-switcher.tsx, MIT): the workspace switcher at the top
// of the sidebar. Its menu lists the user's workspaces, then Invitations (N) when they have
// pending ones, and Create workspace. The workspace's members are on the Workspace page, a fixed
// item in the sidebar.
import * as React from "react"
import { ChevronsUpDown, Mail, Plus } from "lucide-react"

import { InvitationsList } from "@/components/invitations"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { Invitation } from "@/lib/invitations"
import type { Workspace } from "@/lib/workspaces"

const initial = (name: string) => (name.trim()[0] ?? "W").toUpperCase()

export function TeamSwitcher({
  workspaces,
  selected,
  supported,
  onSelect,
  onCreate,
  invitations = [],
  onAnswerInvitation = async () => null,
}: {
  workspaces: Workspace[]
  selected: Workspace
  supported: boolean
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<string | null> // an error to show, or null
  invitations?: Invitation[]
  onAnswerInvitation?: (id: string, action: "accept" | "decline") => Promise<string | null>
}) {
  const [showInvitations, setShowInvitations] = React.useState(false)
  const { isMobile } = useSidebar()
  const [creating, setCreating] = React.useState(false)
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)

  const create = async () => {
    if (busy) return
    setBusy(true)
    const failed = await onCreate(name)
    setBusy(false)
    if (failed) setError(failed)
    else {
      setCreating(false)
      setName("")
      setError(null)
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label="Switch workspace"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary font-semibold text-sidebar-primary-foreground">
                {initial(selected.name)}
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{selected.name}</span>
                <span className="truncate text-xs capitalize">{selected.implicit ? "Workspace" : selected.role}</span>
              </div>
              <ChevronsUpDown className="ml-auto" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            align="start"
            side={isMobile ? "bottom" : "right"}
            sideOffset={4}
          >
            <DropdownMenuLabel className="text-xs text-muted-foreground">Workspaces</DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onClick={() => onSelect(w.id)} className="gap-2 p-2">
                <div className="flex size-6 items-center justify-center rounded-md border text-xs font-medium">
                  {initial(w.name)}
                </div>
                <span className="flex-1 truncate">{w.name}</span>
                {w.id === selected.id && <span className="text-xs text-muted-foreground">Current</span>}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            {invitations.length > 0 && (
              <DropdownMenuItem className="gap-2 p-2" onSelect={() => setShowInvitations(true)}>
                <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                  <Mail className="size-4" />
                </div>
                <div className="font-medium">Invitations ({invitations.length})</div>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="gap-2 p-2" onSelect={() => setCreating(true)}>
              <div className="flex size-6 items-center justify-center rounded-md border bg-transparent">
                <Plus className="size-4" />
              </div>
              <div className="font-medium">Create workspace</div>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog open={showInvitations && invitations.length > 0} onOpenChange={setShowInvitations}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Invitations</DialogTitle>
              <DialogDescription>You join a workspace only if you accept.</DialogDescription>
            </DialogHeader>
            <InvitationsList invitations={invitations} onAnswer={onAnswerInvitation} />
          </DialogContent>
        </Dialog>

        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>
                {supported
                  ? "A workspace keeps its own apps and members."
                  : "Workspaces come with Mynt's next update. For now, everything is in your Personal workspace."}
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void create()
              }}
              className="flex flex-col gap-3"
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Workspace name"
                aria-label="Workspace name"
                maxLength={80}
                disabled={!supported}
              />
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={!supported || busy || !name.trim()}>
                  Create workspace
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
