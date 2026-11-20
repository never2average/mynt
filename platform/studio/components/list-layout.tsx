"use client"

// The studio's list layout, for the Workspace page's tabs: a full-width search, then labelled
// actions and the tab's call to action on the same row, then a full-height table paged 25 rows
// at a time. Labelled buttons only, never icon-only ones.
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Search, SlidersHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"

export const PAGE_SIZE = 25

export function usePaged<T>(rows: T[], size = PAGE_SIZE) {
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const current = Math.min(page, pages)
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])
  const shown = useMemo(() => rows.slice((current - 1) * size, current * size), [rows, current, size])
  return { page: current, pages, shown, setPage }
}

// A panel's table never scrolls: it shows as many rows as fit the table area's height (at least
// MIN_ROWS), measured again whenever the panel is resized, collapsed or opened, and the pager
// moves through the rest. Before anything is measured (or on the server) it is PAGE_SIZE.
export const MIN_ROWS = 5
const ROW_PX = 41 // a one-line row: p-2 cells and a 1px border
const HEAD_PX = 40 // the header row, h-10
const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect

export function rowsThatFit(area: number, head: number, row: number): number {
  return Math.max(MIN_ROWS, Math.floor((area - (head || HEAD_PX) - 2) / (row || ROW_PX)))
}

export function useFitRows(fallback = PAGE_SIZE): { ref: (el: HTMLElement | null) => void; size: number } {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [size, setSize] = useState(fallback)
  const measure = useCallback(() => {
    if (!el) return
    const area = el.clientHeight
    if (!area) return // collapsed or hidden: keep the last size until it shows again
    const head = el.querySelector<HTMLElement>("thead")?.offsetHeight ?? 0
    const row = el.querySelector<HTMLElement>("tbody tr:not([data-empty-row])")?.offsetHeight ?? 0
    const n = rowsThatFit(area, head, row)
    setSize((s) => (s === n ? s : n))
  }, [el])
  useIsoLayoutEffect(() => measure())
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [el, measure])
  return { ref: setEl, size }
}

// Columns a narrow panel leaves out (the table never scrolls sideways either): MID ones show from
// a 32rem panel, WIDE ones from 42rem. Every column is in Export CSV at any width.
export const MID_COL = "hidden @lg/list:table-cell"
export const WIDE_COL = "hidden @2xl/list:table-cell"

export function ListLayout({
  search,
  onSearch,
  searchLabel,
  actions,
  cta,
  children,
  page,
  pages,
  total,
  onPage,
}: {
  search: string
  onSearch: (q: string) => void
  searchLabel: string
  actions?: React.ReactNode
  cta?: React.ReactNode
  children: React.ReactNode // the table
  page: number
  pages: number
  total: number
  onPage: (page: number) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-list-layout>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="pl-8" />
        </div>
        {actions}
        {cta}
      </div>
      <div className="min-h-64 flex-1 overflow-auto rounded-lg border">{children}</div>
      <ListPager page={page} pages={pages} total={total} onPage={onPage} />
    </div>
  )
}

/**
 * A list for a narrow, resizable panel (Earn's right-hand tabs): ONE toolbar row that never wraps,
 * then one table filling the rest of the panel's height, then the pager pinned at the bottom.
 * The row is the search (it gives up width first), the filters and Export CSV, then the tab's
 * call to action, last and never shrunk. The panel is a container (`@container/list`): while it
 * is narrower than 48rem, the filters and Export CSV fold into one labelled "Filters" menu, so the
 * row follows the panel's width, not the window's.
 */
export function PanelList({
  id,
  search,
  onSearch,
  searchLabel,
  filters,
  activeFilters = 0,
  onExport,
  exportDisabled,
  cta,
  children,
  areaRef,
  page,
  pages,
  total,
  onPage,
}: {
  id: string
  areaRef?: (el: HTMLElement | null) => void // useFitRows' ref: the rows per page follow this area's height
  search: string
  onSearch: (q: string) => void
  searchLabel: string
  filters?: React.ReactNode
  activeFilters?: number
  onExport?: () => void
  exportDisabled?: boolean
  cta?: React.ReactNode
  children: React.ReactNode // the table
  page: number
  pages: number
  total: number
  onPage: (page: number) => void
}) {
  const exportButton = (wide: boolean) =>
    onExport ? (
      <Button variant="outline" size="sm" className={wide ? "h-9" : "h-9 w-full justify-start"} onClick={onExport} disabled={exportDisabled} data-export>
        <Download />
        Export CSV
      </Button>
    ) : null
  const folds = Boolean(filters || onExport)
  return (
    <div className="@container/list flex h-full min-h-0 flex-1 flex-col gap-3 p-4" data-list-layout data-tab-panel={id}>
      <div className="flex flex-nowrap items-center gap-2" data-toolbar>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="pl-8" />
        </div>
        {filters && (
          <div className="hidden shrink-0 flex-nowrap items-center gap-2 @3xl/list:flex" data-filters-inline>
            {filters}
          </div>
        )}
        {onExport && (
          <div className="hidden shrink-0 @3xl/list:block" data-export-inline>
            {exportButton(true)}
          </div>
        )}
        {folds && (
          <div className="shrink-0 @3xl/list:hidden" data-filters-folded>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" className="h-9" aria-label={activeFilters ? `Filters: ${activeFilters} on` : "Filters"} data-filters-menu-button data-active={activeFilters ? "true" : undefined}>
                  <SlidersHorizontal className="text-muted-foreground" />
                  Filters
                  {activeFilters > 0 && <span className="font-normal text-muted-foreground tabular-nums">· {activeFilters}</span>}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-60 flex-col items-stretch gap-2 p-2 [&_[data-filter]]:w-full [&_[data-filter]]:justify-between" data-filters-menu>
                {filters}
                {onExport && <div className={filters ? "border-t pt-2" : undefined}>{exportButton(false)}</div>}
              </PopoverContent>
            </Popover>
          </div>
        )}
        {cta && (
          <div className="shrink-0" data-toolbar-cta>
            {cta}
          </div>
        )}
      </div>
      {/* No scrolling, down or across: the page holds as many rows as fit, and long text truncates. */}
      <div ref={areaRef} className="min-h-0 flex-1 overflow-hidden rounded-lg border [&_[data-slot=table-container]]:overflow-hidden [&_td]:truncate" data-table-area>
        {children}
      </div>
      <ListPager page={page} pages={pages} total={total} onPage={onPage} />
    </div>
  )
}

/** The list's pager, under its table: "N rows · Page x of y", then Previous and Next. */
export function ListPager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (page: number) => void }) {
  return (
    <div className="flex items-center justify-end gap-2 text-sm" data-pager>
      <span className="text-muted-foreground">
        {total} {total === 1 ? "row" : "rows"} · Page {page} of {pages}
      </span>
      <Button size="sm" variant="outline" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        <ChevronLeft />
        Previous
      </Button>
      <Button size="sm" variant="outline" onClick={() => onPage(page + 1)} disabled={page >= pages}>
        Next
        <ChevronRight />
      </Button>
    </div>
  )
}

// Rows whose text holds every word typed.
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const text = fields.filter(Boolean).join(" ").toLowerCase()
  return words.every((w) => text.includes(w))
}
