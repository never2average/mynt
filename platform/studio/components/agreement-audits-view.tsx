"use client"

// The Audits page's Agreement audits tab: the oversight audits licence providers run on apps under
// program agreements (lib/agreement-audits.ts). AgreementAuditsView: the table with the same toolbar
// as the other tabs (a full-width search, one Filters popover for agreement, counterparty, app, kind
// and status, a due-date range with quick ranges looking forward, Export CSV, and Add audit
// requirement for a licence provider), paged 25 rows at a time. A row opens AgreementAuditSheet: a
// card of the audit's details on top, its actions as labelled buttons for the caller's side (the
// licence provider: Open audit, Record finding, Resolve finding, Pass, Fail, Waive; the app's side:
// Submit evidence, Respond to finding), then Findings, Evidence and History, each a table. Status is
// always in words, never colour alone. The views are server-renderable for the tests.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Download, FilePlus2, Search } from "lucide-react"

import { DateRangeFilter, FiltersPopover, picksOf, type Facet } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListPager, TOOLBAR_ROW, TOOLBAR_SEARCH, usePaged } from "@/components/list-layout"
import { StatusDot, type DotTone } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tab, TabList } from "@/components/ui/tabs"
import {
  AUDIT_ACTION_LABELS,
  AUDIT_KINDS,
  AUDIT_STATUSES,
  CADENCES,
  cadenceText,
  CSV_HEADERS,
  csvRow,
  dueText,
  filterAgreementAudits,
  findingsText,
  HISTORY_LABELS,
  kindText,
  NO_AGREEMENT_AUDIT_FILTERS,
  OVERDUE,
  SEVERITIES,
  statusText,
  type AgreementAuditDetail,
  type AgreementAuditFilters,
  type AgreementAuditList,
  type AgreementAuditRow,
  type AgreementOption,
  type AuditAction,
} from "@/lib/agreement-audits"
import { toCsv } from "@/lib/compliance"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"
// One function for the default, so the audit sheet (which reads the audit when it opens) doesn't read it again on every render.
const browserFetch: typeof fetch = (...a) => fetch(...a)
const STATUS_TONE: Record<string, DotTone> = { scheduled: "gray", in_progress: "blue", submitted: "amber", passed: "green", failed: "red", waived: "gray" }

/** The audit's status in words, with "Overdue" beside it when it's past due and not closed. */
export function AuditStatus({ status, overdue }: { status: string; overdue: boolean }) {
  return (
    <span className="flex flex-col gap-0.5" data-audit-status={status} data-overdue={overdue || undefined}>
      <StatusDot tone={STATUS_TONE[status] ?? "gray"} label={statusText(status)} />
      {overdue && <StatusDot tone="red" label="Overdue" />}
    </span>
  )
}

const uniq = (pairs: [string | null, string][]) => [...new Map(pairs.filter((p): p is [string, string] => Boolean(p[0]))).entries()].sort((a, b) => a[1].localeCompare(b[1]))

export function AgreementAuditsView({
  list,
  initial = NO_AGREEMENT_AUDIT_FILTERS,
  canAddRequirement = false,
  onOpen,
  onAddRequirement,
}: {
  list: AgreementAuditList
  initial?: AgreementAuditFilters
  canAddRequirement?: boolean
  onOpen: (row: AgreementAuditRow) => void
  onAddRequirement?: () => void
}) {
  const [f, setF] = useState<AgreementAuditFilters>(initial)
  const [due, setDue] = useState({ from: "", to: "" })
  const shown = useMemo(() => filterAgreementAudits(list.audits, f, due), [list.audits, f, due])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const pick = (k: Exclude<keyof AgreementAuditFilters, "query">) => (v: string[]) => {
    setF({ ...f, [k]: v })
    setPage(1)
  }
  const agreementOptions = uniq([...list.agreements.map((a): [string, string] => [a.id, a.label]), ...list.audits.map((a): [string, string] => [a.agreementId, `${a.appName} with ${a.counterparty}`])])
  const facets: Facet[] = [
    { id: "agreement", label: "Agreement", options: agreementOptions.map(([value, label]) => ({ value, label })), selected: picksOf(f.agreement), onChange: pick("agreement") },
    { id: "counterparty", label: "Counterparty", options: uniq(list.audits.map((a) => [a.counterpartyId, a.counterparty])).map(([value, label]) => ({ value, label })), selected: picksOf(f.counterparty), onChange: pick("counterparty") },
    { id: "app", label: "App", options: uniq(list.audits.map((a) => [a.appId, a.appName])).map(([value, label]) => ({ value, label })), selected: picksOf(f.appId), onChange: pick("appId") },
    { id: "kind", label: "Kind", options: AUDIT_KINDS.map((k) => ({ value: k, label: kindText(k) })), selected: picksOf(f.kind), onChange: pick("kind") },
    { id: "status", label: "Status", options: [...AUDIT_STATUSES.map((s) => ({ value: s, label: statusText(s) })), { value: OVERDUE, label: "Overdue" }], selected: picksOf(f.status), onChange: pick("status") },
  ]
  const clear = () => {
    setF({ ...f, agreement: [], counterparty: [], appId: [], kind: [], status: [] })
    setPage(1)
  }
  const exportCsv = () => downloadCsv("agreement-audits.csv", toCsv(CSV_HEADERS, shown.map(csvRow)))
  const addable = canAddRequirement && list.agreements.some((a) => a.canAddRequirements)
  const agreementLabel = (id: string, row: AgreementAuditRow) => list.agreements.find((a) => a.id === id)?.label ?? `${row.appName} with ${row.counterparty}`
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-audit-class="agreements">
      <div className={TOOLBAR_ROW} data-toolbar>
        <div className={TOOLBAR_SEARCH}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={f.query}
            onChange={(e) => {
              setF({ ...f, query: e.target.value })
              setPage(1)
            }}
            placeholder="Search agreement audits"
            className="pl-8"
            aria-label="Search agreement audits"
          />
        </div>
        <FiltersPopover facets={facets} onClear={clear} />
        <DateRangeFilter
          label="Due"
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
        {addable && onAddRequirement && (
          <Button onClick={onAddRequirement} data-add-audit-requirement>
            <FilePlus2 />
            Add audit requirement
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Agreement</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Audit</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Findings</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {onPage.length ? (
              onPage.map((r) => (
                <TableRow key={r.id} data-agreement-audit={r.id} data-status={r.status} className="cursor-pointer" onClick={() => onOpen(r)}>
                  <TableCell className="max-w-56 truncate" title={agreementLabel(r.agreementId, r)}>
                    {agreementLabel(r.agreementId, r)}
                  </TableCell>
                  <TableCell>{r.appName}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-left font-medium underline-offset-4 hover:underline"
                      onClick={(e) => {
                        e.stopPropagation()
                        onOpen(r)
                      }}
                      data-open-audit={r.id}
                    >
                      {r.name}
                    </button>
                    <span className="block text-xs text-muted-foreground">{cadenceText(r.cadence)}</span>
                  </TableCell>
                  <TableCell>{kindText(r.kind)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">{dueText(r.dueAt)}</TableCell>
                  <TableCell>
                    <AuditStatus status={r.status} overdue={r.overdue} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap" data-findings>
                    {findingsText(r)}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  {list.audits.length
                    ? "No agreement audits match these filters."
                    : "No agreement audits yet. They appear here once a licence provider adds an audit requirement to a program agreement and its first audit is due."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <ListPager page={page} pages={pages} total={shown.length} onPage={setPage} noun={["audit", "audits"]} />
    </div>
  )
}

// ---- one audit ----

export type ActionBody = { action: AuditAction } & Record<string, unknown>
type Result = { ok: boolean; message: string }
async function post(url: string, body: unknown, fetcher: typeof fetch): Promise<Result> {
  const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
  const data = (await res?.json().catch(() => null)) as { message?: string } | null
  if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
  if (!res?.ok) return { ok: false, message: data?.message ?? "Couldn't reach Mynt. Please try again." }
  return { ok: true, message: data?.message ?? "Done." }
}

const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—")
const SHA = /^[a-f0-9]{64}$/

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

// The form for one action, inside the sheet.
function ActionForm({ action, detail, busy, onSubmit, onCancel }: { action: AuditAction; detail: AgreementAuditDetail; busy: boolean; onSubmit: (b: ActionBody) => void; onCancel: () => void }) {
  const open = detail.findings.filter((x) => x.status === "open")
  const [note, setNote] = useState("")
  const [severity, setSeverity] = useState<string>("medium")
  const [title, setTitle] = useState("")
  const [findingId, setFindingId] = useState(open[0]?.id ?? "")
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [sha, setSha] = useState("")
  const noteRequired = action === "fail" || action === "waive"
  const valid =
    action === "record_finding"
      ? title.trim().length >= 3
      : action === "resolve_finding"
        ? Boolean(findingId)
        : action === "respond_to_finding"
          ? Boolean(findingId) && note.trim().length >= 3
          : action === "submit_evidence"
            ? Boolean(name.trim()) && url.trim().startsWith("https://") && SHA.test(sha.trim())
            : noteRequired
              ? note.trim().length >= 3
              : true
  const body = (): ActionBody => {
    const n = note.trim() ? { note: note.trim() } : {}
    switch (action) {
      case "record_finding":
        return { action, severity, title: title.trim(), ...(note.trim() ? { detail: note.trim() } : {}) }
      case "resolve_finding":
        return { action, finding_id: findingId, ...n }
      case "respond_to_finding":
        return { action, finding_id: findingId, response: note.trim() }
      case "submit_evidence":
        return { action, evidence: [{ name: name.trim(), url: url.trim(), sha256: sha.trim() }], ...n }
      case "open":
        return { action }
      default:
        return { action, ...n }
    }
  }
  const findingPicker = (
    <label className="flex flex-col gap-1 text-sm">
      Finding
      <select className={field} value={findingId} onChange={(e) => setFindingId(e.target.value)} data-action-finding>
        {open.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title} ({x.severity})
          </option>
        ))}
      </select>
    </label>
  )
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border p-3"
      data-action-form={action}
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && !busy) onSubmit(body())
      }}
    >
      <p className="text-sm font-medium">{AUDIT_ACTION_LABELS[action]}</p>
      {action === "open" && <p className="text-sm text-muted-foreground">You become this audit&apos;s reviewer, and the app&apos;s side is told it&apos;s open.</p>}
      {action === "record_finding" && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Severity
            <select className={field} value={severity} onChange={(e) => setSeverity(e.target.value)} data-action-severity>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Title
            <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} data-action-title />
          </label>
        </>
      )}
      {(action === "resolve_finding" || action === "respond_to_finding") && findingPicker}
      {action === "submit_evidence" && (
        <>
          {detail.evidenceRequired && <p className="text-sm text-muted-foreground">Asked for: {detail.evidenceRequired}</p>}
          <label className="flex flex-col gap-1 text-sm">
            Name
            <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} data-action-evidence-name />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Link (https)
            <input className={field} type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/report.pdf" data-action-evidence-url />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            SHA-256 of the file
            <input className={`${field} font-mono text-xs`} value={sha} onChange={(e) => setSha(e.target.value.toLowerCase())} maxLength={64} placeholder="64 lowercase hex characters" data-action-evidence-sha />
          </label>
        </>
      )}
      {action !== "open" && (
        <label className="flex flex-col gap-1 text-sm">
          {action === "record_finding" ? "Detail (optional)" : action === "respond_to_finding" ? "Your response" : noteRequired ? "Why" : "Note (optional)"}
          <textarea className={`${field} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={4000} data-action-note />
        </label>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !valid} data-action-submit={action}>
          {busy ? "Sending…" : AUDIT_ACTION_LABELS[action]}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

export type DetailTab = "findings" | "evidence" | "history"
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "findings", label: "Findings" },
  { id: "evidence", label: "Evidence" },
  { id: "history", label: "History" },
]

export function AgreementAuditDetailView({
  detail,
  busy = false,
  error = null,
  result = null,
  initialTab = "findings",
  initialAction = null,
  onAction,
}: {
  detail: AgreementAuditDetail
  busy?: boolean
  error?: string | null
  result?: string | null
  initialTab?: DetailTab
  initialAction?: AuditAction | null
  onAction: (b: ActionBody) => void
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [acting, setActing] = useState<AuditAction | null>(initialAction)
  useEffect(() => {
    if (result) setActing(null)
  }, [result])
  return (
    <div className="flex flex-col gap-4" data-agreement-audit-detail={detail.id}>
      <dl className="grid grid-cols-2 gap-3 rounded-lg border p-3" data-audit-card>
        <Meta label="Agreement">
          {detail.appName} with {detail.counterparty}
        </Meta>
        <Meta label="Status">
          <AuditStatus status={detail.status} overdue={detail.overdue} />
        </Meta>
        <Meta label="Kind">{kindText(detail.kind)}</Meta>
        <Meta label="Cadence">{cadenceText(detail.cadence)}</Meta>
        <Meta label="Due">{dueText(detail.dueAt)}</Meta>
        <Meta label="Reviewer">{detail.reviewer ?? "Not yet"}</Meta>
        <Meta label="Opened">{when(detail.openedAt)}</Meta>
        <Meta label="Submitted">{when(detail.submittedAt)}</Meta>
        <Meta label="Closed">{when(detail.closedAt)}</Meta>
        <Meta label="Your side">{detail.side === "counterparty" ? "Licence provider" : detail.side === "both" ? "Both sides" : "The app's side"}</Meta>
        {detail.evidenceRequired && (
          <div className="col-span-2">
            <Meta label="Evidence asked for">{detail.evidenceRequired}</Meta>
          </div>
        )}
        {detail.description && (
          <div className="col-span-2">
            <Meta label="What it covers">{detail.description}</Meta>
          </div>
        )}
        {detail.outcomeNote && (
          <div className="col-span-2">
            <Meta label="Outcome note">{detail.outcomeNote}</Meta>
          </div>
        )}
      </dl>
      {detail.actions.length > 0 && (
        <div className="flex flex-wrap gap-2" data-audit-actions>
          {detail.actions.map((a) => (
            <Button key={a} size="sm" variant={acting === a ? "default" : "outline"} onClick={() => setActing(a)} data-audit-action={a}>
              {AUDIT_ACTION_LABELS[a]}
            </Button>
          ))}
        </div>
      )}
      {acting && detail.actions.includes(acting) && <ActionForm key={acting} action={acting} detail={detail} busy={busy} onSubmit={onAction} onCancel={() => setActing(null)} />}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-audit-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-audit-result>
          {result}
        </p>
      )}
      <TabList aria-label="Audit records">
        {DETAIL_TABS.map((t) => (
          <Tab key={t.id} selected={tab === t.id} onClick={() => setTab(t.id)} data-detail-tab={t.id}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <div className="overflow-auto rounded-lg border" data-detail-panel={tab}>
        {tab === "findings" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Finding</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Responses</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.findings.length ? (
                detail.findings.map((x) => (
                  <TableRow key={x.id} data-finding={x.id} data-status={x.status}>
                    <TableCell className="whitespace-normal">
                      <span className="block font-medium">{x.title}</span>
                      {x.detail && <span className="block text-xs text-muted-foreground">{x.detail}</span>}
                      <span className="block text-xs text-muted-foreground">
                        {x.recordedBy ?? "Someone"}, {when(x.recordedAt)}
                      </span>
                    </TableCell>
                    <TableCell className="capitalize">{x.severity}</TableCell>
                    <TableCell>
                      <StatusDot tone={x.status === "open" ? "amber" : "green"} label={x.status === "open" ? "Open" : "Resolved"} />
                      {x.resolutionNote && <span className="block text-xs text-muted-foreground">{x.resolutionNote}</span>}
                    </TableCell>
                    <TableCell className="whitespace-normal text-xs">
                      {x.responses.length
                        ? x.responses.map((r, i) => (
                            <span key={i} className="block">
                              {r.by ?? "Someone"}: {r.text}
                            </span>
                          ))
                        : "None yet"}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No findings recorded.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {tab === "evidence" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Evidence</TableHead>
                <TableHead>SHA-256</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.evidenceItems.length ? (
                detail.evidenceItems.map((e) => (
                  <TableRow key={e.id} data-evidence={e.id}>
                    <TableCell className="whitespace-normal">
                      {e.url ? (
                        <a href={e.url} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                          {e.name}
                        </a>
                      ) : (
                        <span className="font-medium">{e.name}</span>
                      )}
                      {e.note && <span className="block text-xs text-muted-foreground">{e.note}</span>}
                    </TableCell>
                    <TableCell className="max-w-40 truncate font-mono text-xs" title={e.sha256 ?? undefined}>
                      {e.sha256 ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap">
                      {e.by ?? "Someone"}, {when(e.at)}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                    No evidence submitted yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
        {tab === "history" && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>What</TableHead>
                <TableHead>Who</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.history.length ? (
                detail.history.map((h) => (
                  <TableRow key={h.id} data-history={h.action}>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{when(h.at)}</TableCell>
                    <TableCell>{HISTORY_LABELS[h.action] ?? h.action.replace(/_/g, " ")}</TableCell>
                    <TableCell>{h.by}</TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={3} className="py-6 text-center text-muted-foreground">
                    No history yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  )
}

export function AgreementAuditSheet({
  auditId,
  title,
  open,
  onClose,
  onChanged,
  fetcher = browserFetch,
  readOnly = false,
}: {
  auditId: string | null
  title: string
  open: boolean
  onClose: () => void
  onChanged: () => void
  fetcher?: typeof fetch
  readOnly?: boolean // the Licences page's Audit obligations tab: the audit shown, without its actions
}) {
  const [detail, setDetail] = useState<AgreementAuditDetail | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (!auditId) return
    const res = await fetcher(`/api/agreement-audits/${encodeURIComponent(auditId)}`, { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { audit?: AgreementAuditDetail; message?: string; supported?: boolean } | null
    if (res?.ok && body?.audit) {
      setDetail(body.audit)
      setLoadError(null)
    } else setLoadError(body?.supported === false ? "Audit details come with Mynt's next update." : (body?.message ?? "Couldn't reach Mynt. Please try again."))
  }, [auditId, fetcher])
  useEffect(() => {
    if (!open) return
    setDetail(null)
    setError(null)
    setResult(null)
    void load()
  }, [open, load])
  const act = async (b: ActionBody) => {
    if (busy || !auditId) return
    setBusy(true)
    setError(null)
    setResult(null)
    const r = await post(`/api/agreement-audits/${encodeURIComponent(auditId)}`, b, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.message)
    onChanged()
    await load()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl" data-agreement-audit-sheet>
        <SheetHeader>
          <SheetTitle>{detail?.name ?? title}</SheetTitle>
          <SheetDescription>An oversight audit under a program agreement. Every change is recorded in the audit trail, and the other side is told.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {detail ? (
            <AgreementAuditDetailView detail={readOnly ? { ...detail, actions: [] } : detail} busy={busy} error={error} result={result} onAction={(b) => void act(b)} />
          ) : (
            <p className="text-sm text-muted-foreground" role={loadError ? "alert" : undefined}>
              {loadError ?? "Loading…"}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---- Add audit requirement (a licence provider, on a program agreement with their firm) ----

export type RequirementInput = { agreement_id: string; name: string; kind: string; cadence: string; first_due?: string; description?: string; evidence_required?: string }

export function AddRequirementView({ agreements, busy = false, error = null, result = null, onSubmit }: { agreements: AgreementOption[]; busy?: boolean; error?: string | null; result?: string | null; onSubmit: (r: RequirementInput) => void }) {
  const offered = agreements.filter((a) => a.canAddRequirements)
  const [agreement, setAgreement] = useState(offered[0]?.id ?? "")
  const [name, setName] = useState("")
  const [kind, setKind] = useState("compliance_review")
  const [cadence, setCadence] = useState("annual")
  const [firstDue, setFirstDue] = useState("")
  const [description, setDescription] = useState("")
  const [evidence, setEvidence] = useState("")
  if (!offered.length)
    return (
      <p className="text-sm text-muted-foreground" data-no-agreements>
        No program agreement with your firm can take an audit requirement right now. They can from the moment an app proposes one until it ends.
      </p>
    )
  const onChange = cadence === "on_change"
  const valid = Boolean(agreement) && name.trim().length >= 3 && (onChange || Boolean(firstDue))
  return (
    <form
      className="flex flex-col gap-3"
      data-add-requirement-form
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid || busy) return
        onSubmit({
          agreement_id: agreement,
          name: name.trim(),
          kind,
          cadence,
          ...(!onChange && firstDue ? { first_due: firstDue } : {}),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(evidence.trim() ? { evidence_required: evidence.trim() } : {}),
        })
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Agreement
        <select className={field} value={agreement} onChange={(e) => setAgreement(e.target.value)} data-requirement-agreement>
          {offered.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="e.g. Annual compliance review" data-requirement-name />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Kind
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value)} data-requirement-kind>
            {AUDIT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindText(k)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Cadence
          <select className={field} value={cadence} onChange={(e) => setCadence(e.target.value)} data-requirement-cadence>
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {cadenceText(c)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {onChange ? (
        <p className="text-sm text-muted-foreground">Each audit opens when the app&apos;s builds change its verified source, or when you open one by hand, and is due 30 days later.</p>
      ) : (
        <label className="flex flex-col gap-1 text-sm">
          First due
          <input className={field} type="date" value={firstDue} onChange={(e) => setFirstDue(e.target.value)} data-requirement-first-due />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        What it covers (optional)
        <textarea className={`${field} min-h-16`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} data-requirement-description />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Evidence you need (optional)
        <textarea className={`${field} min-h-16`} value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={4000} data-requirement-evidence />
      </label>
      {result === null && (
        <div>
          <Button type="submit" disabled={busy || !valid} data-add-requirement-submit>
            {busy ? "Adding…" : "Add audit requirement"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-requirement-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-requirement-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function AddRequirementSheet({
  agreements,
  open,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  agreements: AgreementOption[]
  open: boolean
  onClose: () => void
  onDone: () => void
  fetcher?: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!open) return
    setError(null)
    setResult(null)
    setRound((r) => r + 1)
  }, [open])
  const submit = async (r: RequirementInput) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await post("/api/agreement-audits", r, fetcher)
    setBusy(false)
    if (!res.ok) return setError(res.message)
    setResult(res.message)
    onDone()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-add-requirement-sheet>
        <SheetHeader>
          <SheetTitle>Add audit requirement</SheetTitle>
          <SheetDescription>An oversight audit your firm runs on an app under its program agreement. Mynt opens each audit when it&apos;s due, once the agreement is signed. Recorded in the audit trail.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <AddRequirementView key={round} agreements={agreements} busy={busy} error={error} result={result} onSubmit={(r) => void submit(r)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
