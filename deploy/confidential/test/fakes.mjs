import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stand-ins for the cloud, for tests only: a KMS that wraps with a key in memory and signs with Ed25519 keys it made,
// and a container launcher that issues attestation tokens signed by an RSA key whose JWKS the tests hand to the
// verifier. Core's tests (core/test/confidential.test.js) use these too, with the real service code.

export const IMAGE_DIGEST = `sha256:${"ab".repeat(32)}`;

export function fakeKms() {
  const wrap = randomBytes(32);
  const signers = new Map();
  const signer = (v) => {
    if (!signers.has(v)) signers.set(v, generateKeyPairSync("ed25519"));
    return signers.get(v);
  };
  const calls = [];
  return {
    calls,
    async encrypt(key, plaintext, aad) {
      calls.push(["encrypt", key]);
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", wrap, iv);
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(plaintext), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
    },
    async decrypt(key, ciphertext, aad) {
      calls.push(["decrypt", key]);
      const b = Buffer.from(ciphertext, "base64");
      const d = createDecipheriv("aes-256-gcm", wrap, b.subarray(0, 12));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]);
    },
    async sign(version, message) {
      calls.push(["sign", version]);
      return edSign(null, message, signer(version).privateKey);
    },
    async publicKeyPem(version) {
      return signer(version).publicKey.export({ type: "spki", format: "pem" });
    },
  };
}

export function fakeLauncher(over = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwks = { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" }] };
  const issued = [];
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return {
    jwks,
    issued,
    async token({ audience, nonces }) {
      issued.push({ audience, nonces });
      const now = Math.floor(Date.now() / 1000);
      const claims = {
        iss: "https://confidentialcomputing.googleapis.com",
        aud: audience,
        iat: now,
        nbf: now,
        exp: now + 3600,
        eat_nonce: nonces,
        swname: "CONFIDENTIAL_SPACE",
        swversion: ["250300"],
        dbgstat: "disabled-since-boot",
        hwmodel: "GCP_AMD_SEV",
        secboot: true,
        submods: { container: { image_digest: IMAGE_DIGEST }, confidential_space: { support_attributes: ["LATEST", "STABLE", "USABLE"] } },
        ...over,
      };
      const head = b64u({ alg: "RS256", kid: "test-key", typ: "JWT" });
      const body = b64u(claims);
      return `${head}.${body}.${edSign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
    },
    async stsSubjectToken() {
      return "not-used";
    },
  };
}

// A certificate authority and a client certificate it issued (common name `cn`), made with the openssl CLI.
export function clientMaterial(cn = "mynt-core") {
  const dir = mkdtempSync(join(tmpdir(), "keyhouse-mtls-"));
  const ssl = (...a) => execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
  ssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.crt", "-days", "2", "-subj", "/CN=test-ca");
  ssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "client.key", "-out", "client.csr", "-subj", `/CN=${cn}`);
  ssl("x509", "-req", "-in", "client.csr", "-CA", "ca.crt", "-CAkey", "ca.key", "-CAcreateserial", "-out", "client.crt", "-days", "2");
  const read = (f) => readFileSync(join(dir, f), "utf8");
  return { dir, ca: read("ca.crt"), cert: read("client.crt"), key: read("client.key") };
}
