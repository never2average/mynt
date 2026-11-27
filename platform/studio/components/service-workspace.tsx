"use client"

// A service's own workspace (/services/<id>), laid out as an app's and a financial product's: the service's header
// (its name, stage and its offering's status in words, then the labelled Promote / Move back, which open the same
// promotion sheet an app uses with the checks Mynt sends for a service, Put online, and Archive / Restore), the builder
// chat on the left (the service's id is its app id for builds) and its tabs on the right: Overview (its metadata card
// and the checklist of what is left), Contract, Conformance, Terms & pricing, Subscribers, Reliability, Security & risk
// and Activity (lib/services.ts). A service has no preview and none of an app's Products, Agreements, Customers, P&L or
// SDK tabs. Tabs only show, each as tables; every change is a labelled button opening a sheet. Whatever Mynt doesn't
// measure says "Not measured" with why, never 0. Server-renderable for the tests.
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Archive, ArchiveRestore, ChevronLeftIcon, ExternalLink, FileCheck2, FlaskConical, MessageSquarePlus, RefreshCw, Rocket, TestTube2, UploadCloud, type LucideIcon } from "lucide-react"

import { AdminSheet, AdminTable, Field, fieldClass, useAdminAction } from "@/components/admin-kit"
import { AppInfoTab } from "@/components/app-panel-tabs"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { DocsButton } from "@/components/connect-agent"
import { HostingControl, PUT_ONLINE_EVENT } from "@/components/hosting-control"
import { OPEN_PROMOTION_EVENT, StageControl } from "@/components/promotion-view"
import SearchInput from "@/components/search-input"
import { NewAppButton } from "@/components/site-header"
import { DeveloperOnly } from "@/components/studio-gates"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { StepStatusMark } from "@/components/vendor-area"
import { ConformanceSheet, PracticeSheet, TermsSheet } from "@/components/vendor-sheets"
import { useIsMobile } from "@/hooks/use-mobile"
import { LIVE_INTERVAL_MS, PANEL_TAB_EVENT, scopeLabelOf } from "@/lib/app-panel"
import { ProjectConversationsProvider } from "@/lib/project-conversations-context"
import type { ProjectItem } from "@/lib/project-types"
import {
  ASK_AN_ADMIN,
  BUILDER_MESSAGE_EVENT,
  builderEndpointMessage,
  casesWords,
  isServiceTab,
  measuredWords,
  NOT_MEASURED,
  NOT_RECORDED,
  offeringForSheets,
  percent,
  runBuild,
  SERVICE_ENDPOINT_PENDING,
  SERVICE_STEP_LABELS,
  SERVICE_TAB_LABELS,
  SERVICE_TABS,
  serviceHref,
  serviceStepAction,
  stepWaitsOnAdmin,
  type ServiceField,
  type ServiceRun,
  type ServiceStepAction,
  type ServiceTab,
  type ServiceView,
} from "@/lib/services"
import { priceWords, type Step, type VendorOffering } from "@/lib/vendor-area"
import { STAGE_LABELS } from "@/lib/workspaces"

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—")
const short = (id: string | null) => (id ? id.slice(0, 8) : null)

/** What the page can do: each a labelled button that opens a sheet (or sends the builder a prepared message). */
export type ServiceAction = ServiceStepAction | "archive"

// ---- the header ----

export type ServiceHeaderProps = {
  service: ServiceView | null // null while it loads
  error?: string | null
  onAction: (a: ServiceAction) => void
  onBack: () => void
  isMobile?: boolean
}

/** The service's header, as an app's top bar: back, name, stage, its offering's status, its labelled actions, then search and the rest. */
export function ServiceHeader({ service, error = null, onAction, onBack, isMobile = false }: ServiceHeaderProps) {
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background px-4 lg:px-6" data-service-header>
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
      <Button type="button" variant="ghost" size="sm" onClick={onBack} aria-label="Back to Build" title="Back to Build" className="shrink-0 px-2 text-muted-foreground" data-service-back>
        <ChevronLeftIcon />
        Back
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-2" data-service-title>
        <h1 className="truncate text-base font-medium" data-service-name>
          {service?.name ?? (error ? "Service" : "Loading service…")}
        </h1>
        {service && (
          <Badge variant="outline" className="hidden shrink-0 font-normal sm:inline-flex" data-service-stage={service.stage}>
            {STAGE_LABELS[service.stage]}
          </Badge>
        )}
        {service && service.offering.statusWords && (
          // The offering's status as Mynt words it: Needs conformance, Conformance passed, Listed in the Marketplace, …
          <Badge variant="secondary" className="shrink-0 font-normal" title={service.offering.statusNote ?? undefined} data-service-status={service.offering.status}>
            {service.offering.statusWords}
          </Badge>
        )}
        {service && !isMobile && (
          <span className="flex shrink-0 items-center gap-2" data-service-actions>
            {!service.archived && <StageControl appId={service.id} appName={service.name} stage={service.stage} noun="service" />}
            {!service.archived && <HostingControl appId={service.id} appName={service.name} />}
            {service.archived ? (
              <Button size="sm" variant="outline" className="h-7" onClick={() => onAction("restore")} data-service-restore>
                <ArchiveRestore />
                Restore
              </Button>
            ) : (
              <Button size="sm" variant="ghost" className="h-7" onClick={() => onAction("archive")} data-service-archive>
                <Archive />
                Archive
              </Button>
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SearchInput />
        <DeveloperOnly>
          <span className="hidden md:flex">
            <NewAppButton />
          </span>
        </DeveloperOnly>
        <DocsButton />
        <ThemeSwitcher compact />
      </div>
    </header>
  )
}

// ---- Archive / Restore ----

export function ServiceArchiveSheet({ service, mode, onClose, onDone, fetcher }: { service: ServiceView | null; mode: "archive" | "restore" | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [reason, setReason] = useState("")
  useEffect(() => {
    reset()
    setReason("")
  }, [mode, reset])
  const archiving = mode === "archive"
  return (
    <AdminSheet
      id="archive-service"
      open={mode !== null && service !== null}
      onClose={onClose}
      title={archiving ? "Archive service" : "Restore service"}
      description={
        archiving
          ? "Its offering comes off the Marketplace and Mynt stops calling it at once. Products that hand off through it pause new sales, and their builders are told. Its builds, conformance runs, terms and agreements stay."
          : "It comes back as a draft. Put it online again and Mynt tests the build; a service still in Production is listed again when it passes."
      }
      error={error}
      result={result}
    >
      {service && mode && (
        <form
          className="flex flex-col gap-3"
          data-archive-service-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(`/api/services/${encodeURIComponent(service.id)}`, { archived: archiving, ...(archiving && reason.trim() ? { reason: reason.trim() } : {}) })
            if (r?.ok) onDone()
          }}
        >
          <p className="text-sm">
            {service.name} · {service.serviceType.name} in {service.serviceType.region}
            {archiving && service.subscribers.length > 0 ? ` · ${service.subscribers.length} ${service.subscribers.length === 1 ? "subscription" : "subscriptions"}` : ""}
          </p>
          {archiving && (
            <Field label="Why (optional)" hint="Kept with the service's activity">
              <textarea className={`${fieldClass} min-h-16`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} data-archive-reason />
            </Field>
          )}
          <div>
            <Button type="submit" variant={archiving ? "destructive" : "default"} disabled={busy || result !== null} data-archive-service-submit={mode}>
              {busy ? "Saving…" : archiving ? "Archive service" : "Restore service"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

// ---- what every tab is made of ----

function Card({ id, title, subtitle, fields, actions }: { id: string; title: string; subtitle?: string; fields: [string, React.ReactNode][]; actions?: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" data-metadata-card={id}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2" data-tab-actions>
            {actions}
          </div>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
        {fields.map(([label, value]) => (
          <div key={label} className="flex min-w-0 flex-col" data-fact={label}>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function TableBox({ id, title, children }: { id: string; title?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5" data-service-table={id}>
      {title && <h3 className="text-sm font-semibold">{title}</h3>}
      <div className="overflow-auto rounded-lg border">{children}</div>
    </section>
  )
}

const ACTION_ICON: Record<ServiceAction, LucideIcon> = { online: UploadCloud, restore: ArchiveRestore, builder: MessageSquarePlus, practice: TestTube2, conformance: FlaskConical, terms: FileCheck2, production: Rocket, archive: Archive }

function ActionButton({ action, onAction, label = action === "archive" ? "Archive" : SERVICE_STEP_LABELS[action], primary = false, disabled = false }: { action: ServiceAction; onAction: (a: ServiceAction) => void; label?: string; primary?: boolean; disabled?: boolean }) {
  const Icon = ACTION_ICON[action]
  return (
    <Button size="sm" variant={primary ? "default" : "outline"} onClick={() => onAction(action)} disabled={disabled} data-service-action={action}>
      <Icon />
      {label}
    </Button>
  )
}

// ---- Overview: the metadata card and the checklist ----

/** The label of the checklist's stage action: the next stage up (a service in Ideas goes to Staging first). */
export const stageActionLabel = (service: Pick<ServiceView, "stage">) => (service.stage === "idea" ? "Move to staging" : SERVICE_STEP_LABELS.production)

function ChecklistRow({ step, service, onAction }: { step: Step; service: ServiceView; onAction: (a: ServiceAction) => void }) {
  const action = service.archived && step.key !== "app_online" ? null : serviceStepAction(step)
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
      {stepWaitsOnAdmin(step) && (
        <span className="text-sm font-medium" data-step-ask-admin>
          {ASK_AN_ADMIN}
        </span>
      )}
      {action && <ActionButton action={action} onAction={onAction} primary={step.status === "next"} label={action === "production" ? stageActionLabel(service) : undefined} />}
    </li>
  )
}

export function ServiceChecklist({ service, onAction }: { service: ServiceView; onAction: (a: ServiceAction) => void }) {
  const p = service.progress
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4" data-service-checklist data-complete={p.total > 0 && p.done === p.total}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Getting this service listed</h2>
        <p className="text-sm text-muted-foreground" data-checklist-progress>
          {p.total ? `${p.done} of ${p.total} steps done` : "No steps yet"}
        </p>
      </div>
      <ol className="divide-y">
        {service.checklist.map((s) => (
          <ChecklistRow key={s.key} step={s} service={service} onAction={onAction} />
        ))}
      </ol>
    </section>
  )
}

function endpointWords(service: ServiceView): React.ReactNode {
  const e = service.contract?.endpoint
  if (!e) return "Not available: Mynt has no contract for this service type"
  if (e.address) return <code className="text-xs break-all">{`${e.method} ${e.address}`}</code>
  return (
    <span data-endpoint-pending>
      <code className="text-xs">{`${e.method} ${e.path}`}</code> · {SERVICE_ENDPOINT_PENDING}
    </span>
  )
}

export function ServiceOverview({ service, onAction }: { service: ServiceView; onAction: (a: ServiceAction) => void }) {
  return (
    <div className="flex flex-col gap-4" data-service-overview>
      <Card
        id="overview"
        title={service.name}
        subtitle={service.description || undefined}
        fields={[
          ["Service type", service.serviceType.name],
          ["Region", service.serviceType.region],
          ["Firm", service.firm ?? "Not known"],
          ["Stage", STAGE_LABELS[service.stage]],
          ["Status", service.archived ? "Archived" : service.offering.statusWords || "Not known"],
          ["Online", service.hosted ? (service.hosted.online ? "Online" : `Not online (${service.hosted.status})`) : "Not online yet"],
          ["Endpoint", endpointWords(service)],
          ["Price", priceWords(service.offering.price)],
          ["Standard terms", service.terms.current ? `v${service.terms.current.version}` : "None yet"],
        ]}
      />
      {service.offering.statusNote && (
        <p className="rounded-lg border bg-muted/40 px-3 py-2 text-sm" role="status" data-status-note>
          {service.offering.statusNote}
        </p>
      )}
      <ServiceChecklist service={service} onAction={onAction} />
    </div>
  )
}

// ---- Contract ----

export function FieldTable({ id, title, fields, empty }: { id: string; title: string; fields: ServiceField[]; empty: string }) {
  return (
    <TableBox id={id} title={title}>
      <AdminTable
        head={["Field", "Type", "Required", "Description"]}
        rowKeys={fields.map((f) => f.field)}
        rows={fields.map((f) => [<code key="f" className="text-xs">{f.field}</code>, f.type, f.required ? "Yes" : "No", <span key="d" className="block min-w-48 whitespace-normal">{f.description || "Not described"}</span>])}
        empty={empty}
      />
    </TableBox>
  )
}

const jsonText = (v: unknown) => JSON.stringify(v, null, 2)

export function ContractTab({ service }: { service: ServiceView }) {
  const c = service.contract
  if (!c)
    return (
      <p className="text-sm text-muted-foreground" data-contract-unavailable>
        Not available. Mynt has no service type {service.serviceType.key} in {service.serviceType.region} now.
      </p>
    )
  const s = c.signature
  return (
    <div className="flex flex-col gap-4" data-service-contract>
      <Card
        id="contract"
        title={service.serviceType.name}
        subtitle={service.serviceType.description || undefined}
        fields={[
          ["Service type", <code key="k" className="text-xs">{service.serviceType.key}</code>],
          ["Region", service.serviceType.region],
          ["Endpoint", endpointWords(service)],
          ["Limits", c.limits || "Not stated"],
        ]}
      />
      <FieldTable id="input" title="What it takes in" fields={c.inputFields} empty="This service type takes no input fields." />
      {c.paramsFields.length > 0 && <FieldTable id="params" title="Parameters" fields={c.paramsFields} empty="No parameters." />}
      <FieldTable id="output" title="What it gives back" fields={c.outputFields} empty="This service type's output has no fields." />
      <TableBox id="signature" title="Signing rule">
        <AdminTable
          head={["Rule", "Value"]}
          rows={[
            ["Header", <code key="h" className="text-xs">{s.header}</code>],
            ["Format", <span key="f" className="block min-w-48 font-mono text-xs whitespace-normal">{s.format}</span>],
            ["Algorithm", s.algorithm],
            ["Tolerance", s.toleranceSeconds === null ? "Not stated" : `${s.toleranceSeconds} seconds`],
            ["Compare", s.compare],
            ["Refuse with", s.refuseWith === null ? "Not stated" : `HTTP ${s.refuseWith}`],
            // The setting's name only: Mynt hands the secret to the service when it is put online and shows it to nobody.
            ["Secret", <span key="s" className="whitespace-normal">Mynt hands it to the service as the hosted setting <code className="text-xs">{s.secretSetting}</code>; it is never shown</span>],
            ["In words", <span key="r" className="block min-w-48 whitespace-normal">{s.rule}</span>],
          ]}
          empty="No signing rule."
        />
      </TableBox>
      <TableBox id="fixtures" title="Fixtures">
        <AdminTable
          head={["Fixture", "Request Mynt sends"]}
          rowKeys={c.fixtures.map((_, i) => `fixture-${i + 1}`)}
          rows={c.fixtures.map((f, i) => [`Fixture ${i + 1}`, <pre key="p" className="max-w-full overflow-x-auto text-xs font-normal whitespace-pre-wrap">{jsonText(f)}</pre>])}
          empty="This service type has no fixtures."
        />
      </TableBox>
      {c.exampleOutput !== null && (
        <TableBox id="example-output" title="Example output">
          <pre className="overflow-x-auto p-3 text-xs" data-example-output>
            {jsonText(c.exampleOutput)}
          </pre>
        </TableBox>
      )}
    </div>
  )
}

// ---- Conformance ----

/** One run, opened from its row: its cases (a practice run keeps only its failures; its transcript shows in Run practice test). */
export function RunSheet({ run, service, onClose, onAction }: { run: ServiceRun | null; service: ServiceView; onClose: () => void; onAction: (a: ServiceAction) => void }) {
  const practice = run?.kind === "practice"
  const rows = run ? (run.cases ?? run.failures.map((f) => ({ case: f.case, passed: false, httpStatus: null, problems: f.problems }))) : []
  return (
    <AdminSheet
      id="service-run"
      open={run !== null}
      onClose={onClose}
      title={practice ? "Practice run" : "Conformance run"}
      description={practice ? "Mynt's test against its own sandbox for this service type. It never counts as conformance." : "Mynt's own test of the service at its hosted address: each case, and what was wrong where one failed."}
    >
      {run && (
        <div className="flex flex-col gap-3" data-run-detail={run.runId}>
          <p className="text-sm">
            {when(run.at)} · {run.passed ? "Passed" : "Didn't pass"} · {casesWords(run)} cases passed · Build {short(runBuild(service, run)) ?? NOT_RECORDED}
          </p>
          <div className="overflow-auto rounded-lg border">
            <AdminTable
              head={["Case", "Result", "HTTP", "Problems"]}
              rowKeys={rows.map((c) => c.case)}
              rows={rows.map((c) => [c.case.replace(/_/g, " "), c.passed ? "Passed" : "Failed", c.httpStatus === null ? NOT_RECORDED : String(c.httpStatus), <span key="p" className="block min-w-40 whitespace-normal">{c.problems.join("; ") || "None"}</span>])}
              empty={run.passed ? "Every case passed. Mynt keeps the cases of real runs only." : "Mynt kept no cases for this run."}
            />
          </div>
          {practice && (
            <div className="flex flex-col gap-2" data-practice-transcript-note>
              <p className="text-sm text-muted-foreground">Mynt doesn&apos;t keep a practice run&apos;s transcript. Run practice test shows it, with the signing secret left out, right after a run.</p>
              <div>
                <ActionButton action="practice" onAction={onAction} />
              </div>
            </div>
          )}
        </div>
      )}
    </AdminSheet>
  )
}

export function ConformanceTab({ service, onAction }: { service: ServiceView; onAction: (a: ServiceAction) => void }) {
  const [open, setOpen] = useState<ServiceRun | null>(null)
  const runs = service.conformance.runs
  const last = runs.find((r) => r.kind === "conformance") ?? null
  return (
    <div className="flex flex-col gap-4" data-service-conformance>
      <Card
        id="conformance"
        title="Conformance"
        subtitle="Mynt tests each build that goes online before the service is listed. Practice runs are against Mynt's sandbox and never count."
        fields={[
          ["Status", service.offering.statusWords || "Not known"],
          ["Needs conformance", <span key="n" data-conformance-needed={service.conformance.needed}>{service.conformance.needed ? "Yes: the build online hasn't passed Mynt's test" : "No"}</span>],
          ["Last real run", last ? `${last.passed ? "Passed" : "Didn't pass"} ${when(last.at)}` : "Not run yet"],
          ["Build tested", short(service.conformance.testedBuildId) ?? NOT_RECORDED],
        ]}
        actions={
          <>
            <ActionButton action="practice" onAction={onAction} disabled={service.archived} />
            <ActionButton action="conformance" onAction={onAction} primary={service.conformance.needed} disabled={service.archived} />
          </>
        }
      />
      <TableBox id="runs">
        <AdminTable
          head={["When", "Kind", "Build", "Result", "Cases passed", "Run by"]}
          rowKeys={runs.map((r) => r.runId)}
          onRow={(i) => setOpen(runs[i])}
          rows={runs.map((r) => [
            <button key="w" type="button" className="text-left underline-offset-4 hover:underline" onClick={() => setOpen(r)} data-open-run={r.runId}>
              {when(r.at)}
            </button>,
            <span key="k" data-run-kind={r.kind}>
              {r.kind === "practice" ? "Practice" : "Conformance"}
            </span>,
            <span key="b" data-run-build>
              {short(runBuild(service, r)) ?? NOT_RECORDED}
            </span>,
            <span key="r" data-run-result={r.passed ? "passed" : "failed"}>
              {r.passed ? "Passed" : "Didn't pass"}
            </span>,
            casesWords(r),
            r.runBy ?? (r.kind === "conformance" ? "Mynt" : "—"),
          ])}
          empty="No runs yet. Run practice test shows Mynt's test against its sandbox; Run conformance tests the service once it is online."
        />
      </TableBox>
      <RunSheet
        run={open}
        service={service}
        onClose={() => setOpen(null)}
        onAction={(a) => {
          setOpen(null)
          onAction(a)
        }}
      />
    </div>
  )
}

// ---- Terms & pricing ----

export function TermsTab({ service, onAction }: { service: ServiceView; onAction: (a: ServiceAction) => void }) {
  const t = service.terms.current
  const versions = service.terms.versions
  return (
    <div className="flex flex-col gap-4" data-service-terms>
      <Card
        id="terms"
        title="Terms & pricing"
        subtitle="Builders subscribe by accepting your standard terms. Anything changed is a new version; agreements already made keep the version they accepted."
        fields={[
          ["Current version", t ? `v${t.version}` : "None yet"],
          ["Scope", t ? t.scopeLabel : "None yet"],
          ["Price", priceWords(service.offering.price)],
          ["Pricing in words", t?.pricing || "Not stated"],
        ]}
        actions={<ActionButton action="terms" onAction={onAction} primary={!t} disabled={service.archived} />}
      />
      <TableBox id="terms-versions">
        <AdminTable
          head={["Version", "Scope", "Summary", "Pricing", "Set on", "Set by", "Document"]}
          rowKeys={versions.map((v) => `v${v.version}`)}
          rows={versions.map((v) => [
            `v${v.version}${v.current ? " (current)" : ""}`,
            v.scopes === null ? "Not kept" : scopeLabelOf(v.scopes),
            <span key="s" className="block min-w-48 whitespace-normal">{v.summary ?? "Not kept"}</span>,
            v.pricing ?? "Not kept",
            when(v.setAt),
            v.setBy ?? "—",
            v.documentUrl ? (
              <a key="d" href={v.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4">
                Read <ExternalLink className="size-3" />
              </a>
            ) : (
              "Not kept"
            ),
          ])}
          empty="No standard terms yet. Set them so builders can subscribe from the Marketplace."
        />
      </TableBox>
    </div>
  )
}

// ---- Subscribers ----

export function SubscribersTab({ service }: { service: ServiceView }) {
  const subs = service.subscribers
  return (
    <div className="flex flex-col gap-4" data-service-subscribers>
      <Card
        id="subscribers"
        title="Subscribers"
        subtitle="The firms and apps that plugged this service in, with the terms version each accepted."
        fields={[
          ["Subscriptions", String(new Set(subs.map((s) => s.subscriptionId)).size)],
          ["Live", String(new Set(subs.filter((s) => s.environment === "Live").map((s) => s.subscriptionId)).size)],
        ]}
      />
      <TableBox id="subscribers">
        <AdminTable
          head={["Firm", "App", "Terms version accepted", "Since", "Live / sandbox", "Agreement status"]}
          rowKeys={subs.map((s, i) => `${s.subscriptionId}:${i}`)}
          rows={subs.map((s) => [
            s.firm,
            s.appName ?? "Not named",
            s.termsVersion === null ? "Before standard terms" : `v${s.termsVersion}`,
            when(s.since),
            <span key="e" data-environment={s.environment}>
              {s.environment}
            </span>,
            s.agreementStatus ? s.agreementStatus.replace(/_/g, " ") : s.subscriptionStatus === "active" ? "No agreement recorded" : "Ended",
          ])}
          empty="No subscribers yet. Builders subscribe from the Marketplace once the service is in Production with standard terms."
        />
      </TableBox>
    </div>
  )
}

// ---- Reliability ----

function MeasuredFact({ m, format }: { m: ServiceView["reliability"]["calls"]; format?: (n: number) => string }) {
  return <span data-measured={m.value === null ? "no" : "yes"}>{measuredWords(m, format)}</span>
}

export function ReliabilityTab({ service }: { service: ServiceView }) {
  const r = service.reliability
  const last = r.responseTimeMs.inLastConformanceRun
  return (
    <div className="flex flex-col gap-4" data-service-reliability>
      <Card
        id="reliability"
        title="Reliability"
        subtitle={`From Mynt's own records of calls to the service, over the last ${r.windowDays} days. What Mynt doesn't record says so.`}
        fields={[
          ["Calls", <MeasuredFact key="c" m={r.calls} />],
          ["Error rate", <MeasuredFact key="e" m={r.errorRate} format={percent} />],
          ["Response time", <MeasuredFact key="t" m={r.responseTimeMs} format={(n) => `${n} ms`} />],
          [
            "In Mynt's last conformance run",
            last && last.median !== null ? `Median ${last.median} ms${last.max !== null ? `, slowest ${last.max} ms` : ""}${last.requests !== null ? ` over ${last.requests} requests` : ""}${last.at ? ` (${when(last.at)})` : ""}` : `${NOT_MEASURED}: no conformance run has timed it`,
          ],
        ]}
      />
      <TableBox id="by-day" title="Calls by day">
        <AdminTable
          head={["Day", "Live / sandbox", "Calls", "Errors", "Error rate"]}
          rowKeys={r.byDay.map((d) => `${d.day}:${d.environment}`)}
          rows={r.byDay.map((d) => [d.day, d.environment, String(d.calls), String(d.errors), d.errorRate === null ? NOT_MEASURED : percent(d.errorRate)])}
          empty={r.calls.value === null ? `${NOT_MEASURED}: ${r.calls.notMeasured}` : "No calls in this window."}
        />
      </TableBox>
      <TableBox id="incidents" title="Incidents">
        <AdminTable head={["When", "What"]} rowKeys={r.incidents.map((i, n) => `${i.at}:${n}`)} rows={r.incidents.map((i) => [when(i.at), <span key="w" className="whitespace-normal">{i.what}</span>])} empty={`No incidents in the last ${r.windowDays} days.`} />
      </TableBox>
    </div>
  )
}

// ---- Activity ----

export function ActivityTab({ service }: { service: ServiceView }) {
  return (
    <div className="flex flex-col gap-4" data-service-activity>
      <TableBox id="activity">
        <AdminTable
          head={["When", "What", "Detail", "By"]}
          rowKeys={service.activity.map((a, i) => `${a.at}:${i}`)}
          rows={service.activity.map((a) => [when(a.at), a.what, a.detail || "—", a.by ?? "Not recorded"])}
          empty="Nothing has happened to this service yet."
        />
      </TableBox>
    </div>
  )
}

/** One tab's content (Security & risk is the app's own component, keyed by the service's id: components/app-panel-tabs.tsx). */
export function ServiceTabBody({ tab, service, onAction }: { tab: Exclude<ServiceTab, "security">; service: ServiceView; onAction: (a: ServiceAction) => void }) {
  if (tab === "overview") return <ServiceOverview service={service} onAction={onAction} />
  if (tab === "contract") return <ContractTab service={service} />
  if (tab === "conformance") return <ConformanceTab service={service} onAction={onAction} />
  if (tab === "terms") return <TermsTab service={service} onAction={onAction} />
  if (tab === "subscribers") return <SubscribersTab service={service} />
  if (tab === "reliability") return <ReliabilityTab service={service} />
  return <ActivityTab service={service} />
}

// ---- the page ----

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; service: ServiceView }

function useService(serviceId: string) {
  const [state, setState] = useState<Loaded>({ kind: "loading" })
  const inFlight = useRef(false)
  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch(`/api/services/${encodeURIComponent(serviceId)}`, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { service?: ServiceView; supported?: boolean; message?: string } | null
      if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
      if (res?.ok && body?.service) setState({ kind: "ready", service: body.service })
      // What's on screen stays through a failed refresh; only a first load that fails says so.
      else setState((s) => (s.kind === "ready" ? s : { kind: "error", message: body?.supported === false ? "Services come with Mynt's next update." : (body?.message ?? "Couldn't reach Mynt. Please try again.") }))
    } finally {
      inFlight.current = false
    }
  }, [serviceId])
  useEffect(() => {
    void load()
    const again = () => void load()
    const timer = window.setInterval(() => document.visibilityState === "visible" && void load(), LIVE_INTERVAL_MS)
    // A build that ships, a deploy and a move between stages all announce themselves this way.
    window.addEventListener("adorable:projects-updated", again)
    document.addEventListener("visibilitychange", again)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("adorable:projects-updated", again)
      document.removeEventListener("visibilitychange", again)
    }
  }, [load])
  return { state, reload: load }
}

/** The service's builds: its builder chat's conversations (its id is an app id for list_builds). */
function useServiceBuilds(serviceId: string) {
  const [builds, setBuilds] = useState<ProjectItem["conversations"]>([])
  useEffect(() => {
    let live = true
    const load = async () => {
      const res = await fetch("/api/projects", { cache: "no-store" }).catch(() => null)
      const data = res?.ok ? ((await res.json().catch(() => null)) as { services?: ProjectItem[] } | null) : null
      if (live) setBuilds(data?.services?.find((s) => s.id === serviceId)?.conversations ?? [])
    }
    void load()
    const again = () => void load()
    window.addEventListener("adorable:projects-updated", again)
    return () => {
      live = false
      window.removeEventListener("adorable:projects-updated", again)
    }
  }, [serviceId])
  return builds
}

export function ServiceWorkspace({ serviceId, children, isMobile: forcedMobile }: { serviceId: string; children: React.ReactNode; isMobile?: boolean }) {
  const router = useRouter()
  const detected = useIsMobile()
  const isMobile = forcedMobile ?? detected
  const { state, reload } = useService(serviceId)
  const service = state.kind === "ready" ? state.service : null
  const builds = useServiceBuilds(serviceId)
  const [tab, setTab] = useState<ServiceTab>("overview")
  const [mobileView, setMobileView] = useState<"chat" | "panel">("chat")
  const [sheet, setSheet] = useState<"practice" | "conformance" | "terms" | "archive" | "restore" | null>(null)
  const [dirty, setDirty] = useState(false)
  const [sheetOffering, setSheetOffering] = useState<VendorOffering | null>(null)

  // The tab a link names (/services/<id>?tab=conformance, from search), and the chat's slash commands (/contract, …).
  useEffect(() => {
    const asked = new URLSearchParams(window.location.search).get("tab")
    if (isServiceTab(asked)) setTab(asked)
  }, [serviceId])
  useEffect(() => {
    const onPanelTab = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string | null; tab?: unknown }>).detail
      if (!detail || !isServiceTab(detail.tab) || (detail.projectId && detail.projectId !== serviceId)) return
      setTab(detail.tab)
      setMobileView("panel")
    }
    window.addEventListener(PANEL_TAB_EVENT, onPanelTab)
    return () => window.removeEventListener(PANEL_TAB_EVENT, onPanelTab)
  }, [serviceId])

  const onAction = useCallback(
    (a: ServiceAction) => {
      if (a === "online") return void window.dispatchEvent(new CustomEvent(PUT_ONLINE_EVENT, { detail: { projectId: serviceId } }))
      if (a === "production") return void window.dispatchEvent(new CustomEvent(OPEN_PROMOTION_EVENT, { detail: { appId: serviceId } }))
      if (a === "builder") {
        // Into the service's builder chat, as the user's own message.
        if (service) window.dispatchEvent(new CustomEvent(BUILDER_MESSAGE_EVENT, { detail: { projectId: serviceId, text: builderEndpointMessage(service.serviceType.name) } }))
        return setMobileView("chat")
      }
      // The sheet keeps the service as it was when opened: a refresh behind it never resets what's being typed.
      setSheetOffering(service ? offeringForSheets(service) : null)
      setSheet(a)
    },
    [serviceId, service],
  )
  const closeSheet = () => {
    setSheet(null)
    if (dirty) {
      void reload()
      // The sidebar's folders and My services follow an archive or a restore.
      window.dispatchEvent(new Event("adorable:projects-updated"))
    }
    setDirty(false)
  }
  const offering = sheetOffering
  const conversations = useMemo(
    () => ({ projectId: serviceId, conversations: builds, onSelectConversation: (buildId: string) => router.push(serviceHref(serviceId, buildId)) }),
    [serviceId, builds, router],
  )

  const body = (t: ServiceTab) =>
    t === "security" ? (
      // The app's own Security & risk, keyed by the service's id: its risk register and infosec, without an app's signals.
      <AppInfoTab key={`${serviceId}:security`} appId={serviceId} tab="security" active={tab === "security" && (!isMobile || mobileView === "panel")} signals={false} />
    ) : (
      <div className="flex h-full flex-col" data-service-tab={t}>
        <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b px-3 text-xs text-muted-foreground">
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void reload()}>
            <RefreshCw /> Refresh
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {state.kind === "loading" && (
            <div className="flex flex-col gap-4" data-loading>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-48 w-full" />
            </div>
          )}
          {state.kind === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}
          {service && <ServiceTabBody tab={t} service={service} onAction={onAction} />}
        </div>
      </div>
    )

  return (
    <ProjectConversationsProvider value={conversations}>
      <ChatWorkspaceShell
        topBar={<ServiceHeader service={service} error={state.kind === "error" ? state.message : null} onAction={onAction} onBack={() => router.push("/new?type=service")} isMobile={isMobile} />}
        chat={children}
        showPanel
        tabs={SERVICE_TABS.map((t) => ({ id: t, label: SERVICE_TAB_LABELS[t], content: body(t) }))}
        tab={tab}
        onTab={(id) => isServiceTab(id) && setTab(id)}
        isMobile={isMobile}
        mobileView={mobileView}
        onMobileView={setMobileView}
      />
      <TermsSheet offering={sheet === "terms" ? offering : null} onClose={closeSheet} onDone={() => setDirty(true)} />
      <PracticeSheet offering={sheet === "practice" ? offering : null} onClose={closeSheet} onDone={() => setDirty(true)} />
      <ConformanceSheet offering={sheet === "conformance" ? offering : null} onClose={closeSheet} onDone={() => setDirty(true)} hosted />
      <ServiceArchiveSheet service={service} mode={sheet === "archive" || sheet === "restore" ? sheet : null} onClose={closeSheet} onDone={() => setDirty(true)} />
    </ProjectConversationsProvider>
  )
}
