// The risk register an app and a financial product each keep on Mynt (add_risk, update_risk, list_risks), and the
// signals Mynt measures around an app (fraud, vendors, conduct, its products). An app shows them on its
// "Security & risk" tab, a product its register at the top of its Risk tab. Status is always in words, never a
// colour alone; whatever Mynt doesn't measure says so with why, never 0 or an empty table. Pure: the routes read
// Mynt's replies into these shapes, and the views, sheets and tests share them.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export const RISK_CATEGORIES = ["security", "fraud", "vendor", "conduct", "operational", "compliance", "credit", "liquidity", "other"] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  security: "Security",
  fraud: "Fraud",
  vendor: "Vendor",
  conduct: "Conduct",
  operational: "Operational",
  compliance: "Compliance",
  credit: "Credit",
  liquidity: "Liquidity",
  other: "Other",
};
export const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
export const RISK_STATUS_LABELS: Record<RiskStatus, string> = {
  open: "Open: not yet mitigated",
  mitigating: "Mitigating: work under way",
  accepted: "Accepted: living with it",
  closed: "Closed",
};
export const RISK_LEVEL_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
/** A 5×5 score's level, as Mynt grades it: 1-4 low, 5-9 medium, 10-14 high, 15-25 critical. */
export const riskLevel = (score: number) => (score <= 4 ? "low" : score <= 9 ? "medium" : score <= 14 ? "high" : "critical");
export const scoreText = (likelihood: number, impact: number) => `${likelihood} × ${impact} = ${likelihood * impact} (${RISK_LEVEL_LABELS[riskLevel(likelihood * impact)]})`;

export type RiskRow = {
  id: string;
  title: string;
  category: RiskCategory;
  description: string | null;
  likelihood: number;
  impact: number;
  score: number;
  owner: { userId: string; name: string | null } | null;
  mitigation: string | null;
  status: RiskStatus;
  reviewBy: string | null;
  overdue: boolean;
};
// Who may own a risk: the app's workspace members (the product's firm isn't listed: its owner defaults to you).
export type OwnerChoice = { userId: string; name: string };
export type RiskRegister = { available: true; canManage: boolean; risks: RiskRow[]; overdue: number; owners: OwnerChoice[] };
export type Unavailable = { available: false; reason: string };
export const unavailable = (reason: string): Unavailable => ({ available: false, reason });

const isCategory = (v: unknown): v is RiskCategory => typeof v === "string" && (RISK_CATEGORIES as readonly string[]).includes(v);
const isStatus = (v: unknown): v is RiskStatus => typeof v === "string" && (RISK_STATUSES as readonly string[]).includes(v);

export function riskRowsFrom(v: unknown): RiskRow[] {
  return arr(v)
    .filter(isObj)
    .flatMap((r): RiskRow[] => {
      const id = str(r.id);
      const title = str(r.title);
      const likelihood = int(r.likelihood);
      const impact = int(r.impact);
      if (!id || !title || likelihood === null || impact === null || !isCategory(r.category) || !isStatus(r.status)) return [];
      const owner = isObj(r.owner) && str(r.owner.user_id) ? { userId: str(r.owner.user_id)!, name: str(r.owner.name) } : null;
      return [{ id, title, category: r.category, description: str(r.description), likelihood, impact, score: likelihood * impact, owner, mitigation: str(r.mitigation), status: r.status, reviewBy: str(r.review_by), overdue: r.overdue === true }];
    });
}

/** list_risks' reply, or null when it isn't one. */
export function registerFrom(reply: unknown, owners: OwnerChoice[] = []): RiskRegister | null {
  if (!isObj(reply) || !Array.isArray(reply.risks)) return null;
  const risks = riskRowsFrom(reply.risks);
  const counts = isObj(reply.counts) ? reply.counts : {};
  return { available: true, canManage: reply.can_manage === true, risks, overdue: int(counts.overdue) ?? risks.filter((r) => r.overdue).length, owners };
}

// ---- the signals around an app ----

export type SignalRow = { key: string; cells: string[] };
export type Signal = { available: true; rows: SignalRow[] } | Unavailable;

const when = (iso: string | null) => (iso ? iso.replace("T", " ").slice(0, 16) : "—");
const ISSUES: Record<string, string> = {
  conformance_failed: "Conformance failing",
  erroring: "Calls erroring",
  subscription_ended: "Subscription ended",
  contract_ended: "Contract ended",
  paused_by_covenant: "Sales paused by a covenant",
  drifted: "Drifted",
};

function signal(v: unknown, cells: (r: Obj) => string[], key: (r: Obj, i: number) => string): Signal {
  if (!isObj(v)) return unavailable("Mynt didn't send this.");
  if (v.available !== true) return unavailable(str(v.reason) ?? "Mynt doesn't measure this yet.");
  return { available: true, rows: arr(v.rows).filter(isObj).map((r, i) => ({ key: key(r, i), cells: cells(r) })) };
}

export const SIGNAL_COLUMNS = {
  vendors: ["Vendor", "Service", "Issue", "Detail", "Since"],
  conduct: ["Finding", "Audit", "Severity", "Since"],
  products: ["Product", "Issue", "Detail", "Since"],
  fraud: ["Signal", "Detail"],
} as const;

export type AppSignals = { fraud: Signal; vendors: Signal; conduct: Signal; products: Signal };

/** list_risks' signals for an app. Each one Mynt doesn't measure stays not available, with its reason. */
export function signalsFrom(reply: unknown): AppSignals {
  const s = isObj(reply) && isObj(reply.signals) ? reply.signals : null;
  if (!s) {
    const none = unavailable("Mynt didn't send the app's risk signals.");
    return { fraud: none, vendors: none, conduct: none, products: none };
  }
  return {
    fraud: signal(s.fraud, (r) => [str(r.signal) ?? "Signal", str(r.detail) ?? "—"], (r, i) => str(r.id) ?? String(i)),
    vendors: signal(
      s.vendors,
      (r) => [str(r.vendor) ?? "Unnamed vendor", str(r.offering) ?? "—", ISSUES[str(r.issue) ?? ""] ?? str(r.issue) ?? "—", str(r.detail) ?? "—", when(str(r.since))],
      (r, i) => `${str(r.subscription_id) ?? str(r.agreement_id) ?? "v"}:${str(r.issue) ?? ""}:${i}`,
    ),
    conduct: signal(
      s.conduct,
      (r) => [str(r.finding) ?? "Finding", [str(r.kind) === "complaints" ? "Complaints audit" : str(r.kind) === "marketing" ? "Marketing audit" : (str(r.kind) ?? "Audit"), str(r.requirement)].filter(Boolean).join(": "), str(r.severity) ?? "Not graded", when(str(r.since))],
      (r, i) => `${str(r.audit_id) ?? "a"}:${i}`,
    ),
    products: signal(s.products, (r) => [str(r.name) ?? str(r.product_id) ?? "Product", ISSUES[str(r.issue) ?? ""] ?? str(r.issue) ?? "—", str(r.detail) ?? "—", when(str(r.since))], (r, i) => `${str(r.product_id) ?? "p"}:${str(r.issue) ?? ""}:${i}`),
  };
}

/** What a register's sheets send: Add risk (add) or Review risk (review). The route adds the subject. */
export type RiskChange =
  | { action: "add"; title: string; category: RiskCategory; likelihood: number; impact: number; description?: string; mitigation?: string; owner_user_id?: string; review_by?: string }
  | { action: "review"; risk_id: string; status?: RiskStatus; mitigation?: string; likelihood?: number; impact?: number; owner_user_id?: string; review_by?: string; note?: string };
