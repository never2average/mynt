"use client"

// The studio's list layout, for the Workspace page's tabs: a full-width search, then labelled
// actions and the tab's call to action on the same row, then a full-height table paged 25 rows
// at a time. Labelled buttons only, never icon-only ones.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ChevronLeft, ChevronRight, Download, Search } from "lucide-react"

import { FiltersPopover, type Facet } from "@/components/filter-controls"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

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

// A panel's table never scrolls down (only sideways, when it's wider than the panel): it shows as many rows as fit the table area's height (at least
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

// A panel's table shows every column at every width, each with a min width for what it holds; a
// table wider than its panel scrolls sideways inside it (PanelList's table area), never down (the
// pager pages). The first column (the row's name) stays pinned while it scrolls. Every column is in
// Export CSV too.
export const COL = {
  name: "sticky left-0 z-10 min-w-56 bg-card", // the row's name, and a muted line under it
  short: "min-w-28", // a word or two: a state, a number of days
  text: "min-w-48", // a phrase: a status, a health reading
  wide: "min-w-60", // a longer phrase: limits, a reserve, waiting requests
  money: "min-w-32 text-right tabular-nums",
  actions: "w-px min-w-36 text-right", // as wide as its buttons
} as const

/**
 * A page's one toolbar row (search, filters, actions): it never wraps. Where the window is too
 * narrow for it (a phone), the row scrolls sideways and every button keeps its label. The padding
 * (offset by the negative margin) keeps focus rings from being clipped by the scroll.
 */
export const TOOLBAR_ROW = "-m-1 flex flex-nowrap items-center gap-2 overflow-x-auto p-1 [scrollbar-width:none] [&>*]:shrink-0"
/** The toolbar's search: it takes the room left, never less than it needs to read. */
export const TOOLBAR_SEARCH = "relative min-w-48 flex-1 sm:min-w-64"

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
      <div className={TOOLBAR_ROW} data-toolbar>
        <div className={TOOLBAR_SEARCH}>
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
 * The row is the search (it gives up width first), the tab's view switch (ViewSwitch), ONE
 * "Filters" button (its facets as chips in one popover, components/filter-controls.tsx
 * FiltersPopover), Export CSV, then the tab's call to action, last and never shrunk. The panel is
 * a container (`@container/list`): while it is narrower than 48rem, Export CSV moves into the
 * Filters popover, beside Clear all, so the row follows the panel's width, not the window's.
 */
export function PanelList({
  id,
  search,
  onSearch,
  searchLabel,
  view,
  facets,
  onClearFilters,
  onExport,
  exportDisabled,
  cta,
  children,
  areaRef,
  noun,
  page,
  pages,
  total,
  onPage,
}: {
  id: string
  noun?: [string, string] // what the pager counts, singular and plural ("rows" by default)
  areaRef?: (el: HTMLElement | null) => void // useFitRows' ref: the rows per page follow this area's height
  search: string
  onSearch: (q: string) => void
  searchLabel: string
  view?: React.ReactNode // the tab's view switch (ViewSwitch), right after the search
  facets?: Facet[] // the tab's filters, as chips in the one Filters popover
  onClearFilters?: () => void // its Clear all
  onExport?: () => void
  exportDisabled?: boolean
  cta?: React.ReactNode
  children: React.ReactNode // the table
  page: number
  pages: number
  total: number
  onPage: (page: number) => void
}) {
  const exportButton = onExport ? (
    <Button variant="outline" size="sm" className="h-9" onClick={onExport} disabled={exportDisabled} data-export>
      <Download />
      Export CSV
    </Button>
  ) : null
  // Export CSV is in the row while the panel is 48rem or wider; narrower, the row hides it and the
  // Filters popover shows it (checked as the popover opens: the popover isn't in the panel, so the
  // panel's container query can't reach it).
  const inlineExport = useRef<HTMLDivElement>(null)
  const [exportFolded, setExportFolded] = useState(true)
  const hasFacets = Boolean(facets?.length)
  return (
    <div className="@container/list flex h-full min-h-0 flex-1 flex-col gap-3 p-4" data-list-layout data-tab-panel={id}>
      <div className="flex flex-nowrap items-center gap-2" data-toolbar>
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="pl-8" />
        </div>
        {view && (
          <div className="flex shrink-0 items-center" data-toolbar-view>
            {view}
          </div>
        )}
        {hasFacets && (
          <div className="shrink-0" data-filters-folded onPointerDownCapture={() => setExportFolded(!inlineExport.current?.offsetWidth)} onKeyDownCapture={() => setExportFolded(!inlineExport.current?.offsetWidth)}>
            <FiltersPopover facets={facets!} onClear={() => onClearFilters?.()} footer={exportFolded ? exportButton : null} />
          </div>
        )}
        {onExport && (
          <div ref={inlineExport} className={hasFacets ? "hidden shrink-0 @3xl/list:block" : "shrink-0"} data-export-inline>
            {exportButton}
          </div>
        )}
        {cta && (
          <div className="shrink-0" data-toolbar-cta>
            {cta}
          </div>
        )}
      </div>
      {/* No scrolling down: the page holds as many rows as fit. A table wider than the panel
          scrolls sideways in the table area (shadcn's own scroll wrapper is turned off, so the
          area is the one scroller and the pinned first column sticks to it). */}
      <div ref={areaRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden rounded-lg border [&_[data-slot=table-container]]:overflow-visible [&_td]:px-3 [&_th]:px-3" data-table-area>
        {children}
      </div>
      <ListPager page={page} pages={pages} total={total} onPage={onPage} noun={noun} />
    </div>
  )
}

/** The list's pager, under its table: "N rows · Page x of y", then Previous and Next. */
export function ListPager({ page, pages, total, onPage, noun = ["row", "rows"] }: { page: number; pages: number; total: number; onPage: (page: number) => void; noun?: [string, string] }) {
  return (
    <div className="flex items-center justify-end gap-2 text-sm" data-pager>
      <span className="text-muted-foreground">
        {total} {total === 1 ? noun[0] : noun[1]} · Page {page} of {pages}
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
