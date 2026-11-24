import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { connect, type TLSSocket } from "node:tls";
import { fetchAttestationJwks, verifyAttestationToken, type Jwks } from "./attestation-verify.js";
import { ATTESTATION_AUDIENCE } from "./shared/binding.js";
import type { SealedHealthInput, SealedHealthResult } from "./shared/health.js";
import { ConfidentialRefused, isPurpose, PURPOSES, type Attestation, type ConfidentialHost, type Measurements, type Purpose, type SigningKeyRef } from "./host.js";

// The confidential service (deploy/confidential) running as a Google Cloud Confidential Space workload: a container
// in a confidential VM whose image digest the hardware measures, and whose keys are Cloud KMS keys that only a workload
// attesting that exact digest can use. This adapter is the only file in core that names the provider.
//
// Mynt's server talks to it over TLS in both directions: Mynt presents a client certificate the service trusts
// (CONFIDENTIAL_HOST_CLIENT_CERT and CONFIDENTIAL_HOST_CLIENT_KEY, paths to files; CONFIDENTIAL_HOST_CLIENT_CA on the
// service's side), and the service presents a key it made inside the enclave at boot. No certificate authority vouches
// for that key: before anything is sent, Mynt fetches an attestation over the same connection, checks it
// (attestation-verify.ts: the signature, a confidential OS with debugging off, an announced image digest, Mynt's nonce,
// the keys' binding) and pins the key the token binds. A connection to any other key is closed before a byte is sent.

export interface RemoteHostOptions {
  url: string; // https://host:port of the service
  clientCert: string; // PEM
  clientKey: string; // PEM
  allowedDigests: () => Promise<string[]>; // image digests in effect (governance.ts)
  jwks?: () => Promise<Jwks>; // tests: a fake attestation service's keys
  requireStable?: boolean; // tests: fake tokens
  pinTtlMs?: number;
  timeoutMs?: number;
}

export function remoteHostOptionsFromEnv(env: NodeJS.ProcessEnv, allowedDigests: () => Promise<string[]>): RemoteHostOptions {
  const need = (name: string) => env[name] || (() => {
    throw new ConfidentialRefused(`CONFIDENTIAL_HOST=gcp-confidential-space needs ${name} set on the server`);
  })();
  const url = need("CONFIDENTIAL_HOST_URL");
  if (!url.startsWith("https://")) throw new ConfidentialRefused("CONFIDENTIAL_HOST_URL must be an https:// address");
  // File paths, never the material itself: the key is read here, held in memory, and never logged.
  return { url, clientCert: readFileSync(need("CONFIDENTIAL_HOST_CLIENT_CERT"), "utf8"), clientKey: readFileSync(need("CONFIDENTIAL_HOST_CLIENT_KEY"), "utf8"), allowedDigests };
}

const spkiSha256 = (s: TLSSocket) => {
  const raw = s.getPeerCertificate(false)?.raw;
  if (!raw) return null;
  return createHash("sha256").update(new X509Certificate(raw).publicKey.export({ type: "spki", format: "der" })).digest("hex");
};

export class ConfidentialSpaceHost implements ConfidentialHost {
  readonly kind = "gcp-confidential-space" as const;
  private pinned: { spki: string; until: number; measurements: Measurements } | null = null;
  private readonly target: URL;

  constructor(private readonly o: RemoteHostOptions) {
    this.target = new URL(o.url);
  }

  // A TLS connection to the service with Mynt's client certificate. The server's key is checked by the caller.
  private socket(): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
      const s = connect({
        host: this.target.hostname,
        port: Number(this.target.port || 443),
        servername: /^[\d.]+$/.test(this.target.hostname) ? undefined : this.target.hostname,
        cert: this.o.clientCert,
        key: this.o.clientKey,
        // The key is pinned against the attestation below, never trusted from a certificate chain.
        rejectUnauthorized: false,
        minVersion: "TLSv1.3",
      });
      const t = setTimeout(() => s.destroy(new Error("timed out connecting to the confidential service")), this.o.timeoutMs ?? 15_000);
      s.once("secureConnect", () => (clearTimeout(t), resolve(s)));
      s.once("error", (e) => (clearTimeout(t), reject(e)));
    });
  }

  private call<T>(s: TLSSocket, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
      // HTTP framing over the TLS socket already checked: no agent, so nothing opens a connection of its own.
      const req = httpRequest(
        { method, path, host: this.target.hostname, createConnection: () => s, headers: { "content-type": "application/json", ...(payload ? { "content-length": String(payload.length) } : {}) }, timeout: this.o.timeoutMs ?? 30_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
            } catch {
              parsed = null;
            }
            if ((res.statusCode ?? 500) >= 400) {
              const code = (parsed as { error?: string } | null)?.error ?? `http_${res.statusCode}`;
              return reject(res.statusCode === 403 ? new ConfidentialRefused(`The confidential service refused: ${code}`) : new Error(`The confidential service answered ${res.statusCode} (${code})`));
            }
            resolve(parsed as T);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("the confidential service timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  private isPinned(s: TLSSocket) {
    const spki = spkiSha256(s);
    return !!spki && !!this.pinned && this.pinned.spki === spki && this.pinned.until > Date.now();
  }

  // Attests the service on this connection (which the attestation request uses up) and pins the key it presented.
  private async attestAndPin(s: TLSSocket): Promise<void> {
    const spki = spkiSha256(s);
    if (!spki) throw new ConfidentialRefused("The confidential service presented no key");
    const nonce = randomBytes(24).toString("base64url");
    const a = await this.call<Attestation>(s, "GET", `/v1/attestation?nonce=${nonce}`);
    if (!a?.token || !a.keys) throw new ConfidentialRefused("The confidential service gave no attestation");
    const check = verifyAttestationToken(a.token, {
      jwks: await (this.o.jwks ?? fetchAttestationJwks)(),
      audience: ATTESTATION_AUDIENCE,
      nonce,
      keys: a.keys,
      allowedDigests: await this.o.allowedDigests(),
      requireStable: this.o.requireStable,
    });
    if (!check.ok) throw new ConfidentialRefused(`The confidential service's attestation didn't pass: ${check.problems.join("; ")}`);
    if (a.keys.tls_spki_sha256 !== spki) throw new ConfidentialRefused("The confidential service's TLS key isn't the one its attestation binds");
    const c = check.claims!;
    this.pinned = {
      spki,
      until: Date.now() + (this.o.pinTtlMs ?? 10 * 60_000),
      measurements: { host: this.kind, attested: true, image_digest: c.submods?.container?.image_digest ?? null, hardware: c.hwmodel ?? null, software: c.swname ?? null, software_version: c.swversion?.[0] ?? null, debug: c.dbgstat !== "disabled-since-boot", reason: null },
    };
  }

  // Every request: connect, make sure the key presented is the attested one (attesting first when there's no fresh pin
  // for it), then send. One connection per request; nothing is written to a connection whose key isn't pinned.
  private async send<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let s = await this.socket();
    if (!this.isPinned(s)) {
      try {
        await this.attestAndPin(s);
      } finally {
        s.destroy();
      }
      s = await this.socket();
      if (!this.isPinned(s)) {
        s.destroy();
        throw new ConfidentialRefused("The confidential service presented a different key from the one it just attested");
      }
    }
    try {
      return await this.call<T>(s, method, path, body);
    } finally {
      s.destroy();
    }
  }

  async measurements(): Promise<Measurements> {
    await this.send("GET", "/v1/healthz");
    return this.pinned!.measurements;
  }

  // For partners (GET /confidential/attestation): the service's own answer, which they check themselves.
  async attest(nonce: string): Promise<Attestation> {
    return this.send<Attestation>("GET", `/v1/attestation?nonce=${encodeURIComponent(nonce)}`);
  }

  async seal(purpose: Purpose, plaintext: Uint8Array) {
    if (!isPurpose(purpose)) throw new ConfidentialRefused(`Unknown purpose ${purpose}`);
    return (await this.send<{ sealed: string }>("POST", "/v1/seal", { purpose, plaintext: Buffer.from(plaintext).toString("base64url") })).sealed;
  }

  async unseal(purpose: Purpose, sealed: string) {
    if (!isPurpose(purpose)) throw new ConfidentialRefused(`Unknown purpose ${purpose}`);
    if (!PURPOSES[purpose].unseal) throw new ConfidentialRefused(`What's sealed for ${purpose} never leaves the confidential host`);
    return Buffer.from((await this.send<{ plaintext: string }>("POST", "/v1/unseal", { purpose, sealed })).plaintext, "base64url");
  }

  async sign(key: SigningKeyRef, message: Uint8Array) {
    return this.send<{ public_key: string; signature: string }>("POST", "/v1/sign", { key, message: Buffer.from(message).toString("base64url") });
  }

  async publicKey(name: string) {
    return (await this.send<{ public_key: string }>("GET", `/v1/public-key?name=${encodeURIComponent(name)}`)).public_key;
  }

  async ingestPublicKey() {
    return (await this.send<Attestation>("GET", `/v1/attestation?nonce=${randomBytes(24).toString("base64url")}`)).keys.ingest_public_key;
  }

  async computeHealth(input: SealedHealthInput) {
    return this.send<SealedHealthResult>("POST", "/v1/health/compute", { input });
  }

  async initialise() {
    return this.send<{ wrapped_root: string }>("POST", "/v1/init", {});
  }

  async adoptVaultRoot(legacyRoot: Uint8Array) {
    return (await this.send<{ sealed: string }>("POST", "/v1/vault/adopt", { legacy_root: Buffer.from(legacyRoot).toString("base64url") })).sealed;
  }

  async releaseVaultKeys(sealedBundle: string) {
    const r = await this.send<{ data_key: string; derivation_prk: string }>("POST", "/v1/vault/release", { sealed: sealedBundle });
    return { data_key: Buffer.from(r.data_key, "base64url"), derivation_prk: Buffer.from(r.derivation_prk, "base64url") };
  }
}
