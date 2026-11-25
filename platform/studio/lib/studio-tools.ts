import { z } from "zod";
import { ChatKindSchema, SessionEvent, SessionId, SessionMetadata } from "./chat-sessions";
import { isCalendarDate } from "./compliance";
import { HORIZONS, LIQUIDITY, PRODUCT_ACTIONS, PRODUCT_LINES, ProductId, RETURN_TYPES, RISK_LEVELS } from "./products";
import { RISK_AREAS, RISK_CATEGORIES, RISK_STATUSES } from "./risk-register";
import { CLUSTER, SIGNATURE, SOLANA_ADDRESS } from "./wallets";
import { AGREEMENT_FILE_MAX_BYTES } from "./agreement-esign";
import { AGREEMENT_SCOPE_KEYS } from "./app-panel";

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
// What an agreement covers: one or more of Mynt's fixed list (AGREEMENT_SCOPES), each once.
const agreementScopes = z
  .array(z.enum(AGREEMENT_SCOPE_KEYS), { error: "Choose at least one scope." })
  .min(1, "Choose at least one scope.")
  .max(AGREEMENT_SCOPE_KEYS.length)
  .refine((s) => new Set(s).size === s.length, "Each scope once");
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
// Risk registers (lib/risk-register.ts): an app's or a product's, scores 1-5.
const riskSubject = z.enum(["app", "product"]);
const riskCategory = z.enum(RISK_CATEGORIES);
const riskStatus = z.enum(RISK_STATUSES);
const riskScore = z.number().int().min(1).max(5);
const riskArea = z.enum(RISK_AREAS);
// An app kind's id, as Mynt's kind files name them (core/schemas/app-kind.schema.json).
export const appKindId = z.string().regex(/^[a-z][a-z0-9-]{1,39}$/);
// A service provider's service (My services): its endpoints (https only), price per call, notes, the firm's licences it
// relies on, and its standard terms (an https link with the document's SHA-256, a summary and the pricing in words).
const httpsUrl = z.string().trim().url().max(2000).refine((u) => u.startsWith("https://"), "an https link");
const vendorOfferingEdits = {
  name: z.string().trim().min(1).max(200).optional(),
  test_base_url: httpsUrl.optional(),
  live_base_url: httpsUrl.optional(),
  price: z.object({ amount: z.number().min(0).max(1_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }).strict().optional(),
  sla_notes: z.string().trim().max(2000).optional(),
  licence_ids: z.array(z.string().uuid()).max(10).optional(),
  requires_credential: z.boolean().optional(),
};
const vendorOfferingFields = {
  ...vendorOfferingEdits,
  name: z.string().trim().min(1).max(200),
  test_base_url: httpsUrl,
  price: z.object({ amount: z.number().min(0).max(1_000_000), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
};
export const standardTerms = z
  .object({
    document_url: httpsUrl,
    document_sha256: z.string().regex(/^[a-f0-9]{64}$/, "64 lowercase hex characters"),
    summary: z.string().trim().min(10).max(2000),
    pricing_summary: z.string().trim().min(3).max(1000),
    // What the terms cover; part of the version, copied onto every agreement made on them.
    scopes: agreementScopes,
  })
  .strict();

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
  // A product's own workspace (/products/<id>), reading only: its v2 definition (Terms, Customers, Risk,
  // Integrations), its versions and activity, its firm's vendor services, and the health record's status.
  // The numbers (get_product_health) and covenants are read only where Mynt offers them to the user
  // (its licence provider and liquidity providers); everyone else is told why not.
  get_product_definition: z.object({ product_id: ProductId }).strict(),
  list_product_versions: z.object({ id: ProductId }).strict(),
  list_product_activity: z.object({ id: ProductId, limit: z.number().int().min(1).max(200).optional() }).strict(),
  list_my_vendor_subscriptions: z.object({ days: z.number().int().min(1).max(90).optional(), include_ended: z.boolean().optional() }).strict(),
  get_product_health: z.object({ product_id: ProductId, limit: z.number().int().min(1).max(200).optional() }).strict(),
  list_covenants: z.object({ product_id: ProductId }).strict(),
  list_covenant_breaches: z.object({ product_id: ProductId, open_only: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() }).strict(),
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
  // Without app_id: the Licences page's Agreements tab, a licence provider's list of what apps proposed to its firm.
  list_app_agreements: z
    .object({ app_id: id.optional(), workspace_id: workspaceId.optional(), status: z.enum(["proposed", "accepted", "signed", "declined", "terminated"]).optional(), scope: z.enum(AGREEMENT_SCOPE_KEYS).optional() })
    .strict(),
  // Each side's row actions: the licence provider accepts or declines (Accept / Decline), either side signs (Sign) and
  // either side ends one with a reason (End agreement; Withdraw for the app's own proposal). Mynt decides who may.
  respond_to_app_agreement: z.object({ agreement_id: uuid, decision: z.enum(["accept", "decline"]), note: z.string().trim().max(2000).optional() }).strict(),
  sign_app_agreement: z.object({ agreement_id: uuid }).strict(),
  // What a proposed agreement covers (Change scope): only the side that proposed it, only while it's proposed.
  update_agreement_scopes: z.object({ agreement_id: uuid, scopes: agreementScopes }).strict(),
  terminate_app_agreement: z.object({ agreement_id: uuid, reason: z.string().trim().min(3).max(2000) }).strict(),
  // Either side proposes; the other accepts or declines, then both sign. Every agreement names its app: program, data
  // sharing, MSA and SLA alike.
  propose_workspace_agreement: z
    .object({
      workspace_id: workspaceId,
      app_id: id,
      kind: z.enum(["program", "data_sharing", "msa", "sla"]),
      scopes: agreementScopes,
      products: z.array(id).max(20).optional(),
      terms_summary: z.string().trim().min(10).max(4000),
      document_url: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "an https link").optional(),
      document_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      template_id: uuid.optional(),
      effective_from: auditDate.optional(),
      effective_to: auditDate.optional(),
    })
    .strict(),
  propose_app_agreement: z
    .object({
      app_id: id,
      counterparty_entity_id: uuid,
      kind: z.enum(["program", "vendor", "data_sharing", "msa", "sla"]),
      scopes: agreementScopes,
      products: z.array(id).max(20),
      terms_summary: z.string().trim().min(10).max(4000),
      document_url: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "an https link").optional(),
      document_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      effective_from: auditDate.optional(),
      effective_to: auditDate.optional(),
    })
    .strict(),
  // Program agreements signed by e-signature: a licence provider's templates (Upload agreement template, on its
  // Agreements page), each signer's embedded signing page (Sign) and the signed copy (Download signed copy), on both
  // sides' agreement rows. The file is checked again by the upload route (type and size) and by Mynt.
  upload_agreement_template: z
    .object({
      name: z.string().trim().min(3).max(120),
      source: z.literal("upload"),
      licence_id: uuid.optional(),
      sponsorship_id: uuid.optional(),
      file_name: z.string().trim().regex(/^[^/\\\0]{1,150}\.(pdf|docx)$/i),
      file_base64: z.string().max(Math.ceil((AGREEMENT_FILE_MAX_BYTES * 4) / 3) + 8).regex(/^[A-Za-z0-9+/]*={0,2}$/),
      signature_placement: z.enum(["signature_page", "text_tags"]).optional(),
      notes: z.string().trim().max(2000).optional(),
    })
    .strict(),
  list_my_licenses: z.object({}).strict(),
  list_agreement_templates: z.object({ include_retired: z.boolean().optional() }).strict(),
  retire_agreement_template: z.object({ template_id: uuid, reason: z.string().trim().max(500).optional() }).strict(),
  get_agreement_signing_link: z.object({ agreement_id: uuid }).strict(),
  download_agreement_document: z.object({ agreement_id: uuid, part: z.enum(["signed", "certificate"]).optional() }).strict(),
  // The Marketplace (/marketplace): service providers' standard services under their standard terms, subscribed to
  // by accepting the current version for the apps it's for (click-through only: the studio never subscribes
  // without terms), and ending a subscription (the app's Agreements tab's End subscription). A test credential
  // goes to Mynt's key vault and is never read back; live credentials and going live stay with the MCP tools.
  list_vendor_offerings: z
    .object({
      region: z.string().regex(/^[A-Z]{2}$/).optional(),
      service_type: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/).optional(),
      category: z.enum(["identity", "kyc", "account_data", "analytics", "credit_bureau", "documents", "esign", "mandate", "fraud", "ramp", "other"]).optional(),
    })
    .strict(),
  subscribe_vendor_service: z
    .object({
      offering_id: uuid,
      accept_terms_version: z.number().int().min(1).max(1_000_000),
      app_ids: z.array(uuid).min(1).max(20),
      products: z.array(id).max(20).optional(),
      test_credential: z.string().min(1).max(2000).optional(),
      credential_label: z.string().trim().min(1).max(100).optional(),
    })
    .strict(),
  unsubscribe_vendor_service: z.object({ subscription_id: uuid, reason: z.string().trim().min(3).max(2000).optional() }).strict(),
  // My services (/vendor), for service providers (Mynt's vendor role): their onboarding checklist and their firm's own
  // services, with Create service, Edit service, Set standard terms, Run conformance and List / Unlist service. Each
  // route checks the offering is the caller's firm's own (list_my_offerings) before it writes; Mynt checks again. A test
  // credential for a conformance run goes to Mynt only and isn't kept. Revealing or rotating subscribers' signing
  // secrets, and live endpoints' credentials, stay with the MCP tools.
  get_vendor_onboarding: z.object({ offering_id: uuid.optional() }).strict(),
  list_my_offerings: z.object({}).strict(),
  list_my_subscribers: z.object({ offering_id: uuid.optional(), days: z.number().int().min(1).max(90).optional() }).strict(),
  list_service_types: z.object({ region: z.string().regex(/^[A-Z]{2}$/).optional() }).strict(),
  get_my_entity: z.object({}).strict(),
  create_vendor_offering: z
    .object({
      region: z.string().regex(/^[A-Z]{2}$/),
      service_type: z.string().regex(/^[a-z][a-z0-9_]{0,59}$/),
      ...vendorOfferingFields,
    })
    .strict(),
  update_vendor_offering: z
    .object({
      offering_id: uuid,
      ...vendorOfferingEdits,
      listed: z.boolean().optional(),
      standard_terms: standardTerms.optional(),
    })
    .strict(),
  run_conformance: z.object({ offering_id: uuid, test_credential: z.string().min(1).max(2000).optional() }).strict(),
  get_app_customers: z.object({ app_id: id }).strict(),
  set_app_target_segments: z.object({ app_id: id, segments: z.array(z.object({ product_id: id, segment_id: id }).strict()).max(100) }).strict(),
  // Risk registers: an app's (its Security & risk tab) and a financial product's (its Risk tab). Add risk and
  // Review risk are labelled buttons opening a sheet; Mynt decides who keeps which register (can_manage).
  list_risks: z
    .object({
      subject_type: riskSubject,
      subject_id: id,
      status: riskStatus.optional(),
      category: riskCategory.optional(),
      overdue_only: z.boolean().optional(),
      risk_id: uuid.optional(),
    })
    .strict(),
  add_risk: z
    .object({
      subject_type: riskSubject,
      subject_id: id,
      title: z.string().trim().min(3).max(200),
      category: riskCategory,
      // The platform's risk area; Mynt gives an app's or a product's risk its category's when it's left out.
      risk_area: riskArea.optional(),
      likelihood: riskScore,
      impact: riskScore,
      description: z.string().trim().max(4000).optional(),
      mitigation: z.string().trim().max(4000).optional(),
      owner_user_id: uuid.optional(),
      review_by: auditDate.optional(),
    })
    .strict(),
  update_risk: z
    .object({
      risk_id: uuid,
      status: riskStatus.optional(),
      risk_area: riskArea.optional(),
      mitigation: z.string().trim().max(4000).optional(),
      likelihood: riskScore.optional(),
      impact: riskScore.optional(),
      owner_user_id: uuid.optional(),
      review_by: auditDate.optional(),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  // The Audits page's Agreement audits tab: oversight audits licence providers run on apps under program agreements.
  // Read by either party; the licence provider adds requirements, opens, records findings and closes; the app's side
  // submits evidence (https links with their SHA-256, never files) and answers findings. Mynt checks each side again.
  list_agreement_audits: z
    .object({
      workspace_id: workspaceId.optional(),
      app_id: id.optional(),
      agreement_id: uuid.optional(),
      status: z.enum(["scheduled", "in_progress", "submitted", "passed", "failed", "waived"]).optional(),
      overdue: z.boolean().optional(),
      side: z.enum(["app", "counterparty"]).optional(),
    })
    .strict(),
  get_agreement_audit: z.object({ audit_id: uuid }).strict(),
  add_agreement_audit_requirement: z
    .object({
      agreement_id: uuid,
      name: z.string().trim().min(3).max(200),
      kind: z.enum(["compliance_review", "complaints_review", "marketing_review", "security_review", "financial_review", "other"]),
      cadence: z.enum(["once", "monthly", "quarterly", "annual", "on_change"]),
      first_due: auditDate.optional(),
      description: z.string().trim().max(4000).optional(),
      evidence_required: z.string().trim().max(4000).optional(),
    })
    .strict(),
  open_agreement_audit: z.object({ audit_id: uuid }).strict(),
  record_agreement_audit_finding: z
    .object({ audit_id: uuid, severity: z.enum(["low", "medium", "high", "critical"]), title: z.string().trim().min(3).max(200), detail: z.string().trim().max(4000).optional() })
    .strict(),
  resolve_agreement_audit_finding: z.object({ audit_id: uuid, finding_id: uuid, note: z.string().trim().max(2000).optional() }).strict(),
  close_agreement_audit: z.object({ audit_id: uuid, outcome: z.enum(["passed", "failed", "waived"]), note: z.string().trim().max(4000).optional() }).strict(),
  submit_agreement_audit_evidence: z
    .object({
      audit_id: uuid,
      evidence: z
        .array(
          z
            .object({
              name: z.string().trim().min(1).max(200),
              url: z.string().url().max(2000).refine((u) => u.startsWith("https://"), "an https link"),
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      note: z.string().trim().max(4000).optional(),
    })
    .strict(),
  respond_to_agreement_audit_finding: z.object({ audit_id: uuid, finding_id: uuid, response: z.string().trim().min(3).max(4000) }).strict(),
  // The Licences page's SLA tab: the measurable commitments of a service level agreement (Commitments) and their
  // breaches. Either party adds commitments before it's signed and records or resolves breaches once it is; Mynt checks.
  list_agreement_slas: z
    .object({ workspace_id: workspaceId.optional(), app_id: id.optional(), agreement_id: uuid.optional(), side: z.enum(["app", "counterparty"]).optional(), include_retired: z.boolean().optional() })
    .strict(),
  add_agreement_sla: z
    .object({
      agreement_id: uuid,
      metric: z.string().trim().min(3).max(200),
      target: z.union([z.number().finite(), z.string().trim().min(1).max(200)]),
      unit: z.string().trim().max(40).optional(),
      measurement_window: z.enum(["daily", "weekly", "monthly", "quarterly"]),
      measurement_source: z.string().trim().min(3).max(500),
      remedy: z.string().trim().max(2000).optional(),
    })
    .strict(),
  retire_agreement_sla: z.object({ sla_id: uuid, reason: z.string().trim().min(3).max(2000) }).strict(),
  record_sla_breach: z
    .object({
      sla_id: uuid,
      period_start: auditDate,
      period_end: auditDate,
      measured_value: z.union([z.number().finite(), z.string().trim().min(1).max(200)]),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  resolve_sla_breach: z.object({ breach_id: uuid, note: z.string().trim().max(2000).optional() }).strict(),
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

// A regulated firm's own tools, for My firm (/firm) only: a separate allow-list that only a licence provider's session
// may call (lib/studio-server.ts callFirmTool checks the role Mynt gave the account; the routes also check it was
// granted, not implied by an admin's; Mynt checks it again on every call). The chat, Ask AI and every other page use
// STUDIO_TOOLS, which holds none of the writes here. The firm's onboarding checklist (its own firm only: an admin's read
// of any firm is in ADMIN_TOOLS), its record and licences (Register licence, from the region's licence types), the
// requests to sponsor (Review request: Approve sponsorship or Decline request; Revoke sponsorship), what it sponsors,
// its roster (Add party, End party), its facts (Set firm facts: identifiers only), its people (Decide on a member
// waiting to be accepted) and its notices. None takes a firm id: Mynt acts for the caller's own firm, and the routes
// check a sponsorship, licence or party is that firm's before they write. A covenant breach on a revocation, a party's
// qualification facts, the partner kit and webhooks stay with the MCP tools.
export const FIRM_TOOLS = {
  get_my_entity: z.object({}).strict(),
  list_my_licenses: z.object({}).strict(),
  get_regulated_firm_onboarding: z.object({}).strict(),
  get_region: z.object({ code: z.string().regex(/^[A-Z]{2}$/) }).strict(),
  register_license: z
    .object({
      region: z.string().regex(/^[A-Z]{2}$/),
      regulator_id: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
      license_id: z.string().regex(/^[a-z][a-z0-9_]{0,119}$/),
      jurisdiction: z.string().regex(/^[a-z]{2}-[a-z0-9]{1,3}$/).optional(),
      registration_number: z.string().trim().min(1).max(100),
      valid_from: auditDate.optional(),
      valid_to: auditDate.optional(),
    })
    .strict(),
  set_entity_facts: z
    .object({
      identifiers: z
        .array(z.object({ scheme: z.string().regex(/^(lei|[a-z]{2}_[a-z0-9_]{1,40})$/), value: z.string().trim().min(1).max(100) }).strict())
        .max(20)
        .refine((ids) => new Set(ids.map((i) => i.scheme)).size === ids.length, "Each identifier once"),
    })
    .strict(),
  list_sponsorship_requests: z.object({ status: z.enum(["pending", "approved", "declined", "revoked"]).optional() }).strict(),
  list_sponsored_products: z.object({}).strict(),
  approve_sponsorship: z
    .object({
      sponsorship_id: uuid,
      licence_ids: z.array(uuid).min(1).max(20),
      jurisdictions: z.array(z.string().regex(/^[a-z]{2}(-[a-z0-9]{1,3})?$/)).min(1).max(60).optional(),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  decline_sponsorship: z.object({ sponsorship_id: uuid, reason: z.string().trim().min(3).max(2000) }).strict(),
  revoke_sponsorship: z.object({ sponsorship_id: uuid, reason: z.string().trim().min(3).max(2000) }).strict(),
  add_party: z
    .object({
      kind: z.enum(["internal", "external"]),
      person: z.object({ name: z.string().trim().min(1).max(200) }).strict().optional(),
      legal_entity_id: uuid.optional(),
      new_legal_entity: z.object({ name: z.string().trim().min(1).max(200) }).strict().optional(),
      fills: z.array(z.object({ licence_id: uuid, stakeholder: z.string().trim().min(1).max(120) }).strict()).max(20).optional(),
      relationship: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(),
      since: auditDate.optional(),
    })
    .strict(),
  end_party: z.object({ party_id: uuid, until: auditDate.optional() }).strict(),
  decide_firm_member: z.object({ request_id: uuid, accept: z.boolean() }).strict(),
  list_firm_notices: z.object({ limit: z.number().int().min(1).max(200).optional() }).strict(),
} as const;

export type FirmTool = keyof typeof FIRM_TOOLS;
export const isFirmTool = (name: unknown): name is FirmTool => typeof name === "string" && Object.prototype.hasOwnProperty.call(FIRM_TOOLS, name);

// Checks a firm tool's name and arguments against FIRM_TOOLS (the caller checks the session is a licence provider's).
export function parseFirmCall(tool: unknown, args: unknown): { tool: FirmTool; args: Record<string, unknown> } | { error: string } {
  if (!isFirmTool(tool)) return { error: "That tool isn't available in My firm" };
  const parsed = FIRM_TOOLS[tool].safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  return { tool, args: parsed.data as Record<string, unknown> };
}

// Mynt admins' tools, for the platform admin (/platform) only: a separate allow-list that only an admin's session may call
// (lib/studio-server.ts callAdminTool checks the role Mynt gave the account; Mynt checks it again on every call). The
// chat, Ask AI and every other page use STUDIO_TOOLS, which holds none of these. Each is an existing admin tool,
// with the arguments the Admin area sends; anything else (approving mainnet programs, the regulatory model, rails,
// the connector...) stays with the MCP tools.
const ENTITY_STATUSES = ["active", "suspended", "under_liquidation", "dissolved", "struck_off"] as const;
const LEGAL_FORMS = ["company_private", "company_public", "llp", "partnership", "sole_proprietorship", "trust", "cooperative", "society", "nonprofit_company", "statutory_corporation", "government_entity", "foreign_branch"] as const;
export const MYNT_ROLES = ["consumer", "developer", "innovator", "vendor", "license_provider", "liquidity_provider", "admin"] as const;
export const SERVICE_CATEGORIES = ["identity", "kyc", "account_data", "analytics", "credit_bureau", "documents", "esign", "mandate", "fraud", "ramp", "other"] as const;
const email = z.string().trim().toLowerCase().email().max(320);
const page = { limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).max(1_000_000).optional() };
const query = z.string().trim().max(200).optional();
const snake = z.string().regex(/^[a-z][a-z0-9_]*$/).max(60);
const jsonObject = z.record(z.string(), z.unknown());
const licenceTypeIds = z.array(z.string().trim().min(1).max(120)).max(20);
// A risk model's definition (core/src/risk-models.ts): inputs, outputs and thresholds are lists of small objects.
const modelField = z.string().trim().min(1).max(120);
const modelText = z.string().trim().max(2000);
export const riskModelDefinition = {
  name: z.string().trim().min(3).max(200),
  purpose: z.string().trim().min(3).max(4000),
  method: z.string().trim().min(3).max(8000),
  inputs: z.array(z.object({ name: modelField, description: modelText.optional(), source: modelText.optional() }).strict()).max(50),
  outputs: z.array(z.object({ name: modelField, description: modelText.optional() }).strict()).max(50),
  thresholds: z.array(z.object({ name: modelField, value: z.union([z.number(), z.string().trim().min(1).max(200)]), meaning: modelText.optional() }).strict()).max(50),
};

export const ADMIN_TOOLS = {
  // Overview: what needs attention across Mynt.
  ops_status: z.object({ hours: z.number().int().min(1).max(720).optional() }).strict(),
  // Platform settings: the operational settings (read-only) and e-signature (moved here from workspace Settings).
  get_platform_settings: z.object({}).strict(),
  get_esign_settings: z.object({}).strict(),
  set_esign_api_key: z.object({ provider: z.enum(["signwell"]), api_key: z.string().trim().min(8).max(500).regex(/^[\x21-\x7e]+$/) }).strict(),
  register_esign_webhook: z.object({}).strict(),
  remove_esign_api_key: z.object({ confirm: z.literal(true) }).strict(),
  set_esign_test_mode: z.object({ test_mode: z.boolean() }).strict(),
  // Workspaces and financial products across Mynt (core/src/platform-admin.ts): a workspace's page, and a firm's Products tab.
  list_all_workspaces: z.object({ query, status: z.enum(["active", "archived", "frozen"]).optional(), ...page }).strict(),
  admin_get_workspace: z.object({ workspace_id: uuid }).strict(),
  list_all_products: z.object({ query, status: z.enum(["draft", "published", "unpublished"]).optional(), include_archived: z.boolean().optional(), ...page }).strict(),
  // A workspace's Members tab: the same rules (and identity-provider organization) as its owners' own tools.
  admin_invite_workspace_member: z.object({ workspace_id: uuid, email, role: z.enum(["owner", "admin", "member"]) }).strict(),
  admin_change_workspace_member_role: z.object({ workspace_id: uuid, user_id: uuid, role: z.enum(["owner", "admin", "member"]) }).strict(),
  admin_remove_workspace_member: z.object({ workspace_id: uuid, user_id: uuid }).strict(),
  admin_revoke_workspace_invite: z.object({ invite_id: uuid }).strict(),
  // Firms: registered by hand, their members (an email allowed to sign in with roles, then added to the firm) and status.
  list_entities: z.object({}).strict(),
  register_firm: z
    .object({
      name: z.string().trim().min(1).max(200),
      legal_form: z.enum(LEGAL_FORMS).optional(),
      incorporation: z
        .object({ country: z.string().regex(/^[a-z]{2}$/), subdivision: z.string().regex(/^[a-z]{2}-[a-z0-9]{1,3}$/).optional(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })
        .strict()
        .optional(),
      identifiers: z.array(z.object({ scheme: z.string().regex(/^(lei|[a-z]{2}_[a-z0-9_]+)$/), value: z.string().trim().min(1).max(100) }).strict()).max(20).optional(),
      regions: z.array(z.string().regex(/^([A-Z]{2}|global)$/)).max(20).optional(),
    })
    .strict(),
  // Who may sign in, with which roles: read before inviting a firm member, so their other roles are kept.
  list_whitelist: z.object({}).strict(),
  invite_user: z.object({ email, roles: z.array(z.enum(MYNT_ROLES)).min(1).max(MYNT_ROLES.length) }).strict(),
  add_entity_member: z.object({ email, entity_id: uuid }).strict(),
  remove_entity_member: z.object({ email, entity_id: uuid }).strict(),
  // Audit trails, and Security & risk's security events: Mynt's audit log, newest first, each entry with its class.
  audit_log: z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(),
  // Risk register (/platform/risk-register): Mynt's own risk register (the platform subject, Mynt admins only), one
  // risk area per tab (or the unassigned ones), and the open risks across every app and product in that area.
  list_risks: z.object({ subject_type: z.literal("platform"), subject_id: z.literal("mynt"), risk_area: z.enum([...RISK_AREAS, "unassigned"]).optional(), risk_id: uuid.optional() }).strict(),
  add_risk: z
    .object({
      subject_type: z.literal("platform"),
      subject_id: z.literal("mynt"),
      title: z.string().trim().min(3).max(200),
      category: STUDIO_TOOLS.add_risk.shape.category,
      risk_area: z.enum(RISK_AREAS), // every risk on Mynt's own register has one
      likelihood: STUDIO_TOOLS.add_risk.shape.likelihood,
      impact: STUDIO_TOOLS.add_risk.shape.impact,
      description: z.string().trim().max(4000).optional(),
      mitigation: z.string().trim().max(4000).optional(),
      owner_user_id: uuid.optional(),
      review_by: STUDIO_TOOLS.add_risk.shape.review_by,
    })
    .strict(),
  update_risk: STUDIO_TOOLS.update_risk,
  admin_list_risks: z
    .object({ limit: z.number().int().min(1).max(100).optional(), subject_type: z.enum(["app", "product", "platform"]).optional(), risk_area: z.enum([...RISK_AREAS, "unassigned"]).optional() })
    .strict(),
  // Risk models (/platform/risk-models): Mynt's own, per risk area, each edit a new version; validations and retiring
  // are their own actions. And the risk models financial products declare in their definitions, read-only.
  list_risk_models: z.object({ risk_area: z.enum(RISK_AREAS).optional(), status: z.enum(["draft", "active", "retired"]).optional(), model_id: uuid.optional() }).strict(),
  add_risk_model: z
    .object({
      risk_area: z.enum(RISK_AREAS),
      ...riskModelDefinition,
      owner_user_id: uuid.optional(),
      status: z.enum(["draft", "active"]).optional(),
      next_validation_due: auditDate.optional(),
    })
    .strict(),
  update_risk_model: z
    .object({
      model_id: uuid,
      name: riskModelDefinition.name.optional(),
      purpose: riskModelDefinition.purpose.optional(),
      method: riskModelDefinition.method.optional(),
      inputs: riskModelDefinition.inputs.optional(),
      outputs: riskModelDefinition.outputs.optional(),
      thresholds: riskModelDefinition.thresholds.optional(),
      owner_user_id: uuid.optional(),
      status: z.enum(["draft", "active"]).optional(),
      next_validation_due: auditDate.optional(),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
  validate_risk_model: z
    .object({ model_id: uuid, outcome: z.enum(["passed", "passed_with_findings", "failed"]), notes: z.string().trim().min(3).max(4000), next_validation_due: auditDate })
    .strict(),
  retire_risk_model: z.object({ model_id: uuid, reason: z.string().trim().min(3).max(2000) }).strict(),
  admin_list_product_risk_models: z.object({ query: z.string().trim().max(200).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
  set_entity_status: z.object({ entity_id: uuid, status: z.enum(ENTITY_STATUSES), note: z.string().trim().max(2000).optional() }).strict(),
  // Licences: firms' registered licences by review status, and the decision on one.
  list_license_reviews: z.object({ status: z.enum(["pending", "verified", "rejected", "suspended"]).optional() }).strict(),
  review_license: z.object({ license_record_id: uuid, decision: z.enum(["verified", "rejected", "suspended"]), note: z.string().trim().max(2000).optional() }).strict(),
  // Vendors: the standard service types (added, never edited here: define_service_type replaces) and every offering.
  list_service_types: z.object({ region: z.string().regex(/^[A-Z]{2}$/).optional(), category: z.enum(SERVICE_CATEGORIES).optional() }).strict(),
  define_service_type: z
    .object({
      service_type: z
        .object({
          region: z.string().regex(/^[A-Z]{2}$/),
          key: snake,
          name: z.string().trim().min(1).max(200),
          category: z.enum(SERVICE_CATEGORIES),
          description: z.string().trim().max(2000).optional(),
          input_schema: jsonObject,
          output_schema: jsonObject,
          consent_purpose: snake,
          fills: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
          innovator_licences: licenceTypeIds.optional(),
          vendor_licences: licenceTypeIds.optional(),
          moves_money: z.boolean(),
        })
        .strict(),
    })
    .strict(),
  list_vendor_offerings: z.object({ include_unlisted: z.literal(true) }).strict(),
  suspend_vendor_offering: z.object({ offering_id: uuid, suspended: z.boolean(), note: z.string().trim().max(500).optional() }).strict(),
  // Vendor firms: each firm's onboarding progress (the Vendors section's Vendor firms tab), reading only.
  get_vendor_onboarding: z.object({ all_firms: z.literal(true) }).strict(),
  // Regulated firms: each firm's onboarding progress (the list's Onboarding column) or one firm's checklist with its
  // real-company check and the registers' answers so far (its page), reading only; and Run checks on a firm's page.
  get_regulated_firm_onboarding: z.union([z.object({ all_firms: z.literal(true) }).strict(), z.object({ entity_id: uuid }).strict()]),
  run_firm_checks: z.object({ entity_id: uuid }).strict(),
} as const;

export type AdminTool = keyof typeof ADMIN_TOOLS;
export const isAdminTool = (name: unknown): name is AdminTool => typeof name === "string" && Object.prototype.hasOwnProperty.call(ADMIN_TOOLS, name);
export const isMyntAdmin = (roles: string[]) => roles.includes("admin");

// Checks an admin tool's name and arguments against ADMIN_TOOLS (the caller checks the session is an admin's).
export function parseAdminCall(tool: unknown, args: unknown): { tool: AdminTool; args: Record<string, unknown> } | { error: string } {
  if (!isAdminTool(tool)) return { error: "That tool isn't available in the Admin area" };
  const parsed = ADMIN_TOOLS[tool].safeParse(args ?? {});
  if (!parsed.success) return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
  return { tool, args: parsed.data as Record<string, unknown> };
}

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
