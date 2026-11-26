"use client"

// One risk in full (lib/risk-detail.ts; Mynt's get_risk), one component for the three places it shows: the platform
// admin's Risk register (/platform/risk-register/<id>, RiskDetailPage), and a sheet opened from a row of an app's
// Security & risk tab or a product's Risk tab (RiskDetailSheet). The house detail layout (components/admin-kit.tsx
// AdminDetail): a metadata card on top ("‹short id› · ‹risk area› · ‹title›", the status in words, the facts in
// their order: Status · Inherent · Control · Residual · Owner · Next review · Treatment due · Linked, and the
// labelled actions), a tab selector, and each tab a table:
// - Scoring: three tables (Impact factors, Likelihood factors, Control factors), each captioned with its formula in
//   words, with Add factor,
// - Treatment: the tasks that bring the risk down, with Add treatment task, and Make this a control on a done task,
// - Controls: what keeps it down, with Add control,
// - Linked: what it's about, each item linked where it has a page, with Link item,
// - History: every change from the audit trail, with the scores before → after.
// Tabs only show; every change is a labelled button opening a sheet, which posts to the risk's own route and shows
// Mynt's answer in its words. Whoever can't change the register (Mynt's can_manage) reads it: no action buttons but
// Copy link. Levels, statuses and results are always in words; nothing unmeasured is ever 0. Server-renderable.
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useState } from "react"
import { Archive, CheckCircle2, ClipboardCheck, Copy, Link2, ListPlus, Pencil, Plus, ShieldCheck, ShieldPlus, Trash2, Unlink, XCircle } from "lucide-react"

import { AdminDetail, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { ReviewRiskSheet } from "@/components/risk-register"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import {
  beforeAfterWords,
  CONTROL_KIND_LABELS,
  CONTROL_KINDS,
  CONTROL_TEST_LABELS,
  CONTROL_TEST_RESULTS,
  dueWords,
  FACTOR_KIND_LABELS,
  FACTOR_KINDS,
  factorCaption,
  LINK_TARGET_LABELS,
  LINK_TARGETS,
  linkHref,
  NAME_HIDDEN,
  NOT_TESTED,
  ownerWords,
  riskFacts,
  riskHeading,
  sourceWords,
  TREATMENT_EFFECTIVENESS,
  TREATMENT_EFFECTIVENESS_LABELS,
  TREATMENT_STATUS_LABELS,
  TREATMENT_STATUSES,
  whenWords,
  type Control,
  type ControlKind,
  type Factor,
  type FactorKind,
  type LinkTarget,
  type RiskDetailChange,
  type RiskDetailData,
  type RiskLink,
  type Treatment,
} from "@/lib/risk-detail"
import { adminHref } from "@/lib/admin"
import { areaOfRisk, RISK_STATUS_LABELS } from "@/lib/risk-register"

export const RISK_DETAIL_TABS = ["scoring", "treatment", "controls", "linked", "history"] as const
export type RiskDetailTab = (typeof RISK_DETAIL_TABS)[number]
export const RISK_DETAIL_TAB_LABELS: Record<RiskDetailTab, string> = { scoring: "Scoring", treatment: "Treatment", controls: "Controls", linked: "Linked", history: "History" }
export const FACTOR_HEAD = ["Factor", "Score", "Rationale", "Source", "Action"] as const
export const TREATMENT_HEAD = ["Task", "Owner", "Due", "Status", "Progress", "Effectiveness", "Action"] as const
export const CONTROL_HEAD = ["Control", "Kind", "Last tested", "Result", "From task", "Action"] as const
export const LINKED_HEAD = ["Type", "Item", "Note", "Action"] as const
export const HISTORY_HEAD = ["When", "Who", "What changed", "Score before → after"] as const

/** Where the detail's sheets post, and where it reads from: the platform admin's route for any risk an admin opens,
 * else the route under the risk's own app or product. */
export type RiskDetailWhere = "platform" | "studio"
export function riskDetailRoute(where: RiskDetailWhere, subject: { type: string; id: string }, riskId: string): string {
  const risk = encodeURIComponent(riskId)
  if (where === "platform") return `/api/admin/risks/${risk}`
  return subject.type === "app" ? `/api/apps/${encodeURIComponent(subject.id)}/risks/${risk}` : `/api/products/${encodeURIComponent(subject.id)}/risks/${risk}`
}
/** The address Copy link copies: the risk's page on the platform, or the app's or product's tab with the risk open. */
export const riskDetailHref = (where: RiskDetailWhere, riskId: string) => (where === "platform" ? `/platform/risk-register/${encodeURIComponent(riskId)}` : `?risk=${encodeURIComponent(riskId)}`)
/** The whole address to copy from where the reader is: the page's own on the platform; elsewhere the tab they are on, with the risk named. */
export function riskDetailLink(where: RiskDetailWhere, riskId: string, at: { origin: string; pathname: string; search: string }): string {
  if (where === "platform") return `${at.origin}${riskDetailHref(where, riskId)}`
  const query = new URLSearchParams(at.search)
  query.set("risk", riskId)
  return `${at.origin}${at.pathname}?${query.toString()}`
}

type Open =
  | { sheet: "review" }
  | { sheet: "factor"; kind: FactorKind; factor?: Factor }
  | { sheet: "remove-factor"; factor: Factor }
  | { sheet: "treatment"; treatment?: Treatment }
  | { sheet: "control"; control?: Control; fromTask?: Treatment }
  | { sheet: "retire-control"; control: Control }
  | { sheet: "link" }
  | { sheet: "unlink"; link: RiskLink }
  | { sheet: "status"; status: "accepted" | "closed" }
export type RiskDetailSheetName = Open["sheet"]

const wrap = (text: React.ReactNode, key: string, more = "") => (
  <span key={key} className={`block min-w-40 font-normal whitespace-normal ${more}`}>
    {text}
  </span>
)
const SCORES = [1, 2, 3, 4, 5]

function Submit({ busy, disabled, label, name }: { busy: boolean; disabled?: boolean; label: string; name: string }) {
  return (
    <div>
      <Button type="submit" disabled={busy || disabled} data-risk-detail-submit={name}>
        {busy ? "Saving…" : label}
      </Button>
    </div>
  )
}

/** A sheet's form: its fields kept as strings, sent as the action's own arguments. */
function useForm<T extends Record<string, string>>(initial: T) {
  const [v, setV] = useState(initial)
  return { v, set: (k: keyof T) => (e: { target: { value: string } }) => setV((was) => ({ ...was, [k]: e.target.value })) }
}

function FactorForm({ kind, factor, busy, onSubmit }: { kind: FactorKind; factor?: Factor; busy: boolean; onSubmit: (c: RiskDetailChange) => void }) {
  const f = useForm({ name: factor?.name ?? "", score: String(factor?.score ?? 3), rationale: factor?.rationale ?? "", source: factor?.source ? (factor.source.kind === "link" ? factor.source.url : `${factor.source.targetType}:${factor.source.targetId}`) : "" })
  return (
    <form
      className="flex flex-col gap-3"
      data-risk-form="factor"
      onSubmit={(e) => {
        e.preventDefault()
        const fields = { name: f.v.name.trim(), score: Number(f.v.score), rationale: f.v.rationale.trim(), source: f.v.source.trim() }
        onSubmit(factor ? { action: "update_factor", factor_id: factor.id, ...fields } : { action: "add_factor", kind, ...fields })
      }}
    >
      <Field label="Factor">
        <input className={fieldClass} value={f.v.name} onChange={f.set("name")} maxLength={200} required data-risk-detail-field="name" />
      </Field>
      <Field label="Score" hint={kind === "control" ? "1: not working. 5: working fully." : kind === "impact" ? "1: negligible. 5: severe." : "1: rare. 5: almost certain."}>
        <select className={fieldClass} value={f.v.score} onChange={f.set("score")} data-risk-detail-field="score">
          {SCORES.map((n) => (
            <option key={n} value={n}>
              {n} of 5
            </option>
          ))}
        </select>
      </Field>
      <Field label="Rationale (optional)">
        <textarea className={`${fieldClass} min-h-16`} value={f.v.rationale} onChange={f.set("rationale")} maxLength={2000} data-risk-detail-field="rationale" />
      </Field>
      <Field label="Source (optional)" hint="An https link, or something on Mynt as type:id, like app:<id> or agreement_audit:<id>.">
        <input className={fieldClass} value={f.v.source} onChange={f.set("source")} maxLength={500} data-risk-detail-field="source" />
      </Field>
      <Submit busy={busy} disabled={f.v.name.trim().length < 2} label={factor ? "Save factor" : "Add factor"} name="factor" />
    </form>
  )
}

function OwnerField({ owners, value, onChange, keep }: { owners: { userId: string; name: string }[]; value: string; onChange: (e: { target: { value: string } }) => void; keep: string }) {
  if (!owners.length) return null
  return (
    <Field label="Owner">
      <select className={fieldClass} value={value} onChange={onChange} data-risk-detail-field="owner">
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

function TreatmentForm({ treatment, owners, busy, onSubmit }: { treatment?: Treatment; owners: { userId: string; name: string }[]; busy: boolean; onSubmit: (c: RiskDetailChange) => void }) {
  const f = useForm({
    title: treatment?.title ?? "",
    owner: "",
    due: treatment?.due ?? "",
    status: treatment?.status ?? "todo",
    progress: treatment?.progressNote ?? "",
    effectiveness: treatment?.effectiveness ?? "not_assessed",
    effectivenessNote: treatment?.effectivenessNote ?? "",
  })
  const done = f.v.status === "done"
  return (
    <form
      className="flex flex-col gap-3"
      data-risk-form="treatment"
      onSubmit={(e) => {
        e.preventDefault()
        const base = { title: f.v.title.trim(), ...(f.v.owner ? { owner_user_id: f.v.owner } : {}), due: f.v.due, progress_note: f.v.progress.trim() }
        onSubmit(
          treatment
            ? { action: "update_treatment", treatment_id: treatment.id, ...base, status: f.v.status as Treatment["status"], effectiveness: (done ? f.v.effectiveness : "not_assessed") as Treatment["effectiveness"], effectiveness_note: done ? f.v.effectivenessNote.trim() : "" }
            : { action: "add_treatment", ...base },
        )
      }}
    >
      <Field label="Task">
        <input className={fieldClass} value={f.v.title} onChange={f.set("title")} maxLength={200} required data-risk-detail-field="title" />
      </Field>
      <OwnerField owners={owners} value={f.v.owner} onChange={f.set("owner")} keep={treatment?.owner ? `Keep ${treatment.owner.name ?? "the current owner"}` : "You"} />
      <Field label="Due (optional)">
        <input className={fieldClass} type="date" value={f.v.due} onChange={f.set("due")} data-risk-detail-field="due" />
      </Field>
      {treatment && (
        <Field label="Status">
          <select className={fieldClass} value={f.v.status} onChange={f.set("status")} data-risk-detail-field="status">
            {TREATMENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TREATMENT_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="Progress (optional)">
        <textarea className={`${fieldClass} min-h-16`} value={f.v.progress} onChange={f.set("progress")} maxLength={2000} data-risk-detail-field="progress_note" />
      </Field>
      {treatment && (
        <>
          <Field label="Effectiveness" hint={done ? "Whether the task worked, now that it's done." : "Said once the task is done."}>
            <select className={fieldClass} value={done ? f.v.effectiveness : "not_assessed"} onChange={f.set("effectiveness")} disabled={!done} data-risk-detail-field="effectiveness">
              {TREATMENT_EFFECTIVENESS.map((s) => (
                <option key={s} value={s}>
                  {TREATMENT_EFFECTIVENESS_LABELS[s]}
                </option>
              ))}
            </select>
          </Field>
          {done && (
            <Field label="Why (optional)">
              <textarea className={`${fieldClass} min-h-16`} value={f.v.effectivenessNote} onChange={f.set("effectivenessNote")} maxLength={2000} data-risk-detail-field="effectiveness_note" />
            </Field>
          )}
        </>
      )}
      <Submit busy={busy} disabled={f.v.title.trim().length < 3} label={treatment ? "Save task" : "Add treatment task"} name="treatment" />
    </form>
  )
}

function ControlForm({ control, fromTask, busy, onSubmit }: { control?: Control; fromTask?: Treatment; busy: boolean; onSubmit: (c: RiskDetailChange) => void }) {
  const f = useForm({ name: control?.name ?? fromTask?.title ?? "", kind: control?.kind ?? "preventive", description: control?.description ?? "", tested: control?.lastTestedAt ?? "", result: control?.testResult ?? "" })
  return (
    <form
      className="flex flex-col gap-3"
      data-risk-form="control"
      onSubmit={(e) => {
        e.preventDefault()
        const fields = { name: f.v.name.trim(), kind: f.v.kind as ControlKind, description: f.v.description.trim(), last_tested_at: f.v.tested, ...(f.v.result && f.v.tested ? { test_result: f.v.result as NonNullable<Control["testResult"]> } : {}) }
        onSubmit(control ? { action: "update_control", control_id: control.id, ...fields } : { action: "add_control", ...fields, ...(fromTask ? { source_treatment_id: fromTask.id } : {}) })
      }}
    >
      {fromTask && (
        <p className="text-sm text-muted-foreground" data-from-task={fromTask.id}>
          From the finished task: {fromTask.title}
        </p>
      )}
      <Field label="Control">
        <input className={fieldClass} value={f.v.name} onChange={f.set("name")} maxLength={200} required data-risk-detail-field="name" />
      </Field>
      <Field label="Kind">
        <select className={fieldClass} value={f.v.kind} onChange={f.set("kind")} data-risk-detail-field="kind">
          {CONTROL_KINDS.map((k) => (
            <option key={k} value={k}>
              {CONTROL_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="What it does (optional)">
        <textarea className={`${fieldClass} min-h-16`} value={f.v.description} onChange={f.set("description")} maxLength={4000} data-risk-detail-field="description" />
      </Field>
      <Field label="Last tested (optional)">
        <input className={fieldClass} type="date" value={f.v.tested} onChange={f.set("tested")} data-risk-detail-field="last_tested_at" />
      </Field>
      <Field label="Test result" hint="Needs the date it was tested.">
        <select className={fieldClass} value={f.v.tested ? f.v.result : ""} onChange={f.set("result")} disabled={!f.v.tested} data-risk-detail-field="test_result">
          <option value="">{NOT_TESTED}</option>
          {CONTROL_TEST_RESULTS.map((r) => (
            <option key={r} value={r}>
              {CONTROL_TEST_LABELS[r]}
            </option>
          ))}
        </select>
      </Field>
      <Submit busy={busy} disabled={f.v.name.trim().length < 3} label={control ? "Save control" : "Add control"} name="control" />
    </form>
  )
}

function ReasonForm({ name, label, hint, submit, busy, onSubmit }: { name: string; label: string; hint: string; submit: string; busy: boolean; onSubmit: (reason: string) => void }) {
  const f = useForm({ reason: "" })
  return (
    <form
      className="flex flex-col gap-3"
      data-risk-form={name}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(f.v.reason.trim())
      }}
    >
      <Field label={label} hint={hint}>
        <textarea className={`${fieldClass} min-h-20`} value={f.v.reason} onChange={f.set("reason")} maxLength={2000} required data-risk-detail-field="reason" />
      </Field>
      <Submit busy={busy} disabled={f.v.reason.trim().length < 3} label={submit} name={name} />
    </form>
  )
}

function ConfirmForm({ name, what, submit, busy, onSubmit }: { name: string; what: string; submit: string; busy: boolean; onSubmit: () => void }) {
  return (
    <form
      className="flex flex-col gap-3"
      data-risk-form={name}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <p className="text-sm">{what}</p>
      <Submit busy={busy} label={submit} name={name} />
    </form>
  )
}

function LinkForm({ choices, linked, busy, onSubmit }: { choices: RiskDetailData["linkChoices"]; linked: RiskLink[]; busy: boolean; onSubmit: (c: RiskDetailChange) => void }) {
  const first = LINK_TARGETS.find((t) => choices[t]?.length) ?? "app"
  const f = useForm({ type: first as string, pick: "", id: "", note: "" })
  const type = f.v.type as LinkTarget
  // What the picker offers for this type, less what the risk already links to.
  const offered = (choices[type] ?? []).filter((c) => !linked.some((l) => l.targetType === type && l.targetId === c.id))
  const id = (f.v.pick || f.v.id).trim()
  return (
    <form
      className="flex flex-col gap-3"
      data-risk-form="link"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({ action: "link", target_type: type, target_id: id, note: f.v.note.trim() })
      }}
    >
      <Field label="Type">
        <select className={fieldClass} value={f.v.type} onChange={(e) => (f.set("pick")({ target: { value: "" } }), f.set("type")(e))} data-risk-detail-field="target_type">
          {LINK_TARGETS.map((t) => (
            <option key={t} value={t}>
              {LINK_TARGET_LABELS[t]}
            </option>
          ))}
        </select>
      </Field>
      {offered.length > 0 && (
        <Field label={LINK_TARGET_LABELS[type]}>
          <select className={fieldClass} value={f.v.pick} onChange={f.set("pick")} data-risk-detail-field="target_pick">
            <option value="">Pick one, or give an id below</option>
            {offered.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!f.v.pick && (
        <Field label={`${LINK_TARGET_LABELS[type]} id`} hint="Its id on Mynt. You can link what you can read.">
          <input className={fieldClass} value={f.v.id} onChange={f.set("id")} maxLength={200} pattern="[A-Za-z0-9_\-]+" data-risk-detail-field="target_id" />
        </Field>
      )}
      <Field label="Note (optional)">
        <textarea className={`${fieldClass} min-h-16`} value={f.v.note} onChange={f.set("note")} maxLength={1000} data-risk-detail-field="note" />
      </Field>
      <Submit busy={busy} disabled={!id} label="Link item" name="link" />
    </form>
  )
}

const SHEET_TEXT: Record<Exclude<RiskDetailSheetName, "review">, { title: (o: Open) => string; description: string }> = {
  factor: {
    title: (o) => (o.sheet === "factor" && o.factor ? "Edit factor" : "Add factor"),
    description: "A factor explains one of the risk's three scores. It doesn't set the score: that changes with Review risk. Recorded in the risk's history.",
  },
  "remove-factor": { title: () => "Remove factor", description: "The factor leaves the table. The risk's scores stay, and the audit trail keeps what the factor was." },
  treatment: { title: (o) => (o.sheet === "treatment" && o.treatment ? "Update task" : "Add treatment task"), description: "A task that brings the risk down: who owns it, when it's due, where it stands and, once done, whether it worked." },
  control: {
    title: (o) => (o.sheet === "control" && o.control ? "Update control" : o.sheet === "control" && o.fromTask ? "Make this a control" : "Add control"),
    description: "A control keeps the risk down: what it does, its kind, and when it was last tested and how that went. How well the controls work together is the risk's control effectiveness, set with Review risk.",
  },
  "retire-control": { title: () => "Retire control", description: "The control stays listed, marked retired, and can't be changed again." },
  link: { title: () => "Link item", description: "What this risk is about: an app, a product, a vendor's service, an agreement, an oversight audit, an audit-trail entry, a risk model or a firm." },
  unlink: { title: () => "Remove link", description: "Only the link goes: the risk and the item it pointed at stay as they are." },
  status: { title: (o) => (o.sheet === "status" && o.status === "closed" ? "Close risk" : "Accept risk"), description: "Say why. The note is kept with the change in the risk's history." },
}

/** The detail: metadata card, tab selector, the tab's table, and the sheets its labelled actions open. */
export function RiskDetailView({
  data,
  where,
  backLabel = "Back to the risk register",
  onBack = () => undefined,
  onChanged = () => undefined,
  initialTab = "scoring",
  sheet = null,
  fetcher,
}: {
  data: RiskDetailData
  where: RiskDetailWhere
  backLabel?: string
  onBack?: () => void
  onChanged?: () => void
  initialTab?: RiskDetailTab
  sheet?: Open | null
  fetcher?: typeof fetch
}) {
  const { detail, owners } = data
  const { risk, canManage } = detail
  const [tab, setTab] = useState<RiskDetailTab>(initialTab)
  const [open, setOpen] = useState<Open | null>(sheet)
  const [dirty, setDirty] = useState(false)
  const [copied, setCopied] = useState(false)
  const action = useAdminAction(fetcher)
  const route = riskDetailRoute(where, detail.subject, risk.id)
  const show = (o: Open) => (action.reset(), setOpen(o))
  const close = () => {
    setOpen(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const send = async (change: RiskDetailChange) => {
    const res = await action.run(route, change)
    if (res?.ok === true) setDirty(true)
  }
  const copy = () => {
    void navigator.clipboard?.writeText(riskDetailLink(where, risk.id, window.location)).then(() => setCopied(true))
  }
  const readOnly = <span className="text-muted-foreground">Read-only</span>
  const actions = (...buttons: React.ReactNode[]) => (
    <span key="a" className="flex flex-wrap justify-end gap-2">
      {buttons}
    </span>
  )
  const toolbar = (button: React.ReactNode) => (canManage ? <div className="flex justify-end border-b p-2">{button}</div> : null)
  const sent = action.result !== null
  return (
    <>
      <AdminDetail
        backLabel={backLabel}
        onBack={onBack}
        title={riskHeading(risk)}
        subtitle={`${RISK_STATUS_LABELS[risk.status]}${detail.subject.type === "platform" ? " · On Mynt's own register" : ` · On the register of ${detail.subject.type === "app" ? "the app" : "the product"} ${detail.subject.name}`}${canManage ? "" : " · Read-only for you"}`}
        fields={riskFacts(detail).map(([label, value]) => [
          label,
          <span key={label} className="block whitespace-normal" title={value} data-risk-fact={label}>
            {value}
          </span>,
        ])}
        actions={
          <>
            {canManage && (
              <>
                <Button variant="outline" onClick={() => show({ sheet: "review" })} data-risk-action="review">
                  <ClipboardCheck /> Review risk
                </Button>
                <Button variant="outline" onClick={() => show({ sheet: "treatment" })} data-risk-action="add-treatment">
                  <ListPlus /> Add treatment task
                </Button>
                <Button variant="outline" onClick={() => show({ sheet: "control" })} data-risk-action="add-control">
                  <ShieldPlus /> Add control
                </Button>
                <Button variant="outline" onClick={() => show({ sheet: "link" })} data-risk-action="link">
                  <Link2 /> Link item
                </Button>
                {risk.status !== "closed" && (
                  <Button variant="outline" onClick={() => show({ sheet: "status", status: "closed" })} data-risk-action="close">
                    <XCircle /> Close risk
                  </Button>
                )}
                {risk.status !== "accepted" && risk.status !== "closed" && (
                  <Button variant="outline" onClick={() => show({ sheet: "status", status: "accepted" })} data-risk-action="accept">
                    <CheckCircle2 /> Accept risk
                  </Button>
                )}
              </>
            )}
            <Button variant="outline" onClick={copy} data-risk-action="copy-link" data-href={riskDetailHref(where, risk.id)}>
              <Copy /> {copied ? "Link copied" : "Copy link"}
            </Button>
          </>
        }
        tabs={RISK_DETAIL_TABS.map((t) => ({ id: t, label: RISK_DETAIL_TAB_LABELS[t] }))}
        tab={tab}
        onTab={setTab}
      >
        {tab === "scoring" ? (
          <div className="flex flex-col gap-4 p-3" data-risk-tab="scoring">
            {FACTOR_KINDS.map((kind) => {
              const list = detail.scoring[kind]
              return (
                <section key={kind} className="flex flex-col gap-1" data-factor-table={kind}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold">{FACTOR_KIND_LABELS[kind]}</h3>
                    {canManage && (
                      <Button size="sm" variant="outline" onClick={() => show({ sheet: "factor", kind })} data-add-factor={kind}>
                        <Plus /> Add factor
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground" data-factor-caption={kind}>
                    {factorCaption(list)}
                  </p>
                  <div className="overflow-x-auto rounded-lg border">
                    <AdminTable
                      head={FACTOR_HEAD}
                      rowKeys={list.factors.map((f) => f.id)}
                      rows={list.factors.map((f) => [
                        wrap(f.name, "n", "font-medium"),
                        `${f.score} of 5`,
                        wrap(f.rationale ?? "No rationale recorded", "r"),
                        f.source?.kind === "link" ? (
                          <a key="s" href={f.source.url} target="_blank" rel="noreferrer" className="block max-w-56 truncate underline underline-offset-2" title={f.source.url} data-factor-source="link">
                            {f.source.url}
                          </a>
                        ) : (
                          wrap(sourceWords(f.source), "s")
                        ),
                        canManage
                          ? actions(
                              <Button key="e" size="sm" variant="outline" onClick={() => show({ sheet: "factor", kind, factor: f })} data-edit-factor={f.id}>
                                <Pencil /> Edit factor
                              </Button>,
                              <Button key="r" size="sm" variant="outline" onClick={() => show({ sheet: "remove-factor", factor: f })} data-remove-factor={f.id}>
                                <Trash2 /> Remove factor
                              </Button>,
                            )
                          : readOnly,
                      ])}
                      empty={`No ${FACTOR_KIND_LABELS[kind].toLowerCase()} recorded.${canManage ? " Add the first one." : ""}`}
                    />
                  </div>
                </section>
              )
            })}
          </div>
        ) : tab === "treatment" ? (
          <div data-risk-tab="treatment">
            {toolbar(
              <Button size="sm" onClick={() => show({ sheet: "treatment" })} data-add-treatment>
                <ListPlus /> Add treatment task
              </Button>,
            )}
            <AdminTable
              head={TREATMENT_HEAD}
              rowKeys={detail.treatments.map((t) => t.id)}
              rows={detail.treatments.map((t) => [
                wrap(t.title, "t", "font-medium"),
                ownerWords(t.owner),
                <span key="d" className="tabular-nums" data-overdue={t.overdue ? "true" : undefined}>
                  {dueWords(t)}
                </span>,
                <span key="s" data-treatment-status={t.status}>
                  {TREATMENT_STATUS_LABELS[t.status]}
                </span>,
                wrap(t.progressNote ?? "No progress noted", "p"),
                wrap(`${TREATMENT_EFFECTIVENESS_LABELS[t.effectiveness]}${t.effectivenessNote ? `: ${t.effectivenessNote}` : ""}`, "e"),
                canManage
                  ? actions(
                      <Button key="u" size="sm" variant="outline" onClick={() => show({ sheet: "treatment", treatment: t })} data-update-treatment={t.id}>
                        <Pencil /> Update task
                      </Button>,
                      t.status === "done" && !t.isControl ? (
                        <Button key="c" size="sm" variant="outline" onClick={() => show({ sheet: "control", fromTask: t })} data-make-control={t.id}>
                          <ShieldCheck /> Make this a control
                        </Button>
                      ) : null,
                    )
                  : readOnly,
              ])}
              empty={`No treatment tasks yet.${canManage ? " Add the first one." : ""}`}
            />
          </div>
        ) : tab === "controls" ? (
          <div data-risk-tab="controls">
            {toolbar(
              <Button size="sm" onClick={() => show({ sheet: "control" })} data-add-control>
                <ShieldPlus /> Add control
              </Button>,
            )}
            <AdminTable
              head={CONTROL_HEAD}
              rowKeys={detail.controls.map((c) => c.id)}
              rows={detail.controls.map((c) => [
                wrap(
                  <>
                    {c.name}
                    {c.retired && <span className="block text-xs font-normal text-muted-foreground">Retired{c.retired.reason ? `: ${c.retired.reason}` : ""}</span>}
                    {c.description && <span className="block text-xs font-normal text-muted-foreground">{c.description}</span>}
                  </>,
                  "n",
                  "font-medium",
                ),
                wrap(CONTROL_KIND_LABELS[c.kind], "k"),
                c.lastTestedAt ?? NOT_TESTED,
                <span key="r" data-test-result={c.testResult ?? "not_tested"}>
                  {c.testResult ? CONTROL_TEST_LABELS[c.testResult] : NOT_TESTED}
                </span>,
                wrap(c.fromTask ?? "Not from a task", "f"),
                c.retired
                  ? "Retired"
                  : canManage
                    ? actions(
                        <Button key="u" size="sm" variant="outline" onClick={() => show({ sheet: "control", control: c })} data-update-control={c.id}>
                          <Pencil /> Update control
                        </Button>,
                        <Button key="r" size="sm" variant="outline" onClick={() => show({ sheet: "retire-control", control: c })} data-retire-control={c.id}>
                          <Archive /> Retire control
                        </Button>,
                      )
                    : readOnly,
              ])}
              empty={`No controls recorded.${canManage ? " Add the first one, or make one from a finished treatment task." : ""}`}
            />
          </div>
        ) : tab === "linked" ? (
          <div data-risk-tab="linked">
            {toolbar(
              <Button size="sm" onClick={() => show({ sheet: "link" })} data-link-item>
                <Link2 /> Link item
              </Button>,
            )}
            <AdminTable
              head={LINKED_HEAD}
              rowKeys={detail.links.map((l) => l.id)}
              rows={detail.links.map((l) => {
                const href = linkHref(l, where)
                const name = l.name ?? NAME_HIDDEN
                return [
                  LINK_TARGET_LABELS[l.targetType],
                  href && l.name ? (
                    <Link key="i" href={href} className="underline underline-offset-2" data-linked-item={href}>
                      {name}
                    </Link>
                  ) : (
                    wrap(name, "i")
                  ),
                  wrap(l.note ?? "No note", "n"),
                  canManage
                    ? actions(
                        <Button key="u" size="sm" variant="outline" onClick={() => show({ sheet: "unlink", link: l })} data-unlink={l.id}>
                          <Unlink /> Remove link
                        </Button>,
                      )
                    : readOnly,
                ]
              })}
              empty={`Nothing linked yet.${canManage ? " Link what this risk is about." : ""}`}
            />
          </div>
        ) : (
          <div data-risk-tab="history">
            <AdminTable
              head={HISTORY_HEAD}
              rowKeys={detail.history.map((h) => h.key)}
              rows={[...detail.history].reverse().map((h) => [
                <span key="w" className="tabular-nums">
                  {whenWords(h.at)}
                </span>,
                h.who,
                wrap(
                  <>
                    {h.what}
                    {h.note && <span className="block text-xs text-muted-foreground">Note: {h.note}</span>}
                  </>,
                  "c",
                ),
                wrap(beforeAfterWords(h), "s", "tabular-nums"),
              ])}
              empty="No history recorded."
            />
          </div>
        )}
      </AdminDetail>
      {canManage && (
        <>
          <ReviewRiskSheet subject={detail.subject} risk={open?.sheet === "review" ? risk : null} owners={owners} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} withArea={detail.subject.type === "platform"} />
          {open && open.sheet !== "review" && (
            <AdminSheet open title={SHEET_TEXT[open.sheet].title(open)} description={SHEET_TEXT[open.sheet].description} onClose={close} error={action.error} result={action.result} id={`risk-${open.sheet}`}>
              {sent ? null : open.sheet === "factor" ? (
                <FactorForm kind={open.kind} factor={open.factor} busy={action.busy} onSubmit={(c) => void send(c)} />
              ) : open.sheet === "remove-factor" ? (
                <ConfirmForm name="remove-factor" what={`Remove the factor “${open.factor.name}” (${open.factor.score} of 5)?`} submit="Remove factor" busy={action.busy} onSubmit={() => void send({ action: "remove_factor", factor_id: open.factor.id })} />
              ) : open.sheet === "treatment" ? (
                <TreatmentForm treatment={open.treatment} owners={owners} busy={action.busy} onSubmit={(c) => void send(c)} />
              ) : open.sheet === "control" ? (
                <ControlForm control={open.control} fromTask={open.fromTask} busy={action.busy} onSubmit={(c) => void send(c)} />
              ) : open.sheet === "retire-control" ? (
                <ReasonForm name="retire-control" label={`Why “${open.control.name}” is retired`} hint="Kept with the control." submit="Retire control" busy={action.busy} onSubmit={(reason) => void send({ action: "retire_control", control_id: open.control.id, reason })} />
              ) : open.sheet === "link" ? (
                <LinkForm choices={data.linkChoices} linked={detail.links} busy={action.busy} onSubmit={(c) => void send(c)} />
              ) : open.sheet === "unlink" ? (
                <ConfirmForm name="unlink" what={`Remove the link to ${LINK_TARGET_LABELS[open.link.targetType].toLowerCase()} “${open.link.name ?? open.link.targetId}”?`} submit="Remove link" busy={action.busy} onSubmit={() => void send({ action: "unlink", link_id: open.link.id })} />
              ) : (
                <ReasonForm
                  name="status"
                  label={open.status === "closed" ? "Why the risk is closed" : "Why the risk is accepted"}
                  hint={open.status === "closed" ? "A closed risk is no longer reviewed." : "An accepted risk is lived with as it is: no more treatment is planned."}
                  submit={open.status === "closed" ? "Close risk" : "Accept risk"}
                  busy={action.busy}
                  onSubmit={(note) => void send({ action: "set_status", status: open.status, note })}
                />
              )}
            </AdminSheet>
          )}
        </>
      )}
    </>
  )
}

/** The platform admin's page for one risk (/platform/risk-register/<id>): Mynt's own, or an app's or a product's read-only. */
export function RiskDetailPage({ riskId }: { riskId: string; onBack?: () => void }) {
  const router = useRouter()
  const pick = useCallback((b: Record<string, unknown>) => (b.detail ? (b as unknown as RiskDetailData) : undefined), [])
  const { state, reload } = useAdminData(riskDetailRoute("platform", { type: "platform", id: "mynt" }, riskId), pick)
  if (state.kind !== "ready") return <AdminNotReady state={state} what="This risk" />
  // Back goes to the register's tab for the risk's own area.
  const area = areaOfRisk(state.data.detail.risk)
  return <RiskDetailView key={state.data.detail.risk.id} data={state.data} where="platform" onBack={() => router.push(`${adminHref("risk-register")}${area ? `?tab=${area}` : ""}`)} onChanged={reload} />
}

/** The same detail in a sheet, from a row of an app's or a product's register. */
export function RiskDetailSheet({ subject, riskId, onClose, onChanged }: { subject: { type: "app" | "product"; id: string }; riskId: string | null; onClose: () => void; onChanged?: () => void }) {
  return (
    <Sheet open={riskId !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-5xl" data-risk-detail-sheet={riskId ?? undefined}>
        <SheetHeader>
          <SheetTitle>Risk</SheetTitle>
          <SheetDescription>Its scores and what explains them, the work that brings it down, what keeps it down, what it&apos;s about, and every change.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-6">{riskId && <RiskDetailLoader key={riskId} subject={subject} riskId={riskId} onClose={onClose} onChanged={onChanged} />}</div>
      </SheetContent>
    </Sheet>
  )
}

function RiskDetailLoader({ subject, riskId, onClose, onChanged }: { subject: { type: "app" | "product"; id: string }; riskId: string; onClose: () => void; onChanged?: () => void }) {
  const pick = useCallback((b: Record<string, unknown>) => (b.detail ? (b as unknown as RiskDetailData) : undefined), [])
  const { state, reload } = useAdminData(riskDetailRoute("studio", subject, riskId), pick)
  return state.kind === "ready" ? (
    <RiskDetailView data={state.data} where="studio" backLabel="Back to the register" onBack={onClose} onChanged={() => (reload(), onChanged?.())} />
  ) : (
    <AdminNotReady state={state} what="This risk" />
  )
}
