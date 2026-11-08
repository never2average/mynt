import { createECDH, createPrivateKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { safePost, type VendorCallOptions } from "../../vendor-call.js";
import { base58Encode, isAddress } from "../codec.js";
import { verifyEd25519, type CustodyServiceClient } from "../signer.js";
import { shortVec } from "../tx.js";

// Turnkey as Mynt's custody service: the mainnet deploy authority is an Ed25519 Solana account in a Turnkey
// wallet, held in Turnkey's secure enclaves. Mynt never sees that key. It asks Turnkey to sign each transaction
// with a Turnkey API key (a P-256 key pair whose private half is TURNKEY_API_PRIVATE_KEY) and checks every
// signature that comes back against the address and the message before it is used.
//
// Mynt sends the whole unsigned transaction (ACTIVITY_TYPE_SIGN_TRANSACTION_V2, TRANSACTION_TYPE_SOLANA)
// rather than a raw payload, so a Turnkey policy can read it (solana.tx.program_keys, transfers, ...) and
// refuse anything but the one transaction Mynt asks it to sign per deploy: the buffer's handover and the
// Deploy or Upgrade (src/solana/service.ts, custodyDeploy). A raw payload Turnkey can't parse.
//
// Requests carry Turnkey's documented API-key stamp: the X-Stamp header is base64url(JSON {publicKey, scheme:
// SIGNATURE_SCHEME_TK_API_P256, signature}), the signature ECDSA P-256 over SHA-256, DER then hex encoded, over
// the exact JSON body sent. The API host is fixed; requests go out under Mynt's outbound rules (HTTPS, no
// private addresses, no redirects, a time limit and a size cap).

export const TURNKEY_API = "https://api.turnkey.com";
export const TURNKEY_ENV = ["TURNKEY_ORGANIZATION_ID", "TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY"] as const;
const SCHEME = "SIGNATURE_SCHEME_TK_API_P256";
const SIGN_TRANSACTION = "ACTIVITY_TYPE_SIGN_TRANSACTION_V2";
const WAITING = new Set(["ACTIVITY_STATUS_CREATED", "ACTIVITY_STATUS_PENDING", "ACTIVITY_STATUS_CONSENSUS_NEEDED"]);

// Refusals from the custody service, safe to show an admin: never the API key, a stamp or a request body.
export class CustodyError extends Error {}

export interface TurnkeyOptions {
  organizationId: string;
  apiPublicKey: string; // compressed P-256, hex (66 characters)
  apiPrivateKey: string; // the P-256 scalar, hex (64 characters); turned into a KeyObject at once, never kept as text
  // Tests only: a fake Turnkey on loopback. The server's configuration never sets these.
  baseUrl?: string;
  outbound?: VendorCallOptions;
  // How long to wait for an activity that needs approvals (consensus) before giving up, and how often to ask.
  approvalTimeoutMs?: number;
  pollMs?: number;
  // A configuration problem found before construction (a variable not set), reported instead of signing.
  problem?: string;
}

const HEX = /^[0-9a-f]+$/i;

export class TurnkeyClient implements CustodyServiceClient {
  readonly provider = "turnkey";
  // Why this client can't sign, when its configuration is wrong: shown to admins as a readiness reason.
  readonly problem: string | null;
  readonly #key: KeyObject | null;
  readonly #publicKey: string;
  readonly #organizationId: string;
  readonly #baseUrl: string;
  readonly #outbound: VendorCallOptions;
  readonly #approvalTimeoutMs: number;
  readonly #pollMs: number;

  constructor(o: TurnkeyOptions) {
    this.#organizationId = o.organizationId.trim();
    this.#publicKey = o.apiPublicKey.trim().toLowerCase();
    this.#baseUrl = (o.baseUrl ?? TURNKEY_API).replace(/\/+$/, "");
    this.#outbound = { timeoutMs: 15_000, ...(o.outbound ?? {}) };
    this.#approvalTimeoutMs = o.approvalTimeoutMs ?? 60_000;
    this.#pollMs = o.pollMs ?? 1_000;
    let key: KeyObject | null = null;
    let problem: string | null = o.problem ?? null;
    if (!problem) {
      try {
        key = p256Key(o.apiPrivateKey.trim(), this.#publicKey);
      } catch (e) {
        problem = (e as Error).message;
      }
    }
    if (!problem && !/^[0-9a-f-]{8,64}$/i.test(this.#organizationId)) problem = "TURNKEY_ORGANIZATION_ID isn't a Turnkey organization ID";
    this.#key = problem ? null : key;
    this.problem = problem;
  }

  // What a log line or JSON serialisation shows: never the key.
  toJSON() {
    return { provider: this.provider, problem: this.problem };
  }

  // The 64-byte Ed25519 signature `address` (a Turnkey wallet account) makes over a compiled legacy message.
  async signSolanaMessage(address: string, message: Uint8Array): Promise<Uint8Array> {
    if (this.problem || !this.#key) throw new CustodyError(`Turnkey isn't configured on this server: ${this.problem}`);
    if (!isAddress(address)) throw new CustodyError("The custody address isn't a Solana address");
    const signers = legacySigners(message);
    const slot = signers.indexOf(address);
    if (slot < 0) throw new CustodyError("The transaction doesn't need the custody address's signature");
    // The unsigned wire transaction: a zeroed slot for each signature, then the message.
    const unsigned = Buffer.concat([Buffer.from(shortVec(signers.length)), Buffer.alloc(64 * signers.length), Buffer.from(message)]);

    let activity = await this.#post("/public/v1/submit/sign_transaction", {
      type: SIGN_TRANSACTION,
      timestampMs: String(Date.now()),
      organizationId: this.#organizationId,
      parameters: { signWith: address, unsignedTransaction: unsigned.toString("hex"), type: "TRANSACTION_TYPE_SOLANA" },
    });
    const deadline = Date.now() + this.#approvalTimeoutMs;
    while (WAITING.has(activity.status)) {
      if (Date.now() > deadline)
        throw new CustodyError(
          `Turnkey activity ${activity.id} is still ${activity.status} after ${Math.round(this.#approvalTimeoutMs / 1000)} s (waiting for approvals), so Mynt sent nothing. Approving it now is harmless (the transaction also needs Mynt's own signatures and its blockhash expires); start the deploy again and approve the new activity, or raise TURNKEY_APPROVAL_TIMEOUT_SECONDS.`,
        );
      await new Promise((r) => setTimeout(r, this.#pollMs));
      activity = await this.#post("/public/v1/query/get_activity", { organizationId: this.#organizationId, activityId: activity.id });
    }
    if (activity.status !== "ACTIVITY_STATUS_COMPLETED")
      throw new CustodyError(`Turnkey refused to sign (${activity.status}${activity.failure ? `: ${activity.failure}` : ""}); check the signing policy for ${address}`);

    const signedHex = activity.result?.signTransactionResult?.signedTransaction;
    if (typeof signedHex !== "string" || !HEX.test(signedHex) || signedHex.length % 2) throw new CustodyError("Turnkey returned no signed transaction");
    const signature = signatureFrom(Buffer.from(signedHex, "hex"), message, slot);
    // Checked here and again by the signer: the address's signature, over exactly this message.
    if (!verifyEd25519(address, message, signature)) throw new CustodyError(`Turnkey's signature doesn't verify for ${address} over this transaction; it wasn't used`);
    return signature;
  }

  async #post(path: string, body: Record<string, unknown>): Promise<TurnkeyActivity> {
    const payload = JSON.stringify(body);
    const r = await safePost(`${this.#baseUrl}${path}`, payload, { "User-Agent": "Mynt-Custody/1", "X-Stamp": this.#stamp(payload) }, this.#outbound);
    if (!r.ok) {
      // Turnkey's own message helps the admin (a policy denial, a stale timestamp); it never holds our API key.
      const msg = (r.body as { message?: unknown } | null)?.message;
      throw new CustodyError(`Turnkey request failed (${r.error ?? `http ${r.http_status}`})${typeof msg === "string" ? `: ${clean(msg)}` : ""}`);
    }
    const a = (r.body as { activity?: Record<string, unknown> } | null)?.activity;
    if (!a || typeof a.status !== "string" || typeof a.id !== "string") throw new CustodyError("Turnkey's answer has no activity");
    const failure = (a.failure as { message?: unknown } | undefined)?.message;
    return { id: a.id, status: a.status, result: a.result as TurnkeyActivity["result"], failure: typeof failure === "string" ? clean(failure) : undefined };
  }

  // X-Stamp: base64url of {publicKey, scheme, signature}, the signature over exactly the body sent.
  #stamp(payload: string): string {
    const signature = cryptoSign("sha256", Buffer.from(payload, "utf8"), { key: this.#key!, dsaEncoding: "der" }).toString("hex");
    return Buffer.from(JSON.stringify({ publicKey: this.#publicKey, scheme: SCHEME, signature })).toString("base64url");
  }
}

interface TurnkeyActivity {
  id: string;
  status: string;
  result?: { signTransactionResult?: { signedTransaction?: unknown } };
  failure?: string;
}

const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);

// A P-256 private key from its hex scalar, checked against the public key Turnkey knows it by.
function p256Key(privateHex: string, publicHex: string): KeyObject {
  if (!/^0[23][0-9a-f]{64}$/.test(publicHex)) throw new Error("TURNKEY_API_PUBLIC_KEY isn't a compressed P-256 public key (66 hex characters)");
  if (!/^[0-9a-fA-F]{1,64}$/.test(privateHex)) throw new Error("TURNKEY_API_PRIVATE_KEY isn't a P-256 private key (64 hex characters)");
  const d = Buffer.from(privateHex.padStart(64, "0"), "hex");
  const ecdh = createECDH("prime256v1");
  try {
    ecdh.setPrivateKey(d);
  } catch {
    throw new Error("TURNKEY_API_PRIVATE_KEY isn't a P-256 private key (64 hex characters)");
  }
  if (ecdh.getPublicKey("hex", "compressed") !== publicHex) throw new Error("TURNKEY_API_PRIVATE_KEY doesn't belong to TURNKEY_API_PUBLIC_KEY");
  const point = ecdh.getPublicKey(null, "uncompressed");
  const b64 = (b: Buffer) => b.toString("base64url");
  return createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64(d), x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) }, format: "jwk" });
}

function readShortVec(b: Uint8Array, o: number): [number, number] {
  let n = 0;
  for (let shift = 0; shift < 21; shift += 7) {
    if (o >= b.length) throw new CustodyError("Malformed transaction");
    const x = b[o++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, o];
  }
  throw new CustodyError("Malformed transaction");
}

// The signers a legacy message needs, in signature order.
function legacySigners(message: Uint8Array): string[] {
  if (message.length < 4 || message[0] & 0x80) throw new CustodyError("Only legacy transaction messages are signed");
  const numSigners = message[0];
  const [nkeys, at] = readShortVec(message, 3);
  if (numSigners < 1 || numSigners > nkeys || at + 32 * nkeys > message.length) throw new CustodyError("Malformed transaction");
  const signers: string[] = [];
  for (let i = 0; i < numSigners; i++) signers.push(base58Encode(message.subarray(at + 32 * i, at + 32 * (i + 1))));
  return signers;
}

// The signature in `slot` of a signed wire transaction, provided its message is exactly the one Mynt sent.
function signatureFrom(wire: Uint8Array, message: Uint8Array, slot: number): Uint8Array {
  const [nsig, o] = readShortVec(wire, 0);
  if (slot >= nsig || o + 64 * nsig > wire.length) throw new CustodyError("Turnkey's signed transaction is malformed");
  if (!Buffer.from(wire.subarray(o + 64 * nsig)).equals(Buffer.from(message)))
    throw new CustodyError("Turnkey's signed transaction isn't the transaction Mynt sent; it wasn't used");
  return Uint8Array.from(wire.subarray(o + 64 * slot, o + 64 * (slot + 1)));
}

// How long Mynt waits for a person to approve the deploy's one activity: TURNKEY_APPROVAL_TIMEOUT_SECONDS,
// default 60, at most 30 minutes.
export const APPROVAL_TIMEOUT_DEFAULT_S = 60;
export const APPROVAL_TIMEOUT_MAX_S = 30 * 60;
export function approvalTimeoutSeconds(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  if (!raw?.trim() || !Number.isFinite(n) || n < 1) return APPROVAL_TIMEOUT_DEFAULT_S;
  return Math.min(Math.floor(n), APPROVAL_TIMEOUT_MAX_S);
}

// Turnkey from the server's environment, by name. None of the three set: no Turnkey. Some set: a client that
// refuses and says which are missing.
export function turnkeyFromEnv(env: NodeJS.ProcessEnv = process.env): TurnkeyClient | null {
  const missing = TURNKEY_ENV.filter((n) => (env[n] ?? "").trim() === "");
  if (missing.length === TURNKEY_ENV.length) return null;
  return new TurnkeyClient({
    organizationId: env.TURNKEY_ORGANIZATION_ID ?? "",
    apiPublicKey: env.TURNKEY_API_PUBLIC_KEY ?? "",
    apiPrivateKey: env.TURNKEY_API_PRIVATE_KEY ?? "",
    approvalTimeoutMs: approvalTimeoutSeconds(env.TURNKEY_APPROVAL_TIMEOUT_SECONDS) * 1000,
    ...(missing.length ? { problem: `${missing.join(" and ")} ${missing.length > 1 ? "aren't" : "isn't"} set on the server` } : {}),
  });
}
