import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// On-chain treasury pools (devnet): the deposit approval byte for byte as the treasury program checks it, the Ed25519
// instruction the program parses, an unsigned transaction whose only signer is the person's wallet, approvals only for
// a caller's own verified wallets and only within the pool's limits and pauses, mainnet refused, balances only for the
// caller's wallets, and the indexer turning the program's events into positions. The chain is a fake RPC; the
// SolanaService, vault, store and tools are the real ones.

process.env.MYNT_VAULT_KEY ??= randomBytes(32).toString("base64");

const { Store } = await import("../dist/store.js");
const { createServer } = await import("../dist/server.js");
const { SolanaService, solanaConfigFromEnv } = await import("../dist/solana/service.js");
const { GENESIS_HASH } = await import("../dist/solana/rpc.js");
const { base58Decode, base58Encode, anchorDiscriminator, findProgramAddress, Keypair } = await import("../dist/solana/codec.js");
const chain = await import("../dist/solana/treasury-chain.js");
const { TreasuryService } = await import("../dist/treasury.js");
const { LinkedAccountsService } = await import("../dist/linked-accounts.js");
const { CATALOG } = await import("./helpers.js");

const TEMPLATE = new URL("../workspaces/coding-build/templates/solana-treasury/", import.meta.url);
const closers = [];
after(() => closers.forEach((c) => c()));

const addr = (n) => base58Encode(Buffer.alloc(32, n));
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};
const i64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const key = (a) => Buffer.from(base58Decode(a));
const bool = (v) => Buffer.from([v ? 1 : 0]);
const DEVNET = Buffer.from(base58Decode(GENESIS_HASH.devnet));

// ---- the deposit approval ----

test("the deposit approval is byte for byte what the treasury program and its tests sign", () => {
  const programId = "DCw4DC1HrhApHAWMxNhrKxw7XGHWGHndAMqVFfp13bJz";
  const pool = addr(7);
  const depositor = addr(9);
  const message = Buffer.from(chain.depositApprovalMessage({ programId, cluster: DEVNET, pool, depositor, nonce: 3n, expiry: 1_700_000_600n }));
  // As tests/mynt_treasury.ts builds it: "MYNTDEP2", program id, cluster, pool, depositor, u64 nonce, i64 expiry.
  const asTheProgramTests = Buffer.concat([Buffer.from("MYNTDEP2"), key(programId), DEVNET, key(pool), key(depositor), u64(3), i64(1_700_000_600)]);
  assert.deepEqual(message, asTheProgramTests);
  assert.equal(message.length, 152);
  // A fixed vector, so a change to either side shows.
  assert.equal(
    message.toString("hex"),
    "4d594e5444455032" +
      "b55ac0a9e848171bb278b379958d0ffb8e6adf395efc582ac644a84f91d5240b" + // the template's program id
      "ce59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab" + // devnet's genesis hash

      "07".repeat(32) +
      "09".repeat(32) +
      "0300000000000000" +
      "58f3536500000000", // 1700000600 = 0x6553f358
  );
  // The program's test file and its source still lay the message out in this order.
  const tests = readFileSync(new URL("tests/mynt_treasury.ts", TEMPLATE), "utf8");
  assert.match(tests, /Buffer\.from\("MYNTDEP2"\), program\.programId\.toBuffer\(\), Buffer\.from\(cluster\), pool\.toBuffer\(\), who\.toBuffer\(\), u64\(nonce\), i64\(expiry\)/);
  const lib = readFileSync(new URL("programs/mynt_treasury/src/lib.rs", TEMPLATE), "utf8");
  const body = lib.slice(lib.indexOf("pub fn deposit_approval_message"), lib.indexOf("pub fn obligations_message"));
  const order = [...body.matchAll(/extend_from_slice\(([^)]*)\)/g)].map((m) => m[1].replace(/\s/g, ""));
  assert.deepEqual(order, ["&DEPOSIT_APPROVAL_DOMAIN", "crate::ID.as_ref(", "cluster", "pool.as_ref(", "depositor.as_ref(", "&nonce.to_le_bytes(", "&expiry.to_le_bytes("]);
  assert.match(lib, /DEPOSIT_APPROVAL_DOMAIN: \[u8; 8\] = \*b"MYNTDEP2"/);
});

test("the Ed25519 instruction is one signature over its own data, as the program parses it, and verifies", () => {
  const kp = Keypair.generate();
  const attester = new chain.TreasuryAttester(kp);
  const now = 1_700_000_000;
  const o = { programId: addr(1), cluster: DEVNET, pool: addr(2), depositor: addr(3), nonce: 0n, expiry: BigInt(now + 600) };
  const { message, signature } = attester.signDepositApproval(o, now);
  const ix = chain.ed25519Instruction(attester.publicKey, signature, message);
  assert.equal(ix.programId, "Ed25519SigVerify111111111111111111111111111");
  assert.equal(ix.keys.length, 0);
  const d = Buffer.from(ix.data);
  // The program's parse_ed25519_ix: one signature, every index u16::MAX.
  assert.equal(d[0], 1);
  assert.equal(d.readUInt16LE(4), 0xffff);
  assert.equal(d.readUInt16LE(8), 0xffff);
  assert.equal(d.readUInt16LE(14), 0xffff);
  assert.deepEqual([d.readUInt16LE(6), d.readUInt16LE(2), d.readUInt16LE(10), d.readUInt16LE(12)], [16, 48, 112, 152]);
  const parsed = chain.parseEd25519Instruction(ix.data);
  assert.deepEqual(Buffer.from(parsed.publicKey), Buffer.from(kp.publicKey));
  assert.deepEqual(Buffer.from(parsed.message), Buffer.from(chain.depositApprovalMessage(o)));
  const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(kp.publicKey).toString("base64url") }, format: "jwk" });
  assert.ok(verify(null, parsed.message, pub, parsed.signature));
  // It signs nothing else: no expiry past ten minutes, none in the past.
  assert.throws(() => attester.signDepositApproval({ ...o, expiry: BigInt(now + 601) }, now), /within 10 minutes/);
  assert.throws(() => attester.signDepositApproval({ ...o, expiry: BigInt(now) }, now), /within 10 minutes/);
  assert.equal(typeof attester.sign, "undefined", "the attester has no general-purpose sign");
});

// ---- a fake devnet ----

const terms = (t = {}) => ({ lock_in: 0, notice: 0, min_reserve: 0, bps: 0, staleness: 3600, cmin: 1, cmax: 1_000_000_000, min_request: 0, topups: false, ext: chain.ZERO_KEY, attesters: [chain.ZERO_KEY, chain.ZERO_KEY], health: addr(44), ...t });
const encodeTerms = (t) =>
  Buffer.concat([i64(t.lock_in), i64(t.notice), u64(t.min_reserve), u16(t.bps), i64(t.staleness), u64(t.cmin), u64(t.cmax), u64(t.min_request), bool(t.topups), key(t.ext), key(t.attesters[0]), key(t.attesters[1]), key(t.health)]);
const encodeFloor = () => Buffer.concat([i64(0), i64(100_000), i64(0), i64(100_000), u64(0), u64(1e12), u16(0), u16(9_999), i64(86_400), u64(0), u64(1e10), bool(true), i64(0)]);
function encodePool(p) {
  const t = encodeTerms(p.terms);
  return Buffer.concat([
    Buffer.from(anchorDiscriminator("account", "Pool")),
    key(p.creator),
    u64(p.poolId),
    p.cluster ?? DEVNET,
    key(addr(40)),
    key(p.mint),
    key(p.vault),
    t,
    encodeFloor(),
    i64(2),
    t,
    i64(0),
    bool(false),
    bool(!!p.sponsorPaused),
    bool(!!p.healthPaused),
    bool(false),
    bool(false),
    u64(0),
    i64(0),
    u64(p.principal ?? 0),
    u64(p.principal ?? 0),
    u64(0),
    u64(0),
    u64(p.nextDeposit ?? 0),
    u64(p.nextRequest ?? 0),
    u64(0),
    i64(0),
    bool(false),
    u64(0),
    u64(0),
    u64(0),
    u64(0),
    Buffer.from([255, 254]),
  ]);
}
const encodePosition = (pool, depositor, principal, nonce) =>
  Buffer.concat([Buffer.from(anchorDiscriminator("account", "Position")), key(pool), key(depositor), u64(principal), u64(principal), u64(1), u64(nonce), u64(0), u64(0), bool(false), Buffer.from([255])]);
const encodeDeposit = (d) =>
  Buffer.concat([Buffer.from(anchorDiscriminator("account", "DepositRecord")), key(d.pool), key(d.depositor), u64(d.seq), u64(d.amount), u64(d.remaining), u64(d.queued), i64(d.settled_at), i64(d.review_until), i64(d.lock_in), i64(d.unlock_at), i64(d.notice), bool(false), Buffer.from([255])]);
const encodeToken = (mint, owner, amount) => Buffer.concat([key(mint), key(owner), u64(amount), Buffer.alloc(165 - 72)]);

class FakeDevnet {
  accounts = new Map();
  signatures = new Map(); // address -> [{ signature, slot }] newest first
  transactions = new Map();
  statuses = new Map();
  calls = [];
  set(address, owner, data, executable = false) {
    this.accounts.set(address, { owner, data: [Buffer.from(data).toString("base64"), "base64"], executable, lamports: 1_000_000 });
  }
  async call(method, params = []) {
    this.calls.push(method);
    switch (method) {
      case "getGenesisHash":
        return GENESIS_HASH.devnet;
      case "getAccountInfo":
        return { value: this.accounts.get(params[0]) ?? null };
      case "getLatestBlockhash":
        return { value: { blockhash: addr(77), lastValidBlockHeight: 1234 } };
      case "getBalance":
        return { value: 3_000_000_000 };
      case "getSignaturesForAddress": {
        // Newest first: after `before`, down to (not including) `until`, at most `limit`.
        let all = this.signatures.get(params[0]) ?? [];
        const { until, before, limit = 1000 } = params[1] ?? {};
        if (before) all = all.slice(all.findIndex((s) => s.signature === before) + 1);
        const i = until ? all.findIndex((s) => s.signature === until) : -1;
        return (i >= 0 ? all.slice(0, i) : all).slice(0, limit).map((s) => ({ err: null, ...s }));
      }
      case "getTransaction":
        return this.transactions.get(params[0]) ?? null;
      case "getSignatureStatuses":
        return { value: params[0].map((s) => this.statuses.get(s) ?? null) };
      default:
        throw new Error(`unexpected ${method}`);
    }
  }
}

// One builder's product with a sponsored, approved pool on it; two liquidity-provider firms; a devnet treasury.
async function world(config = {}) {
  const pg = new PGlite();
  closers.push(() => pg.close().catch(() => {}));
  const db = { query: (s, p) => pg.query(s, p), exec: (s) => pg.exec(s), close: () => pg.close() };
  const store = await Store.open(db, CATALOG);
  const devnet = new FakeDevnet();
  const solana = await SolanaService.open(db, store, solanaConfigFromEnv({}), { rpc: () => devnet, custody: null });
  const treasury = await TreasuryService.open(db, store, solana, { usdcMint: chain.DEVNET_USDC_MINT, indexPerPoll: 200, ...config });
  const linked = new Map(); // user id -> wallets
  const identity = new LinkedAccountsService({ subjectOf: async (id) => id, linkedAccounts: async (id) => ({ git: null, wallets: linked.get(id) ?? [] }), manageUrl: () => null }, 0, Date.now, 0);
  const connect = async (user) => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await createServer(store, user, { identity, solana, treasury }).connect(s);
    const client = new Client({ name: "treasury", version: "0" });
    await client.connect(c);
    closers.push(() => client.close());
    return client;
  };
  const firm = async (name, roles) => {
    const entity = await store.createEntity(null, { name, registration_numbers: {}, regions: ["US"] });
    const { user } = await store.createUser(`${name} person`, roles);
    await store.setUserEntity(user.id, entity.id);
    user.entity_id = entity.id;
    return { entity, user, client: await connect(user) };
  };
  const sponsor = await firm("Partner Bank", ["license_provider"]);
  const builder = await firm("Builder Co", ["innovator"]);
  const fundA = await firm("Fund A", ["liquidity_provider"]);
  const fundB = await firm("Fund B", ["liquidity_provider"]);
  const [seed] = await store.publishedProducts();
  await db.query("UPDATE financial_products.products SET owner_id = $1, entity_id = $2 WHERE id = $3", [builder.user.id, builder.entity.id, seed.id]);
  const makePool = async (o = {}) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO financial_products.liquidity_pools (id, product_id, component_key, sponsor_entity_id, name, sandbox, status, min_reserve_bps, min_reserve_floor_cents, notice_period_days, min_commitment_cents, max_commitment_cents, approved_at, offering_cleared)
       VALUES ($1, $2, 'account', $3, $4, false, $5, 0, 0, 0, 1, $6, now(), $7)`,
      [id, seed.id, sponsor.entity.id, o.name ?? "Devnet pool", o.status ?? "open", o.maxCents ?? 100_000, o.cleared ?? true],
    );
    return id;
  };
  const attester = (await solana.treasuryAttester()).address;
  const programId = Keypair.generate().address;
  const programData = findProgramAddress([base58Decode(programId)], "BPFLoaderUpgradeab1e11111111111111111111111")[0];
  devnet.set(programId, "BPFLoaderUpgradeab1e11111111111111111111111", Buffer.concat([u32(2), key(programData)]), true);
  devnet.set(programData, "BPFLoaderUpgradeab1e11111111111111111111111", Buffer.concat([u32(3), u64(1), bool(true), key(addr(41)), Buffer.from("not the template's bytes"), Buffer.alloc(16)]));
  const creator = addr(42);
  // The builder holds the pool's creator key, as a verified wallet linked to their sign-in.
  linked.set(builder.user.id, [{ chain: "solana", address: creator, verified: true }]);
  let nextPoolNumber = 1;
  const treasuryPool = (o = {}) => {
    const poolId = nextPoolNumber++;
    const address = chain.poolAddress(programId, creator, poolId);
    const vault = findProgramAddress([Buffer.from("vault"), base58Decode(address)], programId)[0];
    const p = { creator, poolId, mint: chain.DEVNET_USDC_MINT, vault, ...o, terms: terms({ attesters: [attester, chain.ZERO_KEY], ...o.terms }) };
    const write = (patch = {}) => devnet.set(address, programId, encodePool({ ...p, ...patch }));
    write();
    return { address, vault, write, p };
  };
  return { db, store, devnet, solana, treasury, linked, sponsor, builder, fundA, fundB, makePool, attester, programId, treasuryPool, connect, firm, productId: seed.id, creator };
}

const callTool = async (client, name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  let data;
  try {
    data = JSON.parse(res.content[0].text);
  } catch {
    data = { error: res.content[0].text };
  }
  return { isError: res.isError ?? false, data };
};
const ok = async (client, name, args) => {
  const r = await callTool(client, name, args);
  assert.equal(r.isError, false, `${name}: ${JSON.stringify(r.data)}`);
  return r.data;
};
const refused = async (client, name, args, code) => {
  const r = await callTool(client, name, args);
  assert.equal(r.isError, true, `${name} should be refused: ${JSON.stringify(r.data)}`);
  assert.equal(r.data.code, code, JSON.stringify(r.data));
  return r.data;
};

test("the attester is generated once in the vault, under its own role, and is never another key", async () => {
  const s = await world();
  assert.equal((await s.solana.treasuryAttester()).address, s.attester);
  const { rows } = await s.db.query("SELECT role, cluster, public_key, sealed FROM financial_products.solana_keys WHERE role = 'treasury_attester'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cluster, "devnet");
  assert.equal(rows[0].public_key, s.attester);
  assert.match(rows[0].sealed, /^v1:/);
  assert.notEqual((await s.solana.authority("devnet")).address, s.attester);
  assert.equal((await ok(s.builder.client, "get_treasury_attester", {})).attester, s.attester);
});

test("registering a treasury: the builder's own pool, devnet only, a real treasury pool with devnet USDC and Mynt's attester", async () => {
  const s = await world();
  const poolId = await s.makePool();
  const good = s.treasuryPool();
  const args = { pool_id: poolId, cluster: "devnet", program_id: s.programId, pool_address: good.address };
  await refused(s.builder.client, "register_treasury_pool", { ...args, cluster: "mainnet" }, "mainnet_disabled");
  // Not the product's builder.
  const other = await s.store.createEntity(null, { name: "Other builder", registration_numbers: {}, regions: ["US"] });
  const { user } = await s.store.createUser("Other", ["innovator"]);
  await s.store.setUserEntity(user.id, other.id);
  user.entity_id = other.id;
  await refused(await s.connect(user), "register_treasury_pool", args, "not_builder");
  const noAttester = s.treasuryPool({ terms: { attesters: [addr(50), chain.ZERO_KEY] } });
  await refused(s.builder.client, "register_treasury_pool", { ...args, pool_address: noAttester.address }, "attester_missing");
  // Mynt's attester and another: someone else could admit depositors Mynt never checked.
  const extra = s.treasuryPool({ terms: { attesters: [s.attester, addr(53)] } });
  await refused(s.builder.client, "register_treasury_pool", { ...args, pool_address: extra.address }, "unexpected_attesters");
  const swapped = s.treasuryPool({ terms: { attesters: [chain.ZERO_KEY, s.attester] } });
  await refused(s.builder.client, "register_treasury_pool", { ...args, pool_address: swapped.address }, "unexpected_attesters");
  // The pool must be the builder's: its creator or authority a wallet linked to them.
  s.linked.set(s.builder.user.id, []);
  await refused(s.builder.client, "register_treasury_pool", args, "not_pool_owner");
  s.linked.set(s.builder.user.id, [{ chain: "solana", address: addr(40), verified: true }]); // the pool's authority
  await ok(s.builder.client, "register_treasury_pool", args);
  s.linked.set(s.builder.user.id, [{ chain: "solana", address: s.creator, verified: false }]);
  await refused(s.builder.client, "register_treasury_pool", args, "not_pool_owner");
  // An admin may register it for them.
  const { user: adminUser } = await s.store.createUser("Ada", ["admin"]);
  await ok(await s.connect(adminUser), "register_treasury_pool", args);
  s.linked.set(s.builder.user.id, [{ chain: "solana", address: s.creator, verified: true }]);
  const otherMint = s.treasuryPool({ mint: addr(51) });
  await refused(s.builder.client, "register_treasury_pool", { ...args, pool_address: otherMint.address }, "wrong_mint");
  const mainnetCluster = s.treasuryPool({ cluster: Buffer.from(base58Decode(GENESIS_HASH.mainnet)) });
  await refused(s.builder.client, "register_treasury_pool", { ...args, pool_address: mainnetCluster.address }, "wrong_cluster");
  // An account of the program that isn't at the pool's own address.
  s.devnet.set(addr(52), s.programId, encodePool({ ...good.p }));
  await refused(s.builder.client, "register_treasury_pool", { ...args, pool_address: addr(52) }, "not_a_treasury_pool");

  const t = await ok(s.builder.client, "register_treasury_pool", args);
  assert.equal(t.verified_build, false);
  assert.equal(t.build_status, "unverified build");
  assert.match(t.program_hash, /^[0-9a-f]{64}$/);
  assert.equal(t.on_chain_terms.mynt_attester_approved, true);
  const listed = (await ok(s.builder.client, "list_pools", {})).find((p) => p.id === poolId);
  assert.deepEqual(
    { cluster: listed.treasury.cluster, program_id: listed.treasury.program_id, pool_address: listed.treasury.pool_address, verified_build: listed.treasury.verified_build },
    { cluster: "devnet", program_id: s.programId, pool_address: good.address, verified_build: false },
  );
  for (const k of ["lock_in_seconds", "notice_seconds", "min_reserve", "min_reserve_bps", "sponsor_paused", "health_paused", "deposits_paused"]) assert.ok(k in listed.treasury.on_chain_terms, k);
  // A liquidity provider sees it too, with its health row.
  const withHealth = await ok(s.fundA.client, "list_pools_with_health", {});
  assert.equal(withHealth.find((p) => p.pool_id === poolId)?.treasury?.pool_address, good.address);
});

async function registered(s, o = {}) {
  const poolId = await s.makePool(o.pool);
  const t = s.treasuryPool(o.treasury);
  await ok(s.builder.client, "register_treasury_pool", { pool_id: poolId, cluster: "devnet", program_id: s.programId, pool_address: t.address });
  return { poolId, ...t };
}

test("a deposit is prepared only for the caller's own verified wallet, unsigned, with the wallet as fee payer and only signer", async () => {
  const s = await world();
  const { poolId, address, vault, write } = await registered(s, { treasury: { nextDeposit: 4, terms: { lock_in: 3600, notice: 600 } } });
  const wallet = Keypair.generate().address;
  const unverified = Keypair.generate().address;
  s.linked.set(s.fundA.user.id, [
    { chain: "solana", address: wallet, verified: true },
    { chain: "solana", address: unverified, verified: false },
  ]);
  s.devnet.set(chain.associatedTokenAddress(wallet, chain.DEVNET_USDC_MINT), chain.TOKEN_PROGRAM, encodeToken(chain.DEVNET_USDC_MINT, wallet, 50_000_000));
  s.devnet.set(chain.positionAddress(s.programId, address, wallet), s.programId, encodePosition(address, wallet, 1_000_000, 2));
  const args = { pool_id: poolId, wallet, amount_usdc_base_units: 5_000_000, max_lock_in_seconds: 7200 };

  await refused(s.fundA.client, "prepare_treasury_deposit", { ...args, wallet: unverified }, "wallet_not_linked");
  await refused(s.fundA.client, "prepare_treasury_deposit", { ...args, wallet: Keypair.generate().address }, "wallet_not_linked");
  // Fund B's own wallet list doesn't include Fund A's wallet.
  await refused(s.fundB.client, "prepare_treasury_deposit", args, "wallet_not_linked");
  // A builder has no such tool; neither does an admin.
  assert.ok(!(await s.builder.client.listTools()).tools.some((t) => t.name === "prepare_treasury_deposit"));
  // A pool without a treasury.
  await refused(s.fundA.client, "prepare_treasury_deposit", { ...args, pool_id: await s.makePool() }, "not_on_chain");
  await refused(s.fundA.client, "prepare_treasury_deposit", { ...args, amount_usdc_base_units: 1_000_000_000 }, "over_limit");
  await refused(s.fundA.client, "prepare_treasury_deposit", { ...args, max_lock_in_seconds: 60 }, "terms_changed");
  await refused(s.fundA.client, "prepare_treasury_deposit", { ...args, amount_usdc_base_units: 60_000_000 }, "insufficient_usdc");

  const before = Math.floor(Date.now() / 1000);
  const out = await ok(s.fundA.client, "prepare_treasury_deposit", args);
  assert.equal(out.cluster, "devnet");
  assert.deepEqual(
    { pool: out.summary.pool, amount: out.summary.amount, lock_in_seconds: out.summary.lock_in_seconds, notice_seconds: out.summary.notice_seconds, wallet: out.summary.wallet },
    { pool: "Devnet pool", amount: 5_000_000, lock_in_seconds: 3600, notice_seconds: 600, wallet },
  );
  const expires = new Date(out.expires_at).getTime() / 1000;
  assert.ok(expires > before && expires <= Math.floor(Date.now() / 1000) + 600, "the approval lives at most ten minutes");

  const tx = chain.decodeV0Transaction(Buffer.from(out.transaction_base64, "base64"));
  assert.equal(tx.version, 0);
  assert.equal(tx.numSigners, 1, "the wallet is the only signer");
  assert.equal(tx.keys[0], wallet, "and the fee payer");
  assert.deepEqual([...tx.signatures[0]], new Array(64).fill(0), "nothing is signed");
  assert.equal(tx.blockhash, addr(77));
  assert.ok(!tx.keys.includes(s.attester), "Mynt's attester is no account of the transaction");
  assert.ok(!tx.keys.includes((await s.solana.authority("devnet")).address), "nor is any other Mynt key");
  assert.equal(tx.instructions.length, 2);
  const [att, dep] = tx.instructions;
  assert.equal(att.programId, "Ed25519SigVerify111111111111111111111111111");
  const parsed = chain.parseEd25519Instruction(att.data);
  assert.equal(base58Encode(parsed.publicKey), s.attester);
  // The approval is for this pool, this wallet, at the position's nonce (2), until expires_at.
  assert.deepEqual(Buffer.from(parsed.message), Buffer.from(chain.depositApprovalMessage({ programId: s.programId, cluster: DEVNET, pool: address, depositor: wallet, nonce: 2n, expiry: BigInt(expires) })));
  assert.equal(dep.programId, s.programId);
  assert.deepEqual(Buffer.from(dep.data), Buffer.concat([Buffer.from(anchorDiscriminator("global", "deposit")), u64(5_000_000), i64(expires), i64(7200)]));
  assert.deepEqual(
    dep.accounts.map((a) => [a.pubkey, a.signer, a.writable]),
    [
      [wallet, true, true],
      [address, false, true],
      [chain.positionAddress(s.programId, address, wallet), false, true],
      [chain.depositAddress(s.programId, address, 4), false, true],
      [vault, false, true],
      [chain.associatedTokenAddress(wallet, chain.DEVNET_USDC_MINT), false, true],
      [chain.DEVNET_USDC_MINT, false, false],
      ["Sysvar1nstructions1111111111111111111111111", false, false],
      [chain.hookAddress(s.programId, address), false, false],
      [s.programId, false, false],
      [chain.TOKEN_PROGRAM, false, false],
      ["11111111111111111111111111111111", false, false],
    ],
  );

  // Paused on chain: refused.
  write({ sponsorPaused: true }); // the prepare path always reads the pool fresh
  await refused(s.fundA.client, "prepare_treasury_deposit", args, "pool_paused");
  write({ healthPaused: true });
  await refused(s.fundA.client, "prepare_treasury_deposit", args, "pool_paused");
  write();
  // Paused at Mynt: refused.
  await s.db.query("UPDATE financial_products.liquidity_pools SET status = 'paused', pause_kind = 'manual' WHERE id = $1", [poolId]);
  await refused(s.fundA.client, "prepare_treasury_deposit", args, "pool_paused");
  await s.db.query("UPDATE financial_products.liquidity_pools SET status = 'open', pause_kind = NULL WHERE id = $1", [poolId]);
  // As commit_to_pool: a pool that isn't sandbox needs its offering cleared.
  await s.db.query("UPDATE financial_products.liquidity_pools SET offering_cleared = false WHERE id = $1", [poolId]);
  await refused(s.fundA.client, "prepare_treasury_deposit", args, "offering_not_cleared");
  await s.db.query("UPDATE financial_products.liquidity_pools SET offering_cleared = true WHERE id = $1", [poolId]);
  // The firm's limit across its wallets: 100000 cents is 1000 USDC; the indexer's records count toward it.
  await s.db.query("UPDATE financial_products.liquidity_pools SET max_commitment_cents = 500 WHERE id = $1", [poolId]);
  await refused(s.fundA.client, "prepare_treasury_deposit", args, "over_limit");
  // A firm that isn't active has no standing.
  await s.db.query("UPDATE financial_products.liquidity_pools SET max_commitment_cents = 100000 WHERE id = $1", [poolId]);
  await s.db.query("UPDATE financial_products.entities SET status = 'suspended' WHERE id = $1", [s.fundA.entity.id]);
  await refused(s.fundA.client, "prepare_treasury_deposit", args, "not_liquidity_provider");
});

test("balances are read only for the caller's own linked wallets, and mainnet is refused everywhere", async () => {
  const s = await world();
  const wallet = Keypair.generate().address;
  s.linked.set(s.fundA.user.id, [{ chain: "solana", address: wallet, verified: true }]);
  s.devnet.set(chain.associatedTokenAddress(wallet, chain.DEVNET_USDC_MINT), chain.TOKEN_PROGRAM, encodeToken(chain.DEVNET_USDC_MINT, wallet, 12_345));
  const b = await ok(s.fundA.client, "get_wallet_balances", { address: wallet, cluster: "devnet" });
  assert.deepEqual({ sol: b.sol_lamports, usdc: b.usdc_base_units }, { sol: 3_000_000_000, usdc: 12_345 });
  await refused(s.fundA.client, "get_wallet_balances", { address: Keypair.generate().address, cluster: "devnet" }, "wallet_not_linked");
  await refused(s.fundB.client, "get_wallet_balances", { address: wallet, cluster: "devnet" }, "wallet_not_linked");
  await refused(s.fundA.client, "get_wallet_balances", { address: wallet, cluster: "mainnet" }, "mainnet_disabled");
  await refused(s.builder.client, "register_treasury_pool", { pool_id: await s.makePool(), cluster: "mainnet", program_id: s.programId, pool_address: addr(60) }, "mainnet_disabled");
  // A treasury row can only ever be devnet.
  await assert.rejects(s.db.query("INSERT INTO financial_products.treasury_pools (pool_id, cluster, program_id, pool_address, vault, usdc_mint, creator, registered_by) VALUES ($1, 'mainnet', 'a', 'b', 'c', 'd', 'e', $2)", [await s.makePool(), s.fundA.user.id]));
});

const logs = (programId, ...events) => [
  `Program ${programId} invoke [1]`,
  "Program log: Instruction: Deposit",
  ...events.map((e) => `Program data: ${Buffer.from(chain.encodeEvent(e)).toString("base64")}`),
  // An extension the treasury called logs its own data: never read as the treasury's.
  `Program ${addr(61)} invoke [2]`,
  `Program data: ${Buffer.from(chain.encodeEvent({ ...events[0], amount: 999n })).toString("base64")}`,
  `Program ${addr(61)} success`,
  `Program ${programId} consumed 20000 of 200000 compute units`,
  `Program ${programId} success`,
];

test("the indexer turns the treasury's events into on-chain positions, once, and a withdrawal request is prepared from them", async () => {
  const s = await world();
  const { poolId, address, write } = await registered(s, { treasury: { nextRequest: 7, terms: { notice: 300, min_request: 10 } } });
  const wallet = Keypair.generate().address;
  s.linked.set(s.fundA.user.id, [{ chain: "solana", address: wallet, verified: true }]);
  const now = Math.floor(Date.now() / 1000);
  const deposit = chain.depositAddress(s.programId, address, 0);
  const locked = chain.depositAddress(s.programId, address, 1);
  const request = chain.requestAddress(s.programId, address, 0);
  const sig = (n) => base58Encode(Buffer.alloc(64, n));
  const tx = (programId, ...events) => ({ slot: 10, meta: { err: null, logMessages: logs(programId, ...events) } });
  s.devnet.transactions.set(sig(1), tx(s.programId, { name: "DepositMade", pool: address, depositor: wallet, deposit, seq: 0n, amount: 5_000_000n, settled_at: BigInt(now - 7200), review_until: BigInt(now - 7200), unlock_at: BigInt(now - 3600), principal_after: 5_000_000n }));
  s.devnet.transactions.set(sig(2), tx(s.programId, { name: "WithdrawalRequested", pool: address, depositor: wallet, deposit, request, seq: 0n, amount: 2_000_000n, payable_at: BigInt(now - 60) }));
  s.devnet.transactions.set(sig(3), tx(s.programId, { name: "WithdrawalPaid", pool: address, depositor: wallet, request, seq: 0n, amount: 1_500_000n, remaining: 500_000n, partial: true, parked: false, reserve_floor: 0n, vault_after: 0n }));
  // Another pool's event in the same program, and a failed transaction: neither counts.
  s.devnet.transactions.set(sig(4), tx(s.programId, { name: "DepositMade", pool: addr(62), depositor: wallet, deposit: addr(63), seq: 0n, amount: 7n, settled_at: 0n, review_until: 0n, unlock_at: 0n, principal_after: 7n }));
  s.devnet.transactions.set(sig(5), { slot: 11, meta: { err: { InstructionError: [1, { Custom: 6012 }] }, logMessages: logs(s.programId, { name: "DepositMade", pool: address, depositor: wallet, deposit: addr(64), seq: 9n, amount: 9n, settled_at: 0n, review_until: 0n, unlock_at: 0n, principal_after: 9n }) } });
  s.devnet.transactions.set(sig(6), tx(s.programId, { name: "DepositMade", pool: address, depositor: wallet, deposit: locked, seq: 1n, amount: 1_000_000n, settled_at: BigInt(now), review_until: BigInt(now), unlock_at: BigInt(now + 86_400), principal_after: 6_000_000n }));
  s.devnet.signatures.set(address, [6, 5, 4, 3, 2, 1].map((n) => ({ signature: sig(n), slot: n })));

  assert.deepEqual(await s.treasury.index(), { events: 4 });
  // Indexed again from the start: nothing counts twice.
  await s.db.query("UPDATE financial_products.treasury_pools SET index_cursor = NULL");
  assert.deepEqual(await s.treasury.index(), { events: 0 });

  const positions = await ok(s.fundA.client, "list_my_positions", {});
  const p = positions.find((x) => x.source === "on-chain");
  assert.ok(p, JSON.stringify(positions));
  assert.deepEqual(
    { cluster: p.cluster, pool_id: p.pool_id, wallet: p.wallet, principal: p.principal, deposited: p.deposited, paid: p.paid, queued: p.queued, available: p.available_to_request },
    { cluster: "devnet", pool_id: poolId, wallet, principal: 4_500_000, deposited: 6_000_000, paid: 1_500_000, queued: 500_000, available: 3_000_000 },
  );
  assert.deepEqual(
    p.deposits.map((d) => [d.deposit, d.remaining, d.queued, d.unlocked]),
    [
      [deposit, 3_500_000, 500_000, true],
      [locked, 1_000_000, 0, false],
    ],
  );
  assert.equal(p.deposits[1].unlock_at, new Date((now + 86_400) * 1000).toISOString());
  assert.deepEqual(p.requests.map((r) => [r.address, r.status, r.paid, r.remaining]), [[request, "open", 1_500_000, 500_000]]);
  // Fund B sees none of it.
  assert.ok(!(await ok(s.fundB.client, "list_my_positions", {})).some((x) => x.source === "on-chain"));

  // A withdrawal request against the unlocked deposit, as the chain has it now.
  s.devnet.set(deposit, s.programId, encodeDeposit({ pool: address, depositor: wallet, seq: 0, amount: 5_000_000, remaining: 3_500_000, queued: 500_000, settled_at: now - 7200, review_until: now - 7200, lock_in: 3600, unlock_at: now - 3600, notice: 600 }));
  s.devnet.set(locked, s.programId, encodeDeposit({ pool: address, depositor: wallet, seq: 1, amount: 1_000_000, remaining: 1_000_000, queued: 0, settled_at: now, review_until: now, lock_in: 86_400, unlock_at: now + 86_400, notice: 600 }));
  const args = { pool_id: poolId, wallet, deposit, amount_usdc_base_units: 1_000_000, max_notice_seconds: 600 };
  await refused(s.fundA.client, "prepare_treasury_withdrawal", { ...args, deposit: locked }, "deposit_locked");
  await refused(s.fundA.client, "prepare_treasury_withdrawal", { ...args, amount_usdc_base_units: 3_000_001 }, "over_limit");
  await refused(s.fundA.client, "prepare_treasury_withdrawal", { ...args, max_notice_seconds: 100 }, "terms_changed");
  await refused(s.fundB.client, "prepare_treasury_withdrawal", args, "wallet_not_linked");
  const out = await ok(s.fundA.client, "prepare_treasury_withdrawal", args);
  assert.equal(out.summary.notice_seconds, 300, "the shorter of the deposit's and the terms' notice");
  const back = chain.decodeV0Transaction(Buffer.from(out.transaction_base64, "base64"));
  assert.equal(back.numSigners, 1);
  assert.equal(back.keys[0], wallet);
  assert.equal(back.instructions.length, 1, "no attestation for a withdrawal");
  assert.ok(!back.keys.includes(s.attester));
  assert.deepEqual(Buffer.from(back.instructions[0].data), Buffer.concat([Buffer.from(anchorDiscriminator("global", "request_withdrawal")), u64(1_000_000), i64(600)]));
  assert.deepEqual(
    back.instructions[0].accounts.map((a) => a.pubkey),
    [wallet, address, deposit, chain.requestAddress(s.programId, address, 7), "11111111111111111111111111111111"],
  );
  void write;

  // The studio confirms a sent transaction: not found yet, then confirmed (and the pool it touched is read at once).
  assert.equal((await ok(s.fundA.client, "get_treasury_tx_status", { signature: sig(9) })).status, "not_found");
  s.devnet.statuses.set(sig(3), { slot: 10, err: null, confirmationStatus: "confirmed" });
  s.devnet.transactions.get(sig(3)).transaction = { message: { accountKeys: [wallet, address] } };
  const st = await ok(s.fundA.client, "get_treasury_tx_status", { signature: sig(3) });
  assert.deepEqual({ status: st.status, queued: st.queued_pools }, { status: "confirmed", queued: [poolId] });
  await s.treasury.idle();
  s.devnet.statuses.set(sig(5), { slot: 11, err: { InstructionError: [1, { Custom: 6012 }] } });
  assert.equal((await ok(s.fundA.client, "get_treasury_tx_status", { signature: sig(5) })).status, "failed");
});

test("events decode from the program's layouts and pool accounts from its size", () => {
  const e = { name: "WithdrawalPaid", pool: addr(1), depositor: addr(2), request: addr(3), seq: 4n, amount: 5n, remaining: 6n, partial: true, parked: false, reserve_floor: 7n, vault_after: 8n };
  assert.deepEqual(chain.decodeEvent(chain.encodeEvent(e)), e);
  assert.equal(chain.decodeEvent(Buffer.from(anchorDiscriminator("event", "PauseChanged"))).event, "PauseChanged");
  assert.equal(chain.decodeEvent(Buffer.alloc(16)), null);
  const pool = encodePool({ creator: addr(1), poolId: 1, mint: addr(2), vault: addr(3), terms: terms() });
  assert.equal(pool.length, chain.POOL_SIZE, "8 + Pool::INIT_SPACE");
  assert.equal(chain.decodePool(pool.subarray(0, pool.length - 1)), null);
  assert.equal(chain.decodePool(pool).terms.health_authority, addr(44));
});

// ---- the review's fixes ----

const { opsStatus } = await import("../dist/ops.js");
const sigN = (n) => base58Encode(Buffer.concat([Buffer.from("treasury-sig"), u32(n), Buffer.alloc(48)]));
const eventLine = (bytes) => `Program data: ${Buffer.from(bytes).toString("base64")}`;
const txOf = (programId, ...datas) => ({ slot: 10, meta: { err: null, logMessages: [`Program ${programId} invoke [1]`, ...datas.map(eventLine), `Program ${programId} success`] } });
const termsApplied = (pool, attesters) => Buffer.concat([Buffer.from(anchorDiscriminator("event", "TermsApplied")), key(pool), encodeTerms(terms({ attesters }))]);
const depositMade = (pool, depositor, seq, amount, at) =>
  chain.encodeEvent({ name: "DepositMade", pool, depositor, deposit: chain.depositAddress(addr(1), pool, seq), seq: BigInt(seq), amount: BigInt(amount), settled_at: BigInt(at), review_until: BigInt(at), unlock_at: BigInt(at), principal_after: BigInt(amount) });

test("approvals are only ever for devnet: the attester refuses another cluster, and a pool that names one is refused", async () => {
  const attester = new chain.TreasuryAttester(Keypair.generate());
  const now = 1_700_000_000;
  const o = { programId: addr(1), pool: addr(2), depositor: addr(3), nonce: 0n, expiry: BigInt(now + 60) };
  assert.throws(() => attester.signDepositApproval({ ...o, cluster: Buffer.from(base58Decode(GENESIS_HASH.mainnet)) }, now), /devnet approvals only/);
  assert.throws(() => attester.signDepositApproval({ ...o, cluster: Buffer.alloc(32) }, now), /devnet approvals only/);
  assert.ok(attester.signDepositApproval({ ...o, cluster: DEVNET }, now).signature.length === 64);

  const s = await world();
  const { poolId, write } = await registered(s);
  const wallet = Keypair.generate().address;
  s.linked.set(s.fundA.user.id, [{ chain: "solana", address: wallet, verified: true }]);
  s.devnet.set(chain.associatedTokenAddress(wallet, chain.DEVNET_USDC_MINT), chain.TOKEN_PROGRAM, encodeToken(chain.DEVNET_USDC_MINT, wallet, 50_000_000));
  // The account now names mainnet's genesis hash: refused, nothing signed.
  write({ cluster: Buffer.from(base58Decode(GENESIS_HASH.mainnet)) });
  await refused(s.fundA.client, "prepare_treasury_deposit", { pool_id: poolId, wallet, amount_usdc_base_units: 1_000_000, max_lock_in_seconds: 0 }, "wrong_cluster");
});

test("an attester change on chain stops Mynt's approvals for the pool and flags it, from the indexer or a fresh read", async () => {
  const s = await world();
  const wallet = Keypair.generate().address;
  s.linked.set(s.fundA.user.id, [{ chain: "solana", address: wallet, verified: true }]);
  s.devnet.set(chain.associatedTokenAddress(wallet, chain.DEVNET_USDC_MINT), chain.TOKEN_PROGRAM, encodeToken(chain.DEVNET_USDC_MINT, wallet, 50_000_000));
  const args = (poolId) => ({ pool_id: poolId, wallet, amount_usdc_base_units: 1_000_000, max_lock_in_seconds: 0 });

  // The indexer reads a TermsApplied that adds a second attester.
  const a = await registered(s);
  await ok(s.fundA.client, "prepare_treasury_deposit", args(a.poolId));
  s.devnet.transactions.set(sigN(1), txOf(s.programId, termsApplied(a.address, [s.attester, chain.ZERO_KEY])));
  s.devnet.transactions.set(sigN(2), txOf(s.programId, termsApplied(a.address, [s.attester, addr(70)])));
  s.devnet.signatures.set(a.address, [{ signature: sigN(2), slot: 2 }, { signature: sigN(1), slot: 1 }]);
  await s.treasury.index();
  const flagged = await refused(s.fundA.client, "prepare_treasury_deposit", args(a.poolId), "attesters_changed");
  assert.match(flagged.error, /attesters/);
  const row = (await ok(s.builder.client, "list_pools", {})).find((p) => p.id === a.poolId);
  assert.match(row.treasury.attesters_flag, /a terms change set the attesters/);
  assert.ok((await opsStatus(s.db)).attention.some((l) => /treasury pools: 1 devnet treasury/.test(l)));
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.audit_log WHERE action = 'treasury_attesters_flagged'")).rows[0].n, 1);
  // Registering again with the attesters put back clears it.
  await ok(s.builder.client, "register_treasury_pool", { pool_id: a.poolId, cluster: "devnet", program_id: s.programId, pool_address: a.address });
  await ok(s.fundA.client, "prepare_treasury_deposit", args(a.poolId));

  // No event read yet, but the fresh read before signing shows the change: refused and flagged.
  const b = await registered(s);
  b.write({ terms: terms({ attesters: [s.attester, addr(71)] }) });
  await refused(s.fundA.client, "prepare_treasury_deposit", args(b.poolId), "attesters_changed");
  assert.ok((await s.db.query("SELECT attesters_flag FROM financial_products.treasury_pools WHERE pool_id = $1", [b.poolId])).rows[0].attesters_flag);
  // An AttesterRemoved event flags too.
  const c = await registered(s);
  s.devnet.transactions.set(sigN(3), txOf(s.programId, Buffer.concat([Buffer.from(anchorDiscriminator("event", "AttesterRemoved")), key(c.address), key(s.attester)])));
  s.devnet.signatures.set(c.address, [{ signature: sigN(3), slot: 3 }]);
  await s.treasury.index();
  await refused(s.fundA.client, "prepare_treasury_deposit", args(c.poolId), "attesters_changed");
});

test("the indexer pages back to its cursor across polls, a bounded amount each time, and skips nothing", async () => {
  // One page of signatures a poll and 500 transactions read a poll, so a backlog takes many polls.
  const s = await world({ indexPagesPerPoll: 1, indexPerPoll: 500 });
  const { address } = await registered(s);
  const wallet = Keypair.generate().address;
  const list = [];
  // 2500 signatures, newest first; deposits at the oldest, in the second page and the newest.
  const at = Math.floor(Date.now() / 1000) - 10;
  for (let n = 0; n < 2500; n++) list.unshift({ signature: sigN(1000 + n), slot: 100 + n });
  const withDeposit = { 0: 1, 1500: 2, 2499: 3 };
  for (const [n, seq] of Object.entries(withDeposit)) s.devnet.transactions.set(sigN(1000 + Number(n)), txOf(s.programId, depositMade(address, wallet, seq, 1_000 * seq, at)));
  s.devnet.signatures.set(address, list);
  const deposits = async () => (await s.db.query("SELECT seq::int AS seq FROM financial_products.treasury_deposits ORDER BY seq")).rows.map((r) => r.seq);
  const cursor = async () => (await s.db.query("SELECT index_cursor, scan_before FROM financial_products.treasury_pools")).rows[0];

  // Polls 1 and 2 only scan (a page each); nothing is read until the scan reaches the cursor (none yet: the start).
  await s.treasury.index();
  assert.deepEqual(await deposits(), []);
  assert.equal((await cursor()).scan_before, sigN(1000 + 1500));
  // Meanwhile, a newer transaction arrives: the next scan finds it.
  list.unshift({ signature: sigN(9000), slot: 9000 });
  s.devnet.transactions.set(sigN(9000), txOf(s.programId, depositMade(address, wallet, 4, 4_000, at)));
  await s.treasury.index();
  assert.deepEqual(await deposits(), []);
  // Poll 3 reaches the start: then the oldest 500 are read, oldest first.
  await s.treasury.index();
  assert.deepEqual(await deposits(), [1]);
  assert.equal((await cursor()).index_cursor, sigN(1000 + 2499), "the cursor is the newest signature the scan started from");
  for (let i = 0; i < 4; i++) await s.treasury.index();
  assert.deepEqual(await deposits(), [1, 2, 3]);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.treasury_pending")).rows[0].n, 0);
  // The next scan, from the cursor, picks up what arrived in the meantime.
  await s.treasury.index();
  assert.deepEqual(await deposits(), [1, 2, 3, 4]);
  assert.equal((await cursor()).index_cursor, sigN(9000));
});

test("status checks and prepares are rate-limited per person, and a confirmed status queues its pools for the indexer", async () => {
  const s = await world();
  const { poolId, address } = await registered(s);
  const wallet = Keypair.generate().address;
  s.linked.set(s.fundA.user.id, [{ chain: "solana", address: wallet, verified: true }]);
  s.devnet.statuses.set(sigN(1), { slot: 5, err: null, confirmationStatus: "finalized" });
  s.devnet.transactions.set(sigN(1), { ...txOf(s.programId, depositMade(address, wallet, 0, 7_000, Math.floor(Date.now() / 1000))), transaction: { message: { accountKeys: [wallet, address] } } });
  s.devnet.signatures.set(address, [{ signature: sigN(1), slot: 5 }]);
  const st = await ok(s.fundA.client, "get_treasury_tx_status", { signature: sigN(1) });
  assert.deepEqual(st.queued_pools, [poolId]);
  await s.treasury.idle();
  assert.equal((await ok(s.fundA.client, "list_my_positions", {})).find((p) => p.source === "on-chain")?.principal, 7_000);
  for (let i = 1; i < 30; i++) await ok(s.fundA.client, "get_treasury_tx_status", { signature: sigN(2) });
  await refused(s.fundA.client, "get_treasury_tx_status", { signature: sigN(2) }, "rate_limited");
  // Someone else isn't held up.
  await ok(s.fundB.client, "get_treasury_tx_status", { signature: sigN(2) });
  // Prepares: twenty a minute, refused or not.
  const args = { pool_id: poolId, wallet, amount_usdc_base_units: 1, max_lock_in_seconds: 0 };
  for (let i = 0; i < 20; i++) await refused(s.fundB.client, "prepare_treasury_deposit", args, "wallet_not_linked");
  await refused(s.fundB.client, "prepare_treasury_deposit", args, "rate_limited");
  await refused(s.fundB.client, "prepare_treasury_withdrawal", { pool_id: poolId, wallet, deposit: addr(5), amount_usdc_base_units: 1, max_notice_seconds: 0 }, "rate_limited");
});

test("positions and the firm's limit follow each wallet's current link: unlinked or gone from the firm, it stops counting", async () => {
  const s = await world();
  const { poolId, address } = await registered(s);
  const wallet = Keypair.generate().address;
  // Two people at Fund A; the first prepares from their wallet.
  const second = await s.store.createUser("Fund A second person", ["liquidity_provider"]);
  await s.store.setUserEntity(second.user.id, s.fundA.entity.id);
  second.user.entity_id = s.fundA.entity.id;
  const colleague = await s.connect(second.user);
  s.linked.set(s.fundA.user.id, [{ chain: "solana", address: wallet, verified: true }]);
  s.devnet.set(chain.associatedTokenAddress(wallet, chain.DEVNET_USDC_MINT), chain.TOKEN_PROGRAM, encodeToken(chain.DEVNET_USDC_MINT, wallet, 50_000_000));
  await ok(s.fundA.client, "prepare_treasury_deposit", { pool_id: poolId, wallet, amount_usdc_base_units: 1_000_000, max_lock_in_seconds: 0 });
  s.devnet.transactions.set(sigN(1), txOf(s.programId, depositMade(address, wallet, 0, 4_000_000, Math.floor(Date.now() / 1000))));
  s.devnet.signatures.set(address, [{ signature: sigN(1), slot: 1 }]);
  await s.treasury.index();
  const onChain = async (client) => (await ok(client, "list_my_positions", {})).filter((p) => p.source === "on-chain");
  assert.equal((await onChain(colleague)).length, 1, "the colleague sees the firm's wallet while it's linked");
  // Its 4 USDC counts toward the firm's limit for the colleague's own wallet: 500 cents is 5 USDC.
  const own = Keypair.generate().address;
  s.linked.set(second.user.id, [{ chain: "solana", address: own, verified: true }]);
  s.devnet.set(chain.associatedTokenAddress(own, chain.DEVNET_USDC_MINT), chain.TOKEN_PROGRAM, encodeToken(chain.DEVNET_USDC_MINT, own, 50_000_000));
  await s.db.query("UPDATE financial_products.liquidity_pools SET max_commitment_cents = 500 WHERE id = $1", [poolId]);
  const ownArgs = { pool_id: poolId, wallet: own, amount_usdc_base_units: 2_000_000, max_lock_in_seconds: 0 };
  await refused(colleague, "prepare_treasury_deposit", ownArgs, "over_limit");
  // The first person unlinks it: it no longer counts, and its record is dropped.
  s.linked.set(s.fundA.user.id, []);
  assert.equal((await onChain(colleague)).length, 0);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.treasury_wallets WHERE wallet = $1", [wallet])).rows[0].n, 0);
  await ok(colleague, "prepare_treasury_deposit", ownArgs);
  // Someone who leaves the firm takes their wallets with them.
  const other = await s.store.createEntity(null, { name: "Elsewhere", registration_numbers: {}, regions: ["US"] });
  await s.store.setUserEntity(second.user.id, other.id);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.treasury_wallets WHERE user_id = $1", [second.user.id])).rows[0].n, 1);
  await onChain(s.fundA.client);
  assert.equal((await s.db.query("SELECT count(*)::int AS n FROM financial_products.treasury_wallets WHERE user_id = $1", [second.user.id])).rows[0].n, 0);
});
