"use client"

// The dashboard's investor view, for liquidity providers, laid out as the builder view: Needs attention
// (only when something needs you), the portfolio's key figures (committed, settled, queued for withdrawal,
// paid out, returns), one toolbar row (search pools, Pool, Source, Date range) over Capital in and Paid
// out, one chart above the other (the toolbar narrows those charts only), then recent financial activity
// with View all. Positions, pools and wallets in detail are on Earn and in the header. Anything Mynt
// doesn't measure reads "Not measured", never 0; any part whose tool this Mynt lacks says so.
// Model: lib/investor.ts. Server-renderable for the tests.
import Link from "next/link"
import { useState } from "react"
import { ChevronRight, Search } from "lucide-react"

import { NeedsAttention, Panel, Section } from "@/components/dashboard-panels"
import { DateRangeFilter, FilterSelect } from "@/components/filter-controls"
import { PnlChart } from "@/components/pnl"
import { KpiRow } from "@/components/charts"
import { dateRange, trimSeries, type Kpi } from "@/lib/dashboard-visual"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AttentionItem } from "@/lib/attention"
import type { AuditRow } from "@/lib/audit-classes"
import { defaultInvestorFilter, filterPositions, flowSeries, investingItem, portfolioOf, positionExtras, SOURCE_LABELS, type InvestorFilter, type Source, type Totals } from "@/lib/investor"
import type { LiquidityData } from "@/lib/liquidity"
import { money, type Range } from "@/lib/pnl"
import type { Loaded } from "@/lib/use-compliance"
import type { EarnWallets } from "@/lib/wallets"
import { cn } from "@/lib/utils"

export const BALANCES_UNAVAILABLE = "Balances unavailable"

function NotReady({ state, what }: { state: Exclude<Loaded<unknown>, { kind: "ready" }>; what: string }) {
  if (state.kind === "loading") return <Skeleton className="h-16 w-full" />
  return (
    <p className={cn("py-3 text-sm", state.kind === "error" ? "text-destructive" : "text-muted-foreground")} role={state.kind === "error" ? "alert" : undefined} data-empty="not-available">
      {state.kind === "error" ? state.message : state.kind === "unavailable" ? state.message : `${what} isn't available yet. It comes with Mynt's next update.`}
    </p>
  )
}

// ---- the portfolio strip ----

const STATS: [keyof Totals, string][] = [
  ["committed", "Committed"],
  ["settled", "Settled"],
  ["queued", "Queued for withdrawal"],
  ["paid", "Paid out"],
]

function PortfolioKpis({ positions, flows }: { positions: NonNullable<LiquidityData["provider"]>["positions"]; flows: { revenue: number | null; costs: number | null }[] | null }) {
  const p = portfolioOf(positions)
  const sources = (Object.keys(p.bySource) as Source[]).sort()
  // Running totals per period from the dated history (devnet): what went in, what was paid out.
  const running = (pick: (f: { revenue: number | null; costs: number | null }) => number | null) => {
    if (!flows || !flows.some((f) => pick(f) !== null)) return null
    let n = 0
    return flows.map((f) => (pick(f) === null ? null : (n += pick(f)!)))
  }
  const extra = positionExtras(positions)
  // A 4 x 2 grid: money in (committed, settled, pending, available), then money out and the rest.
  const kpis: Kpi[] = [
    { key: "committed", label: "Committed", value: p.all.committed, unit: "money", delta: null, spark: running((f) => f.revenue) },
    { key: "settled", label: "Settled", value: p.all.settled, unit: "money", delta: null, spark: null },
    { key: "pending", label: "Pending in", value: extra.pendingIn, unit: "money", delta: null, spark: null },
    { key: "available", label: "Available to withdraw", value: extra.available, unit: "money", delta: null, spark: null },
    { key: "queued", label: "Queued for withdrawal", value: p.all.queued, unit: "money", delta: null, spark: null },
    { key: "paid", label: "Paid out", value: p.all.paid, unit: "money", delta: null, spark: running((f) => f.costs) },
    { key: "pools", label: "Pools held", value: extra.pools, unit: "count", delta: null, spark: null },
    { key: "returns", label: "Returns", value: p.returns, unit: "money", delta: null, spark: null, note: p.returns === null ? "A surplus claim's amount isn't known" : "Wind-down surplus claimed; rails pools pay none" },
  ]
  return (
    <>
      <KpiRow kpis={kpis} grid />
      {sources.length > 1 && (
        <p className="flex flex-wrap gap-x-4 text-xs text-muted-foreground" data-split>
          {sources.map((s) => (
            <span key={s}>
              {SOURCE_LABELS[s]}: committed {money(p.bySource[s]!.committed)} · settled {money(p.bySource[s]!.settled)} · paid out {money(p.bySource[s]!.paid)}
            </span>
          ))}
        </p>
      )}
    </>
  )
}

// ---- the toolbar: search, Pool, Source, Date range ----

function InvestorToolbar({ filter, onFilter, pools }: { filter: InvestorFilter; onFilter: (f: InvestorFilter) => void; pools: { id: string; name: string }[] }) {
  const set = (patch: Partial<InvestorFilter>) => onFilter({ ...filter, ...patch })
  return (
    <div className="flex flex-wrap items-center gap-2" data-toolbar data-chart-filters>
      <div className="relative min-w-64 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={filter.query} onChange={(e) => set({ query: e.target.value, poolId: "all" })} placeholder="Search pools by name" className="pl-8" aria-label="Search pools" />
      </div>
      <FilterSelect label="Pool" value={filter.poolId === "all" ? "" : filter.poolId} onChange={(v) => set({ poolId: v || "all" })} options={pools.map((x) => ({ value: x.id, label: x.name }))} />
      <FilterSelect
        label="Source"
        value={filter.source === "all" ? "" : filter.source}
        onChange={(v) => set({ source: (v || "all") as InvestorFilter["source"] })}
        options={(Object.keys(SOURCE_LABELS) as Source[]).map((x) => ({ value: x, label: SOURCE_LABELS[x] }))}
      />
      <DateRangeFilter
        label="Date range"
        from={filter.from}
        to={filter.to}
        onChange={(from, to) => {
          // Cleared: back to the last six months.
          const d = defaultInvestorFilter()
          set(from ? { from, to: to || from } : { from: d.from, to: d.to })
        }}
      />
    </div>
  )
}

// ---- recent financial activity, with View all ----

function FinancialActivity({ state }: { state: Loaded<AuditRow[]> }) {
  return (
    <Section id="financial-activity" title="Recent financial activity">
      {state.kind !== "ready" ? (
        <NotReady state={state} what="Financial activity" />
      ) : state.data.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground" data-empty="nothing">
          No money has moved yet
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.data.slice(0, 10).map((r) => (
              <TableRow key={r.id} data-activity-row>
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{when(r.at)}</TableCell>
                <TableCell className="font-mono text-xs">{r.kind}</TableCell>
                <TableCell className="max-w-64 truncate">{r.summary ?? r.details ?? "—"}</TableCell>
                <TableCell className="text-xs capitalize">{r.status?.replace(/_/g, " ") ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {/* The whole financial audit trail, on a row of its own at the bottom right. */}
      <div className="flex justify-end border-t pt-3" data-view-all>
        <Button asChild variant="outline" size="sm">
          <Link href="/audits?tab=financial">
            View all
            <ChevronRight />
          </Link>
        </Button>
      </div>
    </Section>
  )
}

const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`

export function InvestorView({
  liquidity,
  activity = { kind: "loading" },
  attention = { kind: "loading" },
  filter: initial,
  now = Date.now(),
}: {
  liquidity: Loaded<LiquidityData>
  /** Wallets are in the header now; accepted so callers needn't change. */
  wallets?: Loaded<EarnWallets>
  activity?: Loaded<AuditRow[]>
  attention?: Loaded<AttentionItem[]>
  /** The toolbar's starting filter (the last six months, everything, by default). */
  filter?: InvestorFilter
  now?: number
}) {
  const [filter, setFilter] = useState<InvestorFilter>(initial ?? defaultInvestorFilter(new Date(now)))
  const provider = liquidity.kind === "ready" ? liquidity.data.provider : undefined
  const positionsState: Loaded<NonNullable<LiquidityData["provider"]>> =
    liquidity.kind !== "ready" ? liquidity : provider ? { kind: "ready", data: provider } : { kind: "unsupported" }
  // The key figures: the whole portfolio, its last six months of history.
  const kpiFlows = provider ? flowSeries(provider.positions, "month", 6, now) : null
  // The charts: the positions the toolbar keeps, over the dates picked.
  const range = dateRange(filter, new Date(now))
  const shown = provider ? filterPositions(provider.positions, filter) : []
  const flows = provider ? flowSeries(shown, range.granularity, range.periods as Range, now) : null
  const chart: Loaded<{ series: NonNullable<typeof flows>["series"] }> = flows
    ? { kind: "ready", data: { series: trimSeries(flows.series, filter.from, filter.to) } }
    : (positionsState as Exclude<typeof positionsState, { kind: "ready" }>)
  const pools = provider ? [...new Map(provider.positions.map((x) => [x.poolId, { id: x.poolId, name: x.name }])).values()] : []
  const onChain = shown.some((x) => x.onChain)
  const investing: Loaded<AttentionItem[]> = attention.kind === "ready" ? { kind: "ready", data: attention.data.filter(investingItem) } : attention
  const labels = { revenue: "Capital in", costs: "Paid out", netIncome: "Net" }

  return (
    <div className="flex flex-col gap-4 lg:gap-5" data-investor-view>
      <NeedsAttention state={investing} />

      <Panel id="portfolio">
        <section className="flex min-w-0 flex-col gap-2" data-section="portfolio" aria-label="Your portfolio">
          {positionsState.kind === "ready" ? <PortfolioKpis positions={positionsState.data.positions} flows={kpiFlows?.series ?? null} /> : <NotReady state={positionsState} what="Your positions" />}
        </section>
      </Panel>

      <InvestorToolbar filter={filter} onFilter={setFilter} pools={pools} />
      <Panel id="money">
        <PnlChart
          state={chart}
          granularity={range.granularity}
          periods={range.periods as Range}
          controls={false}
          only="revenue"
          variant="area"
          title="Capital in"
          id="capital-in"
          labels={labels}
          empty="Not measured yet: Mynt has no dated deposits for these dates."
        />
        <PnlChart
          state={chart}
          granularity={range.granularity}
          periods={range.periods as Range}
          controls={false}
          only="costs"
          variant="area"
          title="Paid out"
          id="paid-out"
          labels={labels}
          empty="Not measured yet: Mynt has no dated payouts for these dates."
          note={flows?.railsUnmeasured && onChain ? "Devnet deposits and payouts only: rails positions carry no dated history yet. Paid out counts in the period it became payable." : onChain ? "Paid out counts in the period it became payable." : undefined}
        />
      </Panel>

      <Panel id="financial-activity">
        <FinancialActivity state={activity} />
      </Panel>
    </div>
  )
}
