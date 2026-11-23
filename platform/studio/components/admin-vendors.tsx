"use client"

// Admin → Vendors: the standard service types admins define per region (list_service_types), with Add service type
// (define_service_type: its input and output contracts as JSON Schemas, the consent it needs, whether it moves
// money), and every vendor's offering of them whatever its status (list_vendor_offerings), with its last conformance
// result and Suspend offering / Reinstate offering (suspend_vendor_offering). Changing an existing service type, and
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
import { conformanceWords, csvOf, dateOf, words, type AdminOffering, type ServiceTypeRow } from "@/lib/admin"
import { categoryLabel } from "@/lib/marketplace"
import { SERVICE_CATEGORIES } from "@/lib/studio-tools"

type View = "types" | "offerings"
export type VendorsData = { serviceTypes: ServiceTypeRow[]; offerings: AdminOffering[] }
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

export function AddServiceTypeSheet({ open, onClose, onDone, fetcher }: { open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [f, setF] = useState({ region: "US", key: "", name: "", category: "identity", description: "", consent: "", fills: "", innovatorLicences: "", vendorLicences: "", movesMoney: false, input: EMPTY_SCHEMA, output: EMPTY_SCHEMA })
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (open) {
      reset()
      setInvalid(null)
    }
  }, [open, reset])
  const set = (patch: Partial<typeof f>) => setF((x) => ({ ...x, ...patch }))
  return (
    <AdminSheet id="add-service-type" open={open} onClose={onClose} title="Add service type" description="A new standard service vendors can offer in a region: the contract every vendor implements, and the consent it needs." error={invalid ?? error} result={result}>
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
  const paged = view === "types" ? typesPaged : offeringsPaged
  const facets = [
    { id: "region", label: "Region", options: regions.map((r) => ({ value: r, label: r })), selected: region, onChange: (v: string[]) => setRegion(v) },
    { id: "category", label: "Category", options: SERVICE_CATEGORIES.map((c) => ({ value: c, label: categoryLabel(c) })), selected: category, onChange: (v: string[]) => setCategory(v) },
    ...(view === "offerings" ? [{ id: "status", label: "Status", options: ["draft", "listed", "suspended"].map((s) => ({ value: s, label: words(s) })), selected: status, onChange: (v: string[]) => setStatus(v) }] : []),
  ]
  const exportCsv = () =>
    view === "types"
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
      </TabList>
      <AdminList
        id={view === "types" ? "service-types" : "offerings"}
        search={query}
        onSearch={setQuery}
        searchLabel={view === "types" ? "Search service types by name, key or consent" : "Search offerings by name, vendor or service"}
        facets={facets}
        onClearFilters={() => (setRegion([]), setCategory([]), setStatus([]))}
        onExport={exportCsv}
        exportDisabled={view === "types" ? !types.length : !offerings.length}
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
        total={view === "types" ? types.length : offerings.length}
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
      <AddServiceTypeSheet open={adding} onClose={closeSheet} onDone={() => setDirty(true)} />
      <SuspendOfferingSheet offering={acting} onClose={closeSheet} onDone={() => setDirty(true)} />
    </div>
  )
}

export function VendorsTab() {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.serviceTypes) && Array.isArray(b.offerings) ? ({ serviceTypes: b.serviceTypes, offerings: b.offerings } as VendorsData) : undefined), [])
  const { state, reload } = useAdminData("/api/admin/vendors", pick)
  return state.kind === "ready" ? <VendorsView data={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="Vendors" />
}
