import { createHash, verify as verifySignature, X509Certificate } from "node:crypto";
import { configProblems, keysNonce, type EnclaveKeys } from "./shared/binding.js";
import { CborMap, CborTag, decodeCbor, encodeCbor, type Cbor } from "./shared/cbor.js";
import { ConfidentialRefused, type Attestation, type EnclavePcrs, type Measurements } from "./host.js";
import { expectedClientAuthority, RemoteConfidentialHost, remoteOptionsFromEnv, type RemoteHostOptions } from "./remote.js";

// The confidential service (deploy/confidential) running in an AWS Nitro Enclave: an isolated VM carved out of an EC2
// instance, with no network, disk or console, whose image file the Nitro hypervisor measures into PCRs, and whose
// security module signs attestation documents over them. Its root key is wrapped by an AWS KMS key whose key policy
// lets only an enclave attesting the announced PCR0 use it (deploy/confidential/aws/). This is the only file in core
// that names the provider.
//
// What's checked, all of it, with node:crypto and the CBOR reader in shared/cbor.ts (no dependency):
//   - the document is a COSE_Sign1 (ES384) whose signature verifies with the certificate inside it;
//   - that certificate chains, through the document's own bundle, to the AWS Nitro Enclaves root certificate pinned
//     below (never one fetched at run time), each certificate valid now and each issuer a CA;
//   - pcr0, pcr1 and pcr2 together equal one release Mynt announced (governance.ts) or the caller expects, and aren't
//     the zeros a debug-mode enclave reports (whose memory its operator could read);
//   - the document is fresh (made within the last five minutes), carries the caller's nonce, binds the keys returned
//     beside it in user_data (`mynt-keys-<sha256>`, shared/binding.ts) and the service's TLS key in public_key;
//   - the settings the enclave was handed by its parent instance, which it binds with the keys, are the ones the caller
//     expects: the KMS key that wraps its root (and that key's region), and the SHA-256 of the one authority whose
//     client certificates it accepts. Both expected values are required: the parent is not trusted, and root on it
//     could otherwise hand the enclave a key or an authority of its own (and then call it as Mynt's server).

// AWS_NitroEnclaves_Root-G1, from https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.zip (the zip's
// SHA-256 is 8cf60e2b2efca96c6a9e71e851d00c1b6991cc09eadbe64a6a1d1b1eb9faff7c). Valid until 2049. The certificate's
// SHA-256 fingerprint, as AWS documents it, is checked by core/test/confidential.test.js.
export const NITRO_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICETCCAZagAwIBAgIRAPkxdWgbkK/hHUbMtOTn+FYwCgYIKoZIzj0EAwMwSTEL
MAkGA1UEBhMCVVMxDzANBgNVBAoMBkFtYXpvbjEMMAoGA1UECwwDQVdTMRswGQYD
VQQDDBJhd3Mubml0cm8tZW5jbGF2ZXMwHhcNMTkxMDI4MTMyODA1WhcNNDkxMDI4
MTQyODA1WjBJMQswCQYDVQQGEwJVUzEPMA0GA1UECgwGQW1hem9uMQwwCgYDVQQL
DANBV1MxGzAZBgNVBAMMEmF3cy5uaXRyby1lbmNsYXZlczB2MBAGByqGSM49AgEG
BSuBBAAiA2IABPwCVOumCMHzaHDimtqQvkY4MpJzbolL//Zy2YlES1BR5TSksfbb
48C8WBoyt7F2Bw7eEtaaP+ohG2bnUs990d0JX28TcPQXCEPZ3BABIeTPYwEoCWZE
h8l5YoQwTcU/9KNCMEAwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUkCW1DdkF
R+eWw5b6cp3PmanfS5YwDgYDVR0PAQH/BAQDAgGGMAoGCCqGSM49BAMDA2kAMGYC
MQCjfy+Rocm9Xue4YnwWmNJVA44fA0P5W2OpYow9OYCVRaEevL8uO1XYru5xtMPW
rfMCMQCi85sWBbJwKKXdS6BptQFuZbT73o/gBh1qUxl/nNr12UO8Yfwr6wPLb+6N
IwLz3/Y=
-----END CERTIFICATE-----
`;

const ES384 = -35;
const MAX_AGE_MS = 5 * 60_000;
const SKEW_MS = 60_000;

export interface NitroDocument {
  module_id: string;
  digest: string;
  timestamp: number; // ms since the epoch
  pcrs: Map<number, Buffer>;
  certificate: Buffer;
  cabundle: Buffer[];
  public_key: Buffer | null;
  user_data: Buffer | null;
  nonce: Buffer | null;
}

export interface NitroCheck {
  ok: boolean;
  problems: string[];
  document: NitroDocument | null;
  pcrs: EnclavePcrs | null;
}

const bytes = (v: Cbor | undefined, what: string): Buffer => {
  if (!(v instanceof Uint8Array)) throw new Error(`${what} isn't a byte string`);
  return Buffer.from(v);
};
const optionalBytes = (v: Cbor | undefined, what: string) => (v === undefined || v === null ? null : bytes(v, what));

// The COSE_Sign1 structure and its payload, typed. Throws on anything malformed.
export function parseNitroDocument(document: string | Uint8Array) {
  const raw = typeof document === "string" ? Buffer.from(document, "base64") : Buffer.from(document);
  let top = decodeCbor(raw);
  if (top instanceof CborTag && top.tag === 18) top = top.value;
  if (!Array.isArray(top) || top.length !== 4) throw new Error("not a COSE_Sign1 structure");
  const [protectedHeader, , payload, signature] = top;
  const header = decodeCbor(bytes(protectedHeader, "the protected header"));
  if (!(header instanceof CborMap)) throw new Error("the protected header isn't a map");
  const body = decodeCbor(bytes(payload, "the payload"));
  if (!(body instanceof CborMap)) throw new Error("the payload isn't a map");
  const pcrMap = body.get("pcrs");
  if (!(pcrMap instanceof CborMap)) throw new Error("the document has no PCRs");
  const pcrs = new Map<number, Buffer>();
  for (const [k, v] of pcrMap) {
    if (typeof k !== "number") throw new Error("a PCR index isn't a number");
    pcrs.set(k, bytes(v, `PCR${k}`));
  }
  const cabundle = body.get("cabundle");
  if (!Array.isArray(cabundle) || cabundle.length === 0) throw new Error("the document has no certificate bundle");
  const ts = body.get("timestamp");
  if (typeof ts !== "number") throw new Error("the document has no timestamp");
  const text = (k: string) => {
    const v = body.get(k);
    if (typeof v !== "string") throw new Error(`${k} isn't text`);
    return v;
  };
  const doc: NitroDocument = {
    module_id: text("module_id"),
    digest: text("digest"),
    timestamp: ts,
    pcrs,
    certificate: bytes(body.get("certificate"), "certificate"),
    cabundle: cabundle.map((c, i) => bytes(c, `cabundle[${i}]`)),
    public_key: optionalBytes(body.get("public_key"), "public_key"),
    user_data: optionalBytes(body.get("user_data"), "user_data"),
    nonce: optionalBytes(body.get("nonce"), "nonce"),
  };
  return { alg: header.get(1), protectedHeader: bytes(protectedHeader, "the protected header"), payload: bytes(payload, "the payload"), signature: bytes(signature, "the signature"), doc };
}

export const pcrsOfDocument = (doc: NitroDocument): EnclavePcrs | null => {
  const hex = (i: number) => doc.pcrs.get(i)?.toString("hex") ?? null;
  const [pcr0, pcr1, pcr2] = [hex(0), hex(1), hex(2)];
  return pcr0 && pcr1 && pcr2 ? { pcr0, pcr1, pcr2 } : null;
};

export function verifyNitroAttestation(
  document: string,
  x: { nonce: string; keys: EnclaveKeys; allowedPcrs: EnclavePcrs[]; expectedKmsKey: string | null | undefined; expectedClientCaSha256: string | null | undefined; roots?: string[]; now?: Date; maxAgeMs?: number },
): NitroCheck {
  const problems: string[] = [];
  let parsed: ReturnType<typeof parseNitroDocument>;
  try {
    parsed = parseNitroDocument(document);
  } catch (e) {
    return { ok: false, problems: [`the attestation document can't be read: ${(e as Error).message}`], document: null, pcrs: null };
  }
  const { doc } = parsed;
  const now = (x.now ?? new Date()).getTime();
  if (parsed.alg !== ES384) problems.push("the document isn't signed with ES384");
  if (doc.digest !== "SHA384") problems.push(`the PCRs are ${doc.digest}, not SHA384`);

  // The chain: the bundle starts at the pinned root and each certificate issues the next, ending with the signer's.
  let signer: X509Certificate | null = null;
  try {
    const chain = [...doc.cabundle, doc.certificate].map((d) => new X509Certificate(d));
    const roots = (x.roots ?? [NITRO_ROOT_PEM]).map((p) => new X509Certificate(p));
    if (!roots.some((r) => r.raw.equals(chain[0].raw))) problems.push("the certificate chain doesn't start at the AWS Nitro Enclaves root");
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      if (new Date(c.validFrom).getTime() > now || new Date(c.validTo).getTime() < now) problems.push(`certificate ${i} in the chain isn't valid now`);
      if (i === 0) {
        if (!c.verify(c.publicKey)) problems.push("the root certificate isn't self-signed");
        continue;
      }
      const issuer = chain[i - 1];
      if (!issuer.ca) problems.push(`certificate ${i - 1} in the chain isn't a CA`);
      if (!c.checkIssued(issuer) || !c.verify(issuer.publicKey)) problems.push(`certificate ${i} in the chain isn't issued by the one before it`);
    }
    signer = chain[chain.length - 1];
  } catch {
    problems.push("the document's certificates can't be read");
  }

  // The COSE signature over Sig_structure = ["Signature1", protected, external_aad (empty), payload].
  if (signer) {
    const toBeSigned = encodeCbor(["Signature1", parsed.protectedHeader, new Uint8Array(0), parsed.payload]);
    let good = false;
    try {
      good = verifySignature("sha384", toBeSigned, { key: signer.publicKey, dsaEncoding: "ieee-p1363" }, parsed.signature);
    } catch {
      good = false;
    }
    if (!good) problems.push("the document's signature doesn't verify with its certificate");
  }

  if (now - doc.timestamp > (x.maxAgeMs ?? MAX_AGE_MS)) problems.push("the document is stale: made more than five minutes ago");
  if (doc.timestamp - now > SKEW_MS) problems.push("the document is dated in the future");

  const pcrs = pcrsOfDocument(doc);
  if (!pcrs) problems.push("the document lacks PCR0, PCR1 or PCR2");
  else if (/^0+$/.test(pcrs.pcr0)) problems.push("the enclave runs in debug mode (its PCRs are zeros): its operator could read its memory");
  else if (!x.allowedPcrs.some((p) => p.pcr0 === pcrs.pcr0 && p.pcr1 === pcrs.pcr1 && p.pcr2 === pcrs.pcr2))
    problems.push(`the enclave's PCRs (pcr0 ${pcrs.pcr0}) aren't one announced for this release`);

  if (!doc.nonce || !doc.nonce.equals(Buffer.from(x.nonce, "utf8"))) problems.push("the document doesn't carry your nonce: it may be a replay");
  if (!doc.user_data || !doc.user_data.equals(Buffer.from(keysNonce(x.keys), "utf8"))) problems.push("the document doesn't bind the keys returned with it: they may have been swapped on the way");
  if (!doc.public_key || createHash("sha256").update(doc.public_key).digest("hex") !== x.keys.tls_spki_sha256) problems.push("the document's public key isn't the service's TLS key");
  // Never optional: with no expected value there is a problem, so nothing unattested decides whose keys or callers.
  problems.push(
    ...configProblems(
      x.keys.config,
      { kms_key: x.expectedKmsKey, region: x.expectedKmsKey ? (kmsKeyRegion(x.expectedKmsKey) ?? null) : null, client_ca_sha256: x.expectedClientCaSha256 },
      { kms_key: "the service's root is wrapped by", region: "the service uses KMS in", client_ca_sha256: "the service accepts client certificates from the authority" },
    ),
  );

  return { ok: problems.length === 0, problems, document: doc, pcrs };
}

export const kmsKeyRegion = (arn: string): string | null => /^arn:[^:]+:kms:([^:]+):/.exec(arn)?.[1] ?? null;

export interface NitroEnclaveOptions extends RemoteHostOptions {
  allowedPcrs: () => Promise<EnclavePcrs[]>; // PCRs in effect (governance.ts)
  expectedKmsKey: string; // the KMS key that must wrap the service's root (its ARN)
  expectedClientCaSha256: string; // the one authority whose client certificates the service must accept (clientAuthority)
  roots?: string[]; // tests: a test authority instead of the AWS root
}

// CONFIDENTIAL_HOST=aws-nitro: CONFIDENTIAL_HOST_URL (https:// of the parent instance's port), the two client
// certificate paths, CONFIDENTIAL_HOST_CLIENT_CA (the path to the authority's certificate) and
// CONFIDENTIAL_HOST_KMS_KEY (the wrap key's ARN, a name and not a secret).
export function nitroHostOptionsFromEnv(env: NodeJS.ProcessEnv, allowedPcrs: () => Promise<EnclavePcrs[]>, wrappedRoot?: () => Promise<string | null>): NitroEnclaveOptions {
  const base = remoteOptionsFromEnv("aws-nitro", env);
  const expectedKmsKey = env.CONFIDENTIAL_HOST_KMS_KEY;
  if (!expectedKmsKey?.startsWith("arn:") || !kmsKeyRegion(expectedKmsKey)) throw new ConfidentialRefused("CONFIDENTIAL_HOST=aws-nitro needs CONFIDENTIAL_HOST_KMS_KEY set on the server: the wrap key's ARN");
  return { ...base, allowedPcrs, expectedKmsKey, expectedClientCaSha256: expectedClientAuthority("aws-nitro", env, base.clientCert), wrappedRoot };
}

export class NitroEnclaveHost extends RemoteConfidentialHost {
  readonly kind = "aws-nitro" as const;

  constructor(private readonly nitro: NitroEnclaveOptions) {
    super(nitro);
  }

  protected async verify(a: Attestation, nonce: string): Promise<Measurements> {
    if (a.format !== "nitro-cose") throw new ConfidentialRefused(`The confidential service gave a ${a.format} attestation, not an enclave's document`);
    const check = verifyNitroAttestation(a.token!, { nonce, keys: a.keys, allowedPcrs: await this.nitro.allowedPcrs(), expectedKmsKey: this.nitro.expectedKmsKey, expectedClientCaSha256: this.nitro.expectedClientCaSha256, roots: this.nitro.roots });
    if (!check.ok) throw new ConfidentialRefused(`The confidential service's attestation didn't pass: ${check.problems.join("; ")}`);
    return { host: this.kind, attested: true, image_digest: null, pcrs: check.pcrs, hardware: check.document!.module_id, software: "nitro-enclave", software_version: null, debug: false, reason: null };
  }
}
