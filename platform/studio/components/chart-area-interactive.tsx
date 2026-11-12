"use client"

// From shadcn/ui's dashboard-01 block (chart-area-interactive.tsx, MIT): one series, money moved
// per day, over the dashboard's period. Its time-range picker is gone (Mynt reports the
// period), and when Mynt doesn't measure money moved the card says so instead of drawing zeros.
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts"

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { usd } from "@/lib/dashboard"

const chartConfig = {
  value: {
    label: "Money moved",
    color: "var(--chart-1)",
  },
} satisfies ChartConfig

const day = (value: string) =>
  new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

export function ChartAreaInteractive({
  daily,
  periodDays,
}: {
  daily: { date: string; value: number }[] | null
  periodDays: number | null
}) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Money moved per day</CardTitle>
        <CardDescription>
          {daily ? `Settled through your apps, last ${periodDays ?? daily.length} days` : "Not measured yet"}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        {daily ? (
          <ChartContainer config={chartConfig} className="aspect-auto h-[250px] w-full">
            <AreaChart data={daily}>
              <defs>
                <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-value)" stopOpacity={0.6} />
                  <stop offset="95%" stopColor="var(--color-value)" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={day} />
              <YAxis tickLine={false} axisLine={false} width={64} tickFormatter={(v: number) => usd(v)} />
              <ChartTooltip
                cursor={false}
                content={<ChartTooltipContent labelFormatter={(v) => day(String(v))} formatter={(v) => usd(Number(v))} indicator="dot" />}
              />
              <Area dataKey="value" type="monotone" fill="url(#fillValue)" stroke="var(--color-value)" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="flex h-[250px] items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">
            Mynt doesn&apos;t report money moved per day yet.
          </div>
        )}
      </CardContent>
    </Card>
  )
}
