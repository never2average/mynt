// The Audits page's four classes of record, and the licence obligations behind its Licence
// obligations tab. list_workspace_audit takes `class` (security, obligations, financial or
// workspace) where Mynt has it and returns rows of one shape; get_workspace_obligations lists each
// licence's regulatory obligations with their status and evidence. Until then the Workspace
// activity tab shows the audit trail as it is, and the others say they aren't available yet.
// Pure, for the routes, the page and the tests.
import type { AuditEvent } from "./compliance";
import { anyOf, type Picks } from "./facets";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const AUDIT_CLASSES = ["security", "obligations", "financial", "workspace"] as const;
export type AuditClass = (typeof AUDIT_CLASSES)[number];
export const AUDIT_CLASS_LABELS: Record<AuditClass, string> = {
  security: "App security",
  obligations: "Licence obligations",
  financial: "Financial activity",
  workspace: "Workspace activity",
};
export const AUDIT_CLASS_HELP: Record<AuditClass, string> = {
  security: "Build audits and their findings, program gate results and vulnerability flags",
  obligations: "Each licence's regulatory obligations for the products it covers: met, at risk or overdue, with evidence",
  financial: "Money movements, live transactions, liquidity commitments and withdrawals, rail use and refusals",
  workspace: "Membership, roles, keys and settings",
};
export const auditClassOf = (v: unknown): AuditClass => (AUDIT_CLASSES.includes(v as AuditClass) ? (v as AuditClass) : "security");

// The Audits page's tabs: the four classes, with Agreement audits (oversight audits licence providers
// run on apps under program agreements, lib/agreement-audits.ts) after Licence obligations. It's a tab
// of its own so the regulator's obligations keep their register's schema.
export const AUDITS_TABS = ["security", "obligations", "agreements", "financial", "workspace"] as const;
export type AuditsTab = (typeof AUDITS_TABS)[number];
export const AUDITS_TAB_LABELS: Record<AuditsTab, string> = { ...AUDIT_CLASS_LABELS, agreements: "Agreement audits" };
export const AUDITS_TAB_HELP: Record<AuditsTab, string> = {
  ...AUDIT_CLASS_HELP,
  agreements: "The oversight audits licence providers run on your apps under program agreements: due dates, status, findings and evidence",
};
export const auditsTabOf = (v: unknown): AuditsTab => (AUDITS_TABS.includes(v as AuditsTab) ? (v as AuditsTab) : "security");

// ---- rows ----

export type AuditRow = {
  id: string;
  at: string;
  class: AuditClass | null;
  kind: string;
  actor: { id: string | null; name: string | null };
  appId: string | null;
  target: { type: string | null; id: string | null; name: string | null };
  summary: string | null;
  severity: string | null;
  status: string | null;
  details: string | null;
};
export type AuditRowPage = { rows: AuditRow[]; nextCursor: string | null };

const detailsText = (v: unknown): string | null => {
  if (str(v)) return str(v);
  if (isObj(v) && Object.keys(v).length) return JSON.stringify(v);
  return null;
};

function party(v: unknown): { id: string | null; name: string | null } {
  if (typeof v === "string") return { id: null, name: str(v) };
  const o = isObj(v) ? v : {};
  return { id: str(o.id), name: str(o.name) };
}

/** list_workspace_audit's answer with `class`: rows (under `rows` or `events`) and the next cursor. */
export function fromClassAudit(raw: unknown): AuditRowPage {
  const r = isObj(raw) ? raw : {};
  const list = Array.isArray(r.rows) ? r.rows : Array.isArray(r.events) ? r.events : [];
  const rows = list.filter(isObj).flatMap((e, i): AuditRow[] => {
    const at = str(e.at);
    const kind = str(e.kind) ?? str(e.action);
    if (!at || !kind) return [];
    const target = isObj(e.target) ? e.target : {};
    return [
      {
        id: str(e.id) ?? `${at}-${i}`,
        at,
        class: AUDIT_CLASSES.includes(e.class as AuditClass) ? (e.class as AuditClass) : null,
        kind,
        actor: party(e.actor),
        appId: str(e.app_id),
        target: { type: str(target.type), id: str(target.id), name: str(target.name) },
        summary: str(e.summary),
        severity: str(e.severity),
        status: str(e.status),
        details: detailsText(e.details),
      },
    ];
  });
  return { rows, nextCursor: str(r.next_cursor) };
}

/** The audit trail as Mynt has it today, as rows (the Workspace activity tab's fallback). */
export function rowsFromEvents(events: AuditEvent[]): AuditRow[] {
  return events.map((e, i) => ({
    id: `${e.at}-${i}`,
    at: e.at,
    class: "workspace",
    kind: e.action,
    actor: e.actor,
    appId: e.target.type === "app" ? e.target.id : null,
    target: e.target,
    summary: null,
    severity: null,
    status: null,
    details: e.details,
  }));
}

export function searchRows(rows: AuditRow[], query: string): AuditRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const text = [r.kind, r.actor.name, r.target.type, r.target.name, r.target.id, r.summary, r.severity, r.status, r.details].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

// ---- obligations ----

export const OBLIGATION_STATUSES = ["met", "at_risk", "overdue", "unknown"] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];
export const OBLIGATION_LABELS: Record<ObligationStatus, string> = { met: "Met", at_risk: "At risk", overdue: "Overdue", unknown: "Unknown" };

export type Obligation = {
  licenceId: string | null;
  licenceType: string | null;
  partner: string | null; // the partner's name
  partnerId: string | null; // its entity id: what the Partner filter matches
  reason: string | null; // why an Unknown one is unknown
  regulator: string | null;
  obligationId: string;
  title: string;
  products: string[];
  status: ObligationStatus;
  dueAt: string | null;
  evidence: string | null;
};

const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap((p) => (typeof p === "string" ? (str(p) ? [str(p)!] : []) : isObj(p) ? [str(p.name) ?? str(p.id)].filter((x): x is string => Boolean(x)) : [])) : [];

/** get_workspace_obligations' answer: a list, or { obligations }. Kept in the regulator's terms.
 * The partner is { entity_id, name }; evidence is a summary; an unknown one says why (reason). */
export function fromObligations(raw: unknown): Obligation[] {
  const list = Array.isArray(raw) ? raw : isObj(raw) && Array.isArray(raw.obligations) ? raw.obligations : [];
  return list.filter(isObj).flatMap((o, i): Obligation[] => {
    const title = str(o.title);
    if (!title) return [];
    return [
      {
        licenceId: str(o.licence_id),
        licenceType: str(o.licence_type),
        partner: typeof o.partner === "string" ? str(o.partner) : isObj(o.partner) ? str(o.partner.name) : null,
        partnerId: isObj(o.partner) ? (str(o.partner.entity_id) ?? str(o.partner.name)) : str(o.partner),
        reason: str(o.reason),
        regulator: str(o.regulator),
        obligationId: str(o.obligation_id) ?? `obligation-${i}`,
        title,
        products: names(o.products),
        status: OBLIGATION_STATUSES.includes(o.status as ObligationStatus) ? (o.status as ObligationStatus) : "unknown",
        dueAt: str(o.due_at),
        evidence: str(o.evidence),
      },
    ];
  });
}

// Partner, regulator, status and product take any number of picks (an obligation matches any of a
// filter's picks, and every filter that has one); one value still works.
export type ObligationFilters = { query: string; partner: Picks; regulator: Picks; status: Picks; product: Picks };
export const NO_OBLIGATION_FILTERS: ObligationFilters = { query: "", partner: [], regulator: [], status: [], product: [] };

export function filterObligations(list: Obligation[], f: ObligationFilters): Obligation[] {
  const words = f.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((o) => {
    if (!anyOf(f.partner, o.partnerId) || !anyOf(f.regulator, o.regulator) || !anyOf(f.status, o.status) || !anyOf(f.product, o.products)) return false;
    const text = [o.title, o.partner, o.regulator, o.licenceType, o.obligationId, o.evidence, o.reason, ...o.products].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
