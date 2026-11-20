"use client"

// The dashboard's investor view, for liquidity providers, in the builder view's statement style
// (sections with headings and tables, no cards): the portfolio strip (committed, settled, queued
// for withdrawal, paid out, returns), capital in against paid out per period (the P&L chart), each
// deposit with its pool, source (Devnet or Rails), status and pool health, what comes up in the
// next 30 days, the user's wallets with their balances, recent financial activity and what needs
// attention about investing. Anything Mynt doesn't measure reads "Not measured", never 0; any part
// whose tool this Mynt lacks says so. Model: lib/investor.ts. Server-renderable for the tests.
import Link from "next/link"

import { NeedsAttention, Panel, Section, SectionLink } from "@/components/dashboard-panels"
import { PnlChart } from "@/components/pnl"
import { Donut, KpiRow } from "@/components/charts"
import type { Kpi } from "@/lib/dashboard-visual"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AttentionItem } from "@/lib/attention"
import type { AuditRow } from "@/lib/audit-classes"
import {
  allocation,
  HEALTH_LABELS,
  healthState,
  unlockBars,
  type HealthState,
  comingUp,
  COMING_UP_DAYS,
  COMING_UP_LABELS,
  depositRows,
  flowSeries,
  investingItem,
  portfolioOf,
  SOURCE_LABELS,
  statusText,
  type Source,
  type Totals,
} from "@/lib/investor"
import { healthText, type LiquidityData } from "@/lib/liquidity"
import { money, NOT_MEASURED, type Granularity, type Range } from "@/lib/pnl"
import type { Loaded } from "@/lib/use-compliance"
import { balancesText, type EarnWallets } from "@/lib/wallets"
import { shortAddress } from "@/lib/linked-accounts"
import { cn } from "@/lib/utils"

export const BALANCES_UNAVAILABLE = "Balances unavailable"
const EARN_POSITIONS = "/earn?tab=my-positions"

function NotReady({ state, what }: { state: Exclude<Loaded<unknown>, { kind: "ready" }>; what: string }) {
  if (state.kind === "loading") return <Skeleton className="h-16 w-full" />
  return (
    <p className={cn("py-3 text-sm", state.kind === "error" ? "text-destructive" : "text-muted-foreground")} role={state.kind === "error" ? "alert" : undefined} data-empty="not-available">
      {state.kind === "error" ? state.message : state.kind === "unavailable" ? state.message : `${what} isn't available yet. It comes with Mynt's next update.`}
    </p>
  )
}

function SourceBadge({ source }: { source: Source }) {
  return (
    <Badge variant="outline" className="font-normal" data-source={source}>
      {SOURCE_LABELS[source]}
    </Badge>
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
  const kpis: Kpi[] = [
    { key: "committed", label: "Committed", value: p.all.committed, unit: "money", delta: null, spark: running((f) => f.revenue) },
    { key: "settled", label: "Settled", value: p.all.settled, unit: "money", delta: null, spark: null },
    { key: "queued", label: "Queued for withdrawal", value: p.all.queued, unit: "money", delta: null, spark: null },
    { key: "paid", label: "Paid out", value: p.all.paid, unit: "money", delta: null, spark: running((f) => f.costs) },
    { key: "returns", label: "Returns", value: null, unit: "money", delta: null, spark: null, note: "Mynt doesn't measure yield" },
  ]
  return (
    <>
      <KpiRow kpis={kpis} />
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

// ---- the unlock timeline: a mini Gantt per deposit ----

const day = (t: number) => new Date(t).toISOString().slice(0, 10)

function UnlockTimeline({ positions, now }: { positions: NonNullable<LiquidityData["provider"]>["positions"]; now: number }) {
  const bars = unlockBars(positions, now)
  if (!bars.length)
    return (
      <p className="py-3 text-sm text-muted-foreground" data-empty="nothing">
        No devnet deposits with a lock-in
      </p>
    )
  return (
    <ol className="flex flex-col gap-2" data-unlocks>
      {bars.map((b) => {
        const span = b.end - b.start
        const at = (t: number) => `${Math.min(100, Math.max(0, ((t - b.start) / span) * 100))}%`
        const label = `${b.poolName}: in review until ${day(b.reviewEnd)}, locked until ${day(b.unlock)}, then available. ${statusText({ status: b.status, until: null })} today.`
        return (
          <li key={b.key} className="grid grid-cols-[minmax(0,8rem)_1fr] items-center gap-3" data-unlock={b.key} data-status={b.status}>
            <span className="truncate text-xs">{b.poolName}</span>
            <span className="relative block h-3 w-full overflow-hidden rounded-sm bg-muted" role="img" aria-label={label}>
              <span className="absolute inset-y-0 bg-chart-3/70" style={{ left: "0%", width: at(b.reviewEnd) }} data-segment="review" />
              <span className="absolute inset-y-0 bg-chart-2/70" style={{ left: at(b.reviewEnd), width: `calc(${at(b.unlock)} - ${at(b.reviewEnd)})` }} data-segment="locked" />
              <span className="absolute inset-y-0 right-0 bg-chart-1/70" style={{ left: at(b.unlock) }} data-segment="available" />
              <span className="absolute inset-y-[-2px] w-0.5 bg-foreground" style={{ left: at(b.now) }} data-now title="Now" />
            </span>
          </li>
        )
      })}
      <li className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-3/70" />In review</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-2/70" />Locked</span>
        <span className="flex items-center gap-1.5"><span className="size-2.5 rounded-sm bg-chart-1/70" />Available</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-0.5 bg-foreground" />Now</span>
      </li>
    </ol>
  )
}

// ---- pool health ----

const HEALTH_TONE: Record<HealthState, string> = { healthy: "bg-emerald-500", at_risk: "bg-amber-500", paused: "bg-destructive", unknown: "bg-muted-foreground/40" }

function PoolHealthList({ pools, held }: { pools: NonNullable<LiquidityData["provider"]>["pools"]; held: Set<string> }) {
  const mine = pools.filter((p) => held.has(p.id))
  if (!mine.length)
    return (
      <p className="py-3 text-sm text-muted-foreground" data-empty="nothing">
        No pools held yet
      </p>
    )
  return (
    <ul className="flex flex-col divide-y" data-pool-health>
      {mine.map((p) => {
        const state = healthState(p)
        return (
          <li key={p.id} className="flex items-center gap-2 py-1.5 text-sm" data-pool={p.id} data-health={state}>
            <span aria-hidden className={cn("size-2 shrink-0 rounded-full", HEALTH_TONE[state])} />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            <span className="text-xs text-muted-foreground">{HEALTH_LABELS[state]}</span>
          </li>
        )
      })}
    </ul>
  )
}

// ---- recent financial activity ----

const when = (iso: string) => (Number.isNaN(Date.parse(iso)) ? iso : iso.slice(0, 16).replace("T", " ") + " UTC")

function FinancialActivity({ state }: { state: Loaded<AuditRow[]> }) {
  return (
    <Section id="financial-activity" title="Recent financial activity" action={<SectionLink href="/audits?tab=financial">Audits</SectionLink>}>
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
    </Section>
  )
}

export function InvestorView({
  liquidity,
  wallets = { kind: "loading" },
  activity = { kind: "loading" },
  attention = { kind: "loading" },
  granularity = "month",
  periods = 6,
  onGranularity,
  onPeriods,
  now = Date.now(),
}: {
  liquidity: Loaded<LiquidityData>
  wallets?: Loaded<EarnWallets>
  activity?: Loaded<AuditRow[]>
  attention?: Loaded<AttentionItem[]>
  granularity?: Granularity
  periods?: Range
  onGranularity?: (g: Granularity) => void
  onPeriods?: (p: Range) => void
  now?: number
}) {
  const provider = liquidity.kind === "ready" ? liquidity.data.provider : undefined
  const positionsState: Loaded<NonNullable<LiquidityData["provider"]>> =
    liquidity.kind !== "ready" ? liquidity : provider ? { kind: "ready", data: provider } : { kind: "unsupported" }
  const flows = provider ? flowSeries(provider.positions, granularity, periods, now) : null
  const investing: Loaded<AttentionItem[]> = attention.kind === "ready" ? { kind: "ready", data: attention.data.filter(investingItem) } : attention

  return (
    <div className="flex flex-col gap-4 lg:gap-5" data-investor-view>
      <NeedsAttention state={investing} />

      <Panel id="portfolio">
        <section className="flex min-w-0 flex-col gap-2" data-section="portfolio" aria-label="Your portfolio">
          {positionsState.kind === "ready" ? <PortfolioKpis positions={positionsState.data.positions} flows={flows?.series ?? null} /> : <NotReady state={positionsState} what="Your positions" />}
        </section>
      </Panel>

      <Panel id="top" cols="@4xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <PnlChart
          state={flows ? { kind: "ready", data: { series: flows.series } } : (positionsState as Exclude<typeof positionsState, { kind: "ready" }>)}
          granularity={granularity}
          periods={periods}
          onGranularity={onGranularity}
          onPeriods={onPeriods}
          variant="area"
          title="Capital in and paid out"
          labels={{ revenue: "Capital in", costs: "Paid out", netIncome: "Net" }}
          empty="Not measured yet: Mynt has no dated deposits or payouts for these periods."
          note={flows?.railsUnmeasured && provider?.positions.some((p) => p.onChain) ? "Devnet deposits and payouts only: rails positions carry no dated history yet. Paid out counts in the period it became payable." : flows && provider?.positions.some((p) => p.onChain) ? "Paid out counts in the period it became payable." : undefined}
        />
        <Section id="allocation" title="Allocation">
          {positionsState.kind === "ready" ? (
            <Donut title="Settled by pool" slices={allocation(positionsState.data.positions)} empty="Nothing settled in a pool yet" />
          ) : (
            <NotReady state={positionsState} what="Allocation" />
          )}
        </Section>
      </Panel>

      <Panel id="unlocks-and-health" cols="@4xl/main:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section id="unlocks" title="Unlock timeline">
          {positionsState.kind === "ready" ? <UnlockTimeline positions={positionsState.data.positions} now={now} /> : <NotReady state={positionsState} what="Unlocks" />}
        </Section>
        <Section id="pool-health" title="Pool health">
          {positionsState.kind === "ready" ? <PoolHealthList pools={positionsState.data.pools} held={new Set(positionsState.data.positions.map((p) => p.poolId))} /> : <NotReady state={positionsState} what="Pool health" />}
        </Section>
      </Panel>

      <Panel id="positions">
      <Section id="positions" title="Positions" action={<SectionLink href={EARN_POSITIONS}>Earn</SectionLink>}>
        {positionsState.kind !== "ready" ? (
          <NotReady state={positionsState} what="Your positions" />
        ) : positionsState.data.positions.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground" data-empty="nothing">
            No positions yet. <Link href="/earn" className="font-medium hover:underline">Find a pool on Earn</Link>
          </p>
        ) : (
          <Table data-positions>
            <TableHeader>
              <TableRow>
                <TableHead>Pool</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Remaining</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pool health</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Open</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {depositRows(positionsState.data.positions, positionsState.data.pools, now).map((r) => (
                <TableRow key={r.key} data-deposit={r.key} data-status={r.status}>
                  <TableCell className="max-w-48 truncate font-medium">{r.poolName}</TableCell>
                  <TableCell>
                    <SourceBadge source={r.source} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.amountCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(r.remainingCents)}</TableCell>
                  <TableCell className="text-xs">{statusText(r)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{healthText(r.health)}</TableCell>
                  <TableCell className="text-right">
                    <Link href={EARN_POSITIONS} className="text-sm font-medium hover:underline">
                      Open in Earn
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      </Panel>

      <Panel id="coming-and-wallets" cols="@4xl/main:grid-cols-2">
        <Section id="coming-up" title="Coming up">
          {positionsState.kind !== "ready" ? (
            <NotReady state={positionsState} what="Coming up" />
          ) : (
            (() => {
              const items = comingUp(positionsState.data.positions, positionsState.data.withdrawals, now)
              return items.length === 0 ? (
                <p className="py-3 text-sm text-muted-foreground" data-empty="nothing">
                  Nothing unlocks or becomes payable in the next {COMING_UP_DAYS} days
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>What</TableHead>
                      <TableHead>Pool</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((c) => (
                      <TableRow key={c.key} data-coming-up={c.kind}>
                        <TableCell className="whitespace-nowrap text-xs tabular-nums">{c.at.slice(0, 10)}</TableCell>
                        <TableCell className="text-xs">{COMING_UP_LABELS[c.kind]}</TableCell>
                        <TableCell className="max-w-40 truncate">
                          {c.poolName} <SourceBadge source={c.source} />
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{money(c.amountCents)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            })()
          )}
        </Section>

        <Section id="wallets" title="Wallets">
          {wallets.kind !== "ready" ? (
            <NotReady state={wallets} what="Wallets" />
          ) : !wallets.data.supported ? (
            <NotReady state={{ kind: "unsupported" }} what="Linked wallets" />
          ) : wallets.data.wallets.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground" data-empty="nothing">
              No wallets linked yet{wallets.data.manageUrl ? <> · <a href={wallets.data.manageUrl} rel="noreferrer" className="font-medium hover:underline">Link a wallet</a></> : null}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Wallet</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead className="text-right">Balance (devnet)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {wallets.data.wallets.map((w) => (
                  <TableRow key={w.address} data-wallet={w.address}>
                    <TableCell className="font-mono text-xs" title={w.address}>
                      {shortAddress(w.address)}
                    </TableCell>
                    <TableCell className="text-xs">{w.network}</TableCell>
                    <TableCell className={cn("text-right text-xs tabular-nums", !w.balances && "text-muted-foreground")}>
                      {wallets.data.balancesSupported ? balancesText(w.balances) : BALANCES_UNAVAILABLE}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Section>
      </Panel>

      <Panel id="financial-activity">
        <FinancialActivity state={activity} />
      </Panel>
    </div>
  )
}
