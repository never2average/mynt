// The dashboard's sections below the P&L: the Needs attention strip (get_workspace_attention),
// Apps by stage (a compact table: each app's stage, readiness for the next one from the
// promotion checks, and last build) and Recent activity (the newest audit entries). Plain
// sections with headings and tables, no cards. Each says when Mynt doesn't offer its data yet,
// never showing an empty table as if it were data. Server-renderable for the tests.
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { Activity as ActivityIcon, ChevronRight, Coins, Hammer, KeyRound, Users } from "lucide-react"

import { PipelineFunnel } from "@/components/charts"
import { pipeline, relativeTime } from "@/lib/dashboard-visual"

import { StatusDot } from "@/components/promotion-view"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { SEVERITY_LABELS, type AttentionItem, type Severity } from "@/lib/attention"
import type { AuditEvent } from "@/lib/compliance"
import type { DashboardApp } from "@/lib/dashboard"
import { readinessText, type Readiness } from "@/lib/promotions"
import type { Loaded } from "@/lib/use-compliance"
import { STAGE_LABELS, STAGES, type Stage } from "@/lib/workspaces"

export type StageApp = { id: string; name: string; stage: Stage; readiness: Readiness | "not_checked" | null }
export type StagesData = { checks: boolean; apps: StageApp[] }

const SEVERITY_TONE: Record<Severity, "red" | "amber" | "green"> = { high: "red", medium: "amber", low: "green" }

/** A dashboard section: a heading with an optional labelled link, then its body. */
// The dashboards' layout: each row is one outlined panel; sections side by side in a row are split by a
// divider (stacked, with one between them, on narrow screens). Flat: a border, no shadow or fill.
export function Panel({ children, cols, id, className }: { children: React.ReactNode; cols?: string; id: string; className?: string }) {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-1 divide-y overflow-hidden rounded-lg border [&>*]:min-w-0 [&>*]:p-4",
        cols && "@4xl/main:divide-x @4xl/main:divide-y-0",
        cols,
        className,
      )}
      data-row={id}
      data-panel
    >
      {children}
    </div>
  )
}

export function Section({ title, description, action, children, id }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode; id: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-3" data-section={id} aria-labelledby={`section-${id}`}>
      <div className="flex items-baseline gap-3">
        <h2 id={`section-${id}`} className="text-sm font-semibold">
          {title}
        </h2>
        {description && <p className="hidden truncate text-xs text-muted-foreground sm:block">{description}</p>}
        {action && <div className="ml-auto shrink-0 text-sm">{action}</div>}
      </div>
      {children}
    </section>
  )
}

export function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium hover:underline">
      {children}
    </Link>
  )
}

function Quiet({ children, kind }: { children: React.ReactNode; kind: string }) {
  return (
    <p className="py-3 text-sm text-muted-foreground" data-empty={kind}>
      {children}
    </p>
  )
}

// Loading, not offered yet, not for this workspace yet, or an error: what the section says instead.
function NotReadyText<T>({ state, what }: { state: Exclude<Loaded<T>, { kind: "ready" }>; what: string }) {
  if (state.kind === "loading") return <Skeleton className="h-16 w-full" />
  if (state.kind === "error")
    return (
      <p role="alert" className="py-3 text-sm text-destructive">
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

/** Needs attention: a compact strip of items (severity dot, title, link); nothing at all when nothing needs you. */
export function NeedsAttention({ state }: { state: Loaded<AttentionItem[]> }) {
  if (state.kind === "loading") return <Skeleton className="h-8 w-full" data-strip="attention" />
  if (state.kind === "ready" && state.data.length === 0) return null
  return (
    <div className="flex flex-col gap-1 rounded-md border px-3 py-2" data-strip="attention">
      <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
        Needs attention
        {state.kind === "ready" && <span className="tabular-nums">· {state.data.length}</span>}
      </div>
      {state.kind !== "ready" ? (
        <NotReadyText state={state} what="Needs attention" />
      ) : (
        <ul className="flex flex-col divide-y">
          {state.data.map((i) => (
            <li key={i.id} className="flex min-w-0 items-center gap-3 py-1.5 text-sm" data-attention={i.id} data-severity={i.severity}>
              <StatusDot tone={SEVERITY_TONE[i.severity]} label={SEVERITY_LABELS[i.severity]} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{i.title}</span>
                {i.detail && <span className="text-muted-foreground"> · {i.detail}</span>}
              </span>
              {when(i.at) && <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{when(i.at)}</span>}
              {/* Only studio pages are links; any other address Mynt gives is shown, not followed. */}
              {i.href ? (
                <Link href={i.href} className="shrink-0 text-sm font-medium hover:underline">
                  Open
                </Link>
              ) : (
                i.linkText && (
                  <span className="max-w-48 shrink-0 truncate text-xs text-muted-foreground" title={i.linkText} data-plain-link>
                    {i.linkText}
                  </span>
                )
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReadinessLine({ app, checks }: { app: StageApp; checks: boolean }) {
  if (app.stage === "production") return <span className="text-xs text-muted-foreground">Live</span>
  if (!checks) return <span className="text-xs text-muted-foreground">Promotion checks aren&apos;t available yet</span>
  if (!app.readiness || app.readiness === "not_checked") return <span className="text-xs text-muted-foreground">Not checked yet</span>
  const r = app.readiness
  const tone = r.failing ? "red" : r.canPromote ? "green" : "amber"
  return <StatusDot tone={tone} label={readinessText(r)} />
}

const STAGE_ORDER: Record<Stage, number> = Object.fromEntries(STAGES.map((s, i) => [s, i])) as Record<Stage, number>

/** Apps by stage: a compact table, Production first; each app's last build comes from the dashboard. */
/** Apps by stage: Ideas → Staging → Production as a funnel, each app a chip with its checks passing. */
export function AppsByStage({ state }: { state: Loaded<StagesData>; apps?: DashboardApp[] }) {
  return (
    <Section
      id="apps-by-stage"
      title="Apps by stage"
      action={<SectionLink href="/settings?tab=apps">All apps</SectionLink>}
    >
      {state.kind !== "ready" ? (
        <NotReadyText state={state} what="Apps by stage" />
      ) : (
        <>
          <PipelineFunnel steps={pipeline(state.data.apps)} />
          {!state.data.checks && <p className="text-xs text-muted-foreground">Promotion checks aren&apos;t available yet</p>}
        </>
      )}
    </Section>
  )
}

export const RECENT_ROWS = 10

const ACTIVITY_ICONS: [RegExp, React.ComponentType<{ className?: string }>][] = [
  [/^(app|build|deploy|release|promotion)\b/, Hammer],
  [/^(member|invite|workspace|role)\b/, Users],
  [/^(key|webhook|setting|repo)/, KeyRound],
  [/^(pool|liquidity|withdraw|commit|deposit|money|payment|rail)/, Coins],
]
const iconFor = (action: string) => ACTIVITY_ICONS.find(([re]) => re.test(action))?.[1] ?? ActivityIcon

/** Recent activity: a compact timeline, an icon per kind of record, newest first. */
export function RecentActivity({ state, now = Date.now() }: { state: Loaded<AuditEvent[]>; now?: number }) {
  const rows = state.kind === "ready" ? state.data.slice(0, RECENT_ROWS) : []
  return (
    <Section id="recent-activity" title="Recent activity">
      {state.kind !== "ready" ? (
        <NotReadyText state={state} what="Recent activity" />
      ) : rows.length === 0 ? (
        <Quiet kind="nothing">Nothing has happened in this workspace yet</Quiet>
      ) : (
        <ol className="relative flex flex-col border-l pl-4" data-timeline>
          {rows.map((e, i) => {
            const Icon = iconFor(e.action)
            return (
              <li key={`${e.at}-${i}`} className="relative flex min-w-0 items-start gap-2 py-1.5" data-activity-row>
                <span className="absolute top-2 -left-[25px] flex size-4 items-center justify-center rounded-full border bg-background" aria-hidden>
                  <Icon className="size-2.5 text-muted-foreground" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  <span className="font-medium">{e.actor.name ?? e.actor.id ?? "Mynt"}</span> <span className="font-mono text-xs">{e.action}</span>{" "}
                  <span className="text-muted-foreground">{[e.target.type, e.target.name ?? e.target.id].filter(Boolean).join(": ") || "Not recorded"}</span>
                </span>
                <time className="shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={e.at} title={`${e.at.slice(0, 16).replace("T", " ")} UTC`}>
                  {relativeTime(e.at, now)}
                </time>
              </li>
            )
          })}
        </ol>
      )}
      {/* The whole audit trail, on a row of its own at the bottom right. */}
      <div className="flex justify-end border-t pt-3" data-view-all>
        <Button asChild variant="outline" size="sm">
          <Link href="/audits">
            View all
            <ChevronRight />
          </Link>
        </Button>
      </div>
    </Section>
  )
}
