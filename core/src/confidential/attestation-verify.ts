import { createPublicKey, verify, type JsonWebKey } from "node:crypto";
import { keysNonce, type EnclaveKeys } from "./shared/binding.js";

// Checks an attestation token from the confidential VM's attestation service: an OIDC JWT (RS256) signed by the
// service's published keys. Used by Mynt's own client before it trusts the confidential service at all, and by
// core/scripts/verify-mynt-enclave.mjs, which partners run themselves. No JWT library: node:crypto verifies RS256.
//
// What must hold, all of it:
//   - the signature verifies with a key from the issuer's JWKS, and iss, aud, exp, nbf/iat are right;
//   - swname is the confidential OS, dbgstat says debugging has been off since boot, the OS image is a supported
//     production one (support_attributes has STABLE), and secure boot was on;
//   - the container's image digest is one Mynt announced for this release (governance.ts) or the one the caller expects;
//   - eat_nonce has the caller's nonce and the binding of the enclave's keys (shared/binding.ts).

export const ATTESTATION_ISSUER = "https://confidentialcomputing.googleapis.com";
export const ATTESTATION_DISCOVERY = `${ATTESTATION_ISSUER}/.well-known/openid-configuration`;
export const CONFIDENTIAL_OS = "CONFIDENTIAL_SPACE";
export const DEBUG_OFF = "disabled-since-boot";
const SKEW_S = 60;

export interface Jwks {
  keys: (JsonWebKey & { kid?: string })[];
}
export interface TokenClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  eat_nonce?: string | string[];
  swname?: string;
  swversion?: string[];
  dbgstat?: string;
  hwmodel?: string;
  secboot?: boolean;
  submods?: { container?: { image_digest?: string; image_reference?: string }; confidential_space?: { support_attributes?: string[] } };
}
export interface TokenCheck {
  ok: boolean;
  problems: string[];
  claims: TokenClaims | null;
}

const part = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Record<string, unknown>;

export function verifyAttestationToken(
  token: string,
  x: { jwks: Jwks; audience: string; nonce: string; keys: EnclaveKeys; allowedDigests: string[]; now?: Date; requireStable?: boolean },
): TokenCheck {
  const problems: string[] = [];
  const pieces = token.split(".");
  if (pieces.length !== 3) return { ok: false, problems: ["the token isn't a JWT"], claims: null };
  let header: { alg?: string; kid?: string };
  let claims: TokenClaims;
  try {
    header = part(pieces[0]) as typeof header;
    claims = part(pieces[1]) as TokenClaims;
  } catch {
    return { ok: false, problems: ["the token can't be decoded"], claims: null };
  }
  if (header.alg !== "RS256") problems.push(`the token is signed with ${header.alg ?? "nothing"}, not RS256`);
  const candidates = x.jwks.keys.filter((k) => (header.kid ? k.kid === header.kid : true) && k.kty === "RSA");
  const signed = Buffer.from(`${pieces[0]}.${pieces[1]}`, "utf8");
  const sig = Buffer.from(pieces[2], "base64url");
  const verified = candidates.some((k) => {
    try {
      return verify("RSA-SHA256", signed, createPublicKey({ key: k, format: "jwk" }), sig);
    } catch {
      return false;
    }
  });
  if (!verified) problems.push("the signature doesn't verify with the attestation service's published keys");

  const now = Math.floor((x.now ?? new Date()).getTime() / 1000);
  if (claims.iss !== ATTESTATION_ISSUER) problems.push(`issuer is ${claims.iss ?? "missing"}, expected ${ATTESTATION_ISSUER}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(x.audience)) problems.push(`audience isn't ${x.audience}`);
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) problems.push("the token has expired");
  if (typeof claims.nbf === "number" && claims.nbf - SKEW_S > now) problems.push("the token isn't valid yet");

  if (claims.swname !== CONFIDENTIAL_OS) problems.push(`the workload isn't running on ${CONFIDENTIAL_OS} (swname ${claims.swname ?? "missing"})`);
  if (claims.dbgstat !== DEBUG_OFF) problems.push(`debugging isn't off since boot (dbgstat ${claims.dbgstat ?? "missing"}): an operator could read the workload's memory`);
  if (claims.secboot !== true) problems.push("secure boot wasn't on");
  if ((x.requireStable ?? true) && !claims.submods?.confidential_space?.support_attributes?.includes("STABLE")) problems.push("the confidential OS image isn't a supported production (STABLE) image");

  const digest = claims.submods?.container?.image_digest ?? null;
  if (!digest) problems.push("the token names no container image digest");
  else if (!x.allowedDigests.includes(digest)) problems.push(`the image digest ${digest} isn't one announced for this release`);

  const nonces = Array.isArray(claims.eat_nonce) ? claims.eat_nonce : claims.eat_nonce ? [claims.eat_nonce] : [];
  if (!nonces.includes(x.nonce)) problems.push("the token doesn't carry your nonce: it may be a replay");
  if (!nonces.includes(keysNonce(x.keys))) problems.push("the token doesn't bind the keys returned with it: they may have been swapped on the way");

  return { ok: problems.length === 0, problems, claims };
}

// The attestation service's signing keys, from its discovery document. Cached for an hour.
let cached: { at: number; jwks: Jwks } | null = null;
export async function fetchAttestationJwks(fetchImpl: typeof fetch = fetch): Promise<Jwks> {
  if (cached && Date.now() - cached.at < 3_600_000) return cached.jwks;
  const d = await fetchImpl(ATTESTATION_DISCOVERY);
  if (!d.ok) throw new Error(`attestation discovery answered ${d.status}`);
  const { jwks_uri } = (await d.json()) as { jwks_uri?: string };
  if (!jwks_uri?.startsWith("https://")) throw new Error("attestation discovery has no jwks_uri");
  const k = await fetchImpl(jwks_uri);
  if (!k.ok) throw new Error(`attestation keys answered ${k.status}`);
  const jwks = (await k.json()) as Jwks;
  cached = { at: Date.now(), jwks };
  return jwks;
}
