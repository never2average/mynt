// The licence provider's side of app agreements (the Licences page's Agreements tab): what apps' workspaces
// proposed to or made with the provider's firm (list_app_agreements without app_id), and what it may do with each
// (Accept, Decline, Sign, End agreement). Pure, so the route, the view and the tests share it; Mynt checks every
// action again.
import { AGREEMENT_KIND_LABELS, agreementActions, documentLink, type AgreementAction } from "./app-panel";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// Who sees the tab: Mynt's licence providers (admins have the role too). Mynt decides what each may do.
export const isLicenceProvider = (roles: readonly string[]) => roles.includes("license_provider");

// The provider's view of a status: what it waits for, from its side.
export const LP_STATUS_LABELS: Record<string, string> = {
  proposed: "Proposed: waiting for your answer",
  accepted: "Accepted: waiting for signatures",
  signed: "Signed",
  declined: "Declined",
  terminated: "Ended",
};

export type LpAgreementRow = {
  id: string;
  appName: string;
  appId: string | null;
  workspace: string;
  products: string[];
  kind: string; // the label
  kindKey: string;
  status: string; // in words
  statusKey: string;
  signatures: string | null;
  from: string | null;
  to: string | null;
  proposedAt: string | null;
  documentUrl: string | null; // https only
  terms: string | null;
  endedReason: string | null;
  actions: AgreementAction[];
};

export function lpAgreementsFrom(reply: unknown): LpAgreementRow[] | null {
  if (!isObj(reply) || !Array.isArray(reply.agreements)) return null;
  return arr(reply.agreements)
    .filter(isObj)
    .flatMap((a): LpAgreementRow[] => {
      const id = str(a.id);
      if (!id) return [];
      const statusKey = str(a.status) ?? "unknown";
      const sig = isObj(a.signatures) ? a.signatures : {};
      const appSigned = sig.app_side === true;
      const counterpartySigned = sig.counterparty_side === true;
      const app = isObj(a["app"]) ? a["app"] : {};
      const ws = isObj(a.workspace) ? a.workspace : {};
      return [
        {
          id,
          appName: str(app.name) ?? "Unnamed app",
          appId: str(app.id),
          workspace: str(ws.name) ?? "Unnamed workspace",
          products: arr(a.products).map((p) => (isObj(p) ? (str(p.name) ?? str(p.id)) : str(p))).filter((p): p is string => Boolean(p)),
          kind: AGREEMENT_KIND_LABELS[str(a.kind) ?? ""] ?? str(a.kind) ?? "Agreement",
          kindKey: str(a.kind) ?? "",
          status: LP_STATUS_LABELS[statusKey] ?? statusKey,
          statusKey,
          signatures: statusKey === "accepted" ? `${counterpartySigned ? "You signed" : "You haven't signed"}; ${appSigned ? "the app's side signed" : "the app's side hasn't signed"}` : null,
          from: str(a.effective_from),
          to: str(a.effective_to),
          proposedAt: str(a.proposed_at),
          documentUrl: documentLink(a.document_url),
          terms: str(a.terms_summary),
          endedReason: str(a.termination_reason),
          actions: agreementActions({ statusKey, appSigned, counterpartySigned }, "counterparty"),
        },
      ];
    });
}

// The status filter's choices, in the order an agreement moves through them.
export const LP_STATUS_FILTERS = ["proposed", "accepted", "signed", "declined", "terminated"] as const;
