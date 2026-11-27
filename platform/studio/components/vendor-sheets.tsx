"use client"

// My services' sheets: every change in a service provider's own area is a labelled button opening one of these, which
// posts to an /api/vendor route and shows Mynt's answer in its own words. Create service and Edit service
// (create_vendor_offering, update_vendor_offering), Set standard terms (an https link with the document's SHA-256,
// computed here in the browser from the file, or pasted; a summary; the pricing in words; the Scope, at least one;
// each change a new version),
// Run practice test (the same cases against Mynt's own sandbox, with each case's result and what Mynt sent and
// expected; it never counts), Run conformance (Mynt's own test of the endpoint, with each failure) and List service /
// Unlist service.
// Server-renderable for the tests.
import { useEffect, useMemo, useState } from "react"
import { Copy } from "lucide-react"

import { AdminSheet, Field, fieldClass, useAdminAction } from "@/components/admin-kit"
import { ScopeField } from "@/components/agreement-scope-field"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { AgreementScope } from "@/lib/app-panel"
import { categoryLabel } from "@/lib/marketplace"
import { isHttpsUrl, sha256Hex, sha256Of, type LicenceOption, type PracticeResult, type ServiceTypeOption, type VendorOffering } from "@/lib/vendor-area"

type Done = () => void
const offeringPath = (id: string, tail = "") => `/api/vendor/offerings/${encodeURIComponent(id)}${tail}`
const blankToUndefined = (s: string) => (s.trim() ? s.trim() : undefined)

// ---- Create service / Edit service ----

type ServiceForm = { typeKey: string; name: string; testUrl: string; liveUrl: string; amount: string; currency: string; sla: string; licenceIds: string[]; requiresCredential: boolean }
const formOf = (o: VendorOffering | null): ServiceForm => ({
  typeKey: o ? `${o.region}/${o.serviceKey}` : "",
  name: o?.name ?? "",
  testUrl: o?.testBaseUrl ?? "",
  liveUrl: o?.liveBaseUrl ?? "",
  amount: o?.price ? String(o.price.amount) : "",
  currency: o?.price?.currency ?? "USD",
  sla: o?.slaNotes ?? "",
  licenceIds: o?.licenceIds ?? [],
  requiresCredential: o?.requiresCredential ?? false,
})

/** What's wrong with the form, in words, or null when it can be sent. */
export function serviceFormProblem(f: ServiceForm, creating: boolean, hadTestUrl = true): string | null {
  if (creating && !f.typeKey) return "Choose the standard service type."
  if (!f.name.trim()) return "Give the service a name."
  // A new draft may leave it blank, to practise against Mynt's sandbox first. Mynt's real test and listing need it.
  if (f.testUrl.trim() ? !isHttpsUrl(f.testUrl) : !creating && hadTestUrl) return "The test endpoint must be an https link."
  if (f.liveUrl.trim() && !isHttpsUrl(f.liveUrl)) return "The live endpoint must be an https link."
  const amount = Number(f.amount)
  if (!f.amount.trim() || !Number.isFinite(amount) || amount < 0) return "Give your price per call (0 or more)."
  if (!/^[A-Z]{3}$/.test(f.currency.trim().toUpperCase())) return "The currency is three letters, e.g. USD."
  return null
}

export function ServiceSheet({
  mode,
  offering = null,
  open,
  serviceTypes,
  licences,
  onClose,
  onDone,
  fetcher,
}: {
  mode: "create" | "edit"
  offering?: VendorOffering | null
  open: boolean
  serviceTypes: ServiceTypeOption[]
  licences: LicenceOption[]
  onClose: () => void
  onDone: Done
  fetcher?: typeof fetch
}) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [f, setF] = useState<ServiceForm>(() => formOf(offering))
  const [invalid, setInvalid] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
    setSecret(null)
    setF(formOf(offering))
  }, [open, offering, reset])
  const set = (patch: Partial<ServiceForm>) => setF((x) => ({ ...x, ...patch }))
  const creating = mode === "create"
  const region = creating ? (f.typeKey.split("/")[0] ?? "") : (offering?.region ?? "")
  const picked = serviceTypes.find((t) => `${t.region}/${t.key}` === f.typeKey) ?? null
  const usable = useMemo(() => licences.filter((l) => !region || l.region === region), [licences, region])
  const title = creating ? "Create service" : "Edit service"
  return (
    <AdminSheet
      id={creating ? "create-service" : "edit-service"}
      open={open}
      onClose={() => {
        setSecret(null) // the signing secret isn't kept once the sheet closes
        onClose()
      }}
      title={title}
      description={
        creating
          ? "Offer one of Mynt's standard services from your test endpoint. It starts as a draft; Mynt tests it before it's listed. No endpoint yet? Leave it blank and run a practice test first."
          : "Change your service. Changing an endpoint or licences makes it a draft again, to pass Mynt's conformance test before it's listed."
      }
      error={invalid ?? error}
      result={result}
    >
      <form
        className="flex flex-col gap-3"
        data-service-form={mode}
        onSubmit={async (e) => {
          e.preventDefault()
          const problem = serviceFormProblem(f, creating, Boolean(offering?.testBaseUrl))
          if (problem) return setInvalid(problem)
          setInvalid(null)
          const fields = {
            name: f.name.trim(),
            ...(f.testUrl.trim() ? { test_base_url: f.testUrl.trim() } : {}),
            ...(f.liveUrl.trim() ? { live_base_url: f.liveUrl.trim() } : {}),
            price: { amount: Number(f.amount), currency: f.currency.trim().toUpperCase() },
            sla_notes: f.sla.trim(),
            licence_ids: f.licenceIds.filter((id) => usable.some((l) => l.id === id)),
            requires_credential: f.requiresCredential,
          }
          const r = creating
            ? await run("/api/vendor/offerings", { region: picked?.region ?? region, service_type: picked?.key ?? "", ...fields })
            : await run(offeringPath(offering!.id), fields)
          if (r?.ok) {
            if (typeof r.signing_secret === "string") setSecret(r.signing_secret)
            onDone()
          }
        }}
      >
        {creating ? (
          <Field label="Standard service type" hint="Defined by Mynt per region: the contract your endpoint implements">
            <select className={fieldClass} value={f.typeKey} onChange={(e) => set({ typeKey: e.target.value, licenceIds: [] })} required data-service-type>
              <option value="">Choose…</option>
              {serviceTypes.map((t) => (
                <option key={`${t.region}/${t.key}`} value={`${t.region}/${t.key}`}>
                  {t.region} · {t.name} ({categoryLabel(t.category)})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <p className="text-sm text-muted-foreground" data-service-fixed>
            {offering?.serviceKey} in {offering?.region}
          </p>
        )}
        {picked && picked.vendorLicences.length > 0 && (
          <p className="text-xs text-muted-foreground" data-service-needs-licence>
            This service needs your firm to hold a licence of one of: {picked.vendorLicences.join(", ")}, verified by Mynt and named below.
          </p>
        )}
        <Field label="Name">
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} required data-service-name />
        </Field>
        <Field
          label={creating || !offering?.testBaseUrl ? "Test endpoint (optional for now)" : "Test endpoint"}
          hint={creating || !offering?.testBaseUrl ? "https only. Mynt calls POST <endpoint>/v1/<service type>. Mynt's real test and listing need it; a practice test doesn't" : "https only. Mynt calls POST <endpoint>/v1/<service type>"}
        >
          <Input value={f.testUrl} onChange={(e) => set({ testUrl: e.target.value })} placeholder="https://api.example.com" inputMode="url" required={!creating && Boolean(offering?.testBaseUrl)} data-service-test-url />
        </Field>
        <Field label="Live endpoint (optional)" hint="https only">
          <Input value={f.liveUrl} onChange={(e) => set({ liveUrl: e.target.value })} placeholder="https://api.example.com" inputMode="url" data-service-live-url />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price per call" hint="For subscribers to see; you bill them directly">
            <Input value={f.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" required data-service-price />
          </Field>
          <Field label="Currency">
            <Input value={f.currency} onChange={(e) => set({ currency: e.target.value })} maxLength={3} required data-service-currency />
          </Field>
        </div>
        <Field label="Service levels (optional)">
          <textarea className={`${fieldClass} min-h-16`} value={f.sla} onChange={(e) => set({ sla: e.target.value })} maxLength={2000} data-service-sla />
        </Field>
        <fieldset className="flex flex-col gap-1 text-sm" data-service-licences>
          <legend className="mb-1">Licences it relies on</legend>
          {usable.length ? (
            usable.map((l) => (
              <label key={l.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={f.licenceIds.includes(l.id)}
                  onChange={(e) => set({ licenceIds: e.target.checked ? [...f.licenceIds, l.id] : f.licenceIds.filter((x) => x !== l.id) })}
                  data-service-licence={l.id}
                />
                {l.licenceType} ({l.number}) · {l.status === "verified" ? "Verified by Mynt" : l.status === "pending" ? "Waiting for Mynt to verify" : l.status}
              </label>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No licences registered{region ? ` in ${region}` : ""}. Register one with the register_license tool for Mynt to verify.</span>
          )}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={f.requiresCredential} onChange={(e) => set({ requiresCredential: e.target.checked })} data-service-credential />
          Subscribers need a credential I issue them (sent as Authorization: Bearer)
        </label>
        <div>
          <Button type="submit" disabled={busy || result !== null} data-service-submit={mode}>
            {busy ? "Saving…" : title}
          </Button>
        </div>
      </form>
      {secret && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-signing-secret>
          <p className="font-medium">Conformance signing secret (shown once)</p>
          <code className="break-all rounded bg-muted p-2 text-xs">{secret}</code>
          <p className="text-xs text-muted-foreground">Your test endpoint checks Mynt-Signature with it. It isn&apos;t shown again, here or anywhere.</p>
          <div>
            <Button type="button" size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(secret)} data-copy-secret>
              <Copy />
              Copy signing secret
            </Button>
          </div>
        </div>
      )}
    </AdminSheet>
  )
}

// ---- Set standard terms ----

export function TermsSheet({ offering, onClose, onDone, fetcher }: { offering: VendorOffering | null; onClose: () => void; onDone: Done; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [url, setUrl] = useState("")
  const [sha, setSha] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [summary, setSummary] = useState("")
  const [pricing, setPricing] = useState("")
  const [scopes, setScopes] = useState<AgreementScope[]>([])
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    reset()
    setInvalid(null)
    setFileName(null)
    setUrl(offering?.terms?.documentUrl ?? "")
    setSha(offering?.terms?.documentSha256 ?? "")
    setSummary(offering?.terms?.summary ?? "")
    setPricing(offering?.terms?.pricing ?? "")
    // Terms from before scopes were recorded have none: the vendor chooses them for the new version.
    setScopes(offering?.terms?.scopes ?? [])
  }, [offering, reset])
  const next = (offering?.terms?.version ?? 0) + 1
  return (
    <AdminSheet
      id="set-terms"
      open={offering !== null}
      onClose={onClose}
      title="Set standard terms"
      description={`What subscribers accept in the Marketplace, with no negotiation. Saving a change makes version ${next}, a change of scope included; agreements already made keep the version and scope they accepted.`}
      error={invalid ?? error}
      result={result}
    >
      {offering && (
        <form
          className="flex flex-col gap-3"
          data-terms-form
          onSubmit={async (e) => {
            e.preventDefault()
            const digest = sha256Of(sha)
            if (!isHttpsUrl(url)) return setInvalid("The terms document link must be https.")
            if (!digest) return setInvalid("The document's SHA-256 is 64 hex characters: choose the file to compute it, or paste it.")
            if (summary.trim().length < 10) return setInvalid("Write a short summary (10 characters or more).")
            if (pricing.trim().length < 3) return setInvalid("Say your pricing in words.")
            if (!scopes.length) return setInvalid("Choose what your terms cover: at least one scope.")
            setInvalid(null)
            const r = await run(offeringPath(offering.id, "/terms"), {
              standard_terms: { document_url: url.trim(), document_sha256: digest, summary: summary.trim(), pricing_summary: pricing.trim(), scopes },
            })
            if (r?.ok) onDone()
          }}
        >
          <Field label="Terms document link" hint="https only: where subscribers read the full terms">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/terms.pdf" inputMode="url" required data-terms-url />
          </Field>
          <Field label="The document, to compute its SHA-256" hint="Read here in your browser; the file isn't uploaded anywhere">
            <input
              type="file"
              className="text-sm"
              data-terms-file
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setFileName(file.name)
                setSha(await sha256Hex(await file.arrayBuffer()))
              }}
            />
          </Field>
          <Field label="Document SHA-256" hint={fileName ? `Computed from ${fileName}` : "Or paste it: 64 hex characters"}>
            <Input value={sha} onChange={(e) => (setSha(e.target.value), setFileName(null))} maxLength={64} spellCheck={false} className="font-mono text-xs" required data-terms-sha />
          </Field>
          <Field label="Summary" hint="The terms in a few sentences, as subscribers see them before accepting">
            <textarea className={`${fieldClass} min-h-20`} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} required data-terms-summary />
          </Field>
          <Field label="Pricing in words" hint="e.g. $0.40 per check, invoiced monthly. You bill subscribers directly, never through Mynt">
            <Input value={pricing} onChange={(e) => setPricing(e.target.value)} maxLength={1000} required data-terms-pricing />
          </Field>
          <div data-terms-scopes>
            <ScopeField value={scopes} onChange={setScopes} />
            <p className="mt-1 text-xs text-muted-foreground">Every agreement made on these terms records this scope.</p>
          </div>
          <div>
            <Button type="submit" disabled={busy || result !== null || !scopes.length} data-terms-submit>
              {busy ? "Saving…" : "Save standard terms"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

// ---- Run conformance ----

type Failure = { case: string; problems: string[] }
// `hosted`: a service built and hosted on Mynt. Its endpoint is Mynt's (the hosted address, never typed), so the words
// say so; the test and its route are the same.
export function ConformanceSheet({ offering, onClose, onDone, fetcher, hosted = false }: { offering: VendorOffering | null; onClose: () => void; onDone: Done; fetcher?: typeof fetch; hosted?: boolean }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [credential, setCredential] = useState("")
  const [outcome, setOutcome] = useState<{ passed: boolean; failures: Failure[] } | null>(null)
  useEffect(() => {
    reset()
    setCredential("")
    setOutcome(null)
  }, [offering, reset])
  return (
    <AdminSheet
      id="run-conformance"
      open={offering !== null}
      onClose={onClose}
      title="Run conformance"
      description={
        hosted
          ? "Mynt calls the service at its hosted address with signed requests, checks every answer against the service's contract, that badly signed and stale requests are refused, and your licences. A pass lets it move to Production, where it is listed."
          : "Mynt calls your test endpoint itself with signed requests, checks every answer against the service's contract, that badly signed and stale requests are refused, and your licences. A pass lets you list the service."
      }
      error={error}
      result={result}
    >
      {offering && (
        <form
          className="flex flex-col gap-3"
          data-conformance-form
          autoComplete="off"
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(offeringPath(offering.id, "/conformance"), offering.requiresCredential ? { test_credential: blankToUndefined(credential) ?? "" } : {})
            setCredential("") // sent once; never kept in the form
            if (r?.ok) {
              setOutcome({ passed: r.passed === true, failures: Array.isArray(r.failures) ? (r.failures as Failure[]) : [] })
              onDone()
            }
          }}
        >
          <p className="text-sm">
            {offering.name} · {offering.testBaseUrl ? `${hosted ? "endpoint" : "test endpoint"} ${offering.testBaseUrl}` : hosted ? "not online yet" : "no test endpoint yet"}
          </p>
          {!offering.testBaseUrl &&
            (hosted ? (
              <p className="text-sm text-muted-foreground" data-conformance-no-endpoint>
                Mynt tests the service itself, at its hosted address. Put it online first. Until then, Run practice test shows the test against Mynt&apos;s sandbox; a practice pass doesn&apos;t count.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground" data-conformance-no-endpoint>
                Mynt&apos;s real test calls your own test endpoint. Add it with Edit service first. Until then, Run practice test shows the test against Mynt&apos;s sandbox; a practice pass doesn&apos;t count.
              </p>
            ))}
          {offering.requiresCredential && (
            <Field label="Test credential" hint="Sent to your test endpoint for this run only; Mynt doesn't keep it">
              <Input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} maxLength={2000} autoComplete="off" spellCheck={false} required data-conformance-credential />
            </Field>
          )}
          <div>
            <Button type="submit" disabled={busy || !offering.testBaseUrl || (offering.requiresCredential && !credential.trim())} data-conformance-submit>
              {busy ? "Mynt is testing…" : outcome ? "Run conformance again" : "Run conformance"}
            </Button>
          </div>
        </form>
      )}
      {outcome && (
        <div className="flex flex-col gap-2 text-sm" data-conformance-outcome={outcome.passed ? "passed" : "failed"}>
          <p className="font-medium">{outcome.passed ? "Result: passed" : "Result: didn't pass"}</p>
          {outcome.failures.length > 0 && (
            <ul className="list-disc pl-5" data-conformance-failures>
              {outcome.failures.map((f) => (
                <li key={f.case}>
                  <span className="font-medium">{f.case.replace(/_/g, " ")}</span>: {f.problems.join("; ") || "failed"}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </AdminSheet>
  )
}

// ---- Run practice test ----

function downloadJson(name: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2)

/** Mynt's test cases against Mynt's own sandbox for the service. For practice only: it never counts as conformance. */
export function PracticeSheet({ offering, onClose, onDone, fetcher }: { offering: VendorOffering | null; onClose: () => void; onDone: Done; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [outcome, setOutcome] = useState<PracticeResult | null>(null)
  useEffect(() => {
    reset()
    setOutcome(null)
  }, [offering, reset])
  const ref = outcome?.reference ?? null
  return (
    <AdminSheet
      id="run-practice"
      open={offering !== null}
      onClose={onClose}
      title="Run practice test"
      description="Mynt runs its conformance test's own cases against its own sandbox for this service, which answers as a correct endpoint would. Nothing leaves Mynt. It shows what Mynt sends and expects, so you can build your endpoint against it. A practice pass never counts: the service stays as it is, and listing still needs the real test of your own endpoint."
      error={error}
      result={result}
    >
      {offering && (
        <form
          className="flex flex-col gap-3"
          data-practice-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(offeringPath(offering.id, "/practice"), {})
            if (r?.ok) {
              setOutcome({
                passed: r.passed === true,
                status: typeof r.status === "string" ? r.status : null,
                cases: Array.isArray(r.cases) ? (r.cases as PracticeResult["cases"]) : [],
                licenceNote: typeof r.licenceNote === "string" ? r.licenceNote : null,
                reference: (r.reference as PracticeResult["reference"]) ?? null,
              })
              onDone()
            }
          }}
        >
          <p className="text-sm">
            {offering.name} · {offering.serviceKey} in {offering.region}
          </p>
          <div>
            <Button type="submit" disabled={busy} data-practice-submit>
              {busy ? "Mynt is practising…" : outcome ? "Run practice test again" : "Run practice test"}
            </Button>
          </div>
        </form>
      )}
      {outcome && (
        <div className="flex flex-col gap-3 text-sm" data-practice-outcome={outcome.passed ? "passed" : "failed"}>
          <p className="font-medium">{outcome.passed ? "Practice result: passed (doesn't count as conformance)" : "Practice result: didn't pass"}</p>
          <ul className="flex flex-col gap-1" data-practice-cases>
            {outcome.cases.map((c) => (
              <li key={c.case} data-practice-case={c.case} data-practice-case-result={c.passed ? "passed" : "failed"}>
                <span className="font-medium">{c.case.replace(/_/g, " ")}</span>: {c.passed ? "Passed" : "Didn't pass"}
                {c.httpStatus !== null ? ` (HTTP ${c.httpStatus})` : ""}
                {c.problems.length ? `: ${c.problems.join("; ")}` : ""}
              </li>
            ))}
          </ul>
          {outcome.licenceNote && (
            <p className="text-muted-foreground" data-practice-licence-note>
              {outcome.licenceNote}
            </p>
          )}
          {ref ? (
            <div className="flex flex-col gap-2" data-practice-reference>
              <p className="font-medium">What Mynt sends and expects</p>
              <p className="text-muted-foreground">
                {ref.sendsTo}. {ref.signature} {ref.marker}
              </p>
              <p className="text-muted-foreground">Expects: {ref.expects}</p>
              <div>
                <Button type="button" size="sm" variant="outline" onClick={() => downloadJson(`practice-${ref.serviceType || "service"}.json`, ref)} data-practice-download>
                  Download transcript
                </Button>
              </div>
              {ref.transcript.map((x) => (
                <details key={x.case} className="rounded-md border p-2" data-practice-exchange={x.case}>
                  <summary className="cursor-pointer font-medium">{x.case.replace(/_/g, " ")}</summary>
                  <p className="mt-1 text-muted-foreground">Expected: {x.expected}</p>
                  <p className="mt-2 text-xs font-medium">
                    Mynt sent: {x.request.method} {x.request.path}
                  </p>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{pretty({ headers: x.request.headers, body: x.request.body })}</pre>
                  <p className="mt-2 text-xs font-medium">The sandbox answered: HTTP {x.response.httpStatus ?? "—"}</p>
                  <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-xs">{pretty(x.response.body)}</pre>
                </details>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground" data-practice-no-reference>
              Mynt didn&apos;t send a transcript for this run.
            </p>
          )}
        </div>
      )}
    </AdminSheet>
  )
}

// ---- List service / Unlist service ----

export function ListingSheet({ offering, onClose, onDone, fetcher }: { offering: VendorOffering | null; onClose: () => void; onDone: Done; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  useEffect(() => reset(), [offering, reset])
  const listing = offering?.status !== "listed"
  return (
    <AdminSheet
      id="listing"
      open={offering !== null}
      onClose={onClose}
      title={listing ? "List service" : "Unlist service"}
      description={
        listing
          ? "App teams see it in the Marketplace and subscribe by accepting your standard terms. Mynt lists it only once it passed conformance."
          : "It comes off the Marketplace. Current subscribers keep it."
      }
      error={error}
      result={result}
    >
      {offering && (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            {offering.name} ({offering.region})
          </p>
          {listing && !offering.terms && (
            <p className="text-sm text-muted-foreground" data-listing-no-terms>
              It has no standard terms yet: app teams can&apos;t subscribe from the Marketplace until you set them.
            </p>
          )}
          <div>
            <Button
              variant={listing ? "default" : "outline"}
              disabled={busy || result !== null}
              onClick={async () => {
                const r = await run(offeringPath(offering.id, "/listing"), { listed: listing })
                if (r?.ok) onDone()
              }}
              data-listing-submit={listing ? "list" : "unlist"}
            >
              {busy ? "Saving…" : listing ? "List service" : "Unlist service"}
            </Button>
          </div>
        </div>
      )}
    </AdminSheet>
  )
}
