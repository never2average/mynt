import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inTransaction, type Db } from "./db.js";
import type { SandboxHost } from "./sandbox-host.js";
import { SOLANA_VERIFY_SCRIPT } from "./solana/toolchain.js";
import { loadCrateAllowlist } from "./solana/vuln-db.js";
import { judgeUpgradeLock, type UpgradeLock } from "./solana/upgrade-lock.js";
import { readTemplateBuild, treasuryTemplateAt } from "./treasury-template.js";
import { getPool, OFFERING_NOT_CLEARED, pausedOnlyForMissingHealth, treasuryHealthExempt, type Pool } from "./liquidity.js";
import type { Store, User } from "./store.js";
import { base58Decode, base58Encode, executableHash, findProgramAddress, isAddress, pubkeyBytes } from "./solana/codec.js";
import { GENESIS_HASH, type Cluster, type SolanaRpc } from "./solana/rpc.js";
import { programEvents } from "./solana/service.js";
import {
  associatedTokenAddress,
  compileV0Message,
  decodeDeposit,
  decodeEvent,
  decodePool,
  decodePosition,
  decodeTokenAccount,
  decodeV0Transaction,
  depositInstruction,
  DEVNET_USDC_MINT,
  ed25519Instruction,
  MAX_APPROVAL_SECONDS,
  poolAddress,
  positionAddress,
  requestWithdrawalInstruction,
  TOKEN_PROGRAM,
  unsignedTransaction,
  ZERO_KEY,
  type DepositApprovalFormat,
  type PoolAccount,
  type TreasuryAttester,
  type TreasuryEvent,
} from "./solana/treasury-chain.js";
import { SYSVAR_CLOCK, UPGRADEABLE_LOADER } from "./solana/tx.js";

// Liquidity pools whose capital is held on chain, in an app's own treasury program built from Mynt's template
// (workspaces/coding-build/templates/solana-treasury). Devnet only: mainnet stays behind the mainnet program gate.
//
// Mynt never signs for a person's funds and never holds their keys. For a deposit it checks the person (a verified
// wallet linked to their sign-in, the liquidity provider's standing, the pool's limits and pauses), has its attester
// sign the program's deposit approval, and hands back an unsigned transaction whose fee payer and only signer is the
// person's own wallet. A withdrawal request is the same without the attester. An indexer reads the treasury's events
// for registered pools into Mynt's records, so positions show what's on chain.

const T = "financial_products";
const TABLES = `
  -- A liquidity pool's on-chain treasury: the program and pool account its builder registered, checked on chain.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_pools (
    pool_id uuid PRIMARY KEY REFERENCES ${T}.liquidity_pools(id),
    cluster text NOT NULL CHECK (cluster = 'devnet'),
    program_id text NOT NULL,
    pool_address text NOT NULL UNIQUE,
    vault text NOT NULL,
    usdc_mint text NOT NULL,
    creator text NOT NULL,
    program_hash text,
    upgrade_authority text,
    verified_build boolean NOT NULL DEFAULT false,
    build_note text,
    registered_by uuid NOT NULL,
    index_cursor text,
    indexed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Every treasury event the indexer read, once (a transaction's events in log order).
  CREATE TABLE IF NOT EXISTS ${T}.treasury_events (
    id uuid PRIMARY KEY,
    pool_address text NOT NULL,
    signature text NOT NULL,
    idx integer NOT NULL,
    slot bigint,
    event text NOT NULL,
    data jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (pool_address, signature, idx)
  );
  -- Deposits and withdrawal requests as the events left them, in USDC base units.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_deposits (
    address text PRIMARY KEY,
    pool_address text NOT NULL,
    depositor text NOT NULL,
    seq numeric(20, 0) NOT NULL,
    amount numeric(20, 0) NOT NULL,
    remaining numeric(20, 0) NOT NULL,
    queued numeric(20, 0) NOT NULL DEFAULT 0,
    settled_at bigint NOT NULL,
    review_until bigint NOT NULL,
    unlock_at bigint NOT NULL,
    rejected boolean NOT NULL DEFAULT false,
    signature text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS treasury_deposits_depositor_idx ON ${T}.treasury_deposits (depositor, pool_address);
  CREATE TABLE IF NOT EXISTS ${T}.treasury_requests (
    address text PRIMARY KEY,
    pool_address text NOT NULL,
    depositor text NOT NULL,
    deposit text NOT NULL,
    seq numeric(20, 0) NOT NULL,
    amount numeric(20, 0) NOT NULL,
    remaining numeric(20, 0) NOT NULL,
    paid numeric(20, 0) NOT NULL DEFAULT 0,
    payable_at bigint NOT NULL,
    status text NOT NULL CHECK (status IN ('open', 'paid', 'cancelled', 'voided', 'parked')),
    signature text NOT NULL
  );
  CREATE INDEX IF NOT EXISTS treasury_requests_depositor_idx ON ${T}.treasury_requests (depositor, pool_address);
  -- The wallets a firm's people prepared treasury transactions from, so the firm's positions include them.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_wallets (
    wallet text NOT NULL,
    lp_entity_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (wallet, lp_entity_id, user_id)
  );
  -- A pool whose attesters changed on chain from [Mynt's attester, none]: Mynt stops approving deposits to it.
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS attesters_flag text;
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS attesters_flagged_at timestamptz;
  -- Asked to be indexed soon (a transaction it touched was confirmed).
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS index_requested_at timestamptz;
  -- A scan of new signatures part-way: the page to read before, the newest signature it started from, pages read.
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS scan_before text;
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS scan_newest text;
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS scan_pages integer NOT NULL DEFAULT 0;
  -- The deposit approval layout the pool's program checks (solana/treasury-chain.ts). Pools registered before
  -- MYNTDEP3 keep MYNTDEP2, which binds no amount: Mynt's limits are advisory for them, so mainnet never takes one.
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS deposit_approval text NOT NULL DEFAULT 'MYNTDEP2' CHECK (deposit_approval IN ('MYNTDEP2', 'MYNTDEP3'));
  -- Every MYNTDEP3 approval Mynt's attester issued: one deposit of exactly amount, by wallet at its position's nonce,
  -- until expires_at (seconds). Until the nonce moves on or it expires, it counts toward the firm's limit.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_approvals (
    id uuid PRIMARY KEY,
    pool_id uuid NOT NULL,
    pool_address text NOT NULL,
    lp_entity_id uuid NOT NULL,
    user_id uuid NOT NULL,
    wallet text NOT NULL,
    nonce numeric(20, 0) NOT NULL,
    amount numeric(20, 0) NOT NULL CHECK (amount > 0),
    expires_at bigint NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS treasury_approvals_firm_idx ON ${T}.treasury_approvals (pool_address, lp_entity_id, expires_at);
  CREATE INDEX IF NOT EXISTS treasury_approvals_wallet_idx ON ${T}.treasury_approvals (pool_address, wallet, expires_at);
  -- Every wallet Mynt approved a MYNTDEP3 deposit for, per firm and pool, kept for good: its principal counts toward
  -- that firm's limit whether or not it's still linked.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_firm_wallets (
    pool_address text NOT NULL,
    lp_entity_id uuid NOT NULL,
    wallet text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (pool_address, lp_entity_id, wallet)
  );
  -- The program's last-deployed slot when the pool was registered: a MYNTDEP3 prepare refuses a program upgraded since.
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS program_slot numeric(20, 0);
  -- Who can change the pool's program, judged at registration: immutable, timelocked_multisig (a Squads v4 vault
  -- with no config authority, at least two signers and the minimum time lock) or unlocked; the multisig named.
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS upgrade_lock text CHECK (upgrade_lock IN ('immutable', 'timelocked_multisig', 'unlocked'));
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS upgrade_lock_detail jsonb;
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS upgrade_multisig text;
  -- Mynt's own rebuilds of the treasury template at a pool's program id (src/treasury-template.ts), one per program id
  -- and template build, in a sandbox with Mynt's verifiable build script: what the template compiles to there.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_builds (
    program_id text NOT NULL,
    template_sha256 text NOT NULL,
    status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
    sha256 text,
    error text,
    sandbox_id text,
    process_id integer,
    attempts integer NOT NULL DEFAULT 0,
    requested_by uuid,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (program_id, template_sha256)
  );
  -- Mainnet treasuries, once an admin has turned treasury mainnet on and a pool passes every mainnet check.
  DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'treasury_pools_cluster_check' AND conrelid = '${T}.treasury_pools'::regclass AND pg_get_constraintdef(oid) NOT LIKE '%mainnet%') THEN
      ALTER TABLE ${T}.treasury_pools DROP CONSTRAINT treasury_pools_cluster_check;
      ALTER TABLE ${T}.treasury_pools ADD CONSTRAINT treasury_pools_cluster_check CHECK (cluster IN ('devnet', 'mainnet'));
    END IF;
  END $$;
  -- Set by the watch (watch()) when a pool's program, upgrade authority or multisig changed on chain since it was
  -- registered: Mynt approves no deposits to it until its builder registers it again.
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS program_flag text;
  ALTER TABLE ${T}.treasury_pools ADD COLUMN IF NOT EXISTS program_flagged_at timestamptz;
  -- Treasury settings an admin changes (configure_treasury_mainnet): 'mainnet' = { enabled }.
  CREATE TABLE IF NOT EXISTS ${T}.treasury_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Signatures a completed scan found and the indexer hasn't read yet, oldest first by (slot, pos DESC).
  CREATE TABLE IF NOT EXISTS ${T}.treasury_pending (
    pool_id uuid NOT NULL,
    signature text NOT NULL,
    slot bigint NOT NULL,
    pos bigint NOT NULL,
    failed boolean NOT NULL DEFAULT false,
    PRIMARY KEY (pool_id, signature)
  );
`;

export const TREASURY_CLUSTERS = ["devnet", "mainnet"] as const;
export const MAINNET_DISABLED = "Treasury pools are devnet only for now: mainnet stays behind the mainnet program gate";
// Circle's USDC on mainnet.
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
// Where a treasury rebuild runs in its sandbox.
const BUILD_DIR = "/home/user/mynt-treasury-build";

// Whether depositors can leave within the upgrade time lock: always for an immutable program; for a multisig, its time
// lock covers the pool's lock-in plus notice.
export function timeLockCovers(lock: UpgradeLock | { status: string }, terms: { lock_in_seconds: bigint; notice_seconds: bigint }): boolean {
  if (lock.status === "immutable") return true;
  if (lock.status !== "timelocked_multisig") return false;
  return BigInt((lock as { time_lock_seconds: number }).time_lock_seconds) >= terms.lock_in_seconds + terms.notice_seconds;
}

// What would still stop a registered (devnet) treasury from holding mainnet money, besides mainnet being off.
export function mainnetBlockers(row: Pick<TreasuryRow, "verified_build" | "deposit_approval" | "upgrade_lock" | "upgrade_lock_detail">, terms?: { lock_in_seconds: bigint; notice_seconds: bigint } | null): string[] {
  const out: string[] = [];
  if (!row.verified_build) out.push("not a verified build: its bytes must be the treasury template as Mynt rebuilds it at its program id");
  if (row.deposit_approval !== "MYNTDEP3") out.push("its deposit approvals aren't MYNTDEP3 (amount-bound, single use)");
  if (row.upgrade_lock !== "immutable" && row.upgrade_lock !== "timelocked_multisig")
    out.push(`its upgrade authority isn't locked: ${(row.upgrade_lock_detail as { reason?: string } | null)?.reason ?? "make it immutable, or a Squads multisig vault (no config authority, two or more signers, a time lock) and name the multisig"}`);
  // A time lock only protects depositors who can leave within it: an upgrade approved now could run before a deposit
  // made now is out of its lock-in and notice.
  const timeLock = (row.upgrade_lock_detail as { time_lock_seconds?: number } | null)?.time_lock_seconds;
  if (row.upgrade_lock === "timelocked_multisig" && terms && timeLock !== undefined && BigInt(timeLock) < terms.lock_in_seconds + terms.notice_seconds)
    out.push(`its multisig's time lock (${timeLock}s) is shorter than the pool's lock-in and notice (${terms.lock_in_seconds + terms.notice_seconds}s): depositors couldn't leave before an approved upgrade runs`);
  out.push("on mainnet it must be registered again there, once an admin turns treasury mainnet on: its pool bound to mainnet's genesis hash, holding USDC, attested by Mynt's mainnet attester, under a program id of its own");
  return out;
}
// A cent in USDC base units (USDC has 6 decimals).
export const BASE_UNITS_PER_CENT = 10_000n;
const CACHE_MS = 60_000;

const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL("../schemas/solana-treasury-template.json", import.meta.url)), "utf8")) as {
  declared_id: string;
  program_sha256: string;
  // Earlier template builds still deployed on devnet, and the approval layout each checks.
  earlier_builds?: { program_sha256: string; deposit_approval: DepositApprovalFormat }[];
  deposit_approval?: DepositApprovalFormat;
  cargo_lock_sha256: string;
  program: string;
};
// How long past its expiry (by Mynt's clock) an approval still counts toward a firm's limit, at least: the cluster's
// clock can trail Mynt's. It counts for longer if the cluster's own clock says it's still valid.
const APPROVAL_CLOCK_GRACE_SECONDS = 120;
// How far back approvals are read for the limit; if the cluster's clock can't be read, all of these count.
const APPROVAL_LOOKBACK_SECONDS = 86_400;
// Issued approvals are kept this long, then pruned.
const APPROVAL_KEEP_SECONDS = 30 * 86_400;

export interface TreasuryConfig {
  usdcMint: string; // SOLANA_DEVNET_USDC_MINT, default Circle's devnet USDC
  indexPerPoll: number; // TREASURY_INDEX_PER_POLL: transactions read per pool per poll
  indexPagesPerPoll?: number; // signature pages (1000 each) scanned per pool per poll; the scan resumes where it stopped
  prepareLimitPerMinute?: number; // prepare_* calls per person a minute (20)
  statusLimitPerMinute?: number; // get_treasury_tx_status calls per person a minute (30)
  // TREASURY_MIN_UPGRADE_TIMELOCK_HOURS (48): the shortest time lock a Squads multisig holding a treasury's upgrade
  // authority may have, for its program to count as locked.
  minUpgradeTimelockSeconds?: number;
  // How long Mynt's rebuild of the template at a pool's program id may take (90 minutes).
  verifyBuildMinutes?: number;
  // The sandbox type for those rebuilds (BUILD_SANDBOX_TYPE).
  sandboxType?: string;
}
export function treasuryConfigFromEnv(env = process.env): TreasuryConfig {
  const mint = env.SOLANA_DEVNET_USDC_MINT && isAddress(env.SOLANA_DEVNET_USDC_MINT) ? env.SOLANA_DEVNET_USDC_MINT : DEVNET_USDC_MINT;
  const per = Number(env.TREASURY_INDEX_PER_POLL);
  const hours = Number(env.TREASURY_MIN_UPGRADE_TIMELOCK_HOURS);
  return {
    usdcMint: mint,
    indexPerPoll: env.TREASURY_INDEX_PER_POLL && per >= 1 ? Math.floor(per) : 200,
    indexPagesPerPoll: 5,
    prepareLimitPerMinute: 20,
    statusLimitPerMinute: 30,
    minUpgradeTimelockSeconds: Math.round((env.TREASURY_MIN_UPGRADE_TIMELOCK_HOURS && hours >= 1 ? hours : 48) * 3600),
    verifyBuildMinutes: 90,
    sandboxType: env.BUILD_SANDBOX_TYPE ?? "default",
  };
}

// What the treasury needs of Mynt's Solana service: a cluster's RPC (checked against its genesis hash) and the
// attester sealed in the vault.
export interface TreasuryChain {
  rpc(cluster: Cluster): SolanaRpc;
  treasuryAttester(cluster?: Cluster): Promise<TreasuryAttester>;
}

export class TreasuryRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
function refuse(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new TreasuryRefusal(code, message, extra);
}

// A u64 as JSON: a number while it's exact, a decimal string beyond 2^53.
export const units = (v: bigint) => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v.toString());
const big = (v: unknown) => BigInt(String(v ?? 0));
const iso = (seconds: bigint | number) => new Date(Number(seconds) * 1000).toISOString();
const DEVNET_GENESIS = Buffer.from(base58Decode(GENESIS_HASH.devnet));
// One program id and pool address can exist on both clusters: everything cached per pool is keyed by cluster too.
const cacheKey = (cluster: Cluster, address: string) => `${cluster}:${address}`;
// The only attester set Mynt approves deposits under: its own attester in the first slot, the second empty.
export const exactAttesters = (attesters: readonly string[], mynt: string) => attesters.length === 2 && attesters[0] === mynt && attesters[1] === ZERO_KEY;

type Row = Record<string, unknown>;
export interface TreasuryRow {
  pool_id: string;
  cluster: Cluster;
  program_id: string;
  pool_address: string;
  vault: string;
  usdc_mint: string;
  creator: string;
  program_hash: string | null;
  upgrade_authority: string | null;
  verified_build: boolean;
  build_note: string | null;
  deposit_approval: DepositApprovalFormat;
  program_slot: string | null;
  upgrade_lock: UpgradeLock["status"] | null;
  upgrade_lock_detail: Record<string, unknown> | null;
  upgrade_multisig: string | null;
  program_flag: string | null;
  index_cursor: string | null;
  attesters_flag: string | null;
  scan_before: string | null;
  scan_newest: string | null;
  scan_pages: number;
}

interface AccountInfo {
  data: [string, string];
  owner: string;
  executable: boolean;
  lamports: number;
}

export interface Standing {
  user: User;
  firm: string | null; // the caller's firm, active on Mynt; null when it has none or isn't active
  firmProblem: string | null;
  // The caller's verified Solana wallets linked to their sign-in, or why they couldn't be read.
  wallets: string[] | { unavailable: string };
  // Anyone's verified Solana wallets as linked now; null when that can't be read. Wallets are attributed to a firm only
  // through their current link.
  linkedOf: (userId: string) => Promise<string[] | null>;
}

export class TreasuryService {
  private cache = new Map<string, { at: number; pool: PoolAccount }>();
  private calls = new Map<string, number[]>(); // per person and kind: the times of their calls in the last minute
  // The cluster every chain read in the current operation goes to: the pool's own, set where an operation on one pool
  // starts (prepare, index, watch); devnet otherwise. An explicit cluster argument always wins.
  private readonly onCluster = new AsyncLocalStorage<Cluster>();
  private here = (c?: Cluster): Cluster => c ?? this.onCluster.getStore() ?? "devnet";
  private kicking: Promise<void> | null = null;

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    private readonly chain: TreasuryChain,
    readonly config: TreasuryConfig,
    private readonly now: () => Date,
    private readonly sandboxes: SandboxHost | null = null,
  ) {}

  static async open(db: Db, store: Store, chain: TreasuryChain, config: TreasuryConfig = treasuryConfigFromEnv(), opts: { now?: () => Date; sandboxes?: SandboxHost | null } = {}) {
    await db.exec(TABLES);
    return new TreasuryService(db, store, chain, config, opts.now ?? (() => new Date()), opts.sandboxes ?? null);
  }

  // The cluster's RPC, checked once against its genesis hash (SolanaService.rpc), so what's read is that chain.
  private rpc(cluster?: Cluster) {
    return this.chain.rpc(this.here(cluster));
  }

  // At most `max` calls a minute per person and kind (in this process), or rate_limited.
  private limit(userId: string, kind: string, max: number) {
    const key = `${kind}:${userId}`;
    const t = Date.now();
    const recent = (this.calls.get(key) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= max) refuse("rate_limited", `Too many ${kind} calls: at most ${max} a minute; try again shortly`);
    recent.push(t);
    this.calls.set(key, recent);
    if (this.calls.size > 10_000) this.calls.delete(this.calls.keys().next().value!);
  }

  private async call<R>(method: string, params: unknown[], cluster?: Cluster): Promise<R> {
    const c = this.here(cluster);
    try {
      return await this.rpc(c).call<R>(method, params);
    } catch (e) {
      // RPC errors never carry the endpoint (rpc.ts); the message says what kind of failure it was.
      return refuse("rpc_unavailable", `${c === "devnet" ? "Devnet" : "Mainnet"} couldn't be read just now: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  private async account(address: string, cluster?: Cluster): Promise<AccountInfo | null> {
    const r = await this.call<{ value: AccountInfo | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }], cluster);
    return r?.value ?? null;
  }
  private bytes = (a: AccountInfo) => Uint8Array.from(Buffer.from(a.data[0], "base64"));

  async attesterAddress(cluster: Cluster = "devnet") {
    return (await this.chain.treasuryAttester(cluster)).address;
  }

  // ---- the treasury mainnet switch ----

  async mainnetEnabled(): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT value FROM ${T}.treasury_settings WHERE key = 'mainnet'`);
    return (rows[0] as { value?: { enabled?: boolean } } | undefined)?.value?.enabled === true;
  }

  // What treasury mainnet needs from this server before an admin can turn it on: a mainnet RPC (checked against
  // mainnet's genesis hash) and the vault for the mainnet attester. Pools still pass every mainnet check one by one.
  async mainnetReadiness(): Promise<{ enabled: boolean; ready: boolean; reasons: string[]; attester: string | null }> {
    const reasons: string[] = [];
    let attester: string | null = null;
    try {
      this.rpc("mainnet");
      await this.call("getGenesisHash", [], "mainnet");
    } catch (e) {
      reasons.push(e instanceof TreasuryRefusal ? e.message : `no mainnet RPC (SOLANA_RPC_URL_MAINNET): ${(e as Error).message.slice(0, 200)}`);
    }
    try {
      attester = await this.attesterAddress("mainnet");
    } catch (e) {
      reasons.push(`no mainnet attester: ${(e as Error).message.slice(0, 200)}`);
    }
    return { enabled: await this.mainnetEnabled(), ready: reasons.length === 0, reasons, attester };
  }

  // An admin turns treasury mainnet on (only when the server is ready) or off (always). Off stops every mainnet
  // prepare at once; deposits already made stay withdrawable through the program itself.
  async setMainnet(user: User, enabled: boolean) {
    if (enabled) {
      const r = await this.mainnetReadiness();
      if (!r.ready) refuse("mainnet_not_ready", `Treasury mainnet can't be turned on yet: ${r.reasons.join("; ")}`, { reasons: r.reasons });
    }
    await this.db.query(
      `INSERT INTO ${T}.treasury_settings (key, value, updated_by) VALUES ('mainnet', $1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify({ enabled }), user.id],
    );
    await this.store.audit(user.id, enabled ? "treasury_mainnet_enabled" : "treasury_mainnet_disabled", "treasury_mainnet", {});
    return this.mainnetReadiness();
  }

  // ---- registry ----

  async get(poolId: string): Promise<TreasuryRow | null> {
    const { rows } = await this.db.query(`SELECT * FROM ${T}.treasury_pools WHERE pool_id = $1`, [poolId]);
    return (rows[0] as unknown as TreasuryRow | undefined) ?? null;
  }

  async all(): Promise<TreasuryRow[]> {
    return (await this.db.query(`SELECT * FROM ${T}.treasury_pools ORDER BY created_at`)).rows as unknown as TreasuryRow[];
  }

  // A builder names the treasury of one of its product's pools. Everything is read from devnet: the program (an
  // upgradeable program, whose executable hash is recorded and compared with the template's verifiable build), and the
  // pool account (a mynt_treasury Pool at its own address, for this cluster, holding devnet USDC, with Mynt's attester
  // among its attesters). A build Mynt hasn't rebuilt at this address is recorded as unverified; devnet takes it.
  async register(
    user: User,
    input: { pool_id: string; cluster: string; program_id: string; pool_address: string; deposit_approval?: DepositApprovalFormat; upgrade_multisig?: string },
    who: { admin: boolean; wallets: string[] | { unavailable: string } },
  ) {
    if (input.cluster !== "devnet" && input.cluster !== "mainnet") refuse("mainnet_disabled", MAINNET_DISABLED);
    const pool = await getPool(this.store, input.pool_id);
    if (!pool) refuse("no_pool", `No pool '${input.pool_id}'`);
    if (!isAddress(input.program_id) || !isAddress(input.pool_address)) refuse("not_an_address", "program_id and pool_address must be Solana addresses");
    if (input.cluster === "mainnet") return this.registerMainnet(user, input, who);
    // A pool on mainnet is never registered back onto devnet in place, and devnet never shares a mainnet program id.
    const existing = await this.get(input.pool_id);
    if (existing?.cluster === "mainnet") refuse("cluster_mismatch", "This pool's treasury is on mainnet: register it with cluster mainnet");
    const { rows: onMainnet } = await this.db.query(`SELECT 1 FROM ${T}.treasury_pools WHERE program_id = $1 AND cluster = 'mainnet' LIMIT 1`, [input.program_id]);
    if (onMainnet[0]) refuse("cluster_mismatch", "A mainnet treasury uses this program id: a devnet treasury needs a program id of its own");
    const { programHash, upgradeAuthority, programSlot, authorityKnown, p } = await this.readTreasury("devnet", input.program_id, input.pool_address);
    if (p.usdc_mint !== this.config.usdcMint) refuse("wrong_mint", `The pool holds ${p.usdc_mint}, not devnet USDC (${this.config.usdcMint})`);
    const attester = await this.attesterAddress();
    if (!p.terms.attesters.includes(attester)) refuse("attester_missing", `Mynt's attester ${attester} isn't one of the pool's attesters, so Mynt can't approve deposits to it`, { mynt_attester: attester });
    if (!exactAttesters(p.terms.attesters, attester)) refuse("unexpected_attesters", `The pool's attesters must be exactly [Mynt's attester ${attester}, none]: another attester could admit depositors Mynt never checked`, { mynt_attester: attester, attesters: p.terms.attesters });
    // The pool is the builder's: its creator or its authority is a verified wallet linked to them (or an admin registers it).
    if (!who.admin) {
      const mine = Array.isArray(who.wallets) ? who.wallets : [];
      if (!mine.includes(p.creator) && !mine.includes(p.authority))
        refuse("not_pool_owner", `The pool's creator (${p.creator}) or authority (${p.authority}) must be a verified Solana wallet linked to your sign-in${Array.isArray(who.wallets) ? "" : ` (your linked wallets couldn't be read: ${who.wallets.unavailable})`}; or an admin registers it`, { creator: p.creator, authority: p.authority });
    }
    const { rows: taken } = await this.db.query(`SELECT pool_id FROM ${T}.treasury_pools WHERE pool_address = $1 AND pool_id <> $2`, [input.pool_address, input.pool_id]);
    if (taken[0]) refuse("already_registered", "That pool account is already another pool's treasury");
    // An earlier template build is never the current one, even if the manifest were left listing it as both.
    const earlier = programHash ? MANIFEST.earlier_builds?.find((b) => b.program_sha256 === programHash) : undefined;
    const { verified, note } = earlier ? { verified: false, note: "an earlier build of the treasury template" } : await this.verification(input.program_id, programHash, user.id);
    const lock = await this.upgradeLock("devnet", upgradeAuthority, input.upgrade_multisig ?? null, authorityKnown);
    // The approval layout the program checks: the template's own build and its earlier builds are known; otherwise
    // what the builder says, else what this pool was registered with, else the template's current one (MYNTDEP3).
    const known: DepositApprovalFormat | null = earlier ? earlier.deposit_approval : verified ? (MANIFEST.deposit_approval ?? "MYNTDEP3") : null;
    if (known && input.deposit_approval && input.deposit_approval !== known)
      refuse("wrong_deposit_approval", `This program is a build of Mynt's treasury template that checks ${known} deposit approvals, not ${input.deposit_approval}`, { deposit_approval: known });
    const before = await this.get(input.pool_id);
    const format: DepositApprovalFormat = known ?? input.deposit_approval ?? (before && before.pool_address === input.pool_address ? before.deposit_approval : "MYNTDEP3");
    await this.db.query(
      `INSERT INTO ${T}.treasury_pools (pool_id, cluster, program_id, pool_address, vault, usdc_mint, creator, program_hash, upgrade_authority, verified_build, build_note, registered_by, deposit_approval, program_slot, upgrade_lock, upgrade_lock_detail, upgrade_multisig)
       VALUES ($1, 'devnet', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (pool_id) DO UPDATE SET program_id = EXCLUDED.program_id, pool_address = EXCLUDED.pool_address, vault = EXCLUDED.vault, usdc_mint = EXCLUDED.usdc_mint, creator = EXCLUDED.creator,
         program_hash = EXCLUDED.program_hash, upgrade_authority = EXCLUDED.upgrade_authority, verified_build = EXCLUDED.verified_build, build_note = EXCLUDED.build_note, registered_by = EXCLUDED.registered_by, deposit_approval = EXCLUDED.deposit_approval, program_slot = EXCLUDED.program_slot, upgrade_lock = EXCLUDED.upgrade_lock, upgrade_lock_detail = EXCLUDED.upgrade_lock_detail, upgrade_multisig = EXCLUDED.upgrade_multisig,
         index_cursor = CASE WHEN ${T}.treasury_pools.pool_address = EXCLUDED.pool_address THEN ${T}.treasury_pools.index_cursor ELSE NULL END,
         scan_before = CASE WHEN ${T}.treasury_pools.pool_address = EXCLUDED.pool_address THEN ${T}.treasury_pools.scan_before ELSE NULL END,
         scan_newest = CASE WHEN ${T}.treasury_pools.pool_address = EXCLUDED.pool_address THEN ${T}.treasury_pools.scan_newest ELSE NULL END,
         attesters_flag = NULL, attesters_flagged_at = NULL, program_flag = NULL, program_flagged_at = NULL, updated_at = now()`,
      [input.pool_id, input.program_id, input.pool_address, p.vault, p.usdc_mint, p.creator, programHash, upgradeAuthority, verified, note, user.id, format, programSlot === null ? null : programSlot.toString(), lock.status, JSON.stringify(lock), input.upgrade_multisig ?? null],
    );
    // A pool on MYNTDEP3 counts every firm's history of wallets toward its limit. Deposits made before (under
    // MYNTDEP2, e.g. a pool upgraded in place) came through Mynt's prepares too, which recorded each wallet's firm:
    // those wallets with money still in the pool join their firm's history, so nothing earlier escapes the count.
    // A rebuild that finished while this registration was being checked is applied now.
    if (!verified && !earlier && input.program_id !== MANIFEST.declared_id) {
      const done = await this.templateBuild(input.program_id);
      if (done?.status === "succeeded" && done.sha256) await this.rejudge(input.program_id, done.sha256);
    }
    if (format === "MYNTDEP3")
      await this.db.query(
        `INSERT INTO ${T}.treasury_firm_wallets (pool_address, lp_entity_id, wallet)
         SELECT DISTINCT d.pool_address, w.lp_entity_id, d.depositor FROM ${T}.treasury_deposits d JOIN ${T}.treasury_wallets w ON w.wallet = d.depositor
         WHERE d.pool_address = $1 AND NOT d.rejected AND d.remaining > 0
         ON CONFLICT DO NOTHING`,
        [input.pool_address],
      );
    this.cache.set(cacheKey("devnet", input.pool_address), { at: Date.now(), pool: p });
    return this.view((await this.get(input.pool_id))!, p, null, attester);
  }

  // ---- reading the chain ----

  private async poolAccount(row: TreasuryRow, fresh = false): Promise<PoolAccount> {
    const hit = this.cache.get(cacheKey(row.cluster, row.pool_address));
    if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.pool;
    const info = await this.account(row.pool_address, row.cluster);
    const p = info && info.owner === row.program_id ? decodePool(this.bytes(info)) : null;
    if (!p) return refuse("not_on_chain", `The pool's treasury account isn't on ${row.cluster} any more`);
    this.cache.set(cacheKey(row.cluster, row.pool_address), { at: Date.now(), pool: p });
    return p;
  }

  view(row: TreasuryRow, p: PoolAccount | null, error: string | null = null, attester: string | null = null) {
    const nowS = BigInt(Math.floor(this.now().getTime() / 1000));
    return {
      cluster: row.cluster,
      program_id: row.program_id,
      pool_address: row.pool_address,
      verified_build: row.verified_build,
      // Set when the pool's attesters changed on chain: Mynt approves no deposits to it until it's registered again.
      attesters_flag: row.attesters_flag ?? null,
      build_status: row.verified_build ? "verified build" : "unverified build",
      // MYNTDEP3: each approval is for one deposit of its exact amount, so the firm's limit holds on chain.
      // MYNTDEP2 (earlier builds): an approval can be reused until it expires, so Mynt's limits are advisory.
      deposit_approval: row.deposit_approval,
      // Exact only when Mynt rebuilt the program (a verified build) and it checks MYNTDEP3: an unverified build is
      // whatever its builder deployed, so Mynt can't vouch that it spends approvals. Even exact holds only while the
      // program is the one registered: its upgrade authority could deploy one that takes deposits without approvals
      // (Mynt stops approving once it sees an upgrade, program_upgraded).
      firm_limit: row.verified_build && row.deposit_approval === "MYNTDEP3" ? "exact" : "advisory",
      // Who can change the program: immutable, a timelocked Squads multisig, or unlocked (with why).
      upgrade_lock: row.upgrade_lock_detail ?? (row.upgrade_lock ? { status: row.upgrade_lock } : null),
      // What stands between this treasury and mainnet, besides mainnet being off at Mynt.
      // Set by the watch when the program, its upgrade authority or its multisig changed since registration.
      program_flag: row.program_flag ?? null,
      mainnet_blockers: row.cluster === "mainnet" ? [] : mainnetBlockers(row, p?.terms ?? null),
      build_note: row.build_note,
      program_hash: row.program_hash,
      upgrade_authority: row.upgrade_authority,
      on_chain_terms: p
        ? {
            lock_in_seconds: Number(p.terms.lock_in_seconds),
            notice_seconds: Number(p.terms.notice_seconds),
            review_window_seconds: Number(p.floor.review_window_seconds),
            min_reserve: units(p.terms.min_reserve),
            min_reserve_bps: p.terms.min_reserve_bps,
            commitment_min: units(p.terms.commitment_min),
            commitment_max: units(p.terms.commitment_max),
            min_request: units(p.terms.min_request),
            topups_when_health_paused: p.terms.topups_when_health_paused,
            sponsor_paused: p.sponsor_paused,
            health_paused: p.health_paused,
            winding_down: p.wind_down_at !== 0n,
            deposits_paused: p.sponsor_paused || p.health_paused || p.wind_down_at !== 0n,
            pending_terms_effective_at: p.has_pending_terms ? iso(p.pending_effective_at) : null,
            attesters: p.terms.attesters.filter((a) => a !== ZERO_KEY),
            mynt_attester_approved: attester ? p.terms.attesters.includes(attester) : null,
            usdc_mint: p.usdc_mint,
            vault: p.vault,
            authority: p.authority,
            total_principal: units(p.total_principal),
            total_queued: units(p.total_queued),
            as_of: new Date(Number(nowS) * 1000).toISOString(),
          }
        : null,
      on_chain_error: error,
    };
  }

  // The treasury of each pool that has one, read from devnet (each pool account cached for up to a minute).
  async views(poolIds: string[]) {
    const out = new Map<string, ReturnType<TreasuryService["view"]>>();
    if (!poolIds.length) return out;
    const { rows } = await this.db.query(`SELECT * FROM ${T}.treasury_pools WHERE pool_id = ANY($1::uuid[])`, [poolIds]);
    // Each pool from its own cluster, judged against that cluster's attester.
    const attesters = new Map<Cluster, string | null>();
    for (const r of rows as unknown as TreasuryRow[]) {
      if (!attesters.has(r.cluster)) attesters.set(r.cluster, await this.attesterAddress(r.cluster).catch(() => null));
      const attester = attesters.get(r.cluster) ?? null;
      try {
        out.set(r.pool_id, this.view(r, await this.onCluster.run(r.cluster, () => this.poolAccount(r)), null, attester));
      } catch (e) {
        out.set(r.pool_id, this.view(r, null, (e as Error).message, attester));
      }
    }
    return out;
  }

  // ---- what a liquidity provider prepares ----

  private linked(s: Standing, wallet: string) {
    if (!isAddress(wallet)) refuse("wallet_not_linked", "wallet must be a Solana address");
    if (!Array.isArray(s.wallets)) refuse("wallet_not_linked", `Your linked wallets couldn't be checked: ${s.wallets.unavailable}`);
    if (!(s.wallets as string[]).includes(wallet)) refuse("wallet_not_linked", "That wallet isn't a verified Solana wallet linked to your sign-in; link it on your account page first");
  }

  // `exit`: a withdrawal request. Getting money out is never held to the conditions for putting it in: a mainnet
  // pool whose switch was turned off, or whose program changed, still gets withdrawal requests prepared.
  private async eligible(s: Standing, poolId: string, o: { exit?: boolean } = {}): Promise<{ pool: Pool; row: TreasuryRow; firm: string }> {
    if (!s.firm) refuse("not_liquidity_provider", s.firmProblem ?? "You don't belong to an active firm");
    const pool = await getPool(this.store, poolId);
    if (!pool || !pool.approved_at) refuse("not_on_chain", `No approved pool '${poolId}'`);
    const row = await this.get(poolId);
    if (!row) refuse("not_on_chain", "This pool has no on-chain treasury registered");
    if (row!.cluster === "mainnet" && !o.exit) await this.mainnetStillHolds(row!, pool!);
    const product = await this.store.getProduct(pool!.product_id);
    if (s.firm === pool!.sponsor_entity_id || s.firm === product?.entity_id) refuse("not_liquidity_provider", "A pool's sponsor or its product's firm can't be a liquidity provider in it");
    // As commit_to_pool: a pool that isn't sandbox takes capital only once an admin recorded its offering as cleared.
    if (!o.exit && !pool!.sandbox && !pool!.offering_cleared) refuse("offering_not_cleared", OFFERING_NOT_CLEARED);
    return { pool: pool!, row: row!, firm: s.firm! };
  }

  // A mainnet pool takes real money only while treasury mainnet is on and it still holds every mainnet condition.
  private async mainnetStillHolds(row: TreasuryRow, pool: Pool) {
    if (!(await this.mainnetEnabled())) refuse("mainnet_disabled", "Treasury mainnet is off: an admin turned it off, so Mynt prepares nothing on mainnet");
    if (pool.sandbox) refuse("mainnet_disabled", "A sandbox pool can't hold mainnet money");
    if (!row.verified_build || row.deposit_approval !== "MYNTDEP3") refuse("mainnet_disabled", "This mainnet treasury isn't a verified MYNTDEP3 build any more: its builder registers it again");
    if (row.upgrade_lock !== "immutable" && row.upgrade_lock !== "timelocked_multisig") refuse("upgrade_lock_changed", "This mainnet treasury's upgrade authority isn't locked: its builder registers it again");
  }

  // Mainnet reads need a mainnet RPC; without one, mainnet is simply off here.
  private mainnetReachable(cluster: Cluster) {
    if (cluster !== "mainnet") return;
    try {
      this.rpc("mainnet");
    } catch {
      refuse("mainnet_disabled", `${MAINNET_DISABLED}: this Mynt has no mainnet RPC`);
    }
  }

  // USDC on each cluster: devnet's from the config, Circle's on mainnet.
  private mintFor(cluster: Cluster) {
    return cluster === "mainnet" ? MAINNET_USDC_MINT : this.config.usdcMint;
  }

  private async blockhash() {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    return r.value;
  }

  private async remember(wallet: string, firm: string, userId: string) {
    await this.db.query(`INSERT INTO ${T}.treasury_wallets (wallet, lp_entity_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [wallet, firm, userId]);
  }

  // The firm's on-chain principal in a pool, from the indexer, over the firm's wallets as linked now, other than `except`.
  private async firmPrincipal(wallets: string[], poolAddress: string, except: string): Promise<bigint> {
    const others = wallets.filter((w) => w !== except);
    if (!others.length) return 0n;
    const { rows } = await this.db.query(`SELECT COALESCE(sum(d.remaining), 0) AS n FROM ${T}.treasury_deposits d WHERE d.pool_address = $1 AND NOT d.rejected AND d.depositor = ANY($2::text[])`, [poolAddress, others]);
    return big(rows[0]?.n);
  }

  async prepareDeposit(s: Standing, input: { pool_id: string; wallet: string; amount_usdc_base_units: number; max_lock_in_seconds: number }) {
    this.limit(s.user.id, "prepare", this.config.prepareLimitPerMinute ?? 20);
    const { pool, row, firm } = await this.eligible(s, input.pool_id);
    return this.onCluster.run(row.cluster, () => this.depositOn(s, input, pool, row, firm));
  }

  private async depositOn(s: Standing, input: { pool_id: string; wallet: string; amount_usdc_base_units: number; max_lock_in_seconds: number }, pool: Pool, row: TreasuryRow, firm: string) {
    this.linked(s, input.wallet);
    const amount = BigInt(input.amount_usdc_base_units);
    if (amount <= 0n) refuse("over_limit", "The amount must be more than zero");
    // As the liquidity worker: a sandbox treasury pool paused only because no health snapshot exists isn't held to it
    // (the treasury enforces its own reserve on chain); the worker opens it on its next tick.
    const exempt = pausedOnlyForMissingHealth(pool) && (await treasuryHealthExempt(this.store, pool));
    if (row.program_flag) refuse("program_changed", `Mynt has stopped approving deposits to this pool: ${row.program_flag}. Its builder registers it again`);
    if (pool.status !== "open" && !exempt) refuse("pool_paused", `This pool isn't taking deposits right now (${pool.status}${pool.pause_reason ? `: ${pool.pause_reason}` : ""})`);
    const p = await this.poolAccount(row, true);
    const attester = await this.chain.treasuryAttester(row.cluster);
    if (row.attesters_flag) refuse("attesters_changed", `Mynt has stopped approving deposits to this pool: ${row.attesters_flag}. Its builder registers it again once its attesters are [Mynt's, none]`);
    if (!p.terms.attesters.includes(attester.address)) {
      await this.flag(row, "Mynt's attester is no longer one of the pool's attesters");
      refuse("attester_removed", "Mynt's attester is no longer one of this pool's attesters, so Mynt can't approve deposits to it");
    }
    if (!exactAttesters(p.terms.attesters, attester.address)) {
      await this.flag(row, "the pool's attesters are no longer exactly [Mynt's attester, none]");
      refuse("attesters_changed", "The pool's attesters changed on chain: Mynt has stopped approving deposits to it");
    }
    // Every approval Mynt signs is for the pool's own cluster, whatever the account says: a pool bound elsewhere is refused.
    const genesis = Buffer.from(base58Decode(GENESIS_HASH[row.cluster]));
    if (!Buffer.from(p.cluster).equals(genesis)) refuse("wrong_cluster", `The pool's attestations are for another cluster than ${row.cluster}`);
    if (row.cluster === "mainnet" && row.deposit_approval !== "MYNTDEP3") refuse("mainnet_disabled", "Mainnet takes only MYNTDEP3 approvals");
    if (row.cluster === "mainnet" && !timeLockCovers((row.upgrade_lock_detail ?? { status: row.upgrade_lock }) as UpgradeLock, p.terms))
      refuse("upgrade_lock_changed", "The pool's lock-in and notice are now longer than the multisig's time lock: depositors couldn't leave before an approved upgrade runs");
    if (p.wind_down_at !== 0n) refuse("pool_paused", "The pool is winding down: it takes no new deposits");
    if (p.sponsor_paused) refuse("pool_paused", "The pool's authority has paused new deposits");
    const positionInfo = await this.account(positionAddress(row.program_id, row.pool_address, input.wallet));
    const position = positionInfo && positionInfo.owner === row.program_id ? decodePosition(this.bytes(positionInfo)) : null;
    const principal = position?.principal ?? 0n;
    if (p.health_paused && !(p.terms.topups_when_health_paused && principal > 0n)) refuse("pool_paused", "New deposits are paused for the pool's health");
    if (principal + amount > p.terms.commitment_max) refuse("over_limit", `That would take this wallet's principal in the pool over its maximum of ${p.terms.commitment_max} base units`, { principal: units(principal), commitment_max: units(p.terms.commitment_max) });
    if (principal + amount < p.terms.commitment_min) refuse("under_minimum", `A wallet's principal in this pool must be at least ${p.terms.commitment_min} base units`, { commitment_min: units(p.terms.commitment_min) });
    const firmMax = BigInt(pool.max_commitment_cents) * BASE_UNITS_PER_CENT;
    const firmWallets = await this.walletsOf(firm, s);
    const once = row.deposit_approval === "MYNTDEP3";
    // MYNTDEP2: the indexer's records, checked now; the approval could be reused, so this is advisory. MYNTDEP3 is
    // checked exactly, under the firm's lock, as the approval is issued (approveOnce).
    if (!once) {
      const firmNow = (await this.firmPrincipal(firmWallets, row.pool_address, input.wallet)) + principal;
      if (firmNow + amount > firmMax) refuse("over_limit", `That would take your firm's position over this pool's limit of ${pool.max_commitment_cents} cents per firm`, { exposure: units(firmNow), limit: units(firmMax) });
    }
    if (p.terms.lock_in_seconds > BigInt(input.max_lock_in_seconds)) refuse("terms_changed", `The pool's lock-in is ${p.terms.lock_in_seconds} seconds, longer than the ${input.max_lock_in_seconds} you agreed to`, { lock_in_seconds: Number(p.terms.lock_in_seconds) });
    const ata = await this.account(associatedTokenAddress(input.wallet, p.usdc_mint));
    const held = ata ? (decodeTokenAccount(this.bytes(ata))?.amount ?? 0n) : 0n;
    if (held < amount) refuse("insufficient_usdc", `The wallet holds ${held} base units of ${row.cluster === "devnet" ? "devnet " : ""}USDC, less than ${amount}`, { usdc_base_units: units(held) });

    const nowS = Math.floor(this.now().getTime() / 1000);
    const expiry = BigInt(nowS + MAX_APPROVAL_SECONDS);
    const cluster = genesis;
    const build = async (nonce: bigint) => {
      const base = { programId: row.program_id, cluster, pool: row.pool_address, depositor: input.wallet, nonce, expiry };
      const { message, signature } = attester.signDepositApproval(once ? { ...base, format: "MYNTDEP3", amount } : { ...base, format: "MYNTDEP2" }, nowS);
      const ixs = [
      ed25519Instruction(attester.publicKey, signature, message),
      depositInstruction({
        programId: row.program_id,
        pool: row.pool_address,
        vault: p.vault,
        usdcMint: p.usdc_mint,
        depositor: input.wallet,
        nextDepositSeq: p.next_deposit_seq,
        extensionProgram: p.terms.extension_program,
        amount,
        expiry,
        maxLockInSeconds: BigInt(input.max_lock_in_seconds),
      }),
      ];
      return this.unsigned(input.wallet, ixs);
    };
    if (once) await this.multisigStillLocked(row);
    const tx = once
      ? await this.approveOnce({ s, firm, firmWallets, row, pool, wallet: input.wallet, nonce: position?.nonce ?? 0n, amount, expiry, nowS, firmMax }, build)
      : await build(position?.nonce ?? 0n);
    await this.remember(input.wallet, firm, s.user.id);
    return {
      cluster: row.cluster,
      transaction_base64: tx.base64,
      expires_at: iso(expiry),
      last_valid_block_height: tx.lastValidBlockHeight,
      summary: {
        pool: pool.name,
        pool_id: pool.id,
        pool_address: row.pool_address,
        amount: units(amount),
        lock_in_seconds: Number(p.terms.lock_in_seconds),
        notice_seconds: Number(p.terms.notice_seconds),
        review_window_seconds: Number(p.floor.review_window_seconds),
        wallet: input.wallet,
        verified_build: row.verified_build,
        deposit_approval: row.deposit_approval,
      },
    };
  }

  // MYNTDEP3: issues one approval, checking the firm's limit exactly, under one lock per pool (in this process, then
  // across Mynt's processes) so no two prepares in a pool can both pass. The firm's exposure is:
  // - the on-chain principal of every wallet that counts for the firm: those linked to its people now, and every wallet
  //   Mynt ever approved for this firm in this pool (treasury_firm_wallets), linked or not, so unlinking a wallet (or a
  //   colleague's links being unreadable) can't hide principal. In a MYNTDEP3 pool money only comes in through Mynt's
  //   approvals, so that history is complete;
  // - plus every approval that can still land, whichever firm it was issued to, for those wallets and the firm's own:
  //   unexpired by the cluster's clock or by Mynt's (less the grace), and at a nonce the wallet's position hasn't passed
  //   (a deposit or a refusal moves it on). Of several at one wallet's nonce only one can land, so the largest counts.
  // The cluster's clock and the positions come from one read. The approval is signed at the nonce read under the lock
  // and recorded, with the wallet's link to the firm, in the transaction it's signed in: if building fails, nothing is.
  private async approveOnce<R>(
    o: { s: Standing; firm: string; firmWallets: string[]; row: TreasuryRow; pool: Pool; wallet: string; nonce: bigint; amount: bigint; expiry: bigint; nowS: number; firmMax: bigint },
    build: (nonce: bigint) => Promise<R>,
  ): Promise<R> {
    const lock = `mynt.treasury_approval:${o.row.pool_address}`;
    return this.serially(lock, () =>
      inTransaction(this.db, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lock]);
        await this.unchangedProgram(o.row);
        const { rows: history } = (await tx.query(`SELECT wallet FROM ${T}.treasury_firm_wallets WHERE pool_address = $1 AND lp_entity_id = $2`, [o.row.pool_address, o.firm])) as { rows: { wallet: string }[] };
        const counted = [...new Set([...o.firmWallets, o.wallet, ...history.map((r) => r.wallet)])];
        const { rows } = (await tx.query(
          `SELECT wallet, nonce, amount, expires_at FROM ${T}.treasury_approvals WHERE pool_address = $1 AND (lp_entity_id = $2 OR wallet = ANY($3::text[])) AND expires_at >= $4`,
          [o.row.pool_address, o.firm, counted, o.nowS - APPROVAL_LOOKBACK_SECONDS],
        )) as { rows: { wallet: string; nonce: string; amount: string; expires_at: string }[] };
        const { positions: live, clusterNow } = await this.positionsOf(o.row, [...new Set([...counted, ...rows.map((r) => r.wallet)])]);
        // Still usable on chain until the cluster's clock passes its expiry; Mynt's clock (less the grace) as a floor.
        // An unreadable clock counts everything in the lookback.
        const after = clusterNow === null ? o.nowS - APPROVAL_LOOKBACK_SECONDS : Math.min(clusterNow, o.nowS - APPROVAL_CLOCK_GRACE_SECONDS);
        let principal = 0n;
        for (const w of counted) principal += live.get(w)?.principal ?? 0n;
        const open = new Map<string, bigint>();
        for (const r of rows) {
          if (Number(r.expires_at) < after) continue;
          const n = BigInt(r.nonce);
          if (n < (live.get(r.wallet)?.nonce ?? 0n)) continue; // spent, or can't land any more
          const k = `${r.wallet}:${n}`;
          const a = BigInt(r.amount);
          if (a > (open.get(k) ?? 0n)) open.set(k, a);
        }
        // A wallet in the firm's history that's no longer linked to it, holds nothing in the pool and has no approval
        // that can still land drops out (it could otherwise only ever take room from the firm).
        const linkedNow = new Set([...o.firmWallets, o.wallet]);
        const openWallets = new Set([...open.keys()].map((k) => k.slice(0, k.lastIndexOf(":"))));
        const idle = history.map((r) => r.wallet).filter((w) => !linkedNow.has(w) && (live.get(w)?.principal ?? 0n) === 0n && !openWallets.has(w));
        if (idle.length) await tx.query(`DELETE FROM ${T}.treasury_firm_wallets WHERE pool_address = $1 AND lp_entity_id = $2 AND wallet = ANY($3::text[])`, [o.row.pool_address, o.firm, idle]);
        const liveNonce = live.get(o.wallet)?.nonce ?? 0n;
        const nonce = liveNonce > o.nonce ? liveNonce : o.nonce;
        const mine = `${o.wallet}:${nonce}`;
        let outstanding = 0n;
        for (const [k, a] of open) if (k !== mine) outstanding += a;
        const atMine = open.get(mine) ?? 0n;
        const exposure = principal + outstanding + (atMine > o.amount ? atMine : o.amount);
        if (exposure > o.firmMax)
          refuse("over_limit", `That would take your firm's position over this pool's limit of ${o.pool.max_commitment_cents} cents per firm (counting deposits approved in the last ${MAX_APPROVAL_SECONDS / 60} minutes that haven't landed yet)`, {
            exposure: units(principal),
            approved_not_landed: units(outstanding + atMine),
            limit: units(o.firmMax),
          });
        const out = await build(nonce);
        await tx.query(`INSERT INTO ${T}.treasury_approvals (id, pool_id, pool_address, lp_entity_id, user_id, wallet, nonce, amount, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
          randomUUID(),
          o.row.pool_id,
          o.row.pool_address,
          o.firm,
          o.s.user.id,
          o.wallet,
          nonce.toString(),
          o.amount.toString(),
          o.expiry.toString(),
        ]);
        await tx.query(`INSERT INTO ${T}.treasury_firm_wallets (pool_address, lp_entity_id, wallet) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [o.row.pool_address, o.firm, o.wallet]);
        await tx.query(`INSERT INTO ${T}.treasury_wallets (wallet, lp_entity_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [o.wallet, o.firm, o.s.user.id]);
        await tx.query(`DELETE FROM ${T}.treasury_approvals WHERE pool_address = $1 AND expires_at < $2`, [o.row.pool_address, o.nowS - APPROVAL_KEEP_SECONDS]);
        return out;
      }),
    );
  }

  // Runs `f` after any earlier call with the same key has finished, in this process.
  private readonly queues = new Map<string, Promise<unknown>>();
  private serially<R>(key: string, f: () => Promise<R>): Promise<R> {
    const before = this.queues.get(key) ?? Promise.resolve();
    const run = before.then(f, f);
    const settled = run.catch(() => undefined);
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }

  // ---- reading a treasury from a cluster ----

  // A treasury's program (an upgradeable program: its executable hash, last-deployed slot and upgrade authority) and
  // its pool account (a mynt_treasury Pool at its own address), read from `cluster`, whose RPC is checked against that
  // cluster's genesis hash. The pool's own cluster field, which its deposit approvals are bound to, must be that
  // chain's genesis hash: an approval for one cluster can then never admit a deposit on another.
  private async readTreasury(cluster: Cluster, programId: string, address: string) {
    const program = await this.account(programId, cluster);
    if (!program || !program.executable || program.owner !== UPGRADEABLE_LOADER) refuse("not_a_program", `${programId} isn't an upgradeable program on ${cluster}`);
    const programBytes = this.bytes(program!);
    if (programBytes.length < 36 || Buffer.from(programBytes).readUInt32LE(0) !== 2) refuse("not_a_program", `${programId} isn't an upgradeable program on ${cluster}`);
    const [programData] = findProgramAddress([pubkeyBytes(programId)], UPGRADEABLE_LOADER);
    const pd = await this.account(programData, cluster);
    let programHash: string | null = null;
    let upgradeAuthority: string | null = null;
    let programSlot: bigint | null = null;
    let authorityKnown = false;
    if (pd) {
      const b = Buffer.from(this.bytes(pd));
      if (b.length > 45 && b.readUInt32LE(0) === 3) {
        programSlot = b.readBigUInt64LE(4);
        upgradeAuthority = b[12] === 1 ? base58Encode(b.subarray(13, 45)) : null;
        programHash = executableHash(b.subarray(45));
        authorityKnown = true;
      }
    }
    const info = await this.account(address, cluster);
    if (!info || info.owner !== programId) refuse("not_a_treasury_pool", `${address} isn't an account of ${programId} on ${cluster}`);
    const onChain = decodePool(this.bytes(info!));
    if (!onChain) refuse("not_a_treasury_pool", `${address} isn't a mynt_treasury pool account`);
    const p = onChain!;
    if (poolAddress(programId, p.creator, p.pool_id) !== address) refuse("not_a_treasury_pool", `${address} isn't at the pool's own address`);
    if (!Buffer.from(p.cluster).equals(Buffer.from(base58Decode(GENESIS_HASH[cluster]))))
      refuse("wrong_cluster", `The pool's deposit approvals are bound to another chain than ${cluster}: its cluster isn't ${cluster}'s genesis hash`, { cluster: base58Encode(p.cluster), expected: GENESIS_HASH[cluster] });
    return { programHash, upgradeAuthority, programSlot, authorityKnown, p };
  }

  // Who can change the program, from the chain: the multisig the builder names (if any) is read and judged.
  private async upgradeLock(cluster: Cluster, authority: string | null, multisig: string | null, authorityKnown = true): Promise<UpgradeLock> {
    const min = this.config.minUpgradeTimelockSeconds ?? 48 * 3600;
    // A program whose data couldn't be read isn't judged immutable: who can change it is unknown.
    if (!authorityKnown) return { status: "unlocked", reason: "the program's data couldn't be read, so who can change it is unknown" };
    if (authority === null || !multisig) return judgeUpgradeLock(authority, null, min);
    const a = isAddress(multisig) ? await this.account(multisig, cluster) : null;
    return judgeUpgradeLock(authority, { address: multisig, account: a ? { owner: a.owner, data: this.bytes(a) } : null }, min);
  }

  // Mainnet stays off. Asked for it, Mynt reads the treasury from mainnet (when it has a mainnet RPC) and says what
  // would still stop it there: the pool bound to mainnet's genesis hash, a verified build of the template at its
  // own address (a rebuild is queued if there's none), a locked upgrade authority, MYNTDEP3, mainnet USDC, and a
  // program id of its own (not one a devnet treasury uses). Nothing is recorded but the rebuild request.
  private async registerMainnet(user: User, input: { pool_id: string; program_id: string; pool_address: string; upgrade_multisig?: string }, who: { admin: boolean; wallets: string[] | { unavailable: string } }) {
    let read: Awaited<ReturnType<TreasuryService["readTreasury"]>>;
    try {
      this.rpc("mainnet");
    } catch {
      return refuse("mainnet_disabled", `${MAINNET_DISABLED}. This Mynt has no mainnet RPC, so it can't check the treasury there either`);
    }
    try {
      read = await this.readTreasury("mainnet", input.program_id, input.pool_address);
    } catch (e) {
      if (e instanceof TreasuryRefusal) return refuse((await this.mainnetEnabled()) ? e.code : "mainnet_disabled", `On mainnet: ${e.message}`, { mainnet_checks: { [e.code]: e.message } });
      throw e;
    }
    const { programHash, upgradeAuthority, authorityKnown, programSlot, p } = read;
    // Only the pool's own builder (its creator or authority, a wallet linked to them; or an admin) gets a rebuild queued.
    const mine = who.admin || (Array.isArray(who.wallets) && (who.wallets.includes(p.creator) || who.wallets.includes(p.authority)));
    const { verified, note } = mine ? await this.verification(input.program_id, programHash, user.id) : { verified: false, note: "not checked: the pool's creator or authority isn't a verified wallet linked to you" };
    const lock = await this.upgradeLock("mainnet", upgradeAuthority, input.upgrade_multisig ?? null, authorityKnown);
    const { rows: reused } = await this.db.query(`SELECT 1 FROM ${T}.treasury_pools WHERE program_id = $1 AND cluster = 'devnet' LIMIT 1`, [input.program_id]);
    const pool = await getPool(this.store, input.pool_id);
    const mainnetAttester = await this.attesterAddress("mainnet").catch(() => null);
    const checks = {
      cluster: "pass: the pool's deposit approvals are bound to mainnet",
      verified_build: verified ? "pass" : `fail: ${note}`,
      upgrade_lock: lock.status === "unlocked" ? `fail: ${lock.reason}` : `pass: ${lock.status}`,
      deposit_approval: verified && MANIFEST.deposit_approval === "MYNTDEP3" ? "pass: MYNTDEP3" : "fail: only a verified MYNTDEP3 build",
      usdc_mint: p.usdc_mint === this.mintFor("mainnet") ? "pass" : `fail: the pool holds ${p.usdc_mint}, not USDC (${this.mintFor("mainnet")})`,
      own_program_id: reused[0] ? "fail: a devnet treasury uses this program id; give the mainnet treasury its own" : "pass",
      attesters: mainnetAttester && exactAttesters(p.terms.attesters, mainnetAttester) ? "pass" : `fail: the pool's attesters must be exactly [Mynt's mainnet attester${mainnetAttester ? ` ${mainnetAttester}` : ""}, none] (get_treasury_attester with cluster mainnet)`,
      owner: mine ? "pass" : "fail: the pool's creator or authority isn't a verified Solana wallet linked to you",
      real_money_pool: pool!.sandbox ? "fail: a sandbox pool can't hold mainnet money" : "pass",
      time_lock: timeLockCovers(lock, p.terms) ? "pass" : `fail: the multisig's time lock is shorter than the pool's lock-in and notice (${p.terms.lock_in_seconds + p.terms.notice_seconds}s): depositors couldn't leave before an approved upgrade runs`,
      history: await this.historyCheck(input.pool_id, input.pool_address),
    };
    const enabled = await this.mainnetEnabled();
    const failing = Object.values(checks).some((c) => c.startsWith("fail"));
    if (!enabled) return refuse("mainnet_disabled", `${MAINNET_DISABLED}: an admin hasn't turned treasury mainnet on. Its checks there are listed in mainnet_checks`, { mainnet_checks: checks });
    if (failing) return refuse("mainnet_checks_failed", "This treasury doesn't pass every mainnet check: they're listed in mainnet_checks", { mainnet_checks: checks });
    const { rows: taken } = await this.db.query(`SELECT pool_id FROM ${T}.treasury_pools WHERE pool_address = $1 AND pool_id <> $2`, [input.pool_address, input.pool_id]);
    if (taken[0]) refuse("already_registered", "That pool account is already another pool's treasury");
    await this.db.query(
      `INSERT INTO ${T}.treasury_pools (pool_id, cluster, program_id, pool_address, vault, usdc_mint, creator, program_hash, upgrade_authority, verified_build, build_note, registered_by, deposit_approval, program_slot, upgrade_lock, upgrade_lock_detail, upgrade_multisig)
       VALUES ($1, 'mainnet', $2, $3, $4, $5, $6, $7, $8, true, NULL, $9, 'MYNTDEP3', $10, $11, $12, $13)
       ON CONFLICT (pool_id) DO UPDATE SET cluster = 'mainnet', program_id = EXCLUDED.program_id, pool_address = EXCLUDED.pool_address, vault = EXCLUDED.vault, usdc_mint = EXCLUDED.usdc_mint, creator = EXCLUDED.creator,
         program_hash = EXCLUDED.program_hash, upgrade_authority = EXCLUDED.upgrade_authority, verified_build = true, build_note = NULL, registered_by = EXCLUDED.registered_by, deposit_approval = 'MYNTDEP3',
         program_slot = EXCLUDED.program_slot, upgrade_lock = EXCLUDED.upgrade_lock, upgrade_lock_detail = EXCLUDED.upgrade_lock_detail, upgrade_multisig = EXCLUDED.upgrade_multisig,
         index_cursor = CASE WHEN ${T}.treasury_pools.pool_address = EXCLUDED.pool_address AND ${T}.treasury_pools.cluster = 'mainnet' THEN ${T}.treasury_pools.index_cursor ELSE NULL END,
         scan_before = NULL, scan_newest = NULL, attesters_flag = NULL, attesters_flagged_at = NULL, program_flag = NULL, program_flagged_at = NULL, updated_at = now()`,
      [input.pool_id, input.program_id, input.pool_address, p.vault, p.usdc_mint, p.creator, programHash, upgradeAuthority, user.id, programSlot === null ? null : programSlot.toString(), lock.status, JSON.stringify(lock), input.upgrade_multisig ?? null],
    );
    await this.store.audit(user.id, "treasury_mainnet_registered", input.pool_id, { program_id: input.program_id, pool_address: input.pool_address });
    this.cache.set(cacheKey("mainnet", input.pool_address), { at: Date.now(), pool: p });
    return this.view((await this.get(input.pool_id))!, p, null, mainnetAttester);
  }

  // A pool moving onto mainnet, or to another mainnet address, mustn't strand money or inherit another's records:
  // its current treasury holds nothing still in it (indexed deposits with money left), and the new address has no
  // records from devnet (deposits, requests and events are keyed by address, the same on both clusters).
  private async historyCheck(poolId: string, address: string): Promise<string> {
    const before = await this.get(poolId);
    if (before && (before.pool_address !== address || before.cluster !== "mainnet")) {
      const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM ${T}.treasury_deposits WHERE pool_address = $1 AND NOT rejected AND remaining > 0`, [before.pool_address]);
      if (Number((rows[0] as { n: number }).n) > 0) return `fail: its current treasury (${before.cluster} ${before.pool_address}) still holds deposits; it can't move until they're withdrawn`;
    }
    if (!(before?.cluster === "mainnet" && before.pool_address === address)) {
      const { rows } = await this.db.query(`SELECT 1 FROM ${T}.treasury_events WHERE pool_address = $1 LIMIT 1`, [address]);
      if (rows[0]) return "fail: this address has records from devnet: use a pool account that never held a devnet treasury";
    }
    return "pass";
  }

  // ---- verified builds: Mynt's own rebuild of the template at a program id ----

  // Whether these deployed bytes are the treasury template's current build at this program id: the template's own
  // id against the manifest, any other against Mynt's rebuild there. With none yet (and sandboxes to build in), one
  // is queued; a failed one is retried up to three times.
  private async verification(programId: string, programHash: string | null, userId: string): Promise<{ verified: boolean; note: string | null }> {
    if (!programHash) return { verified: false, note: "unverified build: the program's bytes couldn't be read" };
    if (programId === MANIFEST.declared_id) return programHash === MANIFEST.program_sha256 ? { verified: true, note: null } : { verified: false, note: "unverified build: not the template's current build" };
    const b = await this.templateBuild(programId);
    if (b?.status === "succeeded") return b.sha256 === programHash ? { verified: true, note: null } : { verified: false, note: `unverified build: the deployed program isn't the treasury template rebuilt at this program id (${b.sha256})` };
    if (!this.sandboxes) return { verified: false, note: "unverified build: this Mynt has no sandboxes to rebuild the treasury template at this program id" };
    if (b?.status === "queued" || b?.status === "running") return { verified: false, note: "unverified build, for now: Mynt is rebuilding the treasury template at this program id, and checks it when done" };
    // Three failures in a row wait a day before another try (a provider outage shouldn't end it for good).
    if (b?.status === "failed" && b.attempts >= 3 && b.finished_at && Date.now() - new Date(b.finished_at).getTime() < 86_400_000)
      return { verified: false, note: `unverified build: Mynt couldn't rebuild the treasury template at this program id (${b.error ?? "failed"}); it tries again a day after the last attempt` };
    // At most three rebuilds waiting or running per person: one builder can't hold up everyone else's.
    const { rows: mine } = await this.db.query(`SELECT count(*)::int AS n FROM ${T}.treasury_builds WHERE requested_by = $1 AND status IN ('queued', 'running') AND program_id <> $2`, [userId, programId]);
    if (Number((mine[0] as { n: number }).n) >= 3) return { verified: false, note: "unverified build: you have three rebuilds waiting already; register again once they're done" };
    await this.db.query(
      `INSERT INTO ${T}.treasury_builds (program_id, template_sha256, status, requested_by) VALUES ($1, $2, 'queued', $3)
       ON CONFLICT (program_id, template_sha256) DO UPDATE SET status = 'queued', error = NULL, sandbox_id = NULL, process_id = NULL, requested_by = EXCLUDED.requested_by,
         attempts = CASE WHEN ${T}.treasury_builds.attempts >= 3 THEN 0 ELSE ${T}.treasury_builds.attempts END, updated_at = now()
       WHERE ${T}.treasury_builds.status = 'failed'`,
      [programId, MANIFEST.program_sha256, userId],
    );
    return { verified: false, note: "unverified build, for now: Mynt is rebuilding the treasury template at this program id, and checks it when done" };
  }

  private async templateBuild(programId: string) {
    const { rows } = await this.db.query(`SELECT status, sha256, error, attempts, finished_at FROM ${T}.treasury_builds WHERE program_id = $1 AND template_sha256 = $2`, [programId, MANIFEST.program_sha256]);
    return (rows[0] as { status: string; sha256: string | null; error: string | null; attempts: number; finished_at: string | null } | undefined) ?? null;
  }

  // One step of the rebuild worker (every minute or so): finishes the running rebuild when its command is done (or
  // timed out), else starts the oldest queued one. One at a time; the source is Mynt's own template, never a builder's.
  async buildTick(): Promise<void> {
    if (!this.sandboxes) return;
    const sb = this.sandboxes;
    const { rows: running } = (await this.db.query(`SELECT * FROM ${T}.treasury_builds WHERE status = 'running' ORDER BY started_at LIMIT 1`)) as { rows: Row[] };
    const r = running[0];
    if (r) {
      const id = r.sandbox_id as string;
      const pid = r.process_id as number | null;
      const timedOut = Date.now() - new Date(r.started_at as string).getTime() > (this.config.verifyBuildMinutes ?? 90) * 60_000;
      let st = pid === null ? { running: false, exitCode: null } : await sb.commandStatus(id, pid).catch(() => null);
      if (st === null) {
        // Not answering: a sandbox that's gone or broken fails the rebuild now rather than holding the queue.
        const box = await sb.getSandbox(id).catch(() => null);
        st = !box || ["error", "cancelled", "archived", "archiving"].includes(box.state) ? { running: false, exitCode: null } : { running: true, exitCode: null };
      }
      if (st.running && !timedOut) return;
      const out = timedOut && st.running ? { error: `timed out after ${this.config.verifyBuildMinutes ?? 90} minutes` } : readTemplateBuild(await sb.readFile(id, `${BUILD_DIR}/out/programs.json`).catch(() => null), await sb.readFile(id, `${BUILD_DIR}/out/checks.jsonl`).catch(() => null), r.program_id as string, MANIFEST);
      await sb.stop(id).catch(() => undefined);
      await this.finishBuild(r.program_id as string, r.template_sha256 as string, out);
      return;
    }
    // Claimed before anything is created, so a second worker (or tick) can't start the same one.
    const { rows: queued } = (await this.db.query(
      `UPDATE ${T}.treasury_builds SET status = 'running', started_at = now(), attempts = attempts + 1, updated_at = now()
       WHERE (program_id, template_sha256) = (SELECT program_id, template_sha256 FROM ${T}.treasury_builds WHERE status = 'queued' AND template_sha256 = $1 ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         AND status = 'queued'
       RETURNING *`,
      [MANIFEST.program_sha256],
    )) as { rows: Row[] };
    const q = queued[0];
    if (!q) return;
    const programId = q.program_id as string;
    let sandboxId: string | null = null;
    try {
      const files = treasuryTemplateAt(programId);
      const s = await sb.createSandbox({ name: `mynt-treasury-build-${programId.slice(0, 8)}`, type: this.config.sandboxType, ttlSeconds: 3 * 3600, labels: { mynt_role: "treasury_build" }, env: {} });
      sandboxId = s.id;
      const all: Record<string, string> = { [`${BUILD_DIR}/solana-verify.sh`]: SOLANA_VERIFY_SCRIPT, [`${BUILD_DIR}/allowlist.json`]: JSON.stringify(loadCrateAllowlist()) };
      for (const [path, text] of Object.entries(files)) all[`${BUILD_DIR}/src/solana/${path}`] = text;
      if (sb.writeFiles) await sb.writeFiles(s.id, all);
      else for (const [path, text] of Object.entries(all)) await sb.writeFile(s.id, path, text);
      const run = await sb.exec(s.id, `cd ${BUILD_DIR} && bash solana-verify.sh build ${BUILD_DIR}/src ${BUILD_DIR}/out ${BUILD_DIR}/allowlist.json > ${BUILD_DIR}/build.log 2>&1`, { detached: true });
      await this.db.query(`UPDATE ${T}.treasury_builds SET sandbox_id = $3, process_id = $4, updated_at = now() WHERE program_id = $1 AND template_sha256 = $2`, [
        programId,
        q.template_sha256,
        s.id,
        run.processId ?? null,
      ]);
    } catch (e) {
      if (sandboxId) await sb.stop(sandboxId).catch(() => undefined);
      await this.db.query(`UPDATE ${T}.treasury_builds SET status = 'failed', error = $3, finished_at = now(), updated_at = now() WHERE program_id = $1 AND template_sha256 = $2`, [
        programId,
        q.template_sha256,
        `couldn't start: ${(e as Error).message.slice(0, 300)}`,
      ]);
    }
  }

  // Records a rebuild's outcome, and re-judges every pool on that program id against it.
  private async finishBuild(programId: string, template: string, out: { sha256: string } | { error: string }) {
    if ("error" in out) {
      await this.db.query(`UPDATE ${T}.treasury_builds SET status = 'failed', error = $3, finished_at = now(), updated_at = now() WHERE program_id = $1 AND template_sha256 = $2`, [programId, template, out.error.slice(0, 500)]);
      await this.db.query(`UPDATE ${T}.treasury_pools SET build_note = $2, updated_at = now() WHERE program_id = $1 AND NOT verified_build`, [programId, `unverified build: Mynt couldn't rebuild the treasury template at this program id (${out.error.slice(0, 200)})`]);
      return;
    }
    await this.db.query(`UPDATE ${T}.treasury_builds SET status = 'succeeded', sha256 = $3, error = NULL, finished_at = now(), updated_at = now() WHERE program_id = $1 AND template_sha256 = $2`, [programId, template, out.sha256]);
    if (template !== MANIFEST.program_sha256) return;
    await this.rejudge(programId, out.sha256);
  }

  // Judges every pool on this program id against Mynt's rebuild there. A pool whose program was redeployed since it
  // was registered (its recorded hash is stale) isn't judged on that hash: it's told to register again.
  private async rejudge(programId: string, sha256: string) {
    const { rows } = await this.db.query(`SELECT DISTINCT cluster FROM ${T}.treasury_pools WHERE program_id = $1`, [programId]);
    for (const { cluster } of rows as { cluster: Cluster }[]) await this.rejudgeOn(cluster, programId, sha256);
  }

  // Each cluster's pools on the program id against that cluster's program, never another's.
  private async rejudgeOn(cluster: Cluster, programId: string, sha256: string) {
    const slot = await this.onCluster.run(cluster, () => this.programSlotNow(programId)).catch(() => undefined);
    await this.db.query(
      `UPDATE ${T}.treasury_pools SET build_note = 'redeployed since it was registered: register it again to check it', verified_build = false, updated_at = now()
       WHERE program_id = $1 AND cluster = $3 AND $2::text IS DISTINCT FROM program_slot::text`,
      [programId, slot === undefined ? "unknown" : slot, cluster],
    );
    await this.db.query(
      `UPDATE ${T}.treasury_pools SET verified_build = (program_hash = $2 AND deposit_approval = $3),
         build_note = CASE WHEN program_hash = $2 AND deposit_approval = $3 THEN NULL
                           WHEN program_hash = $2 THEN 'verified bytes, but registered with another deposit approval layout: register it again'
                           ELSE 'unverified build: the deployed program isn''t the treasury template rebuilt at this program id (' || $2 || ')' END,
         updated_at = now()
       WHERE program_id = $1 AND cluster = $5 AND $4::text IS NOT DISTINCT FROM program_slot::text`,
      [programId, sha256, MANIFEST.deposit_approval ?? "MYNTDEP3", slot === undefined ? "unknown" : slot, cluster],
    );
  }

  private async programSlotNow(programId: string): Promise<string | null> {
    const [programData] = findProgramAddress([pubkeyBytes(programId)], UPGRADEABLE_LOADER);
    const r = await this.call<{ value: AccountInfo | null }>("getAccountInfo", [programData, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 12 } }]);
    const b = r?.value ? Buffer.from(this.bytes(r.value)) : null;
    return b && b.length >= 12 && b.readUInt32LE(0) === 3 ? b.readBigUInt64LE(4).toString() : null;
  }

  // A timelocked multisig weakened since registration (its time lock, threshold or members, which its own proposals
  // can change) is caught before any approval: recorded as unlocked, and Mynt stops until the builder registers it
  // again. Checked before the approval's transaction (so the record stays); weakening a multisig itself waits out its
  // time lock, so nothing slips in between.
  private async multisigStillLocked(row: TreasuryRow) {
    if (row.upgrade_lock === "timelocked_multisig" && row.upgrade_multisig) {
      const before = row.upgrade_lock_detail as { time_lock_seconds: number; threshold: number } | null;
      const now = await this.upgradeLock(row.cluster, row.upgrade_authority, row.upgrade_multisig);
      if (now.status !== "timelocked_multisig" || (before && (now.time_lock_seconds < before.time_lock_seconds || now.threshold < before.threshold))) {
        await this.db.query(`UPDATE ${T}.treasury_pools SET upgrade_lock = 'unlocked', upgrade_lock_detail = $2, updated_at = now() WHERE pool_id = $1`, [
          row.pool_id,
          JSON.stringify({ status: "unlocked", reason: `its multisig changed since registration: ${now.status === "unlocked" ? now.reason : "a shorter time lock or a lower threshold"}` }),
        ]);
        refuse("upgrade_lock_changed", "The multisig that can upgrade the pool's program was weakened since it was registered: Mynt approves no deposits to it until its builder registers it again");
      }
    }
  }

  // MYNTDEP3 is checked against the program as registered: one upgraded since might no longer spend approvals, so it's
  // refused until its builder registers it again (which re-reads its bytes and layout).
  private async unchangedProgram(row: TreasuryRow) {
    if (row.program_slot === null) refuse("program_upgraded", "The pool's program couldn't be read when it was registered: Mynt approves no deposits to it until its builder registers it again");
    const [programData] = findProgramAddress([pubkeyBytes(row.program_id)], UPGRADEABLE_LOADER);
    const r = await this.call<{ value: AccountInfo | null }>("getAccountInfo", [programData, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 45 } }]);
    const b = r?.value ? Buffer.from(this.bytes(r.value)) : null;
    const slot = b && b.length >= 12 && b.readUInt32LE(0) === 3 ? b.readBigUInt64LE(4).toString() : null;
    if (slot !== row.program_slot) refuse("program_upgraded", "The pool's program was upgraded (or closed) since it was registered: Mynt approves no deposits to it until its builder registers it again");
    // Handing the upgrade authority to someone else doesn't redeploy the program, so it's checked on its own.
    const authority = b && b.length >= 45 ? (b[12] === 1 ? base58Encode(b.subarray(13, 45)) : null) : undefined;
    if (authority === undefined || authority !== row.upgrade_authority)
      refuse("program_upgraded", "The pool's program has a different upgrade authority since it was registered: Mynt approves no deposits to it until its builder registers it again");
  }

  // The positions of these wallets in the pool, and the cluster's clock, as on chain now: the clock rides in the first
  // read, so it's from the same slot as the first hundred positions. clusterNow is null when the clock can't be read.
  private async positionsOf(row: TreasuryRow, wallets: string[]) {
    const positions = new Map<string, NonNullable<ReturnType<typeof decodePosition>>>();
    let clusterNow: number | null = null;
    const addresses = [SYSVAR_CLOCK, ...wallets.map((w) => positionAddress(row.program_id, row.pool_address, w))];
    for (let i = 0; i < addresses.length; i += 100) {
      const chunk = addresses.slice(i, i + 100);
      const r = await this.call<{ value: (AccountInfo | null)[] }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "confirmed" }]);
      chunk.forEach((_, j) => {
        const a = r?.value?.[j];
        if (i + j === 0) {
          // Clock: slot, epoch_start_timestamp, epoch, leader_schedule_epoch (8 bytes each), then unix_timestamp.
          const b = a ? Buffer.from(this.bytes(a)) : null;
          if (b && b.length >= 40) clusterNow = Number(b.readBigInt64LE(32));
          return;
        }
        const p = a && a.owner === row.program_id ? decodePosition(this.bytes(a)) : null;
        if (p) positions.set(wallets[i + j - 1], p);
      });
    }
    return { positions, clusterNow: clusterNow as number | null };
  }

  async prepareWithdrawal(s: Standing, input: { pool_id: string; wallet: string; deposit: string; amount_usdc_base_units: number; max_notice_seconds: number }) {
    this.limit(s.user.id, "prepare", this.config.prepareLimitPerMinute ?? 20);
    const { pool, row, firm } = await this.eligible(s, input.pool_id, { exit: true });
    return this.onCluster.run(row.cluster, () => this.withdrawalOn(s, input, pool, row, firm));
  }

  private async withdrawalOn(s: Standing, input: { pool_id: string; wallet: string; deposit: string; amount_usdc_base_units: number; max_notice_seconds: number }, pool: Pool, row: TreasuryRow, firm: string) {
    this.linked(s, input.wallet);
    const amount = BigInt(input.amount_usdc_base_units);
    if (!isAddress(input.deposit)) refuse("deposit_not_found", "deposit is the deposit record's address");
    const p = await this.poolAccount(row, true);
    const info = await this.account(input.deposit);
    const d = info && info.owner === row.program_id ? decodeDeposit(this.bytes(info)) : null;
    if (!d || d.pool !== row.pool_address || d.depositor !== input.wallet) refuse("deposit_not_found", "No deposit of that wallet at that address in this pool");
    const dep = d!;
    const nowS = BigInt(Math.floor(this.now().getTime() / 1000));
    const windingDown = p.wind_down_at !== 0n && nowS >= p.wind_down_at;
    if (dep.rejected) refuse("deposit_rejected", "That deposit was refused and refunded");
    if (!windingDown && nowS < dep.review_until) refuse("in_review", `The deposit is in its review window until ${iso(dep.review_until)}`, { review_until: iso(dep.review_until) });
    if (!windingDown && nowS < dep.unlock_at) refuse("deposit_locked", `The deposit is locked in until ${iso(dep.unlock_at)}`, { unlock_at: iso(dep.unlock_at) });
    const free = dep.remaining - dep.queued;
    if (amount <= 0n || amount > free) refuse("over_limit", `At most ${free} base units of that deposit can be requested (what's left less what's already queued)`, { available: units(free) });
    if (amount < p.terms.min_request && amount !== free) refuse("below_min_request", `A request is at least ${p.terms.min_request} base units unless it's all that's left`, { min_request: units(p.terms.min_request) });
    const notice = dep.notice_seconds < p.terms.notice_seconds ? dep.notice_seconds : p.terms.notice_seconds;
    if (notice > BigInt(input.max_notice_seconds)) refuse("terms_changed", `The notice is ${notice} seconds, longer than the ${input.max_notice_seconds} you agreed to`, { notice_seconds: Number(notice) });
    const tx = await this.unsigned(input.wallet, [
      requestWithdrawalInstruction({ programId: row.program_id, pool: row.pool_address, deposit: input.deposit, depositor: input.wallet, nextRequestSeq: p.next_request_seq, amount, maxNoticeSeconds: BigInt(input.max_notice_seconds) }),
    ]);
    await this.remember(input.wallet, firm, s.user.id);
    return {
      cluster: row.cluster,
      // Exits are never blocked, but the wallet should hear that the program changed since it was registered.
      ...(row.program_flag ? { warning: `This pool's program changed since it was registered (${row.program_flag}): check the transaction in your wallet before signing` } : {}),
      transaction_base64: tx.base64,
      // No attestation: only the blockhash ages (about a minute), after which it's prepared again.
      expires_at: new Date(this.now().getTime() + 60_000).toISOString(),
      last_valid_block_height: tx.lastValidBlockHeight,
      summary: {
        pool: pool.name,
        pool_id: pool.id,
        pool_address: row.pool_address,
        amount: units(amount),
        deposit: input.deposit,
        lock_in_seconds: Number(dep.lock_in_seconds),
        notice_seconds: Number(notice),
        payable_from: iso(nowS + notice),
        wallet: input.wallet,
      },
    };
  }

  // An unsigned v0 transaction: the wallet pays and is the only signer. Read back before it goes, so nothing of
  // Mynt's is ever a signer or an account of it.
  private async unsigned(wallet: string, ixs: ReturnType<typeof ed25519Instruction>[]) {
    const { blockhash, lastValidBlockHeight } = await this.blockhash();
    const message = compileV0Message(wallet, ixs, blockhash);
    const bytes = unsignedTransaction(message);
    const back = decodeV0Transaction(bytes);
    if (back.numSigners !== 1 || back.keys[0] !== wallet) throw new Error("A prepared transaction must have the wallet as its only signer");
    return { base64: Buffer.from(bytes).toString("base64"), lastValidBlockHeight };
  }

  // ---- balances ----

  async balances(address: string, cluster: string) {
    if (cluster !== "devnet" && cluster !== "mainnet") refuse("mainnet_disabled", MAINNET_DISABLED);
    // A read: allowed with the switch off too (when Mynt has a mainnet RPC), so people can still see their money.
    const c = cluster as Cluster;
    this.mainnetReachable(c);
    const sol = await this.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }], c);
    const mint = this.mintFor(c);
    const ata = associatedTokenAddress(address, mint);
    const info = await this.account(ata, c);
    const token = info && info.owner === TOKEN_PROGRAM ? decodeTokenAccount(this.bytes(info)) : null;
    return { address, cluster: c, sol_lamports: sol.value, usdc_base_units: units(token?.amount ?? 0n), usdc_mint: mint, usdc_account: ata };
  }

  // ---- the watch ----

  // Every few minutes, for every registered pool: is its program still the one registered (same last-deployed slot),
  // its upgrade authority the same, and its multisig (if one holds it) no weaker? A change flags the pool
  // (program_flag, audited as treasury_program_flagged, counted in ops_status): Mynt approves no deposits to it until
  // its builder registers it again. Withdrawal requests aren't affected. An unreadable chain flags nothing.
  async watch(): Promise<{ checked: number; flagged: number }> {
    let checked = 0;
    let flagged = 0;
    for (const row of await this.all()) {
      if (row.program_flag) continue;
      try {
        const why = await this.onCluster.run(row.cluster, () => this.programChange(row));
        checked++;
        if (why && (await this.flagProgram(row, why))) flagged++;
      } catch (e) {
        if (!(e instanceof TreasuryRefusal && e.code === "rpc_unavailable")) console.error(`treasury watch: ${row.pool_address}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    return { checked, flagged };
  }

  // What changed about the pool's program since registration, or null.
  private async programChange(row: TreasuryRow): Promise<string | null> {
    if (row.program_slot === null) return null; // never read at registration: already refused for approvals
    const [programData] = findProgramAddress([pubkeyBytes(row.program_id)], UPGRADEABLE_LOADER);
    const r = await this.call<{ value: AccountInfo | null }>("getAccountInfo", [programData, { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 45 } }]);
    const b = r?.value ? Buffer.from(this.bytes(r.value)) : null;
    if (!b || b.length < 45 || b.readUInt32LE(0) !== 3) return "its program was closed";
    if (b.readBigUInt64LE(4).toString() !== row.program_slot) return "its program was redeployed since it was registered";
    const authority = b[12] === 1 ? base58Encode(b.subarray(13, 45)) : null;
    if (authority !== row.upgrade_authority) return `its upgrade authority changed since it was registered (now ${authority ?? "none"})`;
    if (row.upgrade_lock === "timelocked_multisig" && row.upgrade_multisig) {
      const before = row.upgrade_lock_detail as { time_lock_seconds: number; threshold: number } | null;
      const now = await this.upgradeLock(row.cluster, row.upgrade_authority, row.upgrade_multisig);
      if (now.status !== "timelocked_multisig") return `the multisig that can upgrade it is no longer locked: ${now.status === "unlocked" ? now.reason : now.status}`;
      if (before && (now.time_lock_seconds < before.time_lock_seconds || now.threshold < before.threshold))
        return `the multisig that can upgrade it was weakened (time lock ${before.time_lock_seconds}s to ${now.time_lock_seconds}s, threshold ${before.threshold} to ${now.threshold})`;
    }
    return null;
  }

  private async flagProgram(row: TreasuryRow, why: string): Promise<boolean> {
    // Only if the pool is still registered as it was when read (a registration meanwhile is judged afresh).
    const { rows } = await this.db.query(
      `UPDATE ${T}.treasury_pools SET program_flag = $2, program_flagged_at = now()
       WHERE pool_id = $1 AND program_flag IS NULL AND program_slot::text IS NOT DISTINCT FROM $3::text AND upgrade_authority IS NOT DISTINCT FROM $4 AND upgrade_multisig IS NOT DISTINCT FROM $5
       RETURNING pool_id`,
      [row.pool_id, why, row.program_slot, row.upgrade_authority, row.upgrade_multisig],
    );
    if (rows.length) await this.store.audit(null, "treasury_program_flagged", row.pool_id, { cluster: row.cluster, pool_address: row.pool_address, reason: why });
    return rows.length > 0;
  }

  // ---- the indexer ----

  async index() {
    let events = 0;
    // Pools asked for first (a transaction they touched was confirmed), then the rest.
    const rows = (await this.db.query(`SELECT * FROM ${T}.treasury_pools ORDER BY index_requested_at DESC NULLS LAST, created_at`)).rows as unknown as TreasuryRow[];
    for (const row of rows) {
      try {
        events += await this.indexPool(row);
      } catch (e) {
        console.error(`treasury indexer: ${row.pool_address}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    return { events };
  }

  // The pools asked for, indexed in the background, one run at a time.
  private kick() {
    if (this.kicking) return;
    this.kicking = (async () => {
      try {
        const rows = (await this.db.query(`SELECT * FROM ${T}.treasury_pools WHERE index_requested_at IS NOT NULL ORDER BY index_requested_at`)).rows as unknown as TreasuryRow[];
        for (const row of rows) await this.indexPool(row).catch((e) => console.error(`treasury indexer: ${row.pool_address}: ${(e as Error).message.slice(0, 200)}`));
      } finally {
        this.kicking = null;
      }
    })();
  }
  // For tests: until the background indexing the status checks asked for has finished.
  async idle() {
    while (this.kicking) await this.kicking;
  }

  // Two steps, with bounded work per poll and nothing ever skipped. A scan pages backward from the newest signature
  // to the stored cursor (indexPagesPerPoll pages a poll, resuming where it stopped), keeping what it finds; once it
  // reaches the cursor, the cursor moves to the newest signature it started from. Then what it found is read oldest
  // first, indexPerPoll a poll; a new scan starts only once all of it has been read.
  async indexPool(row: TreasuryRow): Promise<number> {
    return this.onCluster.run(row.cluster, () => this.indexPoolOn(row));
  }

  private async indexPoolOn(row: TreasuryRow): Promise<number> {
    await this.db.query(`UPDATE ${T}.treasury_pools SET index_requested_at = NULL WHERE pool_id = $1`, [row.pool_id]);
    const fresh = (await this.db.query(`SELECT * FROM ${T}.treasury_pools WHERE pool_id = $1`, [row.pool_id])).rows[0] as unknown as TreasuryRow | undefined;
    if (!fresh) return 0;
    let applied = 0;
    if (!fresh.scan_newest && (await this.pending(fresh.pool_id)) > 0) applied += await this.readPending(fresh);
    else if (await this.scan(fresh)) applied += await this.readPending(fresh);
    if (applied) this.cache.delete(cacheKey(fresh.cluster, fresh.pool_address));
    return applied;
  }

  private async pending(poolId: string) {
    return Number((await this.db.query(`SELECT count(*)::int AS n FROM ${T}.treasury_pending WHERE pool_id = $1`, [poolId])).rows[0]?.n ?? 0);
  }

  // Pages of the scan; true once it has reached the cursor.
  private async scan(row: TreasuryRow): Promise<boolean> {
    const rpc = this.rpc();
    let before = row.scan_before ?? undefined;
    let newest = row.scan_newest;
    let pages = Number(row.scan_pages ?? 0);
    for (let i = 0; i < (this.config.indexPagesPerPoll ?? 5); i++) {
      const sigs = await rpc.call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [
        row.pool_address,
        { limit: 1000, commitment: "confirmed", ...(row.index_cursor ? { until: row.index_cursor } : {}), ...(before ? { before } : {}) },
      ]);
      if (!newest && sigs.length) newest = sigs[0].signature;
      for (const [k, x] of sigs.entries())
        await this.db.query(`INSERT INTO ${T}.treasury_pending (pool_id, signature, slot, pos, failed) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [row.pool_id, x.signature, x.slot ?? 0, pages * 1000 + k, !!x.err]);
      pages++;
      if (sigs.length < 1000) {
        await this.db.query(`UPDATE ${T}.treasury_pools SET index_cursor = COALESCE($2, index_cursor), scan_before = NULL, scan_newest = NULL, scan_pages = 0, indexed_at = now() WHERE pool_id = $1`, [row.pool_id, newest]);
        row.index_cursor = newest ?? row.index_cursor;
        row.scan_before = row.scan_newest = null;
        return true;
      }
      before = sigs[sigs.length - 1].signature;
      await this.db.query(`UPDATE ${T}.treasury_pools SET scan_before = $2, scan_newest = $3, scan_pages = $4 WHERE pool_id = $1`, [row.pool_id, before, newest, pages]);
    }
    return false;
  }

  // What the scan found, oldest first, indexPerPoll at a time.
  private async readPending(row: TreasuryRow): Promise<number> {
    const rpc = this.rpc();
    const { rows } = await this.db.query(`SELECT signature, slot, failed FROM ${T}.treasury_pending WHERE pool_id = $1 ORDER BY slot ASC, pos DESC LIMIT $2`, [row.pool_id, this.config.indexPerPoll]);
    let applied = 0;
    for (const s of rows as { signature: string; slot: unknown; failed: boolean }[]) {
      if (!s.failed) {
        const tx = await rpc.call<{ slot: number; meta: { err: unknown; logMessages?: string[] } | null } | null>("getTransaction", [s.signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
        if (tx && !tx.meta?.err) {
          const events = programEvents(row.program_id, tx.meta?.logMessages ?? []).map(decodeEvent);
          for (const [i, e] of events.entries()) {
            if (!e) continue;
            if (e.name !== "other" && e.pool !== row.pool_address) continue;
            if (await this.record(row.pool_address, s.signature, i, tx.slot ?? Number(s.slot), e)) {
              applied++;
              await this.watchAttesters(row, e);
            }
          }
        }
      }
      await this.db.query(`DELETE FROM ${T}.treasury_pending WHERE pool_id = $1 AND signature = $2`, [row.pool_id, s.signature]);
    }
    return applied;
  }

  // A terms change or a removal that leaves the attesters other than [Mynt's, none] stops Mynt's approvals for the pool.
  private async watchAttesters(row: TreasuryRow, e: TreasuryEvent) {
    if (e.name === "AttesterRemoved") return this.flag(row, `attester ${e.attester} was removed on chain`);
    if (e.name !== "TermsApplied") return;
    let mynt: string;
    try {
      mynt = await this.attesterAddress(row.cluster);
    } catch {
      return this.flag(row, "a terms change was applied and Mynt's attester couldn't be read to check it");
    }
    if (!exactAttesters(e.attesters, mynt)) await this.flag(row, `a terms change set the attesters to [${e.attesters.join(", ")}]`);
  }

  private async flag(row: TreasuryRow, why: string) {
    const { rows } = await this.db.query(`UPDATE ${T}.treasury_pools SET attesters_flag = $2, attesters_flagged_at = now() WHERE pool_id = $1 AND attesters_flag IS NULL RETURNING pool_id`, [row.pool_id, why]);
    row.attesters_flag = why;
    if (rows.length) await this.store.audit(null, "treasury_attesters_flagged", row.pool_id, { pool_address: row.pool_address, reason: why });
  }

  // One event, once: recorded, then applied to the deposits and requests it changes, together.
  private async record(poolAddress: string, signature: string, idx: number, slot: number, e: TreasuryEvent): Promise<boolean> {
    const data = JSON.parse(JSON.stringify(e, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const run = async (q: Pick<Db, "query">) => {
      const { rows } = await q.query(
        `INSERT INTO ${T}.treasury_events (id, pool_address, signature, idx, slot, event, data) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (pool_address, signature, idx) DO NOTHING RETURNING id`,
        [randomUUID(), poolAddress, signature, idx, slot, e.name === "other" ? e.event : e.name, JSON.stringify(data)],
      );
      if (!rows.length) return false;
      await applyEvent(q, e, signature);
      return true;
    };
    return this.db.transaction ? this.db.transaction(run) : run(this.db);
  }

  // ---- positions ----

  // The firm's wallets: the caller's own linked ones (when they're at this firm), and those its people prepared from,
  // each only while that person is still at the firm and the wallet is still linked to them. A record whose person left
  // the firm or unlinked the wallet is dropped; one whose links can't be read now is left out until they can.
  async walletsOf(firm: string, s: Standing): Promise<string[]> {
    const out = new Set<string>(s.user.entity_id === firm && Array.isArray(s.wallets) ? s.wallets : []);
    const { rows } = await this.db.query(`SELECT wallet, user_id FROM ${T}.treasury_wallets WHERE lp_entity_id = $1`, [firm]);
    const byUser = new Map<string, string[]>();
    for (const r of rows as { wallet: string; user_id: string }[]) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.wallet]);
    for (const [userId, wallets] of byUser) {
      const person = await this.store.getUser(userId);
      if (!person || person.entity_id !== firm) {
        await this.db.query(`DELETE FROM ${T}.treasury_wallets WHERE lp_entity_id = $1 AND user_id = $2`, [firm, userId]);
        continue;
      }
      const linked = userId === s.user.id && Array.isArray(s.wallets) ? s.wallets : await s.linkedOf(userId).catch(() => null);
      if (!linked) continue;
      for (const w of wallets) {
        if (linked.includes(w)) out.add(w);
        else await this.db.query(`DELETE FROM ${T}.treasury_wallets WHERE wallet = $1 AND lp_entity_id = $2 AND user_id = $3`, [w, firm, userId]);
      }
    }
    return [...out];
  }

  async positions(wallets: string[], poolId?: string) {
    if (!wallets.length) return [];
    const { rows: pools } = await this.db.query(
      `SELECT t.pool_id, t.cluster, t.program_id, t.pool_address, p.name, p.product_id FROM ${T}.treasury_pools t JOIN ${T}.liquidity_pools p ON p.id = t.pool_id WHERE ($1::uuid IS NULL OR t.pool_id = $1) ORDER BY t.created_at`,
      [poolId ?? null],
    );
    if (!pools.length) return [];
    const addresses = pools.map((p) => p.pool_address as string);
    const { rows: deposits } = await this.db.query(`SELECT * FROM ${T}.treasury_deposits WHERE pool_address = ANY($1::text[]) AND depositor = ANY($2::text[]) ORDER BY seq`, [addresses, wallets]);
    const { rows: requests } = await this.db.query(`SELECT * FROM ${T}.treasury_requests WHERE pool_address = ANY($1::text[]) AND depositor = ANY($2::text[]) ORDER BY seq`, [addresses, wallets]);
    // The wind-down surplus each wallet claimed: the only return a treasury pays. A claim recorded before Mynt read
    // its amount (stored without one) leaves that wallet's total unknown.
    const { rows: claims } = await this.db.query(`SELECT pool_address, data FROM ${T}.treasury_events WHERE event = 'SurplusClaimed' AND pool_address = ANY($1::text[])`, [addresses]);
    const nowS = Math.floor(this.now().getTime() / 1000);
    const out = [];
    for (const p of pools as Row[]) {
      for (const wallet of wallets) {
        const ds = deposits.filter((d) => d.pool_address === p.pool_address && d.depositor === wallet);
        const rs = requests.filter((r) => r.pool_address === p.pool_address && r.depositor === wallet);
        if (!ds.length && !rs.length) continue;
        const sum = (xs: Row[], k: string) => xs.reduce((n, x) => n + big(x[k]), 0n);
        const live = ds.filter((d) => !d.rejected);
        const queued = sum(rs.filter((r) => r.status === "open" || r.status === "parked"), "remaining");
        const principal = sum(live, "remaining");
        const unlocked = live.filter((d) => Number(d.unlock_at) <= nowS && Number(d.review_until) <= nowS).reduce((n, d) => n + big(d.remaining) - big(d.queued), 0n);
        const mine = claims.filter((c) => c.pool_address === p.pool_address && ((c.data as Row | null)?.depositor === wallet || (c.data as Row | null)?.depositor === undefined));
        const surplus = mine.some((c) => (c.data as Row | null)?.amount === undefined) ? null : mine.reduce((n, c) => n + big((c.data as Row).amount), 0n);
        out.push({
          source: "on-chain" as const,
          cluster: p.cluster as Cluster,
          pool_id: p.pool_id as string,
          name: p.name as string,
          product_id: p.product_id as string,
          program_id: p.program_id as string,
          pool_address: p.pool_address as string,
          wallet,
          sandbox: p.cluster !== "mainnet", // devnet USDC is test money; mainnet's is real
          principal: units(principal),
          deposited: units(sum(live, "amount")),
          paid: units(sum(rs, "paid")),
          queued: units(queued),
          available_to_request: units(unlocked),
          // What the wallet has been paid beyond its principal (wind-down surplus); null if a claim's amount is unknown.
          surplus_claimed: surplus === null ? null : units(surplus),
          deposits: ds.map((d) => ({
            deposit: d.address as string, // the deposit record's address: prepare_treasury_withdrawal's `deposit`
            address: d.address as string,
            seq: units(big(d.seq)),
            amount: units(big(d.amount)),
            remaining: units(big(d.remaining)),
            queued: units(big(d.queued)),
            settled_at: iso(Number(d.settled_at)),
            review_until: iso(Number(d.review_until)),
            unlock_at: iso(Number(d.unlock_at)),
            unlocks_at: iso(Number(d.unlock_at)),
            lock_in_seconds: Number(d.unlock_at) - Number(d.settled_at),
            unlocked: Number(d.unlock_at) <= nowS,
            rejected: d.rejected as boolean,
            signature: d.signature as string,
          })),
          requests: rs.map((r) => ({
            address: r.address as string,
            seq: units(big(r.seq)),
            deposit: r.deposit as string,
            amount: units(big(r.amount)),
            remaining: units(big(r.remaining)),
            paid: units(big(r.paid)),
            payable_at: iso(Number(r.payable_at)),
            status: r.status as string,
            signature: r.signature as string,
          })),
        });
      }
    }
    return out;
  }

  // ---- a sent transaction ----

  async txStatus(user: User, signature: string, cluster: Cluster = "devnet") {
    // A read: allowed with the switch off too, so a withdrawal request can be followed.
    this.mainnetReachable(cluster);
    return this.onCluster.run(cluster, () => this.txStatusOn(user, signature, cluster));
  }

  private async txStatusOn(user: User, signature: string, cluster: Cluster) {
    this.limit(user.id, "get_treasury_tx_status", this.config.statusLimitPerMinute ?? 30);
    let ok = false;
    try {
      ok = base58Decode(signature).length === 64;
    } catch {
      ok = false;
    }
    if (!ok) refuse("not_a_signature", "signature is a transaction signature, in base58");
    const r = await this.call<{ value: ({ slot: number; err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const st = r.value?.[0] ?? null;
    const status = !st ? "not_found" : st.err ? "failed" : (st.confirmationStatus ?? "processed");
    const queued: string[] = [];
    // Confirmed: the registered pools it touched are indexed next, in the background, so positions show it soon.
    if (status === "confirmed" || status === "finalized") {
      const tx = await this.call<{ transaction?: { message?: { accountKeys?: string[] } } } | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
      const keys = new Set(tx?.transaction?.message?.accountKeys ?? []);
      for (const row of await this.all()) {
        if (row.cluster !== cluster || !keys.has(row.pool_address)) continue;
        await this.db.query(`UPDATE ${T}.treasury_pools SET index_requested_at = now() WHERE pool_id = $1`, [row.pool_id]);
        queued.push(row.pool_id);
      }
      if (queued.length) this.kick();
    }
    return { signature, cluster, status, err: st?.err ?? null, slot: st?.slot ?? null, queued_pools: queued };
  }
}

// How one event changes the deposits and requests it names.
export async function applyEvent(q: Pick<Db, "query">, e: TreasuryEvent, signature: string) {
  const s = (v: bigint) => v.toString();
  switch (e.name) {
    case "DepositMade":
      await q.query(
        `INSERT INTO ${T}.treasury_deposits (address, pool_address, depositor, seq, amount, remaining, queued, settled_at, review_until, unlock_at, rejected, signature)
         VALUES ($1, $2, $3, $4, $5, $5, 0, $6, $7, $8, false, $9) ON CONFLICT (address) DO NOTHING`,
        [e.deposit, e.pool, e.depositor, s(e.seq), s(e.amount), s(e.settled_at), s(e.review_until), s(e.unlock_at), signature],
      );
      return;
    case "DepositRejected":
      await q.query(`UPDATE ${T}.treasury_deposits SET rejected = true, remaining = GREATEST(remaining - $2::numeric, 0) WHERE address = $1`, [e.deposit, s(e.refunded)]);
      return;
    case "WithdrawalRequested":
      await q.query(
        `INSERT INTO ${T}.treasury_requests (address, pool_address, depositor, deposit, seq, amount, remaining, paid, payable_at, status, signature) VALUES ($1, $2, $3, $4, $5, $6, $6, 0, $7, 'open', $8) ON CONFLICT (address) DO NOTHING`,
        [e.request, e.pool, e.depositor, e.deposit, s(e.seq), s(e.amount), s(e.payable_at), signature],
      );
      await q.query(`UPDATE ${T}.treasury_deposits SET queued = queued + $2::numeric WHERE address = $1`, [e.deposit, s(e.amount)]);
      return;
    case "WithdrawalPaid":
      await q.query(`UPDATE ${T}.treasury_requests SET paid = paid + $2::numeric, remaining = $3::numeric, status = CASE WHEN $3::numeric = 0 THEN 'paid' ELSE status END WHERE address = $1`, [e.request, s(e.amount), s(e.remaining)]);
      await q.query(
        `UPDATE ${T}.treasury_deposits SET remaining = GREATEST(remaining - $2::numeric, 0), queued = GREATEST(queued - $2::numeric, 0) WHERE address = (SELECT deposit FROM ${T}.treasury_requests WHERE address = $1)`,
        [e.request, s(e.amount)],
      );
      return;
    case "RequestCancelled":
    case "RequestVoided":
      await q.query(`UPDATE ${T}.treasury_requests SET status = $2, remaining = 0 WHERE address = $1`, [e.request, e.name === "RequestCancelled" ? "cancelled" : "voided"]);
      await q.query(`UPDATE ${T}.treasury_deposits SET queued = GREATEST(queued - $2::numeric, 0) WHERE address = (SELECT deposit FROM ${T}.treasury_requests WHERE address = $1)`, [e.request, s(e.amount)]);
      return;
    case "RequestParked":
      await q.query(`UPDATE ${T}.treasury_requests SET status = 'parked' WHERE address = $1`, [e.request]);
      return;
    default:
      return;
  }
}
