// Liquidity pools, as the studio shows them (the /liquidity page and the wallet tile's links).
// Pure: reads Mynt's liquidity tools' replies (core/src/liquidity-tools.ts, product-health-tools.ts,
// sponsorships.ts) into the page's rows, and the checks the page makes before it sends anything.
// Mynt checks everything again. Amounts are integer cents from Mynt, shown as US dollars.
//
// Who sees what: builders (Mynt's innovator role, which developers have) see their products'
// pools and may propose one; liquidity providers browse the pools open to commitments, commit
// capital and ask for it back. Money only ever moves on a rail the pool's sponsoring licence
// provider approved; Mynt never holds anyone's funds or keys.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const cents = (v: unknown): number => num(v) ?? 0;
const list = (v: unknown, key: string): unknown[] => (Array.isArray(v) ? v : isObj(v) && Array.isArray(v[key]) ? (v[key] as unknown[]) : []);

// ---- roles ----

export type LiquidityAccess = { builder: boolean; liquidityProvider: boolean };
export const NO_ACCESS: LiquidityAccess = { builder: false, liquidityProvider: false };

// From whoami's effective roles: developers are innovators on Mynt, and innovators are its builders.
export const accessFrom = (roles: readonly string[]): LiquidityAccess => ({
  builder: roles.includes("innovator") || roles.includes("developer"),
  liquidityProvider: roles.includes("liquidity_provider"),
});
export const hasLiquidity = (a: LiquidityAccess | null | undefined) => Boolean(a && (a.builder || a.liquidityProvider));
// Whether the studio's liquidity routes serve this session at all (Mynt checks every call again).
export const canUseLiquidity = (roles: readonly string[]) => hasLiquidity(accessFrom(roles));

// Earn's right-hand panel tabs (/earn?tab=...), beside its assistant: the pools the conversation
// matched, then the detailed tables by role, then the assistant's drafts (liquidity providers'
// only: builders can't commit).
export type LiquidityTab = "opportunities" | "my-positions" | "my-pools";
export type EarnTab = "pools" | LiquidityTab | "drafts";
export const TAB_LABELS: Record<EarnTab, string> = { pools: "Pools", opportunities: "Opportunities", "my-positions": "My positions", "my-pools": "My pools", drafts: "Drafts" };
export function tabsFor(a: LiquidityAccess): EarnTab[] {
  if (!hasLiquidity(a)) return [];
  return ["pools", ...(a.liquidityProvider ? (["opportunities", "my-positions"] as const) : []), ...(a.builder ? (["my-pools"] as const) : []), ...(a.liquidityProvider ? (["drafts"] as const) : [])];
}
// ?tab= on /earn, and /liquidity's old tabs: the panel tab it names. The old "assistant" (and
// anything unknown) is Pools.
export function earnTabFromQuery(tab: unknown): EarnTab {
  if (tab === "open-pools" || tab === "opportunities") return "opportunities";
  if (tab === "my-positions" || tab === "my-pools" || tab === "drafts") return tab;
  return "pools";
}
export const earnTabFromLiquidity = earnTabFromQuery;
// A link that names a table or the drafts opens the panel straight away, before any message.
export const tabOpensPanel = (tab: unknown) => earnTabFromQuery(tab) !== "pools";
// The wallet tile's links, by role.
export function walletLinksFor(a: LiquidityAccess | null | undefined): { label: string; href: string }[] {
  if (!a) return [];
  return [...(a.builder ? [{ label: "Manage pools", href: "/earn?tab=my-pools" }] : []), ...(a.liquidityProvider ? [{ label: "Provide liquidity", href: "/earn?tab=opportunities" }] : [])];
}

// ---- money ----

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const usd = (c: number | null | undefined) => (c === null || c === undefined ? "—" : USD.format(c / 100));

// "1,250.50" or "$1250.5" -> 125050 cents; null for anything that isn't a positive dollar amount.
export function parseUsd(input: string): number | null {
  const s = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  const c = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return Number.isSafeInteger(c) && c > 0 ? c : null;
}

export const percentOfBps = (bps: number | null) => (bps === null ? "—" : `${(bps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`);

// ---- pools ----

export type Pool = {
  id: string;
  name: string;
  productId: string;
  productName: string | null;
  productLine: string | null;
  componentKey: string | null;
  sandbox: boolean;
  status: string; // open, paused, closed
  pauseKind: string | null; // awaiting_approval, manual, governance, health
  pauseReason: string | null;
  holdReason: string | null;
  minReserveBps: number;
  minReserveFloorCents: number;
  noticePeriodDays: number; // the wait after a withdrawal request before it can be paid
  lockInDays: number | null; // the least time after a deposit settles before it can be withdrawn; null when Mynt doesn't set one
  minCommitmentCents: number;
  maxCommitmentCents: number;
  depositRailId: string | null;
  withdrawalRailId: string | null;
  approvedAt: string | null;
  offeringCleared: boolean;
  createdAt: string | null;
};

export function fromPools(reply: unknown): Pool[] {
  return list(reply, "pools")
    .filter(isObj)
    .map((p) => ({
      id: str(p.id) ?? "",
      name: str(p.name) ?? "Unnamed pool",
      productId: str(p.product_id) ?? "",
      productName: null,
      productLine: null,
      componentKey: str(p.component_key),
      sandbox: p.sandbox === true,
      status: str(p.status) ?? "unknown",
      pauseKind: str(p.pause_kind),
      pauseReason: str(p.pause_reason),
      holdReason: str(p.hold_reason),
      minReserveBps: cents(p.min_reserve_bps),
      minReserveFloorCents: cents(p.min_reserve_floor_cents),
      noticePeriodDays: cents(p.notice_period_days),
      lockInDays: num(p.lock_in_days),
      minCommitmentCents: cents(p.min_commitment_cents),
      maxCommitmentCents: cents(p.max_commitment_cents),
      depositRailId: str(p.deposit_rail_id),
      withdrawalRailId: str(p.withdrawal_rail_id),
      approvedAt: str(p.approved_at),
      offeringCleared: p.offering_cleared === true,
      createdAt: str(p.created_at),
    }))
    .filter((p) => p.id && p.productId);
}

// Where a pool stands. Real (non-sandbox) commitments are refused by Mynt until an admin records
// that the pool's offering was cleared, so an uncleared real pool is shown as sandbox-only.
export type PoolStage = "awaiting_approval" | "sandbox" | "uncleared" | "cleared";
export const STAGE_LABELS: Record<PoolStage, string> = {
  awaiting_approval: "Proposed — awaiting sponsor approval",
  sandbox: "Sandbox — test money only",
  uncleared: "Sandbox only — not yet cleared for real commitments",
  cleared: "Cleared for real commitments",
};
export function stageOf(p: Pool): PoolStage {
  if (!p.approvedAt) return "awaiting_approval";
  if (p.sandbox) return "sandbox";
  return p.offeringCleared ? "cleared" : "uncleared";
}
export const railsApproved = (p: Pool) => Boolean(p.approvedAt && p.depositRailId && p.withdrawalRailId);
export function statusText(p: Pool): string {
  if (p.status === "paused") return p.pauseKind === "awaiting_approval" ? "Waiting for approval" : `Paused${p.pauseReason ? `: ${p.pauseReason}` : ""}`;
  if (p.status === "open") return p.holdReason ? `Open, payments held: ${p.holdReason}` : "Open";
  if (p.status === "closed") return "Closed to new commitments";
  return p.status;
}
export const reserveText = (p: Pool) => `${percentOfBps(p.minReserveBps)} of obligations, at least ${usd(p.minReserveFloorCents)}`;
export const noticeText = (days: number) => (days === 0 ? "No notice" : `${days} day${days === 1 ? "" : "s"}`);
// Lock-in and notice are different things: lock-in runs from when a deposit settles, notice from when a withdrawal is asked for.
export const lockInText = (days: number | null) => (days === null ? "Not set" : days === 0 ? "None" : `${days} day${days === 1 ? "" : "s"}`);
export const limitsText = (p: Pool) => `${usd(p.minCommitmentCents)} – ${usd(p.maxCommitmentCents)} per firm`;

// ---- health ----

// A pool's latest health, as far as the user may see it. Builders get status and verification
// (list_product_health); liquidity providers also get the numbers for products they're committed
// to (list_pools_with_health). Anything not measured or not theirs to see stays null, with why.
export type PoolHealth = {
  verified: boolean | null;
  snapshotStatus: string | null;
  sequence: number | null;
  periodEnd: string | null;
  latestVerifiedEnd: string | null;
  coverageBps: number | null;
  headroomCents: number | null;
  reason: string | null;
};
const NO_HEALTH = (reason: string): PoolHealth => ({ verified: null, snapshotStatus: null, sequence: null, periodEnd: null, latestVerifiedEnd: null, coverageBps: null, headroomCents: null, reason });

// list_pools_with_health: one row per pool.
export function fromPoolsWithHealth(reply: unknown): Map<string, PoolHealth> {
  const out = new Map<string, PoolHealth>();
  for (const r of list(reply, "pools").filter(isObj)) {
    const id = str(r.pool_id);
    if (!id) continue;
    const snap = isObj(r.snapshot) ? r.snapshot : null;
    out.set(id, {
      verified: typeof r.verified === "boolean" ? r.verified : null,
      snapshotStatus: snap ? str(snap.status) : null,
      sequence: snap ? num(snap.sequence) : null,
      periodEnd: snap ? str(snap.period_end) : null,
      latestVerifiedEnd: r.verified === true && snap ? str(snap.period_end) : null,
      coverageBps: num(r.coverage_bps),
      headroomCents: num(r.headroom_cents),
      reason: str(r.verified_reason) ?? str(r.coverage_reason),
    });
  }
  return out;
}

// list_product_health: one record per product (or per pool of it), newest snapshot first.
export function fromProductHealth(reply: unknown): Map<string, PoolHealth> {
  const out = new Map<string, PoolHealth>();
  for (const r of list(reply, "records").filter(isObj)) {
    const product = str(r.product_id);
    if (!product) continue;
    const snaps = (Array.isArray(r.snapshots) ? r.snapshots : []).filter(isObj);
    const latest = snaps[0];
    const verified = snaps.find((s) => s.verified === true);
    out.set(`${product}|${str(r.pool_id) ?? ""}`, latest
      ? { ...NO_HEALTH(""), reason: null, verified: latest.verified === true, snapshotStatus: str(latest.status), sequence: num(latest.sequence), periodEnd: str(latest.period_end), latestVerifiedEnd: verified ? str(verified.period_end) : null }
      : NO_HEALTH("No health snapshot yet"));
  }
  return out;
}
export const healthFor = (m: Map<string, PoolHealth>, p: Pool): PoolHealth => m.get(`${p.productId}|${p.id}`) ?? m.get(`${p.productId}|`) ?? NO_HEALTH("No health snapshot yet");

export function healthText(h: PoolHealth | null | undefined): string {
  if (!h) return "Not available yet";
  if (h.sequence === null) return h.reason ?? "No health snapshot yet";
  const verified = h.verified ? "Verified" : "Not verified";
  return `${verified} · #${h.sequence}${h.periodEnd ? ` to ${h.periodEnd.slice(0, 10)}` : ""}`;
}

// ---- withdrawals and positions ----

export type Withdrawal = {
  id: string;
  seq: number | null;
  poolId: string;
  poolName: string | null;
  amountCents: number;
  status: string;
  requestedAt: string | null;
  eligibleAt: string | null;
  settledCents: number;
  inFlightCents: number;
  waitingReason: string | null;
  sandbox: boolean;
};
export function fromWithdrawals(reply: unknown): Withdrawal[] {
  return list(reply, "withdrawals")
    .filter(isObj)
    .map((w) => ({
      id: str(w.id) ?? "",
      seq: num(w.seq),
      poolId: str(w.pool_id) ?? "",
      poolName: str(w.pool_name),
      amountCents: cents(w.amount_cents),
      status: str(w.status) ?? "unknown",
      requestedAt: str(w.requested_at),
      eligibleAt: str(w.eligible_at),
      settledCents: cents(w.settled_cents),
      inFlightCents: cents(w.in_flight_cents),
      waitingReason: str(w.waiting_reason) ?? str(w.status_reason),
      sandbox: w.sandbox === true,
    }))
    .filter((w) => w.id && w.poolId);
}
// Still in the queue: not yet paid, cancelled or ended.
export const WAITING = new Set(["queued", "parked", "paying"]);
export const queueLength = (ws: Withdrawal[], poolId: string) => ws.filter((w) => w.poolId === poolId && WAITING.has(w.status)).length;

export type Position = {
  poolId: string;
  name: string;
  productId: string;
  sandbox: boolean;
  poolStatus: string;
  state: string | null; // the US state the firm's capital moves from, fixed while it holds a position
  committedCents: number; // settled in, plus what's still on its way in
  settledCents: number; // the balance: settled in, less settled out
  pendingInCents: number;
  queuedCents: number;
  paidCents: number; // settled withdrawals
  availableCents: number; // what may be asked for now
  exited: boolean;
};
export function fromPositions(reply: unknown): Position[] {
  return list(reply, "positions")
    .filter(isObj)
    .map((p) => ({
      poolId: str(p.pool_id) ?? "",
      name: str(p.name) ?? "Unnamed pool",
      productId: str(p.product_id) ?? "",
      sandbox: p.sandbox === true,
      poolStatus: str(p.pool_status) ?? "unknown",
      state: str(p.state),
      committedCents: cents(p.contributed_cents) + cents(p.pending_in_cents),
      settledCents: cents(p.balance_cents),
      pendingInCents: cents(p.pending_in_cents),
      queuedCents: cents(p.queued_withdrawal_cents),
      paidCents: cents(p.withdrawn_cents),
      availableCents: cents(p.available_to_withdraw_cents),
      exited: p.exited === true,
    }))
    .filter((p) => p.poolId);
}

// ---- proposing a pool ----

// A component of the builder's firm's product that an approved licence provider sponsors: the
// only place Mynt lets a pool be proposed (list_my_sponsorships).
export type Sponsored = { productId: string; productName: string; componentKey: string; sponsorId: string; sponsorName: string | null };
export function fromSponsorships(reply: unknown): { approved: Sponsored[]; productIds: Set<string> } {
  const rows = list(reply, "sponsorships").filter(isObj);
  const productIds = new Set(rows.map((s) => str(s.product_id) ?? (isObj(s.product) ? str(s.product.id) : null)).filter((v): v is string => Boolean(v)));
  const approved = rows
    .filter((s) => s.status === "approved")
    .map((s) => {
      const product = isObj(s.product) ? s.product : {};
      const provider = isObj(s.provider) ? s.provider : {};
      const productId = str(s.product_id) ?? str(product.id) ?? "";
      return { productId, productName: str(product.name) ?? productId, componentKey: str(s.component_key) ?? "", sponsorId: str(s.provider_entity_id) ?? str(provider.entity_id) ?? "", sponsorName: str(provider.name) };
    })
    .filter((s) => s.productId && s.componentKey && s.sponsorId);
  // One option per (product, component, sponsor).
  const seen = new Set<string>();
  return { approved: approved.filter((s) => (seen.has(`${s.productId}|${s.componentKey}|${s.sponsorId}`) ? false : (seen.add(`${s.productId}|${s.componentKey}|${s.sponsorId}`), true))), productIds };
}

export type ProposeInput = {
  product_id: string;
  component_key: string;
  name: string;
  sandbox: boolean;
  min_reserve_bps: number;
  min_reserve_floor_cents: number;
  notice_period_days: number;
  min_commitment_cents: number;
  max_commitment_cents: number;
  sponsor_entity_id?: string;
};

// The proposal form's values, as typed, to create_pool's arguments, or why not.
export function proposalFrom(f: { option: Sponsored | null; name: string; sandbox: boolean; reservePercent: string; reserveFloor: string; noticeDays: string; minCommit: string; maxCommit: string }, options: Sponsored[]): ProposeInput | { error: string } {
  if (!f.option) return { error: "Pick the sponsored component this pool serves." };
  if (!f.name.trim()) return { error: "Name the pool." };
  const pct = f.reservePercent.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(pct) || Number(pct) > 10000) return { error: "Minimum reserve is a percentage of obligations, like 20 or 12.5." };
  const floor = f.reserveFloor.trim() === "" || f.reserveFloor.trim() === "0" ? 0 : parseUsd(f.reserveFloor);
  if (floor === null) return { error: "The reserve floor is a dollar amount (0 for none)." };
  if (!/^\d{1,4}$/.test(f.noticeDays.trim()) || Number(f.noticeDays) > 3650) return { error: "The notice period is a whole number of days, 0 to 3650." };
  const min = parseUsd(f.minCommit);
  const max = parseUsd(f.maxCommit);
  if (min === null || max === null) return { error: "Commitment limits are dollar amounts above zero." };
  if (min > max) return { error: "The smallest commitment can't be more than the largest." };
  // Name the sponsor only when more than one sponsors the same component.
  const several = options.filter((o) => o.productId === f.option!.productId && o.componentKey === f.option!.componentKey).length > 1;
  return {
    product_id: f.option.productId,
    component_key: f.option.componentKey,
    name: f.name.trim().slice(0, 200),
    sandbox: f.sandbox,
    min_reserve_bps: Math.round(Number(pct) * 100),
    min_reserve_floor_cents: floor,
    notice_period_days: Number(f.noticeDays),
    min_commitment_cents: min,
    max_commitment_cents: max,
    ...(several ? { sponsor_entity_id: f.option.sponsorId } : {}),
  };
}

// ---- committing and withdrawing ----

// Why a commitment of `amount` cents can't be sent from here, or null. Mynt checks again (health,
// the rail, the state, the limits as they stand), so passing this isn't a promise.
// Why the pool can't take a commitment at all right now, whatever the amount, or null.
export function poolCommitBlock(p: Pool, position: Position | null | undefined): string | null {
  const stage = stageOf(p);
  if (stage === "awaiting_approval") return "This pool isn't approved yet: its sponsoring licence provider must approve it and name its money rails first.";
  if (stage === "uncleared") return `${STAGE_LABELS.uncleared}. A Mynt admin must clear this pool's offering before it takes real money.`;
  if (!railsApproved(p)) return "This pool has no approved money rails yet.";
  if (p.status === "closed") return "This pool is closed to new commitments.";
  if (p.status === "paused" && p.pauseKind !== "health") return `This pool is paused${p.pauseReason ? `: ${p.pauseReason}` : ""}.`;
  if (position && position.settledCents + position.pendingInCents >= p.maxCommitmentCents) return `Your position is at this pool's limit of ${usd(p.maxCommitmentCents)} per firm.`;
  return null;
}

export function commitRefusal(p: Pool, position: Position | null | undefined, amount: number | null): string | null {
  const blocked = poolCommitBlock(p, position);
  if (blocked) return blocked;
  if (amount === null || amount <= 0) return "Enter an amount in dollars.";
  const current = position ? position.settledCents + position.pendingInCents : 0;
  if (current + amount > p.maxCommitmentCents)
    return `That would take your position to ${usd(current + amount)}, over this pool's limit of ${usd(p.maxCommitmentCents)} per firm.`;
  if (current + amount < p.minCommitmentCents) return `A firm's position in this pool must be at least ${usd(p.minCommitmentCents)}.`;
  return null;
}

export function withdrawalRefusal(position: Position | null | undefined, amount: number | null): string | null {
  if (!position || position.availableCents <= 0) return "Nothing in this pool is available to withdraw: only settled capital not already on its way out or queued.";
  if (amount === null || amount <= 0) return "Enter an amount in dollars.";
  if (amount > position.availableCents) return `You can ask for at most ${usd(position.availableCents)} from this pool right now.`;
  return null;
}

// The rules of the withdrawal queue, in words, for the request form.
export const withdrawalTerms = (noticeDays: number | null) =>
  `Requests are paid first in, first out${noticeDays ? `, no sooner than ${noticeText(noticeDays).toLowerCase()} after you ask (the pool's notice period)` : ""}, and only as far as the pool's latest verified health snapshot keeps it above its minimum reserve, so a request may be paid in part, or wait. Money comes back on the pool's approved withdrawal rail; Mynt never holds it.`;

export const US_STATE_CODES = "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy".split(" ").map((s) => `us-${s}`);

// ---- the page ----

export type PoolRow = Pool & { queueLength: number | null; health: PoolHealth | null };

export type LiquidityData = {
  supported: boolean;
  access: LiquidityAccess;
  builder?: { pools: PoolRow[]; proposable: Sponsored[] | null; withdrawalsShown: boolean };
  provider?: { pools: PoolRow[]; positions: Position[]; withdrawals: Withdrawal[]; canCommit: boolean; canWithdraw: boolean };
};

export type PoolFilters = { query: string; productLine: string; stage: "" | PoolStage; money: "" | "sandbox" | "real" };
export const NO_POOL_FILTERS: PoolFilters = { query: "", productLine: "", stage: "", money: "" };
export function filterPools<T extends Pool>(pools: T[], f: PoolFilters): T[] {
  const q = f.query.trim().toLowerCase();
  return pools.filter(
    (p) =>
      (!q || [p.name, p.productName, p.productId, p.productLine, p.componentKey].some((v) => v?.toLowerCase().includes(q))) &&
      (!f.productLine || p.productLine === f.productLine) &&
      (!f.stage || stageOf(p) === f.stage) &&
      (!f.money || (f.money === "sandbox") === p.sandbox),
  );
}

export const PAGE_SIZE = 10;
export function pageOf<T>(items: T[], page: number, size = PAGE_SIZE): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(0, page), pages - 1);
  return { items: items.slice(p * size, p * size + size), page: p, pages };
}
