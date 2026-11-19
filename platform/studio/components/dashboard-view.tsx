// The dashboard (home page): Needs attention as a strip, then rows of outlined panels (Panel):
// the key figures; Money moved and Costs, one chart above the other, under one set of filters
// (app, app stage, date range: those charts only); recent activity. Sections side by side are split by a divider; flat,
// no shadows. The P&L comes from get_workspace_pnl (components/pnl.tsx) and degrades on its own;
// everything else works without it. Server-renderable for the tests.
import Link from "next/link"
import { Plus } from "lucide-react"

import { NeedsAttention, Panel, RecentActivity, type StageApp, type StagesData } from "@/components/dashboard-panels"
import { PnlChart, PNL_NOT_AVAILABLE } from "@/components/pnl"
import { KpiRow } from "@/components/charts"
import { Skeleton } from "@/components/ui/skeleton"
import { appsForStage, builderKpis, dateRange, DEFAULT_CHART_FILTER, type ChartFilter } from "@/lib/dashboard-visual"
import { Button } from "@/components/ui/button"
import type { Dashboard } from "@/lib/dashboard"
import type { AttentionItem } from "@/lib/attention"
import type { AuditEvent } from "@/lib/compliance"
import { DATE_RANGES, type Pnl } from "@/lib/pnl"
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
  const charts = chartPnl ?? pnl
  const range = dateRange(filter.range)
  return (
    <div className="@container/main flex flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6" data-dashboard>
      <NeedsAttention state={attention} />
      {dashboard.apps.length === 0 && <EmptyState />}

      <Panel id="kpis">
        <section className="flex flex-col gap-3" data-section="kpis" aria-label="Key figures this period">
          <KpiRow kpis={builderKpis(ready, appsLive)} />
        </section>
      </Panel>

      <Panel id="money">
        <div className="flex flex-col gap-4">
          <ChartFilters filter={filter} onFilter={onFilter} apps={stages.kind === "ready" ? stages.data.apps : []} />
          <PnlChart state={charts} granularity={range.granularity} periods={range.periods} controls={false} only="revenue" variant="area" title="Money moved" id="money-moved" empty="Not measured yet: Mynt hasn't recorded money moved for these periods." />
        </div>
        <PnlChart state={charts} granularity={range.granularity} periods={range.periods} controls={false} only="costs" variant="area" title="Costs" id="costs" empty="Not measured yet: Mynt hasn't recorded costs for these periods." />
      </Panel>

      <Panel id="activity">
        <RecentActivity state={activity} />
      </Panel>
    </div>
  )
}

/** One set of filters for both charts: the app (within the stage picked), the app stage, the date range. */
function ChartFilters({ filter, onFilter, apps }: { filter: ChartFilter; onFilter?: (f: ChartFilter) => void; apps: StageApp[] }) {
  const set = (patch: Partial<ChartFilter>) => onFilter?.({ ...filter, ...patch })
  const choices = appsForStage(apps, filter.stage)
  return (
    <div className="flex flex-wrap items-end gap-3" data-chart-filters>
      <FilterSelect label="App" value={filter.app} onChange={(app) => set({ app })} id="app">
        <option value="all">All apps</option>
        {choices.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="App stage" value={filter.stage} onChange={(stage) => set({ stage: stage as ChartFilter["stage"], app: "all" })} id="stage">
        <option value="all">All stages</option>
        {STAGES.map((st) => (
          <option key={st} value={st}>
            {STAGE_LABELS[st]}
          </option>
        ))}
      </FilterSelect>
      <FilterSelect label="Date range" value={filter.range} onChange={(range) => set({ range: range as ChartFilter["range"] })} id="range">
        {DATE_RANGES.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </FilterSelect>
    </div>
  )
}

function FilterSelect({ label, value, onChange, id, children }: { label: string; value: string; onChange: (v: string) => void; id: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-36 flex-col gap-1 text-xs text-muted-foreground" data-filter={id}>
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border bg-background px-2 text-sm text-foreground shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {children}
      </select>
    </label>
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
