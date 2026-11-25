"use client"

// My firm's sheets: every change in a regulated firm's own area is a labelled button opening one of these, which posts
// to an /api/firm route and shows Mynt's answer in its own words. Set firm facts (set_entity_facts: the identifiers the
// real-company check looks the firm up by), Register licence (register_license), Review request (Approve sponsorship or
// Decline request), Revoke sponsorship, Add party and End party (the roster), and Decide (a member waiting to be
// accepted). Server-renderable for the tests.
import { useEffect, useMemo, useState } from "react"

import { AdminSheet, Field, fieldClass, useAdminAction } from "@/components/admin-kit"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  checkLine,
  FACT_SCHEMES,
  identifiersToSave,
  jurisdictionWords,
  leiProblem,
  type Firm,
  type FirmLicence,
  type FirmPerson,
  type LicenceTypeOption,
  type NeededRole,
  type RealCompanyCheck,
  type RosterRow,
  type Sponsorship,
} from "@/lib/firm-area"

type Done = () => void
type SheetProps = { onClose: () => void; onDone: Done; fetcher?: typeof fetch }
const DATE = /^\d{4}-\d{2}-\d{2}$/
const today = () => new Date().toISOString().slice(0, 10)

// ---- Set firm facts ----

export function FirmFactsSheet({ open, firm, check, onClose, onDone, fetcher }: SheetProps & { open: boolean; firm: Firm | null; check: RealCompanyCheck | null }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const current = useMemo(() => Object.fromEntries(FACT_SCHEMES.map((f) => [f.scheme, firm?.identifiers.find((i) => i.scheme === f.scheme)?.value ?? ""])), [firm])
  const [typed, setTyped] = useState<Record<string, string>>(current)
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
    setTyped(current)
  }, [open, current, reset])
  const others = (firm?.identifiers ?? []).filter((i) => !FACT_SCHEMES.some((f) => f.scheme === i.scheme))
  return (
    <AdminSheet
      id="firm-facts"
      open={open}
      onClose={onClose}
      title="Set firm facts"
      description="What Mynt looks your firm up by on the public registers, to show it's a real company before it sponsors. Your legal name is Mynt's to correct: ask Mynt if it's wrong."
      error={invalid ?? error}
      result={result}
    >
      {firm && (
        <form
          className="flex flex-col gap-3"
          data-firm-facts-form
          onSubmit={async (e) => {
            e.preventDefault()
            const problem = leiProblem(typed.lei ?? "")
            if (problem) return setInvalid(problem)
            setInvalid(null)
            const r = await run("/api/firm/facts", { identifiers: identifiersToSave(firm.identifiers, typed) })
            if (r?.ok) onDone()
          }}
        >
          <p className="text-sm" data-facts-legal-name>
            Legal name on Mynt: <span className="font-medium">{firm.name}</span>
          </p>
          {check?.ruleText && (
            <p className="text-xs text-muted-foreground" data-facts-rule>
              The rule: {check.ruleText}.
            </p>
          )}
          {FACT_SCHEMES.map((f) => (
            <Field key={f.scheme} label={f.label} hint={f.hint}>
              <Input value={typed[f.scheme] ?? ""} onChange={(e) => setTyped((t) => ({ ...t, [f.scheme]: e.target.value }))} maxLength={100} spellCheck={false} data-fact={f.scheme} />
            </Field>
          ))}
          {others.length > 0 && (
            <p className="text-xs text-muted-foreground" data-facts-kept>
              Kept as they are: {others.map((i) => `${i.scheme.replace(/_/g, " ")} ${i.value}`).join(", ")}.
            </p>
          )}
          <div>
            <Button type="submit" disabled={busy || result !== null} data-firm-facts-submit>
              {busy ? "Saving…" : "Set firm facts"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

// ---- Register licence ----

type LicenceForm = { typeKey: string; jurisdiction: string; number: string; validFrom: string; validTo: string }
const BLANK_LICENCE: LicenceForm = { typeKey: "", jurisdiction: "", number: "", validFrom: "", validTo: "" }
const typeKeyOf = (t: LicenceTypeOption) => `${t.region}/${t.regulatorId}/${t.id}`

/** What's wrong with the form, in words, or null when it can be sent. */
export function licenceFormProblem(f: LicenceForm, picked: LicenceTypeOption | null): string | null {
  if (!picked) return "Choose the licence type."
  if (!f.number.trim()) return "Give the licence's number, as the regulator's register shows it."
  if (picked.perJurisdiction && !f.jurisdiction) return "This licence type is issued per state: choose the one it was issued for."
  for (const d of [f.validFrom, f.validTo]) if (d && !DATE.test(d)) return "Dates are YYYY-MM-DD."
  if (f.validFrom && f.validTo && f.validTo < f.validFrom) return "It can't end before it starts."
  return null
}

export function RegisterLicenceSheet({ open, licenceTypes, onClose, onDone, fetcher }: SheetProps & { open: boolean; licenceTypes: LicenceTypeOption[] }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [f, setF] = useState<LicenceForm>(BLANK_LICENCE)
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
    setF(BLANK_LICENCE)
  }, [open, reset])
  const set = (patch: Partial<LicenceForm>) => setF((x) => ({ ...x, ...patch }))
  const picked = licenceTypes.find((t) => typeKeyOf(t) === f.typeKey) ?? null
  return (
    <AdminSheet
      id="register-licence"
      open={open}
      onClose={onClose}
      title="Register licence"
      description="Record a licence your firm holds. Mynt verifies it against the regulator's register before it counts; you can sponsor under it once it's verified and in force."
      error={invalid ?? error}
      result={result}
    >
      <form
        className="flex flex-col gap-3"
        data-register-licence-form
        onSubmit={async (e) => {
          e.preventDefault()
          const problem = licenceFormProblem(f, picked)
          if (problem || !picked) return setInvalid(problem)
          setInvalid(null)
          const r = await run("/api/firm/licences", {
            region: picked.region,
            regulator_id: picked.regulatorId,
            license_id: picked.id,
            ...(picked.perJurisdiction ? { jurisdiction: f.jurisdiction } : {}),
            registration_number: f.number.trim(),
            ...(f.validFrom ? { valid_from: f.validFrom } : {}),
            ...(f.validTo ? { valid_to: f.validTo } : {}),
          })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Licence type" hint="From Mynt's regulatory model for your firm's regions">
          <select className={fieldClass} value={f.typeKey} onChange={(e) => set({ typeKey: e.target.value, jurisdiction: "" })} required data-licence-type>
            <option value="">Choose…</option>
            {licenceTypes.map((t) => (
              <option key={typeKeyOf(t)} value={typeKeyOf(t)}>
                {t.region} · {t.regulator} · {t.name}
              </option>
            ))}
          </select>
        </Field>
        {licenceTypes.length === 0 && (
          <p className="text-xs text-muted-foreground" data-no-licence-types>
            Mynt&apos;s regulatory model has no licence types for your firm&apos;s regions yet. Ask Mynt to add them.
          </p>
        )}
        {picked?.perJurisdiction && (
          <Field label="Issued for" hint="This licence type is issued per state: register it once for each state you hold it in">
            <select className={fieldClass} value={f.jurisdiction} onChange={(e) => set({ jurisdiction: e.target.value })} required data-licence-jurisdiction>
              <option value="">Choose…</option>
              {picked.jurisdictions.map((j) => (
                <option key={j} value={j}>
                  {j.toUpperCase()}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Licence number" hint="As the regulator's register shows it">
          <Input value={f.number} onChange={(e) => set({ number: e.target.value })} maxLength={100} required spellCheck={false} data-licence-number />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid from (optional)">
            <Input type="date" value={f.validFrom} onChange={(e) => set({ validFrom: e.target.value })} data-licence-valid-from />
          </Field>
          <Field label="Valid to (optional)">
            <Input type="date" value={f.validTo} onChange={(e) => set({ validTo: e.target.value })} data-licence-valid-to />
          </Field>
        </div>
        <div>
          <Button type="submit" disabled={busy || result !== null} data-register-licence-submit>
            {busy ? "Registering…" : "Register licence"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

// ---- Review request: Approve sponsorship or Decline request ----

export function ReviewRequestSheet({ request, check, licences, onClose, onDone, fetcher }: SheetProps & { request: Sponsorship | null; check: RealCompanyCheck | null; licences: FirmLicence[] }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  // The licences that grant the component, as Mynt matched them; only those verified and in force can be named.
  const usable = useMemo(() => (request?.granting ?? []).filter((l) => l.inForce), [request])
  const [licenceIds, setLicenceIds] = useState<string[]>([])
  const [where, setWhere] = useState<string[]>([])
  const [note, setNote] = useState("")
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    reset()
    setInvalid(null)
    setNote("")
    setLicenceIds(usable.map((l) => l.id))
    setWhere(request?.asked ?? [])
  }, [request, usable, reset])
  // Mynt refuses an approval until the firm passes the real-company check: said here, before anyone tries.
  const notPassed = check !== null && check.passes === false
  const toggle = (list: string[], set: (v: string[]) => void, id: string, on: boolean) => set(on ? [...list, id] : list.filter((x) => x !== id))
  const path = request ? `/api/firm/sponsorships/${encodeURIComponent(request.id)}` : ""
  return (
    <AdminSheet
      id="review-request"
      open={request !== null}
      onClose={onClose}
      title="Review request"
      description="A builder asks your firm to sponsor one component of its product under your licences. Approving covers it where you approve, by the licences you name; declining says why."
      error={invalid ?? error}
      result={result}
    >
      {request && (
        <div className="flex flex-col gap-3" data-review-request={request.id}>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            {[
              ["Product", request.product],
              ["Builder", request.builder],
              ["Component", `${request.component} (${request.componentWords})`],
              ["Asked for", jurisdictionWords(request.asked)],
            ].map(([k, v]) => (
              <div key={k} className="flex flex-col">
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {request.note && <p className="text-sm text-muted-foreground">Their note: {request.note}</p>}
          {notPassed && (
            <p role="status" className="rounded-md border p-2 text-sm" data-review-check-warning>
              You can&apos;t approve yet. {checkLine(check)} You can still decline.
            </p>
          )}
          <fieldset className="flex flex-col gap-1 text-sm" data-review-licences>
            <legend className="mb-1">Sponsor it under</legend>
            {request.granting.length ? (
              request.granting.map((l) => (
                <label key={l.id} className="flex items-center gap-2">
                  <input type="checkbox" checked={licenceIds.includes(l.id)} disabled={!l.inForce} onChange={(e) => toggle(licenceIds, setLicenceIds, l.id, e.target.checked)} data-review-licence={l.id} />
                  {l.licenceType}
                  {l.jurisdiction ? ` (${l.jurisdiction.toUpperCase()})` : ""} · {l.inForce ? "Verified, in force" : "Not verified and in force yet"}
                </label>
              ))
            ) : (
              <span className="text-muted-foreground" data-review-no-licences>
                None of your firm&apos;s {licences.length ? `${licences.length} ` : ""}licences grants this component. Register one that does, or decline.
              </span>
            )}
          </fieldset>
          {request.asked.length > 0 && (
            <fieldset className="flex flex-col gap-1 text-sm" data-review-jurisdictions>
              <legend className="mb-1">Where</legend>
              {request.asked.map((j) => (
                <label key={j} className="flex items-center gap-2">
                  <input type="checkbox" checked={where.includes(j)} onChange={(e) => toggle(where, setWhere, j, e.target.checked)} data-review-jurisdiction={j} />
                  {j.toUpperCase()}
                </label>
              ))}
            </fieldset>
          )}
          <Field label="Note or reason" hint="Optional when approving; needed to decline (the builder sees it)">
            <textarea className={`${fieldClass} min-h-16`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} data-review-note />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={busy || result !== null || notPassed || !usable.length}
              title={notPassed ? "Mynt refuses it until the real-company check passes" : !usable.length ? "No licence of yours that grants it is verified and in force" : undefined}
              onClick={async () => {
                if (!licenceIds.length) return setInvalid("Choose the licence to sponsor it under.")
                if (request.asked.length && !where.length) return setInvalid("Choose where you sponsor it.")
                setInvalid(null)
                const r = await run(path, { action: "approve", licence_ids: licenceIds, ...(request.asked.length ? { jurisdictions: where } : {}), ...(note.trim() ? { note: note.trim() } : {}) })
                if (r?.ok) onDone()
              }}
              data-review-approve
            >
              {busy ? "Saving…" : "Approve sponsorship"}
            </Button>
            <Button
              variant="outline"
              disabled={busy || result !== null}
              onClick={async () => {
                if (note.trim().length < 3) return setInvalid("Say why you decline (3 characters or more).")
                setInvalid(null)
                const r = await run(path, { action: "decline", reason: note.trim() })
                if (r?.ok) onDone()
              }}
              data-review-decline
            >
              Decline request
            </Button>
          </div>
        </div>
      )}
    </AdminSheet>
  )
}

// ---- Revoke sponsorship ----

export function RevokeSponsorshipSheet({ sponsorship, onClose, onDone, fetcher }: SheetProps & { sponsorship: Sponsorship | null }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [reason, setReason] = useState("")
  useEffect(() => {
    reset()
    setReason("")
  }, [sponsorship, reset])
  return (
    <AdminSheet
      id="revoke-sponsorship"
      open={sponsorship !== null}
      onClose={onClose}
      title="Revoke sponsorship"
      description="The component loses your licences' cover. A published product resting on it drifts: new sales pause until its builder finds cover and publishes a new version. This can't be undone; the builder would have to ask again."
      error={error}
      result={result}
    >
      {sponsorship && (
        <form
          className="flex flex-col gap-3"
          data-revoke-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(`/api/firm/sponsorships/${encodeURIComponent(sponsorship.id)}`, { action: "revoke", reason: reason.trim() })
            if (r?.ok) onDone()
          }}
        >
          <p className="text-sm">
            {sponsorship.product} · {sponsorship.component} · {sponsorship.builder} · {jurisdictionWords(sponsorship.approved)}
          </p>
          <Field label="Reason" hint="The builder sees it, and it's kept in the audit trail">
            <textarea className={`${fieldClass} min-h-20`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} required data-revoke-reason />
          </Field>
          <div>
            <Button type="submit" variant="destructive" disabled={busy || result !== null || reason.trim().length < 3} data-revoke-submit>
              {busy ? "Revoking…" : "Revoke sponsorship"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

// ---- Add party / End party ----

type PartyForm = { kind: "internal" | "external"; name: string; entityId: string; fills: string[]; relationship: string; since: string }
const fillKey = (n: Pick<NeededRole, "licenceId" | "stakeholder">) => `${n.licenceId}|${n.stakeholder}`
const partyFormOf = (role: NeededRole | null): PartyForm => ({ kind: role?.kind ?? "internal", name: "", entityId: "", fills: role ? [fillKey(role)] : [], relationship: "", since: "" })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What's wrong with the form, in words, or null when it can be sent. */
export function partyFormProblem(f: PartyForm): string | null {
  if (f.kind === "internal" && !f.name.trim()) return "Give the person's name."
  if (f.kind === "external" && !f.name.trim() && !f.entityId.trim()) return "Give the other firm's legal name, or its firm id on Mynt."
  if (f.kind === "external" && f.name.trim() && f.entityId.trim()) return "Give the other firm's legal name or its firm id, not both."
  if (f.entityId.trim() && !UUID.test(f.entityId.trim())) return "A firm id looks like 123e4567-e89b-42d3-a456-426614174000."
  if (f.relationship.trim() && !/^[a-z][a-z0-9_]*$/.test(f.relationship.trim())) return "The relationship is a lowercase code, like collection_agency_agreement."
  if (f.since && !DATE.test(f.since)) return "Dates are YYYY-MM-DD."
  return null
}

export function AddPartySheet({ open, needed, role = null, onClose, onDone, fetcher }: SheetProps & { open: boolean; needed: NeededRole[]; role?: NeededRole | null }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [f, setF] = useState<PartyForm>(() => partyFormOf(role))
  const [invalid, setInvalid] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    reset()
    setInvalid(null)
    setF(partyFormOf(role))
  }, [open, role, reset])
  const set = (patch: Partial<PartyForm>) => setF((x) => ({ ...x, ...patch }))
  const roles = needed.filter((n) => n.kind === f.kind)
  return (
    <AdminSheet
      id="add-party"
      open={open}
      onClose={onClose}
      title="Add party"
      description="Who fills a role at your firm: a person in it, or another firm. Each licence type names the roles its holder must fill; a gap blocks publishing the products you sponsor. Parties aren't edited: end one and add the new one."
      error={invalid ?? error}
      result={result}
    >
      <form
        className="flex flex-col gap-3"
        data-add-party-form
        onSubmit={async (e) => {
          e.preventDefault()
          const problem = partyFormProblem(f)
          if (problem) return setInvalid(problem)
          setInvalid(null)
          const fills = roles.filter((n) => f.fills.includes(fillKey(n))).map((n) => ({ licence_id: n.licenceId, stakeholder: n.stakeholder }))
          const r = await run("/api/firm/parties", {
            kind: f.kind,
            ...(f.kind === "internal" ? { person: { name: f.name.trim() } } : f.entityId.trim() ? { legal_entity_id: f.entityId.trim() } : { new_legal_entity: { name: f.name.trim() } }),
            fills,
            ...(f.relationship.trim() ? { relationship: f.relationship.trim() } : {}),
            ...(f.since ? { since: f.since } : {}),
          })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Kind">
          <select className={fieldClass} value={f.kind} onChange={(e) => set({ kind: e.target.value === "external" ? "external" : "internal", fills: [] })} data-party-kind>
            <option value="internal">A person in your firm</option>
            <option value="external">Another firm</option>
          </select>
        </Field>
        <Field label={f.kind === "internal" ? "Person's name" : "Other firm's legal name"}>
          <Input value={f.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} data-party-name />
        </Field>
        {f.kind === "external" && (
          <Field label="Or its firm id on Mynt" hint="When the other firm is already on Mynt">
            <Input value={f.entityId} onChange={(e) => set({ entityId: e.target.value })} maxLength={36} spellCheck={false} data-party-entity />
          </Field>
        )}
        <fieldset className="flex flex-col gap-1 text-sm" data-party-fills>
          <legend className="mb-1">Required roles it fills</legend>
          {roles.length ? (
            roles.map((n) => (
              <label key={fillKey(n)} className="flex items-center gap-2">
                <input type="checkbox" checked={f.fills.includes(fillKey(n))} onChange={(e) => set({ fills: e.target.checked ? [...f.fills, fillKey(n)] : f.fills.filter((x) => x !== fillKey(n)) })} data-party-fill={fillKey(n)} />
                {n.name} · {n.licenceType}
              </label>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">No required role for {f.kind === "internal" ? "a person" : "another firm"} is unfilled. You can still add a counterparty.</span>
          )}
        </fieldset>
        <Field label="Relationship (optional)" hint="For counterparties: a lowercase code, like collection_agency_agreement">
          <Input value={f.relationship} onChange={(e) => set({ relationship: e.target.value })} maxLength={80} spellCheck={false} data-party-relationship />
        </Field>
        <Field label="Since (optional)">
          <Input type="date" value={f.since} onChange={(e) => set({ since: e.target.value })} data-party-since />
        </Field>
        <div>
          <Button type="submit" disabled={busy || result !== null} data-add-party-submit>
            {busy ? "Adding…" : "Add party"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

export function EndPartySheet({ party, onClose, onDone, fetcher }: SheetProps & { party: RosterRow | null }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [until, setUntil] = useState(today)
  useEffect(() => {
    reset()
    setUntil(today())
  }, [party, reset])
  return (
    <AdminSheet
      id="end-party"
      open={party !== null}
      onClose={onClose}
      title="End party"
      description="Record that this party no longer fills its role at your firm. Published products bound to it drift and pause new sales until a new version is published. To change a party, end it and add the new one."
      error={error}
      result={result}
    >
      {party?.partyId && (
        <form
          className="flex flex-col gap-3"
          data-end-party-form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await run(`/api/firm/parties/${encodeURIComponent(party.partyId!)}`, DATE.test(until) ? { until } : {})
            if (r?.ok) onDone()
          }}
        >
          <p className="text-sm">
            {party.name}
            {party.roles.length ? ` · ${party.roles.join("; ")}` : ""}
          </p>
          <Field label="Until" hint="Today unless you say another day">
            <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} data-end-party-until />
          </Field>
          <div>
            <Button type="submit" variant="destructive" disabled={busy || result !== null} data-end-party-submit>
              {busy ? "Ending…" : "End party"}
            </Button>
          </div>
        </form>
      )}
    </AdminSheet>
  )
}

// ---- Decide: a member waiting to be accepted ----

export function DecideMemberSheet({ person, onClose, onDone, fetcher }: SheetProps & { person: FirmPerson | null }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  useEffect(() => reset(), [person, reset])
  const decide = async (accept: boolean) => {
    if (!person?.requestId) return
    const r = await run(`/api/firm/members/${encodeURIComponent(person.requestId)}`, { accept })
    if (r?.ok) onDone()
  }
  return (
    <AdminSheet
      id="decide-member"
      open={person !== null}
      onClose={onClose}
      title="Decide"
      description="Mynt added this account to your firm as a licence provider. Until one of your firm's existing licence providers accepts it, it can do nothing for your firm. Accept only someone you know belongs here; declining ends the request."
      error={error}
      result={result}
    >
      {person && (
        <div className="flex flex-col gap-3" data-decide-member={person.requestId ?? ""}>
          <p className="text-sm">
            {person.email ?? "An account"} · waiting since {person.since ? person.since.slice(0, 10) : "an unknown date"}
          </p>
          {person.adminRecovery && (
            <p className="text-sm text-muted-foreground" data-decide-recovery>
              A Mynt admin has started a recovery of this request. Deciding it here settles it.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || result !== null} onClick={() => void decide(true)} data-decide-accept>
              {busy ? "Saving…" : "Accept member"}
            </Button>
            <Button variant="outline" disabled={busy || result !== null} onClick={() => void decide(false)} data-decide-decline>
              Decline member
            </Button>
          </div>
        </div>
      )}
    </AdminSheet>
  )
}
