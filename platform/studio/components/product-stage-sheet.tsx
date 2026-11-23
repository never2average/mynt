"use client"

// Moving a financial product between stages, the way apps move: Ideas -> Staging -> Production, one step
// at a time and back, always through a sheet, never a drag. The Products tab's rows have the labelled
// actions (Move to staging, Move to production, Move back); each opens this approval sheet: where the
// product stands (components/approval.tsx's steps), what will happen (its summary), Mynt's checks with
// their fixes (components/promotion-view.tsx's list), and one confirm button, enabled only when Mynt says
// the product can move. A failing test can be run again from the sheet (test_product). Moving back asks
// for a reason, as an app's does. Mynt checks everything again when it moves; a refusal (no licence or
// sponsorship covering it, say) is shown in Mynt's own words. The view is server-renderable for the tests.
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowUpRight, FlaskConical } from "lucide-react"

import { ApprovalSteps, ApprovalSummary, linearSteps } from "@/components/approval"
import { CheckList, MoveBackForm, StageMark } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { MOVE_LABEL, nextProductStage, previousProductStage, runProductAction, type StudioProduct } from "@/lib/products"
import { STAGE_NAMES, type PromotionChecks } from "@/lib/promotions"
import { announceThreads } from "@/lib/threads"
import { STAGES, type Stage } from "@/lib/workspaces"

// Ideas, Staging, Production, in order.
const ORDER: Stage[] = [...STAGES].reverse()
const STEP_LABELS = ORDER.map((s) => STAGE_NAMES[s])

// What each stage means for a product, in the sheet's summary.
export const STAGE_MEANING: Record<Stage, string> = {
  idea: "Only your firm sees it.",
  staging: "Apps in Ideas or Staging can build on it in the sandbox. No production app can use it.",
  production: "Published: apps can build on it and go live with it.",
}

export type ProductMove = { mode: "promote"; to: "staging" | "production" } | { mode: "demote"; to: "idea" | "staging" }

/** The move a row's action opens, from the product's stage. */
export const promoteMove = (stage: Stage): ProductMove | null => {
  const to = nextProductStage(stage)
  return to ? { mode: "promote", to } : null
}
export const demoteMove = (stage: Stage): ProductMove | null => {
  const to = previousProductStage(stage)
  return to ? { mode: "demote", to } : null
}

export type ProductStageViewProps = {
  product: Pick<StudioProduct, "id" | "name">
  stage: Stage
  move: ProductMove
  checks: PromotionChecks | null // promote: Mynt's checks (null while loading)
  busy?: boolean
  error?: string | null
  result?: string | null
  testNote?: string | null
  onConfirm: (reason?: string) => void
  onTest?: () => void
}

export function ProductStageView({ product, stage, move, checks, busy = false, error = null, result = null, testNote = null, onConfirm, onTest }: ProductStageViewProps) {
  const done = result !== null
  // Where it stands: done up to its stage, the move's target current (or reached, once it moved).
  const at = ORDER.indexOf(done ? move.to : stage) + (done ? 1 : move.mode === "promote" ? 1 : 0)
  const steps = linearSteps(STEP_LABELS, Math.min(at, ORDER.length))
  const failing = checks?.checks.filter((c) => c.status === "fail").length ?? 0
  const testFailing = checks?.checks.some((c) => c.id === "tests_passed" && c.status !== "pass")
  return (
    <div className="flex flex-col gap-4" data-product-stage-view={move.mode}>
      <ApprovalSteps steps={steps} />
      <ApprovalSummary
        rows={[
          ["Financial product", product.name, "product"],
          ["Now", <StageMark key="from" stage={stage} />, "from"],
          ["Moves to", <StageMark key="to" stage={move.to} />, "to"],
          ["Then", STAGE_MEANING[move.to], "meaning"],
        ]}
      />
      {move.mode === "promote" ? (
        checks ? (
          <>
            <CheckList checks={checks.checks} name={product.name} to={STAGE_NAMES[move.to]} />
            {testFailing && onTest && !done && (
              <div className="flex flex-col gap-1">
                <div>
                  <Button size="sm" variant="outline" onClick={onTest} disabled={busy} data-product-sheet-test>
                    <FlaskConical />
                    Run tests
                  </Button>
                </div>
                {testNote && (
                  <p role="status" className="text-xs text-muted-foreground" data-product-test-note>
                    {testNote}
                  </p>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Checking {product.name}…</p>
        )
      ) : (
        !done && <MoveBackForm appName={product.name} stage={stage} options={[move.to]} busy={busy} onMoveBack={(_, reason) => onConfirm(reason)} />
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-product-stage-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-product-stage-result>
          {result}
        </p>
      )}
      {move.mode === "promote" && !done && (
        <div className="flex flex-col gap-1">
          <Button onClick={() => onConfirm()} disabled={!checks?.canPromote || busy} data-product-confirm={move.to}>
            <ArrowUpRight />
            {busy ? "Moving…" : MOVE_LABEL[move.to]}
          </Button>
          {checks && !checks.canPromote && (
            <p className="text-xs text-muted-foreground">{failing ? `${failing} check${failing === 1 ? "" : "s"} must pass first.` : "Not every check has passed yet."}</p>
          )}
        </div>
      )}
    </div>
  )
}

/** The approval sheet for one product's move; `onMoved` hears its new stage. */
export function ProductStageSheet({
  product,
  move,
  onClose,
  onMoved,
  fetcher = (...a) => fetch(...a),
}: {
  product: (Pick<StudioProduct, "id" | "name"> & { stage: Stage }) | null
  move: ProductMove | null
  onClose: () => void
  onMoved: (id: string, stage: Stage) => void
  fetcher?: typeof fetch
}) {
  const [checks, setChecks] = useState<PromotionChecks | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [testNote, setTestNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const id = product?.id
  const to = move?.mode === "promote" ? move.to : null
  // The caller's fetch may be a new function each render; the sheet reloads only when its move changes.
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher

  const load = useCallback(async () => {
    if (!id || !to) return
    setChecks(null)
    const res = await fetchRef.current(`/api/products/${encodeURIComponent(id)}?to=${to}`, { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { checks?: PromotionChecks; message?: string } | null
    if (res?.ok && body?.checks) setChecks(body.checks)
    else setError(body?.message ?? "Couldn't load Mynt's checks. Please try again.")
  }, [id, to])

  useEffect(() => {
    setError(null)
    setResult(null)
    setTestNote(null)
    void load()
  }, [load, move])

  if (!product || !move) return null
  const confirm = async (reason?: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await runProductAction(product.id, move.mode === "promote" ? { action: "promote", to_stage: move.to } : { action: "demote", to_stage: move.to, reason: reason ?? "" }, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.data.message ?? `Moved to ${STAGE_NAMES[move.to]}.`)
    onMoved(product.id, move.to)
    announceThreads({ products: true })
  }
  const test = async () => {
    if (busy) return
    setBusy(true)
    const r = await runProductAction(product.id, { action: "test" }, fetcher)
    setBusy(false)
    setTestNote(r.ok ? (r.data.message ?? null) : r.message)
    void load()
  }
  const title = move.mode === "promote" ? `${MOVE_LABEL[move.to]}: ${product.name}` : `Move ${product.name} back`
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-product-stage-sheet>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {move.mode === "promote"
              ? `From ${STAGE_NAMES[product.stage]}. Mynt checks the product before it moves; each check shows what to fix.`
              : "Moving a product back is recorded in the audit trail with your reason."}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <ProductStageView product={product} stage={product.stage} move={move} checks={checks} busy={busy} error={error} result={result} testNote={testNote} onConfirm={(reason) => void confirm(reason)} onTest={() => void test()} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
