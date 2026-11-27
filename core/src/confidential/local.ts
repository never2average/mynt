import { createPrivateKey, createPublicKey, sign as edSign, type KeyObject } from "node:crypto";
import { derivedKey } from "../vault.js";
import { KEYS_SCHEMA, type EnclaveKeys } from "./shared/binding.js";
import { x25519FromSeed, x25519PublicRaw } from "./shared/envelope.js";
import { computeSealedHealth, HEALTH_ATTESTER_KEY, type SealedHealthInput } from "./shared/health.js";
import { childKey, newVaultBundle, releaseFromBundle, sealUnder, unsealUnder } from "./shared/sealing.js";
import { ConfidentialRefused, isPurpose, PURPOSES, RESERVED_SIGNING_KEYS, type Attestation, type ConfidentialHost, type Measurements, type Purpose, type SigningKeyRef } from "./host.js";

// The local host: everything in Mynt's own process, keyed by a key derived from MYNT_VAULT_KEY. Today's behaviour, so
// development and tests run without a confidential VM, and so every server keeps working until the operator deploys
// the confidential service. It keeps the same rules (purposes that never come back out are refused here too) but it
// protects nothing from whoever runs the server, and its attestation says exactly that.

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export const ed25519FromSeed = (seed: Uint8Array): KeyObject => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed).subarray(0, 32)]), format: "der", type: "pkcs8" });
export const ed25519PublicRaw = (key: KeyObject) => (createPublicKey(key).export({ format: "jwk" }) as { x: string }).x;

const NOT_ATTESTED = "This server uses the local confidential host (CONFIDENTIAL_HOST unset or local): nothing is attested, and Mynt's server can read what it keeps.";
const TAG = "local";

export class LocalConfidentialHost implements ConfidentialHost {
  readonly kind = "local" as const;

  private root(): Buffer {
    const k = derivedKey("confidential-host-local");
    if (!k) throw new ConfidentialRefused("The local confidential host needs MYNT_VAULT_KEY set on the server");
    return k;
  }
  private signer(name: string) {
    return ed25519FromSeed(childKey(this.root(), `sign:${name}`));
  }
  private ingest() {
    return x25519FromSeed(childKey(this.root(), "ingest"));
  }

  async measurements(): Promise<Measurements> {
    return { host: "local", attested: false, image_digest: null, pcrs: null, hardware: null, software: null, software_version: null, debug: null, reason: NOT_ATTESTED };
  }

  async keys(): Promise<EnclaveKeys> {
    return { schema: KEYS_SCHEMA, tls_spki_sha256: "", ingest_public_key: x25519PublicRaw(this.ingest()), signing: { [HEALTH_ATTESTER_KEY]: ed25519PublicRaw(this.signer(HEALTH_ATTESTER_KEY)) } };
  }

  async attest(nonce: string): Promise<Attestation> {
    return { host: "local", format: "none", token: null, nonce, keys: await this.keys(), measurements: await this.measurements() };
  }

  async seal(purpose: Purpose, plaintext: Uint8Array, context?: string) {
    if (!isPurpose(purpose)) throw new ConfidentialRefused(`Unknown purpose ${purpose}`);
    return sealUnder(this.root(), TAG, purpose, plaintext, context);
  }

  async unseal(purpose: Purpose, sealed: string, context?: string) {
    if (!isPurpose(purpose)) throw new ConfidentialRefused(`Unknown purpose ${purpose}`);
    if (!PURPOSES[purpose].unseal) throw new ConfidentialRefused(`What's sealed for ${purpose} never leaves the confidential host`);
    return unsealUnder(this.root(), TAG, purpose, sealed, context);
  }

  private signWith(priv: KeyObject, message: Uint8Array) {
    return { public_key: ed25519PublicRaw(priv), signature: edSign(null, Buffer.from(message), priv).toString("hex") };
  }

  async sign(key: SigningKeyRef, message: Uint8Array) {
    if ("name" in key && RESERVED_SIGNING_KEYS.includes(key.name)) throw new ConfidentialRefused(`The ${key.name} key signs only inside the confidential host's own check, never a message handed to it`);
    return this.signWith("name" in key ? this.signer(key.name) : ed25519FromSeed(unsealUnder(this.root(), TAG, "signing-key", key.sealed)), message);
  }

  async publicKey(name: string) {
    return ed25519PublicRaw(this.signer(name));
  }

  async ingestPublicKey() {
    return x25519PublicRaw(this.ingest());
  }

  async computeHealth(input: SealedHealthInput) {
    return computeSealedHealth({ ...input, host: "local" }, { ingest: this.ingest(), sign: async (m) => this.signWith(this.signer(HEALTH_ATTESTER_KEY), m) });
  }

  async adoptVaultRoot(legacyRoot: Uint8Array) {
    return sealUnder(this.root(), TAG, "vault-keys", newVaultBundle(legacyRoot));
  }

  async releaseVaultKeys(sealedBundle: string) {
    return releaseFromBundle(unsealUnder(this.root(), TAG, "vault-keys", sealedBundle));
  }
}
