import { fetchAttestationJwks, verifyAttestationToken, type Jwks } from "./attestation-verify.js";
import { ATTESTATION_AUDIENCE } from "./shared/binding.js";
import { ConfidentialRefused, type Attestation, type Measurements } from "./host.js";
import { RemoteConfidentialHost, remoteOptionsFromEnv, type RemoteHostOptions } from "./remote.js";

// The confidential service (deploy/confidential) running as a Google Cloud Confidential Space workload: a container
// in a confidential VM whose image digest the hardware measures, and whose keys are Cloud KMS keys that only a workload
// attesting that exact digest can use. This adapter and attestation-verify.ts are the only files in core that name the
// provider. The connection, the pin and every request are remote.ts's; this file checks the attestation: an OIDC
// token from the attestation service (attestation-verify.ts: the signature, a confidential OS with debugging off, an
// announced image digest, Mynt's nonce, the keys' binding).

export interface ConfidentialSpaceOptions extends RemoteHostOptions {
  allowedDigests: () => Promise<string[]>; // image digests in effect (governance.ts)
  jwks?: () => Promise<Jwks>; // tests: a fake attestation service's keys
  requireStable?: boolean; // tests: fake tokens
}

export function remoteHostOptionsFromEnv(env: NodeJS.ProcessEnv, allowedDigests: () => Promise<string[]>): ConfidentialSpaceOptions {
  return { ...remoteOptionsFromEnv("gcp-confidential-space", env), allowedDigests };
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
      requireStable: this.gcp.requireStable,
    });
    if (!check.ok) throw new ConfidentialRefused(`The confidential service's attestation didn't pass: ${check.problems.join("; ")}`);
    const c = check.claims!;
    return { host: this.kind, attested: true, image_digest: c.submods?.container?.image_digest ?? null, pcrs: null, hardware: c.hwmodel ?? null, software: c.swname ?? null, software_version: c.swversion?.[0] ?? null, debug: c.dbgstat !== "disabled-since-boot", reason: null };
  }
}
