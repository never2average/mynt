import { fetchAttestationJwks, verifyAttestationToken, type ExpectedCustody, type Jwks } from "./attestation-verify.js";
import { ATTESTATION_AUDIENCE } from "./shared/binding.js";
import { ConfidentialRefused, type Attestation, type Measurements } from "./host.js";
import { expectedClientAuthority, RemoteConfidentialHost, remoteOptionsFromEnv, type RemoteHostOptions } from "./remote.js";

// The confidential service (deploy/confidential) running as a Google Cloud Confidential Space workload: a container
// in a confidential VM whose image digest the hardware measures, and whose keys are Cloud KMS keys that only a workload
// attesting that exact digest can use. This adapter and attestation-verify.ts are the only files in core that name the
// provider. The connection, the pin and every request are remote.ts's; this file checks the attestation: an OIDC
// token from the attestation service (attestation-verify.ts: the signature, a confidential OS with debugging off, an
// announced image digest, Mynt's nonce, the keys' binding, and the key custody the service binds with them: the wrap
// key, the signing key versions and the client authority must be the ones this server was told to expect).

export interface ConfidentialSpaceOptions extends RemoteHostOptions {
  allowedDigests: () => Promise<string[]>; // image digests in effect (governance.ts)
  expectedCustody: ExpectedCustody; // the wrap key, signing key versions and client authority the service must bind
  jwks?: () => Promise<Jwks>; // tests: a fake attestation service's keys
  requireStable?: boolean; // tests: fake tokens
}

// CONFIDENTIAL_HOST=gcp-confidential-space: the URL and client certificate paths, and what the service's attestation
// must bind, each required (names, not secrets): CONFIDENTIAL_HOST_WRAP_KEY (the Cloud KMS key that wraps its root, as
// the VM's KEYHOUSE_WRAP_KEY), CONFIDENTIAL_HOST_SIGNING_KEYS (JSON, as the VM's KEYHOUSE_SIGNING_KEYS) and
// CONFIDENTIAL_HOST_CLIENT_CA (the path to the authority certificate that issued the client certificate).
export function remoteHostOptionsFromEnv(env: NodeJS.ProcessEnv, allowedDigests: () => Promise<string[]>): ConfidentialSpaceOptions {
  const kind = "gcp-confidential-space";
  const base = remoteOptionsFromEnv(kind, env);
  const wrapKey = env.CONFIDENTIAL_HOST_WRAP_KEY;
  if (!wrapKey) throw new ConfidentialRefused(`CONFIDENTIAL_HOST=${kind} needs CONFIDENTIAL_HOST_WRAP_KEY set on the server: the name of the key that wraps the service's root`);
  let signingKeys: Record<string, string> | null = null;
  try {
    const parsed = JSON.parse(env.CONFIDENTIAL_HOST_SIGNING_KEYS ?? "") as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === "string" && v)) signingKeys = parsed as Record<string, string>;
  } catch {
    signingKeys = null;
  }
  if (!signingKeys) throw new ConfidentialRefused(`CONFIDENTIAL_HOST=${kind} needs CONFIDENTIAL_HOST_SIGNING_KEYS set on the server: JSON naming each signing key's version, as the service was given it`);
  return { ...base, allowedDigests, expectedCustody: { wrapKey, signingKeys, clientCaSha256: expectedClientAuthority(kind, env, base.clientCert) } };
}

export class ConfidentialSpaceHost extends RemoteConfidentialHost {
  readonly kind = "gcp-confidential-space" as const;

  constructor(private readonly gcp: ConfidentialSpaceOptions) {
    super(gcp);
  }

  protected async verify(a: Attestation, nonce: string): Promise<Measurements> {
    const check = verifyAttestationToken(a.token!, {
      jwks: await (this.gcp.jwks ?? fetchAttestationJwks)(),
      audience: ATTESTATION_AUDIENCE,
      nonce,
      keys: a.keys,
      allowedDigests: await this.gcp.allowedDigests(),
      expectedCustody: this.gcp.expectedCustody,
      requireStable: this.gcp.requireStable,
    });
    if (!check.ok) throw new ConfidentialRefused(`The confidential service's attestation didn't pass: ${check.problems.join("; ")}`);
    const c = check.claims!;
    return { host: this.kind, attested: true, image_digest: c.submods?.container?.image_digest ?? null, pcrs: null, hardware: c.hwmodel ?? null, software: c.swname ?? null, software_version: c.swversion?.[0] ?? null, debug: c.dbgstat !== "disabled-since-boot", reason: null };
  }
}
