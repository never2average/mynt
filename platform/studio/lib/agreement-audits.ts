// The Audits page's Agreement audits tab: the oversight audits licence providers run on apps under
// program agreements (Mynt's list_agreement_audits and get_agreement_audit). Each agreement has many
// audit requirements (an annual compliance review, a quarterly complaints review, a marketing review
// on each change) and each requirement many audits over time. These are the agreement's own audits,
// kept apart from the regulator's obligations (the Licence obligations tab), whose schema they don't
// touch. Pure, for the routes, the page and the tests.
import { anyOf, type Picks } from "./facets";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const AUDIT_KIND_LABELS: Record<string, string> = {
  compliance_review: "Compliance review",
  complaints_review: "Complaints review",
  marketing_review: "Marketing material review",
  security_review: "Security review",
  financial_review: "Financial review",
  other: "Other",
};
export const AUDIT_KINDS = Object.keys(AUDIT_KIND_LABELS);
export const CADENCE_LABELS: Record<string, string> = { once: "Once", monthly: "Monthly", quarterly: "Quarterly", annual: "Annual", on_change: "On each change" };
export const CADENCES = Object.keys(CADENCE_LABELS);
export const AUDIT_STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  submitted: "Submitted, waiting for review",
  passed: "Passed",
  failed: "Failed",
  waived: "Waived",
};
export const AUDIT_STATUSES = Object.keys(AUDIT_STATUS_LABELS);
export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
const label = (map: Record<string, string>, v: string | null) => (v ? (map[v] ?? v.replace(/_/g, " ")) : "—");

// What each action is called on its button, and which side takes it (Mynt says which the caller may
// take on each audit: its `actions`).
export const AUDIT_ACTIONS = ["open", "record_finding", "resolve_finding", "pass", "fail", "waive", "submit_evidence", "respond_to_finding"] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AUDIT_ACTION_LABELS: Record<AuditAction, string> = {
  open: "Open audit",
  record_finding: "Record finding",
  resolve_finding: "Resolve finding",
  pass: "Pass",
  fail: "Fail",
  waive: "Waive",
  submit_evidence: "Submit evidence",
  respond_to_finding: "Respond to finding",
};

export type AgreementAuditRow = {
  id: string;
  agreementId: string;
  requirementId: string;
  appId: string | null;
  appName: string;
  counterpartyId: string | null;
  counterparty: string;
  name: string;
  kind: string;
  cadence: string | null;
  dueAt: string | null;
  status: string;
  overdue: boolean;
  findingsOpen: number | null;
  findingsTotal: number | null;
  evidence: number | null;
  side: "app" | "counterparty" | "both";
  actions: AuditAction[];
};
export type AgreementOption = { id: string; label: string; appName: string; counterparty: string; canAddRequirements: boolean };
export type RequirementRow = { id: string; agreementId: string; name: string; kind: string; cadence: string; nextDue: string | null; audits: number | null; overdue: boolean; retired: boolean };
export type AgreementAuditList = {
  agreements: AgreementOption[];
  requirements: RequirementRow[];
  audits: AgreementAuditRow[];
  counts: { audits: number | null; open: number | null; overdue: number | null };
};

const sideOf = (v: unknown): AgreementAuditRow["side"] => (v === "counterparty" || v === "both" ? v : "app");
const actionsOf = (v: unknown) => arr(v).filter((a): a is AuditAction => AUDIT_ACTIONS.includes(a as AuditAction));
const nameOf = (v: unknown, fallback: string) => (isObj(v) ? str(v.name) : null) ?? fallback;

function auditRow(a: Obj): AgreementAuditRow | null {
  const id = str(a.id);
  const agreementId = str(a.agreement_id) ?? (isObj(a.agreement) ? str(a.agreement.id) : null);
  if (!id || !agreementId) return null;
  const req = isObj(a.requirement) ? a.requirement : {};
  const findings = Array.isArray(a.findings) ? a.findings.filter(isObj) : null;
  return {
    id,
    agreementId,
    requirementId: str(a.requirement_id) ?? str(req.id) ?? "",
    appId: str(a.app_id) ?? (isObj(a["app"]) ? str(a["app"].id) : null),
    appName: nameOf(a["app"], "Unnamed app"),
    counterpartyId: isObj(a.counterparty) ? str(a.counterparty.entity_id) : null,
    counterparty: nameOf(a.counterparty, "Unnamed firm"),
    name: str(req.name) ?? "Audit",
    kind: str(req.kind) ?? "other",
    cadence: str(req.cadence),
    dueAt: str(a.due_at),
    status: str(a.status) ?? "unknown",
    overdue: a.overdue === true,
    findingsOpen: num(a.findings_open) ?? (findings ? findings.filter((f) => f.status === "open").length : null),
    findingsTotal: findings ? findings.length : null,
    evidence: Array.isArray(a.evidence) ? a.evidence.length : null,
    side: sideOf(a.your_side),
    actions: actionsOf(a.actions),
  };
}

/** list_agreement_audits' answer, or null when it isn't one. */
export function fromAgreementAuditList(raw: unknown): AgreementAuditList | null {
  if (!isObj(raw) || !Array.isArray(raw.audits)) return null;
  const counts = isObj(raw.counts) ? raw.counts : {};
  return {
    agreements: arr(raw.agreements)
      .filter(isObj)
      .flatMap((a): AgreementOption[] => {
        const id = str(a.id);
        if (!id) return [];
        const app = nameOf(a["app"], "Unnamed app");
        const counterparty = nameOf(a.counterparty, "Unnamed firm");
        return [{ id, label: `${app} with ${counterparty}`, appName: app, counterparty, canAddRequirements: a.can_add_requirements === true }];
      }),
    requirements: arr(raw.requirements)
      .filter(isObj)
      .flatMap((r): RequirementRow[] => {
        const id = str(r.id);
        const agreementId = str(r.agreement_id);
        if (!id || !agreementId) return [];
        return [{ id, agreementId, name: str(r.name) ?? "Audit", kind: str(r.kind) ?? "other", cadence: str(r.cadence) ?? "once", nextDue: str(r.next_due), audits: num(r.audits), overdue: r.overdue === true, retired: str(r.retired_at) !== null }];
      }),
    audits: raw.audits.filter(isObj).flatMap((a) => auditRow(a) ?? []),
    counts: { audits: num(counts.audits), open: num(counts.open), overdue: num(counts.overdue) },
  };
}

// ---- one audit ----

export type FindingRow = { id: string; severity: string; title: string; detail: string | null; status: "open" | "resolved"; recordedBy: string | null; recordedAt: string | null; responses: { by: string | null; at: string | null; text: string }[]; resolutionNote: string | null };
export type EvidenceRow = { id: string; name: string; url: string | null; sha256: string | null; by: string | null; at: string | null; note: string | null };
export type HistoryRow = { id: string; action: string; at: string | null; by: string };
export type AgreementAuditDetail = AgreementAuditRow & {
  description: string | null;
  evidenceRequired: string | null;
  trigger: string | null;
  reviewer: string | null;
  openedAt: string | null;
  submittedAt: string | null;
  closedAt: string | null;
  outcomeNote: string | null;
  findings: FindingRow[];
  evidenceItems: EvidenceRow[];
  history: HistoryRow[];
};

// What each history entry was, in words.
export const HISTORY_LABELS: Record<string, string> = {
  agreement_audit_scheduled: "Scheduled",
  open_agreement_audit: "Opened",
  record_agreement_audit_finding: "Finding recorded",
  resolve_agreement_audit_finding: "Finding resolved",
  submit_agreement_audit_evidence: "Evidence submitted",
  respond_to_agreement_audit_finding: "Finding answered",
  pass_agreement_audit: "Passed",
  fail_agreement_audit: "Failed",
  waive_agreement_audit: "Waived",
};

/** get_agreement_audit's answer, or null when it isn't one. */
export function fromAgreementAudit(raw: unknown): AgreementAuditDetail | null {
  if (!isObj(raw)) return null;
  const row = auditRow(raw);
  if (!row) return null;
  const people = isObj(raw.people) ? raw.people : {};
  const person = (id: unknown) => (str(id) ? (str(people[id as string]) ?? "Someone") : null);
  const req = isObj(raw.requirement) ? raw.requirement : {};
  return {
    ...row,
    description: str(req.description),
    evidenceRequired: str(req.evidence_required),
    trigger: str(raw.trigger),
    reviewer: person(raw.reviewer),
    openedAt: str(raw.opened_at),
    submittedAt: str(raw.submitted_at),
    closedAt: str(raw.closed_at),
    outcomeNote: str(raw.outcome_note),
    findings: arr(raw.findings)
      .filter(isObj)
      .flatMap((f): FindingRow[] => {
        const id = str(f.id);
        if (!id) return [];
        return [
          {
            id,
            severity: str(f.severity) ?? "low",
            title: str(f.title) ?? "Finding",
            detail: str(f.detail),
            status: f.status === "resolved" ? "resolved" : "open",
            recordedBy: person(f.recorded_by),
            recordedAt: str(f.recorded_at),
            responses: arr(f.responses).filter(isObj).map((r) => ({ by: person(r.by), at: str(r.at), text: str(r.text) ?? "" })),
            resolutionNote: str(f.resolution_note),
          },
        ];
      }),
    evidenceItems: arr(raw.evidence)
      .filter(isObj)
      .flatMap((e): EvidenceRow[] => {
        const id = str(e.id);
        if (!id) return [];
        const url = str(e.url);
        return [{ id, name: str(e.name) ?? "Evidence", url: url && url.startsWith("https://") ? url : null, sha256: str(e.sha256), by: person(e.submitted_by), at: str(e.submitted_at), note: str(e.note) }];
      }),
    history: arr(raw.history)
      .filter(isObj)
      .flatMap((h, i): HistoryRow[] => {
        const action = str(h.action);
        if (!action) return [];
        const actor = isObj(h.actor) ? (str(h.actor.name) ?? "Someone") : "Mynt's schedule";
        return [{ id: str(h.id) ?? `${i}`, action, at: str(h.at), by: actor }];
      }),
  };
}

// ---- in words ----

export const kindText = (k: string) => label(AUDIT_KIND_LABELS, k);
export const cadenceText = (c: string | null) => label(CADENCE_LABELS, c);
export const statusText = (s: string) => label(AUDIT_STATUS_LABELS, s);
export const dueText = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
/** Open findings of all, or "Not available" when Mynt didn't say (never 0 for want of data). */
export const findingsText = (r: Pick<AgreementAuditRow, "findingsOpen" | "findingsTotal">) =>
  r.findingsTotal === null && r.findingsOpen === null ? "Not available" : r.findingsTotal === null ? `${r.findingsOpen} open` : r.findingsTotal === 0 ? "None" : `${r.findingsOpen ?? 0} open of ${r.findingsTotal}`;
export const CLOSED = ["passed", "failed", "waived"];

// ---- filters ----

export type AgreementAuditFilters = { query: string; agreement: Picks; counterparty: Picks; appId: Picks; kind: Picks; status: Picks };
export const NO_AGREEMENT_AUDIT_FILTERS: AgreementAuditFilters = { query: "", agreement: [], counterparty: [], appId: [], kind: [], status: [] };
// "overdue" is a status pick of its own: past due and not closed.
export const OVERDUE = "overdue";

export function filterAgreementAudits(rows: AgreementAuditRow[], f: AgreementAuditFilters, due: { from: string; to: string } = { from: "", to: "" }): AgreementAuditRow[] {
  const q = f.query.trim().toLowerCase();
  return rows.filter((r) => {
    if (q && ![r.name, r.appName, r.counterparty, kindText(r.kind), statusText(r.status)].some((x) => x.toLowerCase().includes(q))) return false;
    if (!anyOf(f.agreement, r.agreementId) || !anyOf(f.counterparty, r.counterpartyId) || !anyOf(f.appId, r.appId) || !anyOf(f.kind, r.kind)) return false;
    if (!anyOf(f.status, [r.status, r.overdue ? OVERDUE : null])) return false;
    if (due.from || due.to) {
      const d = r.dueAt ? r.dueAt.slice(0, 10) : "";
      if (!d || (due.from && d < due.from) || (due.to && d > due.to)) return false;
    }
    return true;
  });
}

export const CSV_HEADERS = ["Agreement", "App", "Counterparty", "Audit", "Kind", "Cadence", "Due", "Status", "Overdue", "Open findings", "Findings", "Evidence"];
export const csvRow = (r: AgreementAuditRow) => [r.agreementId, r.appName, r.counterparty, r.name, kindText(r.kind), cadenceText(r.cadence), dueText(r.dueAt), statusText(r.status), r.overdue ? "Yes" : "No", r.findingsOpen === null ? "" : String(r.findingsOpen), r.findingsTotal === null ? "" : String(r.findingsTotal), r.evidence === null ? "" : String(r.evidence)];

// ---- per agreement, for the app's Agreements tab ----

export type AgreementAuditSummary = { count: number; nextDue: string | null; overdue: number };
/** Each agreement's audits: how many, the next due date of an open one, and how many are overdue. */
export function summariesByAgreement(list: AgreementAuditList): Map<string, AgreementAuditSummary> {
  const out = new Map<string, AgreementAuditSummary>();
  for (const a of list.audits) {
    const s = out.get(a.agreementId) ?? { count: 0, nextDue: null, overdue: 0 };
    s.count += 1;
    if (a.overdue) s.overdue += 1;
    if (!CLOSED.includes(a.status) && a.dueAt && (!s.nextDue || a.dueAt < s.nextDue)) s.nextDue = a.dueAt;
    out.set(a.agreementId, s);
  }
  return out;
}
export const auditsHref = (agreementId: string) => `/audits?tab=agreements&agreement=${encodeURIComponent(agreementId)}`;
