// Promotions: an app moves Ideas -> Staging -> Production only through Mynt's checks
// (get_promotion_checks), never by dragging it between folders. Mynt decides whether it may move
// (can_promote) and whether an admin must sign it off; the studio shows each check and its fix.
// Pure, so the routes, the views and the tests share it.
import { isStudioPath } from "./studio-search";
import { canManageMembers, type Role, type Stage } from "./workspaces";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export type PromotionTarget = "staging" | "production";
export type DemotionTarget = "idea" | "staging";
export const CHECK_STATUSES = ["pass", "fail", "warn", "pending"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

// Red, amber, green, always named in words too.
export const CHECK_LABELS: Record<CheckStatus, string> = { pass: "Passed", fail: "Failing", warn: "Warning", pending: "Pending" };
export const CHECK_TONE: Record<CheckStatus, "green" | "amber" | "red"> = { pass: "green", warn: "amber", pending: "amber", fail: "red" };

// A fix: a link (a studio page, or an https page) and/or a Mynt tool that fixes it.
export type CheckFix = { label: string; href: string | null; external: boolean; tool: string | null };
export type PromotionCheck = { id: string; label: string; status: CheckStatus; detail: string | null; fix: CheckFix | null };
export type Signoff = { status: "none" | "requested" | "approved" | "rejected"; by: string | null; at: string | null };

export type PromotionChecks = {
  appId: string;
  fromStage: Stage | null;
  toStage: PromotionTarget;
  checks: PromotionCheck[];
  canPromote: boolean;
  needsAdminSignoff: boolean;
  signoff: Signoff | null;
};

// The tools a promotion needs, and the ones that are optional extras.
export const PROMOTION_TOOLS = { checks: "get_promotion_checks", promote: "promote_app", demote: "demote_app", signoff: "request_promotion_signoff" } as const;
export type PromotionSupport = { checks: boolean; promote: boolean; demote: boolean; signoff: boolean };

export function promotionSupport(tools: { name: string }[]): PromotionSupport {
  const has = (n: string) => tools.some((t) => t.name === n);
  return { checks: has(PROMOTION_TOOLS.checks), promote: has(PROMOTION_TOOLS.promote), demote: has(PROMOTION_TOOLS.demote), signoff: has(PROMOTION_TOOLS.signoff) };
}

// Where an app goes next, and where it can be moved back to.
export function nextStage(stage: Stage): PromotionTarget | null {
  return stage === "idea" ? "staging" : stage === "staging" ? "production" : null;
}
export function earlierStages(stage: Stage): DemotionTarget[] {
  return stage === "production" ? ["staging", "idea"] : stage === "staging" ? ["idea"] : [];
}
export const STAGE_NAMES: Record<Stage, string> = { idea: "Ideas", staging: "Staging", production: "Production" };

// Only a workspace's owners and admins promote or move back its apps (Mynt checks again).
export const canChangeStage = (role: Role | undefined) => canManageMembers(role);

const STAGE_SET = new Set<string>(["idea", "staging", "production"]);

function fixOf(v: unknown): CheckFix | null {
  if (!isObj(v)) return null;
  const label = str(v.label);
  if (!label) return null;
  const raw = str(v.href);
  let href: string | null = null;
  let external = false;
  if (raw && isStudioPath(raw)) href = raw;
  else if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && !u.username && !u.password) {
        href = u.toString();
        external = true;
      }
    } catch {
      href = null;
    }
  }
  const tool = str(v.tool);
  return href || tool ? { label: label.slice(0, 120), href, external, tool: tool && /^[a-z][a-z0-9_]{0,63}$/.test(tool) ? tool : null } : null;
}

function signoffOf(v: unknown): Signoff | null {
  if (!isObj(v)) return null;
  const status = (["none", "requested", "approved", "rejected"] as const).find((s) => s === v.status);
  return status ? { status, by: str(v.by), at: str(v.at) } : null;
}

// get_promotion_checks' reply; null when it isn't one.
export function fromPromotionChecks(reply: unknown, toStage: PromotionTarget): PromotionChecks | null {
  if (!isObj(reply) || !Array.isArray(reply.checks)) return null;
  const checks = reply.checks.filter(isObj).flatMap((c, i): PromotionCheck[] => {
    const label = str(c.label);
    if (!label) return [];
    const status = CHECK_STATUSES.find((s) => s === c.status) ?? "pending";
    return [{ id: str(c.id) ?? `check-${i}`, label, status, detail: str(c.detail), fix: status === "pass" ? null : fixOf(c.fix) }];
  });
  const from = str(reply.from_stage);
  return {
    appId: str(reply.app_id) ?? "",
    fromStage: from && STAGE_SET.has(from) ? (from as Stage) : null,
    toStage: reply.to_stage === "staging" || reply.to_stage === "production" ? reply.to_stage : toStage,
    checks,
    // Mynt's word only; a failing check never shows as promotable, whatever the flag says.
    canPromote: reply.can_promote === true && !checks.some((c) => c.status === "fail"),
    needsAdminSignoff: reply.needs_admin_signoff === true,
    signoff: signoffOf(reply.signoff),
  };
}

// One line for an app's readiness, for the dashboard's Apps by stage.
export type Readiness = { toStage: PromotionTarget; canPromote: boolean; failing: number; open: number; needsSignoff: boolean; signoff: Signoff["status"] | null };

export function readinessOf(c: PromotionChecks): Readiness {
  return {
    toStage: c.toStage,
    canPromote: c.canPromote,
    failing: c.checks.filter((x) => x.status === "fail").length,
    open: c.checks.filter((x) => x.status === "warn" || x.status === "pending").length,
    needsSignoff: c.needsAdminSignoff,
    signoff: c.signoff?.status ?? null,
  };
}

export function readinessText(r: Readiness): string {
  const to = STAGE_NAMES[r.toStage];
  if (r.failing) return `${r.failing} check${r.failing === 1 ? "" : "s"} failing for ${to}`;
  if (r.needsSignoff && r.signoff !== "approved") return r.signoff === "requested" ? `Waiting for admin sign-off for ${to}` : `Needs admin sign-off for ${to}`;
  if (r.canPromote) return `Ready for ${to}`;
  if (r.open) return `${r.open} check${r.open === 1 ? "" : "s"} still open for ${to}`;
  return `Not ready for ${to} yet`;
}
