"use client"

// The two actions of an app's information tabs, each a labelled button opening a sheet (tabs only show):
// - Propose agreement (Agreements tab): an agreement between the app's workspace and another firm. The
//   counterparty is picked from the licence providers sponsoring the app's products; then the kind, the
//   products it covers, a summary of the terms, and optionally a link to the document and the dates it
//   runs between. Mynt tells the other firm, which accepts or declines; then both sign.
// - Choose personas (Customers tab): which of its products' customer segments the app targets.
// Mynt checks everything again and may refuse; its reason is shown in its own words. The views are
// server-renderable for the tests.
import { useEffect, useMemo, useState } from "react"
import { FilePlus2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { AGREEMENT_ACTION_LABELS, AGREEMENT_KIND_LABELS, sponsorsFromCoverage, type AgreementAction, type AppAgreements, type AppCustomers } from "@/lib/app-panel"
import { coverageText, type AgreementCoverage } from "@/lib/promotions"

const field = "rounded-md border border-input bg-background px-2 py-1.5 text-sm"

type Result = { ok: true; message: string } | { ok: false; message: string }
async function post(url: string, body: unknown, fetcher: typeof fetch): Promise<Result> {
  const res = await fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null)
  const data = (await res?.json().catch(() => null)) as { message?: string } | null
  if (res?.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event("mynt:signed-out"))
  if (!res?.ok) return { ok: false, message: data?.message ?? "Couldn't reach Mynt. Please try again." }
  return { ok: true, message: data?.message ?? "Done." }
}

export type Proposal = {
  counterparty_entity_id: string
  kind: "program" | "vendor" | "data_sharing"
  products: string[]
  terms_summary: string
  document_url?: string
  effective_from?: string
  effective_to?: string
}

// A shortcut's pre-fill: the sponsor and the products a missing program agreement is for.
export type ProposalStart = { counterparty: string; products: string[] }

export function ProposeAgreementView({
  data,
  initial,
  busy = false,
  error = null,
  result = null,
  onSubmit,
}: {
  data: Pick<AppAgreements, "sponsors" | "products">
  initial?: ProposalStart
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (p: Proposal) => void
}) {
  const start = initial && data.sponsors.some((s) => s.entityId === initial.counterparty) ? initial : null
  const [counterparty, setCounterparty] = useState(start?.counterparty ?? data.sponsors[0]?.entityId ?? "")
  const [kind, setKind] = useState<Proposal["kind"]>("program")
  const sponsor = data.sponsors.find((s) => s.entityId === counterparty)
  const [products, setProducts] = useState<string[]>(start ? start.products.filter((p) => sponsor?.productIds.includes(p)) : (sponsor?.productIds ?? []))
  const [terms, setTerms] = useState("")
  const [doc, setDoc] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  // A program agreement covers only products the chosen firm sponsors.
  const offered = useMemo(() => (kind === "program" ? data.products.filter((p) => sponsor?.productIds.includes(p.id)) : data.products), [kind, data.products, sponsor])
  if (!data.sponsors.length)
    return (
      <p className="text-sm text-muted-foreground" data-no-sponsors>
        None of this app&apos;s products has a licence provider sponsoring it yet, so there&apos;s no one to propose a program agreement to. Agreements are made with the firms behind the app&apos;s products.
      </p>
    )
  const done = result !== null
  return (
    <form
      className="flex flex-col gap-3"
      data-propose-agreement-form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit({
          counterparty_entity_id: counterparty,
          kind,
          products: products.filter((p) => offered.some((o) => o.id === p)),
          terms_summary: terms.trim(),
          ...(doc.trim() ? { document_url: doc.trim() } : {}),
          ...(from ? { effective_from: from } : {}),
          ...(to ? { effective_to: to } : {}),
        })
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        With
        <select
          className={field}
          value={counterparty}
          onChange={(e) => {
            setCounterparty(e.target.value)
            setProducts(data.sponsors.find((s) => s.entityId === e.target.value)?.productIds ?? [])
          }}
          data-agreement-counterparty
        >
          {data.sponsors.map((s) => (
            <option key={s.entityId} value={s.entityId}>
              {s.name} (sponsors {s.productIds.map((id) => data.products.find((p) => p.id === id)?.name ?? id).join(", ")})
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Kind
        <select className={field} value={kind} onChange={(e) => setKind(e.target.value as Proposal["kind"])} data-agreement-kind>
          {(["program", "vendor", "data_sharing"] as const).map((k) => (
            <option key={k} value={k}>
              {AGREEMENT_KIND_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex flex-col gap-1 text-sm" data-agreement-products>
        <legend className="mb-1">Products it covers</legend>
        {offered.map((p) => (
          <label key={p.id} className="flex items-center gap-2">
            <input type="checkbox" checked={products.includes(p.id)} onChange={(e) => setProducts((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))} data-agreement-product={p.id} />
            {p.name}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">
        Summary of the terms
        <textarea className={`${field} min-h-24`} value={terms} onChange={(e) => setTerms(e.target.value)} maxLength={4000} required data-agreement-terms />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        Link to the document (optional, https)
        <input className={field} type="url" value={doc} onChange={(e) => setDoc(e.target.value)} placeholder="https://" data-agreement-document />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Effective from (optional)
          <input className={field} type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-agreement-from />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Until (optional)
          <input className={field} type="date" value={to} onChange={(e) => setTo(e.target.value)} data-agreement-to />
        </label>
      </div>
      {!done && (
        <div>
          <Button type="submit" disabled={busy || !counterparty || terms.trim().length < 10 || (kind === "program" && !products.length)} data-propose-agreement-submit>
            {busy ? "Proposing…" : "Propose agreement"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-agreement-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-agreement-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function ProposeAgreementSheet({
  appId,
  data,
  initial,
  open,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  appId: string
  data: Pick<AppAgreements, "sponsors" | "products">
  initial?: ProposalStart
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
  const submit = async (p: Proposal) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await post(`/api/apps/${encodeURIComponent(appId)}/agreements`, p, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.message)
    onDone()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-propose-agreement-sheet>
        <SheetHeader>
          <SheetTitle>Propose agreement</SheetTitle>
          <SheetDescription>An agreement between this app&apos;s workspace and a firm behind its products. They accept or decline it; then both sides sign. Recorded in the audit trail.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <ProposeAgreementView key={round} data={data} initial={initial} busy={busy} error={error} result={result} onSubmit={(p) => void submit(p)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

// ---- an agreement's row actions, on either side: Sign, End agreement, Withdraw, Accept, Decline ----
//
// Each opens a sheet saying what it does; ending and withdrawing take the reason (the other side sees it),
// accepting and declining an optional note. The sheet posts { action, reason | note } to the side's own route:
// /api/apps/<app>/agreements/<id> for the app's side, /api/agreements/<id> for the other firm's.

export type AgreementSummary = { id: string; title: string; lines: string[] }
// What the routes take: Withdraw and End agreement are both Mynt's terminate_app_agreement.
export type AgreementActionBody = { action: "sign" | "terminate" | "accept" | "decline"; reason?: string; note?: string }

const ACTION_COPY: Record<AgreementAction, { title: string; says: string; button: string; busy: string; reason: "required" | "optional" | null }> = {
  sign: { title: "Sign agreement", says: "Records your side's signature, with your name and the time, in the audit trail. It's signed once both sides have signed.", button: "Sign agreement", busy: "Signing…", reason: null },
  end: { title: "End agreement", says: "Ends it for both sides. The other side is told, with your reason. An app in production that relied on it keeps running, but its production checks fail until a new program agreement is signed.", button: "End agreement", busy: "Ending…", reason: "required" },
  withdraw: { title: "Withdraw proposal", says: "Withdraws your proposal before the other firm answers it. They're told, with your reason.", button: "Withdraw proposal", busy: "Withdrawing…", reason: "required" },
  accept: { title: "Accept agreement", says: "Accepts the proposal for your firm. Then both sides sign it; it's signed only once both have.", button: "Accept agreement", busy: "Accepting…", reason: "optional" },
  decline: { title: "Decline agreement", says: "Declines the proposal for your firm. The app's side can propose another.", button: "Decline agreement", busy: "Declining…", reason: "optional" },
}
export const actionTitle = (a: AgreementAction) => ACTION_COPY[a].title

export function AgreementActionView({
  action,
  agreement,
  busy = false,
  error = null,
  result = null,
  onSubmit,
}: {
  action: AgreementAction
  agreement: AgreementSummary
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (body: AgreementActionBody) => void
}) {
  const copy = ACTION_COPY[action]
  const [text, setText] = useState("")
  const needs = copy.reason === "required"
  return (
    <form
      className="flex flex-col gap-3"
      data-agreement-action-form={action}
      onSubmit={(e) => {
        e.preventDefault()
        const t = text.trim()
        if (action === "sign") onSubmit({ action: "sign" })
        else if (action === "end" || action === "withdraw") onSubmit({ action: "terminate", reason: t })
        else onSubmit({ action, ...(t ? { note: t } : {}) })
      }}
    >
      <div className="rounded-lg border p-3 text-sm" data-agreement-summary={agreement.id}>
        <p className="font-medium">{agreement.title}</p>
        {agreement.lines.map((l) => (
          <p key={l} className="text-muted-foreground">
            {l}
          </p>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">{copy.says}</p>
      {copy.reason && (
        <label className="flex flex-col gap-1 text-sm">
          {needs ? "Reason" : "Note to the app's side (optional)"}
          <textarea className={`${field} min-h-20`} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} required={needs} data-agreement-reason />
        </label>
      )}
      {result === null && (
        <div>
          <Button type="submit" variant={action === "end" || action === "decline" || action === "withdraw" ? "destructive" : "default"} disabled={busy || (needs && text.trim().length < 3)} data-agreement-action-submit={action}>
            {busy ? copy.busy : copy.button}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-agreement-action-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-agreement-action-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function AgreementActionSheet({
  url,
  action,
  agreement,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  url: string // the side's route for this agreement
  action: AgreementAction | null // null: closed
  agreement: AgreementSummary | null
  onClose: () => void
  onDone: () => void
  fetcher?: typeof fetch
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const open = action !== null && agreement !== null
  useEffect(() => {
    if (!open) return
    setError(null)
    setResult(null)
    setRound((r) => r + 1)
  }, [open, action, agreement?.id])
  const submit = async (body: AgreementActionBody) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await post(url, body, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.message)
    onDone()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-agreement-action-sheet={action ?? undefined}>
        <SheetHeader>
          <SheetTitle>{action ? ACTION_COPY[action].title : "Agreement"}</SheetTitle>
          <SheetDescription>Recorded in the audit trail; the other side is told.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          {open && <AgreementActionView key={round} action={action} agreement={agreement} busy={busy} error={error} result={result} onSubmit={(b) => void submit(b)} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** A row's labelled action buttons. */
export function AgreementActionButtons({ actions, onAction, id }: { actions: AgreementAction[]; onAction: (a: AgreementAction) => void; id: string }) {
  if (!actions.length) return null
  return (
    <div className="flex flex-wrap gap-1.5" data-agreement-actions={id}>
      {actions.map((a) => (
        <Button key={a} size="sm" variant="outline" className="h-7" onClick={() => onAction(a)} data-agreement-action={a}>
          {AGREEMENT_ACTION_LABELS[a]}
        </Button>
      ))}
    </div>
  )
}

// ---- production's program agreements: each product's sponsor, and whether a signed agreement covers it ----

/**
 * The program agreements production needs, one row per product and sponsor, each "Signed and in force" or why
 * not. A missing one has a "Propose agreement" shortcut (owners and admins), pre-filled with that sponsor and
 * product. Used by the Products and Agreements tabs and the Move to production sheet.
 */
export function ProgramCoverage({
  appId,
  coverage,
  canPropose,
  onChanged,
  sheetData,
}: {
  appId: string
  coverage: AgreementCoverage[]
  canPropose: boolean
  onChanged?: () => void
  sheetData?: Pick<AppAgreements, "sponsors" | "products"> // what the sheet offers; by default, the sponsors in `coverage`
}) {
  const [start, setStart] = useState<ProposalStart | null>(null)
  const data = useMemo(() => sheetData ?? sponsorsFromCoverage(coverage), [sheetData, coverage])
  if (!coverage.length)
    return (
      <p className="text-sm text-muted-foreground" data-program-coverage="none">
        No licence provider sponsors this app&apos;s products where it serves, so production needs no program agreement.
      </p>
    )
  return (
    <>
      <ul className="flex flex-col divide-y rounded-lg border text-sm" data-program-coverage>
        {coverage.map((c) => (
          <li key={`${c.productId}/${c.sponsorId}`} className="flex flex-wrap items-center justify-between gap-2 p-2.5" data-coverage={`${c.productId}/${c.sponsorId}`} data-covered={c.covered}>
            <div className="flex min-w-0 flex-col">
              <span className="font-medium">
                {c.sponsorName} for {c.productName}
              </span>
              <span className={c.covered ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{coverageText(c)}</span>
            </div>
            {!c.covered && canPropose && (
              <Button size="sm" variant="outline" className="h-7" onClick={() => setStart({ counterparty: c.sponsorId, products: [c.productId] })} data-propose-for={`${c.productId}/${c.sponsorId}`}>
                <FilePlus2 /> Propose agreement
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canPropose && <ProposeAgreementSheet appId={appId} data={data} initial={start ?? undefined} open={start !== null} onClose={() => setStart(null)} onDone={() => onChanged?.()} />}
    </>
  )
}

export type PersonaChoice = { product_id: string; segment_id: string }

export function ChoosePersonasView({
  data,
  busy = false,
  error = null,
  result = null,
  onSubmit,
}: {
  data: Pick<AppCustomers, "products">
  busy?: boolean
  error?: string | null
  result?: string | null
  onSubmit: (segments: PersonaChoice[]) => void
}) {
  const key = (c: PersonaChoice) => `${c.product_id}/${c.segment_id}`
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(data.products.flatMap((p) => p.personas.filter((s) => s.targeted).map((s) => key({ product_id: p.id, segment_id: s.id })))))
  const any = data.products.some((p) => p.personas.length)
  if (!any)
    return (
      <p className="text-sm text-muted-foreground" data-no-personas>
        None of this app&apos;s products declares customer segments yet, so there are no personas to choose from.
      </p>
    )
  return (
    <form
      className="flex flex-col gap-4"
      data-choose-personas-form
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit([...chosen].map((k) => ({ product_id: k.slice(0, k.indexOf("/")), segment_id: k.slice(k.indexOf("/") + 1) })))
      }}
    >
      {data.products
        .filter((p) => p.personas.length)
        .map((p) => (
          <fieldset key={p.id} className="flex flex-col gap-1 text-sm" data-personas-product={p.id}>
            <legend className="mb-1 font-medium">{p.name}</legend>
            {p.personas.map((s) => {
              const k = key({ product_id: p.id, segment_id: s.id })
              return (
                <label key={s.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={chosen.has(k)}
                    onChange={(e) =>
                      setChosen((cur) => {
                        const next = new Set(cur)
                        if (e.target.checked) next.add(k)
                        else next.delete(k)
                        return next
                      })
                    }
                    data-persona={k}
                  />
                  {s.name}
                  {s.kind ? <span className="text-xs text-muted-foreground">({s.kind})</span> : null}
                </label>
              )
            })}
          </fieldset>
        ))}
      {result === null && (
        <div>
          <Button type="submit" disabled={busy} data-choose-personas-submit>
            {busy ? "Saving…" : "Save personas"}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive" data-personas-error>
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="text-sm font-medium" data-personas-result>
          {result}
        </p>
      )}
    </form>
  )
}

export function ChoosePersonasSheet({
  appId,
  data,
  open,
  onClose,
  onDone,
  fetcher = (...a) => fetch(...a),
}: {
  appId: string
  data: Pick<AppCustomers, "products">
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
  const submit = async (segments: PersonaChoice[]) => {
    if (busy) return
    setBusy(true)
    setError(null)
    const r = await post(`/api/apps/${encodeURIComponent(appId)}/customers`, { segments }, fetcher)
    setBusy(false)
    if (!r.ok) return setError(r.message)
    setResult(r.message)
    onDone()
  }
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" data-choose-personas-sheet>
        <SheetHeader>
          <SheetTitle>Choose personas</SheetTitle>
          <SheetDescription>The customers this app is for, from the segments its products declare. Recorded in the audit trail.</SheetDescription>
        </SheetHeader>
        <div className="px-4 pb-6">
          <ChoosePersonasView key={round} data={data} busy={busy} error={error} result={result} onSubmit={(s) => void submit(s)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
