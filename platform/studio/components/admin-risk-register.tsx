"use client"

// Admin → Risk register (/platform/risk-register; lib/admin-risks.ts, GET and POST /api/admin/risks), one tab per risk
// area (components/risk-area-tabs.tsx). Every section of a tab is a table (components/admin-kit.tsx):
// 1. Mynt's own register in that area: the list toolbar (search, Filters for status, level and Unassigned, Import,
//    Export CSV, Add risk) over one paged table (Risk, Category, Likelihood, Impact, Score with its level in words,
//    Owner, Status in words, Review by with "overdue" in words, Mitigation cut short), each row with a labelled Review
//    risk. Add risk (starting on the tab's area) and Review risk open their sheets (components/risk-register.tsx, as an
//    app's and a product's); the review sheet has the mitigation in full.
// 2. Across apps and products: the open risks in that area on their own registers, read-only, searched and paged, each
//    subject linked to its workspace's or firm's page.
// 3. The area's signals, each a table with its own columns.
// What Mynt can't answer is one table row, "Not available." with why: never an empty table, never a 0.
// Server-renderable.
import Link from "next/link"
import { useCallback, useMemo, useState } from "react"
import { ClipboardCheck, ShieldPlus } from "lucide-react"

import { AdminList, AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { ListLayout, ListPager, matches, PAGE_SIZE, usePaged } from "@/components/list-layout"
import { RiskAreaTabs, useAreaInAddress } from "@/components/risk-area-tabs"
import { AddRiskSheet, IMPACT_WORDS, LIKELIHOOD_WORDS, ReviewRiskSheet } from "@/components/risk-register"
import { Button } from "@/components/ui/button"
import { csvOf } from "@/lib/admin"
import { keeperWords, levelWords, PLATFORM_SUBJECT, reviewWords, RISK_LEVELS, type CrossRisks, type RegisterAreaData, type RiskLevel, type SignalSpec } from "@/lib/admin-risks"
import { areaWords, RISK_AREA_LABELS, RISK_CATEGORY_LABELS, RISK_STATUS_LABELS, RISK_STATUSES, riskLevel, type RiskArea, type RiskRow, type RiskStatus } from "@/lib/risk-register"

export type RegisterFilter = "area" | "unassigned"

const wrap = (text: React.ReactNode, key?: string) => (
  <span key={key} className="block min-w-40 whitespace-normal">
    {text}
  </span>
)
const levelOf = (r: RiskRow) => riskLevel(r.score) as RiskLevel
const scoreWords = (score: number, level: RiskLevel) => `${score} (${levelWords(level)})`
const ownerWords = (r: RiskRow) => (r.owner ? (r.owner.name ?? "Unnamed member") : "No owner")
const NO_MITIGATION = "None recorded"

export const REGISTER_HEAD = ["Risk", "Category", "Likelihood", "Impact", "Score", "Owner", "Status", "Review by", "Mitigation"] as const
const REGISTER_CSV_HEAD = ["Risk", "Category", "Risk area", "Likelihood", "Impact", "Score", "Level", "Owner", "Status", "Review by", "Overdue", "Mitigation"]
const registerCsvRow = (r: RiskRow) => [r.title, RISK_CATEGORY_LABELS[r.category], areaWords(r.riskArea), r.likelihood, r.impact, r.score, levelWords(levelOf(r)), ownerWords(r), RISK_STATUS_LABELS[r.status], r.reviewBy ?? "Not set", r.overdue ? "Yes" : "No", r.mitigation ?? ""]

/** Mynt's own register in one area (or its unassigned risks): the list toolbar over one paged table, and its sheets. */
function RegisterSection({ data, filter, onFilter, onChanged, fetcher }: { data: RegisterAreaData; filter: RegisterFilter; onFilter: (f: RegisterFilter) => void; onChanged?: () => void; fetcher?: typeof fetch }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string[]>([])
  const [level, setLevel] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [reviewing, setReviewing] = useState<RiskRow | null>(null)
  const unassigned = filter === "unassigned"
  const reg = unassigned ? data.unassigned : data.register
  const all = reg.available ? reg.risks : []
  const manage = reg.available && reg.canManage
  const rows = useMemo(
    () => all.filter((r) => matches(query, r.title, RISK_CATEGORY_LABELS[r.category], r.owner?.name, r.mitigation, r.description) && (!status.length || status.includes(r.status)) && (!level.length || level.includes(levelOf(r)))),
    [all, query, status, level],
  )
  const paged = usePaged(rows)
  const label = RISK_AREA_LABELS[data.area].toLowerCase()
  const waiting = !unassigned && data.unassigned.available ? data.unassigned.risks.length : 0
  const notes = reg.available
    ? [
        ...(reg.canManage ? [] : ["Read-only: Mynt's admins keep this register."]),
        ...(reg.overdue > 0 ? [reg.overdue === 1 ? "1 risk is overdue for review." : `${reg.overdue} risks are overdue for review.`] : []),
        ...(waiting > 0 ? [`${waiting === 1 ? "1 risk has" : `${waiting} risks have`} no area yet: choose Unassigned in Filters to see ${waiting === 1 ? "it" : "them"}.`] : []),
      ]
    : []
  const owners = data.register.available ? data.register.owners : reg.available ? reg.owners : []
  return (
    <section className="flex min-w-0 shrink-0 flex-col gap-2" data-risk-register={PLATFORM_SUBJECT.type} data-register-filter={filter} aria-labelledby="risk-register-platform">
      <h2 id="risk-register-platform" className="text-sm font-semibold">
        {unassigned ? "Mynt's own register: unassigned risks" : `Mynt's own register: ${label}`}
      </h2>
      <AdminList
        id="risk-register"
        search={query}
        onSearch={setQuery}
        searchLabel={`Search ${unassigned ? "unassigned risks" : label} by risk, category, owner or mitigation`}
        facets={[
          { id: "status", label: "Status", options: RISK_STATUSES.map((s) => ({ value: s, label: RISK_STATUS_LABELS[s] })), selected: status, onChange: setStatus },
          { id: "level", label: "Level", options: RISK_LEVELS.map((l) => ({ value: l, label: levelWords(l) })), selected: level, onChange: setLevel },
          { id: "area", label: "Risk area", options: [{ value: "unassigned", label: "Unassigned (no area yet)" }], selected: unassigned ? ["unassigned"] : [], onChange: (v) => onFilter(v.includes("unassigned") ? "unassigned" : "area") },
        ]}
        onClearFilters={() => (setStatus([]), setLevel([]), onFilter("area"))}
        onExport={() => downloadCsv(`risk-register-${unassigned ? "unassigned" : data.area}.csv`, csvOf(REGISTER_CSV_HEAD, rows.map(registerCsvRow)))}
        exportDisabled={!rows.length}
        note={notes.length ? notes.join(" ") : null}
        cta={
          manage ? (
            <Button onClick={() => setAdding(true)} data-add-risk>
              <ShieldPlus /> Add risk
            </Button>
          ) : undefined
        }
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable
          head={manage ? [...REGISTER_HEAD, "Action"] : REGISTER_HEAD}
          unavailable={reg.available ? null : reg.reason}
          rowKeys={paged.shown.map((r) => r.id)}
          onRow={manage ? (i) => setReviewing(paged.shown[i]) : undefined}
          rows={paged.shown.map((r) => [
            wrap(r.title, "t"),
            RISK_CATEGORY_LABELS[r.category],
            `${r.likelihood}: ${LIKELIHOOD_WORDS[r.likelihood] ?? "Not graded"}`,
            `${r.impact}: ${IMPACT_WORDS[r.impact] ?? "Not graded"}`,
            <span key="s" className="tabular-nums" data-risk-score={r.score} data-risk-level={levelOf(r)}>
              {scoreWords(r.score, levelOf(r))}
            </span>,
            ownerWords(r),
            <span key="st" data-risk-status={r.status}>
              {RISK_STATUS_LABELS[r.status]}
            </span>,
            <span key="rv" className="tabular-nums" data-overdue={r.overdue ? "true" : undefined}>
              {reviewWords(r)}
            </span>,
            <span key="m" className="block max-w-64 truncate" title={r.mitigation ?? undefined} data-risk-mitigation>
              {r.mitigation ?? NO_MITIGATION}
            </span>,
            ...(manage
              ? [
                  <span key="a" className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={(e) => (e.stopPropagation(), setReviewing(r))} data-review-risk={r.id}>
                      <ClipboardCheck /> Review risk
                    </Button>
                  </span>,
                ]
              : []),
          ])}
          empty={all.length ? "No risks match this search and these filters." : unassigned ? "No unassigned risks: every risk on Mynt's register has an area." : `No ${label} on Mynt's register yet.${manage ? " Add one: what could go wrong, how likely and how bad." : ""}`}
        />
      </AdminList>
      {manage && (
        <>
          <AddRiskSheet subject={PLATFORM_SUBJECT} owners={owners} open={adding} onClose={() => setAdding(false)} onDone={() => onChanged?.()} fetcher={fetcher} area={data.area} />
          <ReviewRiskSheet subject={PLATFORM_SUBJECT} risk={reviewing} owners={owners} onClose={() => setReviewing(null)} onDone={() => onChanged?.()} fetcher={fetcher} withArea />
        </>
      )}
    </section>
  )
}

export const CROSS_HEAD = ["Subject", "Workspace / firm", "Risk", "Score", "Status", "Review by"] as const
const kindWords = (t: "app" | "product" | "platform") => (t === "app" ? "App" : t === "product" ? "Financial product" : "Mynt")

/** The open risks in this area on apps' and products' own registers: read-only, with its own search and pager. */
function CrossRisksSection({ data, area }: { data: CrossRisks; area: RiskArea }) {
  const [query, setQuery] = useState("")
  const all = data.available ? data.risks : []
  const rows = useMemo(() => all.filter((r) => matches(query, r.title, r.subjectName, kindWords(r.subjectType), keeperWords(r), RISK_STATUS_LABELS[r.status as RiskStatus] ?? r.status)), [all, query])
  const paged = usePaged(rows)
  return (
    <section className="flex min-w-0 shrink-0 flex-col gap-2" data-signal="cross-risks" aria-labelledby="signal-cross-risks">
      <h2 id="signal-cross-risks" className="text-sm font-semibold">
        Across apps and products
      </h2>
      <p className="text-xs text-muted-foreground">Open risks in this area on apps&apos; and financial products&apos; own registers, highest score first. Read-only: their workspaces and firms keep them.</p>
      <ListLayout search={query} onSearch={setQuery} searchLabel="Search these risks by app, product, risk or status" page={paged.page} pages={paged.pages} total={rows.length} onPage={paged.setPage}>
        <AdminTable
          head={CROSS_HEAD}
          unavailable={data.available ? null : data.reason}
          rowKeys={paged.shown.map((r) => r.id)}
          rows={paged.shown.map((r) => [
            <span key="s" className="block min-w-40 whitespace-normal" data-cross-risk={r.id}>
              {kindWords(r.subjectType)}:{" "}
              {r.href ? (
                <Link href={r.href} className="underline underline-offset-2" data-risk-link={r.href}>
                  {r.subjectName ?? "Unnamed"}
                </Link>
              ) : (
                (r.subjectName ?? "Unnamed")
              )}
            </span>,
            keeperWords(r),
            wrap(r.title, "t"),
            <span key="sc" className="tabular-nums" data-risk-level={r.level}>
              {scoreWords(r.score, r.level)}
            </span>,
            RISK_STATUS_LABELS[r.status as RiskStatus] ?? r.status,
            <span key="rv" className="tabular-nums" data-overdue={r.overdue ? "true" : undefined}>
              {reviewWords(r)}
            </span>,
          ])}
          empty={all.length ? "No risks match this search." : `No open ${RISK_AREA_LABELS[area].toLowerCase()} on any app's or product's register.`}
        />
      </ListLayout>
    </section>
  )
}

/** One signal: its table, with the signal's own columns; paged when it has more rows than a page holds. */
function SignalTable({ spec }: { spec: SignalSpec }) {
  const rows = spec.signal.available ? spec.signal.rows : []
  const paged = usePaged(rows)
  return (
    <section className="flex min-w-0 shrink-0 flex-col gap-2" data-signal={spec.id} aria-labelledby={`signal-${spec.id}`}>
      <h2 id={`signal-${spec.id}`} className="text-sm font-semibold">
        {spec.title}
      </h2>
      <p className="text-xs text-muted-foreground">{spec.description}</p>
      <div className="min-w-0 overflow-x-auto rounded-lg border" data-signal-table>
        <AdminTable
          head={spec.columns}
          unavailable={spec.signal.available ? null : spec.signal.reason}
          rowKeys={paged.shown.map((r) => r.key)}
          rows={paged.shown.map((r) => r.cells.map((cell, i) => (i === 0 ? cell : wrap(cell, String(i)))))}
          empty={spec.empty}
        />
      </div>
      {rows.length > PAGE_SIZE && <ListPager page={paged.page} pages={paged.pages} total={rows.length} onPage={paged.setPage} />}
    </section>
  )
}

/** One area's tab body, each part a table: the register (toolbar, table, sheets), the risks across apps and products, the signals. */
export function RiskRegisterAreaView({
  data,
  onChanged,
  filter = "area",
  onFilter = () => undefined,
  fetcher,
}: {
  data: RegisterAreaData
  onChanged?: () => void
  filter?: RegisterFilter
  onFilter?: (f: RegisterFilter) => void
  fetcher?: typeof fetch
}) {
  return (
    <div className="flex min-w-0 flex-col gap-8" data-risk-register-area={data.area}>
      <RegisterSection data={data} filter={filter} onFilter={onFilter} onChanged={onChanged} fetcher={fetcher} />
      <CrossRisksSection data={data.cross} area={data.area} />
      {data.signals.map((s) => (
        <SignalTable key={s.id} spec={s} />
      ))}
    </div>
  )
}

/** The page: the seven area tabs, then the tab's body (or why it isn't ready). Server-renderable with state given. */
export function RiskRegisterView({ area, onArea, body }: { area: RiskArea; onArea: (a: RiskArea) => void; body: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-4" data-platform-risk-register>
      <RiskAreaTabs area={area} onArea={onArea} label="Risk areas" />
      {body}
    </div>
  )
}

export function RiskRegisterTab() {
  const [area, setArea] = useAreaInAddress()
  const [filter, setFilter] = useState<RegisterFilter>("area")
  const pick = useCallback((b: Record<string, unknown>) => (b.register && b.unassigned && Array.isArray(b.signals) ? (b as unknown as RegisterAreaData) : undefined), [])
  const { state, reload } = useAdminData(`/api/admin/risks?area=${area}`, pick)
  return (
    <RiskRegisterView
      area={area}
      onArea={(a) => (setFilter("area"), setArea(a))}
      body={state.kind === "ready" && state.data.area === area ? <RiskRegisterAreaView data={state.data} onChanged={reload} filter={filter} onFilter={setFilter} /> : state.kind === "ready" ? null : <AdminNotReady state={state} what="The risk register" />}
    />
  )
}
