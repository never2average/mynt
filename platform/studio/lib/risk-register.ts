// The risk register an app and a financial product each keep on Mynt (add_risk, update_risk, list_risks), and the
// signals Mynt measures around an app (fraud, vendors, conduct, its products). An app shows them on its
// "Security & risk" tab, a product its register at the top of its Risk tab. Every risk carries three scores: inherent
// (likelihood × impact), control (how well its controls work: none, weak, partial, strong, or "Not assessed") and
// residual (derived by the platform's grading, or the keeper's own; "same as inherent" until the control is
// assessed), each with its level in words. Status is always in words, never a colour alone; whatever Mynt doesn't measure says so with why, never 0 or an empty table. Pure: the routes read
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
// The platform's seven risk areas (core/src/risk-register-schema.ts): the tabs of the platform admin's Risk models and
// Risk register, in this order. A risk's fine-grained category falls under one by default (other under none:
// unassigned until a review gives it one), as Mynt backfilled the risks made before areas existed.
export const RISK_AREAS = ["financial", "compliance", "third_party", "operations", "business_process", "technology", "regulated_product"] as const;
export type RiskArea = (typeof RISK_AREAS)[number];
export const RISK_AREA_LABELS: Record<RiskArea, string> = {
  financial: "Financial risk",
  compliance: "Compliance risk",
  third_party: "Third-party risk",
  operations: "Operations risk",
  business_process: "Business process risk",
  technology: "Technology risk",
  regulated_product: "Regulated product risk",
};
export const RISK_AREA_OF_CATEGORY: Record<RiskCategory, RiskArea | null> = {
  credit: "financial",
  liquidity: "financial",
  compliance: "compliance",
  conduct: "compliance",
  vendor: "third_party",
  operational: "operations",
  fraud: "operations",
  security: "technology",
  other: null,
};
export const isRiskArea = (v: unknown): v is RiskArea => typeof v === "string" && (RISK_AREAS as readonly string[]).includes(v);
/** A risk's area: the one Mynt gave it, else its category's (an older Mynt that sends none). */
export const areaOfRisk = (r: { riskArea?: RiskArea | null; category: string }): RiskArea | null =>
  r.riskArea !== undefined ? r.riskArea : (RISK_AREA_OF_CATEGORY[r.category as RiskCategory] ?? null);
export const areaWords = (a: RiskArea | null | undefined) => (a ? RISK_AREA_LABELS[a] : "Unassigned");

export const RISK_LEVEL_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", critical: "Critical" };
/** A 5×5 score's level, as Mynt grades it: 1-4 low, 5-9 medium, 10-14 high, 15-25 critical. */
export const riskLevel = (score: number) => (score <= 4 ? "low" : score <= 9 ? "medium" : score <= 14 ? "high" : "critical");
export const scoreText = (likelihood: number, impact: number) => `${likelihood} × ${impact} = ${likelihood * impact} (${RISK_LEVEL_LABELS[riskLevel(likelihood * impact)]})`;

// Three-step scoring (core/src/risk-grading.ts). The levels, lowest first, and the control's four steps.
export const RISK_LEVELS_ASC = ["low", "medium", "high", "critical"] as const;
export type RiskLevelKey = (typeof RISK_LEVELS_ASC)[number];
export const CONTROL_STEPS = ["none", "weak", "partial", "strong"] as const;
export type ControlStep = (typeof CONTROL_STEPS)[number];
export const CONTROL_STEP_LABELS: Record<ControlStep, string> = { none: "None", weak: "Weak", partial: "Partial", strong: "Strong" };
export const NOT_ASSESSED = "Not assessed";
export const isLevel = (v: unknown): v is RiskLevelKey => typeof v === "string" && (RISK_LEVELS_ASC as readonly string[]).includes(v);
export const isControlStep = (v: unknown): v is ControlStep => typeof v === "string" && (CONTROL_STEPS as readonly string[]).includes(v);
export type Graded = { score: number; level: RiskLevelKey; levelName: string };
export type RiskScores = {
  inherent: Graded;
  control: { effectiveness: ControlStep | null; note: string | null };
  // assessed false: the control isn't assessed and nothing overrides it, so this is the inherent score.
  residual: Graded & { assessed: boolean; overridden: boolean; likelihood: number | null; impact: number | null; why: string | null };
};
/** "4 × 3 = 12 (High)": the inherent score, with its level in words. */
export const inherentWords = (r: { likelihood: number; impact: number } & RiskScores) => `${r.likelihood} × ${r.impact} = ${r.inherent.score} (${r.inherent.levelName})`;
/** "Strong", or "Not assessed": never a blank, never a 0. */
export const controlWords = (r: RiskScores) => (r.control.effectiveness ? CONTROL_STEP_LABELS[r.control.effectiveness] : NOT_ASSESSED);
/** "6 (Medium)"; "overridden" when the keeper set it; "same as inherent" while the control isn't assessed. */
export const residualWords = (r: RiskScores) =>
  `${r.residual.score} (${r.residual.levelName})${r.residual.overridden ? ", overridden" : r.residual.assessed ? "" : ", same as inherent: control not assessed"}`;

/** A risk's three scores as Mynt sent them; from an older Mynt that sends only likelihood and impact, the inherent
 * score by Mynt's default bands, the control not assessed and the residual the same as inherent. */
export function scoresFrom(r: Record<string, unknown>, likelihood: number, impact: number): RiskScores {
  const graded = (v: unknown, fallback: number): Graded => {
    const o = isObj(v) ? v : {};
    const score = int(o.score) ?? fallback;
    const level = isLevel(o.level) ? o.level : (riskLevel(score) as RiskLevelKey);
    return { score, level, levelName: str(o.level_name) ?? RISK_LEVEL_LABELS[level] };
  };
  const inherent = graded(r.inherent, likelihood * impact);
  const c = isObj(r.control) ? r.control : {};
  const res = isObj(r.residual) ? r.residual : {};
  const override = isObj(res.override) ? res.override : null;
  const overridden = res.overridden === true;
  return {
    inherent,
    control: { effectiveness: isControlStep(c.effectiveness) ? c.effectiveness : null, note: str(c.note) },
    residual: { ...graded(r.residual, inherent.score), assessed: res.assessed === true, overridden, likelihood: overridden ? int(res.likelihood) : null, impact: overridden ? int(res.impact) : null, why: override ? str(override.why) : null },
  };
}

export type RiskRow = {
  id: string;
  title: string;
  category: RiskCategory;
  riskArea?: RiskArea | null; // undefined: Mynt didn't say (an older Mynt); null: unassigned
  description: string | null;
  likelihood: number;
  impact: number;
  score: number;
  owner: { userId: string; name: string | null } | null;
  mitigation: string | null;
  status: RiskStatus;
  reviewBy: string | null;
  overdue: boolean;
} & RiskScores;
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
      const riskArea = "risk_area" in r ? (isRiskArea(r.risk_area) ? r.risk_area : null) : undefined;
      return [{ id, title, category: r.category, ...(riskArea !== undefined ? { riskArea } : {}), description: str(r.description), likelihood, impact, score: likelihood * impact, owner, mitigation: str(r.mitigation), status: r.status, reviewBy: str(r.review_by), overdue: r.overdue === true, ...scoresFrom(r, likelihood, impact) }];
    })
    .sort(byResidual);
}
/** Highest residual score first, then the highest inherent score. */
export const byResidual = (a: RiskScores, b: RiskScores) => b.residual.score - a.residual.score || b.inherent.score - a.inherent.score;

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
  | { action: "add"; title: string; category: RiskCategory; risk_area?: RiskArea; likelihood: number; impact: number; description?: string; mitigation?: string; owner_user_id?: string; review_by?: string; control_effectiveness?: ControlStep; control_note?: string }
  | {
      action: "review";
      risk_id: string;
      status?: RiskStatus;
      risk_area?: RiskArea;
      mitigation?: string;
      likelihood?: number;
      impact?: number;
      owner_user_id?: string;
      review_by?: string;
      control_effectiveness?: ControlStep;
      control_note?: string;
      residual_likelihood?: number;
      residual_impact?: number;
      residual_override_reason?: string;
      clear_residual_override?: true;
      note?: string;
    };
