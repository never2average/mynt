"use client"

// The compact filter controls that sit in a table's one toolbar row, after its search: a
// labelled button per filter opening its choices, and a date range. An active filter shows on
// its control ("Status · Overdue", "Dates · 2026-11-01 – 2026-11-13") with Clear in its menu,
// never as extra lines of text. Server-renderable (the menus open on the client).
import { CalendarDays, ChevronDown, X } from "lucide-react"
import type { DateRange } from "react-day-picker"

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
import { Calendar } from "@/components/ui/calendar"
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

// A day as YYYY-MM-DD in local time (what the calendar shows), and back.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const day = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
}

/** A date range on a calendar: click the first day, then the last (two months side by side). Days after today only with future (for due dates). */
export function DateRangeFilter({ from, to, onChange, label = "Dates", clearable = true, future = false }: { from: string; to: string; onChange: (from: string, to: string) => void; label?: string; clearable?: boolean; future?: boolean }) {
  const active = Boolean(from || to)
  const text = active ? `${from || "…"} – ${to || "…"}` : null
  const selected: DateRange | undefined = from || to ? { from: day(from), to: day(to) } : undefined
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9" aria-label={text ? `${label}: ${text}` : label} data-filter={label} data-active={active ? "true" : undefined}>
          <CalendarDays className="text-muted-foreground" />
          {label}
          {text && <span className="font-normal text-muted-foreground tabular-nums">· {text}</span>}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0" data-filter-menu={label}>
        <Calendar
          mode="range"
          numberOfMonths={2}
          selected={selected}
          defaultMonth={day(from) ?? new Date()}
          disabled={future ? undefined : { after: new Date() }}
          onSelect={(r) => onChange(r?.from ? ymd(r.from) : "", r?.to ? ymd(r.to) : r?.from ? ymd(r.from) : "")}
        />
        {clearable && active && (
          <div className="flex justify-end border-t p-2">
            <Button variant="ghost" size="sm" onClick={() => onChange("", "")} data-filter-clear>
              <X />
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
