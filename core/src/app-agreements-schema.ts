// The tables for app agreements and an app's target customers (app-agreements.ts), on their own so the store creates
// them without importing the tools.

const T = "financial_products";

export const APP_AGREEMENT_KINDS = ["program", "vendor", "data_sharing", "msa", "sla"] as const;
export const AGREEMENT_SIDES = ["app", "counterparty"] as const;
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
  -- A vendor's standard terms, from the vendor marketplace (vendor-terms.ts): an agreement made by click-through when the
  -- app's workspace subscribes to a listed offering. It names the subscription it came with and the version of the
  -- vendor's terms accepted (document_url, document_sha256 and terms_summary are that version's), and ends with it.
  ALTER TABLE ${T}.app_agreements ADD COLUMN IF NOT EXISTS vendor_subscription_id uuid REFERENCES ${T}.vendor_subscriptions(id);
  ALTER TABLE ${T}.app_agreements ADD COLUMN IF NOT EXISTS offering_id uuid REFERENCES ${T}.vendor_offerings(id);
  ALTER TABLE ${T}.app_agreements ADD COLUMN IF NOT EXISTS terms_version integer;
  ALTER TABLE ${T}.app_agreements ADD COLUMN IF NOT EXISTS pricing_summary text;
  -- One open negotiated agreement of a kind per app and counterparty at a time; one open click-through agreement per app
  -- and subscription (a vendor with several offerings has one per subscription).
  DROP INDEX IF EXISTS ${T}.app_agreements_one_open_idx;
  CREATE UNIQUE INDEX IF NOT EXISTS app_agreements_one_open_negotiated_idx ON ${T}.app_agreements (app_id, counterparty_entity_id, kind) WHERE status IN ('proposed', 'accepted', 'signed') AND vendor_subscription_id IS NULL;
  -- Master services agreements (msa) and service-level agreements (sla) join the kinds, each for one app like the
  -- others, and either side proposes any agreement (proposed_by_side); the other side answers it.
  ALTER TABLE ${T}.app_agreements DROP CONSTRAINT IF EXISTS app_agreements_kind_check;
  ALTER TABLE ${T}.app_agreements ADD CONSTRAINT app_agreements_kind_check CHECK (kind IN ('program', 'vendor', 'data_sharing', 'msa', 'sla'));
  ALTER TABLE ${T}.app_agreements ADD COLUMN IF NOT EXISTS proposed_by_side text NOT NULL DEFAULT 'app';
  ALTER TABLE ${T}.app_agreements DROP CONSTRAINT IF EXISTS app_agreements_proposed_by_side_check;
  ALTER TABLE ${T}.app_agreements ADD CONSTRAINT app_agreements_proposed_by_side_check CHECK (proposed_by_side IN ('app', 'counterparty'));
  ALTER TABLE ${T}.app_agreements DROP CONSTRAINT IF EXISTS app_agreements_scope_check;
  -- Every new agreement names its app (NOT VALID: rows from before apps were required stay as they are).
  ALTER TABLE ${T}.app_agreements ADD CONSTRAINT app_agreements_scope_check CHECK (app_id IS NOT NULL) NOT VALID;
  DROP INDEX IF EXISTS ${T}.app_agreements_one_open_workspace_idx;
  CREATE UNIQUE INDEX IF NOT EXISTS app_agreements_one_open_subscription_idx ON ${T}.app_agreements (app_id, vendor_subscription_id) WHERE status IN ('proposed', 'accepted', 'signed') AND vendor_subscription_id IS NOT NULL;
  -- A vendor's standard terms on each offering (vendor-terms.ts): the document (https) and its SHA-256, a short summary,
  -- the pricing (billed by the vendor directly, never through Mynt) and a version that goes up when any of them changes.
  -- Listing an offering with terms is the vendor's standing acceptance of them; who set them and when is kept.
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS terms_version integer;
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS terms_document_url text;
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS terms_document_sha256 text;
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS terms_summary text;
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS pricing_summary text;
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS terms_set_by uuid REFERENCES ${T}.users(id);
  ALTER TABLE ${T}.vendor_offerings ADD COLUMN IF NOT EXISTS terms_set_at timestamptz;
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
