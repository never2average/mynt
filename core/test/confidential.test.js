import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHmac, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign as edSign, verify } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The confidential host: the local adapter (today's behaviour), the confidential-VM adapter against the real service
// code with a fake KMS and a fake attestation service, the partner's check, the release record, and the vault's move
// into the host. Tests never touch a cloud.

process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");
const VAULT_KEY = process.env.MYNT_VAULT_KEY;

const vault = await import("../dist/vault.js");
const { LocalConfidentialHost } = await import("../dist/confidential/local.js");
const { ConfidentialSpaceHost } = await import("../dist/confidential/gcp-confidential-space.js");
const { PURPOSES, ConfidentialRefused, confidentialHostStatus, LOCAL_HOST_STATUS } = await import("../dist/confidential/host.js");
const { adoptVault, bootVault, confidentialHostFromEnv, rewrapVault, ConfidentialReleases } = await import("../dist/confidential/index.js");
const { verifyAttestationToken } = await import("../dist/confidential/attestation-verify.js");
const { clientAuthority, keysNonce, ATTESTATION_AUDIENCE } = await import("../dist/confidential/shared/binding.js");
const { sealStatement } = await import("../dist/confidential/shared/envelope.js");
const { healthAttestationMessage, statementMessage } = await import("../dist/confidential/shared/health.js");
const { expandKey, derivationPrk } = await import("../dist/confidential/shared/sealing.js");
const { buildFigures } = await import("../dist/product-health.js");
const { base58Encode } = await import("../dist/solana/codec.js");
const { Store } = await import("../dist/store.js");
const { createServer } = await import("../dist/server.js");
const { createMcpHttpServer } = await import("../dist/http.js");
const { CATALOG } = await import("./helpers.js");

const KEYHOUSE = fileURLToPath(new URL("../../deploy/confidential/", import.meta.url));
const { createKeyhouse, loadPolicy } = await import(`${KEYHOUSE}src/keyhouse.mjs`);
const { startKeyhouseServer } = await import(`${KEYHOUSE}src/http.mjs`);
const { selfSignedEd25519 } = await import(`${KEYHOUSE}src/cert.mjs`);
const { fakeKms, fakeLauncher, clientMaterial, IMAGE_DIGEST } = await import(`${KEYHOUSE}test/fakes.mjs`);

const WRAP_KEY = "projects/p/cryptoKeys/root";
const SIGNING_KEYS = { "health-attester": "projects/p/cryptoKeys/a/cryptoKeyVersions/1" };
const edPub = (raw) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
const openDb = () => {
  const pg = new PGlite();
  return { pg, db: { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() } };
};

// ---- the service's copy of the shared code ----

test("the confidential service runs the same shared code as Mynt's server, byte for byte", () => {
  const built = fileURLToPath(new URL("../dist/confidential/shared/", import.meta.url));
  const files = readdirSync(built).filter((f) => f.endsWith(".js")).sort();
  assert.deepEqual(readdirSync(`${KEYHOUSE}src/shared`).filter((f) => f.endsWith(".js")).sort(), files);
  for (const f of files)
    assert.equal(readFileSync(`${KEYHOUSE}src/shared/${f}`, "utf8"), readFileSync(built + f, "utf8"), `deploy/confidential/src/shared/${f} is stale: cd deploy/confidential && npm run sync-shared`);
});

test("the service's policy and Mynt's agree on which purposes ever come back out", () => {
  const policy = loadPolicy();
  assert.deepEqual(Object.keys(policy.purposes).sort(), Object.keys(PURPOSES).sort());
  for (const [p, rule] of Object.entries(PURPOSES)) assert.equal(policy.purposes[p].unseal, rule.unseal, p);
  // Nothing Mynt's server may unseal is a purpose that's meant never to leave.
  for (const p of policy.callers["mynt-core"].unseal) assert.equal(PURPOSES[p].unseal, true, p);
});

test("the service's image is pinned and has no dependencies to drift", () => {
  const docker = readFileSync(`${KEYHOUSE}Dockerfile`, "utf8");
  // Every base is pinned by digest; any other FROM names an earlier stage of the same file.
  const stages = [];
  for (const [, image, stage] of docker.matchAll(/^FROM (\S+)(?: AS (\S+))?$/gm)) {
    assert.ok(/@sha256:[0-9a-f]{64}$/.test(image) || stages.includes(image), `${image} is neither pinned by digest nor an earlier stage`);
    if (stage) stages.push(stage);
  }
  assert.deepEqual(stages, ["enclave-io", "keyhouse", "nitro", "confidential-space"]);
  assert.match(docker, /^FROM keyhouse AS confidential-space$/m, "the default target (the last stage) stays the container phase 1 built");
  const pkg = JSON.parse(readFileSync(`${KEYHOUSE}package.json`, "utf8"));
  const lock = JSON.parse(readFileSync(`${KEYHOUSE}package-lock.json`, "utf8"));
  assert.deepEqual(pkg.dependencies, {});
  assert.deepEqual(Object.keys(lock.packages), [""]);
  // Only non-secret settings may be overridden from the VM's metadata.
  const allowed = /allow_env_override"="([^"]+)"/.exec(docker)[1].split(",");
  assert.deepEqual(allowed.sort(), ["KEYHOUSE_CLIENT_CA", "KEYHOUSE_PORT", "KEYHOUSE_SIGNING_KEYS", "KEYHOUSE_WIP_PROVIDER", "KEYHOUSE_WRAPPED_ROOT", "KEYHOUSE_WRAP_KEY"]);
});

// ---- the local host ----

test("the local host keeps today's behaviour: keyed by MYNT_VAULT_KEY, the same rules, and it says it attests nothing", async () => {
  const host = new LocalConfidentialHost();
  const sealed = await host.seal("secret", Buffer.from("value"));
  assert.equal((await host.unseal("secret", sealed)).toString(), "value");
  await assert.rejects(host.unseal("partner-ledger", await host.seal("partner-ledger", Buffer.from("{}"))), ConfidentialRefused);
  await assert.rejects(host.unseal("vault-keys", sealed), ConfidentialRefused);
  const msg = randomBytes(20);
  // The health attester signs only inside computeHealth, here as on every host: never a message handed to it.
  await assert.rejects(host.sign({ name: "health-attester" }, msg), /signs only inside/);
  const s = await host.sign({ name: "another-key" }, msg);
  assert.equal(s.public_key, await host.publicKey("another-key"));
  assert.ok(verify(null, msg, edPub(s.public_key), Buffer.from(s.signature, "hex")));
  // Sealed to a key type, a value opens only as that type; one sealed before types were bound still opens.
  const typed = await host.seal("secret", Buffer.from("value"), "FREESTYLE_API_KEY");
  assert.match(typed, /^cs2:local:secret:/);
  assert.equal((await host.unseal("secret", typed, "FREESTYLE_API_KEY")).toString(), "value");
  await assert.rejects(host.unseal("secret", typed, "CLERK_SECRET_KEY"));
  await assert.rejects(host.unseal("secret", typed));
  assert.match(sealed, /^cs1:local:secret:/);
  assert.equal((await host.unseal("secret", sealed, "FREESTYLE_API_KEY")).toString(), "value");
  const a = await host.attest("n".repeat(20));
  assert.equal(a.format, "none");
  assert.equal(a.token, null);
  assert.equal(a.measurements.attested, false);
  assert.match(a.measurements.reason, /nothing is attested/);
  // Another server's key opens nothing of this one's.
  assert.equal(confidentialHostFromEnv({}, null).kind, "local");
  assert.throws(() => confidentialHostFromEnv({ CONFIDENTIAL_HOST: "elsewhere" }, null), ConfidentialRefused);
  assert.throws(() => confidentialHostFromEnv({ CONFIDENTIAL_HOST: "gcp-confidential-space" }, { inEffect: async () => [] }), /CONFIDENTIAL_HOST_URL/);
});

test("which host is never a silent choice: local is the default and says so; a remote host half configured or failing never becomes local", async () => {
  // Unset: the local host, with one plain line at start-up, and the same words in ops_status.
  const lines = [];
  assert.equal(confidentialHostFromEnv({}, null, undefined, (l) => lines.push(l)).kind, "local");
  assert.equal(confidentialHostFromEnv({ CONFIDENTIAL_HOST: "local" }, null, undefined, (l) => lines.push(l)).kind, "local");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("Confidential host: local (keys sealed in this server's own process)"), lines[0]);
  assert.match(lines[0], /Nothing is attested/);
  assert.equal(LOCAL_HOST_STATUS, "Confidential host: local (keys sealed in this server's own process)");
  assert.deepEqual(confidentialHostStatus({}), { kind: "local", attested: false, status: LOCAL_HOST_STATUS });
  assert.match(confidentialHostStatus({ CONFIDENTIAL_HOST: "aws-nitro" }).status, /^Confidential host: aws-nitro \(.*never falls back/);
  const { db } = openDb();
  const store = await Store.open(db, CATALOG);
  const { opsStatus } = await import("../dist/ops.js");
  const was = process.env.CONFIDENTIAL_HOST;
  delete process.env.CONFIDENTIAL_HOST;
  try {
    assert.equal((await opsStatus(db)).confidential_host, "Confidential host: local (keys sealed in this server's own process)");
    process.env.CONFIDENTIAL_HOST = "aws-nitro";
    assert.match((await opsStatus(db)).confidential_host, /^Confidential host: aws-nitro/);
  } finally {
    if (was === undefined) delete process.env.CONFIDENTIAL_HOST;
    else process.env.CONFIDENTIAL_HOST = was;
    await store.close();
  }

  // The line that selects the service is lost but its settings remain: refused, not run on the local host.
  for (const k of ["CONFIDENTIAL_HOST_URL", "CONFIDENTIAL_HOST_CLIENT_KEY", "CONFIDENTIAL_HOST_KMS_KEY", "CONFIDENTIAL_HOST_CLIENT_CA"])
    assert.throws(() => confidentialHostFromEnv({ [k]: "x" }, null, undefined, () => {}), new RegExp(`${k} is set but CONFIDENTIAL_HOST isn't`));

  // A remote host that's configured but misconfigured or unreachable: an error each time, never the local host.
  const m = clientMaterial("mynt-core");
  const dir = mkdtempSync(join(tmpdir(), "no-fallback-"));
  for (const [f, v] of [["c.crt", m.cert], ["c.key", m.key], ["ca.crt", m.ca]]) writeFileSync(join(dir, f), v);
  const releases = { inEffect: async () => [IMAGE_DIGEST], pcrsInEffect: async () => [] };
  const base = { CONFIDENTIAL_HOST: "gcp-confidential-space", CONFIDENTIAL_HOST_URL: "https://127.0.0.1:1", CONFIDENTIAL_HOST_CLIENT_CERT: join(dir, "c.crt"), CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "c.key") };
  assert.throws(() => confidentialHostFromEnv(base, releases), /CONFIDENTIAL_HOST_WRAP_KEY/);
  assert.throws(() => confidentialHostFromEnv({ ...base, CONFIDENTIAL_HOST_WRAP_KEY: "projects/p/cryptoKeys/root" }, releases), /CONFIDENTIAL_HOST_SIGNING_KEYS/);
  const custody = { CONFIDENTIAL_HOST_WRAP_KEY: "projects/p/cryptoKeys/root", CONFIDENTIAL_HOST_SIGNING_KEYS: JSON.stringify({ "health-attester": "projects/p/cryptoKeys/a/cryptoKeyVersions/1" }) };
  assert.throws(() => confidentialHostFromEnv({ ...base, ...custody }, releases), /CONFIDENTIAL_HOST_CLIENT_CA/);
  // The authority named must be the one that issued this server's client certificate.
  writeFileSync(join(dir, "other-ca.crt"), clientMaterial("mynt-core").ca);
  assert.throws(() => confidentialHostFromEnv({ ...base, ...custody, CONFIDENTIAL_HOST_CLIENT_CA: join(dir, "other-ca.crt") }, releases), /didn't issue this server's client certificate/);
  assert.throws(() => confidentialHostFromEnv({ ...base, CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "missing.key") }, releases));
  const host = confidentialHostFromEnv({ ...base, ...custody, CONFIDENTIAL_HOST_CLIENT_CA: join(dir, "ca.crt") }, releases);
  assert.equal(host.kind, "gcp-confidential-space");
  // Nothing listens there: every use fails; nothing is sealed in this process instead.
  await assert.rejects(host.seal("secret", Buffer.from("x")));
  await assert.rejects(host.measurements());
  const { rows } = await (async () => {
    const { db: d2 } = openDb();
    const s2 = await Store.open(d2, CATALOG);
    const { PlatformKeyVault } = await import("../dist/platform-keys.js");
    const { user } = await s2.createUser("Ada", ["admin"]);
    const v = await PlatformKeyVault.open(s2, { host, env: {} });
    assert.equal(await v.ready(), false);
    const { PLATFORM_KEY_TYPES } = await import("../dist/platform-keys.js");
    const r = await v.set(user, PLATFORM_KEY_TYPES[0].key, "x".repeat(64));
    assert.equal(r.ok, false, "a key isn't kept by the local host when the confidential service is the host and is down");
    const out = await d2.query("SELECT sealed FROM financial_products.platform_secrets");
    await s2.close();
    return out;
  })();
  assert.deepEqual(rows, []);
});

const partnerStatement = (entityId, productId, asOf) => {
  const kp = generateKeyPairSync("ed25519");
  const address = base58Encode(Buffer.from(kp.publicKey.export({ format: "jwk" }).x, "base64url"));
  const s = {
    schema: "mynt.partner_ledger.v1",
    provider_entity_id: entityId,
    environment: "live",
    request_id: "req-1",
    as_of: asOf,
    products: [{ product_id: productId, reserves_held_cents: 150_00, customer_obligations_cents: 100_00, reason: null }],
  };
  s.signature = { public_key: address, value: edSign(null, statementMessage(s), kp.privateKey).toString("hex") };
  return { statement: s, address };
};
const healthInput = (envelope, address, now) => ({
  envelope,
  expect: { entity_id: "firm-1", environment: "live", request_id: "req-1", public_key: address, other_key: null, max_age_ms: 86_400_000 },
  now,
  report: { schema: "mynt.product_health.v1", product_id: "p1", pool_id: null, sequence: 3, period_start: now, period_end: now, computed_at: now, live: true, partner: { entity_id: "firm-1", ledger: "partner_http", ledger_name: "x" } },
  flows: { flows: null, reason: "The money rails aren't connected to this Mynt", not_measured: {}, partial: { in: null, out: null, overall: null } },
  withdrawals: 2,
});

test("the local host computes a sealed statement exactly as product health would from the plain one", async () => {
  const host = new LocalConfidentialHost();
  const now = new Date().toISOString();
  const { statement, address } = partnerStatement("firm-1", "p1", now);
  const envelope = sealStatement(statement, await host.ingestPublicKey(), { provider_entity_id: "firm-1", environment: "live", request_id: "req-1" });
  assert.ok(!JSON.stringify(envelope).includes("15000"));
  const r = await host.computeHealth(healthInput(envelope, address, now));
  const expected = buildFigures({ reading: { reserves_held_cents: 150_00, customer_obligations_cents: 100_00, as_of: now, reason: null }, flows: null, flowsReason: "The money rails aren't connected to this Mynt", partial: { in: null, out: null, overall: null }, withdrawals: 2 });
  assert.deepEqual(r.report.figures, expected);
  assert.equal(r.report.source, "partner_ledger");
  assert.ok(verify(null, healthAttestationMessage(r.fingerprint), edPub(await host.publicKey("health-attester")), Buffer.from(r.attestation.signature, "hex")));
  // The signature binds what was checked: it's in the report the fingerprint is of.
  assert.deepEqual(r.report.sealed_statement, { result: "ok", signer_public_key: address, as_of: now, checked: { entity_id: "firm-1", environment: "live", request_id: "req-1", public_key: address, max_age_ms: 86_400_000, now } });
  assert.deepEqual(JSON.parse(r.canonical).sealed_statement, r.report.sealed_statement);
  // The same figures held to another key, request or age limit are another report, with another fingerprint to sign.
  const other = await host.computeHealth({ ...healthInput(envelope, address, now), expect: { ...healthInput(envelope, address, now).expect, max_age_ms: 1 } });
  assert.notEqual(other.report.sealed_statement.checked.max_age_ms, r.report.sealed_statement.checked.max_age_ms);
  assert.notEqual(other.fingerprint, r.fingerprint);
});

// ---- checking an attestation ----

test("an attestation token passes only with its signature, a production confidential OS, debugging off, the digest, the nonce and the key binding", async () => {
  const keys = { schema: "mynt.enclave_keys.v1", tls_spki_sha256: "00", ingest_public_key: "abc", signing: { "health-attester": "def" }, config: { wrap_key: WRAP_KEY, client_ca_sha256: "c".repeat(64), "signing_key:health-attester": SIGNING_KEYS["health-attester"] } };
  const custody = { wrapKey: WRAP_KEY, signingKeys: SIGNING_KEYS, clientCaSha256: "c".repeat(64) };
  const nonce = "partner-nonce-123456";
  const check = async (launcher, o = {}) => {
    const k = o.attested ?? keys; // what the service bound; o.keys is what the verifier was handed beside the token
    const token = await launcher.token({ audience: ATTESTATION_AUDIENCE, nonces: o.nonces ?? [nonce, keysNonce(k)] });
    return verifyAttestationToken(o.mangle ? o.mangle(token) : token, { jwks: (o.jwksFrom ?? launcher).jwks, audience: ATTESTATION_AUDIENCE, nonce, keys: o.keys ?? k, allowedDigests: o.digests ?? [IMAGE_DIGEST], expectedCustody: "custody" in o ? o.custody : custody });
  };
  const good = fakeLauncher();
  assert.deepEqual((await check(good)).problems, []);
  const problem = async (launcher, o, pattern) => {
    const r = await check(launcher, o);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => pattern.test(p)), `${r.problems.join(" | ")} should match ${pattern}`);
  };
  await problem(good, { digests: [`sha256:${"cd".repeat(32)}`] }, /isn't one announced/);
  await problem(fakeLauncher({ dbgstat: "enabled" }), {}, /debugging isn't off/);
  await problem(fakeLauncher({ swname: "GCE" }), {}, /CONFIDENTIAL_SPACE/);
  await problem(fakeLauncher({ secboot: false }), {}, /secure boot/);
  await problem(fakeLauncher({ submods: { container: { image_digest: IMAGE_DIGEST }, confidential_space: { support_attributes: ["USABLE"] } } }), {}, /STABLE/);
  await problem(fakeLauncher({ exp: 1 }), {}, /expired/);
  await problem(fakeLauncher({ iss: "https://elsewhere.example" }), {}, /issuer/);
  await problem(good, { nonces: ["other-nonce-123456", keysNonce(keys)] }, /your nonce/);
  await problem(good, { keys: { ...keys, ingest_public_key: "swapped" } }, /bind the keys/);
  await problem(good, { jwksFrom: fakeLauncher() }, /signature doesn't verify/);
  await problem(good, { mangle: (t) => t.split(".").slice(0, 2).join(".") + "." + Buffer.from("x").toString("base64url") }, /signature doesn't verify/);

  // Key custody: an honest image, properly attested, but started with someone else's keys or authority. Each is
  // bound by the image and compared with what the verifier expects; none is optional.
  const with_ = (config) => ({ attested: { ...keys, config } });
  await problem(good, with_({ ...keys.config, wrap_key: "projects/attacker/cryptoKeys/root" }), /root is wrapped by projects\/attacker\/cryptoKeys\/root, not/);
  await problem(good, with_({ ...keys.config, "signing_key:health-attester": "projects/attacker/cryptoKeys/a/cryptoKeyVersions/1" }), /signing_key:health-attester is projects\/attacker/);
  await problem(good, with_({ ...keys.config, client_ca_sha256: "d".repeat(64) }), /accepts client certificates from the authority d{64}, not c{64}/);
  await problem(good, with_({ ...keys.config, "signing_key:extra": "projects/p/x" }), /binds a setting \(signing_key:extra\) nothing was expected for/);
  await problem(good, { attested: { ...keys, signing: { ...keys.signing, extra: "ghi" } } }, /offers a signing key \(extra\) nothing was expected for/);
  // An image that binds nothing (as the first one did): refused, not passed for want of anything to compare.
  const { config: _none, ...unbound } = keys;
  await problem(good, { attested: unbound }, /root is wrapped by nothing the attestation binds/);
  // A verifier with no expected values: refused too.
  await problem(good, { custody: null }, /no expected key custody was given/);
  await problem(good, { custody: undefined }, /no expected key custody was given/);
  await problem(good, { custody: { ...custody, wrapKey: "" } }, /no expected value was given for wrap_key/);
  await problem(good, { custody: { ...custody, clientCaSha256: null } }, /no expected value was given for client_ca_sha256/);
  await problem(good, { custody: { ...custody, signingKeys: null } }, /no expected signing keys were given/);
  await problem(good, { custody: { ...custody, signingKeys: {} } }, /offers a signing key \(health-attester\) nothing was expected for/);
});

// ---- the confidential-VM adapter, against the real service code ----

// `over`: what whoever runs the VM set differently (its wrap key, its signing keys, the authority it trusts).
async function service({ launcher = fakeLauncher(), spkiOverride = null, over = {} } = {}) {
  const kms = fakeKms();
  const tls = selfSignedEd25519("mynt-keyhouse");
  const m = clientMaterial("mynt-core");
  const authority = clientAuthority(over.ca ?? m.ca);
  const base = { kms, launcher, wrapKey: over.wrapKey ?? WRAP_KEY, signingKeys: over.signingKeys ?? SIGNING_KEYS, clientCaSha256: authority.sha256, tlsSpki: spkiOverride ?? tls.spki, policy: loadPolicy() };
  const { wrapped_root } = await (await createKeyhouse(base)).handle("POST", "/v1/init", "mynt-core", {});
  const kh = await createKeyhouse({ ...base, wrappedRoot: wrapped_root });
  const server = await startKeyhouseServer(kh, { cert: tls.cert, key: tls.key, ca: authority.pem, port: 0, host: "127.0.0.1", log: () => {} });
  const url = `https://127.0.0.1:${server.address().port}`;
  const custody = { wrapKey: WRAP_KEY, signingKeys: SIGNING_KEYS, clientCaSha256: clientAuthority(m.ca).sha256 };
  const host = (o = {}) => new ConfidentialSpaceHost({ url, clientCert: m.cert, clientKey: m.key, allowedDigests: async () => [IMAGE_DIGEST], expectedCustody: custody, jwks: async () => launcher.jwks, ...o });
  return { server, url, m, host, launcher, kms, custody };
}

test("over attested, mutually authenticated TLS: seal, unseal, sign, attest, compute and the vault's keys", async () => {
  const s = await service();
  try {
    const host = s.host();
    const sealed = await host.seal("secret", Buffer.from("provider-api-key"));
    assert.match(sealed, /^cs1:cs:secret:/);
    assert.equal((await host.unseal("secret", sealed)).toString(), "provider-api-key");
    await assert.rejects(host.unseal("partner-ledger", sealed), ConfidentialRefused);
    const typed = await host.seal("secret", Buffer.from("provider-api-key"), "FREESTYLE_API_KEY");
    assert.match(typed, /^cs2:cs:secret:/);
    assert.equal((await host.unseal("secret", typed, "FREESTYLE_API_KEY")).toString(), "provider-api-key");
    await assert.rejects(host.unseal("secret", typed, "CLERK_SECRET_KEY"), /unseal_failed/);
    assert.equal((await host.unseal("secret", sealed, "FREESTYLE_API_KEY")).toString(), "provider-api-key", "sealed before types were bound: still opens");
    const msg = randomBytes(16);
    // The health attester is no signing oracle: refused by the adapter, and by the service were the adapter not there.
    const signsBefore = s.kms.calls.filter((c) => c[0] === "sign").length;
    await assert.rejects(host.sign({ name: "health-attester" }, msg), ConfidentialRefused);
    await assert.rejects(host.send("POST", "/v1/sign", { key: { name: "health-attester" }, message: msg.toString("base64url") }), /reserved_key/);
    assert.equal(s.kms.calls.filter((c) => c[0] === "sign").length, signsBefore);
    assert.ok(await host.publicKey("health-attester"));
    const seed = randomBytes(32);
    const sig = await host.sign({ sealed: await host.seal("signing-key", seed) }, msg);
    assert.ok(verify(null, msg, edPub(sig.public_key), Buffer.from(sig.signature, "hex")));
    await assert.rejects(host.sign({ name: "anything-else" }, msg), ConfidentialRefused);
    const m = await host.measurements();
    assert.deepEqual([m.attested, m.image_digest, m.debug], [true, IMAGE_DIGEST, false]);
    const a = await host.attest("partner-nonce-abcdef");
    assert.equal(a.format, "oidc-jwt");
    assert.deepEqual(a.keys.config, { wrap_key: WRAP_KEY, client_ca_sha256: s.custody.clientCaSha256, "signing_key:health-attester": SIGNING_KEYS["health-attester"] });
    assert.ok(verifyAttestationToken(a.token, { jwks: s.launcher.jwks, audience: ATTESTATION_AUDIENCE, nonce: "partner-nonce-abcdef", keys: a.keys, allowedDigests: [IMAGE_DIGEST], expectedCustody: s.custody }).ok);
    const now = new Date().toISOString();
    const { statement, address } = partnerStatement("firm-1", "p1", now);
    const r = await host.computeHealth(healthInput(sealStatement(statement, a.keys.ingest_public_key, { provider_entity_id: "firm-1", environment: "live", request_id: "req-1" }), address, now));
    assert.equal(r.report.figures.reserves_cents.value, 150_00);
    assert.equal(r.attestation.public_key, a.keys.signing["health-attester"]);
    assert.deepEqual([r.report.sealed_statement.result, r.report.sealed_statement.signer_public_key, r.report.sealed_statement.as_of, r.report.sealed_statement.checked.request_id], ["ok", address, now, "req-1"]);
    assert.ok(verify(null, healthAttestationMessage(r.fingerprint), edPub(r.attestation.public_key), Buffer.from(r.attestation.signature, "hex")));
    const legacy = randomBytes(32);
    const bundle = await host.adoptVaultRoot(legacy);
    const released = await host.releaseVaultKeys(bundle);
    assert.deepEqual(released.derivation_prk, derivationPrk(legacy));
    assert.equal(released.data_key.length, 32);
  } finally {
    s.server.close();
  }
});

test("no attested key, no request: a digest not in effect, a swapped TLS key, or no client certificate stop it before anything is sent", async () => {
  const s = await service();
  try {
    await assert.rejects(s.host({ allowedDigests: async () => [] }).seal("secret", Buffer.from("x")), /isn't one announced/);
    await assert.rejects(s.host({ allowedDigests: async () => [`sha256:${"ef".repeat(32)}`] }).measurements(), ConfidentialRefused);
    // Another authority's client certificate: the service hangs up during the handshake.
    const stranger = clientMaterial("mynt-core");
    await assert.rejects(s.host({ clientCert: stranger.cert, clientKey: stranger.key }).seal("secret", Buffer.from("x")));
  } finally {
    s.server.close();
  }
  // The attestation binds one TLS key, the connection presents another (a machine in the middle): refused.
  const mitm = await service({ spkiOverride: selfSignedEd25519("elsewhere").spki });
  try {
    await assert.rejects(mitm.host().seal("secret", Buffer.from("x")), /TLS key isn't the one its attestation binds/);
  } finally {
    mitm.server.close();
  }
  // Key custody: the right image, attested, but whoever runs the VM pointed it at a wrap key, a signing key or a
  // client authority of their own. Mynt's server refuses each before anything is sent.
  for (const [over, pattern] of [
    [{ wrapKey: "projects/attacker/cryptoKeys/root" }, /root is wrapped by projects\/attacker/],
    [{ signingKeys: { "health-attester": "projects/attacker/cryptoKeys/a/cryptoKeyVersions/1" } }, /signing_key:health-attester is projects\/attacker/],
  ]) {
    const moved = await service({ over });
    try {
      await assert.rejects(moved.host().seal("secret", Buffer.from("x")), pattern);
      // A server with nothing to expect refuses as well, rather than trusting what the service says about itself.
      await assert.rejects(moved.host({ expectedCustody: undefined }).seal("secret", Buffer.from("x")), /no expected key custody was given/);
    } finally {
      moved.server.close();
    }
  }
  // Their own authority, so they can call as mynt-core: the service's attestation shows it, and Mynt's server (whose
  // own certificate that service no longer accepts) is refused or refuses.
  const rogue = clientMaterial("mynt-core");
  const swapped = await service({ over: { ca: rogue.ca } });
  try {
    await assert.rejects(swapped.host().seal("secret", Buffer.from("x")));
    await assert.rejects(swapped.host({ clientCert: rogue.cert, clientKey: rogue.key }).seal("secret", Buffer.from("x")), /accepts client certificates from the authority/);
  } finally {
    swapped.server.close();
  }
  // Debugging on: refused, whatever the digest.
  const debug = await service({ launcher: fakeLauncher({ dbgstat: "enabled" }) });
  try {
    await assert.rejects(debug.host().seal("secret", Buffer.from("x")), /debugging isn't off/);
  } finally {
    debug.server.close();
  }
});

test("verify-mynt-enclave: a partner's own check passes for the published digest and fails for any other", async () => {
  const s = await service();
  try {
    const nonce = "partner-chosen-nonce-01";
    const a = await s.host().attest(nonce);
    const dir = mkdtempSync(join(tmpdir(), "verify-enclave-"));
    writeFileSync(join(dir, "attestation.json"), JSON.stringify({ ...a, releases: [{ image_digest: IMAGE_DIGEST, release: "test", effective_at: new Date().toISOString(), in_effect: true }] }));
    writeFileSync(join(dir, "jwks.json"), JSON.stringify(s.launcher.jwks));
    const custody = { "--expected-wrap-key": WRAP_KEY, "--expected-signing-key": `health-attester=${SIGNING_KEYS["health-attester"]}`, "--expected-client-ca-sha256": s.custody.clientCaSha256 };
    const run = (digest, n = nonce, over = {}) =>
      spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../scripts/verify-mynt-enclave.mjs", import.meta.url)), "--expected-digest", digest, "--attestation-file", join(dir, "attestation.json"), "--nonce", n, "--jwks-file", join(dir, "jwks.json"), ...Object.entries({ ...custody, ...over }).flatMap(([k, v]) => (v === null ? [] : [k, v]))],
        { encoding: "utf8" },
      );
    const ok = run(IMAGE_DIGEST);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const out = JSON.parse(ok.stdout);
    assert.deepEqual([out.wrap_key, out.client_ca_sha256], [WRAP_KEY, s.custody.clientCaSha256]);
    // Key custody is required, and wrong custody fails: the partner doesn't take the service's word for its keys.
    for (const flag of Object.keys(custody)) {
      const missing = run(IMAGE_DIGEST, nonce, { [flag]: null });
      assert.equal(missing.status, 2, flag);
      assert.match(missing.stderr, new RegExp(`${flag} is required`));
    }
    const moved = run(IMAGE_DIGEST, nonce, { "--expected-wrap-key": "projects/elsewhere/cryptoKeys/root" });
    assert.equal(moved.status, 1);
    assert.match(moved.stdout, /root is wrapped by/);
    assert.match(run(IMAGE_DIGEST, nonce, { "--expected-signing-key": "health-attester=projects/elsewhere/v/1" }).stdout, /signing_key:health-attester is/);
    assert.match(run(IMAGE_DIGEST, nonce, { "--expected-client-ca-sha256": "0".repeat(64) }).stdout, /accepts client certificates from the authority/);
    assert.equal(out.ingest_public_key, a.keys.ingest_public_key);
    assert.equal(out.health_attester_key, a.keys.signing["health-attester"]);
    const wrong = run(`sha256:${"00".repeat(32)}`);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stdout, /isn't one announced/);
    assert.match(wrong.stdout, /hasn't announced this digest/);
    assert.equal(run(IMAGE_DIGEST, "a-different-nonce-999").status, 1);
  } finally {
    s.server.close();
  }
});

// ---- the public attestation route ----

test("GET /confidential/attestation relays the host's answer, checks the nonce, and is rate-limited", async () => {
  const { db } = openDb();
  const store = await Store.open(db, CATALOG);
  const get = async (ctx, q) => {
    const srv = createMcpHttpServer(store, null, ctx).listen(0, "127.0.0.1");
    await new Promise((r) => srv.once("listening", r));
    try {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}/confidential/attestation${q}`);
      return { status: r.status, body: await r.json() };
    } finally {
      srv.close();
    }
  };
  assert.equal((await get({}, "?nonce=abcdefghijklmnop")).status, 404);
  const ctx = { confidential: new LocalConfidentialHost(), confidentialReleases: await ConfidentialReleases.open(db) };
  assert.equal((await get(ctx, "?nonce=short")).status, 400);
  assert.equal((await get(ctx, "?nonce=has%20space%20in%20it%20x")).status, 400);
  const ok = await get(ctx, "?nonce=abcdefghijklmnop");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.format, "none");
  assert.equal(ok.body.nonce, "abcdefghijklmnop");
  assert.deepEqual(ok.body.releases, []);
  assert.equal((await get(ctx, "?nonce=abcdefghijklmnop")).status, 429);
  await store.close();
});

// ---- the release record ----

test("releases: the first is in effect at once, later ones after 48 hours, each told to licence-provider firms; a planted row counts for nothing", async () => {
  const { db, pg } = openDb();
  const store = await Store.open(db, CATALOG);
  let clock = Date.UTC(2026, 10, 24, 12);
  const releases = await ConfidentialReleases.open(db, () => new Date(clock));
  const { user: admin } = await store.createUser("Ada", ["admin"]);
  const first = await releases.announce(store, admin, { image_digest: `sha256:${"11".repeat(32)}`, release: "v1", reason: "first" });
  assert.equal(first.in_effect, true);
  const second = await releases.announce(store, admin, { image_digest: `sha256:${"22".repeat(32)}`, release: "v2", reason: "fix" });
  assert.equal(second.in_effect, false);
  assert.equal(new Date(second.effective_at).getTime() - clock, 48 * 3_600_000);
  assert.deepEqual(await releases.inEffect(), [`sha256:${"11".repeat(32)}`]);
  clock += 48 * 3_600_000;
  assert.deepEqual((await releases.inEffect()).sort(), [`sha256:${"11".repeat(32)}`, `sha256:${"22".repeat(32)}`]);
  await assert.rejects(releases.announce(store, admin, { image_digest: "sha256:nothex", release: "x", reason: "x" }), /64 lowercase hex/);
  // Written straight into the table: no MAC, so never in effect.
  await pg.query(`INSERT INTO financial_products.confidential_releases (id, image_digest, release, reason, effective_at, mac) VALUES ($1, $2, 'evil', 'x', now(), 'bad')`, [crypto.randomUUID(), `sha256:${"33".repeat(32)}`]);
  assert.ok(!(await releases.inEffect()).includes(`sha256:${"33".repeat(32)}`));
  await releases.withdraw(store, admin, second.id, "rolled back");
  assert.deepEqual(await releases.inEffect(), [`sha256:${"11".repeat(32)}`]);
  // Who gets which tool.
  const tools = async (user) => {
    const [c, srv] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, {}).connect(srv);
    const client = new Client({ name: "t", version: "0" });
    await client.connect(c);
    return (await client.listTools()).tools.map((t) => t.name);
  };
  const { user: lp } = await store.createUser("Lee", ["license_provider"]);
  assert.ok((await tools(admin)).includes("announce_enclave_release"));
  assert.ok((await tools(lp)).includes("list_enclave_releases"));
  assert.ok(!(await tools(lp)).includes("announce_enclave_release"));
  await store.close();
});

test("a withdrawal is authenticated: cleared in the database, or an older copy of the row put back, the release is not in effect again", async () => {
  const { db, pg } = openDb();
  const store = await Store.open(db, CATALOG);
  let clock = Date.UTC(2026, 10, 24, 12);
  const releases = await ConfidentialReleases.open(db, () => new Date(clock));
  const { user: admin } = await store.createUser("Ada", ["admin"]);
  const D = (x) => `sha256:${x.repeat(32)}`;
  const first = await releases.announce(store, admin, { image_digest: D("11"), release: "v1", reason: "first" });
  const second = await releases.announce(store, admin, { image_digest: D("22"), release: "v2", reason: "fix" });
  clock += 48 * 3_600_000;
  assert.deepEqual((await releases.inEffect()).sort(), [D("11"), D("22")]);
  const row = async (id) => (await pg.query(`SELECT mac, withdrawn_at FROM financial_products.confidential_releases WHERE id = $1`, [id])).rows[0];
  const before = await row(second.id);
  assert.match(before.mac, /^v2v:[0-9a-f]{64}$/, "on the local host, under the vault-derived key");
  await releases.withdraw(store, admin, second.id, "bad build");
  const after = await row(second.id);
  assert.notEqual(after.mac, before.mac, "the MAC covers the withdrawal");
  const find = async (r, id) => (await r.list()).find((x) => x.id === id);
  assert.deepEqual([(await find(releases, second.id)).valid, (await find(releases, second.id)).in_effect], [true, false]);
  await assert.rejects(releases.withdraw(store, admin, second.id, "again"), /Already withdrawn/);

  // 1. withdrawn_at cleared in the database: the row no longer authenticates.
  await pg.query(`UPDATE financial_products.confidential_releases SET withdrawn_at = NULL WHERE id = $1`, [second.id]);
  assert.deepEqual([(await find(releases, second.id)).valid, (await find(releases, second.id)).in_effect], [false, false]);
  assert.deepEqual(await releases.inEffect(), [D("11")]);
  // 2. The whole row put back as it was before the withdrawal, its old MAC and all: authentic, but the withdrawal
  //    is also on record outside the row. A server that has restarted since (no memory of it) still reads the audit log.
  await pg.query(`UPDATE financial_products.confidential_releases SET withdrawn_at = NULL, mac = $2 WHERE id = $1`, [second.id, before.mac]);
  assert.deepEqual(await releases.inEffect(), [D("11")]);
  const { ConfidentialReleases: Fresh } = await import(`../dist/confidential/governance.js?restarted=${Date.now()}`);
  const restarted = await Fresh.open(db, () => new Date(clock));
  assert.deepEqual([(await find(restarted, second.id)).valid, (await find(restarted, second.id)).in_effect], [false, false]);
  assert.deepEqual(await restarted.inEffect(), [D("11")]);
  // 3. Another release's withdrawal moved onto a row doesn't authenticate either.
  await pg.query(`UPDATE financial_products.confidential_releases SET withdrawn_at = $2, mac = $3 WHERE id = $1`, [first.id, after.withdrawn_at, after.mac]);
  assert.equal((await find(releases, first.id)).valid, false);
  await store.close();
});

test("an emptied release table doesn't let the next announcement take effect at once", async () => {
  const D = (x) => `sha256:${x.repeat(32)}`;
  const clock = Date.UTC(2026, 10, 24, 12);
  const wait = async (prepare) => {
    const { db, pg } = openDb();
    const store = await Store.open(db, CATALOG);
    const releases = await ConfidentialReleases.open(db, () => new Date(clock));
    const { user: admin } = await store.createUser("Ada", ["admin"]);
    await prepare({ pg, store, releases, admin });
    const next = await releases.announce(store, admin, { image_digest: D("99"), release: "v9", reason: "after the table was emptied" });
    await store.close();
    return [next.in_effect, new Date(next.effective_at).getTime() - clock];
  };
  const HOURS_48 = 48 * 3_600_000;
  // A server that has never had a release: the first is in effect at once, as before.
  assert.deepEqual(await wait(async () => {}), [true, 0]);
  // Every row deleted: the audit log still says there was a release, so the next one waits.
  assert.deepEqual(
    await wait(async ({ pg, store, releases, admin }) => {
      await releases.announce(store, admin, { image_digest: D("11"), release: "v1", reason: "first" });
      await pg.query(`DELETE FROM financial_products.confidential_releases`);
    }),
    [false, HOURS_48],
  );
  // The audit log emptied as well, but the confidential host has kept something for Mynt (which it can't have before
  // a release was in effect): still waits.
  assert.deepEqual(
    await wait(async ({ pg, store, releases, admin }) => {
      await releases.announce(store, admin, { image_digest: D("11"), release: "v1", reason: "first" });
      await pg.query(`DELETE FROM financial_products.confidential_releases`);
      await pg.query(`DELETE FROM financial_products.audit_log`);
      await pg.query(`INSERT INTO financial_products.confidential_keys (name, sealed, host) VALUES ('host-root', 'wrapped', 'aws-nitro')`);
    }),
    [false, HOURS_48],
  );
  // Every MAC broken instead of the rows deleted (what "no valid release" used to count as a fresh start): waits.
  assert.deepEqual(
    await wait(async ({ pg, store, releases, admin }) => {
      await releases.announce(store, admin, { image_digest: D("11"), release: "v1", reason: "first" });
      await pg.query(`DELETE FROM financial_products.audit_log`);
      await pg.query(`UPDATE financial_products.confidential_releases SET mac = 'broken'`);
    }),
    [false, HOURS_48],
  );
});

test("release rows MACed in the first format still authenticate with the vault key at hand, and are MACed again to cover withdrawal", async () => {
  const { db, pg } = openDb();
  const store = await Store.open(db, CATALOG);
  const clock = Date.UTC(2026, 10, 24, 12);
  const id = crypto.randomUUID();
  const digest = `sha256:${"44".repeat(32)}`;
  const effective = new Date(clock - 1000).toISOString();
  await ConfidentialReleases.open(db, () => new Date(clock)); // the tables
  const v1 = createHmac("sha256", vault.derivedKey("confidential-releases")).update(`${id}\u0000${digest}\u0000v0\u0000${effective}`).digest("hex");
  await pg.query(`INSERT INTO financial_products.confidential_releases (id, image_digest, release, reason, effective_at, mac) VALUES ($1, $2, 'v0', 'from before', $3, $4)`, [id, digest, effective, v1]);
  const releases = await ConfidentialReleases.open(db, () => new Date(clock));
  assert.deepEqual(await releases.inEffect(), [digest]);
  const { mac } = (await pg.query(`SELECT mac FROM financial_products.confidential_releases WHERE id = $1`, [id])).rows[0];
  assert.match(mac, /^v2v:[0-9a-f]{64}$/);
  // A first-format MAC that doesn't check out is left alone and never in effect.
  const other = crypto.randomUUID();
  await pg.query(`INSERT INTO financial_products.confidential_releases (id, image_digest, release, reason, effective_at, mac) VALUES ($1, $2, 'evil', 'x', $3, $4)`, [other, `sha256:${"55".repeat(32)}`, effective, v1]);
  const again = await ConfidentialReleases.open(db, () => new Date(clock));
  assert.deepEqual(await again.inEffect(), [digest]);
  assert.equal((await pg.query(`SELECT mac FROM financial_products.confidential_releases WHERE id = $1`, [other])).rows[0].mac, v1);
  await store.close();
});

// ---- moving the vault into the host (last: it changes this process's vault) ----

test("HKDF-Expand of the released extract gives exactly the keys MYNT_VAULT_KEY derived", () => {
  const root = randomBytes(32);
  for (const info of ["mynt-derived-v1:product-health-subject", "mynt-sandbox-durable-v1", "mynt-derived-v1:ramp-quote:x:live"])
    assert.deepEqual(expandKey(derivationPrk(root), info), Buffer.from(hkdfSync("sha256", root, Buffer.alloc(0), info, 32)));
});

test("the migration: adopt, release at boot, re-wrap (a dry run first), then MYNT_VAULT_KEY can go and nothing changes", async () => {
  const { db } = openDb();
  const store = await Store.open(db, CATALOG);
  await db.exec(`CREATE TABLE financial_products.rewrap_probe (id int PRIMARY KEY, v text)`);
  const live = vault.seal("a customer's value", false);
  const hostingKey = vault.seal("app-key", false) + ":live";
  const sandbox = vault.seal("test value", true) + ":sandbox"; // this process's own key: not MYNT_VAULT_KEY's
  await db.query(`INSERT INTO financial_products.rewrap_probe VALUES (1, $1), (2, $2), (3, $3), (4, 'plain text')`, [live, hostingKey, sandbox]);
  const derivedBefore = vault.derivedKey("product-health-subject");
  const durableBefore = vault.seal("durable", true, true);

  const dry = await rewrapVault(db, { apply: false });
  const probe = dry.columns.find((c) => c.table === "rewrap_probe");
  assert.deepEqual([probe.legacy, probe.unopenable, probe.rewrapped, dry.dry_run], [2, 1, 0, true]);
  assert.equal((await db.query(`SELECT v FROM financial_products.rewrap_probe WHERE id = 1`)).rows[0].v, live, "a dry run changes nothing");

  const host = new LocalConfidentialHost();
  assert.equal(await bootVault(db, host), false, "nothing adopted yet");
  assert.deepEqual(await adoptVault(db, host), { adopted: true, host: "local" });
  assert.deepEqual(await adoptVault(db, host), { adopted: false, host: "local" });
  assert.equal(await bootVault(db, host), true);
  assert.equal(vault.vaultKeysReleased(), true);

  const applied = await rewrapVault(db, { apply: true });
  assert.equal(applied.columns.find((c) => c.table === "rewrap_probe").rewrapped, 2);
  assert.equal((await rewrapVault(db, { apply: false })).columns.find((c) => c.table === "rewrap_probe")?.legacy ?? 0, 0, "run again: nothing left");
  const rows = Object.fromEntries((await db.query(`SELECT id, v FROM financial_products.rewrap_probe`)).rows.map((r) => [r.id, r.v]));
  assert.match(rows[1], /^v2:/);
  assert.match(rows[2], /^v2:.*:live$/);
  assert.equal(rows[3], sandbox);

  delete process.env.MYNT_VAULT_KEY;
  try {
    assert.equal(vault.open(rows[1], false), "a customer's value");
    assert.equal(vault.open(rows[2].slice(0, -":live".length), false), "app-key");
    assert.throws(() => vault.open(live, false), /still sealed with MYNT_VAULT_KEY/);
    assert.deepEqual(vault.derivedKey("product-health-subject"), derivedBefore, "MACs and on-chain subjects don't move");
    assert.equal(vault.open(durableBefore, true), "durable");
    assert.match(vault.seal("new", false), /^v2:/);
    assert.equal(vault.vaultAvailable(false), true);
  } finally {
    process.env.MYNT_VAULT_KEY = VAULT_KEY;
  }
  await store.close();
});
