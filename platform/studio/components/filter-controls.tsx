"use client"

// The compact filter controls that sit in a table's one toolbar row, after its search: a
// labelled button per filter opening its choices, and a date range. An active filter shows on
// its control ("Status · Overdue", "Dates · 2026-11-01 – 2026-11-13") with Clear in its menu,
// never as extra lines of text. Server-renderable (the menus open on the client).
import { ChevronDown, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export type FilterOption = { value: string; label: string }

export function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: FilterOption[]; onChange: (v: string) => void }) {
  const chosen = options.find((o) => o.value === value)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9" aria-label={chosen ? `${label}: ${chosen.label}` : label} data-filter={label} data-active={chosen ? "true" : undefined}>
          {label}
          {chosen && <span className="max-w-32 truncate font-normal text-muted-foreground">· {chosen.label}</span>}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-48 overflow-y-auto" data-filter-menu={label}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">{label}</DropdownMenuLabel>
        {options.length ? (
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value} data-filter-option={o.value}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        ) : (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">Nothing to filter by yet</p>
        )}
        {chosen && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange("")} data-filter-clear>
              <X />
              Clear
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function DateRangeFilter({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const active = Boolean(from || to)
  const text = active ? `${from || "…"} – ${to || "…"}` : null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9" aria-label={text ? `Dates: ${text}` : "Dates"} data-filter="Dates" data-active={active ? "true" : undefined}>
          Dates
          {text && <span className="font-normal text-muted-foreground tabular-nums">· {text}</span>}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-64 flex-col gap-2" data-filter-menu="Dates">
        <label className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          From
          <Input type="date" value={from} onChange={(e) => onChange(e.target.value, to)} className="h-9 w-40" aria-label="From" />
        </label>
        <label className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          To
          <Input type="date" value={to} onChange={(e) => onChange(from, e.target.value)} className="h-9 w-40" aria-label="To" />
        </label>
        {active && (
          <Button variant="ghost" size="sm" className="self-end" onClick={() => onChange("", "")} data-filter-clear>
            <X />
            Clear
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}
