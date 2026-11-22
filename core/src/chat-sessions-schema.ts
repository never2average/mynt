// The tables for the studio's chat sessions (chat-sessions.ts), on their own so the store creates them without
// importing the tools.

export const CHAT_SESSION_TABLES = `
  -- One chat a signed-in user had in the studio (a financial-product chat, an Earn chat; later an app's build
  -- conversation), every kind in the same shape. What was said is not here: it is the session's events.
  CREATE TABLE IF NOT EXISTS financial_products.chat_sessions (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES financial_products.users(id) ON DELETE CASCADE,
    workspace_id uuid,
    kind text NOT NULL CHECK (kind ~ '^[a-z][a-z_]{1,30}$'),
    title text NOT NULL DEFAULT '',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_seq bigint NOT NULL DEFAULT 0,
    bytes bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS chat_sessions_user_kind_idx ON financial_products.chat_sessions (user_id, kind, updated_at DESC);
  -- A session's append-only log, like a coding agent's session file: one row per message or state change, numbered
  -- 1, 2, 3 ... with no gaps. Rows are never changed; reading a session is replaying them in order.
  CREATE TABLE IF NOT EXISTS financial_products.chat_events (
    session_id uuid NOT NULL REFERENCES financial_products.chat_sessions(id) ON DELETE CASCADE,
    seq bigint NOT NULL,
    type text NOT NULL,
    role text,
    client_id text,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, seq)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS chat_events_client_idx ON financial_products.chat_events (session_id, client_id) WHERE client_id IS NOT NULL;
`;
