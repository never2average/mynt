"use client"

// Archiving one of the user's own financial products, and bringing it back. The Products tab's rows have the
// labelled actions (Archive on an idea or a staging product, Unarchive in the Archived view); each opens this
// sheet. Archiving asks for a reason (archive_product records it in the audit trail): the product leaves the
// sidebar's folders, the Products tab and every build, and nothing is deleted. Unarchiving puts it back in the
// stage it was archived in (unarchive_product). Mynt checks again and may refuse (a product in production is
// moved back first); its reason is shown in its own words. The view is server-renderable for the tests.
import { useEffect, useState } from "react"
import { Archive, ArchiveRestore } from "lucide-react"

import { ApprovalSummary } from "@/components/approval"
import { StageMark } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { runProductAction, type StudioProduct } from "@/lib/products"
import { announceThreads } from "@/lib/threads"
import type { Stage } from "@/lib/workspaces"

export type ArchiveMode = "archive" | "unarchive"

export type ProductArchiveViewProps = {
  product: Pick<StudioProduct, "id" | "name">
  stage: Stage
  mode: ArchiveMode
  busy?: boolean
  error?: string | null
  result?: string | null
  onConfirm: (reason?: string) => void
}

export function ProductArchiveView({ product, stage, mode, busy = false, error = null, result = null, onConfirm }: ProductArchiveViewProps) {
  const [reason, setReason] = useState("")
  const done = result !== null
  return (
    <div className="flex flex-col gap-4" data-product-archive-view={mode}>
      <ApprovalSummary
        rows={[
          ["Financial product", product.name, "product"],
          ["Stage", <StageMark key="stage" stage={stage} />, "stage"],
          [
            "Then",
            mode === "archive"
              ? "It leaves your sidebar, the Products tab and every build (apps can't pick it). Nothing is deleted; Unarchive brings it back to this stage."
              : "It comes back to your sidebar and the Products tab, in this stage.",
            "meaning",
          ],
        ]}
      />
      {!done &&
        (mode === "archive" ? (
          <form
            className="flex flex-col gap-3"
            data-archive-form
            onSubmit={(e) => {
              e.preventDefault()
              onConfirm(reason)
            }}
          >
            <label className="flex flex-col gap-1 text-sm">
              Reason
              <textarea
                className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={1000}
                required
                data-archive-reason
              />
            </label>
            <div>
              <Button type="submit" variant="outline" disabled={busy || reason.trim().length < 3} data-product-archive-confirm>
                <Archive />
                {busy ? "Archiving…" : "Archive product"}
              </Button>
            </div>
          </form>
        ) : (
          <div>
            <Button variant="outline" onClick={() => onConfirm()} disabled={busy} data-product-unarchive-confirm>
              <ArchiveRestore />
              {busy ? "Unarchiving…" : "Unarchive product"}
            </Button>
          </div>
        ))}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-product-archive-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-product-archive-result>
          {result}
        </p>
      )}
    </div>
  )
}

/** The sheet for archiving or unarchiving one product; `onDone` hears the product and its stage. */
export function ProductArchiveSheet({
  product,
  mode,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  product: (Pick<StudioProduct, "id" | "name"> & { stage: Stage }) | null
  mode: ArchiveMode | null
  onClose: () => void
  onDone: (id: string, mode: ArchiveMode, stage: Stage) => void
  fetcher?: typeof fetch
}) {
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setError(null)
    setResult(null)
  }, [product?.id, mode])
  if (!product || !mode) return null
  const confirm = async (reason?: string) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await runProductAction(product.id, mode === "archive" ? { action: "archive", reason: reason ?? "" } : { action: "unarchive" }, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.data.message ?? (mode === "archive" ? "Archived." : "Unarchived."))
    onDone(product.id, mode, r.data.stage ?? product.stage)
    announceThreads({ products: true })
  }
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-product-archive-sheet={mode}>
        <SheetHeader>
          <SheetTitle>{mode === "archive" ? `Archive ${product.name}` : `Unarchive ${product.name}`}</SheetTitle>
          <SheetDescription>
            {mode === "archive" ? "Archiving is recorded in the audit trail with your reason. Nothing is deleted." : "Unarchiving is recorded in the audit trail."}
          </SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <ProductArchiveView key={`${product.id}:${mode}`} product={product} stage={product.stage} mode={mode} busy={busy} error={error} result={result} onConfirm={(reason) => void confirm(reason)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
