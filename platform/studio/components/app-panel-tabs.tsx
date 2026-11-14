"use client"

// An app's information tabs in the builder's right-hand panel: P&L, Licences, Security, SDK and
// Activity (lib/app-panel.ts). Each is live while it's on screen: read when it's opened or the
// page comes back into view, and every 30 seconds while both are visible (never while the page
// is hidden), with when it was last read. Every request names this app. Tabs only show
// information: promoting, moving back and the rest are actions elsewhere (the top bar).
import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  checkLabel,
  LIVE_INTERVAL_MS,
  updatedAgo,
  type AppActivity,
  type AppLicences,
  type AppPnl,
  type AppSdk,
  type AppSecurity,
  type InfoTab,
  type NotYet,
  type PanelEvent,
} from "@/lib/app-panel"
import { CHECK_LABELS } from "@/lib/promotions"
import { cn } from "@/lib/utils"

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
export const money = (c: number | null | undefined) => (c === null || c === undefined ? "Not measured" : USD.format(c / 100))
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—")

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: AppPnl | AppLicences | AppSecurity | AppSdk | AppActivity | NotYet }

// Live data for one tab of one app.
export function useLiveTab(appId: string, tab: InfoTab, active: boolean, interval = LIVE_INTERVAL_MS) {
  const [state, setState] = useState<Loaded>({ kind: "loading" })
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const inFlight = useRef(false)
  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch(`/api/apps/${encodeURIComponent(appId)}/panel?tab=${tab}`, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { data?: Loaded extends { data: infer D } ? D : never; message?: string } | null
      if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
      if (!res?.ok || !body?.data) setState({ kind: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." })
      else {
        setState({ kind: "ready", data: body.data })
        setUpdatedAt(Date.now())
      }
    } finally {
      inFlight.current = false
    }
  }, [appId, tab])

  useEffect(() => {
    if (!active) return
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden"
    if (visible()) void load()
    const timer = window.setInterval(() => {
      if (visible()) void load()
    }, interval)
    const onVisibility = () => {
      if (visible()) void load()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [active, load, interval])

  return { state, updatedAt, reload: load }
}

function NotYetNote({ reason }: { reason: string }) {
  return (
    <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground" data-not-yet>
      Not available yet. {reason}
    </p>
  )
}

function Events({ events, reason, empty }: { events: PanelEvent[] | null; reason: string | null; empty: string }) {
  if (events === null) return <p className="text-sm text-muted-foreground">Not available yet. {reason}</p>
  if (!events.length) return <p className="text-sm text-muted-foreground">{empty}</p>
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>What</TableHead>
          <TableHead>Who</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map((e, i) => (
          <TableRow key={`${e.at}-${i}`} data-event={e.action}>
            <TableCell className="tabular-nums">{when(e.at)}</TableCell>
            <TableCell className="whitespace-normal">
              <span className="font-mono text-xs">{e.action}</span>
              {e.details && <div className="max-w-80 truncate text-xs text-muted-foreground" title={e.details}>{e.details}</div>}
            </TableCell>
            <TableCell>{e.actor ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

// ---- the tabs' content ----

export function PnlView({ pnl }: { pnl: AppPnl }) {
  const measured = pnl.series.map((p) => p.netCents).filter((v): v is number => v !== null)
  const max = Math.max(1, ...measured.map(Math.abs))
  const row = (label: string, values: Record<string, number | null>, strong = false) => (
    <TableRow key={label} className={cn(strong && "font-medium")}>
      <TableCell className="whitespace-normal">{label}</TableCell>
      {pnl.columns.map((c) => (
        <TableCell key={c.key} className={cn("text-right tabular-nums", values[c.key] === null || values[c.key] === undefined ? "text-muted-foreground" : "")}>
          {money(values[c.key])}
        </TableCell>
      ))}
    </TableRow>
  )
  return (
    <div className="flex flex-col gap-4" data-pnl>
      <div>
        <h4 className="mb-2 text-sm font-medium">Net by period</h4>
        <div className="flex h-28 items-end gap-2" role="img" aria-label="Net by period">
          {pnl.series.map((p) => (
            <div key={p.start} className="flex flex-1 flex-col items-center gap-1" data-period={p.start} title={`${p.start.slice(0, 10)}: ${money(p.netCents)}`}>
              {p.netCents === null ? (
                <div className="flex h-full w-full items-end justify-center text-[10px] text-muted-foreground">n/m</div>
              ) : (
                <div className={cn("w-full rounded-t", p.netCents < 0 ? "bg-destructive/70" : "bg-primary/70")} style={{ height: `${Math.max(2, (Math.abs(p.netCents) / max) * 100)}%` }} />
              )}
              <span className="text-[10px] text-muted-foreground tabular-nums">{p.start.slice(5, 7)}</span>
            </div>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">n/m: not measured (Mynt doesn&apos;t record every line in that period, so there&apos;s no total).</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Line</TableHead>
            {pnl.columns.map((c) => (
              <TableHead key={c.key} className="text-right">
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {pnl.revenue.map((l) => row(l.label, l.values))}
          {row("Revenue", pnl.totals.revenue, true)}
          {pnl.costs.map((l) => row(l.label, l.values))}
          {row("Costs", pnl.totals.costs, true)}
          {row("Net", pnl.totals["net"], true)}
        </TableBody>
      </Table>
      {pnl.unmeasured.length > 0 && (
        <div className="text-xs text-muted-foreground" data-unmeasured>
          <p className="font-medium">Not measured</p>
          <ul className="list-disc pl-4">
            {pnl.unmeasured.map((u) => (
              <li key={u.label}>
                {u.label}: {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export function LicencesTabView({ data }: { data: AppLicences }) {
  if (!data.products.length) return <p className="text-sm text-muted-foreground">This app uses no regulated products, so no licences are needed for it.</p>
  return (
    <div className="flex flex-col gap-3" data-app-licences>
      <p className="text-sm">
        {data.products.map((p) => p.name).join(", ")}: every product covered in <strong className="tabular-nums">{data.fullyCovered}</strong> state(s); some covered in{" "}
        <strong className="tabular-nums">{data.states.length - data.fullyCovered}</strong> more.
      </p>
      {data.productionCheck && (
        <p className="text-sm" data-production-check={data.productionCheck.status}>
          <Badge variant="outline">{checkLabel(data.productionCheck)}</Badge> {data.productionCheck.detail}
          {data.productionCheck.fix?.label ? <span className="text-muted-foreground"> To fix: {data.productionCheck.fix.label}.</span> : null}
        </p>
      )}
      {data.states.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>State</TableHead>
              <TableHead>Covered</TableHead>
              <TableHead>Not covered</TableHead>
              <TableHead>Licences</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.states.map((s) => (
              <TableRow key={s.code} data-state={s.code} data-covered={s.missing.length ? "partly" : "fully"}>
                <TableCell>{s.name}</TableCell>
                <TableCell className="whitespace-normal">{s.covered.join(", ")}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{s.missing.join(", ") || "—"}</TableCell>
                <TableCell className="whitespace-normal text-xs">
                  {s.licences.map((l, i) => (
                    <div key={i}>
                      {[l.type, l.regulator, l.number].filter(Boolean).join(" · ")}
                      {l.status ? ` (${l.status})` : ""}
                    </div>
                  ))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">None of this app&apos;s products is covered by a licence in force in any state yet.</p>
      )}
    </div>
  )
}

export function SecurityView({ data }: { data: AppSecurity }) {
  return (
    <div className="flex flex-col gap-4" data-app-security>
      <section>
        <h4 className="mb-2 text-sm font-medium">Build checks</h4>
        {data.checks.length ? (
          <ul className="flex flex-col gap-1 text-sm">
            {data.checks.map((c) => (
              <li key={c.id} data-check={c.id} data-status={c.status}>
                <Badge variant="outline">{CHECK_LABELS[c.status]}</Badge> {c.label}
                {c.detail && <span className="text-muted-foreground"> — {c.detail}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{data.checksReason ?? "No build checks to show."}</p>
        )}
      </section>
      <section>
        <h4 className="mb-2 text-sm font-medium">Security events</h4>
        <Events events={data.events} reason={data.eventsReason} empty="No security events for this app." />
      </section>
    </div>
  )
}

export function SdkView({ data }: { data: AppSdk }) {
  if (!data.products.length) return <p className="text-sm text-muted-foreground">This app uses no products yet, so there&apos;s no SDK reference for it.</p>
  return (
    <div className="flex flex-col gap-4" data-app-sdk>
      <p className="text-xs text-muted-foreground">
        From each product&apos;s integration kit (get_product_sdk). Typed TypeScript and Python clients and an OpenAPI document come from an SDK release, which the coding agent makes for the app.
        Devices use client sessions, never the app&apos;s key.
      </p>
      {data.products.map((p) => (
        <section key={p.productId} className="rounded-lg border p-3 text-sm" data-sdk-product={p.productId}>
          <h4 className="font-medium">
            {p.name} {p.version && <span className="text-xs text-muted-foreground">v{p.version}</span>}
          </h4>
          {p.error ? (
            <p className="text-muted-foreground">{p.error}</p>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Action</dt>
              <dd>{p.action ?? "—"}</dd>
              <dt className="text-muted-foreground">Access</dt>
              <dd>{p.access ?? "—"}</dd>
              <dt className="text-muted-foreground">Permitted</dt>
              <dd className="font-mono text-xs">{p.permitted.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">Fields</dt>
              <dd className="font-mono text-xs break-all">{p.fields.join(", ") || "—"}</dd>
              <dt className="text-muted-foreground">Contract</dt>
              <dd>{p.hasContract ? "Published (v2 developer contract)" : "Not published for this product"}</dd>
              {p.handOff && (
                <>
                  <dt className="text-muted-foreground">Hand-off</dt>
                  <dd>{p.handOff}</dd>
                </>
              )}
            </dl>
          )}
        </section>
      ))}
    </div>
  )
}

export function ActivityView({ data }: { data: AppActivity }) {
  return (
    <div className="flex flex-col gap-4" data-app-activity>
      <section>
        <h4 className="mb-2 text-sm font-medium">Builds</h4>
        {data.builds === null ? (
          <p className="text-sm text-muted-foreground">Not available yet.</p>
        ) : data.builds.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Goal</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.builds.map((b) => (
                <TableRow key={b.id} data-build={b.id}>
                  <TableCell className="tabular-nums">{when(b.at)}</TableCell>
                  <TableCell className="max-w-72 truncate" title={b.goal ?? undefined}>
                    {b.goal ?? "—"}
                  </TableCell>
                  <TableCell>{b.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-sm text-muted-foreground">No builds yet.</p>
        )}
      </section>
      <section>
        <h4 className="mb-2 text-sm font-medium">Recent events</h4>
        <Events events={data.events} reason={data.eventsReason} empty="No events for this app yet." />
      </section>
    </div>
  )
}

export function InfoTabBody({ tab, data }: { tab: InfoTab; data: AppPnl | AppLicences | AppSecurity | AppSdk | AppActivity | NotYet }) {
  if (!data.available) return <NotYetNote reason={data.reason} />
  if (tab === "pnl") return <PnlView pnl={data as AppPnl} />
  if (tab === "licences") return <LicencesTabView data={data as AppLicences} />
  if (tab === "security") return <SecurityView data={data as AppSecurity} />
  if (tab === "sdk") return <SdkView data={data as AppSdk} />
  return <ActivityView data={data as AppActivity} />
}

// One live tab: its content, when it was read, and a labelled Refresh.
export function AppInfoTab({ appId, tab, active }: { appId: string; tab: InfoTab; active: boolean }) {
  const { state, updatedAt, reload } = useLiveTab(appId, tab, active)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(t)
  }, [active])
  return (
    <div className="flex h-full flex-col" data-info-tab={tab}>
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b px-3 text-xs text-muted-foreground">
        <span data-updated>{updatedAgo(updatedAt, Math.max(now, updatedAt ?? 0))}</span>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => void reload()}>
          <RefreshCw /> Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {state.kind === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
        {state.kind === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        {state.kind === "ready" && <InfoTabBody tab={tab} data={state.data} />}
      </div>
    </div>
  )
}
