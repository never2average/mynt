// The dashboard (home page): Needs attention as a strip, then rows of outlined panels (Panel):
// the key figures; the P&L chart beside where the money goes; money by app beside apps by stage;
// recent activity beside the workspace facts. Sections side by side are split by a divider; flat,
// no shadows. The P&L comes from get_workspace_pnl (components/pnl.tsx) and degrades on its own;
// everything else works without it. Server-renderable for the tests.
import Link from "next/link"
import { Plus } from "lucide-react"

import { AppsByStage, NeedsAttention, Panel, RecentActivity, Section, type StagesData } from "@/components/dashboard-panels"
import { PnlChart, PNL_NOT_AVAILABLE } from "@/components/pnl"
import { Donut, HBars, KpiRow } from "@/components/charts"
import { Skeleton } from "@/components/ui/skeleton"
import { builderKpis, costSlices, moneyByApp } from "@/lib/dashboard-visual"
import { ConnectRepository, type ReposState } from "@/components/repositories"
import { Button } from "@/components/ui/button"
import { count, facts, type Dashboard } from "@/lib/dashboard"
import type { AttentionItem } from "@/lib/attention"
import type { AuditEvent } from "@/lib/compliance"
import type { Granularity, Pnl, Range } from "@/lib/pnl"
import type { Loaded } from "@/lib/use-compliance"
import { cn } from "@/lib/utils"

function Fact({ label, children, measured = true, title, id }: { label: string; children: React.ReactNode; measured?: boolean; title?: string; id: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-1.5" title={title} data-fact={id}>
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tabular-nums", !measured && "font-normal text-muted-foreground")}>{children}</span>
    </span>
  )
}

/** The operating facts: money moved, customers, hand-offs and build spend, on one wrapping line. */
function OperatingFacts({ dashboard }: { dashboard: Dashboard }) {
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-facts="operating">
      {facts(dashboard).map((f) => (
        <Fact key={f.label} id={f.label} label={f.label} measured={f.measured} title={f.note}>
          {f.value}
        </Fact>
      ))}
    </p>
  )
}

const repoCount = (r: ReposState) => (r.kind === "ready" ? r.repos.length : null)

/** The workspace facts: repositories (listed in Settings), active products and licences. GitHub is in the header. */
function WorkspaceFacts({ dashboard, repos, onReposChanged }: { dashboard: Dashboard; repos: ReposState; onReposChanged?: () => void }) {
  const n = repoCount(repos)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-3 text-xs" data-facts="workspace">
      <Fact id="repositories" label="Repositories" measured={n !== null}>
        <Link href="/settings?tab=repositories" className="hover:underline">
          {n === null ? (repos.kind === "unsupported" ? "Not available yet" : "…") : `${n} connected`}
        </Link>
      </Fact>
      <Fact id="active-products" label="Active products" measured={dashboard.activeProducts !== null}>
        {count(dashboard.activeProducts)}
      </Fact>
      <Fact id="licences" label="Licences" measured={dashboard.licences !== null}>
        <Link href="/licences" className="hover:underline">
          {count(dashboard.licences)}
        </Link>
      </Fact>
      <span className="ml-auto flex flex-wrap gap-2">
        <ConnectRepository enabled={repos.kind === "ready" && repos.connect} onConnected={onReposChanged} />
      </span>
    </div>
  )
}

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
  repos = LOADING,
  onReposChanged,
  pnl = LOADING,
  granularity = "month",
  periods = 6,
  onGranularity,
  onPeriods,
}: {
  dashboard: Dashboard
  attention?: Loaded<AttentionItem[]>
  stages?: Loaded<StagesData>
  activity?: Loaded<AuditEvent[]>
  repos?: ReposState
  onReposChanged?: () => void
  pnl?: Loaded<Pnl>
  granularity?: Granularity
  periods?: Range
  onGranularity?: (g: Granularity) => void
  onPeriods?: (p: Range) => void
}) {
  const ready = pnl.kind === "ready" ? pnl.data : null
  const appsLive = stages.kind === "ready" ? stages.data.apps.filter((a) => a.stage === "production").length : null
  const costs = costSlices(ready)
  return (
    <div className="@container/main flex flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6" data-dashboard>
      <NeedsAttention state={attention} />
      {dashboard.apps.length === 0 && <EmptyState />}

      <Panel id="kpis">
        <section className="flex flex-col gap-3" data-section="kpis" aria-label="Key figures this period">
          <KpiRow kpis={builderKpis(ready, appsLive)} />
        </section>
      </Panel>

      <Panel id="top" cols="@4xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PnlChart state={pnl} granularity={granularity} periods={periods} onGranularity={onGranularity} onPeriods={onPeriods} variant="area" title="Money moved and costs" />
        <Section id="cost-breakdown" title="Where the money goes" description="This period's costs">
          {pnl.kind === "ready" ? (
            <Donut title="Costs this period" slices={costs.slices} unmeasured={costs.unmeasured} empty="No costs measured this period" />
          ) : (
            <PnlNotReadyLine state={pnl} />
          )}
        </Section>
      </Panel>

      <Panel id="apps" cols="@4xl/main:grid-cols-2">
        <Section id="money-by-app" title="Money moved by app" description="This period">
          {pnl.kind === "ready" ? <HBars title="Money moved by app" rows={moneyByApp(ready)} empty="No money moved through your apps yet" /> : <PnlNotReadyLine state={pnl} />}
        </Section>
        <AppsByStage state={stages} apps={dashboard.apps} />
      </Panel>

      <Panel id="activity-and-facts" cols="@4xl/main:grid-cols-2">
        <RecentActivity state={activity} />
        <section className="flex min-w-0 flex-col gap-3" data-section="summary" aria-labelledby="section-summary">
          <h2 id="section-summary" className="text-sm font-semibold">
            Workspace
          </h2>
          <OperatingFacts dashboard={dashboard} />
          <WorkspaceFacts dashboard={dashboard} repos={repos} onReposChanged={onReposChanged} />
        </section>
      </Panel>
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
