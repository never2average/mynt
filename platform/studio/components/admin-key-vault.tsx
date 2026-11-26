"use client"

// Platform admin → Platform settings → Key vault (lib/platform-settings.ts; GET and POST /api/admin/keys): every key
// Mynt's own server uses, as ONE table filling the page under one toolbar (search, Filters, Export CSV). One row per
// key type: what it's for, who uses it, where it comes from (Key vault, Server environment or Not set), who set it
// and when, its fingerprint, and when a change takes effect.
//
// No value is ever on this page: Mynt never sends one back, the rows have no field for one, and the export has no
// column for one. A key goes in once, through Set key or Replace key (a sheet with one password field, emptied the
// moment it's sent), and comes out only by Remove key (a sheet that needs the key's type typed out). A key the
// server's environment sets, and the keys that can only live on the server, are read-only rows that say so.
import { useCallback, useMemo, useState } from "react"
import { KeyRound, Trash2 } from "lucide-react"

import { AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { csvOf } from "@/lib/admin"
import { KEY_CSV_HEAD, KEY_SOURCE_LABELS, keyActions, keyCsvRow, setByWords, setOnWords, takesEffectWords, type KeySource, type KeyVault, type PlatformKey } from "@/lib/platform-settings"

const ROUTE = "/api/admin/keys"
export const KEY_VAULT_HEAD = ["Key", "Used by", "Source", "Set on", "Set by", "Fingerprint", "Takes effect", "Action"] as const
const SOURCES: KeySource[] = ["vault", "environment", "none"]
const EFFECTS = [
  { value: "now", label: "At once" },
  { value: "restart", label: "After a restart" },
]

/** Set key / Replace key: one password field, sent once. The field is emptied before the request leaves. */
export function SetKeySheet({ target, onClose, onDone, fetcher }: { target: PlatformKey | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [value, setValue] = useState("")
  const action = useAdminAction(fetcher)
  const replacing = target?.source === "vault"
  return (
    <AdminSheet
      open={target !== null}
      title={replacing ? "Replace key" : "Set key"}
      description={
        replacing
          ? "The new key takes the old one's place: the old key is retired and its value destroyed. The key is sent to Mynt once, sealed, and never shown again."
          : "The key is sent to Mynt once, checked, sealed in the key vault, and never shown again."
      }
      onClose={onClose}
      error={action.error}
      result={action.result}
      id="set-key"
    >
      {target && action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-key-form={target.type}
          autoComplete="off"
          onSubmit={(e) => {
            e.preventDefault()
            const sent = value.trim()
            setValue("") // gone from the page before the request is made
            if (sent.length < 8) return
            void action.run(ROUTE, { action: "set", type: target.type, value: sent }).then((res) => res?.ok === true && onDone())
          }}
        >
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm" data-key-facts>
            <dt className="text-muted-foreground">Key</dt>
            <dd>
              {target.label} <code className="text-xs">{target.type}</code>
            </dd>
            <dt className="text-muted-foreground">Used by</dt>
            <dd>{target.usedBy}</dd>
            <dt className="text-muted-foreground">Checked</dt>
            <dd>{target.validation ?? "By its format"}</dd>
            <dt className="text-muted-foreground">Takes effect</dt>
            <dd>{target.needsRestart ? "After the server restarts. Until then Mynt keeps using what it started with." : "At once: the next use reads the new key."}</dd>
          </dl>
          <Field label={replacing ? "New key" : "Key"} hint="Paste it once. It isn't shown again, here or anywhere.">
            {target.multiline ? (
              <textarea
                className={`${fieldClass} min-h-28 font-mono text-xs [-webkit-text-security:disc]`}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                required
                data-key-input
                data-key-masked
              />
            ) : (
              <input className={fieldClass} type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" spellCheck={false} required data-key-input />
            )}
          </Field>
          <div>
            <Button type="submit" disabled={action.busy || value.trim().length < 8} data-key-submit="set">
              {action.busy ? "Checking…" : replacing ? "Replace key" : "Set key"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

/** Remove key: the key's type typed out, then the labelled button. */
export function RemoveKeySheet({ target, onClose, onDone, fetcher }: { target: PlatformKey | null; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const [typed, setTyped] = useState("")
  const action = useAdminAction(fetcher)
  return (
    <AdminSheet
      open={target !== null}
      title="Remove key"
      description="The key is removed from the vault and its value destroyed. It can't be brought back: set the key again to use it again."
      onClose={onClose}
      error={action.error}
      result={action.result}
      id="remove-key"
    >
      {target && action.result === null && (
        <form
          className="flex flex-col gap-3"
          data-remove-key-form={target.type}
          onSubmit={(e) => {
            e.preventDefault()
            if (typed.trim() !== target.type) return
            void action.run(ROUTE, { action: "remove", type: target.type, confirm: typed.trim() }).then((res) => res?.ok === true && onDone())
          }}
        >
          <p className="text-sm">
            {target.label} is used by: {target.usedBy}. {target.needsRestart ? "What uses it stops after the server restarts." : "What uses it stops at once."}
          </p>
          <Field label={`Type ${target.type} to confirm`}>
            <input className={fieldClass} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} required data-remove-key-confirm />
          </Field>
          <div>
            <Button type="submit" variant="destructive" disabled={action.busy || typed.trim() !== target.type} data-key-submit="remove">
              {action.busy ? "Removing…" : "Remove key"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

/** The Key vault tab: one toolbar, one table. */
export function KeyVaultView({ vault, onChanged = () => undefined, fetcher, opening = null }: { vault: KeyVault; onChanged?: () => void; fetcher?: typeof fetch; opening?: { set?: string; remove?: string } | null }) {
  const find = (type: string | undefined) => vault.keys.find((k) => k.type === type) ?? null
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<string[]>([])
  const [effect, setEffect] = useState<string[]>([])
  const [setting, setSetting] = useState<PlatformKey | null>(find(opening?.set))
  const [removing, setRemoving] = useState<PlatformKey | null>(find(opening?.remove))
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setSetting(null)
    setRemoving(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const rows = useMemo(
    () =>
      vault.keys.filter(
        (k) =>
          matches(query, k.label, k.type, k.usedBy, k.purpose, KEY_SOURCE_LABELS[k.source], k.setBy) &&
          (!source.length || source.includes(k.source)) &&
          (!effect.length || effect.includes(k.needsRestart ? "restart" : "now")),
      ),
    [vault.keys, query, source, effect],
  )
  const paged = usePaged(rows)
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-key-vault>
      <AdminList
        id="platform-keys"
        search={query}
        onSearch={setQuery}
        searchLabel="Search keys by name, type or what uses them"
        facets={[
          { id: "source", label: "Source", options: SOURCES.map((s) => ({ value: s, label: KEY_SOURCE_LABELS[s] })), selected: source, onChange: setSource },
          { id: "effect", label: "Takes effect", options: EFFECTS, selected: effect, onChange: setEffect },
        ]}
        onClearFilters={() => (setSource([]), setEffect([]))}
        importable={false}
        onExport={() => downloadCsv("platform-keys.csv", csvOf(KEY_CSV_HEAD, rows.map(keyCsvRow)))}
        exportDisabled={!rows.length}
        // No description under the toolbar; only the warning when keys can't be set here at all.
        note={vault.vaultReady ? undefined : "This server can't seal keys yet: its vault key (MYNT_VAULT_KEY) isn't set. Ask whoever runs the server to set it; until then keys can only be set on the server."}
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable
          head={KEY_VAULT_HEAD}
          rowKeys={paged.shown.map((k) => k.type)}
          rows={paged.shown.map((k) => {
            const can = keyActions(k)
            return [
              <span key="k" className="flex min-w-56 flex-col whitespace-normal" data-key-name>
                <span>{k.label}</span>
                <code className="text-xs font-normal text-muted-foreground">{k.type}</code>
                <span className="text-xs font-normal text-muted-foreground">{k.purpose}</span>
              </span>,
              <span key="u" className="block min-w-32 whitespace-normal">
                {k.usedBy}
              </span>,
              <span key="s" data-key-source={k.source}>
                {KEY_SOURCE_LABELS[k.source]}
              </span>,
              setOnWords(k),
              setByWords(k),
              k.fingerprint ? (
                <code key="f" className="text-xs" data-key-fingerprint>
                  {k.fingerprint}
                </code>
              ) : (
                "None"
              ),
              takesEffectWords(k),
              can.readOnly ? (
                <span key="a" className="block min-w-40 text-xs whitespace-normal text-muted-foreground" data-key-read-only>
                  {can.readOnly}
                </span>
              ) : (
                <span key="a" className="flex flex-wrap justify-end gap-2" data-key-actions>
                  <Button size="sm" variant="outline" disabled={!vault.vaultReady} onClick={() => setSetting(k)} data-set-key={k.type}>
                    <KeyRound /> {can.set}
                  </Button>
                  {can.remove && (
                    <Button size="sm" variant="outline" onClick={() => setRemoving(k)} data-remove-key={k.type}>
                      <Trash2 /> Remove key
                    </Button>
                  )}
                </span>
              ),
            ]
          })}
          empty="No key matches."
        />
      </AdminList>
      <SetKeySheet key={`s${setting?.type ?? ""}`} target={setting} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <RemoveKeySheet key={`r${removing?.type ?? ""}`} target={removing} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </div>
  )
}

/** Platform settings' Key vault tab. */
export function KeyVaultTab() {
  const pick = useCallback((b: Record<string, unknown>) => (b.vault ? (b.vault as KeyVault) : undefined), [])
  const { state, reload } = useAdminData(ROUTE, pick)
  return state.kind === "ready" ? <KeyVaultView vault={state.data} onChanged={reload} /> : <AdminNotReady state={state} what="The key vault" />
}
