import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from "node:crypto";
import { canonicalJson } from "./figures.js";

// A partner's ledger statement, sealed to the confidential service: only the enclave holding the ingest key opens it.
// Mynt's server carries it, stores it, and never reads it. Pure (node:crypto and ./figures.js only): this file runs on
// Mynt's server, inside the enclave (deploy/confidential/src/shared/ is a copy of its build) and in partners' tools.
//
// X25519 between a fresh ephemeral key and the enclave's ingest key, HKDF-SHA256 to an AES-256-GCM key, the header
// authenticated as associated data, so the envelope can't be re-addressed to another firm, environment or request.
//
//   {
//     "schema": "mynt.sealed_statement.v1",
//     "alg": "X25519-HKDF-SHA256-A256GCM",
//     "recipient": "<the enclave's ingest public key, base64url, 32 bytes>",
//     "ephemeral": "<the sender's one-time public key, base64url, 32 bytes>",
//     "provider_entity_id": "<the firm>", "environment": "live", "request_id": "<the request it answers, or null>",
//     "iv": "<base64url, 12 bytes>", "ciphertext": "<base64url>", "tag": "<base64url, 16 bytes>"
//   }

export const SEALED_STATEMENT_SCHEMA = "mynt.sealed_statement.v1";
export const SEALED_STATEMENT_ALG = "X25519-HKDF-SHA256-A256GCM";

export interface SealedStatement {
  schema: typeof SEALED_STATEMENT_SCHEMA;
  alg: typeof SEALED_STATEMENT_ALG;
  recipient: string;
  ephemeral: string;
  provider_entity_id: string;
  environment: "test" | "live";
  request_id: string | null;
  iv: string;
  ciphertext: string;
  tag: string;
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

// An X25519 private key from 32 bytes of seed (so the enclave's ingest key is derived from its root, and stays the
// same across restarts while the root does).
export function x25519FromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) throw new Error("An X25519 seed is 32 bytes");
  return createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
}
export const x25519PublicRaw = (key: KeyObject): string => {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  return (pub.export({ format: "jwk" }) as { x: string }).x;
};
const x25519Public = (raw: string) => createPublicKey({ key: { kty: "OKP", crv: "X25519", x: raw }, format: "jwk" });

export const isSealedStatement = (x: unknown): x is SealedStatement =>
  !!x && typeof x === "object" && (x as { schema?: unknown }).schema === SEALED_STATEMENT_SCHEMA && (x as { alg?: unknown }).alg === SEALED_STATEMENT_ALG;

const header = (e: Omit<SealedStatement, "iv" | "ciphertext" | "tag">) =>
  Buffer.from(canonicalJson({ schema: e.schema, alg: e.alg, recipient: e.recipient, ephemeral: e.ephemeral, provider_entity_id: e.provider_entity_id, environment: e.environment, request_id: e.request_id }), "utf8");

const aeadKey = (shared: Buffer, ephemeral: string, recipient: string) =>
  Buffer.from(hkdfSync("sha256", shared, Buffer.concat([unb64u(ephemeral), unb64u(recipient)]), SEALED_STATEMENT_SCHEMA, 32));

// What a partner runs (docs/partners.md): its signed statement, sealed to the enclave's attested ingest key.
export function sealStatement(statement: unknown, recipient: string, meta: { provider_entity_id: string; environment: "test" | "live"; request_id: string | null }): SealedStatement {
  const eph = generateKeyPairSync("x25519");
  const ephemeral = x25519PublicRaw(eph.publicKey);
  const head = { schema: SEALED_STATEMENT_SCHEMA, alg: SEALED_STATEMENT_ALG, recipient, ephemeral, ...meta } as const;
  const key = aeadKey(diffieHellman({ privateKey: eph.privateKey, publicKey: x25519Public(recipient) }), ephemeral, recipient);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header(head));
  const ct = Buffer.concat([cipher.update(JSON.stringify(statement), "utf8"), cipher.final()]);
  return { ...head, iv: b64u(iv), ciphertext: b64u(ct), tag: b64u(cipher.getAuthTag()) };
}

// Inside the enclave: the statement, or a fixed error (never the plaintext, never why the tag failed).
export function openSealedStatement(e: SealedStatement, ingest: KeyObject): unknown {
  if (!isSealedStatement(e)) throw new Error("not a sealed statement");
  if (e.recipient !== x25519PublicRaw(ingest)) throw new Error("sealed to another key");
  const key = aeadKey(diffieHellman({ privateKey: ingest, publicKey: x25519Public(e.ephemeral) }), e.ephemeral, e.recipient);
  const decipher = createDecipheriv("aes-256-gcm", key, unb64u(e.iv));
  decipher.setAAD(header(e));
  decipher.setAuthTag(unb64u(e.tag));
  const plain = Buffer.concat([decipher.update(unb64u(e.ciphertext)), decipher.final()]).toString("utf8");
  return JSON.parse(plain);
}
