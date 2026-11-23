"use client"

// Settings → E-signature, for Mynt admins (lib/esign-settings.ts): where it stands (configured, test mode, the
// webhook, the last event received), then the changes, each a labelled action: paste the service's API key (a
// password field; sent once, never shown again), Re-register webhook, Remove key, and the test-mode switch with what
// each mode means. Mynt checks the key with the service before keeping it. Server-renderable for the tests.
import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { keyLine, providerLabel, TEST_MODE_WORDS, webhookLine, type EsignAction, type EsignStatus } from "@/lib/esign-settings"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "Never")

export function EsignSettingsView({ status, busy = false, message = null, error = null, onAction }: { status: EsignStatus; busy?: boolean; message?: string | null; error?: string | null; onAction: (a: EsignAction) => void }) {
  const [provider, setProvider] = useState(status.provider ?? status.providers[0] ?? "signwell")
  const [key, setKey] = useState("")
  const [confirmRemove, setConfirmRemove] = useState(false)
  const envKey = status.key.source === "environment"
  return (
    <div className="flex max-w-3xl flex-col gap-6" data-esign-settings>
      <section className="flex flex-col gap-2" aria-labelledby="esign-status">
        <h2 id="esign-status" className="text-base font-semibold">
          E-signature
        </h2>
        <p className="text-sm text-muted-foreground">Program agreements between apps and the licence providers sponsoring their products are signed through this service. Mynt keeps the signed copies.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm" data-esign-status>
          <dt className="text-muted-foreground">Status</dt>
          <dd data-esign-configured={status.configured}>{status.configured ? `On, with ${providerLabel(status.provider)}` : "Off: program agreements are signed by hand"}</dd>
          <dt className="text-muted-foreground">API key</dt>
          <dd data-esign-key>{keyLine(status)}</dd>
          <dt className="text-muted-foreground">Mode</dt>
          <dd>{status.testMode.on ? "Test mode" : "Live"}{status.testMode.source === "environment" ? " (set in the server's environment)" : ""}</dd>
          <dt className="text-muted-foreground">Webhook</dt>
          <dd data-esign-webhook>{webhookLine(status)}</dd>
          <dt className="text-muted-foreground">Last event received</dt>
          <dd>{when(status.lastEventAt)}</dd>
        </dl>
        {!status.vaultReady && (
          <p role="alert" className="text-sm text-destructive">
            This server&apos;s vault key (MYNT_VAULT_KEY) isn&apos;t set, so it can&apos;t keep the API key. Ask whoever runs the server to set it.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="esign-key">
        <h3 id="esign-key" className="text-sm font-semibold">
          {status.key.set && !envKey ? "Replace the API key" : "Set the API key"}
        </h3>
        <form
          className="flex flex-col gap-3"
          data-esign-key-form
          onSubmit={(e) => {
            e.preventDefault()
            const k = key.trim()
            setKey("")
            if (k) onAction({ action: "set_key", provider, api_key: k })
          }}
        >
          <label className="flex flex-col gap-1 text-sm">
            Service
            <select className={field} value={provider} onChange={(e) => setProvider(e.target.value)} data-esign-provider>
              {status.providers.map((p) => (
                <option key={p} value={p}>
                  {providerLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            API key
            <input className={field} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key from the service's API settings" data-esign-key-input />
            <span className="text-xs text-muted-foreground">Sent once to Mynt, which checks it with the service and keeps it sealed. It&apos;s never shown again.</span>
          </label>
          <div>
            <Button type="submit" disabled={busy || key.trim().length < 8 || !status.vaultReady} data-esign-save-key>
              {busy ? "Checking…" : "Check and save key"}
            </Button>
          </div>
        </form>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="esign-mode">
        <h3 id="esign-mode" className="text-sm font-semibold">
          Mode
        </h3>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={status.testMode.on} disabled={busy || status.testMode.source === "environment"} onChange={(e) => onAction({ action: "test_mode", test_mode: e.target.checked })} data-esign-test-mode />
          <span>
            <span className="font-medium">Test mode</span>
            <span className="block text-muted-foreground">{status.testMode.on ? TEST_MODE_WORDS.on : TEST_MODE_WORDS.off}</span>
            <span className="block text-xs text-muted-foreground">Documents already made keep the mode they were made in.</span>
          </span>
        </label>
      </section>

      <section className="flex flex-wrap gap-2" aria-label="E-signature actions">
        <Button variant="outline" disabled={busy || !status.key.set || !status.webhook.canRegister} onClick={() => onAction({ action: "register_webhook" })} data-esign-register-webhook>
          Re-register webhook
        </Button>
        {status.key.set && !envKey && !confirmRemove && (
          <Button variant="outline" disabled={busy} onClick={() => setConfirmRemove(true)} data-esign-remove-key>
            Remove key
          </Button>
        )}
        {confirmRemove && (
          <span className="flex flex-wrap items-center gap-2 text-sm" data-esign-confirm-remove>
            Remove the key and delete the webhook? Program agreements are then signed by hand.
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmRemove(false)
                onAction({ action: "remove_key" })
              }}
              data-esign-remove-confirm
            >
              Remove key
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
          </span>
        )}
      </section>

      {error && (
        <p role="alert" className="text-sm text-destructive" data-esign-error>
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm font-medium" data-esign-message>
          {message}
        </p>
      )}
    </div>
  )
}

type State = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; status: EsignStatus }

export function EsignSettingsPanel({ fetcher = (...a) => fetch(...a) }: { fetcher?: typeof fetch }) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    const res = await fetch("/api/esign", { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { settings?: EsignStatus; message?: string } | null
    if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
    if (res?.status === 403) return setState({ kind: "error", message: "E-signature settings are for Mynt admins." })
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
    const res = await fetcher("/api/esign", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { message?: string; settings?: EsignStatus } | null
    setBusy(false)
    if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
    if (!res?.ok) return setError(body?.message ?? "Couldn't reach Mynt. Please try again.")
    setMessage(body?.message ?? "Saved.")
    if (body?.settings) setState({ kind: "ready", status: body.settings })
    else void load()
  }
  if (state.kind === "loading") return <p className="text-sm text-muted-foreground">Loading e-signature settings…</p>
  if (state.kind === "error")
    return (
      <p role="alert" className="text-sm text-destructive">
        {state.message}
      </p>
    )
  return <EsignSettingsView status={state.status} busy={busy} message={message} error={error} onAction={(a) => void act(a)} />
}
