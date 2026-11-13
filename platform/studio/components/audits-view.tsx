"use client"

// The Audits page's content: the workspace's audit trail as a paged table, with a full-width
// search over the page shown, filters Mynt applies (action, member, app, date range) and a
// labelled Export of the rows shown. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react"

import { downloadCsv, selectClass } from "@/components/licences-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { searchAudit, toCsv, type AuditEvent } from "@/lib/compliance"

export type AuditFilters = { action: string; user_id: string; app_id: string; from: string; to: string }
export const NO_AUDIT_FILTERS: AuditFilters = { action: "", user_id: "", app_id: "", from: "", to: "" }
export type Option = { id: string; name: string }

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ") + " UTC"
}
const targetOf = (e: AuditEvent) => [e.target.type, e.target.name ?? e.target.id].filter(Boolean).join(": ") || "—"

export function AuditsView({
  events,
  filters,
  onFilters,
  members,
  apps,
  actions,
  page,
  hasNext,
  onPrev,
  onNext,
  loading = false,
}: {
  events: AuditEvent[]
  filters: AuditFilters
  onFilters: (f: AuditFilters) => void
  members: Option[]
  apps: Option[]
  actions: string[]
  page: number
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
  loading?: boolean
}) {
  const [query, setQuery] = useState("")
  const shown = useMemo(() => searchAudit(events, query), [events, query])
  const set = (k: keyof AuditFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onFilters({ ...filters, [k]: e.target.value })
  const exportCsv = () =>
    downloadCsv(
      "audit.csv",
      toCsv(
        ["When", "Who", "Action", "Target", "Details"],
        shown.map((e) => [e.at, e.actor.name ?? e.actor.id, e.action, targetOf(e), e.details]),
      ),
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this page: action, person, target or details" className="pl-8" aria-label="Search the audit trail" />
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!shown.length}>
          <Download />
          Export CSV
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select className={selectClass} value={filters.action} onChange={set("action")} aria-label="Action">
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className={selectClass} value={filters.user_id} onChange={set("user_id")} aria-label="Member">
          <option value="">All members</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <select className={selectClass} value={filters.app_id} onChange={set("app_id")} aria-label="App">
          <option value="">All apps</option>
          {apps.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          From
          <Input type="date" value={filters.from} onChange={set("from")} className="h-9 w-40" />
        </label>
        <label className="flex items-center gap-1.5 text-muted-foreground">
          To
          <Input type="date" value={filters.to} onChange={set("to")} className="h-9 w-40" />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Who</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((e, i) => (
                <TableRow key={`${e.at}-${i}`}>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{when(e.at)}</TableCell>
                  <TableCell className="font-medium">{e.actor.name ?? e.actor.id ?? "Mynt"}</TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell>{targetOf(e)}</TableCell>
                  <TableCell className="max-w-80 truncate text-muted-foreground" title={e.details ?? undefined}>
                    {e.details ?? "—"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  {loading ? "Loading…" : events.length ? "Nothing on this page matches the search." : "No audit events match these filters."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <div className="flex items-center justify-end gap-2 text-sm">
        <span className="text-muted-foreground">Page {page}</span>
        <Button size="sm" variant="outline" onClick={onPrev} disabled={page <= 1 || loading}>
          <ChevronLeft />
          Previous
        </Button>
        <Button size="sm" variant="outline" onClick={onNext} disabled={!hasNext || loading}>
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  )
}
