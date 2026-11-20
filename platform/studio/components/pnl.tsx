"use client"

// The dashboard's P&L (get_workspace_pnl): the stat strip (revenue, costs and net this period,
// with the change from last period), the chart (revenue and costs as bars, net as a line, per
// month or week over the last 3, 6 or 12), and the statement (each revenue and cost line, then
// the totals, for this period, last period and year to date). A figure Mynt doesn't measure
// reads "Not measured" and is a gap in the chart, never $0. Until Mynt has the tool, each part
// says the P&L isn't available yet and the rest of the dashboard carries on.
import { Area, Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts"

import { Skeleton } from "@/components/ui/skeleton"
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { chartRows, changeText, hasGaps, anyMeasured, money, moneyShort, NOT_MEASURED, RANGES, type Granularity, type Pnl, type PnlLine, type Range, type Values } from "@/lib/pnl"
import type { Loaded } from "@/lib/use-compliance"
import { cn } from "@/lib/utils"

// Until Mynt measures earnings, the top line is money moved: gross settled live movements through
// the apps, not what the developer earns. It's named that way everywhere it shows.
export const REVENUE_LABEL = "Money moved through your apps"

export const PNL_NOT_AVAILABLE = "P&L isn't available yet. It comes with Mynt's next update."

const chartConfig = {
  revenue: { label: "Money moved", color: "var(--chart-1)" },
  costs: { label: "Costs", color: "var(--chart-2)" },
  netIncome: { label: "Net", color: "var(--foreground)" },
} satisfies ChartConfig

/** Loading, not offered, not for this workspace, or an error: what a P&L part says instead. */
function PnlNotReady({ state, height }: { state: Exclude<Loaded<Pnl>, { kind: "ready" }>; height: string }) {
  if (state.kind === "loading") return <Skeleton className={cn("w-full", height)} />
  return (
    <div
      className={cn("flex items-center justify-center rounded-md border border-dashed px-4 text-center text-sm", height, state.kind === "error" ? "text-destructive" : "text-muted-foreground")}
      role={state.kind === "error" ? "alert" : undefined}
      data-pnl-empty={state.kind}
    >
      {state.kind === "error" ? state.message : state.kind === "unavailable" ? state.message : PNL_NOT_AVAILABLE}
    </div>
  )
}

const negative = (c: number | null) => c !== null && c < 0

function Amount({ value, className, net = false }: { value: number | null; className?: string; net?: boolean }) {
  return (
    <span className={cn("tabular-nums", value === null && "text-muted-foreground", net && negative(value) && "text-destructive", className)} data-measured={value !== null} data-negative={negative(value) || undefined}>
      {money(value)}
    </span>
  )
}

// ---- stat strip ----

export function PnlStats({ state }: { state: Loaded<Pnl> }) {
  if (state.kind !== "ready") return <PnlNotReady state={state} height="h-24" />
  const t = state.data.totals
  const label = state.data.columns.find((c) => c.key === "this_period")?.label ?? "This period"
  const rows: [string, string, Values, boolean][] = [
    ["revenue", REVENUE_LABEL, t.revenue, false],
    ["costs", "Costs", t.costs, false],
    ["net", "Net", t.netIncome, true],
  ]
  return (
    <dl className="grid grid-cols-3 divide-x rounded-md border" data-pnl-stats>
      {rows.map(([id, name, v, net]) => (
        <div key={id} className="flex min-w-0 flex-col gap-0.5 px-3 py-2" data-stat={id}>
          <dt className="truncate text-xs text-muted-foreground">
            {name} · {label}
          </dt>
          <dd className={cn("truncate font-semibold", v.this_period === null ? "text-sm" : "text-xl")}>
            <Amount value={v.this_period} net={net} />
          </dd>
          <dd className="truncate text-xs text-muted-foreground" data-change>
            {changeText(v)}
          </dd>
        </div>
      ))}
    </dl>
  )
}

// ---- chart ----

function Segmented<T extends string | number>({ label, options, value, onChange, text }: { label: string; options: readonly T[]; value: T; onChange?: (v: T) => void; text: (v: T) => string }) {
  return (
    <div className="flex items-center rounded-md border p-0.5" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange?.(o)}
          className={cn("rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground", o === value && "bg-muted font-medium text-foreground")}
          data-option={String(o)}
        >
          {text(o)}
        </button>
      ))}
    </div>
  )
}

export type ChartLabels = { revenue: string; costs: string; netIncome: string }

/**
 * The P&L chart: two bars and a line per period. The dashboard's investor view uses it too, with
 * its own title and labels (capital in, paid out, net), `note` under it and `empty` when nothing
 * was measured. `series` alone is read from `state`.
 */
export function PnlChart({
  state,
  granularity,
  periods,
  onGranularity,
  onPeriods,
  title = "Profit and loss",
  labels,
  note,
  empty = "Not measured yet: Mynt hasn't recorded revenue or costs for these periods.",
  variant = "bars",
  only,
  controls = true,
  id = "pnl-chart",
}: {
  state: Loaded<Pick<Pnl, "series">>
  granularity: Granularity
  periods: Range
  onGranularity?: (g: Granularity) => void
  onPeriods?: (p: Range) => void
  title?: string
  labels?: ChartLabels
  note?: string
  empty?: string
  /** "area": the dashboard's large chart (filled areas, net as a line); "bars": the compact one. */
  variant?: "bars" | "area"
  /** One series alone (no net line): the builder dashboard's Money moved and Costs charts. */
  only?: "revenue" | "costs"
  /** The chart's own period and range controls (off where a filter bar above sets them). */
  controls?: boolean
  /** The section's id, so two charts can share a page. */
  id?: string
}) {
  const height = variant === "area" ? "h-[300px]" : "h-[220px]"
  const config = labels
    ? ({
        revenue: { label: labels.revenue, color: chartConfig.revenue.color },
        costs: { label: labels.costs, color: chartConfig.costs.color },
        netIncome: { label: labels.netIncome, color: chartConfig.netIncome.color },
      } satisfies ChartConfig)
    : chartConfig
  const unit = granularity === "month" ? "mo" : "wk"
  const series = state.kind === "ready" ? state.data.series : []
  const rows = chartRows(series, granularity)
  const gaps = rows.filter((r) => (only ? r[only] === null : r.revenue === null || r.costs === null || r.netIncome === null))
  const measured = only ? series.some((p) => p[only] !== null) : anyMeasured(series)
  return (
    <section className="flex min-w-0 flex-col gap-2" data-section={id} aria-labelledby={`section-${id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`section-${id}`} className="text-sm font-semibold">
          {title}
        </h2>
        {controls && (
          <div className="ml-auto flex items-center gap-2">
            <Segmented label="Period" options={["month", "week"] as const} value={granularity} onChange={onGranularity} text={(g) => (g === "month" ? "Month" : "Week")} />
            <Segmented label="Range" options={RANGES} value={periods} onChange={onPeriods} text={(n) => `${n} ${unit}`} />
          </div>
        )}
      </div>
      {state.kind !== "ready" ? (
        <PnlNotReady state={state} height={height} />
      ) : !measured ? (
        <div className={cn("flex items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground", height)} data-pnl-empty="unmeasured">
          {empty}
        </div>
      ) : (
        <>
          <ChartContainer config={config} className={cn("aspect-auto w-full", height)} data-pnl-chart data-variant={variant}>
            <ComposedChart data={rows} margin={{ left: 4, right: 4, top: 8 }} barGap={2}>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="period" tickLine={false} axisLine={false} tickMargin={8} minTickGap={16} />
              <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v: number) => moneyShort(v)} />
              <ReferenceLine y={0} stroke="var(--border)" />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    indicator="dot"
                    formatter={(value, name) => (
                      <div className="flex w-full justify-between gap-4">
                        <span className="text-muted-foreground">{config[name as keyof typeof config]?.label ?? String(name)}</span>
                        <span className="font-mono tabular-nums">{money(typeof value === "number" ? value : null)}</span>
                      </div>
                    )}
                  />
                }
              />
              {!only && <ChartLegend content={<ChartLegendContent />} />}
              {only ? (
                <Area dataKey={only} type="monotone" fill={`var(--color-${only})`} fillOpacity={0.25} stroke={`var(--color-${only})`} strokeWidth={2} connectNulls={false} />
              ) : variant === "area" ? (
                <>
                  <Area dataKey="revenue" type="monotone" fill="var(--color-revenue)" fillOpacity={0.25} stroke="var(--color-revenue)" strokeWidth={2} connectNulls={false} />
                  <Area dataKey="costs" type="monotone" fill="var(--color-costs)" fillOpacity={0.2} stroke="var(--color-costs)" strokeWidth={2} connectNulls={false} />
                </>
              ) : (
                <>
                  <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Bar dataKey="costs" fill="var(--color-costs)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                </>
              )}
              {/* A period Mynt didn't measure stays a gap: nulls are never joined or drawn as 0. */}
              {!only && <Line dataKey="netIncome" type="linear" stroke="var(--color-netIncome)" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />}
            </ComposedChart>
          </ChartContainer>
          {hasGaps(series) && (
            <p className="text-xs text-muted-foreground" data-pnl-gaps>
              Gaps are periods Mynt didn&apos;t measure: {gaps.map((g) => g.period).join(", ")}.
            </p>
          )}
          {note && (
            <p className="text-xs text-muted-foreground" data-chart-note>
              {note}
            </p>
          )}
        </>
      )}
    </section>
  )
}

// ---- statement ----

function LineRow({ line }: { line: PnlLine }) {
  return (
    <TableRow data-line={line.key} data-line-measured={line.measured}>
      <TableCell className="pl-6">
        <span className="font-medium">{line.label}</span>
        {line.source && <span className="ml-2 text-xs text-muted-foreground">{line.source}</span>}
      </TableCell>
      {(["this_period", "last_period", "year_to_date"] as const).map((k) => (
        <TableCell key={k} className="text-right">
          <Amount value={line.values[k]} />
        </TableCell>
      ))}
    </TableRow>
  )
}

function TotalRow({ label, values, net = false, id }: { label: string; values: Values; net?: boolean; id: string }) {
  return (
    <TableRow className="font-semibold" data-total={id}>
      <TableCell>{label}</TableCell>
      {(["this_period", "last_period", "year_to_date"] as const).map((k) => (
        <TableCell key={k} className="text-right">
          <Amount value={values[k]} net={net} />
        </TableCell>
      ))}
    </TableRow>
  )
}

function GroupRow({ label, empty }: { label: string; empty: string | null }) {
  return (
    <TableRow className="bg-muted/40 hover:bg-muted/40">
      <TableCell colSpan={4} className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {label}
        {empty && <span className="ml-2 font-normal normal-case">{empty}</span>}
      </TableCell>
    </TableRow>
  )
}

export function PnlStatement({ state }: { state: Loaded<Pnl> }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-section="pnl-statement" aria-labelledby="section-pnl-statement">
      <div className="flex items-baseline gap-3 border-b pb-2">
        <h2 id="section-pnl-statement" className="text-sm font-semibold">
          Statement
        </h2>
      </div>
      {state.kind !== "ready" ? (
        <PnlNotReady state={state} height="h-24" />
      ) : (
        <>
          <Table data-pnl-table>
            <TableHeader>
              <TableRow>
                <TableHead>Line</TableHead>
                {state.data.columns.map((c) => (
                  <TableHead key={c.key} className="text-right" title={c.start && c.end ? `${c.start} to ${c.end}` : undefined} data-column={c.key}>
                    {c.label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              <GroupRow label={REVENUE_LABEL} empty={state.data.revenue.length ? null : "No lines yet"} />
              {state.data.revenue.map((l) => (
                <LineRow key={l.key} line={l} />
              ))}
              <TotalRow id="revenue" label="Total money moved" values={state.data.totals.revenue} />
              <GroupRow label="Costs" empty={state.data.costs.length ? null : "No cost lines yet"} />
              {state.data.costs.map((l) => (
                <LineRow key={l.key} line={l} />
              ))}
              <TotalRow id="costs" label="Total costs" values={state.data.totals.costs} />
            </TableBody>
            <TableFooter>
              <TotalRow id="net" label="Net" values={state.data.totals.netIncome} net />
            </TableFooter>
          </Table>
          {state.data.unmeasured.length > 0 && (
            <div className="text-xs text-muted-foreground" data-pnl-footnote>
              <p className="font-medium">{NOT_MEASURED} yet:</p>
              <ul className="list-disc pl-5">
                {state.data.unmeasured.map((u) => (
                  <li key={u.key} data-unmeasured={u.key}>
                    <span className="text-foreground">{u.label}</span>: {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  )
}
