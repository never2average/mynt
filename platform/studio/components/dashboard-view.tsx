// The dashboard (home page): Needs attention as a strip, then rows of outlined panels (Panel):
// the key figures; one toolbar row (search, App, App stage, Date range) over Money moved and Costs,
// one chart above the other (the toolbar narrows those charts only); recent activity. Sections side by side are split by a divider; flat,
// no shadows. The P&L comes from get_workspace_pnl (components/pnl.tsx) and degrades on its own;
// everything else works without it. Server-renderable for the tests.
import Link from "next/link"
import { Plus, Search } from "lucide-react"

import { DateRangeFilter, FilterSelect } from "@/components/filter-controls"
import { TOOLBAR_ROW, TOOLBAR_SEARCH } from "@/components/list-layout"
import { Input } from "@/components/ui/input"

import { NeedsAttention, Panel, RecentActivity, type StageApp, type StagesData } from "@/components/dashboard-panels"
import { PnlChart, PNL_NOT_AVAILABLE } from "@/components/pnl"
import { KpiRow } from "@/components/charts"
import { Skeleton } from "@/components/ui/skeleton"
import { appsForStage, buildAverageKpis, builderKpis, dateRange, DEFAULT_CHART_FILTER, defaultChartFilter, trimSeries, type ChartFilter } from "@/lib/dashboard-visual"
import { Button } from "@/components/ui/button"
import type { Dashboard } from "@/lib/dashboard"
import type { AttentionItem } from "@/lib/attention"
import type { AuditEvent } from "@/lib/compliance"
import type { Pnl, Range } from "@/lib/pnl"
import { STAGE_LABELS, STAGES } from "@/lib/workspaces"
import type { Loaded } from "@/lib/use-compliance"

function EmptyState() {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-3 text-sm" data-empty="no-apps">
      <span className="font-medium">No apps yet</span>
      <span className="text-muted-foreground">Describe an app and pick the products it builds on. Mynt&apos;s coding agent builds it, and this page shows how it does.</span>
      <Button asChild size="sm" className="ml-auto">
        <Link href="/new">
          <Plus />
          New app
        </Link>
      </Button>
    </div>
  )
}

const LOADING = { kind: "loading" } as const

export function DashboardView({
  dashboard,
  attention = LOADING,
  stages = LOADING,
  activity = LOADING,
  pnl = LOADING,
  chartPnl,
  filter = DEFAULT_CHART_FILTER,
  onFilter,
}: {
  dashboard: Dashboard
  attention?: Loaded<AttentionItem[]>
  stages?: Loaded<StagesData>
  activity?: Loaded<AuditEvent[]>
  /** The whole workspace's P&L: the key figures. */
  pnl?: Loaded<Pnl>
  /** The P&L for the filter (app, stage, date range): the Money moved and Costs charts. The workspace's when absent. */
  chartPnl?: Loaded<Pnl>
  filter?: ChartFilter
  onFilter?: (f: ChartFilter) => void
}) {
  const ready = pnl.kind === "ready" ? pnl.data : null
  const appsLive = stages.kind === "ready" ? stages.data.apps.filter((a) => a.stage === "production").length : null
  const loaded = chartPnl ?? pnl
  // Only the periods inside the dates picked.
  const charts: Loaded<Pnl> = loaded.kind === "ready" ? { kind: "ready", data: { ...loaded.data, series: trimSeries(loaded.data.series, filter.from, filter.to) } } : loaded
  const range = dateRange(filter)
  const periods = range.periods as Range
  return (
    <div className="@container/main flex flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6" data-dashboard>
      <NeedsAttention state={attention} />
      {dashboard.apps.length === 0 && <EmptyState />}

      <Panel id="kpis">
        <section className="flex flex-col gap-3" data-section="kpis" aria-label="Key figures this period">
          <KpiRow kpis={[...builderKpis(ready, appsLive), ...buildAverageKpis(dashboard.buildAverages)]} grid />
        </section>
      </Panel>

      <ChartToolbar filter={filter} onFilter={onFilter} apps={stages.kind === "ready" ? stages.data.apps : []} />
      {/* Money moved and Costs: each its own panel, one above the other. */}
      <div className="flex flex-col gap-4 lg:gap-5" data-chart-pair>
        <Panel id="money">
          <PnlChart state={charts} granularity={range.granularity} periods={periods} controls={false} only="revenue" variant="area" title="Money moved" id="money-moved" empty="Not measured yet: Mynt hasn't recorded money moved for these periods." />
        </Panel>
        <Panel id="costs">
          <PnlChart state={charts} granularity={range.granularity} periods={periods} controls={false} only="costs" variant="area" title="Costs" id="costs" empty="Not measured yet: Mynt hasn't recorded costs for these periods." />
        </Panel>
      </div>

      <Panel id="activity">
        <RecentActivity state={activity} />
      </Panel>
    </div>
  )
}

/** The charts' one toolbar row, as on Audits and Licences: search (app names), then App, App stage and Date range. */
function ChartToolbar({ filter, onFilter, apps }: { filter: ChartFilter; onFilter?: (f: ChartFilter) => void; apps: StageApp[] }) {
  const set = (patch: Partial<ChartFilter>) => onFilter?.({ ...filter, ...patch })
  return (
    <div className={TOOLBAR_ROW} data-toolbar data-chart-filters>
      <div className={TOOLBAR_SEARCH}>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter.query} onChange={(e) => set({ query: e.target.value, appId: "all" })} placeholder="Search apps by name" className="pl-8" aria-label="Search apps" />
      </div>
      <FilterSelect
        label="App"
        value={filter.appId === "all" ? "" : filter.appId}
        onChange={(v) => set({ appId: v || "all" })}
        options={appsForStage(apps, filter.stage).map((a) => ({ value: a.id, label: a.name }))}
      />
      <FilterSelect
        label="App stage"
        value={filter.stage === "all" ? "" : filter.stage}
        onChange={(v) => set({ stage: (v || "all") as ChartFilter["stage"], appId: "all" })}
        options={STAGES.map((st) => ({ value: st, label: STAGE_LABELS[st] }))}
      />
      <DateRangeFilter
        label="Date range"
        from={filter.from}
        to={filter.to}
        onChange={(from, to) => {
          // Cleared: back to the last six months.
          const d = defaultChartFilter()
          set(from ? { from, to: to || from } : { from: d.from, to: d.to })
        }}
      />
    </div>
  )
}

function PnlNotReadyLine({ state }: { state: Exclude<Loaded<Pnl>, { kind: "ready" }> }) {
  if (state.kind === "loading") return <Skeleton className="h-40 w-full" />
  return (
    <p className="py-3 text-sm text-muted-foreground" data-pnl-empty={state.kind}>
      {state.kind === "error" ? state.message : state.kind === "unavailable" ? state.message : PNL_NOT_AVAILABLE}
    </p>
  )
}
