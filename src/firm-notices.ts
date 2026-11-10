import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { inTransaction } from "./db.js";
import { emitFirmEvent, type FirmWebhookEvent } from "./runtime.js";
import type { Store, User } from "./store.js";

// A change to a firm made by one person (one of its members, or an admin) is told to the whole firm: as an event on
// its webhooks, and as a notice to every member it already has, which they read with list_firm_notices. A member
// added just now isn't told of their own arrival. Notices carry no figures and no secrets.
//
// Licence-provider standing (`users.lp_since`) is what gives an account licence-provider powers at its firm
// (store.ts, rolesWithStanding). A firm's first ever licence provider has it at once, and that marks the firm
// established (`entities.lp_established_at`). From then on nobody gains it directly, however they get there (added by
// an admin, or a member whose roles later gain license_provider): it's a request (`firm_member_requests`) one of the
// firm's licence providers accepts (decide_firm_member), one who has had standing since before the request and is past
// the cool-off. When nobody can (the firm's licence providers lost the role, say), only an admin's recovery settles it
// (recover_firm_member): announced to every current and past licence provider of the firm, any of whom can block it
// (block_firm_recovery), and effective only after RECOVERY_DELAY. Losing standing is told to the firm too.

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


// The firm's licence providers who can decide a request made at `requestedAt`: standing since before it, past the cool-off.
async function eligibleDeciders(store: Store, entityId: string, requestedAt: Date, now: Date, except: string | null): Promise<string[]> {
  const { rows } = await store.db.query(`SELECT id FROM ${T}.users WHERE entity_id = $1 AND lp_since IS NOT NULL AND ($2::uuid IS NULL OR id <> $2)`, [entityId, except]);
  const out: string[] = [];
  for (const r of rows) {
    const since = await standingSince(store, r.id as string);
    if (since && since.getTime() < requestedAt.getTime() && since.getTime() + memberCoolOffMs() <= now.getTime()) out.push(r.id as string);
  }
  return out;
}

export async function pendingMembers(store: Store, entityId: string) {
  const { rows } = await store.db.query(
    `SELECT r.id, r.requested_at, r.reason, r.recovery_started_at, u.email FROM ${T}.firm_member_requests r JOIN ${T}.users u ON u.id = r.user_id WHERE r.entity_id = $1 AND r.status = 'pending' ORDER BY r.requested_at`,
    [entityId],
  );
  return rows.map((r) => ({
    request_id: r.id,
    member_email: r.email,
    reason: r.reason ?? null,
    requested_at: new Date(r.requested_at as string).toISOString(),
    ...(r.recovery_started_at ? { admin_recovery: { started_at: new Date(r.recovery_started_at as string).toISOString(), completes_after: new Date(new Date(r.recovery_started_at as string).getTime() + RECOVERY_DELAY_MS).toISOString(), block_with: "block_firm_recovery" } } : {}),
    decide_with: "decide_firm_member",
  }));
}

type Req = { id: string; entity_id: string; user_id: string; status: string; requested_at: string; recovery_started_at: string | null; recovery_reason: string | null };
const requestById = async (store: Store, id: string) => (await store.db.query(`SELECT * FROM ${T}.firm_member_requests WHERE id = $1`, [id])).rows[0] as Req | undefined;

// Standing given on a request: the account joins (only if it isn't at another firm by now) and has standing from now.
async function grantOnRequest(store: Store, r: Req, decidedBy: string, how: string): Promise<{ error: string } | null> {
  const out = await inTransaction(store.db, async (tx) => {
    const { rows: claimed } = await tx.query(`UPDATE ${T}.firm_member_requests SET status = 'accepted', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [r.id, decidedBy]);
    if (!claimed.length) return "taken";
    const { rows: joined } = await tx.query(
      `UPDATE ${T}.users SET entity_joined_at = CASE WHEN entity_id IS DISTINCT FROM $2 THEN now() ELSE entity_joined_at END, entity_id = $2,
         lp_since = CASE WHEN 'license_provider' = ANY(roles) THEN now() END
       WHERE id = $1 AND (entity_id IS NULL OR entity_id = $2) RETURNING lp_since`,
      [r.user_id, r.entity_id],
    );
    if (!joined.length) {
      await tx.query(`UPDATE ${T}.firm_member_requests SET status = 'declined' WHERE id = $1`, [r.id]);
      return "elsewhere";
    }
    if (joined[0].lp_since) await tx.query(`INSERT INTO ${T}.firm_standing_history (entity_id, user_id, event, reason) VALUES ($1, $2, 'gained', $3)`, [r.entity_id, r.user_id, how]);
    return "ok";
  });
  if (out === "taken") return { error: "That request isn't waiting any more" };
  if (out === "elsewhere") return { error: "That account has joined another firm since it was added to yours, so it can't join yours: the request is closed" };
  return null;
}

// A declined request: the account keeps no place at the firm it has no standing at.
async function closeDeclined(store: Store, r: Req) {
  await store.db.query(`UPDATE ${T}.users SET entity_id = NULL WHERE id = $1 AND entity_id = $2 AND lp_since IS NULL AND 'license_provider' = ANY(roles)`, [r.user_id, r.entity_id]);
}

// An existing licence provider of the firm (never the account asked about, never an admin) accepts or declines it.
export async function decideMembership(store: Store, requestId: string, decider: User, accept: boolean, now = new Date()): Promise<{ error: string } | Record<string, unknown>> {
  const me = (await store.getUser(decider.id)) ?? decider;
  const r = await requestById(store, requestId);
  if (!r || r.entity_id !== me.entity_id) return { error: "No such request at your firm" };
  if (!isLicenceProvider(me.roles) || r.user_id === me.id) return { error: "Only one of your firm's existing licence-provider members decides this" };
  if ((await store.getEntity(r.entity_id))?.status !== "active") return { error: "The firm isn't active" };
  if (r.status !== "pending") return { error: `That request is already ${r.status}` };
  const since = await standingSince(store, me.id);
  if (!since || since.getTime() >= new Date(r.requested_at).getTime()) return { error: "Only a member who was a licence provider at your firm before this request was made decides it" };
  if (since.getTime() + memberCoolOffMs() > now.getTime()) return { error: `You became a licence provider at this firm too recently to decide who joins it: members wait ${Math.round(memberCoolOffMs() / HOUR)} hours (PARTNER_MEMBER_COOLOFF_HOURS)` };
  const member = await store.getUser(r.user_id);
  if (!accept) {
    const { rows } = await store.db.query(`UPDATE ${T}.firm_member_requests SET status = 'declined', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [r.id, me.id]);
    if (!rows.length) return { error: "That request isn't waiting any more" };
    await closeDeclined(store, r);
    await store.audit(me.id, "decline_firm_member", r.entity_id, { request_id: r.id, member_email: member?.email ?? null });
    return { request_id: r.id, status: "declined", note: "They have no licence-provider standing at your firm" };
  }
  const failed = await grantOnRequest(store, r, me.id, "accepted");
  if (failed) return failed;
  await store.audit(me.id, "accept_firm_member", r.entity_id, { request_id: r.id, member_email: member?.email ?? null });
  await noticeFirm(store, r.entity_id, "firm.member_added", { member_email: member?.email ?? null, accepted_by: me.email ?? me.id, at: new Date().toISOString() });
  return { request_id: r.id, status: "accepted", note: "They're a licence provider at your firm now; the member cool-off starts from this moment" };
}

// ---- an admin's recovery, when nobody at the firm can decide ----

export const RECOVERY_DELAY_MS = 7 * 24 * HOUR;

const everyone = async (store: Store, entityId: string) => {
  const current = (await store.db.query(`SELECT id FROM ${T}.users WHERE entity_id = $1`, [entityId])).rows.map((r) => r.id as string);
  return [...new Set([...current, ...(await store.pastLicenceProviders(entityId))])];
};

// Standing lost by an admin's hand, which locks recovery at the firm for RECOVERY_LOCK_MS.
export const ADMIN_LOSS_CAUSES = ["moved_by_admin", "role_removed_by_invite", "revoked_by_admin"];
export const RECOVERY_LOCK_MS = 30 * 24 * HOUR;

// Why an admin's recovery at this firm can't go ahead now, if it can't. Recovery rests on the firm's past licence
// providers being able to object, so it's locked while any of them can't sign in, and for 30 days after any of them lost
// standing there through an admin's action. The account the request is for isn't counted (it's the one being restored).
// The reasons name no one: they say what's wrong, and an admin sees who in its own tools.
export async function recoveryLock(store: Store, entityId: string, subjectId: string, now: Date): Promise<string | null> {
  const past = (await store.pastLicenceProviders(entityId)).filter((id) => id !== subjectId);
  let lockedOut = 0;
  for (const id of past) {
    const email = ((await store.db.query(`SELECT email FROM ${T}.users WHERE id = $1`, [id])).rows[0]?.email as string | null) ?? null;
    if (!email) continue; // a token account: nothing an admin can revoke from it here
    if (!(await store.getInvite(email)) || (await store.isSignupBlocked(email))) lockedOut++;
  }
  if (lockedOut) return `Recovery is locked: ${lockedOut} past licence provider(s) of this firm can't sign in (revoked, blocked or not on the whitelist), so they couldn't object. Restore their access first.`;
  const { rows } = await store.db.query(
    `SELECT max(at) AS at FROM ${T}.firm_standing_history WHERE entity_id = $1 AND event = 'lost' AND reason = ANY($2::text[]) AND user_id <> $3 AND at > $4`,
    [entityId, ADMIN_LOSS_CAUSES, subjectId, new Date(now.getTime() - RECOVERY_LOCK_MS)],
  );
  if (rows[0]?.at) return `Recovery is locked until ${new Date(new Date(rows[0].at as string).getTime() + RECOVERY_LOCK_MS).toISOString()}: a past licence provider of this firm lost standing here through an admin's action (moved to another firm, roles rewritten, or revoked) within the last 30 days.`;
  return null;
}

// First call: starts it (only when nobody at the firm can decide), told to every current and past licence provider.
// A call after RECOVERY_DELAY with no block completes it. One admin is enough: production has one (docs/reference.md).
// Both calls are refused while the firm's recovery is locked (recoveryLock) or someone at the firm can decide.
export async function recoverMembership(store: Store, requestId: string, admin: User, reason: string, now = new Date()): Promise<{ error: string } | Record<string, unknown>> {
  const r = await requestById(store, requestId);
  if (!r) return { error: `No request '${requestId}'` };
  if (r.status !== "pending") return { error: `That request is already ${r.status}` };
  const member = await store.getUser(r.user_id);
  const locked = await recoveryLock(store, r.entity_id, r.user_id, now);
  if (locked) {
    await store.audit(admin.id, "recover_firm_member_refused", r.entity_id, { request_id: r.id, reason: locked });
    return { error: locked };
  }
  if ((await eligibleDeciders(store, r.entity_id, new Date(r.requested_at), now, r.user_id)).length)
    return { error: "The firm has a licence provider who can decide this: it's theirs to accept or decline (decide_firm_member), not an admin's" };
  if (!r.recovery_started_at) {
    await store.db.query(`UPDATE ${T}.firm_member_requests SET recovery_reason = $2, recovery_started_by = $3, recovery_started_at = $4 WHERE id = $1`, [r.id, reason, admin.id, now]);
    const completes = new Date(now.getTime() + RECOVERY_DELAY_MS).toISOString();
    const told = await store.noticeAccounts(r.entity_id, "firm.recovery_pending", { request_id: r.id, member_email: member?.email ?? null, reason, started_at: now.toISOString(), completes_after: completes, block_with: "block_firm_recovery { request_id, reason }" }, await everyone(store, r.entity_id));
    await store.audit(admin.id, "recover_firm_member_started", r.entity_id, { request_id: r.id, member_email: member?.email ?? null, reason });
    return { request_id: r.id, status: "recovery_pending", completes_after: completes, told_accounts: told, note: "Every current and past licence provider of the firm was told and can block it. Call again after completes_after to complete it." };
  }
  const due = new Date(r.recovery_started_at).getTime() + RECOVERY_DELAY_MS;
  if (now.getTime() < due) return { error: `The recovery completes only after ${new Date(due).toISOString()}, so the firm's licence providers have time to see it and block it` };
  const failed = await grantOnRequest(store, r, admin.id, "admin_recovery");
  if (failed) return failed;
  await store.audit(admin.id, "recover_firm_member_completed", r.entity_id, { request_id: r.id, member_email: member?.email ?? null, reason: r.recovery_reason, completion_reason: reason });
  await store.noticeAccounts(r.entity_id, "firm.member_added", { member_email: member?.email ?? null, by: "admin_recovery", at: now.toISOString() }, await everyone(store, r.entity_id));
  return { request_id: r.id, status: "accepted", note: "Recovered: they're a licence provider at the firm now, and the member cool-off starts from this moment" };
}

// Any past licence provider of the firm, current or not (even one whose role was taken away), blocks a recovery.
export async function blockRecovery(store: Store, requestId: string, user: User, reason: string): Promise<{ error: string } | Record<string, unknown>> {
  const r = await requestById(store, requestId);
  if (!r || !r.recovery_started_at || r.status !== "pending") return { error: "No admin recovery is waiting on that request" };
  if ((user.held_roles ?? user.roles).includes("admin") || r.user_id === user.id || !(await store.pastLicenceProviders(r.entity_id)).includes(user.id))
    return { error: "Only someone who has been a licence provider at that firm can block its recovery" };
  const { rows } = await store.db.query(`UPDATE ${T}.firm_member_requests SET status = 'declined', decided_by = $2, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id`, [r.id, user.id]);
  if (!rows.length) return { error: "That request isn't waiting any more" };
  await closeDeclined(store, r);
  const member = await store.getUser(r.user_id);
  await store.audit(user.id, "block_firm_recovery", r.entity_id, { request_id: r.id, member_email: member?.email ?? null, reason });
  await store.noticeAccounts(r.entity_id, "firm.recovery_pending", { request_id: r.id, member_email: member?.email ?? null, status: "blocked", blocked_by: user.email ?? user.id, reason, at: new Date().toISOString() }, await everyone(store, r.entity_id));
  return { request_id: r.id, status: "blocked", note: "The recovery is blocked and the request declined; everyone it was told to has been told" };
}

// Tools any signed-in account has: its notices, and blocking a recovery at a firm where it has been a licence provider
// (which needs no current role there: a demoted licence provider can still object).
export function registerFirmNoticeTools(server: McpServer, store: Store, user: User) {
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const fail = (error: string) => ({ ...json({ error }), isError: true });
  server.registerTool(
    "list_firm_notices",
    {
      title: "Notices to you about your firm",
      description:
        "What's changed at a firm you belong to (or have been a licence provider at) that you should know about, newest first: members added or waiting to be accepted, licence providers losing standing, signing keys registered or replaced, endpoints proposed and confirmed, the ledger source switched, passes about to run out, changes waiting for your approval, and admins' recoveries you can block. The same go to the firm's webhooks. Reading them marks them read.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => json(await firmNotices(store, user.id, limit)),
  );
  server.registerTool(
    "block_firm_recovery",
    {
      title: "Block an admin's recovery of a firm's licence provider",
      description:
        "Anyone who has been a licence provider at a firm, even one whose role has since been taken away: block an admin's recovery (recover_firm_member) of a request at that firm while it waits out its 7 days. The request is declined; it's audited and told to every current and past licence provider of the firm.",
      inputSchema: { request_id: z.string().uuid(), reason: z.string().min(3).max(2000) },
    },
    async ({ request_id, reason }) => {
      const out = await blockRecovery(store, request_id, (await store.getUser(user.id)) ?? user, reason);
      return "error" in out ? fail(out.error as string) : json(out);
    },
  );
}
