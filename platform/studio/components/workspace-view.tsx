"use client"

// The Settings page (/settings): the tab bar (shadcn's line tabs, components/ui/tabs.tsx) first,
// with no details card above it, each tab a table with its one toolbar row. Members and Invitations
// (components/members-view.tsx), Apps (every app with its stage, owner and last build),
// Repositories (the developer's own connected GitHub repositories) and
// General (Manage organization, the identity provider's page for the workspace; rename; for
// owners, archive, unarchive and relink, only where Mynt offers them).
// Server-renderable for the tests.
import Link from "next/link"
import { useMemo, useState } from "react"
import { Archive, Download, ExternalLink, Plus, RotateCcw } from "lucide-react"

import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { downloadCsv } from "@/components/licences-view"
import { dateOf, InvitationsTab, MembersTab, type MembersActions, type MembersData } from "@/components/members-view"
import { RepositoriesTab, type ReposState } from "@/components/repositories"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import { cn } from "@/lib/utils"
import { Tab, TabList } from "@/components/ui/tabs"
import { TAB_LABELS, WORKSPACE_TABS, type WorkspaceTab } from "@/lib/workspace-tabs"
import { STAGE_LABELS, STAGES, type Stage, type Workspace } from "@/lib/workspaces"


export type SettingsTools = { rename: boolean; archive: boolean; unarchive: boolean; relink: boolean }
export const NO_SETTINGS_TOOLS: SettingsTools = { rename: false, archive: false, unarchive: false, relink: false }

export type WorkspaceInfo = {
  supported: boolean // Mynt has workspaces
  message?: string
  workspace: Workspace
  canManage: boolean
  isOwner: boolean
  tools: SettingsTools // what this Mynt offers, read from its tool list
}

export type WorkspaceApp = {
  id: string
  name: string
  stage: Stage
  owner: string | null // a member's name or email; null when Mynt doesn't say
  lastBuild: { id: string; status: string; at: string | null } | null
}

export type SettingsActions = {
  rename(name: string): Promise<string | null>
  archive(): Promise<string | null>
  unarchive(): Promise<string | null>
  relink(): Promise<string | null>
}

export function TabSelector({ tab, onTab }: { tab: WorkspaceTab; onTab: (t: WorkspaceTab) => void }) {
  return (
    <TabList aria-label="Settings">
      {WORKSPACE_TABS.map((t) => (
        <Tab key={t} selected={tab === t} data-tab={t} onClick={() => onTab(t)}>
          {TAB_LABELS[t]}
        </Tab>
      ))}
    </TabList>
  )
}

export function AppsTab({ workspace, apps }: { workspace: Workspace; apps: WorkspaceApp[] }) {
  const [query, setQuery] = useState("")
  const rows = useMemo(() => apps.filter((a) => matches(query, a.name, STAGE_LABELS[a.stage], a.owner)), [apps, query])
  const { page, pages, shown, setPage } = usePaged(rows)
  const exportCsv = () =>
    downloadCsv(
      `${workspace.name}-apps.csv`,
      toCsv(["App", "Stage", "Owner", "Last build", "Last build at"], rows.map((a) => [a.name, STAGE_LABELS[a.stage], a.owner, a.lastBuild?.status ?? null, a.lastBuild?.at ?? null])),
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel="apps">
      <ListLayout
        search={query}
        onSearch={setQuery}
        searchLabel="Search apps by name, stage or owner"
        actions={
          <Button variant="outline" onClick={exportCsv} disabled={!rows.length}>
            <Download />
            Export CSV
          </Button>
        }
        cta={
          <Button asChild>
            <Link href="/new">
              <Plus />
              New app
            </Link>
          </Button>
        }
        page={page}
        pages={pages}
        total={rows.length}
        onPage={setPage}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Last build</TableHead>
              <TableHead className="text-right">Links</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((a) => (
                <TableRow key={a.id} data-app-row={a.id}>
                  <TableCell className="font-medium">{a.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{STAGE_LABELS[a.stage]}</Badge>
                  </TableCell>
                  <TableCell>{a.owner ?? <span className="text-muted-foreground">Not shown by Mynt</span>}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {a.lastBuild ? `${a.lastBuild.status}${dateOf(a.lastBuild.at) ? ` · ${dateOf(a.lastBuild.at)}` : ""}` : "None yet"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/${encodeURIComponent(a.id)}`}>Open app</Link>
                      </Button>
                      {a.lastBuild && (
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/${encodeURIComponent(a.id)}/${encodeURIComponent(a.lastBuild.id)}`}>Last build</Link>
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {apps.length ? "No app matches the search." : "No apps in this workspace yet."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
    </div>
  )
}

export function SettingsTab({ info, actions, manageUrl = null }: { info: WorkspaceInfo; actions: SettingsActions; manageUrl?: string | null }) {
  const w = info.workspace
  const [name, setName] = useState(w.name)
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  if (!info.supported)
    return (
      <p className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground" data-tab-panel="general" data-empty="not-available">
        {info.message ?? "Workspace settings come with Mynt's workspaces."}
      </p>
    )

  const run = async (act: () => Promise<string | null>, done: string) => {
    if (busy) return
    setBusy(true)
    const failed = await act()
    setBusy(false)
    setConfirming(false)
    setMessage(failed ? { error: true, text: failed } : { error: false, text: done })
  }
  const ownerTools = info.isOwner && !w.personal && (info.tools.archive || info.tools.unarchive || info.tools.relink)

  return (
    <div className="flex flex-col gap-4" data-tab-panel="general">
      {manageUrl && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4" data-manage-org>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">Organization</span>
          </div>
          <Button variant="outline" asChild>
            <a href={manageUrl} target="_blank" rel="noopener noreferrer" data-manage-url>
              <ExternalLink />
              Manage organization
            </a>
          </Button>
        </div>
      )}
      {message && (
        <p role={message.error ? "alert" : "status"} className={cn("text-sm", message.error ? "text-destructive" : "font-medium")}>
          {message.text}
        </p>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Name</CardTitle>
          <CardDescription>{info.canManage ? "Owners and admins can rename the workspace." : "Only the workspace's owners and admins can rename it."}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-2 sm:flex-row"
            data-rename-form
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => actions.rename(name), "Renamed.")
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" maxLength={80} disabled={!info.canManage || !info.tools.rename} />
            <Button type="submit" disabled={!info.canManage || !info.tools.rename || busy || !name.trim() || name.trim() === w.name}>
              Rename workspace
            </Button>
          </form>
        </CardContent>
      </Card>

      {ownerTools && (
        <Card data-owner-settings>
          <CardHeader>
            <CardTitle>Archive</CardTitle>
            <CardDescription>Owners only. Archiving freezes the workspace; 7 days later everyone is removed. Until then it can be undone.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {w.orgMissingSince && info.tools.relink && (
              <div className="flex flex-col gap-2" data-relink>
                <p className="text-sm text-muted-foreground">
                  Its organization was deleted in the identity provider on {dateOf(w.orgMissingSince) ?? "an unknown date"}, so the workspace is frozen. Give it a new
                  organization with its members in it, or archive it.
                </p>
                <div>
                  <Button variant="outline" onClick={() => void run(actions.relink, "It has a new organization, with its members in it.")} disabled={busy}>
                    Give it a new organization
                  </Button>
                </div>
              </div>
            )}
            {w.archivedAt ? (
              info.tools.unarchive && (
                <div className="flex flex-col gap-2" data-unarchive>
                  <p className="text-sm text-muted-foreground">
                    Archived on {dateOf(w.archivedAt) ?? "an unknown date"}.{" "}
                    {w.offboardingAt ? `Everyone is removed on ${dateOf(w.offboardingAt)} unless you unarchive it.` : ""}
                  </p>
                  <div>
                    <Button variant="outline" onClick={() => void run(actions.unarchive, "Unarchived. Nobody was removed.")} disabled={busy}>
                      <RotateCcw />
                      Unarchive workspace
                    </Button>
                  </div>
                </div>
              )
            ) : (
              info.tools.archive && (
                <div className="flex flex-wrap items-center gap-2" data-archive>
                  {confirming ? (
                    <>
                      <span className="text-sm">Archive {w.name}? You can undo it for 7 days.</span>
                      <Button variant="destructive" onClick={() => void run(actions.archive, "Archived. You can unarchive it for 7 days.")} disabled={busy}>
                        Yes, archive workspace
                      </Button>
                      <Button variant="ghost" onClick={() => setConfirming(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="outline" onClick={() => setConfirming(true)}>
                      <Archive />
                      Archive workspace
                    </Button>
                  )}
                </div>
              )
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}

export function WorkspaceView({
  tab,
  onTab,
  info,
  members,
  apps,
  memberActions,
  settingsActions,
  repos = { kind: "loading" },
  onReposChanged,
}: {
  tab: WorkspaceTab
  onTab: (t: WorkspaceTab) => void
  info: WorkspaceInfo
  members: MembersData | null
  apps: WorkspaceApp[] | null
  memberActions: MembersActions
  settingsActions: SettingsActions
  repos?: ReposState // the developer's own repositories (not the workspace's)
  onReposChanged?: () => void
}) {
  const loading = <Skeleton className="h-64 w-full rounded-xl" />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-workspace-view>
      <TabSelector tab={tab} onTab={onTab} />
      {tab === "members" && (members ? <MembersTab workspace={info.workspace} data={members} actions={memberActions} /> : loading)}
      {tab === "invitations" && (members ? <InvitationsTab workspace={info.workspace} data={members} actions={memberActions} /> : loading)}
      {tab === "apps" && (apps ? <AppsTab workspace={info.workspace} apps={apps} /> : loading)}
      {tab === "repositories" && <RepositoriesTab state={repos} onConnected={onReposChanged} />}
      {tab === "general" && <SettingsTab info={info} actions={settingsActions} manageUrl={members?.manageUrl ?? null} />}
    </div>
  )
}
