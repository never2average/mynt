// Mynt's own risk models (risk-models.ts), on their own so the store creates them without importing the tools.
import { RISK_AREAS } from "./risk-register-schema.js";

const T = "financial_products";
const areas = RISK_AREAS.map((a) => `'${a}'`).join(", ");

export const RISK_MODEL_STATUSES = ["draft", "active", "retired"] as const;
export const RISK_MODEL_OUTCOMES = ["passed", "passed_with_findings", "failed"] as const;

export const RISK_MODEL_TABLES = `
  -- A risk model Mynt runs the platform with, in one of the platform's seven risk areas: who owns it, where it stands
  -- (draft, active, retired), and its validation (the last one, and when the next is due). What it is (name, purpose,
  -- method, inputs, outputs, thresholds) is in risk_model_versions: editing a model adds a version, never changes one.
  -- Kept and read by Mynt's admins only; every change is audited.
  CREATE TABLE IF NOT EXISTS ${T}.risk_models (
    id uuid PRIMARY KEY,
    risk_area text NOT NULL CHECK (risk_area IN (${areas})),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
    version integer NOT NULL DEFAULT 1,
    owner_user_id uuid REFERENCES ${T}.users(id),
    last_validated_at timestamptz,
    validated_by uuid REFERENCES ${T}.users(id),
    validation_outcome text CHECK (validation_outcome IN ('passed', 'passed_with_findings', 'failed')),
    validation_notes text,
    next_validation_due date,
    retired_at timestamptz,
    retired_by uuid REFERENCES ${T}.users(id),
    retire_reason text,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS risk_models_area_idx ON ${T}.risk_models (risk_area, status);
  CREATE INDEX IF NOT EXISTS risk_models_due_idx ON ${T}.risk_models (next_validation_due) WHERE status <> 'retired';
  -- Each version of a model's definition, immutable: inputs, outputs and thresholds are JSON lists.
  CREATE TABLE IF NOT EXISTS ${T}.risk_model_versions (
    model_id uuid NOT NULL REFERENCES ${T}.risk_models(id),
    version integer NOT NULL,
    name text NOT NULL,
    purpose text NOT NULL,
    method text NOT NULL,
    inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
    outputs jsonb NOT NULL DEFAULT '[]'::jsonb,
    thresholds jsonb NOT NULL DEFAULT '[]'::jsonb,
    change_note text,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (model_id, version)
  );
  -- Every validation recorded, of the version current at the time.
  CREATE TABLE IF NOT EXISTS ${T}.risk_model_validations (
    id uuid PRIMARY KEY,
    model_id uuid NOT NULL REFERENCES ${T}.risk_models(id),
    version integer NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('passed', 'passed_with_findings', 'failed')),
    notes text NOT NULL,
    next_validation_due date NOT NULL,
    validated_by uuid REFERENCES ${T}.users(id),
    validated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS risk_model_validations_model_idx ON ${T}.risk_model_validations (model_id, validated_at DESC);
`;
