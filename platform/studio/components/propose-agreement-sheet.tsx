"use client"

// Propose agreement, on the Licences page's Business agreements, MSA and SLA tabs, from either side: a developer
// managing the workspace proposes to a firm sponsoring its apps' products; a licence provider proposes to a workspace
// whose apps use products its firm sponsors. The other side accepts or declines; it's in force once both have signed.
// The sheet asks for the other party, the app (optional for an MSA or SLA, which bind the whole workspace), the kind
// (the tab's kinds), the products a program agreement covers, a summary of the terms, the document (a link, or for a
// licence provider one of its firm's templates as the starting document) and the dates. Mynt checks everything again.
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { TemplateRow } from "@/lib/agreement-esign"
import { AGREEMENT_KIND_LABELS } from "@/lib/app-panel"
import { WORKSPACE_KINDS, type AgreementSide, type ProposeTarget } from "@/lib/lp-agreements"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"
const SIDE_WORD: Record<AgreementSide, string> = { app: "Your workspace (the app's side)", counterparty: "Your firm (the licence provider)" }

export type ProposalBody = {
  side: AgreementSide
  target_id: string
  app_id?: string
  kind: string
  products: string[]
  terms_summary: string
  document_url?: string
  template_id?: string
  effective_from?: string
  effective_to?: string
}

export function ProposeView({
  targets,
  kinds,
  templates = [],
  busy = false,
  error = null,
  result = null,
  onSubmit,
}: {
  targets: ProposeTarget[]
  kinds: readonly string[]
  templates?: TemplateRow[]
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (b: ProposalBody) => void
}) {
  const sides = [...new Set(targets.map((t) => t.side))]
  const [side, setSide] = useState<AgreementSide>(sides[0] ?? "app")
  const mine = targets.filter((t) => t.side === side)
  const [targetId, setTargetId] = useState(mine[0]?.id ?? "")
  const target = mine.find((t) => t.id === targetId) ?? mine[0]
  const [kind, setKind] = useState(kinds[0] ?? "program")
  const workspaceKind = WORKSPACE_KINDS.includes(kind)
  const [appId, setAppId] = useState(workspaceKind ? "" : (target?.apps[0]?.id ?? ""))
  const app = target?.apps.find((a) => a.id === appId)
  const [products, setProducts] = useState<string[]>([])
  const [terms, setTerms] = useState("")
  const [doc, setDoc] = useState("")
  const [template, setTemplate] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const usable = templates.filter((t) => t.active)
  const needsApp = !workspaceKind
  const ready = Boolean(target) && (!needsApp || Boolean(app)) && terms.trim().length >= 10 && (kind !== "program" || products.length > 0)
  if (!targets.length)
    return (
      <p className="text-sm text-muted-foreground" data-propose-nobody>
        There&apos;s nobody to propose to yet: a firm must sponsor one of your apps&apos; products, or a workspace&apos;s apps must use a product your firm sponsors.
      </p>
    )
  return (
    <form
      className="flex flex-col gap-3"
      data-propose-form
      onSubmit={(e) => {
        e.preventDefault()
        if (!ready || !target) return
        onSubmit({
          side,
          target_id: target.id,
          ...(app ? { app_id: app.id } : {}),
          kind,
          products: kind === "program" || kind === "data_sharing" ? products : [],
          terms_summary: terms.trim(),
          ...(doc.trim() ? { document_url: doc.trim() } : {}),
          ...(side === "counterparty" && template ? { template_id: template } : {}),
          ...(from ? { effective_from: from } : {}),
          ...(to ? { effective_to: to } : {}),
        })
      }}
    >
      {sides.length > 1 && (
        <label className="flex flex-col gap-1 text-sm">
          Propose as
          <select className={field} value={side} onChange={(e) => { const s = e.target.value as AgreementSide; setSide(s); setTargetId(targets.find((t) => t.side === s)?.id ?? ""); setAppId("") }} data-propose-side>
            {sides.map((s) => (
              <option key={s} value={s}>
                {SIDE_WORD[s]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        {side === "app" ? "Firm" : "Workspace"}
        <select className={field} value={target?.id ?? ""} onChange={(e) => { setTargetId(e.target.value); setAppId(""); setProducts([]) }} data-propose-target>
          {mine.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      {kinds.length > 1 && (
        <label className="flex flex-col gap-1 text-sm">
          Kind
          <select className={field} value={kind} onChange={(e) => setKind(e.target.value)} data-propose-kind>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {AGREEMENT_KIND_LABELS[k] ?? k}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        App
        <select className={field} value={app?.id ?? ""} onChange={(e) => { setAppId(e.target.value); setProducts([]) }} data-propose-app>
          {workspaceKind ? <option value="">The whole workspace</option> : <option value="">Choose an app</option>}
          {(target?.apps ?? []).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      {(kind === "program" || kind === "data_sharing") && app && (
        <fieldset className="flex flex-col gap-1 text-sm" data-propose-products>
          <legend>Products it covers{kind === "program" ? "" : " (optional)"}</legend>
          {app.productIds.length ? (
            app.productIds.map((p) => (
              <label key={p} className="flex items-center gap-2">
                <input type="checkbox" checked={products.includes(p)} onChange={() => setProducts(products.includes(p) ? products.filter((x) => x !== p) : [...products, p])} />
                {p}
              </label>
            ))
          ) : (
            <span className="text-muted-foreground">No products of this app are sponsored by this firm.</span>
          )}
        </fieldset>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Summary of the terms
        <textarea className={`${field} min-h-24`} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={4000} required minLength={10} data-propose-terms />
      </label>
      {side === "counterparty" && usable.length > 0 && (
        <label className="flex flex-col gap-1 text-sm">
          Starting document (optional)
          <select className={field} value={template} onChange={(e) => setTemplate(e.target.value)} data-propose-template>
            <option value="">None: a link below, or none</option>
            {usable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}, version {t.version}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Document link (optional, https)
        <input className={field} type="url" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="https://" data-propose-document />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Effective from (optional)
          <input className={field} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Until (optional)
          <input className={field} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      {result === null && (
        <div>
          <Button type="submit" disabled={busy || !ready} data-propose-submit>
            {busy ? "Proposing…" : "Propose agreement"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-propose-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-propose-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function ProposeSheet({
  targets,
  kinds,
  templates,
  open,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  targets: ProposeTarget[]
  kinds: readonly string[]
  templates?: TemplateRow[]
  open: boolean
  onClose: () => void
  onDone: () => void
  fetcher?: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  useEffect(() => {
    if (!open) return
    setError(null)
    setResult(null)
    setRound((r) => r + 1)
  }, [open])
  const submit = async (b: ProposalBody) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const res = await fetcher("/api/agreements", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { message?: string } | null
    setBusy(false)
    if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
    if (!res?.ok) return setError(body?.message ?? "Couldn't reach Mynt. Please try again.")
    setResult(body?.message ?? "Agreement proposed.")
    onDone()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-propose-agreement-sheet>
        <SheetHeader>
          <SheetTitle>Propose agreement</SheetTitle>
          <SheetDescription>The other side accepts or declines it; it&apos;s in force once both sides have signed. Recorded in the audit trail.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <ProposeView key={round} targets={targets} kinds={kinds} templates={templates} busy={busy} error={error} result={result} onSubmit={(b) => void submit(b)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
