// What Mynt's records say about a build's production code review (production-reviews.ts): read here, from the tables
// alone, so the promotion checks (promotions.ts) read them without the service that runs reviews.
import type { Db } from "./db.js";

const T = "financial_products";
type Q = Pick<Db, "query">;
type Row = Record<string, unknown>;

export const PRODUCTION_REVIEW_STATUSES = ["queued", "running", "complete", "incomplete", "refused", "failed", "stopped"] as const;
export type ProductionReviewStatus = (typeof PRODUCTION_REVIEW_STATUSES)[number];
export const REVIEW_ACTIVE: ProductionReviewStatus[] = ["queued", "running"];
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type SeverityCounts = Record<(typeof SEVERITIES)[number], number>;

/** A report's counts by severity, or null when it has none: no report was written, so nothing was measured. */
export function reviewCounts(report: unknown): SeverityCounts | null {
  const c = report && typeof report === "object" ? (report as { counts?: unknown }).counts : null;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const n = (k: string) => {
    const v = Number((c as Row)[k]);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  return { critical: n("critical"), high: n("high"), medium: n("medium"), low: n("low") };
}
export const seriousOf = (report: unknown) => {
  const c = reviewCounts(report);
  return c ? c.critical + c.high : 0;
};

export interface ReviewStanding {
  // The review that counts for this build: its complete one if it has one, else the latest asked for.
  review: Row | undefined;
  // A Mynt admin's recorded exception for this build, with who gave it.
  waiver: (Row & { waived_by_name: string | null }) | undefined;
}

/** Where one build of an app stands: the review that counts for it, and any waiver. */
export async function reviewStanding(q: Q, appId: string, buildId: string): Promise<ReviewStanding> {
  const review = (
    await q.query(`SELECT * FROM ${T}.production_reviews WHERE app_id = $1 AND build_id = $2 ORDER BY (status = 'complete') DESC, created_at DESC LIMIT 1`, [appId, buildId])
  ).rows[0] as Row | undefined;
  const waiver = (
    await q.query(
      `SELECT w.*, u.name AS waived_by_name FROM ${T}.production_review_waivers w LEFT JOIN ${T}.users u ON u.id = w.waived_by WHERE w.app_id = $1 AND w.build_id = $2`,
      [appId, buildId],
    )
  ).rows[0] as ReviewStanding["waiver"];
  return { review, waiver };
}
