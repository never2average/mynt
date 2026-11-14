import { z } from "zod";
import { isCalendarDate } from "./compliance";

// Which of Mynt's tools the studio may call for the signed-in user, with what arguments. Mynt
// checks everything again (who owns what, roles, limits); these keep junk off the wire and keep
// the studio to its job. Anything not listed (vm_access, app_run, admin tools...) can't be
// called from the studio at all.
//
// Writing tools join the list with the screens that use them. The chat starts and steers
// builds, New app creates apps, the dashboard's Connect repository connects repositories and the app's stage
// control promotes; shipping (finish_build), stopping, sandbox commands and hosting changes
// come later.

const id = z.string().trim().min(1).max(200);
// A compose app's service (e.g. api or web), as Mynt checks it (src/hosting-tools.ts).
const service = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/).optional();
const workspaceId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const workspaceName = z.string().trim().min(1).max(80);
// Roles given from the studio; ownership isn't handed over here.
const memberRole = z.enum(["admin", "member"]);
const auditDate = z.string().refine(isCalendarDate, "a real YYYY-MM-DD date");
// Where an app can be promoted to, and moved back to.
const promotionStage = z.enum(["staging", "production"]);
const demotionStage = z.enum(["idea", "staging"]);
// Liquidity: Mynt's pool ids, integer cents, a US state as ISO 3166-2 and an idempotency key.
const uuid = z.string().uuid();
const cents = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const usState = z.string().regex(/^us-[a-z]{2}$/);
const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,200}$/);
const repository = z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name");

export const STUDIO_TOOLS = {
  // apps and catalogue
  whoami: z.object({}).strict(),
  list_my_apps: z.object({ workspace_id: workspaceId.optional() }).strict(),
  list_buildable_products: z
    .object({ product_line: z.string().max(80).optional(), query: z.string().max(200).optional(), access_mode: z.string().max(40).optional() })
    .strict(),
  get_product: z.object({ id }).strict(),
  // An app's SDK tab: the integration kit of each product the app uses (reading only).
  get_product_sdk: z.object({ product_id: id }).strict(),
  // An app's P&L tab: the workspace's profit and loss for that one app (reading only).
  get_workspace_pnl: z
    .object({ workspace_id: workspaceId, app_id: id.optional(), granularity: z.enum(["month", "week"]).optional(), periods: z.number().int().min(1).max(24).optional() })
    .strict(),
  // New app: a draft app on the products picked, then a build for it.
  create_app: z
    .object({
      name: z.string().trim().min(1).max(80),
      description: z.string().trim().min(1).max(4000),
      audience: z.string().trim().min(1).max(500),
      product_ids: z.array(id).min(1).max(20),
      workspace_id: workspaceId.optional(),
    })
    .strict(),
  // The dashboard: money moved, customers, hand-offs and build spend across the user's apps.
  get_developer_dashboard: z
    .object({ days: z.union([z.literal(7), z.literal(30), z.literal(90)]).optional(), workspace_id: workspaceId.optional() })
    .strict(),
  // The dashboard's GitHub facts and the header's wallet control.
  get_linked_accounts: z.object({}).strict(),
  // Workspaces: the switcher, Create workspace and the Members page.
  list_workspaces: z.object({}).strict(),
  create_workspace: z.object({ name: workspaceName }).strict(),
  rename_workspace: z.object({ workspace_id: workspaceId, name: workspaceName }).strict(),
  list_workspace_members: z.object({ workspace_id: workspaceId }).strict(),
  invite_to_workspace: z.object({ workspace_id: workspaceId, email: z.string().trim().toLowerCase().email().max(320), role: memberRole }).strict(),
  revoke_workspace_invite: z.object({ workspace_id: workspaceId, invite_id: id }).strict(),
  change_member_role: z.object({ workspace_id: workspaceId, user_id: id, role: memberRole }).strict(),
  remove_workspace_member: z.object({ workspace_id: workspaceId, user_id: id }).strict(),
  leave_workspace: z.object({ workspace_id: workspaceId }).strict(),
  // The Workspace page's Settings tab, for owners: archiving (undoable for 7 days) and giving a
  // workspace whose organization was deleted a new one. Offered only where Mynt lists them.
  archive_workspace: z.object({ workspace_id: workspaceId }).strict(),
  unarchive_workspace: z.object({ workspace_id: workspaceId }).strict(),
  relink_workspace_org: z.object({ workspace_id: workspaceId }).strict(),
  // What needs the workspace's attention (the dashboard's Needs attention card).
  get_workspace_attention: z.object({ workspace_id: workspaceId }).strict(),
  // The dashboard's P&L: revenue against costs per period, and the statement.
  get_workspace_pnl: z
    .object({ workspace_id: workspaceId, granularity: z.enum(["month", "week"]), periods: z.number().int().min(1).max(24), app_id: id.optional() })
    .strict(),
  // Promotions: an app moves Ideas -> Staging -> Production only through Mynt's checks. Mynt
  // decides whether it may move (can_promote); the studio shows the checks and asks.
  get_promotion_checks: z.object({ app_id: id, to_stage: promotionStage }).strict(),
  promote_app: z.object({ app_id: id, to_stage: promotionStage }).strict(),
  demote_app: z.object({ app_id: id, to_stage: demotionStage, reason: z.string().trim().min(3).max(1000) }).strict(),
  request_promotion_signoff: z.object({ app_id: id }).strict(),
  // Compliance pages (read-only): Coverage, Licences and Audits, for the selected workspace
  // (no workspace_id for the implicit Personal one).
  get_compliance_coverage: z.object({ workspace_id: workspaceId.optional() }).strict(),
  list_workspace_licences: z
    .object({
      workspace_id: workspaceId.optional(),
      status: z.string().max(40).optional(),
      regulator: z.string().max(120).optional(),
      state: z.string().regex(/^[A-Z]{2}$/).optional(),
    })
    .strict(),
  list_workspace_audit: z
    .object({
      workspace_id: workspaceId.optional(),
      cursor: z.string().min(1).max(500).optional(),
      action: z.string().max(120).optional(),
      user_id: id.optional(),
      app_id: id.optional(),
      from: auditDate.optional(),
      to: auditDate.optional(),
      // Mynt's audit classes; sent only where its tool takes it (an app's Security tab).
      class: z.enum(["security", "obligations", "financial", "workspace"]).optional(),
    })
    .strict(),
  // Invitations to other people's workspaces: joining is always the user's explicit choice.
  list_my_invitations: z.object({}).strict(),
  accept_workspace_invite: z.object({ invite_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict(),
  decline_workspace_invite: z.object({ invite_id: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/) }).strict(),
  // repositories
  list_repositories: z.object({}).strict(),
  // The dashboard's Connect repository: connect one of the developer's own repositories. Mynt approves
  // it at once when their linked GitHub account can push to it, else an admin decides.
  connect_repository: z.object({ repository }).strict(),
  // builds
  list_builds: z.object({ status: z.string().max(40).optional(), app_id: id.optional(), workspace_id: workspaceId.optional() }).strict(),
  get_build: z.object({ build_id: id }).strict(),
  get_build_activity: z
    .object({ build_id: id, limit: z.number().int().min(1).max(200).optional(), after: z.number().int().min(0).optional() })
    .strict(),
  // The chat: a message starts a build for the app, or steers the one running. `mode` and
  // `continue_from` are sent only where Mynt offers session builds (lib/chat.ts).
  start_build: z
    .object({
      goal: z.string().trim().min(10).max(4000),
      app_id: id,
      repository: repository.optional(),
      mode: z.literal("session").optional(),
      continue_from: id.optional(),
    })
    .strict(),
  steer_build: z.object({ build_id: id, message: z.string().trim().min(3).max(4000) }).strict(),
  // sandbox (reading only)
  sandbox_files: z.object({ build_id: id, path: z.string().max(1000).optional() }).strict(),
  sandbox_diff: z.object({ build_id: id }).strict(),
  // hosting (reading only)
  hosting_status: z.object({}).strict(),
  app_status: z.object({ app_id: id }).strict(),
  app_logs: z.object({ app_id: id, tail: z.number().int().min(1).max(2000).optional(), service }).strict(),
  // Liquidity (/liquidity, lib/liquidity.ts): reading pools, positions, the withdrawal queue and
  // health; a builder proposing a pool; a liquidity provider committing capital and asking for it
  // back. Never the sponsor's or an admin's pool tools (approving, clearing offerings, pausing,
  // reporting movements, resolving flags).
  list_pools: z.object({ product_id: id.optional(), status: z.enum(["open", "paused", "closed"]).optional() }).strict(),
  list_withdrawals: z
    .object({ pool_id: uuid.optional(), status: z.enum(["queued", "paying", "paid", "paid_short", "returned", "cancelled", "no_balance", "parked"]).optional() })
    .strict(),
  list_my_positions: z.object({ pool_id: uuid.optional(), include_entries: z.boolean().optional() }).strict(),
  list_pools_with_health: z.object({}).strict(),
  list_product_health: z.object({ product_id: id.optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  list_my_sponsorships: z.object({ product_id: id.optional() }).strict(),
  create_pool: z
    .object({
      product_id: id,
      component_key: id,
      name: z.string().trim().min(1).max(200),
      sandbox: z.boolean(),
      min_reserve_bps: z.number().int().min(0).max(1_000_000),
      min_reserve_floor_cents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      notice_period_days: z.number().int().min(0).max(3650),
      min_commitment_cents: cents,
      max_commitment_cents: cents,
      sponsor_entity_id: uuid.optional(),
    })
    .strict(),
  commit_to_pool: z.object({ pool_id: uuid, amount_cents: cents, state: usState, idempotency_key: idempotencyKey }).strict(),
  request_withdrawal: z.object({ pool_id: uuid, amount_cents: cents, idempotency_key: idempotencyKey }).strict(),
} as const;

export type StudioTool = keyof typeof STUDIO_TOOLS;

export function isStudioTool(name: unknown): name is StudioTool {
  return typeof name === "string" && Object.prototype.hasOwnProperty.call(STUDIO_TOOLS, name);
}

export type StudioCall = { tool: StudioTool; args: Record<string, unknown> } | { error: string };

// Checks a tool name and its arguments against the allow-list.
export function parseStudioCall(tool: unknown, args: unknown): StudioCall {
  if (!isStudioTool(tool)) return { error: "That tool isn't available in the studio" };
  const parsed = STUDIO_TOOLS[tool].safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  return { tool, args: parsed.data as Record<string, unknown> };
}

// whoami's effective_roles (developers include innovators); roles as a fallback.
export function rolesFrom(whoami: unknown): string[] {
  const w = (whoami ?? {}) as { effective_roles?: unknown; roles?: unknown };
  const list = Array.isArray(w.effective_roles) ? w.effective_roles : Array.isArray(w.roles) ? w.roles : [];
  return list.filter((r): r is string => typeof r === "string");
}

// The studio is for people who build apps on Mynt. Mynt re-checks every call.
export const isDeveloper = (roles: string[]) => roles.includes("developer") || roles.includes("innovator") || roles.includes("admin");

// Mynt replies with JSON text; anything else is kept as text.
export function parseToolText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
