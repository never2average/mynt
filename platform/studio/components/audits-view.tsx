"use client"

// The Audits page's tables. AuditsView: one class of the workspace's records (App security,
// Financial activity or Workspace activity) as a paged table, with a full-width search over the
// page shown, a filters row (kind, member, app, date range, and severity or status where the
// class has them) and a labelled Export of the rows shown. ObligationsView: each licence's
// regulatory obligations for the products it covers (met, at risk, overdue, with evidence),
// searchable, filtered by partner, regulator, status and product, and exportable. Status is
// never colour alone. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react"

import { downloadCsv, selectClass } from "@/components/licences-view"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  AUDIT_CLASS_HELP,
  AUDIT_CLASS_LABELS,
  AUDIT_CLASSES,
  filterObligations,
  NO_OBLIGATION_FILTERS,
  OBLIGATION_LABELS,
  OBLIGATION_STATUSES,
  searchRows,
  type AuditClass,
  type AuditRow,
  type Obligation,
  type ObligationFilters,
  type ObligationStatus,
} from "@/lib/audit-classes"
import { distinct, toCsv } from "@/lib/compliance"
import { cn } from "@/lib/utils"

export function AuditTabs({ tab, onTab }: { tab: AuditClass; onTab: (t: AuditClass) => void }) {
  return (
    <div role="tablist" aria-label="Audits" className="inline-flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg bg-muted p-1">
      {AUDIT_CLASSES.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          data-tab={t}
          title={AUDIT_CLASS_HELP[t]}
          onClick={() => onTab(t)}
          className={cn("rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors", tab === t ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}
        >
          {AUDIT_CLASS_LABELS[t]}
        </button>
      ))}
    </div>
  )
}

export type AuditFilters = { action: string; user_id: string; app_id: string; from: string; to: string }
export const NO_AUDIT_FILTERS: AuditFilters = { action: "", user_id: "", app_id: "", from: "", to: "" }
export type Option = { id: string; name: string }

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 16).replace("T", " ") + " UTC"
}
const targetOf = (r: AuditRow) => [r.target.type, r.target.name ?? r.target.id].filter(Boolean).join(": ") || "—"
const who = (r: AuditRow) => r.actor.name ?? r.actor.id ?? "Mynt"

type Column = { key: string; label: string; cell: (r: AuditRow, appName: (id: string | null) => string) => React.ReactNode; csv: (r: AuditRow, appName: (id: string | null) => string) => string | null }

const SEVERITY_TONE = (s: string | null): "red" | "amber" | "green" | null =>
  !s ? null : /crit|high|fail|block/i.test(s) ? "red" : /med|warn/i.test(s) ? "amber" : /low|info|pass/i.test(s) ? "green" : null

function Word({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>
  const tone = SEVERITY_TONE(value)
  const label = value.replace(/_/g, " ")
  return tone ? <StatusDot tone={tone} label={label[0].toUpperCase() + label.slice(1)} /> : <span className="capitalize">{label}</span>
}

const COL = {
  when: { key: "when", label: "When", cell: (r) => <span className="whitespace-nowrap tabular-nums text-muted-foreground">{when(r.at)}</span>, csv: (r) => r.at },
  who: { key: "who", label: "Who", cell: (r) => <span className="font-medium">{who(r)}</span>, csv: (r) => who(r) },
  kind: { key: "kind", label: "Kind", cell: (r) => <span className="font-mono text-xs">{r.kind}</span>, csv: (r) => r.kind },
  action: { key: "action", label: "Action", cell: (r) => <span className="font-mono text-xs">{r.kind}</span>, csv: (r) => r.kind },
  app: { key: "app", label: "App", cell: (r, app) => app(r.appId), csv: (r, app) => app(r.appId) },
  target: { key: "target", label: "Target", cell: (r) => targetOf(r), csv: (r) => targetOf(r) },
  summary: {
    key: "summary",
    label: "Summary",
    cell: (r) => (
      <span className="block max-w-80 truncate" title={r.details ?? r.summary ?? undefined}>
        {r.summary ?? r.details ?? "—"}
      </span>
    ),
    csv: (r) => r.summary ?? r.details,
  },
  severity: { key: "severity", label: "Severity", cell: (r) => <Word value={r.severity} />, csv: (r) => r.severity },
  status: { key: "status", label: "Status", cell: (r) => <Word value={r.status} />, csv: (r) => r.status },
} satisfies Record<string, Column>

// What each class's table shows, and which of its own fields it filters by.
export const CLASS_COLUMNS: Record<Exclude<AuditClass, "obligations">, Column[]> = {
  security: [COL.when, COL.app, COL.kind, COL.summary, COL.severity, COL.status, COL.who],
  financial: [COL.when, COL.app, COL.kind, COL.summary, COL.status, COL.who, COL.target],
  workspace: [COL.when, COL.who, COL.action, COL.target, COL.summary],
}
const CLASS_FIELDS: Record<Exclude<AuditClass, "obligations">, ("severity" | "status")[]> = { security: ["severity", "status"], financial: ["status"], workspace: [] }

export function AuditsView({
  auditClass = "workspace",
  rows,
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
  auditClass?: Exclude<AuditClass, "obligations">
  rows: AuditRow[]
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
  const [local, setLocal] = useState<{ severity: string; status: string }>({ severity: "", status: "" })
  const shown = useMemo(
    () => searchRows(rows, query).filter((r) => (!local.severity || r.severity === local.severity) && (!local.status || r.status === local.status)),
    [rows, query, local],
  )
  const columns = CLASS_COLUMNS[auditClass]
  const appName = (id: string | null) => (id ? (apps.find((a) => a.id === id)?.name ?? id) : "—")
  const set = (k: keyof AuditFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => onFilters({ ...filters, [k]: e.target.value })
  const exportCsv = () =>
    downloadCsv(
      `audit-${auditClass}.csv`,
      toCsv(
        columns.map((c) => c.label),
        shown.map((r) => columns.map((c) => c.csv(r, appName))),
      ),
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-audit-class={auditClass}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search this page: kind, person, target, summary or details" className="pl-8" aria-label="Search the audit trail" />
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!shown.length}>
          <Download />
          Export CSV
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-filters>
        <select className={selectClass} value={filters.action} onChange={set("action")} aria-label={auditClass === "workspace" ? "Action" : "Kind"}>
          <option value="">{auditClass === "workspace" ? "All actions" : "All kinds"}</option>
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
        {CLASS_FIELDS[auditClass].map((k) => (
          <select key={k} className={selectClass} value={local[k]} onChange={(e) => setLocal({ ...local, [k]: e.target.value })} aria-label={k === "severity" ? "Severity" : "Status"}>
            <option value="">{k === "severity" ? "All severities" : "All statuses"}</option>
            {distinct(rows.map((r) => r[k])).map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        ))}
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
              {columns.map((c) => (
                <TableHead key={c.key}>{c.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((r) => (
                <TableRow key={r.id} data-audit-row={r.kind}>
                  {columns.map((c) => (
                    <TableCell key={c.key}>{c.cell(r, appName)}</TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="py-10 text-center text-muted-foreground">
                  {loading ? "Loading…" : rows.length ? "Nothing on this page matches." : "No records match these filters."}
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

const OBLIGATION_TONE: Record<ObligationStatus, "red" | "amber" | "green" | null> = { met: "green", at_risk: "amber", overdue: "red", unknown: null }

export function ObligationStatusText({ status }: { status: ObligationStatus }) {
  const tone = OBLIGATION_TONE[status]
  return tone ? <StatusDot tone={tone} label={OBLIGATION_LABELS[status]} /> : <span className="text-xs text-muted-foreground">{OBLIGATION_LABELS[status]}</span>
}

export function ObligationsView({ obligations, initial = NO_OBLIGATION_FILTERS }: { obligations: Obligation[]; initial?: ObligationFilters }) {
  const [f, setF] = useState<ObligationFilters>(initial)
  const shown = useMemo(() => filterObligations(obligations, f), [obligations, f])
  const set = (k: keyof ObligationFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value })
  const counts = Object.fromEntries(OBLIGATION_STATUSES.map((s) => [s, obligations.filter((o) => o.status === s).length])) as Record<ObligationStatus, number>
  const exportCsv = () =>
    downloadCsv(
      "licence-obligations.csv",
      toCsv(
        ["Partner", "Regulator", "Licence", "Obligation", "Title", "Products", "Status", "Due", "Evidence"],
        shown.map((o) => [o.partner, o.regulator, o.licenceId, o.obligationId, o.title, o.products.join("; "), OBLIGATION_LABELS[o.status], o.dueAt, o.evidence]),
      ),
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-audit-class="obligations">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={f.query} onChange={set("query")} placeholder="Search obligation, partner, regulator, product or evidence" className="pl-8" aria-label="Search obligations" />
        </div>
        <Button variant="outline" onClick={exportCsv} disabled={!shown.length}>
          <Download />
          Export CSV
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-sm" data-filters>
        <select className={selectClass} value={f.partner} onChange={set("partner")} aria-label="Partner">
          <option value="">All partners</option>
          {distinct(obligations.map((o) => o.partner)).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select className={selectClass} value={f.regulator} onChange={set("regulator")} aria-label="Regulator">
          <option value="">All regulators</option>
          {distinct(obligations.map((o) => o.regulator)).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select className={selectClass} value={f.status} onChange={set("status")} aria-label="Status">
          <option value="">All statuses</option>
          {OBLIGATION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {OBLIGATION_LABELS[s]} ({counts[s]})
            </option>
          ))}
        </select>
        <select className={selectClass} value={f.product} onChange={set("product")} aria-label="Product">
          <option value="">All products</option>
          {distinct(obligations.flatMap((o) => o.products)).map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="ml-auto text-muted-foreground tabular-nums">
          {shown.length} of {obligations.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Partner</TableHead>
              <TableHead>Regulator</TableHead>
              <TableHead>Obligation</TableHead>
              <TableHead>Products</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Evidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.length ? (
              shown.map((o) => (
                <TableRow key={`${o.licenceId ?? ""}-${o.obligationId}`} data-obligation={o.obligationId} data-status={o.status}>
                  <TableCell className="font-medium">{o.partner ?? "—"}</TableCell>
                  <TableCell>{o.regulator ?? "—"}</TableCell>
                  <TableCell>
                    <span className="block">{o.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{o.obligationId}</span>
                  </TableCell>
                  <TableCell className="max-w-48 truncate" title={o.products.join(", ")}>
                    {o.products.join(", ") || "—"}
                  </TableCell>
                  <TableCell>
                    <ObligationStatusText status={o.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{o.dueAt ? o.dueAt.slice(0, 10) : "—"}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground" title={o.evidence ?? undefined}>
                    {o.evidence ?? "No evidence recorded"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  {obligations.length ? "No obligations match these filters." : "No obligations yet. They appear here once a partner's licence covers one of your products."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
