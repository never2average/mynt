// The tables for agreements' oversight audits (agreement-audits.ts), on their own so the store creates them without
// importing the tools. An app agreement (app-agreements-schema.ts) has many audit requirements, and each requirement
// many audits over time (one open at a time).

const T = "financial_products";

export const AUDIT_REQUIREMENT_KINDS = ["compliance_review", "complaints_review", "marketing_review", "security_review", "financial_review", "other"] as const;
export const AUDIT_CADENCES = ["once", "monthly", "quarterly", "annual", "on_change"] as const;
export const AGREEMENT_AUDIT_STATUSES = ["scheduled", "in_progress", "submitted", "passed", "failed", "waived"] as const;
export const OPEN_AUDIT_STATUSES = ["scheduled", "in_progress", "submitted"] as const;
export const CLOSED_AUDIT_STATUSES = ["passed", "failed", "waived"] as const;
export const FINDING_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const AGREEMENT_AUDIT_TABLES = `
  -- An oversight audit the counterparty (the licence provider sponsoring the app's products) runs on an app under an
  -- agreement: an annual compliance review, a quarterly complaints review, a review of marketing material on each
  -- change. Defined by the counterparty's members; retired, never deleted.
  CREATE TABLE IF NOT EXISTS ${T}.agreement_audit_requirements (
    id uuid PRIMARY KEY,
    agreement_id uuid NOT NULL REFERENCES ${T}.app_agreements(id),
    name text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('compliance_review', 'complaints_review', 'marketing_review', 'security_review', 'financial_review', 'other')),
    cadence text NOT NULL CHECK (cadence IN ('once', 'monthly', 'quarterly', 'annual', 'on_change')),
    first_due date,
    description text,
    evidence_required text,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_by uuid REFERENCES ${T}.users(id),
    retired_at timestamptz,
    retire_reason text
  );
  CREATE INDEX IF NOT EXISTS agreement_audit_requirements_agreement_idx ON ${T}.agreement_audit_requirements (agreement_id);
  -- Each audit of a requirement: due, opened, evidence submitted by the app's side, findings recorded by the
  -- counterparty, then passed, failed or waived. findings: [{id, severity, title, detail, status, ...}];
  -- evidence: [{id, name, url (https), sha256, ...}].
  CREATE TABLE IF NOT EXISTS ${T}.agreement_audits (
    id uuid PRIMARY KEY,
    requirement_id uuid NOT NULL REFERENCES ${T}.agreement_audit_requirements(id),
    agreement_id uuid NOT NULL REFERENCES ${T}.app_agreements(id),
    app_id uuid REFERENCES ${T}.apps(id),
    due_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'submitted', 'passed', 'failed', 'waived')),
    trigger text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule', 'manual', 'build')),
    build_id uuid,
    opened_by uuid REFERENCES ${T}.users(id),
    opened_at timestamptz,
    submitted_by uuid REFERENCES ${T}.users(id),
    submitted_at timestamptz,
    closed_by uuid REFERENCES ${T}.users(id),
    closed_at timestamptz,
    outcome_note text,
    reviewer uuid REFERENCES ${T}.users(id),
    findings jsonb NOT NULL DEFAULT '[]',
    evidence jsonb NOT NULL DEFAULT '[]',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS agreement_audits_agreement_idx ON ${T}.agreement_audits (agreement_id, due_at);
  CREATE INDEX IF NOT EXISTS agreement_audits_app_idx ON ${T}.agreement_audits (app_id, due_at);
  -- One audit open per requirement at a time.
  CREATE UNIQUE INDEX IF NOT EXISTS agreement_audits_one_open_idx ON ${T}.agreement_audits (requirement_id) WHERE status IN ('scheduled', 'in_progress', 'submitted');
`;
