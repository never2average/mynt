"use client"

// The dashboard's Builder / Investor views, as a breadcrumb in the page header after the title:
// "Dashboard / Builder ▾", the way shadcn's Breadcrumb shows a dropdown in a breadcrumb. The
// trigger is plain (no accent colour); its menu lists both views with a check on the current
// one. Shown only when the user's roles allow both; otherwise the header is just "Dashboard".
import { Check, ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { MODE_LABELS, type DashboardMode } from "@/lib/investor"

export function ModeSwitch({ modes, mode, onMode }: { modes: DashboardMode[]; mode: DashboardMode; onMode: (m: DashboardMode) => void }) {
  if (modes.length < 2) return null
  return (
    <span className="flex items-center gap-1" data-mode-switch>
      <span aria-hidden className="text-muted-foreground" data-breadcrumb-separator>
        /
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-1.5 text-base font-medium" aria-label={`Dashboard view: ${MODE_LABELS[mode]}`} data-mode-trigger>
            {MODE_LABELS[mode]}
            <ChevronDown className="size-4 text-muted-foreground" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-36" data-mode-menu>
          {modes.map((m) => (
            <DropdownMenuItem key={m} onSelect={() => onMode(m)} aria-current={m === mode ? "true" : undefined} data-mode={m}>
              <span className="flex-1">{MODE_LABELS[m]}</span>
              {m === mode && <Check className="size-4" aria-label="Current view" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
