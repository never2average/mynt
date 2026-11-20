// Earn's wallets: the user's verified linked wallets (get_linked_accounts), their live devnet
// balances (get_wallet_balances), the one the user picked in the chat bar, and the on-chain
// treasury deposits and withdrawals they sign in their own browser wallet. Pure, for the routes,
// the page and the tests. Mynt never signs and never holds keys; the studio only passes Mynt's
// unsigned transaction to the user's wallet untouched. Devnet only: mainnet is never offered.
import { networkOf, UNKNOWN_NETWORK } from "./linked-accounts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

// The only Solana cluster Earn offers.
export const CLUSTER = "devnet" as const;
export const DEVNET_CHAIN = "solana:devnet" as const;
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A transaction signature, base58 (64 bytes: 64 to 88 characters).
export const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
// The largest Solana transaction (one packet).
export const MAX_TX_BYTES = 1232;

// ---- linked wallets ----

export type Balances = { solLamports: string; usdcBaseUnits: string };
export type EarnWallet = {
  address: string;
  chain: "solana" | "ethereum" | null;
  network: string; // "Solana", "EVM", ... or "Unknown network"
  balances: Balances | null; // devnet, Solana wallets only; null when Mynt couldn't say
};
export type EarnWallets = {
  supported: boolean; // Mynt has get_linked_accounts
  balancesSupported: boolean; // ... and get_wallet_balances
  owner: string | null; // whose list this is (a hash of the user, for remembering the choice per user)
  wallets: EarnWallet[];
  manageUrl: string | null;
  treasury: { deposit: boolean; withdraw: boolean; status: boolean }; // which treasury tools Mynt offers
};
export const NO_WALLETS: EarnWallets = { supported: false, balancesSupported: false, owner: null, wallets: [], manageUrl: null, treasury: { deposit: false, withdraw: false, status: false } };

// Every verified wallet in get_linked_accounts' reply, at most 10, no repeats. A wallet the reply
// marks verified: false is left out (Mynt lists verified ones only; this keeps it that way).
export function walletsFrom(reply: unknown): { address: string; chain: EarnWallet["chain"]; network: string }[] {
  const r = isObj(reply) ? reply : {};
  const seen = new Set<string>();
  const out: { address: string; chain: EarnWallet["chain"]; network: string }[] = [];
  for (const w of Array.isArray(r.wallets) ? r.wallets : []) {
    if (!isObj(w) || w.verified === false) continue;
    const address = str(w.address);
    if (!address || seen.has(address)) continue;
    const network = networkOf(address, str(w.chain));
    const chain = network === "Solana" ? "solana" : network === UNKNOWN_NETWORK ? null : "ethereum";
    seen.add(address);
    out.push({ address, chain, network });
    if (out.length >= 10) break;
  }
  return out;
}

const units = (v: unknown): string | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? String(v) : typeof v === "string" && /^\d{1,30}$/.test(v) ? v.replace(/^0+(?=\d)/, "") : null);

// get_wallet_balances' reply, or null when it isn't one.
export function balancesFrom(reply: unknown): Balances | null {
  if (!isObj(reply)) return null;
  const sol = units(reply.sol_lamports);
  const usdc = units(reply.usdc_base_units);
  return sol !== null && usdc !== null ? { solLamports: sol, usdcBaseUnits: usdc } : null;
}

// Whole base units as a decimal: 12500000 with 6 decimals is "12.5".
function decimal(baseUnits: string, decimals: number, maxFraction: number): string {
  const n = BigInt(baseUnits);
  const scale = 10n ** BigInt(decimals);
  const whole = (n / scale).toLocaleString("en-US");
  const frac = (n % scale).toString().padStart(decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
export const usdcText = (baseUnits: string | bigint) => `${decimal(String(baseUnits), 6, 6)} USDC`;
export const solText = (lamports: string) => `${decimal(lamports, 9, 4)} SOL`;
export const balancesText = (b: Balances | null) => (b ? `${usdcText(b.usdcBaseUnits)} · ${solText(b.solLamports)}` : "Balances unavailable");
// Pools count in integer cents; USDC has 6 decimals, so a cent is 10,000 base units.
export const centsToUsdcBaseUnits = (cents: number) => String(BigInt(cents) * 10_000n);
// Base units to whole cents, rounded down (what may be asked for is never overstated).
export const usdcBaseUnitsToCents = (units: bigint) => Number(units / 10_000n);

// USDC base units as Mynt sends them: a number while it's exact, a decimal string above 2^53.
// Parsed with BigInt, never through a float; null for anything else.
export function baseUnitsOf(v: unknown): bigint | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === "bigint") return v >= 0n ? v : null;
  if (typeof v === "string" && /^\d{1,40}$/.test(v.trim())) return BigInt(v.trim());
  return null;
}

// "12.5" or "1,000.000001" USDC, as typed, to base units; null if it isn't a positive amount with
// at most 6 decimals.
export function parseUsdc(input: string): bigint | null {
  const t = input.trim().replace(/\s*USDC$/i, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const n = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
  return n > 0n ? n : null;
}

// ---- the chosen wallet, remembered per user in this browser ----

export const CHOSEN_KEY = "mynt.earn.wallet";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
const storage = (): StorageLike | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};
function readMap(s: StorageLike | null): Record<string, string> {
  try {
    const v = JSON.parse(s?.getItem(CHOSEN_KEY) ?? "{}") as unknown;
    return isObj(v) ? (Object.fromEntries(Object.entries(v).filter(([, a]) => typeof a === "string")) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
// The wallet this user picked before, if it's still one of theirs; else their first Solana wallet,
// else their first wallet, else none.
export function chosenWallet(list: EarnWallets, s: StorageLike | null = storage()): EarnWallet | null {
  const remembered = list.owner ? readMap(s)[list.owner] : undefined;
  return list.wallets.find((w) => w.address === remembered) ?? list.wallets.find((w) => w.chain === "solana") ?? list.wallets[0] ?? null;
}
export function rememberWallet(owner: string | null, address: string, s: StorageLike | null = storage()): void {
  if (!owner || !s) return;
  try {
    s.setItem(CHOSEN_KEY, JSON.stringify({ ...readMap(s), [owner]: address }));
  } catch {
    // Private windows and blocked storage: the choice lasts for this page only.
  }
}

// ---- on-chain treasuries ----

// attestersFlag: why Mynt stopped approving deposits (the pool's approvers changed on chain), else null.
export type Treasury = { cluster: string; programId: string | null; poolAddress: string | null; verifiedBuild: boolean | null; lockInSeconds: number | null; noticeSeconds: number | null; minRequest: bigint | null; attestersFlag: string | null };

// list_pools' treasury, when the pool has one.
export function treasuryFrom(v: unknown): Treasury | null {
  if (!isObj(v)) return null;
  const cluster = str(v.cluster);
  if (!cluster) return null;
  const terms = isObj(v.on_chain_terms) ? v.on_chain_terms : {};
  const secs = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  return {
    cluster,
    programId: str(v.program_id),
    poolAddress: str(v.pool_address),
    verifiedBuild: typeof v.verified_build === "boolean" ? v.verified_build : null,
    lockInSeconds: secs(terms.lock_in_seconds),
    noticeSeconds: secs(terms.notice_seconds),
    minRequest: baseUnitsOf(terms.min_request),
    attestersFlag: str(v.attesters_flag),
  };
}
export const onDevnet = (t: Treasury | null | undefined): t is Treasury => t?.cluster === CLUSTER;
export const DEPOSITS_PAUSED = "This pool's approvers changed; deposits are paused until its builder re-registers it.";

// ---- on-chain positions (list_my_positions rows with source "on-chain", one per pool and wallet) ----

export type OnChainDeposit = {
  deposit: string; // the deposit record's address: what prepare_treasury_withdrawal takes
  seq: string | null;
  amount: bigint;
  remaining: bigint;
  queued: bigint;
  settledAt: string | null;
  reviewUntil: string | null;
  unlocksAt: string | null;
  lockInSeconds: number | null;
  unlocked: boolean;
  rejected: boolean;
  signature: string | null;
};
export type OnChainRequest = { address: string; deposit: string | null; seq: string | null; amount: bigint; remaining: bigint; paid: bigint; payableAt: string | null; status: string; signature: string | null };
// surplusClaimed: the wind-down surplus the wallet was paid (the treasury's only return); null when Mynt can't say.
export type OnChainPosition = { wallet: string; principal: bigint; deposited: bigint; paid: bigint; queued: bigint; availableToRequest: bigint; surplusClaimed: bigint | null; deposits: OnChainDeposit[]; requests: OnChainRequest[] };

const big0 = (v: unknown) => baseUnitsOf(v) ?? 0n;

// JSON can't carry a bigint, so the studio's routes send these amounts as decimal strings
// (lib/studio-route.ts json). The browser turns an on-chain position back into exact bigints.
type Raw = Record<string, unknown>;
export function reviveOnChainPosition(c: unknown): OnChainPosition | null {
  if (!c || typeof c !== "object") return null;
  const r = c as Raw;
  const list = (v: unknown) => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Raw[]) : []);
  return {
    ...(r as unknown as OnChainPosition),
    principal: big0(r.principal),
    deposited: big0(r.deposited),
    paid: big0(r.paid),
    queued: big0(r.queued),
    availableToRequest: big0(r.availableToRequest),
    surplusClaimed: r.surplusClaimed == null ? null : big0(r.surplusClaimed),
    deposits: list(r.deposits).map((d) => ({ ...(d as unknown as OnChainDeposit), amount: big0(d.amount), remaining: big0(d.remaining), queued: big0(d.queued) })),
    requests: list(r.requests).map((q) => ({ ...(q as unknown as OnChainRequest), amount: big0(q.amount), remaining: big0(q.remaining), paid: big0(q.paid) })),
  };
}
export function onChainPositionFrom(row: Record<string, unknown>): OnChainPosition | null {
  const wallet = str(row.wallet);
  if (!wallet) return null;
  const deposits = (Array.isArray(row.deposits) ? row.deposits : []).filter(isObj).flatMap((d): OnChainDeposit[] => {
    const deposit = str(d.deposit) ?? str(d.address);
    if (!deposit) return [];
    const lock = typeof d.lock_in_seconds === "number" && Number.isFinite(d.lock_in_seconds) ? d.lock_in_seconds : null;
    return [{ deposit, seq: baseUnitsOf(d.seq)?.toString() ?? null, amount: big0(d.amount), remaining: big0(d.remaining), queued: big0(d.queued), settledAt: str(d.settled_at), reviewUntil: str(d.review_until), unlocksAt: str(d.unlocks_at) ?? str(d.unlock_at), lockInSeconds: lock, unlocked: d.unlocked === true, rejected: d.rejected === true, signature: str(d.signature) }];
  });
  const requests = (Array.isArray(row.requests) ? row.requests : []).filter(isObj).flatMap((r): OnChainRequest[] => {
    const address = str(r.address);
    return address ? [{ address, deposit: str(r.deposit), seq: baseUnitsOf(r.seq)?.toString() ?? null, amount: big0(r.amount), remaining: big0(r.remaining), paid: big0(r.paid), payableAt: str(r.payable_at), status: str(r.status) ?? "unknown", signature: str(r.signature) }] : [];
  });
  return {
    wallet,
    principal: big0(row.principal),
    deposited: big0(row.deposited),
    paid: big0(row.paid),
    queued: big0(row.queued),
    availableToRequest: big0(row.available_to_request),
    surplusClaimed: row.surplus_claimed == null ? null : baseUnitsOf(row.surplus_claimed),
    deposits,
    requests,
  };
}

// Where one deposit stands: refused (and refunded), in its review window, locked in, fully
// queued, or available to ask for (what's left, less what's already queued).
export type DepositStanding = { kind: "rejected" | "in_review" | "locked" | "queued" | "available" | "empty"; free: bigint; until: string | null };
const past = (iso: string | null, now: number) => !iso || !Number.isFinite(Date.parse(iso)) || Date.parse(iso) <= now;
export function depositStanding(d: OnChainDeposit, now = Date.now()): DepositStanding {
  const free = d.remaining > d.queued ? d.remaining - d.queued : 0n;
  if (d.rejected) return { kind: "rejected", free: 0n, until: null };
  if (!past(d.reviewUntil, now)) return { kind: "in_review", free, until: d.reviewUntil };
  if (!d.unlocked && !past(d.unlocksAt, now)) return { kind: "locked", free, until: d.unlocksAt };
  if (d.remaining === 0n) return { kind: "empty", free: 0n, until: null };
  if (free === 0n) return { kind: "queued", free, until: null };
  return { kind: "available", free, until: null };
}
const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");
export function standingText(s: DepositStanding): string {
  switch (s.kind) {
    case "rejected":
      return "Refused and refunded";
    case "in_review":
      return `In review until ${day(s.until)}`;
    case "locked":
      return `Locked until ${day(s.until)}`;
    case "queued":
      return "All of it queued for withdrawal";
    case "empty":
      return "Withdrawn";
    default:
      return "Available";
  }
}

// ---- Mynt's treasury refusals, in plain words ----

export const TREASURY_REFUSALS: Record<string, string> = {
  wallet_not_linked: "That wallet isn't one of the verified Solana wallets linked to your sign-in. Link it on your account page first.",
  not_liquidity_provider: "Only a liquidity provider can deposit to or withdraw from a pool.",
  offering_not_cleared: "This pool isn't cleared for commitments yet: a Mynt admin must clear its offering first.",
  over_limit: "That's over this pool's limit. Try a smaller amount.",
  under_minimum: "That's under this pool's minimum. Try a larger amount.",
  pool_paused: "This pool isn't taking deposits right now.",
  not_on_chain: "This pool moves money on its approved rails, not on-chain.",
  mainnet_disabled: "Only devnet is offered.",
  terms_changed: "The pool's terms changed since you looked: its lock-in or notice period is now longer than the one shown. Check the pool again before depositing.",
  insufficient_usdc: "Your wallet doesn't hold enough devnet USDC for that amount.",
  attester_removed: "This pool no longer lets Mynt approve deposits, so a deposit can't be prepared. Its builder needs to fix the treasury.",
  rpc_unavailable: "Mynt couldn't reach devnet just now. Please try again in a minute.",
  deposit_not_found: "Mynt can't find that deposit on devnet. Your positions may still be catching up; try again shortly.",
  deposit_rejected: "That deposit was refused and refunded, so there's nothing to withdraw from it.",
  in_review: "That deposit is still in its review window.",
  deposit_locked: "That deposit is still locked in.",
  below_min_request: "That's under this pool's smallest withdrawal request. Try a larger amount.",
  attesters_changed: "This pool's approvers changed; deposits are paused until its builder re-registers it.",
  unexpected_attesters: "This pool's treasury names approvers other than Mynt's, so Mynt can't register it. Its builder must set its approvers to Mynt's alone.",
  not_pool_owner: "Only the builder of this pool's product can register its treasury.",
  wrong_cluster: "That treasury isn't on devnet. Only devnet is offered.",
  rate_limited: "Too many requests — try again in a minute.",
};
// The refusal Mynt sent ({"error": "...", "code": "...", ...}) as plain words, with the date
// it names where it names one; null when it isn't a coded refusal.
export function treasuryRefusal(raw: string): { code: string; message: string } | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(data) || typeof data.code !== "string") return null;
  const code = data.code;
  let message = TREASURY_REFUSALS[code];
  if (!message) return null;
  const when = code === "in_review" ? str(data.review_until) : code === "deposit_locked" ? str(data.unlock_at) : null;
  if (when) message = message.replace(/\.$/, ` until ${day(when)}.`);
  return { code, message };
}

// What prepare_treasury_deposit and prepare_treasury_withdrawal answer: the unsigned transaction
// and Mynt's own summary of it, which is what the user confirms (never the assistant's words).
export type Prepared = {
  cluster: typeof CLUSTER;
  transactionBase64: string;
  expiresAt: string | null;
  lastValidBlockHeight: number | null; // the blockhash's last block: about a minute after preparing
  summary: { pool: string; amount: string; lockInSeconds: number | null; noticeSeconds: number | null; reviewWindowSeconds: number | null; wallet: string; verifiedBuild: boolean | null };
};
// How long a prepared transaction's blockhash is trusted before signing: it lasts about a minute,
// so after this the page prepares it again first.
export const BLOCKHASH_FRESH_MS = 45_000;
// Two preparations of the same request say the same thing (pool, amount, wallet and terms), so a
// refreshed one can be signed without asking again.
export const sameSummary = (a: Prepared["summary"], b: Prepared["summary"]) =>
  a.pool === b.pool && a.amount === b.amount && a.wallet === b.wallet && a.lockInSeconds === b.lockInSeconds && a.noticeSeconds === b.noticeSeconds && a.reviewWindowSeconds === b.reviewWindowSeconds;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const base64Bytes = (s: string) => (s.length % 4 === 0 ? (s.length / 4) * 3 - (s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0) : -1);

// Mynt's reply, checked: devnet only, a transaction that fits a Solana packet, and a summary for
// the wallet that was asked for. Anything else is refused rather than shown.
export function preparedFrom(reply: unknown, wallet: string): Prepared | { error: string } {
  if (!isObj(reply)) return { error: "Mynt didn't return a transaction." };
  if (reply.cluster !== CLUSTER) return { error: "Mynt offered a transaction that isn't on devnet, so it wasn't shown. Only devnet is offered." };
  const tx = str(reply.transaction_base64);
  const size = tx && BASE64.test(tx) ? base64Bytes(tx) : -1;
  if (!tx || size <= 0 || size > MAX_TX_BYTES) return { error: "Mynt's transaction wasn't one a wallet can sign." };
  const s = isObj(reply.summary) ? reply.summary : null;
  const summaryWallet = s ? str(s.wallet) : null;
  if (!s || summaryWallet !== wallet) return { error: "Mynt's summary didn't name your chosen wallet, so the transaction wasn't shown." };
  const secs = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : null);
  const amount = baseUnitsOf(s.amount);
  return {
    cluster: CLUSTER,
    transactionBase64: tx,
    expiresAt: str(reply.expires_at),
    lastValidBlockHeight: secs(reply.last_valid_block_height),
    summary: {
      pool: str(s.pool) ?? "",
      amount: amount !== null ? usdcText(amount) : "—",
      lockInSeconds: secs(s.lock_in_seconds),
      noticeSeconds: secs(s.notice_seconds),
      reviewWindowSeconds: secs(s.review_window_seconds),
      wallet: summaryWallet,
      verifiedBuild: typeof s.verified_build === "boolean" ? s.verified_build : null,
    },
  };
}

export const durationText = (seconds: number | null) => {
  if (seconds === null) return "Not stated";
  if (seconds === 0) return "None";
  const days = seconds / 86_400;
  if (Number.isInteger(days)) return `${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.round(seconds / 3600);
  return hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${seconds} seconds`;
};

// get_treasury_tx_status: not_found (not seen yet, normal just after sending), processed,
// confirmed, finalized or failed. The page waits on the first two and stops on the rest.
export type TxStatus = { status: "pending" | "confirmed" | "failed"; stage: "not_found" | "processed" | "confirmed" | "finalized" | "failed"; error: string | null };
export function txStatusFrom(reply: unknown): TxStatus | null {
  if (!isObj(reply)) return null;
  const s = reply.status;
  const error = typeof reply.error === "string" ? str(reply.error) : reply.error ? "The transaction failed on devnet." : null;
  if (s === "not_found" || s === "processed") return { status: "pending", stage: s, error: null };
  if (s === "confirmed" || s === "finalized") return { status: "confirmed", stage: s, error: null };
  if (s === "failed") return { status: "failed", stage: s, error };
  return null;
}

// A link to the transaction in a block explorer, only when the studio is told one: the address is
// NEXT_PUBLIC_SOLANA_EXPLORER_TX_URL with {signature} in it (and ?cluster=devnet is added).
export function explorerTxUrl(signature: string, template: string | undefined = process.env.NEXT_PUBLIC_SOLANA_EXPLORER_TX_URL): string | null {
  if (!template || !template.includes("{signature}") || !SIGNATURE.test(signature)) return null;
  try {
    const u = new URL(template.replace("{signature}", signature));
    if (u.protocol !== "https:") return null;
    u.searchParams.set("cluster", CLUSTER);
    return u.toString();
  } catch {
    return null;
  }
}
