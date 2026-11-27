import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, verify, X509Certificate } from "node:crypto";
import { request } from "node:https";
import { selfSignedEd25519 } from "../src/cert.mjs";
import { startKeyhouseServer } from "../src/http.mjs";
import { confidentialSpacePlatform } from "../src/cloud.mjs";
import { createKeyhouse, loadPolicy, Refused } from "../src/keyhouse.mjs";
import { clientAuthority, keysNonce } from "../src/shared/binding.js";
import { sealStatement } from "../src/shared/envelope.js";
import { healthAttestationMessage, statementMessage } from "../src/shared/health.js";
import { childKey, sealUnder, unsealUnder } from "../src/shared/sealing.js";
import { clientMaterial, fakeKms, fakeLauncher } from "./fakes.mjs";

// The confidential service's own rules, against a fake KMS and a fake launcher: what it refuses, what never leaves it,
// and that a partner's sealed statement comes back as one product's figures and a signature.

const SIGNING = { "health-attester": "projects/p/locations/l/keyRings/r/cryptoKeys/attester/cryptoKeyVersions/1" };
const WRAP = "projects/p/locations/l/keyRings/r/cryptoKeys/root";
const CA_SHA256 = "c".repeat(64); // of the authority whose client certificates may call: bound into every attestation
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (b) => {
  let n = BigInt(`0x${Buffer.from(b).toString("hex")}`);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = `1${s}`;
  }
  return s;
};

async function keyhouse({ kms = fakeKms(), launcher = fakeLauncher(), initialised = true } = {}) {
  const tls = selfSignedEd25519("mynt-keyhouse");
  const base = { kms, launcher, wrapKey: WRAP, signingKeys: SIGNING, clientCaSha256: CA_SHA256, tlsSpki: tls.spki, policy: loadPolicy() };
  let wrappedRoot = null;
  if (initialised) wrappedRoot = (await (await createKeyhouse(base)).handle("POST", "/v1/init", "mynt-core", {})).wrapped_root;
  return { kh: await createKeyhouse({ ...base, wrappedRoot }), kms, launcher, tls, wrappedRoot };
}
const refusedWith = (code) => (e) => e instanceof Refused && e.code === code;
const b64u = (b) => Buffer.from(b).toString("base64url");

test("the TLS certificate made at boot parses, and its key is the one whose hash the attestation binds", () => {
  const t = selfSignedEd25519("mynt-keyhouse");
  const x = new X509Certificate(t.cert);
  assert.equal(x.subject, "CN=mynt-keyhouse");
  assert.ok(x.verify(x.publicKey), "self-signed");
  assert.deepEqual(x.publicKey.export({ type: "spki", format: "der" }), t.spki);
});

test("every certificate made at boot is valid DER, whatever its random serial (one in 256 used to start with a zero byte)", () => {
  for (let i = 0; i < 1500; i++) {
    const t = selfSignedEd25519("mynt-keyhouse");
    const x = new X509Certificate(t.cert);
    assert.ok(!x.serialNumber.startsWith("00"), x.serialNumber);
  }
});

test("until it's initialised it attests but seals nothing; init hands back only the wrapped root, once", async () => {
  const { kh, kms } = await keyhouse({ initialised: false });
  await assert.rejects(kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("x") }), refusedWith("not_initialised"));
  const a = await kh.handle("GET", "/v1/attestation", "mynt-core", null, new URLSearchParams({ nonce: "n".repeat(20) }));
  assert.equal(a.keys.ingest_public_key, "");
  const { wrapped_root } = await kh.handle("POST", "/v1/init", "mynt-core", {});
  assert.ok(wrapped_root && !wrapped_root.includes(" "));
  assert.deepEqual(kms.calls.at(-1), ["encrypt", WRAP]);
  // Not used until a restart reads it back: nothing is sealed under a root a restart would lose.
  await assert.rejects(kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("x") }), refusedWith("not_initialised"));
  const { kh: again } = await keyhouse({ initialised: true });
  await assert.rejects(again.handle("POST", "/v1/init", "mynt-core", {}), refusedWith("already_initialised"));
});

test("seal and unseal follow the purpose list and the caller's allow-list", async () => {
  const { kh } = await keyhouse();
  const { sealed } = await kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("api-key-value") });
  assert.match(sealed, /^cs1:cs:secret:/);
  assert.equal(Buffer.from((await kh.handle("POST", "/v1/unseal", "mynt-core", { purpose: "secret", sealed })).plaintext, "base64url").toString(), "api-key-value");
  // Sealed for one purpose never opens as another.
  await assert.rejects(kh.handle("POST", "/v1/unseal", "mynt-core", { purpose: "partner-ledger", sealed }), refusedWith("never_unsealed"));
  const books = (await kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "partner-ledger", plaintext: b64u("{}") })).sealed;
  await assert.rejects(kh.handle("POST", "/v1/unseal", "mynt-core", { purpose: "partner-ledger", sealed: books }), refusedWith("never_unsealed"));
  await assert.rejects(kh.handle("POST", "/v1/unseal", "mynt-core", { purpose: "signing-key", sealed: books }), refusedWith("never_unsealed"));
  await assert.rejects(kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "vault-keys", plaintext: b64u("x") }), refusedWith("not_allowed"));
  await assert.rejects(kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "nope", plaintext: b64u("x") }), refusedWith("unknown_purpose"));
  // A caller the policy doesn't name may do nothing but attest.
  await assert.rejects(kh.handle("POST", "/v1/seal", "someone-else", { purpose: "secret", plaintext: b64u("x") }), refusedWith("not_allowed"));
  await assert.rejects(kh.handle("POST", "/v1/unseal", "someone-else", { purpose: "secret", sealed }), refusedWith("not_allowed"));
  await assert.rejects(kh.handle("POST", "/v1/vault/release", "someone-else", { sealed }), refusedWith("not_allowed"));
});

test("the vault's legacy root goes in and never comes out: release gives the data key and HKDF-Extract of the root", async () => {
  const { kh } = await keyhouse();
  const legacy = randomBytes(32);
  const { sealed } = await kh.handle("POST", "/v1/vault/adopt", "mynt-core", { legacy_root: b64u(legacy) });
  const r = await kh.handle("POST", "/v1/vault/release", "mynt-core", { sealed });
  assert.deepEqual(Buffer.from(r.derivation_prk, "base64url"), createHmac("sha256", Buffer.alloc(32)).update(legacy).digest());
  assert.equal(Buffer.from(r.data_key, "base64url").length, 32);
  assert.ok(!JSON.stringify(r).includes(b64u(legacy)) && !JSON.stringify(r).includes(legacy.toString("base64")));
  await assert.rejects(kh.handle("POST", "/v1/unseal", "mynt-core", { purpose: "vault-keys", sealed }), refusedWith("never_unsealed"));
  await assert.rejects(kh.handle("POST", "/v1/vault/release", "mynt-core", { sealed: sealed.replace(/.$/, "A") }), refusedWith("unseal_failed"));
});

test("sealed with a context (a key's type), a value opens only under the same one; values from before contexts still open", async () => {
  const { kh, wrappedRoot, kms } = await keyhouse();
  const seal = (body) => kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "secret", plaintext: b64u("api-key-value"), ...body });
  const open = async (body) => Buffer.from((await kh.handle("POST", "/v1/unseal", "mynt-core", { purpose: "secret", ...body })).plaintext, "base64url").toString();
  const { sealed } = await seal({ context: "FREESTYLE_API_KEY" });
  assert.match(sealed, /^cs2:cs:secret:/);
  assert.equal(await open({ sealed, context: "FREESTYLE_API_KEY" }), "api-key-value");
  // The row moved to another type in the database, or read with no type at all: it doesn't open.
  await assert.rejects(open({ sealed, context: "CLERK_SECRET_KEY" }), refusedWith("unseal_failed"));
  await assert.rejects(open({ sealed }), refusedWith("unseal_failed"));
  // Relabelled as the old format, it still doesn't: the context is in what the cipher authenticates.
  await assert.rejects(open({ sealed: sealed.replace(/^cs2:/, "cs1:"), context: "FREESTYLE_API_KEY" }), refusedWith("unseal_failed"));
  await assert.rejects(seal({ context: "not a context|x" }), refusedWith("bad_context"));
  await assert.rejects(open({ sealed, context: { a: 1 } }), refusedWith("bad_context"));
  // A value sealed before contexts (cs1) opens, whatever context is named: old rows stay readable until sealed again.
  const old = (await seal({})).sealed;
  assert.match(old, /^cs1:cs:secret:/);
  assert.equal(await open({ sealed: old, context: "FREESTYLE_API_KEY" }), "api-key-value");
  // The shared code agrees, with the root alone.
  const root = await kms.decrypt(WRAP, wrappedRoot, Buffer.from("mynt-keyhouse-root-v1"));
  assert.equal(unsealUnder(root, "cs", "secret", sealed, "FREESTYLE_API_KEY").toString(), "api-key-value");
  assert.throws(() => unsealUnder(root, "cs", "secret", sealed, "ANOTHER_KEY"));
  assert.throws(() => unsealUnder(root, "cs", "secret", sealed));
});

test("signing: the health attester is no signing oracle, whatever the policy says; sealed keys sign only inside the service", async () => {
  const { kh, kms } = await keyhouse();
  const msg = randomBytes(40);
  // The image's own policy doesn't list it, and its public half is all a caller gets.
  assert.deepEqual(loadPolicy().callers["mynt-core"].sign, ["sealed"]);
  assert.deepEqual(loadPolicy().callers["mynt-core"].public_key, ["health-attester"]);
  const before = kms.calls.length;
  await assert.rejects(kh.handle("POST", "/v1/sign", "mynt-core", { key: { name: "health-attester" }, message: b64u(msg) }), refusedWith("reserved_key"));
  assert.ok(!kms.calls.slice(before).some((c) => c[0] === "sign"), "KMS was never asked to sign");
  const pub = await kh.handle("GET", "/v1/public-key", "mynt-core", null, new URLSearchParams({ name: "health-attester" }));
  assert.ok(pub.public_key);
  await assert.rejects(kh.handle("GET", "/v1/public-key", "someone-else", null, new URLSearchParams({ name: "health-attester" })), refusedWith("not_allowed"));
  // Even an image whose policy listed it (as the first one did) refuses: the rule is in the code, before the policy.
  const policy = loadPolicy();
  policy.callers["mynt-core"].sign = ["health-attester", "sealed"];
  const tls = selfSignedEd25519("mynt-keyhouse");
  const loose = await createKeyhouse({ kms: fakeKms(), launcher: fakeLauncher(), wrapKey: WRAP, signingKeys: SIGNING, clientCaSha256: CA_SHA256, tlsSpki: tls.spki, policy });
  await assert.rejects(loose.handle("POST", "/v1/sign", "mynt-core", { key: { name: "health-attester" }, message: b64u(msg) }), refusedWith("reserved_key"));
  await assert.rejects(kh.handle("POST", "/v1/sign", "mynt-core", { key: { name: "treasury-attester" }, message: b64u(msg) }), refusedWith("not_allowed"));
  // A key Mynt sealed to the service as signing-key: it signs, and the key itself is never returned.
  const seed = randomBytes(32);
  const { sealed } = await kh.handle("POST", "/v1/seal", "mynt-core", { purpose: "signing-key", plaintext: b64u(seed) });
  const s2 = await kh.handle("POST", "/v1/sign", "mynt-core", { key: { sealed }, message: b64u(msg) });
  assert.ok(verify(null, msg, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: s2.public_key }, format: "jwk" }), Buffer.from(s2.signature, "hex")));
});

test("an attestation carries the caller's nonce and the binding of the keys it returns", async () => {
  const { kh, launcher, tls } = await keyhouse();
  const nonce = "partner-nonce-0123456789";
  const a = await kh.handle("GET", "/v1/attestation", "mynt-core", null, new URLSearchParams({ nonce }));
  assert.deepEqual(launcher.issued.at(-1).nonces, [nonce, keysNonce(a.keys)]);
  assert.equal(launcher.issued.at(-1).audience, "mynt-enclave-attestation");
  assert.equal(a.keys.tls_spki_sha256, createHash("sha256").update(tls.spki).digest("hex"));
  assert.ok(a.keys.ingest_public_key && a.keys.signing["health-attester"]);
  // Key custody is part of what's attested: the wrap key, each signing key's version, and the client authority.
  assert.deepEqual(a.keys.config, { wrap_key: WRAP, client_ca_sha256: CA_SHA256, "signing_key:health-attester": SIGNING["health-attester"] });
  assert.equal(a.measurements.debug, false);
  await assert.rejects(kh.handle("GET", "/v1/attestation", "mynt-core", null, new URLSearchParams({ nonce: "short" })), refusedWith("bad_nonce"));
});

test("a service that can't say whose keys and callers it has never starts", async () => {
  const tls = selfSignedEd25519("mynt-keyhouse");
  const base = { kms: fakeKms(), launcher: fakeLauncher(), wrapKey: WRAP, signingKeys: SIGNING, tlsSpki: tls.spki, policy: loadPolicy() };
  await assert.rejects(createKeyhouse(base), /client-certificate authority/);
  await assert.rejects(createKeyhouse({ ...base, clientCaSha256: "not-a-hash" }), /client-certificate authority/);
  await assert.rejects(createKeyhouse({ ...base, clientCaSha256: CA_SHA256, wrapKey: "" }), /wrap key/);
  // A platform that binds nothing (as the container platform once did) is refused by the service itself.
  const unbound = { ...confidentialSpacePlatform({ ...base, clientCaSha256: CA_SHA256 }), config: null };
  await assert.rejects(createKeyhouse({ ...base, platform: unbound }), /bind its settings/);
});

test("the client authority is exactly one certificate, and its hash is of that certificate", () => {
  const m = clientMaterial("mynt-core");
  const other = clientMaterial("mynt-core");
  const a = clientAuthority(m.ca);
  assert.equal(a.sha256, createHash("sha256").update(new X509Certificate(m.ca).raw).digest("hex"));
  assert.equal(new X509Certificate(a.pem).fingerprint256, new X509Certificate(m.ca).fingerprint256);
  // The same certificate wrapped differently hashes the same; another authority doesn't.
  assert.equal(clientAuthority(`\n${m.ca.replace(/\n/g, "\r\n")}\n`).sha256, a.sha256);
  assert.notEqual(clientAuthority(other.ca).sha256, a.sha256);
  // A second authority smuggled in behind the expected one (TLS would trust both; a hash of the first wouldn't show it).
  assert.throws(() => clientAuthority(m.ca + other.ca), /exactly one/);
  assert.throws(() => clientAuthority(""), /exactly one/);
  assert.throws(() => clientAuthority(m.ca + m.key), /exactly one/);
  // A client certificate isn't an authority.
  assert.throws(() => clientAuthority(m.cert), /certificate authority/);
});

test("a partner's sealed statement becomes one product's figures and a signature; a forged or misaddressed one, no figures", async () => {
  const { kh } = await keyhouse();
  const a = await kh.handle("GET", "/v1/attestation", "mynt-core", null, new URLSearchParams({ nonce: "n".repeat(20) }));
  const partner = generateKeyPairSync("ed25519");
  const partnerKey = base58(Buffer.from(partner.publicKey.export({ format: "jwk" }).x, "base64url"));
  const now = new Date();
  const statement = {
    schema: "mynt.partner_ledger.v1",
    provider_entity_id: "firm-1",
    environment: "live",
    request_id: "req-1",
    as_of: now.toISOString(),
    products: [
      { product_id: "p1", reserves_held_cents: 15000, customer_obligations_cents: 10000, reason: null },
      { product_id: "p2", reserves_held_cents: 999999, customer_obligations_cents: 1, reason: null },
    ],
  };
  statement.signature = { public_key: partnerKey, value: edSign(null, statementMessage(statement), partner.privateKey).toString("hex") };
  const meta = { provider_entity_id: "firm-1", environment: "live", request_id: "req-1" };
  const input = (envelope, over = {}) => ({
    envelope,
    expect: { entity_id: "firm-1", environment: "live", request_id: "req-1", public_key: partnerKey, other_key: null, max_age_ms: 86_400_000, ...over },
    now: now.toISOString(),
    report: { schema: "mynt.product_health.v1", product_id: "p1", pool_id: null, sequence: 1, period_start: now.toISOString(), period_end: now.toISOString(), computed_at: now.toISOString(), live: true, partner: { entity_id: "firm-1", ledger: "partner_http", ledger_name: "x" } },
    flows: { flows: null, reason: "none", not_measured: {}, partial: { in: null, out: null, overall: null } },
    withdrawals: null,
  });
  const r = await kh.handle("POST", "/v1/health/compute", "mynt-core", { input: input(sealStatement(statement, a.keys.ingest_public_key, meta)) });
  assert.equal(r.ledger_error, null);
  assert.equal(r.report.figures.reserves_cents.value, 15000);
  assert.equal(r.report.figures.coverage_bps.value, 15000);
  assert.ok(!JSON.stringify(r).includes("999999"), "another product's figures never leave");
  assert.equal(r.attestation.public_key, a.keys.signing["health-attester"]);
  assert.ok(verify(null, healthAttestationMessage(r.fingerprint), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: r.attestation.public_key }, format: "jwk" }), Buffer.from(r.attestation.signature, "hex")));
  // The signed report says what was checked: whose key signed the statement, its as_of, and what it was held to.
  assert.deepEqual(r.report.sealed_statement, {
    result: "ok",
    signer_public_key: partnerKey,
    as_of: statement.as_of,
    checked: { entity_id: "firm-1", environment: "live", request_id: "req-1", public_key: partnerKey, max_age_ms: 86_400_000, now: now.toISOString() },
  });
  assert.equal(r.fingerprint, createHash("sha256").update(r.canonical).digest("hex"));
  assert.ok(r.canonical.includes(partnerKey) && JSON.parse(r.canonical).sealed_statement.as_of === statement.as_of, "what was checked is inside what the fingerprint, and so the signature, covers");
  // Signed with a key other than the firm's: no figures.
  const bad = await kh.handle("POST", "/v1/health/compute", "mynt-core", { input: input(sealStatement(statement, a.keys.ingest_public_key, meta), { public_key: base58(randomBytes(32)) }) });
  assert.equal(bad.ledger_error, "statement_signature");
  assert.deepEqual([bad.report.sealed_statement.result, bad.report.sealed_statement.signer_public_key, bad.report.sealed_statement.as_of], ["statement_signature", null, null]);
  assert.equal(bad.report.figures.reserves_cents.value, null);
  assert.equal(bad.report.source, "unavailable");
  // Sealed to some other key: unreadable.
  const other = generateKeyPairSync("x25519");
  const wrong = await kh.handle("POST", "/v1/health/compute", "mynt-core", { input: input(sealStatement(statement, other.publicKey.export({ format: "jwk" }).x, meta)) });
  assert.equal(wrong.ledger_error, "statement_unreadable");
  // Addressed to another request.
  const replay = await kh.handle("POST", "/v1/health/compute", "mynt-core", { input: input(sealStatement(statement, a.keys.ingest_public_key, meta), { request_id: "req-2" }) });
  assert.equal(replay.ledger_error, "statement_identity");
  await assert.rejects(kh.handle("POST", "/v1/health/compute", "someone-else", { input: input(sealStatement(statement, a.keys.ingest_public_key, meta)) }), refusedWith("not_allowed"));
});

test("over TLS: no client certificate, no answer; the caller is its certificate's name; errors are codes only", async () => {
  const { kh, tls } = await keyhouse();
  const m = clientMaterial("mynt-core");
  const lines = [];
  // As server.mjs starts it: the authority that was hashed into the attestation, re-encoded, is the one TLS trusts.
  const server = await startKeyhouseServer(kh, { cert: tls.cert, key: tls.key, ca: clientAuthority(m.ca).pem, port: 0, host: "127.0.0.1", log: (l) => lines.push(l) });
  const port = server.address().port;
  const stranger = clientMaterial("mynt-core"); // the right name, from an authority the service wasn't given
  const call = (path, body, auth = true) =>
    new Promise((resolve, reject) => {
      const payload = body ? Buffer.from(JSON.stringify(body)) : null;
      const req = request({ host: "127.0.0.1", port, path, method: body ? "POST" : "GET", rejectUnauthorized: false, ...(auth ? { cert: (auth === true ? m : auth).cert, key: (auth === true ? m : auth).key } : {}), headers: { "content-type": "application/json" } }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "null") }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  try {
    await assert.rejects(call("/v1/healthz", null, false));
    await assert.rejects(call("/v1/healthz", null, stranger), "a certificate naming mynt-core from another authority is no caller");
    assert.equal((await call("/v1/healthz")).status, 200);
    const sealed = await call("/v1/seal", { purpose: "secret", plaintext: b64u("value-never-logged") });
    assert.equal(sealed.status, 200);
    const refused = await call("/v1/unseal", { purpose: "partner-ledger", sealed: sealed.body.sealed });
    assert.deepEqual(refused, { status: 403, body: { error: "never_unsealed" } });
    assert.ok(lines.some((l) => l === "POST /v1/seal mynt-core 200"));
    assert.ok(!lines.join("\n").includes("value-never-logged") && !lines.join("\n").includes(b64u("value-never-logged")));
  } finally {
    server.close();
  }
});

test("the sealing format is the shared one: a value sealed by the service opens with the shared code and its root only", async () => {
  const root = randomBytes(32);
  const s = sealUnder(root, "cs", "secret", Buffer.from("x"));
  assert.match(s, /^cs1:cs:secret:/);
  assert.match(sealUnder(root, "cs", "secret", Buffer.from("x"), "A_KEY_TYPE"), /^cs2:cs:secret:/);
  assert.notDeepEqual(childKey(root, "ingest"), childKey(randomBytes(32), "ingest"));
});
