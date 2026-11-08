import { test } from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { randomBytes, verify, createPublicKey } from "node:crypto";
import { apiKeyPair, fakeTurnkey } from "./fake-turnkey.js";

const { TurnkeyClient, turnkeyFromEnv, TURNKEY_API } = await import("../dist/solana/custody/turnkey.js");
const { CustodyServiceSigner, verifyEd25519 } = await import("../dist/solana/signer.js");
const { compileMessage, system } = await import("../dist/solana/tx.js");
const { Keypair, base58Encode, base58Decode } = await import("../dist/solana/codec.js");

// A client of the fake Turnkey: loopback over plain HTTP is a test-only outbound option.
const clientFor = (tk, o = {}) =>
  new TurnkeyClient({
    organizationId: tk.organizationId,
    apiPublicKey: tk.apiKey.publicKey,
    apiPrivateKey: tk.apiKey.privateKey,
    baseUrl: tk.baseUrl,
    outbound: { allowInsecureLoopback: true, timeoutMs: 2000 },
    pollMs: 0,
    ...o,
  });

// A deploy-shaped message the custody address pays for, with a second signer (a new account's keypair).
const message = (payer, other = Keypair.generate()) =>
  compileMessage(payer, [system.createAccount(payer, other.address, 1_000_000, 36, "BPFLoaderUpgradeab1e11111111111111111111111")], base58Encode(randomBytes(32)));

const edKey = (address) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(base58Decode(address)).toString("base64url") }, format: "jwk" });

// Every way the API private key could be written down, for leak checks.
const secretForms = (hex) => [hex, hex.toUpperCase(), Buffer.from(hex, "hex").toString("base64"), Buffer.from(hex, "hex").toString("base64url"), hex.slice(8, 40)];

test("turnkey: signs through a stamped sign_transaction activity, and the signature verifies for the custody address", async () => {
  const tk = await fakeTurnkey();
  try {
    const client = clientFor(tk);
    assert.equal(client.problem, null);
    const m = message(tk.address);
    const sig = await client.signSolanaMessage(tk.address, m.bytes);
    assert.equal(sig.length, 64);
    assert.ok(verify(null, m.bytes, edKey(tk.address), sig), "a real ed25519 signature by the wallet account");
    assert.equal(tk.refusedStamps, 0, "every stamp verified");
    const [req] = tk.requests;
    assert.equal(req.path, "/public/v1/submit/sign_transaction");
    const body = JSON.parse(req.raw);
    assert.equal(body.type, "ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
    assert.equal(body.organizationId, tk.organizationId);
    assert.equal(body.parameters.signWith, tk.address);
    assert.equal(body.parameters.type, "TRANSACTION_TYPE_SOLANA");
    // The unsigned transaction is the message behind two zeroed signature slots, hex encoded.
    assert.equal(body.parameters.unsignedTransaction, Buffer.concat([Buffer.from([2]), Buffer.alloc(128), Buffer.from(m.bytes)]).toString("hex"));
    const stamp = JSON.parse(Buffer.from(req.headers["x-stamp"], "base64url").toString());
    assert.deepEqual(Object.keys(stamp).sort(), ["publicKey", "scheme", "signature"]);
    assert.equal(stamp.publicKey, tk.apiKey.publicKey);

    // Through the signer interface too, which checks the signature again.
    const signer = new CustodyServiceSigner(tk.address, client);
    assert.ok(verifyEd25519(tk.address, m.bytes, await signer.sign(m.bytes)));
  } finally {
    await tk.close();
  }
});

test("turnkey: a stamp from the wrong API key is refused by Turnkey, and the client says so without the key", async () => {
  const tk = await fakeTurnkey();
  try {
    const wrong = apiKeyPair();
    const client = clientFor(tk, { apiPublicKey: wrong.publicKey, apiPrivateKey: wrong.privateKey });
    await assert.rejects(client.signSolanaMessage(tk.address, message(tk.address).bytes), (e) => {
      assert.match(e.message, /Turnkey request failed \(http 401\): could not verify api key signature/);
      for (const s of secretForms(wrong.privateKey)) assert.ok(!e.message.includes(s));
      return true;
    });
    assert.equal(tk.refusedStamps, 1);
  } finally {
    await tk.close();
  }
});

test("turnkey: an activity waiting for approvals is polled until it completes, or given up on", async () => {
  const tk = await fakeTurnkey();
  try {
    tk.mode = "consensus";
    const m = message(tk.address);
    const sig = await clientFor(tk).signSolanaMessage(tk.address, m.bytes);
    assert.ok(verifyEd25519(tk.address, m.bytes, sig));
    assert.deepEqual(tk.requests.map((r) => r.path), ["/public/v1/submit/sign_transaction", "/public/v1/query/get_activity", "/public/v1/query/get_activity"]);
    await assert.rejects(clientFor(tk, { approvalTimeoutMs: 0, pollMs: 5 }).signSolanaMessage(tk.address, m.bytes), /still ACTIVITY_STATUS_CONSENSUS_NEEDED .*nothing was signed/);
    tk.mode = "reject";
    await assert.rejects(clientFor(tk).signSolanaMessage(tk.address, m.bytes), /Turnkey refused to sign \(ACTIVITY_STATUS_REJECTED: policy denied\)/);
  } finally {
    await tk.close();
  }
});

test("turnkey: a bad signature, another key's signature, a changed transaction or the wrong address is never used", async () => {
  const tk = await fakeTurnkey();
  try {
    const client = clientFor(tk);
    const m = message(tk.address);
    tk.mode = "bad-signature";
    await assert.rejects(client.signSolanaMessage(tk.address, m.bytes), /doesn't verify for .* it wasn't used/);
    tk.mode = "other-key";
    await assert.rejects(client.signSolanaMessage(tk.address, m.bytes), /doesn't verify/);
    tk.mode = "tamper";
    await assert.rejects(client.signSolanaMessage(tk.address, m.bytes), /isn't the transaction Mynt sent/);
    tk.mode = "sign";
    // An address Turnkey doesn't hold: Turnkey refuses it.
    const stranger = Keypair.generate().address;
    await assert.rejects(client.signSolanaMessage(stranger, message(stranger).bytes), /http 404/);
    // A transaction the custody address doesn't sign: refused before anything is sent.
    const before = tk.requests.length;
    await assert.rejects(client.signSolanaMessage(tk.address, message(Keypair.generate().address).bytes), /doesn't need the custody address's signature/);
    assert.equal(tk.requests.length, before);

    // The signer refuses any client's signature that isn't the configured address's, over this message.
    const liar = { provider: "turnkey", signSolanaMessage: async () => Keypair.generate().sign(m.bytes) };
    await assert.rejects(new CustodyServiceSigner(tk.address, liar).sign(m.bytes), /doesn't verify for/);
    const wrongAddress = new CustodyServiceSigner(Keypair.generate().address, client);
    await assert.rejects(wrongAddress.sign(m.bytes), /doesn't need the custody address's signature/);
  } finally {
    await tk.close();
  }
});

test("turnkey: configuration is by name, checked, and the private key never shows in errors, logs or serialisation", async () => {
  assert.equal(TURNKEY_API, "https://api.turnkey.com");
  assert.equal(turnkeyFromEnv({}), null, "no Turnkey variables: no custody provider");
  const key = apiKeyPair();
  const env = { TURNKEY_ORGANIZATION_ID: "5b0b2c5e-9f0a-4c3d-9a7e-0e2f4b6c8d10", TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey };
  const ok = turnkeyFromEnv(env);
  assert.equal(ok.problem, null);
  assert.equal(ok.provider, "turnkey");
  assert.match(turnkeyFromEnv({ ...env, TURNKEY_API_PRIVATE_KEY: "" }).problem, /^TURNKEY_API_PRIVATE_KEY isn't set on the server$/);
  assert.match(turnkeyFromEnv({ TURNKEY_ORGANIZATION_ID: env.TURNKEY_ORGANIZATION_ID }).problem, /TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY aren't set/);
  const other = apiKeyPair();
  const mismatched = turnkeyFromEnv({ ...env, TURNKEY_API_PRIVATE_KEY: other.privateKey });
  assert.match(mismatched.problem, /TURNKEY_API_PRIVATE_KEY doesn't belong to TURNKEY_API_PUBLIC_KEY/);
  assert.match(turnkeyFromEnv({ ...env, TURNKEY_API_PRIVATE_KEY: "not-hex" }).problem, /isn't a P-256 private key/);
  await assert.rejects(mismatched.signSolanaMessage(Keypair.generate().address, new Uint8Array(10)), /Turnkey isn't configured on this server: TURNKEY_API_PRIVATE_KEY doesn't belong/);

  // What a log line, a debugger or a status view could show of the client.
  const shown = [JSON.stringify(ok), inspect(ok, { showHidden: true, depth: 5 }), String(ok), JSON.stringify(mismatched), inspect(mismatched, { depth: 5 }), mismatched.problem];
  for (const s of [...secretForms(key.privateKey), ...secretForms(other.privateKey)]) assert.ok(!shown.join("\n").includes(s), "an API private key leaked");

  // Over the wire: only the stamp, never the key.
  const tk = await fakeTurnkey();
  try {
    const client = clientFor(tk);
    await client.signSolanaMessage(tk.address, message(tk.address).bytes);
    tk.mode = "bad-signature";
    const err = await client.signSolanaMessage(tk.address, message(tk.address).bytes).catch((e) => e);
    const wire = tk.requests.map((r) => r.raw + JSON.stringify(r.headers)).join("\n");
    for (const s of secretForms(tk.apiKey.privateKey)) {
      assert.ok(!wire.includes(s), "the API private key was sent");
      assert.ok(!err.message.includes(s) && !String(err.stack).includes(s), "the API private key is in an error");
      assert.ok(!inspect(client, { showHidden: true, depth: 5 }).includes(s));
    }
  } finally {
    await tk.close();
  }
});

test("turnkey: requests follow Mynt's outbound rules (HTTPS only, no private addresses)", async () => {
  const key = apiKeyPair();
  const base = { organizationId: "5b0b2c5e-9f0a-4c3d-9a7e-0e2f4b6c8d10", apiPublicKey: key.publicKey, apiPrivateKey: key.privateKey, pollMs: 0 };
  const payer = Keypair.generate().address;
  await assert.rejects(new TurnkeyClient({ ...base, baseUrl: "http://127.0.0.1:9" }).signSolanaMessage(payer, message(payer).bytes), /refused: HTTPS only/);
  await assert.rejects(new TurnkeyClient({ ...base, baseUrl: "https://10.0.0.1" }).signSolanaMessage(payer, message(payer).bytes), /refused: .*private/);
});
