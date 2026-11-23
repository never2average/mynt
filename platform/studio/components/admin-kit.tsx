"use client"

// The Admin area's building blocks (/admin, components/admin-view.tsx), in the studio's list and detail layouts:
// a list is one toolbar row (full-width search, one Filters popover, labelled Import and Export CSV, then the tab's
// call to action) over a full-height table paged 25 rows at a time; a detail is a metadata card on top, a tab
// selector, and each tab a table. Tabs only show; every change is a labelled button opening a sheet (AdminSheet),
// which posts to an /api/admin route and shows Mynt's answer in its words. Data loads platform-wide, never with the
// sidebar's workspace (no withWorkspace here). Server-renderable for the tests.
import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Download, Search, Upload } from "lucide-react"

import { FiltersPopover, type Facet } from "@/components/filter-controls"
import { ListPager, TOOLBAR_ROW, TOOLBAR_SEARCH } from "@/components/list-layout"
import { NotReady } from "@/components/not-available"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tab, TabList } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { Loaded } from "@/lib/use-compliance"

export type { Loaded }

/** Loads an admin route's data (no workspace in the address: the Admin area is platform-wide). */
export function useAdminData<T>(path: string | null, pick: (body: Record<string, unknown>) => T | undefined): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" })
  const [tick, setTick] = useState(0)
  const reload = useCallback(() => setTick((t) => t + 1), [])
  useEffect(() => {
    if (!path) return
    let live = true
    setState({ kind: "loading" })
    ;(async () => {
      const res = await fetch(path, { cache: "no-store" }).catch(() => null)
      if (res?.status === 401) {
        window.location.assign("/api/auth/login")
        return
      }
      const body = (await res?.json().catch(() => null)) as Record<string, unknown> | null
      if (!live) return
      if (res?.status === 404 && body?.error === "not_found" && !body.message) return setState({ kind: "error", message: "This is for Mynt admins." })
      if (!res?.ok || !body) return setState({ kind: "error", message: (body?.message as string) ?? "Couldn't reach Mynt. Please try again." })
      if (body.supported === false) return setState({ kind: "unsupported" })
      const data = pick(body)
      setState(data === undefined ? { kind: "error", message: "Mynt's answer wasn't readable." } : { kind: "ready", data })
    })()
    return () => {
      live = false
    }
  }, [path, pick, tick])
  return { state, reload }
}

/** A tab's body while its data isn't ready: loading, not offered by this Mynt yet, or an error. */
export function AdminNotReady<T>({ state, what }: { state: Exclude<Loaded<T>, { kind: "ready" }>; what: string }) {
  return <NotReady state={state} what={what} />
}

export const IMPORT_NOTE = "Importing a CSV comes with Mynt's next update."

/** A list: one toolbar row over a full-height table and its pager. */
export function AdminList({
  id,
  search,
  onSearch,
  searchLabel,
  facets,
  onClearFilters,
  onExport,
  exportDisabled,
  cta,
  note,
  children,
  page,
  pages,
  total,
  onPage,
}: {
  id: string
  search: string
  onSearch: (q: string) => void
  searchLabel: string
  facets?: Facet[]
  onClearFilters?: () => void
  onExport: () => void
  exportDisabled?: boolean
  cta?: React.ReactNode
  note?: string | null // e.g. "The newest 500 of 812 are shown"
  children: React.ReactNode
  page: number
  pages: number
  total: number
  onPage: (p: number) => void
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-admin-list={id}>
      <div className={TOOLBAR_ROW} data-toolbar>
        <div className={TOOLBAR_SEARCH}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => onSearch(e.target.value)} placeholder={searchLabel} aria-label={searchLabel} className="pl-8" />
        </div>
        {facets && facets.length > 0 && <FiltersPopover facets={facets} onClear={() => onClearFilters?.()} />}
        <Button variant="outline" disabled title={IMPORT_NOTE} aria-description={IMPORT_NOTE} data-import>
          <Upload />
          Import
        </Button>
        <Button variant="outline" onClick={onExport} disabled={exportDisabled} data-export>
          <Download />
          Export CSV
        </Button>
        {cta}
      </div>
      {note && <p className="text-xs text-muted-foreground" data-list-note>{note}</p>}
      <div className="min-h-64 flex-1 overflow-auto rounded-lg border" data-table-view>
        {children}
      </div>
      <ListPager page={page} pages={pages} total={total} onPage={onPage} />
    </div>
  )
}

/** A plain table: its head, its rows (cells), and what it says when there are none. */
export function AdminTable({ head, rows, empty, rowKeys }: { head: string[]; rows: React.ReactNode[][]; empty: string; rowKeys?: string[] }) {
  return (
    <Table>
      <TableHeader className="sticky top-0 bg-card">
        <TableRow>
          {head.map((h) => (
            <TableHead key={h}>{h}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length ? (
          rows.map((cells, i) => (
            <TableRow key={rowKeys?.[i] ?? i} data-row={rowKeys?.[i]}>
              {cells.map((c, j) => (
                <TableCell key={j} className={j === 0 ? "font-medium" : undefined}>
                  {c}
                </TableCell>
              ))}
            </TableRow>
          ))
        ) : (
          <TableRow data-empty-row>
            <TableCell colSpan={head.length} className="py-10 text-center text-muted-foreground">
              {empty}
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  )
}

/** A detail page: Back, the metadata card (title, then label/value pairs, then the labelled actions), the tab selector and the tab's table. */
export function AdminDetail<T extends string>({
  backLabel,
  onBack,
  title,
  subtitle,
  fields,
  actions,
  tabs,
  tab,
  onTab,
  children,
}: {
  backLabel: string
  onBack: () => void
  title: string
  subtitle?: string | null
  fields: [string, React.ReactNode][]
  actions?: React.ReactNode
  tabs: { id: T; label: string }[]
  tab: T
  onTab: (t: T) => void
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-admin-detail>
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} data-back>
          <ArrowLeft />
          {backLabel}
        </Button>
      </div>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" data-metadata-card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{title}</h2>
            {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2" data-detail-actions>{actions}</div>}
        </div>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {fields.map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <TabList aria-label={`${title} tabs`}>
        {tabs.map((t) => (
          <Tab key={t.id} selected={tab === t.id} data-detail-tab={t.id} onClick={() => onTab(t.id)}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <div className="min-h-64 flex-1 overflow-auto rounded-lg border" data-detail-table>
        {children}
      </div>
    </div>
  )
}

/** Posts one admin action and keeps what Mynt answered: busy, its refusal, or its message. */
export function useAdminAction(fetcher: typeof fetch = (...a) => fetch(...a)) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const reset = useCallback(() => {
    setBusy(false)
    setError(null)
    setResult(null)
  }, [])
  const run = useCallback(
    async (url: string, body: unknown): Promise<Record<string, unknown> | null> => {
      setBusy(true)
      setError(null)
      setResult(null)
      const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
      const data = (await res?.json().catch(() => null)) as Record<string, unknown> | null
      setBusy(false)
      if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
      if (!res?.ok) {
        setError(typeof data?.message === "string" ? data.message : "Couldn't reach Mynt. Please try again.")
        return data
      }
      setResult(typeof data?.message === "string" ? data.message : "Done.")
      return data
    },
    [fetcher],
  )
  return { busy, error, result, run, reset }
}

/** An action's sheet: its title, what it does, then its form; Mynt's answer under it. */
export function AdminSheet({ open, title, description, onClose, error, result, children, id }: { open: boolean; title: string; description: string; onClose: () => void; error?: string | null; result?: string | null; children: React.ReactNode; id: string }) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-admin-sheet={id}>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-4">
          {children}
          {error && (
            <p role="alert" className="text-sm text-destructive" data-sheet-error>
              {error}
            </p>
          )}
          {result && (
            <p role="status" className="text-sm font-medium" data-sheet-result>
              {result}
            </p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export const fieldClass = "rounded-md border border-input bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/20"

/** A labelled field in a sheet's form. */
export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}
