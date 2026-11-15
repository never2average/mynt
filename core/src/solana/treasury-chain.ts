import { anchorDiscriminator, base58Decode, base58Encode, findProgramAddress, Keypair, pubkeyBytes } from "./codec.js";
import { SYSTEM_PROGRAM, shortVec, type AccountMeta, type Instruction } from "./tx.js";
import { GENESIS_HASH } from "./rpc.js";

// The per-app treasury program (workspaces/coding-build/templates/solana-treasury, program mynt_treasury) from
// Mynt's side: its account layouts, its events, the deposit and request_withdrawal instructions, the Ed25519
// attestation it checks before a deposit, and the v0 transactions Mynt prepares for a person's own wallet to sign.
//
// Mynt never signs for anyone's funds. The only Mynt key here is the attester, which signs one thing: the domain-tagged
// deposit approval the program reads from the Ed25519 instruction before `deposit`. It holds no funds, pays no fees and
// is never an account of any transaction.

export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111";
export const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
// Circle's USDC on devnet; SOLANA_DEVNET_USDC_MINT overrides it.
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const ZERO_KEY = "11111111111111111111111111111111";

export const DEPOSIT_APPROVAL_DOMAIN = Buffer.from("MYNTDEP2", "ascii");
// The longest a deposit approval may live.
export const MAX_APPROVAL_SECONDS = 600;

export const REQUEST_STATUS = ["open", "paid", "cancelled", "voided", "parked"] as const;
export type RequestStatus = (typeof REQUEST_STATUS)[number];

const u64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64le = (n: bigint | number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const u16le = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};

// "MYNTDEP2" ‖ program id ‖ cluster (genesis hash) ‖ pool ‖ depositor ‖ nonce (u64 LE) ‖ expiry (i64 LE): 152 bytes,
// exactly what deposit_approval_message in the program builds.
export function depositApprovalMessage(o: { programId: string; cluster: Uint8Array; pool: string; depositor: string; nonce: bigint | number; expiry: bigint | number }): Uint8Array {
  if (o.cluster.length !== 32) throw new Error("The cluster is its 32-byte genesis hash");
  return Uint8Array.from(Buffer.concat([DEPOSIT_APPROVAL_DOMAIN, pubkeyBytes(o.programId), Buffer.from(o.cluster), pubkeyBytes(o.pool), pubkeyBytes(o.depositor), u64le(o.nonce), i64le(o.expiry)]));
}

// The Ed25519 precompile's instruction for one signature, laid out as web3.js's Ed25519Program writes it: a 16-byte
// header whose three instruction indexes are u16::MAX (read from this instruction itself, as the program requires),
// then the public key, the signature and the message.
export function ed25519Instruction(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Instruction {
  if (publicKey.length !== 32 || signature.length !== 64) throw new Error("An Ed25519 key is 32 bytes and a signature 64");
  const pkOffset = 16;
  const sigOffset = pkOffset + 32;
  const msgOffset = sigOffset + 64;
  const header = Buffer.concat([Buffer.from([1, 0]), u16le(sigOffset), u16le(0xffff), u16le(pkOffset), u16le(0xffff), u16le(msgOffset), u16le(message.length), u16le(0xffff)]);
  return { programId: ED25519_PROGRAM, keys: [], data: Uint8Array.from(Buffer.concat([header, Buffer.from(publicKey), Buffer.from(signature), Buffer.from(message)])) };
}

// What the program's parse_ed25519_ix reads back (one signature, everything from this instruction); null otherwise.
export function parseEd25519Instruction(data: Uint8Array): { publicKey: Uint8Array; signature: Uint8Array; message: Uint8Array } | null {
  const b = Buffer.from(data);
  if (b.length < 16 || b[0] !== 1) return null;
  if (b.readUInt16LE(4) !== 0xffff || b.readUInt16LE(8) !== 0xffff || b.readUInt16LE(14) !== 0xffff) return null;
  const sig = b.readUInt16LE(2);
  const pk = b.readUInt16LE(6);
  const msg = b.readUInt16LE(10);
  const size = b.readUInt16LE(12);
  if (sig + 64 > b.length || pk + 32 > b.length || msg + size > b.length) return null;
  return { publicKey: Uint8Array.from(b.subarray(pk, pk + 32)), signature: Uint8Array.from(b.subarray(sig, sig + 64)), message: Uint8Array.from(b.subarray(msg, msg + size)) };
}

// ---- addresses ----

const seed = (s: string) => Buffer.from(s, "utf8");
export const poolAddress = (programId: string, creator: string, poolId: bigint | number) => findProgramAddress([seed("pool"), pubkeyBytes(creator), u64le(poolId)], programId)[0];
export const positionAddress = (programId: string, pool: string, depositor: string) => findProgramAddress([seed("position"), pubkeyBytes(pool), pubkeyBytes(depositor)], programId)[0];
export const depositAddress = (programId: string, pool: string, seq: bigint | number) => findProgramAddress([seed("deposit"), pubkeyBytes(pool), u64le(seq)], programId)[0];
export const requestAddress = (programId: string, pool: string, seq: bigint | number) => findProgramAddress([seed("request"), pubkeyBytes(pool), u64le(seq)], programId)[0];
export const hookAddress = (programId: string, pool: string) => findProgramAddress([seed("hook"), pubkeyBytes(pool)], programId)[0];
export const associatedTokenAddress = (owner: string, mint: string) => findProgramAddress([pubkeyBytes(owner), pubkeyBytes(TOKEN_PROGRAM), pubkeyBytes(mint)], ASSOCIATED_TOKEN_PROGRAM)[0];

// ---- accounts ----

class Reader {
  o = 0;
  constructor(readonly b: Buffer) {}
  key() {
    return base58Encode(this.b.subarray(this.o, (this.o += 32)));
  }
  bytes(n: number) {
    return Uint8Array.from(this.b.subarray(this.o, (this.o += n)));
  }
  u64() {
    const v = this.b.readBigUInt64LE(this.o);
    this.o += 8;
    return v;
  }
  i64() {
    const v = this.b.readBigInt64LE(this.o);
    this.o += 8;
    return v;
  }
  u16() {
    const v = this.b.readUInt16LE(this.o);
    this.o += 2;
    return v;
  }
  u8() {
    return this.b[this.o++];
  }
  bool() {
    return this.b[this.o++] === 1;
  }
}

export interface Terms {
  lock_in_seconds: bigint;
  notice_seconds: bigint;
  min_reserve: bigint;
  min_reserve_bps: number;
  obligations_max_staleness: bigint;
  commitment_min: bigint;
  commitment_max: bigint;
  min_request: bigint;
  topups_when_health_paused: boolean;
  extension_program: string;
  attesters: [string, string];
  health_authority: string;
}
const TERMS_SIZE = 8 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1 + 32 + 64 + 32;
function readTerms(r: Reader): Terms {
  return {
    lock_in_seconds: r.i64(),
    notice_seconds: r.i64(),
    min_reserve: r.u64(),
    min_reserve_bps: r.u16(),
    obligations_max_staleness: r.i64(),
    commitment_min: r.u64(),
    commitment_max: r.u64(),
    min_request: r.u64(),
    topups_when_health_paused: r.bool(),
    extension_program: r.key(),
    attesters: [r.key(), r.key()],
    health_authority: r.key(),
  };
}

export interface ProductFloor {
  min_lock_in_seconds: bigint;
  max_lock_in_seconds: bigint;
  min_notice_seconds: bigint;
  max_notice_seconds: bigint;
  min_reserve: bigint;
  max_min_reserve: bigint;
  min_reserve_bps: number;
  max_reserve_bps: number;
  max_obligations_staleness: bigint;
  min_commitment: bigint;
  max_commitment: bigint;
  topups_when_health_paused_allowed: boolean;
  review_window_seconds: bigint;
}
const FLOOR_SIZE = 8 * 6 + 2 + 2 + 8 * 3 + 1 + 8;
function readFloor(r: Reader): ProductFloor {
  return {
    min_lock_in_seconds: r.i64(),
    max_lock_in_seconds: r.i64(),
    min_notice_seconds: r.i64(),
    max_notice_seconds: r.i64(),
    min_reserve: r.u64(),
    max_min_reserve: r.u64(),
    min_reserve_bps: r.u16(),
    max_reserve_bps: r.u16(),
    max_obligations_staleness: r.i64(),
    min_commitment: r.u64(),
    max_commitment: r.u64(),
    topups_when_health_paused_allowed: r.bool(),
    review_window_seconds: r.i64(),
  };
}

export interface PoolAccount {
  creator: string;
  pool_id: bigint;
  cluster: Uint8Array;
  authority: string;
  usdc_mint: string;
  vault: string;
  terms: Terms;
  floor: ProductFloor;
  min_timelock_seconds: bigint;
  has_pending_terms: boolean;
  pending_effective_at: bigint;
  sponsor_paused: boolean;
  health_paused: boolean;
  obligations: bigint;
  total_principal: bigint;
  total_deposited: bigint;
  total_queued: bigint;
  total_parked: bigint;
  next_deposit_seq: bigint;
  next_request_seq: bigint;
  head_seq: bigint;
  wind_down_at: bigint;
  wind_down_started: boolean;
}
export const POOL_SIZE = 8 + 32 + 8 + 32 + 32 * 3 + TERMS_SIZE + FLOOR_SIZE + 8 + TERMS_SIZE + 8 + 5 + 8 * 2 + 8 * 7 + 8 + 1 + 8 * 4 + 2;

const disc = (name: string) => Buffer.from(anchorDiscriminator("account", name));
const hasDisc = (data: Uint8Array, name: string) => data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(disc(name));

// A mynt_treasury Pool account as the program stored it; null when the bytes aren't one.
export function decodePool(data: Uint8Array): PoolAccount | null {
  if (data.length < POOL_SIZE || !hasDisc(data, "Pool")) return null;
  const r = new Reader(Buffer.from(data));
  r.o = 8;
  const creator = r.key();
  const pool_id = r.u64();
  const cluster = r.bytes(32);
  const authority = r.key();
  const usdc_mint = r.key();
  const vault = r.key();
  const terms = readTerms(r);
  const floor = readFloor(r);
  const min_timelock_seconds = r.i64();
  readTerms(r); // pending terms
  const pending_effective_at = r.i64();
  const has_pending_terms = r.bool();
  const sponsor_paused = r.bool();
  const health_paused = r.bool();
  r.bool(); // health_paused_by_authority
  r.bool(); // health_paused_by_health_authority
  const obligations = r.u64();
  r.i64(); // obligations_as_of
  const total_principal = r.u64();
  const total_deposited = r.u64();
  const total_queued = r.u64();
  const total_parked = r.u64();
  const next_deposit_seq = r.u64();
  const next_request_seq = r.u64();
  const head_seq = r.u64();
  const wind_down_at = r.i64();
  const wind_down_started = r.bool();
  return {
    creator,
    pool_id,
    cluster,
    authority,
    usdc_mint,
    vault,
    terms,
    floor,
    min_timelock_seconds,
    has_pending_terms,
    pending_effective_at,
    sponsor_paused,
    health_paused,
    obligations,
    total_principal,
    total_deposited,
    total_queued,
    total_parked,
    next_deposit_seq,
    next_request_seq,
    head_seq,
    wind_down_at,
    wind_down_started,
  };
}

export interface PositionAccount {
  pool: string;
  depositor: string;
  principal: bigint;
  deposited: bigint;
  deposits: bigint;
  nonce: bigint;
}
export function decodePosition(data: Uint8Array): PositionAccount | null {
  if (data.length < 8 + 64 + 32 || !hasDisc(data, "Position")) return null;
  const r = new Reader(Buffer.from(data));
  r.o = 8;
  return { pool: r.key(), depositor: r.key(), principal: r.u64(), deposited: r.u64(), deposits: r.u64(), nonce: r.u64() };
}

export interface DepositAccount {
  pool: string;
  depositor: string;
  seq: bigint;
  amount: bigint;
  remaining: bigint;
  queued: bigint;
  settled_at: bigint;
  review_until: bigint;
  lock_in_seconds: bigint;
  unlock_at: bigint;
  notice_seconds: bigint;
  rejected: boolean;
}
export function decodeDeposit(data: Uint8Array): DepositAccount | null {
  if (data.length < 8 + 64 + 72 + 1 || !hasDisc(data, "DepositRecord")) return null;
  const r = new Reader(Buffer.from(data));
  r.o = 8;
  return {
    pool: r.key(),
    depositor: r.key(),
    seq: r.u64(),
    amount: r.u64(),
    remaining: r.u64(),
    queued: r.u64(),
    settled_at: r.i64(),
    review_until: r.i64(),
    lock_in_seconds: r.i64(),
    unlock_at: r.i64(),
    notice_seconds: r.i64(),
    rejected: r.bool(),
  };
}

// An SPL token account's balance (mint, owner, amount); null when the bytes aren't one.
export function decodeTokenAccount(data: Uint8Array): { mint: string; owner: string; amount: bigint } | null {
  if (data.length < 165) return null;
  const r = new Reader(Buffer.from(data));
  return { mint: r.key(), owner: r.key(), amount: r.u64() };
}

// ---- events ----

export type TreasuryEvent =
  | { name: "DepositMade"; pool: string; depositor: string; deposit: string; seq: bigint; amount: bigint; settled_at: bigint; review_until: bigint; unlock_at: bigint; principal_after: bigint }
  | { name: "DepositRejected"; pool: string; depositor: string; deposit: string; seq: bigint; refunded: bigint; nonce: bigint }
  | { name: "WithdrawalRequested"; pool: string; depositor: string; deposit: string; request: string; seq: bigint; amount: bigint; payable_at: bigint }
  | { name: "WithdrawalPaid"; pool: string; depositor: string; request: string; seq: bigint; amount: bigint; remaining: bigint; partial: boolean; parked: boolean; reserve_floor: bigint; vault_after: bigint }
  | { name: "RequestCancelled" | "RequestVoided" | "RequestParked"; pool: string; depositor: string; request: string; seq: bigint; amount: bigint }
  | { name: "TermsApplied"; pool: string; attesters: [string, string] }
  | { name: "AttesterRemoved"; pool: string; attester: string }
  | { name: "other"; event: string };

const EVENTS = ["DepositMade", "DepositRejected", "WithdrawalRequested", "WithdrawalPaid", "RequestCancelled", "RequestVoided", "RequestParked"] as const;
const OTHER_EVENTS = [
  "PoolInitialized",
  "QueueAdvanced",
  "PauseChanged",
  "AttesterRemoved",
  "TermsProposed",
  "TermsCancelled",
  "TermsApplied",
  "ObligationsAttested",
  "WindDownProposed",
  "WindDownCancelled",
  "WindDownStarted",
  "SurplusClaimed",
  "ExtensionHook",
  "PoolSnapshot",
];
const EVENT_DISC = new Map([...EVENTS, ...OTHER_EVENTS].map((n) => [Buffer.from(anchorDiscriminator("event", n)).toString("hex"), n]));

// An Anchor event the treasury logged ("Program data: <base64>"), by its discriminator; null when it isn't one of the
// treasury's or is too short for its layout.
export function decodeEvent(data: Uint8Array): TreasuryEvent | null {
  if (data.length < 8) return null;
  const name = EVENT_DISC.get(Buffer.from(data.subarray(0, 8)).toString("hex"));
  if (!name) return null;
  const r = new Reader(Buffer.from(data));
  r.o = 8;
  try {
    switch (name) {
      case "DepositMade":
        return { name, pool: r.key(), depositor: r.key(), deposit: r.key(), seq: r.u64(), amount: r.u64(), settled_at: r.i64(), review_until: r.i64(), unlock_at: r.i64(), principal_after: r.u64() };
      case "DepositRejected":
        return { name, pool: r.key(), depositor: r.key(), deposit: r.key(), seq: r.u64(), refunded: r.u64(), nonce: r.u64() };
      case "WithdrawalRequested":
        return { name, pool: r.key(), depositor: r.key(), deposit: r.key(), request: r.key(), seq: r.u64(), amount: r.u64(), payable_at: r.i64() };
      case "WithdrawalPaid":
        return { name, pool: r.key(), depositor: r.key(), request: r.key(), seq: r.u64(), amount: r.u64(), remaining: r.u64(), partial: r.bool(), parked: r.bool(), reserve_floor: r.u64(), vault_after: r.u64() };
      case "RequestCancelled":
      case "RequestVoided":
      case "RequestParked":
        return { name, pool: r.key(), depositor: r.key(), request: r.key(), seq: r.u64(), amount: r.u64() };
      case "TermsApplied": {
        const pool = r.key();
        return { name, pool, attesters: readTerms(r).attesters };
      }
      case "AttesterRemoved":
        return { name, pool: r.key(), attester: r.key() };
      default:
        return { name: "other", event: name };
    }
  } catch {
    return null; // shorter than its layout: not this program's event
  }
}

// The Borsh bytes of an event, for fixtures: the inverse of decodeEvent for the events positions are built from.
export function encodeEvent(e: Exclude<TreasuryEvent, { name: "other" | "TermsApplied" | "AttesterRemoved" }>): Uint8Array {
  const k = (a: string) => Buffer.from(pubkeyBytes(a));
  const b = (v: boolean) => Buffer.from([v ? 1 : 0]);
  const head = Buffer.from(anchorDiscriminator("event", e.name));
  switch (e.name) {
    case "DepositMade":
      return Uint8Array.from(Buffer.concat([head, k(e.pool), k(e.depositor), k(e.deposit), u64le(e.seq), u64le(e.amount), i64le(e.settled_at), i64le(e.review_until), i64le(e.unlock_at), u64le(e.principal_after)]));
    case "DepositRejected":
      return Uint8Array.from(Buffer.concat([head, k(e.pool), k(e.depositor), k(e.deposit), u64le(e.seq), u64le(e.refunded), u64le(e.nonce)]));
    case "WithdrawalRequested":
      return Uint8Array.from(Buffer.concat([head, k(e.pool), k(e.depositor), k(e.deposit), k(e.request), u64le(e.seq), u64le(e.amount), i64le(e.payable_at)]));
    case "WithdrawalPaid":
      return Uint8Array.from(Buffer.concat([head, k(e.pool), k(e.depositor), k(e.request), u64le(e.seq), u64le(e.amount), u64le(e.remaining), b(e.partial), b(e.parked), u64le(e.reserve_floor), u64le(e.vault_after)]));
    default:
      return Uint8Array.from(Buffer.concat([head, k(e.pool), k(e.depositor), k(e.request), u64le(e.seq), u64le(e.amount)]));
  }
}

// ---- instructions ----

const meta = (pubkey: string, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });

// deposit(amount, approval_expiry, max_lock_in_seconds), its accounts in MakeDeposit's order. With no extension the
// optional account is the program's own id, as Anchor reads a missing Option<Account>.
export function depositInstruction(o: { programId: string; pool: string; vault: string; usdcMint: string; depositor: string; nextDepositSeq: bigint; extensionProgram: string; amount: bigint; expiry: bigint; maxLockInSeconds: bigint }): Instruction {
  return {
    programId: o.programId,
    keys: [
      meta(o.depositor, true, true),
      meta(o.pool, false, true),
      meta(positionAddress(o.programId, o.pool, o.depositor), false, true),
      meta(depositAddress(o.programId, o.pool, o.nextDepositSeq), false, true),
      meta(o.vault, false, true),
      meta(associatedTokenAddress(o.depositor, o.usdcMint), false, true),
      meta(o.usdcMint, false, false),
      meta(SYSVAR_INSTRUCTIONS, false, false),
      meta(hookAddress(o.programId, o.pool), false, false),
      meta(o.extensionProgram === ZERO_KEY ? o.programId : o.extensionProgram, false, false),
      meta(TOKEN_PROGRAM, false, false),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    data: Uint8Array.from(Buffer.concat([Buffer.from(anchorDiscriminator("global", "deposit")), u64le(o.amount), i64le(o.expiry), i64le(o.maxLockInSeconds)])),
  };
}

// request_withdrawal(amount, max_notice_seconds), its accounts in RequestWithdrawal's order.
export function requestWithdrawalInstruction(o: { programId: string; pool: string; deposit: string; depositor: string; nextRequestSeq: bigint; amount: bigint; maxNoticeSeconds: bigint }): Instruction {
  return {
    programId: o.programId,
    keys: [
      meta(o.depositor, true, true),
      meta(o.pool, false, true),
      meta(o.deposit, false, true),
      meta(requestAddress(o.programId, o.pool, o.nextRequestSeq), false, true),
      meta(SYSTEM_PROGRAM, false, false),
    ],
    data: Uint8Array.from(Buffer.concat([Buffer.from(anchorDiscriminator("global", "request_withdrawal")), u64le(o.amount), i64le(o.maxNoticeSeconds)])),
  };
}

// ---- v0 transactions, unsigned ----

// A version-0 message with no address lookup tables: the payer first, then writable signers, read-only signers,
// writable and read-only others; then the blockhash and the instructions.
export function compileV0Message(payer: string, instructions: Instruction[], recentBlockhash: string): { bytes: Uint8Array; signers: string[]; keys: string[] } {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const note = (k: string, signer: boolean, writable: boolean) => {
    const m = metas.get(k) ?? { signer: false, writable: false };
    metas.set(k, { signer: m.signer || signer, writable: m.writable || writable });
  };
  note(payer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) note(k.pubkey, k.isSigner, k.isWritable);
    note(ix.programId, false, false);
  }
  // A program that's invoked can't also be writable.
  for (const ix of instructions) if (metas.get(ix.programId)!.writable) throw new Error("An invoked program can't be a writable account");
  const rest = [...metas.entries()].filter(([k]) => k !== payer);
  const group = (signer: boolean, writable: boolean) => rest.filter(([, m]) => m.signer === signer && m.writable === writable).map(([k]) => k);
  const keys = [payer, ...group(true, true), ...group(true, false), ...group(false, true), ...group(false, false)];
  const numSigners = 1 + group(true, true).length + group(true, false).length;
  const index = new Map(keys.map((k, i) => [k, i]));
  const out: number[] = [0x80, numSigners, group(true, false).length, group(false, false).length, ...shortVec(keys.length)];
  for (const k of keys) out.push(...pubkeyBytes(k));
  const hash = base58Decode(recentBlockhash);
  if (hash.length !== 32) throw new Error("Bad blockhash");
  out.push(...hash, ...shortVec(instructions.length));
  for (const ix of instructions) out.push(index.get(ix.programId)!, ...shortVec(ix.keys.length), ...ix.keys.map((k) => index.get(k.pubkey)!), ...shortVec(ix.data.length), ...ix.data);
  out.push(...shortVec(0)); // no address lookup tables
  return { bytes: Uint8Array.from(out), signers: keys.slice(0, numSigners), keys };
}

// The wire form with every signature slot empty (64 zero bytes): the person's wallet fills its own.
export function unsignedTransaction(message: { bytes: Uint8Array; signers: string[] }): Uint8Array {
  return Uint8Array.from([...shortVec(message.signers.length), ...new Uint8Array(64 * message.signers.length), ...message.bytes]);
}

const readShortVec = (b: Uint8Array, start: number): [number, number] => {
  let n = 0;
  let shift = 0;
  let o = start;
  for (;;) {
    if (o >= b.length || shift > 28) throw new Error("bad transaction");
    const x = b[o++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, o];
    shift += 7;
  }
};

export interface DecodedTransaction {
  signatures: Uint8Array[];
  version: 0;
  numSigners: number;
  keys: string[];
  blockhash: string;
  instructions: { programId: string; accounts: { pubkey: string; signer: boolean; writable: boolean }[]; data: Uint8Array }[];
}

// A v0 transaction read back the way the cluster reads it, so what Mynt hands a wallet can be checked before it goes.
export function decodeV0Transaction(tx: Uint8Array): DecodedTransaction {
  let [nsig, o] = readShortVec(tx, 0);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < nsig; i++, o += 64) signatures.push(tx.subarray(o, o + 64));
  if (tx[o++] !== 0x80) throw new Error("not a v0 transaction");
  const numSigners = tx[o++];
  const roSigned = tx[o++];
  const roUnsigned = tx[o++];
  let nkeys: number;
  [nkeys, o] = readShortVec(tx, o);
  const keys: string[] = [];
  for (let i = 0; i < nkeys; i++, o += 32) keys.push(base58Encode(tx.subarray(o, o + 32)));
  const blockhash = base58Encode(tx.subarray(o, (o += 32)));
  const writable = (i: number) => (i < numSigners ? i < numSigners - roSigned : i < nkeys - roUnsigned);
  let nix: number;
  [nix, o] = readShortVec(tx, o);
  const instructions: DecodedTransaction["instructions"] = [];
  for (let i = 0; i < nix; i++) {
    const programId = keys[tx[o++]];
    let na: number;
    [na, o] = readShortVec(tx, o);
    const accounts = [...tx.subarray(o, o + na)].map((k) => ({ pubkey: keys[k], signer: k < numSigners, writable: writable(k) }));
    o += na;
    let nd: number;
    [nd, o] = readShortVec(tx, o);
    instructions.push({ programId, accounts, data: tx.subarray(o, o + nd) });
    o += nd;
  }
  let nlookups: number;
  [nlookups, o] = readShortVec(tx, o);
  if (nlookups !== 0 || o !== tx.length || nsig !== numSigners) throw new Error("bad transaction");
  return { signatures, version: 0, numSigners, keys, blockhash, instructions };
}

// ---- Mynt's attester ----

export class AttesterRefused extends Error {}

// Devnet's treasury attester, sealed in the vault under its own role. It holds no funds and no other authority, and
// it signs one thing only: a deposit approval it builds itself, in the program's layout, expiring within ten minutes.
// It never signs a transaction message, so no code holding this object can make it pay, transfer or call a program,
// and it signs only for devnet: an approval naming any other cluster's genesis hash is refused.
export class TreasuryAttester {
  readonly #key: Keypair;
  constructor(key: Keypair) {
    this.#key = key;
  }
  get address() {
    return this.#key.address;
  }
  get publicKey() {
    return this.#key.publicKey;
  }
  signDepositApproval(o: { programId: string; cluster: Uint8Array; pool: string; depositor: string; nonce: bigint; expiry: bigint }, nowSeconds: number): { message: Uint8Array; signature: Uint8Array } {
    const expiry = Number(o.expiry);
    if (!(expiry > nowSeconds) || expiry - nowSeconds > MAX_APPROVAL_SECONDS) throw new AttesterRefused(`A deposit approval expires within ${MAX_APPROVAL_SECONDS / 60} minutes`);
    if (!Buffer.from(o.cluster).equals(Buffer.from(base58Decode(GENESIS_HASH.devnet)))) throw new AttesterRefused("The treasury attester signs devnet approvals only");
    const message = depositApprovalMessage(o);
    return { message, signature: this.#key.sign(message) };
  }
}
