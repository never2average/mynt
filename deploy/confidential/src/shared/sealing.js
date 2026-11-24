import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
// Sealing under a confidential host's root key, and the vault's keys. Pure (node:crypto only): the same file runs in the
// local host (keyed by MYNT_VAULT_KEY) and inside the confidential service (keyed by a root only the attested image can
// unwrap), so the format is one format.
//
// A sealed value: cs1:<host tag>:<purpose>:<iv>:<tag>:<ciphertext> (base64url), AES-256-GCM under
// HKDF-SHA256(root, "mynt-confidential-v1:<purpose>"), with the host tag and purpose as associated data, so a value
// sealed for one purpose never opens as another, and one sealed by one host never opens on the other.
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
export const purposeKey = (root, purpose) => Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), `mynt-confidential-v1:${purpose}`, 32));
export const childKey = (root, label) => Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), `mynt-confidential-v1:key:${label}`, 32));
export function sealUnder(root, hostTag, purpose, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", purposeKey(root, purpose), iv);
    cipher.setAAD(Buffer.from(`${hostTag}|${purpose}`, "utf8"));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ["cs1", hostTag, purpose, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(":");
}
export function unsealUnder(root, hostTag, purpose, sealed) {
    const [v, tagOfHost, p, iv, tag, ct] = sealed.split(":");
    if (v !== "cs1" || tagOfHost !== hostTag || p !== purpose || !iv || !tag || ct === undefined)
        throw new Error("not sealed for this host and purpose");
    const decipher = createDecipheriv("aes-256-gcm", purposeKey(root, purpose), unb64u(iv));
    decipher.setAAD(Buffer.from(`${hostTag}|${purpose}`, "utf8"));
    decipher.setAuthTag(unb64u(tag));
    return Buffer.concat([decipher.update(unb64u(ct)), decipher.final()]);
}
// ---- the vault's keys (core/src/vault.ts) ----
//
// The bundle holds MYNT_VAULT_KEY (the legacy root) and a fresh data key. What leaves at boot is the data key (new
// values are sealed with it, and the migration re-wraps old ones to it) and HKDF-Extract of the legacy root: every key
// Mynt derives from MYNT_VAULT_KEY (MACs, on-chain subject hashes, sandbox keys) is HKDF-Expand of that, so derived keys
// stay exactly the same while the root itself, which opens every pre-migration value, never leaves the host.
export const derivationPrk = (root) => createHmac("sha256", Buffer.alloc(32)).update(Buffer.from(root)).digest();
// HKDF-Expand for one 32-byte block: equal to hkdfSync("sha256", root, <empty salt>, info, 32).
export const expandKey = (prk, info) => createHmac("sha256", Buffer.from(prk)).update(Buffer.concat([Buffer.from(info, "utf8"), Buffer.from([1])])).digest();
export function newVaultBundle(legacyRoot) {
    if (legacyRoot.length !== 32)
        throw new Error("The vault root is 32 bytes");
    return Buffer.concat([Buffer.from([1]), Buffer.from(legacyRoot), randomBytes(32)]);
}
export function releaseFromBundle(bundle) {
    const b = Buffer.from(bundle);
    if (b.length !== 65 || b[0] !== 1)
        throw new Error("not a vault bundle");
    return { data_key: Buffer.from(b.subarray(33, 65)), derivation_prk: derivationPrk(b.subarray(1, 33)) };
}
