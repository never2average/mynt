// The risk register shared by apps and financial products (risk-register.ts), on its own so the store creates it
// without importing the tools.

const T = "financial_products";

// platform: Mynt's own register (subject_id "mynt"), kept and read by Mynt's admins only.
export const RISK_SUBJECTS = ["app", "product", "platform"] as const;
export const PLATFORM_SUBJECT_ID = "mynt";
export const RISK_CATEGORIES = ["security", "fraud", "vendor", "conduct", "operational", "compliance", "credit", "liquidity", "other"] as const;
export const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;
// The three-step scoring chain (risk-grading.ts): likelihood × impact is the inherent score; how well the controls work
// (four steps) takes it down to the residual score, graded into the platform's levels.
export const RISK_LEVEL_KEYS = ["low", "medium", "high", "critical"] as const;
export const CONTROL_STEPS = ["none", "weak", "partial", "strong"] as const;
export const RISK_FACTOR_KINDS = ["impact", "likelihood", "control"] as const;
export const TREATMENT_STATUSES = ["todo", "doing", "done", "dropped"] as const;
export const TREATMENT_EFFECTIVENESS = ["not_assessed", "ineffective", "partly_effective", "effective"] as const;
export const CONTROL_KINDS = ["preventive", "detective", "corrective"] as const;
export const CONTROL_TEST_RESULTS = ["passed", "gaps_found", "failed"] as const;
export const RISK_LINK_TARGETS = ["app", "product", "vendor_offering", "agreement", "agreement_audit", "audit_entry", "risk_model", "firm"] as const;

// The platform's risk areas: the seven tabs the platform admin's Risk models and Risk register are laid out in. Every
// risk on a register may carry one (risk_area; required on Mynt's own register), and every risk model has one.
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
// The area a risk's fine-grained category falls under when none is given, and how rows made before risk areas were
// backfilled. "other" has none: such a risk stays unassigned until someone gives it an area.
export const RISK_AREA_OF_CATEGORY: Record<(typeof RISK_CATEGORIES)[number], RiskArea | null> = {
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
const sqlList = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(", ");
const AREA_CASE = `CASE category ${Object.entries(RISK_AREA_OF_CATEGORY)
  .filter(([, a]) => a)
  .map(([c, a]) => `WHEN '${c}' THEN '${a}'`)
  .join(" ")} END`;

export const RISK_REGISTER_TABLES = `
  -- One risk on an app's or a financial product's register: what could go wrong, how likely (1-5) and how bad (1-5),
  -- who owns it, what's being done about it, where it stands and when it's next reviewed. Kept by the app's workspace
  -- owners and admins, or the product's own firm; a licence provider sponsoring the product reads it. Mynt's own
  -- register (subject_type 'platform', subject_id 'mynt') is kept and read by Mynt's admins only. Every change is
  -- audited (its history is the audit trail).
  CREATE TABLE IF NOT EXISTS ${T}.risk_register (
    id uuid PRIMARY KEY,
    subject_type text NOT NULL CHECK (subject_type IN ('app', 'product', 'platform')),
    subject_id text NOT NULL,
    title text NOT NULL,
    category text NOT NULL CHECK (category IN ('security', 'fraud', 'vendor', 'conduct', 'operational', 'compliance', 'credit', 'liquidity', 'other')),
    description text,
    likelihood smallint NOT NULL CHECK (likelihood BETWEEN 1 AND 5),
    impact smallint NOT NULL CHECK (impact BETWEEN 1 AND 5),
    owner_user_id uuid REFERENCES ${T}.users(id),
    mitigation text,
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'mitigating', 'accepted', 'closed')),
    review_by date,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS risk_register_subject_idx ON ${T}.risk_register (subject_type, subject_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS risk_register_review_idx ON ${T}.risk_register (review_by) WHERE status <> 'closed';
  -- A register made before the platform's own: its subject check widened to take it.
  ALTER TABLE ${T}.risk_register DROP CONSTRAINT IF EXISTS risk_register_subject_type_check;
  ALTER TABLE ${T}.risk_register ADD CONSTRAINT risk_register_subject_type_check CHECK (subject_type IN ('app', 'product', 'platform'));
  -- The platform's risk area (one of seven; null: unassigned). A row made before it gets its category's area, once (a
  -- row whose category is other stays unassigned); running this again changes nothing.
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS risk_area text CHECK (risk_area IN (${sqlList(RISK_AREAS)}));
  UPDATE ${T}.risk_register SET risk_area = ${AREA_CASE} WHERE risk_area IS NULL AND category <> 'other';
  CREATE INDEX IF NOT EXISTS risk_register_area_idx ON ${T}.risk_register (risk_area) WHERE status <> 'closed';

  -- Three-step scoring. How well the risk's controls work (none, weak, partial, strong; null: not assessed) and why;
  -- the residual score the platform's grading derives from the inherent score and that step (risk-grading.ts; null
  -- until the control is assessed: the residual is the inherent score until then); and a keeper's own residual
  -- likelihood and impact in its place (an override: who, when and why are kept).
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS control_effectiveness text CHECK (control_effectiveness IN (${sqlList(CONTROL_STEPS)}));
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS control_note text;
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS residual_likelihood smallint CHECK (residual_likelihood BETWEEN 1 AND 5);
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS residual_impact smallint CHECK (residual_impact BETWEEN 1 AND 5);
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS residual_score smallint CHECK (residual_score BETWEEN 1 AND 25);
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS residual_overridden_by uuid REFERENCES ${T}.users(id);
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS residual_overridden_at timestamptz;
  ALTER TABLE ${T}.risk_register ADD COLUMN IF NOT EXISTS residual_override_reason text;
  -- What explains each of a risk's three scores: impact factors, likelihood factors and control factors, each scored
  -- 1-5 with its rationale and where it comes from (an https link, or type:id of something on Mynt).
  CREATE TABLE IF NOT EXISTS ${T}.risk_factors (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES ${T}.risk_register(id),
    kind text NOT NULL CHECK (kind IN (${sqlList(RISK_FACTOR_KINDS)})),
    name text NOT NULL,
    score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
    rationale text,
    source text,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS risk_factors_risk_idx ON ${T}.risk_factors (risk_id, kind, created_at);
  -- Treatment tasks: the work that brings a risk down, each with an owner, a due date, where it stands, a progress
  -- note and, once done, whether it worked.
  CREATE TABLE IF NOT EXISTS ${T}.risk_treatments (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES ${T}.risk_register(id),
    title text NOT NULL,
    owner_user_id uuid REFERENCES ${T}.users(id),
    due date,
    status text NOT NULL DEFAULT 'todo' CHECK (status IN (${sqlList(TREATMENT_STATUSES)})),
    progress_note text,
    effectiveness text NOT NULL DEFAULT 'not_assessed' CHECK (effectiveness IN (${sqlList(TREATMENT_EFFECTIVENESS)})),
    effectiveness_note text,
    done_at timestamptz,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS risk_treatments_risk_idx ON ${T}.risk_treatments (risk_id, created_at);
  -- The controls that keep a risk down: what each does, its kind, when it was last tested and how that went. One made
  -- from a finished treatment task names it. A retired control stays listed.
  CREATE TABLE IF NOT EXISTS ${T}.risk_controls (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES ${T}.risk_register(id),
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN (${sqlList(CONTROL_KINDS)})),
    description text,
    last_tested_at date,
    test_result text CHECK (test_result IN (${sqlList(CONTROL_TEST_RESULTS)})),
    source_treatment_id uuid REFERENCES ${T}.risk_treatments(id),
    retired_at timestamptz,
    retired_by uuid REFERENCES ${T}.users(id),
    retire_reason text,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS risk_controls_risk_idx ON ${T}.risk_controls (risk_id, created_at);
  -- What a risk is about: an app, a product, a vendor's offering, an agreement, an oversight audit, an audit-trail
  -- entry, one of Mynt's risk models or a firm. target_id is that thing's id as text.
  CREATE TABLE IF NOT EXISTS ${T}.risk_links (
    id uuid PRIMARY KEY,
    risk_id uuid NOT NULL REFERENCES ${T}.risk_register(id),
    target_type text NOT NULL CHECK (target_type IN (${sqlList(RISK_LINK_TARGETS)})),
    target_id text NOT NULL,
    note text,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (risk_id, target_type, target_id)
  );
  CREATE INDEX IF NOT EXISTS risk_links_target_idx ON ${T}.risk_links (target_type, target_id);
  -- Every version of the platform's risk grading (the risk_grading setting holds the current one): level names, the
  -- score bands, and how the residual score is derived. Kept for good; restoring one adds a new version.
  CREATE TABLE IF NOT EXISTS ${T}.risk_grading_versions (
    version integer PRIMARY KEY,
    grading jsonb NOT NULL,
    note text,
    restored_from integer,
    residuals_changed integer,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;
