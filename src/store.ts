import { createHash, randomBytes, randomUUID } from "node:crypto";
import { currentLine, lineForTreasuryCategory, PRODUCT_LINES, UNDERLYINGS, WRAPPERS, type FinancialProduct } from "./catalog.js";
import type { DeveloperContract } from "./contract.js";
import type { Component, PartyBinding } from "./regime.js";
import type { Db } from "./db.js";
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

export const ROLES = ["consumer", "developer", "innovator", "admin"] as const;
export type Role = (typeof ROLES)[number];

// Roles nest: every admin is an innovator, every innovator a developer, every developer a consumer.
const IMPLIES: Record<Role, Role[]> = { consumer: [], developer: ["consumer"], innovator: ["developer"], admin: ["innovator"] };

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
  app_id: string;
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
  roles: Role[];
  email: string | null;
  entity_id: string | null;
  created_at: string;
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
  type: "disclosure_shown" | "consent_given" | "consent_withdrawn";
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
  state: { entities: Record<string, string>; licences: Record<string, string>; parties: Record<string, string> };
  definition_hash?: string; // the live v2 definition (see definition.ts), when the product has one
  contract?: DeveloperContract; // what developers build against, derived from that definition (see contract.ts)
}
export type DriftChange = { kind: "entity" | "licence" | "party"; id: string; was: string; now: string };
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
  drift: { detected_at: string; changes: DriftChange[] } | null; // pinned state that changed: new sales pause
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
  owner_id: string;
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
  -- Legal entities as typed facts, and the parties on each firm's roster.
  ALTER TABLE financial_products.entities ADD COLUMN IF NOT EXISTS legal_form text CHECK (legal_form IN (${sqlList(LEGAL_FORMS)}));
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
`;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

type Row = Record<string, unknown>;

const toUser = (r: Row): User => ({
  id: r.id as string,
  name: r.name as string,
  roles: r.roles as Role[],
  email: (r.email as string | null) ?? null,
  entity_id: (r.entity_id as string | null) ?? null,
  created_at: iso(r.created_at)!,
});

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
  app_id: r.app_id as string,
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

const toHeldLicense = (r: Row): HeldLicense => ({
  id: r.id as string,
  entity_id: r.entity_id as string,
  region: r.region as string,
  regulator_id: r.regulator_id as string,
  license_id: r.license_id as string,
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

  async eraseVault(appId: string, customerRef: string, sandbox: boolean): Promise<number> {
    return (await this.all("DELETE FROM financial_products.customer_vault WHERE app_id = $1 AND customer_ref = $2 AND sandbox = $3 RETURNING field", [appId, customerRef, sandbox])).length;
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
       FROM financial_products.webhooks w WHERE w.app_id::text = ANY($1) AND $3 = ANY(w.events)
       RETURNING id`,
      [appIds, payload.id, payload.type, JSON.stringify(payload), sandbox],
    );
    return rows.length;
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

  // Overwrites the app's definition with a snapshot: every column except identity, ownership, status
  // and timestamps. Columns the snapshot predates keep their current value.
  async restoreAppSnapshot(appId: string, snapshot: Record<string, unknown>): Promise<App> {
    const keep = new Set(["id", "owner_id", "status", "created_at", "updated_at"]);
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
    const updated = await this.one(
      `UPDATE financial_products.users SET clerk_user_id = $1, email = $2, roles = $3
       WHERE id = (SELECT id FROM financial_products.users WHERE clerk_user_id = $1 OR email = $2
                   ORDER BY (clerk_user_id = $1) DESC NULLS LAST LIMIT 1)
       RETURNING *`,
      [clerkUserId, lower, roles],
    );
    if (updated) return toUser(updated);
    const r = await this.one(
      "INSERT INTO financial_products.users (id, name, roles, clerk_user_id, email) VALUES ($1, $2, $3, $4, $5) RETURNING *",
      [randomUUID(), name, roles, clerkUserId, lower],
    );
    return toUser(r!);
  }

  // Whitelist

  async upsertInvite(email: string, roles: Role[]): Promise<Invite> {
    const r = await this.one(
      `INSERT INTO financial_products.invites (email, roles) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET roles = EXCLUDED.roles RETURNING *`,
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

  async createApp(
    ownerId: string,
    fields: Pick<App, "name" | "description" | "audience" | "product_ids"> & Partial<Pick<App, "disclosures" | "actions">>,
  ): Promise<App> {
    const r = await this.one(
      `INSERT INTO financial_products.apps (id, owner_id, name, description, audience, product_ids, status, disclosures, actions)
       VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8) RETURNING *`,
      [randomUUID(), ownerId, fields.name, fields.description, fields.audience, fields.product_ids, fields.disclosures ?? [], fields.actions ?? ["display"]],
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

  async setUserEntity(userId: string, entityId: string | null): Promise<void> {
    await this.db.query("UPDATE financial_products.users SET entity_id = $2 WHERE id = $1", [userId, entityId]);
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
    l: Pick<HeldLicense, "entity_id" | "region" | "regulator_id" | "license_id" | "registration_number" | "valid_from" | "valid_to">,
  ): Promise<HeldLicense> {
    // Re-registering resubmits for review.
    const r = await this.one(
      `INSERT INTO financial_products.held_licenses
         (id, entity_id, region, regulator_id, license_id, registration_number, valid_from, valid_to, status, submitted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
       ON CONFLICT (entity_id, region, regulator_id, license_id) DO UPDATE SET
         registration_number = EXCLUDED.registration_number, valid_from = EXCLUDED.valid_from, valid_to = EXCLUDED.valid_to,
         status = 'pending', submitted_by = EXCLUDED.submitted_by, reviewed_by = NULL, review_note = NULL, reviewed_at = NULL
       RETURNING *`,
      [randomUUID(), l.entity_id, l.region, l.regulator_id, l.license_id, l.registration_number, l.valid_from, l.valid_to, submittedBy],
    );
    return toHeldLicense(r!);
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
