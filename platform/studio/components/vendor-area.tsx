"use client"

// My services (/vendor): a service provider's own area, for accounts with Mynt's vendor role. On top, the onboarding
// checklist card (get_vendor_onboarding): the firm's steps, then each service's, every step's status in words with a
// mark (never colour alone), what it waits on, and a labelled button where the studio can do it (Create service, Edit
// service, Run practice test, Run conformance, Set standard terms, List service); steps only Mynt can do say what they
// wait for. The practice run is a line for information: it never counts. Then
// the firm's services in the list layout (full-width search, labelled Import and Export CSV, Create service, a
// full-height table paged 25 rows at a time). A service opens its details: a metadata card with its labelled actions,
// then tabs (Conformance runs, Practice runs, Terms versions, Subscribers), each a table. Tabs only show; every change is a labelled
// button opening a sheet (components/vendor-sheets.tsx). Server-renderable for the tests.
import { useMemo, useState } from "react"
import { CheckCircle2, Circle, CircleDot, ExternalLink, FileCheck2, FlaskConical, ListChecks, ListX, PauseCircle, Pencil, Plus, TestTube2 } from "lucide-react"

import { AdminDetail, AdminList, AdminTable } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { ConformanceSheet, ListingSheet, PracticeSheet, ServiceSheet, TermsSheet } from "@/components/vendor-sheets"
import { Button } from "@/components/ui/button"
import {
  BUILT_ON_MYNT,
  conformanceWords,
  offeringsCsv,
  offeringStatusWords,
  priceWords,
  progressWords,
  STEP_ACTION_LABELS,
  STEP_STATUS_WORDS,
  stepAction,
  type ConformanceRun,
  type LicenceOption,
  type Onboarding,
  type ServiceTypeOption,
  type Step,
  type StepAction,
  type StepStatus,
  type Subscriber,
  type TermsVersion,
  type VendorOffering,
} from "@/lib/vendor-area"
import { scopeLabelOf } from "@/lib/app-panel"
import Link from "next/link"
import { RequestServiceTypeSheet, TypeRequestsTable } from "@/components/build-type"
import { serviceHref, type ServiceTypeRequest } from "@/lib/services"

// requests: the service types this account or its firm asked Mynt for (absent on a Mynt without requests; null when Mynt didn't answer).
export type VendorData = { onboarding: Onboarding; offerings: VendorOffering[]; serviceTypes: ServiceTypeOption[]; licences: LicenceOption[]; requests?: ServiceTypeRequest[] | null }
export type OfferingDetailData = { offering: VendorOffering; runs: ConformanceRun[]; practiceRuns?: ConformanceRun[]; termsVersions: TermsVersion[]; subscribers: Subscriber[] | null }

const STATUS_ICON: Record<StepStatus, typeof Circle> = { done: CheckCircle2, next: CircleDot, not_started: Circle, blocked: PauseCircle }
const STATUS_TONE: Record<StepStatus, string> = { done: "text-emerald-600", next: "text-sky-600", not_started: "text-muted-foreground", blocked: "text-amber-600" }
const ACTION_ICON: Record<StepAction, typeof Plus> = { create: Plus, edit: Pencil, terms: FileCheck2, practice: TestTube2, conformance: FlaskConical, list: ListChecks }

/** A step's status: a mark and its words, never colour alone. */
export function StepStatusMark({ status }: { status: StepStatus }) {
  const Icon = STATUS_ICON[status]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${STATUS_TONE[status]}`} data-step-status={status}>
      <Icon aria-hidden className="size-4" />
      {STEP_STATUS_WORDS[status]}
    </span>
  )
}

function StepRow({ step, onAction }: { step: Step; onAction?: (a: StepAction) => void }) {
  const action = stepAction(step)
  const Icon = action ? ACTION_ICON[action] : null
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-step={step.key} data-step-state={step.status}>
      <div className="w-28 pt-0.5">
        <StepStatusMark status={step.status} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {step.title}
          {step.informational && <span className="ml-2 text-xs font-normal text-muted-foreground">(for information)</span>}
        </p>
        <p className="text-sm text-muted-foreground" data-step-detail>
          {step.detail}
        </p>
      </div>
      {action && Icon && onAction && (
        <Button size="sm" variant={step.status === "next" ? "default" : "outline"} onClick={() => onAction(action)} data-step-action={action}>
          <Icon />
          {STEP_ACTION_LABELS[action]}
        </Button>
      )}
    </li>
  )
}

/** The onboarding checklist card: the firm's steps, then each service's. */
export function OnboardingChecklist({ onboarding, onAction }: { onboarding: Onboarding; onAction?: (a: StepAction, offeringId: string | null) => void }) {
  const p = onboarding.progress
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4" data-onboarding-card data-complete={p.complete}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Getting your services listed</h2>
        <p className="text-sm text-muted-foreground" data-onboarding-progress>
          {progressWords(p)}
          {p.next ? ` · Next: ${p.next.title}${p.next.status === "blocked" ? " (waiting for Mynt)" : ""}` : ""}
        </p>
      </div>
      <div data-checklist="firm">
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{onboarding.entity?.name ?? "Your firm"}</h3>
        <ol className="divide-y">
          {onboarding.firmSteps.map((s) => (
            <StepRow key={s.key} step={s} onAction={onAction ? (a) => onAction(a, null) : undefined} />
          ))}
        </ol>
      </div>
      {onboarding.offerings.map((o) => (
        <div key={o.offeringId} data-checklist={o.offeringId} className="border-t pt-2">
          <h3 className="flex flex-wrap items-baseline gap-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {o.name}
            <span className="font-normal normal-case">
              {o.serviceName ?? o.serviceType} · {o.region} · {progressWords(o.progress)}
            </span>
          </h3>
          <ol className="divide-y">
            {o.steps.map((s) => (
              <StepRow key={s.key} step={s} onAction={onAction ? (a) => onAction(a, o.offeringId) : undefined} />
            ))}
          </ol>
        </div>
      ))}
    </section>
  )
}

type SheetState = { kind: "create" } | { kind: "edit" | "terms" | "practice" | "conformance" | "listing"; offering: VendorOffering } | null

/** The sheets every view of the area opens, and what opens them. */
function useSheets(initial: SheetState = null) {
  const [sheet, setSheet] = useState<SheetState>(initial)
  const [dirty, setDirty] = useState(false)
  return { sheet, setSheet, dirty, setDirty }
}

function Sheets({ state, data, onClose, onDone, fetcher }: { state: SheetState; data: Pick<VendorData, "serviceTypes" | "licences">; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const of = (k: string) => (state && state.kind === k && "offering" in state ? state.offering : null)
  return (
    <>
      <ServiceSheet mode="create" open={state?.kind === "create"} serviceTypes={data.serviceTypes} licences={data.licences} onClose={onClose} onDone={onDone} fetcher={fetcher} />
      <ServiceSheet mode="edit" open={state?.kind === "edit"} offering={of("edit")} serviceTypes={data.serviceTypes} licences={data.licences} onClose={onClose} onDone={onDone} fetcher={fetcher} />
      <TermsSheet offering={of("terms")} onClose={onClose} onDone={onDone} fetcher={fetcher} />
      <PracticeSheet offering={of("practice")} onClose={onClose} onDone={onDone} fetcher={fetcher} />
      <ConformanceSheet offering={of("conformance")} onClose={onClose} onDone={onDone} fetcher={fetcher} />
      <ListingSheet offering={of("listing")} onClose={onClose} onDone={onDone} fetcher={fetcher} />
    </>
  )
}

const sheetFor = (a: StepAction, offering: VendorOffering | null): SheetState => {
  if (a === "create") return { kind: "create" }
  if (!offering) return null
  return { kind: a === "list" ? "listing" : a, offering }
}

export function VendorView({
  data,
  onOpen,
  onChanged = () => undefined,
  initialSheet = null,
  fetcher,
}: {
  data: VendorData
  onOpen: (offeringId: string) => void
  onChanged?: () => void
  initialSheet?: SheetState
  fetcher?: typeof fetch
}) {
  const [query, setQuery] = useState("")
  const [requesting, setRequesting] = useState(false)
  const { sheet, setSheet, dirty, setDirty } = useSheets(initialSheet)
  const rows = useMemo(() => data.offerings.filter((o) => matches(query, o.name, o.serviceKey, o.region, offeringStatusWords(o.status), o.service ? BUILT_ON_MYNT : null)), [data.offerings, query])
  const paged = usePaged(rows)
  const firm = data.onboarding.entity !== null
  const close = () => {
    setSheet(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const byId = (id: string | null) => data.offerings.find((o) => o.id === id) ?? null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-vendor-area>
      <OnboardingChecklist onboarding={data.onboarding} onAction={(a, id) => setSheet(sheetFor(a, byId(id)))} />
      <AdminList
        id="my-services"
        search={query}
        onSearch={setQuery}
        searchLabel="Search your services by name, type, region or status"
        onExport={() => downloadCsv("my-services.csv", offeringsCsv(rows))}
        exportDisabled={!rows.length}
        cta={
          <Button onClick={() => setSheet({ kind: "create" })} disabled={!firm} data-create-service>
            <Plus />
            Create service
          </Button>
        }
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable
          head={["Service", "Type", "Regions", "Conformance", "Terms version", "Listed", "Subscribers"]}
          rowKeys={paged.shown.map((o) => o.id)}
          rows={paged.shown.map((o) => [
            o.service ? (
              // Built and hosted on Mynt: it has its own workspace (its builder chat, contract, conformance, …).
              <span key="n" className="flex flex-col" data-built-on-mynt={o.id}>
                <Link href={serviceHref(o.service.id)} className="underline-offset-4 hover:underline" data-open-built-service={o.service.id}>
                  {o.name}
                </Link>
                <span className="text-xs font-normal text-muted-foreground">{BUILT_ON_MYNT}</span>
              </span>
            ) : (
              <button key="n" type="button" className="text-left underline-offset-4 hover:underline" onClick={() => onOpen(o.id)} data-open-service={o.id}>
                {o.name}
              </button>
            ),
            o.serviceKey,
            o.region,
            conformanceWords(o.lastConformance),
            o.terms ? `v${o.terms.version}` : "None yet",
            o.status === "listed" ? "Listed" : o.status === "suspended" ? "Suspended by Mynt" : "Not listed",
            o.subscribers === null ? "Not known" : String(o.subscribers),
          ])}
          empty={data.offerings.length ? "No services match this search." : firm ? "No services yet. Create your first one." : "Mynt hasn't added you to your firm yet."}
        />
      </AdminList>
      {data.requests !== undefined && (
        // The service types this account or its firm asked Mynt's admins to define, with where each stands.
        <section className="flex flex-col gap-2" data-requested-types>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Requested service types</h2>
            <Button variant="outline" onClick={() => setRequesting(true)} data-request-service-type>
              <Plus />
              Request a service type
            </Button>
          </div>
          <div className="overflow-auto rounded-lg border">
            {data.requests === null ? (
              <p className="p-4 text-sm text-muted-foreground" data-requests-unavailable>
                Not available. Mynt didn&apos;t answer with your requests just now.
              </p>
            ) : (
              <TypeRequestsTable requests={data.requests} />
            )}
          </div>
        </section>
      )}
      <Sheets state={sheet} data={data} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <RequestServiceTypeSheet
        open={requesting}
        onClose={() => {
          setRequesting(false)
          onChanged()
        }}
        fetcher={fetcher}
      />
    </div>
  )
}

// ---- a service's details: the metadata card, then tabs, each a table ----

export const DETAIL_TABS = [
  { id: "runs", label: "Conformance runs" },
  { id: "practice", label: "Practice runs" },
  { id: "terms", label: "Terms versions" },
  { id: "subscribers", label: "Subscribers" },
] as const
export type DetailTab = (typeof DETAIL_TABS)[number]["id"]

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—")

export function OfferingDetailView({
  detail,
  data,
  onBack,
  onChanged = () => undefined,
  initialTab = "runs",
  fetcher,
}: {
  detail: OfferingDetailData
  data: Pick<VendorData, "serviceTypes" | "licences">
  onBack: () => void
  onChanged?: () => void
  initialTab?: DetailTab
  fetcher?: typeof fetch
}) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const { sheet, setSheet, dirty, setDirty } = useSheets()
  const o = detail.offering
  const close = () => {
    setSheet(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const suspended = o.status === "suspended"
  const canList = o.status === "conformance_passed"
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-vendor-offering={o.id}>
      <AdminDetail
        backLabel="All services"
        onBack={onBack}
        title={o.name}
        subtitle={`${o.serviceKey} in ${o.region}`}
        fields={[
          ["Status", offeringStatusWords(o.status)],
          ["Price", priceWords(o.price)],
          ["Test endpoint", o.testBaseUrl || "Not yet (practice only)"],
          ["Live endpoint", o.liveBaseUrl ?? "Not yet"],
          ["Conformance", conformanceWords(o.lastConformance)],
          ["Standard terms", o.terms ? `v${o.terms.version}` : "None yet"],
          ["Terms scope", o.terms ? o.terms.scopeLabel : "None yet"],
          ["Subscribers", o.subscribers === null ? "Not known" : String(o.subscribers)],
          ["Credential", o.requiresCredential ? "Subscribers need one you issue" : "Not needed"],
        ]}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setSheet({ kind: "edit", offering: o })} disabled={suspended} data-detail-action="edit">
              <Pencil />
              Edit service
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSheet({ kind: "terms", offering: o })} data-detail-action="terms">
              <FileCheck2 />
              Set standard terms
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSheet({ kind: "practice", offering: o })} disabled={suspended} data-detail-action="practice">
              <TestTube2 />
              Run practice test
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSheet({ kind: "conformance", offering: o })} disabled={suspended} data-detail-action="conformance">
              <FlaskConical />
              Run conformance
            </Button>
            {o.status === "listed" ? (
              <Button size="sm" variant="outline" onClick={() => setSheet({ kind: "listing", offering: o })} data-detail-action="unlist">
                <ListX />
                Unlist service
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => setSheet({ kind: "listing", offering: o })}
                disabled={!canList}
                title={canList ? undefined : suspended ? "Mynt suspended this service" : "It lists once it passes Mynt's conformance test"}
                data-detail-action="list"
              >
                <ListChecks />
                List service
              </Button>
            )}
          </>
        }
        tabs={[...DETAIL_TABS]}
        tab={tab}
        onTab={setTab}
      >
        {tab === "runs" && (
          <AdminTable
            head={["When", "Result", "Run by", "Failures"]}
            rowKeys={detail.runs.map((r) => r.runId)}
            rows={detail.runs.map((r) => [
              when(r.at),
              <span key="r" data-run-result={r.passed ? "passed" : "failed"}>
                {r.passed ? "Passed" : "Didn't pass"}
              </span>,
              r.runBy ?? "—",
              r.failures.length ? r.failures.map((f) => `${f.case.replace(/_/g, " ")}: ${f.problems.join("; ") || "failed"}`).join(" · ") : "None",
            ])}
            empty="Mynt hasn't tested this service yet. Run conformance."
          />
        )}
        {tab === "practice" && (
          <AdminTable
            head={["When", "Practice result", "Run by", "Counts as conformance"]}
            rowKeys={(detail.practiceRuns ?? []).map((r) => r.runId)}
            rows={(detail.practiceRuns ?? []).map((r) => [
              when(r.at),
              <span key="r" data-practice-run-result={r.passed ? "passed" : "failed"}>
                {r.passed ? "Passed" : "Didn't pass"}
              </span>,
              r.runBy ?? "—",
              "No",
            ])}
            empty="No practice runs yet. Run practice test shows Mynt's test against its own sandbox; it never counts as conformance."
          />
        )}
        {tab === "terms" && (
          <AdminTable
            head={["Version", "Current", "Set on", "Set by", "Summary", "Pricing", "Scope", "Document", "SHA-256", "Agreements"]}
            rowKeys={detail.termsVersions.map((v) => `v${v.version}`)}
            rows={detail.termsVersions.map((v) => [
              `v${v.version}`,
              v.current ? "Current" : "Earlier",
              when(v.setAt),
              v.setBy ?? "—",
              v.summary ?? "Not kept",
              v.pricing ?? "Not kept",
              <span key="scope" data-terms-version-scope>
                {v.scopes === null ? "Not kept" : scopeLabelOf(v.scopes)}
              </span>,
              v.documentUrl ? (
                <a key="d" href={v.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
                  Read <ExternalLink className="size-3" />
                </a>
              ) : (
                "Not kept"
              ),
              <span key="s" className="font-mono text-xs break-all">
                {v.documentSha256 ?? "Not kept"}
              </span>,
              v.agreements === null ? "Not known" : String(v.agreements),
            ])}
            empty="No standard terms yet. Set them so app teams can subscribe from the Marketplace."
          />
        )}
        {tab === "subscribers" &&
          (detail.subscribers === null ? (
            <p className="p-4 text-sm text-muted-foreground" data-subscribers-unknown>
              Mynt didn&apos;t say who subscribes just now. Please try again.
            </p>
          ) : (
            <AdminTable
              head={["Subscriber", "Status", "Live", "Since", "Terms accepted", "Calls (30 days)"]}
              rowKeys={detail.subscribers.map((s) => s.subscriptionId)}
              rows={detail.subscribers.map((s) => [
                s.subscriber,
                s.status === "active" ? "Active" : "Ended",
                s.live ? "Live" : "Test only",
                when(s.since),
                s.termsVersions.length ? s.termsVersions.map((v) => `v${v}`).join(", ") : "Before standard terms",
                s.calls === null ? "Not known" : String(s.calls),
              ])}
              empty="No subscribers yet. App teams subscribe from the Marketplace once it's listed with standard terms."
            />
          ))}
      </AdminDetail>
      <Sheets state={sheet} data={data} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </div>
  )
}
