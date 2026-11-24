#!/usr/bin/env node
// Checks Mynt's confidential service yourself, before you seal your books to it. Run from a checkout of the release you
// expect (after `npm ci && npm run build` in core/):
//
//   node scripts/verify-mynt-enclave.mjs --url https://<mynt>/confidential/attestation --expected-digest sha256:<64 hex>
//
// The expected digest is the one CI's confidential-image job printed for that release (and list_enclave_releases
// shows); take it from the release, not from Mynt's answer. What's checked, and every problem printed:
//   - the attestation token's signature, with the attestation service's published keys (fetched from Google, never
//     from Mynt), its issuer, audience and expiry;
//   - a production confidential OS (swname, STABLE support), secure boot on, and debugging off since boot, so nobody,
//     Mynt's operators included, could read the service's memory;
//   - the container image digest equals the one you expect;
//   - your fresh nonce is in the token (not a replay), and so is the binding of the keys returned beside it, so the
//     ingest key you'll seal to and the attester key that signs snapshots are the ones the hardware attested.
// Exit status 0 only when all of it holds; then it prints the keys to use. Offline: --attestation-file <json> --nonce
// <the nonce it was fetched with> --jwks-file <json>.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fetchAttestationJwks, verifyAttestationToken } from "../dist/confidential/attestation-verify.js";
import { ATTESTATION_AUDIENCE } from "../dist/confidential/shared/binding.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "expected-digest": { type: "string" },
    "attestation-file": { type: "string" },
    nonce: { type: "string" },
    "jwks-file": { type: "string" },
    json: { type: "boolean" },
  },
});
const die = (m) => {
  console.error(m);
  process.exit(2);
};
const expected = values["expected-digest"] ?? die("--expected-digest sha256:<64 hex> is required: the digest published for the release you expect");
if (!/^sha256:[0-9a-f]{64}$/.test(expected)) die("--expected-digest must be sha256: and 64 lowercase hex digits");

let nonce;
let attestation;
if (values["attestation-file"]) {
  nonce = values.nonce ?? die("--nonce is required with --attestation-file: the nonce it was fetched with");
  attestation = JSON.parse(readFileSync(values["attestation-file"], "utf8"));
} else {
  const url = values.url ?? die("--url https://<mynt>/confidential/attestation is required");
  nonce = randomBytes(24).toString("base64url");
  const r = await fetch(`${url}?nonce=${nonce}`);
  if (!r.ok) die(`${url} answered ${r.status}`);
  attestation = await r.json();
}

const problems = [];
if (attestation.format !== "oidc-jwt" || !attestation.token) problems.push(`no hardware attestation: ${attestation.measurements?.reason ?? "the service gave no token"}`);
if (attestation.nonce !== nonce) problems.push("the answer names another nonce");
let claims = null;
if (attestation.token) {
  const jwks = values["jwks-file"] ? JSON.parse(readFileSync(values["jwks-file"], "utf8")) : await fetchAttestationJwks();
  const check = verifyAttestationToken(attestation.token, { jwks, audience: ATTESTATION_AUDIENCE, nonce, keys: attestation.keys, allowedDigests: [expected] });
  problems.push(...check.problems);
  claims = check.claims;
}
const announced = (attestation.releases ?? []).find((r) => r.image_digest === expected);
const notes = [];
if (!announced) notes.push("Mynt hasn't announced this digest (list_enclave_releases): ask why before relying on it");
else if (!announced.in_effect) notes.push(`Mynt announced this digest, in effect from ${announced.effective_at}`);

const out = {
  ok: problems.length === 0,
  problems,
  notes,
  image_digest: claims?.submods?.container?.image_digest ?? null,
  hardware: claims?.hwmodel ?? null,
  os_version: claims?.swversion?.[0] ?? null,
  ...(problems.length === 0 ? { ingest_public_key: attestation.keys.ingest_public_key, health_attester_key: attestation.keys.signing?.["health-attester"] ?? null } : {}),
};
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
