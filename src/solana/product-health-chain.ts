import { createHash, createHmac } from "node:crypto";
import { anchorDiscriminator, base58Encode, findProgramAddress, Keypair, pubkeyBytes } from "./codec.js";
import { SYSTEM_PROGRAM, type AccountMeta, type Instruction } from "./tx.js";

// The product-health program (programs/product-health) from Mynt's side: its instructions, its accounts, and the
// publisher key, which only ever signs those instructions. Nothing about a product but a keyed hash of its id, the
// fingerprint of its snapshot, its period and a commitment to the partner's co-signature goes on chain.

export const SOURCE_FLAG = { unavailable: 0, sandbox: 1, partner_ledger: 2 } as const;
export const KIND_SNAPSHOT = 0;
export const KIND_MISSED = 1;
export const ZERO_32 = new Uint8Array(32);

// A product (or a pool of it) on chain: an HMAC under a key derived from Mynt's vault, so nobody can test a guessed
// product id against the chain.
export const subjectKey = (key: Uint8Array, productId: string, poolId: string | null): Uint8Array => Uint8Array.from(createHmac("sha256", key).update(`${productId}\u0000${poolId ?? ""}`).digest());

export const configAddress = (programId: string) => findProgramAddress([Buffer.from("config")], programId)[0];
export const headAddress = (programId: string, subject: Uint8Array) => findProgramAddress([Buffer.from("head"), subject], programId)[0];

const u8 = (n: number) => Uint8Array.of(n);
const u64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64le = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));

const meta = (pubkey: string, isSigner: boolean, isWritable: boolean): AccountMeta => ({ pubkey, isSigner, isWritable });
const ix = (programId: string, keys: AccountMeta[], data: Uint8Array): Instruction => ({ programId, keys, data });

export const DISCRIMINATORS = {
  initialize: anchorDiscriminator("global", "initialize"),
  open_subject: anchorDiscriminator("global", "open_subject"),
  record_snapshot: anchorDiscriminator("global", "record_snapshot"),
  record_missed: anchorDiscriminator("global", "record_missed"),
};
const CONFIG_DISCRIMINATOR = anchorDiscriminator("account", "Config");
const HEAD_DISCRIMINATOR = anchorDiscriminator("account", "Head");

// What a licence provider signs: the domain, then the 32 bytes of the fingerprint, so a signature can't be replayed
// from anything else the key signs.
const COSIGN_DOMAIN = Buffer.from("mynt.product_health.cosign.v1\u0000", "utf8");
export const cosignMessage = (fingerprint: Uint8Array) => Uint8Array.from(Buffer.concat([COSIGN_DOMAIN, Buffer.from(fingerprint)]));

// What goes on chain in place of the partner's key and signature: nothing that links its products to each other.
const COMMITMENT_DOMAIN = Buffer.from("mynt.product_health.partner_commitment.v1\u0000", "utf8");
export function partnerCommitment(subject: Uint8Array, key: Uint8Array, signature: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(COMMITMENT_DOMAIN).update(subject).update(key).update(signature).digest());
}

export interface SnapshotEntry {
  sequence: number;
  fingerprint: Uint8Array;
  period_start: number; // unix seconds
  period_end: number;
  source: keyof typeof SOURCE_FLAG;
  partner_commitment: Uint8Array | null;
}
export interface MissedEntry {
  sequence: number;
  period_start: number;
  period_end: number;
  reason: number; // 0 for now: why is in Mynt's record
}

export const healthIx = {
  initialize: (programId: string, publisher: string, upgradeAuthority: string, programData: string) =>
    ix(
      programId,
      [
        meta(configAddress(programId), false, true),
        meta(publisher, true, true),
        meta(upgradeAuthority, true, false),
        meta(programId, false, false),
        meta(programData, false, false),
        meta(SYSTEM_PROGRAM, false, false),
      ],
      DISCRIMINATORS.initialize,
    ),
  openSubject: (programId: string, publisher: string, subject: Uint8Array) =>
    ix(
      programId,
      [meta(configAddress(programId), false, false), meta(headAddress(programId, subject), false, true), meta(publisher, true, true), meta(SYSTEM_PROGRAM, false, false)],
      concat(DISCRIMINATORS.open_subject, subject),
    ),
  recordSnapshot: (programId: string, publisher: string, subject: Uint8Array, e: SnapshotEntry) =>
    ix(
      programId,
      [meta(configAddress(programId), false, false), meta(headAddress(programId, subject), false, true), meta(publisher, true, false)],
      concat(DISCRIMINATORS.record_snapshot, subject, u64le(e.sequence), e.fingerprint, i64le(e.period_start), i64le(e.period_end), u8(SOURCE_FLAG[e.source]), e.partner_commitment ?? ZERO_32),
    ),
  recordMissed: (programId: string, publisher: string, subject: Uint8Array, e: MissedEntry) =>
    ix(
      programId,
      [meta(configAddress(programId), false, false), meta(headAddress(programId, subject), false, true), meta(publisher, true, false)],
      concat(DISCRIMINATORS.record_missed, subject, u64le(e.sequence), i64le(e.period_start), i64le(e.period_end), u8(e.reason)),
    ),
};

export interface HeadAccount {
  subject: Uint8Array;
  sequence: number;
  fingerprint: Uint8Array;
  period_start: number;
  period_end: number;
  kind: number;
  source: number;
  partner_signed: boolean;
  partner_commitment: Uint8Array;
  chain: Uint8Array;
  mynt_signer: string;
  bump: number;
}

export const HEAD_SIZE = 8 + 32 + 8 + 32 + 8 + 8 + 1 + 1 + 1 + 32 + 32 + 32 + 1;

// An on-chain head account, as the program stored it. null: not a head account.
export function decodeHead(data: Uint8Array): HeadAccount | null {
  if (data.length < HEAD_SIZE || !Buffer.from(data.subarray(0, 8)).equals(Buffer.from(HEAD_DISCRIMINATOR))) return null;
  const b = Buffer.from(data);
  let o = 8;
  const take = (n: number) => Uint8Array.from(b.subarray(o, (o += n)));
  const subject = take(32);
  const sequence = Number(b.readBigUInt64LE(o));
  o += 8;
  const fingerprint = take(32);
  const period_start = Number(b.readBigInt64LE(o));
  o += 8;
  const period_end = Number(b.readBigInt64LE(o));
  o += 8;
  const kind = b[o++];
  const source = b[o++];
  const partner_signed = b[o++] === 1;
  const partner_commitment = take(32);
  const chain = take(32);
  const mynt_signer = base58Encode(take(32));
  return { subject, sequence, fingerprint, period_start, period_end, kind, source, partner_signed, partner_commitment, chain, mynt_signer, bump: b[o] };
}

export function decodeConfigPublisher(data: Uint8Array): string | null {
  if (data.length < 8 + 32 || !Buffer.from(data.subarray(0, 8)).equals(Buffer.from(CONFIG_DISCRIMINATOR))) return null;
  return base58Encode(data.subarray(8, 40));
}

export interface ChainLink {
  subject: Uint8Array;
  sequence: number;
  fingerprint: Uint8Array;
  period_start: number;
  period_end: number;
  kind: number;
  source: number;
  partner_commitment: Uint8Array;
}

// The hash chain over every record, as the program computes it: everything a record says, so none of it can change.
export function nextChain(prev: Uint8Array, l: ChainLink): Uint8Array {
  return Uint8Array.from(
    createHash("sha256")
      .update(prev)
      .update(l.subject)
      .update(u64le(l.sequence))
      .update(l.fingerprint)
      .update(i64le(l.period_start))
      .update(i64le(l.period_end))
      .update(u8(l.kind))
      .update(u8(l.source))
      .update(l.partner_commitment)
      .digest(),
  );
}

// ---- the publisher key: it signs Mynt's health records and nothing else ----

const readShortVec = (b: Uint8Array, start: number): [number, number] => {
  let n = 0;
  let shift = 0;
  let o = start;
  for (;;) {
    if (o >= b.length || shift > 28) throw new Error("bad message");
    const x = b[o++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, o];
    shift += 7;
  }
};

interface ParsedMessage {
  keys: string[];
  instructions: { programId: string; data: Uint8Array }[];
}

// A compiled legacy message, read back the way the cluster reads it. Anything malformed throws.
export function parseMessage(message: Uint8Array): ParsedMessage {
  if (message.length < 3 || message[0] & 0x80) throw new Error("not a legacy message");
  let [nkeys, o] = readShortVec(message, 3);
  const keys: string[] = [];
  for (let i = 0; i < nkeys; i++, o += 32) {
    if (o + 32 > message.length) throw new Error("bad message");
    keys.push(base58Encode(message.subarray(o, o + 32)));
  }
  o += 32; // the blockhash
  let nix: number;
  [nix, o] = readShortVec(message, o);
  const instructions: ParsedMessage["instructions"] = [];
  for (let i = 0; i < nix; i++) {
    const programId = keys[message[o++]];
    if (programId === undefined) throw new Error("bad message");
    let na: number;
    [na, o] = readShortVec(message, o);
    o += na;
    let nd: number;
    [nd, o] = readShortVec(message, o);
    if (o + nd > message.length) throw new Error("bad message");
    instructions.push({ programId, data: message.subarray(o, o + nd) });
    o += nd;
  }
  if (o !== message.length) throw new Error("bad message");
  return { keys, instructions };
}

export class PublisherRefused extends Error {}

const startsWith = (data: Uint8Array, prefix: Uint8Array) => data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
const ALLOWED = Object.values(DISCRIMINATORS);

// Devnet's product-health publisher, sealed in the vault under its own role. It holds no other authority (it isn't
// the deploy authority or anyone's fee payer), and every message is read back before it signs: it must pay its own
// fees and contain only the product-health program's own instructions. So even code holding this object can't use
// it to sign a transfer, an upgrade or a call to any other program.
export class HealthPublisher {
  readonly #key: Keypair;
  readonly programId: string;
  constructor(key: Keypair, programId: string) {
    pubkeyBytes(programId);
    this.#key = key;
    this.programId = programId;
  }
  get address() {
    return this.#key.address;
  }
  async sign(message: Uint8Array): Promise<Uint8Array> {
    let parsed: ParsedMessage;
    try {
      parsed = parseMessage(message);
    } catch {
      throw new PublisherRefused("The product-health publisher signs only messages it can read");
    }
    if (parsed.keys[0] !== this.address) throw new PublisherRefused("The product-health publisher only signs transactions it pays for");
    if (!parsed.instructions.length) throw new PublisherRefused("The product-health publisher won't sign an empty transaction");
    for (const i of parsed.instructions) {
      if (i.programId !== this.programId) throw new PublisherRefused(`The product-health publisher won't sign an instruction to ${i.programId}`);
      if (!ALLOWED.some((d) => startsWith(i.data, d))) throw new PublisherRefused("The product-health publisher signs only the product-health program's own instructions");
    }
    return this.#key.sign(message);
  }
}
