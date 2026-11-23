"use client"

// End subscription (an app's Agreements tab, on a vendor contract's row): ends the workspace's subscription to a service
// provider, with a reason. Mynt ends the agreements accepted with it (for every app it was for) and tells the provider,
// and refuses while a live product hands off through it; its reason is shown in its own words. Server-renderable.
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { VendorContractRow } from "@/lib/app-panel"

export function EndSubscriptionView({ contract, busy = false, error = null, result = null, onSubmit }: { contract: VendorContractRow; busy?: boolean; error?: string | null; result?: string | null; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState("")
  return (
    <form
      className="flex flex-col gap-3"
      data-end-subscription-form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(reason.trim())
      }}
    >
      <p className="text-sm">
        {contract.offering} from {contract.vendor}. Ending it ends the agreements accepted with it, for every app it&apos;s for, removes its credentials from your firm&apos;s key vault, and tells {contract.vendor}.
      </p>
      <label className="flex flex-col gap-1 text-sm">
        Reason
        <textarea className="min-h-20 rounded-md border border-input bg-background px-2 py-1.5 text-sm" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} required data-end-subscription-reason />
      </label>
      {result === null && (
        <div>
          <Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 3} data-end-subscription-submit>
            {busy ? "Ending…" : "End subscription"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-end-subscription-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-end-subscription-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function EndSubscriptionSheet({ contract, onClose, onDone, fetcher = (...a) => fetch(...a) }: { contract: VendorContractRow | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  useEffect(() => {
    setError(null)
    setResult(null)
  }, [contract])
  const submit = async (reason: string) => {
    if (busy || !contract) return
    setBusy(true)
    setError(null)
    const res = await fetcher("/api/marketplace/end", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subscription_id: contract.id, reason }) }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { message?: string } | null
    setBusy(false)
    if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
    if (!res?.ok) return setError(data?.message ?? "Couldn't reach Mynt. Please try again.")
    setResult(data?.message ?? "Subscription ended.")
    onDone()
  }
  return (
    <Sheet open={contract !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-end-subscription-sheet>
        <SheetHeader>
          <SheetTitle>End subscription</SheetTitle>
          <SheetDescription>Stop using this service provider. You can subscribe again from the Marketplace.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">{contract && <EndSubscriptionView key={contract.id} contract={contract} busy={busy} error={error} result={result} onSubmit={submit} />}</div>
      </SheetContent>
    </Sheet>
  )
}
