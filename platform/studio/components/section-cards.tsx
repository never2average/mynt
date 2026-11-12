// From shadcn/ui's dashboard-01 block (section-cards.tsx, MIT): the KPI cards, fed by the
// dashboard instead of sample figures. A figure Mynt doesn't measure says so; it's never 0.
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardAction,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { count, NOT_TRACKED, percent, usd, type Dashboard } from "@/lib/dashboard"

type Kpi = {
  label: string
  value: string
  measured: boolean
  badge?: string
  note: string
}

export function kpis(d: Dashboard): Kpi[] {
  const period = d.periodDays ? `Last ${d.periodDays} days` : "Once Mynt reports it"
  return [
    {
      label: "Money moved through your apps",
      value: usd(d.moneyMoved),
      measured: d.moneyMoved !== null,
      badge: d.moneyMoved !== null ? (d.live ? "Live" : "Sandbox") : undefined,
      note: d.moneyMoved !== null ? `Settled · ${period}` : "Settled payments, live apps only",
    },
    {
      label: "Customers",
      value: count(d.customers),
      measured: d.customers !== null,
      note: "Active enrollments across your apps",
    },
    {
      label: "Hand-offs and conversion",
      value: d.handoffs === null ? count(null) : `${count(d.handoffs)} · ${percent(d.conversion)}`,
      measured: d.handoffs !== null,
      note:
        d.handoffs !== null && d.converted !== null
          ? `${count(d.converted)} converted · ${period}`
          : "Hand-offs to providers, and how many converted",
    },
    {
      label: "Build spend this month",
      value: usd(d.buildSpend),
      measured: d.buildSpend !== null,
      note: d.buildCap !== null ? `Of ${usd(d.buildCap)} monthly budget` : "Coding-agent builds",
    },
    {
      label: "Earnings",
      value: d.earnings === null ? NOT_TRACKED : usd(d.earnings),
      measured: d.earnings !== null,
      note: d.earnings === null ? "Mynt doesn't track your earnings yet" : period,
    },
  ]
}

export function SectionCards({ dashboard }: { dashboard: Dashboard }) {
  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-gradient-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-5 dark:*:data-[slot=card]:bg-card">
      {kpis(dashboard).map((k) => (
        <Card key={k.label} className="@container/card" data-measured={k.measured}>
          <CardHeader>
            <CardDescription>{k.label}</CardDescription>
            <CardTitle
              className={
                k.measured
                  ? "text-2xl font-semibold tabular-nums @[250px]/card:text-3xl"
                  : "text-lg font-medium text-muted-foreground"
              }
            >
              {k.value}
            </CardTitle>
            {k.badge && (
              <CardAction>
                <Badge variant="outline">{k.badge}</Badge>
              </CardAction>
            )}
          </CardHeader>
          <CardFooter className="flex-col items-start gap-1.5 text-sm">
            <div className="text-muted-foreground">{k.note}</div>
          </CardFooter>
        </Card>
      ))}
    </div>
  )
}
