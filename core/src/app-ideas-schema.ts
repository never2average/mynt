// The table for New app's ideas (app-ideas.ts), on its own so the store creates it without importing the checks.

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
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    sort integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    created_by uuid REFERENCES financial_products.users(id)
  );
  CREATE INDEX IF NOT EXISTS app_ideas_kind_idx ON financial_products.app_ideas (kind, status, sort);
`;
