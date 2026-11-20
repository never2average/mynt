"use client"

// The Audits page's tables. AuditsView: one class of the workspace's records (App security,
// Financial activity or Workspace activity) as a paged table, with a full-width search over the
// page shown, then in the same toolbar row its filters (kind, member, app, date range, and
// severity or status where the class has them) and a labelled Export CSV of the rows shown.
// ObligationsView: key figures (obligations, met, due soon, overdue), then each licence's
// regulatory obligations for the products it covers (met, at risk, overdue, with evidence),
// searchable, filtered by partner, regulator, status, product and due date, exportable, and paged
// 25 rows at a time. Status is never colour alone. Server-renderable for the tests.
import { useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react"

import { KpiRow } from "@/components/charts"
import { Panel } from "@/components/dashboard-panels"
import { DateRangeFilter, FilterSelect } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListPager, usePaged } from "@/components/list-layout"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
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
import type { Kpi } from "@/lib/dashboard-visual"
import { cn } from "@/lib/utils"
import { Tab, TabList } from "@/components/ui/tabs"

export function AuditTabs({ tab, onTab }: { tab: AuditClass; onTab: (t: AuditClass) => void }) {
  return (
    <TabList aria-label="Audits">
      {AUDIT_CLASSES.map((t) => (
        <Tab key={t} selected={tab === t} data-tab={t} onClick={() => onTab(t)}>
          {AUDIT_CLASS_LABELS[t]}
        </Tab>
      ))}
    </TabList>
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
      <div className="flex flex-wrap items-center gap-2" data-toolbar>
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search records" className="pl-8" aria-label="Search the audit trail" />
        </div>
        <FilterSelect label="App" value={filters.app_id} onChange={(v) => onFilters({ ...filters, app_id: v })} options={apps.map((x) => ({ value: x.id, label: x.name }))} />
        <FilterSelect label={auditClass === "workspace" ? "Action" : "Kind"} value={filters.action} onChange={(v) => onFilters({ ...filters, action: v })} options={actions.map((x) => ({ value: x, label: x }))} />
        {CLASS_FIELDS[auditClass].map((k) => (
          <FilterSelect
            key={k}
            label={k === "severity" ? "Severity" : "Status"}
            value={local[k]}
            onChange={(v) => setLocal({ ...local, [k]: v })}
            options={distinct(rows.map((r) => r[k])).map((v) => ({ value: v, label: v.replace(/_/g, " ") }))}
          />
        ))}
        <FilterSelect label="Member" value={filters.user_id} onChange={(v) => onFilters({ ...filters, user_id: v })} options={members.map((m) => ({ value: m.id, label: m.name }))} />
        <DateRangeFilter label="Date range" from={filters.from} to={filters.to} onChange={(from, to) => onFilters({ ...filters, from, to })} />
        <Button variant="outline" onClick={exportCsv} disabled={!shown.length} data-export>
          <Download />
          Export CSV
        </Button>
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

export function ObligationStatusText({ status, reason = null }: { status: ObligationStatus; reason?: string | null }) {
  const tone = OBLIGATION_TONE[status]
  return tone ? (
    <StatusDot tone={tone} label={OBLIGATION_LABELS[status]} />
  ) : (
    <span className="text-xs text-muted-foreground" title={reason ?? undefined}>
      {OBLIGATION_LABELS[status]}
    </span>
  )
}

const partnersOf = (list: Obligation[]) =>
  [...new Map(list.flatMap((o) => (o.partnerId ? [[o.partnerId, o.partner ?? o.partnerId] as const] : []))).entries()].sort((a, b) => a[1].localeCompare(b[1]))

export const DUE_SOON_DAYS = 30

const dueAtOf = (o: Obligation) => (o.dueAt && !Number.isNaN(Date.parse(o.dueAt)) ? Date.parse(o.dueAt) : null)

/** The key figures, from the obligations loaded. Due soon is "Not measured" when none has a due date, never 0. */
export function obligationKpis(list: Obligation[], now = Date.now()): Kpi[] {
  const dated = list.some((o) => dueAtOf(o) !== null)
  const dueSoon = (o: Obligation) => {
    const at = dueAtOf(o)
    return o.status !== "met" && at !== null && at > now && at - now <= DUE_SOON_DAYS * 86_400_000
  }
  const k = (key: string, label: string, value: number | null, note: string): Kpi => ({ key, label, value, unit: "count", delta: null, spark: null, note })
  return [
    k("obligations", "Obligations", list.length, "Across your licences"),
    k("met", "Met", list.filter((o) => o.status === "met").length, "With evidence"),
    k("due-soon", "Due soon", dated ? list.filter(dueSoon).length : null, `Not met, due within ${DUE_SOON_DAYS} days`),
    k("overdue", "Overdue", list.filter((o) => o.status === "overdue").length, "Past their due date"),
  ]
}

// Due between two days (YYYY-MM-DD, inclusive); one without a due date is out once a range is set.
export const dueWithin = (o: Obligation, from: string, to: string) => {
  if (!from && !to) return true
  const d = o.dueAt ? o.dueAt.slice(0, 10) : ""
  return Boolean(d) && (!from || d >= from) && (!to || d <= to)
}

export function ObligationsView({ obligations, initial = NO_OBLIGATION_FILTERS, now = Date.now() }: { obligations: Obligation[]; initial?: ObligationFilters; now?: number }) {
  const [f, setF] = useState<ObligationFilters>(initial)
  const [due, setDue] = useState({ from: "", to: "" })
  const shown = useMemo(() => filterObligations(obligations, f).filter((o) => dueWithin(o, due.from, due.to)), [obligations, f, due])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const set = (k: keyof ObligationFilters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setF({ ...f, [k]: e.target.value })
    setPage(1)
  }
  const pick = (k: keyof ObligationFilters) => (v: string) => {
    setF({ ...f, [k]: v })
    setPage(1)
  }
  const counts = Object.fromEntries(OBLIGATION_STATUSES.map((s) => [s, obligations.filter((o) => o.status === s).length])) as Record<ObligationStatus, number>
  const exportCsv = () =>
    downloadCsv(
      "licence-obligations.csv",
      toCsv(
        ["Partner", "Regulator", "Licence", "Licence type", "Obligation", "Title", "Products", "Status", "Reason", "Due", "Evidence"],
        shown.map((o) => [o.partner, o.regulator, o.licenceId, o.licenceType, o.obligationId, o.title, o.products.join("; "), OBLIGATION_LABELS[o.status], o.reason, o.dueAt, o.evidence]),
      ),
    )
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:gap-5" data-audit-class="obligations">
      <Panel id="obligation-figures">
        <KpiRow kpis={obligationKpis(obligations, now)} />
      </Panel>
      <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" data-toolbar>
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={f.query} onChange={set("query")} placeholder="Search obligations" className="pl-8" aria-label="Search obligations" />
        </div>
        <FilterSelect label="Partner" value={f.partner} onChange={pick("partner")} options={partnersOf(obligations).map(([id, name]) => ({ value: id, label: name }))} />
        <FilterSelect label="Regulator" value={f.regulator} onChange={pick("regulator")} options={distinct(obligations.map((o) => o.regulator)).map((v) => ({ value: v, label: v }))} />
        <FilterSelect label="Status" value={f.status} onChange={pick("status")} options={OBLIGATION_STATUSES.map((st) => ({ value: st, label: `${OBLIGATION_LABELS[st]} (${counts[st]})` }))} />
        <FilterSelect label="Product" value={f.product} onChange={pick("product")} options={distinct(obligations.flatMap((o) => o.products)).map((v) => ({ value: v, label: v }))} />
        <DateRangeFilter
          label="Date range"
          future
          from={due.from}
          to={due.to}
          onChange={(from, to) => {
            setDue({ from, to })
            setPage(1)
          }}
        />
        <Button variant="outline" onClick={exportCsv} disabled={!shown.length} data-export>
          <Download />
          Export CSV
        </Button>
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
              <TableHead>Reason</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Evidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {onPage.length ? (
              onPage.map((o) => (
                <TableRow key={`${o.licenceId ?? ""}-${o.obligationId}`} data-obligation={o.obligationId} data-status={o.status}>
                  <TableCell className="font-medium">{o.partner ?? "—"}</TableCell>
                  <TableCell>
                    <span className="block">{o.regulator ?? "—"}</span>
                    {o.licenceType && <span className="text-xs text-muted-foreground">{o.licenceType}</span>}
                  </TableCell>
                  <TableCell>
                    <span className="block">{o.title}</span>
                    <span className="font-mono text-xs text-muted-foreground">{o.obligationId}</span>
                  </TableCell>
                  <TableCell className="max-w-48 truncate" title={o.products.join(", ")}>
                    {o.products.join(", ") || "—"}
                  </TableCell>
                  <TableCell>
                    <ObligationStatusText status={o.status} reason={o.reason} />
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={o.reason ?? undefined} data-reason>
                    {o.reason ?? "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{o.dueAt ? o.dueAt.slice(0, 10) : "—"}</TableCell>
                  <TableCell className="max-w-64 truncate text-muted-foreground" title={o.evidence ?? undefined}>
                    {o.evidence ?? "No evidence recorded"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-muted-foreground">
                  {obligations.length ? "No obligations match these filters." : "No obligations yet. They appear here once a partner's licence covers one of your products."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <ListPager page={page} pages={pages} total={shown.length} onPage={setPage} />
      </div>
    </div>
  )
}
