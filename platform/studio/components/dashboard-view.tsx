// The dashboard (home page): shadcn/ui's dashboard-01 layout (KPI cards, an area chart and a
// table), fed by lib/dashboard.ts. Server-renderable, so the tests render it without a browser.
import Link from "next/link"
import { Plus } from "lucide-react"

import { ChartAreaInteractive } from "@/components/chart-area-interactive"
import { SectionCards } from "@/components/section-cards"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { count, percent, usd, type Dashboard, type DashboardApp } from "@/lib/dashboard"

const when = (at: string | null) =>
  at ? new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : ""

function AppsTable({ apps }: { apps: DashboardApp[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your apps</CardTitle>
        <CardDescription>What each app moved, who it serves, and its latest build</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Money moved</TableHead>
              <TableHead className="text-right">Customers</TableHead>
              <TableHead className="text-right">Conversion</TableHead>
              <TableHead>Last build</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {apps.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">
                  <Link className="hover:underline" href={`/${encodeURIComponent(a.id)}`}>
                    {a.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{a.status}</Badge>
                </TableCell>
                <TableCell className="text-right tabular-nums">{usd(a.moneyMoved, "—")}</TableCell>
                <TableCell className="text-right tabular-nums">{count(a.customers, "—")}</TableCell>
                <TableCell className="text-right tabular-nums">{percent(a.conversion, "—")}</TableCell>
                <TableCell className="text-muted-foreground">
                  {a.lastBuild ? (
                    <Link className="hover:underline" href={`/${encodeURIComponent(a.id)}/${encodeURIComponent(a.lastBuild.id)}`}>
                      {a.lastBuild.status}
                      {a.lastBuild.at ? ` · ${when(a.lastBuild.at)}` : ""}
                    </Link>
                  ) : (
                    "None yet"
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {apps.some((a) => a.moneyMoved === null || a.customers === null) && (
          <p className="mt-3 text-xs text-muted-foreground">— Not measured yet.</p>
        )}
      </CardContent>
    </Card>
  )
}

function EmptyState() {
  return (
    <Card className="mx-4 lg:mx-6">
      <CardHeader>
        <CardTitle>No apps yet</CardTitle>
        <CardDescription>
          Describe an app and pick the products it builds on. Mynt&apos;s coding agent builds it, and this page shows
          how it does.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild>
          <Link href="/new">
            <Plus />
            New app
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}

export function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  return (
    <div className="@container/main flex flex-1 flex-col gap-4 py-4 md:gap-6 md:py-6">
      <SectionCards dashboard={dashboard} />
      {dashboard.apps.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="px-4 lg:px-6">
            <ChartAreaInteractive daily={dashboard.daily} periodDays={dashboard.periodDays} />
          </div>
          <div className="px-4 lg:px-6">
            <AppsTable apps={dashboard.apps} />
          </div>
        </>
      )}
    </div>
  )
}
