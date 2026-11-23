"use client"

// Admin → Workspaces: every workspace on Mynt (list_all_workspaces), whichever one the sidebar has picked. A row's
// Open shows the workspace (admin_get_workspace): its metadata card, then Members, Apps, Invitations and Activity, each
// a table. There are no actions here: renaming, archiving and relinking a workspace are its owners' (the switcher's
// menu), and Mynt gives admins no tool for them. Server-renderable.
import { useCallback, useMemo, useState } from "react"

import { AdminDetail, AdminList, AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StageMark, StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { csvOf, dateOf, whenOf, words, type AdminWorkspace, type WorkspaceDetail } from "@/lib/admin"
import type { Stage } from "@/lib/workspaces"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
  { value: "frozen", label: "Frozen" },
]
const KIND_OPTIONS = [
  { value: "team", label: "Team" },
  { value: "personal", label: "Personal" },
]

export function WorkspaceStatus({ status }: { status: string }) {
  if (status === "frozen") return <StatusDot tone="red" label="Frozen (organization missing)" data-status={status} />
  if (status === "archived") return <StatusDot tone="gray" label="Archived" data-status={status} />
  return <StatusDot tone="green" label="Active" data-status={status} />
}

const ownerOf = (w: AdminWorkspace) => w.owner?.email ?? w.owner?.name ?? "—"

export function WorkspacesListView({ workspaces, total, onOpen }: { workspaces: AdminWorkspace[]; total: number; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string[]>([])
  const [kind, setKind] = useState<string[]>([])
  const shown = useMemo(
    () =>
      workspaces.filter(
        (w) => matches(query, w.name, w.owner?.email, w.owner?.name, w.id) && (!status.length || status.includes(w.status)) && (!kind.length || kind.includes(w.personal ? "personal" : "team")),
      ),
    [workspaces, query, status, kind],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv("workspaces.csv", csvOf(["Name", "Owner", "Members", "Apps", "Status", "Created", "Id"], shown.map((w) => [w.name, ownerOf(w), w.members, w.apps, w.status, dateOf(w.createdAt), w.id])))
  return (
    <AdminList
      id="workspaces"
      search={query}
      onSearch={(q) => {
        setQuery(q)
        setPage(1)
      }}
      searchLabel="Search workspaces by name, owner or id"
      facets={[
        { id: "status", label: "Status", options: STATUS_OPTIONS, selected: status, onChange: (v) => (setStatus(v), setPage(1)) },
        { id: "kind", label: "Kind", options: KIND_OPTIONS, selected: kind, onChange: (v) => (setKind(v), setPage(1)) },
      ]}
      onClearFilters={() => (setStatus([]), setKind([]))}
      onExport={exportCsv}
      exportDisabled={!shown.length}
      note={total > workspaces.length ? `The newest ${workspaces.length} of ${total} workspaces are loaded.` : null}
      page={page}
      pages={pages}
      total={shown.length}
      onPage={setPage}
    >
      <AdminTable
        head={["Workspace", "Owner", "Members", "Apps", "Status", "Created", ""]}
        rowKeys={onPage.map((w) => w.id)}
        rows={onPage.map((w) => [
          <span key="n">
            {w.name}
            {w.personal && <span className="ml-2 text-xs text-muted-foreground">Personal</span>}
          </span>,
          ownerOf(w),
          String(w.members),
          String(w.apps),
          <WorkspaceStatus key="s" status={w.status} />,
          dateOf(w.createdAt),
          <Button key="o" size="sm" variant="outline" onClick={() => onOpen(w.id)} data-open-workspace={w.id}>
            Open
          </Button>,
        ])}
        empty={workspaces.length ? "No workspaces match these filters." : "No workspaces yet."}
      />
    </AdminList>
  )
}

type DetailTab = "members" | "apps" | "invitations" | "activity"
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "members", label: "Members" },
  { id: "apps", label: "Apps" },
  { id: "invitations", label: "Invitations" },
  { id: "activity", label: "Activity" },
]

export function WorkspaceDetailView({ detail, onBack, onOpenApp, initialTab = "members" }: { detail: WorkspaceDetail; onBack: () => void; onOpenApp: (id: string) => void; initialTab?: DetailTab }) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const w = detail.workspace
  return (
    <AdminDetail
      backLabel="Back to workspaces"
      onBack={onBack}
      title={w.name}
      subtitle={w.personal ? "Personal workspace" : "Team workspace"}
      fields={[
        ["Owner", ownerOf(w)],
        ["Status", <WorkspaceStatus key="s" status={w.status} />],
        ["Members", String(w.members)],
        ["Apps", String(w.apps)],
        ["Created", dateOf(w.createdAt)],
        ["Id", <code key="i" className="text-xs">{w.id}</code>],
      ]}
      tabs={DETAIL_TABS}
      tab={tab}
      onTab={setTab}
    >
      {tab === "members" && (
        <AdminTable head={["Name", "Email", "Role", "Joined"]} rowKeys={detail.members.map((m) => m.userId)} rows={detail.members.map((m) => [m.name ?? "—", m.email ?? "—", words(m.role), dateOf(m.joinedAt)])} empty="No members." />
      )}
      {tab === "apps" && (
        <AdminTable
          head={["App", "Stage", "Status", "Latest build", ""]}
          rowKeys={detail.apps.map((a) => a.id)}
          rows={detail.apps.map((a) => [
            a.name,
            <StageMark key="s" stage={a.stage as Stage} />,
            words(a.status),
            a.latestBuild ? `${words(a.latestBuild.status)} · ${dateOf(a.latestBuild.createdAt)}` : "No builds",
            <Button key="o" size="sm" variant="outline" onClick={() => onOpenApp(a.id)} data-open-app={a.id}>
              Open app
            </Button>,
          ])}
          empty="No apps in this workspace."
        />
      )}
      {tab === "invitations" && (
        <AdminTable
          head={["Email", "Role", "Mynt role", "Status", "Invited by", "Sent"]}
          rowKeys={detail.invitations.map((i) => i.id)}
          rows={detail.invitations.map((i) => [i.email, words(i.role), i.myntRole === "consumer" ? "User" : words(i.myntRole), words(i.status), i.invitedBy ?? "—", dateOf(i.createdAt)])}
          empty="No invitations."
        />
      )}
      {tab === "activity" && (
        <AdminTable head={["When", "Action", "By", "About"]} rowKeys={detail.activity.map((e) => e.id)} rows={detail.activity.map((e) => [whenOf(e.createdAt), words(e.action), e.actor ?? "Mynt", <code key="t" className="text-xs">{e.target}</code>])} empty="No activity yet." />
      )}
    </AdminDetail>
  )
}

export function WorkspacesTab({ id, onOpen, onBack, onOpenApp }: { id: string | null; onOpen: (id: string) => void; onBack: () => void; onOpenApp: (id: string) => void }) {
  const pickList = useCallback((b: Record<string, unknown>) => (Array.isArray(b.workspaces) ? { rows: b.workspaces as AdminWorkspace[], total: Number(b.total ?? b.workspaces.length) } : undefined), [])
  const pickOne = useCallback((b: Record<string, unknown>) => (b.detail as WorkspaceDetail | undefined) ?? undefined, [])
  const list = useAdminData(id ? null : "/api/admin/workspaces", pickList)
  const one = useAdminData(id ? `/api/admin/workspaces/${encodeURIComponent(id)}` : null, pickOne)
  if (id) return one.state.kind === "ready" ? <WorkspaceDetailView detail={one.state.data} onBack={onBack} onOpenApp={onOpenApp} /> : <AdminNotReady state={one.state} what="This workspace" />
  return list.state.kind === "ready" ? <WorkspacesListView workspaces={list.state.data.rows} total={list.state.data.total} onOpen={onOpen} /> : <AdminNotReady state={list.state} what="Workspaces" />
}
