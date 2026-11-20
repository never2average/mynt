"use client"

// The dashboard's small charts, on shadcn's chart (recharts), in the theme's chart colours (mint
// first, then blue, amber, grey, pink: app/globals.css, light and dark): a KPI row with
// sparklines, a donut with its legend and values, horizontal bars, and the pipeline funnel. No
// boxed cards: borderless, with subtle dividers. Each chart has a screen-reader summary of its
// figures, and anything unmeasured is a gap or "Not measured", never 0.
import { ArrowDown, ArrowRight, ArrowUp } from "lucide-react"
import Link from "next/link"
import { Bar, BarChart, Cell, Line, LineChart, Pie, PieChart, XAxis, YAxis } from "recharts"

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart"
import { seriesSummary, type FunnelStep, type Kpi, type Slice } from "@/lib/dashboard-visual"
import { money, moneyShort, NOT_MEASURED } from "@/lib/pnl"
import { cn } from "@/lib/utils"
import { STAGE_LABELS } from "@/lib/workspaces"

export const SERIES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]
const colourOf = (i: number) => SERIES[i % SERIES.length]

/** Visually hidden text for screen readers. */
export function SrOnly({ children }: { children: React.ReactNode }) {
  return <span className="sr-only">{children}</span>
}

// ---- sparkline ----

export function Sparkline({ points, label }: { points: (number | null)[] | null; label: string }) {
  if (!points || !points.some((p) => p !== null))
    return (
      <span className="block h-8 w-24 border-b border-dashed border-muted-foreground/30" data-sparkline="none" aria-hidden>
        <SrOnly>{label}: no history</SrOnly>
      </span>
    )
  const data = points.map((v, i) => ({ i, v }))
  return (
    <span className="block" data-sparkline={points.length} data-gaps={points.some((p) => p === null) || undefined}>
      <ChartContainer config={{ v: { label, color: "var(--chart-1)" } }} className="aspect-auto h-8 w-24">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line dataKey="v" type="monotone" stroke="var(--color-v)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ChartContainer>
      <SrOnly>{seriesSummary(`${label} by period`, points.map((v, i) => ({ label: `#${i + 1}`, value: v })), money)}</SrOnly>
    </span>
  )
}

// ---- KPI row ----

export function KpiRow({ kpis, grid = false }: { kpis: Kpi[]; grid?: boolean }) {
  return (
    <dl
      className={
        grid
          ? // Four columns, two rows: a line between columns and between the rows.
            "grid grid-cols-2 gap-y-4 @3xl/main:grid-cols-4 @3xl/main:gap-y-0 @3xl/main:[&>*:nth-child(4n+1)]:border-l-0 @3xl/main:[&>*:nth-child(n+5)]:border-t @3xl/main:[&>*]:border-l @3xl/main:[&>*]:py-3"
          : "grid grid-cols-2 gap-x-6 gap-y-4 @3xl/main:grid-cols-4 @3xl/main:divide-x"
      }
      data-kpis
      data-kpi-grid={grid ? "4x2" : undefined}
    >
      {kpis.map((k) => {
        const measured = k.value !== null
        const Arrow = k.delta?.direction === "up" ? ArrowUp : k.delta?.direction === "down" ? ArrowDown : ArrowRight
        return (
          <div key={k.key} className={cn("flex min-w-0 flex-col gap-1 @3xl/main:px-4", grid ? "@3xl/main:[&:nth-child(4n+1)]:pl-0" : "@3xl/main:first:pl-0")} data-kpi={k.key}>
            <dt className="text-xs text-muted-foreground">{k.label}</dt>
            <dd className={cn("font-semibold tabular-nums", measured ? "text-2xl" : "text-base text-muted-foreground")} data-measured={measured}>
              {k.unit === "money" ? money(k.value) : k.value === null ? NOT_MEASURED : k.value.toLocaleString("en-US")}
            </dd>
            <dd className="flex items-center justify-between gap-2">
              {k.delta ? (
                <span
                  className={cn("inline-flex items-center gap-1 text-xs", k.delta.good === true && "text-emerald-600 dark:text-emerald-400", k.delta.good === false && "text-destructive", k.delta.good === null && "text-muted-foreground")}
                  data-delta={k.delta.direction}
                >
                  <Arrow className="size-3" aria-hidden />
                  {k.delta.text}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">{k.note ?? "No comparison yet"}</span>
              )}
              {k.unit === "money" && <Sparkline points={k.spark} label={k.label} />}
            </dd>
          </div>
        )
      })}
    </dl>
  )
}

// ---- donut ----

export function Donut({ title, slices, unmeasured = [], empty, format = money }: { title: string; slices: Slice[]; unmeasured?: string[]; empty: string; format?: (v: number | null) => string }) {
  const total = slices.reduce((n, s) => n + s.value, 0)
  const config = Object.fromEntries(slices.map((s, i) => [s.key, { label: s.label, color: colourOf(i) }])) satisfies ChartConfig
  return (
    <figure className="flex min-w-0 flex-col gap-3" data-donut={title} aria-label={title}>
      {slices.length === 0 ? (
        <p className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground" data-empty="unmeasured">
          {empty}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <ChartContainer config={config} className="aspect-square h-36 shrink-0">
            <PieChart>
              <ChartTooltip content={<ChartTooltipContent hideLabel formatter={(v, n) => `${config[n as string]?.label ?? n}: ${format(Number(v))}`} />} />
              <Pie data={slices} dataKey="value" nameKey="key" innerRadius="60%" outerRadius="100%" strokeWidth={2} stroke="var(--background)" isAnimationActive={false}>
                {slices.map((s, i) => (
                  <Cell key={s.key} fill={colourOf(i)} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm" data-legend>
            {slices.map((s, i) => (
              <li key={s.key} className="flex items-center gap-2" data-slice={s.key}>
                <span aria-hidden className="size-2.5 shrink-0 rounded-sm" style={{ background: colourOf(i) }} />
                <span className="min-w-0 flex-1 truncate">{s.label}</span>
                <span className="tabular-nums">{format(s.value)}</span>
                <span className="w-10 text-right text-xs text-muted-foreground tabular-nums">{Math.round((s.value / total) * 100)}%</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {unmeasured.length > 0 && (
        <figcaption className="text-xs text-muted-foreground" data-unmeasured-note>
          {unmeasured.map((u) => `${u}: not measured`).join(" · ")}
        </figcaption>
      )}
      <SrOnly>{seriesSummary(title, slices.map((s) => ({ label: s.label, value: s.value })), format)}</SrOnly>
    </figure>
  )
}

// ---- horizontal bars ----

export function HBars({ title, rows, empty }: { title: string; rows: Slice[]; empty: string }) {
  if (!rows.length)
    return (
      <p className="flex h-40 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground" data-empty="unmeasured">
        {empty}
      </p>
    )
  return (
    <figure className="flex min-w-0 flex-col gap-2" data-hbars={title} aria-label={title}>
      <ChartContainer config={{ value: { label: title, color: "var(--chart-1)" } }} className="aspect-auto w-full" style={{ height: Math.max(80, rows.length * 32) }}>
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 8 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="label" width={120} tickLine={false} axisLine={false} tick={{ fontSize: 12 }} />
          <ChartTooltip content={<ChartTooltipContent hideLabel formatter={(v) => money(Number(v))} />} />
          <Bar dataKey="value" fill="var(--color-value)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
        </BarChart>
      </ChartContainer>
      <ul className="sr-only">
        {rows.map((r) => (
          <li key={r.key} data-bar={r.key}>
            {r.label}: {money(r.value)}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground tabular-nums" aria-hidden>
        Top: {rows[0].label} {moneyShort(rows[0].value)}
      </p>
    </figure>
  )
}

// ---- pipeline funnel ----

export function PipelineFunnel({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(1, ...steps.map((s) => s.count))
  return (
    <ol className="grid grid-cols-1 gap-4 @2xl/main:grid-cols-3" data-funnel aria-label="Apps by stage, from idea to production">
      {steps.map((s, i) => (
        <li key={s.stage} className="flex min-w-0 flex-col gap-2" data-step={s.stage}>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium">{STAGE_LABELS[s.stage]}</span>
            <span className="text-2xl font-semibold tabular-nums" data-stage-count={s.stage}>
              {s.count}
            </span>
            {i < steps.length - 1 && <ArrowRight className="ml-auto hidden size-4 text-muted-foreground @2xl/main:block" aria-hidden />}
          </div>
          {/* The funnel: each stage's bar is as wide as its share of the largest stage. */}
          <div className="h-2 w-full rounded-full bg-muted" aria-hidden>
            <div className="h-2 rounded-full" style={{ width: `${(s.count / max) * 100}%`, background: colourOf(i) }} />
          </div>
          {s.apps.length === 0 ? (
            <span className="text-xs text-muted-foreground">No apps</span>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {s.apps.slice(0, 6).map((a) => (
                <li key={a.id} data-chip={a.id}>
                  <Link href={`/${encodeURIComponent(a.id)}`} className="flex flex-col gap-1 rounded-md bg-muted/60 px-2 py-1 text-xs hover:bg-muted">
                    <span className="max-w-32 truncate font-medium">{a.name}</span>
                    {a.total ? (
                      <span className="flex items-center gap-1.5" title={`${a.passing} of ${a.total} checks passing`}>
                        <span className="h-1 w-12 rounded-full bg-background">
                          <span className="block h-1 rounded-full bg-foreground/70" style={{ width: `${((a.passing ?? 0) / a.total) * 100}%` }} />
                        </span>
                        <span className="tabular-nums text-muted-foreground" data-checks>
                          {a.passing}/{a.total}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{s.stage === "production" ? "Live" : "Not checked"}</span>
                    )}
                  </Link>
                </li>
              ))}
              {s.apps.length > 6 && <li className="self-center text-xs text-muted-foreground">+{s.apps.length - 6} more</li>}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}
