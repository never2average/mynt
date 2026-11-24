import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign as edSign, verify } from "node:crypto";
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
const { PURPOSES, ConfidentialRefused } = await import("../dist/confidential/host.js");
const { adoptVault, bootVault, confidentialHostFromEnv, rewrapVault, ConfidentialReleases } = await import("../dist/confidential/index.js");
const { verifyAttestationToken } = await import("../dist/confidential/attestation-verify.js");
const { keysNonce, ATTESTATION_AUDIENCE } = await import("../dist/confidential/shared/binding.js");
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
  assert.match(docker, /^FROM [^\s]+@sha256:[0-9a-f]{64}$/m);
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
  const s = await host.sign({ name: "health-attester" }, msg);
  assert.equal(s.public_key, await host.publicKey("health-attester"));
  assert.ok(verify(null, msg, edPub(s.public_key), Buffer.from(s.signature, "hex")));
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
});

// ---- checking an attestation ----

test("an attestation token passes only with its signature, a production confidential OS, debugging off, the digest, the nonce and the key binding", async () => {
  const keys = { schema: "mynt.enclave_keys.v1", tls_spki_sha256: "00", ingest_public_key: "abc", signing: { "health-attester": "def" } };
  const nonce = "partner-nonce-123456";
  const check = async (launcher, o = {}) => {
    const token = await launcher.token({ audience: ATTESTATION_AUDIENCE, nonces: o.nonces ?? [nonce, keysNonce(keys)] });
    return verifyAttestationToken(o.mangle ? o.mangle(token) : token, { jwks: (o.jwksFrom ?? launcher).jwks, audience: ATTESTATION_AUDIENCE, nonce, keys: o.keys ?? keys, allowedDigests: o.digests ?? [IMAGE_DIGEST] });
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
});

// ---- the confidential-VM adapter, against the real service code ----

async function service({ launcher = fakeLauncher(), spkiOverride = null } = {}) {
  const kms = fakeKms();
  const tls = selfSignedEd25519("mynt-keyhouse");
  const base = { kms, launcher, wrapKey: "projects/p/cryptoKeys/root", signingKeys: { "health-attester": "projects/p/cryptoKeys/a/cryptoKeyVersions/1" }, tlsSpki: spkiOverride ?? tls.spki, policy: loadPolicy() };
  const { wrapped_root } = await (await createKeyhouse(base)).handle("POST", "/v1/init", "mynt-core", {});
  const kh = await createKeyhouse({ ...base, wrappedRoot: wrapped_root });
  const m = clientMaterial("mynt-core");
  const server = await startKeyhouseServer(kh, { cert: tls.cert, key: tls.key, ca: m.ca, port: 0, host: "127.0.0.1", log: () => {} });
  const url = `https://127.0.0.1:${server.address().port}`;
  const host = (o = {}) => new ConfidentialSpaceHost({ url, clientCert: m.cert, clientKey: m.key, allowedDigests: async () => [IMAGE_DIGEST], jwks: async () => launcher.jwks, ...o });
  return { server, url, m, host, launcher, kms };
}

test("over attested, mutually authenticated TLS: seal, unseal, sign, attest, compute and the vault's keys", async () => {
  const s = await service();
  try {
    const host = s.host();
    const sealed = await host.seal("secret", Buffer.from("provider-api-key"));
    assert.match(sealed, /^cs1:cs:secret:/);
    assert.equal((await host.unseal("secret", sealed)).toString(), "provider-api-key");
    await assert.rejects(host.unseal("partner-ledger", sealed), ConfidentialRefused);
    const msg = randomBytes(16);
    const sig = await host.sign({ name: "health-attester" }, msg);
    assert.ok(verify(null, msg, edPub(sig.public_key), Buffer.from(sig.signature, "hex")));
    await assert.rejects(host.sign({ name: "anything-else" }, msg), ConfidentialRefused);
    const m = await host.measurements();
    assert.deepEqual([m.attested, m.image_digest, m.debug], [true, IMAGE_DIGEST, false]);
    const a = await host.attest("partner-nonce-abcdef");
    assert.equal(a.format, "oidc-jwt");
    assert.ok(verifyAttestationToken(a.token, { jwks: s.launcher.jwks, audience: ATTESTATION_AUDIENCE, nonce: "partner-nonce-abcdef", keys: a.keys, allowedDigests: [IMAGE_DIGEST] }).ok);
    const now = new Date().toISOString();
    const { statement, address } = partnerStatement("firm-1", "p1", now);
    const r = await host.computeHealth(healthInput(sealStatement(statement, a.keys.ingest_public_key, { provider_entity_id: "firm-1", environment: "live", request_id: "req-1" }), address, now));
    assert.equal(r.report.figures.reserves_cents.value, 150_00);
    assert.equal(r.attestation.public_key, a.keys.signing["health-attester"]);
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
    const run = (digest, n = nonce) =>
      spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/verify-mynt-enclave.mjs", import.meta.url)), "--expected-digest", digest, "--attestation-file", join(dir, "attestation.json"), "--nonce", n, "--jwks-file", join(dir, "jwks.json")], { encoding: "utf8" });
    const ok = run(IMAGE_DIGEST);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const out = JSON.parse(ok.stdout);
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
