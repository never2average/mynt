import { COVENANT_HOOK_ELIGIBLE, COVENANT_TABLES } from "./covenant-schema.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { currentLine, lineForTreasuryCategory, PRODUCT_LINES, UNDERLYINGS, WRAPPERS, type FinancialProduct } from "./catalog.js";
import type { DeveloperContract } from "./contract.js";
import type { Component, PartyBinding } from "./regime.js";
import { inTransaction, type Db } from "./db.js";
import { LIQUIDITY_TABLES } from "./liquidity-schema.js";
import { WORKSPACE_TABLES, migrateAppWorkspaces, personalWorkspace } from "./workspaces.js";
import { fingerprint, runProductTests, type TestReport } from "./product-tests.js";
import {
  hydrateRegulators,
  PRODUCT_ACTIONS,
  stripScopeProducts,
  type ProductAction as RegulatedAction,
  type ProductMapping,
  type RegulatedProductType,
  type RegulatoryModel,
} from "./regulatory.js";

export const ROLES = ["consumer", "developer", "innovator", "vendor", "license_provider", "liquidity_provider", "admin"] as const;
export type Role = (typeof ROLES)[number];

// Roles nest: every admin is a builder, every builder a consumer. Builders compose and publish products and
// build apps on them: "innovator" and "developer" are two names for the same role (each implies the other),
// kept so existing users, invites and docs keep working. A builder needn't be licensed: a component can be
// covered by a licence provider's licence instead (see sponsorships.ts). Vendors (firms offering standard
// services builders plug in) and licence providers (firms holding the licences that sponsor builders'
// products) are peers of builders with their own tools only, and an admin is all of them. Liquidity providers
// (firms putting capital into products' pools) are peers too, but an admin isn't one: Mynt's staff don't commit capital.
const IMPLIES: Record<Role, Role[]> = {
  consumer: [],
  developer: ["consumer", "innovator"],
  innovator: ["developer"],
  vendor: [],
  license_provider: [],
  liquidity_provider: [],
  admin: ["innovator", "vendor", "license_provider"],
};

// Reference data admins manage: where products may be offered and what kinds of product exist.
// How a product line is legally brought to market in a region: licences, approvals, filings.
export interface LaunchProcedure {
  product_line: string;
  name: string; // e.g. "Mutual fund scheme launch"
  regulator: string;
  steps: string[];
  typical_timeline?: string;
  notes?: string;
}

export interface Region {
  code: string; // ISO 3166-1 alpha-2, or "global"
  name: string;
  regulators: string[];
  ecosystem: string; // how the regulators, key laws and bodies fit together
  procedures: LaunchProcedure[];
  sources: string[]; // official pages the above is drawn from
  regulatory: RegulatoryModel; // regulators, scope, licences + GRC, and legal instruments
  active: boolean;
  updated_at: string;
}

// Fields left out keep their current value, so a partial update never wipes researched content.
export type RegionUpdate = Pick<Region, "code"> & Partial<Omit<Region, "code" | "updated_at" | "regulatory">>;

export interface ProductCategory {
  id: string;
  name: string;
  product_lines: string[];
  description: string;
  active: boolean;
  updated_at: string;
}

export interface ReferenceData {
  regions: Region[];
  categories: ProductCategory[];
}

export interface AuditEntry {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  target: string;
  details: unknown;
  created_at: string;
}

// ---- Runtime layer: per-app API keys, hand-offs, analytics events, webhooks, app releases ----

export type KeyEnvironment = "live" | "sandbox";
export interface ApiKey {
  id: string;
  app_id: string;
  environment: KeyEnvironment;
  label: string;
  prefix: string; // the first characters of the key, to recognise it by
  allowed_origins: string[];
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
  rotated_at: string | null;
  revoked_at: string | null;
}

export interface Handoff {
  id: string;
  app_id: string;
  product_id: string;
  action: string;
  consumer_ref: string | null;
  sandbox: boolean;
  status: "started" | "completed" | "failed";
  redirect_url: string;
  created_at: string;
  resolved_at: string | null;
}

export interface Webhook {
  id: string;
  app_id: string; // empty for a firm's webhook
  entity_id?: string | null; // a firm's webhook (see emitFirmEvent)
  url: string;
  events: string[];
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_id: string;
  type: string;
  payload: unknown;
  sandbox: boolean;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  last_response_code: number | null;
  last_error: string | null;
  next_attempt_at: string | null;
  created_at: string;
  delivered_at: string | null;
}

export interface AppRelease {
  app_id: string;
  version: string;
  changelog: string;
  snapshot: Record<string, unknown>;
  released_by: string | null;
  created_at: string;
}

// ---- end runtime layer ----

const KNOWN_REGIONS: Record<string, { name: string; regulators: string[] }> = {
  global: { name: "Global", regulators: [] },
  IN: { name: "India", regulators: ["RBI", "SEBI", "IRDAI", "PFRDA", "EPFO", "Ministry of Finance"] },
  US: { name: "United States", regulators: ["SEC", "FINRA", "FDIC", "NCUA", "CFPB", "CFTC", "IRS", "US Treasury", "Department of Labor", "State insurance regulators"] },
};

const titleCase = (id: string) => id.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// Regions and categories implied by a catalog, so the bundled products are valid from the start.
export function referenceSeed(products: FinancialProduct[]) {
  const regions = [...new Set(["global", ...products.map((p) => p.region)])].map((code) => ({
    code,
    name: KNOWN_REGIONS[code]?.name ?? code,
    regulators: KNOWN_REGIONS[code]?.regulators ?? [],
  }));
  const lines = new Map<string, Set<string>>();
  for (const p of products) lines.set(p.category, (lines.get(p.category) ?? new Set()).add(p.product_line));
  const categories = [...lines].map(([id, l]) => ({ id, name: titleCase(id), product_lines: [...l].sort() }));
  return { regions, categories };
}

export function effectiveRoles(roles: Role[]): Role[] {
  const out = new Set<Role>();
  const add = (r: Role) => {
    if (out.has(r)) return;
    out.add(r);
    IMPLIES[r].forEach(add);
  };
  roles.forEach(add);
  return ROLES.filter((r) => out.has(r));
}

export interface User {
  id: string;
  name: string;
  roles: Role[]; // the roles the account may act with now: license_provider only with standing at its firm (below)
  email: string | null;
  entity_id: string | null;
  created_at: string;
  held_roles?: Role[]; // the roles granted to the account, standing or not (for deciding who must accept it)
  licence_provider_pending?: boolean; // holds license_provider at a firm without standing there yet
}

// The one place licence-provider powers are resolved. An account of a firm that holds the license_provider role but
// has no standing there (users.lp_since: a firm's first licence provider, or one an existing licence provider accepted;
// see firm-notices.ts) acts as if it didn't hold the role: no licence-provider tool, no sealed figures, no
// sponsorship, covenant or licence decision. An account with no firm keeps the role, which grants nothing without one.
export function rolesWithStanding(roles: Role[], entityId: string | null, lpSince: unknown): Role[] {
  return entityId && !lpSince && roles.includes("license_provider") ? roles.filter((r) => r !== "license_provider") : roles;
}

export interface Invite {
  email: string;
  roles: Role[];
  created_at: string;
}

// One record in a legal entity's GRC folder (or one of its parties' folders): it answers an item of a held
// licence's GRC (see entity-grc.ts). Filing a record with the same key supersedes the current one.
export interface GrcRecord {
  id: string;
  entity_id: string;
  party_id: string | null;
  product_id: string | null; // a record in one of the entity's products' folders
  licence_id: string | null;
  section: string;
  ref: string | null;
  key: string;
  record: Record<string, unknown>;
  status: "current" | "superseded";
  created_by: string | null;
  created_at: string;
}

export interface ClientSession {
  id: string;
  app_id: string;
  key_id: string;
  customer_ref: string | null;
  product_ids: string[];
  scopes: string[];
  sandbox: boolean;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export interface ClientEvidence {
  id: string;
  app_id: string;
  session_id: string;
  product_id: string;
  contract_hash: string | null;
  type: "disclosure_shown" | "consent_given" | "consent_withdrawn" | "action_completed" | "action_failed";
  subject: string;
  content_hash: string | null;
  customer_ref: string | null;
  sandbox: boolean;
  created_at: string;
}

export interface AppJourney {
  app_id: string;
  journey_id: string;
  product_id: string;
  contract_hash: string;
  spec: Record<string, unknown>;
  updated_at: string;
}

export type ProductStatus = "draft" | "published" | "unpublished";
export interface Pins {
  version: number;
  pinned_at: string;
  components: Component[];
  parties: PartyBinding[];
  entity_ids: string[];
  // products: the products it is built on (underlying_product_ids), so it drifts when one is unpublished or drifts
  // sponsorships: the licence providers' sponsorships covering its components (see sponsorships.ts)
  state: {
    entities: Record<string, string>;
    licences: Record<string, string>;
    parties: Record<string, string>;
    vendors?: Record<string, string>;
    products?: Record<string, string>;
    sponsorships?: Record<string, string>;
  };
  definition_hash?: string; // the live v2 definition (see definition.ts), when the product has one
  contract?: DeveloperContract; // what developers build against, derived from that definition (see contract.ts)
  vendor_bindings?: VendorBinding[]; // handoffs the live version runs through a vendor subscription (see vendors.ts)
  licence_jurisdictions?: Record<string, string[]>; // pinned licence id -> the jurisdictions it covers this product in (see regime.ts)
  sponsorship_jurisdictions?: Record<string, string[]>; // pinned sponsorship id -> the jurisdictions it covers this product in
}
export interface VendorBinding {
  handoff_id: string;
  party_id: string;
  subscription_id: string;
  service_type: string;
  consent_purpose: string;
}
export type DriftChange = { kind: "entity" | "licence" | "party" | "vendor" | "product" | "sponsorship" | "legitimacy" | "covenant"; id: string; was: string; now: string; jurisdictions?: string[]; rule_type?: string };

// One public check that a firm is a real, legitimate company (see firm-checks.ts).
export const FIRM_CHECK_STATUSES = ["match", "mismatch", "not_found", "unavailable"] as const;
export type FirmCheckStatus = (typeof FIRM_CHECK_STATUSES)[number];
export interface FirmCheck {
  id: string;
  entity_id: string;
  source: string; // gleif_lei, fincen_msb
  subject: string; // what was looked up: the LEI, or the legal name as matched
  url: string;
  retrieved_at: string;
  status: FirmCheckStatus;
  fields: Record<string, unknown>; // the source's fields as matched against the firm's
  response_hash: string | null; // sha256 of the source's answer about this firm, in a stable form
  note: string | null;
  run_by: string | null;
}

// A licence provider's sponsorship of one component of a builder's product: the builder asks (pending), the
// provider approves it under some of its held licences for some jurisdictions, declines it, or later revokes it.
export const SPONSORSHIP_STATUSES = ["pending", "approved", "declined", "revoked"] as const;
export type SponsorshipStatus = (typeof SPONSORSHIP_STATUSES)[number];
export interface Sponsorship {
  id: string;
  product_id: string;
  component_key: string;
  builder_entity_id: string;
  provider_entity_id: string;
  requested_jurisdictions: string[]; // what the builder asked for (ISO 3166-2 codes, or the country code); empty: the country as a whole
  licence_ids: string[]; // the provider's held licences it's approved under (set on approval)
  jurisdictions: string[]; // where it's approved (set on approval); the country code means the whole country
  status: SponsorshipStatus;
  note: string | null;
  decision_note: string | null;
  requested_by: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}
export interface ProductRecord {
  product: FinancialProduct;
  owner_id: string | null; // null = bundled catalog product
  status: ProductStatus;
  version: number;
  last_test: TestReport | null;
  entity_id: string | null;
  action: ProductAction;
  underlying_product_ids: string[];
  components: Component[]; // the regulated primitives the product is made of (see regime.ts)
  parties: PartyBinding[]; // parties from the owner's roster, bound to components
  pins: Pins | null; // the live version's composition and the state of everything it rests on (see pins.ts)
  drift: { detected_at: string; changes: DriftChange[]; note?: string } | null; // pinned state that changed: new sales pause
  definition: Record<string, unknown> | null; // the v2 product definition (working copy; see definition.ts)
  access_mode: AccessMode;
  build_terms: BuildTerms;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

// Issuers create products; distributors sell and repackagers bundle other issuers' products.
export const PRODUCT_ROLES = ["issuance", "sale", "repackaging"] as const;
export type ProductAction = (typeof PRODUCT_ROLES)[number];
export const ACCESS_MODES = ["open", "approval", "private"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export interface BuildTerms {
  permitted_actions?: string[];
  required_disclosures?: string[];
  banned_phrases?: string[];
  allowed_personas?: string[];
  branding?: string;
  commercials?: { model: string; value?: number; notes?: string };
  handoff_url?: string; // where the runtime API sends deep_link / initiate_onboarding hand-offs
}

export const LEGAL_FORMS = [
  "company_private",
  "company_public",
  "llp",
  "partnership",
  "sole_proprietorship",
  "trust",
  "cooperative",
  "society",
  "nonprofit_company",
  "statutory_corporation",
  "government_entity",
  "foreign_branch",
] as const;
export const ENTITY_STATUSES = ["active", "suspended", "under_liquidation", "dissolved", "struck_off"] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];
export type Identifier = { scheme: string; value: string };
export interface Entity {
  id: string;
  name: string;
  legal_form: (typeof LEGAL_FORMS)[number] | null;
  incorporation: { country: string; subdivision?: string; date?: string } | null; // ISO 3166 codes, lowercase
  identifiers: Identifier[]; // e.g. { scheme: "in_cin", value: "U65999MH…" }, { scheme: "lei", … }
  status: EntityStatus;
  registration_numbers: Record<string, string>;
  regions: string[];
  created_by: string | null;
  created_at: string;
}

// Who fills a firm's roles: the stakeholders its licences mandate (internal people, external firms), and
// its commercial counterparties. Products may only name parties on their owner's roster.
export interface Party {
  id: string;
  entity_id: string;
  kind: "internal" | "external";
  person: { name: string; identifiers: Identifier[] } | null; // internal
  legal_entity_id: string | null; // external
  attributes: Record<string, string | number | boolean>; // facts checked against stakeholder qualifications
  fills: { licence_id: string; stakeholder: string }[]; // held licence record id + mandated stakeholder id
  relationship: string | null; // a code, e.g. collection_agency_agreement
  since: string | null;
  until: string | null;
  status: "active" | "ended";
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type LicenseStatus = "pending" | "verified" | "rejected" | "suspended";
export interface HeldLicense {
  id: string;
  entity_id: string;
  region: string;
  regulator_id: string;
  license_id: string;
  jurisdiction: string | null; // ISO 3166-2 code it was issued for, when its type is issued per jurisdiction
  registration_number: string;
  valid_from: string | null;
  valid_to: string | null;
  status: LicenseStatus;
  submitted_by: string | null;
  reviewed_by: string | null;
  review_note: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export type RequestKind = "product_access" | "campaign_launch";
export type RequestStatus = "pending" | "approved" | "rejected" | "revoked";
export interface AccessRequest {
  id: string;
  kind: RequestKind;
  product_id: string;
  app_id: string | null;
  campaign_id: string | null;
  requester_id: string;
  status: RequestStatus;
  note: string;
  decision_note: string | null;
  decided_by: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ProductVersion {
  product_id: string;
  version: number;
  status: "draft" | "published" | "superseded";
  data: FinancialProduct;
  changelog: string;
  last_test: TestReport | null;
  created_at: string;
  published_at: string | null;
}

export interface Enrollment {
  id: string;
  user_id: string;
  product_id: string;
  product_version: number;
  amount: number | null;
  status: "active" | "cancelled";
  campaign_id: string | null;
  variant: string | null;
  created_at: string;
}

export interface SegmentCriteria {
  enrolled_in?: string[]; // active in any of these products
  enrolled_in_lines?: string[]; // active in any product of these lines
  not_enrolled_in?: string[]; // active in none of these products
}

export interface Segment {
  id: string;
  owner_id: string;
  name: string;
  criteria: SegmentCriteria;
  created_at: string;
}

export interface Variant {
  key: string;
  headline: string;
  body: string;
  cta: string;
}

export type CampaignStatus = "draft" | "pending_approval" | "live" | "paused" | "ended";
export interface Campaign {
  id: string;
  owner_id: string;
  name: string;
  product_ids: string[];
  segment_id: string | null;
  channels: string[];
  variants: Variant[];
  status: CampaignStatus;
  last_lint: unknown;
  created_at: string;
  updated_at: string;
  launched_at: string | null;
}

export interface App {
  id: string;
  owner_id: string; // who created it; access goes by membership of its workspace
  workspace_id: string | null; // null only for an app made before workspaces, until Store.open migrates it
  name: string;
  description: string;
  audience: string;
  product_ids: string[];
  disclosures: string[];
  actions: string[];
  status: "draft" | "published";
  created_at: string;
  updated_at: string;
}

// --- SDKs and experiences (developer build layer) ---
export interface Sdk {
  id: string;
  owner_id: string;
  name: string;
  languages: string[];
  product_ids: string[];
  created_at: string;
}

// What a release was generated from, per product, so later changes can flag it stale.
export interface SdkReleaseSource {
  product_id: string;
  version: number;
  terms_hash: string;
  access: string;
}

export interface SdkRelease {
  sdk_id: string;
  version: string;
  changelog: string;
  sources: SdkReleaseSource[];
  files: { path: string; content: string }[];
  created_at: string;
}
// --- end SDKs and experiences ---

// What Mynt takes on a product line: a base percentage plus a share per point of the product's
// compliance and back-office workload, kept within [min_pct, max_pct] (see take-rates.ts).
export interface TakeRate {
  line: string;
  base_pct: number;
  workload_pct: number;
  min_pct: number;
  max_pct: number;
  basis: string; // what the percentage applies to, e.g. "revenue" or "volume"
  updated_by: string | null;
  updated_at: string;
}

// What a person asked Mynt for in their own words, and the products innovators offered for it.
export const PRODUCT_REQUEST_STATUSES = ["open", "in_progress", "offered", "closed"] as const;
export type ProductRequestStatus = (typeof PRODUCT_REQUEST_STATUSES)[number];
export interface ProductRequest {
  id: string;
  user_id: string;
  need: string;
  product_line: string | null;
  amount: number | null;
  currency: string;
  tenor_days: number | null;
  region: string;
  context: string | null;
  status: ProductRequestStatus;
  created_at: string;
}
export interface ProductRequestOffer {
  request_id: string;
  product_id: string;
  innovator_id: string;
  note: string;
  created_at: string;
}

export class DuplicateError extends Error {}

const sqlList = (values: readonly string[]) => values.map((v) => `'${v}'`).join(", ");

// Kept out of `public` so Supabase's auto-generated REST API never exposes these tables.
const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.users (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    roles text[] NOT NULL,
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.products (
    id text PRIMARY KEY,
    owner_id uuid REFERENCES financial_products.users(id),
    status text NOT NULL CHECK (status IN ('draft', 'published', 'unpublished')),
    data jsonb NOT NULL,
    last_test jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS products_owner_idx ON financial_products.products (owner_id);
  CREATE TABLE IF NOT EXISTS financial_products.enrollments (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    amount numeric,
    status text NOT NULL CHECK (status IN ('active', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS enrollments_one_active_idx
    ON financial_products.enrollments (user_id, product_id) WHERE status = 'active';
  CREATE TABLE IF NOT EXISTS financial_products.apps (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    description text NOT NULL,
    audience text NOT NULL,
    product_ids text[] NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'published')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS apps_owner_idx ON financial_products.apps (owner_id);
  -- Clerk sign-in: a user is linked to a Clerk user and holds no local token.
  ALTER TABLE financial_products.users ALTER COLUMN token_hash DROP NOT NULL;
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS clerk_user_id text UNIQUE;
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS email text UNIQUE;
  -- The whitelist: only these emails may use the server over Clerk, with these roles. Removing an
  -- invite cuts the user off on their next request.
  CREATE TABLE IF NOT EXISTS financial_products.invites (
    email text PRIMARY KEY CHECK (email = lower(email)),
    roles text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- Versioning: products.data/version is the live version; product_versions keeps every published
  -- version and at most one draft of the next one.
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
  CREATE TABLE IF NOT EXISTS financial_products.product_versions (
    product_id text NOT NULL REFERENCES financial_products.products(id),
    version integer NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'published', 'superseded')),
    data jsonb NOT NULL,
    changelog text NOT NULL,
    last_test jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    PRIMARY KEY (product_id, version)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS product_versions_one_draft_idx
    ON financial_products.product_versions (product_id) WHERE status = 'draft';
  -- GTM: segments over consumers' enrollment behaviour, campaigns with A/B variants, attribution.
  CREATE TABLE IF NOT EXISTS financial_products.segments (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    criteria jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.campaigns (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    product_ids text[] NOT NULL,
    segment_id uuid REFERENCES financial_products.segments(id),
    channels text[] NOT NULL,
    variants jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('draft', 'live', 'paused', 'ended')),
    last_lint jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    launched_at timestamptz
  );
  ALTER TABLE financial_products.enrollments ADD COLUMN IF NOT EXISTS product_version integer NOT NULL DEFAULT 1;
  ALTER TABLE financial_products.enrollments ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES financial_products.campaigns(id);
  ALTER TABLE financial_products.enrollments ADD COLUMN IF NOT EXISTS variant text;
  -- Admin-managed reference data and the audit log of admin actions.
  CREATE TABLE IF NOT EXISTS financial_products.regions (
    code text PRIMARY KEY CHECK (code = 'global' OR code ~ '^[A-Z]{2}$'),
    name text NOT NULL,
    regulators text[] NOT NULL DEFAULT '{}',
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS ecosystem text NOT NULL DEFAULT '';
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS procedures jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS sources text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.regions ADD COLUMN IF NOT EXISTS regulatory jsonb NOT NULL DEFAULT '{"regulators": [], "legal": []}';
  -- Legal is split into legislative and judiciary branches; convert the earlier flat list once.
  ALTER TABLE financial_products.regions ALTER COLUMN regulatory
    SET DEFAULT '{"regulators": [], "legal": {"legislative": [], "judiciary": []}}';
  UPDATE financial_products.regions SET regulatory = jsonb_set(regulatory, '{legal}', jsonb_build_object(
    'legislative', COALESCE((SELECT jsonb_agg(l) FROM jsonb_array_elements(regulatory->'legal') l
                             WHERE l->>'kind' IS DISTINCT FROM 'judgment'), '[]'::jsonb),
    'judiciary', COALESCE((SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                             'id', l->'id', 'title', l->'title',
                             'court', COALESCE(l->'issued_by', to_jsonb('Verify: court not recorded'::text)),
                             'court_level', 'other', 'citation', l->'citation', 'decided_on', l->'effective_from',
                             'bench', '[]'::jsonb, 'holding', '', 'summary', COALESCE(l->'summary', to_jsonb(''::text)),
                             'interprets', '[]'::jsonb, 'status', 'good_law', 'url', l->'url', 'applies_to', l->'applies_to')))
                           FROM jsonb_array_elements(regulatory->'legal') l WHERE l->>'kind' = 'judgment'), '[]'::jsonb)))
  WHERE jsonb_typeof(regulatory->'legal') = 'array';
  CREATE TABLE IF NOT EXISTS financial_products.product_categories (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9_]*$'),
    name text NOT NULL,
    product_lines text[] NOT NULL,
    description text NOT NULL DEFAULT '',
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.audit_log (
    id uuid PRIMARY KEY,
    actor_id uuid REFERENCES financial_products.users(id),
    action text NOT NULL,
    target text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS audit_log_created_idx ON financial_products.audit_log (created_at DESC);
  -- Regulated product types are a region-wide catalogue; regulators map onto them many to many,
  -- each supervising a subset of a product type's actions.
  CREATE TABLE IF NOT EXISTS financial_products.regulated_product_types (
    region text NOT NULL REFERENCES financial_products.regions(code),
    id text NOT NULL CHECK (id ~ '^[a-z0-9][a-z0-9_.-]*$'),
    name text NOT NULL,
    description text NOT NULL DEFAULT '',
    type_id text NOT NULL,
    actions text[] NOT NULL CHECK (
      cardinality(actions) > 0 AND actions <@ ARRAY[${sqlList(PRODUCT_ACTIONS)}]::text[]
    ),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (region, id)
  );
  CREATE TABLE IF NOT EXISTS financial_products.regulator_product_types (
    region text NOT NULL,
    regulator_id text NOT NULL,
    product_type_id text NOT NULL,
    actions text[] NOT NULL CHECK (cardinality(actions) > 0),
    PRIMARY KEY (region, regulator_id, product_type_id),
    FOREIGN KEY (region, product_type_id) REFERENCES financial_products.regulated_product_types(region, id) ON DELETE RESTRICT
  );
  CREATE INDEX IF NOT EXISTS regulator_product_types_product_idx
    ON financial_products.regulator_product_types (region, product_type_id);
  -- Tables created before advice, servicing, underwriting and assessment carry the five-action check.
  ALTER TABLE financial_products.regulated_product_types DROP CONSTRAINT IF EXISTS regulated_product_types_actions_check;
  ALTER TABLE financial_products.regulated_product_types ADD CONSTRAINT regulated_product_types_actions_check
    CHECK (cardinality(actions) > 0 AND actions <@ ARRAY[${sqlList(PRODUCT_ACTIONS)}]::text[]);
  -- What a primitive is made of, and the statutory or tax structure around it.
  ALTER TABLE financial_products.regulated_product_types ADD COLUMN IF NOT EXISTS underlying text
    CHECK (underlying IN (${sqlList(UNDERLYINGS)}));
  ALTER TABLE financial_products.regulated_product_types ADD COLUMN IF NOT EXISTS wrapper text
    CHECK (wrapper IN (${sqlList(WRAPPERS)}));
  -- ADD COLUMN IF NOT EXISTS leaves an existing column's check as it was created, so a value added to the list
  -- later (digital_assets) would be refused on an older database. Re-create each list check on every start.
  ALTER TABLE financial_products.regulated_product_types DROP CONSTRAINT IF EXISTS regulated_product_types_underlying_check;
  ALTER TABLE financial_products.regulated_product_types ADD CONSTRAINT regulated_product_types_underlying_check
    CHECK (underlying IN (${sqlList(UNDERLYINGS)}));
  ALTER TABLE financial_products.regulated_product_types DROP CONSTRAINT IF EXISTS regulated_product_types_wrapper_check;
  ALTER TABLE financial_products.regulated_product_types ADD CONSTRAINT regulated_product_types_wrapper_check
    CHECK (wrapper IN (${sqlList(WRAPPERS)}));
  -- ---- Runtime layer: per-app API keys, hand-offs, analytics events, webhooks, app releases ----
  CREATE TABLE IF NOT EXISTS financial_products.api_keys (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    environment text NOT NULL CHECK (environment IN ('live', 'sandbox')),
    label text NOT NULL,
    prefix text NOT NULL,
    key_hash text NOT NULL UNIQUE,
    allowed_origins text[] NOT NULL DEFAULT '{}',
    status text NOT NULL CHECK (status IN ('active', 'revoked')),
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz,
    rotated_at timestamptz,
    revoked_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS api_keys_app_idx ON financial_products.api_keys (app_id);
  CREATE TABLE IF NOT EXISTS financial_products.handoffs (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    key_id uuid REFERENCES financial_products.api_keys(id),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    action text NOT NULL,
    consumer_ref text,
    sandbox boolean NOT NULL,
    status text NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
    redirect_url text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS handoffs_app_idx ON financial_products.handoffs (app_id, created_at);
  CREATE INDEX IF NOT EXISTS handoffs_product_idx ON financial_products.handoffs (product_id, created_at);
  CREATE TABLE IF NOT EXISTS financial_products.app_events (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    type text NOT NULL CHECK (type IN ('view', 'click', 'handoff_started')),
    screen text,
    sandbox boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS app_events_app_idx ON financial_products.app_events (app_id, created_at);
  CREATE INDEX IF NOT EXISTS app_events_product_idx ON financial_products.app_events (product_id, created_at);
  CREATE TABLE IF NOT EXISTS financial_products.test_consumers (
    consumer_ref text PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    label text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS financial_products.webhooks (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    url text NOT NULL,
    events text[] NOT NULL,
    secret text NOT NULL,
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS webhooks_app_idx ON financial_products.webhooks (app_id);
  CREATE TABLE IF NOT EXISTS financial_products.webhook_deliveries (
    id uuid PRIMARY KEY,
    webhook_id uuid NOT NULL REFERENCES financial_products.webhooks(id) ON DELETE CASCADE,
    event_id uuid NOT NULL,
    type text NOT NULL,
    payload jsonb NOT NULL,
    sandbox boolean NOT NULL DEFAULT false,
    status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    last_response_code integer,
    last_error text,
    next_attempt_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx ON financial_products.webhook_deliveries (next_attempt_at) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS webhook_deliveries_hook_idx ON financial_products.webhook_deliveries (webhook_id, created_at DESC);
  -- Snapshots of the whole app row (as jsonb, so columns added later are captured too).
  CREATE TABLE IF NOT EXISTS financial_products.app_releases (
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    version text NOT NULL,
    changelog text NOT NULL,
    snapshot jsonb NOT NULL,
    released_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, version)
  );
  -- ---- end runtime layer ----
  -- Entities (licensed firms) and the licences they hold; admins verify licences.
  CREATE TABLE IF NOT EXISTS financial_products.entities (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    registration_numbers jsonb NOT NULL DEFAULT '{}',
    regions text[] NOT NULL DEFAULT '{}',
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES financial_products.entities(id);
  -- When the account became a member of its current firm: the partner kit's member cool-off counts from it.
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS entity_joined_at timestamptz;
  -- When the account gained licence-provider standing at its firm: when it joined as the firm's first licence provider,
  -- or when an existing member accepted it (firm-notices.ts). Null: no standing, so it counts for no partner-kit gate,
  -- whatever its roles say. Accounts that were licence providers at a firm before this column existed are backfilled
  -- once from when they joined (lp_since_backfilled marks rows the backfill has seen; new rows start seen).
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS lp_since timestamptz;
  ALTER TABLE financial_products.users ADD COLUMN IF NOT EXISTS lp_since_backfilled boolean NOT NULL DEFAULT false;
  ALTER TABLE financial_products.users ALTER COLUMN lp_since_backfilled SET DEFAULT true;
  UPDATE financial_products.users SET lp_since = CASE WHEN entity_id IS NOT NULL AND 'license_provider' = ANY(roles) THEN GREATEST(created_at, entity_joined_at) ELSE lp_since END, lp_since_backfilled = true
    WHERE NOT lp_since_backfilled;
  CREATE TABLE IF NOT EXISTS financial_products.held_licenses (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    region text NOT NULL,
    regulator_id text NOT NULL,
    license_id text NOT NULL,
    registration_number text NOT NULL,
    valid_from text,
    valid_to text,
    status text NOT NULL CHECK (status IN ('pending', 'verified', 'rejected', 'suspended')),
    submitted_by uuid REFERENCES financial_products.users(id),
    reviewed_by uuid REFERENCES financial_products.users(id),
    review_note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    UNIQUE (entity_id, region, regulator_id, license_id)
  );
  -- A licence type issued per jurisdiction (e.g. a money transmitter licence in several US states) is held once
  -- per jurisdiction: the held licence records the ISO 3166-2 code it was issued for (null: not issued per
  -- jurisdiction), and the uniqueness above widens to include it.
  ALTER TABLE financial_products.held_licenses ADD COLUMN IF NOT EXISTS jurisdiction text;
  CREATE UNIQUE INDEX IF NOT EXISTS held_licenses_per_jurisdiction
    ON financial_products.held_licenses (entity_id, region, regulator_id, license_id, (COALESCE(jurisdiction, '')));
  ALTER TABLE financial_products.held_licenses DROP CONSTRAINT IF EXISTS held_licenses_entity_id_region_regulator_id_license_id_key;
  -- Products: who issues or distributes them, what they build on, and how developers may use them.
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES financial_products.entities(id);
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'issuance';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS underlying_product_ids text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS components jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS access_mode text NOT NULL DEFAULT 'approval';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS build_terms jsonb NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.apps ADD COLUMN IF NOT EXISTS disclosures text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.apps ADD COLUMN IF NOT EXISTS actions text[] NOT NULL DEFAULT '{display}';
  -- Campaigns over other innovators' products wait for their approval.
  ALTER TABLE financial_products.campaigns DROP CONSTRAINT IF EXISTS campaigns_status_check;
  ALTER TABLE financial_products.campaigns ADD CONSTRAINT campaigns_status_check
    CHECK (status IN ('draft', 'pending_approval', 'live', 'paused', 'ended'));
  -- Developers' requests to build on a product, and to launch campaigns over it.
  CREATE TABLE IF NOT EXISTS financial_products.requests (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('product_access', 'campaign_launch')),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    app_id uuid REFERENCES financial_products.apps(id),
    campaign_id uuid REFERENCES financial_products.campaigns(id),
    requester_id uuid NOT NULL REFERENCES financial_products.users(id),
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revoked')),
    note text NOT NULL DEFAULT '',
    decision_note text,
    decided_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS requests_product_idx ON financial_products.requests (product_id, status);
  -- SDKs and experiences (developer build layer).
  ALTER TABLE financial_products.apps ADD COLUMN IF NOT EXISTS experience jsonb;
  CREATE TABLE IF NOT EXISTS financial_products.sdks (
    id uuid PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES financial_products.users(id),
    name text NOT NULL,
    languages text[] NOT NULL,
    product_ids text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sdks_owner_idx ON financial_products.sdks (owner_id);
  CREATE TABLE IF NOT EXISTS financial_products.sdk_releases (
    sdk_id uuid NOT NULL REFERENCES financial_products.sdks(id),
    version text NOT NULL,
    changelog text NOT NULL,
    sources jsonb NOT NULL,
    files jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (sdk_id, version)
  );
  -- Releases are immutable: a published bundle never changes under its version.
  CREATE OR REPLACE FUNCTION financial_products.sdk_releases_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    RAISE EXCEPTION 'SDK releases are immutable';
  END $$;
  DROP TRIGGER IF EXISTS sdk_releases_immutable ON financial_products.sdk_releases;
  CREATE TRIGGER sdk_releases_immutable BEFORE UPDATE ON financial_products.sdk_releases
    FOR EACH ROW EXECUTE FUNCTION financial_products.sdk_releases_immutable();
  -- end SDKs and experiences
  -- Product requests: a person's need in their own words, and innovators' products offered for it.
  CREATE TABLE IF NOT EXISTS financial_products.product_requests (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    need text NOT NULL,
    product_line text,
    amount numeric,
    currency text NOT NULL DEFAULT 'INR',
    tenor_days integer,
    region text NOT NULL DEFAULT 'IN',
    context text,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'offered', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS product_requests_user_idx ON financial_products.product_requests (user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS product_requests_status_idx ON financial_products.product_requests (status, created_at DESC);
  CREATE TABLE IF NOT EXISTS financial_products.product_request_offers (
    request_id uuid NOT NULL REFERENCES financial_products.product_requests(id),
    product_id text NOT NULL REFERENCES financial_products.products(id),
    innovator_id uuid NOT NULL REFERENCES financial_products.users(id),
    note text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (request_id, product_id)
  );
  -- Take rates: what Mynt takes per product line, scaled by each product's compliance workload.
  CREATE TABLE IF NOT EXISTS financial_products.take_rates (
    line text PRIMARY KEY CHECK (line IN (${sqlList(PRODUCT_LINES)})),
    base_pct numeric NOT NULL CHECK (base_pct >= 0),
    workload_pct numeric NOT NULL CHECK (workload_pct >= 0),
    min_pct numeric NOT NULL CHECK (min_pct >= 0),
    max_pct numeric NOT NULL CHECK (max_pct >= min_pct AND max_pct <= 100),
    basis text NOT NULL,
    updated_by uuid REFERENCES financial_products.users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.take_rates DROP CONSTRAINT IF EXISTS take_rates_line_check;
  ALTER TABLE financial_products.take_rates ADD CONSTRAINT take_rates_line_check CHECK (line IN (${sqlList(PRODUCT_LINES)}));
  -- Legal entities as typed facts, and the parties on each firm's roster.
  ALTER TABLE financial_products.entities ADD COLUMN IF NOT EXISTS legal_form text CHECK (legal_form IN (${sqlList(LEGAL_FORMS)}));
  ALTER TABLE financial_products.entities DROP CONSTRAINT IF EXISTS entities_legal_form_check;
  ALTER TABLE financial_products.entities ADD CONSTRAINT entities_legal_form_check CHECK (legal_form IN (${sqlList(LEGAL_FORMS)}));
  ALTER TABLE financial_products.entities ADD COLUMN IF NOT EXISTS incorporation jsonb;
  ALTER TABLE financial_products.entities ADD COLUMN IF NOT EXISTS identifiers jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE financial_products.entities ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN (${sqlList(ENTITY_STATUSES)}));
  CREATE TABLE IF NOT EXISTS financial_products.entity_parties (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    kind text NOT NULL CHECK (kind IN ('internal', 'external')),
    person jsonb,
    legal_entity_id uuid REFERENCES financial_products.entities(id),
    attributes jsonb NOT NULL DEFAULT '{}',
    fills jsonb NOT NULL DEFAULT '[]',
    relationship text,
    since text,
    until text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((kind = 'internal' AND person IS NOT NULL AND legal_entity_id IS NULL)
        OR (kind = 'external' AND legal_entity_id IS NOT NULL AND person IS NULL))
  );
  CREATE INDEX IF NOT EXISTS entity_parties_entity_idx ON financial_products.entity_parties (entity_id);
  -- Each entity's GRC folder, and its parties' folders, mirroring the GRC of the licences it holds.
  CREATE TABLE IF NOT EXISTS financial_products.grc_records (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    party_id uuid REFERENCES financial_products.entity_parties(id),
    licence_id uuid REFERENCES financial_products.held_licenses(id),
    section text NOT NULL,
    ref text,
    key text NOT NULL,
    record jsonb NOT NULL,
    status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'superseded')),
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS grc_records_current_idx ON financial_products.grc_records
    (entity_id, COALESCE(party_id::text, ''), COALESCE(licence_id::text, ''), section, key) WHERE status = 'current';
  -- A product binds roster parties to its components; publishing pins them, and drift pauses new sales.
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS parties jsonb NOT NULL DEFAULT '[]';
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS pins jsonb;
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS drift jsonb;
  -- v2 product definitions, and product GRC folders (records scoped to one of the entity's products).
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS definition jsonb;
  ALTER TABLE financial_products.grc_records ADD COLUMN IF NOT EXISTS product_id text REFERENCES financial_products.products(id);
  DROP INDEX IF EXISTS financial_products.grc_records_current_idx;
  CREATE UNIQUE INDEX IF NOT EXISTS grc_records_current_v2_idx ON financial_products.grc_records
    (entity_id, COALESCE(party_id::text, ''), COALESCE(product_id, ''), COALESCE(licence_id::text, ''), section, key) WHERE status = 'current';
  -- Client sessions: short-lived, scoped secrets an app's server mints for one customer's device, so
  -- browsers and phones never hold the app's key. Only the secret's hash is stored.
  CREATE TABLE IF NOT EXISTS financial_products.client_sessions (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    key_id uuid NOT NULL REFERENCES financial_products.api_keys(id),
    secret_hash text NOT NULL UNIQUE,
    customer_ref text,
    product_ids text[] NOT NULL,
    scopes text[] NOT NULL,
    sandbox boolean NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
  );
  -- What a customer's device was shown and agreed to (disclosures, consents), against the contract version.
  CREATE TABLE IF NOT EXISTS financial_products.client_evidence (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    session_id uuid NOT NULL REFERENCES financial_products.client_sessions(id),
    product_id text NOT NULL,
    contract_hash text,
    type text NOT NULL CHECK (type IN ('disclosure_shown', 'consent_given', 'consent_withdrawn')),
    subject text NOT NULL,
    content_hash text,
    customer_ref text,
    sandbox boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS client_evidence_app_idx ON financial_products.client_evidence (app_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS client_evidence_subject_idx ON financial_products.client_evidence (session_id, product_id, subject, created_at DESC);
  -- Apps' journeys: declarative specs checked against one version of a product's developer contract.
  CREATE TABLE IF NOT EXISTS financial_products.app_journeys (
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    journey_id text NOT NULL,
    product_id text NOT NULL,
    contract_hash text NOT NULL,
    spec jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, journey_id)
  );
  -- The customer vault: fields a customer gave once, per app and customer reference, encrypted at rest.
  CREATE TABLE IF NOT EXISTS financial_products.customer_vault (
    app_id uuid NOT NULL REFERENCES financial_products.apps(id),
    customer_ref text NOT NULL,
    sandbox boolean NOT NULL,
    field text NOT NULL,
    sealed text NOT NULL,
    source text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, customer_ref, sandbox, field)
  );
  -- Deployment settings admins change from Mynt (e.g. whether anyone may sign up).
  CREATE TABLE IF NOT EXISTS financial_products.settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by uuid REFERENCES financial_products.users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Emails an admin revoked: public sign-up doesn't let them back in.
  CREATE TABLE IF NOT EXISTS financial_products.signup_blocks (
    email text PRIMARY KEY,
    blocked_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- Vendors: standard services (identity, KYC, account data, bureau, e-sign, …) admins define per region as
  -- one input/output contract, vendors' offerings of them (checked by Mynt before listing), and innovators'
  -- subscriptions. Mynt does no billing: usage is counts per subscription and day, never customer data.
  CREATE TABLE IF NOT EXISTS financial_products.service_types (
    region text NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    description text NOT NULL DEFAULT '',
    input_schema jsonb NOT NULL,
    output_schema jsonb NOT NULL,
    consent_purpose text NOT NULL,
    fills text[] NOT NULL DEFAULT '{}',
    innovator_licences text[] NOT NULL DEFAULT '{}',
    vendor_licences text[] NOT NULL DEFAULT '{}',
    fixtures jsonb NOT NULL DEFAULT '[]',
    updated_by uuid REFERENCES financial_products.users(id),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (region, key)
  );
  CREATE TABLE IF NOT EXISTS financial_products.vendor_offerings (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    region text NOT NULL,
    service_type text NOT NULL,
    name text NOT NULL,
    test_base_url text NOT NULL,
    live_base_url text,
    price jsonb NOT NULL,
    sla_notes text NOT NULL DEFAULT '',
    licence_ids uuid[] NOT NULL DEFAULT '{}',
    requires_credential boolean NOT NULL DEFAULT false,
    conformance_secret text NOT NULL,
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'conformance_passed', 'listed', 'suspended')),
    status_note text,
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (region, service_type) REFERENCES financial_products.service_types(region, key)
  );
  CREATE INDEX IF NOT EXISTS vendor_offerings_entity_idx ON financial_products.vendor_offerings (entity_id);
  CREATE TABLE IF NOT EXISTS financial_products.vendor_conformance_runs (
    id uuid PRIMARY KEY,
    offering_id uuid NOT NULL REFERENCES financial_products.vendor_offerings(id),
    passed boolean NOT NULL,
    cases jsonb NOT NULL,
    run_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS vendor_conformance_offering_idx ON financial_products.vendor_conformance_runs (offering_id, created_at DESC);
  -- A firm's key vault: one row per key, each of one type; values sealed, never returned.
  CREATE TABLE IF NOT EXISTS financial_products.key_vault (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    type text NOT NULL,
    label text NOT NULL,
    sealed text NOT NULL,
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS key_vault_entity_idx ON financial_products.key_vault (entity_id);
  CREATE TABLE IF NOT EXISTS financial_products.vendor_subscriptions (
    id uuid PRIMARY KEY,
    offering_id uuid NOT NULL REFERENCES financial_products.vendor_offerings(id),
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    party_id uuid NOT NULL REFERENCES financial_products.entity_parties(id),
    party_created boolean NOT NULL DEFAULT false,
    live boolean NOT NULL DEFAULT false,
    signing_secret text NOT NULL,
    secret_shown_at timestamptz,
    test_credential_key_id uuid REFERENCES financial_products.key_vault(id),
    live_credential_key_id uuid REFERENCES financial_products.key_vault(id),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS vendor_subscriptions_one_active_idx ON financial_products.vendor_subscriptions (offering_id, entity_id) WHERE status = 'active';
  CREATE TABLE IF NOT EXISTS financial_products.vendor_usage (
    subscription_id uuid NOT NULL REFERENCES financial_products.vendor_subscriptions(id),
    day date NOT NULL,
    environment text NOT NULL CHECK (environment IN ('test', 'live')),
    ok integer NOT NULL DEFAULT 0,
    errors integer NOT NULL DEFAULT 0,
    PRIMARY KEY (subscription_id, day, environment)
  );
  ALTER TABLE financial_products.service_types ADD COLUMN IF NOT EXISTS client_result jsonb;
  -- What a device sends with each call, and quotes: a quote service's answer carries a price that expires, and
  -- the service that accepts it is sent the quote's id once.
  ALTER TABLE financial_products.service_types ADD COLUMN IF NOT EXISTS params_schema jsonb;
  ALTER TABLE financial_products.service_types ADD COLUMN IF NOT EXISTS params_fixture jsonb;
  ALTER TABLE financial_products.service_types ADD COLUMN IF NOT EXISTS quote boolean NOT NULL DEFAULT false;
  ALTER TABLE financial_products.service_types ADD COLUMN IF NOT EXISTS accepts text;
  -- An admin's explicit declaration that a service moves money, so it goes through approved money rails (see
  -- money-rails.ts). NULL only until this backfill, for types defined before it existed.
  ALTER TABLE financial_products.service_types ADD COLUMN IF NOT EXISTS moves_money boolean;
  UPDATE financial_products.service_types SET moves_money = (category = 'ramp' AND NOT quote) WHERE moves_money IS NULL;
  -- Client actions served by a product's bound vendor service: one row per call, the full result sealed (the
  -- device only ever gets client_outcome, which the service type's client_result allows).
  CREATE TABLE IF NOT EXISTS financial_products.vendor_action_runs (
    id uuid PRIMARY KEY,
    request_id uuid NOT NULL UNIQUE,
    subscription_id uuid NOT NULL REFERENCES financial_products.vendor_subscriptions(id) ON DELETE CASCADE,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id) ON DELETE CASCADE,
    app_id uuid NOT NULL REFERENCES financial_products.apps(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES financial_products.client_sessions(id) ON DELETE CASCADE,
    product_id text NOT NULL,
    contract_hash text,
    action text NOT NULL,
    service_type text NOT NULL,
    customer_ref text,
    sandbox boolean NOT NULL,
    -- withdrawn: the customer withdrew consent or erased their data before it finished; expired: never finished.
    status text NOT NULL CHECK (status IN ('calling', 'pending', 'completed', 'failed', 'withdrawn', 'expired')),
    client_outcome jsonb NOT NULL DEFAULT '{}',
    result_sealed text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS vendor_action_runs_session_idx ON financial_products.vendor_action_runs (session_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS vendor_action_runs_customer_idx ON financial_products.vendor_action_runs (app_id, customer_ref, sandbox);
  CREATE INDEX IF NOT EXISTS vendor_action_runs_open_idx ON financial_products.vendor_action_runs (created_at) WHERE status IN ('calling', 'pending');
  -- A completed quote: the vendor's quote id (never shown to the device), until when it may be accepted, and the
  -- run that accepted it (one at most).
  ALTER TABLE financial_products.vendor_action_runs ADD COLUMN IF NOT EXISTS quote_id text;
  ALTER TABLE financial_products.vendor_action_runs ADD COLUMN IF NOT EXISTS quote_expires_at timestamptz;
  ALTER TABLE financial_products.vendor_action_runs ADD COLUMN IF NOT EXISTS accepted_by uuid;
  -- A ramp offering Mynt answers through an adapter in front of the partner's own API (src/ramp-adapters/): the
  -- adapter, its non-secret settings, and the partner's credentials as keys in the ramp firm's key vault.
  ALTER TABLE financial_products.vendor_offerings ADD COLUMN IF NOT EXISTS adapter text;
  ALTER TABLE financial_products.vendor_offerings ADD COLUMN IF NOT EXISTS adapter_config jsonb;
  ALTER TABLE financial_products.vendor_offerings ADD COLUMN IF NOT EXISTS adapter_test_key_id uuid REFERENCES financial_products.key_vault(id);
  ALTER TABLE financial_products.vendor_offerings ADD COLUMN IF NOT EXISTS adapter_live_key_id uuid REFERENCES financial_products.key_vault(id);
  -- The partner's own ids for a customer (by Mynt's pseudonymous key for app and customer), linked by the ramp firm.
  CREATE TABLE IF NOT EXISTS financial_products.ramp_partner_links (
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    environment text NOT NULL CHECK (environment IN ('test', 'live')),
    customer_key text NOT NULL,
    partner_customer_id text NOT NULL,
    partner_payout_account_id text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (entity_id, environment, customer_key)
  );
  -- Transfers an adapter started at the partner, so its webhooks and status reads find Mynt's run.
  CREATE TABLE IF NOT EXISTS financial_products.ramp_adapter_transfers (
    offering_id uuid NOT NULL REFERENCES financial_products.vendor_offerings(id),
    environment text NOT NULL CHECK (environment IN ('test', 'live')),
    partner_transfer_id text NOT NULL,
    subscription_id uuid NOT NULL REFERENCES financial_products.vendor_subscriptions(id),
    request_id uuid NOT NULL,
    direction text NOT NULL CHECK (direction IN ('in', 'out')),
    status text NOT NULL,
    partner_side jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (offering_id, environment, partner_transfer_id)
  );
  -- A completed ramp transfer the partner later reversed; and a result that came after the run ended (kept sealed).
  ALTER TABLE financial_products.vendor_action_runs DROP CONSTRAINT IF EXISTS vendor_action_runs_status_check;
  ALTER TABLE financial_products.vendor_action_runs ADD CONSTRAINT vendor_action_runs_status_check
    CHECK (status IN ('calling', 'pending', 'completed', 'failed', 'withdrawn', 'expired', 'reversed'));
  ALTER TABLE financial_products.vendor_action_runs ADD COLUMN IF NOT EXISTS late_result_sealed text;
  -- Partner webhook events already applied, so a redelivery is a no-op.
  CREATE TABLE IF NOT EXISTS financial_products.ramp_adapter_events (
    offering_id uuid NOT NULL REFERENCES financial_products.vendor_offerings(id),
    event_id text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (offering_id, event_id)
  );
  -- A customer's request, from their own session, to be linked to the ramp partner. The ramp firm sees only the id.
  CREATE TABLE IF NOT EXISTS financial_products.ramp_link_requests (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    app_id uuid NOT NULL,
    customer_ref text NOT NULL,
    sandbox boolean NOT NULL,
    session_id uuid NOT NULL,
    product_id text NOT NULL,
    consent_purpose text NOT NULL,
    status text NOT NULL DEFAULT 'requested',
    refusal text,
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
  );
  ALTER TABLE financial_products.ramp_partner_links ADD COLUMN IF NOT EXISTS link_request_id uuid;
  ALTER TABLE financial_products.ramp_partner_links ADD COLUMN IF NOT EXISTS identity_verified_at timestamptz;
  ALTER TABLE financial_products.ramp_link_requests DROP CONSTRAINT IF EXISTS ramp_link_requests_status_check;
  ALTER TABLE financial_products.ramp_link_requests ADD CONSTRAINT ramp_link_requests_status_check CHECK (status IN ('requested', 'linked', 'refused', 'expired'));
  CREATE INDEX IF NOT EXISTS ramp_link_requests_session_idx ON financial_products.ramp_link_requests (session_id, created_at);
  CREATE INDEX IF NOT EXISTS ramp_link_requests_customer_idx ON financial_products.ramp_link_requests (app_id, customer_ref, created_at);
  -- One partner customer is linked, verified, to one Mynt customer at most.
  CREATE UNIQUE INDEX IF NOT EXISTS ramp_partner_links_one_customer_idx ON financial_products.ramp_partner_links (entity_id, environment, partner_customer_id) WHERE identity_verified_at IS NOT NULL;
  CREATE INDEX IF NOT EXISTS ramp_adapter_transfers_open_idx ON financial_products.ramp_adapter_transfers (updated_at) WHERE status = 'submitted';
  -- Evidence of a vendor-served action's end (status only, never the result).
  ALTER TABLE financial_products.client_evidence DROP CONSTRAINT IF EXISTS client_evidence_type_check;
  ALTER TABLE financial_products.client_evidence ADD CONSTRAINT client_evidence_type_check
    CHECK (type IN ('disclosure_shown', 'consent_given', 'consent_withdrawn', 'action_completed', 'action_failed'));
  -- Firms' (innovators') own webhooks, for what Mynt does on their behalf: a webhook belongs to an app or a firm.
  ALTER TABLE financial_products.webhooks ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES financial_products.entities(id);
  ALTER TABLE financial_products.webhooks ALTER COLUMN app_id DROP NOT NULL;
  CREATE INDEX IF NOT EXISTS webhooks_entity_idx ON financial_products.webhooks (entity_id) WHERE entity_id IS NOT NULL;
  -- What Mynt's own code derives for a product (its regime's coverage and its take rate), stored so it's cheap to read.
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS regime_summary jsonb;
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS take_rate jsonb;
  ALTER TABLE financial_products.products ADD COLUMN IF NOT EXISTS derived_at timestamptz;
  -- Licence providers' sponsorships: one component of a builder's product covered by the provider's held
  -- licences in the jurisdictions it approved (see sponsorships.ts).
  CREATE TABLE IF NOT EXISTS financial_products.sponsorships (
    id uuid PRIMARY KEY,
    product_id text NOT NULL,
    component_key text NOT NULL,
    builder_entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    provider_entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    requested_jurisdictions text[] NOT NULL DEFAULT '{}',
    licence_ids uuid[] NOT NULL DEFAULT '{}',
    jurisdictions text[] NOT NULL DEFAULT '{}',
    status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'revoked')),
    note text,
    decision_note text,
    requested_by uuid REFERENCES financial_products.users(id),
    decided_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    decided_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS sponsorships_product_idx ON financial_products.sponsorships (product_id, component_key);
  CREATE INDEX IF NOT EXISTS sponsorships_provider_idx ON financial_products.sponsorships (provider_entity_id, status);
  -- One pending request per component and provider at a time; approved ones may add up (more jurisdictions).
  CREATE UNIQUE INDEX IF NOT EXISTS sponsorships_one_pending_idx ON financial_products.sponsorships (product_id, component_key, provider_entity_id) WHERE status = 'pending';
  -- Approved money rails: how a licence-provider firm's sponsored products may move money, approved by an admin
  -- (see money-rails.ts). Limits are integer US cents; the daily limit runs per UTC day.
  CREATE TABLE IF NOT EXISTS financial_products.money_rails (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    kind text NOT NULL CHECK (kind IN ('ramp_adapter', 'ach', 'wire', 'rtp', 'fednow', 'push_to_card')),
    provider text NOT NULL,
    direction text NOT NULL CHECK (direction IN ('on_ramp', 'off_ramp', 'payout', 'deposit')),
    states text[] NOT NULL CHECK (cardinality(states) > 0),
    per_transfer_limit_cents bigint NOT NULL CHECK (per_transfer_limit_cents > 0),
    daily_limit_cents bigint NOT NULL CHECK (daily_limit_cents >= per_transfer_limit_cents),
    status text NOT NULL CHECK (status IN ('proposed', 'approved', 'suspended', 'revoked')),
    status_reason text,
    note text,
    proposed_by uuid REFERENCES financial_products.users(id),
    approved_by uuid REFERENCES financial_products.users(id),
    approved_at timestamptz,
    status_changed_by uuid REFERENCES financial_products.users(id),
    status_changed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS money_rails_one_live_idx ON financial_products.money_rails (entity_id, kind, provider, direction) WHERE status <> 'revoked';
  CREATE INDEX IF NOT EXISTS money_rails_entity_idx ON financial_products.money_rails (entity_id, status);
  -- The partner kit (partner-kit.ts): where a licence provider's ledger is read from. An admin fixes the endpoints;
  -- the firm takes the request-signing secret once, passes conformance, then switches its source from the sandbox.
  CREATE TABLE IF NOT EXISTS financial_products.partner_ledger_sources (
    entity_id uuid PRIMARY KEY REFERENCES financial_products.entities(id),
    test_url text,
    live_url text,
    signing_secret text, -- sealed under MYNT_VAULT_KEY
    secret_shown_at timestamptz,
    config_version integer NOT NULL DEFAULT 1,
    configured_by uuid REFERENCES financial_products.users(id),
    configured_at timestamptz,
    pending_test_url text, -- an admin's change, waiting for the firm's own member to confirm it
    pending_live_url text,
    pending_by uuid REFERENCES financial_products.users(id),
    pending_at timestamptz,
    pending_id uuid, -- a fresh id per proposal: what a confirmation names (a timestamp round-trips with less precision)
    expiry_warned_run_id uuid, -- the run whose coming expiry the firm was warned of
    expired_notified_run_id uuid, -- the run whose expiry the firm was told sent it back to the sandbox
    active_source text NOT NULL DEFAULT 'sandbox' CHECK (active_source IN ('sandbox', 'http', 'file')),
    active_run_id uuid,
    activated_by uuid REFERENCES financial_products.users(id),
    activated_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- A firm's separate key for signing its test statements: a test signature never counts for live, nor a live one
  -- for test. MACed under a key derived from the vault, so a key written straight into the table doesn't count.
  -- Every test key a firm has registered, MACed: a key once used for test is never accepted as a live key.
  CREATE TABLE IF NOT EXISTS financial_products.partner_test_signing_key_history (
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    public_key text NOT NULL,
    registered_by uuid REFERENCES financial_products.users(id),
    registered_at timestamptz NOT NULL DEFAULT now(),
    mac text NOT NULL,
    PRIMARY KEY (entity_id, public_key)
  );
  -- A second, long-standing member's approval of a live key change or a switch to live (partner-kit.ts).
  CREATE TABLE IF NOT EXISTS financial_products.partner_kit_approvals (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    action text NOT NULL CHECK (action IN ('live_key', 'source')),
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approving', 'approved', 'declined', 'superseded')),
    requested_by uuid NOT NULL REFERENCES financial_products.users(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid REFERENCES financial_products.users(id),
    decided_at timestamptz,
    approving_at timestamptz, -- when an approval claimed it: one stuck here past a few minutes is checked and put right
    expected_run_id uuid -- for a switch: the conformance run it would go live on, so a stuck claim is settled by it
  );
  CREATE INDEX IF NOT EXISTS partner_kit_approvals_idx ON financial_products.partner_kit_approvals (entity_id, status, requested_at DESC);
  -- An account an admin added to a licence provider that already has members: not a member of anything until one of
  -- the firm's existing members accepts it (firm-notices.ts). Declining it ends the request.
  CREATE TABLE IF NOT EXISTS financial_products.firm_member_requests (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    requested_by uuid REFERENCES financial_products.users(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid REFERENCES financial_products.users(id),
    decided_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS firm_member_requests_one_pending_idx ON financial_products.firm_member_requests (entity_id, user_id) WHERE status = 'pending';
  -- An admin's recovery of a request nobody at the firm can decide (firm-notices.ts): it waits 7 days, told to every
  -- current and past licence provider of the firm, any of whom can block it.
  ALTER TABLE financial_products.firm_member_requests ADD COLUMN IF NOT EXISTS recovery_reason text;
  ALTER TABLE financial_products.firm_member_requests ADD COLUMN IF NOT EXISTS recovery_started_by uuid REFERENCES financial_products.users(id);
  ALTER TABLE financial_products.firm_member_requests ADD COLUMN IF NOT EXISTS recovery_started_at timestamptz;
  ALTER TABLE financial_products.firm_member_requests ADD COLUMN IF NOT EXISTS reason text;
  -- Every time an account gained or lost licence-provider standing at a firm: who its past licence providers are.
  CREATE TABLE IF NOT EXISTS financial_products.firm_standing_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    event text NOT NULL CHECK (event IN ('gained', 'lost')),
    reason text,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS firm_standing_history_idx ON financial_products.firm_standing_history (entity_id, user_id);
  INSERT INTO financial_products.firm_standing_history (entity_id, user_id, event, reason, at)
    SELECT u.entity_id, u.id, 'gained', 'backfill', u.lp_since FROM financial_products.users u
    WHERE u.lp_since IS NOT NULL AND u.entity_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM financial_products.firm_standing_history h WHERE h.entity_id = u.entity_id AND h.user_id = u.id);
  -- When a firm first had a licence provider with standing. From then on nobody gains standing there directly: every
  -- route goes through a request an existing licence provider (or, failing one, an admin's delayed recovery) settles.
  ALTER TABLE financial_products.entities ADD COLUMN IF NOT EXISTS lp_established_at timestamptz;
  UPDATE financial_products.entities e SET lp_established_at = (SELECT min(h.at) FROM financial_products.firm_standing_history h WHERE h.entity_id = e.id AND h.event = 'gained')
    WHERE e.lp_established_at IS NULL AND EXISTS (SELECT 1 FROM financial_products.firm_standing_history h WHERE h.entity_id = e.id AND h.event = 'gained');
  -- Notices to each member of a firm, so a change made by one member (or an admin) is seen by the others.
  CREATE TABLE IF NOT EXISTS financial_products.firm_notices (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    type text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz
  );
  CREATE INDEX IF NOT EXISTS firm_notices_user_idx ON financial_products.firm_notices (user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS financial_products.partner_test_signing_keys (
    entity_id uuid PRIMARY KEY REFERENCES financial_products.entities(id),
    public_key text NOT NULL,
    registered_by uuid REFERENCES financial_products.users(id),
    registered_at timestamptz NOT NULL DEFAULT now(),
    mac text NOT NULL
  );
  -- Each conformance run, with its three parts. Cases name rules and product ids, never a figure.
  CREATE TABLE IF NOT EXISTS financial_products.partner_conformance_runs (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    source text NOT NULL CHECK (source IN ('http', 'file')),
    config_version integer,
    passed boolean NOT NULL,
    ledger_passed boolean NOT NULL,
    identity_passed boolean NOT NULL,
    rails_passed boolean NOT NULL,
    ledger jsonb NOT NULL,
    identity jsonb NOT NULL,
    rails jsonb NOT NULL,
    run_by uuid REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS partner_conformance_entity_idx ON financial_products.partner_conformance_runs (entity_id, source, created_at DESC);
  -- Daily files a licence provider uploaded: the signed statement, sealed (admins can't read the numbers).
  CREATE TABLE IF NOT EXISTS financial_products.partner_ledger_uploads (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    environment text NOT NULL CHECK (environment IN ('test', 'live')),
    as_of timestamptz NOT NULL,
    public_key text NOT NULL,
    statement_sealed text NOT NULL,
    products integer NOT NULL,
    uploaded_by uuid REFERENCES financial_products.users(id),
    uploaded_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS partner_ledger_uploads_idx ON financial_products.partner_ledger_uploads (entity_id, environment, as_of DESC);
  -- The money ledger: every movement Mynt instructed, in integer US cents. A customer appears only as a pseudonymous
  -- key. Live rows always name their rail and amount; sandbox rows may not, and never count against a limit.
  CREATE TABLE IF NOT EXISTS financial_products.money_movements (
    id uuid PRIMARY KEY,
    idempotency_key text NOT NULL UNIQUE,
    product_id text NOT NULL,
    app_id uuid,
    action text,
    sponsor_entity_id uuid REFERENCES financial_products.entities(id),
    rail_id uuid REFERENCES financial_products.money_rails(id),
    direction text CHECK (direction IN ('on_ramp', 'off_ramp', 'payout', 'deposit')),
    amount_cents bigint CHECK (amount_cents > 0),
    state text,
    state_source text,
    customer_key text,
    expected_total_cents bigint,
    settled_amount_cents bigint,
    settled_amount_differs boolean,
    status text NOT NULL CHECK (status IN ('requested', 'submitted', 'settled', 'failed', 'reversed')),
    status_detail text,
    external_ref text,
    subscription_id uuid,
    request_id uuid,
    earlier_request_ids uuid[] NOT NULL DEFAULT '{}', -- every earlier attempt's, so a late answer to any of them still lands
    sandbox boolean NOT NULL DEFAULT false,
    would_refuse text,
    limit_day date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    submitted_at timestamptz,
    settled_at timestamptz,
    failed_at timestamptz,
    reversed_at timestamptz,
    CHECK (sandbox OR (rail_id IS NOT NULL AND sponsor_entity_id IS NOT NULL AND direction IS NOT NULL AND amount_cents IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS money_movements_daily_idx ON financial_products.money_movements (rail_id, limit_day) WHERE NOT sandbox AND status <> 'failed';
  CREATE INDEX IF NOT EXISTS money_movements_product_idx ON financial_products.money_movements (product_id, created_at);
  CREATE INDEX IF NOT EXISTS money_movements_answer_idx ON financial_products.money_movements (subscription_id, request_id);
  CREATE INDEX IF NOT EXISTS money_movements_earlier_requests_idx ON financial_products.money_movements USING gin (earlier_request_ids);
  CREATE INDEX IF NOT EXISTS money_movements_open_idx ON financial_products.money_movements (updated_at) WHERE status IN ('requested', 'submitted');
  INSERT INTO financial_products.settings (key, value) VALUES ('money_ledger_started_at', to_jsonb(now())) ON CONFLICT (key) DO NOTHING;
  -- Every change to a customer's state of residence, append-only: which rails may serve them turns on it.
  CREATE TABLE IF NOT EXISTS financial_products.customer_state_history (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL,
    customer_key text,
    sandbox boolean NOT NULL,
    old_state text,
    old_state_unreadable boolean NOT NULL DEFAULT false, -- the old value couldn't be decrypted (a rotated vault key)
    new_state text,
    changed_by text NOT NULL,
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS customer_state_history_idx ON financial_products.customer_state_history (app_id, customer_key, created_at);
  CREATE OR REPLACE FUNCTION financial_products.customer_state_history_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'customer_state_history is append-only';
  END $fn$;
  DROP TRIGGER IF EXISTS customer_state_history_append_only ON financial_products.customer_state_history;
  CREATE TRIGGER customer_state_history_append_only BEFORE UPDATE OR DELETE ON financial_products.customer_state_history
    FOR EACH ROW EXECUTE FUNCTION financial_products.customer_state_history_is_append_only();
  DROP TRIGGER IF EXISTS customer_state_history_no_truncate ON financial_products.customer_state_history;
  CREATE TRIGGER customer_state_history_no_truncate BEFORE TRUNCATE ON financial_products.customer_state_history
    FOR EACH STATEMENT EXECUTE FUNCTION financial_products.customer_state_history_is_append_only();
  -- One live movement's reservation against its rail, in one transaction. The lock on the rail serialises every
  -- reservation and status change on that rail, and each statement here sees what the one before it committed, so
  -- the day's total can't be read stale and a rail suspended a moment ago can't be used.
  ALTER TABLE financial_products.money_movements ADD COLUMN IF NOT EXISTS state_verified_by text;
  ALTER TABLE financial_products.money_movements ADD COLUMN IF NOT EXISTS state_verified_offering uuid;
  ALTER TABLE financial_products.money_movements ADD COLUMN IF NOT EXISTS state_verified_at timestamptz;
  -- What each identity provider verified about a customer, one row per provider, so one provider can't overwrite
  -- another's result. A live movement goes by the latest row from a provider its sponsor accepts (see
  -- resolveCustomerState). identity_digest: a keyed hash of what was checked, to tell if the customer has changed since.
  -- suspended: the provider's latest check didn't pass.
  CREATE TABLE IF NOT EXISTS financial_products.customer_verified_states (
    app_id uuid NOT NULL,
    customer_ref text NOT NULL,
    offering_id uuid NOT NULL,
    state text,
    status text NOT NULL CHECK (status IN ('verified', 'suspended')),
    status_reason text,
    source text NOT NULL,
    verified_by_entity uuid,
    verified_by text NOT NULL,
    verified_at timestamptz NOT NULL,
    identity_fields text[] NOT NULL DEFAULT '{}',
    identity_digest text,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, customer_ref, offering_id),
    CHECK (status <> 'verified' OR (state IS NOT NULL AND identity_digest IS NOT NULL))
  );
  -- Identity providers a sponsor (or an admin) accepts for one sponsorship. The sponsor's own offerings need no entry.
  CREATE TABLE IF NOT EXISTS financial_products.sponsorship_identity_providers (
    sponsorship_id uuid NOT NULL REFERENCES financial_products.sponsorships(id),
    offering_id uuid NOT NULL REFERENCES financial_products.vendor_offerings(id),
    note text,
    approved_by uuid REFERENCES financial_products.users(id),
    approved_at timestamptz NOT NULL DEFAULT now(),
    revoked_by uuid REFERENCES financial_products.users(id),
    revoked_at timestamptz,
    PRIMARY KEY (sponsorship_id, offering_id)
  );
  -- When a customer erased their data, by keyed hash: a check that began before then can't write a state back.
  CREATE TABLE IF NOT EXISTS financial_products.customer_state_erasures (
    app_id uuid NOT NULL,
    customer_key text NOT NULL,
    erased_at timestamptz NOT NULL,
    PRIMARY KEY (app_id, customer_key)
  );
  ALTER TABLE financial_products.vendor_action_runs ADD COLUMN IF NOT EXISTS identity_fields text[];
  ALTER TABLE financial_products.vendor_action_runs ADD COLUMN IF NOT EXISTS identity_digest text;
  -- A write and an erasure of one customer's verified state take the same lock, so neither can slip past the other.
  CREATE OR REPLACE FUNCTION financial_products.record_verified_customer_state(
    p_app uuid, p_ref text, p_key text, p_offering uuid, p_state text, p_status text, p_reason text, p_source text, p_entity uuid, p_by text,
    p_at timestamptz, p_fields text[], p_digest text, p_started timestamptz
  ) RETURNS TABLE (o_written boolean, o_old text) LANGUAGE plpgsql AS $fn$
  DECLARE
    c financial_products.customer_verified_states%ROWTYPE;
    seen boolean;
    v_at timestamptz := COALESCE(p_at, clock_timestamp());
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('cvs:' || p_app || ':' || p_ref, 0));
    IF EXISTS (SELECT 1 FROM financial_products.customer_state_erasures e WHERE e.app_id = p_app AND e.customer_key = p_key AND e.erased_at >= p_started) THEN
      RETURN QUERY SELECT false, NULL::text;
      RETURN;
    END IF;
    SELECT * INTO c FROM financial_products.customer_verified_states v WHERE v.app_id = p_app AND v.customer_ref = p_ref AND v.offering_id = p_offering;
    seen := FOUND;
    IF seen THEN
      -- The same answer read again, with no time of its own, isn't a new verification.
      IF p_at IS NULL AND c.status = 'verified' AND p_status = 'verified' AND c.state = p_state THEN
        v_at := c.verified_at;
      ELSIF v_at < c.verified_at THEN
        RETURN QUERY SELECT false, c.state;
        RETURN;
      END IF;
      UPDATE financial_products.customer_verified_states v SET state = p_state, status = p_status, status_reason = p_reason, source = p_source, verified_by_entity = p_entity, verified_by = p_by,
        verified_at = v_at, identity_fields = p_fields, identity_digest = p_digest, updated_at = now()
        WHERE v.app_id = p_app AND v.customer_ref = p_ref AND v.offering_id = p_offering;
      RETURN QUERY SELECT true, c.state;
      RETURN;
    END IF;
    INSERT INTO financial_products.customer_verified_states (app_id, customer_ref, offering_id, state, status, status_reason, source, verified_by_entity, verified_by, verified_at, identity_fields, identity_digest)
      VALUES (p_app, p_ref, p_offering, p_state, p_status, p_reason, p_source, p_entity, p_by, v_at, p_fields, p_digest);
    RETURN QUERY SELECT true, NULL::text;
  END $fn$;
  CREATE OR REPLACE FUNCTION financial_products.erase_verified_customer_state(p_app uuid, p_ref text, p_key text) RETURNS TABLE (o_state text) LANGUAGE plpgsql AS $fn$
  BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('cvs:' || p_app || ':' || p_ref, 0));
    IF p_key IS NOT NULL THEN
      INSERT INTO financial_products.customer_state_erasures AS e (app_id, customer_key, erased_at) VALUES (p_app, p_key, clock_timestamp())
        ON CONFLICT (app_id, customer_key) DO UPDATE SET erased_at = EXCLUDED.erased_at;
    END IF;
    RETURN QUERY DELETE FROM financial_products.customer_verified_states v WHERE v.app_id = p_app AND v.customer_ref = p_ref RETURNING v.state;
  END $fn$;
  DROP FUNCTION IF EXISTS financial_products.reserve_money_movement(uuid, uuid, text, text, uuid, text, uuid, text, bigint, text, text, uuid, uuid, bigint, text);
  CREATE OR REPLACE FUNCTION financial_products.reserve_money_movement(
    p_rail uuid, p_id uuid, p_key text, p_product text, p_app uuid, p_action text, p_sponsor uuid, p_direction text,
    p_amount bigint, p_state text, p_customer text, p_subscription uuid, p_request uuid, p_expected bigint, p_state_source text, p_state_verified_by text, p_state_verified_at timestamptz, p_state_verified_offering uuid
  ) RETURNS TABLE (o_outcome text, o_id uuid, o_status text) LANGUAGE plpgsql AS $fn$
  DECLARE
    r financial_products.money_rails%ROWTYPE;
    m financial_products.money_movements%ROWTYPE;
    seen boolean;
    used bigint;
    today date := (clock_timestamp() AT TIME ZONE 'UTC')::date;
    new_id uuid;
  BEGIN
    SELECT * INTO r FROM financial_products.money_rails WHERE id = p_rail FOR UPDATE;
    IF NOT FOUND OR r.status <> 'approved' THEN
      RETURN QUERY SELECT 'rail_not_approved'::text, NULL::uuid, NULL::text;
      RETURN;
    END IF;
    IF p_amount > r.per_transfer_limit_cents THEN
      RETURN QUERY SELECT 'over_transfer_limit'::text, NULL::uuid, NULL::text;
      RETURN;
    END IF;
    SELECT * INTO m FROM financial_products.money_movements WHERE idempotency_key = p_key FOR UPDATE;
    seen := FOUND;
    IF seen THEN
      IF m.amount_cents IS DISTINCT FROM p_amount OR m.direction IS DISTINCT FROM p_direction OR m.product_id <> p_product THEN
        RETURN QUERY SELECT 'idempotency_conflict'::text, m.id, m.status;
        RETURN;
      END IF;
      IF m.status <> 'failed' THEN
        RETURN QUERY SELECT 'duplicate'::text, m.id, m.status;
        RETURN;
      END IF;
    END IF;
    SELECT COALESCE(sum(amount_cents), 0) INTO used FROM financial_products.money_movements
      WHERE rail_id = p_rail AND limit_day = today AND NOT sandbox AND status <> 'failed';
    IF used + p_amount > r.daily_limit_cents THEN
      RETURN QUERY SELECT 'over_daily_limit'::text, NULL::uuid, NULL::text;
      RETURN;
    END IF;
    IF seen THEN
      UPDATE financial_products.money_movements SET status = 'requested', status_detail = NULL, failed_at = NULL, rail_id = p_rail, sponsor_entity_id = p_sponsor,
        state = p_state, state_source = p_state_source, state_verified_by = p_state_verified_by, state_verified_at = p_state_verified_at, state_verified_offering = p_state_verified_offering, expected_total_cents = p_expected, limit_day = today, earlier_request_ids = CASE WHEN request_id IS NOT NULL AND request_id <> p_request THEN array_append(earlier_request_ids, request_id) ELSE earlier_request_ids END, subscription_id = p_subscription, request_id = p_request, updated_at = now() WHERE id = m.id;
      RETURN QUERY SELECT 'reserved'::text, m.id, 'requested'::text;
      RETURN;
    END IF;
    INSERT INTO financial_products.money_movements (id, idempotency_key, product_id, app_id, action, sponsor_entity_id, rail_id, direction, amount_cents, state, state_source, state_verified_by, state_verified_at, state_verified_offering, customer_key, expected_total_cents, status, subscription_id, request_id, limit_day)
      VALUES (p_id, p_key, p_product, p_app, p_action, p_sponsor, p_rail, p_direction, p_amount, p_state, p_state_source, p_state_verified_by, p_state_verified_at, p_state_verified_offering, p_customer, p_expected, 'requested', p_subscription, p_request, today)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING id INTO new_id;
    IF new_id IS NULL THEN
      SELECT * INTO m FROM financial_products.money_movements WHERE idempotency_key = p_key;
      RETURN QUERY SELECT 'duplicate'::text, m.id, m.status;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'reserved'::text, new_id, 'requested'::text;
  END $fn$;
  -- Public checks that a firm is a real, legitimate company (GLEIF's LEI record, FinCEN's MSB registrant list),
  -- run by Mynt itself and kept as history: a licence provider sponsors only once they pass (see firm-checks.ts).
  CREATE TABLE IF NOT EXISTS financial_products.firm_checks (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES financial_products.entities(id),
    source text NOT NULL,
    subject text NOT NULL,
    url text NOT NULL,
    retrieved_at timestamptz NOT NULL DEFAULT now(),
    status text NOT NULL CHECK (status IN ('match', 'mismatch', 'not_found', 'unavailable')),
    fields jsonb NOT NULL DEFAULT '{}',
    response_hash text,
    note text,
    run_by uuid REFERENCES financial_products.users(id)
  );
  CREATE INDEX IF NOT EXISTS firm_checks_entity_idx ON financial_products.firm_checks (entity_id, source, retrieved_at DESC);
  ${LIQUIDITY_TABLES}
${WORKSPACE_TABLES}
`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

type Row = Record<string, unknown>;

const toUser = (r: Row): User => {
  const held = r.roles as Role[];
  const entityId = (r.entity_id as string | null) ?? null;
  const roles = rolesWithStanding(held, entityId, r.lp_since);
  return {
    id: r.id as string,
    name: r.name as string,
    roles,
    email: (r.email as string | null) ?? null,
    entity_id: entityId,
    created_at: iso(r.created_at)!,
    ...(roles.length !== held.length ? { held_roles: held, licence_provider_pending: true } : {}),
  };
};

const toInvite = (r: Row): Invite => ({ email: r.email as string, roles: r.roles as Role[], created_at: iso(r.created_at)! });

// ---- Runtime layer mappers ----

// App API keys: mynt_live_... or mynt_test_..., shown once and stored hashed like users' tokens.
const newApiKey = (env: KeyEnvironment) => `mynt_${env === "live" ? "live" : "test"}_${randomBytes(24).toString("base64url")}`;

const toApiKey = (r: Row): ApiKey => ({
  id: r.id as string,
  app_id: r.app_id as string,
  environment: r.environment as KeyEnvironment,
  label: r.label as string,
  prefix: r.prefix as string,
  allowed_origins: (r.allowed_origins as string[]) ?? [],
  status: r.status as ApiKey["status"],
  created_at: iso(r.created_at)!,
  last_used_at: iso(r.last_used_at),
  rotated_at: iso(r.rotated_at),
  revoked_at: iso(r.revoked_at),
});

const toHandoff = (r: Row): Handoff => ({
  id: r.id as string,
  app_id: r.app_id as string,
  product_id: r.product_id as string,
  action: r.action as string,
  consumer_ref: (r.consumer_ref as string | null) ?? null,
  sandbox: r.sandbox as boolean,
  status: r.status as Handoff["status"],
  redirect_url: r.redirect_url as string,
  created_at: iso(r.created_at)!,
  resolved_at: iso(r.resolved_at),
});

const toWebhook = (r: Row): Webhook => ({
  id: r.id as string,
  app_id: (r.app_id as string | null) ?? "",
  ...(r.entity_id ? { entity_id: r.entity_id as string } : {}),
  url: r.url as string,
  events: r.events as string[],
  created_at: iso(r.created_at)!,
});

const toDelivery = (r: Row): WebhookDelivery => ({
  id: r.id as string,
  webhook_id: r.webhook_id as string,
  event_id: r.event_id as string,
  type: r.type as string,
  payload: r.payload,
  sandbox: r.sandbox as boolean,
  status: r.status as WebhookDelivery["status"],
  attempts: Number(r.attempts),
  last_response_code: r.last_response_code == null ? null : Number(r.last_response_code),
  last_error: (r.last_error as string | null) ?? null,
  next_attempt_at: iso(r.next_attempt_at),
  created_at: iso(r.created_at)!,
  delivered_at: iso(r.delivered_at),
});

const toRelease = (r: Row): AppRelease => ({
  app_id: r.app_id as string,
  version: r.version as string,
  changelog: r.changelog as string,
  snapshot: r.snapshot as Record<string, unknown>,
  released_by: (r.released_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

// ---- end runtime layer mappers ----

const toProductRecord = (r: Row): ProductRecord => ({
  product: r.data as FinancialProduct,
  owner_id: r.owner_id as string | null,
  status: r.status as ProductStatus,
  version: Number(r.version ?? 1),
  last_test: (r.last_test as TestReport | null) ?? null,
  entity_id: (r.entity_id as string | null) ?? null,
  action: ((r.action as string) ?? "issuance") as ProductAction,
  underlying_product_ids: (r.underlying_product_ids as string[]) ?? [],
  components: (r.components as Component[]) ?? [],
  parties: (r.parties as PartyBinding[]) ?? [],
  pins: (r.pins as Pins | null) ?? null,
  drift: (r.drift as ProductRecord["drift"]) ?? null,
  definition: (r.definition as Record<string, unknown> | null) ?? null,
  // Mynt's reference catalogue (no owner) is open to every developer.
  access_mode: (r.owner_id == null ? "open" : ((r.access_mode as string) ?? "approval")) as AccessMode,
  build_terms: (r.build_terms as BuildTerms) ?? {},
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  published_at: iso(r.published_at),
});

const toEntity = (r: Row): Entity => ({
  id: r.id as string,
  name: r.name as string,
  legal_form: (r.legal_form as Entity["legal_form"]) ?? null,
  incorporation: (r.incorporation as Entity["incorporation"]) ?? null,
  identifiers: (r.identifiers as Identifier[]) ?? [],
  status: ((r.status as string) ?? "active") as EntityStatus,
  registration_numbers: (r.registration_numbers as Record<string, string>) ?? {},
  regions: (r.regions as string[]) ?? [],
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

const toGrcRecord = (r: Row): GrcRecord => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  party_id: (r.party_id as string | null) ?? null,
  product_id: (r.product_id as string | null) ?? null,
  licence_id: (r.licence_id as string | null) ?? null,
  section: r.section as string,
  ref: (r.ref as string | null) ?? null,
  key: r.key as string,
  record: (r.record as Record<string, unknown>) ?? {},
  status: r.status as GrcRecord["status"],
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

const toAppJourney = (r: Row): AppJourney => ({
  app_id: r.app_id as string,
  journey_id: r.journey_id as string,
  product_id: r.product_id as string,
  contract_hash: r.contract_hash as string,
  spec: r.spec as Record<string, unknown>,
  updated_at: iso(r.updated_at)!,
});

const toClientSession = (r: Row): ClientSession => ({
  id: r.id as string,
  app_id: r.app_id as string,
  key_id: r.key_id as string,
  customer_ref: (r.customer_ref as string | null) ?? null,
  product_ids: (r.product_ids as string[]) ?? [],
  scopes: (r.scopes as string[]) ?? [],
  sandbox: Boolean(r.sandbox),
  expires_at: iso(r.expires_at)!,
  created_at: iso(r.created_at)!,
  revoked_at: iso(r.revoked_at),
});

const toClientEvidence = (r: Row): ClientEvidence => ({
  id: r.id as string,
  app_id: r.app_id as string,
  session_id: r.session_id as string,
  product_id: r.product_id as string,
  contract_hash: (r.contract_hash as string | null) ?? null,
  type: r.type as ClientEvidence["type"],
  subject: r.subject as string,
  content_hash: (r.content_hash as string | null) ?? null,
  customer_ref: (r.customer_ref as string | null) ?? null,
  sandbox: Boolean(r.sandbox),
  created_at: iso(r.created_at)!,
});

const toParty = (r: Row): Party => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  kind: r.kind as Party["kind"],
  person: (r.person as Party["person"]) ?? null,
  legal_entity_id: (r.legal_entity_id as string | null) ?? null,
  attributes: (r.attributes as Party["attributes"]) ?? {},
  fills: (r.fills as Party["fills"]) ?? [],
  relationship: (r.relationship as string | null) ?? null,
  since: (r.since as string | null) ?? null,
  until: (r.until as string | null) ?? null,
  status: r.status as Party["status"],
  created_by: (r.created_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

const toSponsorship = (r: Row): Sponsorship => ({
  id: r.id as string,
  product_id: r.product_id as string,
  component_key: r.component_key as string,
  builder_entity_id: r.builder_entity_id as string,
  provider_entity_id: r.provider_entity_id as string,
  requested_jurisdictions: (r.requested_jurisdictions as string[]) ?? [],
  licence_ids: ((r.licence_ids as string[]) ?? []).map(String),
  jurisdictions: (r.jurisdictions as string[]) ?? [],
  status: r.status as SponsorshipStatus,
  note: (r.note as string | null) ?? null,
  decision_note: (r.decision_note as string | null) ?? null,
  requested_by: (r.requested_by as string | null) ?? null,
  decided_by: (r.decided_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  decided_at: iso(r.decided_at),
});

const toFirmCheck = (r: Row): FirmCheck => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  source: r.source as string,
  subject: r.subject as string,
  url: r.url as string,
  retrieved_at: iso(r.retrieved_at)!,
  status: r.status as FirmCheckStatus,
  fields: (r.fields as Record<string, unknown>) ?? {},
  response_hash: (r.response_hash as string | null) ?? null,
  note: (r.note as string | null) ?? null,
  run_by: (r.run_by as string | null) ?? null,
});

const toHeldLicense = (r: Row): HeldLicense => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  region: r.region as string,
  regulator_id: r.regulator_id as string,
  license_id: r.license_id as string,
  jurisdiction: (r.jurisdiction as string | null) ?? null,
  registration_number: r.registration_number as string,
  valid_from: (r.valid_from as string | null) ?? null,
  valid_to: (r.valid_to as string | null) ?? null,
  status: r.status as LicenseStatus,
  submitted_by: (r.submitted_by as string | null) ?? null,
  reviewed_by: (r.reviewed_by as string | null) ?? null,
  review_note: (r.review_note as string | null) ?? null,
  created_at: iso(r.created_at)!,
  reviewed_at: iso(r.reviewed_at),
});

const toRequest = (r: Row): AccessRequest => ({
  id: r.id as string,
  kind: r.kind as RequestKind,
  product_id: r.product_id as string,
  app_id: (r.app_id as string | null) ?? null,
  campaign_id: (r.campaign_id as string | null) ?? null,
  requester_id: r.requester_id as string,
  status: r.status as RequestStatus,
  note: (r.note as string) ?? "",
  decision_note: (r.decision_note as string | null) ?? null,
  decided_by: (r.decided_by as string | null) ?? null,
  created_at: iso(r.created_at)!,
  decided_at: iso(r.decided_at),
});

const toProductVersion = (r: Row): ProductVersion => ({
  product_id: r.product_id as string,
  version: Number(r.version),
  status: r.status as ProductVersion["status"],
  data: r.data as FinancialProduct,
  changelog: r.changelog as string,
  last_test: (r.last_test as TestReport | null) ?? null,
  created_at: iso(r.created_at)!,
  published_at: iso(r.published_at),
});

const toEnrollment = (r: Row): Enrollment => ({
  id: r.id as string,
  user_id: r.user_id as string,
  product_id: r.product_id as string,
  product_version: Number(r.product_version ?? 1),
  amount: r.amount == null ? null : Number(r.amount),
  status: r.status as Enrollment["status"],
  campaign_id: (r.campaign_id as string | null) ?? null,
  variant: (r.variant as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

const toProductRequest = (r: Row): ProductRequest => ({
  id: r.id as string,
  user_id: r.user_id as string,
  need: r.need as string,
  product_line: (r.product_line as string | null) ?? null,
  amount: r.amount == null ? null : Number(r.amount),
  currency: r.currency as string,
  tenor_days: r.tenor_days == null ? null : Number(r.tenor_days),
  region: r.region as string,
  context: (r.context as string | null) ?? null,
  status: r.status as ProductRequestStatus,
  created_at: iso(r.created_at)!,
});

const toTakeRate = (r: Row): TakeRate => ({
  line: r.line as string,
  base_pct: Number(r.base_pct),
  workload_pct: Number(r.workload_pct),
  min_pct: Number(r.min_pct),
  max_pct: Number(r.max_pct),
  basis: r.basis as string,
  updated_by: (r.updated_by as string | null) ?? null,
  updated_at: iso(r.updated_at)!,
});

const toProductRequestOffer = (r: Row): ProductRequestOffer => ({
  request_id: r.request_id as string,
  product_id: r.product_id as string,
  innovator_id: r.innovator_id as string,
  note: r.note as string,
  created_at: iso(r.created_at)!,
});

const toSegment = (r: Row): Segment => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  criteria: r.criteria as SegmentCriteria,
  created_at: iso(r.created_at)!,
});

const toCampaign = (r: Row): Campaign => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  product_ids: r.product_ids as string[],
  segment_id: (r.segment_id as string | null) ?? null,
  channels: r.channels as string[],
  variants: r.variants as Variant[],
  status: r.status as CampaignStatus,
  last_lint: r.last_lint ?? null,
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
  launched_at: iso(r.launched_at),
});

const toApp = (r: Row): App => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  workspace_id: (r.workspace_id as string | null) ?? null,
  name: r.name as string,
  description: r.description as string,
  audience: r.audience as string,
  product_ids: r.product_ids as string[],
  disclosures: (r.disclosures as string[]) ?? [],
  actions: (r.actions as string[]) ?? ["display"],
  status: r.status as App["status"],
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

// --- SDKs and experiences (developer build layer) ---
const toSdk = (r: Row): Sdk => ({
  id: r.id as string,
  owner_id: r.owner_id as string,
  name: r.name as string,
  languages: r.languages as string[],
  product_ids: r.product_ids as string[],
  created_at: iso(r.created_at)!,
});

const toSdkRelease = (r: Row): SdkRelease => ({
  sdk_id: r.sdk_id as string,
  version: r.version as string,
  changelog: r.changelog as string,
  sources: r.sources as SdkReleaseSource[],
  files: r.files as SdkRelease["files"],
  created_at: iso(r.created_at)!,
});
// --- end SDKs and experiences ---

export class Store {
  private constructor(readonly db: Db) {}

  // Creates the schema if needed. Mynt ships no catalogue: products come from innovators, regions and
  // categories from admins. `seed` (tests only) inserts published, read-only products and the regions and
  // categories they imply.
  // A least-privilege role can own a pre-created schema without database-level CREATE rights,
  // and CREATE SCHEMA IF NOT EXISTS would still demand them, so only create it when missing.
  static async open(db: Db, seed: FinancialProduct[] = []): Promise<Store> {
    const { rows } = await db.query("SELECT 1 FROM pg_namespace WHERE nspname = 'financial_products'");
    if (rows.length === 0) await db.exec("CREATE SCHEMA financial_products");
    await db.exec(TABLES);
    await db.exec(COVENANT_TABLES);
    await db.query(
      `INSERT INTO financial_products.products (id, owner_id, status, data, published_at)
       SELECT p->>'id', NULL, 'published', p, now() FROM jsonb_array_elements($1::jsonb) AS p
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(seed)],
    );
    // Seed reference data once; after that admins own it (existing rows are never overwritten).
    const ref = referenceSeed(seed);
    await db.query(
      `INSERT INTO financial_products.regions (code, name, regulators)
       SELECT r->>'code', r->>'name', ARRAY(SELECT jsonb_array_elements_text(r->'regulators')) FROM jsonb_array_elements($1::jsonb) AS r
       ON CONFLICT (code) DO NOTHING`,
      [JSON.stringify(ref.regions)],
    );
    await db.query(
      `INSERT INTO financial_products.product_categories (id, name, product_lines)
       SELECT c->>'id', c->>'name', ARRAY(SELECT jsonb_array_elements_text(c->'product_lines')) FROM jsonb_array_elements($1::jsonb) AS c
       ON CONFLICT (id) DO NOTHING`,
      [JSON.stringify(ref.categories)],
    );
    const store = new Store(db);
    await store.liftScopeProductTypes();
    await store.migrateProductLines();
    await store.migrateComponents();
    await migrateAppWorkspaces(db);
    return store;
  }

  // Components used to name a regulated product type as their primitive, with provided_by self or a
  // partner (a firm on Mynt or just a name). Now the primitive is the line and the provider is the owner or
  // a party on its roster: a partner firm on Mynt becomes a counterparty on the owner's roster; a partner
  // known only by name is left unassigned for the firm to name properly.
  private async migrateComponents(): Promise<void> {
    type Legacy = { region: string; primitive: string; action: Component["action"]; provided_by?: string; partner_entity_id?: string | null };
    const rows = (await this.all("SELECT id, entity_id, data, components FROM financial_products.products WHERE jsonb_array_length(components) > 0")).filter(
      (r) => (r.components as Record<string, unknown>[]).some((c) => "region" in c && !("key" in c)),
    );
    if (!rows.length) return;
    const types = await this.regulatedProductTypes();
    const lines = new Map((await this.referenceData(true)).categories.map((c) => [c.id, c.product_lines]));
    for (const r of rows) {
      const entityId = r.entity_id as string | null;
      const productLine = (r.data as FinancialProduct).product_line;
      const keys = new Set<string>();
      const components: Component[] = [];
      for (const o of r.components as Legacy[]) {
        const t = types.find((x) => x.region === o.region && x.id === o.primitive);
        const typeLines = (t && lines.get(t.type_id)) ?? [];
        const primitive = (typeLines.includes(productLine) ? productLine : (typeLines[0] ?? productLine)) as Component["primitive"];
        let key = `${primitive}_${o.action}`;
        for (let n = 2; keys.has(key); n++) key = `${primitive}_${o.action}_${n}`;
        keys.add(key);
        let provider: Component["provider"];
        if (entityId && o.provided_by !== "partner") provider = { by: "self" };
        else if (entityId && o.partner_entity_id) {
          const existing = (await this.partiesOf(entityId)).find((p) => p.status === "active" && p.legal_entity_id === o.partner_entity_id);
          const party =
            existing ??
            (await this.addParty(null, { entity_id: entityId, kind: "external", person: null, legal_entity_id: o.partner_entity_id, attributes: {}, fills: [], relationship: "partner", since: null }));
          provider = { by: "party", party_id: party.id };
        }
        components.push({
          key,
          country: (/^[A-Z]{2}$/.test(o.region) ? o.region : (r.data as FinancialProduct).region).toLowerCase(),
          primitive,
          action: o.action,
          ...(t?.underlying ? { underlying: t.underlying } : {}),
          ...(t?.wrapper ? { wrapper: t.wrapper } : {}),
          ...(provider ? { provider } : {}),
        });
      }
      await this.db.query("UPDATE financial_products.products SET components = $2 WHERE id = $1", [r.id, JSON.stringify(components)]);
    }
  }

  // Products used to sit in four lines (credit, wealth, insurance, treasury). Move stored products,
  // their versions, categories, launch procedures and requests onto the functional lines once; rows
  // already on them are left alone. A product whose last test was current is re-tested, so published
  // products stay published with a report that matches their data.
  private async migrateProductLines(): Promise<void> {
    const lines = [...PRODUCT_LINES];
    const oldLine = (l: string) => !lines.includes(l as never);
    const mapLines = (id: string, current: string[]) => {
      if (id === "exchange_traded" && (current.some(oldLine) || (current.length === 1 && current[0] === "wealth"))) return ["wealth", "securitization"];
      const mapped = current.map((l) => (l === "treasury" ? lineForTreasuryCategory(id) : l === "retirement" ? "wealth" : l));
      return [...new Set(mapped)];
    };
    const categories = await this.all(
      `SELECT id, product_lines FROM financial_products.product_categories
       WHERE NOT (product_lines <@ $1::text[]) OR (id = 'exchange_traded' AND product_lines = '{wealth}')`,
      [lines],
    );
    for (const c of categories) {
      await this.db.query("UPDATE financial_products.product_categories SET product_lines = $2 WHERE id = $1", [
        c.id,
        mapLines(c.id as string, c.product_lines as string[]),
      ]);
    }

    const stale = `(NOT (data->>'product_line' = ANY($1::text[])) OR (data->>'id' IN ('reit', 'invit') AND data->>'product_line' = 'wealth'))`;
    const products = await this.all(`SELECT id, data, last_test FROM financial_products.products WHERE ${stale}`, [lines]);
    const versions = await this.all(
      `SELECT product_id, version, data, last_test FROM financial_products.product_versions WHERE ${stale}`,
      [lines],
    );
    if (products.length + versions.length > 0) {
      const ref = await this.referenceData();
      const migrate = (r: Row) => {
        const before = r.data as FinancialProduct;
        const after = { ...before, product_line: currentLine(before) };
        const test = r.last_test as TestReport | null;
        const retest = test && test.fingerprint === fingerprint(before) ? runProductTests(after, ref) : test;
        return [JSON.stringify(after), retest ? JSON.stringify(retest) : null];
      };
      for (const r of products) {
        await this.db.query("UPDATE financial_products.products SET data = $2, last_test = $3 WHERE id = $1", [r.id, ...migrate(r)]);
      }
      for (const r of versions) {
        await this.db.query("UPDATE financial_products.product_versions SET data = $3, last_test = $4 WHERE product_id = $1 AND version = $2", [
          r.product_id,
          r.version,
          ...migrate(r),
        ]);
      }
    }

    // Launch procedures and requests name a line but no category: treasury ones held or ran money.
    await this.db.query(
      `UPDATE financial_products.regions SET procedures = (
         SELECT jsonb_agg(CASE WHEN p->>'product_line' = 'treasury' THEN jsonb_set(p, '{product_line}', '"account_operations"')
                               WHEN p->>'product_line' = 'retirement' THEN jsonb_set(p, '{product_line}', '"wealth"')
                               ELSE p END)
         FROM jsonb_array_elements(procedures) p)
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(procedures) p WHERE p->>'product_line' IN ('treasury', 'retirement'))`,
    );
    await this.db.query(
      `UPDATE financial_products.product_requests
       SET product_line = CASE product_line WHEN 'retirement' THEN 'wealth' ELSE 'account_operations' END
       WHERE product_line IN ('treasury', 'retirement')`,
    );
  }

  // Regulators used to carry their product types inline. Move them into the region's catalogue and
  // the regulator mapping once; regulators whose scope already references nothing are left alone.
  private async liftScopeProductTypes(): Promise<void> {
    const regions = await this.all(
      `SELECT code, regulatory FROM financial_products.regions
       WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(regulatory->'regulators', '[]'::jsonb)) r
                     WHERE jsonb_array_length(COALESCE(r->'scope'->'product_types', '[]'::jsonb)) > 0)`,
    );
    for (const row of regions) {
      const code = row.code as string;
      const model = row.regulatory as { regulators: { id: string; scope?: { product_types?: Record<string, unknown>[] } }[] };
      for (const r of model.regulators) {
        for (const p of r.scope?.product_types ?? []) {
          const acts = ([] as string[]).concat((p.action ?? p.actions ?? []) as string[]);
          if (typeof p.type_id === "string") {
            await this.db.query(
              `INSERT INTO financial_products.regulated_product_types (region, id, name, description, type_id, actions)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (region, id) DO UPDATE SET
                 actions = ARRAY(SELECT DISTINCT unnest(regulated_product_types.actions || EXCLUDED.actions))`,
              [code, p.id, p.name ?? p.id, p.description ?? "", p.type_id, acts],
            );
          }
          await this.db.query(
            `INSERT INTO financial_products.regulator_product_types (region, regulator_id, product_type_id, actions)
             SELECT $1, $2, $3, COALESCE(NULLIF($4::text[], '{}'), t.actions)
             FROM financial_products.regulated_product_types t WHERE t.region = $1 AND t.id = $3
             ON CONFLICT DO NOTHING`,
            [code, r.id, p.id, acts],
          );
        }
      }
      await this.db.query("UPDATE financial_products.regions SET regulatory = $2 WHERE code = $1", [
        code,
        JSON.stringify({ ...model, regulators: model.regulators.map(stripScopeProducts) }),
      ]);
    }
  }

  // Reference data

  async referenceData(includeInactive = false): Promise<ReferenceData> {
    const where = includeInactive ? "" : "WHERE active";
    const [regions, categories, productTypes, mappings] = await Promise.all([
      this.all(`SELECT * FROM financial_products.regions ${where} ORDER BY code = 'global' DESC, code`),
      this.all(`SELECT * FROM financial_products.product_categories ${where} ORDER BY id`),
      this.regulatedProductTypes(),
      this.productMappings(),
    ]);
    // Regulators are handed out with their supervised product types joined from the catalogue.
    const hydrate = (r: Region): Region => {
      const reg = (r.regulatory ?? {}) as RegulatoryModel;
      return {
        ...r,
        regulatory: {
          ...reg,
          regulators: hydrateRegulators(
            (reg.regulators ?? []) as unknown[],
            productTypes.filter((p) => p.region === r.code),
            mappings.filter((m) => m.region === r.code),
          ),
        },
      };
    };
    return {
      regions: regions.map((r) => hydrate({ ...(r as unknown as Region), updated_at: iso(r.updated_at)! })),
      categories: categories.map((c) => ({ ...(c as unknown as ProductCategory), updated_at: iso(c.updated_at)! })),
    };
  }

  // Regulated product types: a region-wide catalogue regulators map onto.

  async regulatedProductTypes(region?: string): Promise<(RegulatedProductType & { region: string; updated_at: string })[]> {
    const rows = await this.all(
      `SELECT * FROM financial_products.regulated_product_types ${region ? "WHERE region = $1" : ""} ORDER BY region, id`,
      region ? [region] : [],
    );
    return rows.map((r) => ({
      region: r.region as string,
      id: r.id as string,
      name: r.name as string,
      description: r.description as string,
      type_id: r.type_id as string,
      actions: r.actions as RegulatedAction[],
      ...(r.underlying ? { underlying: r.underlying as RegulatedProductType["underlying"] } : {}),
      ...(r.wrapper ? { wrapper: r.wrapper as RegulatedProductType["wrapper"] } : {}),
      updated_at: iso(r.updated_at)!,
    }));
  }

  async upsertRegulatedProductType(region: string, p: RegulatedProductType): Promise<{ replaced: boolean }> {
    const row = await this.one(
      `INSERT INTO financial_products.regulated_product_types (region, id, name, description, type_id, actions, underlying, wrapper)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (region, id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         type_id = EXCLUDED.type_id, actions = EXCLUDED.actions, underlying = EXCLUDED.underlying, wrapper = EXCLUDED.wrapper,
         updated_at = now()
       RETURNING (xmax <> 0) AS replaced`,
      [region, p.id, p.name, p.description, p.type_id, p.actions, p.underlying ?? null, p.wrapper ?? null],
    );
    return { replaced: Boolean(row?.replaced) };
  }

  async removeRegulatedProductType(region: string, id: string): Promise<boolean> {
    const rows = await this.all("DELETE FROM financial_products.regulated_product_types WHERE region = $1 AND id = $2 RETURNING id", [region, id]);
    return rows.length > 0;
  }

  async productMappings(region?: string): Promise<(ProductMapping & { region: string })[]> {
    const rows = await this.all(
      `SELECT * FROM financial_products.regulator_product_types ${region ? "WHERE region = $1" : ""} ORDER BY region, regulator_id, product_type_id`,
      region ? [region] : [],
    );
    return rows.map((r) => ({
      region: r.region as string,
      regulator_id: r.regulator_id as string,
      product_type_id: r.product_type_id as string,
      actions: r.actions as RegulatedAction[],
    }));
  }

  async upsertRegion(r: RegionUpdate): Promise<Region> {
    const row = await this.one(
      `INSERT INTO financial_products.regions (code, name, regulators, ecosystem, procedures, sources, active)
       VALUES ($1, COALESCE($2::text, $1), COALESCE($3::text[], '{}'::text[]), COALESCE($4::text, ''), COALESCE($5::jsonb, '[]'::jsonb),
               COALESCE($6::text[], '{}'::text[]), COALESCE($7::boolean, true))
       ON CONFLICT (code) DO UPDATE SET
         name = COALESCE($2::text, regions.name), regulators = COALESCE($3::text[], regions.regulators),
         ecosystem = COALESCE($4::text, regions.ecosystem), procedures = COALESCE($5::jsonb, regions.procedures),
         sources = COALESCE($6::text[], regions.sources), active = COALESCE($7::boolean, regions.active), updated_at = now()
       RETURNING *`,
      [
        r.code,
        r.name ?? null,
        r.regulators ?? null,
        r.ecosystem ?? null,
        r.procedures ? JSON.stringify(r.procedures) : null,
        r.sources ?? null,
        r.active ?? null,
      ],
    );
    return { ...(row as unknown as Region), updated_at: iso(row!.updated_at)! };
  }

  // Saves a (hydrated) model: regulators' JSON without product types, and the regulator <-> product
  // type mapping derived from each regulator's scope.
  async setRegulatoryModel(code: string, model: RegulatoryModel): Promise<void> {
    const mappings = model.regulators.flatMap((r) =>
      r.scope.product_types.map((p) => ({ regulator_id: r.id, product_type_id: p.id, actions: p.action })),
    );
    await this.db.query(
      `INSERT INTO financial_products.regulator_product_types (region, regulator_id, product_type_id, actions)
       SELECT $1, m.regulator_id, m.product_type_id, ARRAY(SELECT jsonb_array_elements_text(m.actions))
       FROM jsonb_to_recordset($2::jsonb) AS m(regulator_id text, product_type_id text, actions jsonb)
       ON CONFLICT (region, regulator_id, product_type_id) DO UPDATE SET actions = EXCLUDED.actions`,
      [code, JSON.stringify(mappings)],
    );
    await this.db.query(
      `DELETE FROM financial_products.regulator_product_types t
       WHERE t.region = $1 AND NOT EXISTS (
         SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS m(regulator_id text, product_type_id text)
         WHERE m.regulator_id = t.regulator_id AND m.product_type_id = t.product_type_id)`,
      [code, JSON.stringify(mappings)],
    );
    await this.db.query("UPDATE financial_products.regions SET regulatory = $2, updated_at = now() WHERE code = $1", [
      code,
      JSON.stringify({ ...model, regulators: model.regulators.map(stripScopeProducts) }),
    ]);
  }

  async upsertCategory(c: Omit<ProductCategory, "updated_at">): Promise<ProductCategory> {
    const row = await this.one(
      `INSERT INTO financial_products.product_categories (id, name, product_lines, description, active) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, product_lines = EXCLUDED.product_lines,
         description = EXCLUDED.description, active = EXCLUDED.active, updated_at = now()
       RETURNING *`,
      [c.id, c.name, c.product_lines, c.description, c.active],
    );
    return { ...(row as unknown as ProductCategory), updated_at: iso(row!.updated_at)! };
  }

  // Take rates

  async takeRates(): Promise<TakeRate[]> {
    return (await this.all("SELECT * FROM financial_products.take_rates ORDER BY line")).map(toTakeRate);
  }

  async takeRate(line: string): Promise<TakeRate | undefined> {
    const r = await this.one("SELECT * FROM financial_products.take_rates WHERE line = $1", [line]);
    return r && toTakeRate(r);
  }

  async upsertTakeRate(r: Omit<TakeRate, "updated_by" | "updated_at">, actorId: string): Promise<TakeRate> {
    const row = await this.one(
      `INSERT INTO financial_products.take_rates (line, base_pct, workload_pct, min_pct, max_pct, basis, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (line) DO UPDATE SET base_pct = EXCLUDED.base_pct, workload_pct = EXCLUDED.workload_pct,
         min_pct = EXCLUDED.min_pct, max_pct = EXCLUDED.max_pct, basis = EXCLUDED.basis,
         updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING *`,
      [r.line, r.base_pct, r.workload_pct, r.min_pct, r.max_pct, r.basis, actorId],
    );
    return toTakeRate(row!);
  }

  // Audit log

  async audit(actorId: string | null, action: string, target: string, details: unknown = {}): Promise<void> {
    await this.db.query(
      "INSERT INTO financial_products.audit_log (id, actor_id, action, target, details) VALUES ($1, $2, $3, $4, $5)",
      [randomUUID(), actorId, action, target, JSON.stringify(details)],
    );
  }

  async auditLog(limit = 100): Promise<AuditEntry[]> {
    const rows = await this.all(
      `SELECT a.*, u.email AS actor_email FROM financial_products.audit_log a
       LEFT JOIN financial_products.users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({
      id: r.id as string,
      actor_id: (r.actor_id as string | null) ?? null,
      actor_email: (r.actor_email as string | null) ?? null,
      action: r.action as string,
      target: r.target as string,
      details: r.details,
      created_at: iso(r.created_at)!,
    }));
  }

  async allCampaigns(): Promise<Campaign[]> {
    return (await this.all("SELECT * FROM financial_products.campaigns ORDER BY created_at DESC")).map(toCampaign);
  }

  // ---- Runtime layer: API keys, hand-offs, events, webhooks, releases ----

  async createApiKey(
    createdBy: string,
    k: Pick<ApiKey, "app_id" | "environment" | "label" | "allowed_origins">,
  ): Promise<{ key: ApiKey; secret: string }> {
    const secret = newApiKey(k.environment);
    const r = await this.one(
      `INSERT INTO financial_products.api_keys (id, app_id, environment, label, prefix, key_hash, allowed_origins, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8) RETURNING *`,
      [randomUUID(), k.app_id, k.environment, k.label, secret.slice(0, 14), hashToken(secret), k.allowed_origins, createdBy],
    );
    return { key: toApiKey(r!), secret };
  }

  async getApiKey(id: string): Promise<ApiKey | undefined> {
    const r = await this.one("SELECT * FROM financial_products.api_keys WHERE id::text = $1", [id]);
    return r && toApiKey(r);
  }

  async apiKeysForApp(appId: string): Promise<ApiKey[]> {
    return (await this.all("SELECT * FROM financial_products.api_keys WHERE app_id::text = $1 ORDER BY created_at", [appId])).map(toApiKey);
  }

  // The active key with this secret, and its app; marks it used (at most once a minute).
  async createClientSession(
    s: Pick<ClientSession, "app_id" | "key_id" | "customer_ref" | "product_ids" | "scopes" | "sandbox"> & { ttl_seconds: number },
  ): Promise<{ session: ClientSession; secret: string }> {
    const secret = `mcs_${s.sandbox ? "test" : "live"}_${randomBytes(24).toString("base64url")}`;
    const r = await this.one(
      `INSERT INTO financial_products.client_sessions (id, app_id, key_id, secret_hash, customer_ref, product_ids, scopes, sandbox, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(secs => $9)) RETURNING *`,
      [randomUUID(), s.app_id, s.key_id, hashToken(secret), s.customer_ref, s.product_ids, s.scopes, s.sandbox, s.ttl_seconds],
    );
    return { session: toClientSession(r!), secret };
  }

  // A live (unexpired, unrevoked) session by its secret, with its app and the key that minted it.
  async clientSessionBySecret(secret: string): Promise<{ session: ClientSession; key: ApiKey; app: App } | undefined> {
    const r = await this.one(
      `SELECT * FROM financial_products.client_sessions WHERE secret_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(secret)],
    );
    if (!r) return undefined;
    const [key, app] = await Promise.all([this.getApiKey(r.key_id as string), this.getApp(r.app_id as string)]);
    if (!key || key.status !== "active" || !app) return undefined;
    return { session: toClientSession(r), key, app };
  }

  async recordClientEvidence(e: Omit<ClientEvidence, "id" | "created_at">): Promise<ClientEvidence> {
    const r = await this.one(
      `INSERT INTO financial_products.client_evidence (id, app_id, session_id, product_id, contract_hash, type, subject, content_hash, customer_ref, sandbox)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [randomUUID(), e.app_id, e.session_id, e.product_id, e.contract_hash, e.type, e.subject, e.content_hash, e.customer_ref, e.sandbox],
    );
    return toClientEvidence(r!);
  }

  async putVaultField(v: { app_id: string; customer_ref: string; sandbox: boolean; field: string; sealed: string; source: string }): Promise<void> {
    await this.db.query(
      `INSERT INTO financial_products.customer_vault (app_id, customer_ref, sandbox, field, sealed, source) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (app_id, customer_ref, sandbox, field) DO UPDATE SET sealed = EXCLUDED.sealed, source = EXCLUDED.source, updated_at = now()`,
      [v.app_id, v.customer_ref, v.sandbox, v.field, v.sealed, v.source],
    );
  }

  async vaultFields(appId: string, customerRef: string, sandbox: boolean): Promise<{ field: string; sealed: string; source: string; updated_at: string }[]> {
    const rows = await this.all(
      "SELECT field, sealed, source, updated_at FROM financial_products.customer_vault WHERE app_id = $1 AND customer_ref = $2 AND sandbox = $3 ORDER BY field",
      [appId, customerRef, sandbox],
    );
    return rows.map((r) => ({ field: r.field as string, sealed: r.sealed as string, source: r.source as string, updated_at: iso(r.updated_at)! }));
  }

  // Erases what's held for a customer: their vault, the vendor results kept for them (and any still queued for an
  // innovator's webhook), and stops their unfinished vendor actions from filling anything later.
  async eraseVault(appId: string, customerRef: string, sandbox: boolean): Promise<number> {
    const n = (await this.all("DELETE FROM financial_products.customer_vault WHERE app_id = $1 AND customer_ref = $2 AND sandbox = $3 RETURNING field", [appId, customerRef, sandbox])).length;
    await this.db.query(
      `UPDATE financial_products.vendor_action_runs SET result_sealed = NULL,
         status = CASE WHEN status IN ('calling', 'pending') THEN 'withdrawn' ELSE status END,
         completed_at = CASE WHEN status IN ('calling', 'pending') THEN now() ELSE completed_at END
       WHERE app_id = $1 AND customer_ref = $2 AND sandbox = $3`,
      [appId, customerRef, sandbox],
    );
    await this.db.query(
      `UPDATE financial_products.webhook_deliveries SET payload = payload #- '{data,result_sealed}'
       WHERE payload->'data' ? 'result_sealed' AND payload->'data'->>'app_id' = $1 AND payload->'data'->>'customer_ref' = $2 AND sandbox = $3`,
      [appId, customerRef, sandbox],
    );
    return n;
  }

  // A coding-agent build's outcome (the builds service owns the table; it's absent when builds are off).
  async buildRun(id: string): Promise<{ id: string; developer_id: string; app_id: string | null; repository: string | null; commit_sha: string | null; status: string } | undefined> {
    try {
      const r = await this.one("SELECT id, developer_id, app_id, repository, commit_sha, status FROM financial_products.build_runs WHERE id::text = $1", [id]);
      return r as never;
    } catch {
      return undefined;
    }
  }

  async saveJourney(j: Omit<AppJourney, "updated_at">): Promise<AppJourney> {
    const r = await this.one(
      `INSERT INTO financial_products.app_journeys (app_id, journey_id, product_id, contract_hash, spec) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (app_id, journey_id) DO UPDATE SET product_id = EXCLUDED.product_id, contract_hash = EXCLUDED.contract_hash, spec = EXCLUDED.spec, updated_at = now()
       RETURNING *`,
      [j.app_id, j.journey_id, j.product_id, j.contract_hash, JSON.stringify(j.spec)],
    );
    return toAppJourney(r!);
  }

  async journeysOf(appId: string): Promise<AppJourney[]> {
    return (await this.all("SELECT * FROM financial_products.app_journeys WHERE app_id = $1 ORDER BY journey_id", [appId])).map(toAppJourney);
  }

  // The latest consent grant or withdrawal for one purpose in one session (disclosures don't count).
  async latestConsent(sessionId: string, productId: string, purpose: string): Promise<ClientEvidence | undefined> {
    const r = await this.one(
      `SELECT * FROM financial_products.client_evidence WHERE session_id = $1 AND product_id = $2 AND subject = $3 AND type IN ('consent_given', 'consent_withdrawn')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [sessionId, productId, purpose],
    );
    return r && toClientEvidence(r);
  }

  async clientEvidence(appId: string, limit = 200): Promise<ClientEvidence[]> {
    return (await this.all("SELECT * FROM financial_products.client_evidence WHERE app_id = $1 ORDER BY created_at DESC LIMIT $2", [appId, limit])).map(toClientEvidence);
  }

  async apiKeyBySecret(secret: string): Promise<{ key: ApiKey; app: App } | undefined> {
    const r = await this.one(
      `UPDATE financial_products.api_keys SET last_used_at = CASE
         WHEN last_used_at IS NULL OR last_used_at < now() - interval '1 minute' THEN now() ELSE last_used_at END
       WHERE key_hash = $1 AND status = 'active' RETURNING *`,
      [hashToken(secret)],
    );
    if (!r) return undefined;
    const app = await this.getApp(r.app_id as string);
    return app && { key: toApiKey(r), app };
  }

  // A new secret for the same key; the old secret stops working at once.
  async rotateApiKey(id: string, environment: KeyEnvironment): Promise<{ key: ApiKey; secret: string }> {
    const secret = newApiKey(environment);
    const r = await this.one(
      "UPDATE financial_products.api_keys SET key_hash = $2, prefix = $3, rotated_at = now() WHERE id::text = $1 RETURNING *",
      [id, hashToken(secret), secret.slice(0, 14)],
    );
    return { key: toApiKey(r!), secret };
  }

  async revokeApiKey(id: string): Promise<ApiKey> {
    const r = await this.one("UPDATE financial_products.api_keys SET status = 'revoked', revoked_at = now() WHERE id::text = $1 RETURNING *", [id]);
    return toApiKey(r!);
  }

  // Whether any active key lists `origin`, for CORS preflights (which carry no key).
  async originAllowed(origin: string): Promise<boolean> {
    return !!(await this.one("SELECT 1 FROM financial_products.api_keys WHERE status = 'active' AND $1 = ANY(allowed_origins) LIMIT 1", [origin]));
  }

  async createHandoff(h: Omit<Handoff, "status" | "created_at" | "resolved_at"> & { key_id: string | null }): Promise<Handoff> {
    const r = await this.one(
      `INSERT INTO financial_products.handoffs (id, app_id, key_id, product_id, action, consumer_ref, sandbox, status, redirect_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'started', $8) RETURNING *`,
      [h.id, h.app_id, h.key_id, h.product_id, h.action, h.consumer_ref, h.sandbox, h.redirect_url],
    );
    return toHandoff(r!);
  }

  async getHandoff(id: string): Promise<Handoff | undefined> {
    const r = await this.one("SELECT * FROM financial_products.handoffs WHERE id::text = $1", [id]);
    return r && toHandoff(r);
  }

  // Resolves a hand-off that is still open; undefined if it was already resolved.
  async resolveHandoff(id: string, status: "completed" | "failed"): Promise<Handoff | undefined> {
    const r = await this.one(
      "UPDATE financial_products.handoffs SET status = $2, resolved_at = now() WHERE id::text = $1 AND status = 'started' RETURNING *",
      [id, status],
    );
    return r && toHandoff(r);
  }

  async recordAppEvent(e: { app_id: string; product_id: string; type: string; screen: string | null; sandbox: boolean }): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      "INSERT INTO financial_products.app_events (id, app_id, product_id, type, screen, sandbox) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, e.app_id, e.product_id, e.type, e.screen, e.sandbox],
    );
    return id;
  }

  // Counts per app, product, UTC day and kind: app events (view, click, handoff_started) and
  // hand-offs (handoff:started, handoff:completed, handoff:failed). `from` inclusive, `to` exclusive.
  async runtimeCounts(q: { app_ids?: string[]; product_ids?: string[]; from: string; to: string; include_sandbox: boolean }) {
    const rows = await this.all(
      `SELECT app_id::text AS app_id, product_id, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, kind, count(*)::int AS n FROM (
         SELECT app_id, product_id, created_at, type AS kind, sandbox FROM financial_products.app_events
         UNION ALL
         SELECT app_id, product_id, created_at, 'handoff:started', sandbox FROM financial_products.handoffs
         UNION ALL
         SELECT app_id, product_id, created_at, 'handoff:' || status, sandbox FROM financial_products.handoffs WHERE status <> 'started'
       ) x
       WHERE ($1::text[] IS NULL OR app_id::text = ANY($1)) AND ($2::text[] IS NULL OR product_id = ANY($2))
         AND created_at >= $3::timestamptz AND created_at < $4::timestamptz AND (NOT sandbox OR $5)
       GROUP BY 1, 2, 3, 4 ORDER BY 3, 2`,
      [q.app_ids ?? null, q.product_ids ?? null, q.from, q.to, q.include_sandbox],
    );
    return rows as { app_id: string; product_id: string; day: string; kind: string; n: number }[];
  }

  async createTestConsumer(appId: string, label: string): Promise<{ consumer_ref: string; app_id: string; label: string; created_at: string }> {
    const r = await this.one(
      "INSERT INTO financial_products.test_consumers (consumer_ref, app_id, label) VALUES ($1, $2, $3) RETURNING *",
      [`tc_${randomBytes(12).toString("base64url")}`, appId, label],
    );
    return { consumer_ref: r!.consumer_ref as string, app_id: r!.app_id as string, label: r!.label as string, created_at: iso(r!.created_at)! };
  }

  async appsUsingProduct(productId: string): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE $1 = ANY(product_ids) ORDER BY created_at", [productId])).map(toApp);
  }

  async createWebhook(createdBy: string, w: Pick<Webhook, "app_id" | "url" | "events">): Promise<{ webhook: Webhook; secret: string }> {
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const r = await this.one(
      "INSERT INTO financial_products.webhooks (id, app_id, url, events, secret, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
      [randomUUID(), w.app_id, w.url, w.events, secret, createdBy],
    );
    return { webhook: toWebhook(r!), secret };
  }

  async getWebhook(id: string): Promise<Webhook | undefined> {
    const r = await this.one("SELECT * FROM financial_products.webhooks WHERE id::text = $1", [id]);
    return r && toWebhook(r);
  }

  async webhooksForApps(appIds: string[]): Promise<Webhook[]> {
    if (appIds.length === 0) return [];
    return (await this.all("SELECT * FROM financial_products.webhooks WHERE app_id::text = ANY($1) ORDER BY created_at", [appIds])).map(toWebhook);
  }

  async rotateWebhookSecret(id: string): Promise<string> {
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    await this.db.query("UPDATE financial_products.webhooks SET secret = $2 WHERE id::text = $1", [id, secret]);
    return secret;
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.db.query("DELETE FROM financial_products.webhooks WHERE id::text = $1", [id]);
  }

  // Queues one delivery of an event to every webhook of `appIds` subscribed to its type, with the
  // receiving app's id in the payload's data.
  async enqueueEvent(appIds: string[], payload: { id: string; type: string }, sandbox: boolean): Promise<number> {
    if (appIds.length === 0) return 0;
    const rows = await this.all(
      `INSERT INTO financial_products.webhook_deliveries (id, webhook_id, event_id, type, payload, sandbox, status, next_attempt_at)
       SELECT gen_random_uuid(), w.id, $2::uuid, $3, jsonb_set($4::jsonb, '{data,app_id}', to_jsonb(w.app_id::text)), $5, 'pending', now()
       FROM financial_products.webhooks w WHERE w.app_id::text = ANY($1) AND $3 = ANY(w.events) AND w.disabled_at IS NULL
       RETURNING id`,
      [appIds, payload.id, payload.type, JSON.stringify(payload), sandbox],
    );
    return rows.length;
  }

  // A firm's own webhooks (innovators): events about what Mynt does for the firm, e.g. vendor-served actions.
  async createFirmWebhook(createdBy: string, w: { entity_id: string; url: string; events: string[] }): Promise<{ webhook: Webhook; secret: string }> {
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const r = await this.one(
      "INSERT INTO financial_products.webhooks (id, app_id, entity_id, url, events, secret, created_by) VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING *",
      [randomUUID(), w.entity_id, w.url, w.events, secret, createdBy],
    );
    return { webhook: toWebhook(r!), secret };
  }

  async firmWebhooks(entityId: string): Promise<Webhook[]> {
    return (await this.all("SELECT * FROM financial_products.webhooks WHERE entity_id::text = $1 ORDER BY created_at", [entityId])).map(toWebhook);
  }

  // Queues one delivery of an event to every webhook of the firm subscribed to its type.
  async enqueueFirmEvent(entityId: string, payload: { id: string; type: string }, sandbox: boolean): Promise<number> {
    const rows = await this.all(
      `INSERT INTO financial_products.webhook_deliveries (id, webhook_id, event_id, type, payload, sandbox, status, next_attempt_at)
       SELECT gen_random_uuid(), w.id, $2::uuid, $3, $4::jsonb, $5, 'pending', now()
       FROM financial_products.webhooks w WHERE w.entity_id::text = $1 AND $3 = ANY(w.events)
         AND ($3 NOT LIKE 'covenant.%' OR ${COVENANT_HOOK_ELIGIBLE})
       RETURNING id`,
      [entityId, payload.id, payload.type, JSON.stringify(payload), sandbox],
    );
    return rows.length;
  }

  // A covenant alert held back at send time: the breach's record says so. `first`: it was the breach's first alert.
  async recordCovenantAlertUndelivered(breachId: string, type: string, first: boolean, reason: string): Promise<void> {
    await this.db.query(
      `INSERT INTO financial_products.covenant_breach_events (id, breach_id, event, reason, details, at)
       SELECT $1::uuid, b.id, 'alert_undelivered', $3, $4::jsonb, now() FROM financial_products.covenant_breaches b WHERE b.id = $2::uuid`,
      [randomUUID(), breachId, reason, JSON.stringify({ type, first, at_send: true })],
    );
  }

  // How many of a firm's webhooks would receive this event now.
  async reachableFirmWebhooks(entityId: string, type: string): Promise<number> {
    const rows = await this.all(
      `SELECT count(*)::int AS n FROM financial_products.webhooks w WHERE w.entity_id::text = $1 AND $2 = ANY(w.events) AND ($2 NOT LIKE 'covenant.%' OR ${COVENANT_HOOK_ELIGIBLE})`,
      [entityId, type],
    );
    return Number(rows[0]?.n ?? 0);
  }

  // A hook subscribed to covenant.* whose creator can no longer receive them: its alerts are held back.
  async covenantWebhookBlocked(webhookId: string): Promise<boolean> {
    const rows = await this.all(`SELECT ${COVENANT_HOOK_ELIGIBLE} AS ok FROM financial_products.webhooks w WHERE w.id = $1`, [webhookId]);
    return rows[0]?.ok !== true;
  }

  // Claims due deliveries with their webhook's url and secret, leasing them for `leaseSeconds` so
  // another worker doesn't send them at the same time.
  async claimDueDeliveries(now: Date, limit: number, leaseSeconds = 60): Promise<(WebhookDelivery & { url: string; secret: string })[]> {
    const rows = await this.all(
      `WITH due AS (
         SELECT id FROM financial_products.webhook_deliveries
         WHERE status = 'pending' AND next_attempt_at <= $1::timestamptz ORDER BY next_attempt_at LIMIT $2 FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE financial_products.webhook_deliveries d SET next_attempt_at = $1::timestamptz + make_interval(secs => $3)
         FROM due WHERE d.id = due.id RETURNING d.*
       )
       SELECT claimed.*, w.url, w.secret FROM claimed JOIN financial_products.webhooks w ON w.id = claimed.webhook_id`,
      [now.toISOString(), limit, leaseSeconds],
    );
    return rows.map((r) => ({ ...toDelivery(r), url: r.url as string, secret: r.secret as string }));
  }

  // next_attempt_at null on a failure gives up on the delivery.
  async recordDeliveryAttempt(id: string, a: { ok: boolean; code: number | null; error: string | null; next_attempt_at: Date | null }): Promise<void> {
    await this.db.query(
      `UPDATE financial_products.webhook_deliveries SET attempts = attempts + 1, last_response_code = $2, last_error = $3,
         status = CASE WHEN $4 THEN 'delivered' WHEN $5::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
         next_attempt_at = CASE WHEN $4 THEN NULL ELSE $5::timestamptz END,
         delivered_at = CASE WHEN $4 THEN now() ELSE delivered_at END
       WHERE id = $1`,
      [id, a.code, a.error, a.ok, a.next_attempt_at?.toISOString() ?? null],
    );
  }

  async webhookDeliveries(webhookId: string, limit = 50): Promise<WebhookDelivery[]> {
    return (
      await this.all("SELECT * FROM financial_products.webhook_deliveries WHERE webhook_id::text = $1 ORDER BY created_at DESC LIMIT $2", [webhookId, limit])
    ).map(toDelivery);
  }

  async appReleases(appId: string): Promise<AppRelease[]> {
    return (await this.all("SELECT * FROM financial_products.app_releases WHERE app_id::text = $1 ORDER BY created_at", [appId])).map(toRelease);
  }

  // Snapshots the app's whole row as a release.
  async createAppRelease(appId: string, version: string, changelog: string, releasedBy: string): Promise<AppRelease> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.app_releases (app_id, version, changelog, snapshot, released_by)
         SELECT a.id, $2, $3, to_jsonb(a), $4 FROM financial_products.apps a WHERE a.id::text = $1 RETURNING *`,
        [appId, version, changelog, releasedBy],
      );
      return toRelease(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Version ${version} is already released`);
      throw e;
    }
  }

  // Overwrites the app's definition with a snapshot: every column except identity, ownership (its creator and its
  // workspace), status and timestamps. Columns the snapshot predates keep their current value.
  async restoreAppSnapshot(appId: string, snapshot: Record<string, unknown>): Promise<App> {
    const keep = new Set(["id", "owner_id", "workspace_id", "status", "created_at", "updated_at"]);
    const cols = (
      await this.all("SELECT column_name FROM information_schema.columns WHERE table_schema = 'financial_products' AND table_name = 'apps'")
    )
      .map((c) => c.column_name as string)
      .filter((c) => !keep.has(c) && c in snapshot);
    const set = [...cols.map((c) => `"${c.replace(/"/g, '""')}" = r."${c.replace(/"/g, '""')}"`), "updated_at = now()"].join(", ");
    const r = await this.one(
      `UPDATE financial_products.apps a SET ${set}
       FROM (SELECT (jsonb_populate_record(x, $2::jsonb)).* FROM financial_products.apps x WHERE x.id::text = $1) r
       WHERE a.id::text = $1 RETURNING a.*`,
      [appId, JSON.stringify(snapshot)],
    );
    return toApp(r!);
  }

  // ---- end runtime layer ----

  close(): Promise<void> {
    return this.db.close();
  }

  async ping(): Promise<void> {
    await this.db.query("SELECT 1");
  }

  private async one(sql: string, params: unknown[]): Promise<Row | undefined> {
    return (await this.db.query(sql, params)).rows[0];
  }

  private async all(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.db.query(sql, params)).rows;
  }

  // Users

  async createUser(name: string, roles: Role[]): Promise<{ user: User; token: string }> {
    const token = `fpm_${randomBytes(24).toString("base64url")}`;
    const r = await this.one(
      "INSERT INTO financial_products.users (id, name, roles, token_hash) VALUES ($1, $2, $3, $4) RETURNING *",
      [randomUUID(), name, roles, hashToken(token)],
    );
    return { user: toUser(r!), token };
  }

  async userByToken(token: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE token_hash = $1", [hashToken(token)]);
    return r && toUser(r);
  }

  async listUsers(): Promise<User[]> {
    return (await this.all("SELECT * FROM financial_products.users ORDER BY created_at")).map(toUser);
  }

  async clerkIdForEmail(email: string): Promise<string | null> {
    const r = await this.one("SELECT clerk_user_id FROM financial_products.users WHERE email = $1", [email.toLowerCase()]);
    return (r?.clerk_user_id as string | null | undefined) ?? null;
  }

  async userByClerkId(clerkUserId: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE clerk_user_id = $1", [clerkUserId]);
    return r && toUser(r);
  }

  // Creates or refreshes the user linked to a Clerk account. Roles always come from the invite.
  // A known verified email with a new Clerk id (e.g. after moving to a production Clerk instance)
  // relinks the existing user, so they keep what they own.
  async upsertClerkUser(clerkUserId: string, email: string, name: string, roles: Role[]): Promise<User> {
    const lower = email.toLowerCase();
    const before = await this.one(
      "SELECT id, roles FROM financial_products.users WHERE clerk_user_id = $1 OR email = $2 ORDER BY (clerk_user_id = $1) DESC NULLS LAST LIMIT 1",
      [clerkUserId, lower],
    );
    const updated = await this.one(
      `UPDATE financial_products.users SET clerk_user_id = $1, email = $2, roles = $3
       WHERE id = (SELECT id FROM financial_products.users WHERE clerk_user_id = $1 OR email = $2
                   ORDER BY (clerk_user_id = $1) DESC NULLS LAST LIMIT 1)
       RETURNING *`,
      [clerkUserId, lower, roles],
    );
    if (updated) {
      const had = (before?.roles as string[] | undefined) ?? [];
      // Made an admin by an invite rewrite: an admin account acts for no firm's books, so its standing ends, as an
      // admin's action (which locks recovery at the firm for 30 days: firm-notices.ts).
      if (!had.includes("admin") && roles.includes("admin")) {
        const row = await this.one("SELECT entity_id, lp_since FROM financial_products.users WHERE id = $1", [updated.id]);
        if (row?.entity_id && row.lp_since) await this.loseStanding(updated.id as string, row.entity_id as string, "admin_promoted");
      }
      await this.licenceProviderRoleChanged(updated.id as string, had.includes("license_provider"), roles.includes("license_provider"));
      return toUser((await this.one("SELECT * FROM financial_products.users WHERE id = $1", [updated.id]))!);
    }
    const r = await this.one(
      "INSERT INTO financial_products.users (id, name, roles, clerk_user_id, email) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), name, roles, clerkUserId, lower],
    );
    return toUser(r!);
  }

  // A member whose roles gain license_provider (an admin's invite, applied when they sign in again) doesn't gain
  // standing at their firm by it when the firm already has a licence provider with standing: that's a request one of
  // them accepts (firm_member_requests), told to them on their webhooks and as notices. A firm with none grants it now.
  // Losing the role ends the standing.
  private async licenceProviderRoleChanged(userId: string, had: boolean, has: boolean): Promise<void> {
    if (had === has) return;
    const u = await this.one("SELECT entity_id, lp_since FROM financial_products.users WHERE id = $1", [userId]);
    const entityId = (u?.entity_id as string | null) ?? null;
    if (!entityId) return; // standing comes when they join a firm
    if (!has) {
      // The roles come from the whitelist entry an admin set (invite_user), applied at this sign-in.
      if (u?.lp_since) await this.loseStanding(userId, entityId, "role_removed_by_invite");
      return;
    }
    await this.grantOrRequestStanding(userId, entityId, null, "role_gained");
  }

  // ---- licence-provider standing (firm-notices.ts has the rest) ----

  // Notices to these accounts about a firm (all its current members by default), and the firm's webhook event.
  async noticeAccounts(entityId: string, type: string, data: Record<string, unknown>, userIds?: string[]): Promise<number> {
    const ids = userIds ?? (await this.all("SELECT id FROM financial_products.users WHERE entity_id = $1", [entityId])).map((r) => r.id as string);
    for (const id of new Set(ids)) await this.db.query("INSERT INTO financial_products.firm_notices (id, entity_id, user_id, type, data) VALUES ($1, $2, $3, $4, $5)", [randomUUID(), entityId, id, type, JSON.stringify(data)]);
    await this.enqueueFirmEvent(entityId, { id: randomUUID(), type, created_at: new Date().toISOString(), data } as never, false);
    return ids.length;
  }

  // Every account that has ever had licence-provider standing at the firm, current or not.
  async pastLicenceProviders(entityId: string): Promise<string[]> {
    return (await this.all("SELECT DISTINCT user_id FROM financial_products.firm_standing_history WHERE entity_id = $1 AND event = 'gained'", [entityId])).map((r) => r.user_id as string);
  }

  // An account of a firm takes up the licence-provider role there. The firm's first ever licence provider has standing
  // at once, and that marks the firm established (in one transaction, with the firm's row locked, so two can't both be
  // first). After that it's always a request (firm_member_requests), however the account got there.
  async grantOrRequestStanding(userId: string, entityId: string, requestedBy: string | null, reason: string): Promise<{ standing: "granted" } | { standing: "requested"; request_id: string }> {
    const out = await inTransaction(this.db, async (tx) => {
      const e = (await tx.query("SELECT lp_established_at FROM financial_products.entities WHERE id = $1 FOR UPDATE", [entityId])).rows[0];
      if (!e) throw new Error(`No firm '${entityId}'`);
      // Claimed in one statement too, so it holds even where the row lock can't (one shared connection).
      const first = e.lp_established_at ? [] : (await tx.query("UPDATE financial_products.entities SET lp_established_at = now() WHERE id = $1 AND lp_established_at IS NULL RETURNING id", [entityId])).rows;
      if (first.length) {
        await tx.query("UPDATE financial_products.users SET lp_since = now() WHERE id = $1", [userId]);
        await tx.query("INSERT INTO financial_products.firm_standing_history (entity_id, user_id, event, reason) VALUES ($1, $2, 'gained', 'first_licence_provider')", [entityId, userId]);
        return { standing: "granted" as const };
      }
      const pending = (await tx.query("SELECT id FROM financial_products.firm_member_requests WHERE entity_id = $1 AND user_id = $2 AND status = 'pending'", [entityId, userId])).rows[0];
      if (pending) return { standing: "requested" as const, request_id: pending.id as string, fresh: false };
      const id = randomUUID();
      await tx.query("INSERT INTO financial_products.firm_member_requests (id, entity_id, user_id, requested_by, reason) VALUES ($1, $2, $3, $4, $5)", [id, entityId, userId, requestedBy, reason]);
      return { standing: "requested" as const, request_id: id, fresh: true };
    });
    if (out.standing === "granted") {
      await this.audit(null, "licence_provider_standing_granted", entityId, { user_id: userId, reason: "first_licence_provider" });
      return out;
    }
    if ("fresh" in out && out.fresh) {
      const u = await this.one("SELECT email, roles FROM financial_products.users WHERE id = $1", [userId]);
      const members = (await this.all("SELECT id FROM financial_products.users WHERE entity_id = $1 AND id <> $2", [entityId, userId])).map((r) => r.id as string);
      await this.noticeAccounts(entityId, "firm.member_pending", { request_id: out.request_id, member_email: u?.email ?? null, member_roles: u?.roles ?? [], reason, requested_at: new Date().toISOString(), decide_with: "decide_firm_member { request_id, accept: true | false }" }, members);
      await this.audit(requestedBy, "licence_provider_standing_requested", entityId, { request_id: out.request_id, user_id: userId, reason });
    }
    return { standing: "requested", request_id: out.request_id };
  }

  // Standing ends (the role was taken away, or the account left the firm): recorded, and told to the firm.
  async loseStanding(userId: string, entityId: string, reason: string): Promise<void> {
    const { rows } = await this.db.query("UPDATE financial_products.users SET lp_since = NULL WHERE id = $1 AND lp_since IS NOT NULL RETURNING email", [userId]);
    if (!rows.length) return;
    await this.db.query("INSERT INTO financial_products.firm_standing_history (entity_id, user_id, event, reason) VALUES ($1, $2, 'lost', $3)", [entityId, userId, reason]);
    const members = (await this.all("SELECT id FROM financial_products.users WHERE entity_id = $1", [entityId])).map((r) => r.id as string);
    await this.noticeAccounts(entityId, "firm.member_standing_lost", { member_email: rows[0].email ?? null, reason, at: new Date().toISOString() }, [...members, userId]);
    await this.audit(null, "licence_provider_standing_lost", entityId, { user_id: userId, reason });
  }

  // Whitelist

  async upsertInvite(email: string, roles: Role[]): Promise<Invite> {
    const r = await this.one(
      `INSERT INTO financial_products.invites (email, roles) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET roles = EXCLUDED.roles, updated_at = now() RETURNING *`,
      [email.toLowerCase(), roles],
    );
    return toInvite(r!);
  }

  async getInvite(email: string): Promise<Invite | undefined> {
    const r = await this.one("SELECT * FROM financial_products.invites WHERE email = $1", [email.toLowerCase()]);
    return r && toInvite(r);
  }

  async deleteInvite(email: string): Promise<boolean> {
    return (await this.all("DELETE FROM financial_products.invites WHERE email = $1 RETURNING email", [email.toLowerCase()])).length > 0;
  }

  async listInvites(): Promise<Invite[]> {
    return (await this.all("SELECT * FROM financial_products.invites ORDER BY created_at")).map(toInvite);
  }

  async blockSignup(email: string, by: string | null): Promise<void> {
    await this.db.query("INSERT INTO financial_products.signup_blocks (email, blocked_by) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING", [email.toLowerCase(), by]);
  }

  async unblockSignup(email: string): Promise<void> {
    await this.db.query("DELETE FROM financial_products.signup_blocks WHERE email = $1", [email.toLowerCase()]);
  }

  async isSignupBlocked(email: string): Promise<boolean> {
    return Boolean(await this.one("SELECT 1 FROM financial_products.signup_blocks WHERE email = $1", [email.toLowerCase()]));
  }

  // Settings

  async getSetting<T>(key: string): Promise<T | undefined> {
    const r = await this.one("SELECT value FROM financial_products.settings WHERE key = $1", [key]);
    return r ? (r.value as T) : undefined;
  }

  async setSetting(key: string, value: unknown, by: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO financial_products.settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), by],
    );
  }

  // Whether anyone with a verified email may sign in (as a consumer) without an invite.
  async publicSignup(): Promise<boolean> {
    return (await this.getSetting<{ enabled: boolean }>("public_signup"))?.enabled === true;
  }

  // Products

  async setDefinition(productId: string, definition: Record<string, unknown> | null): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET definition = $2, updated_at = now() WHERE id = $1", [productId, definition && JSON.stringify(definition)]);
  }

  async setComposition(productId: string, components: Component[], parties: PartyBinding[]): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET components = $2, parties = $3, updated_at = now() WHERE id = $1", [
      productId,
      JSON.stringify(components),
      JSON.stringify(parties),
    ]);
  }

  // The products this one is built on (a v2 definition's builds_on; see regime.ts).
  async setUnderlyingProducts(productId: string, ids: string[]): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET underlying_product_ids = $2, updated_at = now() WHERE id = $1", [productId, ids]);
  }

  // Pinning a new live version clears any drift recorded against the previous one.
  async setPins(productId: string, pins: Pins | null): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET pins = $2, drift = NULL WHERE id = $1", [productId, pins && JSON.stringify(pins)]);
  }

  async setDrift(productId: string, drift: ProductRecord["drift"]): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET drift = $2 WHERE id = $1", [productId, drift && JSON.stringify(drift)]);
  }

  // Published products whose pins rest on this legal entity (as owner, provider or party holder); all of them without one.
  async pinnedProducts(entityId?: string): Promise<ProductRecord[]> {
    const rows = entityId
      ? await this.all("SELECT * FROM financial_products.products WHERE status = 'published' AND pins->'entity_ids' ? $1 ORDER BY id", [entityId])
      : await this.all("SELECT * FROM financial_products.products WHERE status = 'published' AND pins IS NOT NULL ORDER BY id");
    return rows.map(toProductRecord);
  }

  // Published products whose live version is built on this one (see pins.ts).
  async productsBuiltOn(productId: string): Promise<ProductRecord[]> {
    const rows = await this.all("SELECT * FROM financial_products.products WHERE status = 'published' AND pins->'state'->'products' ? $1 ORDER BY id", [productId]);
    return rows.map(toProductRecord);
  }

  // Every product (drafts too), for recomputing what's derived from each (see derived.ts).
  async allProducts(): Promise<ProductRecord[]> {
    return (await this.all("SELECT * FROM financial_products.products ORDER BY id")).map(toProductRecord);
  }

  // Products resting on a legal entity: owned by it, pinned to it, or with a component provided by a party it stands behind.
  async productsRestingOn(entityId: string): Promise<ProductRecord[]> {
    const rows = await this.all(
      `SELECT p.* FROM financial_products.products p
        WHERE p.entity_id = $1 OR p.pins->'entity_ids' ? $1::text
           OR p.components @> jsonb_build_array(jsonb_build_object('provider', jsonb_build_object('by', 'sponsor', 'entity_id', $1::text)))
           OR EXISTS (SELECT 1 FROM financial_products.entity_parties pa
                       WHERE pa.legal_entity_id = $1
                         AND p.components @> jsonb_build_array(jsonb_build_object('provider', jsonb_build_object('by', 'party', 'party_id', pa.id::text))))
        ORDER BY p.id`,
      [entityId],
    );
    return rows.map(toProductRecord);
  }

  // Ids of products Mynt hasn't derived a regime summary and take rate for yet.
  async productsNotDerived(): Promise<string[]> {
    return (await this.all("SELECT id FROM financial_products.products WHERE derived_at IS NULL ORDER BY id")).map((r) => r.id as string);
  }

  // Doesn't touch updated_at: deriving isn't an edit.
  async setProductDerived(productId: string, regimeSummary: unknown, takeRate: unknown): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET regime_summary = $2, take_rate = $3, derived_at = now() WHERE id = $1", [
      productId,
      regimeSummary == null ? null : JSON.stringify(regimeSummary),
      takeRate == null ? null : JSON.stringify(takeRate),
    ]);
  }

  async productDerived(productId: string): Promise<{ regime_summary: unknown; take_rate: unknown; derived_at: string | null } | undefined> {
    const r = await this.one("SELECT regime_summary, take_rate, derived_at FROM financial_products.products WHERE id = $1", [productId]);
    return r && { regime_summary: r.regime_summary ?? null, take_rate: r.take_rate ?? null, derived_at: iso(r.derived_at) };
  }

  async getProduct(id: string): Promise<ProductRecord | undefined> {
    const r = await this.one("SELECT * FROM financial_products.products WHERE id = $1", [id]);
    return r && toProductRecord(r);
  }

  async publishedProducts(): Promise<FinancialProduct[]> {
    const rows = await this.all("SELECT * FROM financial_products.products WHERE status = 'published' ORDER BY published_at, id");
    return rows.map((r) => toProductRecord(r).product);
  }

  async productsByOwner(ownerId: string): Promise<ProductRecord[]> {
    return (await this.all("SELECT * FROM financial_products.products WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(
      toProductRecord,
    );
  }

  async insertDraft(
    ownerId: string,
    p: FinancialProduct,
    meta: { entity_id?: string | null; action?: ProductAction; underlying_product_ids?: string[] } = {},
  ): Promise<ProductRecord> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.products (id, owner_id, status, data, entity_id, action, underlying_product_ids)
         VALUES ($1, $2, 'draft', $3, $4, $5, $6) RETURNING *`,
        [p.id, ownerId, JSON.stringify(p), meta.entity_id ?? null, meta.action ?? "issuance", meta.underlying_product_ids ?? []],
      );
      return toProductRecord(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Product id '${p.id}' is taken`);
      throw e;
    }
  }

  async saveProduct(p: FinancialProduct, status: ProductStatus): Promise<ProductRecord> {
    const r = await this.one(
      "UPDATE financial_products.products SET data = $1, status = $2, updated_at = now() WHERE id = $3 RETURNING *",
      [JSON.stringify(p), status, p.id],
    );
    return toProductRecord(r!);
  }

  async saveTestReport(id: string, report: TestReport): Promise<void> {
    await this.db.query("UPDATE financial_products.products SET last_test = $1 WHERE id = $2", [JSON.stringify(report), id]);
  }

  async setProductStatus(id: string, status: ProductStatus): Promise<ProductRecord> {
    const r = await this.one(
      `UPDATE financial_products.products
       SET status = $1, updated_at = now(), published_at = CASE WHEN $1 = 'published' THEN now() ELSE published_at END
       WHERE id = $2 RETURNING *`,
      [status, id],
    );
    return toProductRecord(r!);
  }

  // Publishes the product's current data as its current version and records it in the history
  // (one statement, so the history and the live product never disagree).
  async publishCurrentVersion(id: string): Promise<ProductRecord> {
    const r = await this.one(
      `WITH p AS (
         UPDATE financial_products.products SET status = 'published', updated_at = now(), published_at = now()
         WHERE id = $1 RETURNING *
       ), sup AS (
         UPDATE financial_products.product_versions SET status = 'superseded'
         WHERE product_id = $1 AND status = 'published' AND version <> (SELECT version FROM p)
       ), ins AS (
         INSERT INTO financial_products.product_versions (product_id, version, status, data, changelog, last_test, published_at)
         SELECT id, version, 'published', data, 'Initial release', last_test, now() FROM p
         ON CONFLICT (product_id, version) DO UPDATE
           SET status = 'published', data = EXCLUDED.data, last_test = EXCLUDED.last_test, published_at = now()
       )
       SELECT * FROM p`,
      [id],
    );
    return toProductRecord(r!);
  }

  // Versions

  async productVersions(id: string): Promise<ProductVersion[]> {
    return (await this.all("SELECT * FROM financial_products.product_versions WHERE product_id = $1 ORDER BY version", [id])).map(
      toProductVersion,
    );
  }

  async draftVersion(id: string): Promise<ProductVersion | undefined> {
    const r = await this.one("SELECT * FROM financial_products.product_versions WHERE product_id = $1 AND status = 'draft'", [id]);
    return r && toProductVersion(r);
  }

  async createDraftVersion(id: string, data: FinancialProduct, changelog: string): Promise<ProductVersion> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.product_versions (product_id, version, status, data, changelog)
         SELECT $1, GREATEST(p.version, COALESCE(MAX(v.version), 0)) + 1, 'draft', $2, $3
         FROM financial_products.products p LEFT JOIN financial_products.product_versions v ON v.product_id = p.id
         WHERE p.id = $1 GROUP BY p.version
         RETURNING *`,
        [id, JSON.stringify(data), changelog],
      );
      return toProductVersion(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`'${id}' already has a draft version; update, test and publish it first`);
      throw e;
    }
  }

  async saveDraftVersion(id: string, data: FinancialProduct, changelog: string): Promise<ProductVersion> {
    const r = await this.one(
      `UPDATE financial_products.product_versions SET data = $2, changelog = $3, last_test = NULL
       WHERE product_id = $1 AND status = 'draft' RETURNING *`,
      [id, JSON.stringify(data), changelog],
    );
    return toProductVersion(r!);
  }

  async saveDraftVersionTest(id: string, report: TestReport): Promise<void> {
    await this.db.query("UPDATE financial_products.product_versions SET last_test = $2 WHERE product_id = $1 AND status = 'draft'", [
      id,
      JSON.stringify(report),
    ]);
  }

  // The draft version becomes the live product; the previous live version is superseded.
  async publishDraftVersion(id: string): Promise<ProductRecord> {
    const r = await this.one(
      `WITH d AS (
         SELECT * FROM financial_products.product_versions WHERE product_id = $1 AND status = 'draft'
       ), sup AS (
         UPDATE financial_products.product_versions SET status = 'superseded'
         WHERE product_id = $1 AND status = 'published' AND EXISTS (SELECT 1 FROM d)
       ), pub AS (
         UPDATE financial_products.product_versions v SET status = 'published', published_at = now()
         FROM d WHERE v.product_id = d.product_id AND v.version = d.version RETURNING v.*
       )
       UPDATE financial_products.products p
       SET data = pub.data, version = pub.version, last_test = pub.last_test, status = 'published', updated_at = now(), published_at = now()
       FROM pub WHERE p.id = pub.product_id RETURNING p.*`,
      [id],
    );
    return toProductRecord(r!);
  }

  async upgradeEnrollments(productId: string, enrollmentId?: string): Promise<number> {
    const rows = await this.all(
      `UPDATE financial_products.enrollments e SET product_version = p.version
       FROM financial_products.products p
       WHERE e.product_id = p.id AND p.id = $1 AND e.status = 'active' AND e.product_version < p.version
         AND ($2::text IS NULL OR e.id::text = $2)
       RETURNING e.id`,
      [productId, enrollmentId ?? null],
    );
    return rows.length;
  }

  // Enrollments

  async createEnrollment(
    userId: string,
    productId: string,
    amount: number | null,
    attribution: { campaign_id: string; variant: string } | null = null,
  ): Promise<Enrollment> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.enrollments (id, user_id, product_id, product_version, amount, status, campaign_id, variant)
         SELECT $1, $2, $3, p.version, $4, 'active', $5, $6 FROM financial_products.products p WHERE p.id = $3
         RETURNING *`,
        [randomUUID(), userId, productId, amount, attribution?.campaign_id ?? null, attribution?.variant ?? null],
      );
      return toEnrollment(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Already enrolled in '${productId}'`);
      throw e;
    }
  }

  // Active enrollments with their product line, for segment matching.
  async activeEnrollmentFacts(): Promise<{ user_id: string; product_id: string; product_line: string }[]> {
    return (await this.all(
      `SELECT e.user_id, e.product_id, p.data->>'product_line' AS product_line
       FROM financial_products.enrollments e JOIN financial_products.products p ON p.id = e.product_id
       WHERE e.status = 'active'`,
    )) as { user_id: string; product_id: string; product_line: string }[];
  }

  async campaignEnrollments(campaignId: string): Promise<Enrollment[]> {
    return (await this.all("SELECT * FROM financial_products.enrollments WHERE campaign_id::text = $1", [campaignId])).map(toEnrollment);
  }

  // Segments and campaigns

  async createSegment(ownerId: string, name: string, criteria: SegmentCriteria): Promise<Segment> {
    const r = await this.one(
      "INSERT INTO financial_products.segments (id, owner_id, name, criteria) VALUES ($1, $2, $3, $4) RETURNING *",
      [randomUUID(), ownerId, name, JSON.stringify(criteria)],
    );
    return toSegment(r!);
  }

  async getSegment(id: string): Promise<Segment | undefined> {
    const r = await this.one("SELECT * FROM financial_products.segments WHERE id::text = $1", [id]);
    return r && toSegment(r);
  }

  async segmentsByOwner(ownerId: string): Promise<Segment[]> {
    return (await this.all("SELECT * FROM financial_products.segments WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toSegment);
  }

  async createCampaign(
    ownerId: string,
    c: Pick<Campaign, "name" | "product_ids" | "segment_id" | "channels" | "variants">,
  ): Promise<Campaign> {
    const r = await this.one(
      `INSERT INTO financial_products.campaigns (id, owner_id, name, product_ids, segment_id, channels, variants, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft') RETURNING *`,
      [randomUUID(), ownerId, c.name, c.product_ids, c.segment_id, c.channels, JSON.stringify(c.variants)],
    );
    return toCampaign(r!);
  }

  async getCampaign(id: string): Promise<Campaign | undefined> {
    const r = await this.one("SELECT * FROM financial_products.campaigns WHERE id::text = $1", [id]);
    return r && toCampaign(r);
  }

  async saveCampaign(c: Campaign): Promise<Campaign> {
    const r = await this.one(
      `UPDATE financial_products.campaigns
       SET name = $2, product_ids = $3, segment_id = $4, channels = $5, variants = $6, status = $7, last_lint = $8,
           updated_at = now(), launched_at = CASE WHEN $7 = 'live' AND launched_at IS NULL THEN now() ELSE launched_at END
       WHERE id = $1 RETURNING *`,
      [c.id, c.name, c.product_ids, c.segment_id, c.channels, JSON.stringify(c.variants), c.status, JSON.stringify(c.last_lint)],
    );
    return toCampaign(r!);
  }

  async campaignsByOwner(ownerId: string): Promise<Campaign[]> {
    return (await this.all("SELECT * FROM financial_products.campaigns WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(
      toCampaign,
    );
  }

  async liveCampaigns(): Promise<Campaign[]> {
    return (await this.all("SELECT * FROM financial_products.campaigns WHERE status = 'live' ORDER BY launched_at")).map(toCampaign);
  }

  async enrollmentsByUser(userId: string): Promise<Enrollment[]> {
    return (await this.all("SELECT * FROM financial_products.enrollments WHERE user_id = $1 ORDER BY created_at", [userId])).map(
      toEnrollment,
    );
  }

  async getEnrollment(id: string): Promise<Enrollment | undefined> {
    const r = await this.one("SELECT * FROM financial_products.enrollments WHERE id::text = $1", [id]);
    return r && toEnrollment(r);
  }

  async cancelEnrollment(id: string): Promise<Enrollment> {
    const r = await this.one("UPDATE financial_products.enrollments SET status = 'cancelled' WHERE id::text = $1 RETURNING *", [id]);
    return toEnrollment(r!);
  }

  // Apps

  // `workspaceId`: one the caller belongs to (the tools check). Omitted: the owner's own workspace (made if they have
  // none), for callers that predate workspaces.
  async createApp(
    ownerId: string,
    fields: Pick<App, "name" | "description" | "audience" | "product_ids"> & Partial<Pick<App, "disclosures" | "actions">>,
    workspaceId?: string,
  ): Promise<App> {
    const workspace = workspaceId ?? (await personalWorkspace(this.db, ownerId));
    const r = await this.one(
      `INSERT INTO financial_products.apps (id, owner_id, name, description, audience, product_ids, status, disclosures, actions, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8, $9) RETURNING *`,
      [randomUUID(), ownerId, fields.name, fields.description, fields.audience, fields.product_ids, fields.disclosures ?? [], fields.actions ?? ["display"], workspace],
    );
    return toApp(r!);
  }

  async getApp(id: string): Promise<App | undefined> {
    const r = await this.one("SELECT * FROM financial_products.apps WHERE id::text = $1", [id]);
    return r && toApp(r);
  }

  async saveApp(app: App): Promise<App> {
    const r = await this.one(
      `UPDATE financial_products.apps
       SET name = $1, description = $2, audience = $3, product_ids = $4, status = $5, disclosures = $7, actions = $8, updated_at = now()
       WHERE id = $6 RETURNING *`,
      [app.name, app.description, app.audience, app.product_ids, app.status, app.id, app.disclosures, app.actions],
    );
    return toApp(r!);
  }

  async appsByOwner(ownerId: string): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toApp);
  }

  // The apps a user may see and work on: those of every workspace they belong to (or of one of them), and any of
  // their own not yet in a workspace.
  async appsVisibleTo(userId: string, workspaceId?: string): Promise<App[]> {
    return (
      await this.all(
        `SELECT a.* FROM financial_products.apps a
         WHERE (a.workspace_id IN (SELECT workspace_id FROM financial_products.workspace_members WHERE user_id = $1)
                OR (a.workspace_id IS NULL AND a.owner_id = $1))
           AND ($2::text IS NULL OR a.workspace_id::text = $2)
         ORDER BY a.created_at`,
        [userId, workspaceId ?? null],
      )
    ).map(toApp);
  }


  async allApps(): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps ORDER BY created_at")).map(toApp);
  }

  // Entities and held licences

  async createEntity(
    createdBy: string | null,
    e: Pick<Entity, "name" | "registration_numbers" | "regions"> & Partial<Pick<Entity, "legal_form" | "incorporation" | "identifiers">>,
  ): Promise<Entity> {
    const r = await this.one(
      `INSERT INTO financial_products.entities (id, name, registration_numbers, regions, created_by, legal_form, incorporation, identifiers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        randomUUID(),
        e.name,
        JSON.stringify(e.registration_numbers),
        e.regions,
        createdBy,
        e.legal_form ?? null,
        e.incorporation ? JSON.stringify(e.incorporation) : null,
        JSON.stringify(e.identifiers ?? []),
      ],
    );
    return toEntity(r!);
  }

  async setEntityFacts(id: string, e: Partial<Pick<Entity, "legal_form" | "incorporation" | "identifiers">>): Promise<Entity> {
    const r = await this.one(
      `UPDATE financial_products.entities SET legal_form = COALESCE($2, legal_form), incorporation = COALESCE($3, incorporation),
         identifiers = COALESCE($4, identifiers) WHERE id::text = $1 RETURNING *`,
      [id, e.legal_form ?? null, e.incorporation ? JSON.stringify(e.incorporation) : null, e.identifiers ? JSON.stringify(e.identifiers) : null],
    );
    return toEntity(r!);
  }

  async setEntityStatus(id: string, status: EntityStatus): Promise<Entity> {
    const r = await this.one("UPDATE financial_products.entities SET status = $2 WHERE id::text = $1 RETURNING *", [id, status]);
    return toEntity(r!);
  }

  // Parties on a firm's roster

  async addParty(createdBy: string | null, p: Pick<Party, "entity_id" | "kind" | "person" | "legal_entity_id" | "attributes" | "fills" | "relationship" | "since">): Promise<Party> {
    const r = await this.one(
      `INSERT INTO financial_products.entity_parties
         (id, entity_id, kind, person, legal_entity_id, attributes, fills, relationship, since, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        randomUUID(),
        p.entity_id,
        p.kind,
        p.person && JSON.stringify(p.person),
        p.legal_entity_id,
        JSON.stringify(p.attributes),
        JSON.stringify(p.fills),
        p.relationship,
        p.since,
        createdBy,
      ],
    );
    return toParty(r!);
  }

  async getParty(id: string): Promise<Party | undefined> {
    const r = await this.one("SELECT * FROM financial_products.entity_parties WHERE id::text = $1", [id]);
    return r && toParty(r);
  }

  async partiesOf(entityId: string): Promise<Party[]> {
    return (await this.all("SELECT * FROM financial_products.entity_parties WHERE entity_id = $1 ORDER BY created_at", [entityId])).map(toParty);
  }

  // GRC folders

  async fileGrcRecord(
    createdBy: string | null,
    r: Pick<GrcRecord, "entity_id" | "party_id" | "licence_id" | "section" | "ref" | "key" | "record"> & { product_id?: string | null },
  ): Promise<GrcRecord> {
    await this.db.query(
      `UPDATE financial_products.grc_records SET status = 'superseded'
       WHERE entity_id = $1 AND COALESCE(party_id::text, '') = COALESCE($2::text, '') AND COALESCE(licence_id::text, '') = COALESCE($3::text, '')
         AND section = $4 AND key = $5 AND COALESCE(product_id, '') = COALESCE($6::text, '') AND status = 'current'`,
      [r.entity_id, r.party_id, r.licence_id, r.section, r.key, r.product_id ?? null],
    );
    const row = await this.one(
      `INSERT INTO financial_products.grc_records (id, entity_id, party_id, licence_id, section, ref, key, record, created_by, product_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [randomUUID(), r.entity_id, r.party_id, r.licence_id, r.section, r.ref, r.key, JSON.stringify(r.record), createdBy, r.product_id ?? null],
    );
    return toGrcRecord(row!);
  }

  async grcRecords(entityId: string, opts: { party_id?: string | null; history?: boolean } = {}): Promise<GrcRecord[]> {
    const rows = await this.all(
      `SELECT * FROM financial_products.grc_records WHERE entity_id = $1
         AND ($2::boolean OR status = 'current')
         AND ($3::text IS NULL OR party_id::text = $3)
       ORDER BY section, key, created_at`,
      [entityId, Boolean(opts.history), opts.party_id ?? null],
    );
    return rows.map(toGrcRecord);
  }

  async endParty(id: string, until: string): Promise<Party> {
    const r = await this.one(
      "UPDATE financial_products.entity_parties SET status = 'ended', until = $2, updated_at = now() WHERE id::text = $1 RETURNING *",
      [id, until],
    );
    return toParty(r!);
  }

  async getEntity(id: string): Promise<Entity | undefined> {
    const r = await this.one("SELECT * FROM financial_products.entities WHERE id::text = $1", [id]);
    return r && toEntity(r);
  }

  async listEntities(): Promise<Entity[]> {
    return (await this.all("SELECT * FROM financial_products.entities ORDER BY created_at")).map(toEntity);
  }

  // Membership of a firm. Leaving or moving ends standing at the old firm (told to it). Joining as a licence provider
  // has standing at once only as a firm's first ever licence provider; otherwise it's a request the firm settles.
  // `cause`: why standing at the old firm ends, kept in its history (an admin's move locks recovery there: firm-notices.ts).
  async setUserEntity(userId: string, entityId: string | null, cause = "left_firm"): Promise<{ standing: "none" | "granted" | "requested"; request_id?: string; left_standing_at?: string }> {
    const before = await this.one("SELECT entity_id, lp_since, roles FROM financial_products.users WHERE id = $1", [userId]);
    if (!before) return { standing: "none" };
    if (before.entity_id === entityId) return { standing: before.lp_since ? "granted" : "none" };
    const leftStandingAt = before.entity_id && before.lp_since ? (before.entity_id as string) : undefined;
    if (leftStandingAt) await this.loseStanding(userId, leftStandingAt, cause);
    const joinedOut = await this.joinFirm(userId, entityId, before.roles as string[]);
    return leftStandingAt ? { ...joinedOut, left_standing_at: leftStandingAt } : joinedOut;
  }

  private async joinFirm(userId: string, entityId: string | null, roles: string[]): Promise<{ standing: "none" | "granted" | "requested"; request_id?: string }> {
    const before = { roles };
    await this.db.query("UPDATE financial_products.users SET entity_id = $2, entity_joined_at = now(), lp_since = NULL WHERE id = $1", [userId, entityId]);
    if (!entityId || !((before.roles as string[]) ?? []).includes("license_provider")) return { standing: "none" };
    return this.grantOrRequestStanding(userId, entityId, null, "joined");
  }

  async userByEmail(email: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE email = $1", [email.toLowerCase()]);
    return r && toUser(r);
  }

  async getUser(id: string): Promise<User | undefined> {
    const r = await this.one("SELECT * FROM financial_products.users WHERE id::text = $1", [id]);
    return r && toUser(r);
  }

  async entityMembers(entityId: string): Promise<User[]> {
    return (await this.all("SELECT * FROM financial_products.users WHERE entity_id = $1 ORDER BY created_at", [entityId])).map(toUser);
  }

  async registerLicense(
    submittedBy: string,
    l: Pick<HeldLicense, "entity_id" | "region" | "regulator_id" | "license_id" | "registration_number" | "valid_from" | "valid_to"> & { jurisdiction?: string | null },
  ): Promise<HeldLicense> {
    // Re-registering (the same licence type, for the same jurisdiction) resubmits for review.
    const r = await this.one(
      `INSERT INTO financial_products.held_licenses
         (id, entity_id, region, regulator_id, license_id, registration_number, valid_from, valid_to, status, submitted_by, jurisdiction)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
       ON CONFLICT (entity_id, region, regulator_id, license_id, (COALESCE(jurisdiction, ''))) DO UPDATE SET
         registration_number = EXCLUDED.registration_number, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
         status = 'pending', submitted_by = EXCLUDED.submitted_by, reviewed_by = NULL, review_note = NULL, reviewed_at = NULL
       RETURNING *`,
      [randomUUID(), l.entity_id, l.region, l.regulator_id, l.license_id, l.registration_number, l.valid_from, l.valid_to, submittedBy, l.jurisdiction ?? null],
    );
    return toHeldLicense(r!);
  }

  // ---- licence providers' sponsorships (see sponsorships.ts) ----

  async requestSponsorship(
    requestedBy: string,
    s: Pick<Sponsorship, "product_id" | "component_key" | "builder_entity_id" | "provider_entity_id" | "requested_jurisdictions" | "note">,
  ): Promise<Sponsorship> {
    const r = await this.one(
      `INSERT INTO financial_products.sponsorships
         (id, product_id, component_key, builder_entity_id, provider_entity_id, requested_jurisdictions, status, note, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8) RETURNING *`,
      [randomUUID(), s.product_id, s.component_key, s.builder_entity_id, s.provider_entity_id, s.requested_jurisdictions, s.note, requestedBy],
    );
    return toSponsorship(r!);
  }

  async getSponsorship(id: string): Promise<Sponsorship | undefined> {
    const r = await this.one("SELECT * FROM financial_products.sponsorships WHERE id::text = $1", [id]);
    return r && toSponsorship(r);
  }

  async sponsorships(where: { product_id?: string; provider_entity_id?: string; builder_entity_id?: string; status?: SponsorshipStatus }): Promise<Sponsorship[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    for (const k of ["product_id", "provider_entity_id", "builder_entity_id", "status"] as const) {
      if (where[k] === undefined) continue;
      params.push(where[k]);
      clauses.push(`${k} = $${params.length}`);
    }
    const sql = `SELECT * FROM financial_products.sponsorships${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return (await this.all(sql, params)).map(toSponsorship);
  }

  async decideSponsorship(
    id: string,
    decision: { status: SponsorshipStatus; decided_by: string; note: string | null; licence_ids?: string[]; jurisdictions?: string[] },
  ): Promise<Sponsorship> {
    const r = await this.one(
      `UPDATE financial_products.sponsorships SET status = $2, decided_by = $3, decision_note = $4, decided_at = now(),
         licence_ids = COALESCE($5::uuid[], licence_ids), jurisdictions = COALESCE($6::text[], jurisdictions)
       WHERE id::text = $1 RETURNING *`,
      [id, decision.status, decision.decided_by, decision.note, decision.licence_ids ?? null, decision.jurisdictions ?? null],
    );
    return toSponsorship(r!);
  }

  // ---- public checks that a firm is real (see firm-checks.ts) ----

  async recordFirmCheck(c: Omit<FirmCheck, "id" | "retrieved_at"> & { retrieved_at?: string }): Promise<FirmCheck> {
    const r = await this.one(
      `INSERT INTO financial_products.firm_checks (id, entity_id, source, subject, url, retrieved_at, status, fields, response_hash, note, run_by)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $8, $9, $10, $11) RETURNING *`,
      [randomUUID(), c.entity_id, c.source, c.subject, c.url, c.retrieved_at ?? null, c.status, JSON.stringify(c.fields), c.response_hash, c.note, c.run_by],
    );
    return toFirmCheck(r!);
  }

  // A firm's checks, newest first.
  async firmChecks(entityId: string, limit = 200): Promise<FirmCheck[]> {
    return (
      await this.all("SELECT * FROM financial_products.firm_checks WHERE entity_id = $1 ORDER BY retrieved_at DESC, id LIMIT $2", [entityId, limit])
    ).map(toFirmCheck);
  }

  async getHeldLicense(id: string): Promise<HeldLicense | undefined> {
    const r = await this.one("SELECT * FROM financial_products.held_licenses WHERE id::text = $1", [id]);
    return r && toHeldLicense(r);
  }

  async licensesOf(entityId: string): Promise<HeldLicense[]> {
    return (await this.all("SELECT * FROM financial_products.held_licenses WHERE entity_id = $1 ORDER BY created_at", [entityId])).map(toHeldLicense);
  }

  async licensesByStatus(status?: LicenseStatus): Promise<HeldLicense[]> {
    const rows = status
      ? await this.all("SELECT * FROM financial_products.held_licenses WHERE status = $1 ORDER BY created_at", [status])
      : await this.all("SELECT * FROM financial_products.held_licenses ORDER BY created_at");
    return rows.map(toHeldLicense);
  }

  async reviewLicense(id: string, status: LicenseStatus, reviewerId: string, note: string | null): Promise<HeldLicense> {
    const r = await this.one(
      `UPDATE financial_products.held_licenses SET status = $2, reviewed_by = $3, review_note = $4, reviewed_at = now()
       WHERE id::text = $1 RETURNING *`,
      [id, status, reviewerId, note],
    );
    return toHeldLicense(r!);
  }

  // Product access

  async setProductAccess(id: string, mode: AccessMode, terms: BuildTerms): Promise<ProductRecord> {
    const r = await this.one(
      "UPDATE financial_products.products SET access_mode = $2, build_terms = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [id, mode, JSON.stringify(terms)],
    );
    return toProductRecord(r!);
  }

  async createRequest(
    req: Pick<AccessRequest, "kind" | "product_id" | "app_id" | "campaign_id" | "requester_id" | "status" | "note"> & { decided_by?: string | null },
  ): Promise<AccessRequest> {
    const r = await this.one(
      `INSERT INTO financial_products.requests (id, kind, product_id, app_id, campaign_id, requester_id, status, note, decided_by, decided_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $7 = 'pending' THEN NULL ELSE now() END) RETURNING *`,
      [randomUUID(), req.kind, req.product_id, req.app_id, req.campaign_id, req.requester_id, req.status, req.note, req.decided_by ?? null],
    );
    return toRequest(r!);
  }

  async getRequest(id: string): Promise<AccessRequest | undefined> {
    const r = await this.one("SELECT * FROM financial_products.requests WHERE id::text = $1", [id]);
    return r && toRequest(r);
  }

  async decideRequest(id: string, status: RequestStatus, deciderId: string, note: string | null): Promise<AccessRequest> {
    const r = await this.one(
      `UPDATE financial_products.requests SET status = $2, decided_by = $3, decision_note = $4, decided_at = now()
       WHERE id::text = $1 RETURNING *`,
      [id, status, deciderId, note],
    );
    return toRequest(r!);
  }

  async requestsForProducts(productIds: string[]): Promise<AccessRequest[]> {
    if (productIds.length === 0) return [];
    return (
      await this.all("SELECT * FROM financial_products.requests WHERE product_id = ANY($1) ORDER BY created_at DESC", [productIds])
    ).map(toRequest);
  }

  async requestsBy(requesterId: string): Promise<AccessRequest[]> {
    return (await this.all("SELECT * FROM financial_products.requests WHERE requester_id = $1 ORDER BY created_at DESC", [requesterId])).map(toRequest);
  }

  async requestsForCampaign(campaignId: string): Promise<AccessRequest[]> {
    return (await this.all("SELECT * FROM financial_products.requests WHERE campaign_id::text = $1 ORDER BY created_at", [campaignId])).map(toRequest);
  }

  async publishedApps(): Promise<App[]> {
    return (await this.all("SELECT * FROM financial_products.apps WHERE status = 'published' ORDER BY created_at")).map(toApp);
  }

  // --- SDKs and experiences (developer build layer) ---

  async appExperience(appId: string): Promise<unknown | null> {
    const r = await this.one("SELECT experience FROM financial_products.apps WHERE id::text = $1", [appId]);
    return (r?.experience as unknown) ?? null;
  }

  async setAppExperience(appId: string, experience: unknown): Promise<void> {
    await this.db.query("UPDATE financial_products.apps SET experience = $2, updated_at = now() WHERE id::text = $1", [
      appId,
      experience == null ? null : JSON.stringify(experience),
    ]);
  }

  async createSdk(ownerId: string, fields: Pick<Sdk, "name" | "languages" | "product_ids">): Promise<Sdk> {
    const r = await this.one(
      "INSERT INTO financial_products.sdks (id, owner_id, name, languages, product_ids) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), ownerId, fields.name, fields.languages, fields.product_ids],
    );
    return toSdk(r!);
  }

  async getSdk(id: string): Promise<Sdk | undefined> {
    const r = await this.one("SELECT * FROM financial_products.sdks WHERE id::text = $1", [id]);
    return r && toSdk(r);
  }

  async sdksByOwner(ownerId: string): Promise<Sdk[]> {
    return (await this.all("SELECT * FROM financial_products.sdks WHERE owner_id = $1 ORDER BY created_at", [ownerId])).map(toSdk);
  }

  async createSdkRelease(release: Omit<SdkRelease, "created_at">): Promise<SdkRelease> {
    try {
      const r = await this.one(
        `INSERT INTO financial_products.sdk_releases (sdk_id, version, changelog, sources, files)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [release.sdk_id, release.version, release.changelog, JSON.stringify(release.sources), JSON.stringify(release.files)],
      );
      return toSdkRelease(r!);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Release ${release.version} already exists`);
      throw e;
    }
  }

  // Newest first.
  async sdkReleases(sdkId: string): Promise<SdkRelease[]> {
    return (await this.all("SELECT * FROM financial_products.sdk_releases WHERE sdk_id::text = $1 ORDER BY created_at DESC", [sdkId])).map(
      toSdkRelease,
    );
  }

  // --- end SDKs and experiences ---

  // Product requests

  async createProductRequest(
    userId: string,
    r: Pick<ProductRequest, "need" | "product_line" | "amount" | "currency" | "tenor_days" | "region" | "context">,
  ): Promise<ProductRequest> {
    const row = await this.one(
      `INSERT INTO financial_products.product_requests (id, user_id, need, product_line, amount, currency, tenor_days, region, context)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [randomUUID(), userId, r.need, r.product_line, r.amount, r.currency, r.tenor_days, r.region, r.context],
    );
    return toProductRequest(row!);
  }

  async getProductRequest(id: string): Promise<ProductRequest | undefined> {
    const r = await this.one("SELECT * FROM financial_products.product_requests WHERE id::text = $1", [id]);
    return r && toProductRequest(r);
  }

  // Newest first.
  async productRequestsByUser(userId: string): Promise<ProductRequest[]> {
    return (
      await this.all("SELECT * FROM financial_products.product_requests WHERE user_id = $1 ORDER BY created_at DESC", [userId])
    ).map(toProductRequest);
  }

  // Requests still taking offers (not closed), newest first.
  async openProductRequests(f: { product_line?: string; region?: string; limit?: number } = {}): Promise<ProductRequest[]> {
    return (
      await this.all(
        `SELECT * FROM financial_products.product_requests
         WHERE status <> 'closed' AND ($1::text IS NULL OR product_line = $1) AND ($2::text IS NULL OR region = $2)
         ORDER BY created_at DESC LIMIT $3`,
        [f.product_line ?? null, f.region ?? null, f.limit ?? 50],
      )
    ).map(toProductRequest);
  }

  // Links a product to a request and marks the request offered, in one statement so the two
  // can't drift apart. Undefined when the request is closed (or gone).
  async offerForProductRequest(o: Omit<ProductRequestOffer, "created_at">): Promise<ProductRequestOffer | undefined> {
    try {
      const r = await this.one(
        `WITH request AS (
           SELECT id FROM financial_products.product_requests WHERE id::text = $1 AND status <> 'closed' FOR UPDATE
         ), offer AS (
           INSERT INTO financial_products.product_request_offers (request_id, product_id, innovator_id, note)
           SELECT id, $2, $3, $4 FROM request RETURNING *
         ), marked AS (
           UPDATE financial_products.product_requests SET status = 'offered'
           WHERE id IN (SELECT request_id FROM offer)
         )
         SELECT * FROM offer`,
        [o.request_id, o.product_id, o.innovator_id, o.note],
      );
      return r && toProductRequestOffer(r);
    } catch (e) {
      if (isUniqueViolation(e)) throw new DuplicateError(`Product '${o.product_id}' is already offered for this request`);
      throw e;
    }
  }

  // The person enrolled in a product offered for their requests: those requests are answered.
  async closeProductRequestsAnsweredBy(userId: string, productId: string): Promise<string[]> {
    return (
      await this.all(
        `UPDATE financial_products.product_requests SET status = 'closed'
         WHERE user_id = $1 AND status <> 'closed'
           AND id IN (SELECT request_id FROM financial_products.product_request_offers WHERE product_id = $2)
         RETURNING id`,
        [userId, productId],
      )
    ).map((r) => r.id as string);
  }

  async productRequestOffers(requestIds: string[]): Promise<ProductRequestOffer[]> {
    if (!requestIds.length) return [];
    return (
      await this.all(
        "SELECT * FROM financial_products.product_request_offers WHERE request_id::text = ANY($1) ORDER BY created_at",
        [requestIds],
      )
    ).map(toProductRequestOffer);
  }
}
