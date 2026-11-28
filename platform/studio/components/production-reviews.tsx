"use client"

// Production code reviews on an app's (and a service's) Security & risk tab: Mynt's full agent code review of one
// verified build, which a build needs before it goes to Production. A read view (one table: Build, Status, Findings
// by severity, Coverage, Cost, Time, Started by, When; a row opens that review's findings table) with one labelled
// action, Request production review, opening a sheet that says which build, how long it may take and what it costs
// at most. Stopping a review in progress is a labelled button in its sheet. An exception a Mynt admin recorded for
// a build is shown as it is, with its reason. A figure Mynt didn't measure says "Not measured", never 0.
// The views are server-renderable for the tests.
import { useEffect, useState } from "react"
import { FileSearch, Square } from "lucide-react"

import { ApprovalSummary } from "@/components/approval"
import { StatusDot, type DotTone } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  coverageText,
  durationText,
  FINDING_TABLE_HEAD,
  findingsText,
  isActive,
  limitWords,
  NOT_MEASURED,
  REVIEW_STATUS_LABELS,
  REVIEW_TABLE_HEAD,
  REVIEW_TONE,
  sentReview,
  shortId,
  usdText,
  waiverOf,
  waiverWords,
  whenText,
  type ProductionReview,
  type ProductionReviews,
  type ReviewsUnavailable,
  type ReviewStatus,
} from "@/lib/production-reviews"

const TONE: Record<"good" | "bad" | "warn" | "wait", DotTone> = { good: "green", bad: "red", warn: "amber", wait: "blue" }
export function ReviewStatusMark({ status }: { status: ReviewStatus }) {
  return <StatusDot tone={TONE[REVIEW_TONE[status]]} label={REVIEW_STATUS_LABELS[status]} data-review-status={status} />
}

type Fetcher = typeof fetch
const post = async (fetcher: Fetcher, url: string, body: unknown): Promise<{ ok: boolean; message: string }> => {
  const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
  const data = (await res?.json().catch(() => null)) as { message?: unknown } | null
  if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
  return { ok: Boolean(res?.ok), message: typeof data?.message === "string" ? data.message : res?.ok ? "Done." : "Couldn't reach Mynt. Please try again." }
}

/** The cells of one review's row, in REVIEW_TABLE_HEAD's order (the admin's table adds its own columns around them). */
export function reviewCells(r: ProductionReview): React.ReactNode[] {
  return [
    <code key="b" className="text-xs">
      {shortId(r.buildId)}
    </code>,
    <ReviewStatusMark key="s" status={r.status} />,
    <span key="f" className="whitespace-normal" data-review-findings>
      {findingsText(r.findings)}
    </span>,
    <span key="c" className="whitespace-normal" data-review-coverage>
      {coverageText(r.coverage)}
    </span>,
    <span key="$" className="tabular-nums" data-review-cost>
      {usdText(r.costUsd)}
    </span>,
    <span key="t" data-review-time>
      {durationText(r.seconds)}
    </span>,
    r.startedBy ?? "—",
    <span key="w" className="whitespace-nowrap tabular-nums">
      {whenText(r.at)}
    </span>,
  ]
}

/** The read view: the reviews as one table, the waivers recorded for this app's builds, and the labelled action. */
export function ProductionReviewsView({
  appId,
  data,
  noun = "app",
  onRequest,
  onOpen,
}: {
  appId: string
  data: ProductionReviews | ReviewsUnavailable
  noun?: "app" | "service"
  onRequest?: () => void
  onOpen?: (r: ProductionReview) => void
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-production-reviews aria-labelledby="production-reviews-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="production-reviews-title" className="text-sm font-semibold">
          Production code reviews
        </h2>
        {data.available && data.canRequest && onRequest && (
          <Button size="sm" variant="outline" onClick={onRequest} data-request-review>
            <FileSearch /> Request production review
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Before a build of this {noun} goes to Production, Mynt reviews its code in full, once, on that exact build. Mynt reads the review tool&apos;s own records and decides: the reviewer never grades its work, and a review that
        didn&apos;t finish doesn&apos;t pass.
      </p>
      {!data.available ? (
        <p className="py-3 text-sm text-muted-foreground" data-reviews-unavailable>
          Not available. {data.reason}
        </p>
      ) : (
        <>
          {!data.canRequest && (
            <p className="text-xs text-muted-foreground" data-reviews-read-only>
              Read-only: the workspace&apos;s owners and admins request a review.
            </p>
          )}
          {data.waivers
            .filter((w) => w.appId === appId)
            .map((w) => (
              <p key={w.buildId} role="note" className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm" data-review-waiver={w.buildId}>
                <span className="font-medium">Build {shortId(w.buildId)}:</span> {waiverWords(w)}. No complete code review ran on this build.
              </p>
            ))}
          {data.reviews.length ? (
            <div className="min-w-0 overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {REVIEW_TABLE_HEAD.map((h) => (
                      <TableHead key={h}>{h}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.reviews.map((r) => (
                    <TableRow key={r.id} data-review={r.id} data-status={r.status} className={onOpen ? "cursor-pointer" : undefined} onClick={onOpen ? () => onOpen(r) : undefined}>
                      {reviewCells(r).map((cell, i) => (
                        <TableCell key={REVIEW_TABLE_HEAD[i]}>{cell}</TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="py-3 text-sm text-muted-foreground" data-reviews-empty>
              No production code review yet. A build needs one, complete and with no critical or high finding, before it goes to Production.
            </p>
          )}
        </>
      )}
    </section>
  )
}

/** The request sheet's body: which build, what runs, how long it may take, what it costs at most. */
export function RequestReviewView({
  data,
  busy = false,
  error = null,
  result = null,
  onConfirm,
}: {
  data: ProductionReviews
  busy?: boolean
  error?: string | null
  result?: string | null
  onConfirm: (buildId: string) => void
}) {
  const builds = data.builds ?? []
  const [build, setBuild] = useState(builds[0]?.id ?? "")
  const words = limitWords(data.limits)
  const chosen = builds.find((b) => b.id === build)
  const running = data.reviews.find((r) => isActive(r.status))
  const why = !data.canRun
    ? "Production code reviews can't run on this Mynt yet."
    : !builds.length
      ? "No build has passed Mynt's verification and pushed a commit yet: a review is for a verified build."
      : running
        ? `A review of build ${shortId(running.buildId)} is ${REVIEW_STATUS_LABELS[running.status].toLowerCase()}: one review runs at a time.`
        : chosen?.reviewStatus === "complete"
          ? "This build already has a complete review. A new build needs its own."
          : null
  const used = data.usage
  return (
    <div className="flex flex-col gap-4" data-request-review-view>
      <ApprovalSummary
        rows={[
          ["What it reviews", `The build's code, in full, with Mynt's review workflows: ${words.what}`, "what"],
          ["How long it may take", words.time, "time"],
          ["What it costs at most", words.cost, "cost"],
          ["The workspace's limit", words.monthly, "monthly"],
          [
            "Used this month",
            used ? `${used.reviews ?? NOT_MEASURED} review(s), ${usdText(used.usd)}${used.month ? ` (${used.month}; a review in progress counts at its cap)` : ""}` : NOT_MEASURED,
            "used",
          ],
          ["Then", "It runs by itself; this tab shows its findings as they are recorded. A review that runs out of time or budget doesn't pass, and isn't run again by itself.", "meaning"],
        ]}
      />
      {result === null && (
        <form
          className="flex flex-col gap-3"
          data-request-review-form
          onSubmit={(e) => {
            e.preventDefault()
            if (build && !why) onConfirm(build)
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Build to review
            <select className="rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={build} onChange={(e) => setBuild(e.target.value)} disabled={!builds.length} data-review-build>
              {builds.map((b, i) => (
                <option key={b.id} value={b.id}>
                  Build {shortId(b.id)}
                  {i === 0 ? " (latest verified)" : ""}
                  {b.verifiedAt ? `, verified ${b.verifiedAt.slice(0, 10)}` : ""}
                  {b.reviewStatus ? `, last review ${REVIEW_STATUS_LABELS[b.reviewStatus].toLowerCase()}` : ", no review yet"}
                </option>
              ))}
            </select>
          </label>
          {why && (
            <p className="text-sm text-muted-foreground" data-request-review-why>
              {why}
            </p>
          )}
          <div>
            <Button type="submit" variant="outline" disabled={busy || !build || why !== null} data-request-review-confirm>
              <FileSearch />
              {busy ? "Requesting…" : "Request review"}
            </Button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-request-review-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-request-review-result>
          {result}
        </p>
      )}
    </div>
  )
}

/** One review opened: what it was, why it isn't complete (if it isn't) and what to do, then its findings as a table. */
export function ReviewDetailView({
  review,
  loading = false,
  canStop = false,
  busy = false,
  error = null,
  result = null,
  onStop,
}: {
  review: ProductionReview
  loading?: boolean
  canStop?: boolean
  busy?: boolean
  error?: string | null
  result?: string | null
  onStop?: () => void
}) {
  const list = review.findingList
  return (
    <div className="flex flex-col gap-4" data-review-detail={review.id}>
      <ApprovalSummary
        rows={[
          ["Build", <code key="b">{shortId(review.buildId)}</code>, "build"],
          ["Commit", review.commit ? <code key="c">{review.commit.slice(0, 12)}</code> : "—", "commit"],
          ["Status", <ReviewStatusMark key="s" status={review.status} />, "status"],
          ...(review.reason ? ([["Why", review.reason, "reason"]] as [string, React.ReactNode, string][]) : []),
          ...(review.nextStep ? ([["What to do", review.nextStep, "next"]] as [string, React.ReactNode, string][]) : []),
          ...(review.waiver ? ([["Exception", waiverWords(review.waiver), "waiver"]] as [string, React.ReactNode, string][]) : []),
          ["Findings by severity", findingsText(review.findings), "findings"],
          ["Coverage", coverageText(review.coverage), "coverage"],
          ["Cost", usdText(review.costUsd), "cost"],
          ["Time", durationText(review.seconds), "time"],
          ["Limits", `${review.limits.minutes ?? NOT_MEASURED} min, ${usdText(review.limits.capUsd)}, ${review.limits.workflows.join(", ") || NOT_MEASURED}`, "limits"],
          ["Started by", review.startedBy ?? "—", "by"],
          ["When", whenText(review.at), "when"],
        ]}
      />
      {review.coverage?.notReviewed.some((s) => s.reason) && (
        <ul className="list-disc pl-5 text-sm text-muted-foreground" data-review-not-finished>
          {review.coverage.notReviewed
            .filter((s) => s.reason)
            .map((s) => (
              <li key={s.workflow}>
                {s.workflow}: {s.reason}
              </li>
            ))}
        </ul>
      )}
      <div className="min-w-0 overflow-x-auto rounded-lg border" data-review-findings-table>
        <Table>
          <TableHeader>
            <TableRow>
              {FINDING_TABLE_HEAD.map((h) => (
                <TableHead key={h}>{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list?.length ? (
              list.map((f, i) => (
                <TableRow key={`${i}:${f.title}`} data-finding={f.severity}>
                  <TableCell className="capitalize">{f.severity}</TableCell>
                  <TableCell className="whitespace-normal font-medium">{f.title}</TableCell>
                  <TableCell className="whitespace-normal">{f.file ? <code className="text-xs">{f.file}</code> : "—"}</TableCell>
                  <TableCell>{f.workflow ?? "—"}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={FINDING_TABLE_HEAD.length} className="text-muted-foreground" data-findings-empty>
                  {loading ? "Reading the findings…" : list === null ? "The findings couldn't be read." : review.findings === null ? "Not measured: this review wrote no report." : isActive(review.status) ? "No finding recorded so far." : "No finding recorded."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {canStop && isActive(review.status) && onStop && result === null && (
        <div>
          <Button variant="outline" onClick={onStop} disabled={busy} data-stop-review>
            <Square />
            {busy ? "Stopping…" : "Stop review"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">What it has found and spent so far is kept. A stopped review doesn&apos;t pass.</p>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-review-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-review-result>
          {result}
        </p>
      )}
    </div>
  )
}

/** The section with its sheets, for the Security & risk tab. Every request names this app. */
export function ProductionReviewsSection({
  appId,
  data,
  noun = "app",
  onChanged,
  fetcher = (...a) => fetch(...a),
}: {
  appId: string
  data: ProductionReviews | ReviewsUnavailable
  noun?: "app" | "service"
  onChanged?: () => void
  fetcher?: Fetcher
}) {
  const url = `/api/apps/${encodeURIComponent(appId)}/production-reviews`
  const [requesting, setRequesting] = useState(false)
  const [opened, setOpened] = useState<ProductionReview | null>(null)
  const [detail, setDetail] = useState<ProductionReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const reset = () => {
    setBusy(false)
    setError(null)
    setResult(null)
  }
  // The opened review, with its findings (the list has only their counts).
  useEffect(() => {
    if (!opened) return
    let gone = false
    setDetail(null)
    setLoading(true)
    fetcher(`${url}?id=${encodeURIComponent(opened.id)}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body) => {
        if (gone) return
        setDetail(sentReview((body as { review?: unknown } | null)?.review))
        setLoading(false)
      })
    return () => {
      gone = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened?.id])
  const act = async (body: unknown) => {
    setBusy(true)
    setError(null)
    const r = await post(fetcher, url, body)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.message)
    onChanged?.()
  }
  return (
    <>
      <ProductionReviewsView
        appId={appId}
        data={data}
        noun={noun}
        onRequest={() => {
          reset()
          setRequesting(true)
        }}
        onOpen={(r) => {
          reset()
          setOpened(r)
        }}
      />
      {data.available && (
        <Sheet open={requesting} onOpenChange={(o) => !o && setRequesting(false)}>
          <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-request-review-sheet>
            <SheetHeader>
              <SheetTitle>Request production review</SheetTitle>
              <SheetDescription>Mynt&apos;s full code review of one verified build. A build needs it, complete and with no critical or high finding, before it goes to Production.</SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-4">
              <RequestReviewView data={data} busy={busy} error={error} result={result} onConfirm={(build) => act({ action: "request", build_id: build })} />
            </div>
          </SheetContent>
        </Sheet>
      )}
      <Sheet open={opened !== null} onOpenChange={(o) => !o && setOpened(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl" data-review-sheet>
          <SheetHeader>
            <SheetTitle>Production code review</SheetTitle>
            <SheetDescription>{opened ? `Build ${shortId(opened.buildId)}: what Mynt's review found, what it covered, and what it cost.` : ""}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {opened && (
              <ReviewDetailView
                review={detail ?? { ...opened, findingList: loading ? [] : null }}
                loading={loading}
                canStop={data.available && data.canRequest}
                busy={busy}
                error={error}
                result={result}
                onStop={() => act({ action: "stop", id: opened.id })}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
