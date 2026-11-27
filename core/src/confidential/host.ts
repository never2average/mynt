import type { EnclaveKeys } from "./shared/binding.js";
import type { SealedHealthInput, SealedHealthResult } from "./shared/health.js";

// Where Mynt keeps what its own server shouldn't be able to read: the vault's root keys, partners' books, and the keys
// that sign what Mynt attests. Behind one interface, like SandboxHost, so the provider can change and tests use a
// stand-in. Providers live in this folder and are picked by confidentialHostFromEnv (index.ts); provider names appear
// only there and in their adapter files.
//
//   local   in-process, keyed by MYNT_VAULT_KEY: today's behaviour, for development, tests, and every server until the
//           operator deploys the confidential service. It attests nothing, and says so.
//   remote  the confidential service (deploy/confidential) running in attested hardware (remote.ts), reached over
//           mutually authenticated TLS whose server key is pinned to the one the hardware attested. One adapter per
//           provider: an isolated enclave on a cloud VM (aws-nitro, the documented default) or a confidential-VM
//           container (gcp-confidential-space).
//
// Later phases reuse these types rather than adding new ones: a build agent's confidential VM (behind SandboxHost) and a
// confidential hosting tier both report `Measurements` and produce an `Attestation` checked the same way, against
// measurements (an image digest, or an enclave's PCRs) announced through the same release record (governance.ts).

export const CONFIDENTIAL_HOST_KINDS = ["local", "aws-nitro", "gcp-confidential-space"] as const;
export type ConfidentialHostKind = (typeof CONFIDENTIAL_HOST_KINDS)[number];

// What this server's confidential host is, in the words ops_status and the start-up log use.
export const LOCAL_HOST_STATUS = "Confidential host: local (keys sealed in this server's own process)";
export function confidentialHostStatus(env: NodeJS.ProcessEnv = process.env): { kind: string; attested: boolean; status: string } {
  const kind = env.CONFIDENTIAL_HOST || "local";
  if (kind === "local") return { kind, attested: false, status: LOCAL_HOST_STATUS };
  if (!(CONFIDENTIAL_HOST_KINDS as readonly string[]).includes(kind)) return { kind, attested: false, status: `Confidential host: ${kind} isn't a host Mynt knows, so the server won't start with it` };
  return { kind, attested: true, status: `Confidential host: ${kind} (keys sealed in the attested confidential service; this server never falls back to its own process)` };
}

// What a confidential workload is: the hardware and software that ran it and the exact image. Null where a host can't say.
export interface Measurements {
  host: ConfidentialHostKind;
  attested: boolean; // false: nothing here is backed by hardware (the local host)
  image_digest: string | null; // sha256:… of the container image the hardware measured (confidential-VM containers)
  pcrs: EnclavePcrs | null; // the enclave image's measurements (enclave hosts)
  hardware: string | null; // e.g. the attestation's hardware model
  software: string | null; // the confidential OS image's name
  software_version: string | null;
  debug: boolean | null; // whether the workload could be debugged (an operator could read its memory): must be false
  reason: string | null; // why measurements are missing, when they are
}

// An enclave's platform configuration registers, hex SHA-384: pcr0 the whole image file, pcr1 the kernel and boot
// ramdisk, pcr2 the application. What a release announces for an enclave host, and what its key policy names (pcr0).
export interface EnclavePcrs {
  pcr0: string;
  pcr1: string;
  pcr2: string;
}

export interface Attestation {
  host: ConfidentialHostKind;
  // oidc-jwt: a token from a cloud attestation service; nitro-cose: an enclave's attestation document (COSE_Sign1,
  // base64), signed by the hardware's security module; none: the local host.
  format: "oidc-jwt" | "nitro-cose" | "none";
  token: string | null; // the signed token or document (verify-mynt-enclave checks it); null on the local host
  nonce: string;
  keys: EnclaveKeys; // bound into the token's nonces (shared/binding.ts)
  measurements: Measurements;
}

// Signs with a named key the host holds, or with a key Mynt stored sealed to the host (opened only inside it).
export type SigningKeyRef = { name: string } | { sealed: string };

// What may be sealed, by whom, and whether it can ever come back out. The confidential service enforces its own copy
// of this list (deploy/confidential/policy.json, part of the measured image); the local host enforces this one.
export const PURPOSES = {
  // Secrets Mynt's server needs back to do its job (a provider's API key): sealed at rest by the host.
  secret: { unseal: true },
  // The vault's keys, sealed together. Never unsealed as such: releaseVaultKeys hands Mynt's server only what it needs
  // at boot (vault.ts), never the legacy root.
  "vault-keys": { unseal: false },
  // MYNT_VAULT_KEY itself, adopted once by the migration (index.ts: mynt confidential adopt). Never comes back out.
  "vault-legacy-root": { unseal: false },
  // Private keys Mynt holds (e.g. a Solana key): opened only inside the host, to sign (SigningKeyRef.sealed).
  "signing-key": { unseal: false },
  // Partners' ledger statements kept for audit: never readable by Mynt's server.
  "partner-ledger": { unseal: false },
} as const;
export type Purpose = keyof typeof PURPOSES;
export const isPurpose = (p: string): p is Purpose => Object.hasOwn(PURPOSES, p);

export class ConfidentialRefused extends Error {}

// Named keys that sign only inside one operation of the host, never a message a caller hands it: the health attester
// signs only the report computeHealth made (shared/health.ts). Every host refuses them in sign().
export const RESERVED_SIGNING_KEYS: readonly string[] = ["health-attester"];

export interface ConfidentialHost {
  readonly kind: ConfidentialHostKind;
  attest(nonce: string): Promise<Attestation>;
  measurements(): Promise<Measurements>;
  // `context`: what the value is (a platform key's type), bound into the sealed value so it opens only when the same
  // context is named again (shared/sealing.ts). Values sealed before contexts open under any.
  seal(purpose: Purpose, plaintext: Uint8Array, context?: string): Promise<string>;
  unseal(purpose: Purpose, sealed: string, context?: string): Promise<Buffer>; // refused for purposes that never come back out
  // Never with the health-attester key: it signs only inside computeHealth (RESERVED_SIGNING_KEYS).
  sign(key: SigningKeyRef, message: Uint8Array): Promise<{ public_key: string; signature: string }>; // base64url, hex
  publicKey(name: string): Promise<string>; // base64url raw Ed25519
  ingestPublicKey(): Promise<string>; // base64url X25519: what partners seal their statements to
  // A product-health snapshot from a partner's sealed statement (shared/health.ts), computed inside the host.
  computeHealth(input: SealedHealthInput): Promise<SealedHealthResult>;
  // The vault keys (vault.ts): adopt MYNT_VAULT_KEY once, then release the sealed bundle at each boot.
  adoptVaultRoot(legacyRoot: Uint8Array): Promise<string>;
  releaseVaultKeys(sealedBundle: string): Promise<{ data_key: Buffer; derivation_prk: Buffer }>;
  // A host whose root key is kept wrapped outside it: made once, the wrapped form (ciphertext only the host can unwrap)
  // returned for the operator to store where the host reads it at start.
  initialise?(): Promise<{ wrapped_root: string }>;
  // Hosts whose wrapped root Mynt keeps (it holds nothing a restart keeps): handed back after a restart.
  unlock?(wrappedRoot: string): Promise<void>;
}
