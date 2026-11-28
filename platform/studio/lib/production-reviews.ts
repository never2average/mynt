// Production code reviews, as the studio shows them: Mynt's full agent code review of one verified build, which a
// build needs before it goes to Production (Mynt's list_production_reviews and get_production_review). Read here
// from Mynt's answers, field by field; anything Mynt didn't measure is null and shown as "Not measured", never 0.
//
// Where they show: an app's (and a service's) Security & risk tab, as a table with a labelled Request production
// review button opening a sheet; and the platform admin's Audit trails → Production reviews tab, across workspaces,
// with Stop review and Record exception.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

export const REVIEW_STATUSES = ["queued", "running", "complete", "incomplete", "refused", "failed", "stopped"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  incomplete: "Incomplete",
  refused: "Refused by the model provider",
  failed: "Failed",
  stopped: "Stopped",
};
export const REVIEW_TONE: Record<ReviewStatus, "good" | "bad" | "warn" | "wait"> = { queued: "wait", running: "wait", complete: "good", incomplete: "bad", refused: "bad", failed: "bad", stopped: "warn" };
export const isActive = (s: ReviewStatus) => s === "queued" || s === "running";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type SeverityCounts = Record<Severity, number>;

export type ReviewCoverage = {
  reviewed: string[];
  notReviewed: { workflow: string; kind: string | null; reason: string | null }[];
};
export type ReviewFinding = { severity: string; title: string; file: string | null; workflow: string | null };
export type ReviewLimits = { workflows: string[]; minutes: number | null; capUsd: number | null; model: string | null };
export type ReviewWaiver = { appId: string; buildId: string; reason: string; by: string | null; at: string | null };

export type ProductionReview = {
  id: string;
  appId: string;
  appName: string | null;
  appKind: "app" | "service";
  workspaceId: string | null;
  workspaceName: string | null;
  buildId: string;
  commit: string | null;
  status: ReviewStatus;
  // Counts by severity from the report so far; null when no report was written.
  findings: SeverityCounts | null;
  coverage: ReviewCoverage | null;
  costUsd: number | null;
  seconds: number | null;
  limits: ReviewLimits;
  reason: string | null;
  nextStep: string | null;
  startedBy: string | null;
  byMyntAdmin: boolean;
  at: string;
  finishedAt: string | null;
  // Only on one review read by itself (get_production_review).
  findingList: ReviewFinding[] | null;
  waiver: ReviewWaiver | null;
};

export type ReviewableBuild = { id: string; verifiedAt: string | null; commit: string | null; reviewStatus: ReviewStatus | null };
export type ProductionReviews = {
  available: true;
  reviews: ProductionReview[];
  waivers: ReviewWaiver[];
  // What a review asked for now would run with, and the workspace's monthly limits.
  limits: ReviewLimits & { workspaceMonthly: number | null; workspaceMonthlyUsd: number | null };
  // Whether reviews can run on this Mynt at all.
  canRun: boolean;
  // For one app: the verified builds a review can be asked for, whether this person may ask, and what the workspace
  // has used this month. Null across workspaces.
  builds: ReviewableBuild[] | null;
  canRequest: boolean;
  usage: { month: string | null; reviews: number | null; usd: number | null } | null;
};
export type ReviewsUnavailable = { available: false; reason: string };
export const NO_REVIEWS_YET = "Production code reviews come with Mynt's next update.";

const statusOf = (v: unknown): ReviewStatus | null => ((REVIEW_STATUSES as readonly string[]).includes(v as string) ? (v as ReviewStatus) : null);

function countsFrom(v: unknown): SeverityCounts | null {
  if (!isObj(v)) return null;
  const out = {} as SeverityCounts;
  for (const s of SEVERITIES) {
    const n = num(v[s]);
    if (n === null) return null;
    out[s] = n;
  }
  return out;
}

function coverageFrom(v: unknown): ReviewCoverage | null {
  if (!isObj(v)) return null;
  return {
    reviewed: arr(v.reviewed).filter((w): w is string => typeof w === "string"),
    notReviewed: arr(v.not_reviewed)
      .filter(isObj)
      .flatMap((s) => (str(s.workflow) ? [{ workflow: str(s.workflow)!, kind: str(s.kind), reason: str(s.reason) }] : [])),
  };
}

const limitsFrom = (v: unknown): ReviewLimits => {
  const l = isObj(v) ? v : {};
  return { workflows: arr(l.workflows).filter((w): w is string => typeof w === "string"), minutes: num(l.minutes), capUsd: num(l.cap_usd), model: str(l.model) };
};

function waiverFrom(v: unknown): ReviewWaiver | null {
  if (!isObj(v)) return null;
  const appId = str(v.app_id);
  const buildId = str(v.build_id);
  const reason = str(v.reason);
  if (!appId || !buildId || !reason) return null;
  return { appId, buildId, reason, by: isObj(v.waived_by) ? (str(v.waived_by.name) ?? str(v.waived_by.id)) : null, at: str(v.at) };
}

export function reviewFrom(v: unknown): ProductionReview | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  const appId = str(v.app_id);
  const buildId = str(v.build_id);
  const status = statusOf(v.status);
  const at = str(v.created_at);
  if (!id || !appId || !buildId || !status || !at) return null;
  const by = isObj(v.requested_by) ? v.requested_by : null;
  return {
    id,
    appId,
    appName: str(v.app_name),
    appKind: v.app_kind === "service" ? "service" : "app",
    workspaceId: str(v.workspace_id),
    workspaceName: str(v.workspace_name),
    buildId,
    commit: str(v.commit_sha),
    status,
    findings: countsFrom(v.findings),
    coverage: coverageFrom(v.coverage),
    costUsd: num(v.cost_usd),
    seconds: num(v.seconds),
    limits: limitsFrom(v.limits),
    reason: str(v.reason),
    nextStep: str(v.next_step),
    startedBy: by ? (by.mynt_admin === true ? `${str(by.name) ?? "A Mynt admin"} (Mynt admin)` : (str(by.name) ?? str(by.id))) : null,
    byMyntAdmin: by?.mynt_admin === true,
    at,
    finishedAt: str(v.finished_at),
    findingList: Array.isArray(v.finding_list)
      ? v.finding_list.filter(isObj).map((f) => ({ severity: str(f.severity) ?? "unrated", title: str(f.title) ?? "Untitled finding", file: str(f.file), workflow: str(f.workflow) }))
      : null,
    waiver: waiverFrom(v.waiver),
  };
}

/** Mynt's list_production_reviews answer, or null when it isn't one. */
export function reviewsFrom(reply: unknown): ProductionReviews | null {
  if (!isObj(reply) || !Array.isArray(reply.reviews)) return null;
  const l = isObj(reply.limits) ? reply.limits : {};
  const u = isObj(reply.workspace_usage) ? reply.workspace_usage : null;
  return {
    available: true,
    reviews: reply.reviews.map(reviewFrom).filter((r): r is ProductionReview => r !== null),
    waivers: arr(reply.waivers).map(waiverFrom).filter((w): w is ReviewWaiver => w !== null),
    limits: { ...limitsFrom(l), workspaceMonthly: num(l.workspace_monthly_reviews), workspaceMonthlyUsd: num(l.workspace_monthly_usd) },
    canRun: reply.available === true,
    builds: Array.isArray(reply.builds)
      ? reply.builds.filter(isObj).flatMap((b) => (str(b.id) ? [{ id: str(b.id)!, verifiedAt: str(b.verified_at), commit: str(b.commit_sha), reviewStatus: statusOf(b.review_status) }] : []))
      : null,
    canRequest: reply.can_request === true,
    usage: u ? { month: str(u.month), reviews: num(u.reviews), usd: num(u.usd) } : null,
  };
}

// What the studio's own routes answer with (a review, or the list, already read from Mynt as above): taken as it
// is when it has a review's shape, null otherwise.
export const sentReview = (v: unknown): ProductionReview | null =>
  isObj(v) && str(v.id) && str(v.appId) && str(v.buildId) && statusOf(v.status) && isObj(v.limits) ? (v as unknown as ProductionReview) : null;
export const sentReviews = (v: unknown): ProductionReviews | null =>
  isObj(v) && v.available === true && Array.isArray(v.reviews) && Array.isArray(v.waivers) && isObj(v.limits) && v.reviews.every((r) => sentReview(r) !== null) ? (v as unknown as ProductionReviews) : null;

// ---- words ----

export const NOT_MEASURED = "Not measured";
export const shortId = (id: string) => id.slice(0, 8);
const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
/** Dollars Mynt measured, or "Not measured": never $0.00 for want of a measurement. */
export const usdText = (n: number | null) => (n === null ? NOT_MEASURED : USD.format(n));
/** How long a review ran, or "Not measured" when it never started. */
export function durationText(seconds: number | null): string {
  if (seconds === null) return NOT_MEASURED;
  const m = Math.round(seconds / 60);
  if (m < 1) return "Under a minute";
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** "1 critical, 2 high, 0 medium, 3 low", or "Not measured" when the review wrote no report. */
export const findingsText = (c: SeverityCounts | null) => (c === null ? NOT_MEASURED : SEVERITIES.map((s) => `${c[s]} ${s}`).join(", "));
/** Which parts were reviewed and which weren't, or "Not measured". */
export function coverageText(c: ReviewCoverage | null): string {
  if (c === null) return NOT_MEASURED;
  const parts = [c.reviewed.length ? `Reviewed: ${c.reviewed.join(", ")}` : "", c.notReviewed.length ? `Not finished: ${c.notReviewed.map((s) => (s.kind ? `${s.workflow} (${s.kind})` : s.workflow)).join(", ")}` : ""].filter(Boolean);
  return parts.length ? parts.join(". ") : "Nothing reviewed yet";
}
export const whenText = (iso: string | null) => (iso ? `${iso.replace("T", " ").slice(0, 16)} UTC` : "—");

/** What the request sheet says a review may take and cost, from the limits in force. */
export function limitWords(l: ProductionReviews["limits"]): { time: string; cost: string; what: string; monthly: string } {
  return {
    time: l.minutes === null ? NOT_MEASURED : `Up to ${durationText(l.minutes * 60)}`,
    cost: l.capUsd === null ? NOT_MEASURED : `At most ${USD.format(l.capUsd)}, paid by Mynt (not your build budget)`,
    what: l.workflows.length ? l.workflows.join(", ") : NOT_MEASURED,
    monthly:
      l.workspaceMonthly === null || l.workspaceMonthlyUsd === null
        ? NOT_MEASURED
        : `${l.workspaceMonthly} reviews and ${USD.format(l.workspaceMonthlyUsd)} per workspace per calendar month`,
  };
}

/** The build's waiver, if a Mynt admin recorded one. */
export const waiverOf = (waivers: ReviewWaiver[], appId: string, buildId: string) => waivers.find((w) => w.appId === appId && w.buildId === buildId) ?? null;
export const waiverWords = (w: ReviewWaiver) => `Waived by a Mynt admin: ${w.reason}${w.by || w.at ? ` (${[w.by, w.at?.slice(0, 10)].filter(Boolean).join(", ")})` : ""}`;

export const REVIEW_TABLE_HEAD = ["Build", "Status", "Findings by severity", "Coverage", "Cost", "Time", "Started by", "When"] as const;
export const FINDING_TABLE_HEAD = ["Severity", "Finding", "File", "Workflow"] as const;
