// The tables for service-level commitments under app agreements (agreement-slas.ts), on their own so the store creates
// them without importing the tools. An app agreement (app-agreements-schema.ts) has many SLAs, and each SLA many
// recorded breaches over time.

const T = "financial_products";

export const SLA_WINDOWS = ["daily", "weekly", "monthly", "quarterly"] as const;
export const SLA_STATUSES = ["active", "retired"] as const;

export const AGREEMENT_SLA_TABLES = `
  -- A service level the licence provider sponsoring the app's products sets on a program agreement: the metric, its
  -- target (and unit), the window it's measured over, where the measurement comes from and the remedy when it's missed.
  -- Retired, never deleted.
  CREATE TABLE IF NOT EXISTS ${T}.agreement_slas (
    id uuid PRIMARY KEY,
    agreement_id uuid NOT NULL REFERENCES ${T}.app_agreements(id),
    metric text NOT NULL,
    target text NOT NULL,
    target_value numeric,
    unit text,
    measurement_window text NOT NULL CHECK (measurement_window IN ('daily', 'weekly', 'monthly', 'quarterly')),
    measurement_source text NOT NULL,
    remedy text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_by uuid REFERENCES ${T}.users(id),
    retired_at timestamptz,
    retire_reason text
  );
  CREATE INDEX IF NOT EXISTS agreement_slas_agreement_idx ON ${T}.agreement_slas (agreement_id);
  -- A missed service level in one measurement period, recorded by either party; open until either resolves it.
  CREATE TABLE IF NOT EXISTS ${T}.agreement_sla_breaches (
    id uuid PRIMARY KEY,
    sla_id uuid NOT NULL REFERENCES ${T}.agreement_slas(id),
    agreement_id uuid NOT NULL REFERENCES ${T}.app_agreements(id),
    period_start date NOT NULL,
    period_end date NOT NULL CHECK (period_end >= period_start),
    measured_value text NOT NULL,
    recorded_by uuid REFERENCES ${T}.users(id),
    recorded_side text NOT NULL CHECK (recorded_side IN ('app', 'counterparty')),
    note text,
    created_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    resolved_by uuid REFERENCES ${T}.users(id),
    resolution_note text
  );
  CREATE INDEX IF NOT EXISTS agreement_sla_breaches_sla_idx ON ${T}.agreement_sla_breaches (sla_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS agreement_sla_breaches_open_idx ON ${T}.agreement_sla_breaches (agreement_id) WHERE resolved_at IS NULL;
`;
