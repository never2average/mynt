"use client"

// Platform admin → Platform settings → E-signature, for Mynt admins (lib/esign-settings.ts; GET and POST
// /api/admin/esign): where e-signature stands, as ONE table filling the page under one toolbar. Its rows are the
// settings themselves (Setting, Value, Action): the service, its API key, the mode, the webhook and the last event
// received. Every change is a labelled button opening a sheet: Set key or Replace key (a password field; sent once,
// never shown again; Mynt checks it with the service before keeping it), Remove key (typed out to confirm), Change
// mode (test or live, with what each means) and Re-register webhook. The key is a row of the Key vault too: setting
// it there or here does the same. Never a key or a webhook id on the page.
import { useCallback, useEffect, useState } from "react"
import { FlaskConical, KeyRound, RefreshCw, Trash2 } from "lucide-react"

import { AdminList, AdminSheet, AdminTable, Field, fieldClass } from "@/components/admin-kit"
import { matches, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { keyLine, providerLabel, TEST_MODE_WORDS, webhookLine, type EsignAction, type EsignStatus } from "@/lib/esign-settings"

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "Never")
export const ESIGN_HEAD = ["Setting", "Value", "Action"] as const
export const REMOVE_WORD = "remove"
export type EsignSheet = "key" | "remove" | "mode" | "webhook"
type Row = { id: string; setting: string; value: React.ReactNode; text: string; action: React.ReactNode }

export function EsignSettingsView({
  status,
  busy = false,
  message = null,
  error = null,
  onAction,
  sheet = null,
  onSheet,
}: {
  status: EsignStatus
  busy?: boolean
  message?: string | null
  error?: string | null
  onAction: (a: EsignAction) => void
  sheet?: EsignSheet | null // which sheet is open (the panel keeps it; a test may open one)
  onSheet?: (s: EsignSheet | null) => void
}) {
  const [own, setOwn] = useState<EsignSheet | null>(sheet)
  const open = onSheet ? sheet : own
  const show = (s: EsignSheet | null) => (onSheet ? onSheet(s) : setOwn(s))
  const [query, setQuery] = useState("")
  const [provider, setProvider] = useState(status.provider ?? status.providers[0] ?? "signwell")
  const [key, setKey] = useState("")
  const [typed, setTyped] = useState("")
  const [testMode, setTestMode] = useState(status.testMode.on)
  const envKey = status.key.source === "environment"
  const envMode = status.testMode.source === "environment"
  const stored = status.key.set && !envKey
  const readOnly = (words: string) => (
    <span className="block min-w-40 text-xs whitespace-normal text-muted-foreground" data-esign-read-only>
      {words}
    </span>
  )
  const all: Row[] = [
    {
      id: "service",
      setting: "Service",
      text: status.configured ? `On, with ${providerLabel(status.provider)}` : "Off: program agreements are signed by hand",
      value: <span data-esign-configured={status.configured}>{status.configured ? `On, with ${providerLabel(status.provider)}` : "Off: program agreements are signed by hand"}</span>,
      action: readOnly("Follows the API key"),
    },
    {
      id: "key",
      setting: "API key",
      text: keyLine(status),
      value: <span data-esign-key>{keyLine(status)}</span>,
      action: envKey ? (
        readOnly("Set on the server; overrides the vault")
      ) : (
        <span className="flex flex-wrap justify-end gap-2">
          <Button size="sm" variant="outline" disabled={busy || !status.vaultReady} onClick={() => show("key")} data-esign-set-key>
            <KeyRound /> {stored ? "Replace key" : "Set key"}
          </Button>
          {stored && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => show("remove")} data-esign-remove-key>
              <Trash2 /> Remove key
            </Button>
          )}
        </span>
      ),
    },
    {
      id: "mode",
      setting: "Mode",
      text: status.testMode.on ? TEST_MODE_WORDS.on : TEST_MODE_WORDS.off,
      value: (
        <span className="block min-w-56 whitespace-normal" data-esign-mode={status.testMode.on ? "test" : "live"}>
          {status.testMode.on ? TEST_MODE_WORDS.on : TEST_MODE_WORDS.off}
        </span>
      ),
      action: envMode ? (
        readOnly("Set on the server (ESIGN_TEST_MODE)")
      ) : (
        <span className="flex justify-end">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => show("mode")} data-esign-change-mode>
            <FlaskConical /> Change mode
          </Button>
        </span>
      ),
    },
    {
      id: "webhook",
      setting: "Webhook",
      text: webhookLine(status),
      value: (
        <span className="block min-w-56 whitespace-normal" data-esign-webhook>
          {webhookLine(status)}
          {status.webhook.callbackUrl ? <span className="block text-xs text-muted-foreground">The service sends its events to {status.webhook.callbackUrl}</span> : null}
        </span>
      ),
      action: (
        <span className="flex justify-end">
          <Button size="sm" variant="outline" disabled={busy || !status.key.set || !status.webhook.canRegister} onClick={() => show("webhook")} data-esign-register-webhook>
            <RefreshCw /> Re-register webhook
          </Button>
        </span>
      ),
    },
    { id: "last-event", setting: "Last event received", text: when(status.lastEventAt), value: when(status.lastEventAt), action: readOnly("Recorded by Mynt") },
  ]
  const rows = all.filter((r) => matches(query, r.setting, r.text))
  const paged = usePaged(rows)
  const done = message !== null
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-esign-settings>
      <AdminList
        id="esign-settings"
        search={query}
        onSearch={setQuery}
        searchLabel="Search the e-signature settings"
        importable={false}
        note={
          status.vaultReady
            ? "Program agreements between apps and the licence providers sponsoring their products are signed through this service. Mynt keeps the signed copies. The API key is a row of the Key vault too."
            : "This server's vault key (MYNT_VAULT_KEY) isn't set, so it can't keep the API key. Ask whoever runs the server to set it."
        }
        page={paged.page}
        pages={paged.pages}
        total={rows.length}
        onPage={paged.setPage}
      >
        <AdminTable head={ESIGN_HEAD} rowKeys={paged.shown.map((r) => r.id)} rows={paged.shown.map((r) => [r.setting, r.value, r.action])} empty="No setting matches." />
      </AdminList>

      <AdminSheet
        open={open === "key"}
        title={stored ? "Replace key" : "Set key"}
        description="The key from the service's API settings. It's sent to Mynt once, which checks it with the service, seals it in the key vault and registers the webhook. It's never shown again."
        onClose={() => show(null)}
        error={error}
        result={message}
        id="esign-key"
      >
        {!done && (
          <form
            className="flex flex-col gap-3"
            data-esign-key-form
            autoComplete="off"
            onSubmit={(e) => {
              e.preventDefault()
              const k = key.trim()
              setKey("") // gone from the page before the request is made
              if (k) onAction({ action: "set_key", provider, api_key: k })
            }}
          >
            <Field label="Service">
              <select className={fieldClass} value={provider} onChange={(e) => setProvider(e.target.value)} data-esign-provider>
                {status.providers.map((p) => (
                  <option key={p} value={p}>
                    {providerLabel(p)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="API key" hint="Paste it once. It isn't shown again, here or anywhere.">
              <input className={fieldClass} type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} data-esign-key-input />
            </Field>
            <div>
              <Button type="submit" disabled={busy || key.trim().length < 8 || !status.vaultReady} data-esign-save-key>
                {busy ? "Checking…" : "Check and save key"}
              </Button>
            </div>
          </form>
        )}
      </AdminSheet>

      <AdminSheet
        open={open === "remove"}
        title="Remove key"
        description="The key is removed from the vault and its value destroyed, and the webhook is deleted at the service. Program agreements are then signed by hand until a key is set again."
        onClose={() => show(null)}
        error={error}
        result={message}
        id="esign-remove"
      >
        {!done && (
          <form
            className="flex flex-col gap-3"
            data-esign-confirm-remove
            onSubmit={(e) => {
              e.preventDefault()
              if (typed.trim().toLowerCase() !== REMOVE_WORD) return
              setTyped("")
              onAction({ action: "remove_key" })
            }}
          >
            <Field label={`Type ${REMOVE_WORD} to confirm`}>
              <input className={fieldClass} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} data-esign-remove-typed />
            </Field>
            <div>
              <Button type="submit" variant="destructive" disabled={busy || typed.trim().toLowerCase() !== REMOVE_WORD} data-esign-remove-confirm>
                {busy ? "Removing…" : "Remove key"}
              </Button>
            </div>
          </form>
        )}
      </AdminSheet>

      <AdminSheet
        open={open === "mode"}
        title="Change mode"
        description="Test mode is for trying the whole flow; live documents are legally binding. Documents already made keep the mode they were made in."
        onClose={() => show(null)}
        error={error}
        result={message}
        id="esign-mode"
      >
        {!done && (
          <form
            className="flex flex-col gap-3"
            data-esign-mode-form
            onSubmit={(e) => {
              e.preventDefault()
              onAction({ action: "test_mode", test_mode: testMode })
            }}
          >
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={testMode} disabled={busy} onChange={(e) => setTestMode(e.target.checked)} data-esign-test-mode />
              <span>
                <span className="font-medium">Test mode</span>
                <span className="block text-muted-foreground">{testMode ? TEST_MODE_WORDS.on : TEST_MODE_WORDS.off}</span>
              </span>
            </label>
            <div>
              <Button type="submit" disabled={busy || testMode === status.testMode.on} data-esign-save-mode>
                {busy ? "Saving…" : testMode ? "Switch to test mode" : "Switch to live"}
              </Button>
            </div>
          </form>
        )}
      </AdminSheet>

      <AdminSheet
        open={open === "webhook"}
        title="Re-register webhook"
        description="Mynt registers the service's webhook to this server again with the stored key. One already pointing here is reused, so nothing is doubled."
        onClose={() => show(null)}
        error={error}
        result={message}
        id="esign-webhook"
      >
        {!done && (
          <div>
            <Button disabled={busy} onClick={() => onAction({ action: "register_webhook" })} data-esign-register-confirm>
              {busy ? "Registering…" : "Re-register webhook"}
            </Button>
          </div>
        )}
      </AdminSheet>
    </div>
  )
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; status: EsignStatus }

export function EsignSettingsPanel({ fetcher = (...a) => fetch(...a) }: { fetcher?: typeof fetch }) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sheet, setSheet] = useState<EsignSheet | null>(null)
  const load = useCallback(async () => {
    const res = await fetch("/api/admin/esign", { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { settings?: EsignStatus; message?: string } | null
    if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
    if (res?.status === 403 || res?.status === 404) return setState({ kind: "error", message: "E-signature settings are for Mynt admins." })
    setState(res?.ok && body?.settings ? { kind: "ready", status: body.settings } : { kind: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." })
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  const act = async (a: EsignAction) => {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    const payload = a.action === "remove_key" ? { action: "remove_key", confirm: true } : a
    const res = await fetcher("/api/admin/esign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { message?: string; settings?: EsignStatus } | null
    setBusy(false)
    if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
    if (!res?.ok) return setError(body?.message ?? "Couldn't reach Mynt. Please try again.")
    setMessage(body?.message ?? "Saved.")
    if (body?.settings) setState({ kind: "ready", status: body.settings })
    else void load()
  }
  // A sheet opens clean: the last answer belongs to the sheet it was given in.
  const onSheet = (s: EsignSheet | null) => {
    setError(null)
    setMessage(null)
    setSheet(s)
  }
  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Loading e-signature settings…</p>
  if (state.kind === "error")
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    )
  return <EsignSettingsView status={state.status} busy={busy} message={message} error={error} onAction={(a) => void act(a)} sheet={sheet} onSheet={onSheet} />
}
