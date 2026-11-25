"use client"

// Admin → Regulated firms (the section's name on screen; its address stays /platform/firms), with two tabs in the
// page's body (/platform/firms?tab=firms, the default, or ?tab=licences):
// - Regulated firms: every firm registered on Mynt (list_entities), each a licence provider, a vendor, a liquidity provider or an
//   innovator by its members' roles, with how many of its licences wait for review. Firms are added by hand by Mynt's
//   admins: Register regulated firm (register_firm) adds one with no members. A vendor-only firm is listed too, its
//   type in words (Vendors → Vendor firms has their onboarding).
// - Licences: every firm's licences and their review (components/admin-licences.tsx; it was a section of its own).
// A row's Open shows the firm: its metadata card with Invite member (an
// email allowed to sign in with the roles picked, invite_user, then added to the firm, add_entity_member) and Set firm
// status (set_entity_status), then Members (each with Change role and Remove: components/admin-members.tsx), Licences
// (each with Verify licence, Reject licence or Suspend licence, as the Licences tab has them),
// Offerings and Products (the firm's products, owned or sponsored: the platform admin has no products list of its own;
// /platform/firms/<id>?tab=products opens it), Onboarding (a regulated firm's checklist towards sponsoring) and Checks
// (every answer the public registers gave about it), each a table. The metadata card says where the real-company check
// stands (its latest result, when, the rule and what's missing), with Run checks (run_firm_checks). The list's
// Onboarding column says how far each regulated firm is ("5 of 7 steps done", and the next step). What a firm keeps to
// itself (its encrypted health books, its signatures) isn't here: admins can't read or co-sign them. Server-renderable.
import { useCallback, useEffect, useMemo, useState } from "react"
import { Building2, SearchCheck, ShieldAlert, UserPlus } from "lucide-react"

import { LicenceActions, LicencesTab, LicenceStatus, ReviewLicenceSheet, type Decision } from "@/components/admin-licences"
import { FirmMembersTable, InviteFirmMemberSheet } from "@/components/admin-members"
import { AdminDetail, AdminList, AdminNotReady, AdminSheet, AdminTable, Field, fieldClass, useAdminAction, useAdminData } from "@/components/admin-kit"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { StageMark, StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tab, TabList } from "@/components/ui/tabs"
import { conformanceWords, csvOf, dateOf, firmOnboardingWords, FIRM_TYPE_LABELS, FIRM_TYPES, FIRMS_TAB_LABELS, FIRMS_TABS, NOT_AVAILABLE, words, type AdminLicence, type AdminOffering, type AdminProduct, type Firm, type FirmsTab } from "@/lib/admin"
import { STEP_STATUS_WORDS, type Onboarding, type RealCompanyCheck } from "@/lib/firm-area"
import type { Stage } from "@/lib/workspaces"

const typesOf = (f: Firm) => f.types.map((t) => FIRM_TYPE_LABELS[t]).join(", ") || "No members yet"
export const LEGAL_FORMS = ["company_private", "company_public", "llp", "partnership", "sole_proprietorship", "trust", "cooperative", "society", "nonprofit_company", "statutory_corporation", "government_entity", "foreign_branch"] as const
// Licences waiting for review, as the list shows it: the number Mynt counted, or "Not available" when it gave none (never 0).
export const awaitingReviewWords = (f: Pick<Firm, "awaitingReview">) => (typeof f.awaitingReview === "number" ? String(f.awaitingReview) : NOT_AVAILABLE)
export function FirmStatus({ status }: { status: string }) {
  return <StatusDot tone={status === "active" ? "green" : status === "suspended" ? "amber" : "red"} label={words(status)} data-firm-status={status} />
}

/** Register regulated firm: a legal entity added by hand, with no members yet. */
export function RegisterFirmSheet({ open, onClose, onDone, fetcher }: { open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [name, setName] = useState("")
  const [legalForm, setLegalForm] = useState("")
  const [country, setCountry] = useState("us")
  const [regions, setRegions] = useState("US")
  const [lei, setLei] = useState("")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  return (
    <AdminSheet id="register-firm" open={open} onClose={onClose} title="Register regulated firm" description="Adds a firm to Mynt by hand, with no members yet. Invite its people next, from the firm's page." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-register-firm-form
        onSubmit={async (e) => {
          e.preventDefault()
          const body = {
            name: name.trim(),
            ...(legalForm ? { legal_form: legalForm } : {}),
            ...(country.trim() ? { incorporation: { country: country.trim().toLowerCase() } } : {}),
            regions: regions.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean).map((r) => (r.toLowerCase() === "global" ? "global" : r.toUpperCase())),
            ...(lei.trim() ? { identifiers: [{ scheme: "lei", value: lei.trim() }] } : {}),
          }
          const r = await run("/api/admin/firms", body)
          if (r?.ok) onDone()
        }}
      >
        <Field label="Legal name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required data-firm-name />
        </Field>
        <Field label="Legal form">
          <select className={fieldClass} value={legalForm} onChange={(e) => setLegalForm(e.target.value)} data-firm-legal-form>
            <option value="">Not recorded</option>
            {LEGAL_FORMS.map((f) => (
              <option key={f} value={f}>
                {words(f)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Country of incorporation" hint="Two letters, e.g. us">
          <Input value={country} onChange={(e) => setCountry(e.target.value)} maxLength={2} data-firm-country />
        </Field>
        <Field label="Regions it operates in" hint="Country codes or global, separated by commas">
          <Input value={regions} onChange={(e) => setRegions(e.target.value)} maxLength={200} data-firm-regions />
        </Field>
        <Field label="LEI (optional)" hint="Mynt checks it against GLEIF's public record">
          <Input value={lei} onChange={(e) => setLei(e.target.value)} maxLength={100} data-firm-lei />
        </Field>
        <div>
          <Button type="submit" disabled={busy || !name.trim()} data-register-firm-submit>
            {busy ? "Registering…" : "Register regulated firm"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

const ENTITY_STATUSES = ["active", "suspended", "under_liquidation", "dissolved", "struck_off"] as const

/** Set firm status: from its company registry, with a note. Products resting on it are re-checked. */
export function FirmStatusSheet({ firm, open, onClose, onDone, fetcher }: { firm: Firm; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  const [status, setStatus] = useState(firm.status)
  const [note, setNote] = useState("")
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  return (
    <AdminSheet id="firm-status" open={open} onClose={onClose} title="Set firm status" description="Record the firm's status from its company registry. Every published product resting on it is re-checked; drifted ones pause new sales." error={error} result={result}>
      <form
        className="flex flex-col gap-3"
        data-firm-status-form
        onSubmit={async (e) => {
          e.preventDefault()
          const r = await run(`/api/admin/firms/${encodeURIComponent(firm.id)}/status`, { status, note: note.trim() })
          if (r?.ok) onDone()
        }}
      >
        <Field label="Status">
          <select className={fieldClass} value={status} onChange={(e) => setStatus(e.target.value)} data-firm-status-select>
            {ENTITY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {words(s)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Note: where this comes from">
          <textarea className={`${fieldClass} min-h-20`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} required data-firm-status-note />
        </Field>
        <div>
          <Button type="submit" disabled={busy || note.trim().length < 3} data-firm-status-submit>
            {busy ? "Saving…" : "Set firm status"}
          </Button>
        </div>
      </form>
    </AdminSheet>
  )
}

export function FirmsListView({ firms, onOpen, onChanged = () => undefined, sheetOpen = false }: { firms: Firm[]; onOpen: (id: string) => void; onChanged?: () => void; sheetOpen?: boolean }) {
  const [query, setQuery] = useState("")
  const [type, setType] = useState<string[]>([])
  const [status, setStatus] = useState<string[]>([])
  const [registering, setRegistering] = useState(sheetOpen)
  // The list is read again once the sheet closes, so its answer stays on screen until then.
  const [dirty, setDirty] = useState(false)
  const shown = useMemo(
    () =>
      firms.filter(
        (f) =>
          matches(query, f.name, f.id, ...f.members.map((m) => m.email)) &&
          (!type.length || type.some((t) => (t === "none" ? !f.types.length : f.types.includes(t as Firm["types"][number])))) &&
          (!status.length || status.includes(f.status)),
      ),
    [firms, query, type, status],
  )
  const { page, pages, shown: onPage, setPage } = usePaged(shown)
  const exportCsv = () =>
    downloadCsv("regulated-firms.csv", csvOf(["Firm", "Type", "Status", "Onboarding", "Members", "Licences", "Awaiting review", "Country", "Created", "Id"], shown.map((f) => [f.name, typesOf(f), f.status, firmOnboardingWords(f), f.members.length, f.licences.length, awaitingReviewWords(f), f.country ?? "", dateOf(f.createdAt), f.id])))
  return (
    <>
      <AdminList
        id="firms"
        search={query}
        onSearch={(q) => (setQuery(q), setPage(1))}
        searchLabel="Search regulated firms by name, member email or id"
        facets={[
          { id: "type", label: "Type", options: [...FIRM_TYPES.map((t) => ({ value: t, label: FIRM_TYPE_LABELS[t] })), { value: "none", label: "No members yet" }], selected: type, onChange: (v) => (setType(v), setPage(1)) },
          { id: "status", label: "Status", options: ENTITY_STATUSES.map((s) => ({ value: s, label: words(s) })), selected: status, onChange: (v) => (setStatus(v), setPage(1)) },
        ]}
        onClearFilters={() => (setType([]), setStatus([]))}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        cta={
          <Button onClick={() => setRegistering(true)} data-register-firm>
            <Building2 />
            Register regulated firm
          </Button>
        }
        page={page}
        pages={pages}
        total={shown.length}
        onPage={setPage}
      >
        <AdminTable
          head={["Firm", "Type", "Status", "Onboarding", "Members", "Licences", "Awaiting review", "Country", "Created", ""]}
          rowKeys={onPage.map((f) => f.id)}
          rows={onPage.map((f) => [
            f.name,
            typesOf(f),
            <FirmStatus key="s" status={f.status} />,
            <span key="o" data-firm-onboarding={f.id}>
              {firmOnboardingWords(f)}
            </span>,
            String(f.members.length),
            String(f.licences.length),
            <span key="w" data-awaiting-review={f.id}>
              {awaitingReviewWords(f)}
            </span>,
            f.country?.toUpperCase() ?? "—",
            dateOf(f.createdAt),
            <Button key="o" size="sm" variant="outline" onClick={() => onOpen(f.id)} data-open-firm={f.id}>
              Open
            </Button>,
          ])}
          empty={firms.length ? "No regulated firms match these filters." : "No regulated firms yet. Register the first one."}
        />
      </AdminList>
      <RegisterFirmSheet
        open={registering}
        onClose={() => {
          setRegistering(false)
          if (dirty) onChanged()
        }}
        onDone={() => setDirty(true)}
      />
    </>
  )
}

export type FirmDetailTab = "members" | "licences" | "offerings" | "products" | "onboarding" | "checks"
type DetailTab = FirmDetailTab
export const FIRM_DETAIL_TABS: readonly FirmDetailTab[] = ["members", "licences", "offerings", "products", "onboarding", "checks"]
const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "members", label: "Members" },
  { id: "licences", label: "Licences" },
  { id: "offerings", label: "Offerings" },
  { id: "products", label: "Products" },
  { id: "onboarding", label: "Onboarding" },
  { id: "checks", label: "Checks" },
]
// onboarding: the firm's checklist towards sponsoring, with its real-company check (null on a Mynt without it).
export type FirmDetail = { firm: Firm; offerings: AdminOffering[] | null; products: AdminProduct[] | null; onboarding?: Onboarding | null }

/** The real-company check's latest result, in a few words (never colour alone; never a pass Mynt didn't measure). */
export function checkResultWords(c: RealCompanyCheck | null | undefined): string {
  if (!c) return NOT_AVAILABLE
  if (c.passes === true) return "Passed"
  if (c.passes === null) return c.status === "done" ? "Not required on this Mynt" : NOT_AVAILABLE
  if (!c.lastRunAt) return "Not run yet"
  if (!c.lastAnswerAt) return "Not known: the registers couldn't be reached"
  return "Not passed"
}
/** What the firm still lacks for the check, in Mynt's words; "Nothing" once it passes. */
export const checkMissingWords = (c: RealCompanyCheck | null | undefined) => (!c ? NOT_AVAILABLE : c.passes !== false ? "Nothing" : c.reasons.join("; ") || "Mynt didn't say")

/** Run checks: Mynt asks the public registers about the firm now. */
export function RunChecksSheet({ firm, check, open, onClose, onDone, fetcher }: { firm: Firm; check: RealCompanyCheck | null; open: boolean; onClose: () => void; onDone: () => void; fetcher?: typeof fetch }) {
  const { busy, error, result, run, reset } = useAdminAction(fetcher)
  useEffect(() => {
    if (open) reset()
  }, [open, reset])
  return (
    <AdminSheet
      id="run-checks"
      open={open}
      onClose={onClose}
      title="Run checks"
      description="Mynt asks the public registers about this firm now: GLEIF's record of its LEI and FinCEN's MSB registrant list. Each answer is kept. A licence provider sponsors only once it passes; a mismatch or lapse drifts the products it sponsors."
      error={error}
      result={result}
    >
      <div className="flex flex-col gap-3" data-run-checks-form>
        <p className="text-sm">{firm.name}</p>
        {check?.ruleText && (
          <p className="text-sm text-muted-foreground" data-run-checks-rule>
            The rule: {check.ruleText}.
          </p>
        )}
        <div>
          <Button
            disabled={busy}
            onClick={async () => {
              const r = await run(`/api/admin/firms/${encodeURIComponent(firm.id)}/checks`, {})
              if (r?.ok) onDone()
            }}
            data-run-checks-submit
          >
            {busy ? "Asking the registers…" : result ? "Run checks again" : "Run checks"}
          </Button>
        </div>
      </div>
    </AdminSheet>
  )
}

export function FirmDetailView({ detail, onBack, onChanged = () => undefined, initialTab = "members", sheet = null, fetcher }: { detail: FirmDetail; onBack: () => void; onChanged?: () => void; initialTab?: DetailTab; sheet?: "invite" | "status" | "checks" | null; fetcher?: typeof fetch }) {
  const [tab, setTab] = useState<DetailTab>(initialTab)
  const [open, setOpen] = useState<"invite" | "status" | "checks" | null>(sheet)
  // The licence under review and what was picked for it (Verify licence, Reject licence or Suspend licence).
  const [reviewing, setReviewing] = useState<{ licence: AdminLicence; decision: Decision } | null>(null)
  const [dirty, setDirty] = useState(false)
  const close = () => {
    setOpen(null)
    setReviewing(null)
    if (dirty) onChanged()
  }
  const f = detail.firm
  const onboarding = detail.onboarding ?? null
  const check = onboarding?.check ?? null
  const full = (text: string) => (
    <span title={text} className="block truncate">
      {text}
    </span>
  )
  return (
    <>
      <AdminDetail
        backLabel="Back to regulated firms"
        onBack={onBack}
        title={f.name}
        subtitle={typesOf(f)}
        fields={[
          ["Status", <FirmStatus key="s" status={f.status} />],
          ["Legal form", words(f.legalForm)],
          ["Country", f.country?.toUpperCase() ?? "—"],
          ["Regions", f.regions.join(", ") || "—"],
          ["Members", String(f.members.length)],
          ["Licences", String(f.licences.length)],
          ["Awaiting review", awaitingReviewWords(f)],
          [
            "Real-company check",
            <span key="c" data-real-company-check={check ? (check.passes === true ? "passed" : check.passes === null ? "not_measured" : "not_passed") : "unknown"}>
              {checkResultWords(check)}
            </span>,
          ],
          ["Last checked", check ? (check.lastRunAt ? dateOf(check.lastRunAt) : "Never") : NOT_AVAILABLE],
          ["The rule", full(check?.ruleText ?? NOT_AVAILABLE)],
          ["What's missing", <span key="m" data-check-missing>{full(checkMissingWords(check))}</span>],
          ["Registered", dateOf(f.createdAt)],
          ["Id", <code key="i" className="text-xs">{f.id}</code>],
        ]}
        actions={
          <>
            <Button size="sm" onClick={() => setOpen("invite")} data-invite-member>
              <UserPlus />
              Invite member
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen("status")} data-set-firm-status>
              <ShieldAlert />
              Set firm status
            </Button>
            <Button size="sm" variant="outline" onClick={() => setOpen("checks")} data-run-checks>
              <SearchCheck />
              Run checks
            </Button>
          </>
        }
        tabs={DETAIL_TABS}
        tab={tab}
        onTab={setTab}
      >
        {tab === "members" && (
          <FirmMembersTable firm={f} onChanged={onChanged} />
        )}
        {tab === "licences" && (
          <AdminTable
            head={["Licence", "Regulator", "Region", "Jurisdiction", "Number", "Valid to", "Review", ""]}
            rowKeys={f.licences.map((l) => l.id)}
            rows={f.licences.map((l) => [
              l.licenceType,
              l.regulator,
              l.region,
              l.jurisdiction ?? "—",
              l.number ?? "—",
              dateOf(l.validTo),
              <LicenceStatus key="s" status={l.status} />,
              <LicenceActions key="a" licence={l} onAct={(decision) => setReviewing({ licence: l, decision })} />,
            ])}
            empty="No licences registered."
          />
        )}
        {tab === "offerings" &&
          (detail.offerings === null ? (
            <p className="p-4 text-sm text-muted-foreground">Vendors&apos; offerings aren&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["Offering", "Service", "Region", "Status", "Conformance"]}
              rowKeys={detail.offerings.map((o) => o.id)}
              rows={detail.offerings.map((o) => [o.name, o.serviceName, o.region, words(o.status), conformanceWords(o.conformance)])}
              empty="This firm offers no standard services."
            />
          ))}
        {tab === "products" &&
          (detail.products === null ? (
            <p className="p-4 text-sm text-muted-foreground">The products across firms aren&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["Product", "This firm", "Line", "Region", "Stage", "Status", "Archived", "Sponsors"]}
              rowKeys={detail.products.map((p) => p.id)}
              rows={detail.products.map((p) => {
                const s = p.sponsors.find((x) => x.entityId === f.id)
                return [
                  <span key="n" id={`product-${p.id}`} data-product={p.id}>
                    {p.name}
                  </span>,
                  p.firm?.id === f.id ? "Owns it" : `Sponsors it${s?.status === "pending" ? " (pending)" : ""}`,
                  words(p.productLine),
                  p.region ?? "—",
                  <StageMark key="s" stage={p.stage as Stage} />,
                  words(p.status),
                  p.archived ? "Archived" : "No",
                  p.sponsors.map((x) => (x.status === "pending" ? `${x.name} (pending)` : x.name)).join(", ") || "None",
                ]
              })}
              empty="This firm owns and sponsors no products."
            />
          ))}
        {tab === "onboarding" &&
          (onboarding === null ? (
            <p className="p-4 text-sm text-muted-foreground">Regulated firms&apos; onboarding isn&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["Step", "Status", "Where it stands", "Done by"]}
              rowKeys={onboarding.steps.map((s) => s.key)}
              rows={onboarding.steps.map((s) => [
                s.informational ? `${s.title} (for information)` : s.title,
                <span key="s" data-step-status={s.status}>
                  {STEP_STATUS_WORDS[s.status]}
                </span>,
                <span key="d" className="whitespace-normal">
                  {s.detail}
                </span>,
                s.by === "admin" ? "Mynt" : s.by === "builder" ? "Builders" : "The firm",
              ])}
              empty="Mynt gave no steps for this firm."
            />
          ))}
        {tab === "checks" &&
          (onboarding === null ? (
            <p className="p-4 text-sm text-muted-foreground">The registers&apos; answers aren&apos;t available on this Mynt yet.</p>
          ) : (
            <AdminTable
              head={["When", "Register", "Result", "Note", "Run"]}
              rowKeys={onboarding.checks.map((c) => c.id)}
              rows={onboarding.checks.map((c) => [
                c.at ? c.at.slice(0, 16).replace("T", " ") : "—",
                c.sourceName,
                <span key="r" data-check-result={c.status}>
                  {c.statusWords.charAt(0).toUpperCase() + c.statusWords.slice(1)}
                </span>,
                <span key="n" className="whitespace-normal">
                  {c.note ?? "—"}
                </span>,
                c.scheduled ? "Mynt's monthly re-check" : "By an admin",
              ])}
              empty="No register has been asked about this firm yet. Run checks."
            />
          ))}
      </AdminDetail>
      <RunChecksSheet firm={f} check={check} open={open === "checks"} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
      <InviteFirmMemberSheet firm={f} open={open === "invite"} onClose={close} onDone={() => setDirty(true)} />
      <FirmStatusSheet firm={f} open={open === "status"} onClose={close} onDone={() => setDirty(true)} />
      <ReviewLicenceSheet licence={reviewing?.licence ?? null} decision={reviewing?.decision ?? null} onClose={close} onDone={() => setDirty(true)} fetcher={fetcher} />
    </>
  )
}

/** The section's tab bar, in the page's body: Regulated firms (the list) and Licences (every firm's licences, for review). */
export function FirmsTabs({ tab, onTab }: { tab: FirmsTab; onTab: (t: FirmsTab) => void }) {
  return (
    <TabList aria-label="Regulated firms">
      {FIRMS_TABS.map((t) => (
        <Tab key={t} selected={tab === t} onClick={() => onTab(t)} data-firms-tab={t}>
          {FIRMS_TAB_LABELS[t]}
        </Tab>
      ))}
    </TabList>
  )
}

export function FirmsTab({
  id,
  onOpen,
  onBack,
  initialTab,
  tab = "firms",
  onTab = () => undefined,
}: {
  id: string | null
  onOpen: (id: string) => void
  onBack: () => void
  initialTab?: FirmDetailTab // a firm's page: the tab it opens on
  tab?: FirmsTab // the section's page: Firms or Licences
  onTab?: (t: FirmsTab) => void
}) {
  const pickList = useCallback((b: Record<string, unknown>) => (Array.isArray(b.firms) ? (b.firms as Firm[]) : undefined), [])
  const pickOne = useCallback((b: Record<string, unknown>) => (b.firm ? ({ firm: b.firm, offerings: b.offerings ?? null, products: b.products ?? null, onboarding: b.onboarding ?? null } as FirmDetail) : undefined), [])
  // Only what's on screen is read: the firms list on the Firms tab, the licences on theirs (LicencesTab reads them).
  const list = useAdminData(id || tab !== "firms" ? null : "/api/admin/firms", pickList)
  const one = useAdminData(id ? `/api/admin/firms/${encodeURIComponent(id)}` : null, pickOne)
  if (id) return one.state.kind === "ready" ? <FirmDetailView detail={one.state.data} onBack={onBack} onChanged={one.reload} initialTab={initialTab} /> : <AdminNotReady state={one.state} what="This firm" />
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-admin-firms data-view={tab}>
      <FirmsTabs tab={tab} onTab={onTab} />
      {tab === "licences" ? <LicencesTab /> : list.state.kind === "ready" ? <FirmsListView firms={list.state.data} onOpen={onOpen} onChanged={list.reload} /> : <AdminNotReady state={list.state} what="Regulated firms" />}
    </div>
  )
}
