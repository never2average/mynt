// The tables for the Build page's ideas: app ideas (app-ideas.ts) and financial product ideas (product-ideas.ts), on
// their own so the store creates them without importing the checks.

export const APP_IDEA_TABLES = `
  -- Specific app ideas on an app kind, offered on New app as chips and Templates rows. Admins keep them
  -- (create_app_idea, update_app_idea, retire_app_idea); seed_app_ideas adds the shipped ones, only when asked.
  CREATE TABLE IF NOT EXISTS financial_products.app_ideas (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
    kind text NOT NULL,
    problem text NOT NULL,
    pitch text NOT NULL,
    goal text NOT NULL,
    product_lines text[] NOT NULL,
    categories text[] NOT NULL DEFAULT '{}',
    product_names text[] NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    sort integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES financial_products.users(id)
  );
  -- The product categories in its lines an idea is for, and words from the products' names (added after the
  -- table: existing rows have none).
  ALTER TABLE financial_products.app_ideas ADD COLUMN IF NOT EXISTS categories text[] NOT NULL DEFAULT '{}';
  ALTER TABLE financial_products.app_ideas ADD COLUMN IF NOT EXISTS product_names text[] NOT NULL DEFAULT '{}';
  -- The chip's short label on the Build page (1 to 34 characters; the problem is its tooltip). Added after the
  -- table: existing rows have none until an admin fills it (seed_app_ideas with labels_only, or update_app_idea).
  ALTER TABLE financial_products.app_ideas ADD COLUMN IF NOT EXISTS chip_label text;
  CREATE INDEX IF NOT EXISTS app_ideas_kind_idx ON financial_products.app_ideas (kind, status, sort);

  -- Ideas for new financial products a licensed firm could define, offered in the Build page's Financial product
  -- mode. Admins keep them (create_product_idea, update_product_idea, retire_product_idea); seed_product_ideas adds
  -- the shipped ones, only when asked. Apart from app_ideas: different fields and different checks.
  CREATE TABLE IF NOT EXISTS financial_products.product_ideas (
    id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
    label text NOT NULL,
    product_name text NOT NULL,
    summary text NOT NULL,
    product_line text NOT NULL,
    category text NOT NULL,
    region text NOT NULL,
    key_features text[] NOT NULL DEFAULT '{}',
    risk_level text,
    liquidity text,
    typical_horizon text,
    return_type text,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    sort integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES financial_products.users(id)
  );
  -- The chip's short label (1 to 34 characters; the product name and label are its tooltip). Added after the
  -- table: existing rows have none until an admin fills it (seed_product_ideas with labels_only, or update_product_idea).
  ALTER TABLE financial_products.product_ideas ADD COLUMN IF NOT EXISTS chip_label text;
  CREATE INDEX IF NOT EXISTS product_ideas_line_idx ON financial_products.product_ideas (product_line, status, sort);
`;
