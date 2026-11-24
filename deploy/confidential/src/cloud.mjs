import { createPublicKey, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request } from "node:http";
import { ATTESTATION_AUDIENCE, keysNonce } from "./shared/binding.js";

// The two things the service asks of the confidential VM's cloud, and nothing else:
//
//   - attestation tokens, from the container launcher over its local socket: a token whose eat_nonce carries the
//     caller's nonce and the binding of the service's keys, for partners and Mynt's server to check;
//   - Cloud KMS, as the workload: the launcher keeps a fresh attestation token (audience: Google's token service) in a
//     file; the service exchanges it for an access token through the workload identity pool the operator set up, whose
//     condition admits only this image's digest on a production confidential OS. KMS then wraps the root key and signs
//     with the Ed25519 keys. No human principal holds those KMS permissions (docs/reference.md).
//
// Every URL and path is injectable, so tests run it against fakes. Nothing here logs a token or a key.

export const LAUNCHER_SOCKET = "/run/container_launcher/teeserver.sock";
export const LAUNCHER_TOKEN_FILE = "/run/container_launcher/attestation_verifier_claims_token";
const STS_URL = "https://sts.googleapis.com/v1/token";
const KMS_URL = "https://cloudkms.googleapis.com/v1";

export function launcherClient({ socketPath = LAUNCHER_SOCKET, tokenFile = LAUNCHER_TOKEN_FILE } = {}) {
  return {
    // A custom-audience token with up to six nonces (each 10 to 74 bytes).
    token({ audience, nonces }) {
      return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify({ audience, token_type: "OIDC", nonces }));
        const req = request({ socketPath, method: "POST", path: "/v1/token", host: "localhost", headers: { "content-type": "application/json", "content-length": body.length } }, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString("utf8").trim()) : reject(new Error(`the launcher answered ${res.statusCode}`))));
        });
        req.on("error", reject);
        req.end(body);
      });
    },
    // The token the launcher refreshes for the token service.
    stsSubjectToken: async () => (await readFile(tokenFile, "utf8")).trim(),
  };
}

export function kmsClient({ provider, subjectToken, fetchImpl = fetch, stsUrl = STS_URL, kmsUrl = KMS_URL }) {
  let access = null;
  const token = async () => {
    if (access && access.until > Date.now() + 60_000) return access.token;
    const r = await fetchImpl(stsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grantType: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: `//iam.googleapis.com/${provider}`,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        requestedTokenType: "urn:ietf:params:oauth:token-type:access_token",
        subjectToken: await subjectToken(),
        subjectTokenType: "urn:ietf:params:oauth:token-type:jwt",
      }),
    });
    if (!r.ok) throw new Error(`the token service answered ${r.status}`);
    const j = await r.json();
    access = { token: j.access_token, until: Date.now() + (Number(j.expires_in) || 300) * 1000 };
    return access.token;
  };
  const call = async (method, path, body) => {
    const r = await fetchImpl(`${kmsUrl}/${path}`, { method, headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error(`KMS answered ${r.status} for ${path.split("/").slice(-1)[0]}`);
    return r.json();
  };
  const b64 = (b) => Buffer.from(b).toString("base64");
  return {
    async encrypt(key, plaintext, aad) {
      return (await call("POST", `${key}:encrypt`, { plaintext: b64(plaintext), additionalAuthenticatedData: b64(aad) })).ciphertext;
    },
    async decrypt(key, ciphertext, aad) {
      return Buffer.from((await call("POST", `${key}:decrypt`, { ciphertext, additionalAuthenticatedData: b64(aad) })).plaintext, "base64");
    },
    // EC_SIGN_ED25519 is PureEdDSA: the message itself goes in `data`, not a digest.
    async sign(version, message) {
      return Buffer.from((await call("POST", `${version}:asymmetricSign`, { data: b64(message) })).signature, "base64");
    },
    async publicKeyPem(version) {
      return (await call("GET", `${version}/publicKey`)).pem;
    },
  };
}

// The Confidential Space platform for the keyhouse (keyhouse.mjs): attestation tokens from the launcher, the root
// wrapped by a Cloud KMS symmetric key, and named keys signed by Cloud KMS Ed25519 keys, each usable only by this image.
const ROOT_AAD = Buffer.from("mynt-keyhouse-root-v1");

export function confidentialSpacePlatform({ kms, launcher, wrapKey, signingKeys = {} }) {
  const publicKeys = new Map();
  const publicKey = async (name) => {
    if (!publicKeys.has(name)) publicKeys.set(name, createPublicKey(await kms.publicKeyPem(signingKeys[name])).export({ format: "jwk" }).x);
    return publicKeys.get(name);
  };
  // Informational only: what the token claims, unverified here. Callers verify the token itself.
  const claimsOf = (token) => {
    try {
      return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    } catch {
      return {};
    }
  };
  return {
    host: "gcp-confidential-space",
    tag: "cs",
    signingNames: Object.keys(signingKeys),
    derivedSigning: false,
    config: null,
    async attest(nonce, keys) {
      const token = await launcher.token({ audience: ATTESTATION_AUDIENCE, nonces: [nonce, keysNonce(keys)] });
      const c = claimsOf(token);
      return {
        format: "oidc-jwt",
        token,
        measurements: {
          host: "gcp-confidential-space",
          attested: true,
          image_digest: c.submods?.container?.image_digest ?? null,
          pcrs: null,
          hardware: c.hwmodel ?? null,
          software: c.swname ?? null,
          software_version: c.swversion?.[0] ?? null,
          debug: c.dbgstat ? c.dbgstat !== "disabled-since-boot" : null,
          reason: null,
        },
      };
    },
    async newWrappedRoot() {
      const fresh = randomBytes(32);
      try {
        return await kms.encrypt(wrapKey, fresh, ROOT_AAD);
      } finally {
        fresh.fill(0);
      }
    },
    unwrapRoot: (wrapped) => kms.decrypt(wrapKey, wrapped, ROOT_AAD),
    publicKey: (name) => publicKey(name),
    async sign(name, message) {
      return { public_key: await publicKey(name), signature: (await kms.sign(signingKeys[name], message)).toString("hex") };
    },
  };
}
