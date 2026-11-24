// The risk register shared by apps and financial products (risk-register.ts), on its own so the store creates it
// without importing the tools.

const T = "financial_products";

// platform: Mynt's own register (subject_id "mynt"), kept and read by Mynt's admins only.
export const RISK_SUBJECTS = ["app", "product", "platform"] as const;
export const PLATFORM_SUBJECT_ID = "mynt";
export const RISK_CATEGORIES = ["security", "fraud", "vendor", "conduct", "operational", "compliance", "credit", "liquidity", "other"] as const;
export const RISK_STATUSES = ["open", "mitigating", "accepted", "closed"] as const;

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
`;
