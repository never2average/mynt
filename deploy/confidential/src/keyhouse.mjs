import { createHash, createPrivateKey, createPublicKey, randomBytes, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { KEYS_SCHEMA, keysNonce, validNonce, ATTESTATION_AUDIENCE } from "./shared/binding.js";
import { x25519FromSeed, x25519PublicRaw } from "./shared/envelope.js";
import { computeSealedHealth, HEALTH_ATTESTER_KEY } from "./shared/health.js";
import { childKey, newVaultBundle, releaseFromBundle, sealUnder, unsealUnder } from "./shared/sealing.js";

// The confidential service ("keyhouse"): what Mynt's server asks of the enclave, and the rules it can't talk its way
// past, because they're in this image and the image is what the hardware measures.
//
//   - Its root key is random, made here once, and kept only wrapped by a Cloud KMS key that only this image (by
//     digest, on a production confidential OS) may use. Unwrapped, it exists only in this process's memory.
//   - Each caller (by its client certificate's common name) may do only what policy.json lists for it.
//   - What's sealed for a purpose that never comes back out (the vault's legacy root, partners' books, private keys) has
//     no endpoint that returns it. The vault's keys are released as the data key and the derivation key only.
//   - Partners' sealed statements are opened, checked and computed here; only one product's figures and a signature
//     over their fingerprint leave.
//   - Nothing is logged but the route, the caller and the outcome: never a body, a key, a token or a figure.

const HOST_TAG = "cs";
const ROOT_AAD = Buffer.from("mynt-keyhouse-root-v1");
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ed25519FromSeed = (seed) => createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seed).subarray(0, 32)]), format: "der", type: "pkcs8" });
const rawOf = (key) => (key.type === "public" ? key : createPublicKey(key)).export({ format: "jwk" }).x;
const b64u = (b) => Buffer.from(b).toString("base64url");

export class Refused extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const loadPolicy = (path = new URL("../policy.json", import.meta.url)) => JSON.parse(readFileSync(path, "utf8"));

// config: { kms, launcher, wrapKey, wrappedRoot, signingKeys: { name: version }, tlsSpki, policy, now }
export async function createKeyhouse(config) {
  const { kms, launcher, policy } = config;
  const root = config.wrappedRoot ? await kms.decrypt(config.wrapKey, config.wrappedRoot, ROOT_AAD) : null;
  const publicKeys = new Map();

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
  const kmsVersion = (name) => {
    const v = config.signingKeys?.[name];
    if (!v) throw new Refused("unknown_key", 400);
    return v;
  };
  const publicKey = async (name) => {
    if (!publicKeys.has(name)) publicKeys.set(name, rawOf(createPublicKey(await kms.publicKeyPem(kmsVersion(name)))));
    return publicKeys.get(name);
  };
  const signNamed = async (name, message) => ({ public_key: await publicKey(name), signature: (await kms.sign(kmsVersion(name), message)).toString("hex") });

  const keys = async () => ({
    schema: KEYS_SCHEMA,
    tls_spki_sha256: createHash("sha256").update(config.tlsSpki).digest("hex"),
    ingest_public_key: root ? x25519PublicRaw(ingest()) : "", // empty until initialised: nothing can be sealed to it yet
    signing: Object.fromEntries(await Promise.all(Object.keys(config.signingKeys ?? {}).sort().map(async (n) => [n, await publicKey(n)]))),
  });

  // Informational only: what the token claims, unverified here. Callers verify the token itself.
  const claimsOf = (token) => {
    try {
      return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    } catch {
      return {};
    }
  };

  const routes = {
    "GET /v1/healthz": async () => ({ ok: true, initialised: !!root }),

    // Public through Mynt (GET /confidential/attestation): no caller check beyond the TLS client certificate.
    "GET /v1/attestation": async (_caller, _body, query) => {
      const nonce = query.get("nonce");
      if (!validNonce(nonce)) throw new Refused("bad_nonce", 400);
      const k = await keys();
      const token = await launcher.token({ audience: ATTESTATION_AUDIENCE, nonces: [nonce, keysNonce(k)] });
      const c = claimsOf(token);
      return {
        host: "gcp-confidential-space",
        format: "oidc-jwt",
        token,
        nonce,
        keys: k,
        measurements: {
          host: "gcp-confidential-space",
          attested: true,
          image_digest: c.submods?.container?.image_digest ?? null,
          hardware: c.hwmodel ?? null,
          software: c.swname ?? null,
          software_version: c.swversion?.[0] ?? null,
          debug: c.dbgstat ? c.dbgstat !== "disabled-since-boot" : null,
          reason: null,
        },
      };
    },

    // Once: make the root, wrap it with KMS, and hand back the wrapped form (ciphertext only this image can unwrap) for
    // the operator to store in the VM's metadata as KEYHOUSE_WRAPPED_ROOT. The root isn't used until the service
    // restarts with it there, so nothing is ever sealed under a root that a restart would lose. Refused once there is one.
    "POST /v1/init": async (caller) => {
      allowed(caller, "init", true);
      if (root) throw new Refused("already_initialised", 409);
      const fresh = randomBytes(32);
      const wrapped = await config.kms.encrypt(config.wrapKey, fresh, ROOT_AAD);
      fresh.fill(0);
      return { wrapped_root: wrapped };
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
      return computeSealedHealth({ ...input, host: "gcp-confidential-space" }, { ingest: ingest(), sign: (m) => signNamed(HEALTH_ATTESTER_KEY, m) });
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
