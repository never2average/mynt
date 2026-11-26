"use client"

// Admin → Platform settings → Risk grading (lib/risk-grading.ts; GET and POST /api/admin/risk-grading): how every risk
// on every register is graded, as ONE table filling the page under one toolbar (search, Filters, Export CSV, Version
// history, Edit bands). Its rows are the grading's rules, each with what it applies to, the inherent and residual
// side, and the level in words (coloured by level AND labelled: colour is never the only signal):
// - Level band: each level's name and its inherent and residual score bands,
// - Residual method: reduce (each control step's reduction, with a worked example) or matrix (the residual level per
//   inherent level and control step),
// - Likelihood × impact: the 5×5 heat map as 25 rows, the likeliest first: the score and the level it falls in.
// Edit bands opens the sheet that changes the level names, the bands and the residual method; Version history opens
// a sheet with every kept version as a row (who, when, why) and its labelled Restore this version. Either change
// makes a new version, and Mynt derives the residual scores that aren't overridden again and says how many moved.
import { useCallback, useMemo, useState } from "react"
import { History, SlidersHorizontal } from "lucide-react"

import { AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { csvOf } from "@/lib/admin"
import { bandsOf, bandWords, boundsOf, deriveResidual, levelOf, METHOD_LABELS, percentWords, stepWords, versionWords, type Grading, type GradingChange, type GradingData, type GradingVersion } from "@/lib/risk-grading"
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
    <AdminSheet open={open} title="Edit bands" description="The level names, the score bands and the residual method. Saving makes a new version; the old ones stay, and Mynt derives every residual score that isn't overridden again." onClose={onClose} error={problem ?? action.error} result={action.result} id="edit-grading">
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

export const GRADING_HEAD = ["Rule", "Applies to", "Inherent", "Residual", "Level"] as const
export const HISTORY_HEAD = ["Version", "When", "Who", "Why", "Residual scores moved", "Action"] as const
export const GRADING_RULES = ["band", "method", "score"] as const
export type GradingRule = (typeof GRADING_RULES)[number]
export const GRADING_RULE_LABELS: Record<GradingRule, string> = { band: "Level band", method: "Residual method", score: "Likelihood × impact" }
export type GradingRow = { key: string; rule: GradingRule; appliesTo: string; inherent: string; residual: string; level: RiskLevelKey; levelName: string }

/** The grading as the table's rows: the four bands, the residual method's steps, then the heat map's 25 cells (the likeliest first). */
export function gradingRows(data: GradingData): GradingRow[] {
  const g = data.grading
  const name = (l: RiskLevelKey) => g.levels[l]
  const bands: GradingRow[] = RISK_LEVELS_ASC.map((l, i) => ({ key: `band-${l}`, rule: "band", appliesTo: `Level ${i + 1}: ${name(l)}`, inherent: bandWords(g.inherent_bands[i]), residual: bandWords(g.residual_bands[i]), level: l, levelName: name(l) }))
  const method: GradingRow[] =
    g.residual_method === "reduce"
      ? CONTROL_STEPS.map((s) => {
          const r = deriveResidual(g, EXAMPLE, s)
          const level = levelOf(g.residual_bands, r)
          return { key: `method-${s}`, rule: "method", appliesTo: `${stepWords(s)} control`, inherent: `${percentWords(g.reduce[s])} taken off`, residual: `Inherent ${EXAMPLE} becomes ${r}`, level, levelName: name(level) }
        })
      : RISK_LEVELS_ASC.flatMap((l) =>
          CONTROL_STEPS.map((s): GradingRow => ({ key: `method-${l}-${s}`, rule: "method", appliesTo: `${name(l)} risk with a ${stepWords(s).toLowerCase()} control`, inherent: name(l), residual: name(g.matrix[l][s]), level: g.matrix[l][s], levelName: name(g.matrix[l][s]) })),
        )
  const scores: GradingRow[] = data.heatMap.flatMap((row) =>
    row.cells.map(
      (c): GradingRow => ({
        key: `score-${row.likelihood}x${c.impact}`,
        rule: "score",
        appliesTo: `Likelihood ${row.likelihood}: ${LIKELIHOOD_WORDS[row.likelihood]} × Impact ${c.impact}: ${IMPACT_WORDS[c.impact]}`,
        inherent: String(c.score),
        residual: "By the control's effectiveness",
        level: c.level,
        levelName: c.levelName,
      }),
    ),
  )
  return [...bands, ...method, ...scores]
}

/** Version history: every kept version as a row, with its labelled Restore this version. */
export function GradingHistorySheet({ data, open, onClose, onRestore }: { data: GradingData; open: boolean; onClose: () => void; onRestore: (v: GradingVersion) => void }) {
  return (
    <AdminSheet
      open={open}
      title="Version history"
      description="Every version of the grading that was in force: who changed it, when and why, and how many residual scores it moved. Restoring one makes a new version; none is ever lost."
      onClose={onClose}
      id="grading-history"
    >
      <div className="overflow-x-auto rounded-lg border" data-grading-history>
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
                <Button size="sm" variant="outline" onClick={() => onRestore(v)} data-restore-version={v.version}>
                  <History /> Restore this version
                </Button>
              </span>
            ),
          ])}
          empty="No versions yet: these are Mynt's defaults. The first change keeps them as version 1."
        />
      </div>
    </AdminSheet>
  )
}

export const GRADING_CSV_HEAD = ["Rule", "Applies to", "Inherent", "Residual", "Level"]

/** The Risk grading tab: one toolbar, one table; Edit bands, Version history and Restore this version in sheets. */
export function RiskGradingView({ data, onChanged = () => undefined, sheet = null, fetcher }: { data: GradingData; onChanged?: () => void; sheet?: "edit" | "history" | { restore: number } | null; fetcher?: typeof fetch }) {
  const [editing, setEditing] = useState(sheet === "edit")
  const [history, setHistory] = useState(sheet === "history")
  const [restoring, setRestoring] = useState<GradingVersion | null>(sheet && typeof sheet === "object" ? (data.history.find((v) => v.version === sheet.restore) ?? null) : null)
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState("")
  const [rule, setRule] = useState<string[]>([])
  const [level, setLevel] = useState<string[]>([])
  const close = () => {
    setEditing(false)
    setHistory(false)
    setRestoring(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const g = data.grading
  const all = useMemo(() => gradingRows(data), [data])
  const rows = useMemo(
    () => all.filter((r) => matches(query, GRADING_RULE_LABELS[r.rule], r.appliesTo, r.inherent, r.residual, r.levelName) && (!rule.length || rule.includes(r.rule)) && (!level.length || level.includes(r.level))),
    [all, query, rule, level],
  )
  const paged = usePaged(rows)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-risk-grading data-grading-version={data.version}>
      <AdminList
        id="risk-grading"
        search={query}
        onSearch={setQuery}
        searchLabel="Search the grading by rule, score or level"
        facets={[
          { id: "rule", label: "Rule", options: GRADING_RULES.map((r) => ({ value: r, label: GRADING_RULE_LABELS[r] })), selected: rule, onChange: setRule },
          { id: "level", label: "Level", options: RISK_LEVELS_ASC.map((l) => ({ value: l, label: g.levels[l] })), selected: level, onChange: setLevel },
        ]}
        onClearFilters={() => (setRule([]), setLevel([]))}
        importable={false}
        onExport={() => downloadCsv(`risk-grading-version-${data.version}.csv`, csvOf(GRADING_CSV_HEAD, rows.map((r) => [GRADING_RULE_LABELS[r.rule], r.appliesTo, r.inherent, r.residual, r.levelName])))}
        exportDisabled={!rows.length}
        cta={
          <>
            <Button variant="outline" onClick={() => setHistory(true)} data-grading-history-open>
              <History /> Version history
            </Button>
            <Button onClick={() => setEditing(true)} data-edit-grading>
              <SlidersHorizontal /> Edit bands
            </Button>
          </>
        }
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable
          head={GRADING_HEAD}
          rowKeys={paged.shown.map((r) => r.key)}
          rows={paged.shown.map((r) => [
            <span key="r" data-grading-rule={r.rule}>
              {GRADING_RULE_LABELS[r.rule]}
            </span>,
            <span key="a" className="block min-w-48 font-normal whitespace-normal">
              {r.appliesTo}
            </span>,
            r.inherent,
            r.residual,
            <span key="l" className={`rounded px-1.5 py-0.5 ${LEVEL_CLASS[r.level]}`} data-level={r.level}>
              {r.levelName}
            </span>,
          ])}
          empty="No rule matches."
        />
      </AdminList>
      <EditGradingSheet key={`e${data.version}:${editing}`} data={data} open={editing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <GradingHistorySheet
        data={data}
        open={history}
        onClose={close}
        onRestore={(v) => {
          setHistory(false)
          setRestoring(v)
        }}
      />
      <RestoreGradingSheet key={`r${restoring?.version ?? ""}`} version={restoring} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </div>
  )
}

/** Platform settings' Risk grading tab. */
export function RiskGradingSection() {
  const pick = useCallback((b: Record<string, unknown>) => (b.grading ? (b.grading as GradingData) : undefined), [])
  const { state, reload } = useAdminData("/api/admin/risk-grading", pick)
  return state.kind === "ready" ? <RiskGradingView data={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="Risk grading" />
}
