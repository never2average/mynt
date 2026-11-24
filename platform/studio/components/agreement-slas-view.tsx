"use client"

// The SLA tab's commitments and breaches (lib/agreement-slas.ts), shown in a service level agreement's detail as two
// tabs, each a table: Commitments (metric, target, window, source, remedy, status) and Breaches (the period, what
// was measured, who recorded it, whether it's resolved). The actions are labelled buttons opening a sheet:
// Add commitment (either side, before the agreement is signed), Record breach and Retire commitment (on a
// commitment), Resolve breach (on an open breach). Mynt checks each again; its refusal is shown in its own words.
import { useEffect, useState } from "react"

import type { DetailTable } from "@/components/licences-kit"
import { dayOf } from "@/components/licences-kit"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { SIDE_LABELS, SLA_WINDOWS, slaStatusText, WINDOW_LABELS, type BreachRow, type SlaRow } from "@/lib/agreement-slas"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"

export type SlaSheetMode =
  | { kind: "add"; agreementId: string; title: string }
  | { kind: "record_breach"; sla: SlaRow }
  | { kind: "retire"; sla: SlaRow }
  | { kind: "resolve_breach"; sla: SlaRow; breach: BreachRow }

const TITLES: Record<SlaSheetMode["kind"], string> = { add: "Add commitment", record_breach: "Record breach", retire: "Retire commitment", resolve_breach: "Resolve breach" }

/** What each sheet posts, and where. */
export function slaRequest(mode: SlaSheetMode, values: Record<string, string>): { url: string; body: Record<string, unknown> } {
  const asNumber = (v: string) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v.trim())
  if (mode.kind === "add")
    return {
      url: "/api/agreement-slas",
      body: { agreement_id: mode.agreementId, metric: values.metric ?? "", target: asNumber(values.target ?? ""), unit: values.unit ?? "", measurement_window: values.window ?? "monthly", measurement_source: values.source ?? "", remedy: values.remedy ?? "" },
    }
  const url = `/api/agreement-slas/${encodeURIComponent(mode.sla.id)}`
  if (mode.kind === "record_breach") return { url, body: { action: "record_breach", period_start: values.from ?? "", period_end: values.to ?? "", measured_value: asNumber(values.measured ?? ""), note: values.note ?? "" } }
  if (mode.kind === "retire") return { url, body: { action: "retire", reason: values.reason ?? "" } }
  return { url, body: { action: "resolve_breach", breach_id: mode.breach.id, note: values.note ?? "" } }
}

export function SlaFormView({ mode, busy = false, error = null, result = null, onSubmit }: { mode: SlaSheetMode; busy?: boolean; error?: string | null; result?: string | null; onSubmit: (values: Record<string, string>) => void }) {
  const [v, setV] = useState<Record<string, string>>({ window: "monthly" })
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value })
  const ready =
    mode.kind === "add"
      ? (v.metric ?? "").trim().length >= 3 && (v.target ?? "").trim().length > 0 && (v.source ?? "").trim().length >= 3
      : mode.kind === "record_breach"
        ? Boolean(v.from && v.to && (v.measured ?? "").trim())
        : mode.kind === "retire"
          ? (v.reason ?? "").trim().length >= 3
          : true
  return (
    <form
      className="flex flex-col gap-3"
      data-sla-form={mode.kind}
      onSubmit={(e) => {
        e.preventDefault()
        if (ready) onSubmit(v)
      }}
    >
      {mode.kind !== "add" && (
        <div className="rounded-lg border p-3 text-sm" data-sla-summary={mode.sla.id}>
          <p className="font-medium">{mode.sla.metric}</p>
          <p className="text-muted-foreground">
            Target {mode.sla.target}, measured {mode.sla.window.toLowerCase()} from {mode.sla.source}
          </p>
        </div>
      )}
      {mode.kind === "add" && (
        <>
          <label className="flex flex-col gap-1 text-sm">
            Metric
            <input className={field} value={v.metric ?? ""} onChange={set("metric")} maxLength={200} placeholder="Ledger API availability" data-sla-metric />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm">
              Target
              <input className={field} value={v.target ?? ""} onChange={set("target")} maxLength={200} placeholder="99.9" data-sla-target />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Unit (optional)
              <input className={field} value={v.unit ?? ""} onChange={set("unit")} maxLength={40} placeholder="%" data-sla-unit />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Measured
            <select className={field} value={v.window} onChange={set("window")} data-sla-window>
              {SLA_WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {WINDOW_LABELS[w]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Measured from
            <input className={field} value={v.source ?? ""} onChange={set("source")} maxLength={500} placeholder="The provider's status page" data-sla-source />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Remedy when it&apos;s missed (optional)
            <textarea className={`${field} min-h-16`} value={v.remedy ?? ""} onChange={set("remedy")} maxLength={2000} data-sla-remedy />
          </label>
        </>
      )}
      {mode.kind === "record_breach" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-sm">
              Period from
              <input className={field} type="date" value={v.from ?? ""} onChange={set("from")} data-breach-from />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Period to
              <input className={field} type="date" value={v.to ?? ""} onChange={set("to")} data-breach-to />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Measured value
            <input className={field} value={v.measured ?? ""} onChange={set("measured")} maxLength={200} data-breach-measured />
          </label>
        </>
      )}
      {mode.kind === "retire" ? (
        <label className="flex flex-col gap-1 text-sm">
          Reason
          <textarea className={`${field} min-h-16`} value={v.reason ?? ""} onChange={set("reason")} maxLength={2000} data-sla-reason />
        </label>
      ) : (
        mode.kind !== "add" && (
          <label className="flex flex-col gap-1 text-sm">
            Note (optional)
            <textarea className={`${field} min-h-16`} value={v.note ?? ""} onChange={set("note")} maxLength={2000} data-sla-note />
          </label>
        )
      )}
      {result === null && (
        <div>
          <Button type="submit" variant={mode.kind === "retire" ? "destructive" : "default"} disabled={busy || !ready} data-sla-submit={mode.kind}>
            {busy ? "Saving…" : TITLES[mode.kind]}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-sla-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-sla-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function SlaSheet({ mode, onClose, onDone, fetcher = (...a) => fetch(...a) }: { mode: SlaSheetMode | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!mode) return
    setError(null)
    setResult(null)
    setRound((r) => r + 1)
  }, [mode])
  const submit = async (values: Record<string, string>) => {
    if (busy || !mode) return
    setBusy(true)
    setError(null)
    const { url, body } = slaRequest(mode, values)
    const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { message?: string } | null
    setBusy(false)
    if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
    if (!res?.ok) return setError(data?.message ?? "Couldn't reach Mynt. Please try again.")
    setResult(data?.message ?? "Done.")
    onDone()
  }
  return (
    <Sheet open={mode !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-sla-sheet={mode?.kind}>
        <SheetHeader>
          <SheetTitle>{mode ? TITLES[mode.kind] : "SLA"}</SheetTitle>
          <SheetDescription>{mode?.kind === "add" ? mode.title : "Recorded in the audit trail; the other side is told."}</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">{mode && <SlaFormView key={round} mode={mode} busy={busy} error={error} result={result} onSubmit={(v) => void submit(v)} />}</div>
      </SheetContent>
    </Sheet>
  )
}

/** A service level agreement's Commitments and Breaches tabs, each a table, with the labelled actions Mynt allows. */
export function slaDetailTabs(slas: SlaRow[], onSheet: (m: SlaSheetMode) => void): DetailTable[] {
  const breaches = slas.flatMap((s) => s.breaches.map((b) => ({ s, b })))
  return [
    {
      id: "commitments",
      label: "Commitments",
      headers: ["Metric", "Target", "Measured", "Source", "Remedy", "Status", "Actions"],
      rows: slas.map((s) => ({
        key: s.id,
        cells: [
          s.metric,
          s.target,
          s.window,
          s.source,
          s.remedy ?? "—",
          slaStatusText(s),
          <div key="a" className="flex flex-wrap gap-1.5" data-sla-actions={s.id}>
            {s.actions.includes("record_breach") && (
              <Button size="sm" variant="outline" className="h-7" onClick={() => onSheet({ kind: "record_breach", sla: s })} data-record-breach={s.id}>
                Record breach
              </Button>
            )}
            {s.actions.includes("retire") && (
              <Button size="sm" variant="outline" className="h-7" onClick={() => onSheet({ kind: "retire", sla: s })} data-retire-sla={s.id}>
                Retire commitment
              </Button>
            )}
          </div>,
        ],
      })),
      empty: "No commitments yet. Either side adds them before the agreement is signed.",
    },
    {
      id: "breaches",
      label: "Breaches",
      headers: ["Commitment", "Period", "Measured", "Recorded by", "Status", "Actions"],
      rows: breaches.map(({ s, b }) => ({
        key: b.id,
        cells: [
          s.metric,
          `${dayOf(b.periodStart)} to ${dayOf(b.periodEnd)}`,
          b.measured,
          [b.recordedBy, b.recordedSide ? SIDE_LABELS[b.recordedSide] : null].filter(Boolean).join(", ") || "—",
          b.open ? "Open" : `Resolved ${dayOf(b.resolvedAt)}${b.resolutionNote ? `: ${b.resolutionNote}` : ""}`,
          b.canResolve && b.open ? (
            <Button key="r" size="sm" variant="outline" className="h-7" onClick={() => onSheet({ kind: "resolve_breach", sla: s, breach: b })} data-resolve-breach={b.id}>
              Resolve breach
            </Button>
          ) : (
            "—"
          ),
        ],
      })),
      empty: "No breaches recorded.",
    },
  ]
}
