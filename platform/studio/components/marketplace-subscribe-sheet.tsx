"use client"

// The Marketplace's Subscribe sheet: subscribing to a service provider's standard service by accepting its standard
// terms (no negotiation). Choose the apps it's for and, optionally, those apps' products it's used for; enter the test
// credential the provider issued you if the service needs one (it goes to your firm's key vault on Mynt, is never
// shown again and is cleared from this form once sent); tick "I accept <provider>'s standard terms v<version>"; then
// Subscribe. Mynt checks everything again (the current version, that you're an owner or admin of each app's
// workspace, your firm's prerequisites) and may refuse; its reason is shown in its own words. Server-renderable.
import { useEffect, useMemo, useState } from "react"
import { ExternalLink } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { MarketplaceApp, Offering, SubscribeRequest } from "@/lib/marketplace"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"

export function SubscribeView({
  offering: o,
  apps,
  preselect = null,
  busy = false,
  error = null,
  result = null,
  onSubmit,
}: {
  offering: Offering
  apps: MarketplaceApp[]
  preselect?: string | null
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (r: SubscribeRequest) => void
}) {
  const [chosen, setChosen] = useState<string[]>(preselect && apps.some((a) => a.id === preselect) ? [preselect] : [])
  const [products, setProducts] = useState<string[]>([])
  const [credential, setCredential] = useState("")
  const [label, setLabel] = useState("")
  const [accepted, setAccepted] = useState(false)
  // A result means the credential was sent: it isn't kept in the form.
  useEffect(() => {
    if (result !== null) setCredential("")
  }, [result])
  const offeredProducts = useMemo(() => [...new Set(apps.filter((a) => chosen.includes(a.id)).flatMap((a) => a.productIds))], [apps, chosen])
  if (!o.terms)
    return (
      <p className="text-sm text-muted-foreground" data-no-terms>
        {o.provider} has no standard terms on file yet, so there&apos;s nothing to accept. Subscribing from the Marketplace is by accepting a provider&apos;s standard terms.
      </p>
    )
  if (!apps.length)
    return (
      <p className="text-sm text-muted-foreground" data-no-apps>
        You have no apps yet. A subscription is for the apps that use it: create an app first.
      </p>
    )
  const terms = o.terms
  const done = result !== null
  const ready = chosen.length > 0 && accepted && (!o.requiresCredential || credential.trim().length > 0)
  return (
    <form
      className="flex flex-col gap-4"
      data-subscribe-form
      autoComplete="off"
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready) return
        const picked = products.filter((p) => offeredProducts.includes(p))
        onSubmit({
          offering_id: o.id,
          accept_terms_version: terms.version,
          app_ids: chosen,
          ...(picked.length ? { products: picked } : {}),
          ...(o.requiresCredential && credential.trim() ? { test_credential: credential.trim() } : {}),
          ...(o.requiresCredential && label.trim() ? { credential_label: label.trim() } : {}),
        })
      }}
    >
      <fieldset className="flex flex-col gap-1 text-sm" data-subscribe-apps>
        <legend className="mb-1 font-medium">Apps it&apos;s for</legend>
        {apps.map((a) => (
          <label key={a.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={chosen.includes(a.id)}
              onChange={(e) => setChosen((cur) => (e.target.checked ? [...cur, a.id] : cur.filter((x) => x !== a.id)))}
              data-subscribe-app={a.id}
            />
            {a.name}
          </label>
        ))}
      </fieldset>
      {offeredProducts.length > 0 && (
        <fieldset className="flex flex-col gap-1 text-sm" data-subscribe-products>
          <legend className="mb-1 font-medium">Products it&apos;s used for (optional)</legend>
          {offeredProducts.map((p) => (
            <label key={p} className="flex items-center gap-2">
              <input type="checkbox" checked={products.includes(p)} onChange={(e) => setProducts((cur) => (e.target.checked ? [...cur, p] : cur.filter((x) => x !== p)))} data-subscribe-product={p} />
              {p}
            </label>
          ))}
        </fieldset>
      )}
      {o.requiresCredential && (
        <div className="flex flex-col gap-3" data-subscribe-credential>
          <label className="flex flex-col gap-1 text-sm">
            Test credential from {o.provider}
            <input className={field} type="password" value={credential} onChange={(e) => setCredential(e.target.value)} maxLength={2000} autoComplete="off" spellCheck={false} data-subscribe-test-credential />
            <span className="text-xs text-muted-foreground">Kept in your firm&apos;s key vault on Mynt and sent only to the provider&apos;s test endpoint. It&apos;s never shown again.</span>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Name for the credential (optional)
            <input className={field} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} data-subscribe-credential-label />
          </label>
        </div>
      )}
      <section className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-subscribe-terms={terms.version}>
        <p className="font-medium">
          {o.provider}&apos;s standard terms v{terms.version}
        </p>
        <p className="text-muted-foreground">{terms.summary}</p>
        <p>Pricing: {terms.pricing || o.pricing}. The provider bills you directly; Mynt never bills or holds money for it.</p>
        <a href={terms.documentUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline underline-offset-4" data-subscribe-terms-document>
          Read the terms <ExternalLink className="size-3" />
        </a>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-0.5" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} data-accept-terms />
          <span>
            I accept {o.provider}&apos;s standard terms v{terms.version}
          </span>
        </label>
      </section>
      {!done && (
        <div>
          <Button type="submit" disabled={busy || !ready} data-subscribe-submit>
            {busy ? "Subscribing…" : "Subscribe"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-subscribe-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-subscribe-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function SubscribeSheet({
  offering,
  apps,
  preselect = null,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  offering: Offering | null
  apps: MarketplaceApp[]
  preselect?: string | null
  onClose: () => void
  onDone: () => void
  fetcher?: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!offering) return
    setError(null)
    setResult(null)
    setRound((r) => r + 1)
  }, [offering])
  const submit = async (r: SubscribeRequest) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await fetcher("/api/marketplace/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(r) }).catch(() => null)
    const data = (await res?.json().catch(() => null)) as { message?: string } | null
    setBusy(false)
    if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
    if (!res?.ok) return setError(data?.message ?? "Couldn't reach Mynt. Please try again.")
    setResult(data?.message ?? "Subscribed.")
    onDone()
  }
  return (
    <Sheet open={offering !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-subscribe-sheet>
        <SheetHeader>
          <SheetTitle>Subscribe{offering ? ` to ${offering.name}` : ""}</SheetTitle>
          <SheetDescription>Accept the service provider&apos;s standard terms for the apps that use it. The agreement is signed at once and shows in each app&apos;s Agreements tab.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-4">{offering && <SubscribeView key={round} offering={offering} apps={apps} preselect={preselect} busy={busy} error={error} result={result} onSubmit={submit} />}</div>
      </SheetContent>
    </Sheet>
  )
}
