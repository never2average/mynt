// The risk register shared by apps and financial products (risk-register.ts), on its own so the store creates it
// without importing the tools.

const T = "financial_products";

// platform: Mynt's own register (subject_id "mynt"), kept and read by Mynt's admins only.
export const RISK_SUBJECTS = ["app", "product", "platform"] as const;
export const PLATFORM_SUBJECT_ID = "mynt";
export const RISK_CATEGORIES = ["security", "fraud", "vendor", "conduct", "operational", "compliance", "credit", "liquidity", "other"] as const;
export const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;

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
`;
