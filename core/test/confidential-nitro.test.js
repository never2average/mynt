import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
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
const { confidentialHostFromEnv, initialiseHost, storedWrappedRoot, ConfidentialReleases } = await import("../dist/confidential/index.js");
const { keysNonce, KEYS_SCHEMA } = await import("../dist/confidential/shared/binding.js");
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
  assert.ok(readFileSync(fileURLToPath(new URL("../../docs/reference.md", import.meta.url)), "utf8").includes(DOCUMENTED_ROOT_FINGERPRINT));
});

// ---- the document check ----

const tls = selfSignedEd25519("mynt-keyhouse");
const keys = { schema: KEYS_SCHEMA, tls_spki_sha256: createHash("sha256").update(tls.spki).digest("hex"), ingest_public_key: "ingest", signing: { "health-attester": "attester" }, config: { kms_key: KEY_ARN, region: "us-east-1" } };
const nonce = "partner-nonce-0123456789";
async function doc({ nsm = fakeNsm({ chain }), fields = {} } = {}) {
  return (await nsm.attest({ nonce: Buffer.from(nonce), userData: Buffer.from(keysNonce(keys)), publicKey: tls.spki, ...fields })).toString("base64");
}
const check = (d, o = {}) => verifyNitroAttestation(d, { nonce, keys, allowedPcrs: [PCRS], expectedKmsKey: KEY_ARN, roots: [chain.rootPem], ...o });

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

// ---- the adapter, against the real service behind a fake parent instance ----

// The enclave: the real service on the Nitro platform, listening on a Unix socket as it does inside an enclave. The
// parent: a TCP relay to that socket (socat's job on a real instance).
async function enclave({ kms, nsm = fakeNsm({ chain }) }) {
  const dir = mkdtempSync(join(tmpdir(), "enclave-"));
  const t = selfSignedEd25519("mynt-keyhouse");
  const client = nitroKms({ region: "us-east-1", keyArn: KEY_ARN, nsm, credentials: fakeCredentials, post: kms.post });
  const kh = await createKeyhouse({ platform: nitroPlatform({ kms: client, nsm, region: "us-east-1", keyArn: KEY_ARN }), wrappedRoot: null, tlsSpki: t.spki, policy: loadPolicy() });
  const m = enclave.client;
  const path = join(dir, "https.sock");
  const server = await startKeyhouseServer(kh, { cert: t.cert, key: t.key, ca: m.ca, path, log: () => {} });
  return { server, path };
}
enclave.client = clientMaterial("mynt-core");

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
  const host = (o = {}) => new NitroEnclaveHost({ url, clientCert: m.cert, clientKey: m.key, allowedPcrs: async () => [PCRS], expectedKmsKey: KEY_ARN, roots: [chain.rootPem], wrappedRoot: () => storedWrappedRoot(db, "aws-nitro"), ...o });
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

    // The enclave restarts: a new TLS key, no root. The adapter re-attests the new key and hands the root back.
    inside.server.close();
    inside = await enclave({ kms });
    target.path = inside.path;
    assert.equal((await h.unseal("secret", sealed)).toString(), "provider-api-key");
    assert.equal(await h.publicKey("health-attester"), attester, "the attester is derived from the root, so it survives restarts");

    // Not announced, or wrapped by another key: refused before anything is sent.
    await assert.rejects(host({ allowedPcrs: async () => [] }).seal("secret", Buffer.from("x")), /aren't one announced/);
    await assert.rejects(host({ expectedKmsKey: KEY_ARN.replace("1234abcd", "9999abcd") }).measurements(), ConfidentialRefused);
    // A real deployment checks against AWS's root, which no test authority chains to.
    await assert.rejects(host({ roots: undefined }).measurements(), /AWS Nitro Enclaves root/);
  } finally {
    inside.server.close();
    relay.close();
    await store.close();
  }
});

test("from the environment: aws-nitro needs the URL, the client certificate and the wrap key's ARN", () => {
  const releases = { inEffect: async () => [], pcrsInEffect: async () => [] };
  assert.throws(() => confidentialHostFromEnv({ CONFIDENTIAL_HOST: "aws-nitro" }, releases), /CONFIDENTIAL_HOST_URL/);
  const dir = mkdtempSync(join(tmpdir(), "nitro-env-"));
  const m = enclave.client;
  writeFileSync(join(dir, "c.crt"), m.cert);
  writeFileSync(join(dir, "c.key"), m.key);
  const env = { CONFIDENTIAL_HOST: "aws-nitro", CONFIDENTIAL_HOST_URL: "https://203.0.113.10:8443", CONFIDENTIAL_HOST_CLIENT_CERT: join(dir, "c.crt"), CONFIDENTIAL_HOST_CLIENT_KEY: join(dir, "c.key") };
  assert.throws(() => confidentialHostFromEnv(env, releases), /CONFIDENTIAL_HOST_KMS_KEY/);
  assert.equal(confidentialHostFromEnv({ ...env, CONFIDENTIAL_HOST_KMS_KEY: KEY_ARN }, releases).kind, "aws-nitro");
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
  const ok = run(PCRS, ["--expected-kms-key", KEY_ARN]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const out = JSON.parse(ok.stdout);
  assert.deepEqual([out.pcrs, out.kms_key, out.ingest_public_key, out.health_attester_key, out.notes], [PCRS, KEY_ARN, "ingest", "attester", []]);
  const wrong = run({ ...PCRS, pcr1: "cc".repeat(48) });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stdout, /aren't one announced/);
  assert.match(wrong.stdout, /hasn't announced these PCRs/);
  // Without the test authority, the pinned AWS root: a test document fails.
  const real = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-mynt-enclave.mjs", import.meta.url)), "--expected-pcr0", PCRS.pcr0, "--expected-pcr1", PCRS.pcr1, "--expected-pcr2", PCRS.pcr2, "--attestation-file", join(dir, "attestation.json"), "--nonce", nonce], { encoding: "utf8" });
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
  const [admin, use, deny, noReencrypt] = statements;
  assert.ok(!admin.Action.some((a) => /Decrypt|GenerateDataKey|ReEncrypt|kms:\*|Encrypt/.test(a)), "the account manages the key but can't use it");
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
  assert.match(setup, /isn't one the key policy allows/);
  for (const relay of ["TCP-LISTEN:8443", "vsock-proxy 8000 kms.", "VSOCK-LISTEN:8001", "VSOCK-LISTEN:8002", "VSOCK-LISTEN:8003"]) assert.ok(setup.includes(relay), relay);
  // The enclave helper's ports are the same ones.
  const io = readFileSync(`${KEYHOUSE}enclave-io/main.go`, "utf8");
  for (const [name, port] of [["portInbound", 8443], ["portKMS", 8000], ["portIMDS", 8001], ["portConfig", 8002], ["portLogs", 8003]]) assert.match(io, new RegExp(`${name}\\s+= ${port}`));
  // nitro-cli is pinned to one release in both places (its kernel and boot ramdisk are part of PCR0 and PCR1).
  const pin = (f) => /NITRO_CLI_VERSION="?([\d.]+)"?/.exec(readFileSync(`${AWS_DIR}${f}`, "utf8"))[1];
  assert.equal(pin("parent-setup.sh"), pin("build-eif.sh"));
});
