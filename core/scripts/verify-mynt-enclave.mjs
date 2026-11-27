#!/usr/bin/env node
// Checks Mynt's confidential service yourself, before you seal your books to it. Run from a checkout of the release you
// expect (after `npm ci && npm run build` in core/), with the measurements that release's CI published (they're also in
// list_enclave_releases; take them from the release, not from Mynt's answer):
//
//   An enclave (the default deployment):
//     node scripts/verify-mynt-enclave.mjs --url https://<mynt>/confidential/attestation \
//       --expected-pcr0 <96 hex> --expected-pcr1 <96 hex> --expected-pcr2 <96 hex> \
//       --expected-kms-key <arn> --expected-client-ca-sha256 <64 hex>
//   A confidential-VM container:
//     node scripts/verify-mynt-enclave.mjs --url https://<mynt>/confidential/attestation --expected-digest sha256:<64 hex> \
//       --expected-wrap-key <key name> --expected-signing-key health-attester=<key version name> \
//       --expected-client-ca-sha256 <64 hex>
//
// The key names and the client authority's SHA-256 are required, not optional: they're the settings that reach the
// service from outside its measured image (which key wraps its root, which keys sign, whose client certificates may
// call it). Mynt publishes them with each release announcement; keep the ones you were first given, and ask why if
// they ever change. Without them an honest image could be wrapped by a key someone else controls, or called by
// someone who isn't Mynt's server.
//
// What's checked, and every problem printed:
//   - an enclave's attestation document: its COSE signature (ES384), its certificate chain up to the AWS Nitro
//     Enclaves root certificate pinned in core/src/confidential/aws-nitro.ts (never one from Mynt), its freshness, and
//     pcr0, pcr1 and pcr2 equal to the ones you expect (and not a debug-mode enclave's zeros);
//   - or a container's attestation token: its signature, with the attestation service's published keys (fetched from
//     Google, never from Mynt), issuer, audience and expiry; a production confidential OS with secure boot and
//     debugging off since boot; the image digest you expect;
//   - either way, your fresh nonce (not a replay), and the binding of the keys returned beside it, so the ingest key
//     you'll seal to and the attester key that signs snapshots are the ones the hardware attested;
//   - and the settings bound with those keys: the key that wraps the service's root, the keys it signs with (a
//     container) and the authority whose client certificates it accepts are exactly the ones you expect.
// Exit status 0 only when all of it holds; then it prints the keys to use. Offline: --attestation-file <json> --nonce
// <the nonce it was fetched with> (and --jwks-file <json> for a container token).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyNitroAttestation } from "../dist/confidential/aws-nitro.js";
import { fetchAttestationJwks, verifyAttestationToken } from "../dist/confidential/attestation-verify.js";
import { ATTESTATION_AUDIENCE } from "../dist/confidential/shared/binding.js";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    "expected-digest": { type: "string" },
    "expected-pcr0": { type: "string" },
    "expected-pcr1": { type: "string" },
    "expected-pcr2": { type: "string" },
    "expected-kms-key": { type: "string" },
    "expected-client-ca-sha256": { type: "string" },
    "expected-wrap-key": { type: "string" },
    "expected-signing-key": { type: "string", multiple: true },
    "attestation-file": { type: "string" },
    nonce: { type: "string" },
    "jwks-file": { type: "string" },
    // Tests only: a test authority instead of the pinned root.
    "test-root-file": { type: "string" },
    json: { type: "boolean" },
  },
});
const die = (m) => {
  console.error(m);
  process.exit(2);
};
const PCR = /^[0-9a-f]{96}$/;
const wantsPcrs = values["expected-pcr0"] !== undefined || values["expected-pcr1"] !== undefined || values["expected-pcr2"] !== undefined;
const expectedPcrs = wantsPcrs ? { pcr0: values["expected-pcr0"] ?? "", pcr1: values["expected-pcr1"] ?? "", pcr2: values["expected-pcr2"] ?? "" } : null;
if (expectedPcrs && !Object.values(expectedPcrs).every((p) => PCR.test(p))) die("--expected-pcr0, --expected-pcr1 and --expected-pcr2 are each 96 lowercase hex digits");
const expected = values["expected-digest"];
if (!expectedPcrs && !expected) die("Give the measurements published for the release you expect: --expected-pcr0/1/2 for an enclave, or --expected-digest for a container");
if (expected && !/^sha256:[0-9a-f]{64}$/.test(expected)) die("--expected-digest must be sha256: and 64 lowercase hex digits");
// Required, never optional: what decides whose keys the service uses and who may call it.
const expectedClientCa = values["expected-client-ca-sha256"];
if (!/^[0-9a-f]{64}$/.test(expectedClientCa ?? "")) die("--expected-client-ca-sha256 is required: the SHA-256 (64 lowercase hex digits) of the authority whose client certificates the service accepts, as Mynt published it");
const expectedKmsKey = values["expected-kms-key"];
if (expectedPcrs && !/^arn:[^:]+:kms:[^:]+:/.test(expectedKmsKey ?? "")) die("--expected-kms-key is required for an enclave: the ARN of the KMS key that wraps the service's root, as Mynt published it");
const expectedSigningKeys = {};
for (const pair of values["expected-signing-key"] ?? []) {
  const at = pair.indexOf("=");
  if (at < 1 || at === pair.length - 1) die("--expected-signing-key is <name>=<key version>, e.g. health-attester=projects/…/cryptoKeyVersions/1");
  expectedSigningKeys[pair.slice(0, at)] = pair.slice(at + 1);
}
if (expected && !values["expected-wrap-key"]) die("--expected-wrap-key is required for a container: the name of the key that wraps the service's root, as Mynt published it");
if (expected && !Object.keys(expectedSigningKeys).length) die("--expected-signing-key is required for a container (once per key): the key version behind each signing key, as Mynt published it");

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
const out = { ok: false, problems, notes: [], host: attestation.host ?? null };
if (attestation.nonce !== nonce) problems.push("the answer names another nonce");
if (attestation.format === "nitro-cose" && attestation.token) {
  if (!expectedPcrs) problems.push("this is an enclave's attestation: give --expected-pcr0, --expected-pcr1 and --expected-pcr2");
  const roots = values["test-root-file"] ? [readFileSync(values["test-root-file"], "utf8")] : undefined;
  const check = verifyNitroAttestation(attestation.token, { nonce, keys: attestation.keys, allowedPcrs: expectedPcrs ? [expectedPcrs] : [], expectedKmsKey: expectedKmsKey ?? null, expectedClientCaSha256: expectedClientCa, roots });
  problems.push(...check.problems);
  Object.assign(out, { pcrs: check.pcrs, module: check.document?.module_id ?? null, kms_key: attestation.keys?.config?.kms_key ?? null, client_ca_sha256: attestation.keys?.config?.client_ca_sha256 ?? null });
  const announced = expectedPcrs && (attestation.releases ?? []).find((r) => r.pcrs?.pcr0 === expectedPcrs.pcr0 && r.pcrs?.pcr1 === expectedPcrs.pcr1 && r.pcrs?.pcr2 === expectedPcrs.pcr2);
  if (!announced) out.notes.push("Mynt hasn't announced these PCRs (list_enclave_releases): ask why before relying on them");
  else if (!announced.in_effect) out.notes.push(`Mynt announced these PCRs, in effect from ${announced.effective_at}`);
} else if (attestation.format === "oidc-jwt" && attestation.token) {
  if (!expected) problems.push("this is a container's attestation: give --expected-digest");
  const jwks = values["jwks-file"] ? JSON.parse(readFileSync(values["jwks-file"], "utf8")) : await fetchAttestationJwks();
  const check = verifyAttestationToken(attestation.token, { jwks, audience: ATTESTATION_AUDIENCE, nonce, keys: attestation.keys, allowedDigests: expected ? [expected] : [], expectedCustody: expected ? { wrapKey: values["expected-wrap-key"], signingKeys: expectedSigningKeys, clientCaSha256: expectedClientCa } : null });
  problems.push(...check.problems);
  const claims = check.claims;
  Object.assign(out, { image_digest: claims?.submods?.container?.image_digest ?? null, hardware: claims?.hwmodel ?? null, os_version: claims?.swversion?.[0] ?? null, wrap_key: attestation.keys?.config?.wrap_key ?? null, client_ca_sha256: attestation.keys?.config?.client_ca_sha256 ?? null });
  const announced = (attestation.releases ?? []).find((r) => r.image_digest === expected);
  if (!announced) out.notes.push("Mynt hasn't announced this digest (list_enclave_releases): ask why before relying on it");
  else if (!announced.in_effect) out.notes.push(`Mynt announced this digest, in effect from ${announced.effective_at}`);
} else {
  problems.push(`no hardware attestation: ${attestation.measurements?.reason ?? "the service gave no token"}`);
}

out.ok = problems.length === 0;
if (out.ok) Object.assign(out, { ingest_public_key: attestation.keys.ingest_public_key, health_attester_key: attestation.keys.signing?.["health-attester"] ?? null });
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
