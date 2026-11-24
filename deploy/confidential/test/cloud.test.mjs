import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kmsClient, launcherClient } from "../src/cloud.mjs";

// The two cloud calls, against fakes: the launcher's token endpoint over its socket, and KMS as the workload through
// the token service. What's checked is the shape of each request, since that's what the cloud enforces.

test("the launcher is asked for an OIDC token with the audience and nonces, over its socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "launcher-"));
  const socketPath = join(dir, "teeserver.sock");
  let got = null;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got = { method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString()) };
      res.end("header.claims.signature\n");
    });
  });
  await new Promise((r) => server.listen(socketPath, r));
  writeFileSync(join(dir, "token"), "sts-subject-token\n");
  try {
    const l = launcherClient({ socketPath, tokenFile: join(dir, "token") });
    assert.equal(await l.token({ audience: "mynt-enclave-attestation", nonces: ["a".repeat(16), "b".repeat(16)] }), "header.claims.signature");
    assert.deepEqual(got, { method: "POST", url: "/v1/token", body: { audience: "mynt-enclave-attestation", token_type: "OIDC", nonces: ["a".repeat(16), "b".repeat(16)] } });
    assert.equal(await l.stsSubjectToken(), "sts-subject-token");
  } finally {
    server.close();
  }
});

test("KMS is called as the workload: the attestation token exchanged through the pool's provider, cached; Ed25519 signs raw data", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null, auth: init.headers?.authorization ?? null });
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.startsWith("https://sts.")) return json({ access_token: "federated-access", expires_in: 3600 });
    if (url.endsWith(":asymmetricSign")) return json({ signature: Buffer.from("sig").toString("base64") });
    if (url.endsWith(":encrypt")) return json({ ciphertext: "Y3Q=" });
    if (url.endsWith(":decrypt")) return json({ plaintext: Buffer.from("root").toString("base64") });
    return json({ pem: "PEM" });
  };
  const provider = "projects/123/locations/global/workloadIdentityPools/mynt/providers/attested";
  const kms = kmsClient({ provider, subjectToken: async () => "attestation-token", fetchImpl });
  assert.deepEqual(await kms.sign("projects/p/cryptoKeys/k/cryptoKeyVersions/1", Buffer.from("message")), Buffer.from("sig"));
  assert.equal(await kms.encrypt("projects/p/cryptoKeys/w", Buffer.from("root"), Buffer.from("aad")), "Y3Q=");
  assert.deepEqual(await kms.decrypt("projects/p/cryptoKeys/w", "Y3Q=", Buffer.from("aad")), Buffer.from("root"));
  const sts = calls.filter((c) => c.url.startsWith("https://sts."));
  assert.equal(sts.length, 1, "the access token is reused");
  assert.equal(sts[0].body.audience, `//iam.googleapis.com/${provider}`);
  assert.equal(sts[0].body.subjectToken, "attestation-token");
  assert.equal(sts[0].body.subjectTokenType, "urn:ietf:params:oauth:token-type:jwt");
  const sign = calls.find((c) => c.url.endsWith(":asymmetricSign"));
  assert.deepEqual(sign.body, { data: Buffer.from("message").toString("base64") });
  assert.equal(sign.auth, "Bearer federated-access");
  assert.equal(calls.find((c) => c.url.endsWith(":encrypt")).body.additionalAuthenticatedData, Buffer.from("aad").toString("base64"));
});
