"use client"

// A risk register, as an app's Security & risk tab and a product's Risk tab show it: a table of risks (title,
// category, likelihood × impact score, owner, status in words, review by), with a labelled Add risk button and a
// Review risk button on each row, each opening its sheet, for whoever keeps the register (Mynt's can_manage: the
// app's workspace owners and admins, the product's own firm). Anyone else, a product's sponsor included, reads it.
// Whatever Mynt can't answer says "Not available." with why. Mynt checks every change again and may refuse; its
// reason is shown in its own words. The views are server-renderable for the tests.
import { useEffect, useState } from "react"
import { ClipboardCheck, ShieldPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  RISK_AREA_LABELS,
  RISK_AREA_OF_CATEGORY,
  RISK_AREAS,
  RISK_CATEGORIES,
  RISK_CATEGORY_LABELS,
  RISK_STATUS_LABELS,
  RISK_STATUSES,
  scoreText,
  type RiskArea,
  type RiskCategory,
  type RiskChange,
  type RiskRegister,
  type RiskRow,
  type RiskStatus,
  type Signal,
  type Unavailable,
} from "@/lib/risk-register"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"
const SCORES = [1, 2, 3, 4, 5]
const LIKELIHOOD_WORDS = ["", "Rare", "Unlikely", "Possible", "Likely", "Almost certain"]
const IMPACT_WORDS = ["", "Negligible", "Minor", "Moderate", "Major", "Severe"]

// Mynt's own register (platform) is the platform admin's Risk register (/platform/risk-register), one risk area per
// tab, kept and read by Mynt admins only: its sheets also pick the risk's area (Add risk starts on the tab's).
export type RiskSubject = { type: "app" | "product" | "platform"; id: string }
const routeOf = (s: RiskSubject) =>
  s.type === "platform" ? "/api/admin/risks" : s.type === "app" ? `/api/apps/${encodeURIComponent(s.id)}/risks` : `/api/products/${encodeURIComponent(s.id)}/risks`

type Result = { ok: true; message: string } | { ok: false; message: string }
async function post(url: string, body: unknown, fetcher: typeof fetch): Promise<Result> {
  const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
  const data = (await res?.json().catch(() => null)) as { message?: string } | null
  if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
  if (!res?.ok) return { ok: false, message: data?.message ?? "Couldn't reach Mynt. Please try again." }
  return { ok: true, message: data?.message ?? "Done." }
}

function NotAvailable({ reason }: { reason: string }) {
  return (
    <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-not-available>
      Not available. {reason}
    </p>
  )
}

const statusText = (r: RiskRow) => RISK_STATUS_LABELS[r.status]
const reviewText = (r: RiskRow) => (r.reviewBy ? `${r.reviewBy}${r.overdue ? " (overdue)" : ""}` : "Not set")

/** The register's table, its Add risk action and each row's Review risk, with their sheets. With area (Mynt's own
 * register, one risk area per tab), the sheets pick the risk's area too, Add risk starting on that one; filters sits
 * between the heading and the table (the tab's filter chips). */
export function RiskRegisterSection({
  subject,
  data,
  onChanged,
  fetcher,
  area,
  title = "Risk register",
  filters = null,
}: {
  subject: RiskSubject
  data: RiskRegister | Unavailable
  onChanged?: () => void
  fetcher?: typeof fetch
  area?: RiskArea
  title?: string
  filters?: React.ReactNode
}) {
  const [adding, setAdding] = useState(false)
  const [reviewing, setReviewing] = useState<RiskRow | null>(null)
  const manage = data.available && data.canManage
  return (
    <section className="flex min-w-0 flex-col gap-2" data-risk-register={subject.type} aria-labelledby={`risk-register-${subject.type}`}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={`risk-register-${subject.type}`} className="text-sm font-semibold">
          {title}
        </h2>
        {manage && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} data-add-risk>
            <ShieldPlus /> Add risk
          </Button>
        )}
      </div>
      {filters}
      {!data.available ? (
        <NotAvailable reason={data.reason} />
      ) : (
        <>
          {!data.canManage && (
            <p className="text-xs text-muted-foreground" data-risk-read-only>
              {subject.type === "app" ? "Read-only: the workspace's owners and admins keep this register." : subject.type === "platform" ? "Read-only: Mynt's admins keep this register." : "Read-only: the product's own firm keeps this register."}
            </p>
          )}
          {data.overdue > 0 && (
            <p className="text-sm" role="status" data-risks-overdue={data.overdue}>
              {data.overdue === 1 ? "1 risk is overdue for review." : `${data.overdue} risks are overdue for review.`}
            </p>
          )}
          {data.risks.length ? (
            <div className="min-w-0 overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Risk</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Likelihood × impact</TableHead>
                    <TableHead>Owner</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Review by</TableHead>
                    {manage && <TableHead className="text-right">Action</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.risks.map((r) => (
                    <TableRow key={r.id} data-risk={r.id} data-status={r.status}>
                      <TableCell className="font-medium whitespace-normal">
                        {r.title}
                        {r.mitigation && <div className="text-xs font-normal text-muted-foreground">Mitigation: {r.mitigation}</div>}
                      </TableCell>
                      <TableCell>{RISK_CATEGORY_LABELS[r.category]}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums" data-risk-score={r.score}>
                        {scoreText(r.likelihood, r.impact)}
                      </TableCell>
                      <TableCell className="whitespace-normal">{r.owner ? (r.owner.name ?? "Unnamed member") : <span className="text-muted-foreground">No owner</span>}</TableCell>
                      <TableCell className="whitespace-normal">{statusText(r)}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap tabular-nums" data-overdue={r.overdue ? "true" : undefined}>
                        {reviewText(r)}
                      </TableCell>
                      {manage && (
                        <TableCell className="text-right">
                          <Button size="sm" variant="outline" onClick={() => setReviewing(r)} data-review-risk={r.id}>
                            <ClipboardCheck /> Review risk
                          </Button>
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="rounded-lg border px-4 py-4 text-sm text-muted-foreground" data-none>
              No risks on the register yet.{manage ? " Add one: what could go wrong, how likely and how bad." : ""}
            </p>
          )}
        </>
      )}
      {manage && data.available && (
        <>
          <AddRiskSheet subject={subject} owners={data.owners} open={adding} onClose={() => setAdding(false)} onDone={() => onChanged?.()} fetcher={fetcher} area={area} />
          <ReviewRiskSheet subject={subject} risk={reviewing} owners={data.owners} onClose={() => setReviewing(null)} onDone={() => onChanged?.()} fetcher={fetcher} withArea={area !== undefined} />
        </>
      )}
    </section>
  )
}

/** One signal section of an app's Security & risk tab: a table, or "Not available." with why. */
export function SignalSection({ id, title, description, columns, signal, empty }: { id: string; title: string; description?: string; columns: readonly string[]; signal: Signal; empty: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-signal={id} aria-labelledby={`signal-${id}`}>
      <h2 id={`signal-${id}`} className="text-sm font-semibold">
        {title}
      </h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
      {!signal.available ? (
        <NotAvailable reason={signal.reason} />
      ) : signal.rows.length ? (
        <div className="min-w-0 overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((c) => (
                  <TableHead key={c}>{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {signal.rows.map((r) => (
                <TableRow key={r.key} data-signal-row={r.key}>
                  {r.cells.map((cell, i) => (
                    <TableCell key={i} className={i === 0 ? "font-medium whitespace-normal" : "text-sm whitespace-normal text-muted-foreground"}>
                      {cell}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-lg border px-4 py-4 text-sm text-muted-foreground" data-none>
          {empty}
        </p>
      )}
    </section>
  )
}

// ---- the sheets ----

function ScoreSelect({ label, value, onChange, words, name }: { label: string; value: number; onChange: (n: number) => void; words: string[]; name: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <select className={field} value={value} onChange={(e) => onChange(Number(e.target.value))} data-risk-field={name}>
        {SCORES.map((n) => (
          <option key={n} value={n}>
            {n}: {words[n]}
          </option>
        ))}
      </select>
    </label>
  )
}

function OwnerSelect({ owners, value, onChange, keep }: { owners: { userId: string; name: string }[]; value: string; onChange: (v: string) => void; keep: string }) {
  if (!owners.length) return null
  return (
    <label className="flex flex-col gap-1 text-sm">
      Owner
      <select className={field} value={value} onChange={(e) => onChange(e.target.value)} data-risk-field="owner">
        <option value="">{keep}</option>
        {owners.map((o) => (
          <option key={o.userId} value={o.userId}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  )
}

function Outcome({ busy, error, result, submitLabel, busyLabel, disabled, name }: { busy: boolean; error: string | null; result: string | null; submitLabel: string; busyLabel: string; disabled: boolean; name: string }) {
  return (
    <>
      {result === null && (
        <div>
          <Button type="submit" disabled={busy || disabled} data-risk-submit={name}>
            {busy ? busyLabel : submitLabel}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-risk-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-risk-result>
          {result}
        </p>
      )}
    </>
  )
}

function AreaSelect({ value, onChange, unassigned }: { value: RiskArea | ""; onChange: (a: RiskArea) => void; unassigned?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      Risk area
      <select className={field} value={value} onChange={(e) => onChange(e.target.value as RiskArea)} required data-risk-field="risk_area">
        {unassigned && (
          <option value="" disabled>
            Unassigned: pick one
          </option>
        )}
        {RISK_AREAS.map((a) => (
          <option key={a} value={a}>
            {RISK_AREA_LABELS[a]}
          </option>
        ))}
      </select>
    </label>
  )
}

// The first category that falls under an area, so Add risk on a tab starts on a category that belongs there.
const categoryFor = (area: RiskArea | undefined): RiskCategory => (area ? (RISK_CATEGORIES.find((c) => RISK_AREA_OF_CATEGORY[c] === area) ?? "other") : "security")

export function AddRiskView({
  owners,
  busy = false,
  error = null,
  result = null,
  onSubmit,
  area,
}: {
  owners: { userId: string; name: string }[]
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (c: Extract<RiskChange, { action: "add" }>) => void
  area?: RiskArea // Mynt's own register: the risk's area, starting on the tab's
}) {
  const [title, setTitle] = useState("")
  const [riskArea, setRiskArea] = useState<RiskArea | undefined>(area)
  const [category, setCategory] = useState<RiskCategory>(categoryFor(area))
  const [description, setDescription] = useState("")
  const [likelihood, setLikelihood] = useState(3)
  const [impact, setImpact] = useState(3)
  const [mitigation, setMitigation] = useState("")
  const [owner, setOwner] = useState("")
  const [reviewBy, setReviewBy] = useState("")
  return (
    <form
      className="flex flex-col gap-3"
      data-add-risk-form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({
          action: "add",
          title: title.trim(),
          category,
          ...(riskArea ? { risk_area: riskArea } : {}),
          likelihood,
          impact,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(mitigation.trim() ? { mitigation: mitigation.trim() } : {}),
          ...(owner ? { owner_user_id: owner } : {}),
          ...(reviewBy ? { review_by: reviewBy } : {}),
        })
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        What could go wrong
        <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required data-risk-field="title" />
      </label>
      {area !== undefined && <AreaSelect value={riskArea ?? ""} onChange={setRiskArea} />}
      <label className="flex flex-col gap-1 text-sm">
        Category
        <select className={field} value={category} onChange={(e) => setCategory(e.target.value as RiskCategory)} data-risk-field="category">
          {RISK_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {RISK_CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Description (optional)
        <textarea className={`${field} min-h-20`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} data-risk-field="description" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <ScoreSelect label="Likelihood" value={likelihood} onChange={setLikelihood} words={LIKELIHOOD_WORDS} name="likelihood" />
        <ScoreSelect label="Impact" value={impact} onChange={setImpact} words={IMPACT_WORDS} name="impact" />
      </div>
      <p className="text-xs text-muted-foreground" data-risk-score-preview>
        Score: {scoreText(likelihood, impact)}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Mitigation (optional)
        <textarea className={`${field} min-h-20`} value={mitigation} onChange={(e) => setMitigation(e.target.value)} maxLength={4000} data-risk-field="mitigation" />
      </label>
      <OwnerSelect owners={owners} value={owner} onChange={setOwner} keep="You" />
      <label className="flex flex-col gap-1 text-sm">
        Review by (optional)
        <input className={field} type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} data-risk-field="review_by" />
      </label>
      <Outcome busy={busy} error={error} result={result} submitLabel="Add risk" busyLabel="Adding…" disabled={title.trim().length < 3} name="add" />
    </form>
  )
}

export function ReviewRiskView({
  risk,
  owners,
  busy = false,
  error = null,
  result = null,
  onSubmit,
  withArea = false,
}: {
  risk: RiskRow
  owners: { userId: string; name: string }[]
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (c: Extract<RiskChange, { action: "review" }>) => void
  withArea?: boolean // Mynt's own register: its area can change (an unassigned one gets one here)
}) {
  const [riskArea, setRiskArea] = useState<RiskArea | "">(risk.riskArea ?? "")
  const [status, setStatus] = useState<RiskStatus>(risk.status)
  const [likelihood, setLikelihood] = useState(risk.likelihood)
  const [impact, setImpact] = useState(risk.impact)
  const [mitigation, setMitigation] = useState(risk.mitigation ?? "")
  const [owner, setOwner] = useState("")
  const [reviewBy, setReviewBy] = useState(risk.reviewBy ?? "")
  const [note, setNote] = useState("")
  // Only what changed is sent; accepting or closing a risk needs a note saying why.
  const change = {
    ...(status !== risk.status ? { status } : {}),
    ...(withArea && riskArea && riskArea !== risk.riskArea ? { risk_area: riskArea } : {}),
    ...(likelihood !== risk.likelihood ? { likelihood } : {}),
    ...(impact !== risk.impact ? { impact } : {}),
    ...(mitigation.trim() && mitigation.trim() !== (risk.mitigation ?? "") ? { mitigation: mitigation.trim() } : {}),
    ...(owner && owner !== risk.owner?.userId ? { owner_user_id: owner } : {}),
    ...(reviewBy && reviewBy !== risk.reviewBy ? { review_by: reviewBy } : {}),
  }
  const needsNote = (status === "accepted" || status === "closed") && status !== risk.status
  return (
    <form
      className="flex flex-col gap-3"
      data-review-risk-form={risk.id}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ action: "review", risk_id: risk.id, ...change, ...(note.trim() ? { note: note.trim() } : {}) })
      }}
    >
      <p className="text-sm">
        <span className="font-medium">{risk.title}</span>
        <span className="block text-xs text-muted-foreground">
          {RISK_CATEGORY_LABELS[risk.category]} · now {scoreText(risk.likelihood, risk.impact)} · {RISK_STATUS_LABELS[risk.status]}
        </span>
      </p>
      {withArea && <AreaSelect value={riskArea} onChange={setRiskArea} unassigned={!risk.riskArea} />}
      <label className="flex flex-col gap-1 text-sm">
        Status
        <select className={field} value={status} onChange={(e) => setStatus(e.target.value as RiskStatus)} data-risk-field="status">
          {RISK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {RISK_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-3">
        <ScoreSelect label="Likelihood" value={likelihood} onChange={setLikelihood} words={LIKELIHOOD_WORDS} name="likelihood" />
        <ScoreSelect label="Impact" value={impact} onChange={setImpact} words={IMPACT_WORDS} name="impact" />
      </div>
      <p className="text-xs text-muted-foreground" data-risk-score-preview>
        Score: {scoreText(likelihood, impact)}
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Mitigation
        <textarea className={`${field} min-h-20`} value={mitigation} onChange={(e) => setMitigation(e.target.value)} maxLength={4000} data-risk-field="mitigation" />
      </label>
      <OwnerSelect owners={owners} value={owner} onChange={setOwner} keep={risk.owner ? `Keep ${risk.owner.name ?? "the current owner"}` : "Keep as is"} />
      <label className="flex flex-col gap-1 text-sm">
        Review by
        <input className={field} type="date" value={reviewBy} onChange={(e) => setReviewBy(e.target.value)} data-risk-field="review_by" />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        {needsNote ? "Why (needed to accept or close it)" : "Note (optional)"}
        <textarea className={`${field} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required={needsNote} data-risk-field="note" />
      </label>
      <Outcome busy={busy} error={error} result={result} submitLabel="Save review" busyLabel="Saving…" disabled={!Object.keys(change).length || (needsNote && !note.trim())} name="review" />
    </form>
  )
}

function useSubmit(subject: RiskSubject, open: boolean, onDone: () => void, fetcher: typeof fetch) {
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
  const submit = async (c: RiskChange) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await post(routeOf(subject), c, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.message)
    onDone()
  }
  return { busy, error, result, round, submit }
}

export function AddRiskSheet({
  subject,
  owners,
  open,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
  area,
}: {
  subject: RiskSubject
  owners: { userId: string; name: string }[]
  open: boolean
  onClose: () => void
  onDone: () => void
  fetcher?: typeof fetch
  area?: RiskArea
}) {
  const s = useSubmit(subject, open, onDone, fetcher)
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-add-risk-sheet>
        <SheetHeader>
          <SheetTitle>Add risk</SheetTitle>
          <SheetDescription>
            A risk on {subject.type === "app" ? "this app's" : subject.type === "platform" ? "Mynt's own" : "this product's"} register: what could go wrong, how likely it is and how bad it would be (1 to 5 each), who owns it and when it&apos;s next reviewed. Recorded in the audit trail.
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <AddRiskView key={`${area ?? ""}:${s.round}`} owners={owners} busy={s.busy} error={s.error} result={s.result} onSubmit={(c) => void s.submit(c)} area={area} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function ReviewRiskSheet({
  subject,
  risk,
  owners,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
  withArea = false,
}: {
  subject: RiskSubject
  risk: RiskRow | null
  owners: { userId: string; name: string }[]
  onClose: () => void
  onDone: () => void
  fetcher?: typeof fetch
  withArea?: boolean
}) {
  const s = useSubmit(subject, risk !== null, onDone, fetcher)
  return (
    <Sheet open={risk !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-review-risk-sheet>
        <SheetHeader>
          <SheetTitle>Review risk</SheetTitle>
          <SheetDescription>Change where it stands, its scores, mitigation, owner or next review date. Every change is kept in its history.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{risk && <ReviewRiskView key={`${risk.id}:${s.round}`} risk={risk} owners={owners} busy={s.busy} error={s.error} result={s.result} onSubmit={(c) => void s.submit(c)} withArea={withArea} />}</div>
      </SheetContent>
    </Sheet>
  )
}
