import { randomUUID } from "node:crypto";
import { emitFirmEvent, type FirmWebhookEvent } from "./runtime.js";
import type { Store, User } from "./store.js";

// A change to a firm made by one person (one of its members, or an admin) is told to the whole firm: as an event on
// its webhooks, and as a notice to every member it already has, which they read with list_firm_notices. A member
// added just now isn't told of their own arrival. Notices carry no figures and no secrets.
//
// An account an admin adds to a licence provider that already has a licence-provider member doesn't join at once: it's
// a pending request until one of those members accepts it (decide_firm_member). Until then it's a member of nothing,
// so it passes no gate, and its cool-off (partner-kit.ts) starts when it's accepted. Declining ends the request. The
// first member of a firm with none is added by an admin directly, as before.
//
// Standing goes with the role, not with joining: an account of the firm whose roles gain license_provider (an admin's
// invite, applied at its next sign-in) gets standing only the same way, through a request a member accepts (store.ts,
// licenceProviderRoleChanged). `users.lp_since` is when it gained standing; without it, an account counts for no gate.

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

const isLicenceProvider = (roles: string[]) => roles.includes("license_provider") && !roles.includes("admin");
const HOUR = 3_600_000;

// A member who gained licence-provider standing less than this ago can't change what Mynt reads as the firm's books, nor
// decide who else joins. 0 turns it off (local demos only).
export const memberCoolOffMs = () => {
  const raw = process.env.PARTNER_MEMBER_COOLOFF_HOURS;
  const n = raw === undefined || raw.trim() === "" ? 72 : Number(raw);
  return (Number.isFinite(n) && n >= 0 ? n : 72) * HOUR;
};

// When an account's licence-provider standing at its firm counts from: the latest of its creation, its joining the firm
// and its gaining standing there (acceptance, once accepted). Null: no standing at any firm.
export async function standingSince(store: Store, userId: string): Promise<Date | null> {
  const { rows } = await store.db.query(`SELECT created_at, entity_joined_at, lp_since, entity_id, roles FROM ${T}.users WHERE id = $1`, [userId]);
  const r = rows[0];
  if (!r || !r.entity_id || !r.lp_since || !isLicenceProvider((r.roles as string[]) ?? [])) return null;
  const t = (v: unknown) => (v ? new Date(v as string).getTime() : 0);
  return new Date(Math.max(t(r.created_at), t(r.entity_joined_at), t(r.lp_since)));
}

// Whether adding this account to this firm needs an existing member's acceptance: it's a licence provider and the firm
// already has one with standing.
export async function needsAcceptance(store: Store, entityId: string, member: User): Promise<boolean> {
  if (!isLicenceProvider(member.roles)) return false;
  const { rows } = await store.db.query(`SELECT roles FROM ${T}.users WHERE entity_id = $1 AND id <> $2 AND lp_since IS NOT NULL`, [entityId, member.id]);
  return rows.some((r) => isLicenceProvider((r.roles as string[]) ?? []));
}

export async function requestMembership(store: Store, entityId: string, member: User, requestedBy: string) {
  const existing = (await store.db.query(`SELECT id FROM ${T}.firm_member_requests WHERE entity_id = $1 AND user_id = $2 AND status = 'pending'`, [entityId, member.id])).rows[0];
  const id = (existing?.id as string | undefined) ?? randomUUID();
  if (!existing) await store.db.query(`INSERT INTO ${T}.firm_member_requests (id, entity_id, user_id, requested_by) VALUES ($1, $2, $3, $4)`, [id, entityId, member.id, requestedBy]);
  const told = await noticeFirm(store, entityId, "firm.member_pending", { request_id: id, member_email: member.email, member_roles: member.roles, requested_at: new Date().toISOString(), by: "admin", decide_with: "decide_firm_member { request_id, accept: true | false }" });
  return { request_id: id, status: "pending_acceptance", firm_told: told };
}

export async function pendingMembers(store: Store, entityId: string) {
  const { rows } = await store.db.query(
    `SELECT r.id, r.requested_at, u.email FROM ${T}.firm_member_requests r JOIN ${T}.users u ON u.id = r.user_id WHERE r.entity_id = $1 AND r.status = 'pending' ORDER BY r.requested_at`,
    [entityId],
  );
  return rows.map((r) => ({ request_id: r.id, member_email: r.email, requested_at: new Date(r.requested_at as string).toISOString(), decide_with: "decide_firm_member" }));
}

// An existing member of the firm (never the account asked about, never an admin) accepts or declines it. The one deciding
// must have had licence-provider standing there since before the request was made, and be past the cool-off.
export async function decideMembership(store: Store, requestId: string, decider: User, accept: boolean, now = new Date()): Promise<{ error: string } | Record<string, unknown>> {
  const me = (await store.getUser(decider.id)) ?? decider;
  const r = (await store.db.query(`SELECT * FROM ${T}.firm_member_requests WHERE id = $1`, [requestId])).rows[0] as { id: string; entity_id: string; user_id: string; status: string; requested_at: string } | undefined;
  if (!r || r.entity_id !== me.entity_id) return { error: "No such request at your firm" };
  if (!isLicenceProvider(me.roles) || r.user_id === me.id) return { error: "Only one of your firm's existing licence-provider members decides this" };
  if ((await store.getEntity(r.entity_id))?.status !== "active") return { error: "The firm isn't active" };
  const since = await standingSince(store, me.id);
  if (!since || since.getTime() >= new Date(r.requested_at).getTime()) return { error: "Only a member who was a licence provider at your firm before this request was made decides it" };
  if (since.getTime() + memberCoolOffMs() > now.getTime()) return { error: `You became a licence provider at this firm too recently to decide who joins it: members wait ${Math.round(memberCoolOffMs() / HOUR)} hours (PARTNER_MEMBER_COOLOFF_HOURS)` };
  const { rows } = await store.db.query(`UPDATE ${T}.firm_member_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [r.id, accept ? "accepted" : "declined", me.id]);
  if (!rows.length) return { error: `That request is already ${r.status}` };
  const member = await store.getUser(r.user_id);
  await store.audit(me.id, accept ? "accept_firm_member" : "decline_firm_member", r.entity_id, { request_id: r.id, member_email: member?.email ?? null });
  if (!accept) return { request_id: r.id, status: "declined", note: "They have no licence-provider standing at your firm" };
  // Joined (or confirmed) only if the account isn't at another firm by now; its standing, and so its cool-off, start now.
  const { rows: joined } = await store.db.query(
    `UPDATE ${T}.users SET entity_joined_at = CASE WHEN entity_id IS DISTINCT FROM $2 THEN now() ELSE entity_joined_at END, entity_id = $2,
       lp_since = CASE WHEN 'license_provider' = ANY(roles) THEN now() END
     WHERE id = $1 AND (entity_id IS NULL OR entity_id = $2) RETURNING id`,
    [r.user_id, r.entity_id],
  );
  if (!joined.length) {
    await store.db.query(`UPDATE ${T}.firm_member_requests SET status = 'declined' WHERE id = $1`, [r.id]);
    return { error: "That account has joined another firm since it was added to yours, so it can't join yours: the request is closed" };
  }
  await noticeFirm(store, r.entity_id, "firm.member_added", { member_email: member?.email ?? null, accepted_by: me.email ?? me.id, at: new Date().toISOString() });
  return { request_id: r.id, status: "accepted", note: "They're a licence provider at your firm now; the member cool-off starts from this moment" };
}
