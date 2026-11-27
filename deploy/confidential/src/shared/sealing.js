import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
// Sealing under a confidential host's root key, and the vault's keys. Pure (node:crypto only): the same file runs in the
// local host (keyed by MYNT_VAULT_KEY) and inside the confidential service (keyed by a root only the attested image can
// unwrap), so the format is one format.
//
// A sealed value: cs1:<host tag>:<purpose>:<iv>:<tag>:<ciphertext> (base64url), AES-256-GCM under
// HKDF-SHA256(root, "mynt-confidential-v1:<purpose>"), with the host tag and purpose as associated data, so a value
// sealed for one purpose never opens as another, and one sealed by one host never opens on the other.
//
// Sealed with a context (what the value is: a platform key's type), it is cs2:… with the context in the associated data
// too, so a row moved to another context in the database never opens there. The context isn't stored in the value: the
// caller names it again to open. A cs1 value (sealed before contexts) still opens, whatever context is named; nothing
// can turn a cs2 value into a cs1 one, and callers seal again with the context the next time they write.
export const SEAL_CONTEXT = /^[A-Za-z0-9_.-]{1,128}$/;
const aad = (hostTag, purpose, context) => Buffer.from(context ? `${hostTag}|${purpose}|${context}` : `${hostTag}|${purpose}`, "utf8");
// Whether a sealed value binds a context (cs2). Callers use it to seal an older value again.
export const bindsContext = (sealed) => sealed.startsWith("cs2:");
const b64u = (b) => Buffer.from(b).toString("base64url");
const unb64u = (s) => Buffer.from(s, "base64url");
export const purposeKey = (root, purpose) => Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), `mynt-confidential-v1:${purpose}`, 32));
export const childKey = (root, label) => Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), `mynt-confidential-v1:key:${label}`, 32));
export function sealUnder(root, hostTag, purpose, plaintext, context = "") {
    if (context && !SEAL_CONTEXT.test(context))
        throw new Error("a sealing context is 1 to 128 letters, digits, dots, dashes or underscores");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", purposeKey(root, purpose), iv);
    cipher.setAAD(aad(hostTag, purpose, context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return [context ? "cs2" : "cs1", hostTag, purpose, b64u(iv), b64u(cipher.getAuthTag()), b64u(ct)].join(":");
}
export function unsealUnder(root, hostTag, purpose, sealed, context = "") {
    const [v, tagOfHost, p, iv, tag, ct] = sealed.split(":");
    if ((v !== "cs1" && v !== "cs2") || tagOfHost !== hostTag || p !== purpose || !iv || !tag || ct === undefined)
        throw new Error("not sealed for this host and purpose");
    if (context && !SEAL_CONTEXT.test(context))
        throw new Error("not a sealing context");
    // cs2 binds its context, and never opens without the same one; cs1 was sealed before contexts and has none.
    if (v === "cs2" && !context)
        throw new Error("this value is sealed to a context: name it");
    const decipher = createDecipheriv("aes-256-gcm", purposeKey(root, purpose), unb64u(iv));
    decipher.setAAD(aad(hostTag, purpose, v === "cs2" ? context : ""));
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
