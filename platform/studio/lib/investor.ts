// The dashboard's investor view, for liquidity providers: what the user has put into pools, what
// is settled, queued and paid out, per deposit, what comes up in the next 30 days, and capital in
// against paid out per period. Built from Earn's data (lib/liquidity-server.ts): list_my_positions
// (rails rows, and on-chain devnet rows with their deposits and requests), list_withdrawals and
// list_pools_with_health. Pure, for the page and the tests. Amounts are integer cents. Mynt
// doesn't measure returns, so they read "Not measured", never 0.
import type { Granularity, Range } from "./pnl";
import type { LiquidityAccess, PoolHealth, PoolRow, Position, Withdrawal } from "./liquidity";
import { WAITING } from "./liquidity";
import { usdcBaseUnitsToCents } from "./wallets";

// ---- which views the user's roles allow ----

export type DashboardMode = "builder" | "investor";
export const MODE_LABELS: Record<DashboardMode, string> = { builder: "Builder", investor: "Investor" };

/** Builder for developers and innovators, Investor for liquidity providers; only those allowed. */
export function modesFor(a: LiquidityAccess | null): DashboardMode[] {
  if (!a) return ["builder"];
  const modes: DashboardMode[] = [...(a.builder ? (["builder"] as const) : []), ...(a.liquidityProvider ? (["investor"] as const) : [])];
  return modes.length ? modes : ["builder"];
}

export const MODE_KEY = "mynt.dashboard.mode";
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const storage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};
const keyFor = (owner: string | null) => (owner ? `${MODE_KEY}.${owner}` : MODE_KEY);

/** The view last picked by this user in this browser, if their roles still allow it. */
export function rememberedMode(allowed: DashboardMode[], owner: string | null = null, store: StorageLike | null = storage()): DashboardMode {
  try {
    const v = store?.getItem(keyFor(owner));
    if (v === "builder" || v === "investor") if (allowed.includes(v)) return v;
  } catch {
    // storage blocked: the first allowed view
  }
  return allowed[0];
}
export function rememberMode(mode: DashboardMode, owner: string | null = null, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(keyFor(owner), mode);
  } catch {
    // storage blocked: the choice lasts this visit only
  }
}

// ---- the portfolio ----

export type Source = "devnet" | "rails";
export const SOURCE_LABELS: Record<Source, string> = { devnet: "Devnet", rails: "Rails" };

export type Totals = { committed: number | null; settled: number | null; queued: number | null; paid: number | null };
// returns: what the portfolio was paid beyond its principal: on chain, the wind-down surplus claimed; rails pools can
// pay back no more than went in, so theirs is a real 0. Null when an on-chain position's surplus is unknown.
export type Portfolio = { all: Totals; bySource: Partial<Record<Source, Totals>>; returns: number | null };

export type DepositStatus = "in_review" | "locked" | "available" | "queued" | "rejected" | "committed" | "exited";
export type DepositRow = {
  key: string;
  poolId: string;
  poolName: string;
  source: Source;
  amountCents: number | null;
  remainingCents: number | null;
  status: DepositStatus;
  until: string | null; // review or lock end, for In review / Locked until …
  health: PoolHealth | null;
};

const sum = (xs: (number | null)[]): number | null => (xs.length && xs.every((x) => x !== null) ? xs.reduce<number>((n, x) => n + (x as number), 0) : xs.length ? null : 0);
const after = (iso: string | null, now: number) => (iso ? Date.parse(iso) > now : false);

export function depositStatus(d: Position["deposits"][number], now: number): { status: DepositStatus; until: string | null } {
  if (d.rejected) return { status: "rejected", until: null };
  if (after(d.reviewUntil, now)) return { status: "in_review", until: d.reviewUntil };
  if (!d.unlocked && after(d.unlockAt, now)) return { status: "locked", until: d.unlockAt };
  const free = d.remainingCents !== null && d.queuedCents !== null ? d.remainingCents - d.queuedCents : null;
  if ((d.queuedCents ?? 0) > 0 && (free === null || free <= 0)) return { status: "queued", until: null };
  return { status: "available", until: null };
}

function onChainTotals(p: Position): Totals {
  const live = p.deposits.filter((d) => !d.rejected);
  return {
    committed: sum(live.map((d) => d.amountCents)),
    settled: sum(live.map((d) => d.remainingCents)),
    queued: sum(p.requests.filter((r) => r.status === "open" || r.status === "parked").map((r) => r.remainingCents)),
    paid: sum(p.requests.map((r) => r.paidCents)),
  };
}
const railsTotals = (p: Position): Totals => ({ committed: p.committedCents, settled: p.settledCents, queued: p.queuedCents, paid: p.paidCents });
const add = (a: Totals, b: Totals): Totals => ({
  committed: a.committed === null || b.committed === null ? null : a.committed + b.committed,
  settled: a.settled === null || b.settled === null ? null : a.settled + b.settled,
  queued: a.queued === null || b.queued === null ? null : a.queued + b.queued,
  paid: a.paid === null || b.paid === null ? null : a.paid + b.paid,
});
const ZERO: Totals = { committed: 0, settled: 0, queued: 0, paid: 0 };

export function portfolioOf(positions: Position[]): Portfolio {
  const bySource: Partial<Record<Source, Totals>> = {};
  for (const p of positions) {
    const source: Source = p.onChain ? "devnet" : "rails";
    bySource[source] = add(bySource[source] ?? ZERO, p.onChain ? onChainTotals(p) : railsTotals(p));
  }
  const all = Object.values(bySource).reduce<Totals>((t, s) => add(t, s), ZERO);
  const surplus = positions.filter((p) => p.onChain).map((p) => (p.chain && p.chain.surplusClaimed !== null ? usdcBaseUnitsToCents(p.chain.surplusClaimed) : null));
  const returns = surplus.some((x) => x === null) ? null : surplus.reduce<number>((n, x) => n + (x as number), 0);
  return { all, bySource, returns };
}

export function depositRows(positions: Position[], pools: PoolRow[], now: number): DepositRow[] {
  const byId = new Map(pools.map((p) => [p.id, p]));
  return positions.flatMap((p): DepositRow[] => {
    const health = byId.get(p.poolId)?.health ?? null;
    if (p.onChain)
      return p.deposits.map((d) => {
        const s = depositStatus(d, now);
        return { key: d.deposit, poolId: p.poolId, poolName: p.name, source: "devnet", amountCents: d.amountCents, remainingCents: d.remainingCents, status: s.status, until: s.until, health };
      });
    const status: DepositStatus = p.exited ? "exited" : p.queuedCents > 0 && p.availableCents === 0 ? "queued" : p.availableCents > 0 ? "available" : "committed";
    return [{ key: `rails-${p.poolId}`, poolId: p.poolId, poolName: p.name, source: "rails", amountCents: p.committedCents, remainingCents: p.settledCents, status, until: null, health }];
  });
}

export const STATUS_LABELS: Record<DepositStatus, string> = {
  in_review: "In review",
  locked: "Locked",
  available: "Available",
  queued: "Queued",
  rejected: "Rejected",
  committed: "Committed",
  exited: "Exited",
};
export const statusText = (r: Pick<DepositRow, "status" | "until">) =>
  r.until && (r.status === "locked" || r.status === "in_review") ? `${r.status === "locked" ? "Locked until" : "In review until"} ${r.until.slice(0, 10)}` : STATUS_LABELS[r.status];

// ---- coming up: the next 30 days ----

export const COMING_UP_DAYS = 30;
export type ComingUp = { key: string; at: string; kind: "unlock" | "review_ends" | "payable"; poolId: string; poolName: string; source: Source; amountCents: number | null };

export function comingUp(positions: Position[], withdrawals: Withdrawal[], now: number, days = COMING_UP_DAYS): ComingUp[] {
  const end = now + days * 86_400_000;
  const inWindow = (iso: string | null) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return !Number.isNaN(t) && t > now && t <= end;
  };
  const out: ComingUp[] = [];
  for (const p of positions.filter((x) => x.onChain)) {
    for (const d of p.deposits.filter((x) => !x.rejected)) {
      if (inWindow(d.reviewUntil)) out.push({ key: `${d.deposit}-review`, at: d.reviewUntil!, kind: "review_ends", poolId: p.poolId, poolName: p.name, source: "devnet", amountCents: d.remainingCents });
      if (!d.unlocked && inWindow(d.unlockAt)) out.push({ key: `${d.deposit}-unlock`, at: d.unlockAt!, kind: "unlock", poolId: p.poolId, poolName: p.name, source: "devnet", amountCents: d.remainingCents });
    }
    for (const r of p.requests.filter((x) => x.status === "open" || x.status === "parked"))
      if (inWindow(r.payableAt)) out.push({ key: `${r.address}-payable`, at: r.payableAt!, kind: "payable", poolId: p.poolId, poolName: p.name, source: "devnet", amountCents: r.remainingCents });
  }
  const names = new Map(positions.map((p) => [p.poolId, p.name]));
  for (const w of withdrawals.filter((x) => WAITING.has(x.status)))
    if (inWindow(w.eligibleAt)) out.push({ key: `${w.id}-payable`, at: w.eligibleAt!, kind: "payable", poolId: w.poolId, poolName: w.poolName ?? names.get(w.poolId) ?? "Pool", source: "rails", amountCents: w.amountCents - w.settledCents });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
export const COMING_UP_LABELS: Record<ComingUp["kind"], string> = { unlock: "Unlocks", review_ends: "Review ends", payable: "Withdrawal payable" };

// ---- capital in against paid out, per period ----

export type FlowPeriod = { start: string; end: string; revenue: number | null; costs: number | null; netIncome: number | null };

function periodStarts(granularity: Granularity, periods: Range, now: number): Date[] {
  const d = new Date(now);
  const starts: Date[] = [];
  if (granularity === "month") {
    for (let i = periods - 1; i >= 0; i--) starts.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)));
  } else {
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    for (let i = periods - 1; i >= 0; i--) starts.push(new Date(monday - i * 7 * 86_400_000));
  }
  return starts;
}

/**
 * Capital in (on-chain deposits by when they settled) and paid out (on-chain requests' paid
 * amounts, by when they became payable) per period. Rails positions carry no dated history, so
 * with only rails positions every period is a gap; with both, the figures are devnet's alone.
 */
export function flowSeries(positions: Position[], granularity: Granularity, periods: Range, now: number): { series: FlowPeriod[]; railsUnmeasured: boolean } {
  const onChain = positions.filter((p) => p.onChain);
  // Rails positions whose movements came with their settlement dates.
  const rails = positions.filter((p) => !p.onChain && Array.isArray(p.entries));
  const starts = periodStarts(granularity, periods, now);
  const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] : granularity === "month" ? new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1)) : new Date(s.getTime() + 7 * 86_400_000)));
  const series = starts.map((s, i): FlowPeriod => {
    const from = s.getTime();
    const to = ends[i].getTime();
    const within = (iso: string | null) => {
      const t = iso ? Date.parse(iso) : NaN;
      return !Number.isNaN(t) && t >= from && t < to;
    };
    if (!onChain.length && !rails.length) return { start: s.toISOString().slice(0, 10), end: ends[i].toISOString().slice(0, 10), revenue: null, costs: null, netIncome: null };
    const settledIn = (p: Position, kind: string) => (p.entries ?? []).filter((e) => e.kind === kind && within(e.settledAt)).map((e) => e.settledCents);
    const ins = [...onChain.flatMap((p) => p.deposits.filter((d) => !d.rejected && within(d.settledAt)).map((d) => d.amountCents)), ...rails.flatMap((p) => settledIn(p, "deposit"))];
    const outs = [...onChain.flatMap((p) => p.requests.filter((r) => within(r.payableAt)).map((r) => r.paidCents)), ...rails.flatMap((p) => settledIn(p, "withdrawal"))];
    const capitalIn = sum(ins);
    const paidOut = sum(outs);
    return { start: s.toISOString().slice(0, 10), end: ends[i].toISOString().slice(0, 10), revenue: capitalIn, costs: paidOut, netIncome: capitalIn === null || paidOut === null ? null : capitalIn - paidOut };
  });
  // Rails positions sent without their dated movements stay out of the chart, and the chart says so.
  return { series, railsUnmeasured: positions.some((p) => !p.onChain && !Array.isArray(p.entries)) };
}

// Needs attention items about investing: pools, positions, withdrawals or the treasury.
export const investingItem = (i: { kind?: string | null; href?: string | null }) =>
  /pool|position|withdraw|liquidity|treasury|deposit/i.test(i.kind ?? "") || (i.href ?? "").startsWith("/earn");

// ---- the visual view ----

/** Each pool's share of what's settled: the allocation donut (only pools with something in them). */
export function allocation(positions: Position[]): { key: string; label: string; value: number }[] {
  const by = new Map<string, { label: string; value: number }>();
  for (const p of positions) {
    const t = p.onChain ? onChainTotals(p) : railsTotals(p);
    if (t.settled === null || t.settled <= 0) continue;
    const cur = by.get(p.poolId) ?? { label: p.name, value: 0 };
    cur.value += t.settled;
    by.set(p.poolId, cur);
  }
  return [...by].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.value - a.value);
}

/** A deposit's road from settled to free: review, then lock-in, then available, with now on it. */
export type UnlockBar = { key: string; poolName: string; start: number; reviewEnd: number; unlock: number; end: number; now: number; status: DepositStatus };
export function unlockBars(positions: Position[], now: number): UnlockBar[] {
  return positions
    .filter((p) => p.onChain)
    .flatMap((p) =>
      p.deposits
        .filter((d) => !d.rejected && d.settledAt && d.unlockAt)
        .map((d) => {
          const start = Date.parse(d.settledAt!);
          const unlock = Date.parse(d.unlockAt!);
          const reviewEnd = d.reviewUntil ? Math.min(Date.parse(d.reviewUntil), unlock) : start;
          // The bar runs a little past the later of now and the unlock, so "available" shows.
          const end = Math.max(now, unlock) + Math.max(1, (unlock - start) * 0.15);
          return { key: d.deposit, poolName: p.name, start, reviewEnd, unlock, end, now, status: depositStatus(d, now).status };
        })
        .filter((b) => [b.start, b.unlock, b.reviewEnd].every(Number.isFinite)),
    );
}

export type HealthState = "healthy" | "at_risk" | "paused" | "unknown";
export const HEALTH_LABELS: Record<HealthState, string> = { healthy: "Healthy", at_risk: "At risk", paused: "Paused", unknown: "No verified snapshot" };
/** A held pool's health at a glance, from its latest snapshot and status (never guessed). */
export function healthState(pool: Pick<PoolRow, "status" | "pauseKind" | "health">): HealthState {
  if (pool.status === "paused" || pool.pauseKind) return "paused";
  const h = pool.health;
  if (!h || h.sequence === null) return "unknown";
  if (h.verified === false || (h.coverageBps !== null && h.coverageBps < 10_000) || (h.headroomCents !== null && h.headroomCents < 0)) return "at_risk";
  return h.verified ? "healthy" : "unknown";
}

// ---- the investor dashboard's toolbar: Pool, Source, Date range, search ----

// from / to: the first and last day the charts show, YYYY-MM-DD.
export type InvestorFilter = { poolId: string; source: Source | "all"; from: string; to: string; query: string };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// The last six months, every pool and source.
export function defaultInvestorFilter(now = new Date()): InvestorFilter {
  return { poolId: "all", source: "all", from: ymd(new Date(now.getFullYear(), now.getMonth() - 5, 1)), to: ymd(now), query: "" };
}
// The positions the toolbar keeps: one pool, else those whose pool name matches the search; then by source.
export function filterPositions<P extends { poolId: string; name: string; onChain: boolean }>(positions: readonly P[], f: InvestorFilter): P[] {
  const q = f.query.trim().toLowerCase();
  return positions.filter(
    (p) =>
      (f.poolId === "all" ? !q || p.name.toLowerCase().includes(q) : p.poolId === f.poolId) &&
      (f.source === "all" || (f.source === "devnet" ? p.onChain : !p.onChain)),
  );
}

// The investor's other figures: what's on its way in, what may be asked for now, and how many pools they hold
// (positions not exited). An amount Mynt doesn't report for a position leaves the total unmeasured.
export function positionExtras(positions: readonly Pick<Position, "poolId" | "pendingInCents" | "availableCents" | "exited">[]): { pendingIn: number | null; available: number | null; pools: number } {
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    pendingIn: sum(positions.map((p) => num(p.pendingInCents))),
    available: sum(positions.map((p) => num(p.availableCents))),
    pools: new Set(positions.filter((p) => !p.exited).map((p) => p.poolId)).size,
  };
}
