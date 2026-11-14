// The tables for app promotions (promotions.ts), on their own so the store creates them without importing the checks.
import { inTransaction, type Db } from "./db.js";
import { appStages } from "./workspaces.js";

const T = "financial_products";

export const PROMOTION_TABLES = `
  -- The stage someone last promoted or demoted the app to (none yet: Mynt derives it), the verified build it was
  -- promoted with and the checks it passed then.
  CREATE TABLE IF NOT EXISTS ${T}.app_promotions (
    app_id uuid PRIMARY KEY REFERENCES ${T}.apps(id),
    stage text NOT NULL CHECK (stage IN ('idea', 'staging', 'production')),
    build_id uuid,
    -- The US states (ISO 3166-2, lower case) the app serves: every product it uses must be covered in each.
    target_states text[] NOT NULL DEFAULT '{}',
    checks jsonb,
    updated_by uuid REFERENCES ${T}.users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- A Mynt admin's sign-off on a production promotion, for one verified build (its id and source hash).
  CREATE TABLE IF NOT EXISTS ${T}.promotion_signoffs (
    id uuid PRIMARY KEY,
    app_id uuid NOT NULL REFERENCES ${T}.apps(id),
    workspace_id uuid,
    build_id uuid NOT NULL,
    source_sha256 text,
    commit_sha text,
    status text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'superseded')),
    reasons jsonb NOT NULL DEFAULT '[]',
    requested_by uuid REFERENCES ${T}.users(id),
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by uuid REFERENCES ${T}.users(id),
    decided_at timestamptz,
    note text
  );
  CREATE UNIQUE INDEX IF NOT EXISTS promotion_signoffs_open_idx ON ${T}.promotion_signoffs (app_id) WHERE status = 'requested';
  CREATE INDEX IF NOT EXISTS promotion_signoffs_app_idx ON ${T}.promotion_signoffs (app_id, requested_at DESC);
  CREATE INDEX IF NOT EXISTS promotion_signoffs_status_idx ON ${T}.promotion_signoffs (status, requested_at DESC);
  -- When the apps already there were given their stage (seedAppStages): one row, once.
  CREATE TABLE IF NOT EXISTS ${T}.app_promotions_seeded (
    done boolean PRIMARY KEY CHECK (done),
    at timestamptz NOT NULL DEFAULT now(),
    apps integer NOT NULL DEFAULT 0
  );
`;

// Once, when promotions arrive: every app already there keeps the stage Mynt derived for it (appStages), so nothing
// moves folder. From then on an app's stage changes only by promote_app and demote_app, and a new app starts as an
// idea. One server at a time (an advisory lock); the marker row makes it run once.
export async function seedAppStages(db: Db): Promise<number> {
  if ((await db.query(`SELECT 1 FROM ${T}.app_promotions_seeded`)).rows.length) return 0;
  const apps = (await db.query(`SELECT id::text AS id, status FROM ${T}.apps`)).rows as { id: string; status: "draft" | "published" }[];
  const stages = await appStages(db, apps); // tells a missing optional table by its error: outside the transaction
  return inTransaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('mynt.app_stages_seeded'))");
    if ((await tx.query(`SELECT 1 FROM ${T}.app_promotions_seeded`)).rows.length) return 0;
    let n = 0;
    for (const a of apps) {
      const stage = stages.get(a.id) ?? "idea";
      if (stage === "idea") continue;
      n += (await tx.query(`INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, $2) ON CONFLICT (app_id) DO NOTHING RETURNING app_id`, [a.id, stage])).rows.length;
    }
    await tx.query(`INSERT INTO ${T}.app_promotions_seeded (done, apps) VALUES (true, $1)`, [n]);
    return n;
  });
}
