import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  freezeAccount,
  getAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  thawAccount,
} from "@solana/spl-token";
import { MyntTreasury } from "../target/types/mynt_treasury";
import { ExtensionProbe } from "../target/types/extension_probe";

const { PublicKey, Keypair, SystemProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_CLOCK_PUBKEY, Transaction } = anchor.web3;
type PublicKeyT = anchor.web3.PublicKey;
type KeypairT = anchor.web3.Keypair;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A local validator can drop a transaction whose blockhash it hasn't caught up with ("Blockhash not found") or let
// one expire while it's busy. Those never reached the program, so they are sent again with a fresh blockhash.
const TRANSIENT = /Blockhash not found|BlockhashNotFound|block height exceeded|BlockheightExceeded|TransactionExpired|has expired/i;
const transient = (e: any) => TRANSIENT.test(`${e}\n${(e?.logs ?? e?.transactionLogs ?? []).join("\n")}`);
async function retry<T>(send: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await send();
    } catch (e) {
      if (i >= attempts || !transient(e)) throw e;
      await sleep(500 * i);
    }
  }
}

// Every transaction is read, simulated and confirmed at "confirmed", with a blockhash fetched for it (AnchorProvider
// takes a fresh one on each send), and sent again on a transient failure.
class TestProvider extends anchor.AnchorProvider {
  async sendAndConfirm(tx: any, signers?: any, opts?: any): Promise<string> {
    return retry(() => super.sendAndConfirm(tx, signers, { ...opts, commitment: "confirmed", preflightCommitment: "confirmed" }));
  }
}

// Runs on the local validator `anchor test` starts. Mynt runs these again, in its own clean sandbox, against the
// programs it built verifiably. Each rule of the treasury has its own pool here, so the cases don't share state.
describe("mynt_treasury", () => {
  const env = anchor.AnchorProvider.env();
  const connection = new anchor.web3.Connection(env.connection.rpcEndpoint, { commitment: "confirmed" });
  const provider = new TestProvider(connection, env.wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  anchor.setProvider(provider);
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = anchor.workspace.myntTreasury as Program<MyntTreasury>;
  const probe = anchor.workspace.extensionProbe as Program<ExtensionProbe>;
  const confirmed = { commitment: "confirmed" as const };

  const authority = Keypair.generate(); // in production a Squads vault PDA; any key works here
  const healthAuthority = Keypair.generate();
  const attester = Keypair.generate();
  const attester2 = Keypair.generate();
  const stranger = Keypair.generate();
  let mint: PublicKeyT;
  let cluster: number[];
  let nextPoolId = 1;

  const u64 = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);
  const i64 = (n: number | BN) => new BN(n).toTwos(64).toArrayLike(Buffer, "le", 8);
  const pda = (seeds: (string | Buffer | PublicKeyT)[], programId = program.programId) =>
    PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.isBuffer(s) ? s : s.toBuffer())), programId)[0];
  const ata = (owner: PublicKeyT) => getAssociatedTokenAddressSync(mint, owner, true);
  const chainNow = async () => Number((await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"))!.data.readBigInt64LE(32));
  const ready = async () => {
    for (;;) {
      const health = await (connection as any)._rpcRequest("getHealth", []).catch(() => null);
      if (health?.result === "ok") break;
      await sleep(400);
    }
    const start = await connection.getSlot("confirmed");
    while ((await connection.getSlot("confirmed")) < start + 2) await sleep(200);
  };
  const waitUntil = async (t: number) => {
    while ((await chainNow()) < t) await sleep(400);
    await ready();
  };
  const balance = async (account: PublicKeyT) => Number((await getAccount(connection, account, "confirmed")).amount);
  // What a failed transaction's program said: the Anchor error code (from the error, or parsed from the simulation
  // logs), the logs themselves (runtime errors such as a privilege escalation live there), then the message.
  const failure = async (e: any) => {
    let logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
    if (!logs.length && typeof e?.getLogs === "function") logs = (await e.getLogs(connection).catch(() => [])) ?? [];
    const code = e?.error?.errorCode?.code ?? anchor.AnchorError.parse(logs)?.error.errorCode.code ?? "";
    return { code, text: `${code}\n${logs.join("\n")}\n${e}` };
  };
  const fails = async (p: Promise<unknown>, re: RegExp) => {
    try {
      await p;
    } catch (e: any) {
      const { text } = await failure(e);
      assert.ok(!transient(e), `a transient RPC failure, not the program's answer: ${e}`);
      assert.match(text, re);
      return;
    }
    assert.fail(`expected a failure matching ${re}`);
  };
  const events = async (signature: string) => {
    let tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    for (let i = 0; !tx && i < 20; i++) {
      await sleep(250);
      tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    }
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
    return [...parser.parseLogs(tx?.meta?.logMessages ?? [])].map((e) => ({ name: e.name.toLowerCase(), data: e.data as any }));
  };
  const fund = async (...keys: PublicKeyT[]) => {
    const tx = new Transaction();
    for (const k of keys) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k, lamports: 2 * anchor.web3.LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(tx, [], confirmed);
  };
  const tokenAccount = async (owner: PublicKeyT, amount = 0) => {
    const address = ata(owner);
    await provider.sendAndConfirm(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, address, owner, mint)), [], confirmed);
    if (amount) await retry(() => mintTo(connection, payer, mint, address, payer, amount, [], confirmed));
    return address;
  };
  const depositor = async (amount = 1_000) => {
    const kp = Keypair.generate();
    await fund(kp.publicKey);
    await tokenAccount(kp.publicKey, amount);
    return kp;
  };

  const terms = (t: Record<string, unknown> = {}) => ({
    lockInSeconds: new BN(0),
    noticeSeconds: new BN(0),
    minReserve: new BN(0),
    minReserveBps: 0,
    obligationsMaxStaleness: new BN(3600),
    commitmentMin: new BN(1),
    commitmentMax: new BN(1_000_000_000),
    minRequest: new BN(0),
    topupsWhenHealthPaused: false,
    extensionProgram: PublicKey.default,
    attesters: [attester.publicKey, PublicKey.default],
    healthAuthority: healthAuthority.publicKey,
    ...t,
  });
  const floor = (f: Record<string, unknown> = {}) => ({
    minLockInSeconds: new BN(0),
    maxLockInSeconds: new BN(100_000),
    minNoticeSeconds: new BN(0),
    maxNoticeSeconds: new BN(100_000),
    minReserve: new BN(0),
    maxMinReserve: new BN(1_000_000_000_000),
    minReserveBps: 0,
    maxReserveBps: 9_999,
    maxObligationsStaleness: new BN(86_400),
    minCommitment: new BN(0),
    maxCommitment: new BN(10_000_000_000),
    topupsWhenHealthPausedAllowed: true,
    reviewWindowSeconds: new BN(0),
    ...f,
  });

  type Pool = { pool: PublicKeyT; vault: PublicKeyT; signature: string };
  const createPool = async (t: Record<string, unknown> = {}, f: Record<string, unknown> = {}, minTimelock = 2): Promise<Pool> => {
    const poolId = new BN(nextPoolId++);
    const pool = pda(["pool", payer.publicKey, u64(poolId)]);
    const vault = pda(["vault", pool]);
    const signature = await program.methods
      .initializePool(poolId, cluster, terms(t) as any, floor(f) as any, new BN(minTimelock))
      .accountsPartial({ creator: payer.publicKey, authority: authority.publicKey, pool, usdcMint: mint, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc(confirmed);
    return { pool, vault, signature };
  };

  const approval = (pool: PublicKeyT, who: PublicKeyT, nonce: number, expiry: number, signer: KeypairT = attester) =>
    Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer.secretKey,
      message: Buffer.concat([Buffer.from("MYNTDEP2"), program.programId.toBuffer(), Buffer.from(cluster), pool.toBuffer(), who.toBuffer(), u64(nonce), i64(expiry)]),
    });
  const obligationsAttestation = (pool: PublicKeyT, obligations: number, asOf: number, signer: KeypairT) =>
    Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer.secretKey,
      message: Buffer.concat([Buffer.from("MYNTOBL2"), program.programId.toBuffer(), Buffer.from(cluster), pool.toBuffer(), u64(obligations), i64(asOf)]),
    });

  type DepositOpts = {
    expiry?: number;
    signer?: KeypairT;
    approveFor?: PublicKeyT;
    nonce?: number;
    noAttestation?: boolean;
    maxLockIn?: number;
    extension?: PublicKeyT | null;
    remaining?: anchor.web3.AccountMeta[];
  };
  const deposit = async (p: Pool, who: KeypairT, amount: number, o: DepositOpts = {}) => {
    const seq = (await program.account.pool.fetch(p.pool, "confirmed")).nextDepositSeq;
    const record = pda(["deposit", p.pool, u64(seq)]);
    const position = pda(["position", p.pool, who.publicKey]);
    const nonce = o.nonce ?? ((await program.account.position.fetchNullable(position, "confirmed"))?.nonce.toNumber() ?? 0);
    const expiry = o.expiry ?? (await chainNow()) + 600;
    const signature = await program.methods
      .deposit(new BN(amount), new BN(expiry), new BN(o.maxLockIn ?? 1_000_000))
      .accountsPartial({
        depositor: who.publicKey,
        pool: p.pool,
        position,
        deposit: record,
        vault: p.vault,
        depositorToken: ata(who.publicKey),
        usdcMint: mint,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        hook: pda(["hook", p.pool]),
        extensionProgram: o.extension ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(o.remaining ?? [])
      .preInstructions(o.noAttestation ? [] : [approval(p.pool, o.approveFor ?? who.publicKey, nonce, expiry, o.signer)])
      .signers([who])
      .rpc(confirmed);
    return { record, position, seq, signature };
  };
  const request = async (p: Pool, who: KeypairT, record: PublicKeyT, amount: number, maxNotice = 1_000_000) => {
    const seq = (await program.account.pool.fetch(p.pool, "confirmed")).nextRequestSeq;
    const req = pda(["request", p.pool, u64(seq)]);
    const signature = await program.methods
      .requestWithdrawal(new BN(amount), new BN(maxNotice))
      .accountsPartial({ depositor: who.publicKey, pool: p.pool, deposit: record, request: req, systemProgram: SystemProgram.programId })
      .signers([who])
      .rpc(confirmed);
    return { request: req, seq, signature };
  };
  type ProcessOpts = { seq?: BN; requesterToken?: PublicKeyT; extension?: PublicKeyT | null; remaining?: anchor.web3.AccountMeta[] };
  const processQueue = async (p: Pool, o: ProcessOpts = {}) => {
    const seq = o.seq ?? (await program.account.pool.fetch(p.pool, "confirmed")).headSeq;
    const req = pda(["request", p.pool, u64(seq)]);
    const r = await program.account.withdrawalRequest.fetch(req, "confirmed");
    return program.methods
      .processQueue()
      .accountsPartial({
        pool: p.pool,
        request: req,
        deposit: r.deposit,
        position: pda(["position", p.pool, r.depositor]),
        vault: p.vault,
        requesterToken: o.requesterToken ?? ata(r.depositor),
        usdcMint: mint,
        hook: pda(["hook", p.pool]),
        extensionProgram: o.extension ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts(o.remaining ?? [])
      .rpc(confirmed);
  };
  const reject = async (p: Pool, record: PublicKeyT, o: { signer?: KeypairT; to?: PublicKeyT } = {}) => {
    const d = await program.account.depositRecord.fetch(record, "confirmed");
    const signer = o.signer ?? authority;
    return program.methods
      .rejectDeposit()
      .accountsPartial({
        authority: signer.publicKey,
        pool: p.pool,
        deposit: record,
        position: pda(["position", p.pool, d.depositor]),
        vault: p.vault,
        depositorToken: o.to ?? ata(d.depositor),
        usdcMint: mint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc(confirmed);
  };
  const authorityCall = (method: string, p: Pool, args: unknown[], signer: KeypairT = authority) =>
    (program.methods as any)[method](...args).accountsPartial({ authority: signer.publicKey, pool: p.pool }).signers([signer]).rpc(confirmed);
  const healthPause = (p: Pool, paused: boolean, signer: KeypairT = healthAuthority) =>
    program.methods.setHealthPause(paused).accountsPartial({ signer: signer.publicKey, pool: p.pool }).signers([signer]).rpc(confirmed);
  const applyTerms = (p: Pool) => program.methods.applyTerms().accountsPartial({ pool: p.pool }).rpc(confirmed);
  const attestObligations = (p: Pool, obligations: number, asOf: number, signers: KeypairT[] = [attester]) =>
    program.methods
      .attestObligations(new BN(obligations), new BN(asOf))
      .accountsPartial({ pool: p.pool, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions(signers.map((s) => obligationsAttestation(p.pool, obligations, asOf, s)))
      .rpc(confirmed);

  before(async () => {
    // A fresh local validator can refuse the first transactions ("Blockhash not found"); wait until it's healthy and
    // has produced some blocks, as Anchor 0.32.2's own test runner does.
    await ready();
    while ((await connection.getBlockHeight("confirmed")) < 25) await sleep(400);
    cluster = Array.from(anchor.utils.bytes.bs58.decode(await connection.getGenesisHash()));
    await fund(authority.publicKey, healthAuthority.publicKey, stranger.publicKey);
    // The mint can freeze accounts, as USDC's issuer can.
    mint = await retry(() => createMint(connection, payer, payer.publicKey, payer.publicKey, 6, undefined, confirmed));
    await tokenAccount(authority.publicKey);
    await tokenAccount(stranger.publicKey);
  });

  it("opens a pool whose terms are account state and whose vault only the pool's PDA owns", async () => {
    const p = await createPool({ lockInSeconds: new BN(30), noticeSeconds: new BN(1) }, { minLockInSeconds: new BN(30) });
    const state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.terms.lockInSeconds.toNumber(), 30);
    assert.equal(state.floor.minLockInSeconds.toNumber(), 30);
    assert.deepEqual(Array.from(state.cluster), cluster);
    assert.ok(state.authority.equals(authority.publicKey));
    assert.ok(state.vault.equals(p.vault));
    const vault = await getAccount(connection, p.vault, "confirmed");
    assert.ok(vault.owner.equals(p.pool), "the pool's PDA owns the vault");
    assert.equal(vault.delegate, null, "no delegate");
    assert.equal(vault.closeAuthority, null, "no close authority");
    assert.deepEqual((await events(p.signature)).map((e) => e.name), ["poolinitialized"]);
    // Terms outside the floor, or a timelock shorter than the notice period, are refused at the start too.
    await fails(createPool({ lockInSeconds: new BN(5) }, { minLockInSeconds: new BN(10) }), /TermsBelowFloor/);
    await fails(createPool({ lockInSeconds: new BN(50) }, { maxLockInSeconds: new BN(40) }), /TermsAboveMaximum/);
    await fails(createPool({ noticeSeconds: new BN(10) }, {}, 5), /TimelockTooShort/);
    // Admission bounds: a reserve that could hold all the principal, or a review window over 30 days.
    await fails(createPool({}, { maxReserveBps: 10_000 }), /InvalidTerms/);
    await fails(createPool({}, { reviewWindowSeconds: new BN(30 * 86_400 + 1) }), /InvalidTerms/);
  });

  it("takes deposits only from depositors an attester allowed, at the lock-in they agreed to, each its own record", async () => {
    const p = await createPool({ lockInSeconds: new BN(100), noticeSeconds: new BN(5) }, {}, 5);
    const d = await depositor();
    await fails(deposit(p, d, 10, { noAttestation: true }), /MissingAttestation/);
    await fails(deposit(p, d, 10, { signer: stranger }), /UnknownAttester/);
    await fails(deposit(p, d, 10, { approveFor: stranger.publicKey }), /AttestationMismatch/);
    await fails(deposit(p, d, 10, { nonce: 1 }), /AttestationMismatch/);
    await fails(deposit(p, d, 10, { expiry: (await chainNow()) - 5 }), /AttestationExpired/);
    await fails(deposit(p, d, 10, { maxLockIn: 99 }), /TermsChanged/);
    const first = await deposit(p, d, 10, { maxLockIn: 100 });
    const second = await deposit(p, d, 15);
    const a = await program.account.depositRecord.fetch(first.record, "confirmed");
    const b = await program.account.depositRecord.fetch(second.record, "confirmed");
    assert.equal(a.amount.toNumber(), 10);
    assert.equal(a.unlockAt.toNumber(), a.settledAt.toNumber() + 100);
    assert.equal(a.lockInSeconds.toNumber(), 100);
    assert.equal(a.noticeSeconds.toNumber(), 5);
    assert.equal(b.seq.toNumber(), 1);
    const position = await program.account.position.fetch(first.position, "confirmed");
    assert.equal(position.principal.toNumber(), 25);
    assert.equal(await balance(p.vault), 25);
    const [made] = await events(first.signature);
    assert.equal(made.name, "depositmade");
    assert.equal(made.data.amount.toNumber(), 10);

    // An attester removed by the authority admits no one, at once.
    await fails(authorityCall("removeAttester", p, [attester.publicKey], stranger), /ConstraintHasOne|has.one/i);
    const removed = await authorityCall("removeAttester", p, [attester.publicKey]);
    assert.equal((await events(removed))[0].name, "attesterremoved");
    await fails(deposit(p, d, 10), /UnknownAttester/);
  });

  it("keeps each depositor's principal within the commitments, and requests above the minimum size", async () => {
    const p = await createPool({ commitmentMin: new BN(100), commitmentMax: new BN(500), minRequest: new BN(50), noticeSeconds: new BN(5) }, {}, 5);
    const d = await depositor();
    await fails(deposit(p, d, 50), /BelowCommitmentMin/);
    const dep = await deposit(p, d, 100);
    await fails(deposit(p, d, 401), /AboveCommitmentMax/);
    await deposit(p, d, 400);
    await fails(request(p, d, dep.record, 10), /BelowMinRequest/);
    await fails(request(p, d, dep.record, 60, 4), /TermsChanged/); // the depositor expects at most 4s of notice
    await request(p, d, dep.record, 60);
    await request(p, d, dep.record, 40); // under the minimum, but all that's left of the deposit
  });

  it("(b) a health pause lets existing depositors top up only when the terms say so; a sponsor pause refuses deposits but never exits", async () => {
    const withTopups = await createPool({ topupsWhenHealthPaused: true });
    const without = await createPool({ topupsWhenHealthPaused: false });
    const d = await depositor();
    const newcomer = await depositor();
    const before = await deposit(without, d, 100);
    await deposit(withTopups, d, 10);

    await fails(healthPause(without, true, stranger), /Unauthorized/);
    await fails(authorityCall("setSponsorPause", without, [true], stranger), /ConstraintHasOne|has.one/i);
    await healthPause(withTopups, true);
    await healthPause(without, true);
    await deposit(withTopups, d, 10);
    await fails(deposit(withTopups, newcomer, 10), /TopUpsOnly/);
    await fails(deposit(without, d, 10), /DepositsPausedForHealth/);
    // Each keeps its own flag: the health authority can't lift a health pause the authority set.
    await healthPause(without, true, authority);
    await healthPause(without, false);
    await fails(deposit(without, d, 10), /DepositsPausedForHealth/);
    assert.equal((await program.account.pool.fetch(without.pool, "confirmed")).healthPausedByAuthority, true);

    const sig = await authorityCall("setSponsorPause", without, [true]);
    assert.equal((await events(sig))[0].name, "pausechanged");
    await authorityCall("setSponsorPause", withTopups, [true]);
    await fails(deposit(withTopups, d, 10), /DepositsPaused/);
    await fails(deposit(without, d, 10), /DepositsPaused/);

    // Paused both ways, exits still go through.
    const held = await balance(ata(d.publicKey));
    await request(without, d, before.record, 100);
    await processQueue(without);
    assert.equal(await balance(ata(d.publicKey)), held + 100);
    assert.equal(await balance(without.vault), 0);
    // And no instruction can pause them: only these two touch the pause flags, and neither is an exit.
    const names = program.idl.instructions.map((i) => i.name);
    assert.deepEqual(names.filter((n) => /pause/i.test(n)).sort(), ["setHealthPause", "setSponsorPause"].sort());
  });

  it("(a) refuses deposits only during their review window, never pays locked money, and a refusal spends the attestation", async () => {
    const p = await createPool({}, { reviewWindowSeconds: new BN(4) }, 2);
    const d = await depositor();
    const refused = await deposit(p, d, 100); // lock-in 0, but under review for 4s
    await fails(request(p, d, refused.record, 100), /InReview/);
    await fails(reject(p, refused.record, { signer: stranger }), /ConstraintHasOne|has.one/i);
    const held = await balance(ata(d.publicKey));
    const r = await reject(p, refused.record);
    const [ev] = await events(r);
    assert.equal(ev.name, "depositrejected");
    assert.equal(ev.data.nonce.toNumber(), 1);
    assert.equal(await balance(ata(d.publicKey)), held + 100, "the refused deposit went back to the depositor");
    await fails(reject(p, refused.record), /DepositRejected/);
    await fails(deposit(p, d, 100, { nonce: 0 }), /AttestationMismatch/); // the old attestation is spent
    const accepted = await deposit(p, d, 100); // a fresh one, at nonce 1

    const effective = (await chainNow()) + 4;
    await authorityCall("proposeTerms", p, [terms({ lockInSeconds: new BN(3600) }), new BN(effective)]);
    await waitUntil(effective);
    await applyTerms(p);
    const locked = await deposit(p, d, 100); // locked for an hour
    assert.isAbove((await program.account.depositRecord.fetch(locked.record, "confirmed")).unlockAt.toNumber(), (await chainNow()) + 3000);

    await waitUntil((await program.account.depositRecord.fetch(locked.record, "confirmed")).reviewUntil.toNumber());
    await fails(reject(p, accepted.record), /ReviewWindowClosed/);
    await fails(request(p, d, locked.record, 1), /DepositLocked/);
    await request(p, d, accepted.record, 100);
    await fails(request(p, d, accepted.record, 1), /ExceedsUnlocked/);
    await fails(request(p, d, refused.record, 1), /DepositRejected/);

    const before = await balance(ata(d.publicKey));
    await processQueue(p);
    assert.equal(await balance(ata(d.publicKey)), before + 100);
    assert.equal(await balance(p.vault), 100, "the locked deposit stays in the vault");
    const left = await program.account.depositRecord.fetch(locked.record, "confirmed");
    assert.equal(left.remaining.toNumber(), 100);
    const state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.totalQueued.toNumber(), 0);
    assert.equal(state.totalPrincipal.toNumber(), 100);
    assert.equal(state.headSeq.toNumber(), state.nextRequestSeq.toNumber(), "the queue is empty");
  });

  it("(c) changes terms only after the timelock, within the floor both ways, and only for new deposits", async () => {
    const base = { lockInSeconds: new BN(10), noticeSeconds: new BN(1), minReserveBps: 100, commitmentMax: new BN(1_000_000) };
    const p = await createPool(base, {
      minLockInSeconds: new BN(10),
      maxLockInSeconds: new BN(30),
      minNoticeSeconds: new BN(1),
      maxNoticeSeconds: new BN(20),
      minReserveBps: 100,
      maxReserveBps: 2000,
      maxCommitment: new BN(1_000_000),
      maxObligationsStaleness: new BN(3600),
      topupsWhenHealthPausedAllowed: false,
      reviewWindowSeconds: new BN(35),
    }, 3);
    const d = await depositor();
    const early = await deposit(p, d, 10);
    const earlyUnlock = (await program.account.depositRecord.fetch(early.record, "confirmed")).unlockAt.toNumber();

    const later = (await chainNow()) + 60;
    for (const lax of [
      { lockInSeconds: new BN(9) },
      { noticeSeconds: new BN(0) },
      { minReserveBps: 99 },
      { commitmentMax: new BN(1_000_001) },
      { obligationsMaxStaleness: new BN(3601) },
      { topupsWhenHealthPaused: true },
    ]) {
      await fails(authorityCall("proposeTerms", p, [terms({ ...base, ...lax }), new BN(later)]), /TermsBelowFloor/);
    }
    for (const tight of [{ lockInSeconds: new BN(31) }, { noticeSeconds: new BN(21) }, { minReserveBps: 2001 }]) {
      await fails(authorityCall("proposeTerms", p, [terms({ ...base, ...tight }), new BN(later)]), /TermsAboveMaximum/);
    }
    // A higher reserve binds deposits already made, so it waits out the longer of the floor's longest lock-in and its
    // review window, plus its longest notice: max(30, 35) + 20.
    await fails(authorityCall("proposeTerms", p, [terms({ ...base, minReserveBps: 200 }), new BN((await chainNow()) + 52)]), /TimelockTooShort/);
    await authorityCall("proposeTerms", p, [terms({ ...base, minReserveBps: 200 }), new BN((await chainNow()) + 60)]);
    await authorityCall("cancelTerms", p, []);
    await fails(applyTerms(p), /NoPendingTerms/);

    const stricter = terms({ ...base, lockInSeconds: new BN(20), noticeSeconds: new BN(3) });
    await fails(authorityCall("proposeTerms", p, [stricter, new BN(later)], stranger), /ConstraintHasOne|has.one/i);
    await fails(authorityCall("proposeTerms", p, [stricter, new BN((await chainNow()) + 1)]), /TimelockTooShort/);
    const effective = (await chainNow()) + 5;
    const proposed = await authorityCall("proposeTerms", p, [stricter, new BN(effective)]);
    assert.equal((await events(proposed))[0].name, "termsproposed");
    await fails(applyTerms(p), /TermsNotEffective/);
    await waitUntil(effective);
    const applied = await applyTerms(p); // permissionless
    assert.equal((await events(applied))[0].name, "termsapplied");
    assert.equal((await program.account.pool.fetch(p.pool, "confirmed")).terms.lockInSeconds.toNumber(), 20);

    const e = await program.account.depositRecord.fetch(early.record, "confirmed");
    assert.equal(e.unlockAt.toNumber(), earlyUnlock, "an existing deposit keeps its lock-in");
    assert.equal(e.noticeSeconds.toNumber(), 1, "and its notice");
    const fresh = await deposit(p, d, 10);
    const f = await program.account.depositRecord.fetch(fresh.record, "confirmed");
    assert.equal(f.unlockAt.toNumber(), f.settledAt.toNumber() + 20);
    // The early deposit's request gets its own 1s notice, not the new 3s.
    await waitUntil(Math.max(earlyUnlock, e.reviewUntil.toNumber()));
    const r = await request(p, d, early.record, 10, 1);
    const req = await program.account.withdrawalRequest.fetch(r.request, "confirmed");
    assert.equal(req.payableAt.toNumber() - req.requestedAt.toNumber(), 1);
  });

  it("(d)(e) pays strictly from the head, keeps a partly paid request at the head, and never goes below the reserve floor", async () => {
    // The fixed floor is 60, capped at 50% of the principal still owed.
    const p = await createPool({ minReserve: new BN(60) }, { maxReserveBps: 5000 });
    const x = await depositor();
    const y = await depositor();
    const z = await depositor();
    const dx = await deposit(p, x, 100);
    const dy = await deposit(p, y, 50);
    const rx = await request(p, x, dx.record, 100);
    const ry = await request(p, y, dy.record, 50);

    await fails(processQueue(p, { seq: ry.seq }), /ConstraintSeeds|seeds constraint/i);
    const paid = async () => (await events(await processQueue(p))).find((e) => e.name === "withdrawalpaid")!.data;

    const xHeld = await balance(ata(x.publicKey));
    const yHeld = await balance(ata(y.publicKey));
    let pay = await paid(); // principal 150: floor min(60, 75) = 60
    assert.equal(pay.amount.toNumber(), 90);
    assert.equal(pay.partial, true);
    assert.equal(pay.reserveFloor.toNumber(), 60);
    assert.equal(pay.vaultAfter.toNumber(), 60, "paid down to the floor, no further");
    let state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.headSeq.toNumber(), rx.seq.toNumber(), "a partial fill stays at the head");
    assert.equal((await program.account.withdrawalRequest.fetch(rx.request, "confirmed")).remaining.toNumber(), 70 - 60);
    assert.equal(await balance(ata(y.publicKey)), yHeld, "nothing behind the head is paid");

    pay = await paid(); // principal 60: floor min(60, 30) = 30
    assert.equal(pay.amount.toNumber(), 10);
    assert.equal(pay.partial, false);
    assert.equal(await balance(ata(x.publicKey)), xHeld + 100);
    state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.headSeq.toNumber(), ry.seq.toNumber());

    pay = await paid(); // principal 50: floor min(60, 25) = 25
    assert.equal(pay.amount.toNumber(), 25);
    assert.equal(pay.partial, true);
    assert.equal(pay.vaultAfter.toNumber(), pay.reserveFloor.toNumber());

    const snap = await program.methods.snapshot().accountsPartial({ pool: p.pool, vault: p.vault }).rpc(confirmed);
    const s = (await events(snap))[0];
    assert.equal(s.name, "poolsnapshot");
    assert.equal(s.data.vaultBalance.toNumber(), 25);
    assert.equal(s.data.reserveFloor.toNumber(), 12);
    assert.equal(s.data.totalQueued.toNumber(), 25);

    await deposit(p, z, 100); // principal 125: floor min(60, 62) = 60
    pay = await paid();
    assert.equal(pay.amount.toNumber(), 25);
    assert.equal(await balance(ata(y.publicKey)), yHeld + 50);
    assert.equal(await balance(p.vault), 100);
  });

  it("(e) measures the reserve against attested obligations: rises need both attesters, and the floor is capped", async () => {
    const p = await createPool({ minReserveBps: 5000, obligationsMaxStaleness: new BN(60), attesters: [attester.publicKey, attester2.publicKey] }, { maxReserveBps: 9000 });
    const d = await depositor();
    const dep = await deposit(p, d, 100);
    const now = await chainNow();
    await fails(attestObligations(p, 161, now - 120, [attester, attester2]), /AttestationStale/);
    await fails(attestObligations(p, 161, now, [attester]), /MissingAttestation|NeedsTwoAttesters/);
    await fails(attestObligations(p, 161, now, [attester, attester]), /NeedsTwoAttesters/);
    await fails(attestObligations(p, 161, now, [attester, stranger]), /UnknownAttester/);
    const sig = await attestObligations(p, 161, now, [attester, attester2]);
    const [ev] = await events(sig);
    assert.equal(ev.data.attesters, 2);
    assert.equal(ev.data.reserveFloor.toNumber(), 81, "rounded up: 161 x 50% = 80.5");
    await fails(attestObligations(p, 161, now, [attester, attester2]), /AttestationStale/); // not newer than the last
    await request(p, d, dep.record, 100);
    const held = await balance(ata(d.publicKey));
    await processQueue(p);
    assert.equal(await balance(ata(d.publicKey)), held + 19);
    assert.equal(await balance(p.vault), 81);

    // A huge figure can't shut every exit: the floor is capped at 90% of the principal still owed (81 → 72).
    await waitUntil(now + 1);
    const capped = await attestObligations(p, 1_000_000, now + 1, [attester2, attester]);
    assert.equal((await events(capped))[0].data.reserveFloor.toNumber(), 72);
    await processQueue(p);
    assert.equal(await balance(p.vault), 72);
    // A falling figure needs one attester.
    await waitUntil(now + 2);
    await attestObligations(p, 0, now + 2, [attester]);
    await processQueue(p);
    assert.equal(await balance(ata(d.publicKey)), held + 100);
  });

  it("(f) has no instruction that moves vault funds to the authority", async () => {
    const names = program.idl.instructions.map((i) => i.name).sort();
    assert.deepEqual(
      names,
      [
        "applyTerms", "attestObligations", "cancelRequest", "cancelTerms", "cancelWindDown", "claimParked", "claimSurplus", "deposit",
        "initializePool", "parkHead", "processQueue", "proposeTerms", "proposeWindDown", "rejectDeposit", "removeAttester",
        "requestWithdrawal", "setHealthPause", "setSponsorPause", "snapshot", "startWindDown",
      ].sort(),
      "a new instruction needs its own review",
    );
    // The vault is writable only where it's created, paid into, or paid out of to a depositor.
    const writesVault = program.idl.instructions.filter((i) => (i.accounts as any[]).some((a) => a.name === "vault" && a.writable)).map((i) => i.name).sort();
    assert.deepEqual(writesVault, ["claimParked", "claimSurplus", "deposit", "initializePool", "processQueue", "rejectDeposit"]);

    const authorityToken = ata(authority.publicKey);
    const reviewed = await createPool({}, { reviewWindowSeconds: new BN(600) });
    const d = await depositor();
    const held = await deposit(reviewed, d, 100);
    await fails(reject(reviewed, held.record, { to: authorityToken }), /ConstraintAddress|address constraint/i);
    await reject(reviewed, held.record);

    const p = await createPool();
    const dep = await deposit(p, d, 100);
    await request(p, d, dep.record, 40);
    await fails(processQueue(p, { requesterToken: authorityToken }), /ConstraintAddress|address constraint/i);
    await processQueue(p);
    assert.equal(await balance(authorityToken), 0, "the authority never received anything");
    assert.equal(await balance(p.vault), 60);
  });

  it("parks a request whose account is frozen, so the queue moves on, and pays it once thawed", async () => {
    const p = await createPool();
    const x = await depositor();
    const y = await depositor();
    const dx = await deposit(p, x, 100);
    const dy = await deposit(p, y, 50);
    const rx = await request(p, x, dx.record, 100);
    await request(p, y, dy.record, 50);
    const park = () =>
      program.methods.parkHead().accountsPartial({ pool: p.pool, request: pda(["request", p.pool, u64(rx.seq)]), requesterToken: ata(x.publicKey) }).rpc(confirmed);
    const claim = () =>
      program.methods
        .claimParked()
        .accountsPartial({ pool: p.pool, request: rx.request, deposit: dx.record, position: pda(["position", p.pool, x.publicKey]), vault: p.vault, requesterToken: ata(x.publicKey), usdcMint: mint, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(confirmed);

    await fails(park(), /NotFrozen/);
    await retry(() => freezeAccount(connection, payer, ata(x.publicKey), mint, payer, [], confirmed));
    await fails(processQueue(p), /frozen/i);
    const parked = await park();
    assert.include((await events(parked)).map((e) => e.name), "requestparked");
    const yHeld = await balance(ata(y.publicKey));
    await processQueue(p); // the next one is paid
    assert.equal(await balance(ata(y.publicKey)), yHeld + 50);
    await fails(claim(), /frozen/i);

    await retry(() => thawAccount(connection, payer, ata(x.publicKey), mint, payer, [], confirmed));
    const xHeld = await balance(ata(x.publicKey));
    const claimed = await claim();
    assert.equal(await balance(ata(x.publicKey)), xHeld + 100);
    assert.equal((await events(claimed)).find((e) => e.name === "withdrawalpaid")!.data.parked, true);
    await fails(claim(), /NotParked/);
    const state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.totalParked.toNumber(), 0);
    assert.equal(state.totalQueued.toNumber(), 0);
  });

  it("winds down after a timelock: deposits close, lock-ins and the floor lift, and the surplus goes pro rata", async () => {
    const p = await createPool({ lockInSeconds: new BN(3600), minReserve: new BN(50) }, {}, 2);
    const x = await depositor();
    const y = await depositor();
    const dx = await deposit(p, x, 100);
    const dy = await deposit(p, y, 50);
    await retry(() => mintTo(connection, payer, mint, p.vault, payer, 30, [], confirmed)); // a surplus above principal
    await fails(request(p, x, dx.record, 100), /DepositLocked/);

    await fails(authorityCall("proposeWindDown", p, [new BN((await chainNow()) + 1)]), /TimelockTooShort/);
    await fails(authorityCall("proposeWindDown", p, [new BN((await chainNow()) + 60)], stranger), /ConstraintHasOne|has.one/i);
    const at = (await chainNow()) + 4;
    await authorityCall("proposeWindDown", p, [new BN(at)]);
    await fails(deposit(p, x, 10), /WindingDown/); // closed from the proposal, not from when it takes effect
    await fails(program.methods.startWindDown().accountsPartial({ pool: p.pool, vault: p.vault }).rpc(confirmed), /NotWindingDown/);
    await waitUntil(at);
    await fails(deposit(p, x, 10), /WindingDown/);
    await fails(authorityCall("cancelWindDown", p, []), /WindingDown/);
    const started = await program.methods.startWindDown().accountsPartial({ pool: p.pool, vault: p.vault }).rpc(confirmed);
    const [ev] = await events(started);
    assert.equal(ev.data.surplus.toNumber(), 30);

    const xHeld = await balance(ata(x.publicKey));
    const yHeld = await balance(ata(y.publicKey));
    await request(p, x, dx.record, 100); // the lock-in no longer holds
    await request(p, y, dy.record, 50);
    await processQueue(p);
    await processQueue(p); // and the floor is zero
    const claim = (who: KeypairT) =>
      program.methods
        .claimSurplus()
        .accountsPartial({ pool: p.pool, position: pda(["position", p.pool, who.publicKey]), vault: p.vault, depositorToken: ata(who.publicKey), usdcMint: mint, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(confirmed);
    await claim(x);
    await claim(y);
    await fails(claim(x), /SurplusClaimed/);
    assert.equal(await balance(ata(x.publicKey)), xHeld + 100 + 20);
    assert.equal(await balance(ata(y.publicKey)), yHeld + 50 + 10);
    assert.equal(await balance(p.vault), 0);
  });

  it("shares a wind-down's surplus by principal at the proposal, so cycling deposits through the queue buys nothing", async () => {
    const p = await createPool({}, {}, 2);
    const honest = await depositor();
    const cycler = await depositor(1_000);
    await deposit(p, honest, 100);
    // Deposit, withdraw, deposit again: 400 deposited in all, never more than 100 outstanding.
    let last = await deposit(p, cycler, 100);
    for (let i = 0; i < 3; i++) {
      await request(p, cycler, last.record, 100);
      await processQueue(p);
      last = await deposit(p, cycler, 100);
    }
    assert.equal((await program.account.position.fetch(last.position, "confirmed")).deposited.toNumber(), 400);
    await retry(() => mintTo(connection, payer, mint, p.vault, payer, 30, [], confirmed)); // the surplus

    const at = (await chainNow()) + 4;
    const proposed = await authorityCall("proposeWindDown", p, [new BN(at)]);
    assert.equal((await events(proposed))[0].data.principal.toNumber(), 200);
    await fails(deposit(p, cycler, 100), /WindingDown/);
    // Paid out before the wind-down starts: the share still counts what was outstanding at the proposal.
    await request(p, cycler, last.record, 100);
    await processQueue(p);
    await waitUntil(at);
    await program.methods.startWindDown().accountsPartial({ pool: p.pool, vault: p.vault }).rpc(confirmed);
    const claim = (who: KeypairT) =>
      program.methods
        .claimSurplus()
        .accountsPartial({ pool: p.pool, position: pda(["position", p.pool, who.publicKey]), vault: p.vault, depositorToken: ata(who.publicKey), usdcMint: mint, tokenProgram: TOKEN_PROGRAM_ID })
        .rpc(confirmed);
    const shares = [];
    for (const who of [honest, cycler]) {
      const sig = await claim(who);
      shares.push((await events(sig)).find((e) => e.name === "surplusclaimed")!.data.amount.toNumber());
    }
    assert.deepEqual(shares, [15, 15], "by principal at the proposal (100 each), not by everything ever deposited (100 vs 400)");
  });

  it("(g) calls an extension, signed only by the pool's hook PDA, but the extension can never sign for the vault", async () => {
    const probeState = pda(["probe"], probe.programId);
    await probe.methods.initProbe(0).accountsPartial({ probe: probeState, payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc(confirmed);
    const setMode = (mode: number) => probe.methods.setMode(mode).accountsPartial({ probe: probeState }).rpc(confirmed);
    const p = await createPool({ extensionProgram: probe.programId });
    const d = await depositor();
    const own = [{ pubkey: probeState, isSigner: false, isWritable: true }];

    await fails(deposit(p, d, 100), /ExtensionMissing/);
    await fails(deposit(p, d, 100, { extension: TOKEN_PROGRAM_ID, remaining: own }), /WrongExtension/);
    const ok = await deposit(p, d, 100, { extension: probe.programId, remaining: own });
    const state = await probe.account.probe.fetch(probeState, "confirmed");
    assert.equal(state.calls.toNumber(), 1);
    assert.equal(state.lastKind, 0);
    assert.equal(state.lastAmount.toNumber(), 100);
    assert.equal(state.hookWasSigner, true, "the hook PDA signs, so the extension knows the call is the treasury's");
    assert.equal(state.poolWasSigner, false, "the pool is never a signer for the extension");
    assert.equal(state.poolWasWritable, false, "nor writable");
    assert.include((await events(ok.signature)).map((e) => e.name), "extensionhook");

    // Hostile: it tries to move the vault's USDC with the pool as authority. The runtime refuses: the pool never signed.
    await setMode(1);
    const thief = ata(stranger.publicKey);
    // Even asked for writable, the vault and the thief's account reach the extension read-only, and the pool never as a signer.
    const attack = [...own, { pubkey: p.vault, isSigner: false, isWritable: true }, { pubkey: thief, isSigner: false, isWritable: true }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }];
    await fails(deposit(p, d, 50, { extension: probe.programId, remaining: attack }), /unauthorized signer or writable account|PrivilegeEscalation|privilege/i);
    await request(p, d, ok.record, 100);
    await fails(processQueue(p, { extension: probe.programId, remaining: attack }), /unauthorized signer or writable account|PrivilegeEscalation|privilege/i);
    assert.equal(await balance(p.vault), 100);
    assert.equal(await balance(thief), 0);

    // And it can't hold up an exit: the hook on payments is best effort, so the queue is paid without it.
    const held = await balance(ata(d.publicKey));
    const paid = await processQueue(p);
    assert.equal(await balance(ata(d.publicKey)), held + 100);
    const hook = (await events(paid)).find((e) => e.name === "extensionhook")!;
    assert.equal(hook.data.called, false);
    await setMode(0);
  });
});
