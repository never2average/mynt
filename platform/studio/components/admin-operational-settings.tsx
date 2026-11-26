"use client"

// Platform admin → Platform settings → Operational settings (lib/platform-settings.ts; GET and POST
// /api/admin/settings): the non-secret settings this Mynt runs with, as ONE table filling the page under one toolbar
// (search, Filters, Export CSV). One row per setting: its value in effect, Mynt's default, where the value comes from
// and what it's for. Change setting is a labelled button opening a sheet that says how the value is checked and what
// changes; a setting the server's environment sets is a read-only row that says so. No secret is ever a setting.
import { useCallback, useMemo, useState } from "react"
import { SlidersHorizontal } from "lucide-react"

import { AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { csvOf } from "@/lib/admin"
import { ENV_SETTING_NOTE, SETTING_CSV_HEAD, SETTING_SOURCE_LABELS, settingCsvRow, settingSourceWords, type PlatformSetting, type SettingSource } from "@/lib/platform-settings"

const ROUTE = "/api/admin/settings"
export const SETTINGS_HEAD = ["Setting", "Value", "Default", "Source", "Description", "Action"] as const
const SOURCES: SettingSource[] = ["environment", "stored", "default"]

/** Change setting: the new value, how it's checked, and what changes. */
export function ChangeSettingSheet({ target, onClose, onDone, fetcher }: { target: PlatformSetting | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [value, setValue] = useState(target?.value ?? "")
  const action = useAdminAction(fetcher)
  const send = (v: string | null) => target && void action.run(ROUTE, { key: target.key, value: v }).then((res) => res?.ok === true && onDone())
  const changed = target !== null && value.trim() !== "" && value.trim() !== target.value
  return (
    <AdminSheet
      open={target !== null}
      title="Change setting"
      description="Mynt checks the new value against the setting's type and range, then uses it from the next build, audit, exploration or usage sample. No restart is needed. The change is audited, old value to new."
      onClose={onClose}
      error={action.error}
      result={action.result}
      id="change-setting"
    >
      {target && action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-setting-form={target.key}
          onSubmit={(e) => {
            e.preventDefault()
            if (changed) send(value.trim())
          }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-setting-facts>
            <dt className="text-muted-foreground">Setting</dt>
            <dd>
              <code className="text-xs">{target.key}</code>: {target.description}
            </dd>
            <dt className="text-muted-foreground">Used by</dt>
            <dd>{target.usedBy || "Mynt's server"}</dd>
            <dt className="text-muted-foreground">Now</dt>
            <dd>
              {target.value} ({settingSourceWords(target)})
            </dd>
            <dt className="text-muted-foreground">Default</dt>
            <dd>{target.default}</dd>
          </dl>
          <Field label="New value" hint={target.validation ?? undefined}>
            {target.options ? (
              <select className={fieldClass} value={value} onChange={(e) => setValue(e.target.value)} data-setting-input>
                {target.options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : (
              <input className={fieldClass} value={value} onChange={(e) => setValue(e.target.value)} maxLength={600} autoComplete="off" spellCheck={false} required data-setting-input />
            )}
          </Field>
          <p className="text-sm" data-setting-change>
            {changed ? `${target.key} changes from ${target.value} to ${value.trim()}.` : "Nothing changes yet."}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={action.busy || !changed} data-setting-submit="set">
              {action.busy ? "Saving…" : "Save setting"}
            </Button>
            {target.source === "stored" && (
              <Button type="button" variant="outline" disabled={action.busy} onClick={() => send(null)} data-setting-submit="reset">
                Reset to Mynt&apos;s default ({target.default})
              </Button>
            )}
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

/** The Operational settings tab: one toolbar, one table. */
export function OperationalSettingsView({ settings, editable = true, onChanged = () => undefined, fetcher, opening = null }: { settings: PlatformSetting[]; editable?: boolean; onChanged?: () => void; fetcher?: typeof fetch; opening?: string | null }) {
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<string[]>([])
  const [changing, setChanging] = useState<PlatformSetting | null>(settings.find((s) => s.key === opening) ?? null)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setChanging(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const rows = useMemo(() => settings.filter((s) => matches(query, s.key, s.description, s.usedBy, s.value, SETTING_SOURCE_LABELS[s.source]) && (!source.length || source.includes(s.source))), [settings, query, source])
  const paged = usePaged(rows)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-operational-settings>
      <AdminList
        id="operational-settings"
        search={query}
        onSearch={setQuery}
        searchLabel="Search settings by name, value or what they're for"
        facets={[{ id: "source", label: "Source", options: SOURCES.map((s) => ({ value: s, label: SETTING_SOURCE_LABELS[s] })), selected: source, onChange: setSource }]}
        onClearFilters={() => setSource([])}
        importable={false}
        onExport={() => downloadCsv("operational-settings.csv", csvOf(SETTING_CSV_HEAD, rows.map(settingCsvRow)))}
        exportDisabled={!rows.length}
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable
          head={SETTINGS_HEAD}
          rowKeys={paged.shown.map((s) => s.key)}
          rows={paged.shown.map((s) => [
            <code key="k" className="text-xs">
              {s.key}
            </code>,
            <span key="v" data-setting-value>
              {s.value}
            </span>,
            s.default,
            <span key="s" data-setting-source={s.source}>
              {settingSourceWords(s)}
            </span>,
            <span key="d" className="block min-w-48 font-normal whitespace-normal">
              {s.description}
              {s.usedBy ? <span className="block text-xs text-muted-foreground">Used by: {s.usedBy}</span> : null}
            </span>,
            s.source === "environment" ? (
              <span key="a" className="block min-w-40 text-xs whitespace-normal text-muted-foreground" data-setting-read-only>
                {ENV_SETTING_NOTE}
              </span>
            ) : editable ? (
              <span key="a" className="flex justify-end">
                <Button size="sm" variant="outline" onClick={() => setChanging(s)} data-change-setting={s.key}>
                  <SlidersHorizontal /> Change setting
                </Button>
              </span>
            ) : (
              <span key="a" className="block text-xs text-muted-foreground" data-setting-read-only>
                Changing it here comes with Mynt&apos;s next update
              </span>
            ),
          ])}
          empty="No setting matches."
        />
      </AdminList>
      <ChangeSettingSheet key={`c${changing?.key ?? ""}`} target={changing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </div>
  )
}

type SettingsData = { settings: PlatformSetting[]; editable: boolean }

/** Platform settings' Operational settings tab. */
export function OperationalSettingsTab() {
  const pick = useCallback((b: Record<string, unknown>) => (Array.isArray(b.settings) ? ({ settings: b.settings as PlatformSetting[], editable: b.editable !== false } as SettingsData) : undefined), [])
  const { state, reload } = useAdminData(ROUTE, pick)
  return state.kind === "ready" ? <OperationalSettingsView settings={state.data.settings} editable={state.data.editable} onChanged={reload} /> : <AdminNotReady state={state} what="Operational settings" />
}
