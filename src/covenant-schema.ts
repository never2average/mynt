// The covenants' tables (see covenants.ts), in a file of its own because the drift check reads them, and so the store
// creates them, on every Mynt, whether or not the covenant timer runs. Additive: nothing here changes an existing table.
export const COVENANT_TABLES = `
  -- A licence provider's rules for one sponsorship. The status columns are the evaluator's; the rest is the sponsor's.
  CREATE TABLE IF NOT EXISTS financial_products.covenants (
    id uuid PRIMARY KEY,
    sponsorship_id uuid NOT NULL REFERENCES financial_products.sponsorships(id),
    product_id text NOT NULL,
    provider_entity_id uuid NOT NULL,
    rule_type text NOT NULL,
    threshold bigint NOT NULL,
    action text NOT NULL CHECK (action IN ('alert', 'pause')),
    severity text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    cooldown_seconds integer NOT NULL,
    unknown_limit_seconds integer NOT NULL,
    version integer NOT NULL DEFAULT 1,
    created_by uuid,
    updated_by uuid,
    created_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL,
    deleted_at timestamptz,
    status text NOT NULL DEFAULT 'unevaluated' CHECK (status IN ('unevaluated', 'pass', 'fail', 'unknown')),
    status_reason text,
    status_since timestamptz,
    last_evaluated_at timestamptz,
    last_epoch integer,
    last_sequence integer,
    last_version integer,
    last_alert_at timestamptz,
    open_breach_id uuid,
    open_unknown_breach_id uuid
  );
  CREATE INDEX IF NOT EXISTS covenants_sponsorship_idx ON financial_products.covenants (sponsorship_id) WHERE deleted_at IS NULL;
  CREATE INDEX IF NOT EXISTS covenants_product_idx ON financial_products.covenants (product_id) WHERE deleted_at IS NULL;
  -- Every breach as it was when it happened. Never changed: what happens next is a row in covenant_breach_events.
  CREATE TABLE IF NOT EXISTS financial_products.covenant_breaches (
    id uuid PRIMARY KEY,
    covenant_id uuid NOT NULL REFERENCES financial_products.covenants(id),
    sponsorship_id uuid NOT NULL,
    product_id text NOT NULL,
    provider_entity_id uuid NOT NULL,
    rule_type text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('breach', 'unknown_limit')),
    severity text NOT NULL,
    action text NOT NULL,
    action_taken text NOT NULL,
    alerted boolean NOT NULL,
    sandbox boolean NOT NULL,
    threshold bigint NOT NULL,
    unit text NOT NULL,
    observed_value bigint, -- durations and counts of periods, which aren't the firm's books
    observed_sealed text, -- a figure from the sealed report (reserves, coverage, flows), sealed as the report is
    snapshot_epoch integer,
    snapshot_sequence integer,
    snapshot_fingerprint text,
    reason text,
    in_flight jsonb, -- what was in flight when a pause took effect: reported, never cancelled
    opened_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covenant_breaches_product_idx ON financial_products.covenant_breaches (product_id, opened_at DESC);
  CREATE INDEX IF NOT EXISTS covenant_breaches_provider_idx ON financial_products.covenant_breaches (provider_entity_id, opened_at DESC);
  CREATE TABLE IF NOT EXISTS financial_products.covenant_breach_events (
    id uuid PRIMARY KEY,
    breach_id uuid NOT NULL REFERENCES financial_products.covenant_breaches(id),
    event text NOT NULL,
    actor_id uuid,
    reason text,
    details jsonb NOT NULL DEFAULT '{}',
    at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS covenant_breach_events_idx ON financial_products.covenant_breach_events (breach_id, at);
  -- A covenant's hold on a product: the drift check reads it, and it lasts until the sponsor releases it.
  CREATE TABLE IF NOT EXISTS financial_products.covenant_holds (
    id uuid PRIMARY KEY,
    breach_id uuid NOT NULL UNIQUE REFERENCES financial_products.covenant_breaches(id),
    covenant_id uuid NOT NULL REFERENCES financial_products.covenants(id),
    sponsorship_id uuid NOT NULL REFERENCES financial_products.sponsorships(id),
    product_id text NOT NULL,
    provider_entity_id uuid NOT NULL,
    rule_type text NOT NULL,
    paused_at timestamptz NOT NULL,
    released_at timestamptz,
    released_by uuid,
    release_reason text,
    override boolean NOT NULL DEFAULT false
  );
  CREATE INDEX IF NOT EXISTS covenant_holds_product_idx ON financial_products.covenant_holds (product_id) WHERE released_at IS NULL;
  CREATE OR REPLACE FUNCTION financial_products.covenant_breaches_are_append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
  BEGIN
    RAISE EXCEPTION 'The covenant breach record is append-only';
  END $fn$;
  DROP TRIGGER IF EXISTS covenant_breaches_append_only ON financial_products.covenant_breaches;
  CREATE TRIGGER covenant_breaches_append_only BEFORE UPDATE OR DELETE ON financial_products.covenant_breaches
    FOR EACH ROW EXECUTE FUNCTION financial_products.covenant_breaches_are_append_only();
  DROP TRIGGER IF EXISTS covenant_breaches_no_truncate ON financial_products.covenant_breaches;
  CREATE TRIGGER covenant_breaches_no_truncate BEFORE TRUNCATE ON financial_products.covenant_breaches
    FOR EACH STATEMENT EXECUTE FUNCTION financial_products.covenant_breaches_are_append_only();
  DROP TRIGGER IF EXISTS covenant_breach_events_append_only ON financial_products.covenant_breach_events;
  CREATE TRIGGER covenant_breach_events_append_only BEFORE UPDATE OR DELETE ON financial_products.covenant_breach_events
    FOR EACH ROW EXECUTE FUNCTION financial_products.covenant_breaches_are_append_only();
  DROP TRIGGER IF EXISTS covenant_breach_events_no_truncate ON financial_products.covenant_breach_events;
  CREATE TRIGGER covenant_breach_events_no_truncate BEFORE TRUNCATE ON financial_products.covenant_breach_events
    FOR EACH STATEMENT EXECUTE FUNCTION financial_products.covenant_breaches_are_append_only();
`;
