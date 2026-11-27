import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { selfSignedEd25519 } from "../src/cert.mjs";
import { openEnvelopedData } from "../src/cms.mjs";
import { createKeyhouse, loadPolicy, Refused } from "../src/keyhouse.mjs";
import { imdsCredentials, nitroKms, nitroPlatform, parseSettings, signV4 } from "../src/nitro.mjs";
import { clientAuthority, keysNonce } from "../src/shared/binding.js";
import { CborTag, decodeCbor } from "../src/shared/cbor.js";
import { clientMaterial } from "./fakes.mjs";
import { envelopedData, fakeCredentials, fakeNitroKms, fakeNsm, KEY_ARN, PCRS } from "./fakes-nitro.mjs";

// The Nitro platform against a fake security module and a fake KMS that enforces the key policy's PCR0 condition:
// what the enclave sends KMS, what it can open, and that the keyhouse's rules hold there as they do elsewhere.

const b64u = (b) => Buffer.from(b).toString("base64url");
const refusedWith = (code) => (e) => e instanceof Refused && e.code === code;

const CA_SHA256 = "c".repeat(64);
async function nitroKeyhouse({ nsm = fakeNsm(), kms = fakeNitroKms() } = {}) {
  const tls = selfSignedEd25519("mynt-keyhouse");
  const client = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm, credentials: fakeCredentials, post: kms.post });
  const platform = nitroPlatform({ kms: client, nsm, region: "us-east-1", keyArn: KEY_ARN, clientCaSha256: CA_SHA256 });
  const kh = await createKeyhouse({ platform, wrappedRoot: null, tlsSpki: tls.spki, policy: loadPolicy() });
  return { kh, nsm, kms, tls, platform };
}

test("Signature Version 4 matches the AWS SDK's (botocore) for the same request", () => {
  const h = signV4({
    host: "kms.us-east-1.amazonaws.com",
    region: "us-east-1",
    service: "kms",
    headers: { "Content-Type": "application/x-amz-json-1.1", "X-Amz-Target": "TrentService.Decrypt" },
    body: '{"KeyId":"k"}',
    // AWS's documented example credentials, not a real key.
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "session-token" },
    now: new Date("2026-01-02T03:04:05Z"),
  });
  assert.equal(h["x-amz-date"], "20260102T030405Z");
  assert.equal(
    h.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260102/us-east-1/kms/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=113b189d3479936f368262a308aa38a5804e6dc61a3559c02d3fce908c2928d9",
  );
});

test("CMS EnvelopedData opens with the recipient's key, in DER and in BER's indefinite form; another key opens nothing", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const secret = randomBytes(32);
  assert.deepEqual(openEnvelopedData(envelopedData(secret, rsa.publicKey), rsa.privateKey), secret);
  assert.deepEqual(openEnvelopedData(envelopedData(secret, rsa.publicKey, { indefinite: true }), rsa.privateKey), secret);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(() => openEnvelopedData(envelopedData(secret, rsa.publicKey), other.privateKey));
  assert.throws(() => openEnvelopedData(Buffer.from("3003020102", "hex"), rsa.privateKey));
});

test("the instance role's credentials come from IMDSv2 (a token first), and are reused until near expiry", async () => {
  const seen = [];
  const send = async (o) => {
    seen.push(`${o.method} ${o.path} ${o.headers?.["x-aws-ec2-metadata-token"] ?? ""}`);
    if (o.path === "/latest/api/token") return { status: 200, text: "imds-token" };
    if (o.path.endsWith("/security-credentials/")) return { status: 200, text: "mynt-keyhouse-role\n" };
    return { status: 200, text: JSON.stringify({ AccessKeyId: "ASIAEXAMPLE", SecretAccessKey: "x", Token: "t", Expiration: new Date(Date.now() + 3_600_000).toISOString() }) };
  };
  const creds = imdsCredentials({ send });
  assert.deepEqual(await creds(), { accessKeyId: "ASIAEXAMPLE", secretAccessKey: "x", sessionToken: "t" });
  await creds();
  assert.deepEqual(seen, ["PUT /latest/api/token ", "GET /latest/meta-data/iam/security-credentials/ imds-token", "GET /latest/meta-data/iam/security-credentials/mynt-keyhouse-role imds-token"]);
});

test("KMS is called signed, with an attestation document as Recipient, and answers only to the enclave's key", async () => {
  const nsm = fakeNsm();
  const kms = fakeNitroKms();
  const client = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm, credentials: fakeCredentials, post: kms.post });
  const { ciphertextBlob, plaintext } = await client.generateDataKey();
  assert.equal(plaintext.length, 32);
  assert.deepEqual(await client.decrypt(ciphertextBlob), plaintext);
  assert.ok(kms.calls.every((c) => c.signed && c.recipient), "every call is signed and attested");
  assert.deepEqual(kms.calls[0].context, { mynt: "keyhouse-root-v1" });
  // The document KMS saw carries the Recipient RSA key and nothing of the caller's.
  const doc = nsm.issued.at(-1);
  assert.equal(createPublicKey({ key: doc.publicKey, format: "der", type: "spki" }).asymmetricKeyType, "rsa");
  assert.equal(doc.nonce ?? null, null);
  // An enclave whose PCR0 the policy doesn't name gets nothing.
  const other = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm: fakeNsm({ pcrs: { ...PCRS, pcr0: "b0".repeat(48) } }), credentials: fakeCredentials, post: kms.post });
  await assert.rejects(other.decrypt(ciphertextBlob), /KMS answered 400 for Decrypt \(AccessDeniedException\)/);
  // Nor does a debug-mode enclave (all-zero PCRs).
  const debug = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm: fakeNsm({ pcrs: { pcr0: "00".repeat(48), pcr1: "00".repeat(48), pcr2: "00".repeat(48) } }), credentials: fakeCredentials, post: kms.post });
  await assert.rejects(debug.generateDataKey(), /AccessDeniedException/);
  // And a KMS answer in plaintext is refused, not used.
  const leaky = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm, credentials: fakeCredentials, post: async () => ({ status: 200, text: JSON.stringify({ Plaintext: "AAAA", CiphertextBlob: "x" }) }) });
  await assert.rejects(leaky.generateDataKey(), /for the enclave alone/);
});

test("in the enclave: locked until init or unlock; init returns only the wrapped root; a restart unlocks with it", async () => {
  const kms = fakeNitroKms({ indefinite: true });
  const { kh } = await nitroKeyhouse({ kms });
  await assert.rejects(kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("x") }), refusedWith("not_initialised"));
  const locked = await kh.handle("GET", "/v1/attestation", "mynt-core", null, new URLSearchParams({ nonce: "n".repeat(20) }));
  assert.deepEqual(locked.keys.signing, {}, "no derived signing key exists before the root does");
  const { wrapped_root } = await kh.handle("POST", "/v1/init", "mynt-core", {});
  await assert.rejects(kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("x") }), refusedWith("not_initialised"));
  await assert.rejects(kh.handle("POST", "/v1/unlock", "someone-else", { wrapped_root }), refusedWith("not_allowed"));
  await assert.rejects(kh.handle("POST", "/v1/unlock", "mynt-core", { wrapped_root: wrapped_root.replace(/^./, (c) => (c === "A" ? "B" : "A")) }), refusedWith("unwrap_failed"));
  await kh.handle("POST", "/v1/unlock", "mynt-core", { wrapped_root });
  await assert.rejects(kh.handle("POST", "/v1/unlock", "mynt-core", { wrapped_root }), refusedWith("already_initialised"));
  const { sealed } = await kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("value") });
  assert.match(sealed, /^cs1:ne:secret:/);
  // The attester key, derived from the root, signs only inside the health check: never a message a caller hands over.
  await assert.rejects(kh.handle("POST", "/v1/sign", "mynt-core", { key: { name: "health-attester" }, message: b64u("m") }), refusedWith("reserved_key"));
  const attester = await kh.handle("GET", "/v1/public-key", "mynt-core", null, new URLSearchParams({ name: "health-attester" }));
  // A key Mynt sealed here as a signing key still signs.
  const seed = randomBytes(32);
  const key = (await kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "signing-key", plaintext: b64u(seed) })).sealed;
  const signed = await kh.handle("POST", "/v1/sign", "mynt-core", { key: { sealed: key }, message: b64u("m") });

  // The enclave restarts (nothing survives) and gets the same root back: the same keys, the same sealed values.
  const { kh: again } = await nitroKeyhouse({ kms });
  await again.handle("POST", "/v1/unlock", "mynt-core", { wrapped_root });
  assert.equal(Buffer.from((await again.handle("POST", "/v1/unseal", "mynt-core", { purpose: "secret", sealed })).plaintext, "base64url").toString(), "value");
  assert.deepEqual(await again.handle("GET", "/v1/public-key", "mynt-core", null, new URLSearchParams({ name: "health-attester" })), attester);
  const signedAgain = await again.handle("POST", "/v1/sign", "mynt-core", { key: { sealed: key }, message: b64u("m") });
  assert.equal(signedAgain.public_key, signed.public_key);
  assert.ok(verify(null, Buffer.from("m"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: signed.public_key }, format: "jwk" }), Buffer.from(signedAgain.signature, "hex")));
});

test("an attestation is the module's document: the caller's nonce, the keys' binding as user_data, the TLS key as public_key", async () => {
  const { kh, nsm, tls } = await nitroKeyhouse();
  const { wrapped_root } = await kh.handle("POST", "/v1/init", "mynt-core", {});
  await kh.handle("POST", "/v1/unlock", "mynt-core", { wrapped_root });
  const nonce = "partner-nonce-0123456789";
  const a = await kh.handle("GET", "/v1/attestation", "mynt-core", null, new URLSearchParams({ nonce }));
  assert.equal(a.host, "aws-nitro");
  assert.equal(a.format, "nitro-cose");
  // What the parent handed the enclave is part of what's attested: the key, its region, and the client authority.
  assert.deepEqual(a.keys.config, { kms_key: KEY_ARN, region: "us-east-1", client_ca_sha256: CA_SHA256 });
  assert.ok(a.keys.signing["health-attester"] && a.keys.ingest_public_key);
  const fields = nsm.issued.at(-1);
  assert.equal(Buffer.from(fields.nonce).toString(), nonce);
  assert.equal(Buffer.from(fields.userData).toString(), keysNonce(a.keys));
  assert.equal(createHash("sha256").update(fields.publicKey).digest("hex"), a.keys.tls_spki_sha256);
  assert.equal(a.keys.tls_spki_sha256, createHash("sha256").update(tls.spki).digest("hex"));
  const top = decodeCbor(Buffer.from(a.token, "base64"));
  assert.ok(top instanceof CborTag && top.tag === 18);
  assert.deepEqual(a.measurements.pcrs, PCRS);
  assert.equal(a.measurements.debug, false);
});

test("settings from the parent: a region, a KMS key ARN in it, and exactly one authority (hashed for the attestation), or nothing starts", () => {
  const m = clientMaterial("mynt-core");
  const ca = m.ca;
  const authority = clientAuthority(ca);
  assert.deepEqual(parseSettings(JSON.stringify({ region: "us-east-1", kms_key: KEY_ARN, client_ca: ca, extra: 1 })), { region: "us-east-1", kms_key: KEY_ARN, client_ca: authority.pem, client_ca_sha256: authority.sha256 });
  // The parent appends an authority of its own, to call the enclave as Mynt's server: refused, not half-hashed.
  assert.throws(() => parseSettings(JSON.stringify({ region: "us-east-1", kms_key: KEY_ARN, client_ca: ca + clientMaterial("mynt-core").ca })), /client_ca: .*exactly one/);
  assert.throws(() => parseSettings(JSON.stringify({ region: "us-east-1", kms_key: KEY_ARN, client_ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n" })), /client_ca/);
  assert.throws(() => nitroPlatform({ kms: {}, nsm: {}, region: "us-east-1", keyArn: KEY_ARN }), /client-certificate authority/);
  assert.throws(() => parseSettings(JSON.stringify({ region: "us-west-2", kms_key: KEY_ARN, client_ca: ca })), /kms_key/);
  assert.throws(() => parseSettings(JSON.stringify({ region: "nowhere", kms_key: KEY_ARN, client_ca: ca })), /region/);
  assert.throws(() => parseSettings(JSON.stringify({ region: "us-east-1", kms_key: KEY_ARN, client_ca: "x" })), /client_ca/);
});
