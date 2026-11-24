import { createHash } from "node:crypto";
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
export const keysDigest = (k) => createHash("sha256").update(canonicalJson(k), "utf8").digest("hex");
export const keysNonce = (k) => `${KEYS_NONCE_PREFIX}${keysDigest(k)}`;
export const validNonce = (n) => typeof n === "string" && NONCE_PATTERN.test(n);
