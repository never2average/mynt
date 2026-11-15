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
export const usdcText = (baseUnits: string) => `${decimal(baseUnits, 6, 6)} USDC`;
export const solText = (lamports: string) => `${decimal(lamports, 9, 4)} SOL`;
export const balancesText = (b: Balances | null) => (b ? `${usdcText(b.usdcBaseUnits)} · ${solText(b.solLamports)}` : "Balances unavailable");
// Pools count in integer cents; USDC has 6 decimals, so a cent is 10,000 base units.
export const centsToUsdcBaseUnits = (cents: number) => String(BigInt(cents) * 10_000n);

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

export type Treasury = { cluster: string; programId: string | null; poolAddress: string | null; verifiedBuild: boolean | null; lockInSeconds: number | null; noticeSeconds: number | null };

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
  };
}
export const onDevnet = (t: Treasury | null | undefined): t is Treasury => t?.cluster === CLUSTER;

// What prepare_treasury_deposit and prepare_treasury_withdrawal answer: the unsigned transaction
// and Mynt's own summary of it, which is what the user confirms (never the assistant's words).
export type Prepared = {
  cluster: typeof CLUSTER;
  transactionBase64: string;
  expiresAt: string | null;
  summary: { pool: string; amount: string; lockInSeconds: number | null; noticeSeconds: number | null; wallet: string };
};
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
  const amount = units(s.amount);
  return {
    cluster: CLUSTER,
    transactionBase64: tx,
    expiresAt: str(reply.expires_at),
    summary: { pool: str(s.pool) ?? "", amount: amount !== null ? usdcText(amount) : (str(s.amount) ?? "—"), lockInSeconds: secs(s.lock_in_seconds), noticeSeconds: secs(s.notice_seconds), wallet: summaryWallet },
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

export type TxStatus = { status: "pending" | "confirmed" | "failed"; error: string | null };
export function txStatusFrom(reply: unknown): TxStatus | null {
  if (!isObj(reply)) return null;
  const s = reply.status;
  return s === "pending" || s === "confirmed" || s === "failed" ? { status: s, error: str(reply.error) } : null;
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
