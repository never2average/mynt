// What a compliance page shows while its data isn't there: loading, not offered by this Mynt
// yet, not scoped to this shared workspace yet, or an error.
import { Clock } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import type { Loaded } from "@/lib/use-compliance"

export function NotAvailableYet({ what, message }: { what: string; message?: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center" data-empty="not-available">
      <Clock className="size-6 text-muted-foreground" />
      <p className="font-medium">{what} isn&apos;t available yet</p>
      <p className="max-w-md text-sm text-muted-foreground">{message ?? "It comes with Mynt's next update. Nothing is missing from your workspace."}</p>
    </div>
  )
}

// The page's body for every state but ready.
export function NotReady<T>({ state, what }: { state: Exclude<Loaded<T>, { kind: "ready" }>; what: string }) {
  if (state.kind === "loading") return <Skeleton className="h-96 w-full rounded-xl" />
  if (state.kind === "error")
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    )
  return <NotAvailableYet what={what} message={state.kind === "unavailable" ? state.message : undefined} />
}
