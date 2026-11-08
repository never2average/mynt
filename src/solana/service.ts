import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import { emitFirmEvent } from "../runtime.js";
import type { Store, User } from "../store.js";
import { open, seal, vaultAvailable } from "../vault.js";
import { anchorDiscriminator, base58Encode, executableHash, findProgramAddress, isAddress, Keypair } from "./codec.js";
import { CLUSTERS, GenesisCheckedRpc, HttpSolanaRpc, rpcUrlsFromEnv, type Cluster, type SolanaRpc } from "./rpc.js";
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
import {
  BUFFER_HEADER,
  compileMessage,
  loader,
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
}

export function solanaConfigFromEnv(env = process.env): SolanaConfig {
  return {
    rpcUrls: rpcUrlsFromEnv(env),
    mainnetVaultAllowed: env.SOLANA_MAINNET_VAULT_SIGNER === "enabled",
    confirmTimeoutMs: Number(env.SOLANA_CONFIRM_TIMEOUT_MS ?? 90_000),
    pollMs: Number(env.SOLANA_CONFIRM_POLL_MS ?? 1_000),
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
const AIRDROP_MAX = 2 * LAMPORTS_PER_SOL;
const CALL_FEE_RESERVE = 5_000_000; // what a developer's fee payer keeps for calls' fees
const DEVNET_CALLER_FLOAT = 50_000_000; // devnet only: enough for a call to pay an account's rent
const sol = (lamports: number) => `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
const explorer = (cluster: Cluster, kind: "tx" | "address", id: string) =>
  `https://explorer.solana.com/${kind}/${id}${cluster === "devnet" ? "?cluster=devnet" : ""}`;

export class SolanaError extends Error {}

export class SolanaService {
  private jobs = new Map<string, Promise<void>>();
  private rpcs = new Map<Cluster, SolanaRpc>();

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
    return new SolanaService(db, store, config, opts.rpc ?? ((_c, url) => new HttpSolanaRpc(url)), opts.custody ?? null, opts.multisig ?? null);
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
        `SELECT version, action, build_id, verifiable_hash, tx, signer_backend, created_at FROM ${T}.solana_program_versions WHERE program = $1 ORDER BY version`,
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
    if (s.backend === "custody-service" && !this.custody) reasons.push("no custody provider is connected to this Mynt");
    if (s.backend === "custody-service" && !s.custody) reasons.push("no custody address is configured");
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
  async recordArtifacts(buildId: string, artifacts: (ProgramArtifact & { reported_sha256?: string })[]) {
    const kept: string[] = [];
    for (const a of artifacts) {
      const sha = executableHash(a.program);
      if (a.reported_sha256 && a.reported_sha256 !== sha) continue;
      await this.db.query(
        `INSERT INTO ${T}.solana_program_artifacts (id, build_id, name, declared_id, sha256, size, program_b64, idl) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (build_id, name) DO UPDATE SET declared_id = EXCLUDED.declared_id, sha256 = EXCLUDED.sha256, size = EXCLUDED.size, program_b64 = EXCLUDED.program_b64, idl = EXCLUDED.idl`,
        [randomUUID(), buildId, a.name, a.declared_id, sha, a.program.length, Buffer.from(a.program).toString("base64"), a.idl == null ? null : JSON.stringify(a.idl)],
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
    return (await this.db.query(`SELECT name, declared_id, sha256, size FROM ${T}.solana_program_artifacts WHERE build_id = $1 ORDER BY name`, [buildId])).rows as {
      name: string;
      declared_id: string | null;
      sha256: string;
      size: number;
    }[];
  }

  // The verified program for `p` in a build: the build must be the developer's, verified and shipped by Mynt,
  // and Mynt's own build of it must declare exactly this program's address.
  private async verifiedArtifact(user: User, p: ProgramRecord, buildId: string) {
    const b = await this.one(`SELECT developer_id, status FROM ${T}.build_runs WHERE id::text = $1`, [buildId]);
    if (!b || (b.developer_id !== user.id && b.developer_id !== p.owner_id)) throw new SolanaError(`No build of yours with id '${buildId}'`);
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
    return { name: r.name as string, sha256: r.sha256 as string, program: new Uint8Array(program) };
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
    const signer = await this.authority(p.cluster); // refuses here, before anything starts, when it isn't configured
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
      await this.finish(userId, p, prior.build_id, chain.hash, await this.latestSignature(p), signer, "deploy", chain.capacity);
      p = (await this.get(p.program_id))!;
      await this.update(p.id, { operation: "upgrade", operation_started_at: new Date(), pending_build_id: buildId });
      action = "upgrade";
      maxDataLen = chain.capacity;
    }
    if (action === "deploy") {
      maxDataLen = len * 2; // room to grow, as the Solana CLI leaves
      const programRent = await rent(PROGRAM_ACCOUNT_SIZE);
      const need = (await rent(BUFFER_HEADER + len)) + programRent + (await rent(PROGRAMDATA_HEADER + maxDataLen)) + FEE_MARGIN;
      await this.fund(rpc, p.cluster, signer.address, need);
      const programKey = await this.vaultKey(p.cluster, "program", p.id);
      if (!programKey) throw new SolanaError("The program's reserved keypair is missing");
      // The address is public once reserved: anyone may have sent it lamports. Then it can't be created, but, as
      // the Solana CLI does, it can be topped up, sized and handed to the loader, signed by its own keypair.
      const existing = await this.accountInfo(rpc, p.program_id);
      let open: Instruction[];
      if (!existing) open = [system.createAccount(signer.address, p.program_id, programRent, PROGRAM_ACCOUNT_SIZE, UPGRADEABLE_LOADER)];
      else if (existing.owner === SYSTEM_PROGRAM && !existing.space)
        open = [
          ...(existing.lamports < programRent ? [system.transfer(signer.address, p.program_id, programRent - existing.lamports)] : []),
          system.allocate(p.program_id, PROGRAM_ACCOUNT_SIZE),
          system.assign(p.program_id, UPGRADEABLE_LOADER),
        ];
      else throw new SolanaError(`An account owned by ${existing.owner} already exists at ${p.program_id}`);
      const buffer = await this.writeBuffer(rpc, signer, artifact.program, () => this.heartbeat(p.id));
      try {
        tx = await this.send(rpc, signer, [
          ...open,
          loader.deployWithMaxDataLen({ payer: signer.address, programData: p.programdata_address!, program: p.program_id, buffer, authority: signer.address, maxDataLen }),
        ], [programKey]);
      } catch (e) {
        await this.closeBuffer(rpc, signer, buffer);
        throw e;
      }
    } else {
      const capacity = chain?.capacity ?? p.max_data_len ?? 0;
      if (len > capacity) throw new SolanaError(`The new program (${len} bytes) is larger than the ${capacity} bytes reserved at first deploy; deploy it as a new program`);
      await this.fund(rpc, p.cluster, signer.address, (await rent(BUFFER_HEADER + len)) + FEE_MARGIN);
      const buffer = await this.writeBuffer(rpc, signer, artifact.program, () => this.heartbeat(p.id));
      try {
        tx = await this.send(rpc, signer, [loader.upgrade({ programData: p.programdata_address!, program: p.program_id, buffer, spill: signer.address, authority: signer.address })]);
      } catch (e) {
        await this.closeBuffer(rpc, signer, buffer);
        throw e;
      }
    }
    await this.finish(userId, p, buildId, artifact.sha256, tx, signer, action, maxDataLen);
  }

  // The deploy or upgrade is on chain: record the version and tell the firm.
  private async finish(userId: string | null, p: ProgramRecord, buildId: string, sha256: string, tx: string, signer: SolanaSigner, action: "deploy" | "upgrade", maxDataLen: number | null) {
    const version = p.version + 1;
    await this.db.query(
      `INSERT INTO ${T}.solana_program_versions (id, program, version, action, build_id, verifiable_hash, tx, signer_backend, by_user) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [randomUUID(), p.id, version, action, buildId, sha256, tx, signer.backend, userId],
    );
    await this.update(p.id, {
      status: "deployed",
      operation: null,
      operation_started_at: null,
      pending_build_id: null,
      version,
      build_id: buildId,
      verifiable_hash: sha256,
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
        { program_id: p.program_id, name: p.name, cluster: p.cluster, version, verifiable_hash: sha256, signature: tx, build_id: buildId },
        p.cluster !== "mainnet",
      );
  }

  private async storedArtifact(p: ProgramRecord, buildId: string) {
    const r = await this.one(`SELECT sha256 FROM ${T}.solana_program_artifacts WHERE build_id = $1 AND declared_id = $2`, [buildId, p.program_id]);
    return r ? { sha256: r.sha256 as string } : null;
  }

  // A build of this program that Mynt verified, whose program hashes as `sha256`.
  private async artifactByHash(p: ProgramRecord, sha256: string) {
    const r = await this.one(`SELECT build_id FROM ${T}.solana_program_artifacts WHERE declared_id = $1 AND sha256 = $2 ORDER BY created_at DESC LIMIT 1`, [p.program_id, sha256]);
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

  // The program bytes into a fresh buffer account, a Write per chunk, confirmed in batches.
  private async writeBuffer(rpc: SolanaRpc, signer: SolanaSigner, program: Uint8Array, alive: () => Promise<void> = async () => undefined) {
    const buffer = Keypair.generate();
    const size = BUFFER_HEADER + program.length;
    const lamports = await rpc.call<number>("getMinimumBalanceForRentExemption", [size]);
    await this.send(rpc, signer, [system.createAccount(signer.address, buffer.address, lamports, size, UPGRADEABLE_LOADER), loader.initializeBuffer(buffer.address, signer.address)], [buffer]);
    try {
      const writes: Instruction[] = [];
      for (let offset = 0; offset < program.length; offset += WRITE_CHUNK) writes.push(loader.write(buffer.address, signer.address, offset, program.subarray(offset, offset + WRITE_CHUNK)));
      for (let i = 0; i < writes.length; i += 16) {
        const { blockhash } = await this.blockhash(rpc);
        const sigs = [];
        for (const w of writes.slice(i, i + 16)) sigs.push(await this.submit(rpc, signer, [w], [], blockhash));
        await this.confirm(rpc, sigs);
        await alive();
      }
    } catch (e) {
      await this.closeBuffer(rpc, signer, buffer.address);
      throw e;
    }
    return buffer.address;
  }

  // Best effort: a buffer left behind holds rent; closing it returns that to the signer.
  private async closeBuffer(rpc: SolanaRpc, signer: SolanaSigner, buffer: string) {
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
      if (Date.now() > deadline) throw new SolanaError(`Transaction ${pending[0]} wasn't confirmed in time`);
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
      const k = await this.keyRow(c, "authority", "");
      if (k) authorities.add(k.public_key);
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

  async simulate(p: ProgramRecord, input: CallInput) {
    await this.callable(p);
    const { payer, caller } = await this.callKeys(p.cluster, p.owner_id);
    const rpc = this.rpc(p.cluster);
    const ix = await this.instruction(p, input, { payer: payer.address, caller: caller.address });
    const message = compileMessage(payer.address, [ix], (await this.blockhash(rpc)).blockhash);
    const wire = serializeTransaction(message, new Map());
    const r = await rpc.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [
      Buffer.from(wire).toString("base64"),
      { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
    ]);
    return {
      ok: !r.value.err,
      err: r.value.err ?? null,
      logs: (r.value.logs ?? []).slice(-60),
      units_consumed: r.value.unitsConsumed ?? null,
      fee_payer: payer.address,
      caller: caller.address,
    };
  }

  // Simulated first; sent only if the simulation succeeds. Fees come from the developer's fee payer, which no
  // program ever sees; $caller signs only when the call lists it.
  async call(user: User, p: ProgramRecord, input: CallInput) {
    const simulation = await this.simulate(p, input);
    if (!simulation.ok) return { sent: false, simulation };
    const { payer, caller } = await this.callKeys(p.cluster, p.owner_id);
    const rpc = this.rpc(p.cluster);
    await this.fund(rpc, p.cluster, payer.address, CALL_FEE_RESERVE);
    const ix = await this.instruction(p, input, { payer: payer.address, caller: caller.address });
    const callerSigns = ix.keys.some((k) => k.pubkey === caller.address && k.isSigner);
    if (callerSigns && p.cluster === "devnet") await this.fund(rpc, p.cluster, caller.address, DEVNET_CALLER_FLOAT).catch(() => undefined);
    const signature = await this.send(rpc, { address: payer.address, sign: async (m) => payer.sign(m) }, [ix], callerSigns ? [caller] : []);
    await this.store.audit(user.id, "call_program", p.program_id, { cluster: p.cluster, signature, method: input.method ?? null });
    return { sent: true, signature, explorer_url: explorer(p.cluster, "tx", signature), simulation };
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

