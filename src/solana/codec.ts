import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";

// Solana's encodings, keys and addresses, written out so Mynt needs no chain SDK: base58, ed25519 keypairs in
// the CLI's 64-byte form (seed then public key), program-derived addresses and Anchor's discriminators.

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

export function base58Decode(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error("not base58");
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  for (const c of text) {
    if (c !== "1") break;
    zeros++;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
}

// A public key (an address): 32 bytes, written in base58.
export function pubkeyBytes(address: string): Uint8Array {
  const b = base58Decode(address);
  if (b.length !== 32) throw new Error(`'${address}' isn't a Solana address`);
  return b;
}

export const isAddress = (s: string) => {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && pubkeyBytes(s).length === 32;
  } catch {
    return false;
  }
};

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

// The Solana CLI's keypair: 64 bytes, the ed25519 seed then the public key.
// The private key and seed are JS #private fields: no log, inspection or JSON serialisation can reach them.
export class Keypair {
  readonly #key: KeyObject;
  readonly #seed: Uint8Array;
  readonly publicKey: Uint8Array;

  private constructor(key: KeyObject, publicKey: Uint8Array, seed: Uint8Array) {
    this.#key = key;
    this.#seed = seed;
    this.publicKey = publicKey;
  }

  static generate(): Keypair {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" }) as { d: string; x: string };
    return new Keypair(privateKey, Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.d, "base64url"));
  }

  static fromSecret(secret: Uint8Array): Keypair {
    if (secret.length !== 64) throw new Error("A Solana keypair is 64 bytes");
    const seed = secret.subarray(0, 32);
    const pub = secret.subarray(32);
    // Node 24 checks the halves itself; older versions don't, so both paths end in the same refusal.
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) }, format: "jwk" });
    } catch {
      throw new Error("The keypair's public half doesn't match its secret");
    }
    // A keypair whose halves don't belong together signs for a different address than it claims.
    const derived = Buffer.from((key.export({ format: "jwk" }) as { x: string }).x, "base64url");
    if (!derived.equals(Buffer.from(pub))) throw new Error("The keypair's public half doesn't match its secret");
    return new Keypair(key, Uint8Array.from(pub), Uint8Array.from(seed));
  }

  get address() {
    return base58Encode(this.publicKey);
  }

  // The 64-byte secret, as the Solana CLI stores it. Only ever sealed; never shown, logged or returned.
  secret(): Uint8Array {
    return Uint8Array.from([...this.#seed, ...this.publicKey]);
  }

  sign(message: Uint8Array): Uint8Array {
    return new Uint8Array(edSign(null, message, this.#key));
  }
}

// ---- program-derived addresses ----

const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a: bigint) {
  const r = a % P;
  return r < 0n ? r + P : r;
}
function modPow(b: bigint, e: bigint) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a: bigint) {
  return modPow(a, P - 2n);
}

// Whether 32 bytes decode to a point on ed25519 (a key someone could hold); a program address must not.
export function isOnCurve(bytes: Uint8Array): boolean {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  y = mod(y);
  const y2 = (y * y) % P;
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const x2 = (u * modInv(v)) % P;
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

export function createProgramAddress(seeds: Uint8Array[], programId: string): string {
  const h = createHash("sha256");
  for (const s of seeds) {
    if (s.length > 32) throw new Error("A seed is at most 32 bytes");
    h.update(s);
  }
  h.update(pubkeyBytes(programId)).update("ProgramDerivedAddress");
  const out = h.digest();
  if (isOnCurve(out)) throw new Error("on curve");
  return base58Encode(out);
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): [string, number] {
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddress([...seeds, Uint8Array.of(bump)], programId), bump];
    } catch {
      /* next bump */
    }
  }
  throw new Error("No program address found");
}

// Anchor names instructions and events by the first 8 bytes of sha256("global:<name>") / ("event:<Name>").
export const anchorDiscriminator = (namespace: "global" | "event" | "account", name: string) =>
  Uint8Array.from(createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8));

// The executable hash solana-verify reports: sha256 of the program with its trailing zero padding removed, so
// the file Mynt built and the bytes on chain (padded to the account's size) hash the same.
export function executableHash(program: Uint8Array): string {
  let end = program.length;
  while (end > 0 && program[end - 1] === 0) end--;
  return createHash("sha256").update(program.subarray(0, end)).digest("hex");
}
