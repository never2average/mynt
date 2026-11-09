import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { emitFirmEvent } from "../runtime.js";
import type { Store, User } from "../store.js";
import { open, seal, vaultAvailable } from "../vault.js";
import { anchorDiscriminator, base58Encode, executableHash, findProgramAddress, isAddress, Keypair } from "./codec.js";
import { CLUSTERS, GenesisCheckedRpc, HttpSolanaRpc, RateLimiter, rpcMaxRetryMsFromEnv, rpcPaceFromEnv, rpcUrlsFromEnv, type Cluster, type SolanaRpc } from "./rpc.js";
import {
  CustodyServiceSigner,
  MAINNET_NOT_CONFIGURED,
  MultisigSigner,
  SignerNotConfigured,
  VaultSigner,
  type CustodyServiceClient,
  type MainnetBackend,
  type MultisigClient,
  type SolanaSigner,
} from "./signer.js";
import { turnkeyFromEnv } from "./custody/turnkey.js";
import {
  BUFFER_HEADER,
  compileMessage,
  loader,
  NONCE_ACCOUNT_SIZE,
  PROGRAM_ACCOUNT_SIZE,
  PROGRAMDATA_HEADER,
  serializeTransaction,
  SYSTEM_PROGRAM,
  signatureOf,
  system,
  UPGRADEABLE_LOADER,
  WRITE_CHUNK,
  type Instruction,
} from "./tx.js";

// Developers' Solana programs: Mynt reserves each program's address, builds the program itself from verified
// source (never the coding agent's artifact), deploys and upgrades it with its own signer, simulates and sends
// calls to it, and watches it for events, which go to the owning firm's webhooks. Nothing here reaches a
// customer: customers only ever see dollars.

const T = "financial_products";
const TABLES = `
  -- Mynt's Solana keys, sealed under MYNT_VAULT_KEY: each cluster's deploy authority, a caller key per developer,
  -- and each reserved program's own keypair (needed once, for the first deploy).
  CREATE TABLE IF NOT EXISTS ${T}.solana_keys (
    id uuid PRIMARY KEY,
    cluster text NOT NULL,
    role text NOT NULL,
    scope text NOT NULL DEFAULT '',
    public_key text NOT NULL,
    sealed text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (cluster, role, scope)
  );
  -- The program registry.
  CREATE TABLE IF NOT EXISTS ${T}.solana_programs (
    id uuid PRIMARY KEY,
    name text NOT NULL,
    cluster text NOT NULL,
    program_id text NOT NULL UNIQUE,
    owner_id uuid NOT NULL REFERENCES ${T}.users(id),
    entity_id uuid,
    app_id uuid,
    product_id text,
    status text NOT NULL,
    operation text,
    operation_started_at timestamptz,
    version integer NOT NULL DEFAULT 0,
    build_id uuid,
    verifiable_hash text,
    deployer text,
    upgrade_authority text,
    signer_backend text,
    deployed_tx text,
    programdata_address text,
    max_data_len integer,
    index_cursor text,
    pending_build_id uuid,
    error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE ${T}.solana_programs ADD COLUMN IF NOT EXISTS pending_build_id uuid;
  -- The Cargo.lock each build compiled with (sha256): with the program's own hash, what a rebuild must match.
  ALTER TABLE ${T}.solana_programs ADD COLUMN IF NOT EXISTS cargo_lock_sha256 text;
  CREATE INDEX IF NOT EXISTS solana_programs_owner_idx ON ${T}.solana_programs (owner_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS ${T}.solana_program_versions (
    id uuid PRIMARY KEY,
    program uuid NOT NULL REFERENCES ${T}.solana_programs(id),
    version integer NOT NULL,
    action text NOT NULL,
    build_id uuid NOT NULL,
    verifiable_hash text NOT NULL,
    tx text NOT NULL,
    signer_backend text NOT NULL,
    by_user uuid,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- What Mynt built from a verified build's source, in its own clean sandbox: the program bytes and IDL.
  CREATE TABLE IF NOT EXISTS ${T}.solana_program_artifacts (
    id uuid PRIMARY KEY,
    build_id uuid NOT NULL,
    name text NOT NULL,
    declared_id text,
    sha256 text NOT NULL,
    size integer NOT NULL,
    program_b64 text NOT NULL,
    idl jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (build_id, name)
  );
  ALTER TABLE ${T}.solana_program_artifacts ADD COLUMN IF NOT EXISTS cargo_lock_sha256 text;
  ALTER TABLE ${T}.solana_program_versions ADD COLUMN IF NOT EXISTS cargo_lock_sha256 text;
  -- The workspace source Mynt captured with a build's programs (Rust, manifests, the Cargo.lock it built with), by
  -- the sha256 of the JSON Mynt read back: what the mainnet program gate audits.
  CREATE TABLE IF NOT EXISTS ${T}.solana_program_sources (
    sha256 text PRIMARY KEY,
    files jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE ${T}.solana_program_artifacts ADD COLUMN IF NOT EXISTS sources_sha256 text;
  CREATE TABLE IF NOT EXISTS ${T}.solana_program_events (
    id uuid PRIMARY KEY,
    program uuid NOT NULL REFERENCES ${T}.solana_programs(id),
    signature text NOT NULL,
    idx integer NOT NULL,
    slot bigint,
    event text NOT NULL,
    data_b64 text,
    failed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (program, signature, idx)
  );
  CREATE TABLE IF NOT EXISTS ${T}.solana_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    updated_by uuid,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
`;

export interface SolanaConfig {
  rpcUrls: Record<Cluster, string | null>;
  // SOLANA_MAINNET_VAULT_SIGNER=enabled: the operator allows mainnet keys in Mynt's vault on this server.
  mainnetVaultAllowed: boolean;
  confirmTimeoutMs: number;
  pollMs: number;
  // How many requests a second a deploy's buffer writes go out at, per cluster (SOLANA_RPC_MAX_RPS; by default
  // what the public devnet endpoint allows, more with a provider's RPC).
  maxRps?: Record<Cluster, number>;
  // How long one RPC call keeps retrying a rate limit before it fails (SOLANA_RPC_MAX_RETRY_SECONDS).
  rpcMaxRetryMs?: number;
  // Devnet only: how much Mynt's devnet deploy authority may send a developer's call keys when the faucet
  // won't. Mainnet keys are never funded automatically.
  devnetTopUp?: DevnetTopUpLimits;
}

export interface DevnetTopUpLimits {
  maxLamports: number; // one top-up, at most (SOLANA_DEVNET_TOPUP_MAX_SOL, default 0.05)
  dailyLamports: number; // one developer's top-ups in any 24 hours (SOLANA_DEVNET_TOPUP_DAILY_SOL, default 0.25)
  authorityKeepLamports: number; // what the authority always keeps for its own rent and fees (SOLANA_DEVNET_AUTHORITY_KEEP_SOL, default 0.1)
}

export const DEFAULT_DEVNET_TOPUP: DevnetTopUpLimits = { maxLamports: 50_000_000, dailyLamports: 250_000_000, authorityKeepLamports: 100_000_000 };

export function devnetTopUpFromEnv(env = process.env): DevnetTopUpLimits {
  const lamports = (name: string, fallback: number) => {
    const v = Number(env[name]);
    return env[name] && Number.isFinite(v) && v >= 0 ? Math.round(v * 1_000_000_000) : fallback;
  };
  return {
    maxLamports: lamports("SOLANA_DEVNET_TOPUP_MAX_SOL", DEFAULT_DEVNET_TOPUP.maxLamports),
    dailyLamports: lamports("SOLANA_DEVNET_TOPUP_DAILY_SOL", DEFAULT_DEVNET_TOPUP.dailyLamports),
    authorityKeepLamports: lamports("SOLANA_DEVNET_AUTHORITY_KEEP_SOL", DEFAULT_DEVNET_TOPUP.authorityKeepLamports),
  };
}

export function solanaConfigFromEnv(env = process.env): SolanaConfig {
  return {
    rpcUrls: rpcUrlsFromEnv(env),
    mainnetVaultAllowed: env.SOLANA_MAINNET_VAULT_SIGNER === "enabled",
    confirmTimeoutMs: Number(env.SOLANA_CONFIRM_TIMEOUT_MS ?? 90_000),
    pollMs: Number(env.SOLANA_CONFIRM_POLL_MS ?? 1_000),
    maxRps: rpcPaceFromEnv(env),
    rpcMaxRetryMs: rpcMaxRetryMsFromEnv(env),
    devnetTopUp: devnetTopUpFromEnv(env),
  };
}

export interface MainnetSettings {
  enabled: boolean;
  backend: MainnetBackend | null;
  custody: { provider: string; address: string } | null;
  multisig: { address: string; vault: string } | null;
}
const DEFAULT_MAINNET: MainnetSettings = { enabled: false, backend: null, custody: null, multisig: null };

export interface ProgramRecord {
  id: string;
  name: string;
  cluster: Cluster;
  program_id: string;
  owner_id: string;
  entity_id: string | null;
  app_id: string | null;
  product_id: string | null;
  status: "reserved" | "deploying" | "deployed" | "failed";
  operation: "deploy" | "upgrade" | null;
  version: number;
  build_id: string | null;
  verifiable_hash: string | null;
  cargo_lock_sha256: string | null;
  deployer: string | null;
  upgrade_authority: string | null;
  signer_backend: string | null;
  deployed_tx: string | null;
  programdata_address: string | null;
  max_data_len: number | null;
  index_cursor: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProgramArtifact {
  name: string;
  declared_id: string | null;
  sha256: string;
  size: number;
  program: Uint8Array;
  idl: unknown;
}

// An instruction to one registered program, as a developer gives it: an Anchor method (its arguments already
// Borsh-encoded) or the raw instruction data, and the accounts. The only signer allowed is the developer's own
// caller key, written "$caller".
export interface CallInput {
  method?: string;
  args_base64?: string;
  data_base64?: string;
  accounts: { pubkey: string; writable?: boolean; signer?: boolean }[];
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
type Row = Record<string, unknown>;
const toProgram = (r: Row): ProgramRecord => ({
  ...(r as unknown as ProgramRecord),
  version: Number(r.version ?? 0),
  max_data_len: r.max_data_len == null ? null : Number(r.max_data_len),
  created_at: iso(r.created_at)!,
  updated_at: iso(r.updated_at)!,
});

const LAMPORTS_PER_SOL = 1_000_000_000;
const FEE_MARGIN = 20_000_000; // 0.02 SOL for the transactions' fees
const SIGNATURE_FEE = 5_000; // lamports per signature, Solana's base fee
// Custody deploys: Mynt's deploy payer (SOL only, no program) and each deploy's temporary buffer key.
const DEPLOY_PAYER = "deploy-payer";
const BUFFER_KEY = "buffer-authority";
const BUFFER_ACCOUNT = "buffer"; // the buffer a buffer key is writing, so a crash's leftover can be closed
const VAULT_BUFFER = "vault-buffer"; // the buffer a vault-signed deploy is writing, so a failure's leftover can be closed
const WRITE_BATCH = 16; // writes sent on one blockhash, then confirmed together
const WRITE_ATTEMPTS = 4; // how often a batch's unconfirmed writes are signed again on a fresh blockhash
const NONCE_KEY = "custody-nonce"; // a program's durable nonce account for its custody-signed transactions
type Signs = { address: string; sign(m: Uint8Array): Promise<Uint8Array> };
const signs = (k: Keypair): Signs => ({ address: k.address, sign: async (m) => k.sign(m) });
const AIRDROP_MAX = 2 * LAMPORTS_PER_SOL;
const CALL_FEE_RESERVE = 5_000_000; // what a developer's fee payer keeps for calls' fees
// Devnet only: what a developer's caller holds before a call that names it, enough for the rent of a typical small
// account an Anchor `initialize` creates with $caller as its payer (about 2.7 KB). A bigger one is topped up from
// the simulation's own shortfall, once.
const DEVNET_CALLER_FLOAT = 20_000_000;
const TOPUP_ACTION = "solana_devnet_topup";
// What the system program logs when a transfer (an account's creation, its rent) has too little.
const SHORTFALL = /insufficient lamports (\d+), need (\d+)/;
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const explorer = (cluster: Cluster, kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

export class SolanaError extends Error {}

// What deploys ask of the mainnet program gate: throws, saying why, unless an approved review covers exactly
// these bytes for this program and action (and an upgrade's timelock is over).
export interface MainnetGateCheck {
  assertDeployable(p: ProgramRecord, sha256: string, action: "deploy" | "upgrade"): Promise<void>;
}
// A transaction that wasn't confirmed before SOLANA_CONFIRM_TIMEOUT_MS: it may still land, or its blockhash may
// have expired.
class Unconfirmed extends SolanaError {}
// What a cluster answers to a transaction whose blockhash it no longer knows (expired, or the node is behind).
const BLOCKHASH_GONE = /blockhash not found|BlockhashNotFound|block height exceeded/i;

export class SolanaService {
  private jobs = new Map<string, Promise<void>>();
  private rpcs = new Map<Cluster, SolanaRpc>();
  private pacers = new Map<Cluster, RateLimiter>();
  private topUps = new Map<string, Promise<unknown>>(); // one developer's devnet top-ups, one at a time

  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly config: SolanaConfig,
    private readonly rpcFactory: (cluster: Cluster, url: string) => SolanaRpc,
    private readonly custody: CustodyServiceClient | null,
    private readonly multisig: MultisigClient | null,
  ) {}

  static async open(
    db: Db,
    store: Store,
    config: SolanaConfig = solanaConfigFromEnv(),
    opts: { rpc?: (cluster: Cluster, url: string) => SolanaRpc; custody?: CustodyServiceClient | null; multisig?: MultisigClient | null } = {},
  ) {
    await db.exec(TABLES);
    // The custody provider comes from the server's environment (Turnkey's variables) unless one is passed in.
    const custody = opts.custody !== undefined ? opts.custody : turnkeyFromEnv();
    const rpc = opts.rpc ?? ((_c: Cluster, url: string) => new HttpSolanaRpc(url, {}, { maxRetryMs: config.rpcMaxRetryMs }));
    return new SolanaService(db, store, config, rpc, custody, opts.multisig ?? null);
  }

  // ---- persistence ----

  private async one(sql: string, params: unknown[] = []) {
    return (await this.db.query(sql, params)).rows[0] as Row | undefined;
  }

  async get(programId: string) {
    const r = await this.one(`SELECT * FROM ${T}.solana_programs WHERE program_id = $1`, [programId]);
    return r ? toProgram(r) : undefined;
  }

  async list(ownerId: string | null) {
    const rows = (await this.db.query(`SELECT * FROM ${T}.solana_programs WHERE ($1::uuid IS NULL OR owner_id = $1) ORDER BY created_at DESC LIMIT 500`, [ownerId])).rows as Row[];
    return rows.map(toProgram);
  }

  async versions(p: ProgramRecord) {
    return (
      await this.db.query(
        `SELECT version, action, build_id, verifiable_hash, cargo_lock_sha256, tx, signer_backend, created_at FROM ${T}.solana_program_versions WHERE program = $1 ORDER BY version`,
        [p.id],
      )
    ).rows.map((r: Row) => ({ ...r, created_at: iso(r.created_at) }));
  }

  async events(p: ProgramRecord, limit = 20) {
    return (
      await this.db.query(
        `SELECT signature, idx, slot, event, data_b64, failed, created_at FROM ${T}.solana_program_events WHERE program = $1 ORDER BY created_at DESC, idx DESC LIMIT $2`,
        [p.id, limit],
      )
    ).rows.map((r: Row) => ({ ...r, slot: r.slot == null ? null : Number(r.slot), created_at: iso(r.created_at) }));
  }

  private async update(id: string, fields: Partial<Record<keyof ProgramRecord | "operation_started_at" | "pending_build_id", unknown>>) {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    await this.db.query(`UPDATE ${T}.solana_programs SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [
      id,
      ...keys.map((k) => (fields as Record<string, unknown>)[k]),
    ]);
  }

  // Who may act on a program: its owner, or someone of the same firm.
  canAct(user: User, p: ProgramRecord) {
    return p.owner_id === user.id || (!!p.entity_id && p.entity_id === user.entity_id);
  }

  // ---- settings and signers ----

  async mainnetSettings(): Promise<MainnetSettings> {
    const r = await this.one(`SELECT value FROM ${T}.solana_settings WHERE key = 'mainnet'`);
    return { ...DEFAULT_MAINNET, ...((r?.value as Partial<MainnetSettings>) ?? {}) };
  }

  async configureMainnet(user: User, patch: Partial<MainnetSettings> & { generate_key?: boolean }) {
    const current = await this.mainnetSettings();
    const next: MainnetSettings = {
      enabled: patch.enabled ?? current.enabled,
      backend: patch.backend !== undefined ? patch.backend : current.backend,
      custody: patch.custody !== undefined ? patch.custody : current.custody,
      multisig: patch.multisig !== undefined ? patch.multisig : current.multisig,
    };
    if (next.custody && !isAddress(next.custody.address)) throw new SolanaError("custody_address isn't a Solana address");
    if (next.multisig && !(isAddress(next.multisig.address) && isAddress(next.multisig.vault))) throw new SolanaError("multisig_address and multisig_vault must be Solana addresses");
    let generated: string | null = null;
    if (patch.generate_key) {
      if (next.backend !== "mainnet-vault") throw new SolanaError("generate_key is for the mainnet-vault backend");
      if (!vaultAvailable(false)) throw new SolanaError("MYNT_VAULT_KEY isn't set on this server, so Mynt can't hold a key");
      const existing = await this.keyRow("mainnet", "authority", "");
      generated = existing ? null : (await this.createKey("mainnet", "authority", "")).address;
    }
    // Custody deploys are paid for by a Mynt-held deploy payer: made now, so the operator sees what to fund.
    if (next.backend === "custody-service" && vaultAvailable(false)) await this.deployPayer("mainnet");
    await this.db.query(
      `INSERT INTO ${T}.solana_settings (key, value, updated_by) VALUES ('mainnet', $1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [JSON.stringify(next), user.id],
    );
    return { generated_authority: generated, ...(await this.status()) };
  }

  private async keyRow(cluster: Cluster, role: string, scope: string) {
    return this.one(`SELECT public_key, sealed FROM ${T}.solana_keys WHERE cluster = $1 AND role = $2 AND scope = $3`, [cluster, role, scope]) as Promise<
      { public_key: string; sealed: string } | undefined
    >;
  }

  private async createKey(cluster: Cluster, role: string, scope: string) {
    const kp = Keypair.generate();
    await this.db.query(
      `INSERT INTO ${T}.solana_keys (id, cluster, role, scope, public_key, sealed) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (cluster, role, scope) DO NOTHING`,
      [randomUUID(), cluster, role, scope, kp.address, seal(Buffer.from(kp.secret()).toString("base64"), false)],
    );
    // Two requests at once: whichever key was stored first is the key.
    return this.vaultKey(cluster, role, scope) as Promise<Keypair>;
  }

  private async vaultKey(cluster: Cluster, role: string, scope: string): Promise<Keypair | null> {
    const r = await this.keyRow(cluster, role, scope);
    return r ? Keypair.fromSecret(Buffer.from(open(r.sealed, false), "base64")) : null;
  }

  // Imports an existing keypair (the Solana CLI's JSON array) as a cluster's deploy authority. For the operator,
  // from the server's command line; the key never passes through a tool.
  async importAuthority(cluster: Cluster, secretJson: string) {
    // A parse error quotes the text it choked on: here, part of a secret. Only a fixed message ever leaves.
    let kp: Keypair;
    try {
      const parsed: unknown = JSON.parse(secretJson);
      if (!Array.isArray(parsed) || parsed.length !== 64 || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error();
      kp = Keypair.fromSecret(Uint8Array.from(parsed as number[]));
    } catch {
      throw new SolanaError("The file isn't a Solana keypair (a JSON array of 64 numbers, as solana-keygen writes)");
    }
    if (await this.keyRow(cluster, "authority", "")) throw new SolanaError(`A ${cluster} authority is already in the vault`);
    await this.db.query(`INSERT INTO ${T}.solana_keys (id, cluster, role, scope, public_key, sealed) VALUES ($1, $2, 'authority', '', $3, $4)`, [
      randomUUID(),
      cluster,
      kp.address,
      seal(Buffer.from(kp.secret()).toString("base64"), false),
    ]);
    return kp.address;
  }

  // Why mainnet can't be used yet, if it can't: every reason, for the admin to fix.
  async mainnetReadiness() {
    const s = await this.mainnetSettings();
    const reasons: string[] = [];
    if (!this.config.rpcUrls.mainnet) reasons.push("SOLANA_RPC_URL_MAINNET isn't set on the server");
    if (!s.backend) reasons.push("no mainnet signer backend is chosen (configure_solana_signer)");
    if (s.backend === "mainnet-vault") {
      if (!this.config.mainnetVaultAllowed) reasons.push("SOLANA_MAINNET_VAULT_SIGNER isn't set to 'enabled' on the server");
      if (!vaultAvailable(false)) reasons.push("MYNT_VAULT_KEY isn't set on the server");
      else if (!(await this.keyRow("mainnet", "authority", ""))) reasons.push("no mainnet key is in the vault (configure_solana_signer with generate_key, or `mynt solana import-key`)");
    }
    if (s.backend === "custody-service") {
      if (!this.custody) reasons.push("no custody provider is connected to this Mynt (for Turnkey: set TURNKEY_ORGANIZATION_ID, TURNKEY_API_PUBLIC_KEY and TURNKEY_API_PRIVATE_KEY on the server)");
      else if (this.custody.problem) reasons.push(`the ${this.custody.provider} custody provider isn't usable: ${this.custody.problem}`);
      if (!vaultAvailable(false)) reasons.push("MYNT_VAULT_KEY isn't set on the server (custody deploys seal their deploy payer and buffer keys with it)");
      if (!s.custody) reasons.push("no custody address is configured");
      else if (this.custody && s.custody.provider !== this.custody.provider)
        reasons.push(`the custody provider configured is '${s.custody.provider}', but this Mynt is connected to ${this.custody.provider}`);
    }
    if (s.backend === "multisig") reasons.push(this.multisig ? "multisig deploys are approved as proposals, which this Mynt doesn't raise yet" : "no multisig client is connected to this Mynt");
    if (!s.enabled) reasons.push("an admin hasn't enabled mainnet (configure_solana_signer with enabled: true)");
    return { settings: s, ready: reasons.length === 0, reasons };
  }

  // The signer for a cluster's deploys and upgrades, or a refusal that says what's missing.
  async authority(cluster: Cluster): Promise<SolanaSigner> {
    if (cluster === "devnet") {
      if (!vaultAvailable(false)) throw new SignerNotConfigured("The devnet signer needs MYNT_VAULT_KEY set on the server");
      const kp = (await this.vaultKey("devnet", "authority", "")) ?? (await this.createKey("devnet", "authority", ""));
      return new VaultSigner("devnet-vault", "devnet", kp);
    }
    const { settings, ready, reasons } = await this.mainnetReadiness();
    if (!ready) throw new SignerNotConfigured(`${MAINNET_NOT_CONFIGURED}: ${reasons.join("; ")}`);
    if (settings.backend === "mainnet-vault") return new VaultSigner("mainnet-vault", "mainnet", (await this.vaultKey("mainnet", "authority", ""))!);
    if (settings.backend === "custody-service") return new CustodyServiceSigner(settings.custody!.address, this.custody);
    return new MultisigSigner(settings.multisig!.vault, this.multisig);
  }

  // A developer's keys for program calls on a cluster: a fee payer, which pays every call's fees and is never
  // passed to a program, and a caller ($caller), which signs only when a call lists it. Neither is ever the deploy
  // authority, so one firm's program can't act with a key that controls another's or spend the fee payer's SOL.
  private async callKeys(cluster: Cluster, ownerId: string): Promise<{ payer: Keypair; caller: Keypair }> {
    if (cluster === "mainnet") {
      const { settings, ready, reasons } = await this.mainnetReadiness();
      if (!ready) throw new SignerNotConfigured(`${MAINNET_NOT_CONFIGURED}: ${reasons.join("; ")}`);
      if (settings.backend !== "mainnet-vault")
        throw new SignerNotConfigured(`${MAINNET_NOT_CONFIGURED} for program calls: they sign with per-developer keys in Mynt's vault, which needs the mainnet-vault backend`);
    } else if (!vaultAvailable(false)) throw new SignerNotConfigured("The devnet signer needs MYNT_VAULT_KEY set on the server");
    const key = async (role: string) => (await this.vaultKey(cluster, role, ownerId)) ?? (await this.createKey(cluster, role, ownerId));
    return { payer: await key("payer"), caller: await key("caller") };
  }

  rpc(cluster: Cluster): SolanaRpc {
    const url = this.config.rpcUrls[cluster];
    if (!url) throw new SignerNotConfigured(`${MAINNET_NOT_CONFIGURED}: SOLANA_RPC_URL_MAINNET isn't set on the server`);
    let r = this.rpcs.get(cluster);
    // Checked once that it really serves this cluster (its genesis hash), before anything is sent.
    if (!r) this.rpcs.set(cluster, (r = new GenesisCheckedRpc(cluster, this.rpcFactory(cluster, url))));
    return r;
  }

  // One pace per cluster, shared by every deploy writing to it, so two deploys at once don't double the rate.
  private pacer(cluster: Cluster) {
    let l = this.pacers.get(cluster);
    if (!l) this.pacers.set(cluster, (l = new RateLimiter(this.config.maxRps?.[cluster] ?? 0)));
    return l;
  }

  async status() {
    const devnet = await this.keyRow("devnet", "authority", "");
    const m = await this.mainnetReadiness();
    const mainnetKey = await this.keyRow("mainnet", "authority", "");
    return {
      devnet: { signer: "devnet-vault", authority: devnet?.public_key ?? null, rpc: this.config.rpcUrls.devnet === "https://api.devnet.solana.com" ? "public devnet endpoint" : "configured" },
      mainnet: {
        enabled: m.settings.enabled,
        backend: m.settings.backend,
        authority:
          m.settings.backend === "mainnet-vault"
            ? (mainnetKey?.public_key ?? null)
            : m.settings.backend === "custody-service"
              ? (m.settings.custody?.address ?? null)
              : m.settings.backend === "multisig"
                ? (m.settings.multisig?.vault ?? null)
                : null,
        custody_provider: m.settings.custody?.provider ?? null,
        // custody-service: the Mynt-held key that pays each deploy's fees and rent (SOL only; it controls no program).
        deploy_payer: m.settings.backend === "custody-service" ? ((await this.keyRow("mainnet", DEPLOY_PAYER, ""))?.public_key ?? null) : null,
        multisig: m.settings.multisig?.address ?? null,
        rpc_configured: !!this.config.rpcUrls.mainnet,
        vault_signer_allowed: this.config.mainnetVaultAllowed,
        ready: m.ready,
        missing: m.reasons,
      },
    };
  }

  // ---- registry ----

  // A program's address, before any code exists: the developer declares it in the program (declare_id!) and
  // Anchor.toml. Mynt keeps the address's keypair, which only the first deploy needs.
  async reserve(user: User, o: { name: string; cluster: Cluster; app_id?: string | null; product_id?: string | null }) {
    if (!vaultAvailable(false)) throw new SolanaError("Solana programs need MYNT_VAULT_KEY set on the server, to hold their keys");
    const id = randomUUID();
    const kp = await this.createKey(o.cluster, "program", id);
    await this.db.query(
      `INSERT INTO ${T}.solana_programs (id, name, cluster, program_id, owner_id, entity_id, app_id, product_id, status, programdata_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9)`,
      [id, o.name, o.cluster, kp.address, user.id, user.entity_id, o.app_id ?? null, o.product_id ?? null, findProgramAddress([kp.publicKey], UPGRADEABLE_LOADER)[0]],
    );
    return (await this.get(kp.address))!;
  }

  // Reserved programs of an app, for its builds: the coding agent declares exactly these addresses.
  async programsForApp(appId: string) {
    const rows = (await this.db.query(`SELECT name, cluster, program_id, status FROM ${T}.solana_programs WHERE app_id = $1 ORDER BY created_at`, [appId])).rows as Row[];
    return rows as { name: string; cluster: Cluster; program_id: string; status: string }[];
  }

  // What Mynt built in its verify sandbox. The hash is Mynt's own, over the bytes it read back; it must agree
  // with the one the sandbox computed, or the artifact isn't kept.
  async recordArtifacts(
    buildId: string,
    artifacts: (ProgramArtifact & { reported_sha256?: string; cargo_lock_sha256?: string | null; sources?: { sha256: string; files: Record<string, string> } | null })[],
  ) {
    const kept: string[] = [];
    for (const a of artifacts) {
      const sha = executableHash(a.program);
      if (a.reported_sha256 && a.reported_sha256 !== sha) continue;
      const sources = a.sources && /^[0-9a-f]{64}$/.test(a.sources.sha256) ? a.sources : null;
      if (sources)
        await this.db.query(`INSERT INTO ${T}.solana_program_sources (sha256, files) VALUES ($1, $2) ON CONFLICT (sha256) DO NOTHING`, [sources.sha256, JSON.stringify(sources.files)]);
      await this.db.query(
        `INSERT INTO ${T}.solana_program_artifacts (id, build_id, name, declared_id, sha256, size, program_b64, idl, cargo_lock_sha256, sources_sha256) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (build_id, name) DO UPDATE SET declared_id = EXCLUDED.declared_id, sha256 = EXCLUDED.sha256, size = EXCLUDED.size, program_b64 = EXCLUDED.program_b64, idl = EXCLUDED.idl,
           cargo_lock_sha256 = EXCLUDED.cargo_lock_sha256, sources_sha256 = EXCLUDED.sources_sha256`,
        [
          randomUUID(),
          buildId,
          a.name,
          a.declared_id,
          sha,
          a.program.length,
          Buffer.from(a.program).toString("base64"),
          a.idl == null ? null : JSON.stringify(a.idl),
          /^[0-9a-f]{64}$/.test(a.cargo_lock_sha256 ?? "") ? a.cargo_lock_sha256 : null,
          sources?.sha256 ?? null,
        ],
      );
      kept.push(a.name);
    }
    return kept;
  }

  // The IDL a later, untrusted run produced: used only to name events, never deployed.
  async recordIdl(buildId: string, name: string, idl: unknown) {
    await this.db.query(`UPDATE ${T}.solana_program_artifacts SET idl = $3 WHERE build_id = $1 AND name = $2`, [buildId, name, JSON.stringify(idl)]);
  }

  async artifacts(buildId: string) {
    return (await this.db.query(`SELECT name, declared_id, sha256, size, cargo_lock_sha256 FROM ${T}.solana_program_artifacts WHERE build_id = $1 ORDER BY name`, [buildId])).rows as {
      name: string;
      declared_id: string | null;
      sha256: string;
      size: number;
    }[];
  }

  // The verified program for `p` in a build: the build must be the developer's, verified and shipped by Mynt,
  // and Mynt's own build of it must declare exactly this program's address.
  // `user` null: Mynt itself, re-reading a build a person's request already checked (the mainnet gate's worker).
  private async verifiedArtifact(user: User | null, p: ProgramRecord, buildId: string) {
    const b = await this.one(`SELECT developer_id, status FROM ${T}.build_runs WHERE id::text = $1`, [buildId]);
    if (!b || (user && b.developer_id !== user.id && b.developer_id !== p.owner_id)) throw new SolanaError(`No build of yours with id '${buildId}'`);
    if (b.status !== "succeeded") throw new SolanaError(`Build ${buildId} is ${b.status}: only a build Mynt verified can be deployed`);
    const rows = (await this.db.query(`SELECT * FROM ${T}.solana_program_artifacts WHERE build_id = $1`, [buildId])).rows as Row[];
    if (!rows.length) throw new SolanaError(`Mynt's verification of build ${buildId} built no Solana program`);
    const r = rows.find((x) => x.declared_id === p.program_id);
    if (!r)
      throw new SolanaError(
        `None of the programs Mynt built from build ${buildId} declares ${p.program_id} (they declare ${rows.map((x) => `${x.name}: ${x.declared_id ?? "no address"}`).join(", ")}); set declare_id! and Anchor.toml to the reserved address`,
      );
    const program = Buffer.from(r.program_b64 as string, "base64");
    if (executableHash(program) !== r.sha256) throw new SolanaError("The stored artifact doesn't match its recorded hash");
    return { name: r.name as string, sha256: r.sha256 as string, program: new Uint8Array(program), idl: (r.idl as unknown) ?? null, sources_sha256: (r.sources_sha256 as string | null) ?? null };
  }

  // ---- the mainnet program gate (src/solana/mainnet-gate.ts) ----

  // Every mainnet deploy and upgrade must have an approved review for exactly the bytes it ships. Without a gate
  // connected, mainnet deploys are refused.
  gate: MainnetGateCheck | null = null;

  // What the gate reviews of a build: the exact bytes Mynt stored, their IDL, and the source Mynt captured with them.
  async reviewMaterial(user: User | null, p: ProgramRecord, buildId: string) {
    const a = await this.verifiedArtifact(user, p, buildId);
    const src = a.sources_sha256 ? await this.one(`SELECT files FROM ${T}.solana_program_sources WHERE sha256 = $1`, [a.sources_sha256]) : undefined;
    return { ...a, sources: (src?.files as Record<string, string> | undefined) ?? null };
  }

  // Mynt's mainnet signer as it stands, or null while mainnet isn't ready. Never throws.
  async mainnetSigner(): Promise<{ backend: string; address: string } | null> {
    try {
      const s = await this.authority("mainnet");
      return { backend: s.backend, address: s.address };
    } catch {
      return null;
    }
  }

  // ---- deploy and upgrade ----

  // A deploy or upgrade whose job has gone (a restart, a crash) would block the program for good: after this
  // long without its job, the chain decides what happened (recoverStale).
  static STALE_OPERATION_MS = 30 * 60_000;
  // Transactions the indexer reads per program per poll; a longer backlog continues on the next poll.
  static INDEX_PER_POLL = 1000;
  // Only the process that runs deploys (the HTTP server) recovers stale ones; a stdio server or a CLI command
  // sharing the database never touches another process's operation.
  recovery = false;

  // Starts a first deploy (or, for a deployed program, an upgrade) in the background; get_program follows it.
  async deploy(user: User, p: ProgramRecord, buildId: string, action: "deploy" | "upgrade") {
    if (action === "deploy" && !["reserved", "failed"].includes(p.status))
      throw new SolanaError(p.status === "deployed" ? "Already deployed: use upgrade_program" : `The program is ${p.status}`);
    if (action === "upgrade" && p.status !== "deployed") throw new SolanaError(`Only a deployed program can be upgraded (it is ${p.status})`);
    if (p.operation) throw new SolanaError(`A ${p.operation} of this program is already running`);
    const artifact = await this.verifiedArtifact(user, p, buildId);
    if (action === "upgrade" && artifact.sha256 === p.verifiable_hash) throw new SolanaError("This build's program is the one already deployed");
    if (p.cluster === "mainnet") {
      // The mainnet program gate: an approved review of exactly these bytes (and, for an upgrade, its timelock
      // over). Checked before the signer, so a program without one learns that first.
      if (!this.gate) throw new SolanaError("Mainnet deploys and upgrades need an approved mainnet review (request_mainnet_review), and the review gate isn't running on this Mynt");
      await this.gate.assertDeployable(p, artifact.sha256, action);
    }
    const signer = await this.authority(p.cluster); // refuses here, before anything starts, when it isn't configured
    if (p.cluster === "mainnet" && !["mainnet-vault", "custody-service"].includes(signer.backend))
      throw new SolanaError(`Mainnet programs' upgrade authority must be Mynt's own signer (mainnet-vault or custody-service), not ${signer.backend}`);
    if (action === "upgrade" && p.upgrade_authority !== signer.address)
      throw new SolanaError(`The program's upgrade authority is ${p.upgrade_authority}, but ${p.cluster}'s signer is now ${signer.address}; transfer the authority first`);
    const claimed = await this.db.query(
      `UPDATE ${T}.solana_programs SET operation = $2, operation_started_at = now(), pending_build_id = $3, error = NULL${action === "deploy" ? ", status = 'deploying'" : ""}, updated_at = now()
       WHERE id = $1 AND operation IS NULL RETURNING id`,
      [p.id, action, buildId],
    );
    if (!claimed.rows.length) throw new SolanaError("Another deploy or upgrade of this program just started");
    const job = this.runDeploy(user.id, p, buildId, artifact, signer, action)
      .catch((e) => this.markFailed(p, action, (e as Error).message))
      .finally(() => this.jobs.delete(p.id));
    this.jobs.set(p.id, job);
    return (await this.get(p.program_id))!;
  }

  // A running deploy's sign of life: recovery leaves an operation alone while this keeps moving.
  private async heartbeat(id: string) {
    await this.db.query(`UPDATE ${T}.solana_programs SET operation_started_at = now() WHERE id = $1 AND operation IS NOT NULL`, [id]);
  }

  // A program that is deployed stays deployed (a failed upgrade, or a deploy that turned into one); only a first
  // deploy still in progress becomes failed.
  private async markFailed(p: ProgramRecord, _action: "deploy" | "upgrade", error: string) {
    await this.db.query(
      `UPDATE ${T}.solana_programs SET operation = NULL, operation_started_at = NULL, pending_build_id = NULL, error = $2,
         status = CASE WHEN status = 'deploying' THEN 'failed' ELSE status END, updated_at = now() WHERE id = $1`,
      [p.id, error.slice(0, 1000)],
    );
  }

  // Resolves once a background deploy or upgrade of `programId` has finished (tests; graceful shutdown).
  async settled(programId?: string) {
    const p = programId ? await this.get(programId) : undefined;
    await Promise.all(p ? [this.jobs.get(p.id)] : [...this.jobs.values()]);
  }

  // Deploys and upgrades no live job owns, older than STALE_OPERATION_MS: if the chain holds exactly the build's
  // program under Mynt's signer, it went through; otherwise it's marked interrupted, and can be started again.
  async recoverStale(now = Date.now()) {
    const cutoff = new Date(now - SolanaService.STALE_OPERATION_MS);
    const rows = (await this.db.query(`SELECT * FROM ${T}.solana_programs WHERE operation IS NOT NULL AND operation_started_at < $1`, [cutoff])).rows as Row[];
    let recovered = 0;
    for (const r of rows) {
      const p = toProgram(r);
      if (this.jobs.has(p.id)) continue;
      const action = p.operation!;
      const buildId = r.pending_build_id as string | null;
      try {
        const artifact = buildId ? await this.storedArtifact(p, buildId) : null;
        const signer = await this.authority(p.cluster);
        const chain = artifact ? await this.onChain(this.rpc(p.cluster), p) : null;
        if (artifact && chain && chain.authority === signer.address && chain.hash === artifact.sha256) {
          await this.finish(null, p, buildId!, artifact.sha256, await this.latestSignature(p), signer, action, chain.capacity);
        } else await this.markFailed(p, action, `The ${action} was interrupted before it finished; start it again`);
      } catch (e) {
        await this.markFailed(p, action, `The ${action} was interrupted (${(e as Error).message.slice(0, 300)}); start it again`);
      }
      recovered++;
    }
    return recovered;
  }

  private async runDeploy(userId: string, p: ProgramRecord, buildId: string, artifact: { sha256: string; program: Uint8Array }, signer: SolanaSigner, action: "deploy" | "upgrade") {
    const rpc = this.rpc(p.cluster);
    const len = artifact.program.length;
    const rent = (size: number) => rpc.call<number>("getMinimumBalanceForRentExemption", [size]);
    // A deploy or upgrade that landed although Mynt didn't see it confirmed (a timeout, a restart): the chain
    // already holds exactly this program under Mynt's signer, so record it instead of failing again.
    const chain = await this.onChain(rpc, p);
    if (chain && chain.authority === signer.address && chain.hash === artifact.sha256) {
      await this.finish(userId, p, buildId, artifact.sha256, await this.latestSignature(p), signer, action, chain.capacity);
      return;
    }
    let tx: string;
    let maxDataLen = p.max_data_len;
    if (action === "deploy" && chain) {
      // An earlier build of this program, deployed by Mynt's signer but never recorded (a retry with a newer
      // build after a lost confirmation): record that one, then this build goes through as an upgrade.
      const prior = chain.authority === signer.address ? await this.artifactByHash(p, chain.hash) : null;
      if (!prior) throw new SolanaError(`A different program already exists at ${p.program_id}`);
      // Recorded and handed over to the upgrade in one write: the operation stays claimed throughout.
      await this.finish(userId, p, prior.build_id, chain.hash, await this.latestSignature(p), signer, "deploy", chain.capacity, { continueAs: "upgrade", pendingBuildId: buildId });
      p = (await this.get(p.program_id))!;
      action = "upgrade";
      maxDataLen = chain.capacity;
    }
    // A custody service signs only the final Deploy or Upgrade (one approval per deploy); see custodyDeploy.
    const custody = signer.backend === "custody-service";
    if (action === "deploy") {
      maxDataLen = len * 2; // room to grow, as the Solana CLI leaves
      const programRent = await rent(PROGRAM_ACCOUNT_SIZE);
      const programDataRent = await rent(PROGRAMDATA_HEADER + maxDataLen);
      const programKey = await this.vaultKey(p.cluster, "program", p.id);
      if (!programKey) throw new SolanaError("The program's reserved keypair is missing");
      // The address is public once reserved: anyone may have sent it lamports. Then it can't be created, but, as
      // the Solana CLI does, it can be topped up, sized and handed to the loader, signed by its own keypair.
      const opening = async (funder: string): Promise<Instruction[]> => {
        const existing = await this.accountInfo(rpc, p.program_id);
        if (!existing) return [system.createAccount(funder, p.program_id, programRent, PROGRAM_ACCOUNT_SIZE, UPGRADEABLE_LOADER)];
        if (existing.owner === SYSTEM_PROGRAM && !existing.space)
          return [
            ...(existing.lamports < programRent ? [system.transfer(funder, p.program_id, programRent - existing.lamports)] : []),
            system.allocate(p.program_id, PROGRAM_ACCOUNT_SIZE),
            system.assign(p.program_id, UPGRADEABLE_LOADER),
          ];
        throw new SolanaError(`An account owned by ${existing.owner} already exists at ${p.program_id}`);
      };
      if (custody) {
        tx = await this.custodyDeploy(rpc, p, signer, artifact.program, programRent + programDataRent + FEE_MARGIN, async (payer, buffer) => ({
          before: await opening(payer),
          last: loader.deployWithMaxDataLen({ payer, programData: p.programdata_address!, program: p.program_id, buffer, authority: signer.address, maxDataLen: maxDataLen! }),
          extra: [programKey],
        }));
        await this.finish(userId, p, buildId, artifact.sha256, tx, signer, action, maxDataLen);
        return;
      }
      await this.closeLeftoverBuffer(rpc, p, signer);
      await this.fund(rpc, p.cluster, signer.address, (await rent(BUFFER_HEADER + len)) + programRent + programDataRent + FEE_MARGIN);
      const open = await opening(signer.address);
      const buffer = await this.writeBuffer(rpc, p.cluster, signer, artifact.program, () => this.heartbeat(p.id), await this.freshKey(p.cluster, VAULT_BUFFER, p.id));
      try {
        tx = await this.send(rpc, signer, [
          ...open,
          loader.deployWithMaxDataLen({ payer: signer.address, programData: p.programdata_address!, program: p.program_id, buffer, authority: signer.address, maxDataLen }),
        ], [programKey]);
      } catch (e) {
        await this.closeBuffer(rpc, signer, buffer);
        throw e;
      }
      await this.forgetBuffer(p);
    } else {
      const capacity = chain?.capacity ?? p.max_data_len ?? 0;
      if (len > capacity) throw new SolanaError(`The new program (${len} bytes) is larger than the ${capacity} bytes reserved at first deploy; deploy it as a new program`);
      if (custody) {
        // The buffer's rent comes back to Mynt's deploy payer as the upgrade's spill.
        tx = await this.custodyDeploy(rpc, p, signer, artifact.program, FEE_MARGIN, async (payer, buffer) => ({
          before: [],
          last: loader.upgrade({ programData: p.programdata_address!, program: p.program_id, buffer, spill: payer, authority: signer.address }),
          extra: [],
        }));
        await this.finish(userId, p, buildId, artifact.sha256, tx, signer, action, maxDataLen);
        return;
      }
      await this.closeLeftoverBuffer(rpc, p, signer);
      await this.fund(rpc, p.cluster, signer.address, (await rent(BUFFER_HEADER + len)) + FEE_MARGIN);
      const buffer = await this.writeBuffer(rpc, p.cluster, signer, artifact.program, () => this.heartbeat(p.id), await this.freshKey(p.cluster, VAULT_BUFFER, p.id));
      try {
        tx = await this.send(rpc, signer, [loader.upgrade({ programData: p.programdata_address!, program: p.program_id, buffer, spill: signer.address, authority: signer.address })]);
      } catch (e) {
        await this.closeBuffer(rpc, signer, buffer);
        throw e;
      }
      await this.forgetBuffer(p);
    }
    await this.finish(userId, p, buildId, artifact.sha256, tx, signer, action, maxDataLen);
  }

  // The deploy or upgrade is on chain: record the version and tell the firm.
  private async finish(
    userId: string | null,
    p: ProgramRecord,
    buildId: string,
    sha256: string,
    tx: string,
    signer: SolanaSigner,
    action: "deploy" | "upgrade",
    maxDataLen: number | null,
    next: { continueAs: "upgrade"; pendingBuildId: string } | null = null,
  ) {
    const version = p.version + 1;
    const lock = (await this.one(`SELECT cargo_lock_sha256 FROM ${T}.solana_program_artifacts WHERE build_id = $1 AND declared_id = $2`, [buildId, p.program_id]))?.cargo_lock_sha256 ?? null;
    await this.db.query(
      `INSERT INTO ${T}.solana_program_versions (id, program, version, action, build_id, verifiable_hash, cargo_lock_sha256, tx, signer_backend, by_user) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [randomUUID(), p.id, version, action, buildId, sha256, lock, tx, signer.backend, userId],
    );
    await this.update(p.id, {
      status: "deployed",
      operation: next ? next.continueAs : null,
      operation_started_at: next ? new Date() : null,
      pending_build_id: next ? next.pendingBuildId : null,
      version,
      build_id: buildId,
      verifiable_hash: sha256,
      cargo_lock_sha256: lock,
      deployer: signer.address,
      upgrade_authority: signer.address,
      signer_backend: signer.backend,
      deployed_tx: tx,
      max_data_len: maxDataLen,
      error: null,
      ...(action === "deploy" ? { index_cursor: tx } : {}),
    });
    // The program's own keypair has done its one job; only the upgrade authority matters from here on.
    if (action === "deploy") await this.db.query(`DELETE FROM ${T}.solana_keys WHERE cluster = $1 AND role = 'program' AND scope = $2`, [p.cluster, p.id]);
    if (p.entity_id)
      await emitFirmEvent(
        this.store,
        p.entity_id,
        action === "deploy" ? "program.deployed" : "program.upgraded",
        { program_id: p.program_id, name: p.name, cluster: p.cluster, version, verifiable_hash: sha256, cargo_lock_sha256: lock, signature: tx, build_id: buildId },
        p.cluster !== "mainnet",
      );
  }

  private async storedArtifact(p: ProgramRecord, buildId: string) {
    const r = await this.one(`SELECT sha256 FROM ${T}.solana_program_artifacts WHERE build_id = $1 AND declared_id = $2`, [buildId, p.program_id]);
    return r ? { sha256: r.sha256 as string } : null;
  }

  // A build of this program that Mynt verified and shipped, by its owner or someone of the owner's firm, whose
  // program hashes as `sha256`. Nobody else's build can be recorded as this program's.
  private async artifactByHash(p: ProgramRecord, sha256: string) {
    const r = await this.one(
      `SELECT a.build_id FROM ${T}.solana_program_artifacts a
         JOIN ${T}.build_runs b ON b.id = a.build_id
         JOIN ${T}.users u ON u.id = b.developer_id
       WHERE a.declared_id = $1 AND a.sha256 = $2 AND b.status = 'succeeded'
         AND (b.developer_id = $3 OR ($4::uuid IS NOT NULL AND u.entity_id = $4))
       ORDER BY a.created_at DESC LIMIT 1`,
      [p.program_id, sha256, p.owner_id, p.entity_id],
    );
    return r ? { build_id: r.build_id as string } : null;
  }

  private async latestSignature(p: ProgramRecord) {
    const sigs = await this.rpc(p.cluster).call<{ signature: string }[]>("getSignaturesForAddress", [p.programdata_address, { limit: 1, commitment: "confirmed" }]);
    return sigs[0]?.signature ?? "unknown";
  }

  private async accountInfo(rpc: SolanaRpc, address: string) {
    const r = await rpc.call<{ value: { lamports: number; owner: string; space?: number } | null }>("getAccountInfo", [
      address,
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
    ]);
    return r?.value ?? null;
  }

  private async accountData(rpc: SolanaRpc, address: string) {
    const r = await rpc.call<{ value: { owner: string; data: [string, string] } | null }>("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
    return r?.value ? { owner: r.value.owner, data: Buffer.from(r.value.data[0], "base64") } : null;
  }

  // What the chain holds at a program's address: an upgradeable program (its program data's upgrade authority,
  // the hash of its code and the space reserved for it), or null when there's no such program there.
  private async onChain(rpc: SolanaRpc, p: ProgramRecord) {
    const prog = await this.accountData(rpc, p.program_id);
    if (!prog || prog.owner !== UPGRADEABLE_LOADER || prog.data.length < 36 || prog.data.readUInt32LE(0) !== 2) return null;
    if (base58Encode(prog.data.subarray(4, 36)) !== p.programdata_address) return null;
    const pd = await this.accountData(rpc, p.programdata_address!);
    if (!pd || pd.data.length < PROGRAMDATA_HEADER || pd.data.readUInt32LE(0) !== 3) return null;
    return {
      authority: pd.data[12] === 1 ? base58Encode(pd.data.subarray(13, 45)) : null,
      hash: executableHash(pd.data.subarray(PROGRAMDATA_HEADER)),
      capacity: pd.data.length - PROGRAMDATA_HEADER,
    };
  }

  // Enough SOL for what's next: devnet asks its faucet; mainnet must be funded by the operator.
  private async fund(rpc: SolanaRpc, cluster: Cluster, address: string, need: number) {
    const balance = async () => (await rpc.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value;
    let have = await balance();
    for (let i = 0; cluster === "devnet" && have < need && i < 4; i++) {
      try {
        const sig = await rpc.call<string>("requestAirdrop", [address, Math.min(AIRDROP_MAX, need - have)]);
        await this.confirm(rpc, [sig]);
      } catch {
        break; // the faucet's limits: say what's needed instead
      }
      have = await balance();
    }
    if (have < need)
      throw new SolanaError(
        `${address} holds ${sol(have)} on ${cluster} and needs ${sol(need)}${cluster === "devnet" ? " (the devnet faucet's limit was reached; fund it at https://faucet.solana.com and try again)" : "; the operator funds it"}`,
      );
  }

  // A deploy or upgrade whose authority is a custody service (Turnkey). The service signs one transaction, the
  // final Deploy or Upgrade, so a person can approve each deploy once in its consensus:
  //   1. Mynt's deploy payer (a Mynt-held key that holds SOL only and controls no program) funds a fresh
  //      buffer key, sealed in the vault for this deploy, with just the buffer's rent and its fees.
  //   2. The buffer key creates the buffer and writes the program into it, signed locally, batch by batch.
  //   3. One transaction, signed by the custody service: hand the buffer to the custody address (SetAuthority,
  //      signed by the buffer key; the loader requires the buffer's authority to be the upgrade authority) and
  //      Deploy or Upgrade (signed by the custody address). The deploy payer pays its fees and rent; the custody
  //      address pays nothing, so it needs no SOL. The handover is in the same transaction, so if that one fails
  //      the buffer is still the buffer key's, and closed. It runs on the program's durable nonce, not a recent
  //      blockhash, so a person can take as long as TURNKEY_APPROVAL_TIMEOUT_SECONDS to approve it.
  //   4. Whatever is left with the buffer key goes back to the deploy payer and the key is deleted. The buffer's
  //      address is stored with the key, so a buffer left by a crash is closed by the next deploy.
  private async custodyDeploy(
    rpc: SolanaRpc,
    p: ProgramRecord,
    custody: SolanaSigner,
    program: Uint8Array,
    payerNeed: number,
    final: (payer: string, buffer: string) => Promise<{ before: Instruction[]; last: Instruction; extra: Keypair[] }>,
  ): Promise<string> {
    const payer = await this.deployPayer(p.cluster);
    // A buffer key left by an interrupted deploy is cleaned up first; if that can't be finished, nothing starts,
    // so a deploy never reuses an old buffer key or buffer.
    if (!(await this.sweepBufferKey(rpc, p, payer)))
      throw new SolanaError(
        "An earlier deploy of this program left a buffer key whose buffer couldn't be closed or whose SOL couldn't be returned to the deploy payer (the RPC may be unreachable). Nothing was started; start the deploy again once the RPC answers",
      );
    const rent = (size: number) => rpc.call<number>("getMinimumBalanceForRentExemption", [size]);
    // The buffer's rent; the buffer key's own rent-exempt minimum, which it keeps until the sweep empties it (an
    // account may not be left holding less than that, only nothing); and its fees: creating the buffer (two
    // signatures), the writes, the sweep, and room for a batch of writes sent again (an expired blockhash).
    const bufferNeed = (await rent(BUFFER_HEADER + program.length)) + (await rent(0)) + SIGNATURE_FEE * (Math.ceil(program.length / WRITE_CHUNK) + 3 + 2 * WRITE_BATCH);
    const nonceKey = await this.vaultKey(p.cluster, NONCE_KEY, p.id);
    const nonceNeed = nonceKey && (await this.nonceValue(rpc, nonceKey.address, payer.address)) ? 0 : (await rent(NONCE_ACCOUNT_SIZE)) + 2 * SIGNATURE_FEE;
    // The deploy payer's own: the funding transfer, and the invalidation if it fails (two signatures).
    await this.fund(rpc, p.cluster, payer.address, payerNeed + bufferNeed + nonceNeed + 3 * SIGNATURE_FEE);
    const nonce = await this.durableNonce(rpc, p, payer);
    const temp = await this.freshKey(p.cluster, BUFFER_KEY, p.id);
    const bufferKey = await this.freshKey(p.cluster, BUFFER_ACCOUNT, p.id); // its address, kept until it's closed or used
    try {
      await this.send(rpc, signs(payer), [system.transfer(payer.address, temp.address, bufferNeed)]);
      const buffer = await this.writeBuffer(rpc, p.cluster, signs(temp), program, () => this.heartbeat(p.id), bufferKey);
      try {
        const { before, last, extra } = await final(payer.address, buffer);
        return await this.sendCustodySigned(rpc, payer, custody, nonce, [...before, loader.setBufferAuthority(buffer, temp.address, custody.address), last], [temp, ...extra]);
      } catch (e) {
        await this.invalidate(rpc, payer, nonce, temp, buffer);
        throw e;
      }
    } finally {
      await this.sweepBufferKey(rpc, p, payer);
    }
  }

  // After anything goes wrong once the custody service has been asked (an approval that timed out, a refusal, a
  // send that failed or wasn't confirmed): one transaction, paid for and signed by the deploy payer, that advances
  // the nonce and closes the buffer (signed by the buffer key, still its authority). Advancing the nonce makes
  // every message signed on the old one permanently invalid, including one Turnkey signs after a late approval.
  // If the deploy landed after all, its buffer is gone and only the nonce is advanced; the retry records the
  // deploy from the chain. Best effort: the next custody deploy of the program advances the nonce anyway.
  private async invalidate(rpc: SolanaRpc, payer: Keypair, nonce: string, temp: Keypair, buffer: string) {
    try {
      const value = await this.nonceValue(rpc, nonce, payer.address);
      if (!value) return;
      const a = await this.accountData(rpc, buffer);
      const stillOurs = a && a.owner === UPGRADEABLE_LOADER && a.data.length >= BUFFER_HEADER && a.data.readUInt32LE(0) === 1 && base58Encode(a.data.subarray(5, 37)) === temp.address;
      const ixs = [system.advanceNonce(nonce, payer.address), ...(stillOurs ? [loader.close(buffer, payer.address, temp.address)] : [])];
      const message = compileMessage(payer.address, ixs, value);
      const sigs = new Map(message.signers.map((s) => [s, (s === payer.address ? payer : temp).sign(message.bytes)]));
      const wire = serializeTransaction(message, sigs);
      const signature = (await rpc.call<string>("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }])) || signatureOf(wire);
      await this.confirm(rpc, [signature]);
    } catch {
      /* the next custody deploy of this program advances the nonce */
    }
  }

  // A key that must be new: a deploy never reuses an earlier deploy's buffer key or buffer.
  private async freshKey(cluster: Cluster, role: string, scope: string) {
    const kp = Keypair.generate();
    const r = await this.db.query(
      `INSERT INTO ${T}.solana_keys (id, cluster, role, scope, public_key, sealed) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (cluster, role, scope) DO NOTHING RETURNING id`,
      [randomUUID(), cluster, role, scope, kp.address, seal(Buffer.from(kp.secret()).toString("base64"), false)],
    );
    if (!r.rows.length) throw new SolanaError(`A ${role} key for this program is still in the vault from an earlier deploy; start the deploy again to clean it up`);
    return kp;
  }

  // The program's durable nonce for custody deploys, authorised by the deploy payer: created by its first custody
  // deploy (one per program, so two deploys at once never race for it), and kept for its upgrades.
  private async durableNonce(rpc: SolanaRpc, p: ProgramRecord, payer: Keypair) {
    const key = (await this.vaultKey(p.cluster, NONCE_KEY, p.id)) ?? (await this.createKey(p.cluster, NONCE_KEY, p.id));
    if (await this.nonceValue(rpc, key.address, payer.address)) return key.address;
    if (await this.accountInfo(rpc, key.address)) throw new SolanaError(`${key.address} is in use, but isn't this program's nonce account`);
    const lamports = await rpc.call<number>("getMinimumBalanceForRentExemption", [NONCE_ACCOUNT_SIZE]);
    await this.send(rpc, signs(payer), [system.createAccount(payer.address, key.address, lamports, NONCE_ACCOUNT_SIZE, SYSTEM_PROGRAM), system.initializeNonce(key.address, payer.address)], [key]);
    return key.address;
  }

  // A nonce account's current nonce, if it is one, initialised, and authorised by `authority`.
  private async nonceValue(rpc: SolanaRpc, address: string, authority: string): Promise<string | null> {
    const a = await this.accountData(rpc, address);
    if (!a || a.owner !== SYSTEM_PROGRAM || a.data.length !== NONCE_ACCOUNT_SIZE || a.data.readUInt32LE(4) !== 1) return null;
    if (base58Encode(a.data.subarray(8, 40)) !== authority) return null;
    return base58Encode(a.data.subarray(40, 72));
  }

  // The deploy payer for custody deploys: Mynt-held, sealed in the vault; the operator funds it.
  private async deployPayer(cluster: Cluster) {
    if (!vaultAvailable(false)) throw new SignerNotConfigured("Custody deploys need MYNT_VAULT_KEY set on the server, to hold the deploy payer and buffer keys");
    return (await this.vaultKey(cluster, DEPLOY_PAYER, "")) ?? (await this.createKey(cluster, DEPLOY_PAYER, ""));
  }

  // A deploy's buffer key, after its deploy or after a crash: every buffer it still controls is closed to the
  // deploy payer (the one stored with it, and any the loader lists under it), its lamports go back to the deploy
  // payer, and it's gone from the vault. Kept if anything fails, so the next deploy of the program tries again.
  // True when nothing is left.
  private async sweepBufferKey(rpc: SolanaRpc, p: ProgramRecord, payer: Keypair): Promise<boolean> {
    const clear = () => this.db.query(`DELETE FROM ${T}.solana_keys WHERE cluster = $1 AND role IN ($2, $3) AND scope = $4`, [p.cluster, BUFFER_KEY, BUFFER_ACCOUNT, p.id]);
    const key = await this.vaultKey(p.cluster, BUFFER_KEY, p.id);
    if (!key) {
      await clear(); // a buffer address without its key can't be closed by Mynt anyway
      return true;
    }
    try {
      const buffers = new Set<string>(await this.buffersOf(rpc, key.address));
      const stored = await this.keyRow(p.cluster, BUFFER_ACCOUNT, p.id);
      if (stored) buffers.add(stored.public_key);
      for (const b of buffers) {
        const a = await this.accountData(rpc, b);
        const isOurs = a && a.owner === UPGRADEABLE_LOADER && a.data.length >= BUFFER_HEADER && a.data.readUInt32LE(0) === 1 && a.data[4] === 1 && base58Encode(a.data.subarray(5, 37)) === key.address;
        if (isOurs) await this.send(rpc, signs(payer), [loader.close(b, payer.address, key.address)], [key]);
      }
      const { value } = await rpc.call<{ value: number }>("getBalance", [key.address, { commitment: "confirmed" }]);
      // All of it, less the fee: an account left with fewer lamports than rent would be refused.
      if (value > SIGNATURE_FEE) await this.send(rpc, signs(key), [system.transfer(key.address, payer.address, value - SIGNATURE_FEE)]);
    } catch {
      return false;
    }
    await clear();
    return true;
  }

  // Buffers whose authority is `authority`, as the loader lists them (its authority sits at bytes 5..37). Best
  // effort: some RPC providers don't serve getProgramAccounts; the stored buffer address covers that.
  private async buffersOf(rpc: SolanaRpc, authority: string): Promise<string[]> {
    try {
      const r = await rpc.call<{ pubkey: string }[]>("getProgramAccounts", [
        UPGRADEABLE_LOADER,
        { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 0, bytes: base58Encode(Uint8Array.of(1, 0, 0, 0, 1)) } }, { memcmp: { offset: 5, bytes: authority } }] },
      ]);
      return Array.isArray(r) ? r.map((x) => x.pubkey).filter((k) => typeof k === "string" && isAddress(k)) : [];
    } catch {
      return [];
    }
  }

  // The one transaction the custody service signs, paid for by the deploy payer, on the program's durable nonce:
  // it starts by advancing the nonce and uses the nonce as its blockhash, so it stays valid however long the
  // approval takes, until it lands or the nonce moves. The custody signature is checked by the signer (the
  // custody address's, over exactly this message) before anything is sent.
  private async sendCustodySigned(rpc: SolanaRpc, payer: Keypair, custody: SolanaSigner, nonce: string, ixs: Instruction[], extra: Keypair[]) {
    const value = await this.nonceValue(rpc, nonce, payer.address);
    if (!value) throw new SolanaError(`The durable nonce ${nonce} isn't ready`);
    const message = compileMessage(payer.address, [system.advanceNonce(nonce, payer.address), ...ixs], value);
    const sigs = new Map<string, Uint8Array>([[custody.address, await custody.sign(message.bytes)]]);
    for (const s of message.signers) {
      if (sigs.has(s)) continue;
      const kp = [payer, ...extra].find((k) => k.address === s);
      if (!kp) throw new SolanaError(`No signature available for ${s}`);
      sigs.set(s, kp.sign(message.bytes));
    }
    const wire = serializeTransaction(message, sigs);
    const signature = (await rpc.call<string>("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }])) || signatureOf(wire);
    await this.confirm(rpc, [signature]);
    return signature;
  }

  // The program bytes into a fresh buffer account, a Write per chunk, confirmed in batches, each batch on a
  // fresh blockhash, the writes paced to what the cluster's RPC allows.
  private async writeBuffer(rpc: SolanaRpc, cluster: Cluster, signer: Signs, program: Uint8Array, alive: () => Promise<void> = async () => undefined, buffer = Keypair.generate()) {
    const size = BUFFER_HEADER + program.length;
    const lamports = await rpc.call<number>("getMinimumBalanceForRentExemption", [size]);
    await this.send(rpc, signer, [system.createAccount(signer.address, buffer.address, lamports, size, UPGRADEABLE_LOADER), loader.initializeBuffer(buffer.address, signer.address)], [buffer]);
    try {
      const writes: Instruction[] = [];
      for (let offset = 0; offset < program.length; offset += WRITE_CHUNK) writes.push(loader.write(buffer.address, signer.address, offset, program.subarray(offset, offset + WRITE_CHUNK)));
      for (let i = 0; i < writes.length; i += WRITE_BATCH) {
        await this.writeBatch(rpc, cluster, signer, writes.slice(i, i + WRITE_BATCH));
        await alive();
      }
    } catch (e) {
      await this.closeBuffer(rpc, signer, buffer.address);
      throw e;
    }
    return buffer.address;
  }

  // One batch of writes on one blockhash, confirmed together. A write that can't land on it (its blockhash expired
  // while the RPC was rate-limiting us, or it wasn't confirmed in time) is signed again on a fresh blockhash and
  // sent again. That is safe: a Write puts the same bytes at the same offset, however often it lands.
  private async writeBatch(rpc: SolanaRpc, cluster: Cluster, signer: Signs, writes: Instruction[]) {
    let pending = writes;
    for (let attempt = 1; ; attempt++) {
      const { blockhash } = await this.blockhash(rpc);
      const sent: { w: Instruction; sig: string }[] = [];
      try {
        for (const w of pending) {
          await this.pacer(cluster).take();
          sent.push({ w, sig: await this.submit(rpc, signer, [w], [], blockhash) });
        }
        await this.confirm(rpc, sent.map((x) => x.sig));
        return;
      } catch (e) {
        if (attempt >= WRITE_ATTEMPTS || !(e instanceof Unconfirmed || BLOCKHASH_GONE.test((e as Error).message))) throw e;
        // Only what hasn't landed goes again: what was sent may have landed in the meantime.
        const landed = new Set<string>();
        if (sent.length) {
          const r = await rpc.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [sent.map((x) => x.sig), { searchTransactionHistory: true }]);
          sent.forEach((x, i) => {
            const st = r.value[i];
            if (st && !st.err && ["confirmed", "finalized"].includes(st.confirmationStatus ?? "")) landed.add(x.sig);
          });
        }
        pending = pending.filter((w) => !sent.some((x) => x.w === w && landed.has(x.sig)));
        if (!pending.length) return;
      }
    }
  }

  // A buffer an earlier vault-signed deploy or upgrade of this program left behind (its close failed: the RPC was
  // rate-limiting or down) is closed before a new one is written, so its rent comes back. If it can't be closed
  // now, nothing starts: the deploy can be started again once the RPC answers.
  private async closeLeftoverBuffer(rpc: SolanaRpc, p: ProgramRecord, signer: Signs) {
    const stored = await this.keyRow(p.cluster, VAULT_BUFFER, p.id);
    if (!stored) return;
    try {
      const a = await this.accountData(rpc, stored.public_key);
      const ours = a && a.owner === UPGRADEABLE_LOADER && a.data.length >= BUFFER_HEADER && a.data.readUInt32LE(0) === 1 && a.data[4] === 1 && base58Encode(a.data.subarray(5, 37)) === signer.address;
      if (ours) await this.send(rpc, signer, [loader.close(stored.public_key, signer.address, signer.address)]);
    } catch (e) {
      throw new SolanaError(`An earlier deploy of this program left a buffer that couldn't be closed yet (${(e as Error).message.slice(0, 300)}). Nothing was started; start the deploy again once the RPC answers`);
    }
    await this.forgetBuffer(p);
  }

  private async forgetBuffer(p: ProgramRecord) {
    await this.db.query(`DELETE FROM ${T}.solana_keys WHERE cluster = $1 AND role = $2 AND scope = $3`, [p.cluster, VAULT_BUFFER, p.id]);
  }

  // Best effort: a buffer left behind holds rent; closing it returns that to the signer.
  private async closeBuffer(rpc: SolanaRpc, signer: Signs, buffer: string) {
    await this.send(rpc, signer, [loader.close(buffer, signer.address, signer.address)]).catch(() => undefined);
  }

  private async blockhash(rpc: SolanaRpc) {
    return (await rpc.call<{ value: { blockhash: string } }>("getLatestBlockhash", [{ commitment: "confirmed" }])).value;
  }

  // Signs (`signer` pays; `extra` are other keys that must sign) and sends, without waiting.
  private async submit(rpc: SolanaRpc, signer: { address: string; sign(m: Uint8Array): Promise<Uint8Array> }, ixs: Instruction[], extra: Keypair[], blockhash: string) {
    const message = compileMessage(signer.address, ixs, blockhash);
    const sigs = new Map<string, Uint8Array>();
    for (const s of message.signers) {
      if (s === signer.address) sigs.set(s, await signer.sign(message.bytes));
      else {
        const kp = extra.find((k) => k.address === s);
        if (!kp) throw new SolanaError(`No signature available for ${s}`);
        sigs.set(s, kp.sign(message.bytes));
      }
    }
    const wire = serializeTransaction(message, sigs);
    const signature = await rpc.call<string>("sendTransaction", [Buffer.from(wire).toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    return signature || signatureOf(wire);
  }

  private async send(rpc: SolanaRpc, signer: { address: string; sign(m: Uint8Array): Promise<Uint8Array> }, ixs: Instruction[], extra: Keypair[] = []) {
    const sig = await this.submit(rpc, signer, ixs, extra, (await this.blockhash(rpc)).blockhash);
    await this.confirm(rpc, [sig]);
    return sig;
  }

  private async confirm(rpc: SolanaRpc, signatures: string[]) {
    const deadline = Date.now() + this.config.confirmTimeoutMs;
    let pending = [...signatures];
    while (pending.length) {
      const r = await rpc.call<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [pending, { searchTransactionHistory: true }]);
      const still: string[] = [];
      pending.forEach((s, i) => {
        const st = r.value[i];
        if (st?.err) throw new SolanaError(`Transaction ${s} failed: ${JSON.stringify(st.err).slice(0, 300)}`);
        if (!st || !["confirmed", "finalized"].includes(st.confirmationStatus ?? "")) still.push(s);
      });
      pending = still;
      if (!pending.length) break;
      if (Date.now() > deadline) throw new Unconfirmed(`Transaction ${pending[0]} wasn't confirmed in time`);
      await new Promise((r) => setTimeout(r, this.config.pollMs));
    }
  }

  // ---- calls ----

  private async instruction(p: ProgramRecord, input: CallInput, keys: { payer: string; caller: string }): Promise<Instruction> {
    let data: Buffer;
    if (input.method) {
      if (!/^[a-z_][a-z0-9_]*$/.test(input.method)) throw new SolanaError("method is the Anchor instruction's name, in snake_case");
      data = Buffer.concat([anchorDiscriminator("global", input.method), Buffer.from(input.args_base64 ?? "", "base64")]);
    } else if (input.data_base64) data = Buffer.from(input.data_base64, "base64");
    else throw new SolanaError("Give method (an Anchor instruction) or data_base64");
    const authorities = new Set<string>();
    for (const c of CLUSTERS) {
      for (const role of ["authority", DEPLOY_PAYER]) {
        const k = await this.keyRow(c, role, "");
        if (k) authorities.add(k.public_key);
      }
    }
    const s = await this.mainnetSettings();
    if (s.custody) authorities.add(s.custody.address);
    if (s.multisig) authorities.add(s.multisig.vault);
    const metas = input.accounts.map((a) => {
      const pubkey = a.pubkey === "$caller" ? keys.caller : a.pubkey;
      if (!isAddress(pubkey)) throw new SolanaError(`'${a.pubkey}' isn't a Solana address`);
      if (authorities.has(pubkey)) throw new SolanaError("A program call may not include Mynt's deploy authority");
      if (pubkey === keys.payer) throw new SolanaError("A program call may not include its fee payer; use $caller");
      if (a.signer && pubkey !== keys.caller) throw new SolanaError("The only signer a call may have is your caller key ($caller)");
      return { pubkey, isSigner: !!a.signer, isWritable: !!a.writable };
    });
    return { programId: p.program_id, keys: metas, data: new Uint8Array(data) };
  }

  private async callable(p: ProgramRecord) {
    if (p.status !== "deployed") throw new SolanaError(`The program is ${p.status}; only a deployed program can be called`);
  }

  async simulate(user: User, p: ProgramRecord, input: CallInput) {
    await this.callable(p);
    const { payer, caller } = await this.callKeys(p.cluster, p.owner_id);
    const rpc = this.rpc(p.cluster);
    const ix = await this.instruction(p, input, { payer: payer.address, caller: caller.address });
    // On devnet the developer's keys are funded before the simulation, which fails with AccountNotFound for a fee
    // payer that doesn't exist yet. On mainnet nothing is funded for them: an unfunded fee payer is named.
    const callerUsed = ix.keys.some((k) => k.pubkey === caller.address && (k.isSigner || k.isWritable));
    if (p.cluster === "devnet") {
      await this.devnetFloat(user, p.owner_id, payer.address, "fee payer", CALL_FEE_RESERVE);
      if (callerUsed) await this.devnetFloat(user, p.owner_id, caller.address, "caller", DEVNET_CALLER_FLOAT);
    } else await this.mainnetFunded(rpc, payer.address, 2 * SIGNATURE_FEE);
    let r = await this.simulateOnce(rpc, payer.address, ix);
    // An account bigger than the caller's float: its shortfall, from the system program's log, then once more.
    const short = p.cluster === "devnet" && callerUsed && r.value.err ? (r.value.logs ?? []).map((l) => SHORTFALL.exec(l)).find((m) => m) : null;
    if (short) {
      const have = await this.balance(rpc, caller.address);
      await this.devnetFloat(user, p.owner_id, caller.address, "caller", have + Number(short[2]) - Number(short[1]));
      r = await this.simulateOnce(rpc, payer.address, ix);
    }
    return {
      ok: !r.value.err,
      err: r.value.err ?? null,
      logs: (r.value.logs ?? []).slice(-60),
      units_consumed: r.value.unitsConsumed ?? null,
      fee_payer: payer.address,
      caller: caller.address,
    };
  }

  private async simulateOnce(rpc: SolanaRpc, payer: string, ix: Instruction) {
    const message = compileMessage(payer, [ix], (await this.blockhash(rpc)).blockhash);
    const wire = serializeTransaction(message, new Map());
    return rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [
      Buffer.from(wire).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
    ]);
  }

  // Simulated first; sent only if the simulation succeeds. Fees come from the developer's fee payer, which no
  // program ever sees; $caller signs only when the call lists it. On devnet the simulation has already funded
  // both keys; on mainnet the fee payer must hold its reserve, which Mynt never sends it.
  async call(user: User, p: ProgramRecord, input: CallInput) {
    const simulation = await this.simulate(user, p, input);
    if (!simulation.ok) return { sent: false, simulation };
    const { payer, caller } = await this.callKeys(p.cluster, p.owner_id);
    const rpc = this.rpc(p.cluster);
    if (p.cluster === "mainnet") await this.mainnetFunded(rpc, payer.address, CALL_FEE_RESERVE);
    const ix = await this.instruction(p, input, { payer: payer.address, caller: caller.address });
    const callerSigns = ix.keys.some((k) => k.pubkey === caller.address && k.isSigner);
    const signature = await this.send(rpc, { address: payer.address, sign: async (m) => payer.sign(m) }, [ix], callerSigns ? [caller] : []);
    await this.store.audit(user.id, "call_program", p.program_id, { cluster: p.cluster, signature, method: input.method ?? null });
    return { sent: true, signature, explorer_url: explorer(p.cluster, "tx", signature), simulation };
  }

  private async balance(rpc: SolanaRpc, address: string) {
    return (await rpc.call<{ value: number }>("getBalance", [address, { commitment: "confirmed" }])).value;
  }

  // Mainnet: a developer's fee payer is theirs to fund. Says which address, and how much it needs.
  private async mainnetFunded(rpc: SolanaRpc, address: string, need: number) {
    const have = await this.balance(rpc, address);
    if (have < need)
      throw new SolanaError(
        `Your mainnet fee payer ${address} holds ${sol(have)} and needs at least ${sol(need)} to pay for calls. Mynt never funds mainnet keys: send SOL to ${address} and try again`,
      );
  }

  // Devnet only: a developer's call key holds at least `need`. The faucet first; if it refuses (it rate-limits
  // servers), a transfer of just the shortfall from Mynt's devnet deploy authority, within the top-up limits.
  // That transfer is its own transaction, signed only by the authority, to the developer's own key: the
  // authority never signs, pays for or appears in a developer's call. One developer's top-ups run one at a time,
  // so the daily limit holds.
  private async devnetFloat(user: User, ownerId: string, address: string, role: string, need: number) {
    const prior = this.topUps.get(ownerId) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.devnetFloatNow(user, ownerId, address, role, need));
    this.topUps.set(ownerId, run);
    try {
      return await run;
    } finally {
      if (this.topUps.get(ownerId) === run) this.topUps.delete(ownerId);
    }
  }

  private async devnetFloatNow(user: User, ownerId: string, address: string, role: string, need: number) {
    const rpc = this.rpc("devnet");
    let have = await this.balance(rpc, address);
    if (have >= need) return;
    const audit = (source: string, lamports: number, signature: string) =>
      this.store.audit(user.id, TOPUP_ACTION, address, { cluster: "devnet", owner_id: ownerId, role, source, lamports, signature });
    try {
      const lamports = Math.min(AIRDROP_MAX, need);
      const sig = await rpc.call<string>("requestAirdrop", [address, lamports]);
      await this.confirm(rpc, [sig]);
      await audit("faucet", lamports, sig);
      have = await this.balance(rpc, address);
      if (have >= need) return;
    } catch {
      // the faucet's limits: Mynt's own devnet SOL instead
    }
    const limits = this.config.devnetTopUp ?? DEFAULT_DEVNET_TOPUP;
    const shortfall = need - have;
    const fundIt = `fund ${address} at https://faucet.solana.com and try again`;
    if (shortfall > limits.maxLamports)
      throw new SolanaError(
        `Your devnet ${role} ${address} needs ${sol(shortfall)} more, over the ${sol(limits.maxLamports)} Mynt tops up at once, and the devnet faucet refused; ${fundIt}`,
      );
    const row = await this.one(
      `SELECT COALESCE(SUM((details->>'lamports')::bigint), 0) AS used FROM financial_products.audit_log
       WHERE action = $1 AND details->>'owner_id' = $2 AND details->>'source' = 'devnet-authority' AND created_at > now() - interval '24 hours'`,
      [TOPUP_ACTION, ownerId],
    );
    const used = Number(row?.used ?? 0);
    if (used + shortfall > limits.dailyLamports)
      throw new SolanaError(
        `Mynt has topped up your devnet keys with ${sol(used)} in the last 24 hours (its daily limit is ${sol(limits.dailyLamports)}) and the devnet faucet refused; ${fundIt}`,
      );
    // Only the devnet authority (a vault key, never a custody or multisig key), and only what it can spare
    // while keeping enough for its own rent and fees.
    const authority = await this.vaultKey("devnet", "authority", "");
    const spare = authority ? (await this.balance(rpc, authority.address)) - limits.authorityKeepLamports - SIGNATURE_FEE : 0;
    if (!authority || spare < shortfall) throw new SolanaError(`The devnet faucet refused and Mynt's own devnet SOL is low; ${fundIt}`);
    const signature = await this.send(rpc, signs(authority), [system.transfer(authority.address, address, shortfall)]);
    await audit("devnet-authority", shortfall, signature);
  }

  // ---- the indexer ----

  // New transactions of every deployed program, oldest first; each Anchor event its own logs carry (the
  // "Program data:" lines while the program is the one running) goes to the owning firm's webhooks.
  async pollEvents() {
    if (this.recovery) await this.recoverStale().catch((e) => console.error(`solana: recovering stale operations: ${(e as Error).message.slice(0, 200)}`));
    const programs = (await this.db.query(`SELECT * FROM ${T}.solana_programs WHERE status = 'deployed' ORDER BY updated_at`)).rows.map((r) => toProgram(r as Row));
    let emitted = 0;
    for (const p of programs) {
      if (p.cluster === "mainnet" && !this.config.rpcUrls.mainnet) continue;
      try {
        emitted += await this.indexProgram(p);
      } catch (e) {
        console.error(`solana indexer: ${p.program_id}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
    return { programs: programs.length, events: emitted };
  }

  private async indexProgram(p: ProgramRecord) {
    const rpc = this.rpc(p.cluster);
    // Every signature since the cursor (newest first, a page at a time), so none is skipped however long the
    // backlog; then the oldest INDEX_PER_POLL of them are read, and the cursor moves only past what was read.
    const fresh: { signature: string; slot: number; err: unknown }[] = [];
    let before: string | undefined;
    for (;;) {
      const sigs = await rpc.call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [
        p.program_id,
        { limit: 1000, commitment: "confirmed", ...(p.index_cursor ? { until: p.index_cursor } : {}), ...(before ? { before } : {}) },
      ]);
      fresh.push(...sigs);
      if (sigs.length < 1000) break;
      before = sigs[sigs.length - 1].signature;
    }
    if (!fresh.length) return 0;
    const idl = await this.idlFor(p);
    let emitted = 0;
    for (const s of fresh.reverse().slice(0, SolanaService.INDEX_PER_POLL)) {
      const tx = await rpc.call<{ slot: number; meta: { err: unknown; logMessages?: string[] } | null } | null>("getTransaction", [
        s.signature,
        { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
      ]);
      const events = programEvents(p.program_id, tx?.meta?.logMessages ?? []);
      for (const [i, data] of events.entries()) {
        const name = eventName(idl, data);
        const inserted = await this.db.query(
          `INSERT INTO ${T}.solana_program_events (id, program, signature, idx, slot, event, data_b64, failed) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (program, signature, idx) DO NOTHING RETURNING id`,
          [randomUUID(), p.id, s.signature, i, tx?.slot ?? s.slot, name, Buffer.from(data).toString("base64"), !!(tx?.meta?.err ?? s.err)],
        );
        if (!inserted.rows.length) continue;
        emitted++;
        if (p.entity_id)
          await emitFirmEvent(
            this.store,
            p.entity_id,
            "program.event",
            { program_id: p.program_id, name: p.name, cluster: p.cluster, signature: s.signature, slot: tx?.slot ?? s.slot, event: name, data_base64: Buffer.from(data).toString("base64"), failed: !!(tx?.meta?.err ?? s.err) },
            p.cluster !== "mainnet",
          );
      }
      await this.update(p.id, { index_cursor: s.signature });
    }
    return emitted;
  }

  private async idlFor(p: ProgramRecord) {
    if (!p.build_id) return null;
    const r = await this.one(`SELECT idl FROM ${T}.solana_program_artifacts WHERE build_id = $1 AND declared_id = $2`, [p.build_id, p.program_id]);
    return (r?.idl as { events?: { name: string; discriminator?: number[] }[] } | null) ?? null;
  }

  // ---- what developers see ----

  view(p: ProgramRecord) {
    return {
      program_id: p.program_id,
      name: p.name,
      cluster: p.cluster,
      app_id: p.app_id,
      product_id: p.product_id,
      status: p.status,
      in_progress: p.operation,
      version: p.version,
      build_id: p.build_id,
      verifiable_hash: p.verifiable_hash,
      cargo_lock_sha256: p.cargo_lock_sha256,
      deployer: p.deployer,
      upgrade_authority: p.upgrade_authority,
      signer_backend: p.signer_backend,
      deployed_tx: p.deployed_tx,
      programdata_address: p.programdata_address,
      error: p.error,
      explorer_url: explorer(p.cluster, "address", p.program_id),
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }
}

// The Anchor event payloads a program logged itself: "Program data: <base64>" lines while `programId` is the
// innermost program running (not a program it called, nor one that called it).
export function programEvents(programId: string, logs: string[]): Uint8Array[] {
  const stack: string[] = [];
  const out: Uint8Array[] = [];
  for (const line of logs) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Program (\w+) invoke \[\d+\]$/))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if ((m = line.match(/^Program data: (.+)$/)) && stack[stack.length - 1] === programId) {
      const data = Buffer.from(m[1].trim(), "base64");
      if (data.length >= 8) out.push(new Uint8Array(data));
    }
  }
  return out;
}

// An event's name by its discriminator: from the build's IDL, or computed from the IDL's event names.
export function eventName(idl: { events?: { name: string; discriminator?: number[] }[] } | null, data: Uint8Array): string {
  const head = Buffer.from(data.subarray(0, 8));
  for (const e of idl?.events ?? []) {
    const d = e.discriminator?.length === 8 ? Buffer.from(e.discriminator) : Buffer.from(anchorDiscriminator("event", e.name));
    if (d.equals(head)) return e.name;
  }
  return "unknown";
}

