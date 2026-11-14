"use client"

// The studio's list layout, for the Workspace page's tabs: a full-width search, then labelled
// actions and the tab's call to action on the same row, then a full-height table paged 25 rows
// at a time. Labelled buttons only, never icon-only ones.
import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

export const PAGE_SIZE = 25

export function usePaged<T>(rows: T[], size = PAGE_SIZE) {
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / size))
  useEffect(() => {
    if (page > pages) setPage(pages)
  }, [page, pages])
  const shown = useMemo(() => rows.slice((page - 1) * size, page * size), [rows, page, size])
  return { page: Math.min(page, pages), pages, shown, setPage }
}

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
      <div className="flex items-center justify-end gap-2 text-sm">
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
    </div>
  )
}

// Rows whose text holds every word typed.
export function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const text = fields.filter(Boolean).join(" ").toLowerCase()
  return words.every((w) => text.includes(w))
}
