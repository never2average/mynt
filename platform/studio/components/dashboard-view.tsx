// The dashboard (home page), laid out like a P&L statement rather than a grid of cards: Needs
// attention as a strip, then the top row (left: revenue, costs and net this period, the
// operating facts and the workspace facts; right: the P&L chart), the statement table, and Apps
// by stage beside Recent activity (stacked on narrow screens). Sections with headings,
// dividers and tables; no cards. The P&L comes from get_workspace_pnl (components/pnl.tsx) and
// degrades on its own; everything else works without it. Server-renderable for the tests.
import Link from "next/link"
import { Github, Plus } from "lucide-react"

import { AppsByStage, NeedsAttention, RecentActivity, type StagesData } from "@/components/dashboard-panels"
import { PnlChart, PnlStatement, PnlStats } from "@/components/pnl"
import { ConnectRepository, type ReposState } from "@/components/repositories"
import { Button } from "@/components/ui/button"
import { count, facts, type Dashboard } from "@/lib/dashboard"
import type { LinkedAccounts } from "@/lib/linked-accounts"
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

/** The workspace facts: GitHub, repositories (listed in Settings), active products and licences. */
function WorkspaceFacts({ dashboard, linked, repos, onReposChanged }: { dashboard: Dashboard; linked: LinkedAccounts | null; repos: ReposState; onReposChanged?: () => void }) {
  const n = repoCount(repos)
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-2 text-xs" data-facts="workspace">
      <Fact id="github" label="GitHub">
        <span className="inline-flex items-center gap-1">
          <Github className="size-3.5" />
          {linked?.github ?? (linked ? "Not linked" : "…")}
        </span>
      </Fact>
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
        {linked && !linked.github && linked.manageUrl && (
          <Button size="sm" variant="outline" asChild>
            <a href={linked.manageUrl} rel="noreferrer">
              <Github />
              Link GitHub
            </a>
          </Button>
        )}
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
  linked = null,
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
  linked?: LinkedAccounts | null
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
  return (
    <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6" data-dashboard>
      <NeedsAttention state={attention} />
      {dashboard.apps.length === 0 && <EmptyState />}

      <div className="grid grid-cols-1 gap-6 @4xl/main:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-row="top">
        <section className="flex min-w-0 flex-col gap-3" data-section="summary" aria-labelledby="section-summary">
          <div className="border-b pb-2">
            <h2 id="section-summary" className="text-sm font-semibold">
              How the workspace is doing
            </h2>
          </div>
          <PnlStats state={pnl} />
          <OperatingFacts dashboard={dashboard} />
          <WorkspaceFacts dashboard={dashboard} linked={linked} repos={repos} onReposChanged={onReposChanged} />
        </section>
        <PnlChart state={pnl} granularity={granularity} periods={periods} onGranularity={onGranularity} onPeriods={onPeriods} />
      </div>

      <PnlStatement state={pnl} />

      <div className="grid grid-cols-1 gap-6 @5xl/main:grid-cols-2" data-row="apps-and-activity">
        <AppsByStage state={stages} apps={dashboard.apps} />
        <RecentActivity state={activity} />
      </div>
    </div>
  )
}
