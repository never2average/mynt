"use client"

// The Builds page (/builds): every coding-agent build across the user's apps, newest first, in
// the dashboard's design. Key figures first (counted from the builds loaded; "Not measured" when
// they couldn't be loaded), then one toolbar row (search, one Filters popover with App and Status, Date range, Export CSV and
// New app last) and a full-height table paged 25 rows at a time. Status is a dot and words.
// Server-renderable for the tests.
import Link from "next/link"
import { useMemo, useState } from "react"
import { Download, Plus } from "lucide-react"

import { KpiRow } from "@/components/charts"
import { Panel } from "@/components/dashboard-panels"
import { anyOf, DateRangeFilter, FiltersPopover, picksOf, type Facet, type Picks } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListLayout, matches, usePaged } from "@/components/list-layout"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Measured, useNow } from "@/components/build-meter"
import { costOfCap, totalTime, type BuildMetrics } from "@/lib/build-metrics"
import { STARTING, STEERABLE } from "@/lib/chat"
import { toCsv } from "@/lib/compliance"
import type { Kpi } from "@/lib/dashboard-visual"

export type BuildRow = { appId: string; appName: string; id: string; title: string; status: string; updatedAt: string; metrics?: BuildMetrics | null }

const FAILED = new Set(["failed", "blocked", "over_budget"])
const isRunning = (s: string) => STEERABLE.has(s) || STARTING.has(s)

/** The key figures: counts of the builds loaded; every one "Not measured" when they couldn't be loaded. */
export function buildKpis(rows: BuildRow[] | null): Kpi[] {
  const count = (pick: (r: BuildRow) => boolean) => (rows ? rows.filter(pick).length : null)
  const k = (key: string, label: string, value: number | null, note: string): Kpi => ({ key, label, value, unit: "count", delta: null, spark: null, note })
  return [
    k("builds", "Builds", count(() => true), "Across your apps"),
    k("succeeded", "Succeeded", count((r) => r.status === "succeeded"), "Verified by Mynt"),
    k("failed", "Failed", count((r) => FAILED.has(r.status)), "Failed, blocked or over budget"),
    k("running", "Running", count((r) => isRunning(r.status)), "Queued or in progress"),
  ]
}

function BuildStatus({ status }: { status: string }) {
  const label = status.replace(/_/g, " ")
  const text = label[0] ? label[0].toUpperCase() + label.slice(1) : "—"
  if (status === "succeeded") return <StatusDot tone="green" label={text} />
  if (FAILED.has(status)) return <StatusDot tone="red" label={text} />
  if (isRunning(status)) return <StatusDot tone="amber" label={text} />
  return <span className="text-xs text-muted-foreground">{text}</span>
}

// A timestamp's day as YYYY-MM-DD in local time, what the date range's calendar shows.
const dayOf = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}
const whenOf = (iso: string) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "")

// App and Status take any number of picks (a build matches any of them); one value still works.
export type BuildFilters = { query: string; appId: Picks; status: Picks; from: string; to: string }
export const NO_BUILD_FILTERS: BuildFilters = { query: "", appId: [], status: [], from: "", to: "" }

export function filterBuilds(rows: BuildRow[], f: BuildFilters): BuildRow[] {
  return rows.filter((r) => {
    if (!anyOf(f.appId, r.appId) || !anyOf(f.status, r.status)) return false
    if (f.from || f.to) {
      const d = dayOf(r.updatedAt)
      if (!d || (f.from && d < f.from) || (f.to && d > f.to)) return false
    }
    return matches(f.query, r.title, r.appName, r.status, r.id)
  })
}

function LoadingBuilds() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 lg:gap-5" data-builds-loading>
      <Panel id="build-figures">
        <div className="grid grid-cols-2 gap-4 @3xl/main:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      </Panel>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="min-h-64 w-full flex-1" />
    </div>
  )
}

/** rows: the builds loaded, newest first; null while loading. error: why they couldn't be loaded. */
export function BuildsView({ rows, error = null, initial = NO_BUILD_FILTERS }: { rows: BuildRow[] | null; error?: string | null; initial?: BuildFilters }) {
  const [f, setF] = useState<BuildFilters>(initial)
  const all = useMemo(() => rows ?? [], [rows])
  const shown = useMemo(() => filterBuilds(all, f), [all, f])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const apps = useMemo(() => [...new Map(all.map((r) => [r.appId, r.appName] as const))].sort((a, b) => a[1].localeCompare(b[1])), [all])
  const statuses = useMemo(() => [...new Set(all.map((r) => r.status))].sort(), [all])
  const now = useNow(onPage.some((r) => isRunning(r.status)))
  const set = (patch: Partial<BuildFilters>) => {
    setF({ ...f, ...patch })
    setPage(1)
  }
  const facets: Facet[] = [
    { id: "app", label: "App", options: apps.map(([value, label]) => ({ value, label })), selected: picksOf(f.appId), onChange: (appId) => set({ appId }) },
    { id: "status", label: "Status", options: statuses.map((s) => ({ value: s, label: s.replace(/_/g, " ") })), selected: picksOf(f.status), onChange: (status) => set({ status }) },
  ]

  if (rows === null && !error) return <LoadingBuilds />

  const exportCsv = () =>
    downloadCsv(
      "builds.csv",
      toCsv(
        ["Build", "App", "Status", "Cost", "Time", "Updated"],
        shown.map((r) => [r.title, r.appName, r.status, costOfCap(r.metrics).text, totalTime(r.metrics, r.status).text, r.updatedAt]),
      ),
    )

  return (
    <>
      <Panel id="build-figures">
        <KpiRow kpis={buildKpis(error ? null : rows)} />
      </Panel>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <ListLayout
        search={f.query}
        onSearch={(query) => set({ query })}
        searchLabel="Search builds"
        actions={
          <>
            <FiltersPopover facets={facets} onClear={() => set({ appId: [], status: [] })} />
            <DateRangeFilter label="Date range" from={f.from} to={f.to} onChange={(from, to) => set({ from, to })} />
            <Button variant="outline" onClick={exportCsv} disabled={!shown.length} data-export>
              <Download />
              Export CSV
            </Button>
          </>
        }
        cta={
          <Button asChild data-new-app>
            <Link href="/new">
              <Plus />
              New app
            </Link>
          </Button>
        }
        page={page}
        pages={pages}
        total={shown.length}
        onPage={setPage}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Build</TableHead>
              <TableHead>App</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {onPage.length ? (
              onPage.map((r) => (
                <TableRow key={`${r.appId}-${r.id}`} data-build={r.id} data-status={r.status}>
                  <TableCell className="max-w-md truncate font-medium">
                    <Link className="hover:underline" href={`/${encodeURIComponent(r.appId)}/${encodeURIComponent(r.id)}`}>
                      {r.title}
                    </Link>
                  </TableCell>
                  <TableCell>{r.appName}</TableCell>
                  <TableCell>
                    <BuildStatus status={r.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    <Measured shown={costOfCap(r.metrics)} field="cost" />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums" data-live={isRunning(r.status) || undefined}>
                    <Measured shown={totalTime(r.metrics, r.status, now)} field="time" />
                  </TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">{whenOf(r.updatedAt)}</TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                  {all.length ? "No builds match these filters." : error ? "Builds couldn't be loaded." : "No builds yet. Start one with New app."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ListLayout>
    </>
  )
}
