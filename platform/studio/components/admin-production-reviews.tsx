"use client"

// Platform admin → Audit trails → Production reviews (/platform/audit?tab=reviews): every workspace's production code
// reviews (lib/production-reviews.ts), newest first. The list convention: full-width search, one Filters popover
// (status, workspace), labelled Export CSV, over a full-height table paged 25 rows at a time. A row opens
// /platform/audit/<review>?tab=reviews: its metadata card, then Findings and Coverage, each a table. Its changes are
// labelled buttons opening a sheet: Stop review (a review in progress) and Record exception (one build may go to
// Production without a complete review; the reason is required, kept in the audit trail and shown on the app's
// promotion checks). Server-renderable for the tests.
import { useCallback, useMemo, useState } from "react"
import { ShieldAlert, Square } from "lucide-react"

import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { usePaged } from "@/components/list-layout"
import { ReviewStatusMark, reviewCells } from "@/components/production-reviews"
import { Button } from "@/components/ui/button"
import { csvOf } from "@/lib/admin"
import {
  coverageText,
  durationText,
  FINDING_TABLE_HEAD,
  findingsText,
  isActive,
  NOT_MEASURED,
  REVIEW_STATUS_LABELS,
  REVIEW_STATUSES,
  REVIEW_TABLE_HEAD,
  sentReview,
  sentReviews,
  shortId,
  usdText,
  waiverOf,
  waiverWords,
  whenText,
  type ProductionReview,
  type ProductionReviews,
  type ReviewStatus,
} from "@/lib/production-reviews"

export const WAIVER_REASON_MIN = 20
const CSV_HEAD = ["Workspace", "App or service", "Build", "Status", "Findings by severity", "Coverage", "Cost (USD)", "Time", "Started by", "When", "Why", "Review id"]
const csvRow = (r: ProductionReview) => [
  r.workspaceName ?? r.workspaceId ?? "",
  r.appName ?? r.appId,
  r.buildId,
  REVIEW_STATUS_LABELS[r.status],
  findingsText(r.findings),
  coverageText(r.coverage),
  r.costUsd === null ? NOT_MEASURED : r.costUsd.toFixed(2),
  durationText(r.seconds),
  r.startedBy ?? "",
  r.at,
  r.reason ?? "",
  r.id,
]

const matches = (r: ProductionReview, q: string) =>
  !q || [r.appName, r.workspaceName, r.buildId, r.id, r.startedBy, r.reason, REVIEW_STATUS_LABELS[r.status]].some((v) => (v ?? "").toLowerCase().includes(q.toLowerCase()))

export function ProductionReviewsListView({ data, onOpen }: { data: ProductionReviews; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string[]>([])
  const [workspace, setWorkspace] = useState<string[]>([])
  const workspaces = useMemo(() => [...new Map(data.reviews.filter((r) => r.workspaceId).map((r) => [r.workspaceId!, r.workspaceName ?? r.workspaceId!])).entries()], [data.reviews])
  const shown = useMemo(
    () => data.reviews.filter((r) => matches(r, query.trim()) && (!status.length || status.includes(r.status)) && (!workspace.length || (r.workspaceId !== null && workspace.includes(r.workspaceId)))),
    [data.reviews, query, status, workspace],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const first = <X,>(set: (v: X) => void) => (v: X) => {
    set(v)
    setPage(1)
  }
  return (
    <AdminList
      id="production-reviews"
      search={query}
      onSearch={first(setQuery)}
      searchLabel="Search production reviews by app, workspace, build or who started them"
      facets={[
        { id: "status", label: "Status", options: REVIEW_STATUSES.map((s) => ({ value: s, label: REVIEW_STATUS_LABELS[s] })), selected: status, onChange: first(setStatus) },
        { id: "workspace", label: "Workspace", options: workspaces.map(([value, label]) => ({ value, label })), selected: workspace, onChange: first(setWorkspace) },
      ]}
      onClearFilters={() => {
        setStatus([])
        setWorkspace([])
        setPage(1)
      }}
      importable={false}
      onExport={() => downloadCsv("production-reviews.csv", csvOf(CSV_HEAD, shown.map(csvRow)))}
      exportDisabled={!shown.length}
      note={data.canRun ? null : "Production code reviews can't run on this Mynt yet: they need its agent sandboxes, model backend and repository host."}
      page={page}
      pages={pages}
      total={shown.length}
      onPage={setPage}
    >
      <AdminTable
        head={["Workspace", "App or service", ...REVIEW_TABLE_HEAD, ""]}
        rowKeys={onPage.map((r) => r.id)}
        onRow={(i) => onOpen(onPage[i].id)}
        rows={onPage.map((r) => {
          const waiver = waiverOf(data.waivers, r.appId, r.buildId)
          const [build, mark, ...rest] = reviewCells(r)
          return [
            r.workspaceName ?? r.workspaceId ?? "—",
            <span key="a" className="flex min-w-0 flex-col">
              <span className="truncate">{r.appName ?? r.appId}</span>
              <span className="text-xs text-muted-foreground">{r.appKind === "service" ? "Service" : "App"}</span>
            </span>,
            build,
            <span key="s" className="flex flex-col gap-0.5">
              {mark}
              {waiver && (
                <span className="text-xs text-muted-foreground" data-row-waiver>
                  Exception recorded for this build
                </span>
              )}
            </span>,
            ...rest,
            <Button
              key="o"
              size="sm"
              variant="outline"
              onClick={(ev) => {
                ev.stopPropagation()
                onOpen(r.id)
              }}
              data-open-review={r.id}
            >
              Open
            </Button>,
          ]
        })}
        empty={data.reviews.length ? "No reviews match these filters." : "No production code review has been requested yet."}
      />
    </AdminList>
  )
}

type DetailTab = "findings" | "coverage"
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "findings", label: "Findings" },
  { id: "coverage", label: "Coverage" },
]

export function ProductionReviewDetailView({
  review,
  onBack,
  onStop,
  onWaive,
  initialTab = "findings",
}: {
  review: ProductionReview
  onBack: () => void
  onStop?: () => void
  onWaive?: () => void
  initialTab?: DetailTab
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const findings = review.findingList ?? []
  const cover = review.coverage
  // An exception is for a build whose review can't finish: never one that passed, or that recorded a critical or high finding.
  const serious = (review.findings?.critical ?? 0) + (review.findings?.high ?? 0)
  const waivable = !isActive(review.status) && !(review.status === "complete" && serious === 0) && serious === 0
  return (
    <AdminDetail
      backLabel="Back to production reviews"
      onBack={onBack}
      title={`${review.appName ?? review.appId}: build ${shortId(review.buildId)}`}
      subtitle={[review.workspaceName, review.appKind === "service" ? "Service" : "App"].filter(Boolean).join(" · ")}
      actions={
        <>
          {isActive(review.status) && onStop && (
            <Button size="sm" variant="outline" onClick={onStop} data-stop-review>
              <Square /> Stop review
            </Button>
          )}
          {waivable && onWaive && (
            <Button size="sm" variant="outline" onClick={onWaive} data-waive-review>
              <ShieldAlert /> {review.waiver ? "Change exception" : "Record exception"}
            </Button>
          )}
        </>
      }
      fields={[
        ["Status", <ReviewStatusMark key="s" status={review.status} />],
        ["Findings by severity", findingsText(review.findings)],
        ["Cost", usdText(review.costUsd)],
        ["Time", durationText(review.seconds)],
        ["Limits", `${review.limits.minutes ?? NOT_MEASURED} min, ${usdText(review.limits.capUsd)}`],
        ["Model", review.limits.model ?? "—"],
        ["Started by", review.startedBy ?? "—"],
        ["When", whenText(review.at)],
        ["Commit", review.commit ? <code key="c" className="text-xs">{review.commit.slice(0, 12)}</code> : "—"],
        ["Build", <code key="b" className="text-xs">{review.buildId}</code>],
        ["Review", <code key="r" className="text-xs">{review.id}</code>],
        ["Exception", review.waiver ? <span key="w" className="whitespace-normal" data-review-waiver>{waiverWords(review.waiver)}</span> : "None recorded"],
        ...(review.reason ? ([["Why", <span key="y" className="whitespace-normal" data-review-reason>{review.reason}</span>]] as [string, React.ReactNode][]) : []),
        ...(review.nextStep ? ([["What to do", <span key="n" className="whitespace-normal">{review.nextStep}</span>]] as [string, React.ReactNode][]) : []),
      ]}
      tabs={DETAIL_TABS}
      tab={tab}
      onTab={setTab}
    >
      {tab === "findings" && (
        <AdminTable
          head={FINDING_TABLE_HEAD}
          rowKeys={findings.map((f, i) => `${i}:${f.title}`)}
          rows={findings.map((f) => [<span key="s" className="capitalize">{f.severity}</span>, <span key="t" className="whitespace-normal">{f.title}</span>, f.file ? <code key="f" className="text-xs">{f.file}</code> : "—", f.workflow ?? "—"])}
          empty={isActive(review.status) ? "No finding recorded so far." : "No finding recorded."}
          unavailable={review.findings === null ? "This review wrote no report, so its findings weren't measured." : null}
        />
      )}
      {tab === "coverage" && (
        <AdminTable
          head={["Workflow", "Reviewed", "Why not"]}
          rowKeys={[...(cover?.reviewed ?? []), ...(cover?.notReviewed.map((s) => s.workflow) ?? [])]}
          rows={[...(cover?.reviewed ?? []).map((w) => [w, "Yes", "—"]), ...(cover?.notReviewed ?? []).map((s) => [s.workflow, "No", <span key="y" className="whitespace-normal">{[s.kind, s.reason].filter(Boolean).join(": ") || "Not said"}</span>])]}
          empty="The review names no workflow."
          unavailable={cover === null ? "This review wrote no report, so its coverage wasn't measured." : null}
        />
      )}
    </AdminDetail>
  )
}

/** The Record exception sheet's form: the reason is required, and said to be public to the workspace and audited. */
export function WaiveReviewForm({ review, busy, onSubmit }: { review: ProductionReview; busy: boolean; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState(review.waiver?.reason ?? "")
  const short = reason.trim().length < WAIVER_REASON_MIN
  return (
    <form
      className="flex flex-col gap-3"
      data-waive-form
      onSubmit={(e) => {
        e.preventDefault()
        if (!short) onSubmit(reason.trim())
      }}
    >
      <p className="text-sm">
        Build <code>{shortId(review.buildId)}</code> of {review.appName ?? "this app"} may then go to Production without a complete code review. It is for this build only: the next build needs its own review or its own exception.
      </p>
      <Field label="Reason" hint={`Required, at least ${WAIVER_REASON_MIN} characters. Shown to the workspace on the promotion checks ("Waived by a Mynt admin: …") and kept in the audit trail with your name.`}>
        <textarea className={`${fieldClass} min-h-24`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required data-waive-reason />
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={busy || short} data-waive-confirm>
          <ShieldAlert />
          {busy ? "Recording…" : "Record exception"}
        </Button>
      </div>
    </form>
  )
}

const URL = "/api/admin/production-reviews"

function ReviewDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const pick = useCallback((b: Record<string, unknown>) => sentReview(b.review) ?? undefined, [])
  const { state, reload } = useAdminData(`${URL}/${encodeURIComponent(id)}`, pick)
  const [sheet, setSheet] = useState<"stop" | "waive" | null>(null)
  const action = useAdminAction()
  if (state.kind !== "ready") return <AdminNotReady state={state} what="This production review" />
  const review = state.data
  const open = (s: "stop" | "waive") => {
    action.reset()
    setSheet(s)
  }
  const run = async (body: unknown) => {
    const out = await action.run(URL, body)
    if (out?.ok) reload()
  }
  return (
    <>
      <ProductionReviewDetailView key={review.id} review={review} onBack={onBack} onStop={() => open("stop")} onWaive={() => open("waive")} />
      <AdminSheet
        id="stop-review"
        open={sheet === "stop"}
        title="Stop review"
        description="Ends the review's sandbox now. What it has found and spent so far is kept; a stopped review doesn't pass the production check."
        onClose={() => setSheet(null)}
        error={action.error}
        result={action.result}
      >
        {!action.result && (
          <div>
            <Button variant="outline" disabled={action.busy} onClick={() => run({ action: "stop", id: review.id })} data-stop-confirm>
              <Square />
              {action.busy ? "Stopping…" : "Stop review"}
            </Button>
          </div>
        )}
      </AdminSheet>
      <AdminSheet
        id="waive-review"
        open={sheet === "waive"}
        title="Record exception"
        description="An explicit, audited exception to the production code review for one build: for a review that can't finish (the model provider refuses it, say), never for its findings."
        onClose={() => setSheet(null)}
        error={action.error}
        result={action.result}
      >
        {!action.result && <WaiveReviewForm review={review} busy={action.busy} onSubmit={(reason) => run({ action: "waive", app_id: review.appId, build_id: review.buildId, reason })} />}
      </AdminSheet>
    </>
  )
}

export function ProductionReviewsTab({ id, onOpen, onBack }: { id: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const pick = useCallback((b: Record<string, unknown>) => sentReviews(b.reviews) ?? undefined, [])
  const { state } = useAdminData(id ? null : URL, pick)
  if (id) return <ReviewDetail id={id} onBack={onBack} />
  if (state.kind !== "ready") return <AdminNotReady state={state} what="Production reviews" />
  return <ProductionReviewsListView data={state.data} onOpen={onOpen} />
}

export type { ReviewStatus }
