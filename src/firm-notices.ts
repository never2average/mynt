import { randomUUID } from "node:crypto";
import { emitFirmEvent, type FirmWebhookEvent } from "./runtime.js";
import type { Store } from "./store.js";

// A change to a firm made by one person (one of its members, or an admin) is told to the whole firm: as an event on
// its webhooks, and as a notice to every member it already has, which they read with list_firm_notices. A member
// added just now isn't told of their own arrival. Notices carry no figures and no secrets.

const T = "financial_products";

export async function noticeFirm(store: Store, entityId: string, type: FirmWebhookEvent, data: Record<string, unknown>): Promise<{ webhooks: number; members: number }> {
  const { rows } = await store.db.query(`SELECT id FROM ${T}.users WHERE entity_id = $1`, [entityId]);
  for (const r of rows) await store.db.query(`INSERT INTO ${T}.firm_notices (id, entity_id, user_id, type, data) VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), entityId, r.id, type, JSON.stringify(data)]);
  const webhooks = await emitFirmEvent(store, entityId, type, data, false).catch((e) => {
    console.error("firm notice: webhook not queued:", (e as Error).message);
    return 0;
  });
  return { webhooks, members: rows.length };
}

export async function firmNotices(store: Store, userId: string, limit = 50) {
  const { rows } = await store.db.query(`SELECT id, type, data, created_at, read_at FROM ${T}.firm_notices WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
  await store.db.query(`UPDATE ${T}.firm_notices SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return rows.map((r) => ({ id: r.id, type: r.type, data: r.data, at: new Date(r.created_at as string).toISOString(), read: r.read_at != null }));
}
