// My firm (/firm): a regulated firm's own area in the studio, for accounts Mynt gave the licence-provider role. Pure:
// Mynt's replies (get_regulated_firm_onboarding, get_my_entity, list_my_licenses, list_sponsorship_requests,
// list_sponsored_products, list_firm_notices, get_region) into what the page shows, each step's status in words and the
// action the studio offers for it, each table's rows and its CSV. Mynt decides every step; nothing here does.
import { toCsv } from "./compliance";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const strs = (v: unknown) => arr(v).filter((x): x is string => typeof x === "string" && x.length > 0);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
const words = (code: string) => code.replace(/_/g, " ");

/** The licence-provider role, as Mynt's whoami grants it (an admin only implies it). */
export const isLicenceProviderRole = (roles: readonly string[]) => roles.includes("license_provider");

// ---- the onboarding checklist ----

export type StepStatus = "done" | "next" | "not_started" | "blocked";
export const STEP_STATUSES: readonly StepStatus[] = ["done", "next", "not_started", "blocked"];
/** A step's status in words (shown with its mark, never as colour alone). */
export const STEP_STATUS_WORDS: Record<StepStatus, string> = { done: "Done", next: "Do this next", not_started: "Not started", blocked: "Waiting" };

/** What the studio can do for a step: open one of the area's sheets. Steps only Mynt can do have none. */
export type StepAction = "facts" | "licence" | "party" | "review";
export const STEP_ACTION_LABELS: Record<StepAction, string> = {
  facts: "Set firm facts",
  licence: "Register licence",
  party: "Add party",
  review: "Review request",
};

export type Step = { key: string; title: string; status: StepStatus; detail: string; tool: string | null; by: "firm" | "admin" | "builder"; informational: boolean; facts: Obj };
export type Progress = { done: number | null; total: number | null; next: { key: string; title: string; status: StepStatus } | null; complete: boolean };
/** One public register's answer about the firm (run_firm_checks, or Mynt's own monthly re-check). */
export type CheckAnswer = { id: string; source: string; sourceName: string; status: string; statusWords: string; at: string | null; note: string | null; scheduled: boolean };
export type RealCompanyCheck = {
  status: StepStatus;
  /** Whether it passes: null when this Mynt doesn't run the check (never shown as a pass). */
  passes: boolean | null;
  detail: string;
  rule: string | null;
  ruleText: string | null;
  reasons: string[];
  lastRunAt: string | null;
  lastAnswerAt: string | null;
};
export type Onboarding = {
  entity: { id: string; name: string; status: string } | null;
  steps: Step[];
  progress: Progress;
  readyToSponsor: boolean;
  check: RealCompanyCheck | null;
  checks: CheckAnswer[];
};

const stepOf = (s: Obj): Step | null => {
  const key = str(s.key);
  const status = str(s.status) as StepStatus | null;
  if (!key || !status || !STEP_STATUSES.includes(status)) return null;
  const by = s.by === "admin" || s.by === "builder" ? s.by : "firm";
  return { key, title: str(s.title) ?? key, status, detail: str(s.detail) ?? "", tool: str(s.tool), by, informational: s.informational === true, facts: isObj(s.facts) ? s.facts : {} };
};
export const progressOf = (p: unknown): Progress => {
  const o = isObj(p) ? p : {};
  const n = isObj(o.next) ? o.next : null;
  const status = n ? (str(n.status) as StepStatus | null) : null;
  return {
    done: num(o.done),
    total: num(o.total),
    next: n && str(n.key) ? { key: str(n.key)!, title: str(n.title) ?? str(n.key)!, status: status && STEP_STATUSES.includes(status) ? status : "next" } : null,
    complete: o.complete === true,
  };
};
const answerOf = (c: Obj): CheckAnswer | null =>
  str(c.id) && str(c.source)
    ? {
        id: str(c.id)!,
        source: str(c.source)!,
        sourceName: str(c.source_name) ?? words(str(c.source)!),
        status: str(c.status) ?? "unavailable",
        statusWords: str(c.status_words) ?? words(str(c.status) ?? "unavailable"),
        at: str(c.at),
        note: str(c.note),
        scheduled: c.scheduled === true,
      }
    : null;

export function fromOnboarding(reply: unknown): Onboarding | null {
  if (!isObj(reply) || !Array.isArray(reply.steps)) return null;
  const e = isObj(reply.entity) ? reply.entity : null;
  const steps = reply.steps.filter(isObj).map(stepOf).filter((s): s is Step => s !== null);
  const c = steps.find((s) => s.key === "real_company_check") ?? null;
  return {
    entity: e && str(e.id) ? { id: str(e.id)!, name: str(e.name) ?? "Your firm", status: str(e.status) ?? "active" } : null,
    steps,
    progress: progressOf(reply.progress),
    readyToSponsor: reply.ready_to_sponsor === true,
    check: c
      ? {
          status: c.status,
          passes: typeof c.facts.passes === "boolean" ? c.facts.passes : null,
          detail: c.detail,
          rule: str(c.facts.rule),
          ruleText: str(c.facts.rule_text),
          reasons: strs(c.facts.reasons),
          lastRunAt: str(c.facts.last_run_at),
          lastAnswerAt: str(c.facts.last_answer_at),
        }
      : null,
    checks: arr(reply.checks).filter(isObj).map(answerOf).filter((a): a is CheckAnswer => a !== null),
  };
}

/**
 * The studio's action for a step, where the firm's own people can take it now: its facts (Set firm facts), a licence
 * (Register licence), a required role (Add party) and a waiting request (Review request). Steps only Mynt or builders
 * can do, steps already done and steps that wait have none.
 */
export function stepAction(step: Step): StepAction | null {
  if (step.status === "done" || step.status === "blocked" || step.by !== "firm") return null;
  switch (step.key) {
    case "firm_facts":
      return "facts";
    case "licences_registered":
      return "licence";
    case "licences_verified":
      return step.tool === "register_license" && step.status === "next" ? "licence" : null;
    case "roster_complete":
      return step.status === "next" ? "party" : null;
    case "first_sponsorship":
      return step.tool === "approve_sponsorship" && (num(step.facts.pending) ?? 0) > 0 ? "review" : null;
    default:
      return null; // the ledger and the agreement template stay with their own tools and page
  }
}

/** Progress in words: "4 of 7 steps done", "All 7 steps done", or "Not known" when Mynt gave no count (never 0). */
export function progressWords(p: Progress): string {
  if (p.done === null || p.total === null) return "Not known";
  if (!p.total) return "No steps yet";
  return p.complete ? `All ${p.total} steps done` : `${p.done} of ${p.total} steps done`;
}

/** The real-company check in a line: its result in words, then when Mynt last asked the registers. */
export function checkLine(c: RealCompanyCheck | null): string {
  if (!c) return "Real-company check: Mynt didn't say where it stands.";
  const head = c.passes === true ? "Passed" : c.passes === null && c.status === "done" ? "Not required on this Mynt" : c.status === "blocked" && !c.lastRunAt ? "Not run yet" : c.passes === false && !c.lastAnswerAt && c.lastRunAt ? "Not known yet" : "Not passed";
  // Mynt's own words often open with the result ("Passed. …", "Not passed. …"): it's said once.
  return c.detail.startsWith(`${head}.`) ? `Real-company check: ${c.detail}` : `Real-company check: ${head}. ${c.detail}`;
}

// ---- the firm's record: facts, people, roster (get_my_entity) ----

export type Identifier = { scheme: string; value: string };
export type FirmPerson = { key: string; name: string | null; email: string | null; status: "licence_provider" | "member" | "waiting" | "invited"; since: string | null; requestId: string | null; adminRecovery: boolean };
export type RosterRow = {
  key: string;
  partyId: string | null; // null: a required role nobody fills yet
  name: string;
  kind: "internal" | "external";
  roles: string[]; // the roles it fills, in words
  relationship: string | null;
  since: string | null;
  until: string | null;
  status: "active" | "ended" | "needed";
  fill: { licenceId: string; stakeholder: string } | null; // for a needed role: what Add party fills
};
export type NeededRole = { licenceId: string; licenceType: string; stakeholder: string; name: string; kind: "internal" | "external" };
export type Firm = { id: string; name: string; status: string; regions: string[]; legalForm: string | null; country: string | null; identifiers: Identifier[]; members: { id: string; name: string | null; email: string | null }[]; roster: RosterRow[]; needed: NeededRole[] };

export const PERSON_STATUS_WORDS: Record<FirmPerson["status"], string> = {
  licence_provider: "Licence provider",
  member: "Member",
  waiting: "Waiting to be accepted",
  invited: "Invited, not yet signed in",
};

export function fromFirm(entity: unknown): Firm | null {
  if (!isObj(entity) || !str(entity.id)) return null;
  const licences = new Map(arr(entity.licenses).filter(isObj).map((l) => [String(l.id), `${str(l.license_id) ?? "Licence"}${str(l.jurisdiction) ? ` (${str(l.jurisdiction)})` : ""}`]));
  const reconciliation = isObj(entity.reconciliation) ? arr(entity.reconciliation.licences).filter(isObj) : [];
  const needed: NeededRole[] = reconciliation.flatMap((l) =>
    arr(l.missing)
      .filter(isObj)
      .flatMap((m) => (str(m.stakeholder) && str(l.licence_id) ? [{ licenceId: str(l.licence_id)!, licenceType: licences.get(str(l.licence_id)!) ?? str(l.license_id) ?? "Licence", stakeholder: str(m.stakeholder)!, name: str(m.name) ?? words(str(m.stakeholder)!), kind: m.kind === "external" ? ("external" as const) : ("internal" as const) }] : [])),
  );
  const parties: RosterRow[] = arr(entity.parties)
    .filter(isObj)
    .flatMap((p): RosterRow[] => {
      const id = str(p.id);
      if (!id) return [];
      const kind = p.kind === "external" ? "external" : "internal";
      const person = isObj(p.person) ? str(p.person.name) : null;
      return [
        {
          key: id,
          partyId: id,
          name: kind === "internal" ? (person ?? "A person") : (str(p.legal_entity_name) ?? "Another firm"),
          kind,
          roles: arr(p.fills)
            .filter(isObj)
            .map((f) => `${words(str(f.stakeholder) ?? "role")} · ${licences.get(String(f.licence_id)) ?? "a licence"}`),
          relationship: str(p.relationship),
          since: str(p.since),
          until: str(p.until),
          status: p.status === "ended" ? "ended" : "active",
          fill: null,
        },
      ];
    });
  const inc = isObj(entity.incorporation) ? entity.incorporation : null;
  return {
    id: str(entity.id)!,
    name: str(entity.name) ?? "Your firm",
    status: str(entity.status) ?? "active",
    regions: strs(entity.regions),
    legalForm: str(entity.legal_form),
    country: inc ? str(inc.country) : null,
    identifiers: arr(entity.identifiers)
      .filter(isObj)
      .flatMap((i) => (str(i.scheme) && str(i.value) ? [{ scheme: str(i.scheme)!, value: str(i.value)! }] : [])),
    members: arr(entity.members)
      .filter(isObj)
      .flatMap((m) => (str(m.id) ? [{ id: str(m.id)!, name: str(m.name), email: str(m.email) }] : [])),
    // Required roles nobody fills come first, then the parties (active before ended).
    roster: [
      ...needed.map((n): RosterRow => ({ key: `needed:${n.licenceId}:${n.stakeholder}`, partyId: null, name: "Nobody yet", kind: n.kind, roles: [`${n.name} · ${n.licenceType}`], relationship: null, since: null, until: null, status: "needed", fill: { licenceId: n.licenceId, stakeholder: n.stakeholder } })),
      ...parties.filter((p) => p.status === "active"),
      ...parties.filter((p) => p.status === "ended"),
    ],
    needed,
  };
}

/** The firm's people: its licence providers, its other members, those waiting to be accepted and those yet to sign in. */
export function peopleOf(firm: Firm | null, onboarding: Onboarding): FirmPerson[] {
  const facts = onboarding.steps.find((s) => s.key === "licence_provider_members")?.facts ?? {};
  const providers = arr(facts.licence_providers).filter(isObj);
  const providerEmails = new Set(providers.map((p) => str(p.email)?.toLowerCase()).filter((e): e is string => Boolean(e)));
  const person = (key: string, name: string | null, email: string | null, status: FirmPerson["status"], since: string | null = null, requestId: string | null = null, adminRecovery = false): FirmPerson => ({ key, name, email, status, since, requestId, adminRecovery });
  return [
    ...providers.map((p, i) => person(`lp:${str(p.email) ?? i}`, str(p.name), str(p.email), "licence_provider", str(p.since))),
    ...(firm?.members ?? []).filter((m) => !m.email || !providerEmails.has(m.email.toLowerCase())).map((m) => person(`m:${m.id}`, m.name, m.email, "member")),
    ...arr(facts.waiting)
      .filter(isObj)
      .map((p, i) => person(`w:${str(p.request_id) ?? i}`, null, str(p.email), "waiting", str(p.requested_at), str(p.request_id), p.admin_recovery === true)),
    ...arr(facts.invited)
      .filter(isObj)
      .map((p, i) => person(`i:${str(p.email) ?? i}`, null, str(p.email), "invited", str(p.invited_at))),
  ];
}

// The identifiers the real-company check and Mynt's admins look a firm up by. Any other identifier on the firm's record
// is kept as it is when these are saved (set_entity_facts replaces the whole list).
export const FACT_SCHEMES = [
  { scheme: "lei", label: "LEI", hint: "20 letters and digits. Mynt checks it against GLEIF's public record." },
  { scheme: "us_fincen_msb", label: "FinCEN MSB registration number", hint: "Mynt matches your legal name against FinCEN's registrant list; an admin checks the number by hand." },
  { scheme: "us_nmls", label: "NMLS ID", hint: "Checked by hand on NMLS Consumer Access." },
] as const;
const LEI = /^[A-Z0-9]{18}[0-9]{2}$/;
/** What's wrong with a typed LEI, or null (its check digits are Mynt's to verify). */
export const leiProblem = (value: string) => (!value.trim() || LEI.test(value.trim().toUpperCase()) ? null : "An LEI is 20 letters and digits, ending in two digits.");
/** The identifiers to save: the firm's other ones kept, these three replaced by what was typed (blank removes one). */
export function identifiersToSave(current: Identifier[], typed: Record<string, string>): Identifier[] {
  const ours = new Set<string>(FACT_SCHEMES.map((f) => f.scheme));
  return [
    ...FACT_SCHEMES.flatMap((f) => {
      const v = (typed[f.scheme] ?? "").trim();
      return v ? [{ scheme: f.scheme, value: f.scheme === "lei" ? v.toUpperCase() : v }] : [];
    }),
    ...current.filter((i) => !ours.has(i.scheme)),
  ];
}

// ---- licences (list_my_licenses) and the licence types to choose from (get_region) ----

export type FirmLicence = { id: string; region: string; regulator: string; licenceType: string; jurisdiction: string | null; number: string; validFrom: string | null; validTo: string | null; status: string; inForce: boolean; reviewNote: string | null; covers: string[]; sponsorships: number | null };
export function fromLicences(reply: unknown): FirmLicence[] | null {
  if (!isObj(reply) || !Array.isArray(reply.licences)) return null;
  return reply.licences.filter(isObj).flatMap((l) =>
    str(l.id)
      ? [
          {
            id: str(l.id)!,
            region: str(l.region) ?? "",
            regulator: str(l.regulator_id) ?? "",
            licenceType: str(l.license_id) ?? "Licence",
            jurisdiction: str(l.jurisdiction),
            number: str(l.registration_number) ?? "",
            validFrom: str(l.valid_from),
            validTo: str(l.valid_to),
            status: str(l.status) ?? "pending",
            inForce: l.in_force === true,
            reviewNote: str(l.review_note),
            covers: strs(l.covers),
            sponsorships: Array.isArray(l.sponsorships) ? l.sponsorships.length : null,
          },
        ]
      : [],
  );
}
/** A licence's status in words. */
export function licenceStatusWords(l: Pick<FirmLicence, "status" | "inForce" | "reviewNote" | "validTo">): string {
  if (l.status === "verified") return l.inForce ? "Verified by Mynt, in force" : `Verified by Mynt, not in force${l.validTo ? ` (valid to ${l.validTo})` : ""}`;
  if (l.status === "pending") return "Waiting for Mynt to verify";
  if (l.status === "suspended") return `Suspended by Mynt${l.reviewNote ? `: ${l.reviewNote}` : ""}`;
  if (l.status === "rejected") return `Not verified by Mynt${l.reviewNote ? `: ${l.reviewNote}` : ""}`;
  return words(l.status);
}
export const coversWords = (covers: string[]) => (covers.length ? covers.map((c) => c.toUpperCase()).join(", ") : "Nowhere by itself");

export type LicenceTypeOption = { region: string; regulatorId: string; regulator: string; id: string; name: string; perJurisdiction: boolean; jurisdictions: string[] };
/** A region's licence types, from its regulatory model (get_region): what Register licence offers. */
export function licenceTypeOptions(region: string, reply: unknown): LicenceTypeOption[] {
  const model = isObj(reply) && isObj(reply.regulatory) ? reply.regulatory : null;
  return arr(model?.regulators)
    .filter(isObj)
    .flatMap((r) =>
      arr(r.license_types)
        .filter(isObj)
        .flatMap((l) =>
          str(r.id) && str(l._id)
            ? [{ region, regulatorId: str(r.id)!, regulator: str(r.short_name) ?? str(r.name) ?? str(r.id)!, id: str(l._id)!, name: str(l.name) ?? str(l._id)!, perJurisdiction: l.issued_per_jurisdiction === true, jurisdictions: strs(l.covers) }]
            : [],
        ),
    );
}

// ---- sponsorship requests and sponsored products ----

export type GrantingLicence = { id: string; licenceType: string; jurisdiction: string | null; inForce: boolean };
export type Sponsorship = {
  id: string;
  status: string;
  product: string;
  productStatus: string | null;
  drifted: boolean;
  component: string;
  componentWords: string;
  builder: string;
  asked: string[];
  approved: string[];
  note: string | null;
  decisionNote: string | null;
  askedAt: string | null;
  decidedAt: string | null;
  licences: string[]; // the licences it's approved under, in words
  granting: GrantingLicence[]; // the firm's licences that grant the component (pending requests)
};
export function fromSponsorships(reply: unknown): Sponsorship[] | null {
  if (!Array.isArray(reply)) return null;
  return reply.filter(isObj).flatMap((s): Sponsorship[] => {
    const id = str(s.id);
    if (!id) return [];
    const product = isObj(s.product) ? s.product : {};
    const component = isObj(s.component) ? s.component : {};
    const builder = isObj(s.builder) ? s.builder : {};
    return [
      {
        id,
        status: str(s.status) ?? "pending",
        product: str(product.name) ?? str(product.id) ?? "A product",
        productStatus: str(product.status),
        drifted: product.drifted === true,
        component: str(component.key) ?? str(s.component_key) ?? "",
        componentWords: [str(component.primitive), str(component.action)].filter(Boolean).map((x) => words(x!)).join(", ") || (str(component.key) ?? "—"),
        builder: str(builder.name) ?? "A builder",
        asked: strs(s.requested_jurisdictions),
        approved: strs(s.jurisdictions),
        note: str(s.note),
        decisionNote: str(s.decision_note),
        askedAt: str(s.created_at),
        decidedAt: str(s.decided_at),
        licences: arr(s.licences)
          .filter(isObj)
          .map((l) => `${str(l.license_id) ?? "A licence"}${str(l.jurisdiction) ? ` (${str(l.jurisdiction)})` : ""}`),
        granting: arr(s.your_licences_granting_it)
          .filter(isObj)
          .flatMap((l) => (str(l.id) ? [{ id: str(l.id)!, licenceType: str(l.license_id) ?? "Licence", jurisdiction: str(l.jurisdiction), inForce: l.in_force === true }] : [])),
      },
    ];
  });
}
export const SPONSORSHIP_STATUS_WORDS: Record<string, string> = { pending: "Waiting for your decision", approved: "Approved", declined: "Declined", revoked: "Revoked" };
export const sponsorshipStatusWords = (s: string) => SPONSORSHIP_STATUS_WORDS[s] ?? words(s);
export const jurisdictionWords = (codes: string[]) => (codes.length ? codes.map((c) => c.toUpperCase()).join(", ") : "The whole country");
/** A sponsored product's state in words: live, drifted (new sales paused) or not live yet. */
export const productStateWords = (s: Pick<Sponsorship, "productStatus" | "drifted">) => (s.drifted ? "Drifted: new sales paused" : s.productStatus === "published" ? "Live" : s.productStatus ? `Not live (${words(s.productStatus)})` : "Not known");

// ---- notices (list_firm_notices) ----

export type Notice = { id: string; type: string; what: string; details: string; at: string | null; read: boolean };
const NOTICE_WORDS: Record<string, string> = {
  "firm.member_added": "A member was added",
  "firm.member_pending": "A member is waiting to be accepted",
  "firm.member_removed": "A member was removed",
  "firm.member_standing_lost": "A licence provider lost standing",
  "firm.recovery_pending": "A Mynt admin's recovery is waiting",
};
/** A notice's type in words: Mynt's event name, read as a sentence ("partner_ledger.source_changed" → "Partner ledger: source changed"). */
export const noticeWords = (type: string) => {
  if (NOTICE_WORDS[type]) return NOTICE_WORDS[type];
  const [area, ...rest] = type.split(".");
  const tail = words(rest.join(" "));
  const head = words(area ?? type);
  return tail ? `${head.charAt(0).toUpperCase()}${head.slice(1)}: ${tail}` : `${head.charAt(0).toUpperCase()}${head.slice(1)}`;
};
// What a notice says, from its data: plain values only (never an object dumped as text), a few of them.
const detailsOf = (data: unknown) =>
  isObj(data)
    ? Object.entries(data)
        .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
        .slice(0, 6)
        .map(([k, v]) => `${words(k)}: ${String(v)}`)
        .join(" · ")
    : "";
export function fromNotices(reply: unknown): Notice[] | null {
  if (!Array.isArray(reply)) return null;
  return reply.filter(isObj).flatMap((n) => (str(n.id) ? [{ id: str(n.id)!, type: str(n.type) ?? "notice", what: noticeWords(str(n.type) ?? "notice"), details: detailsOf(n.data), at: str(n.at), read: n.read === true }] : []));
}

// ---- tabs and CSV ----

export const FIRM_TABS = [
  { id: "licences", label: "Licences" },
  { id: "requests", label: "Sponsorship requests" },
  { id: "sponsored", label: "Sponsored products" },
  { id: "roster", label: "Roster" },
  { id: "people", label: "People" },
  { id: "notices", label: "Notices" },
] as const;
export type FirmTab = (typeof FIRM_TABS)[number]["id"];
export const firmTabOf = (v: string | null | undefined): FirmTab => FIRM_TABS.find((t) => t.id === v)?.id ?? "licences";

export const licencesCsv = (rows: FirmLicence[]) =>
  toCsv(
    ["Licence", "Regulator", "Region", "Jurisdiction", "Number", "Valid from", "Valid to", "Status", "Covers", "Sponsorships"],
    rows.map((l) => [l.licenceType, l.regulator, l.region, l.jurisdiction ?? "", l.number, l.validFrom ?? "", l.validTo ?? "", licenceStatusWords(l), coversWords(l.covers), l.sponsorships === null ? "Not known" : String(l.sponsorships)]),
  );
export const sponsorshipsCsv = (rows: Sponsorship[]) =>
  toCsv(
    ["Product", "Component", "Builder", "Asked for", "Approved in", "Status", "Asked on", "Decided on"],
    rows.map((s) => [s.product, s.component, s.builder, jurisdictionWords(s.asked), s.status === "approved" ? jurisdictionWords(s.approved) : "", sponsorshipStatusWords(s.status), day(s.askedAt), day(s.decidedAt)]),
  );
export const sponsoredCsv = (rows: Sponsorship[]) =>
  toCsv(
    ["Product", "State", "Component", "Builder", "Licences", "Jurisdictions", "Since"],
    rows.map((s) => [s.product, productStateWords(s), s.component, s.builder, s.licences.join("; "), jurisdictionWords(s.approved), day(s.decidedAt)]),
  );
export const rosterCsv = (rows: RosterRow[]) =>
  toCsv(
    ["Party", "Kind", "Roles", "Relationship", "Since", "Until", "Status"],
    rows.map((r) => [r.name, r.kind === "internal" ? "Person" : "Firm", r.roles.join("; "), r.relationship ?? "", r.since ?? "", r.until ?? "", r.status === "needed" ? "Needed" : r.status === "ended" ? "Ended" : "Active"]),
  );
export const peopleCsv = (rows: FirmPerson[]) => toCsv(["Name", "Email", "Status", "Since"], rows.map((p) => [p.name ?? "", p.email ?? "", PERSON_STATUS_WORDS[p.status], day(p.since)]));
export const noticesCsv = (rows: Notice[]) => toCsv(["When", "What", "Details", "Read"], rows.map((n) => [n.at ?? "", n.what, n.details, n.read ? "Read" : "New"]));
