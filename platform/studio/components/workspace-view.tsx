"use client"

// The Settings page (/settings): the tab bar (shadcn's line tabs, components/ui/tabs.tsx) first,
// with no details card above it, in the dashboard's layout: key figures in a Panel where the tab
// is about counts, then one toolbar row over a paged table. Members and Invitations
// (components/members-view.tsx), Apps (every app with its stage, owner and last build),
// Repositories (the developer's own connected GitHub repositories) and General (Organization
// with Manage organization, the identity provider's page for the workspace; Name; for owners,
// Archive, with unarchive and relink, only where Mynt offers them). Flat Panels, no cards.
// Server-renderable for the tests.
import Link from "next/link"
import { useMemo, useState } from "react"
import { Archive, Download, ExternalLink, Plus, RotateCcw } from "lucide-react"

import { KpiRow } from "@/components/charts"
import { Panel, Section } from "@/components/dashboard-panels"
import { FilterSelect } from "@/components/filter-controls"
import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { downloadCsv } from "@/components/licences-view"
import { dateOf, InvitationsTab, MembersTab, type MembersActions, type MembersData } from "@/components/members-view"
import { StatusDot } from "@/components/promotion-view"
import { RepositoriesTab, type ReposState } from "@/components/repositories"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toCsv } from "@/lib/compliance"
import type { Kpi } from "@/lib/dashboard-visual"
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

const STAGE_OPTIONS = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))

/** An app's stage as the dashboard shows status: a dot in words (Production green, Staging amber), Ideas as plain text. */
export function StageMark({ stage }: { stage: Stage }) {
  if (stage === "production") return <StatusDot tone="green" label={STAGE_LABELS[stage]} />
  if (stage === "staging") return <StatusDot tone="amber" label={STAGE_LABELS[stage]} />
  return (
    <span className="text-xs font-medium text-muted-foreground" data-stage={stage}>
      {STAGE_LABELS[stage]}
    </span>
  )
}

/** The Apps tab's key figures, counted from the apps Mynt listed. */
export function appKpis(apps: WorkspaceApp[]): Kpi[] {
  const kpi = (key: string, label: string, value: number): Kpi => ({ key, label, value, unit: "count", delta: null, spark: null, note: "" })
  const count = (s: Stage) => apps.filter((a) => a.stage === s).length
  return [kpi("apps", "Apps", apps.length), kpi("production", "Production", count("production")), kpi("staging", "Staging", count("staging")), kpi("ideas", "Ideas", count("idea"))]
}

export function AppsTab({ workspace, apps }: { workspace: Workspace; apps: WorkspaceApp[] }) {
  const [query, setQuery] = useState("")
  const [stage, setStage] = useState("")
  const rows = useMemo(() => apps.filter((a) => (!stage || a.stage === stage) && matches(query, a.name, STAGE_LABELS[a.stage], a.owner)), [apps, query, stage])
  const { page, pages, shown, setPage } = usePaged(rows)
  const exportCsv = () =>
    downloadCsv(
      `${workspace.name}-apps.csv`,
      toCsv(["App", "Stage", "Owner", "Last build", "Last build at"], rows.map((a) => [a.name, STAGE_LABELS[a.stage], a.owner, a.lastBuild?.status ?? null, a.lastBuild?.at ?? null])),
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:gap-5" data-tab-panel="apps">
      <Panel id="app-kpis">
        <section className="flex flex-col gap-3" data-section="kpis" aria-label="Key figures">
          <KpiRow kpis={appKpis(apps)} />
        </section>
      </Panel>
      <ListLayout
        search={query}
        onSearch={setQuery}
        searchLabel="Search apps by name, stage or owner"
        actions={
          <>
            <FilterSelect label="Stage" value={stage} options={STAGE_OPTIONS} onChange={setStage} />
            <Button variant="outline" onClick={exportCsv} disabled={!rows.length}>
              <Download />
              Export CSV
            </Button>
          </>
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
                    <StageMark stage={a.stage} />
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
  const canRename = info.canManage && info.tools.rename
  const showArchive = !w.archivedAt && info.tools.archive

  return (
    <div className="flex flex-col gap-4 lg:gap-5" data-tab-panel="general">
      {message && (
        <p role={message.error ? "alert" : "status"} className={cn("text-sm", message.error ? "text-destructive" : "font-medium")}>
          {message.text}
        </p>
      )}
      {manageUrl && (
        <Panel id="organization">
          <div className="flex flex-wrap items-center gap-3" data-manage-org>
            <h2 className="min-w-0 flex-1 text-sm font-semibold">Organization</h2>
            <Button variant="outline" asChild>
              <a href={manageUrl} target="_blank" rel="noopener noreferrer" data-manage-url>
                <ExternalLink />
                Manage organization
              </a>
            </Button>
          </div>
        </Panel>
      )}
      <Panel id="name">
        <Section id="workspace-name" title="Name">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            data-rename-form
            onSubmit={(e) => {
              e.preventDefault()
              void run(() => actions.rename(name), "Renamed.")
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Workspace name" maxLength={80} disabled={!canRename} />
            <Button type="submit" disabled={!canRename || busy || !name.trim() || name.trim() === w.name}>
              Save
            </Button>
          </form>
        </Section>
      </Panel>

      {ownerTools && (
        <Panel id="archive">
          <div data-owner-settings>
            <Section
              id="archive"
              title="Archive"
              action={
                showArchive ? (
                  <Button variant="outline" onClick={() => setConfirming(true)} disabled={busy} data-archive>
                    <Archive />
                    Archive workspace
                  </Button>
                ) : undefined
              }
            >
              {w.orgMissingSince && info.tools.relink && (
                <div className="flex flex-wrap items-center gap-3" data-relink>
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Frozen: its organization was deleted in the identity provider on {dateOf(w.orgMissingSince) ?? "an unknown date"}.
                  </p>
                  <Button variant="outline" onClick={() => void run(actions.relink, "It has a new organization, with its members in it.")} disabled={busy}>
                    Give it a new organization
                  </Button>
                </div>
              )}
              {w.archivedAt && info.tools.unarchive && (
                <div className="flex flex-wrap items-center gap-3" data-unarchive>
                  <p className="min-w-0 flex-1 text-sm text-muted-foreground">
                    Archived on {dateOf(w.archivedAt) ?? "an unknown date"}.{" "}
                    {w.offboardingAt ? `Everyone is removed on ${dateOf(w.offboardingAt)} unless you unarchive it.` : ""}
                  </p>
                  <Button variant="outline" onClick={() => void run(actions.unarchive, "Unarchived. Nobody was removed.")} disabled={busy}>
                    <RotateCcw />
                    Unarchive workspace
                  </Button>
                </div>
              )}
            </Section>
          </div>
        </Panel>
      )}

      {ownerTools && showArchive && (
        <Dialog open={confirming} onOpenChange={setConfirming}>
          <DialogContent className="sm:max-w-md" data-archive-confirm>
            <DialogHeader>
              <DialogTitle>Archive {w.name}?</DialogTitle>
              <DialogDescription>Archiving freezes the workspace; 7 days later everyone is removed. Until then it can be undone.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void run(actions.archive, "Archived. You can unarchive it for 7 days.")} disabled={busy}>
                Yes, archive workspace
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
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
  const loading = <Skeleton className="h-64 w-full" data-loading />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:gap-5" data-workspace-view>
      <TabSelector tab={tab} onTab={onTab} />
      {tab === "members" && (members ? <MembersTab workspace={info.workspace} data={members} actions={memberActions} /> : loading)}
      {tab === "invitations" && (members ? <InvitationsTab workspace={info.workspace} data={members} actions={memberActions} /> : loading)}
      {tab === "apps" && (apps ? <AppsTab workspace={info.workspace} apps={apps} /> : loading)}
      {tab === "repositories" && <RepositoriesTab state={repos} onConnected={onReposChanged} />}
      {tab === "general" && <SettingsTab info={info} actions={settingsActions} manageUrl={members?.manageUrl ?? null} />}
    </div>
  )
}
