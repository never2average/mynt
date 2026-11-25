// App agreements as the Licences page's Business agreements tab shows them, from either side:
// - the licence provider's (the counterparty's): what apps' workspaces proposed to or made with its firm
//   (list_app_agreements without app_id), and what it may do with each (Accept, Decline, Sign, End agreement);
// - the developer's (the app's side): its workspace's apps' agreements with their sponsors and vendors
//   (list_app_agreements with each app's id), and what it may do (Withdraw, Sign, End agreement).
// One row type for both, so one table shows them. Pure, so the route, the view and the tests share it; Mynt checks
// every action again.
import { esignOf, esignStatusLine, type EsignInfo } from "./agreement-esign";
import { AGREEMENT_KIND_LABELS, AGREEMENT_STATUS_LABELS, agreementActions, documentLink, type AgreementAction } from "./app-panel";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// Who answers apps' agreements for a firm: Mynt's licence providers (admins have the role too). Mynt decides what each may do.
export const isLicenceProvider = (roles: readonly string[]) => roles.includes("license_provider");

// The provider's view of a status: what it waits for, from its side.
export const LP_STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed: waiting for your answer",
  accepted: "Accepted: waiting for signatures",
  signed: "Signed",
  declined: "Declined",
  terminated: "Ended",
};

export type AgreementSide = "app" | "counterparty";

export type LpAgreementRow = {
  id: string;
  side: AgreementSide; // which side the signed-in person is on for this row
  proposedBy: AgreementSide; // who proposed it: the other side accepts or declines
  appName: string; // every agreement, MSAs and SLAs too, is for one app
  appId: string | null;
  template: { id: string | null; name: string; version: number | null } | null; // the template (MSA) its document came from
  workspace: string;
  counterparty: string; // the other firm (the licence provider or vendor)
  products: string[];
  kind: string; // the label
  kindKey: string;
  status: string; // in words, from the row's side
  statusKey: string;
  signatures: string | null;
  appSigned: boolean;
  counterpartySigned: boolean;
  from: string | null;
  to: string | null;
  proposedAt: string | null;
  documentUrl: string | null; // https only
  terms: string | null;
  endedReason: string | null;
  actions: AgreementAction[];
  esign: EsignInfo | null; // a program agreement signed by e-signature: Sign opens the signing page; the signed copy
};

/** One agreement as Mynt describes it, read from one side. `app` names the app when the reply doesn't (the app's own list). */
export function agreementRowOf(a: Obj, side: AgreementSide, app?: { id: string; name: string; workspace?: string | null }): LpAgreementRow | null {
  const id = str(a.id);
  if (!id) return null;
  const statusKey = str(a.status) ?? "unknown";
  const sig = isObj(a.signatures) ? a.signatures : {};
  // Where Mynt signs by e-signature, each side's signature is the e-signature document's (the agreement's own are
  // set only once both have signed there).
  const esign = esignOf(a);
  const appSigned = sig.app_side === true || Boolean(esign?.byEsign && esign.appSigned);
  const counterpartySigned = sig.counterparty_side === true || Boolean(esign?.byEsign && esign.counterpartySigned);
  const appObj = isObj(a["app"]) ? a["app"] : {};
  const ws = isObj(a.workspace) ? a.workspace : {};
  const cp = isObj(a.counterparty) ? a.counterparty : {};
  const mine = side === "app" ? appSigned : counterpartySigned;
  const theirs = side === "app" ? counterpartySigned : appSigned;
  const manual = `${mine ? "You signed" : "You haven't signed"}; ${theirs ? (side === "app" ? "they signed" : "the app's side signed") : side === "app" ? "they haven't signed" : "the app's side hasn't signed"}`;
  const proposedBy: AgreementSide = a.proposed_by_side === "counterparty" ? "counterparty" : "app";
  const t = isObj(a.template) ? a.template : null;
  // What the caller may do: Mynt's own list where it gives one (it knows who proposed and who manages), else worked
  // out from the status, the signatures and who proposed.
  const given = Array.isArray(a.actions) ? a.actions.filter((x): x is AgreementAction => ACTIONS.includes(x as AgreementAction)) : null;
  const statusWords = side === "app" ? AGREEMENT_STATUS_LABELS : LP_STATUS_LABELS;
  return {
    id,
    side,
    proposedBy,
    appName: str(appObj.name) ?? app?.name ?? "Unnamed app",
    appId: str(appObj.id) ?? app?.id ?? null,
    template: t && str(t.name) ? { id: str(t.id), name: str(t.name)!, version: typeof t.version === "number" ? t.version : null } : null,
    workspace: str(ws.name) ?? app?.workspace ?? "Unnamed workspace",
    counterparty: str(cp.name) ?? "Unnamed firm",
    products: arr(a.products).map((p) => (isObj(p) ? (str(p.name) ?? str(p.id)) : str(p))).filter((p): p is string => Boolean(p)),
    kind: AGREEMENT_KIND_LABELS[str(a.kind) ?? ""] ?? str(a.kind) ?? "Agreement",
    kindKey: str(a.kind) ?? "",
    // A proposal waits for whichever side didn't make it.
    status: statusKey === "proposed" ? (proposedBy === side ? "Proposed: waiting for them" : "Proposed: waiting for your answer") : (statusWords[statusKey] ?? statusKey),
    statusKey,
    signatures: esign?.byEsign && (statusKey === "accepted" || statusKey === "signed") ? esignStatusLine(esign, side) : statusKey === "accepted" ? manual : null,
    appSigned,
    counterpartySigned,
    from: str(a.effective_from),
    to: str(a.effective_to),
    proposedAt: str(a.proposed_at),
    documentUrl: documentLink(a.document_url),
    terms: str(a.terms_summary),
    endedReason: str(a.termination_reason),
    actions: given ?? agreementActions({ statusKey, appSigned, counterpartySigned, proposedBy }, side),
    esign,
  };
}

const ACTIONS: AgreementAction[] = ["accept", "decline", "sign", "withdraw", "end"];

/** The licence provider's list (list_app_agreements without app_id). */
export function lpAgreementsFrom(reply: unknown): LpAgreementRow[] | null {
  if (!isObj(reply) || !Array.isArray(reply.agreements)) return null;
  return arr(reply.agreements)
    .filter(isObj)
    .flatMap((a) => agreementRowOf(a, "counterparty") ?? []);
}

/**
 * An app's or a workspace's agreements, from the app's side (list_app_agreements with app_id or workspace_id). Only
 * the workspace's owners and admins act: the others read.
 */
export function appAgreementsFrom(reply: unknown, app?: { id: string; name: string; workspace?: string | null }): { rows: LpAgreementRow[]; canManage: boolean } | null {
  if (!isObj(reply) || !Array.isArray(reply.agreements)) return null;
  const canManage = reply.can_manage === true;
  const rows = arr(reply.agreements)
    .filter(isObj)
    .flatMap((a) => agreementRowOf(a, "app", app) ?? [])
    .map((r) => (canManage ? r : { ...r, actions: [] }));
  return { rows, canManage };
}

// Who the Propose agreement sheet can propose to, from the person's side:
// - the app's side (a developer managing the workspace): the firms sponsoring its apps' products (Mynt's
//   proposable_counterparties), each with the apps it could cover;
// - a licence provider: the workspaces whose apps use products its firm sponsors, or that already have an agreement
//   with it (Mynt's proposable_workspaces), each with those apps.
export type ProposeApp = { id: string; name: string; productIds: string[] };
export type ProposeTarget = { side: AgreementSide; id: string; name: string; apps: ProposeApp[] };

export function proposeTargetsFrom(reply: unknown, side: AgreementSide, appNames: Map<string, string> = new Map()): ProposeTarget[] {
  if (!isObj(reply)) return [];
  if (side === "app")
    return arr(reply.proposable_counterparties)
      .filter(isObj)
      .flatMap((c): ProposeTarget[] => {
        const id = str(c.entity_id);
        if (!id) return [];
        const productIds = arr(c.product_ids).map(str).filter((x): x is string => Boolean(x));
        const apps = arr(c.app_ids)
          .map(str)
          .filter((x): x is string => Boolean(x))
          .map((a) => ({ id: a, name: appNames.get(a) ?? "Unnamed app", productIds }));
        return [{ side, id, name: str(c.name) ?? "Unnamed firm", apps }];
      });
  return arr(reply.proposable_workspaces)
    .filter(isObj)
    .flatMap((w): ProposeTarget[] => {
      const ws = isObj(w.workspace) ? w.workspace : {};
      const id = str(ws.id);
      if (!id) return [];
      const apps = arr(w.apps)
        .filter(isObj)
        // The products a program agreement can cover: those of the app the firm sponsors (Mynt's sponsored_product_ids).
        .flatMap((a): ProposeApp[] => (str(a.id) ? [{ id: str(a.id)!, name: str(a.name) ?? "Unnamed app", productIds: arr(Array.isArray(a.sponsored_product_ids) ? a.sponsored_product_ids : a.product_ids).map(str).filter((x): x is string => Boolean(x)) }] : []));
      return [{ side, id, name: str(ws.name) ?? "Unnamed workspace", apps }];
    });
}

// The agreement kinds each tab of the Licences page lists (and proposes).
export const TAB_KINDS = { business: ["program", "data_sharing"], msa: ["msa"], sla: ["sla"] } as const;
// The status filter's choices, in the order an agreement moves through them.
export const LP_STATUS_FILTERS = ["proposed", "accepted", "signed", "declined", "terminated"] as const;

/** A row's key in a list holding both sides (one account can be both sides of an agreement). */
export const rowKey = (r: Pick<LpAgreementRow, "id" | "side">) => `${r.side}:${r.id}`;
