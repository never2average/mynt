"use client"

// The dashboard's Builder / Investor switch: a segmented control, neutral (no accent colour),
// shown only when the user's roles allow both views.
import { MODE_LABELS, type DashboardMode } from "@/lib/investor"
import { cn } from "@/lib/utils"

export function ModeSwitch({ modes, mode, onMode }: { modes: DashboardMode[]; mode: DashboardMode; onMode: (m: DashboardMode) => void }) {
  if (modes.length < 2) return null
  return (
    <div className="inline-flex items-center rounded-md border p-0.5" role="group" aria-label="Dashboard view" data-mode-switch>
      {modes.map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={m === mode}
          onClick={() => onMode(m)}
          className={cn("rounded px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground", m === mode && "bg-muted font-medium text-foreground")}
          data-mode={m}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  )
}
