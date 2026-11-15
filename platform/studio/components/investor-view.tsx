"use client"

// The dashboard's investor view, for liquidity providers, in the builder view's statement style
// (sections with headings and tables, no cards): the portfolio strip (committed, settled, queued
// for withdrawal, paid out, returns), capital in against paid out per period (the P&L chart), each
// deposit with its pool, source (Devnet or Rails), status and pool health, what comes up in the
// next 30 days, the user's wallets with their balances, recent financial activity and what needs
// attention about investing. Anything Mynt doesn't measure reads "Not measured", never 0; any part
// whose tool this Mynt lacks says so. Model: lib/investor.ts. Server-renderable for the tests.
import Link from "next/link"

import { NeedsAttention, Section, SectionLink } from "@/components/dashboard-panels"
import { PnlChart } from "@/components/pnl"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { AttentionItem } from "@/lib/attention"
import type { AuditRow } from "@/lib/audit-classes"
import {
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

function PortfolioStrip({ positions }: { positions: NonNullable<LiquidityData["provider"]>["positions"] }) {
  const p = portfolioOf(positions)
  const sources = (Object.keys(p.bySource) as Source[]).sort()
  const split = sources.length > 1
  return (
    <dl className="grid grid-cols-2 divide-x divide-y rounded-md border sm:grid-cols-5 sm:divide-y-0" data-portfolio>
      {STATS.map(([k, label]) => (
        <div key={k} className="flex min-w-0 flex-col gap-0.5 px-3 py-2" data-stat={k}>
          <dt className="truncate text-xs text-muted-foreground">{label}</dt>
          <dd className={cn("truncate font-semibold tabular-nums", p.all[k] === null ? "text-sm text-muted-foreground" : "text-xl")}>{money(p.all[k])}</dd>
          {split && (
            <dd className="truncate text-xs text-muted-foreground" data-split>
              {sources.map((s) => `${SOURCE_LABELS[s]} ${money(p.bySource[s]![k])}`).join(" · ")}
            </dd>
          )}
        </div>
      ))}
      <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2" data-stat="returns">
        <dt className="truncate text-xs text-muted-foreground">Returns</dt>
        <dd className="truncate text-sm font-semibold text-muted-foreground">{NOT_MEASURED}</dd>
        <dd className="truncate text-xs text-muted-foreground">Mynt doesn&apos;t measure yield</dd>
      </div>
    </dl>
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
    <div className="flex flex-col gap-6" data-investor-view>
      <NeedsAttention state={investing} />

      <div className="grid grid-cols-1 gap-6 @4xl/main:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" data-row="top">
        <section className="flex min-w-0 flex-col gap-3" data-section="portfolio" aria-labelledby="section-portfolio">
          <div className="border-b pb-2">
            <h2 id="section-portfolio" className="text-sm font-semibold">
              Your portfolio
            </h2>
          </div>
          {positionsState.kind === "ready" ? <PortfolioStrip positions={positionsState.data.positions} /> : <NotReady state={positionsState} what="Your positions" />}
        </section>
        <PnlChart
          state={flows ? { kind: "ready", data: { series: flows.series } } : (positionsState as Exclude<typeof positionsState, { kind: "ready" }>)}
          granularity={granularity}
          periods={periods}
          onGranularity={onGranularity}
          onPeriods={onPeriods}
          title="Capital in and paid out"
          labels={{ revenue: "Capital in", costs: "Paid out", netIncome: "Net" }}
          empty="Not measured yet: Mynt has no dated deposits or payouts for these periods."
          note={flows?.railsUnmeasured && provider?.positions.some((p) => p.onChain) ? "Devnet deposits and payouts only: rails positions carry no dated history yet. Paid out counts in the period it became payable." : flows && provider?.positions.some((p) => p.onChain) ? "Paid out counts in the period it became payable." : undefined}
        />
      </div>

      <Section id="positions" title="Positions" description="Each deposit, with its pool's health" action={<SectionLink href={EARN_POSITIONS}>Earn</SectionLink>}>
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

      <div className="grid grid-cols-1 gap-6 @5xl/main:grid-cols-2" data-row="coming-and-wallets">
        <Section id="coming-up" title="Coming up" description={`Unlocks and payable withdrawals in the next ${COMING_UP_DAYS} days`}>
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

        <Section id="wallets" title="Wallets" description="Your linked wallets, read-only here">
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
      </div>

      <FinancialActivity state={activity} />
    </div>
  )
}
