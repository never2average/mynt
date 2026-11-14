import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import { TOKEN_PROGRAM_ID, createMint, getAccount, getAssociatedTokenAddressSync, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { MyntTreasury } from "../target/types/mynt_treasury";
import { ExtensionProbe } from "../target/types/extension_probe";

const { PublicKey, Keypair, SystemProgram, Ed25519Program, SYSVAR_INSTRUCTIONS_PUBKEY, SYSVAR_CLOCK_PUBKEY, Transaction } = anchor.web3;
type PublicKeyT = anchor.web3.PublicKey;
type KeypairT = anchor.web3.Keypair;

// Runs on the local validator `anchor test` starts. Mynt runs these again, in its own clean sandbox, against the
// programs it built verifiably. Each rule of the treasury has its own pool here, so the cases don't share state.
describe("mynt_treasury", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const program = anchor.workspace.myntTreasury as Program<MyntTreasury>;
  const probe = anchor.workspace.extensionProbe as Program<ExtensionProbe>;
  const confirmed = { commitment: "confirmed" as const };

  const authority = Keypair.generate(); // in production a Squads vault PDA; any key works here
  const healthAuthority = Keypair.generate();
  const attester = Keypair.generate();
  const stranger = Keypair.generate();
  let mint: PublicKeyT;
  let nextPoolId = 1;

  const u64 = (n: number | BN) => new BN(n).toArrayLike(Buffer, "le", 8);
  const i64 = (n: number | BN) => new BN(n).toTwos(64).toArrayLike(Buffer, "le", 8);
  const pda = (seeds: (string | Buffer | PublicKeyT)[], programId = program.programId) =>
    PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.isBuffer(s) ? s : s.toBuffer())), programId)[0];
  const ata = (owner: PublicKeyT) => getAssociatedTokenAddressSync(mint, owner);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const chainNow = async () => Number((await connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, "confirmed"))!.data.readBigInt64LE(32));
  const waitUntil = async (t: number) => {
    while ((await chainNow()) < t) await sleep(400);
  };
  const balance = async (account: PublicKeyT) => Number((await getAccount(connection, account, "confirmed")).amount);
  const fails = async (p: Promise<unknown>, re: RegExp) => {
    try {
      await p;
    } catch (e: any) {
      const text = `${e}\n${(e?.logs ?? e?.transactionLogs ?? []).join("\n")}`;
      assert.match(text, re);
      return;
    }
    assert.fail(`expected a failure matching ${re}`);
  };
  const events = async (signature: string) => {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const parser = new anchor.EventParser(program.programId, new anchor.BorshCoder(program.idl));
    return [...parser.parseLogs(tx?.meta?.logMessages ?? [])].map((e) => ({ name: e.name.toLowerCase(), data: e.data as any }));
  };
  const fund = async (...keys: PublicKeyT[]) => {
    const tx = new Transaction();
    for (const k of keys) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k, lamports: 2 * anchor.web3.LAMPORTS_PER_SOL }));
    await provider.sendAndConfirm(tx, [], confirmed);
  };
  const tokenAccount = async (owner: PublicKeyT, amount = 0) => {
    const account = await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner, true, "confirmed");
    if (amount) await mintTo(connection, payer, mint, account.address, payer, amount, [], { commitment: "confirmed" });
    return account.address;
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
    topupsWhenHealthPaused: false,
    extensionProgram: PublicKey.default,
    attesters: [attester.publicKey, PublicKey.default],
    healthAuthority: healthAuthority.publicKey,
    ...t,
  });
  const floor = (f: Record<string, unknown> = {}) => ({
    minLockInSeconds: new BN(0),
    minNoticeSeconds: new BN(0),
    minReserve: new BN(0),
    minReserveBps: 0,
    maxObligationsStaleness: new BN(86_400),
    minCommitment: new BN(0),
    maxCommitment: new BN(10_000_000_000),
    topupsWhenHealthPausedAllowed: true,
    ...f,
  });

  type Pool = { pool: PublicKeyT; vault: PublicKeyT; signature: string };
  const createPool = async (t: Record<string, unknown> = {}, f: Record<string, unknown> = {}, minTimelock = 2): Promise<Pool> => {
    const poolId = new BN(nextPoolId++);
    const pool = pda(["pool", payer.publicKey, u64(poolId)]);
    const vault = pda(["vault", pool]);
    const signature = await program.methods
      .initializePool(poolId, terms(t) as any, floor(f) as any, new BN(minTimelock))
      .accountsPartial({ creator: payer.publicKey, authority: authority.publicKey, pool, usdcMint: mint, vault, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId })
      .rpc(confirmed);
    return { pool, vault, signature };
  };

  const approval = (pool: PublicKeyT, who: PublicKeyT, expiry: number, signer: KeypairT = attester) =>
    Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer.secretKey,
      message: Buffer.concat([Buffer.from("MYNTDEP1"), program.programId.toBuffer(), pool.toBuffer(), who.toBuffer(), i64(expiry)]),
    });
  const obligationsAttestation = (pool: PublicKeyT, obligations: number, asOf: number, signer: KeypairT = attester) =>
    Ed25519Program.createInstructionWithPrivateKey({
      privateKey: signer.secretKey,
      message: Buffer.concat([Buffer.from("MYNTOBL1"), program.programId.toBuffer(), pool.toBuffer(), u64(obligations), i64(asOf)]),
    });

  type DepositOpts = { expiry?: number; signer?: KeypairT; approveFor?: PublicKeyT; noAttestation?: boolean; extension?: PublicKeyT | null; remaining?: anchor.web3.AccountMeta[] };
  const deposit = async (p: Pool, who: KeypairT, amount: number, o: DepositOpts = {}) => {
    const seq = (await program.account.pool.fetch(p.pool, "confirmed")).nextDepositSeq;
    const record = pda(["deposit", p.pool, u64(seq)]);
    const position = pda(["position", p.pool, who.publicKey]);
    const expiry = o.expiry ?? (await chainNow()) + 600;
    const signature = await program.methods
      .deposit(new BN(amount), new BN(expiry))
      .accountsPartial({
        depositor: who.publicKey,
        pool: p.pool,
        position,
        deposit: record,
        vault: p.vault,
        depositorToken: ata(who.publicKey),
        usdcMint: mint,
        instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        extensionProgram: o.extension ?? null,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(o.remaining ?? [])
      .preInstructions(o.noAttestation ? [] : [approval(p.pool, o.approveFor ?? who.publicKey, expiry, o.signer)])
      .signers([who])
      .rpc(confirmed);
    return { record, position, seq, signature };
  };
  const request = async (p: Pool, who: KeypairT, record: PublicKeyT, amount: number) => {
    const seq = (await program.account.pool.fetch(p.pool, "confirmed")).nextRequestSeq;
    const req = pda(["request", p.pool, u64(seq)]);
    const signature = await program.methods
      .requestWithdrawal(new BN(amount))
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
  const authorityCall = (method: "setSponsorPause" | "proposeTerms" | "cancelTerms", p: Pool, args: unknown[], signer: KeypairT = authority) =>
    (program.methods as any)[method](...args).accountsPartial({ authority: signer.publicKey, pool: p.pool }).signers([signer]).rpc(confirmed);
  const healthPause = (p: Pool, paused: boolean, signer: KeypairT = healthAuthority) =>
    program.methods.setHealthPause(paused).accountsPartial({ signer: signer.publicKey, pool: p.pool }).signers([signer]).rpc(confirmed);
  const applyTerms = (p: Pool) => program.methods.applyTerms().accountsPartial({ pool: p.pool }).rpc(confirmed);
  const attestObligations = (p: Pool, obligations: number, asOf: number, signer: KeypairT = attester) =>
    program.methods
      .attestObligations(new BN(obligations), new BN(asOf))
      .accountsPartial({ pool: p.pool, instructions: SYSVAR_INSTRUCTIONS_PUBKEY })
      .preInstructions([obligationsAttestation(p.pool, obligations, asOf, signer)])
      .rpc(confirmed);

  before(async () => {
    // A fresh local validator can refuse the first transactions ("Blockhash not found"); wait until it has produced
    // some blocks, as Anchor 0.32.2's own test runner does.
    while ((await connection.getBlockHeight("confirmed")) < 25) await sleep(400);
    await fund(authority.publicKey, healthAuthority.publicKey, stranger.publicKey);
    mint = await createMint(connection, payer, payer.publicKey, null, 6, undefined, confirmed);
    await tokenAccount(authority.publicKey);
    await tokenAccount(stranger.publicKey);
  });

  it("opens a pool whose terms are account state and whose vault only the pool's PDA owns", async () => {
    const p = await createPool({ lockInSeconds: new BN(30), noticeSeconds: new BN(1) }, { minLockInSeconds: new BN(30) });
    const state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.terms.lockInSeconds.toNumber(), 30);
    assert.equal(state.floor.minLockInSeconds.toNumber(), 30);
    assert.ok(state.authority.equals(authority.publicKey));
    assert.ok(state.vault.equals(p.vault));
    const vault = await getAccount(connection, p.vault, "confirmed");
    assert.ok(vault.owner.equals(p.pool), "the pool's PDA owns the vault");
    assert.equal(vault.delegate, null, "no delegate");
    assert.equal(vault.closeAuthority, null, "no close authority");
    assert.deepEqual((await events(p.signature)).map((e) => e.name), ["poolinitialized"]);
    // Terms below the floor, or a timelock shorter than the notice period, are refused at the start too.
    await fails(createPool({ lockInSeconds: new BN(5) }, { minLockInSeconds: new BN(10) }), /TermsBelowFloor/);
    await fails(createPool({ noticeSeconds: new BN(10) }, {}, 5), /TimelockTooShort/);
  });

  it("takes deposits only from depositors an attester allowed, each its own record with the lock-in of the day", async () => {
    const p = await createPool({ lockInSeconds: new BN(100) });
    const d = await depositor();
    await fails(deposit(p, d, 10, { noAttestation: true }), /MissingAttestation/);
    await fails(deposit(p, d, 10, { signer: stranger }), /UnknownAttester/);
    await fails(deposit(p, d, 10, { approveFor: stranger.publicKey }), /AttestationMismatch/);
    await fails(deposit(p, d, 10, { expiry: (await chainNow()) - 5 }), /AttestationExpired/);
    const first = await deposit(p, d, 10);
    const second = await deposit(p, d, 15);
    const a = await program.account.depositRecord.fetch(first.record, "confirmed");
    const b = await program.account.depositRecord.fetch(second.record, "confirmed");
    assert.equal(a.amount.toNumber(), 10);
    assert.equal(a.unlockAt.toNumber(), a.settledAt.toNumber() + 100);
    assert.equal(a.lockInSeconds.toNumber(), 100);
    assert.equal(b.seq.toNumber(), 1);
    const position = await program.account.position.fetch(first.position, "confirmed");
    assert.equal(position.principal.toNumber(), 25);
    assert.equal(await balance(p.vault), 25);
    const [made] = await events(first.signature);
    assert.equal(made.name, "depositmade");
    assert.equal(made.data.amount.toNumber(), 10);
  });

  it("keeps each depositor's principal within the commitment minimum and maximum", async () => {
    const p = await createPool({ commitmentMin: new BN(100), commitmentMax: new BN(500) });
    const d = await depositor();
    await fails(deposit(p, d, 50), /BelowCommitmentMin/);
    await deposit(p, d, 100);
    await fails(deposit(p, d, 401), /AboveCommitmentMax/);
    await deposit(p, d, 400);
  });

  it("(b) a health pause lets top-ups in only when the terms say so; a sponsor pause refuses deposits but never exits", async () => {
    const withTopups = await createPool({ topupsWhenHealthPaused: true });
    const without = await createPool({ topupsWhenHealthPaused: false });
    const d = await depositor();
    const before = await deposit(without, d, 100);

    await fails(healthPause(without, true, stranger), /Unauthorized/);
    await fails(authorityCall("setSponsorPause", without, [true], stranger), /ConstraintHasOne|has.one/i);
    await healthPause(withTopups, true);
    await healthPause(without, true);
    await deposit(withTopups, d, 10);
    await fails(deposit(without, d, 10), /DepositsPausedForHealth/);

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

  it("(a) never pays locked money, even after the unlocked deposit a request was made against is rejected", async () => {
    const p = await createPool({}, {}, 2);
    const d = await depositor();
    const unlocked = await deposit(p, d, 100); // lock-in 0: unlocked at once
    const effective = (await chainNow()) + 3;
    await authorityCall("proposeTerms", p, [terms({ lockInSeconds: new BN(3600) }), new BN(effective)]);
    await waitUntil(effective);
    await applyTerms(p);
    const locked = await deposit(p, d, 100); // locked for an hour
    assert.isAbove((await program.account.depositRecord.fetch(locked.record, "confirmed")).unlockAt.toNumber(), (await chainNow()) + 3000);

    await fails(request(p, d, locked.record, 1), /DepositLocked/);
    await request(p, d, unlocked.record, 100);
    await fails(request(p, d, unlocked.record, 1), /ExceedsUnlocked/);

    const held = await balance(ata(d.publicKey));
    const rejected = await reject(p, unlocked.record);
    assert.equal((await events(rejected))[0].name, "depositrejected");
    assert.equal(await balance(ata(d.publicKey)), held + 100, "the rejected deposit went back to the depositor");
    assert.equal(await balance(p.vault), 100);

    // The request is re-checked at pay time: its deposit is gone, so it's voided and nothing of the locked one moves.
    const sig = await processQueue(p);
    assert.includeMembers((await events(sig)).map((e) => e.name), ["requestvoided", "queueadvanced"]);
    assert.equal(await balance(ata(d.publicKey)), held + 100);
    assert.equal(await balance(p.vault), 100);
    const left = await program.account.depositRecord.fetch(locked.record, "confirmed");
    assert.equal(left.remaining.toNumber(), 100);
    assert.equal(left.queued.toNumber(), 0);
    await fails(request(p, d, unlocked.record, 1), /DepositRejected/);
    await fails(reject(p, unlocked.record), /DepositRejected/);
    const state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.totalQueued.toNumber(), 0);
    assert.equal(state.totalPrincipal.toNumber(), 100);
    assert.equal(state.headSeq.toNumber(), state.nextRequestSeq.toNumber(), "the queue is empty");
  });

  it("(c) changes terms only after the timelock, never laxer than the product floor, and keeps each deposit's lock-in", async () => {
    const base = { lockInSeconds: new BN(10), noticeSeconds: new BN(1), minReserveBps: 100, commitmentMax: new BN(1_000_000) };
    const p = await createPool(base, { minLockInSeconds: new BN(10), minNoticeSeconds: new BN(1), minReserveBps: 100, maxCommitment: new BN(1_000_000), maxObligationsStaleness: new BN(3600), topupsWhenHealthPausedAllowed: false }, 3);
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
    const stricter = terms({ ...base, lockInSeconds: new BN(20) });
    await fails(authorityCall("proposeTerms", p, [stricter, new BN(later)], stranger), /ConstraintHasOne|has.one/i);
    await fails(authorityCall("proposeTerms", p, [stricter, new BN((await chainNow()) + 1)]), /TimelockTooShort/);

    // Proposed, then cancelled: nothing to apply.
    await authorityCall("proposeTerms", p, [stricter, new BN(later)]);
    await authorityCall("cancelTerms", p, []);
    await fails(applyTerms(p), /NoPendingTerms/);

    const effective = (await chainNow()) + 4;
    const proposed = await authorityCall("proposeTerms", p, [stricter, new BN(effective)]);
    assert.equal((await events(proposed))[0].name, "termsproposed");
    await fails(applyTerms(p), /TermsNotEffective/);
    await waitUntil(effective);
    const applied = await applyTerms(p); // permissionless
    assert.equal((await events(applied))[0].name, "termsapplied");
    assert.equal((await program.account.pool.fetch(p.pool, "confirmed")).terms.lockInSeconds.toNumber(), 20);

    assert.equal((await program.account.depositRecord.fetch(early.record, "confirmed")).unlockAt.toNumber(), earlyUnlock, "an existing deposit keeps its lock-in");
    const fresh = await deposit(p, d, 10);
    const f = await program.account.depositRecord.fetch(fresh.record, "confirmed");
    assert.equal(f.unlockAt.toNumber(), f.settledAt.toNumber() + 20);
  });

  it("(d)(e) pays strictly from the head, keeps a partly paid request at the head, and never goes below the reserve floor", async () => {
    const p = await createPool({ minReserve: new BN(120) });
    const x = await depositor();
    const y = await depositor();
    const z = await depositor();
    const dx = await deposit(p, x, 100);
    const dy = await deposit(p, y, 50);
    const rx = await request(p, x, dx.record, 100);
    const ry = await request(p, y, dy.record, 50);

    await fails(processQueue(p, { seq: ry.seq }), /ConstraintSeeds|seeds constraint/i);

    const xHeld = await balance(ata(x.publicKey));
    const first = await processQueue(p);
    const paid = (await events(first)).find((e) => e.name === "withdrawalpaid")!;
    assert.equal(paid.data.amount.toNumber(), 30);
    assert.equal(paid.data.partial, true);
    assert.equal(paid.data.reserveFloor.toNumber(), 120);
    assert.equal(await balance(p.vault), 120);
    assert.equal(await balance(ata(x.publicKey)), xHeld + 30);
    let state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.headSeq.toNumber(), rx.seq.toNumber(), "a partial fill stays at the head");
    assert.equal((await program.account.withdrawalRequest.fetch(rx.request, "confirmed")).remaining.toNumber(), 70);
    await fails(processQueue(p), /ReserveFloor/);

    await deposit(p, z, 100);
    await processQueue(p);
    assert.equal(await balance(ata(x.publicKey)), xHeld + 100);
    state = await program.account.pool.fetch(p.pool, "confirmed");
    assert.equal(state.headSeq.toNumber(), ry.seq.toNumber());
    const yHeld = await balance(ata(y.publicKey));
    await processQueue(p);
    assert.equal(await balance(ata(y.publicKey)), yHeld + 30);
    assert.equal(await balance(p.vault), 120, "the vault stops at the floor");
    await fails(processQueue(p), /ReserveFloor/);

    const snap = await program.methods.snapshot().accountsPartial({ pool: p.pool, vault: p.vault }).rpc(confirmed);
    const s = (await events(snap))[0];
    assert.equal(s.name, "poolsnapshot");
    assert.equal(s.data.vaultBalance.toNumber(), 120);
    assert.equal(s.data.reserveFloor.toNumber(), 120);
    assert.equal(s.data.totalQueued.toNumber(), 20);
  });

  it("(e) measures the reserve against a fresh attested obligations figure", async () => {
    const p = await createPool({ minReserveBps: 5000, obligationsMaxStaleness: new BN(60) });
    const d = await depositor();
    const dep = await deposit(p, d, 100);
    const now = await chainNow();
    await fails(attestObligations(p, 160, now - 120), /AttestationStale/);
    await fails(attestObligations(p, 160, now, stranger), /UnknownAttester/);
    const sig = await attestObligations(p, 160, now);
    assert.equal((await events(sig))[0].data.reserveFloor.toNumber(), 80);
    await fails(attestObligations(p, 160, now), /AttestationStale/); // not newer than the last
    await request(p, d, dep.record, 100);
    const held = await balance(ata(d.publicKey));
    await processQueue(p);
    assert.equal(await balance(ata(d.publicKey)), held + 20);
    assert.equal(await balance(p.vault), 80);
    await waitUntil(now + 1);
    await attestObligations(p, 0, now + 1);
    await processQueue(p);
    assert.equal(await balance(ata(d.publicKey)), held + 100);
  });

  it("(f) has no instruction that moves vault funds to the authority", async () => {
    const names = program.idl.instructions.map((i) => i.name).sort();
    assert.deepEqual(
      names,
      ["applyTerms", "attestObligations", "cancelRequest", "cancelTerms", "deposit", "initializePool", "processQueue", "proposeTerms", "rejectDeposit", "requestWithdrawal", "setHealthPause", "setSponsorPause", "snapshot"].sort(),
      "a new instruction needs its own review",
    );
    // The vault is writable only where it's created, paid into, or paid out of to a depositor.
    const writesVault = program.idl.instructions.filter((i) => (i.accounts as any[]).some((a) => a.name === "vault" && a.writable)).map((i) => i.name).sort();
    assert.deepEqual(writesVault, ["deposit", "initializePool", "processQueue", "rejectDeposit"]);

    const p = await createPool({ minReserve: new BN(0) });
    const d = await depositor();
    const dep = await deposit(p, d, 100);
    await request(p, d, dep.record, 40);
    const authorityToken = ata(authority.publicKey);
    await fails(reject(p, dep.record, { to: authorityToken }), /ConstraintAddress|address constraint/i);
    await fails(reject(p, dep.record, { signer: stranger }), /ConstraintHasOne|has.one/i);
    await fails(processQueue(p, { requesterToken: authorityToken }), /ConstraintAddress|address constraint/i);
    await processQueue(p);
    await reject(p, dep.record);
    assert.equal(await balance(authorityToken), 0, "the authority never received anything");
    assert.equal(await balance(p.vault), 0);
  });

  it("(g) calls an extension on deposits and payments, but the extension can never sign for the vault", async () => {
    const probeState = pda(["probe"], probe.programId);
    await probe.methods.initProbe(0).accountsPartial({ probe: probeState, payer: payer.publicKey, systemProgram: SystemProgram.programId }).rpc(confirmed);
    const setMode = (mode: number) => probe.methods.setMode(mode).accountsPartial({ probe: probeState }).rpc(confirmed);
    const p = await createPool({ extensionProgram: probe.programId });
    const d = await depositor();
    const own = [{ pubkey: probeState, isSigner: false, isWritable: true }];

    await fails(deposit(p, d, 100), /ExtensionMissing/);
    await fails(deposit(p, d, 100, { extension: TOKEN_PROGRAM_ID, remaining: own }), /WrongExtension/);
    await fails(
      deposit(p, d, 100, { extension: probe.programId, remaining: [...own, { pubkey: p.vault, isSigner: false, isWritable: true }] }),
      /ExtensionAccountNotWritable/,
    );
    const ok = await deposit(p, d, 100, { extension: probe.programId, remaining: own });
    let state = await probe.account.probe.fetch(probeState, "confirmed");
    assert.equal(state.calls.toNumber(), 1);
    assert.equal(state.lastKind, 0);
    assert.equal(state.lastAmount.toNumber(), 100);
    assert.equal(state.poolWasSigner, false, "the pool is never a signer for the extension");
    assert.equal(state.poolWasWritable, false, "nor writable");
    assert.include((await events(ok.signature)).map((e) => e.name), "extensionhook");

    // Hostile: it tries to move the vault's USDC with the pool as authority. The runtime refuses: the pool never signed.
    await setMode(1);
    const thief = ata(stranger.publicKey);
    const attack = [...own, { pubkey: p.vault, isSigner: false, isWritable: false }, { pubkey: thief, isSigner: false, isWritable: false }, { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }];
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
