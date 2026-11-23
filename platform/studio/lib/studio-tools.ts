import { z } from "zod";
import { ChatKindSchema, SessionEvent, SessionId, SessionMetadata } from "./chat-sessions";
import { isCalendarDate } from "./compliance";
import { HORIZONS, LIQUIDITY, PRODUCT_ACTIONS, PRODUCT_LINES, ProductId, RETURN_TYPES, RISK_LEVELS } from "./products";
import { CLUSTER, SIGNATURE, SOLANA_ADDRESS } from "./wallets";

// Which of Mynt's tools the studio may call for the signed-in user, with what arguments. Mynt
// checks everything again (who owns what, roles, limits); these keep junk off the wire and keep
// the studio to its job. Anything not listed (vm_access, app_run, admin tools...) can't be
// called from the studio at all.
//
// Writing tools join the list with the screens that use them. The chat starts and steers
// builds, New app creates apps (and products, then tests and publishes them), the dashboard's Connect repository connects repositories and the app's stage
// control promotes, the builder chat's Ship ships (finish_build), and the app's Put online hosts a
// verified build (request_hosting for the app's workspace, then deploy_app) and chooses the repository
// its builds push to (set_app_repository); stopping, undeploying, sandbox commands and VM access come later.

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
// Wallets and treasuries: a Solana address, devnet only, USDC in whole base units (6 decimals, sent
// as a number while it's a safe integer) and a duration in seconds.
const solanaAddress = z.string().regex(SOLANA_ADDRESS);
const devnet = z.literal(CLUSTER);
const baseUnits = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const seconds = z.number().int().min(0).max(10 * 365 * 86_400);
// An app kind's id, as Mynt's kind files name them (core/schemas/app-kind.schema.json).
export const appKindId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);

export const STUDIO_TOOLS = {
  // apps and catalogue
  whoami: z.object({}).strict(),
  list_my_apps: z.object({ workspace_id: workspaceId.optional() }).strict(),
  list_buildable_products: z
    .object({
      product_line: z.string().max(80).optional(),
      query: z.string().max(200).optional(),
      access_mode: z.string().max(40).optional(),
      // sandbox: products in staging too (for sandbox builds only)
      environment: z.enum(["production", "sandbox"]).optional(),
    })
    .strict(),
  get_product: z.object({ id }).strict(),
  // New app's Templates: starting points for common finance apps.
  list_app_kinds: z.object({}).strict(),
  // ...and the specific app ideas on them, from Mynt's database (reading only; admins keep them in Mynt).
  list_app_ideas: z.object({ kind: appKindId.optional() }).strict(),
  // Financial product mode's ideas for new products a firm could define (reading only; admins keep them in Mynt).
  list_product_ideas: z.object({ product_line: z.string().max(80).optional() }).strict(),
  // An app's SDK tab: the integration kit of each product the app uses (reading only).
  get_product_sdk: z.object({ product_id: id }).strict(),
  // New app's Create product: a draft product (create_product's own fields; Mynt checks them again), then
  // its stage actions on its row (Test, Move to staging or production, Move back). The user's own products (drafts too) and the regions and categories the
  // sheet offers are read alongside.
  // include_archived: the Products tab's Archived filter (archive_product), flagged archived.
  list_my_products: z.object({ include_archived: z.boolean().optional() }).strict(),
  list_regions: z.object({}).strict(),
  list_product_categories: z.object({ product_line: z.enum(PRODUCT_LINES).optional() }).strict(),
  create_product: z
    .object({
      id: ProductId,
      name: z.string().trim().min(1).max(200),
      product_line: z.enum(PRODUCT_LINES),
      category: z.string().trim().min(1).max(120),
      region: z.string().trim().regex(/^([A-Za-z]{2}|global)$/),
      risk_level: z.enum(RISK_LEVELS),
      liquidity: z.enum(LIQUIDITY),
      typical_horizon: z.enum(HORIZONS),
      return_type: z.enum(RETURN_TYPES),
      regulator: z.string().trim().min(1).max(200),
      description: z.string().trim().min(1).max(4000),
      key_features: z.array(z.string().trim().min(1).max(500)).max(20),
      action: z.enum(PRODUCT_ACTIONS),
      underlying_product_ids: z.array(id).max(20),
    })
    .strict(),
  test_product: z.object({ id: ProductId }).strict(),
  publish_product: z.object({ id: ProductId }).strict(),
  // A product's stage, as an app's: Mynt's checks, then a move up or (with a reason) back down.
  get_product_promotion_checks: z.object({ product_id: ProductId, to_stage: z.enum(["staging", "production"]) }).strict(),
  promote_product: z.object({ product_id: ProductId, to_stage: z.enum(["staging", "production"]) }).strict(),
  demote_product: z.object({ product_id: ProductId, to_stage: z.enum(["idea", "staging"]), reason: z.string().trim().min(3).max(1000) }).strict(),
  // Out of the way (idea or staging only; Mynt refuses production), with a reason, and back to its stage. Never deleted.
  archive_product: z.object({ product_id: ProductId, reason: z.string().trim().min(3).max(1000) }).strict(),
  unarchive_product: z.object({ product_id: ProductId }).strict(),
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
  // The dashboard's P&L, and an app's P&L tab (with app_id): revenue against costs per period, and the statement.
  get_workspace_pnl: z
    .object({ workspace_id: workspaceId, granularity: z.enum(["month", "week"]), periods: z.number().int().min(1).max(24), app_id: id.optional() })
    .strict(),
  // Promotions: an app moves Ideas -> Staging -> Production only through Mynt's checks. Mynt
  // decides whether it may move (can_promote); the studio shows the checks and asks.
  get_promotion_checks: z.object({ app_id: id, to_stage: promotionStage }).strict(),
  promote_app: z.object({ app_id: id, to_stage: promotionStage }).strict(),
  demote_app: z.object({ app_id: id, to_stage: demotionStage, reason: z.string().trim().min(3).max(1000) }).strict(),
  request_promotion_signoff: z.object({ app_id: id }).strict(),
  // An app's Products, Agreements and Customers tabs: its products with their sponsors, its agreements with the firms
  // behind them (Propose agreement), and the personas it targets (Choose personas). Apps hold no licences themselves.
  list_app_agreements: z.object({ app_id: id, status: z.enum(["proposed", "accepted", "signed", "declined", "terminated"]).optional() }).strict(),
  propose_app_agreement: z
    .object({
      app_id: id,
      counterparty_entity_id: uuid,
      kind: z.enum(["program", "vendor", "data_sharing"]),
      products: z.array(id).max(20),
      terms_summary: z.string().trim().min(10).max(4000),
      document_url: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "an https link").optional(),
      document_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      effective_from: auditDate.optional(),
      effective_to: auditDate.optional(),
    })
    .strict(),
  get_app_customers: z.object({ app_id: id }).strict(),
  set_app_target_segments: z.object({ app_id: id, segments: z.array(z.object({ product_id: id, segment_id: id }).strict()).max(100) }).strict(),
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
      // Mynt's audit classes: the Audits page's tabs, and an app's Security tab.
      class: z.enum(["security", "obligations", "financial", "workspace"]).optional(),
    })
    .strict(),
  // The Audits page's Licence obligations tab: each licence's regulatory obligations.
  get_workspace_obligations: z.object({ workspace_id: workspaceId }).strict(),
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
    .object({ build_id: id, limit: z.number().int().min(1).max(200).optional(), after: z.number().int().min(0).optional(), text_deltas: z.boolean().optional(), reasoning: z.boolean().optional() })
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
      // New app: the app kind it starts from (list_app_kinds), checked by Mynt.
      kind: appKindId.optional(),
    })
    .strict(),
  steer_build: z.object({ build_id: id, message: z.string().trim().min(3).max(4000) }).strict(),
  // The builder chat's Ship (and /ship): ends the session build; the agent ships it and Mynt verifies it.
  finish_build: z.object({ build_id: id }).strict(),
  // sandbox (reading only)
  sandbox_files: z.object({ build_id: id, path: z.string().max(1000).optional() }).strict(),
  sandbox_diff: z.object({ build_id: id }).strict(),
  // The app's repository (Put online's sheet), and choosing one of the developer's own connected,
  // approved repositories for its next builds (Mynt checks the connection again).
  get_app_repository: z.object({ app_id: id }).strict(),
  set_app_repository: z.object({ app_id: id, repository }).strict(),
  // hosting: the workspace's hosting and its apps; Put online turns the app's workspace's hosting on
  // (owners and admins; idempotent) and hosts one build Mynt verified.
  hosting_status: z.object({ workspace_id: workspaceId.optional() }).strict(),
  request_hosting: z.object({ workspace_id: workspaceId }).strict(),
  deploy_app: z.object({ app_id: id, build_id: id }).strict(),
  app_status: z.object({ app_id: id }).strict(),
  app_logs: z.object({ app_id: id, tail: z.number().int().min(1).max(2000).optional(), service }).strict(),
  // Liquidity (/liquidity, lib/liquidity.ts): reading pools, positions, the withdrawal queue and
  // health; a builder proposing a pool; a liquidity provider committing capital, asking for it
  // back, cancelling a request and answering a correction to its state. Never the sponsor's or an admin's pool tools (approving, clearing offerings, pausing,
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
      // A retry with the same key and terms is the pool Mynt already made, never a second one.
      idempotency_key: idempotencyKey.optional(),
    })
    .strict(),
  commit_to_pool: z.object({ pool_id: uuid, amount_cents: cents, state: usState, idempotency_key: idempotencyKey }).strict(),
  request_withdrawal: z.object({ pool_id: uuid, amount_cents: cents, idempotency_key: idempotencyKey }).strict(),
  // A liquidity provider leaving the queue with one of its requests (queued or parked), and its
  // answer to a correction of the US state its capital moves from (accept or dispute). Neither
  // takes an idempotency key: the studio sends each once per click.
  cancel_withdrawal: z.object({ withdrawal_id: uuid }).strict(),
  respond_to_state_correction: z.object({ correction_id: uuid, accept: z.boolean(), reason: z.string().trim().min(1).max(1000).optional() }).strict(),
  // Earn's wallets and on-chain treasuries, devnet only (never mainnet): a linked wallet's live
  // balances, and Mynt preparing an unsigned deposit or withdrawal transaction that the user signs
  // in their own browser wallet (Mynt and the studio never sign), then its status.
  get_wallet_balances: z.object({ address: solanaAddress, cluster: devnet }).strict(),
  prepare_treasury_deposit: z.object({ pool_id: uuid, wallet: solanaAddress, amount_usdc_base_units: baseUnits, max_lock_in_seconds: seconds }).strict(),
  prepare_treasury_withdrawal: z.object({ pool_id: uuid, wallet: solanaAddress, deposit: solanaAddress, amount_usdc_base_units: baseUnits, max_notice_seconds: seconds }).strict(),
  get_treasury_tx_status: z.object({ signature: z.string().regex(SIGNATURE) }).strict(),
  // The user's own chats (Build page's product chats, Earn's), kept on Mynt as sessions of events
  // (lib/chat-sessions.ts): only their own, through app/api/threads.
  create_chat_session: z.object({ id: SessionId, kind: ChatKindSchema, title: z.string().max(200).optional(), metadata: SessionMetadata.optional() }).strict(),
  append_chat_events: z.object({ id: SessionId, events: z.array(SessionEvent).min(1).max(100) }).strict(),
  list_chat_sessions: z.object({ kind: ChatKindSchema.optional(), query: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
  get_chat_session: z.object({ id: SessionId, after_seq: z.number().int().min(0).optional() }).strict(),
  delete_chat_session: z.object({ id: SessionId }).strict(),
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
