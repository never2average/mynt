// The tables for app agreements and an app's target customers (app-agreements.ts), on their own so the store creates
// them without importing the tools.

const T = "financial_products";

export const APP_AGREEMENT_KINDS = ["program", "vendor", "data_sharing"] as const;
export const APP_AGREEMENT_STATUSES = ["proposed", "accepted", "signed", "declined", "terminated"] as const;

export const APP_AGREEMENT_TABLES = `
  -- A business agreement between an app's workspace (the developer side) and another firm on Mynt: a program agreement
  -- with a licence provider sponsoring products the app uses, a vendor contract, or a data-sharing agreement. Proposed
  -- by the app's owners or admins, accepted or declined by the other firm, signed by both (signed only once both have),
  -- and terminated by either side with a reason. Every change is audited.
  CREATE TABLE IF NOT EXISTS ${T}.app_agreements (
    id uuid PRIMARY KEY,
    workspace_id uuid,
    app_id uuid REFERENCES ${T}.apps(id),
    counterparty_entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    kind text NOT NULL CHECK (kind IN ('program', 'vendor', 'data_sharing')),
    status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'accepted', 'signed', 'declined', 'terminated')),
    products jsonb NOT NULL DEFAULT '[]',
    terms_summary text NOT NULL,
    document_url text,
    document_sha256 text,
    effective_from date,
    effective_to date,
    proposed_by uuid REFERENCES ${T}.users(id),
    proposed_at timestamptz NOT NULL DEFAULT now(),
    responded_by uuid REFERENCES ${T}.users(id),
    responded_at timestamptz,
    response_note text,
    app_signed_by uuid REFERENCES ${T}.users(id),
    app_signed_at timestamptz,
    counterparty_signed_by uuid REFERENCES ${T}.users(id),
    counterparty_signed_at timestamptz,
    terminated_by uuid REFERENCES ${T}.users(id),
    terminated_at timestamptz,
    termination_reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS app_agreements_app_idx ON ${T}.app_agreements (app_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS app_agreements_counterparty_idx ON ${T}.app_agreements (counterparty_entity_id, status);
  -- One open agreement of a kind per app and counterparty at a time.
  CREATE UNIQUE INDEX IF NOT EXISTS app_agreements_one_open_idx ON ${T}.app_agreements (app_id, counterparty_entity_id, kind) WHERE status IN ('proposed', 'accepted', 'signed');
  -- The customer segments (personas) an app targets, picked from its products' customer_segments.
  CREATE TABLE IF NOT EXISTS ${T}.app_target_segments (
    app_id uuid NOT NULL REFERENCES ${T}.apps(id),
    product_id text NOT NULL,
    segment_id text NOT NULL,
    chosen_by uuid REFERENCES ${T}.users(id),
    chosen_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, product_id, segment_id)
  );
`;
