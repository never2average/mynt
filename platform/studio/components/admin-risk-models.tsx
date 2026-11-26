"use client"

// Admin → Risk models (/platform/risk-models; lib/risk-models.ts, /api/admin/risk-models), one tab per risk area
// (components/risk-area-tabs.tsx). Each tab is ONE table filling the page, under the list toolbar: Mynt's own risk
// models in that area (name, status in words, health in words: Healthy, Validation overdue, Last validation failed or
// No validation yet; owner, version, last validated, next validation due with "overdue" in words, and how many risks
// link to it) with a labelled Add risk model; a row opens /platform/risk-models/<id>: its metadata card (the facts
// Status · Health · Risk area · Owner · Version · Last validated · Next validation due · Linked risks) with Edit model
// (a change to what it is is a new version), Record validation and Retire model, each a labelled button opening its
// sheet, then the tabs Definition (method, inputs, outputs and thresholds, each a table), Validations, Linked risks
// (the risks on registers that link to it, each opening its page, with a labelled Link risk) and Versions.
// On the Regulated product risk tab the same table also holds, read-only, the risk models financial products declare
// in their own definitions, with a Source column ("Mynt model" / "Product: <name> (<firm>)", linked to the firm's
// Products tab) and a Type column. What Mynt can't answer is one table row, "Not available." with why.
// Server-renderable.
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Archive, ClipboardCheck, ExternalLink, Link2, Pencil, Plus } from "lucide-react"

import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { RiskAreaTabs, useAreaInAddress } from "@/components/risk-area-tabs"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { adminHref, csvOf } from "@/lib/admin"
import { RISK_AREA_LABELS, RISK_AREAS, type RiskArea } from "@/lib/risk-register"
import {
  dueWords,
  healthWords,
  lastValidatedWords,
  LINKED_RISK_HEAD,
  linkedRiskCells,
  linkedWords,
  modelFacts,
  listOf,
  listText,
  MODEL_OUTCOME_LABELS,
  MODEL_OUTCOMES,
  MODEL_STATUS_LABELS,
  MODEL_STATUSES,
  ownerWords,
  statusWords,
  thresholdsForMynt,
  type ModelDetail,
  type ModelList,
  type ModelOutcome,

  type ProductRiskModels,
  type RiskModel,
} from "@/lib/risk-models"

type Owner = { userId: string; name: string }
export type RiskModelsData = { area: RiskArea; models: ModelList; owners: Owner[]; productModels: ProductRiskModels | null }
// riskChoices: Mynt's own risks Link risk can pick (null: this Mynt can't list them).
export type RiskModelDetailData = { detail: ModelDetail; owners: Owner[]; riskChoices?: { id: string; title: string }[] | null }
const routeOf = (id?: string) => (id ? `/api/admin/risk-models/${encodeURIComponent(id)}` : "/api/admin/risk-models")

// ---- the sheets ----

type DefinitionDraft = { name: string; purpose: string; method: string; inputs: string; outputs: string; thresholds: string }
const draftOf = (m: RiskModel | null): DefinitionDraft => ({
  name: m?.name ?? "",
  purpose: m?.purpose ?? "",
  method: m?.method ?? "",
  inputs: m ? listText(m.inputs) : "",
  outputs: m ? listText(m.outputs) : "",
  thresholds: m ? listText(m.thresholds) : "",
})
const INPUTS_HINT = 'JSON: a list like [{ "name": "liquid_assets", "source": "pool ledger" }]'
const OUTPUTS_HINT = 'JSON: a list like [{ "name": "coverage_ratio", "description": "…" }]'
const THRESHOLDS_HINT = 'JSON: a list like [{ "name": "minimum", "value": 1.2, "meaning": "Below it, new commitments pause" }]'

/** The definition's fields, read into what Mynt takes; the first list that isn't one is the error. */
function definitionOf(d: DefinitionDraft): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const inputs = listOf(d.inputs, "Inputs")
  if (!inputs.ok) return inputs
  const outputs = listOf(d.outputs, "Outputs")
  if (!outputs.ok) return outputs
  const thresholds = listOf(d.thresholds, "Thresholds")
  if (!thresholds.ok) return thresholds
  return { ok: true, value: { name: d.name.trim(), purpose: d.purpose.trim(), method: d.method.trim(), inputs: inputs.value, outputs: outputs.value, thresholds: thresholdsForMynt(thresholds.value) } }
}

function DefinitionFields({ d, set }: { d: DefinitionDraft; set: (p: Partial<DefinitionDraft>) => void }) {
  return (
    <>
      <Field label="Name">
        <Input value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} required data-model-field="name" />
      </Field>
      <Field label="Purpose" hint="What the model is for.">
        <textarea className={`${fieldClass} min-h-16`} value={d.purpose} onChange={(e) => set({ purpose: e.target.value })} maxLength={4000} required data-model-field="purpose" />
      </Field>
      <Field label="Method" hint="The formula or approach, in words.">
        <textarea className={`${fieldClass} min-h-20`} value={d.method} onChange={(e) => set({ method: e.target.value })} maxLength={8000} required data-model-field="method" />
      </Field>
      <Field label="Inputs" hint={INPUTS_HINT}>
        <textarea className={`${fieldClass} min-h-20 font-mono text-xs`} value={d.inputs} onChange={(e) => set({ inputs: e.target.value })} data-model-field="inputs" />
      </Field>
      <Field label="Outputs (scores or measures)" hint={OUTPUTS_HINT}>
        <textarea className={`${fieldClass} min-h-20 font-mono text-xs`} value={d.outputs} onChange={(e) => set({ outputs: e.target.value })} data-model-field="outputs" />
      </Field>
      <Field label="Thresholds" hint={THRESHOLDS_HINT}>
        <textarea className={`${fieldClass} min-h-20 font-mono text-xs`} value={d.thresholds} onChange={(e) => set({ thresholds: e.target.value })} data-model-field="thresholds" />
      </Field>
    </>
  )
}

function OwnerField({ owners, value, onChange, keep }: { owners: Owner[]; value: string; onChange: (v: string) => void; keep: string }) {
  if (!owners.length) return null
  return (
    <Field label="Owner">
      <select className={fieldClass} value={value} onChange={(e) => onChange(e.target.value)} data-model-field="owner">
        <option value="">{keep}</option>
        {owners.map((o) => (
          <option key={o.userId} value={o.userId}>
            {o.name}
          </option>
        ))}
      </select>
    </Field>
  )
}

function StatusField({ value, onChange }: { value: "draft" | "active"; onChange: (v: "draft" | "active") => void }) {
  return (
    <Field label="Status">
      <select className={fieldClass} value={value} onChange={(e) => onChange(e.target.value as "draft" | "active")} data-model-field="status">
        <option value="draft">{MODEL_STATUS_LABELS.draft}</option>
        <option value="active">{MODEL_STATUS_LABELS.active}</option>
      </select>
    </Field>
  )
}

function Submit({ busy, disabled, label, name }: { busy: boolean; disabled: boolean; label: string; name: string }) {
  return (
    <div>
      <Button type="submit" disabled={busy || disabled} data-model-submit={name}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  )
}

export function AddRiskModelSheet({ area, owners, open, onClose, onDone, fetcher }: { area: RiskArea; owners: Owner[]; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [d, setD] = useState<DefinitionDraft>(draftOf(null))
  const [riskArea, setRiskArea] = useState<RiskArea>(area)
  const [owner, setOwner] = useState("")
  const [status, setStatus] = useState<"draft" | "active">("draft")
  const [due, setDue] = useState("")
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
    setD(draftOf(null))
    setRiskArea(area)
    setOwner("")
    setStatus("draft")
    setDue("")
  }, [open, area, reset])
  return (
    <AdminSheet id="add-risk-model" open={open} onClose={onClose} title="Add risk model" description="One of Mynt's own risk models: what it measures and how, its inputs, outputs and thresholds, who owns it and when it's first validated. It starts at version 1; every change is audited." error={invalid ?? error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-add-risk-model-form
        onSubmit={async (e) => {
          e.preventDefault()
          const def = definitionOf(d)
          if (!def.ok) return setInvalid(def.error)
          setInvalid(null)
          const r = await run(routeOf(), { risk_area: riskArea, ...def.value, status, ...(owner ? { owner_user_id: owner } : {}), ...(due ? { next_validation_due: due } : {}) })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Risk area">
          <select className={fieldClass} value={riskArea} onChange={(e) => setRiskArea(e.target.value as RiskArea)} data-model-field="risk_area">
            {RISK_AREAS.map((a) => (
              <option key={a} value={a}>
                {RISK_AREA_LABELS[a]}
              </option>
            ))}
          </select>
        </Field>
        <DefinitionFields d={d} set={(p) => setD((x) => ({ ...x, ...p }))} />
        <OwnerField owners={owners} value={owner} onChange={setOwner} keep="You" />
        <StatusField value={status} onChange={setStatus} />
        <Field label="First validation due (optional)">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} data-model-field="next_validation_due" />
        </Field>
        {result === null && <Submit busy={busy} disabled={d.name.trim().length < 3 || d.purpose.trim().length < 3 || d.method.trim().length < 3} label="Add risk model" name="add" />}
      </form>
    </AdminSheet>
  )
}

export function EditRiskModelSheet({ model, owners, open, onClose, onDone, fetcher }: { model: RiskModel; owners: Owner[]; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [d, setD] = useState<DefinitionDraft>(draftOf(model))
  const [owner, setOwner] = useState("")
  const [status, setStatus] = useState<"draft" | "active">(model.status === "active" ? "active" : "draft")
  const [due, setDue] = useState(model.nextValidationDue ?? "")
  const [note, setNote] = useState("")
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
    setD(draftOf(model))
    setOwner("")
    setStatus(model.status === "active" ? "active" : "draft")
    setDue(model.nextValidationDue ?? "")
    setNote("")
  }, [open, model, reset])
  return (
    <AdminSheet id="edit-risk-model" open={open} onClose={onClose} title="Edit model" description={`A change to what it is (name, purpose, method, inputs, outputs, thresholds) makes version ${model.version + 1}; version ${model.version} stays as it was. Owner, status and the next validation date change on the model itself.`} error={invalid ?? error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-edit-risk-model-form={model.id}
        onSubmit={async (e) => {
          e.preventDefault()
          const def = definitionOf(d)
          if (!def.ok) return setInvalid(def.error)
          const before = definitionOf(draftOf(model))
          // Only what changed is sent.
          const changed = Object.fromEntries(Object.entries(def.value).filter(([k, v]) => !before.ok || JSON.stringify(v) !== JSON.stringify(before.value[k])))
          const body = {
            action: "edit",
            ...changed,
            ...(owner && owner !== model.owner?.userId ? { owner_user_id: owner } : {}),
            ...(status !== model.status ? { status } : {}),
            ...(due && due !== model.nextValidationDue ? { next_validation_due: due } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          }
          if (Object.keys(body).filter((k) => k !== "action" && k !== "note").length === 0) return setInvalid("Nothing changed: edit what's different.")
          setInvalid(null)
          const r = await run(routeOf(model.id), body)
          if (r?.ok) onDone()
        }}
      >
        <DefinitionFields d={d} set={(p) => setD((x) => ({ ...x, ...p }))} />
        <OwnerField owners={owners} value={owner} onChange={setOwner} keep={model.owner ? `Keep ${model.owner.name ?? "the current owner"}` : "Keep as is"} />
        <StatusField value={status} onChange={setStatus} />
        <Field label="Next validation due">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} data-model-field="next_validation_due" />
        </Field>
        <Field label="Why (optional)" hint="Kept as the new version's change note.">
          <textarea className={`${fieldClass} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} data-model-field="note" />
        </Field>
        {result === null && <Submit busy={busy} disabled={false} label="Save changes" name="edit" />}
      </form>
    </AdminSheet>
  )
}

export function RecordValidationSheet({ model, open, onClose, onDone, fetcher }: { model: RiskModel; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [outcome, setOutcome] = useState<ModelOutcome>("passed")
  const [notes, setNotes] = useState("")
  const [due, setDue] = useState("")
  useEffect(() => {
    if (!open) return
    reset()
    setOutcome("passed")
    setNotes("")
    setDue("")
  }, [open, reset])
  return (
    <AdminSheet id="record-validation" open={open} onClose={onClose} title="Record validation" description={`A validation of version ${model.version}: what was checked and found, the outcome, and when the next one is due. Every validation is kept.`} error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-record-validation-form={model.id}
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run(routeOf(model.id), { action: "validate", outcome, notes: notes.trim(), next_validation_due: due })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Outcome">
          <select className={fieldClass} value={outcome} onChange={(e) => setOutcome(e.target.value as ModelOutcome)} data-model-field="outcome">
            {MODEL_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {MODEL_OUTCOME_LABELS[o]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Notes" hint="What was checked, and what was found.">
          <textarea className={`${fieldClass} min-h-20`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} required data-model-field="notes" />
        </Field>
        <Field label="Next validation due">
          <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} required data-model-field="next_validation_due" />
        </Field>
        {result === null && <Submit busy={busy} disabled={notes.trim().length < 3 || !due} label="Record validation" name="validate" />}
      </form>
    </AdminSheet>
  )
}

export function RetireRiskModelSheet({ model, open, onClose, onDone, fetcher }: { model: RiskModel; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [reason, setReason] = useState("")
  useEffect(() => {
    if (!open) return
    reset()
    setReason("")
  }, [open, reset])
  return (
    <AdminSheet id="retire-risk-model" open={open} onClose={onClose} title="Retire model" description="It stays listed with every version and validation, but can't be changed or validated again. This can't be undone." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-retire-risk-model-form={model.id}
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run(routeOf(model.id), { action: "retire", reason: reason.trim() })
          if (r?.ok) onDone()
        }}
      >
        <p className="text-sm">{model.name}</p>
        <Field label="Why">
          <textarea className={`${fieldClass} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} required data-model-field="reason" />
        </Field>
        {result === null && (
          <div>
            <Button type="submit" variant="destructive" disabled={busy || reason.trim().length < 3} data-model-submit="retire">
              {busy ? "Saving…" : "Retire model"}
            </Button>
          </div>
        )}
      </form>
    </AdminSheet>
  )
}

export function LinkRiskSheet({ model, choices, open, onClose, onDone, fetcher }: { model: RiskModel; choices: { id: string; title: string }[]; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [risk, setRisk] = useState("")
  const [note, setNote] = useState("")
  const action = useAdminAction(fetcher)
  useEffect(() => {
    if (open) action.reset()
  }, [open])
  return (
    <AdminSheet open={open} title="Link risk" description="Link one of Mynt's own risks to this model: the risk it measures, or one about the model itself. The link shows on both, and in the risk's history." onClose={onClose} error={action.error} result={action.result} id="link-risk">
      {action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-link-risk-form={model.id}
          onSubmit={(e) => {
            e.preventDefault()
            void action.run(routeOf(model.id), { action: "link_risk", risk_id: risk, note: note.trim() }).then((res) => res?.ok === true && onDone())
          }}
        >
          <Field label="Risk" hint={choices.length ? "Mynt's own register. An app's or a product's risk is linked by its keeper." : "Every risk on Mynt's own register is already linked, or it has none yet."}>
            <select className={fieldClass} value={risk} onChange={(e) => setRisk(e.target.value)} required data-model-field="risk">
              <option value="">Pick a risk</option>
              {choices.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note (optional)">
            <textarea className={`${fieldClass} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} data-model-field="link-note" />
          </Field>
          <Submit busy={action.busy} disabled={!risk} label="Link risk" name="link-risk" />
        </form>
      )}
    </AdminSheet>
  )
}

// ---- the list (one area's tab): ONE table ----

export const MODEL_HEAD = ["Model", "Status", "Health", "Owner", "Version", "Last validated", "Next validation due", "Linked risks", "Action"] as const
// The Regulated product risk tab's table also holds the models financial products declare: it says each row's source and type.
export const MODEL_HEAD_WITH_PRODUCTS = ["Model", "Source", "Type", "Status", "Health", "Owner", "Version", "Last validated", "Next validation due", "Linked risks", "Action"] as const
export const MODEL_SOURCE_LABELS = { mynt: "Mynt models", product: "Product models" } as const
const NOT_AVAILABLE = "Not available"
const NOT_RECORDED = "Not recorded"

type ModelRow = {
  key: string
  source: "mynt" | "product"
  sourceWords: string // "Mynt model", "Product: Fixed deposit (Builder Inc)"
  name: string
  type: string
  status: string // a Mynt model's status; "" for a product's model, which has none on Mynt
  statusWords: string
  health: string // in words; "Not assessed" for a product's own model, which Mynt doesn't validate
  linked: string // how many risks link to it, in words
  owner: string
  version: string
  lastValidated: string
  due: string
  overdue: boolean
  model: RiskModel | null // Mynt's own: its page opens
  href: string | null // a product's: its firm's Products tab
  search: string
  missing?: boolean // the one row for a part Mynt can't answer
}

/** A tab's rows: Mynt's own models, then (Regulated product risk) the models products declare, read-only. A part Mynt
 * can't answer is one row, "Not available." with why: never left out, never a 0. */
function modelRows(data: RiskModelsData): ModelRow[] {
  const none = (key: string, source: ModelRow["source"], sourceWords: string, reason: string): ModelRow => ({ key, source, sourceWords, name: `Not available. ${reason}`, type: NOT_AVAILABLE, status: "", statusWords: NOT_AVAILABLE, health: NOT_AVAILABLE, linked: NOT_AVAILABLE, owner: NOT_AVAILABLE, version: NOT_AVAILABLE, lastValidated: NOT_AVAILABLE, due: NOT_AVAILABLE, overdue: false, model: null, href: null, search: reason, missing: true })
  const mynt: ModelRow[] = data.models.available
    ? data.models.models.map((m) => ({ key: m.id, source: "mynt", sourceWords: "Mynt model", name: m.name, type: "Not stated", status: m.status, statusWords: statusWords(m), health: healthWords(m), linked: linkedWords(m.linkedRisks), owner: ownerWords(m.owner), version: `Version ${m.version}`, lastValidated: lastValidatedWords(m), due: dueWords(m), overdue: m.overdue, model: m, href: null, search: m.purpose }))
    : [none("mynt:none", "mynt", "Mynt model", data.models.reason)]
  const products: ModelRow[] = !data.productModels
    ? []
    : data.productModels.available
      ? data.productModels.rows.map((r) => ({
          key: `product:${r.key}`,
          source: "product",
          sourceWords: `Product: ${r.productName} (${r.firmName ?? "Mynt's reference product"})`,
          name: r.modelName,
          type: r.type,
          status: "",
          statusWords: "Declared in the product's definition",
          health: "Not assessed: the product's firm validates it",
          linked: "Not counted",
          owner: r.firmName ?? "Mynt's reference product",
          version: r.version ?? "Not stated",
          lastValidated: NOT_RECORDED,
          due: NOT_RECORDED,
          overdue: false,
          model: null,
          href: r.href,
          search: r.productName,
        }))
      : [none("product:none", "product", "Product models", data.productModels.reason)]
  return [...mynt, ...products]
}

/** One area's models: the list's toolbar (search, Filters, Import, Export CSV, Add risk model) over its ONE table. */
export function RiskModelsAreaView({ data, onOpen = () => undefined, onChanged = () => undefined, sheet = null, fetcher }: { data: RiskModelsData; onOpen?: (id: string) => void; onChanged?: () => void; sheet?: "add" | null; fetcher?: typeof fetch }) {
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string[]>([])
  const [source, setSource] = useState<string[]>([])
  const [adding, setAdding] = useState(sheet === "add")
  const [dirty, setDirty] = useState(false)
  const withProducts = data.area === "regulated_product" && data.productModels !== null
  const all = useMemo(() => modelRows(withProducts ? data : { ...data, productModels: null }), [data, withProducts])
  const rows = useMemo(() => all.filter((r) => matches(query, r.name, r.search, r.owner, r.sourceWords, r.type) && (!status.length || status.includes(r.status)) && (!source.length || source.includes(r.source))), [all, query, status, source])
  const paged = usePaged(rows)
  const label = RISK_AREA_LABELS[data.area].toLowerCase()
  const overdue = data.models.available ? data.models.counts.overdue : 0
  const unhealthy = data.models.available ? data.models.models.filter((m) => m.health !== "healthy" && m.health !== "retired").length : 0
  const close = () => {
    setAdding(false)
    if (dirty) onChanged()
    setDirty(false)
  }
  const cell = (r: ModelRow) => ({
    name: (
      <span key="n" className={r.missing ? "block min-w-48 font-normal whitespace-normal text-muted-foreground" : undefined} data-not-available={r.missing ? "" : undefined}>
        {r.name}
      </span>
    ),
    source: (
      <span key="src" className="block min-w-40 whitespace-normal" data-model-source={r.source}>
        {r.href ? (
          <Link href={r.href} className="underline underline-offset-2" onClick={(e) => e.stopPropagation()} data-product-model-link={r.href}>
            {r.sourceWords}
          </Link>
        ) : (
          r.sourceWords
        )}
      </span>
    ),
    status: (
      <span key="s" data-model-status={r.status || undefined}>
        {r.statusWords}
      </span>
    ),
    due: (
      <span key="d" data-overdue={r.overdue ? "true" : undefined}>
        {r.due}
      </span>
    ),
    health: (
      <span key="h" className="block min-w-28 whitespace-normal" data-model-health={r.model?.health}>
        {r.health}
      </span>
    ),
    action: r.model ? (
      <span key="o" className="flex justify-end">
        <Button size="sm" variant="outline" onClick={(e) => (e.stopPropagation(), onOpen(r.model!.id))} data-open-model={r.model.id}>
          <ExternalLink />
          Open
        </Button>
      </span>
    ) : r.href ? (
      <span key="o" className="flex justify-end">
        <Button asChild size="sm" variant="outline">
          <Link href={r.href} aria-label={`Open the firm of ${r.sourceWords}`} data-open-product-model={r.href}>
            <ExternalLink />
            Open
          </Link>
        </Button>
      </span>
    ) : (
      ""
    ),
  })
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-risk-models-area={data.area}>
      <AdminList
        id="risk-models"
        search={query}
        onSearch={setQuery}
        searchLabel={withProducts ? `Search ${label} models by name, purpose, owner, product or type` : `Search ${label} models by name, purpose or owner`}
        facets={[
          ...(withProducts ? [{ id: "source", label: "Source", options: (["mynt", "product"] as const).map((s) => ({ value: s, label: MODEL_SOURCE_LABELS[s] })), selected: source, onChange: (v: string[]) => setSource(v) }] : []),
          { id: "status", label: "Status", options: MODEL_STATUSES.map((s) => ({ value: s, label: MODEL_STATUS_LABELS[s] })), selected: status, onChange: (v: string[]) => setStatus(v) },
        ]}
        onClearFilters={() => (setStatus([]), setSource([]))}
        onExport={() =>
          downloadCsv(
            `risk-models-${data.area}.csv`,
            csvOf(
              ["Model", ...(withProducts ? ["Source", "Type"] : []), "Area", "Status", "Health", "Owner", "Version", "Last validated", "Next validation due", "Linked risks"],
              rows.map((r) => [r.name, ...(withProducts ? [r.sourceWords, r.type] : []), data.area, r.model ? r.model.status : r.statusWords, r.health, r.owner, r.model ? r.model.version : r.version, r.lastValidated, r.due, r.model ? (r.model.linkedRisks ?? r.linked) : r.linked]),
            ),
          )
        }
        exportDisabled={!rows.some((r) => !r.missing)}
        note={[overdue ? `${overdue === 1 ? "1 model is" : `${overdue} models are`} overdue for validation.` : null, unhealthy ? `${unhealthy === 1 ? "1 model isn't" : `${unhealthy} models aren't`} healthy.` : null, withProducts ? "Product models are the ones financial products declare in their own definitions. Read-only: each product's firm keeps them." : null].filter(Boolean).join(" ") || null}
        cta={
          data.models.available ? (
            <Button onClick={() => setAdding(true)} data-add-risk-model>
              <Plus />
              Add risk model
            </Button>
          ) : undefined
        }
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable
          head={withProducts ? MODEL_HEAD_WITH_PRODUCTS : MODEL_HEAD}
          rowKeys={paged.shown.map((r) => r.key)}
          onRow={(i) => paged.shown[i].model && onOpen(paged.shown[i].model!.id)}
          opens={paged.shown.map((r) => r.model !== null)}
          rows={paged.shown.map((r) => {
            const c = cell(r)
            return [c.name, ...(withProducts ? [c.source, r.type] : []), c.status, c.health, r.owner, r.version, r.lastValidated, c.due, r.linked, c.action]
          })}
          empty={all.length ? "No models match this search and these filters." : `No ${label} models yet. Add the first one.`}
        />
      </AdminList>
      <AddRiskModelSheet area={data.area} owners={data.owners} open={adding} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </div>
  )
}

export function RiskModelsView({ area, onArea, body }: { area: RiskArea; onArea: (a: RiskArea) => void; body: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-platform-risk-models>
      <RiskAreaTabs area={area} onArea={onArea} label="Risk areas" />
      {body}
    </div>
  )
}

// ---- one model's page ----

export const MODEL_DETAIL_TABS = ["definition", "validations", "linked", "versions"] as const
export type ModelDetailTab = (typeof MODEL_DETAIL_TABS)[number]
const DETAIL_TAB_LABELS: Record<ModelDetailTab, string> = { definition: "Definition", validations: "Validations", linked: "Linked risks", versions: "Versions" }
const dayOf = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")

export function RiskModelDetailView({
  data,
  onBack = () => undefined,
  onChanged = () => undefined,
  initialTab = "definition",
  sheet = null,
  fetcher,
}: {
  data: RiskModelDetailData
  onBack?: () => void
  onChanged?: () => void
  initialTab?: ModelDetailTab
  sheet?: "edit" | "validate" | "retire" | "link" | null
  fetcher?: typeof fetch
}) {
  const { model, versions, validations, linked } = data.detail
  const [tab, setTab] = useState<ModelDetailTab>(initialTab)
  const [open, setOpen] = useState<"edit" | "validate" | "retire" | "link" | null>(sheet)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setOpen(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const live = model.status !== "retired"
  return (
    <>
      <AdminDetail
        backLabel={`Back to ${RISK_AREA_LABELS[model.riskArea].toLowerCase()} models`}
        onBack={onBack}
        title={model.name}
        subtitle={model.purpose}
        fields={[
          ...modelFacts(model, linked).map(([label, value]): [string, React.ReactNode] => [
            label,
            <span key={label} className="block whitespace-normal" title={value} data-model-fact={label} data-model-status={label === "Status" ? model.status : undefined} data-model-health={label === "Health" ? model.health : undefined} data-overdue={label === "Next validation due" && model.overdue ? "true" : undefined}>
              {value}
            </span>,
          ]),
          ...(model.retiredReason ? [["Why it was retired", model.retiredReason] as [string, React.ReactNode]] : []),
        ]}
        actions={
          live ? (
            <>
              <Button variant="outline" onClick={() => setOpen("edit")} data-model-action="edit">
                <Pencil />
                Edit model
              </Button>
              <Button variant="outline" onClick={() => setOpen("validate")} data-model-action="validate">
                <ClipboardCheck />
                Record validation
              </Button>
              <Button variant="outline" onClick={() => setOpen("retire")} data-model-action="retire">
                <Archive />
                Retire model
              </Button>
            </>
          ) : null
        }
        tabs={MODEL_DETAIL_TABS.map((t) => ({ id: t, label: DETAIL_TAB_LABELS[t] }))}
        tab={tab}
        onTab={setTab}
      >
        {tab === "definition" ? (
          <div className="flex flex-col gap-4 p-3" data-model-definition>
            <section className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">Method</h3>
              <div className="rounded-lg border">
                <AdminTable
                  head={["Part", "What it says"]}
                  rows={[
                    ["Purpose", <span key="p" className="block min-w-48 font-normal whitespace-pre-wrap">{model.purpose || "Not stated"}</span>],
                    ["Method", <span key="m" className="block min-w-48 font-normal whitespace-pre-wrap" data-model-method>{model.method || "Not stated"}</span>],
                  ]}
                  empty="Not stated."
                />
              </div>
            </section>
            <section className="flex flex-col gap-1" data-model-inputs>
              <h3 className="text-sm font-semibold">Inputs</h3>
              <div className="rounded-lg border">
                <AdminTable head={["Input", "Description", "Source"]} rows={model.inputs.map((x) => [x.name, x.description ?? "—", x.source ?? "—"])} empty="No inputs listed." />
              </div>
            </section>
            <section className="flex flex-col gap-1" data-model-outputs>
              <h3 className="text-sm font-semibold">Outputs</h3>
              <div className="rounded-lg border">
                <AdminTable head={["Output", "Description"]} rows={model.outputs.map((x) => [x.name, x.description ?? "—"])} empty="No outputs listed." />
              </div>
            </section>
            <section className="flex flex-col gap-1" data-model-thresholds>
              <h3 className="text-sm font-semibold">Thresholds</h3>
              <div className="rounded-lg border">
                <AdminTable head={["Threshold", "Value", "What happens"]} rows={model.thresholds.map((x) => [x.name, x.value, x.meaning ?? "—"])} empty="No thresholds listed." />
              </div>
            </section>
          </div>
        ) : tab === "validations" ? (
          <AdminTable
            head={["Validated", "Version", "Outcome", "Validated by", "Notes", "Next due"]}
            rowKeys={validations.map((v) => v.id)}
            rows={validations.map((v) => [dayOf(v.validatedAt), `Version ${v.version}`, MODEL_OUTCOME_LABELS[v.outcome], ownerWords(v.validatedBy), <span key="n" className="whitespace-normal">{v.notes}</span>, v.nextValidationDue ?? "—"])}
            empty="Never validated. Record the first validation."
          />
        ) : tab === "linked" ? (
          <div data-model-linked>
            {live && data.riskChoices && (
              <div className="flex justify-end border-b p-2">
                <Button size="sm" onClick={() => setOpen("link")} data-link-risk>
                  <Link2 />
                  Link risk
                </Button>
              </div>
            )}
            <AdminTable
              head={LINKED_RISK_HEAD}
              rowKeys={(linked ?? []).map((l) => l.linkId)}
              rows={(linked ?? []).map((l) => [
                <Link key="r" href={adminHref("risk-register", l.risk.id)} className="block min-w-40 whitespace-normal underline underline-offset-2" data-linked-risk={l.risk.id}>
                  {l.risk.title}
                  {l.note && <span className="block text-xs font-normal text-muted-foreground no-underline">{l.note}</span>}
                </Link>,
                ...linkedRiskCells(l).map((c, i) => (
                  <span key={i} className={i === 1 ? "block min-w-28 tabular-nums whitespace-normal" : undefined} data-overdue={i === 3 && l.risk.overdue ? "true" : undefined}>
                    {c}
                  </span>
                )),
              ])}
              empty="No risks link to this model yet."
              unavailable={linked === null ? "Linked risks come with Mynt's next update." : null}
            />
          </div>
        ) : (
          <AdminTable
            head={["Version", "Name", "Made", "By", "Why it changed"]}
            rowKeys={versions.map((v) => String(v.version))}
            rows={[...versions].reverse().map((v) => [`Version ${v.version}${v.version === model.version ? " (current)" : ""}`, v.name, dayOf(v.createdAt), ownerWords(v.createdBy), v.changeNote ?? (v.version === 1 ? "First version" : "—")])}
            empty="No versions recorded."
          />
        )}
      </AdminDetail>
      {live && (
        <>
          <EditRiskModelSheet model={model} owners={data.owners} open={open === "edit"} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
          <RecordValidationSheet model={model} open={open === "validate"} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
          <RetireRiskModelSheet model={model} open={open === "retire"} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
          <LinkRiskSheet model={model} choices={data.riskChoices ?? []} open={open === "link"} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
        </>
      )}
    </>
  )
}

// ---- the section (/platform/risk-models, /platform/risk-models/<id>) ----

function ModelPage({ id, onBack }: { id: string; onBack: () => void }) {
  const router = useRouter()
  const pick = useCallback((b: Record<string, unknown>) => (b.detail ? ({ detail: b.detail, owners: Array.isArray(b.owners) ? b.owners : [], riskChoices: Array.isArray(b.riskChoices) ? b.riskChoices : null } as RiskModelDetailData) : undefined), [])
  const { state, reload } = useAdminData(routeOf(id), pick)
  // Back goes to the model's own area's tab.
  return state.kind === "ready" ? (
    <RiskModelDetailView key={state.data.detail.model.version} data={state.data} onBack={() => router.push(`${adminHref("risk-models")}?tab=${state.data.detail.model.riskArea}`)} onChanged={reload} />
  ) : (
    <AdminNotReady state={state} what="This risk model" />
  )
}

export function RiskModelsTab({ id = null, onOpen, onBack }: { id?: string | null; onOpen: (id: string) => void; onBack: () => void }) {
  const [area, setArea] = useAreaInAddress()
  const pick = useCallback((b: Record<string, unknown>) => (b.models && b.area ? (b as unknown as RiskModelsData) : undefined), [])
  const { state, reload } = useAdminData(id ? null : `/api/admin/risk-models?area=${area}`, pick)
  if (id) return <ModelPage id={id} onBack={onBack} />
  return (
    <RiskModelsView
      area={area}
      onArea={setArea}
      body={state.kind === "ready" ? state.data.area === area ? <RiskModelsAreaView key={area} data={state.data} onOpen={onOpen} onChanged={reload} /> : null : <AdminNotReady state={state} what="Risk models" />}
    />
  )
}

