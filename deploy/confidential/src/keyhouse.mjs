import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { KEYS_SCHEMA, validNonce } from "./shared/binding.js";
import { x25519FromSeed, x25519PublicRaw } from "./shared/envelope.js";
import { computeSealedHealth, HEALTH_ATTESTER_KEY } from "./shared/health.js";
import { childKey, newVaultBundle, releaseFromBundle, sealUnder, unsealUnder } from "./shared/sealing.js";

// The confidential service ("keyhouse"): what Mynt's server asks of the enclave, and the rules it can't talk its way
// past, because they're in this image and the image is what the hardware measures.
//
//   - Its root key is random, made here once, and kept only wrapped by a KMS key that only this image may use (an
//     enclave attesting this image's PCR0, or a confidential-VM container with this digest on a production OS).
//     Unwrapped, it exists only in this process's memory.
//   - Each caller (by its client certificate's common name) may do only what policy.json lists for it.
//   - What's sealed for a purpose that never comes back out (the vault's legacy root, partners' books, private keys) has
//     no endpoint that returns it. The vault's keys are released as the data key and the derivation key only.
//   - Partners' sealed statements are opened, checked and computed here; only one product's figures and a signature
//     over their fingerprint leave.
//   - Nothing is logged but the route, the caller and the outcome: never a body, a key, a token or a figure.
//
// Where it runs is a platform (nitro.mjs for an AWS Nitro enclave, cloud.mjs for a Google Confidential Space
// container): how it attests, how its root is wrapped and unwrapped, and how its named keys sign. The rest is this file.

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
export const ed25519FromSeed = (seed) => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed).subarray(0, 32)]), format: "der", type: "pkcs8" });
export const rawOf = (key) => (key.type === "public" ? key : createPublicKey(key)).export({ format: "jwk" }).x;
const b64u = (b) => Buffer.from(b).toString("base64url");

export class Refused extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const loadPolicy = (path = new URL("../policy.json", import.meta.url)) => JSON.parse(readFileSync(path, "utf8"));

// A platform: {
//   host, tag             the host's name (as core's ConfidentialHostKind) and the tag sealed values carry
//   signingNames          the named signing keys it offers (health-attester)
//   derivedSigning        true when they're derived from the root (so exist only once it does)
//   config                settings from outside the image that decide whose keys it uses, bound into the attestation
//   attest(nonce, keys, tlsSpki) -> { format, token, measurements }
//   newWrappedRoot()      a fresh root, returned only wrapped
//   unwrapRoot(wrapped)   the root, through the attestation-gated key
//   publicKey(name, root), sign(name, message, root)
// }
//
// config: { platform, wrappedRoot, tlsSpki, policy }. Without a platform, the Confidential Space one is made from
// { kms, launcher, wrapKey, signingKeys } (cloud.mjs).
export async function createKeyhouse(config) {
  const { policy } = config;
  const platform = config.platform ?? (await import("./cloud.mjs")).confidentialSpacePlatform(config);
  const HOST_TAG = platform.tag;
  let root = config.wrappedRoot ? await platform.unwrapRoot(config.wrappedRoot) : null;

  const requireRoot = () => {
    if (!root) throw new Refused("not_initialised", 409);
    return root;
  };
  const allowed = (caller, action, what) => {
    const rules = policy.callers?.[caller];
    const list = rules?.[action];
    if (list === true || (Array.isArray(list) && what !== undefined && list.includes(what))) return;
    throw new Refused("not_allowed");
  };
  const purposeOf = (p) => {
    if (!Object.hasOwn(policy.purposes, p)) throw new Refused("unknown_purpose", 400);
    return policy.purposes[p];
  };
  const ingest = () => x25519FromSeed(childKey(requireRoot(), "ingest"));
  const known = (name) => {
    if (!platform.signingNames.includes(name)) throw new Refused("unknown_key", 400);
    if (platform.derivedSigning) requireRoot();
  };
  const publicKey = async (name) => (known(name), platform.publicKey(name, root));
  const signNamed = async (name, message) => (known(name), platform.sign(name, message, root));

  const keys = async () => ({
    schema: KEYS_SCHEMA,
    tls_spki_sha256: createHash("sha256").update(config.tlsSpki).digest("hex"),
    ingest_public_key: root ? x25519PublicRaw(ingest()) : "", // empty until initialised: nothing can be sealed to it yet
    // Keys derived from the root exist only once it does.
    signing: Object.fromEntries(
      await Promise.all(
        [...platform.signingNames]
          .filter(() => root || !platform.derivedSigning)
          .sort()
          .map(async (n) => [n, await publicKey(n)]),
      ),
    ),
    ...(platform.config ? { config: platform.config } : {}),
  });

  const routes = {
    "GET /v1/healthz": async () => ({ ok: true, host: platform.host, initialised: !!root }),

    // Public through Mynt (GET /confidential/attestation): no caller check beyond the TLS client certificate.
    "GET /v1/attestation": async (_caller, _body, query) => {
      const nonce = query.get("nonce");
      if (!validNonce(nonce)) throw new Refused("bad_nonce", 400);
      const k = await keys();
      const { format, token, measurements } = await platform.attest(nonce, k, config.tlsSpki);
      return { host: platform.host, format, token, nonce, keys: k, measurements };
    },

    // Once: make the root, wrap it with KMS, and hand back the wrapped form (ciphertext only this image can unwrap) for
    // Mynt to keep (an enclave) or the operator to store in the VM's metadata (KEYHOUSE_WRAPPED_ROOT). The root isn't
    // used until it comes back (POST /v1/unlock, or a restart with it in the metadata), so nothing is ever sealed under
    // a root whose wrapped form nobody kept. Refused once there is one.
    "POST /v1/init": async (caller) => {
      allowed(caller, "init", true);
      if (root) throw new Refused("already_initialised", 409);
      return { wrapped_root: await platform.newWrappedRoot() };
    },

    // The wrapped root, handed back by Mynt after a restart (an enclave keeps nothing). Only KMS, through the policy
    // that admits this image alone, can unwrap it; one that doesn't unwrap leaves the service locked.
    "POST /v1/unlock": async (caller, body) => {
      allowed(caller, "init", true);
      if (root) throw new Refused("already_initialised", 409);
      const wrapped = String(body.wrapped_root ?? "");
      if (!wrapped) throw new Refused("bad_root", 400);
      try {
        root = await platform.unwrapRoot(wrapped);
      } catch {
        throw new Refused("unwrap_failed", 400);
      }
      return { ok: true };
    },

    "POST /v1/seal": async (caller, body) => {
      purposeOf(body.purpose);
      allowed(caller, "seal", body.purpose);
      if (body.purpose === "vault-keys") throw new Refused("use_vault_adopt", 400);
      return { sealed: sealUnder(requireRoot(), HOST_TAG, body.purpose, Buffer.from(String(body.plaintext ?? ""), "base64url")) };
    },

    "POST /v1/unseal": async (caller, body) => {
      const p = purposeOf(body.purpose);
      if (!p.unseal) throw new Refused("never_unsealed");
      allowed(caller, "unseal", body.purpose);
      try {
        return { plaintext: b64u(unsealUnder(requireRoot(), HOST_TAG, body.purpose, String(body.sealed ?? ""))) };
      } catch (e) {
        if (e instanceof Refused) throw e;
        throw new Refused("unseal_failed", 400);
      }
    },

    "POST /v1/sign": async (caller, body) => {
      const message = Buffer.from(String(body.message ?? ""), "base64url");
      if (body.key?.name) {
        allowed(caller, "sign", body.key.name);
        return signNamed(body.key.name, message);
      }
      if (typeof body.key?.sealed === "string") {
        allowed(caller, "sign", "sealed");
        let priv;
        try {
          priv = ed25519FromSeed(unsealUnder(requireRoot(), HOST_TAG, "signing-key", body.key.sealed));
        } catch {
          throw new Refused("unseal_failed", 400);
        }
        return { public_key: rawOf(priv), signature: edSign(null, message, priv).toString("hex") };
      }
      throw new Refused("bad_key", 400);
    },

    "GET /v1/public-key": async (caller, _body, query) => {
      allowed(caller, "sign", query.get("name") ?? "");
      return { public_key: await publicKey(query.get("name")) };
    },

    "POST /v1/health/compute": async (caller, body) => {
      allowed(caller, "health", true);
      const input = body.input;
      if (!input?.envelope || !input.expect || !input.report || !input.flows) throw new Refused("bad_input", 400);
      return computeSealedHealth({ ...input, host: platform.host }, { ingest: ingest(), sign: (m) => signNamed(HEALTH_ATTESTER_KEY, m) });
    },

    "POST /v1/vault/adopt": async (caller, body) => {
      allowed(caller, "vault", "adopt");
      const legacy = Buffer.from(String(body.legacy_root ?? ""), "base64url");
      if (legacy.length !== 32) throw new Refused("bad_root", 400);
      return { sealed: sealUnder(requireRoot(), HOST_TAG, "vault-keys", newVaultBundle(legacy)) };
    },

    "POST /v1/vault/release": async (caller, body) => {
      allowed(caller, "vault", "release");
      let r;
      try {
        r = releaseFromBundle(unsealUnder(requireRoot(), HOST_TAG, "vault-keys", String(body.sealed ?? "")));
      } catch {
        throw new Refused("unseal_failed", 400);
      }
      return { data_key: b64u(r.data_key), derivation_prk: b64u(r.derivation_prk) };
    },
  };

  return {
    initialised: () => !!root,
    keys,
    // One request: the route, the caller (from its verified client certificate), the parsed body and query.
    async handle(method, pathname, caller, body, query) {
      const route = routes[`${method} ${pathname}`];
      if (!route) throw new Refused("not_found", 404);
      return route(caller, body ?? {}, query ?? new URLSearchParams());
    },
  };
}

// Signing keys derived from the root, for platforms whose KMS can't gate signing on attestation (nitro.mjs): each an
// Ed25519 key from HKDF of the root, so it exists only where the root does, inside the attested image.
export const derivedSigner = (name, root) => ed25519FromSeed(childKey(root, `sign:${name}`));
