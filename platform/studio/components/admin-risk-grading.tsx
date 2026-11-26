"use client"

// Admin → Platform settings → Risk grading (lib/risk-grading.ts; GET and POST /api/admin/risk-grading): how every risk
// on every register is graded. Four tables, read-only:
// - the likelihood × impact heat map: a real 5×5 table, each cell its score and its level in words (coloured by level
//   AND labelled: colour is never the only signal),
// - the bands: each level's name and its inherent and residual score bands,
// - the residual method: reduce (each control step's reduction, with a worked example) or matrix (the residual level
//   per inherent level and control step), with the method in words,
// - the version history, each kept version with who, when and why, and a labelled Restore this version.
// Edit grading and Restore this version are labelled buttons opening a sheet; either makes a new version, and Mynt
// derives the residual scores that aren't overridden again and says how many moved. Server-renderable.
import { useCallback, useState } from "react"
import { History, SlidersHorizontal } from "lucide-react"

import { AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { Section } from "@/components/dashboard-panels"
import { Button } from "@/components/ui/button"
import { bandsOf, bandWords, boundsOf, deriveResidual, METHOD_LABELS, percentWords, stepWords, versionWords, type Grading, type GradingChange, type GradingData, type GradingVersion } from "@/lib/risk-grading"
import { CONTROL_STEPS, RISK_LEVELS_ASC, type ControlStep, type RiskLevelKey } from "@/lib/risk-register"
import { IMPACT_WORDS, LIKELIHOOD_WORDS } from "@/components/risk-register"

const ROUTE = "/api/admin/risk-grading"
// A level's colour, with dark text on it: the level's name is always in the cell too.
const LEVEL_CLASS: Record<RiskLevelKey, string> = {
  low: "bg-emerald-100 text-emerald-950 dark:bg-emerald-950 dark:text-emerald-100",
  medium: "bg-amber-100 text-amber-950 dark:bg-amber-950 dark:text-amber-100",
  high: "bg-orange-200 text-orange-950 dark:bg-orange-950 dark:text-orange-100",
  critical: "bg-red-200 text-red-950 dark:bg-red-950 dark:text-red-100",
}
const whenOf = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "Not recorded")
const EXAMPLE = 20

/** The 5×5 grid as a table: likelihood down the side (the likeliest first), impact across, each cell its score and level. */
export function HeatMapTable({ data }: { data: GradingData }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full border-collapse text-sm" data-heat-map>
        <caption className="caption-top px-3 py-2 text-left text-xs text-muted-foreground">Inherent score = likelihood × impact. Each cell shows the score and the level it falls in.</caption>
        <thead>
          <tr>
            <th scope="col" className="border-b px-3 py-2 text-left font-medium">
              Likelihood ↓ · Impact →
            </th>
            {[1, 2, 3, 4, 5].map((i) => (
              <th key={i} scope="col" className="border-b px-3 py-2 text-left font-medium">
                {i}: {IMPACT_WORDS[i]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.heatMap.map((row) => (
            <tr key={row.likelihood} data-heat-row={row.likelihood}>
              <th scope="row" className="border-b px-3 py-2 text-left font-medium whitespace-nowrap">
                {row.likelihood}: {LIKELIHOOD_WORDS[row.likelihood]}
              </th>
              {row.cells.map((c) => (
                <td key={c.impact} className={`border-b px-3 py-2 tabular-nums ${LEVEL_CLASS[c.level]}`} data-heat-cell={`${row.likelihood}x${c.impact}`} data-score={c.score} data-level={c.level}>
                  {c.score} · {c.levelName}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type Draft = { names: Record<RiskLevelKey, string>; inherent: string[]; residual: string[]; method: Grading["residual_method"]; reduce: Record<ControlStep, string>; matrix: Grading["matrix"]; note: string }
const draftOf = (g: Grading): Draft => ({
  names: { ...g.levels },
  inherent: boundsOf(g.inherent_bands).map(String),
  residual: boundsOf(g.residual_bands).map(String),
  method: g.residual_method,
  reduce: Object.fromEntries(CONTROL_STEPS.map((s) => [s, String(Math.round(g.reduce[s] * 100))])) as Record<ControlStep, string>,
  matrix: JSON.parse(JSON.stringify(g.matrix)) as Grading["matrix"],
  note: "",
})
/** The draft as what Mynt takes: only what differs from the grading in force; or why it can't be sent. */
export function changeOf(d: Draft, g: Grading): { ok: true; change: GradingChange } | { ok: false; error: string } {
  const inherent = bandsOf(d.inherent.map(Number))
  if (!inherent.ok) return { ok: false, error: `Inherent bands: ${inherent.error}` }
  const residual = bandsOf(d.residual.map(Number))
  if (!residual.ok) return { ok: false, error: `Residual bands: ${residual.error}` }
  const shares = CONTROL_STEPS.map((s) => Number(d.reduce[s]))
  if (shares.some((n) => !Number.isFinite(n) || n < 0 || n > 100)) return { ok: false, error: "Each reduction is a percentage from 0 to 100." }
  const next: Grading = {
    levels: Object.fromEntries(RISK_LEVELS_ASC.map((l) => [l, d.names[l].trim()])) as Grading["levels"],
    inherent_bands: inherent.bands,
    residual_bands: residual.bands,
    residual_method: d.method,
    reduce: Object.fromEntries(CONTROL_STEPS.map((s, i) => [s, shares[i] / 100])) as Grading["reduce"],
    matrix: d.matrix,
  }
  if (RISK_LEVELS_ASC.some((l) => !next.levels[l])) return { ok: false, error: "Each level needs a name." }
  const changed = (Object.keys(next) as (keyof Grading)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(g[k]))
  if (!changed.length) return { ok: false, error: "Nothing changed yet." }
  return { ok: true, change: { action: "set", note: d.note.trim(), ...Object.fromEntries(changed.map((k) => [k, next[k]])) } as GradingChange }
}

export function EditGradingSheet({ data, open, onClose, onDone, fetcher }: { data: GradingData; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [d, setD] = useState<Draft>(() => draftOf(data.grading))
  const [problem, setProblem] = useState<string | null>(null)
  const action = useAdminAction(fetcher)
  const set = (p: Partial<Draft>) => setD((was) => ({ ...was, ...p }))
  const bound = (key: "inherent" | "residual", i: number, v: string) => set({ [key]: d[key].map((x, n) => (n === i ? v : x)) } as Partial<Draft>)
  return (
    <AdminSheet open={open} title="Edit grading" description="The level names, the score bands and the residual method. Saving makes a new version; the old ones stay, and Mynt derives every residual score that isn't overridden again." onClose={onClose} error={problem ?? action.error} result={action.result} id="edit-grading">
      {action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-grading-form
          onSubmit={(e) => {
            e.preventDefault()
            const c = changeOf(d, data.grading)
            if (!c.ok) return setProblem(c.error)
            setProblem(null)
            void action.run(ROUTE, c.change).then((res) => res?.ok === true && onDone())
          }}
        >
          <fieldset className="flex flex-col gap-2" data-grading-bands>
            <legend className="text-sm font-medium">Levels and bands</legend>
            <p className="text-xs text-muted-foreground">Each band starts right after the one below ends: low at 1, critical always ends at 25.</p>
            {RISK_LEVELS_ASC.map((l, i) => (
              <div key={l} className="grid grid-cols-3 gap-2">
                <Field label={`Level ${i + 1} name`}>
                  <input className={fieldClass} value={d.names[l]} onChange={(e) => set({ names: { ...d.names, [l]: e.target.value } })} maxLength={40} required data-grading-field={`name-${l}`} />
                </Field>
                {(["inherent", "residual"] as const).map((key) => (
                  <Field key={key} label={`${key === "inherent" ? "Inherent" : "Residual"} band ends at`}>
                    {i < 3 ? (
                      <input className={fieldClass} type="number" min={1} max={24} value={d[key][i]} onChange={(e) => bound(key, i, e.target.value)} required data-grading-field={`${key}-${l}`} />
                    ) : (
                      <input className={fieldClass} value="25" readOnly aria-readonly data-grading-field={`${key}-${l}`} />
                    )}
                  </Field>
                ))}
              </div>
            ))}
          </fieldset>
          <Field label="Residual method">
            <select className={fieldClass} value={d.method} onChange={(e) => set({ method: e.target.value as Grading["residual_method"] })} data-grading-field="method">
              {(["reduce", "matrix"] as const).map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABELS[m]}
                </option>
              ))}
            </select>
          </Field>
          {d.method === "reduce" ? (
            <fieldset className="grid grid-cols-2 gap-2" data-grading-reduce>
              <legend className="text-sm font-medium">Share taken off the inherent score (%)</legend>
              {CONTROL_STEPS.map((s) => (
                <Field key={s} label={`${stepWords(s)} control`}>
                  <input className={fieldClass} type="number" min={0} max={100} value={d.reduce[s]} onChange={(e) => set({ reduce: { ...d.reduce, [s]: e.target.value } })} required data-grading-field={`reduce-${s}`} />
                </Field>
              ))}
            </fieldset>
          ) : (
            <fieldset className="flex flex-col gap-2" data-grading-matrix>
              <legend className="text-sm font-medium">Residual level per inherent level and control effectiveness</legend>
              {RISK_LEVELS_ASC.map((l) => (
                <div key={l} className="grid grid-cols-4 gap-2">
                  {CONTROL_STEPS.map((s) => (
                    <Field key={s} label={`${d.names[l] || l} · ${stepWords(s)}`}>
                      <select className={fieldClass} value={d.matrix[l][s]} onChange={(e) => set({ matrix: { ...d.matrix, [l]: { ...d.matrix[l], [s]: e.target.value as RiskLevelKey } } })} data-grading-field={`matrix-${l}-${s}`}>
                        {RISK_LEVELS_ASC.map((x) => (
                          <option key={x} value={x}>
                            {d.names[x] || x}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
              ))}
            </fieldset>
          )}
          <Field label="Why the grading changes" hint="Kept with the version.">
            <textarea className={`${fieldClass} min-h-16`} value={d.note} onChange={(e) => set({ note: e.target.value })} maxLength={2000} required data-grading-field="note" />
          </Field>
          <div>
            <Button type="submit" disabled={action.busy || d.note.trim().length < 3} data-grading-submit="set">
              {action.busy ? "Saving…" : "Save as a new version"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

export function RestoreGradingSheet({ version, onClose, onDone, fetcher }: { version: GradingVersion | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [note, setNote] = useState("")
  const action = useAdminAction(fetcher)
  return (
    <AdminSheet
      open={version !== null}
      title="Restore this version"
      description="Its level names, bands and residual method come back as a new version; every version stays in the history. Mynt derives every residual score that isn't overridden again."
      onClose={onClose}
      error={action.error}
      result={action.result}
      id="restore-grading"
    >
      {version && action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-restore-form={version.version}
          onSubmit={(e) => {
            e.preventDefault()
            const change: GradingChange = { action: "restore", version: version.version, note: note.trim() }
            void action.run(ROUTE, change).then((res) => res?.ok === true && onDone())
          }}
        >
          <p className="text-sm">
            Restore version {version.version}
            {version.note ? `: “${version.note}”` : ""}?
          </p>
          <Field label="Why it's restored" hint="Kept with the new version.">
            <textarea className={`${fieldClass} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required data-grading-field="restore-note" />
          </Field>
          <div>
            <Button type="submit" disabled={action.busy || note.trim().length < 3} data-grading-submit="restore">
              {action.busy ? "Restoring…" : "Restore this version"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

export const BANDS_HEAD = ["Level", "Name", "Inherent band", "Residual band"] as const
export const REDUCE_HEAD = ["Control effectiveness", "Share taken off", `Example: inherent ${EXAMPLE} becomes`] as const
export const HISTORY_HEAD = ["Version", "When", "Who", "Why", "Residual scores moved", "Action"] as const

/** The section's four tables, with Edit grading and each version's Restore this version. */
export function RiskGradingView({ data, onChanged = () => undefined, sheet = null, fetcher }: { data: GradingData; onChanged?: () => void; sheet?: "edit" | { restore: number } | null; fetcher?: typeof fetch }) {
  const [editing, setEditing] = useState(sheet === "edit")
  const [restoring, setRestoring] = useState<GradingVersion | null>(sheet && sheet !== "edit" ? (data.history.find((v) => v.version === sheet.restore) ?? null) : null)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setEditing(false)
    setRestoring(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const g = data.grading
  const residualLevel = (score: number) => g.levels[(g.residual_bands.find((b) => score >= b.from && score <= b.to) ?? g.residual_bands[3]).level]
  const sub = (title: string, id: string, body: React.ReactNode, note?: string) => (
    <section className="flex min-w-0 flex-col gap-1" data-grading-table={id}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {body}
    </section>
  )
  return (
    <div className="flex flex-col gap-4" data-risk-grading data-grading-version={data.version}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm" data-grading-in-force>
          In force: {versionWords(data.version)}.
        </p>
        <Button variant="outline" onClick={() => setEditing(true)} data-edit-grading>
          <SlidersHorizontal /> Edit grading
        </Button>
      </div>
      {sub("Likelihood × impact", "heat-map", <HeatMapTable data={data} />)}
      {sub(
        "Levels and bands",
        "bands",
        <div className="overflow-x-auto rounded-lg border">
          <AdminTable
            head={BANDS_HEAD}
            rowKeys={[...RISK_LEVELS_ASC]}
            rows={RISK_LEVELS_ASC.map((l, i) => [
              `Level ${i + 1}`,
              <span key="n" className={`rounded px-1.5 py-0.5 ${LEVEL_CLASS[l]}`} data-level-name={l}>
                {g.levels[l]}
              </span>,
              bandWords(g.inherent_bands[i]),
              bandWords(g.residual_bands[i]),
            ])}
            empty="No levels."
          />
        </div>,
        "A score's level is the band it falls in. Together the bands cover 1 to 25 with no gap.",
      )}
      {sub(
        "Residual method",
        "method",
        <div className="overflow-x-auto rounded-lg border">
          {g.residual_method === "reduce" ? (
            <AdminTable
              head={REDUCE_HEAD}
              rowKeys={[...CONTROL_STEPS]}
              rows={CONTROL_STEPS.map((s) => {
                const r = deriveResidual(g, EXAMPLE, s)
                return [stepWords(s), percentWords(g.reduce[s]), `${r} (${residualLevel(r)})`]
              })}
              empty="No steps."
            />
          ) : (
            <AdminTable
              head={["Inherent level", ...CONTROL_STEPS.map((s) => `${stepWords(s)} control`)]}
              rowKeys={[...RISK_LEVELS_ASC]}
              rows={RISK_LEVELS_ASC.map((l) => [g.levels[l], ...CONTROL_STEPS.map((s) => g.levels[g.matrix[l][s]])])}
              empty="No levels."
            />
          )}
        </div>,
        `${METHOD_LABELS[g.residual_method]}. ${data.methodWords} A risk whose control isn't assessed stands at its inherent score; one whose keeper set the residual themselves (an override) is never derived again.`,
      )}
      {sub(
        "Version history",
        "history",
        <div className="overflow-x-auto rounded-lg border">
          <AdminTable
            head={HISTORY_HEAD}
            rowKeys={data.history.map((v) => String(v.version))}
            rows={data.history.map((v) => [
              `Version ${v.version}${v.version === data.version ? " (in force)" : ""}`,
              whenOf(v.at),
              v.by ?? "Mynt",
              <span key="w" className="block min-w-40 font-normal whitespace-normal">
                {v.note ?? "No reason recorded"}
                {v.restoredFrom !== null ? ` (restored version ${v.restoredFrom})` : ""}
              </span>,
              v.residualsChanged === null ? "Not recorded" : String(v.residualsChanged),
              v.version === data.version || !v.grading ? (
                v.version === data.version ? "In force" : "Can't be read"
              ) : (
                <span key="a" className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => setRestoring(v)} data-restore-version={v.version}>
                    <History /> Restore this version
                  </Button>
                </span>
              ),
            ])}
            empty="No versions yet: these are Mynt's defaults. The first change keeps them as version 1."
          />
        </div>,
      )}
      <EditGradingSheet key={`e${data.version}:${editing}`} data={data} open={editing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <RestoreGradingSheet key={`r${restoring?.version ?? ""}`} version={restoring} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </div>
  )
}

/** Platform settings' Risk grading section. */
export function RiskGradingSection() {
  const pick = useCallback((b: Record<string, unknown>) => (b.grading ? (b.grading as GradingData) : undefined), [])
  const { state, reload } = useAdminData("/api/admin/risk-grading", pick)
  return (
    <Section id="risk-grading" title="Risk grading" description="How every risk on every register is graded: the levels, their score bands, and how the residual score is derived from the inherent score and the control's effectiveness.">
      {state.kind === "ready" ? <RiskGradingView data={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="Risk grading" />}
    </Section>
  )
}
