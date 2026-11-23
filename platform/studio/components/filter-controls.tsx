"use client"

// The filter controls that sit in a table's one toolbar row, after its search. A list's facets go
// in ONE "Filters" popover (FiltersPopover): a heading per facet with its choices as chips (any
// number per facet; a row matches any of a facet's picks, and every facet that has one), one
// Clear all, and the count on the button ("Filters · 2"). A date range is its own calendar button
// beside it (DateRangeFilter). FilterSelect stays for a single choice that isn't a list filter
// (the map's region, a chart's app). A view switch (Matched · All · Invested) is a segmented
// control (ViewSwitch). Server-renderable (the menus open on the client).
import { CalendarDays, Check, ChevronDown, SlidersHorizontal, X } from "lucide-react"
import type { DateRange } from "react-day-picker"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
export { anyOf, picksOf, type Picks } from "@/lib/facets"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

// ---- one Filters popover: facets as chips ----

/** One facet of a list's filters: its heading, its choices, and which of them are picked (any number). */
export type Facet = { id: string; label: string; options: FilterOption[]; selected: string[]; onChange: (selected: string[]) => void }

/** How many choices are picked over all the facets (the count on the Filters button). */
export const facetsOn = (facets: Facet[]) => facets.reduce((n, f) => n + f.selected.length, 0)

/** The list with `value` added, or taken out if it was there. */
export const toggled = <T extends string>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])

/**
 * The Filters popover's content: per facet, its heading once and its choices as chips that toggle
 * (any number within a facet; a row must match every facet that has one picked), then one Clear
 * all, and `footer` (a narrow panel's Export CSV) beside it.
 */
export function FacetChips({ facets, onClear, footer }: { facets: Facet[]; onClear: () => void; footer?: React.ReactNode }) {
  const on = facetsOn(facets)
  return (
    <div className="flex flex-col gap-3" data-facets>
      {facets.map((f) => (
        <section key={f.id} className="flex flex-col gap-1.5" data-facet={f.id}>
          <h3 className="text-xs font-medium text-muted-foreground" data-facet-heading>
            {f.label}
          </h3>
          {f.options.length ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={f.label}>
              {f.options.map((o) => {
                const pressed = f.selected.includes(o.value)
                return (
                  <button
                    key={o.value}
                    type="button"
                    aria-pressed={pressed}
                    data-chip={o.value}
                    data-state={pressed ? "on" : "off"}
                    onClick={() => f.onChange(toggled(f.selected, o.value))}
                    className={cn(
                      "inline-flex h-7 max-w-full items-center gap-1 truncate rounded-full border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                      pressed ? "border-primary bg-primary text-primary-foreground" : "bg-background text-foreground hover:bg-accent",
                    )}
                  >
                    {pressed && <Check className="size-3 shrink-0" />}
                    {o.label}
                  </button>
                )
              })}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Nothing to filter by yet</p>
          )}
        </section>
      ))}
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <Button variant="ghost" size="sm" disabled={!on} onClick={onClear} data-filters-clear>
          <X />
          Clear all
        </Button>
        {footer}
      </div>
    </div>
  )
}

/** The toolbar's one "Filters" button ("Filters · 2" with two choices picked), opening FacetChips. */
export function FiltersPopover({ facets, onClear, footer }: { facets: Facet[]; onClear: () => void; footer?: React.ReactNode }) {
  const on = facetsOn(facets)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-9" aria-label={on ? `Filters: ${on} on` : "Filters"} data-filters-menu-button data-active={on ? "true" : undefined}>
          <SlidersHorizontal className="text-muted-foreground" />
          Filters
          {on > 0 && <span className="font-normal text-muted-foreground tabular-nums">· {on}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-3" data-filters-menu>
        <FacetChips facets={facets} onClear={onClear} footer={footer} />
      </PopoverContent>
    </Popover>
  )
}

/**
 * A segmented control for a list's views ("Matched · All · Invested"), for PanelList's toolbar: the
 * options side by side, and in a panel narrower than 36rem one compact button with the chosen
 * view that opens the others (no heading in it: the button already says what it is).
 */
export function ViewSwitch<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const chosen = options.find((o) => o.value === value) ?? options[0]
  return (
    <>
      <div role="radiogroup" aria-label={label} className="hidden h-9 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-1 @xl/list:inline-flex" data-view-switch>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            data-view-option={o.value}
            data-state={o.value === value ? "on" : "off"}
            onClick={() => onChange(o.value)}
            className="h-7 rounded-md px-2.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="shrink-0 @xl/list:hidden" data-view-compact>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9" aria-label={`${label}: ${chosen?.label ?? ""}`}>
              {chosen?.label}
              <ChevronDown className="text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-36" data-view-menu>
            <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as T)}>
              {options.map((o) => (
                <DropdownMenuRadioItem key={o.value} value={o.value} data-view-option={o.value}>
                  {o.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  )
}

// A day as YYYY-MM-DD in local time (what the calendar shows), and back.
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const day = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : undefined
}

export type DatePreset = { id: string; label: string; from: string; to: string }

/**
 * The quick choices beside the calendar, as days (YYYY-MM-DD, inclusive). Weeks start on Monday.
 * Past ranges for records (Today, Last 7 days, Last week, Last 30 days, Last month, This month,
 * Year to date, This year, Last year); with future, ranges ahead for due dates (Today, This week,
 * Next week, Next 30 days, This month, Next month, Rest of this year, This year).
 */
export function datePresets(now: Date = new Date(), future = false): DatePreset[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const add = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
  const monday = add(today, -((today.getDay() + 6) % 7))
  const y = today.getFullYear()
  const m = today.getMonth()
  const p = (id: string, label: string, f: Date, t: Date): DatePreset => ({ id, label, from: ymd(f), to: ymd(t) })
  if (future)
    return [
      p("today", "Today", today, today),
      p("this-week", "This week", monday, add(monday, 6)),
      p("next-week", "Next week", add(monday, 7), add(monday, 13)),
      p("next-30", "Next 30 days", today, add(today, 29)),
      p("this-month", "This month", new Date(y, m, 1), new Date(y, m + 1, 0)),
      p("next-month", "Next month", new Date(y, m + 1, 1), new Date(y, m + 2, 0)),
      p("rest-of-year", "Rest of this year", today, new Date(y, 11, 31)),
      p("this-year", "This year", new Date(y, 0, 1), new Date(y, 11, 31)),
    ]
  return [
    p("today", "Today", today, today),
    p("last-7", "Last 7 days", add(today, -6), today),
    p("last-week", "Last week", add(monday, -7), add(monday, -1)),
    p("last-30", "Last 30 days", add(today, -29), today),
    p("last-month", "Last month", new Date(y, m - 1, 1), new Date(y, m, 0)),
    p("this-month", "This month", new Date(y, m, 1), today),
    p("ytd", "Year to date", new Date(y, 0, 1), today),
    p("this-year", "This year", new Date(y, 0, 1), new Date(y, 11, 31)),
    p("last-year", "Last year", new Date(y - 1, 0, 1), new Date(y - 1, 11, 31)),
  ]
}

/** A date range: quick choices (Last week, Last month, Year to date…) beside a calendar where you click the first day, then the last (two months side by side). Days after today only with future (for due dates). */
export function DateRangeFilter({ from, to, onChange, label = "Dates", clearable = true, future = false, now }: { from: string; to: string; onChange: (from: string, to: string) => void; label?: string; clearable?: boolean; future?: boolean; now?: Date }) {
  const active = Boolean(from || to)
  const presets = datePresets(now ?? new Date(), future)
  const preset = active ? presets.find((x) => x.from === from && x.to === to) : undefined
  const text = active ? (preset?.label ?? `${from || "…"} – ${to || "…"}`) : null
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
      <PopoverContent align="end" className="flex w-auto max-w-[calc(100vw-2rem)] flex-col p-0 sm:flex-row" data-filter-menu={label}>
        <div role="group" aria-label="Quick ranges" className="flex gap-1 overflow-x-auto border-b p-2 sm:w-40 sm:flex-col sm:overflow-visible sm:border-r sm:border-b-0" data-date-presets>
          {presets.map((x) => (
            <Button
              key={x.id}
              type="button"
              variant={preset?.id === x.id ? "secondary" : "ghost"}
              size="sm"
              className="shrink-0 justify-start font-normal"
              aria-pressed={preset?.id === x.id}
              data-date-preset={x.id}
              onClick={() => onChange(x.from, x.to)}
            >
              {x.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-col">
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
        </div>
      </PopoverContent>
    </Popover>
  )
}
