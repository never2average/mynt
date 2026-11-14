// The dashboard's sections below the P&L: the Needs attention strip (get_workspace_attention),
// Apps by stage (a compact table: each app's stage, readiness for the next one from the
// promotion checks, and last build) and Recent activity (the newest audit entries). Plain
// sections with headings and tables, no cards. Each says when Mynt doesn't offer its data yet,
// never showing an empty table as if it were data. Server-renderable for the tests.
import Link from "next/link"

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
export function Section({ title, description, action, children, id }: { title: string; description?: string; action?: React.ReactNode; children: React.ReactNode; id: string }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-section={id} aria-labelledby={`section-${id}`}>
      <div className="flex items-baseline gap-3 border-b pb-2">
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

/** Needs attention: a compact strip of items (severity dot, title, link); one line when nothing needs you. */
export function NeedsAttention({ state }: { state: Loaded<AttentionItem[]> }) {
  if (state.kind === "loading") return <Skeleton className="h-8 w-full" data-strip="attention" />
  if (state.kind === "ready" && state.data.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-strip="attention" data-empty="nothing">
        Nothing needs you right now
      </p>
    )
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
export function AppsByStage({ state, apps = [] }: { state: Loaded<StagesData>; apps?: DashboardApp[] }) {
  const counts = state.kind === "ready" ? STAGES.map((s) => [s, state.data.apps.filter((a) => a.stage === s).length] as const) : []
  return (
    <Section
      id="apps-by-stage"
      title="Apps by stage"
      description="Ideas → Staging → Production, through Mynt's checks"
      action={<SectionLink href="/settings?tab=apps">All apps</SectionLink>}
    >
      {state.kind !== "ready" ? (
        <NotReadyText state={state} what="Apps by stage" />
      ) : (
        <>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {counts.map(([s, n]) => (
              <span key={s}>
                {STAGE_LABELS[s]}{" "}
                <span className="font-semibold text-foreground tabular-nums" data-stage-count={s}>
                  {n}
                </span>
              </span>
            ))}
          </p>
          {state.data.apps.length === 0 ? (
            <Quiet kind="nothing">No apps in this workspace yet</Quiet>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>App</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Readiness</TableHead>
                  <TableHead>Last build</TableHead>
                  <TableHead className="text-right">
                    <span className="sr-only">Open</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...state.data.apps]
                  .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.name.localeCompare(b.name))
                  .map((a) => {
                    const build = apps.find((d) => d.id === a.id)?.lastBuild ?? null
                    return (
                      <TableRow key={a.id} data-stage-row={a.stage}>
                        <TableCell className="max-w-48 truncate font-medium">{a.name}</TableCell>
                        <TableCell className="text-muted-foreground">{STAGE_LABELS[a.stage]}</TableCell>
                        <TableCell>
                          <ReadinessLine app={a} checks={state.data.checks} />
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {build ? (
                            <Link className="hover:underline" href={`/${encodeURIComponent(a.id)}/${encodeURIComponent(build.id)}`}>
                              {build.status}
                              {when(build.at) ? ` · ${when(build.at)}` : ""}
                            </Link>
                          ) : (
                            "None yet"
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link href={`/${encodeURIComponent(a.id)}`} className="text-sm font-medium hover:underline">
                            Open app
                          </Link>
                        </TableCell>
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </Section>
  )
}

export const RECENT_ROWS = 10

export function RecentActivity({ state }: { state: Loaded<AuditEvent[]> }) {
  const rows = state.kind === "ready" ? state.data.slice(0, RECENT_ROWS) : []
  return (
    <Section id="recent-activity" title="Recent activity" description="The newest entries in the audit trail" action={<SectionLink href="/audits">Audits</SectionLink>}>
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
                <TableCell className="whitespace-nowrap text-xs text-muted-foreground tabular-nums">{e.at.slice(0, 16).replace("T", " ")} UTC</TableCell>
                <TableCell className="max-w-32 truncate font-medium">{e.actor.name ?? e.actor.id ?? "Mynt"}</TableCell>
                <TableCell className="font-mono text-xs">{e.action}</TableCell>
                <TableCell className="max-w-48 truncate">{[e.target.type, e.target.name ?? e.target.id].filter(Boolean).join(": ") || "Not recorded"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  )
}
