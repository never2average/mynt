import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes, X509Certificate } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

// The enclave host (aws-nitro): checking an enclave's attestation document against a test authority (and that the root
// pinned for real ones is AWS's), the adapter against the real service code behind a fake parent instance, releases
// that announce PCRs, the partner's check, and the CloudFormation template's key policy. Tests never touch a cloud.

process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");

const { NITRO_ROOT_PEM, NitroEnclaveHost, verifyNitroAttestation } = await import("../dist/confidential/aws-nitro.js");
const { ConfidentialRefused } = await import("../dist/confidential/host.js");
const { adoptVault, bootVault, confidentialHostFromEnv, initialiseHost, storedWrappedRoot, ConfidentialReleases } = await import("../dist/confidential/index.js");
const { releaseMacKeysFromEnv } = await import("../dist/confidential/governance.js");
const { clientAuthority, keysNonce, KEYS_SCHEMA } = await import("../dist/confidential/shared/binding.js");
const vault = await import("../dist/vault.js");
const { Store } = await import("../dist/store.js");
const { CATALOG } = await import("./helpers.js");

const KEYHOUSE = fileURLToPath(new URL("../../deploy/confidential/", import.meta.url));
const { createKeyhouse, loadPolicy } = await import(`${KEYHOUSE}src/keyhouse.mjs`);
const { startKeyhouseServer } = await import(`${KEYHOUSE}src/http.mjs`);
const { selfSignedEd25519 } = await import(`${KEYHOUSE}src/cert.mjs`);
const { nitroKms, nitroPlatform } = await import(`${KEYHOUSE}src/nitro.mjs`);
const { clientMaterial } = await import(`${KEYHOUSE}test/fakes.mjs`);
const { fakeCredentials, fakeNitroKms, fakeNsm, testNitroChain, KEY_ARN, PCRS } = await import(`${KEYHOUSE}test/fakes-nitro.mjs`);

const openDb = () => {
  const pg = new PGlite();
  return { pg, db: { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() } };
};
const chain = testNitroChain();

// AWS documents this SHA-256 fingerprint for AWS_NitroEnclaves_Root-G1 (Nitro Enclaves User Guide, "Verifying the root
// of trust"); the zip it ships in has SHA-256 8cf60e2b2efca96c6a9e71e851d00c1b6991cc09eadbe64a6a1d1b1eb9faff7c.
const DOCUMENTED_ROOT_FINGERPRINT = "64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B";

test("the pinned root is AWS's Nitro Enclaves root: its documented fingerprint, a self-signed P-384 CA valid until 2049", () => {
  const root = new X509Certificate(NITRO_ROOT_PEM);
  assert.equal(root.fingerprint256, DOCUMENTED_ROOT_FINGERPRINT);
  assert.equal(root.subject, "C=US\nO=Amazon\nOU=AWS\nCN=aws.nitro-enclaves");
  assert.ok(root.ca && root.verify(root.publicKey));
  assert.equal(root.publicKey.asymmetricKeyDetails.namedCurve, "secp384r1");
  assert.equal(new Date(root.validTo).getUTCFullYear(), 2049);
  // The documentation names the same fingerprint, so partners can compare.
  assert.ok(readFileSync(fileURLToPath(new URL("../../docs/reference/confidential-computing.md", import.meta.url)), "utf8").includes(DOCUMENTED_ROOT_FINGERPRINT));
});

// ---- the document check ----

const tls = selfSignedEd25519("mynt-keyhouse");
const CA_SHA256 = "c".repeat(64); // the authority whose client certificates the enclave accepts, as it binds it
const keys = { schema: KEYS_SCHEMA, tls_spki_sha256: createHash("sha256").update(tls.spki).digest("hex"), ingest_public_key: "ingest", signing: { "health-attester": "attester" }, config: { kms_key: KEY_ARN, region: "us-east-1", client_ca_sha256: CA_SHA256 } };
const nonce = "partner-nonce-0123456789";
async function doc({ nsm = fakeNsm({ chain }), fields = {} } = {}) {
  return (await nsm.attest({ nonce: Buffer.from(nonce), userData: Buffer.from(keysNonce(keys)), publicKey: tls.spki, ...fields })).toString("base64");
}
const check = (d, o = {}) => verifyNitroAttestation(d, { nonce, keys, allowedPcrs: [PCRS], expectedKmsKey: KEY_ARN, expectedClientCaSha256: CA_SHA256, roots: [chain.rootPem], ...o });

test("an enclave's document passes only with its signature, the chain to the root, announced PCRs, freshness, the nonce and the bindings", async () => {
  const good = check(await doc());
  assert.deepEqual(good.problems, []);
  assert.deepEqual(good.pcrs, PCRS);
  const problem = async (d, o, re) => {
    const r = check(typeof d === "string" ? d : await doc(d), o);
    assert.equal(r.ok, false);
    assert.match(r.problems.join("; "), re);
  };
  await problem({}, { allowedPcrs: [{ ...PCRS, pcr2: "ff".repeat(48) }] }, /aren't one announced/);
  await problem({}, { allowedPcrs: [] }, /aren't one announced/);
  await problem({}, { nonce: "another-nonce-0000000" }, /your nonce/);
  // A real-looking document from another authority: not AWS's root.
  await problem({}, { roots: undefined }, /doesn't start at the AWS Nitro Enclaves root/);
  await problem({ nsm: fakeNsm({ chain, over: { cabundle: [chain.intermediate] } }) }, {}, /doesn't start at the AWS Nitro Enclaves root/);
  await problem({ nsm: fakeNsm({ chain, over: { cabundle: [chain.root, chain.leaf] } }) }, {}, /isn't issued by the one before it|isn't a CA/);
  await problem({ nsm: fakeNsm({ chain, over: { flipSignature: true } }) }, {}, /signature doesn't verify/);
  await problem({ nsm: fakeNsm({ chain, over: { signingKey: testNitroChain().leafKey } }) }, {}, /signature doesn't verify/);
  await problem({ nsm: fakeNsm({ chain, over: { timestamp: Date.now() - 10 * 60_000 } }) }, {}, /stale/);
  await problem({ nsm: fakeNsm({ chain, over: { timestamp: Date.now() + 10 * 60_000 } }) }, {}, /in the future/);
  await problem({}, { now: new Date(Date.now() + 3 * 86_400_000), maxAgeMs: 10 * 86_400_000 }, /isn't valid now/);
  await problem({ nsm: fakeNsm({ chain, pcrs: { pcr0: "00".repeat(48), pcr1: "00".repeat(48), pcr2: "00".repeat(48) } }) }, {}, /debug mode/);
  await problem({}, { keys: { ...keys, ingest_public_key: "swapped" } }, /bind the keys/);
  await problem({ fields: { publicKey: selfSignedEd25519("elsewhere").spki } }, {}, /public key isn't the service's TLS key/);
  await problem({}, { expectedKmsKey: KEY_ARN.replace("1234abcd", "9999abcd") }, /wrapped by/);
  await problem("bm90IGNib3I=", {}, /can't be read/);
});

test("what the parent handed the enclave is checked, never taken: the wrap key and the client authority both need an expected value", async () => {
  const bound = async (config, o = {}) => {
    const k = { ...keys, config };
    const d = (await fakeNsm({ chain }).attest({ nonce: Buffer.from(nonce), userData: Buffer.from(keysNonce(k)), publicKey: tls.spki })).toString("base64");
    return check(d, { keys: k, ...o });
  };
  const fails = async (config, o, re) => {
    const r = await bound(config, o);
    assert.equal(r.ok, false);
    assert.match(r.problems.join("; "), re);
  };
  assert.deepEqual((await bound(keys.config)).problems, []);
  // Root on the parent adds an authority of its own and restarts the enclave: the same image, the same PCRs, a
  // genuine document, and a different authority bound into it.
  await fails({ ...keys.config, client_ca_sha256: "d".repeat(64) }, {}, /accepts client certificates from the authority d{64}, not c{64}/);
  // An image from before the authority was bound says nothing about it: refused, not passed.
  await fails({ kms_key: KEY_ARN, region: "us-east-1" }, {}, /accepts client certificates from the authority nothing the attestation binds/);
  // A verifier with no expected value has nothing to hold the enclave to: refused, for each setting.
  for (const none of [undefined, null, ""]) {
    await fails(keys.config, { expectedClientCaSha256: none }, /no expected value was given for client_ca_sha256/);
    await fails(keys.config, { expectedKmsKey: none }, /no expected value was given for kms_key/);
  }
  // The key in another region, or a setting nobody expected.
  await fails({ ...keys.config, region: "eu-west-1" }, {}, /uses KMS in eu-west-1, not us-east-1/);
  await fails({ ...keys.config, extra: "x" }, {}, /binds a setting \(extra\) nothing was expected for/);
});

// ---- the adapter, against the real service behind a fake parent instance ----

// The enclave: the real service on the Nitro platform, listening on a Unix socket as it does inside an enclave. The
// parent: a TCP relay to that socket (socat's job on a real instance).
// `ca`: the authority the parent handed it (the real one, unless root on the parent swapped in its own).
async function enclave({ kms, nsm = fakeNsm({ chain }), ca = enclave.client.ca }) {
  const dir = mkdtempSync(join(tmpdir(), "enclave-"));
  const t = selfSignedEd25519("mynt-keyhouse");
  const client = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm, credentials: fakeCredentials, post: kms.post });
  // As server.mjs does with the parent's settings: the one authority, hashed into the attestation and given to TLS.
  const authority = clientAuthority(ca);
  const kh = await createKeyhouse({ platform: nitroPlatform({ kms: client, nsm, region: "us-east-1", keyArn: KEY_ARN, clientCaSha256: authority.sha256 }), wrappedRoot: null, tlsSpki: t.spki, policy: loadPolicy() });
  const path = join(dir, "https.sock");
  const server = await startKeyhouseServer(kh, { cert: t.cert, key: t.key, ca: authority.pem, path, log: () => {} });
  return { server, path };
}
enclave.client = clientMaterial("mynt-core");
const CLIENT_CA_SHA256 = clientAuthority(enclave.client.ca).sha256;

async function parent(target) {
  const relay = createNetServer((c) => {
    const e = netConnect(target.path);
    c.pipe(e).pipe(c);
    c.on("error", () => e.destroy());
    e.on("error", () => c.destroy());
  });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  return relay;
}

test("over the parent's relay: attested and pinned, init stores the wrapped root, and a restarted enclave gets it back", async () => {
  const { db } = openDb();
  const store = await Store.open(db, CATALOG);
  await ConfidentialReleases.open(db); // as at boot: the confidential tables exist before the host is used
  const kms = fakeNitroKms();
  let inside = await enclave({ kms });
  const target = { path: inside.path };
  const relay = await parent(target);
  const url = `https://127.0.0.1:${relay.address().port}`;
  const m = enclave.client;
  const host = (o = {}) => new NitroEnclaveHost({ url, clientCert: m.cert, clientKey: m.key, allowedPcrs: async () => [PCRS], expectedKmsKey: KEY_ARN, expectedClientCaSha256: CLIENT_CA_SHA256, roots: [chain.rootPem], wrappedRoot: () => storedWrappedRoot(db, "aws-nitro"), ...o });
  try {
    const h = host();
    const measured = await h.measurements();
    assert.deepEqual([measured.host, measured.attested, measured.pcrs, measured.debug], ["aws-nitro", true, PCRS, false]);
    await assert.rejects(h.seal("secret", Buffer.from("x")), /not_initialised/);
    const init = await initialiseHost(db, h);
    assert.equal(init.stored, true);
    assert.equal(await storedWrappedRoot(db, "aws-nitro"), init.wrapped_root);
    await assert.rejects(initialiseHost(db, h), /already has a root/);
    const sealed = await h.seal("secret", Buffer.from("provider-api-key"));
    assert.match(sealed, /^cs1:ne:secret:/);
    const attester = await h.publicKey("health-attester");
    // The attester signs only inside the health check: no caller gets a signature over a message of its choosing.
    await assert.rejects(h.sign({ name: "health-attester" }, Buffer.from("anything")), ConfidentialRefused);
    await assert.rejects(h.send("POST", "/v1/sign", { key: { name: "health-attester" }, message: Buffer.from("anything").toString("base64url") }), /reserved_key/);
    const attested = await h.attest("partner-nonce-0123456789");
    assert.deepEqual(attested.keys.config, { kms_key: KEY_ARN, region: "us-east-1", client_ca_sha256: CLIENT_CA_SHA256 });

    // The enclave restarts: a new TLS key, no root. The adapter re-attests the new key and hands the root back.
    inside.server.close();
    inside = await enclave({ kms });
    target.path = inside.path;
    assert.equal((await h.unseal("secret", sealed)).toString(), "provider-api-key");
    assert.equal(await h.publicKey("health-attester"), attester, "the attester is derived from the root, so it survives restarts");

    // Not announced, or wrapped by another key: refused before anything is sent.
    await assert.rejects(host({ allowedPcrs: async () => [] }).seal("secret", Buffer.from("x")), /aren't one announced/);
    await assert.rejects(host({ expectedKmsKey: KEY_ARN.replace("1234abcd", "9999abcd") }).measurements(), ConfidentialRefused);
    // A server that wasn't told which authority or key to expect refuses, rather than taking the enclave's word.
    await assert.rejects(host({ expectedClientCaSha256: undefined }).measurements(), /no expected value was given for client_ca_sha256/);
    await assert.rejects(host({ expectedKmsKey: undefined }).measurements(), /no expected value was given for kms_key/);

    // A real deployment checks against AWS's root, which no test authority chains to.
    await assert.rejects(host({ roots: undefined }).measurements(), /AWS Nitro Enclaves root/);
    // Root on the parent hands the enclave an authority of its own and restarts it, to call it as mynt-core. Same
    // image, same PCRs, a genuine attestation: but the authority is bound into it, so Mynt's server stops (its own
    // certificate is no longer accepted, and were it, the attestation names the wrong authority), and anyone
    // holding the attacker's certificate and checking the attestation sees the swap.
    const rogue = clientMaterial("mynt-core");
    inside.server.close();
    inside = await enclave({ kms, ca: rogue.ca });
    target.path = inside.path;
    await assert.rejects(h.unseal("secret", sealed));
    const asAttacker = host({ clientCert: rogue.cert, clientKey: rogue.key });
    await assert.rejects(asAttacker.measurements(), /accepts client certificates from the authority/);
    // The attacker can still call the enclave directly with its own certificate: that's what the attestation exposes.
    const seen = await host({ clientCert: rogue.cert, clientKey: rogue.key, expectedClientCaSha256: clientAuthority(rogue.ca).sha256 }).attest("partner-nonce-0123456789");
    assert.notEqual(seen.keys.config.client_ca_sha256, CLIENT_CA_SHA256);
    assert.equal(verifyNitroAttestation(seen.token, { nonce: "partner-nonce-0123456789", keys: seen.keys, allowedPcrs: [PCRS], expectedKmsKey: KEY_ARN, expectedClientCaSha256: CLIENT_CA_SHA256, roots: [chain.rootPem] }).ok, false, "a partner checking with the published authority refuses it");
  } finally {
    inside.server.close();
    relay.close();
    await store.close();
  }
});

test("from the environment: aws-nitro needs the URL, the client certificate, the wrap key's ARN and the client authority", () => {
  const releases = { inEffect: async () => [], pcrsInEffect: async () => [] };
  assert.throws(() => confidentialHostFromEnv({ CONFIDENTIAL_HOST: "aws-nitro" }, releases), /CONFIDENTIAL_HOST_URL/);
  const dir = mkdtempSync(join(tmpdir(), "nitro-env-"));
  const m = enclave.client;
  writeFileSync(join(dir, "c.crt"), m.cert);
  writeFileSync(join(dir, "c.key"), m.key);
  const env = { CONFIDENTIAL_HOST: "aws-nitro", CONFIDENTIAL_HOST_URL: "https://203.0.113.10:8443", CONFIDENTIAL_HOST_CLIENT_CERT: join(dir, "c.crt"), CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "c.key") };
  assert.throws(() => confidentialHostFromEnv(env, releases), /CONFIDENTIAL_HOST_KMS_KEY/);
  // The authority isn't optional: without it the server would have nothing to hold the enclave's callers to.
  assert.throws(() => confidentialHostFromEnv({ ...env, CONFIDENTIAL_HOST_KMS_KEY: KEY_ARN }, releases), /CONFIDENTIAL_HOST_CLIENT_CA/);
  writeFileSync(join(dir, "ca.crt"), m.ca);
  writeFileSync(join(dir, "two.crt"), m.ca + clientMaterial("mynt-core").ca);
  writeFileSync(join(dir, "other.crt"), clientMaterial("mynt-core").ca);
  assert.throws(() => confidentialHostFromEnv({ ...env, CONFIDENTIAL_HOST_KMS_KEY: KEY_ARN, CONFIDENTIAL_HOST_CLIENT_CA: join(dir, "two.crt") }, releases), /exactly one PEM certificate/);
  assert.throws(() => confidentialHostFromEnv({ ...env, CONFIDENTIAL_HOST_KMS_KEY: KEY_ARN, CONFIDENTIAL_HOST_CLIENT_CA: join(dir, "other.crt") }, releases), /didn't issue this server's client certificate/);
  assert.throws(() => confidentialHostFromEnv({ ...env, CONFIDENTIAL_HOST_KMS_KEY: KEY_ARN, CONFIDENTIAL_HOST_CLIENT_CA: join(dir, "missing.crt") }, releases), /CONFIDENTIAL_HOST_CLIENT_CA can't be used/);
  assert.equal(confidentialHostFromEnv({ ...env, CONFIDENTIAL_HOST_KMS_KEY: KEY_ARN, CONFIDENTIAL_HOST_CLIENT_CA: join(dir, "ca.crt") }, releases).kind, "aws-nitro");
});

// ---- releases that announce PCRs ----

test("releases announce an enclave's three PCRs: checked, MACed, in effect on the same clock as digests", async () => {
  const { db, pg } = openDb();
  const store = await Store.open(db, CATALOG);
  let clock = Date.UTC(2026, 10, 24, 12);
  const releases = await ConfidentialReleases.open(db, () => new Date(clock));
  const { user: admin } = await store.createUser("Ada", ["admin"]);
  const first = await releases.announce(store, admin, { ...PCRS, release: "v1", reason: "first enclave build" });
  assert.deepEqual([first.kind, first.pcrs, first.image_digest, first.in_effect, first.valid], ["enclave-pcrs", PCRS, null, true, true]);
  assert.deepEqual(await releases.pcrsInEffect(), [PCRS]);
  assert.deepEqual(await releases.inEffect(), [], "an enclave release is no container digest");
  const next = { pcr0: "b0".repeat(48), pcr1: PCRS.pcr1, pcr2: "b2".repeat(48) };
  const second = await releases.announce(store, admin, { ...next, release: "v2", reason: "fix" });
  assert.equal(second.in_effect, false);
  clock += 48 * 3_600_000;
  assert.deepEqual(await releases.pcrsInEffect(), [next, PCRS]);
  await assert.rejects(releases.announce(store, admin, { ...PCRS, release: "again", reason: "x" }), /already announced/);
  await assert.rejects(releases.announce(store, admin, { pcr0: PCRS.pcr0, release: "x", reason: "x" }), /96 lowercase hex/);
  await assert.rejects(releases.announce(store, admin, { ...PCRS, pcr0: "00".repeat(48), release: "x", reason: "x" }), /debug mode/);
  await assert.rejects(releases.announce(store, admin, { ...PCRS, image_digest: `sha256:${"11".repeat(32)}`, release: "x", reason: "x" }), /either/);
  await assert.rejects(releases.announce(store, admin, { release: "x", reason: "x" }), /either/);
  // A PCR changed in the database: the MAC no longer matches, so it's never in effect.
  await pg.query(`UPDATE financial_products.confidential_releases SET pcrs = $1 WHERE id = $2`, [JSON.stringify({ ...PCRS, pcr2: "ee".repeat(48) }), first.id]);
  const planted = (await releases.list()).find((r) => r.id === first.id);
  assert.deepEqual([planted.valid, planted.in_effect], [false, false]);
  assert.deepEqual(await releases.pcrsInEffect(), [next]);
  await store.close();
});

// ---- the partner's own check ----

test("verify-mynt-enclave: an enclave's document passes for the published PCRs and fails for any other", async () => {
  const d = await doc();
  const dir = mkdtempSync(join(tmpdir(), "verify-nitro-"));
  writeFileSync(join(dir, "attestation.json"), JSON.stringify({ host: "aws-nitro", format: "nitro-cose", token: d, nonce, keys, releases: [{ image_digest: null, pcrs: PCRS, release: "test", effective_at: new Date().toISOString(), in_effect: true }] }));
  writeFileSync(join(dir, "root.pem"), chain.rootPem);
  const run = (pcrs, extra = []) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/verify-mynt-enclave.mjs", import.meta.url)), "--expected-pcr0", pcrs.pcr0, "--expected-pcr1", pcrs.pcr1, "--expected-pcr2", pcrs.pcr2, "--attestation-file", join(dir, "attestation.json"), "--nonce", nonce, "--test-root-file", join(dir, "root.pem"), ...extra],
      { encoding: "utf8" },
    );
  const custody = ["--expected-kms-key", KEY_ARN, "--expected-client-ca-sha256", CA_SHA256];
  const ok = run(PCRS, custody);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.pcrs, out.kms_key, out.client_ca_sha256, out.ingest_public_key, out.health_attester_key, out.notes], [PCRS, KEY_ARN, CA_SHA256, "ingest", "attester", []]);
  // The wrap key and the client authority are required: the script stops before it checks anything without them.
  const noKey = run(PCRS, ["--expected-client-ca-sha256", CA_SHA256]);
  assert.equal(noKey.status, 2);
  assert.match(noKey.stderr, /--expected-kms-key is required/);
  const noCa = run(PCRS, ["--expected-kms-key", KEY_ARN]);
  assert.equal(noCa.status, 2);
  assert.match(noCa.stderr, /--expected-client-ca-sha256 is required/);
  assert.equal(run(PCRS, ["--expected-kms-key", "not-an-arn", "--expected-client-ca-sha256", CA_SHA256]).status, 2);
  // Another key, or another authority, than the ones Mynt published: fails.
  const otherKey = run(PCRS, ["--expected-kms-key", KEY_ARN.replace("1234abcd", "9999abcd"), "--expected-client-ca-sha256", CA_SHA256]);
  assert.equal(otherKey.status, 1);
  assert.match(otherKey.stdout, /wrapped by/);
  const otherCa = run(PCRS, ["--expected-kms-key", KEY_ARN, "--expected-client-ca-sha256", "e".repeat(64)]);
  assert.equal(otherCa.status, 1);
  assert.match(otherCa.stdout, /accepts client certificates from the authority/);
  const wrong = run({ ...PCRS, pcr1: "cc".repeat(48) }, custody);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /aren't one announced/);
  assert.match(wrong.stdout, /hasn't announced these PCRs/);
  // Without the test authority, the pinned AWS root: a test document fails.
  const real = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-mynt-enclave.mjs", import.meta.url)), "--expected-pcr0", PCRS.pcr0, "--expected-pcr1", PCRS.pcr1, "--expected-pcr2", PCRS.pcr2, "--attestation-file", join(dir, "attestation.json"), "--nonce", nonce, ...custody], { encoding: "utf8" });
  assert.equal(real.status, 1);
  assert.match(real.stdout, /AWS Nitro Enclaves root/);
});

// ---- the deployment files ----

const AWS_DIR = `${KEYHOUSE}aws/`;
test("the CloudFormation template's key policy is the documented one: used only with an attested PCR0, never re-encrypted", () => {
  const cfn = JSON.parse(readFileSync(`${AWS_DIR}keyhouse.cloudformation.json`, "utf8"));
  const manual = JSON.parse(readFileSync(`${AWS_DIR}key-policy.json`, "utf8"));
  const statements = cfn.Resources.WrapKey.Properties.KeyPolicy.Statement;
  assert.deepEqual(statements.map((s) => s.Sid), manual.Statement.map((s) => s.Sid));
  for (const [i, s] of statements.entries()) {
    assert.equal(s.Effect, manual.Statement[i].Effect, s.Sid);
    assert.deepEqual(s.Action, manual.Statement[i].Action, s.Sid);
    assert.deepEqual(Object.keys(s.Condition ?? {}), Object.keys(manual.Statement[i].Condition ?? {}), s.Sid);
  }
  const [admin, breakGlass, nobodyElse, use, deny, noReencrypt] = statements;
  assert.deepEqual(statements.map((s) => s.Sid), ["AccountManagesButDoesNotUse", "BreakGlassChangesThePolicy", "NobodyElseChangesThePolicy", "EnclaveUsesWithAttestation", "NobodyUsesWithoutAttestation", "NobodyReEncrypts"]);
  assert.ok(!admin.Action.some((a) => /Decrypt|GenerateDataKey|ReEncrypt|kms:\*|Encrypt/.test(a)), "the account manages the key but can't use it");
  // The account can't rewrite the policy (which is what decides which image may use the key): only one named
  // break-glass role can, everyone else is denied outright, and that role can't use the key either.
  assert.ok(!admin.Action.some((a) => /PutKeyPolicy|kms:Put\*|kms:\*/.test(a)), "the account can't change the key's policy");
  assert.deepEqual(breakGlass.Principal, { AWS: { Ref: "KeyPolicyAdminRoleArn" } });
  assert.deepEqual([breakGlass.Effect, breakGlass.Action], ["Allow", ["kms:PutKeyPolicy", "kms:GetKeyPolicy", "kms:DescribeKey"]]);
  assert.deepEqual([nobodyElse.Effect, nobodyElse.Principal, nobodyElse.Action], ["Deny", { AWS: "*" }, ["kms:PutKeyPolicy"]]);
  assert.deepEqual(nobodyElse.Condition, { ArnNotEquals: { "aws:PrincipalArn": { Ref: "KeyPolicyAdminRoleArn" } } });
  for (const s of statements.filter((x) => x.Effect === "Allow")) assert.equal(s.Action.includes("kms:PutKeyPolicy"), s === breakGlass, s.Sid);
  assert.equal(cfn.Resources.WrapKey.Properties.BypassPolicyLockoutSafetyCheck, true, "or KMS refuses a policy its creator can't change");
  assert.match(cfn.Parameters.KeyPolicyAdminRoleArn.AllowedPattern, /role/);
  assert.equal(cfn.Parameters.KeyPolicyAdminRoleArn.Default, undefined, "no default: the operator names the role");
  // The alarm: any change to the key's policy (or disabling, deleting or granting it) reaches a person, through a
  // rule on the key's own CloudTrail events, a CloudWatch alarm on that rule, and a trail for them to come from.
  const rule = cfn.Resources.WrapKeyChangeRule.Properties;
  assert.deepEqual(rule.EventPattern.detail.resources, { ARN: [{ "Fn::GetAtt": ["WrapKey", "Arn"] }] });
  assert.ok(["PutKeyPolicy", "ScheduleKeyDeletion", "DisableKey", "CreateGrant"].every((n) => rule.EventPattern.detail.eventName.includes(n)));
  assert.deepEqual(rule.Targets.map((t) => t.Arn), [{ Ref: "AlarmTopic" }]);
  const alarm = cfn.Resources.WrapKeyChangeAlarm.Properties;
  assert.deepEqual([alarm.Namespace, alarm.MetricName, alarm.Dimensions, alarm.Threshold, alarm.AlarmActions], ["AWS/Events", "MatchedEvents", [{ Name: "RuleName", Value: { Ref: "WrapKeyChangeRule" } }], 1, [{ Ref: "AlarmTopic" }]]);
  assert.deepEqual(cfn.Resources.AlarmTopic.Properties.Subscription, [{ Protocol: "email", Endpoint: { Ref: "AlarmEmail" } }]);
  assert.ok(cfn.Resources.AlarmTopicPolicy.Properties.PolicyDocument.Statement.some((s) => s.Principal.Service === "events.amazonaws.com" && s.Action === "sns:Publish"));
  assert.equal(cfn.Parameters.AlarmEmail.Default, undefined);
  assert.deepEqual([cfn.Resources.AuditTrail.Condition, cfn.Resources.AuditTrail.Properties.IsLogging, cfn.Parameters.CreateAuditTrail.Default], ["AuditTrail", true, "true"]);
  assert.deepEqual(cfn.Resources.AuditTrail.Properties.EventSelectors, [{ ReadWriteType: "WriteOnly", IncludeManagementEvents: true }]);
  // Every Ref and GetAtt in the template names something it defines (a typo here only shows when a stack is made).
  const defined = new Set([...Object.keys(cfn.Parameters), ...Object.keys(cfn.Resources), "AWS::AccountId", "AWS::Region", "AWS::Partition", "AWS::NoValue"]);
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    if (typeof v.Ref === "string") assert.ok(defined.has(v.Ref), `Ref ${v.Ref}`);
    if (Array.isArray(v["Fn::GetAtt"])) assert.ok(defined.has(v["Fn::GetAtt"][0]), `GetAtt ${v["Fn::GetAtt"][0]}`);
    if (typeof v.Condition === "string" && v.Type) assert.ok(Object.hasOwn(cfn.Conditions, v.Condition), `Condition ${v.Condition}`);
    for (const d of [].concat(v.DependsOn ?? [])) if (v.Type) assert.ok(defined.has(d), `DependsOn ${d}`);
    Object.values(v).forEach(walk);
  };
  walk(cfn.Resources);
  walk(cfn.Outputs);
  // No account, address or host of anyone's is written into either file.
  for (const f of ["keyhouse.cloudformation.json", "key-policy.json"]) assert.doesNotMatch(readFileSync(`${AWS_DIR}${f}`, "utf8"), /\d{12}(?!\})|@[a-z0-9-]+\.[a-z]{2,}/, f);
  assert.deepEqual(use.Condition, { StringEqualsIgnoreCase: { "kms:RecipientAttestation:ImageSha384": { Ref: "AllowedPcr0s" } } });
  assert.deepEqual(deny.Principal, { AWS: "*" });
  assert.deepEqual(deny.Condition, { StringNotEqualsIgnoreCase: { "kms:RecipientAttestation:ImageSha384": { Ref: "AllowedPcr0s" } } });
  assert.ok(["kms:Decrypt", "kms:GenerateDataKey"].every((a) => deny.Action.includes(a)));
  assert.ok(["kms:ReEncryptFrom", "kms:CreateGrant"].every((a) => noReencrypt.Action.includes(a)) && !noReencrypt.Condition);
  // The instance: enclaves on, IMDSv2 only, only Mynt's server on 8443, and nothing but the wrap key for its role.
  const lt = cfn.Resources.LaunchTemplate.Properties.LaunchTemplateData;
  assert.deepEqual(lt.EnclaveOptions, { Enabled: true });
  assert.equal(lt.MetadataOptions.HttpTokens, "required");
  assert.deepEqual(cfn.Resources.SecurityGroup.Properties.SecurityGroupIngress.map((r) => [r.FromPort, r.CidrIp]), [[8443, { Ref: "MyntServerAddress" }]]);
  assert.deepEqual(cfn.Resources.InstanceRoleKmsPolicy.Properties.PolicyDocument.Statement, [{ Effect: "Allow", Action: ["kms:Decrypt", "kms:GenerateDataKey"], Resource: { "Fn::GetAtt": ["WrapKey", "Arn"] } }]);
  assert.match(lt.UserData["Fn::Base64"]["Fn::Sub"][0], /deploy\/confidential\/aws\/parent-setup\.sh/);
  // Templates and examples are JSON here, never YAML.
  assert.deepEqual(readdirSync(AWS_DIR).filter((f) => /\.ya?ml$/.test(f)), []);
});

test("the parent's setup builds the release's commit, refuses a PCR0 the policy doesn't allow, and runs every relay", () => {
  const setup = readFileSync(`${AWS_DIR}parent-setup.sh`, "utf8");
  assert.equal(spawnSync("bash", ["-n", `${AWS_DIR}parent-setup.sh`]).status, 0);
  assert.equal(spawnSync("bash", ["-n", `${AWS_DIR}build-eif.sh`]).status, 0);
  assert.match(setup, /build-eif\.sh/);
  // One authority only reaches the enclave's settings, and its SHA-256 is printed for the operator to compare.
  assert.match(setup, /exactly one base64 PEM certificate/);
  assert.match(setup, /CLIENT_CA_SHA256/);
  const made = readFileSync(`${KEYHOUSE}make-client-cert.sh`, "utf8");
  assert.equal(spawnSync("bash", ["-n", `${KEYHOUSE}make-client-cert.sh`]).status, 0);
  assert.match(made, /CONFIDENTIAL_HOST_CLIENT_CA/);
  assert.match(made, /sha256sum/);
  assert.match(setup, /isn't one the key policy allows/);
  for (const relay of ["TCP-LISTEN:8443", "vsock-proxy 8000 kms.", "VSOCK-LISTEN:8001", "VSOCK-LISTEN:8002", "VSOCK-LISTEN:8003"]) assert.ok(setup.includes(relay), relay);
  // The enclave helper's ports are the same ones.
  const io = readFileSync(`${KEYHOUSE}enclave-io/main.go`, "utf8");
  for (const [name, port] of [["portInbound", 8443], ["portKMS", 8000], ["portIMDS", 8001], ["portConfig", 8002], ["portLogs", 8003]]) assert.match(io, new RegExp(`${name}\\s+= ${port}`));
  // nitro-cli is pinned to one release in both places (its kernel and boot ramdisk are part of PCR0 and PCR1).
  const pin = (f) => /NITRO_CLI_VERSION="?([\d.]+)"?/.exec(readFileSync(`${AWS_DIR}${f}`, "utf8"))[1];
  assert.equal(pin("parent-setup.sh"), pin("build-eif.sh"));
});

// ---- booting with no vault key on the server (last: it releases the vault's keys into this process) ----

test("a server set to the enclave boots with no MYNT_VAULT_KEY: the release record is authenticated before the vault is released, and fails closed", async () => {
  const { db, pg } = openDb();
  const store = await Store.open(db, CATALOG);
  const kms = fakeNitroKms();
  const inside = await enclave({ kms });
  const relay = await parent({ path: inside.path });
  const url = `https://127.0.0.1:${relay.address().port}`;
  const m = enclave.client;
  const dir = mkdtempSync(join(tmpdir(), "boot-"));
  writeFileSync(join(dir, "client.key"), m.key);
  writeFileSync(join(dir, "other.key"), clientMaterial("mynt-core").key);
  // The server's settings, as the migration leaves them. Only the release record's keys are read from here; the host
  // is made directly so the test authority can stand in for AWS's root.
  const env = { CONFIDENTIAL_HOST: "aws-nitro", CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "client.key") };
  const boot = async (e = env) => {
    const releases = await ConfidentialReleases.open(db, () => new Date(), () => releaseMacKeysFromEnv(e));
    const host = new NitroEnclaveHost({ url, clientCert: m.cert, clientKey: m.key, allowedPcrs: () => releases.pcrsInEffect(), expectedKmsKey: KEY_ARN, expectedClientCaSha256: CLIENT_CA_SHA256, roots: [chain.rootPem], wrappedRoot: () => storedWrappedRoot(db, "aws-nitro") });
    return { releases, host };
  };
  const VAULT_KEY = process.env.MYNT_VAULT_KEY;
  try {
    // The migration, with MYNT_VAULT_KEY still on the server: announce the build, make the root, adopt the vault.
    const { user: admin } = await store.createUser("Ada", ["admin"]);
    const first = await boot();
    const announced = await first.releases.announce(store, admin, { ...PCRS, release: "v1", reason: "first enclave build" });
    assert.equal(announced.in_effect, true);
    assert.match((await pg.query(`SELECT mac FROM financial_products.confidential_releases`)).rows[0].mac, /^v2c:[0-9a-f]{64}$/, "MACed under a key from the server's client key, not the vault");
    await initialiseHost(db, first.host);
    assert.deepEqual(await adoptVault(db, first.host), { adopted: true, host: "aws-nitro" });
    const derivedBefore = vault.derivedKey("product-health-subject");

    // MYNT_VAULT_KEY is removed, as the migration says, and the server restarts: nothing vault-derived exists yet.
    delete process.env.MYNT_VAULT_KEY;
    assert.equal(vault.vaultKeysReleased(), false);
    assert.equal(vault.derivedKey("confidential-releases"), null);
    assert.equal(releaseMacKeysFromEnv(env).vault, null);

    // Fail closed, each before anything is released:
    // 1. the release record as it was first authenticated (a vault-derived key only): no key, no release in effect.
    const vaultOnly = () => ({ scheme: "v", current: vault.derivedKey("confidential-releases"), vault: vault.derivedKey("confidential-releases"), previous: null });
    const old = await ConfidentialReleases.open(db, () => new Date(), vaultOnly);
    assert.deepEqual(await old.pcrsInEffect(), []);
    // 2. another client key on the server, or none readable: the rows don't authenticate.
    for (const e of [{ ...env, CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "other.key") }, { ...env, CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "missing.key") }, { CONFIDENTIAL_HOST: "aws-nitro" }]) {
      const b = await boot(e);
      assert.deepEqual(await b.releases.pcrsInEffect(), []);
      await assert.rejects(bootVault(db, b.host), /aren't one announced/);
      // With no client key to authenticate it with, nothing can be announced either.
      if (!e.CONFIDENTIAL_HOST_CLIENT_KEY?.endsWith("other.key")) await assert.rejects(b.releases.announce(store, admin, { pcr0: "b0".repeat(48), pcr1: "b1".repeat(48), pcr2: "b2".repeat(48), release: "x", reason: "x" }), /client key/);
    }
    // 3. a build planted in the database (a row copied from the real one, with other PCRs): never in effect.
    const real = (await pg.query(`SELECT * FROM financial_products.confidential_releases`)).rows[0];
    const plantedPcrs = { pcr0: "e0".repeat(48), pcr1: "e1".repeat(48), pcr2: "e2".repeat(48) };
    await pg.query(`INSERT INTO financial_products.confidential_releases (id, pcrs, release, reason, effective_at, mac) VALUES ($1, $2, 'evil', 'x', $3, $4)`, [crypto.randomUUID(), JSON.stringify(plantedPcrs), real.effective_at, real.mac]);
    assert.deepEqual(await (await boot()).releases.pcrsInEffect(), [PCRS]);
    assert.equal(vault.vaultKeysReleased(), false, "nothing was released by any of that");

    // The boot itself: the rows authenticate with the client key, the enclave is attested against them, and it
    // releases the vault's keys into this process. No vault key was on the server at any point of it.
    const second = await boot();
    assert.deepEqual(await second.releases.pcrsInEffect(), [PCRS]);
    assert.equal(await bootVault(db, second.host), true);
    assert.equal(vault.vaultKeysReleased(), true);
    assert.equal(process.env.MYNT_VAULT_KEY, undefined);
    assert.deepEqual(vault.derivedKey("product-health-subject"), derivedBefore, "the keys derived from the vault are what they were");
    assert.match(vault.seal("a new value", false), /^v2:/);
    assert.match(await second.host.seal("secret", Buffer.from("x"), "ANTHROPIC_API_KEY"), /^cs2:ne:secret:/);
    // Once the server has had its vault released by a host, no announcement is ever "the first" again, even with the
    // release table and everything else that records one emptied.
    await pg.query(`DELETE FROM financial_products.confidential_releases`);
    await pg.query(`DELETE FROM financial_products.audit_log`);
    await pg.query(`DELETE FROM financial_products.confidential_keys`);
    const later = await second.releases.announce(store, admin, { pcr0: "b0".repeat(48), pcr1: "b1".repeat(48), pcr2: "b2".repeat(48), release: "v2", reason: "after the table was emptied" });
    assert.equal(later.in_effect, false);
  } finally {
    process.env.MYNT_VAULT_KEY = VAULT_KEY;
    inside.server.close();
    relay.close();
    await store.close();
  }
});

test("rows announced before the release record moved to the client key: authenticated again while the vault key is at hand, refused without it", async () => {
  // (The vault's keys are released in this process by now, so the vault-derived key is at hand, as on a running server.)
  const { db, pg } = openDb();
  const store = await Store.open(db, CATALOG);
  const dir = mkdtempSync(join(tmpdir(), "remac-"));
  writeFileSync(join(dir, "client.key"), enclave.client.key);
  writeFileSync(join(dir, "new.key"), clientMaterial("mynt-core").key);
  const env = { CONFIDENTIAL_HOST: "aws-nitro", CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "client.key") };
  const now = () => new Date(Date.UTC(2026, 10, 24, 12));
  await ConfidentialReleases.open(db, now);
  const id = crypto.randomUUID();
  const effective = new Date(Date.UTC(2026, 10, 24, 11)).toISOString();
  const measured = `pcrs:${PCRS.pcr0},${PCRS.pcr1},${PCRS.pcr2}`;
  const v1 = createHmac("sha256", vault.derivedKey("confidential-releases")).update(`${id}\u0000${measured}\u0000v0\u0000${effective}`).digest("hex");
  await pg.query(`INSERT INTO financial_products.confidential_releases (id, pcrs, release, reason, effective_at, mac) VALUES ($1, $2, 'v0', 'from before', $3, $4)`, [id, JSON.stringify(PCRS), effective, v1]);
  const macNow = async () => (await pg.query(`SELECT mac FROM financial_products.confidential_releases WHERE id = $1`, [id])).rows[0].mac;
  // Without the vault-derived key (a server that never ran with it after the change): not in effect, row untouched.
  const noVault = await ConfidentialReleases.open(db, now, () => ({ ...releaseMacKeysFromEnv(env), vault: null }));
  assert.deepEqual(await noVault.pcrsInEffect(), []);
  assert.equal(await macNow(), v1);
  // With it at hand once (any start during the migration): in effect, and re-MACed under the client key...
  const withVault = await ConfidentialReleases.open(db, now, () => releaseMacKeysFromEnv(env));
  assert.deepEqual(await withVault.pcrsInEffect(), [PCRS]);
  const moved = await macNow();
  assert.match(moved, /^v2c:/);
  // ...so from then on it authenticates with no vault key at all.
  assert.deepEqual(await (await ConfidentialReleases.open(db, now, () => ({ ...releaseMacKeysFromEnv(env), vault: null }))).pcrsInEffect(), [PCRS]);
  // The client certificate is replaced: nothing authenticates under the new key alone, until the old key's path is
  // named for one start (CONFIDENTIAL_HOST_PREVIOUS_CLIENT_KEY), which moves the rows to the new key.
  const rotated = { CONFIDENTIAL_HOST: "aws-nitro", CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "new.key") };
  assert.deepEqual(await (await ConfidentialReleases.open(db, now, () => ({ ...releaseMacKeysFromEnv(rotated), vault: null }))).pcrsInEffect(), []);
  assert.equal(await macNow(), moved);
  const carried = await ConfidentialReleases.open(db, now, () => ({ ...releaseMacKeysFromEnv({ ...rotated, CONFIDENTIAL_HOST_PREVIOUS_CLIENT_KEY: join(dir, "client.key") }), vault: null }));
  assert.deepEqual(await carried.pcrsInEffect(), [PCRS]);
  assert.notEqual(await macNow(), moved);
  assert.deepEqual(await (await ConfidentialReleases.open(db, now, () => ({ ...releaseMacKeysFromEnv(rotated), vault: null }))).pcrsInEffect(), [PCRS]);
  await store.close();
});
