import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";

// What machines cost per app, over time, for the workspace P&L (get_workspace_pnl): samples of each machine's running
// total from its provider (a hosting VM's run seconds, a sandbox's dollars), each with what it cost since the one
// before. A machine's first sample is its baseline (nothing is charged for time before Mynt started counting it),
// except one Mynt has just made, which starts from zero. Per-period cost is the sum of those differences.
//
// hosting: each hosted app's own VM (a direct hosting provider), priced at FREESTYLE_USD_PER_HOUR when sampled.
// sandbox: a build's sandboxes once the build has ended (its preview kept up until the sandbox's time limit) and
// sandboxes reopened on a finished build (reopen_sandbox). While a build runs, its sandboxes are in its own cost.
// Recording of each kind starts once, at a date kept in settings; periods before it aren't measured.

export type UsageKind = "hosting" | "sandbox";
export const USAGE_KINDS: UsageKind[] = ["hosting", "sandbox"];
export const usageStartedSetting = (kind: UsageKind) => `usage_recording_started_at:${kind}`;
// How often machines are sampled (USAGE_SAMPLE_MS, default 5 minutes). A machine deleted between two samples loses
// at most that much time from the record, on a provider that forgets a deleted machine's usage.
export const usageSampleMs = (env = process.env) => Math.max(10_000, Number(env.USAGE_SAMPLE_MS ?? 300_000));

export const USAGE_TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.usage_samples (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('hosting', 'sandbox')),
    resource_id text NOT NULL,
    app_id uuid NOT NULL,
    sampled_at timestamptz NOT NULL DEFAULT now(),
    total numeric NOT NULL,
    delta_usd numeric NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS usage_samples_resource_idx ON financial_products.usage_samples (kind, resource_id, sampled_at DESC);
  CREATE INDEX IF NOT EXISTS usage_samples_app_idx ON financial_products.usage_samples (app_id, kind, sampled_at);
`;

export class UsageMeter {
  private constructor(private readonly db: Db) {}

  static async open(db: Db) {
    await db.exec(USAGE_TABLES);
    return new UsageMeter(db);
  }

  // Recording of this kind starts now, unless it already has.
  async start(kind: UsageKind) {
    await this.db.query("INSERT INTO financial_products.settings (key, value) VALUES ($1, to_jsonb(now())) ON CONFLICT (key) DO NOTHING", [usageStartedSetting(kind)]);
  }

  // A machine's running total now. `toUsd` prices the increase since the last sample; `fromZero` marks a machine Mynt
  // just made (its whole total counts); otherwise a first sample is only a baseline.
  async record(kind: UsageKind, resourceId: string, appId: string, total: number, toUsd: (increase: number) => number, o: { fromZero?: boolean } = {}) {
    if (!Number.isFinite(total) || total < 0) return;
    const last = (
      await this.db.query("SELECT total FROM financial_products.usage_samples WHERE kind = $1 AND resource_id = $2 ORDER BY sampled_at DESC LIMIT 1", [kind, resourceId])
    ).rows[0] as { total: unknown } | undefined;
    const increase = last ? Math.max(0, total - Number(last.total)) : o.fromZero ? total : 0;
    const usd = increase > 0 ? Math.max(0, toUsd(increase)) : 0;
    await this.db.query(
      "INSERT INTO financial_products.usage_samples (id, kind, resource_id, app_id, total, delta_usd) VALUES ($1, $2, $3, $4, $5, $6)",
      [randomUUID(), kind, resourceId, appId, total, usd],
    );
  }
}
