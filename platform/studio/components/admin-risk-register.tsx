"use client"

// Admin → Risk register (/platform/risk-register; lib/admin-risks.ts, GET and POST /api/admin/risks), one tab per risk
// area (components/risk-area-tabs.tsx). A tab is ONE table filling the page (components/admin-kit.tsx AdminList over
// AdminTable): the list toolbar (search, Filters for source, status, level and Unassigned, Import, Export CSV, Add
// risk) over every risk item of the area, 25 to a page, whatever its source (lib/admin-risks.ts registerItemsFrom):
// - "Mynt": Mynt's own register, each row with a labelled Review risk (the row opens it too),
// - "App: <name>" / "Product: <name>": the open risks on apps' and products' own registers, read-only, the subject
//   linked to its workspace's or firm's page and a labelled Open,
// - "Signal: <name>": what the area's signals say needs attention; a signal that is clear is one row saying so, and one
//   Mynt doesn't measure is one row, "Not available", with why: never left out, never a 0.
// Columns: Risk, Source, Category, the three scores Inherent (likelihood × impact), Control (how well its controls
// work, or "Not assessed") and Residual (each level in words with its number; a signal is "Not scored"), Owner, Status
// in words, Review by / When ("overdue" in words), Detail (cut short; in full in its title, the review sheet and the
// CSV), Action. Sorted by residual score, highest first; Filters has the residual level. A risk's row opens its page
// (/platform/risk-register/<id>, components/risk-detail.tsx) by a click or its labelled Open: Mynt's own to keep, an
// app's or a product's to read. Add risk (starting on the tab's area) and Review risk open their sheets
// (components/risk-register.tsx, as an app's and a product's). Server-renderable.
import Link from "next/link"
import { useCallback, useMemo, useState } from "react"
import { ClipboardCheck, ExternalLink, ShieldPlus } from "lucide-react"

import { AdminList, AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { RiskDetailPage } from "@/components/risk-detail"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { RiskAreaTabs, useAreaInAddress } from "@/components/risk-area-tabs"
import { AddRiskSheet, ReviewRiskSheet } from "@/components/risk-register"
import { Button } from "@/components/ui/button"
import { adminHref, csvOf } from "@/lib/admin"
import { ITEM_STATUS_LABELS, ITEM_STATUSES, levelWords, PLATFORM_SUBJECT, REGISTER_SOURCE_LABELS, REGISTER_SOURCES, registerItemsFrom, RISK_LEVELS, type RegisterAreaData, type RegisterItem } from "@/lib/admin-risks"
import { areaWords, RISK_AREA_LABELS, type RiskArea, type RiskRow } from "@/lib/risk-register"

export type RegisterFilter = "area" | "unassigned"

export const REGISTER_HEAD = ["Risk", "Source", "Category", "Inherent", "Control", "Residual", "Owner", "Status", "Review by / When", "Detail", "Action"] as const
export const REGISTER_CSV_HEAD = ["Risk", "Source", "Category", "Risk area", "Likelihood", "Impact", "Inherent score", "Inherent level", "Control", "Residual score", "Residual level", "Residual", "Owner", "Status", "Review by / When", "Overdue", "Detail"]
const registerCsvRow = (i: RegisterItem, area: string) => [
  i.title,
  i.sourceWords,
  i.category,
  area,
  i.likelihood ?? (i.score === null ? i.scoreWords : "Not recorded"),
  i.impact ?? (i.score === null ? i.scoreWords : "Not recorded"),
  i.score ?? i.scoreWords,
  i.level ? levelWords(i.level) : i.scoreWords,
  i.controlWords,
  i.residual ?? i.residualWords,
  i.residualLevel ? levelWords(i.residualLevel) : i.residualWords,
  i.residualWords,
  i.owner,
  ITEM_STATUS_LABELS[i.status],
  i.reviewBy ?? i.when,
  i.source === "signals" || i.status === "not_available" ? "Not applicable" : i.overdue ? "Yes" : "No",
  i.detail,
]

const wrap = (text: React.ReactNode, key: string) => (
  <span key={key} className="block min-w-40 whitespace-normal">
    {text}
  </span>
)

/** One area's tab body: the list toolbar over the ONE table of the area's risk items, and Mynt's register's sheets. */
export function RiskRegisterAreaView({
  data,
  onChanged,
  filter = "area",
  onFilter = () => undefined,
  onOpen = () => undefined,
  fetcher,
}: {
  data: RegisterAreaData
  onOpen?: (riskId: string) => void
  onChanged?: () => void
  filter?: RegisterFilter
  onFilter?: (f: RegisterFilter) => void
  fetcher?: typeof fetch
}) {
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<string[]>([])
  const [status, setStatus] = useState<string[]>([])
  const [level, setLevel] = useState<string[]>([])
  const [adding, setAdding] = useState(false)
  const [reviewing, setReviewing] = useState<RiskRow | null>(null)
  const unassigned = filter === "unassigned"
  const reg = unassigned ? data.unassigned : data.register
  const manage = reg.available && reg.canManage
  const all = useMemo(() => registerItemsFrom(data, unassigned), [data, unassigned])
  const rows = useMemo(
    () =>
      all.filter(
        (i) =>
          matches(query, i.title, i.sourceWords, i.category, i.owner, i.detail) &&
          (!source.length || source.includes(i.source)) &&
          (!status.length || status.includes(i.status)) &&
          (!level.length || (i.residualLevel !== null && level.includes(i.residualLevel))),
      ),
    [all, query, source, status, level],
  )
  const paged = usePaged(rows)
  const label = RISK_AREA_LABELS[data.area].toLowerCase()
  const waiting = !unassigned && data.unassigned.available ? data.unassigned.risks.length : 0
  const notes = [
    ...(unassigned ? ["Mynt's own risks with no area yet. Review one to give it its area."] : []),
    ...(reg.available && !reg.canManage ? ["Read-only: Mynt's admins keep Mynt's register."] : []),
    ...(reg.available && reg.overdue > 0 ? [reg.overdue === 1 ? "1 risk on Mynt's register is overdue for review." : `${reg.overdue} risks on Mynt's register are overdue for review.`] : []),
    ...(waiting > 0 ? [`${waiting === 1 ? "1 risk has" : `${waiting} risks have`} no area yet: choose Unassigned in Filters to see ${waiting === 1 ? "it" : "them"}.`] : []),
  ]
  const owners = data.register.available ? data.register.owners : reg.available ? reg.owners : []
  const review = (i: RegisterItem) => (manage && i.risk ? () => setReviewing(i.risk) : null)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-risk-register-area={data.area} data-risk-register={PLATFORM_SUBJECT.type} data-register-filter={filter}>
      <AdminList
        id="risk-register"
        search={query}
        onSearch={setQuery}
        searchLabel={`Search ${unassigned ? "unassigned risks" : label} by risk, source or detail`}
        facets={[
          { id: "source", label: "Source", options: REGISTER_SOURCES.map((s) => ({ value: s, label: REGISTER_SOURCE_LABELS[s] })), selected: source, onChange: setSource },
          { id: "status", label: "Status", options: ITEM_STATUSES.map((s) => ({ value: s, label: ITEM_STATUS_LABELS[s] })), selected: status, onChange: setStatus },
          { id: "level", label: "Residual level", options: RISK_LEVELS.map((l) => ({ value: l, label: levelWords(l) })), selected: level, onChange: setLevel },
          { id: "area", label: "Risk area", options: [{ value: "unassigned", label: "Unassigned (no area yet)" }], selected: unassigned ? ["unassigned"] : [], onChange: (v) => onFilter(v.includes("unassigned") ? "unassigned" : "area") },
        ]}
        onClearFilters={() => (setSource([]), setStatus([]), setLevel([]), onFilter("area"))}
        onExport={() => downloadCsv(`risk-register-${unassigned ? "unassigned" : data.area}.csv`, csvOf(REGISTER_CSV_HEAD, rows.map((i) => registerCsvRow(i, areaWords(unassigned ? null : data.area)))))}
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
          head={REGISTER_HEAD}
          rowKeys={paged.shown.map((i) => i.key)}
          onRow={(n) => paged.shown[n].riskId && onOpen(paged.shown[n].riskId!)}
          opens={paged.shown.map((i) => i.riskId !== null)}
          rows={paged.shown.map((i) => [
            wrap(i.title, "t"),
            <span key="src" className="block min-w-32 whitespace-normal" data-risk-source={i.source}>
              {i.subject ? (
                <>
                  {i.subject.kind}:{" "}
                  {i.subject.href ? (
                    <Link href={i.subject.href} className="underline underline-offset-2" onClick={(e) => e.stopPropagation()} data-risk-link={i.subject.href}>
                      {i.subject.name}
                    </Link>
                  ) : (
                    i.subject.name
                  )}
                </>
              ) : (
                i.sourceWords
              )}
            </span>,
            i.category,
            <span key="sc" className="tabular-nums whitespace-nowrap" data-risk-score={i.score ?? undefined} data-risk-level={i.level ?? undefined}>
              {i.scoreWords}
            </span>,
            <span key="ctl" data-risk-control>
              {i.controlWords}
            </span>,
            <span key="res" className="block min-w-28 tabular-nums whitespace-normal" data-risk-residual={i.residual ?? undefined} data-residual-level={i.residualLevel ?? undefined}>
              {i.residualWords}
            </span>,
            i.owner,
            <span key="st" data-risk-status={i.status}>
              {ITEM_STATUS_LABELS[i.status]}
            </span>,
            <span key="w" className="tabular-nums" data-overdue={i.overdue ? "true" : undefined}>
              {i.when}
            </span>,
            <span key="d" className="block max-w-64 truncate" title={i.detail} data-risk-detail>
              {i.detail}
            </span>,
            i.riskId ? (
              <span key="a" className="flex justify-end gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={adminHref("risk-register", i.riskId)} aria-label={`Open the risk ${i.title}`} onClick={(e) => e.stopPropagation()} data-open-risk={i.riskId}>
                    <ExternalLink /> Open
                  </Link>
                </Button>
                {review(i) && (
                  <Button size="sm" variant="outline" onClick={(e) => (e.stopPropagation(), setReviewing(i.risk))} data-review-risk={i.risk!.id}>
                    <ClipboardCheck /> Review risk
                  </Button>
                )}
              </span>
            ) : (
              ""
            ),
          ])}
          empty={all.length ? "No risks match this search and these filters." : unassigned ? "No unassigned risks: every risk on Mynt's register has an area." : `No ${label} recorded.`}
        />
      </AdminList>
      {manage && (
        <>
          <AddRiskSheet subject={PLATFORM_SUBJECT} owners={owners} open={adding} onClose={() => setAdding(false)} onDone={() => onChanged?.()} fetcher={fetcher} area={data.area} />
          <ReviewRiskSheet subject={PLATFORM_SUBJECT} risk={reviewing} owners={owners} onClose={() => setReviewing(null)} onDone={() => onChanged?.()} fetcher={fetcher} withArea />
        </>
      )}
    </div>
  )
}

/** The page: the seven area tabs, then the tab's one table (or why it isn't ready). Server-renderable with state given. */
export function RiskRegisterView({ area, onArea, body }: { area: RiskArea; onArea: (a: RiskArea) => void; body: React.ReactNode }) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" data-platform-risk-register>
      <RiskAreaTabs area={area} onArea={onArea} label="Risk areas" />
      {body}
    </div>
  )
}

export function RiskRegisterTab({ id = null, onOpen = () => undefined, onBack = () => undefined }: { id?: string | null; onOpen?: (riskId: string) => void; onBack?: () => void }) {
  return id ? <RiskDetailPage riskId={id} onBack={onBack} /> : <RiskRegisterList onOpen={onOpen} />
}

function RiskRegisterList({ onOpen }: { onOpen: (riskId: string) => void }) {
  const [area, setArea] = useAreaInAddress()
  const [filter, setFilter] = useState<RegisterFilter>("area")
  const pick = useCallback((b: Record<string, unknown>) => (b.register && b.unassigned && Array.isArray(b.signals) ? (b as unknown as RegisterAreaData) : undefined), [])
  const { state, reload } = useAdminData(`/api/admin/risks?area=${area}`, pick)
  return (
    <RiskRegisterView
      area={area}
      onArea={(a) => (setFilter("area"), setArea(a))}
      body={state.kind === "ready" && state.data.area === area ? <RiskRegisterAreaView key={area} data={state.data} onChanged={reload} filter={filter} onFilter={setFilter} onOpen={onOpen} /> : state.kind === "ready" ? null : <AdminNotReady state={state} what="The risk register" />}
    />
  )
}
