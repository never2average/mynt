"use client"

// Admin → Audit trails (/platform/audit): Mynt's audit log across every workspace and firm (audit_log, lib/admin-audit.ts).
// The list convention: full-width search, one Filters popover (action, class, actor, workspace, firm, target type),
// the date range with its quick choices (past-looking), labelled Import (disabled, with why) and Export CSV, over a
// full-height table paged 25 rows at a time. A row opens /platform/audit/<id>: its metadata card, then Details (the
// entry's details as a table: secrets are never in it) and Related (other entries about the same target, newest 50).
// Read-only: nothing here changes anything. Server-renderable for the tests.
import { useCallback, useMemo, useState } from "react"

import { AdminDetail, AdminList, AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { DateRangeFilter } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { csvOf } from "@/lib/admin"
import {
  actionLabel,
  actorWords,
  AUDIT_CSV_HEAD,
  auditCsvRow,
  auditFacetOptions,
  classLabel,
  detailsShort,
  filterAudit,
  NO_AUDIT_FILTERS,
  placeWords,
  relatedEntries,
  TARGET_TYPE_LABELS,
  whenWords,
  type AuditEntry,
  type AuditFilters,
} from "@/lib/admin-audit"

export type AuditData = { entries: AuditEntry[]; limit: number }

const targetCell = (e: AuditEntry) => (
  <span className="flex min-w-0 flex-col">
    <span className="text-xs text-muted-foreground">{TARGET_TYPE_LABELS[e.targetType]}</span>
    <code className="truncate text-xs">{e.target || "—"}</code>
  </span>
)

export function AuditListView({ data, onOpen, now, initial = NO_AUDIT_FILTERS }: { data: AuditData; onOpen: (id: string) => void; now?: Date; initial?: AuditFilters }) {
  const [f, setF] = useState<AuditFilters>(initial)
  const options = useMemo(() => auditFacetOptions(data.entries), [data.entries])
  const shown = useMemo(() => filterAudit(data.entries, f), [data.entries, f])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const set = (patch: Partial<AuditFilters>) => {
    setF((x) => ({ ...x, ...patch }))
    setPage(1)
  }
  const facet = (id: "action" | "class" | "actor" | "workspace" | "firm" | "targetType", label: string) => ({ id, label, options: options[id], selected: f[id], onChange: (v: string[]) => set({ [id]: v }) })
  const exportCsv = () => downloadCsv("audit-trail.csv", csvOf(AUDIT_CSV_HEAD, shown.map(auditCsvRow)))
  return (
    <AdminList
      id="audit"
      search={f.query}
      onSearch={(q) => set({ query: q })}
      searchLabel="Search the audit trail by action, actor, target or detail"
      facets={[facet("action", "Action"), facet("class", "Class"), facet("actor", "Actor"), facet("workspace", "Workspace"), facet("firm", "Firm"), facet("targetType", "Target type")]}
      onClearFilters={() => set({ action: [], class: [], actor: [], workspace: [], firm: [], targetType: [] })}
      dates={<DateRangeFilter label="When" from={f.from} to={f.to} now={now} onChange={(from, to) => set({ from, to })} />}
      onExport={exportCsv}
      exportDisabled={!shown.length}
      note={data.entries.length >= data.limit ? `The newest ${data.limit} entries are loaded; search and filters look through those.` : null}
      page={page}
      pages={pages}
      total={shown.length}
      onPage={setPage}
    >
      <AdminTable
        head={["When", "Action", "Class", "Actor", "Workspace / Firm", "Target", "Details", ""]}
        rowKeys={onPage.map((e) => e.id)}
        onRow={(i) => onOpen(onPage[i].id)}
        rows={onPage.map((e) => [
          <span key="w" className="whitespace-nowrap tabular-nums">
            {whenWords(e.at)}
          </span>,
          actionLabel(e.action),
          <span key="c" data-audit-class={e.class ?? "none"}>
            {classLabel(e.class)}
          </span>,
          actorWords(e),
          placeWords(e),
          targetCell(e),
          <span key="d" className="text-xs text-muted-foreground">
            {detailsShort(e)}
          </span>,
          <Button
            key="o"
            size="sm"
            variant="outline"
            onClick={(ev) => {
              ev.stopPropagation()
              onOpen(e.id)
            }}
            data-open-audit={e.id}
          >
            Open
          </Button>,
        ])}
        empty={data.entries.length ? "No entries match these filters." : "Nothing in the audit trail yet."}
      />
    </AdminList>
  )
}

type DetailTab = "details" | "related"
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "related", label: "Related" },
]

export function AuditDetailView({ entry, related, onBack, onOpen, initialTab = "details" }: { entry: AuditEntry; related: AuditEntry[]; onBack: () => void; onOpen: (id: string) => void; initialTab?: DetailTab }) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  return (
    <AdminDetail
      backLabel="Back to audit trails"
      onBack={onBack}
      title={actionLabel(entry.action)}
      subtitle={classLabel(entry.class)}
      fields={[
        ["When", whenWords(entry.at)],
        ["Actor", actorWords(entry)],
        ["Workspace", entry.workspace ? (entry.workspace.name ?? entry.workspace.id) : "—"],
        ["Firm", entry.firm ? (entry.firm.name ?? entry.firm.id) : "—"],
        ["Target type", TARGET_TYPE_LABELS[entry.targetType]],
        ["Target", <code key="t" className="text-xs">{entry.target || "—"}</code>],
        ["Action", <code key="a" className="text-xs">{entry.action}</code>],
        ["Id", <code key="i" className="text-xs">{entry.id}</code>],
      ]}
      tabs={DETAIL_TABS}
      tab={tab}
      onTab={setTab}
    >
      {tab === "details" && <AdminTable head={["Detail", "Value"]} rowKeys={entry.details.map(([k]) => k)} rows={entry.details.map(([k, v]) => [k, <span key="v" className="break-all whitespace-normal">{v}</span>])} empty="This entry has no details." />}
      {tab === "related" && (
        <AdminTable
          head={["When", "Action", "Class", "Actor", "Details"]}
          rowKeys={related.map((e) => e.id)}
          onRow={(i) => onOpen(related[i].id)}
          rows={related.map((e) => [whenWords(e.at), actionLabel(e.action), classLabel(e.class), actorWords(e), detailsShort(e)])}
          empty="No other entries about this target among the newest loaded."
        />
      )}
    </AdminDetail>
  )
}

export function AuditTab({ id, onOpen, onBack }: { id: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.entries) ? ({ entries: b.entries as AuditEntry[], limit: Number(b.limit ?? b.entries.length) } as AuditData) : undefined), [])
  const { state } = useAdminData("/api/admin/audit", pick)
  if (state.kind !== "ready") return <AdminNotReady state={state} what={id ? "This audit entry" : "Audit trails"} />
  if (!id) return <AuditListView data={state.data} onOpen={onOpen} />
  const entry = state.data.entries.find((e) => e.id === id)
  if (!entry)
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-audit-missing>
        This entry isn&apos;t among the newest {state.data.limit} in the audit trail.
      </p>
    )
  return <AuditDetailView key={entry.id} entry={entry} related={relatedEntries(state.data.entries, entry)} onBack={onBack} onOpen={onOpen} />
}
