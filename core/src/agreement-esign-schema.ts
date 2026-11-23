// The tables for licence providers' agreement templates and the e-signature of program agreements
// (agreement-esign.ts), on their own so the store creates them without importing the tools.

const T = "financial_products";

export const AGREEMENT_TEMPLATE_SOURCES = ["upload", "provider_template"] as const;
export const SIGNATURE_PLACEMENTS = ["signature_page", "text_tags"] as const;

export const AGREEMENT_ESIGN_TABLES = `
  -- A licence provider's program agreement, as its firm wants it signed: a file it uploaded (sealed under the vault
  -- key, with its SHA-256) or a template it keeps at the e-signature service. Attached to one of the firm's licences
  -- or sponsorships, or neither (the firm's default). Versions are immutable: uploading under the same name adds the
  -- next version and makes it the active one; retiring makes none active.
  CREATE TABLE IF NOT EXISTS ${T}.agreement_templates (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES ${T}.entities(id),
    licence_id uuid REFERENCES ${T}.held_licenses(id),
    sponsorship_id uuid REFERENCES ${T}.sponsorships(id),
    kind text NOT NULL DEFAULT 'program' CHECK (kind IN ('program')),
    name text NOT NULL,
    version integer NOT NULL CHECK (version > 0),
    source text NOT NULL CHECK (source IN ('upload', 'provider_template')),
    file_name text,
    file_type text CHECK (file_type IN ('pdf', 'docx')),
    file_size integer,
    file_sealed text,
    sha256 text,
    provider text,
    provider_template_id text,
    placeholders jsonb NOT NULL DEFAULT '{}',
    field_map jsonb NOT NULL DEFAULT '{}',
    signature_placement text NOT NULL DEFAULT 'signature_page' CHECK (signature_placement IN ('signature_page', 'text_tags')),
    notes text,
    active boolean NOT NULL DEFAULT true,
    created_by uuid REFERENCES ${T}.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    retired_by uuid REFERENCES ${T}.users(id),
    retired_at timestamptz,
    UNIQUE (entity_id, name, version),
    CHECK ((source = 'upload' AND file_sealed IS NOT NULL AND sha256 IS NOT NULL) OR (source = 'provider_template' AND provider_template_id IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS agreement_templates_entity_idx ON ${T}.agreement_templates (entity_id, active, created_at DESC);
  -- The e-signature document of a program agreement: which template (and version) it was made from, the service's
  -- document id, who signs for each side, and, once complete, the signed copy and the service's audit certificate,
  -- each sealed under the vault key with its SHA-256.
  CREATE TABLE IF NOT EXISTS ${T}.app_agreement_documents (
    agreement_id uuid PRIMARY KEY REFERENCES ${T}.app_agreements(id),
    template_id uuid REFERENCES ${T}.agreement_templates(id),
    template_version integer,
    template_sha256 text,
    schedule_sha256 text,
    provider text NOT NULL,
    provider_document_id text UNIQUE,
    test_mode boolean NOT NULL,
    status text NOT NULL DEFAULT 'creating',
    counterparty_signer_id uuid REFERENCES ${T}.users(id),
    app_signer_id uuid REFERENCES ${T}.users(id),
    counterparty_signed_at timestamptz,
    app_signed_at timestamptz,
    signed_sealed text,
    signed_sha256 text,
    signed_size integer,
    certificate_sealed text,
    certificate_sha256 text,
    certificate_size integer,
    completed_at timestamptz,
    last_synced_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Webhook events already handled, so a replayed delivery does nothing twice.
  CREATE TABLE IF NOT EXISTS ${T}.esign_webhook_events (
    provider text NOT NULL,
    event_id text NOT NULL,
    type text NOT NULL,
    document_id text,
    received_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, event_id)
  );
  ALTER TABLE ${T}.app_agreements ADD COLUMN IF NOT EXISTS signed_at timestamptz;
  -- Mynt's own secrets that admins set from Mynt Studio (the e-signature service's API key and webhook id,
  -- esign-settings.ts): one row per key, sealed under the vault key, never returned.
  CREATE TABLE IF NOT EXISTS ${T}.platform_secrets (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE,
    sealed text NOT NULL,
    set_by uuid REFERENCES ${T}.users(id),
    set_at timestamptz NOT NULL DEFAULT now()
  );
`;
