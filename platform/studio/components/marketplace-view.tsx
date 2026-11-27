"use client"

// The Marketplace page (/marketplace): standard services from service providers, each under the provider's standard
// terms, which an app's workspace subscribes to by accepting them (no negotiation; the provider bills directly, Mynt
// never bills or holds money for it). The list layout: one toolbar row (the full-width search, one Filters popover
// with region, category and service type, Import, Export CSV), then the full-height table paged 25 rows at a time.
// A row opens its details in a side peek: a card of the key facts on top, then tabs (Overview, Standard terms,
// Pricing, Prerequisites, Conformance, Regions), each a table, and a labelled Subscribe button opening the Subscribe
// sheet (components/marketplace-subscribe-sheet.tsx). Server-renderable for the tests.
import { useMemo, useState } from "react"
import { Download, ExternalLink, FileCheck2, FlaskConical, Search, Upload } from "lucide-react"

import { AdminSheet, Field, fieldClass } from "@/components/admin-kit"
import { FiltersPopover, picksOf, type Facet } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { ListPager, TOOLBAR_ROW, TOOLBAR_SEARCH, usePaged } from "@/components/list-layout"
import { SubscribeSheet } from "@/components/marketplace-subscribe-sheet"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tab, TabList } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  categoryLabel,
  conformanceText,
  distinctSorted,
  filterOfferings,
  IN_TESTING,
  IN_TESTING_NOTE,
  marketplaceCsv,
  offeringIdOf,
  testingHref,
  NO_MARKETPLACE_FILTERS,
  prerequisiteText,
  subscribeBlocker,
  type ForApp,
  type MarketplaceApp,
  type MarketplaceFilters,
  type Offering,
} from "@/lib/marketplace"

export const MARKETPLACE_IMPORT_NOTE = "Service providers list their own services on Mynt; there's nothing to import here."

const opts = (values: string[], label: (v: string) => string = (v) => v) => values.map((v) => ({ value: v, label: label(v) }))

export function MarketplaceView({
  offerings,
  apps,
  forApp = null,
  canSubscribe = true,
  initial = NO_MARKETPLACE_FILTERS,
  initialOfferingId = null,
  onSubscribed,
  fetcher,
}: {
  offerings: Offering[]
  apps: MarketplaceApp[]
  forApp?: ForApp | null
  canSubscribe?: boolean
  initial?: MarketplaceFilters
  initialOfferingId?: string | null
  onSubscribed?: () => void
  fetcher?: typeof fetch
}) {
  const [f, setF] = useState<MarketplaceFilters>(initial)
  const shown = useMemo(() => filterOfferings(offerings, f), [offerings, f])
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const [openId, setOpenId] = useState<string | null>(initialOfferingId)
  const [subscribing, setSubscribing] = useState<Offering | null>(null)
  const [subscribed, setSubscribed] = useState(false)
  const [adding, setAdding] = useState(false)
  const open = offerings.find((o) => o.id === openId) ?? null
  const set = (patch: Partial<MarketplaceFilters>) => {
    setF({ ...f, ...patch })
    setPage(1)
  }
  const facet = (id: "region" | "category" | "service", label: string, options: { value: string; label: string }[]): Facet => ({
    id,
    label,
    options,
    selected: picksOf(f[id]),
    onChange: (v) => set({ [id]: v } as Partial<MarketplaceFilters>),
  })
  const services = new Map(offerings.map((o) => [o.serviceKey, o.serviceType]))
  const facets = [
    facet("region", "Region", opts(distinctSorted([...offerings.map((o) => o.region), ...f.region]))),
    facet("category", "Category", opts(distinctSorted(offerings.map((o) => o.category)), categoryLabel)),
    facet("service", "Service type", opts(distinctSorted([...services.keys()]), (k) => services.get(k) ?? k)),
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-marketplace-page data-for-app={forApp?.id}>
      <div className={TOOLBAR_ROW} data-toolbar>
        <div className={TOOLBAR_SEARCH}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={f.query} onChange={(e) => set({ query: e.target.value })} placeholder="Search provider, service, category, region or pricing" className="pl-8" aria-label="Search the marketplace" />
        </div>
        <FiltersPopover facets={facets} onClear={() => set({ region: [], category: [], service: [] })} />
        <Button variant="outline" onClick={() => setAdding(true)} data-add-testing>
          <FlaskConical />
          Add a service in testing
        </Button>
        <Button variant="outline" disabled title={MARKETPLACE_IMPORT_NOTE} aria-description={MARKETPLACE_IMPORT_NOTE} data-import>
          <Upload />
          Import
        </Button>
        <Button variant="outline" onClick={() => downloadCsv("marketplace.csv", marketplaceCsv(shown))} disabled={!shown.length} data-export>
          <Download />
          Export CSV
        </Button>
      </div>
      <div className="min-h-64 flex-1 overflow-auto rounded-lg border" data-table-view>
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Provider</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Category</TableHead>
              <TableHead>Regions</TableHead>
              <TableHead>Pricing</TableHead>
              <TableHead>Conformance</TableHead>
              <TableHead>Prerequisites</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {onPage.length ? (
              onPage.map((o) => (
                <TableRow key={o.id} data-offering={o.id} className="cursor-pointer" onClick={() => setOpenId(o.id)}>
                  <TableCell className="font-medium">
                    <button type="button" className="text-left underline-offset-4 hover:underline" onClick={() => setOpenId(o.id)} data-open-offering={o.id}>
                      {o.provider}
                    </button>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {o.name}
                    {o.inTesting && <div className="text-xs text-muted-foreground" title={IN_TESTING_NOTE} data-in-testing>{IN_TESTING}: sandbox only</div>}
                    {o.subscriptionId && <div className="text-xs text-muted-foreground" data-subscribed>Subscribed</div>}
                  </TableCell>
                  <TableCell>{categoryLabel(o.category)}</TableCell>
                  <TableCell>{o.region}</TableCell>
                  <TableCell className="max-w-56 truncate" title={o.pricing}>
                    {o.pricing}
                  </TableCell>
                  <TableCell data-conformance={o.conformance ? (o.conformance.passed ? "passed" : "failed") : "untested"}>{conformanceText(o.conformance)}</TableCell>
                  <TableCell className="max-w-56 truncate" title={prerequisiteText(o)} data-prerequisites={o.canSubscribe ? "met" : "not-met"}>
                    {o.canSubscribe ? "You meet them" : "Not met"}
                  </TableCell>
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  {offerings.length ? "No services match these filters." : "No services listed yet. Service providers appear here once Mynt has tested and listed their services."}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <ListPager page={page} pages={pages} total={shown.length} onPage={setPage} noun={["service", "services"]} />
      <AddTestingSheet open={adding} onClose={() => setAdding(false)} appId={forApp?.id ?? null} />
      <OfferingPeek
        offering={open}
        onClose={() => setOpenId(null)}
        canSubscribe={canSubscribe}
        onSubscribe={(o) => {
          setOpenId(null)
          setSubscribing(o)
        }}
      />
      {/* Read again once the sheet closes after a subscription, so its result stays on screen until then. */}
      <SubscribeSheet
        offering={subscribing}
        apps={apps}
        preselect={forApp?.id ?? null}
        onClose={() => {
          setSubscribing(null)
          if (subscribed) onSubscribed?.()
          setSubscribed(false)
        }}
        onDone={() => setSubscribed(true)}
        fetcher={fetcher}
      />
    </div>
  )
}

// ---- the side peek: a metadata card, then tabs, each a table ----

export const PEEK_TABS = [
  { id: "overview", label: "Overview" },
  { id: "terms", label: "Standard terms" },
  { id: "pricing", label: "Pricing" },
  { id: "prerequisites", label: "Prerequisites" },
  { id: "conformance", label: "Conformance" },
  { id: "regions", label: "Regions" },
] as const
export type PeekTab = (typeof PEEK_TABS)[number]["id"]

type Pair = [string, React.ReactNode]

function PairsTable({ rows, id }: { rows: Pair[]; id: string }) {
  return (
    <div className="overflow-auto rounded-lg border" data-peek-table={id}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-48">Field</TableHead>
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([k, v]) => (
            <TableRow key={k}>
              <TableCell className="align-top text-muted-foreground">{k}</TableCell>
              <TableCell className="whitespace-normal">{v}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function peekRows(o: Offering, tab: PeekTab): Pair[] {
  switch (tab) {
    case "overview":
      return [
        ["Provider", o.provider],
        ["Service", o.name],
        ["Service type", o.serviceType],
        ["Category", categoryLabel(o.category)],
        ["Customer consent it needs", o.consentPurpose ?? "—"],
        ["Fields it fills", o.fills.join(", ") || "—"],
        ["Service levels", o.slaNotes || "—"],
        ["Live endpoint", o.liveAvailable ? "Available" : "Not yet: test only"],
        ["Your subscription", o.subscriptionId ? "Subscribed" : "Not subscribed"],
      ]
    case "terms":
      if (!o.terms) return [["Standard terms", "No standard terms on file. The provider hasn't set any yet, so there's nothing to accept."]]
      return [
        ["Version", `v${o.terms.version}`],
        ["Scope", <span key="scope" data-terms-scope>{o.terms.scopeLabel}</span>],
        ["Summary", o.terms.summary],
        [
          "Document",
          <a key="doc" href={o.terms.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4" data-terms-document>
            Read the terms <ExternalLink className="size-3" />
          </a>,
        ],
        ["Document SHA-256", <span key="sha" className="font-mono text-xs break-all">{o.terms.documentSha256}</span>],
        ["Set on", o.terms.setAt ? o.terms.setAt.slice(0, 10) : "—"],
        ["How it's signed", "The provider accepts these terms by listing them; you accept them by subscribing. Your agreement records this version's scope; a later version doesn't change your agreement."],
      ]
    case "pricing":
      return [
        ["Pricing", o.pricing],
        ["Billing", "The provider bills you directly. Mynt never bills or holds money for it; it only counts calls."],
      ]
    case "prerequisites":
      return [
        ["Your firm", prerequisiteText(o)],
        ["Licences your firm needs (one of)", o.requiredLicences.join(", ") || "None"],
        ["Provider's licences", o.providerLicences.length ? o.providerLicences.map((l) => `${l.type}${l.number ? ` (${l.number})` : ""}${l.inForce ? "" : ", not in force"}`).join("; ") : "None named"],
        ["Credential", o.requiresCredential ? "The provider issues you a test credential, kept in your firm's key vault" : "Not needed"],
      ]
    case "conformance":
      return [
        ["Mynt's test", conformanceText(o.conformance)],
        ["Last run", o.conformance?.at ? o.conformance.at.slice(0, 16).replace("T", " ") : "—"],
        ["What it checks", "Mynt calls the provider's test endpoint itself and checks every answer against the service's contract, and that badly signed or stale requests are refused."],
      ]
    case "regions":
      return [["Region", o.region]]
  }
}

/** Add a service in testing: its builder gives the offering id; the Marketplace then shows it, marked, to subscribe to in the sandbox. */
export function AddTestingSheet({ open, onClose, appId = null, navigate }: { open: boolean; onClose: () => void; appId?: string | null; navigate?: (href: string) => void }) {
  const [text, setText] = useState("")
  const id = offeringIdOf(text)
  return (
    <AdminSheet
      id="add-testing"
      open={open}
      onClose={onClose}
      title="Add a service in testing"
      description="A service still in Staging isn't listed here. Its builder gives you its offering id; with it you can subscribe and call the service in the sandbox only. Once they move it to Production it is listed, and your subscription carries over."
      error={text.trim() && !id ? "That isn't an offering id. It looks like 1b4e28ba-2fa1-41d2-883f-0016d3cca427." : null}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!id) return
          ;(navigate ?? ((href: string) => window.location.assign(href)))(testingHref(id, appId))
        }}
      >
        <Field label="Offering id">
          <input className={fieldClass} value={text} onChange={(e) => setText(e.target.value)} placeholder="The id the service's builder gave you" aria-label="Offering id" data-testing-id />
        </Field>
        <div>
          <Button type="submit" disabled={!id} data-testing-show>
            <FlaskConical />
            Show this service
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

export function OfferingPeek({ offering, onClose, onSubscribe, canSubscribe = true, initialTab = "overview" }: { offering: Offering | null; onClose: () => void; onSubscribe: (o: Offering) => void; canSubscribe?: boolean; initialTab?: PeekTab }) {
  const [tab, setTab] = useState<PeekTab>(initialTab)
  return (
    <Sheet open={offering !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-[65vw]" data-offering-peek={offering?.id}>
        {offering && (
          <>
            <SheetHeader>
              <SheetTitle>{offering.name}</SheetTitle>
              <SheetDescription>
                {offering.serviceType} from {offering.provider}, a service provider on Mynt.
              </SheetDescription>
            </SheetHeader>
            <OfferingDetail offering={offering} tab={tab} onTab={setTab} onSubscribe={onSubscribe} canSubscribe={canSubscribe} />
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

export function OfferingDetail({ offering: o, tab, onTab, onSubscribe, canSubscribe = true }: { offering: Offering; tab: PeekTab; onTab: (t: PeekTab) => void; onSubscribe: (o: Offering) => void; canSubscribe?: boolean }) {
  const blocker = canSubscribe ? subscribeBlocker(o) : "Subscribing from the Marketplace comes with Mynt's next update."
  const facts: Pair[] = [
    ["Provider", o.provider],
    ["Category", categoryLabel(o.category)],
    ["Region", o.region],
    ["Pricing", o.pricing],
    ["Standard terms", o.terms ? `v${o.terms.version}` : "None on file"],
    ["Conformance", conformanceText(o.conformance)],
    ["Prerequisites", o.canSubscribe ? "You meet them" : "Not met"],
    // Only a service in testing says so: everything else here is listed.
    ...(o.inTesting ? ([["Availability", IN_TESTING_NOTE]] as Pair[]) : []),
  ]
  return (
    <div className="flex flex-col gap-4 px-4 pb-4" data-offering-detail={o.id}>
      <section className="rounded-lg border bg-card p-4" data-offering-card>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
          {facts.map(([k, v]) => (
            <div key={k} className="flex flex-col">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => onSubscribe(o)} disabled={blocker !== null} data-subscribe={o.id}>
            <FileCheck2 />
            {o.subscriptionId ? "Subscribe another app" : "Subscribe"}
          </Button>
          {blocker && (
            <p className="text-sm text-muted-foreground" data-subscribe-blocker>
              {blocker}
            </p>
          )}
        </div>
      </section>
      <TabList aria-label="Service details">
        {PEEK_TABS.map((t) => (
          <Tab key={t.id} selected={tab === t.id} onClick={() => onTab(t.id)} data-peek-tab={t.id}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <PairsTable id={tab} rows={peekRows(o, tab)} />
    </div>
  )
}
