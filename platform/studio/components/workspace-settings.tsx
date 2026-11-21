"use client"

// The workspace's own settings, in the workspace switcher's menu (once Settings' General tab):
// Rename workspace for owners and admins, and for owners Archive workspace, Unarchive workspace and
// a new organization for a frozen one, each only where this Mynt offers it. Each opens a Sheet.
// Mynt checks every change again (app/api/workspaces/[workspaceId]/route.ts).
import * as React from "react"

import { dateOf } from "@/components/members-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { NO_SETTINGS_TOOLS, type SettingsActions, type WorkspaceInfo } from "@/components/workspace-view"
import { cn } from "@/lib/utils"
import type { Workspace } from "@/lib/workspaces"

export type WorkspaceSetting = "rename" | "archive" | "unarchive" | "relink"
export type WorkspaceSettings = { info: WorkspaceInfo | null; actions: SettingsActions }

export const SETTING_LABELS: Record<WorkspaceSetting, string> = {
  rename: "Rename workspace",
  archive: "Archive workspace",
  unarchive: "Unarchive workspace",
  relink: "Give it a new organization",
}

// Which of the settings this user may use on this workspace: the checks General made.
export function allowedSettings(info: WorkspaceInfo | null): WorkspaceSetting[] {
  if (!info?.supported) return []
  const w = info.workspace
  const owner = info.isOwner && !w.personal
  const out: WorkspaceSetting[] = []
  if (info.canManage && info.tools.rename) out.push("rename")
  if (owner && !w.archivedAt && info.tools.archive) out.push("archive")
  if (owner && w.archivedAt && info.tools.unarchive) out.push("unarchive")
  if (owner && w.orgMissingSince && info.tools.relink) out.push("relink")
  return out
}

const failedText = "That didn't work. Please try again."

async function send(url: string, method: string, payload: unknown): Promise<string | null> {
  const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
  const body = (await res?.json().catch(() => null)) as { message?: string } | null
  return res?.ok ? null : (body?.message ?? failedText)
}

// The selected workspace's settings info (GET /api/workspaces/:id) and the calls that change it;
// after a change, the workspaces list and the info load again.
export function useWorkspaceSettings(selected: Workspace, reload: () => Promise<unknown> | void, enabled = true): WorkspaceSettings {
  const [info, setInfo] = React.useState<WorkspaceInfo | null>(null)
  const id = encodeURIComponent(selected.id)
  const real = enabled && !selected.implicit

  const load = React.useCallback(async () => {
    if (!real) return setInfo(null)
    const res = await fetch(`/api/workspaces/${id}`, { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as WorkspaceInfo | null
    setInfo(res?.ok && body ? { ...body, tools: { ...NO_SETTINGS_TOOLS, ...body.tools }, canManage: body.canManage ?? false, isOwner: body.isOwner ?? false } : null)
  }, [id, real])

  React.useEffect(() => {
    setInfo(null)
    void load()
  }, [load])

  const actions: SettingsActions = React.useMemo(() => {
    const base = `/api/workspaces/${id}`
    const then = async (failed: string | null) => {
      if (!failed) await Promise.all([reload(), load()])
      return failed
    }
    return {
      rename: async (name) => then(await send(base, "PATCH", { name })),
      archive: async () => then(await send(base, "POST", { action: "archive" })),
      unarchive: async () => then(await send(base, "POST", { action: "unarchive" })),
      relink: async () => then(await send(base, "POST", { action: "relink" })),
    }
  }, [id, reload, load])

  return { info, actions }
}

type SheetProps = { open: boolean; onOpenChange: (open: boolean) => void; workspace: Workspace }

function Failure({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  ) : null
}

// Rename workspace: the name and Save.
export function RenameWorkspaceSheet({ open, onOpenChange, workspace, onRename }: SheetProps & { onRename: (name: string) => Promise<string | null> }) {
  const [name, setName] = React.useState(workspace.name)
  const [busy, setBusy] = React.useState(false)
  const [failed, setFailed] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (open) {
      setName(workspace.name)
      setFailed(null)
    }
  }, [open, workspace.name])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} data-rename-sheet>
        <SheetHeader>
          <SheetTitle>Rename workspace</SheetTitle>
        </SheetHeader>
        <form
          className="flex flex-1 flex-col gap-3 px-4"
          data-rename-form
          onSubmit={async (e) => {
            e.preventDefault()
            if (busy || !name.trim()) return
            setBusy(true)
            const err = await onRename(name.trim())
            setBusy(false)
            if (err) setFailed(err)
            else onOpenChange(false)
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" maxLength={80} />
          <Failure text={failed} />
          <SheetFooter className="px-0">
            <Button type="submit" disabled={busy || !name.trim() || name.trim() === workspace.name}>
              Save
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

// Archive, unarchive or relink: a confirmation with what happens, then Yes; once done, what
// happened and Close.
const CONFIRM: Record<Exclude<WorkspaceSetting, "rename">, { title: (w: Workspace) => string; body: (w: Workspace) => string; yes: string; done: string; destructive: boolean }> = {
  archive: {
    title: (w) => `Archive ${w.name}?`,
    body: () => "Archiving freezes the workspace; 7 days later everyone is removed. Until then it can be undone.",
    yes: "Yes, archive workspace",
    done: "Archived. You can unarchive it for 7 days.",
    destructive: true,
  },
  unarchive: {
    title: (w) => `Unarchive ${w.name}?`,
    body: (w) =>
      `Archived on ${dateOf(w.archivedAt) ?? "an unknown date"}.${w.offboardingAt ? ` Everyone is removed on ${dateOf(w.offboardingAt)} unless you unarchive it.` : ""}`,
    yes: "Yes, unarchive workspace",
    done: "Unarchived. Nobody was removed.",
    destructive: false,
  },
  relink: {
    title: (w) => `Give ${w.name} a new organization?`,
    body: (w) => `Frozen: its organization was deleted in the identity provider on ${dateOf(w.orgMissingSince) ?? "an unknown date"}.`,
    yes: "Yes, give it a new organization",
    done: "It has a new organization, with its members in it.",
    destructive: false,
  },
}

export function ConfirmWorkspaceSheet({
  open,
  onOpenChange,
  workspace,
  kind,
  onConfirm,
}: SheetProps & { kind: Exclude<WorkspaceSetting, "rename">; onConfirm: () => Promise<string | null> }) {
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<{ error: boolean; text: string } | null>(null)
  // The workspace as it was when the sheet opened: once archived, the title stays "Archive …?".
  const [shown, setShown] = React.useState(workspace)
  React.useEffect(() => {
    if (open) {
      setResult(null)
      setShown(workspace)
    }
  }, [open])
  const c = CONFIRM[kind]
  const done = result && !result.error

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} data-confirm-sheet={kind}>
        <SheetHeader>
          <SheetTitle>{c.title(shown)}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4">
          {!done && <p className="text-sm text-muted-foreground">{c.body(shown)}</p>}
          {result && (
            <p role={result.error ? "alert" : "status"} className={cn("text-sm", result.error ? "text-destructive" : "font-medium")}>
              {result.text}
            </p>
          )}
        </div>
        <SheetFooter>
          {done ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          ) : (
            <>
              <Button
                variant={c.destructive ? "destructive" : "default"}
                disabled={busy}
                onClick={async () => {
                  if (busy) return
                  setBusy(true)
                  const err = await onConfirm()
                  setBusy(false)
                  setResult(err ? { error: true, text: err } : { error: false, text: c.done })
                }}
              >
                {c.yes}
              </Button>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}

// The open sheet, if any, for the switcher.
export function WorkspaceSettingSheets({ open, onClose, workspace, actions }: { open: WorkspaceSetting | null; onClose: () => void; workspace: Workspace; actions: SettingsActions }) {
  const change = (o: boolean) => {
    if (!o) onClose()
  }
  return (
    <>
      <RenameWorkspaceSheet open={open === "rename"} onOpenChange={change} workspace={workspace} onRename={actions.rename} />
      {(["archive", "unarchive", "relink"] as const).map((k) => (
        <ConfirmWorkspaceSheet key={k} kind={k} open={open === k} onOpenChange={change} workspace={workspace} onConfirm={actions[k]} />
      ))}
    </>
  )
}
