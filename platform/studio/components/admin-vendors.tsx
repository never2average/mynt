"use client"

// Admin → Vendors: the standard service types admins define per region (list_service_types), with Add service type
// (define_service_type: its input and output contracts as JSON Schemas, the consent it needs, whether it moves
// money), and every vendor's offering of them whatever its status (list_vendor_offerings), with its last conformance
// result and Suspend offering / Reinstate offering (suspend_vendor_offering), and each vendor firm's onboarding progress
// (Vendor firms: get_vendor_onboarding's all_firms, read only). Changing an existing service type, and
// its advanced fields (fixtures, what a device is told, params, quotes), stay with the MCP tool. Server-renderable.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Ban, Plus, RotateCcw } from "lucide-react"

import { AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tab, TabList } from "@/components/ui/tabs"
import { NotAvailableYet } from "@/components/not-available"
import { conformanceWords, csvOf, dateOf, onboardingWords, words, type AdminOffering, type ServiceTypeRow, type VendorFirmRow } from "@/lib/admin"
import { categoryLabel } from "@/lib/marketplace"
import { SERVICE_CATEGORIES } from "@/lib/studio-tools"
import { TypeRequestsTable } from "@/components/build-type"
import { keyFromName, schemaFromExample, type ServiceTypeRequest } from "@/lib/services"

type View = "types" | "offerings" | "firms" | "requests"
// firms: each vendor firm's onboarding progress; null on a Mynt without get_vendor_onboarding.
// requests: the service types builders asked Mynt to define; absent on a Mynt without requests.
export type VendorsData = { serviceTypes: ServiceTypeRow[]; offerings: AdminOffering[]; firms?: VendorFirmRow[] | null; requests?: ServiceTypeRequest[] | null }
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
const EMPTY_SCHEMA = '{\n  "type": "object",\n  "properties": {}\n}'

/** The JSON Schema typed into a field, or why it isn't one (JSON only, an object). */
export function schemaOf(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const v = JSON.parse(text) as unknown
    return typeof v === "object" && v !== null && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false, error: "It must be a JSON object." }
  } catch {
    return { ok: false, error: "That isn't valid JSON." }
  }
}

const BLANK_TYPE = { region: "US", key: "", name: "", category: "identity", description: "", consent: "", fills: "", innovatorLicences: "", vendorLicences: "", movesMoney: false, input: EMPTY_SCHEMA, output: EMPTY_SCHEMA }
/** Define from request: the form filled from what was asked for (its name, region and what it does, a key from the
 * name, and the least a schema can say about each example), for the admin to edit before adding. */
export const typeFormFromRequest = (r: ServiceTypeRequest): typeof BLANK_TYPE => ({
  ...BLANK_TYPE,
  region: r.region,
  key: keyFromName(r.name),
  name: r.name,
  category: "other",
  description: r.whatItDoes,
  input: JSON.stringify(schemaFromExample(r.exampleInput), null, 2),
  output: JSON.stringify(schemaFromExample(r.exampleOutput), null, 2),
})

// `from`: the request this service type answers (Define from request). It is sent with the new type, so Mynt marks the
// request defined.
export function AddServiceTypeSheet({ open, onClose, onDone, fetcher, from = null }: { open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch; from?: ServiceTypeRequest | null }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [f, setF] = useState(() => (from ? typeFormFromRequest(from) : BLANK_TYPE))
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      reset()
      setInvalid(null)
      if (from) setF(typeFormFromRequest(from))
    }
  }, [open, reset, from])
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  return (
    <AdminSheet
      id="add-service-type"
      open={open}
      onClose={onClose}
      title={from ? "Define from request" : "Add service type"}
      description={
        from
          ? `${from.requestedBy ?? "A builder"}${from.firm ? ` at ${from.firm}` : ""} asked for this. The schemas below are the least their examples say: edit them into the contract every vendor implements.`
          : "A new standard service vendors can offer in a region: the contract every vendor implements, and the consent it needs."
      }
      error={invalid ?? error}
      result={result}
    >
      <form
        className="flex flex-col gap-3"
        data-service-type-form
        onSubmit={async (e) => {
          e.preventDefault()
          const input = schemaOf(f.input)
          const output = schemaOf(f.output)
          if (!input.ok) return setInvalid(`Input schema: ${input.error}`)
          if (!output.ok) return setInvalid(`Output schema: ${output.error}`)
          setInvalid(null)
          const r = await run("/api/admin/vendors/service-types", {
            service_type: {
              region: f.region.trim().toUpperCase(),
              key: f.key.trim(),
              name: f.name.trim(),
              category: f.category,
              ...(f.description.trim() ? { description: f.description.trim() } : {}),
              input_schema: input.value,
              output_schema: output.value,
              consent_purpose: f.consent.trim(),
              fills: list(f.fills),
              innovator_licences: list(f.innovatorLicences),
              vendor_licences: list(f.vendorLicences),
              moves_money: f.movesMoney,
            },
            ...(from ? { from_request: from.id } : {}),
          })
          if (r?.ok) onDone()
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Region" hint="Two letters, e.g. US">
            <Input value={f.region} onChange={(e) => set({ region: e.target.value })} maxLength={2} required data-type-region />
          </Field>
          <Field label="Category">
            <select className={fieldClass} value={f.category} onChange={(e) => set({ category: e.target.value })} data-type-category>
              {SERVICE_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Key" hint="Lower case with underscores; vendors serve it at /v1/<key>">
          <Input value={f.key} onChange={(e) => set({ key: e.target.value })} maxLength={60} pattern="[a-z][a-z0-9_]*" required data-type-key />
        </Field>
        <Field label="Name">
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} required data-type-name />
        </Field>
        <Field label="Description">
          <textarea className={`${fieldClass} min-h-16`} value={f.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} />
        </Field>
        <Field label="Consent purpose" hint="The consent the customer gives first, e.g. identity_verification">
          <Input value={f.consent} onChange={(e) => set({ consent: e.target.value })} maxLength={60} pattern="[a-z][a-z0-9_]*" required data-type-consent />
        </Field>
        <Field label="Fields its output fills" hint="Data dictionary fields, separated by commas">
          <Input value={f.fills} onChange={(e) => set({ fills: e.target.value })} />
        </Field>
        <Field label="Licences the subscribing firm must hold one of" hint="Licence type ids from the region's regulatory model; empty for none">
          <Input value={f.innovatorLicences} onChange={(e) => set({ innovatorLicences: e.target.value })} />
        </Field>
        <Field label="Licences the vendor must hold one of" hint="Empty for none">
          <Input value={f.vendorLicences} onChange={(e) => set({ vendorLicences: e.target.value })} />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.movesMoney} onChange={(e) => set({ movesMoney: e.target.checked })} data-type-moves-money />
          It instructs a money movement (then it runs only through an approved money rail)
        </label>
        <Field label="Input schema (JSON)">
          <textarea className={`${fieldClass} min-h-32 font-mono text-xs`} value={f.input} onChange={(e) => set({ input: e.target.value })} spellCheck={false} data-type-input />
        </Field>
        <Field label="Output schema (JSON)">
          <textarea className={`${fieldClass} min-h-32 font-mono text-xs`} value={f.output} onChange={(e) => set({ output: e.target.value })} spellCheck={false} data-type-output />
        </Field>
        <div>
          <Button type="submit" disabled={busy || !f.key.trim() || !f.name.trim() || !f.consent.trim() || result !== null} data-add-service-type-submit>
            {busy ? "Adding…" : "Add service type"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

export function SuspendOfferingSheet({ offering, onClose, onDone, fetcher }: { offering: AdminOffering | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [note, setNote] = useState("")
  useEffect(() => {
    reset()
    setNote("")
  }, [offering, reset])
  const suspend = offering?.status !== "suspended"
  return (
    <AdminSheet
      id="suspend-offering"
      open={offering !== null}
      onClose={onClose}
      title={suspend ? "Suspend offering" : "Reinstate offering"}
      description={
        suspend
          ? "It stops being listed or called at once. Products bound to it drift and pause new sales until it's reinstated."
          : "It goes back to draft, and is listed again once it passes Mynt's conformance test."
      }
      error={error}
      result={result}
    >
      {offering && (
        <form
          className="flex flex-col gap-3"
          data-suspend-offering-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(`/api/admin/vendors/offerings/${encodeURIComponent(offering.id)}`, { suspended: suspend, note: note.trim() })
            if (r?.ok) onDone()
          }}
        >
          <p className="text-sm">
            {offering.name} from {offering.vendor} ({offering.region} · {offering.serviceName})
          </p>
          <Field label="Why">
            <textarea className={`${fieldClass} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required data-suspend-note />
          </Field>
          <div>
            <Button type="submit" variant={suspend ? "destructive" : "default"} disabled={busy || note.trim().length < 3 || result !== null} data-suspend-submit={suspend ? "suspend" : "reinstate"}>
              {busy ? "Saving…" : suspend ? "Suspend offering" : "Reinstate offering"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

// ---- Requested service types ----

export function DeclineRequestSheet({ request, onClose, onDone, fetcher }: { request: ServiceTypeRequest | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [reason, setReason] = useState("")
  useEffect(() => {
    reset()
    setReason("")
  }, [request, reset])
  return (
    <AdminSheet id="decline-type-request" open={request !== null} onClose={onClose} title="Decline request" description="The requester reads your reason. To accept it instead, define the service type from the request." error={error} result={result}>
      {request && (
        <form
          className="flex flex-col gap-3"
          data-decline-request-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(`/api/admin/vendors/requests/${encodeURIComponent(request.id)}`, { reason: reason.trim() })
            if (r?.ok) onDone()
          }}
        >
          <p className="text-sm">
            {request.name} ({request.region}), asked for by {request.requestedBy ?? "a builder"}
            {request.firm ? ` at ${request.firm}` : ""}
          </p>
          <Field label="Reason">
            <textarea className={`${fieldClass} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} required data-decline-reason />
          </Field>
          <div>
            <Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 3 || result !== null} data-decline-request-submit>
              {busy ? "Saving…" : "Decline request"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

/** One request, opened from its row: what it does and its examples, with its two labelled actions while it waits. */
export function RequestSheet({ request, onClose, onDefine, onDecline }: { request: ServiceTypeRequest | null; onClose: () => void; onDefine: (r: ServiceTypeRequest) => void; onDecline: (r: ServiceTypeRequest) => void }) {
  return (
    <AdminSheet id="type-request" open={request !== null} onClose={onClose} title={request?.name ?? "Request"} description="A standard service type a builder asked Mynt to define.">
      {request && (
        <div className="flex flex-col gap-3 text-sm" data-type-request={request.id}>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2">
            {(
              [
                ["Region", request.region],
                ["Status", request.statusWords],
                ["Requested by", request.requestedBy ?? "Not known"],
                ["Firm", request.firm ?? "No firm"],
                ["Requested", dateOf(request.requestedAt)],
                ...(request.status === "defined" ? [["Defined as", request.serviceTypeKey ?? "Not recorded"]] : []),
                ...(request.status === "declined" ? [["Reason", request.decisionNote ?? "Not recorded"]] : []),
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>
          <div>
            <h3 className="text-xs text-muted-foreground">What it does</h3>
            <p className="whitespace-pre-wrap" data-request-what>
              {request.whatItDoes || "Not said"}
            </p>
          </div>
          <div>
            <h3 className="text-xs text-muted-foreground">Example input</h3>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs" data-request-example="input">
              {JSON.stringify(request.exampleInput, null, 2)}
            </pre>
          </div>
          <div>
            <h3 className="text-xs text-muted-foreground">Example output</h3>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs" data-request-example="output">
              {JSON.stringify(request.exampleOutput, null, 2)}
            </pre>
          </div>
          {request.status === "requested" && (
            <div className="flex flex-wrap gap-2" data-request-actions>
              <Button onClick={() => onDefine(request)} data-define-from-request>
                <Plus />
                Define from request
              </Button>
              <Button variant="outline" onClick={() => onDecline(request)} data-decline-request>
                <Ban />
                Decline
              </Button>
            </div>
          )}
        </div>
      )}
    </AdminSheet>
  )
}

export function RequestedTypes({ requests, onChanged = () => undefined, fetcher }: { requests: ServiceTypeRequest[]; onChanged?: () => void; fetcher?: typeof fetch }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string[]>([])
  const [open, setOpen] = useState<ServiceTypeRequest | null>(null)
  const [defining, setDefining] = useState<ServiceTypeRequest | null>(null)
  const [declining, setDeclining] = useState<ServiceTypeRequest | null>(null)
  const [dirty, setDirty] = useState(false)
  const rows = useMemo(() => requests.filter((r) => matches(query, r.name, r.region, r.firm, r.requestedBy, r.statusWords, r.whatItDoes) && (!status.length || status.includes(r.status))), [requests, query, status])
  const paged = usePaged(rows)
  const close = () => {
    setDefining(null)
    setDeclining(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  return (
    <>
      <AdminList
        id="type-requests"
        search={query}
        onSearch={setQuery}
        searchLabel="Search requests by name, region, firm or who asked"
        facets={[{ id: "status", label: "Status", options: [{ value: "requested", label: "Waiting for Mynt" }, { value: "defined", label: "Defined" }, { value: "declined", label: "Declined" }], selected: status, onChange: (v: string[]) => setStatus(v) }]}
        onClearFilters={() => setStatus([])}
        onExport={() => downloadCsv("requested-service-types.csv", csvOf(["Requested", "Name", "Region", "Firm", "Requested by", "Status"], rows.map((r) => [dateOf(r.requestedAt), r.name, r.region, r.firm ?? "", r.requestedBy ?? "", r.statusWords])))}
        exportDisabled={!rows.length}
        importable={false}
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        {requests.length && !rows.length ? <AdminTable head={["Requested", "Name", "Region", "Firm", "Requested by", "Status"]} rows={[]} empty="No requests match these filters." /> : <TypeRequestsTable admin requests={paged.shown} onOpen={setOpen} />}
      </AdminList>
      <RequestSheet
        request={open}
        onClose={() => setOpen(null)}
        onDefine={(r) => {
          setOpen(null)
          setDefining(r)
        }}
        onDecline={(r) => {
          setOpen(null)
          setDeclining(r)
        }}
      />
      <AddServiceTypeSheet open={defining !== null} from={defining} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <DeclineRequestSheet request={declining} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </>
  )
}

export function OfferingStatus({ status }: { status: string }) {
  return <StatusDot tone={status === "listed" ? "green" : status === "suspended" ? "red" : "gray"} label={words(status)} data-offering-status={status} />
}

export function VendorsView({ data, initialView = "types", onChanged = () => undefined, sheet = null }: { data: VendorsData; initialView?: View; onChanged?: () => void; sheet?: "add" | null }) {
  const [view, setView] = useState<View>(initialView)
  const [query, setQuery] = useState("")
  const [region, setRegion] = useState<string[]>([])
  const [category, setCategory] = useState<string[]>([])
  const [status, setStatus] = useState<string[]>([])
  const [adding, setAdding] = useState(sheet === "add")
  const [acting, setActing] = useState<AdminOffering | null>(null)
  const [dirty, setDirty] = useState(false)
  const closeSheet = () => {
    setAdding(false)
    setActing(null)
    if (dirty) onChanged()
  }
  const regions = useMemo(() => [...new Set([...data.serviceTypes.map((t) => t.region), ...data.offerings.map((o) => o.region)])].sort(), [data])
  const types = useMemo(() => data.serviceTypes.filter((t) => matches(query, t.name, t.key, t.description, t.consentPurpose) && (!region.length || region.includes(t.region)) && (!category.length || category.includes(t.category))), [data, query, region, category])
  const offerings = useMemo(
    () => data.offerings.filter((o) => matches(query, o.name, o.vendor, o.serviceName, o.serviceKey) && (!region.length || region.includes(o.region)) && (!category.length || category.includes(o.category)) && (!status.length || status.includes(o.status))),
    [data, query, region, category, status],
  )
  const typesPaged = usePaged(types)
  const offeringsPaged = usePaged(offerings)
  const firms = useMemo(() => (data.firms ?? []).filter((f) => matches(query, f.name, f.next?.title, f.status)), [data.firms, query])
  const firmsPaged = usePaged(firms)
  const paged = view === "types" ? typesPaged : view === "offerings" ? offeringsPaged : firmsPaged
  const facets = [
    { id: "region", label: "Region", options: regions.map((r) => ({ value: r, label: r })), selected: region, onChange: (v: string[]) => setRegion(v) },
    { id: "category", label: "Category", options: SERVICE_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })), selected: category, onChange: (v: string[]) => setCategory(v) },
    ...(view === "offerings" ? [{ id: "status", label: "Status", options: ["draft", "listed", "suspended"].map((s) => ({ value: s, label: words(s) })), selected: status, onChange: (v: string[]) => setStatus(v) }] : []),
  ]
  const exportCsv = () =>
    view === "firms"
      ? downloadCsv("vendor-firms.csv", csvOf(["Firm", "Status", "Vendor people", "Services", "Listed", "Onboarding", "Next step"], firms.map((f) => [f.name, f.status, numberWords(f.vendorMembers), numberWords(f.services), numberWords(f.listed), onboardingWords(f), nextWords(f)])))
      : view === "types"
      ? downloadCsv("service-types.csv", csvOf(["Region", "Key", "Name", "Category", "Consent purpose", "Moves money", "Fills", "Updated"], types.map((t) => [t.region, t.key, t.name, t.category, t.consentPurpose, t.movesMoney ? "yes" : "no", t.fills.join(" "), dateOf(t.updatedAt)])))
      : downloadCsv("offerings.csv", csvOf(["Offering", "Vendor", "Region", "Service", "Status", "Conformance", "Live"], offerings.map((o) => [o.name, o.vendor, o.region, o.serviceKey, o.status, conformanceWords(o.conformance), o.liveAvailable ? "yes" : "no"])))
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-admin-vendors data-view={view}>
      <TabList aria-label="Vendors">
        <Tab selected={view === "types"} onClick={() => setView("types")} data-vendors-view="types">
          Service types
        </Tab>
        <Tab selected={view === "offerings"} onClick={() => setView("offerings")} data-vendors-view="offerings">
          Offerings
        </Tab>
        <Tab selected={view === "firms"} onClick={() => setView("firms")} data-vendors-view="firms">
          Vendor firms
        </Tab>
        <Tab selected={view === "requests"} onClick={() => setView("requests")} data-vendors-view="requests">
          Requested service types
        </Tab>
      </TabList>
      {view === "requests" ? (
        data.requests ? (
          <RequestedTypes requests={data.requests} onChanged={onChanged} />
        ) : (
          <NotAvailableYet what="Requested service types" />
        )
      ) : view === "firms" && data.firms === null ? (
        <NotAvailableYet what="Vendor firms' onboarding" />
      ) : (
      <AdminList
        id={view === "types" ? "service-types" : view === "offerings" ? "offerings" : "vendor-firms"}
        search={query}
        onSearch={setQuery}
        searchLabel={view === "types" ? "Search service types by name, key or consent" : view === "offerings" ? "Search offerings by name, vendor or service" : "Search vendor firms by name or next step"}
        facets={view === "firms" ? [] : facets}
        onClearFilters={() => (setRegion([]), setCategory([]), setStatus([]))}
        onExport={exportCsv}
        exportDisabled={view === "types" ? !types.length : view === "offerings" ? !offerings.length : !firms.length}
        cta={
          view === "types" ? (
            <Button onClick={() => setAdding(true)} data-add-service-type>
              <Plus />
              Add service type
            </Button>
          ) : null
        }
        page={paged.page}
        pages={paged.pages}
        total={view === "types" ? types.length : view === "offerings" ? offerings.length : firms.length}
        onPage={paged.setPage}
      >
        {view === "types" ? (
          <AdminTable
            head={["Service type", "Region", "Category", "Consent purpose", "Moves money", "Updated"]}
            rowKeys={typesPaged.shown.map((t) => `${t.region}/${t.key}`)}
            rows={typesPaged.shown.map((t) => [
              <span key="n" className="flex flex-col">
                {t.name}
                <code className="text-xs text-muted-foreground">{t.key}</code>
              </span>,
              t.region,
              categoryLabel(t.category),
              t.consentPurpose,
              t.movesMoney ? "Yes" : "No",
              dateOf(t.updatedAt),
            ])}
            empty={data.serviceTypes.length ? "No service types match these filters." : "No service types yet. Add the first one."}
          />
        ) : view === "firms" ? (
          <AdminTable
            head={["Firm", "Status", "Vendor people", "Services", "Listed", "Onboarding", "Next step"]}
            rowKeys={firmsPaged.shown.map((f) => f.entityId)}
            rows={firmsPaged.shown.map((f) => [
              f.name,
              words(f.status),
              numberWords(f.vendorMembers),
              numberWords(f.services),
              numberWords(f.listed),
              <span key="o" data-onboarding={f.complete ? "complete" : "in-progress"}>
                {onboardingWords(f)}
              </span>,
              nextWords(f),
            ])}
            empty={(data.firms ?? []).length ? "No vendor firms match this search." : "No vendor firms yet. Register one and invite its people with the vendor role."}
          />
        ) : (
          <AdminTable
            head={["Offering", "Vendor", "Region", "Service", "Status", "Conformance", ""]}
            rowKeys={offeringsPaged.shown.map((o) => o.id)}
            rows={offeringsPaged.shown.map((o) => [
              o.name,
              o.vendor,
              o.region,
              o.serviceName,
              <OfferingStatus key="s" status={o.status} />,
              conformanceWords(o.conformance),
              <span key="a" className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setActing(o)} data-offering-action={o.status === "suspended" ? "reinstate" : "suspend"}>
                  {o.status === "suspended" ? <RotateCcw /> : <Ban />}
                  {o.status === "suspended" ? "Reinstate offering" : "Suspend offering"}
                </Button>
              </span>,
            ])}
            empty={data.offerings.length ? "No offerings match these filters." : "No vendor offers a standard service yet."}
          />
        )}
      </AdminList>
      )}
      <AddServiceTypeSheet open={adding} onClose={closeSheet} onDone={() => setDirty(true)} />
      <SuspendOfferingSheet offering={acting} onClose={closeSheet} onDone={() => setDirty(true)} />
    </div>
  )
}

const numberWords = (n: number | null) => (n === null ? "Not known" : String(n))
// The next step, and whether it waits on Mynt (an admin) rather than on the vendor.
const nextWords = (f: VendorFirmRow) => (f.next ? `${f.next.title}${f.next.waitingOnMynt ? " (waiting for Mynt)" : ""}` : f.complete ? "Nothing: listed" : "—")

export function VendorsTab() {
  const pick = useCallback(
    (b: Record<string, unknown>) =>
      Array.isArray(b.serviceTypes) && Array.isArray(b.offerings) ? ({ serviceTypes: b.serviceTypes, offerings: b.offerings, firms: Array.isArray(b.firms) ? b.firms : null, ...(Array.isArray(b.requests) ? { requests: b.requests } : {}) } as VendorsData) : undefined,
    [],
  )
  const { state, reload } = useAdminData("/api/admin/vendors", pick)
  return state.kind === "ready" ? <VendorsView data={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="Vendors" />
}
