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
  -- What a promotion was for: the verified build's source, and the build its hosting ran.
  ALTER TABLE ${T}.app_promotions ADD COLUMN IF NOT EXISTS source_sha256 text;
  ALTER TABLE ${T}.app_promotions ADD COLUMN IF NOT EXISTS hosted_build_id uuid;
  -- What made the sign-off necessary (programs beyond devnet, a build carrying programs, approved money rails): an
  -- approval holds only while it stays the same.
  ALTER TABLE ${T}.promotion_signoffs ADD COLUMN IF NOT EXISTS basis jsonb;
  CREATE UNIQUE INDEX IF NOT EXISTS promotion_signoffs_open_idx ON ${T}.promotion_signoffs (app_id) WHERE status = 'requested';
  CREATE INDEX IF NOT EXISTS promotion_signoffs_app_idx ON ${T}.promotion_signoffs (app_id, requested_at DESC);
  CREATE INDEX IF NOT EXISTS promotion_signoffs_status_idx ON ${T}.promotion_signoffs (status, requested_at DESC);
  -- When apps already live (live keys, published, real customers) were put in production (grandfatherLiveApps): once.
  CREATE TABLE IF NOT EXISTS ${T}.app_live_grandfathered (
    done boolean PRIMARY KEY CHECK (done),
    at timestamptz NOT NULL DEFAULT now(),
    apps integer NOT NULL DEFAULT 0
  );
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

// ---- production gates real money ----

// Live keys, live runtime calls (real customers, real money) and publishing are for production apps only: ideas and
// staging run on sandbox keys.
export const NOT_PRODUCTION = "Promote this app to Production first (get_promotion_checks, promote_app); until then it runs on sandbox keys only";

type Q = Pick<Db, "query">;
export async function isProduction(q: Q, appId: string): Promise<boolean> {
  return (await q.query(`SELECT 1 FROM ${T}.app_promotions WHERE app_id::text = $1 AND stage = 'production'`, [appId])).rows.length > 0;
}

// Once, when the gate arrives, so nothing live breaks: an app with an active live key, published, or with real
// (non-sandbox) customers' sessions or hand-offs goes to production, recorded in the audit trail with why.
export async function grandfatherLiveApps(db: Db): Promise<number> {
  if ((await db.query(`SELECT 1 FROM ${T}.app_live_grandfathered`)).rows.length) return 0;
  return inTransaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('mynt.app_live_grandfathered'))");
    if ((await tx.query(`SELECT 1 FROM ${T}.app_live_grandfathered`)).rows.length) return 0;
    const live = (
      await tx.query(
        `SELECT a.id::text AS id, p.stage,
           EXISTS (SELECT 1 FROM ${T}.api_keys k WHERE k.app_id = a.id AND k.environment = 'live' AND k.status = 'active') AS live_key,
           a.status = 'published' AS published,
           (EXISTS (SELECT 1 FROM ${T}.client_sessions s WHERE s.app_id = a.id AND NOT s.sandbox)
             OR EXISTS (SELECT 1 FROM ${T}.handoffs h WHERE h.app_id = a.id AND NOT h.sandbox)) AS real_customers
         FROM ${T}.apps a LEFT JOIN ${T}.app_promotions p ON p.app_id = a.id
         WHERE p.stage IS DISTINCT FROM 'production'`,
      )
    ).rows as { id: string; stage: string | null; live_key: boolean; published: boolean; real_customers: boolean }[];
    let n = 0;
    for (const a of live) {
      const why = [a.live_key && "an active live key", a.published && "published", a.real_customers && "real customers"].filter((x): x is string => !!x);
      if (!why.length) continue;
      await tx.query(
        `INSERT INTO ${T}.app_promotions (app_id, stage) VALUES ($1, 'production') ON CONFLICT (app_id) DO UPDATE SET stage = 'production', updated_at = now()`,
        [a.id],
      );
      await tx.query(`INSERT INTO ${T}.audit_log (id, actor_id, action, target, details) VALUES (gen_random_uuid(), NULL, 'app_stage_grandfathered', $1, $2)`, [
        a.id,
        JSON.stringify({ app_id: a.id, from_stage: a.stage ?? "idea", to_stage: "production", why, note: "Already live when production began gating real money" }),
      ]);
      n++;
    }
    await tx.query(`INSERT INTO ${T}.app_live_grandfathered (done, apps) VALUES (true, $1)`, [n]);
    return n;
  });
}
