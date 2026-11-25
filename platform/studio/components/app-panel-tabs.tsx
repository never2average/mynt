"use client"

// An app's information tabs in the builder's right-hand panel: Products, Agreements, Customers,
// Security & risk, P&L, SDK and Activity (lib/app-panel.ts). There's no Licences tab: an app holds no
// licences, its products do (the Products tab shows each one's sponsor and states). Each is live while it's on screen: read when it's opened or the
// page comes back into view, and every 30 seconds while both are visible (never while the page
// is hidden), with when it was last read. Every request names this app. Tabs only show
// information: promoting, moving back and the rest are actions elsewhere (the top bar), and the
// Agreements and Customers tabs' changes are labelled buttons opening a sheet. They're
// laid out as the dashboard is (one column, the panel being narrow): key figures in a panel,
// sections with headings, tables in a bordered box, and a View all row under a preview of a list.
import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ChevronRight, FilePlus2, Handshake, RefreshCw, Users } from "lucide-react"

import { KpiRow } from "@/components/charts"
import { Panel, Section } from "@/components/dashboard-panels"
import { PnlChart } from "@/components/pnl"
import { AgreementActionButtons, AgreementActionSheet, ChoosePersonasSheet, ProgramCoverage, ProposeAgreementSheet } from "@/components/app-agreement-sheets"
import { SignedCopyLinks, SigningSheet } from "@/components/agreement-esign"
import { EndSubscriptionSheet } from "@/components/end-subscription-sheet"
import { marketplaceHref } from "@/lib/marketplace"
import { StageMark, StatusDot } from "@/components/promotion-view"
import { RiskRegisterSection, SignalSection } from "@/components/risk-register"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  agreementActions,
  buildStatusLabel,
  buildTone,
  countText,
  LIVE_INTERVAL_MS,
  STAGE_TEXT,
  stateLabel,
  updatedAgo,
  type AgreementAction,
  type AgreementRow,
  type AppActivity,
  type AppAgreements,
  type AppCustomers,
  type AppPnl,
  type AppProducts,
  type AppSdk,
  type AppSecurity,
  type InfoTab,
  type PanelEvent,
  type TabData,
  type VendorContractRow,
} from "@/lib/app-panel"
import { auditsHref, type AgreementAuditSummary } from "@/lib/agreement-audits"
import { deltaOf, type Kpi } from "@/lib/dashboard-visual"
import { SIGNAL_COLUMNS } from "@/lib/risk-register"
import { CHECK_LABELS, CHECK_TONE } from "@/lib/promotions"
import { cn } from "@/lib/utils"
import type { Stage } from "@/lib/workspaces"

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
export const money = (c: number | null | undefined) => (c === null || c === undefined ? "Not measured" : USD.format(c / 100))
const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—")

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: TabData }

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

const Quiet = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>

// A section previewing a longer list ends with a row linking to the whole of it, as on the dashboard.
function ViewAll({ href }: { href: string }) {
  return (
    <div className="flex justify-end border-t pt-3" data-view-all={href}>
      <Button asChild variant="outline" size="sm">
        <Link href={href}>
          View all
          <ChevronRight />
        </Link>
      </Button>
    </div>
  )
}

// A table in its own bordered box; the panel is narrow, so a wide table scrolls inside the box.
function TableBox({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 overflow-auto rounded-lg border">{children}</div>
}

/** A build's status as the dashboard shows status: a coloured dot and a word. */
export function BuildStatus({ status }: { status: string }) {
  const tone = buildTone(status)
  const label = buildStatusLabel(status)
  return tone ? <StatusDot tone={tone} label={label} /> : <span className="text-xs text-muted-foreground">{label}</span>
}

// The most rows a tab previews of a list; the whole of it is a View all away.
export const PANEL_ROWS = 10

function Events({ events, reason, empty }: { events: PanelEvent[] | null; reason: string | null; empty: string }) {
  if (events === null) return <Quiet>Not available yet. {reason}</Quiet>
  if (!events.length) return <Quiet>{empty}</Quiet>
  return (
    <TableBox>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>What</TableHead>
            <TableHead>Who</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.slice(0, PANEL_ROWS).map((e, i) => (
            <TableRow key={`${e.at}-${i}`} data-event={e.action}>
              <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{when(e.at)}</TableCell>
              <TableCell className="whitespace-normal">
                <span className="font-mono text-xs">{e.action}</span>
                {e.details && (
                  <div className="max-w-80 truncate text-xs text-muted-foreground" title={e.details}>
                    {e.details}
                  </div>
                )}
              </TableCell>
              <TableCell>{e.actor ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableBox>
  )
}

// ---- the tabs' content ----

// A statement figure; one Mynt didn't send is unmeasured (null), never 0.
const figure = (v: Record<string, number | null>, key: string) => v[key] ?? null

export function PnlView({ pnl }: { pnl: AppPnl }) {
  const thisLabel = pnl.columns.find((c) => c.key === "this_period")?.label ?? "This period"
  const kpi = (key: string, label: string, v: Record<string, number | null>, spark: (number | null)[], costLike = false): Kpi => ({
    key,
    label,
    value: figure(v, "this_period"),
    unit: "money",
    delta: deltaOf({ this_period: figure(v, "this_period"), last_period: figure(v, "last_period"), year_to_date: figure(v, "year_to_date") }, costLike),
    spark: pnl.series.length ? spark : null,
  })
  const kpis = [
    kpi("money-moved", "Money moved", pnl.totals.revenue, pnl.series.map((p) => p.revenueCents)),
    kpi("costs", "Costs", pnl.totals.costs, pnl.series.map((p) => p.costsCents), true),
    kpi("net", "Net", pnl.totals["net"], pnl.series.map((p) => p.netCents)),
  ]
  // The app's series in the dashboard chart's shape: an unmeasured period stays null, a gap.
  const chart = {
    kind: "ready" as const,
    data: { series: pnl.series.map((p) => ({ start: p.start, end: "", revenue: p.revenueCents, costs: p.costsCents, netIncome: p.netCents })) },
  }
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
      <Panel id="app-pnl-kpis">
        <Section id="app-pnl-kpis" title={thisLabel}>
          <KpiRow kpis={kpis} />
        </Section>
      </Panel>
      <Panel id="app-pnl-charts">
        <PnlChart
          state={chart}
          granularity="month"
          periods={6}
          title="Money moved"
          only="revenue"
          controls={false}
          id="app-pnl-revenue"
          empty="Not measured yet: Mynt hasn't recorded money moved through this app for these periods."
        />
        <PnlChart
          state={chart}
          granularity="month"
          periods={6}
          title="Costs"
          only="costs"
          controls={false}
          id="app-pnl-costs"
          empty="Not measured yet: Mynt hasn't recorded this app's costs for these periods."
        />
      </Panel>
      <Section id="app-pnl-statement" title="Statement">
        <TableBox>
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
        </TableBox>
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
      </Section>
    </div>
  )
}

// The app's products: the regulated things, each with its stage, the licence providers sponsoring it
// and the states they cover. The app's licence coverage is seen here, through its products: it holds
// no licences of its own.
export function ProductsTabView({ data, appId = "", onChanged }: { data: AppProducts; appId?: string; onChanged?: () => void }) {
  if (!data.products.length) return <Quiet>This app uses no financial products yet.</Quiet>
  const check = data.productionCheck
  const agreements = data.agreementCheck ?? null
  const coverage = data.coverage ?? agreements?.coverage ?? []
  return (
    <div className="flex flex-col gap-4" data-app-products>
      {(agreements || data.gate?.flagged || coverage.length > 0) && (
        <Section id="app-program-agreements" title="Program agreements for production" description="A signed program agreement with each product's sponsor, in force today.">
          {agreements ? (
            <div className="flex min-w-0 items-center gap-2 text-sm" data-agreement-check={agreements.status}>
              <StatusDot tone={CHECK_TONE[agreements.status]} label={CHECK_LABELS[agreements.status]} />
              <span className="min-w-0 truncate font-medium">{agreements.label}</span>
            </div>
          ) : null}
          {data.gate?.flagged && <ProductionFlag missing={data.gate.missing} />}
          <ProgramCoverage appId={appId} coverage={coverage} canPropose={data.canManage === true} onChanged={onChanged} />
        </Section>
      )}
      {check && (
        <Section id="app-production-check" title="Production check">
          <div className="flex flex-col gap-1 text-sm" data-production-check={check.status}>
            <div className="flex min-w-0 items-center gap-2">
              <StatusDot tone={CHECK_TONE[check.status]} label={CHECK_LABELS[check.status]} />
              <span className="min-w-0 truncate font-medium">{check.label}</span>
            </div>
            {check.detail && <p className="text-muted-foreground">{check.detail}</p>}
            {check.fix?.label ? <p className="text-muted-foreground">To fix: {check.fix.label}.</p> : null}
          </div>
        </Section>
      )}
      <Section id="app-products" title="Products this app uses" description="Licence coverage is each product's: its own firm's licences, or a licence provider's sponsorship in the states shown.">
        <TableBox>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Sponsor</TableHead>
                <TableHead>States covered</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.products.map((p) => (
                <TableRow key={p.id} data-app-product={p.id}>
                  <TableCell className="whitespace-normal">
                    <Link href={`/products/${encodeURIComponent(p.id)}`} className="font-medium underline-offset-4 hover:underline" data-product-link={p.id}>
                      {p.name}
                    </Link>
                  </TableCell>
                  <TableCell>{p.stage && STAGE_TEXT[p.stage] ? <StageMark stage={p.stage as Stage} /> : <span className="text-xs text-muted-foreground">{p.missing ? "Not found" : "—"}</span>}</TableCell>
                  <TableCell className="whitespace-normal">{p.sponsors.length ? p.sponsors.map((s) => s.name).join(", ") : <span className="text-muted-foreground">No sponsor on record</span>}</TableCell>
                  <TableCell className="whitespace-normal text-xs">{p.states.length ? p.states.map(stateLabel).join(", ") : <span className="text-muted-foreground">None through a sponsor</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableBox>
      </Section>
    </div>
  )
}

const dates = (from: string | null, to: string | null) => (from || to ? `${from ?? "—"} to ${to ?? "open-ended"}` : "Not set")

// An agreement's oversight audits: how many, the next one due and how many are overdue (in words),
// with a link to Audits filtered to this agreement.
function AgreementAuditsCell({ agreementId, summary }: { agreementId: string; summary: AgreementAuditSummary | undefined }) {
  return (
    <div className="flex flex-col gap-0.5">
      {summary ? (
        <>
          <span>
            {summary.count} {summary.count === 1 ? "audit" : "audits"}
            {summary.nextDue ? `, next due ${summary.nextDue.slice(0, 10)}` : ", none open"}
          </span>
          {summary.overdue > 0 && <StatusDot tone="red" label={`${summary.overdue} overdue`} />}
        </>
      ) : (
        <span className="text-muted-foreground">None yet</span>
      )}
      <Link href={auditsHref(agreementId)} className="font-medium underline-offset-4 hover:underline" data-agreement-audits-link={agreementId}>
        View audits
      </Link>
    </div>
  )
}

// Business development: program agreements with the products' sponsors, vendor contracts and the
// introductions in progress. Status is always in words. Propose agreement is a labelled action.
export function AgreementsTabView({ appId, data, onChanged }: { appId: string; data: AppAgreements; onChanged?: () => void }) {
  const [proposing, setProposing] = useState(false)
  const [ending, setEnding] = useState<VendorContractRow | null>(null)
  const [acting, setActing] = useState<{ action: AgreementAction; row: AgreementRow } | null>(null)
  const [signing, setSigning] = useState<string | null>(null)
  const coverage = data.coverage ?? []
  return (
    <div className="flex flex-col gap-5" data-app-agreements>
      {data.gate?.flagged && <ProductionFlag missing={data.gate.missing} />}
      {coverage.length > 0 && (
        <Section id="app-program-coverage" title="Program agreements for production" description="Production needs a signed program agreement, in force today, with each product's sponsor.">
          <ProgramCoverage appId={appId} coverage={coverage} canPropose={data.canManage} onChanged={onChanged} sheetData={data} />
        </Section>
      )}
      <Section
        id="app-agreements"
        title="Agreements"
        description="Program agreements with the licence providers sponsoring this app's products, and data sharing with them."
        action={
          data.canManage ? (
            <Button size="sm" variant="outline" onClick={() => setProposing(true)} data-propose-agreement>
              <FilePlus2 /> Propose agreement
            </Button>
          ) : undefined
        }
      >
        {data.agreements.length ? (
          <TableBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>With</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Products covered</TableHead>
                  <TableHead>Effective</TableHead>
                  {data.audits && <TableHead>Audits</TableHead>}
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.agreements.map((a) => (
                  <TableRow key={a.id} data-agreement={a.id} data-status={a.statusKey}>
                    <TableCell className="whitespace-normal font-medium">
                      {a.counterparty}
                      {a.documentUrl && (
                        <div>
                          <a href={a.documentUrl} target="_blank" rel="noopener noreferrer" className="text-xs font-normal underline-offset-4 hover:underline" data-agreement-document={a.id}>
                            Document
                          </a>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{a.kind}</TableCell>
                    <TableCell className={`whitespace-normal${a.scopes.length ? "" : " text-muted-foreground"}`} data-agreement-scope={a.id}>
                      {a.scopeLabel}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      {a.status}
                      {a.signatures && <div className="text-xs text-muted-foreground">{a.signatures}</div>}
                      {a.statusKey === "terminated" && a.endedReason && <div className="text-xs text-muted-foreground">Reason: {a.endedReason}</div>}
                    </TableCell>
                    <TableCell className="whitespace-normal">{a.products.join(", ") || "—"}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap tabular-nums">{dates(a.from, a.to)}</TableCell>
                    {data.audits && (
                      <TableCell className="whitespace-normal text-xs" data-agreement-audits={a.id}>
                        <AgreementAuditsCell agreementId={a.id} summary={data.audits[a.id]} />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {data.canManage && (
                          <AgreementActionButtons
                            id={a.id}
                            actions={agreementActions(a, "app")}
                            // Sign on a program agreement signed by e-signature opens the signer's embedded signing page.
                            onAction={(action) => (action === "sign" && a.esign?.byEsign ? setSigning(a.id) : setActing({ action, row: a }))}
                          />
                        )}
                        <SignedCopyLinks agreementId={a.id} esign={a.esign} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
        ) : (
          <Quiet>No agreements yet.{data.canManage ? " Propose one to a firm sponsoring this app's products." : ""}</Quiet>
        )}
      </Section>
      <Section
        id="app-vendor-contracts"
        title="Vendor contracts"
        description="The service providers this app's workspace subscribes to, under their standard terms."
        action={
          <Button size="sm" variant="outline" asChild data-browse-vendors>
            <Link href={marketplaceHref(appId)}>
              <Handshake /> Browse vendors
            </Link>
          </Button>
        }
      >
        {data.vendorContracts.length ? (
          <TableBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>With</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Terms</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Since</TableHead>
                  {data.canManage && <TableHead>Actions</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.vendorContracts.map((v) => (
                  <TableRow key={v.id} data-vendor-contract={v.id}>
                    <TableCell className="whitespace-normal font-medium">{v.vendor}</TableCell>
                    <TableCell>Vendor subscription</TableCell>
                    <TableCell>Active ({v.environment})</TableCell>
                    <TableCell className="whitespace-normal">{v.offering}</TableCell>
                    <TableCell className="whitespace-normal" data-vendor-terms={v.termsVersion ?? (v.noStandardTerms ? "none" : "other-app")}>
                      {v.termsVersion !== null ? `Standard terms v${v.termsVersion}` : v.noStandardTerms ? "No standard terms on file" : "Accepted for another app"}
                    </TableCell>
                    <TableCell className={`whitespace-normal${v.scopes?.length ? "" : " text-muted-foreground"}`} data-vendor-scope={v.id}>
                      {v.scopeLabel ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs whitespace-nowrap tabular-nums">{when(v.since)}</TableCell>
                    {data.canManage && (
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => setEnding(v)} data-end-subscription={v.id}>
                          End subscription
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
        ) : (
          <Quiet>No vendor services subscribed. Browse vendors to subscribe to a service provider&apos;s standard terms.</Quiet>
        )}
      </Section>
      <Section id="app-introductions" title="Introductions in progress" description="From Mynt's business-development agent: the other side is named once both have said yes.">
        {data.introductions === null ? (
          <Quiet>Not available: Mynt&apos;s business-development agent isn&apos;t running here.</Quiet>
        ) : data.introductions.length ? (
          <TableBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>With</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Since</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.introductions.map((i) => (
                  <TableRow key={i.id} data-introduction={i.id}>
                    <TableCell className="whitespace-normal">{i.counterparty ?? <span className="text-muted-foreground">Named once both say yes</span>}</TableCell>
                    <TableCell>Introduction</TableCell>
                    <TableCell className="whitespace-normal">{i.status}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap tabular-nums">{when(i.since)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
        ) : (
          <Quiet>No introductions in progress.</Quiet>
        )}
      </Section>
      {data.canManage && <ProposeAgreementSheet appId={appId} data={data} open={proposing} onClose={() => setProposing(false)} onDone={() => onChanged?.()} />}
      {data.canManage && <EndSubscriptionSheet contract={ending} onClose={() => setEnding(null)} onDone={() => onChanged?.()} />}
      {data.canManage && (
        <>
        <SigningSheet
          agreementId={signing ?? ""}
          open={signing !== null}
          onClose={() => {
            setSigning(null)
            onChanged?.()
          }}
        />
        <AgreementActionSheet
          url={acting ? `/api/apps/${encodeURIComponent(appId)}/agreements/${encodeURIComponent(acting.row.id)}` : ""}
          action={acting?.action ?? null}
          agreement={acting ? { id: acting.row.id, title: `${acting.row.kind} with ${acting.row.counterparty}`, lines: [`Covers: ${acting.row.products.join(", ") || "no products named"}`, `Scope: ${acting.row.scopeLabel}`, `Effective: ${dates(acting.row.from, acting.row.to)}`, acting.row.status] } : null}
          onClose={() => setActing(null)}
          onDone={() => onChanged?.()}
        />
        </>
      )}
    </div>
  )
}

/** An app in production that lost a program agreement: it keeps running, and this says what's missing. */
export function ProductionFlag({ missing }: { missing: string[] }) {
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm" data-production-flag>
      <p className="font-medium">This app is in production without every program agreement it needs</p>
      <p className="text-muted-foreground">It keeps running, but its production checks fail until a new one is signed:</p>
      <ul className="list-disc pl-5">
        {missing.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  )
}

// The customers the app is for (personas from its products' segments) and how many it has, where
// Mynt measures that: "Not measured" otherwise, never 0. Choose personas is a labelled action.
export function CustomersTabView({ appId, data, onChanged }: { appId: string; data: AppCustomers; onChanged?: () => void }) {
  const [choosing, setChoosing] = useState(false)
  const targeted = data.products.flatMap((p) => p.personas.filter((s) => s.targeted).map((s) => ({ product: p.name, ...s })))
  const kpis: Kpi[] = [
    { key: "live-customers", label: "Live customers", value: data.live.withSessions, unit: "count", delta: null, spark: null, note: data.live.reason ?? "With client sessions" },
    { key: "sandbox-customers", label: "Sandbox customers", value: data.sandbox.withSessions, unit: "count", delta: null, spark: null, note: data.sandbox.reason ?? "With client sessions" },
  ]
  return (
    <div className="flex flex-col gap-5" data-app-customers>
      <Panel id="app-customer-counts">
        <KpiRow kpis={kpis} />
        <p className="text-xs text-muted-foreground" data-vault-counts>
          In the customer vault: {countText(data.live.inVault)} live, {countText(data.sandbox.inVault)} sandbox.
        </p>
      </Panel>
      <Section
        id="app-personas"
        title="Personas this app targets"
        action={
          data.canManage ? (
            <Button size="sm" variant="outline" onClick={() => setChoosing(true)} data-choose-personas>
              <Users /> Choose personas
            </Button>
          ) : undefined
        }
      >
        {targeted.length ? (
          <TableBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Persona</TableHead>
                  <TableHead>Kind</TableHead>
                  <TableHead>From product</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {targeted.map((s) => (
                  <TableRow key={`${s.product}/${s.id}`} data-targeted-persona={s.id}>
                    <TableCell className="whitespace-normal font-medium">{s.name}</TableCell>
                    <TableCell>{s.kind ?? "—"}</TableCell>
                    <TableCell className="whitespace-normal">{s.product}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
        ) : (
          <Quiet>No personas chosen yet.{data.canManage ? " Choose them from the segments this app's products declare." : ""}</Quiet>
        )}
      </Section>
      {data.canManage && <ChoosePersonasSheet appId={appId} data={data} open={choosing} onClose={() => setChoosing(false)} onDone={() => onChanged?.()} />}
    </div>
  )
}

// Security & risk: the app's risk register (Add risk and Review risk, each a labelled button opening a sheet), its
// information security (Mynt's build checks and security events), then the signals Mynt measures around it: fraud,
// vendors, conduct and its products. Each is a table, or "Not available." with why; never a 0 for what isn't measured.
export function SecurityView({ data, appId = "", onChanged }: { data: AppSecurity; appId?: string; onChanged?: () => void }) {
  return (
    <div className="flex flex-col gap-5" data-app-security>
      <RiskRegisterSection subject={{ type: "app", id: appId }} data={data.register} onChanged={onChanged} />
      <h2 className="text-sm font-semibold" data-infosec>
        Infosec
      </h2>
      <p className="-mt-3 text-xs text-muted-foreground">Mynt verifies every build outside the agent&apos;s sandbox (tests, types, a secrets scan, a static scan, dependencies) and, where audits are on, has it audited independently. On Mynt&apos;s hosting the app&apos;s key is added on the way out and never stored on its machine.</p>
      <Section id="app-build-checks" title="Build checks">
        {data.checks.length ? (
          <ul className="flex flex-col divide-y text-sm">
            {data.checks.map((c) => (
              <li key={c.id} className="flex min-w-0 flex-col gap-0.5 py-1.5" data-check={c.id} data-status={c.status}>
                <div className="flex min-w-0 items-center gap-2">
                  <StatusDot tone={CHECK_TONE[c.status]} label={CHECK_LABELS[c.status]} />
                  <span className="min-w-0 truncate">{c.label}</span>
                </div>
                {c.detail && <span className="text-xs text-muted-foreground">{c.detail}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <Quiet>{data.checksReason ?? "No build checks to show."}</Quiet>
        )}
      </Section>
      <Section id="app-security-events" title="Security events">
        <Events events={data.events} reason={data.eventsReason} empty="No security events for this app." />
        <ViewAll href="/audits?tab=security" />
      </Section>
      <SignalSection id="fraud" title="Fraud" description="Fraud and velocity signals from the app's customer sessions." columns={SIGNAL_COLUMNS.fraud} signal={data.signals.fraud} empty="No fraud signals for this app." />
      <SignalSection
        id="vendors"
        title="Vendors"
        description="The vendor services this app's workspace relies on that are failing conformance or erroring, and subscriptions or contracts that have ended."
        columns={SIGNAL_COLUMNS.vendors}
        signal={data.signals.vendors}
        empty="No vendor service of this app's is failing, and no vendor contract has ended."
      />
      <SignalSection
        id="conduct"
        title="Conduct"
        description="Open findings from oversight audits of this app's agreements: marketing and complaints."
        columns={SIGNAL_COLUMNS.conduct}
        signal={data.signals.conduct}
        empty="No open marketing or complaints findings."
      />
      <SignalSection
        id="products"
        title="From products"
        description="This app's products with new sales paused by a licence provider's covenant, or drifted from their published composition."
        columns={SIGNAL_COLUMNS.products}
        signal={data.signals.products}
        empty="None of this app's products is paused or drifted."
      />
    </div>
  )
}

export function SdkView({ data }: { data: AppSdk }) {
  if (!data.products.length) return <Quiet>This app uses no products yet, so there&apos;s no SDK reference for it.</Quiet>
  return (
    <div className="flex flex-col gap-4" data-app-sdk>
      {data.products.map((p) => (
        <Panel key={p.productId} id={`sdk-${p.productId}`}>
          <div data-sdk-product={p.productId}>
            <Section id={`sdk-${p.productId}`} title={p.name} action={p.version ? <span className="text-xs text-muted-foreground">v{p.version}</span> : undefined}>
              {p.error ? (
                <Quiet>{p.error}</Quiet>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
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
            </Section>
          </div>
        </Panel>
      ))}
    </div>
  )
}

export function ActivityView({ data }: { data: AppActivity }) {
  return (
    <div className="flex flex-col gap-5" data-app-activity>
      <Section id="app-builds" title="Builds">
        {data.builds === null ? (
          <Quiet>Not available yet.</Quiet>
        ) : data.builds.length ? (
          <TableBox>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Goal</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.builds.slice(0, PANEL_ROWS).map((b) => (
                  <TableRow key={b.id} data-build={b.id}>
                    <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">{when(b.at)}</TableCell>
                    <TableCell className="max-w-72 truncate" title={b.goal ?? undefined}>
                      {b.goal ?? "—"}
                    </TableCell>
                    <TableCell>
                      <BuildStatus status={b.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableBox>
        ) : (
          <Quiet>No builds yet.</Quiet>
        )}
        <ViewAll href="/builds" />
      </Section>
      <Section id="app-recent-events" title="Recent events">
        <Events events={data.events} reason={data.eventsReason} empty="No events for this app yet." />
        <ViewAll href="/audits?tab=workspace" />
      </Section>
    </div>
  )
}

export function InfoTabBody({ tab, data, appId = "", onChanged }: { tab: InfoTab; data: TabData; appId?: string; onChanged?: () => void }) {
  if (!data.available) return <NotYetNote reason={data.reason} />
  if (tab === "products") return <ProductsTabView data={data as AppProducts} appId={appId} onChanged={onChanged} />
  if (tab === "agreements") return <AgreementsTabView appId={appId} data={data as AppAgreements} onChanged={onChanged} />
  if (tab === "customers") return <CustomersTabView appId={appId} data={data as AppCustomers} onChanged={onChanged} />
  if (tab === "pnl") return <PnlView pnl={data as AppPnl} />
  if (tab === "security") return <SecurityView appId={appId} data={data as AppSecurity} onChanged={onChanged} />
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
        {state.kind === "loading" && (
          <div className="flex flex-col gap-4" data-loading>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        {state.kind === "ready" && <InfoTabBody tab={tab} data={state.data} appId={appId} onChanged={() => void reload()} />}
      </div>
    </div>
  )
}
