"use client"

// The Licences page (/licences?tab=coverage|licences), laid out as the studio's detail pages
// are: a summary card on top, then tabs. Coverage is the map of US states (components/
// coverage-view.tsx, as the Coverage page was), Licences the table of partner licences
// (components/licences-view.tsx). Coverage opens first: it's the overview, the table the detail.
// Server-renderable for the tests.
import { CoverageView } from "@/components/coverage-view"
import { LicencesView } from "@/components/licences-view"
import { NotReady } from "@/components/not-available"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { allStates, COVERAGE_LABELS, COVERAGE_STATUSES, countByStatus, expiryOf, type Coverage, type Licence } from "@/lib/compliance"
import { LICENCES_TAB_LABELS, LICENCES_TABS, type LicencesTab } from "@/lib/licences-tabs"
import type { Loaded } from "@/lib/use-compliance"
import { cn } from "@/lib/utils"

function Figure({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("text-sm font-medium", typeof value === "number" && "text-lg tabular-nums")}>{value}</dd>
    </div>
  )
}

// A figure from data that isn't there says why, never 0.
const missing = (s: Loaded<unknown>) => (s.kind === "loading" ? "Loading…" : s.kind === "error" ? "Couldn't load" : "Not available yet")

export function LicencesSummary({ coverage, licences, now = Date.now() }: { coverage: Loaded<Coverage>; licences: Loaded<Licence[]>; now?: number }) {
  const counts = coverage.kind === "ready" ? countByStatus(allStates(coverage.data)) : null
  const expiry = licences.kind === "ready" ? licences.data.map((l) => expiryOf(l, now)) : null
  return (
    <Card data-licences-summary>
      <CardHeader>
        <CardTitle className="text-xl">Licences and coverage</CardTitle>
        <CardDescription>Where this workspace&apos;s products can serve customers, and the partner licences behind them</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          {COVERAGE_STATUSES.map((s) => (
            <Figure key={s} label={`${COVERAGE_LABELS[s]} states`} value={counts ? counts[s] : missing(coverage)} />
          ))}
          <Figure label="Licences" value={licences.kind === "ready" ? licences.data.length : missing(licences)} />
          <Figure label="Expiring within 60 days" value={expiry ? expiry.filter((e) => e === "expiring").length : missing(licences)} />
          <Figure label="Expired" value={expiry ? expiry.filter((e) => e === "expired").length : missing(licences)} />
        </dl>
      </CardContent>
    </Card>
  )
}

export function LicencesTabBar({ tab, onTab }: { tab: LicencesTab; onTab: (t: LicencesTab) => void }) {
  return (
    <div role="tablist" aria-label="Licences" className="inline-flex w-fit items-center gap-1 rounded-lg bg-muted p-1">
      {LICENCES_TABS.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          data-tab={t}
          onClick={() => onTab(t)}
          className={cn("rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors", tab === t ? "bg-background text-foreground shadow-sm" : "hover:text-foreground")}
        >
          {LICENCES_TAB_LABELS[t]}
        </button>
      ))}
    </div>
  )
}

export function LicencesPageView({ tab, onTab, coverage, licences }: { tab: LicencesTab; onTab: (t: LicencesTab) => void; coverage: Loaded<Coverage>; licences: Loaded<Licence[]> }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-licences-page>
      <LicencesSummary coverage={coverage} licences={licences} />
      <LicencesTabBar tab={tab} onTab={onTab} />
      {tab === "coverage" ? (
        <div data-tab-panel="coverage">{coverage.kind === "ready" ? <CoverageView coverage={coverage.data} /> : <NotReady state={coverage} what="Coverage" />}</div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col" data-tab-panel="licences">
          {licences.kind === "ready" ? <LicencesView licences={licences.data} /> : <NotReady state={licences} what="Licences" />}
        </div>
      )}
    </div>
  )
}
