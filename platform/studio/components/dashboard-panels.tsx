// The dashboard's lower cards: Needs attention (get_workspace_attention), Apps by stage (each
// stage's apps with their readiness for the next one) and Recent activity (the newest audit
// entries). Each says when Mynt doesn't offer its data yet, never showing an empty card as if
// it were data. Server-renderable for the tests.
import Link from "next/link"
import { ArrowRight, FlaskConical, Lightbulb, Rocket } from "lucide-react"

import { StatusDot } from "@/components/promotion-view"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SEVERITY_LABELS, type AttentionItem, type Severity } from "@/lib/attention"
import type { AuditEvent } from "@/lib/compliance"
import { readinessText, type Readiness } from "@/lib/promotions"
import type { Loaded } from "@/lib/use-compliance"
import { STAGE_LABELS, STAGES, type Stage } from "@/lib/workspaces"

export type StageApp = { id: string; name: string; stage: Stage; readiness: Readiness | "not_checked" | null }
export type StagesData = { checks: boolean; apps: StageApp[] }

const SEVERITY_TONE: Record<Severity, "red" | "amber" | "green"> = { high: "red", medium: "amber", low: "green" }
const STAGE_ICONS = { production: Rocket, staging: FlaskConical, idea: Lightbulb } as const

function Quiet({ children, kind }: { children: React.ReactNode; kind: string }) {
  return (
    <p className="py-6 text-center text-sm text-muted-foreground" data-empty={kind}>
      {children}
    </p>
  )
}

// Loading, not offered yet, not for this workspace yet, or an error: what the card says instead.
function NotReadyText<T>({ state, what }: { state: Exclude<Loaded<T>, { kind: "ready" }>; what: string }) {
  if (state.kind === "loading") return <Skeleton className="h-24 w-full" />
  if (state.kind === "error")
    return (
      <p role="alert" className="py-6 text-center text-sm text-destructive">
        {state.message}
      </p>
    )
  return <Quiet kind="not-available">{state.kind === "unavailable" ? state.message : `${what} isn't available yet. It comes with Mynt's next update.`}</Quiet>
}

const when = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}

export function NeedsAttention({ state }: { state: Loaded<AttentionItem[]> }) {
  return (
    <Card data-card="attention">
      <CardHeader>
        <CardTitle>Needs attention</CardTitle>
        <CardDescription>What in this workspace is waiting on someone</CardDescription>
      </CardHeader>
      <CardContent>
        {state.kind !== "ready" ? (
          <NotReadyText state={state} what="Needs attention" />
        ) : state.data.length === 0 ? (
          <Quiet kind="nothing">Nothing needs you right now</Quiet>
        ) : (
          <ul className="flex flex-col divide-y">
            {state.data.map((i) => (
              <li key={i.id} className="flex items-start gap-3 py-3" data-attention={i.id} data-severity={i.severity}>
                <StatusDot tone={SEVERITY_TONE[i.severity]} label={SEVERITY_LABELS[i.severity]} />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">{i.title}</span>
                  {i.detail && <span className="text-sm text-muted-foreground">{i.detail}</span>}
                </div>
                {when(i.at) && <span className="shrink-0 text-xs text-muted-foreground">{when(i.at)}</span>}
                {i.href &&
                  (i.external ? (
                    <a href={i.href} target="_blank" rel="noopener noreferrer" className="shrink-0 text-sm font-medium hover:underline">
                      Open
                    </a>
                  ) : (
                    <Link href={i.href} className="shrink-0 text-sm font-medium hover:underline">
                      Open
                    </Link>
                  ))}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ReadinessLine({ app, checks }: { app: StageApp; checks: boolean }) {
  if (app.stage === "production") return <span className="text-xs text-muted-foreground">Live</span>
  if (!checks) return <span className="text-xs text-muted-foreground">Promotion checks aren&apos;t available yet</span>
  if (!app.readiness || app.readiness === "not_checked") return <span className="text-xs text-muted-foreground">Not checked yet: open the app to see its checks</span>
  const r = app.readiness
  const tone = r.failing ? "red" : r.canPromote ? "green" : "amber"
  return <StatusDot tone={tone} label={readinessText(r)} />
}

export function AppsByStage({ state }: { state: Loaded<StagesData> }) {
  return (
    <Card data-card="apps-by-stage">
      <CardHeader>
        <CardTitle>Apps by stage</CardTitle>
        <CardDescription>Each app moves Ideas → Staging → Production through Mynt&apos;s checks</CardDescription>
        <CardAction>
          <Link href="/workspace?tab=apps" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">
            All apps
            <ArrowRight className="size-3.5" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {state.kind !== "ready" ? (
          <NotReadyText state={state} what="Apps by stage" />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {STAGES.map((s) => {
              const apps = state.data.apps.filter((a) => a.stage === s)
              const Icon = STAGE_ICONS[s]
              return (
                <div key={s} className="flex flex-col gap-2 rounded-lg border p-3" data-stage-card={s}>
                  <div className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="font-medium">{STAGE_LABELS[s]}</span>
                    <span className="ml-auto text-2xl font-semibold tabular-nums" data-stage-count={s}>
                      {apps.length}
                    </span>
                  </div>
                  {apps.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No apps</span>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {apps.slice(0, 5).map((a) => (
                        <li key={a.id} className="flex flex-col gap-0.5">
                          <Link href={`/${encodeURIComponent(a.id)}`} className="truncate text-sm font-medium hover:underline">
                            {a.name}
                          </Link>
                          <ReadinessLine app={a} checks={state.data.checks} />
                        </li>
                      ))}
                      {apps.length > 5 && (
                        <li>
                          <Link href="/workspace?tab=apps" className="text-xs text-muted-foreground hover:underline">
                            {apps.length - 5} more
                          </Link>
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export const RECENT_ROWS = 10

export function RecentActivity({ state }: { state: Loaded<AuditEvent[]> }) {
  const rows = state.kind === "ready" ? state.data.slice(0, RECENT_ROWS) : []
  return (
    <Card data-card="recent-activity">
      <CardHeader>
        <CardTitle>Recent activity</CardTitle>
        <CardDescription>The newest entries in this workspace&apos;s audit trail</CardDescription>
        <CardAction>
          <Link href="/audits" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">
            Audits
            <ArrowRight className="size-3.5" />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {state.kind !== "ready" ? (
          <NotReadyText state={state} what="Recent activity" />
        ) : rows.length === 0 ? (
          <Quiet kind="nothing">Nothing has happened in this workspace yet</Quiet>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e, i) => (
                <TableRow key={`${e.at}-${i}`} data-activity-row>
                  <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{e.at.slice(0, 16).replace("T", " ")} UTC</TableCell>
                  <TableCell className="font-medium">{e.actor.name ?? e.actor.id ?? "Mynt"}</TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell>{[e.target.type, e.target.name ?? e.target.id].filter(Boolean).join(": ") || "Not recorded"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}
