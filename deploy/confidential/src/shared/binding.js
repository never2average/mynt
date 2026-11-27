import { createHash, X509Certificate } from "node:crypto";
import { canonicalJson } from "./figures.js";
// How an attestation binds the enclave's keys and a caller's nonce. Pure (node:crypto and ./figures.js only): the same
// file runs on Mynt's server, inside the enclave and in core/scripts/verify-mynt-enclave.mjs, so all three agree.
//
// The attestation token carries two nonces (eat_nonce): the caller's, as given, and `mynt-keys-<sha256 hex>` over the
// canonical JSON of the enclave's public keys. A verifier recomputes the second from the keys returned beside the token,
// so a key Mynt's server swapped in on the way wouldn't match what the hardware attested. Hosts whose attestation has no
// nonce list carry the same two values in their own fields (an enclave's attestation document: nonce and user_data).
export const KEYS_SCHEMA = "mynt.enclave_keys.v1";
export const KEYS_NONCE_PREFIX = "mynt-keys-";
// The attestation service takes nonces of 10 to 74 bytes; Mynt asks for 16 to 64 URL-safe characters.
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const ATTESTATION_AUDIENCE = "mynt-enclave-attestation";
// The one authority whose client certificates the service accepts, as it reached the service (PEM), and the SHA-256
// (hex) of its DER encoding: what the attestation binds as config.client_ca_sha256. Exactly one certificate: a bundle
// would let whoever supplies the setting add an authority of their own behind the expected one. The PEM returned is
// re-encoded from the certificate that was hashed, so what's trusted is exactly what's attested.
export function clientAuthority(pem) {
    const blocks = String(pem).match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;
    if (blocks !== 1 || /-----BEGIN (?!CERTIFICATE-----)/.test(pem))
        throw new Error("the client authority must be exactly one PEM certificate");
    const cert = new X509Certificate(pem);
    if (!cert.ca)
        throw new Error("the client authority isn't a certificate authority");
    return { pem: cert.toString(), sha256: createHash("sha256").update(cert.raw).digest("hex") };
}
export const CLIENT_CA_SHA256 = /^[0-9a-f]{64}$/;
// The named signing keys' part of the bound settings, one entry per name: `signing_key:<name>` -> the key version.
export const signingKeyConfig = (signingKeys) => Object.fromEntries(Object.entries(signingKeys).map(([name, version]) => [`signing_key:${name}`, version]));
// Every setting a verifier expects must be bound, with that value, and nothing may be bound that it has no expected
// value for: a problem per difference, none when they agree.
// `words`: how a difference reads for a setting, e.g. { kms_key: "the service's root is wrapped by" }.
export function configProblems(bound, expected, words = {}) {
    const problems = [];
    const b = bound ?? {};
    for (const [k, want] of Object.entries(expected)) {
        if (!want)
            problems.push(`no expected value was given for ${k}: without one, whoever runs the host could have chosen it`);
        else if (b[k] !== want)
            problems.push(`${words[k] ?? `${k} is`} ${typeof b[k] === "string" && b[k] ? b[k] : "nothing the attestation binds"}, not ${want}`);
    }
    for (const k of Object.keys(b))
        if (!Object.hasOwn(expected, k))
            problems.push(`the attestation binds a setting (${k}) nothing was expected for`);
    return problems;
}
export const keysDigest = (k) => createHash("sha256").update(canonicalJson(k), "utf8").digest("hex");
export const keysNonce = (k) => `${KEYS_NONCE_PREFIX}${keysDigest(k)}`;
export const validNonce = (n) => typeof n === "string" && NONCE_PATTERN.test(n);
