"use client"

// My firm (/firm): a regulated firm's own area, for accounts Mynt granted the licence-provider role. On top, the firm's
// card (its facts, the real-company check's latest result in words, Set firm facts), then the onboarding checklist
// (get_regulated_firm_onboarding): every step's status in words with a mark (never colour alone), what it waits on, and
// a labelled button where the studio can do it; steps only Mynt can do say what they wait for. Then tabs, each a table
// in the list layout (full-width search, labelled Import and Export CSV, the tab's own call to action, a full-height
// table paged 25 rows at a time): Licences, Sponsorship requests, Sponsored products, Roster, People and Notices. Tabs
// only show; every change is a labelled button opening a sheet (components/firm-sheets.tsx). Server-renderable.
import { useCallback, useMemo, useState } from "react"
import { BadgeCheck, CheckCircle2, Circle, CircleDot, ClipboardCheck, FilePlus2, PauseCircle, PencilLine, ShieldOff, UserCheck, UserMinus, UserPlus } from "lucide-react"

import { AdminList, AdminNotReady, AdminTable, useAdminData } from "@/components/admin-kit"
import { AddPartySheet, DecideMemberSheet, EndPartySheet, FirmFactsSheet, RegisterLicenceSheet, ReviewRequestSheet, RevokeSponsorshipSheet } from "@/components/firm-sheets"
import { downloadCsv } from "@/components/licences-view"
import { matches, usePaged } from "@/components/list-layout"
import { Button } from "@/components/ui/button"
import { Tab, TabList } from "@/components/ui/tabs"
import {
  checkLine,
  coversWords,
  FIRM_TABS,
  jurisdictionWords,
  licencesCsv,
  licenceStatusWords,
  noticesCsv,
  peopleCsv,
  peopleOf,
  PERSON_STATUS_WORDS,
  productStateWords,
  progressWords,
  rosterCsv,
  sponsoredCsv,
  sponsorshipsCsv,
  sponsorshipStatusWords,
  STEP_ACTION_LABELS,
  STEP_STATUS_WORDS,
  stepAction,
  type Firm,
  type FirmLicence,
  type FirmPerson,
  type FirmTab,
  type LicenceTypeOption,
  type NeededRole,
  type Notice,
  type Onboarding,
  type RosterRow,
  type Sponsorship,
  type Step,
  type StepAction,
  type StepStatus,
} from "@/lib/firm-area"

// A part Mynt didn't answer is null: its tab says so, never an empty list.
export type FirmData = { onboarding: Onboarding; firm: Firm | null; licences: FirmLicence[] | null; requests: Sponsorship[] | null; sponsored: Sponsorship[] | null; licenceTypes: LicenceTypeOption[] }

const STATUS_ICON: Record<StepStatus, typeof Circle> = { done: CheckCircle2, next: CircleDot, not_started: Circle, blocked: PauseCircle }
const STATUS_TONE: Record<StepStatus, string> = { done: "text-emerald-600", next: "text-sky-600", not_started: "text-muted-foreground", blocked: "text-amber-600" }
const ACTION_ICON: Record<StepAction, typeof Circle> = { facts: PencilLine, licence: FilePlus2, party: UserPlus, review: ClipboardCheck }
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—")
const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") : "—")

/** A step's status: a mark and its words, never colour alone. */
export function StepStatusMark({ status }: { status: StepStatus }) {
  const Icon = STATUS_ICON[status]
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-medium ${STATUS_TONE[status]}`} data-step-status={status}>
      <Icon aria-hidden className="size-4" />
      {STEP_STATUS_WORDS[status]}
    </span>
  )
}

function StepRow({ step, onAction }: { step: Step; onAction?: (a: StepAction) => void }) {
  const action = stepAction(step)
  const Icon = action ? ACTION_ICON[action] : null
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2" data-step={step.key} data-step-state={step.status}>
      <div className="w-28 pt-0.5">
        <StepStatusMark status={step.status} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {step.title}
          {step.informational && <span className="ml-2 text-xs font-normal text-muted-foreground">(for information)</span>}
        </p>
        <p className="text-sm text-muted-foreground" data-step-detail>
          {step.detail}
        </p>
      </div>
      {action && Icon && onAction && (
        <Button size="sm" variant={step.status === "next" ? "default" : "outline"} onClick={() => onAction(action)} data-step-action={action}>
          <Icon />
          {STEP_ACTION_LABELS[action]}
        </Button>
      )}
    </li>
  )
}

/** The onboarding checklist card. */
export function FirmChecklist({ onboarding, onAction }: { onboarding: Onboarding; onAction?: (a: StepAction) => void }) {
  const p = onboarding.progress
  return (
    <section className="flex flex-col gap-2 rounded-xl border bg-card p-4" data-onboarding-card data-complete={p.complete}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold">Getting ready to sponsor</h2>
        <p className="text-sm text-muted-foreground" data-onboarding-progress>
          {progressWords(p)}
          {p.next ? ` · Next: ${p.next.title}${p.next.status === "blocked" ? " (waiting)" : ""}` : ""}
        </p>
      </div>
      <ol className="divide-y" data-checklist="firm">
        {onboarding.steps.map((s) => (
          <StepRow key={s.key} step={s} onAction={onAction} />
        ))}
      </ol>
    </section>
  )
}

/** The firm's card: what it is on Mynt, the real-company check's latest result, and Set firm facts. */
export function FirmCard({ data, onFacts }: { data: FirmData; onFacts?: () => void }) {
  const { onboarding, firm } = data
  const check = onboarding.check
  const id = (scheme: string) => firm?.identifiers.find((i) => i.scheme === scheme)?.value ?? "Not recorded"
  const fields: [string, React.ReactNode][] = firm
    ? [
        ["Status", firm.status.replace(/_/g, " ")],
        ["Regions", firm.regions.join(", ") || "—"],
        ["LEI", id("lei")],
        ["FinCEN MSB registration", id("us_fincen_msb")],
        ["NMLS ID", id("us_nmls")],
        ["Can sponsor now", onboarding.readyToSponsor ? "Yes" : "Not yet"],
        [
          "Firm id (share it with builders)",
          <code key="i" className="text-xs">
            {firm.id}
          </code>,
        ],
      ]
    : []
  return (
    <section className="flex flex-col gap-3 rounded-xl border bg-card p-4" data-firm-card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold">{onboarding.entity?.name ?? "Your firm"}</h2>
          <p className="text-sm text-muted-foreground">{onboarding.entity ? "A regulated firm on Mynt: it sponsors builders' products under its licences." : "Mynt hasn't added you to your firm yet."}</p>
        </div>
        {firm && onFacts && (
          <Button size="sm" variant="outline" onClick={onFacts} data-set-firm-facts>
            <PencilLine />
            Set firm facts
          </Button>
        )}
      </div>
      {fields.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          {fields.map(([label, value]) => (
            <div key={label} className="flex min-w-0 flex-col">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="truncate">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {onboarding.entity && (
        <p className="flex flex-wrap items-start gap-2 text-sm" data-real-company-check={check ? (check.passes === true ? "passed" : check.passes === null ? "not_measured" : "not_passed") : "unknown"}>
          {check && <StepStatusMark status={check.status} />}
          <span className="min-w-0 flex-1">
            {checkLine(check)}
            {check?.lastRunAt ? ` Last asked ${day(check.lastRunAt)}.` : ""}
          </span>
        </p>
      )}
    </section>
  )
}

type SheetState =
  | { kind: "facts" }
  | { kind: "licence" }
  | { kind: "party"; role: NeededRole | null }
  | { kind: "review"; request: Sponsorship }
  | { kind: "revoke"; sponsorship: Sponsorship }
  | { kind: "end"; party: RosterRow }
  | { kind: "decide"; person: FirmPerson }
  | null

const unknown = (what: string) => (
  <p className="p-4 text-sm text-muted-foreground" data-tab-unknown>
    Mynt didn&apos;t say {what} just now. Please try again.
  </p>
)

export function FirmView({
  data,
  onChanged = () => undefined,
  initialTab = "licences",
  initialSheet = null,
  notices,
  fetcher,
}: {
  data: FirmData
  onChanged?: () => void
  initialTab?: FirmTab
  initialSheet?: SheetState
  notices?: Notice[] | null // given by the tests; the page reads them when the tab opens
  fetcher?: typeof fetch
}) {
  const [tab, setTab] = useState<FirmTab>(initialTab)
  const [query, setQuery] = useState("")
  const [sheet, setSheet] = useState<SheetState>(initialSheet)
  const [dirty, setDirty] = useState(false)
  const { onboarding, firm } = data
  const hasFirm = onboarding.entity !== null
  const people = useMemo(() => peopleOf(firm, onboarding), [firm, onboarding])
  const pickNotices = useCallback((b: Record<string, unknown>) => (Array.isArray(b.notices) ? (b.notices as Notice[]) : undefined), [])
  const loadedNotices = useAdminData(tab === "notices" && notices === undefined && hasFirm ? "/api/firm/notices" : null, pickNotices)
  const close = () => {
    setSheet(null)
    if (dirty) onChanged()
    setDirty(false)
  }
  const done = () => setDirty(true)
  const pick = (t: FirmTab) => {
    setTab(t)
    setQuery("")
    if (typeof window !== "undefined") window.history.replaceState(null, "", t === "licences" ? "/firm" : `/firm?tab=${t}`)
  }
  const act = (a: StepAction) => {
    if (a === "facts") return setSheet({ kind: "facts" })
    if (a === "licence") return setSheet({ kind: "licence" })
    if (a === "party") return setSheet({ kind: "party", role: firm?.needed[0] ?? null })
    const first = data.requests?.[0]
    if (first) setSheet({ kind: "review", request: first })
    else pick("requests")
  }

  // Each tab's rows, filtered by the search.
  const licences = useMemo(() => (data.licences ?? []).filter((l) => matches(query, l.licenceType, l.regulator, l.region, l.jurisdiction, l.number, licenceStatusWords(l))), [data.licences, query])
  // Requests waiting come first, then what's approved (each can be revoked).
  const requests = useMemo(() => [...(data.requests ?? []), ...(data.sponsored ?? [])].filter((s) => matches(query, s.product, s.component, s.builder, sponsorshipStatusWords(s.status), ...s.asked, ...s.approved)), [data.requests, data.sponsored, query])
  const sponsored = useMemo(() => (data.sponsored ?? []).filter((s) => matches(query, s.product, s.component, s.builder, productStateWords(s), ...s.approved)), [data.sponsored, query])
  const roster = useMemo(() => (firm?.roster ?? []).filter((r) => matches(query, r.name, r.relationship, ...r.roles)), [firm, query])
  const shownPeople = useMemo(() => people.filter((p) => matches(query, p.name, p.email, PERSON_STATUS_WORDS[p.status])), [people, query])
  const noticeRows = notices ?? (loadedNotices.state.kind === "ready" ? loadedNotices.state.data : null)
  const shownNotices = useMemo(() => (noticeRows ?? []).filter((n) => matches(query, n.what, n.details)), [noticeRows, query])

  const pagedLicences = usePaged(licences)
  const pagedRequests = usePaged(requests)
  const pagedSponsored = usePaged(sponsored)
  const pagedRoster = usePaged(roster)
  const pagedPeople = usePaged(shownPeople)
  const pagedNotices = usePaged(shownNotices)

  const list = {
    licences: { search: "Search your licences by type, regulator, number or status", paged: pagedLicences, total: licences.length, csv: () => downloadCsv("firm-licences.csv", licencesCsv(licences)) },
    requests: { search: "Search sponsorship requests by product, builder, state or status", paged: pagedRequests, total: requests.length, csv: () => downloadCsv("sponsorship-requests.csv", sponsorshipsCsv(requests)) },
    sponsored: { search: "Search sponsored products by product, builder or state", paged: pagedSponsored, total: sponsored.length, csv: () => downloadCsv("sponsored-products.csv", sponsoredCsv(sponsored)) },
    roster: { search: "Search your roster by name, role or relationship", paged: pagedRoster, total: roster.length, csv: () => downloadCsv("firm-roster.csv", rosterCsv(roster)) },
    people: { search: "Search your firm's people by name, email or status", paged: pagedPeople, total: shownPeople.length, csv: () => downloadCsv("firm-people.csv", peopleCsv(shownPeople)) },
    notices: { search: "Search notices", paged: pagedNotices, total: shownNotices.length, csv: () => downloadCsv("firm-notices.csv", noticesCsv(shownNotices)) },
  }[tab]

  // Each tab's own call to action names what it adds; the read-only tabs have none.
  const cta =
    tab === "licences" ? (
      <Button onClick={() => setSheet({ kind: "licence" })} disabled={!hasFirm} data-register-licence>
        <FilePlus2 />
        Register licence
      </Button>
    ) : tab === "roster" ? (
      <Button onClick={() => setSheet({ kind: "party", role: null })} disabled={!hasFirm} data-add-party>
        <UserPlus />
        Add party
      </Button>
    ) : undefined

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4" data-firm-area>
      <FirmCard data={data} onFacts={() => setSheet({ kind: "facts" })} />
      <FirmChecklist onboarding={onboarding} onAction={act} />
      <TabList aria-label="My firm">
        {FIRM_TABS.map((t) => (
          <Tab key={t.id} selected={tab === t.id} onClick={() => pick(t.id)} data-firm-tab={t.id}>
            {t.label}
          </Tab>
        ))}
      </TabList>
      <AdminList id={`firm-${tab}`} search={query} onSearch={(q) => (setQuery(q), list.paged.setPage(1))} searchLabel={list.search} onExport={list.csv} exportDisabled={!list.total} cta={cta} page={list.paged.page} pages={list.paged.pages} total={list.total} onPage={list.paged.setPage}>
        {tab === "licences" &&
          (data.licences === null ? (
            unknown("which licences your firm holds")
          ) : (
            <AdminTable
              head={["Licence", "Regulator", "Region", "Issued for", "Number", "Valid from", "Valid to", "Status", "Covers", "Sponsorships"]}
              rowKeys={pagedLicences.shown.map((l) => l.id)}
              rows={pagedLicences.shown.map((l) => [
                l.licenceType,
                l.regulator,
                l.region,
                l.jurisdiction?.toUpperCase() ?? "—",
                l.number,
                l.validFrom ?? "—",
                l.validTo ?? "—",
                <span key="s" className="inline-flex items-center gap-1.5" data-licence-status={l.status}>
                  {l.inForce ? <BadgeCheck aria-hidden className="size-4" /> : null}
                  {licenceStatusWords(l)}
                </span>,
                coversWords(l.covers),
                l.sponsorships === null ? "Not known" : String(l.sponsorships),
              ])}
              empty={data.licences.length ? "No licences match this search." : hasFirm ? "No licences yet. Register the first one for Mynt to verify." : "Mynt hasn't added you to your firm yet."}
            />
          ))}
        {tab === "requests" &&
          (data.requests === null || data.sponsored === null ? (
            unknown("which requests your firm has")
          ) : (
            <AdminTable
              head={["Product", "Component", "Builder", "Asked for", "Approved in", "Status", "Asked on", ""]}
              rowKeys={pagedRequests.shown.map((s) => s.id)}
              rows={pagedRequests.shown.map((s) => [
                s.product,
                s.component,
                s.builder,
                jurisdictionWords(s.asked),
                s.status === "approved" ? jurisdictionWords(s.approved) : "—",
                <span key="s" data-sponsorship-status={s.status}>
                  {sponsorshipStatusWords(s.status)}
                </span>,
                day(s.askedAt),
                s.status === "pending" ? (
                  <Button key="a" size="sm" onClick={() => setSheet({ kind: "review", request: s })} data-review={s.id}>
                    <ClipboardCheck />
                    Review request
                  </Button>
                ) : s.status === "approved" ? (
                  <Button key="a" size="sm" variant="outline" onClick={() => setSheet({ kind: "revoke", sponsorship: s })} data-revoke={s.id}>
                    <ShieldOff />
                    Revoke sponsorship
                  </Button>
                ) : null,
              ])}
              empty={data.requests.length + data.sponsored.length ? "No requests match this search." : "No requests yet. Builders name your firm id and ask; share the id with them."}
            />
          ))}
        {tab === "sponsored" &&
          (data.sponsored === null ? (
            unknown("what your firm sponsors")
          ) : (
            <AdminTable
              head={["Product", "State", "Component", "Builder", "Under", "Where", "Since"]}
              rowKeys={pagedSponsored.shown.map((s) => s.id)}
              rows={pagedSponsored.shown.map((s) => [
                s.product,
                <span key="s" data-product-state={s.drifted ? "drifted" : (s.productStatus ?? "unknown")}>
                  {productStateWords(s)}
                </span>,
                `${s.component} (${s.componentWords})`,
                s.builder,
                s.licences.join("; ") || "—",
                jurisdictionWords(s.approved),
                day(s.decidedAt),
              ])}
              empty={data.sponsored.length ? "No sponsored products match this search." : "Your firm sponsors nothing yet."}
            />
          ))}
        {tab === "roster" &&
          (firm === null ? (
            unknown("who is on your firm's roster")
          ) : (
            <AdminTable
              head={["Party", "Kind", "Roles", "Relationship", "Since", "Status", ""]}
              rowKeys={pagedRoster.shown.map((r) => r.key)}
              rows={pagedRoster.shown.map((r) => [
                r.name,
                r.kind === "internal" ? "Person" : "Firm",
                r.roles.join("; ") || "—",
                r.relationship?.replace(/_/g, " ") ?? "—",
                r.since ?? "—",
                <span key="s" data-roster-status={r.status}>
                  {r.status === "needed" ? "Needed: nobody fills it" : r.status === "ended" ? `Ended${r.until ? ` ${r.until}` : ""}` : "Active"}
                </span>,
                r.status === "needed" ? (
                  <Button key="a" size="sm" onClick={() => setSheet({ kind: "party", role: firm.needed.find((n) => r.fill && n.licenceId === r.fill.licenceId && n.stakeholder === r.fill.stakeholder) ?? null })} data-fill-role={r.key}>
                    <UserPlus />
                    Add party
                  </Button>
                ) : r.status === "active" ? (
                  <Button key="a" size="sm" variant="outline" onClick={() => setSheet({ kind: "end", party: r })} data-end-party={r.key}>
                    <UserMinus />
                    End party
                  </Button>
                ) : null,
              ])}
              empty={firm.roster.length ? "Nobody on your roster matches this search." : "Nobody on your roster yet. Add who fills the roles your licences require."}
            />
          ))}
        {tab === "people" && (
          <AdminTable
            head={["Name", "Email", "Status", "Since", ""]}
            rowKeys={pagedPeople.shown.map((p) => p.key)}
            rows={pagedPeople.shown.map((p) => [
              p.name ?? "—",
              p.email ?? "—",
              <span key="s" data-person-status={p.status}>
                {PERSON_STATUS_WORDS[p.status]}
              </span>,
              day(p.since),
              p.status === "waiting" && p.requestId ? (
                <Button key="a" size="sm" onClick={() => setSheet({ kind: "decide", person: p })} data-decide={p.requestId}>
                  <UserCheck />
                  Decide
                </Button>
              ) : null,
            ])}
            empty={people.length ? "Nobody matches this search." : hasFirm ? "Mynt hasn't told us who is at your firm. Mynt's admins add your firm's people." : "Mynt hasn't added you to your firm yet."}
          />
        )}
        {tab === "notices" &&
          (noticeRows === null ? (
            !hasFirm ? (
              <AdminTable head={["When", "What", "Details", "Read"]} rows={[]} empty="Mynt hasn't added you to your firm yet." />
            ) : loadedNotices.state.kind === "ready" ? null : (
              <div className="p-4">
                <AdminNotReady state={loadedNotices.state} what="Notices" />
              </div>
            )
          ) : (
            <AdminTable
              head={["When", "What", "Details", "Read"]}
              rowKeys={pagedNotices.shown.map((n) => n.id)}
              rows={pagedNotices.shown.map((n) => [
                when(n.at),
                n.what,
                n.details || "—",
                <span key="r" data-notice-read={n.read}>
                  {n.read ? "Read" : "New"}
                </span>,
              ])}
              empty={noticeRows.length ? "No notices match this search." : "No notices yet. Mynt tells you here when something changes at your firm."}
            />
          ))}
      </AdminList>
      <FirmFactsSheet open={sheet?.kind === "facts"} firm={firm} check={onboarding.check} onClose={close} onDone={done} fetcher={fetcher} />
      <RegisterLicenceSheet open={sheet?.kind === "licence"} licenceTypes={data.licenceTypes} onClose={close} onDone={done} fetcher={fetcher} />
      <AddPartySheet open={sheet?.kind === "party"} needed={firm?.needed ?? []} role={sheet?.kind === "party" ? sheet.role : null} onClose={close} onDone={done} fetcher={fetcher} />
      <EndPartySheet party={sheet?.kind === "end" ? sheet.party : null} onClose={close} onDone={done} fetcher={fetcher} />
      <ReviewRequestSheet request={sheet?.kind === "review" ? sheet.request : null} check={onboarding.check} licences={data.licences ?? []} onClose={close} onDone={done} fetcher={fetcher} />
      <RevokeSponsorshipSheet sponsorship={sheet?.kind === "revoke" ? sheet.sponsorship : null} onClose={close} onDone={done} fetcher={fetcher} />
      <DecideMemberSheet person={sheet?.kind === "decide" ? sheet.person : null} onClose={close} onDone={done} fetcher={fetcher} />
    </div>
  )
}
