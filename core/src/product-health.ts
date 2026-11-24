import { createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, randomBytes, randomUUID, verify as edVerify } from "node:crypto";
import { defaultLedgerFor, isLedgerError, isSealedReading, type PartnerLedger, type PartnerLedgerReading, type SealedLedgerReading } from "./partner-ledger/index.js";
import type { ConfidentialHost } from "./confidential/host.js";
import { HEALTH_ATTESTER_KEY, healthAttestationMessage } from "./confidential/shared/health.js";
import type { Db } from "./db.js";
import { base58Decode, isAddress, isWeakEd25519Key, Keypair } from "./solana/codec.js";
import {
  cosignMessage,
  decodeHead,
  headAddress,
  healthIx,
  KIND_MISSED,
  KIND_SNAPSHOT,
  nextChain,
  partnerCommitment,
  SOURCE_FLAG,
  subjectKey,
  ZERO_32,
  type ChainLink,
  type HeadAccount,
  type MissedEntry,
  type SnapshotEntry,
} from "./solana/product-health-chain.js";
import { verifyEd25519 } from "./solana/signer.js";
import type { SolanaService } from "./solana/service.js";
import type { Store, User } from "./store.js";
import { derivedKey, open as openSealed, seal, vaultAvailable } from "./vault.js";
import { serialLoop } from "./worker.js";

// Each product's financial health, on the record: reserves against what customers are owed, what flowed, what's
// pending, what failed. Licence providers and liquidity providers read it to pull a licence or move capital, so:
//
//   - the partner's numbers come from the partner's own ledger, never the developer's app;
//   - each snapshot is encoded canonically and its sha256 goes on chain, so a report can't be changed afterwards
//     without it showing; a random salt inside keeps the numbers from being guessed from it;
//   - the report is encrypted per product and opened only for entitled readers, through get_product_health;
//   - a figure Mynt can't measure is null with a reason, never 0; money is integer cents, ratios integer basis points;
//   - a live product's snapshot counts as verified only when the partner co-signs it, and that's re-checked on every
//     read from the authenticated report and the signature, never from a stored flag.
//
// Mynt never holds funds and no customer data goes on chain; this module only reports.

const T = "financial_products";
export const SCHEMA = "mynt.product_health.v1";
export const TABLES = `
  -- Each licence provider firm's current key for co-signing snapshots, and every key it has ever registered.
  CREATE TABLE IF NOT EXISTS ${T}.product_health_signing_keys (
    entity_id uuid PRIMARY KEY,
    public_key text NOT NULL,
    registered_by uuid,
    registered_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ${T}.product_health_signing_key_history (
    entity_id uuid NOT NULL,
    public_key text NOT NULL,
    registered_by uuid,
    registered_at timestamptz NOT NULL DEFAULT now(),
    mac text NOT NULL, -- under a key derived from the vault: someone who can only write the database can't plant a key
    PRIMARY KEY (entity_id, public_key)
  );
  -- Per product (or pool): the data key its reports are encrypted with, sealed under MYNT_VAULT_KEY.
  CREATE TABLE IF NOT EXISTS ${T}.product_health_keys (
    subject text PRIMARY KEY,
    sealed_key text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  -- Each on-chain record of a subject: the first, and each one an admin started after a chain reset or a new program.
  -- The prev_ columns are what the record before it looked like when it ended, so a re-anchor can't launder it.
  CREATE TABLE IF NOT EXISTS ${T}.product_health_anchors (
    subject text NOT NULL,
    epoch integer NOT NULL,
    reason text NOT NULL,
    anchored_by uuid,
    anchored_at timestamptz NOT NULL DEFAULT now(),
    program_id text,
    prev_verdict text,
    prev_head_sequence integer,
    prev_head_chain text,
    mac text NOT NULL, -- under a key derived from the vault: someone who can only write the database can't rewrite this
    PRIMARY KEY (subject, epoch)
  );
  -- When the worker last ran, for ops_status.
  CREATE TABLE IF NOT EXISTS ${T}.product_health_worker (
    id text PRIMARY KEY,
    last_tick_at timestamptz NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ${T}.product_health_snapshots (
    id uuid PRIMARY KEY,
    subject text NOT NULL,
    epoch integer NOT NULL DEFAULT 0,
    product_id text NOT NULL,
    pool_id text NOT NULL DEFAULT '',
    sequence integer NOT NULL,
    period_start timestamptz NOT NULL,
    period_end timestamptz NOT NULL,
    status text NOT NULL CHECK (status IN ('pending_signature', 'ready', 'published', 'missed')),
    source text NOT NULL,
    live boolean NOT NULL DEFAULT false,
    partner_entity_id uuid,
    fingerprint text,
    report_sealed text,
    attestation text,
    partner_key text,
    partner_signature text,
    sign_deadline timestamptz,
    publish_deadline timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz,
    missed_reason text,
    last_error text,
    stalled_reason text,
    on_chain boolean NOT NULL DEFAULT false,
    tx_signature text,
    published_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (subject, epoch, sequence),
    UNIQUE (subject, period_start)
  );
  CREATE INDEX IF NOT EXISTS product_health_status_idx ON ${T}.product_health_snapshots (status, subject, sequence);
  -- A snapshot the confidential host computed from a partner's sealed statement: its health-attester key and signature
  -- over the fingerprint (confidential/shared/health.ts).
  ALTER TABLE ${T}.product_health_snapshots ADD COLUMN IF NOT EXISTS enclave_key text;
  ALTER TABLE ${T}.product_health_snapshots ADD COLUMN IF NOT EXISTS enclave_signature text;
`;

export * from "./confidential/shared/figures.js";
import { adaptRailFlows, buildFigures, canonicalJson, fingerprintOf, FLOWS_BASIS, FLOWS_UNAVAILABLE, NOT_PARTIAL, type AdaptedFlows, type FlowsFor, type HealthReport } from "./confidential/shared/figures.js";

// ---- encryption ----

// Per product: a random AES-256-GCM key, sealed under MYNT_VAULT_KEY, encrypts its reports. The sealed report is
// bound to its subject, sequence and fingerprint, so a stored report can't be moved to another row or edited.
const aad = (subject: string, sequence: number, fingerprint: string) => Buffer.from(`${subject}|${sequence}|${fingerprint}`, "utf8");

export function sealReport(key: Buffer, plaintext: string, subject: string, sequence: number, fingerprint: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(subject, sequence, fingerprint));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function openReport(key: Buffer, sealed: string, subject: string, sequence: number, fingerprint: string): string {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unknown report format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAAD(aad(subject, sequence, fingerprint));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

// ---- the record ----

export type SnapshotStatus = "pending_signature" | "ready" | "published" | "missed";
export interface SnapshotRow {
  id: string;
  subject: string;
  epoch: number;
  product_id: string;
  pool_id: string;
  sequence: number;
  period_start: string;
  period_end: string;
  status: SnapshotStatus;
  source: string;
  live: boolean;
  partner_entity_id: string | null;
  fingerprint: string | null;
  report_sealed: string | null;
  attestation: string | null;
  partner_key: string | null;
  partner_signature: string | null;
  sign_deadline: string | null;
  publish_deadline: string | null;
  attempts: number;
  next_attempt_at: string | null;
  missed_reason: string | null;
  last_error: string | null;
  stalled_reason: string | null;
  on_chain: boolean;
  tx_signature: string | null;
  published_at: string | null;
  created_at: string;
  enclave_key?: string | null;
  enclave_signature?: string | null;
}

export interface Gap {
  kind: "no_record" | "missed" | "sequence_gap" | "period_gap" | "overdue" | "chain_behind" | "chain_ahead" | "stalled" | "re_anchored";
  sequence?: number;
  from?: string;
  to?: string;
  detail: string;
}

const iso = (t: string | Date) => new Date(t).toISOString();
const hexOf = (b: Uint8Array) => Buffer.from(b).toString("hex");
const hexToBytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

type GapRow = Pick<SnapshotRow, "sequence" | "period_start" | "period_end" | "status" | "missed_reason" | "on_chain"> & Partial<Pick<SnapshotRow, "fingerprint" | "stalled_reason">>;

// Where the record has a hole, for a monitor. Pure, from one chain's rows (oldest first) and its head. `chainKnown`:
// whether the head could be read at all; when it couldn't, nothing is claimed about the chain.
export function findGaps(rows: GapRow[], head: HeadAccount | null, now: Date, intervalMs: number, chainKnown = true): Gap[] {
  const gaps: Gap[] = [];
  for (const [i, r] of rows.entries()) {
    if (r.status === "missed") gaps.push({ kind: "missed", sequence: r.sequence, from: iso(r.period_start), to: iso(r.period_end), detail: r.missed_reason ?? "No snapshot for this period" });
    if (r.stalled_reason) gaps.push({ kind: "stalled", sequence: r.sequence, detail: r.stalled_reason });
    const prev = rows[i - 1];
    if (prev && r.sequence !== prev.sequence + 1) gaps.push({ kind: "sequence_gap", sequence: r.sequence, detail: `Sequence jumps from ${prev.sequence} to ${r.sequence}` });
    if (prev && new Date(r.period_start).getTime() > new Date(prev.period_end).getTime())
      gaps.push({ kind: "period_gap", sequence: r.sequence, from: iso(prev.period_end), to: iso(r.period_start), detail: "No record covers this time" });
  }
  const last = rows[rows.length - 1];
  if (last && new Date(last.period_end).getTime() + 2 * intervalMs < now.getTime()) gaps.push({ kind: "overdue", from: iso(last.period_end), detail: "No snapshot has been recorded since" });
  if (chainKnown) {
    const lastOnChain = [...rows].reverse().find((r) => r.on_chain)?.sequence ?? 0;
    const at = head?.sequence ?? 0;
    if (at < lastOnChain) gaps.push({ kind: "chain_behind", detail: head ? `Mynt recorded sequence ${lastOnChain} as on chain, but the chain's head is at ${at}` : `Mynt recorded sequence ${lastOnChain} as on chain, but the chain has no record for this product` });
    if (at > lastOnChain) {
      // One ahead and it's the next row of ours: that transaction landed and Mynt just hasn't recorded it yet.
      const next = rows.find((r) => r.sequence === at);
      const snapshotLanding = !!next?.fingerprint && !!head && next.fingerprint === hexOf(head.fingerprint);
      const markerLanding = next?.status === "missed" && head?.kind === KIND_MISSED;
      const landing = !!head && at === lastOnChain + 1 && (snapshotLanding || markerLanding);
      if (!landing) gaps.push({ kind: "chain_ahead", detail: `The chain's head is at sequence ${at}, past Mynt's own record (${lastOnChain})` });
    }
  }
  return gaps;
}

// What Mynt established about one stored snapshot, from the authenticated report and the signature, not stored flags.
export interface Assessment {
  report: HealthReport | null;
  report_matches: boolean | null; // null: nothing to check (a missed period)
  source: string;
  live: boolean;
  attestation: string | null;
  signature_ok: boolean | null; // null: no signature
  on_chain: string;
  enclave_signature_ok?: boolean | null; // null: not computed by the confidential host
}

// What the record says about a snapshot, for anyone allowed to see that it exists: no figures. `verified` needs all of
// it: published, the report authentic, from a real ledger on a live product, partner-signed, and matching the chain.
export function snapshotStatus(r: SnapshotRow, a: Assessment) {
  const live = a.live === true && a.source === "partner_ledger";
  const verified = r.status === "published" && a.report_matches === true && live && a.attestation === "partner_signed" && a.signature_ok === true && a.on_chain === "matches";
  const notes: string[] = [];
  if (a.source === "sandbox") notes.push("Sandbox figures: test numbers, never a live product's health.");
  if (a.source === "unavailable" && r.status !== "missed") notes.push("The partner's ledger couldn't be read for this period.");
  if (a.source === "unknown") notes.push("The stored report can't be authenticated, so where its numbers came from is unknown.");
  if (r.status !== "missed" && a.attestation === "mynt_only") notes.push("Without the licence provider's co-signature: Mynt alone attests this snapshot, so it isn't verified.");
  if (a.attestation === "invalid_signature") notes.push("The stored co-signature doesn't verify against any key the licence provider has registered.");
  if (r.status === "pending_signature") notes.push("Waiting for the licence provider's co-signature.");
  if (r.status === "missed") notes.push(r.missed_reason ?? "No snapshot for this period.");
  return {
    product_id: r.product_id,
    pool_id: r.pool_id || null,
    sequence: r.sequence,
    epoch: r.epoch,
    period_start: iso(r.period_start),
    period_end: iso(r.period_end),
    status: r.status,
    source: a.source,
    live,
    attestation: a.attestation,
    verified,
    fingerprint: r.fingerprint,
    on_chain: r.on_chain,
    tx_signature: r.tx_signature,
    published_at: r.published_at ? iso(r.published_at) : null,
    notes,
    // Computed by the confidential host from the partner's sealed statement: its key and whether its signature checks.
    ...(r.enclave_signature ? { enclave: { public_key: r.enclave_key, signature_ok: a.enclave_signature_ok === true } } : {}),
  };
}

// What a pool's reserve gate reads about the latest finished snapshot.
export interface PoolHealthReading {
  sequence: number;
  status: SnapshotStatus;
  source: string;
  live: boolean;
  verified: boolean;
  notes: string[];
  report: HealthReport | null;
}

export interface ProductHealthConfig {
  intervalMs: number;
  cosignWindowMs: number; // how long a snapshot waits for the partner's co-signature before it's published mynt_only
  pollMs: number;
  programId: string | null; // the deployed product-health program; none, and the worker doesn't run
}

export const MAX_INTERVAL_MINUTES = 24 * 60;

export function productHealthConfigFromEnv(env = process.env): ProductHealthConfig {
  const minutes = Number(env.PRODUCT_HEALTH_INTERVAL_MINUTES);
  const intervalMs = (env.PRODUCT_HEALTH_INTERVAL_MINUTES && minutes >= 1 ? Math.min(Math.floor(minutes), MAX_INTERVAL_MINUTES) : 60) * 60_000;
  const window = Number(env.PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES);
  const cosignWindowMs = Math.min(env.PRODUCT_HEALTH_COSIGN_WINDOW_MINUTES && window >= 0 ? window * 60_000 : intervalMs / 2, intervalMs / 2);
  const programId = env.PRODUCT_HEALTH_PROGRAM_ID || null;
  return { intervalMs, cosignWindowMs, pollMs: Number(env.PRODUCT_HEALTH_POLL_MS ?? 60_000), programId: programId && isAddress(programId) ? programId : null };
}

export interface HealthChain {
  readonly programId: string;
  readonly publisher: string;
  head(subject: Uint8Array, programId?: string): Promise<HeadAccount | null>; // of another program, to read one retired
  latestRecordTx?(subject: Uint8Array, expected: Uint8Array): Promise<string | null>; // the newest successful transaction on a subject's head that carries these bytes
  hasHeadHistory(subject: Uint8Array, programId?: string): Promise<boolean>; // whether a subject's head has ever had a transaction (of another program, to read one retired)
  publishSnapshot(subject: Uint8Array, entry: SnapshotEntry, opening: boolean): Promise<string>;
  publishMissed(subject: Uint8Array, entry: MissedEntry, opening: boolean): Promise<string>;
}

export interface ProductHealthDeps {
  chain?: HealthChain | null;
  flowsFor?: FlowsFor | null;
  ledgerFor?: (entityId: string) => PartnerLedger | Promise<PartnerLedger>;
  liquidityProvidersOf?: (productId: string) => Promise<string[]>; // firms entitled alongside the licence provider
  poolsOf?: (productId: string) => Promise<string[]>; // none until pools exist
  openWithdrawalRequests?: (productId: string, poolId: string | null) => Promise<number>; // the queue's size, for the report
  exitedLiquidityProvider?: (productId: string, entityId: string) => Promise<Date | null>; // when a firm left its last pool of this product
  liquidityProviderBooks?: (productId: string, entityId: string) => Promise<string[]>; // the sponsors whose books a firm may read: those of its own pools
  poolSponsorOf?: (poolId: string) => Promise<string | null>; // whose books a pool's snapshots read
  confidential?: ConfidentialHost | null; // computes snapshots from partners' sealed statements (confidential/)
  now?: () => Date;
}

// Whether `signature` (hex) is the confidential host's health-attester key (base64url) over a snapshot's fingerprint.
export function verifyHealthAttestation(publicKey: string, fingerprint: string, signature: string): boolean {
  try {
    return edVerify(null, healthAttestationMessage(fingerprint), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }), Buffer.from(signature, "hex"));
  } catch {
    return false;
  }
}

export class HealthError extends Error {}

const UNCHOSEN_LEDGER: PartnerLedger = {
  id: "unavailable",
  name: "No ledger could be chosen",
  kind: "sandbox",
  read: async () => ({ error: { code: "ledger_unchosen", message: "Mynt couldn't tell which ledger to read" } }),
};

const unix = (t: string | Date) => Math.floor(new Date(t).getTime() / 1000);
const ERROR_LIMIT = 300;

export const MAX_REANCHOR_REASON = 500;

export interface Anchor {
  subject: string;
  epoch: number;
  reason: string;
  anchored_at: string;
  program_id: string | null;
  prev_verdict: string | null; // matches, mismatch, or gone (the old chain couldn't be read to compare)
  prev_head_sequence: number | null;
  prev_head_chain: string | null;
  mac: string;
  valid: boolean; // the row's MAC checks out: Mynt wrote this
}

interface Subject {
  productId: string;
  poolId: string | null;
  subject: string;
  partner: string;
  live: boolean;
}

export class ProductHealthService {
  private timer: NodeJS.Timeout | null = null;
  // Told after each product's record is brought up to date, so what watches it (covenants.ts) can look at a new snapshot.
  afterAdvance: ((productId: string) => Promise<unknown>) | null = null;
  private constructor(
    private readonly db: Db,
    private readonly store: Store,
    readonly config: ProductHealthConfig,
    private readonly deps: ProductHealthDeps,
  ) {}

  static async open(db: Db, store: Store, config: ProductHealthConfig = productHealthConfigFromEnv(), deps: ProductHealthDeps = {}) {
    await db.exec(TABLES);
    return new ProductHealthService(db, store, config, deps);
  }

  get chain() {
    return this.deps.chain ?? null;
  }
  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }
  // The clock health figures are judged by, for what's compared against them.
  clock() {
    return this.now();
  }

  // ---- keys ----

  // The subject of a product on chain: a keyed hash, so a guessed product id can't be tested against the chain.
  subjectOf(productId: string, poolId: string | null): Uint8Array {
    const key = derivedKey("product-health-subject");
    if (!key) throw new HealthError("Product health needs MYNT_VAULT_KEY set on the server");
    return subjectKey(key, productId, poolId);
  }

  private async dataKey(subject: string): Promise<Buffer> {
    const read = async () => (await this.db.query(`SELECT sealed_key FROM ${T}.product_health_keys WHERE subject = $1`, [subject])).rows[0] as { sealed_key: string } | undefined;
    let row = await read();
    if (!row) {
      await this.db.query(`INSERT INTO ${T}.product_health_keys (subject, sealed_key) VALUES ($1, $2) ON CONFLICT (subject) DO NOTHING`, [subject, seal(randomBytes(32).toString("base64"), false)]);
      row = await read(); // two at once: whichever was stored first is the key
    }
    return Buffer.from(openSealed(row!.sealed_key, false), "base64");
  }

  private keyMac(entityId: string, publicKey: string): string {
    const key = derivedKey("product-health-signing-key-history");
    if (!key) throw new HealthError("Product health needs MYNT_VAULT_KEY set on the server");
    return createHmac("sha256", key).update(`${entityId}\u0000${publicKey}`).digest("hex");
  }

  // The firm's current key, only if it's one Mynt really recorded: a key written straight into the table doesn't count.
  async signingKey(entityId: string): Promise<string | null> {
    const { rows } = await this.db.query(`SELECT public_key FROM ${T}.product_health_signing_keys WHERE entity_id = $1`, [entityId]);
    const key = (rows[0] as { public_key: string } | undefined)?.public_key ?? null;
    return key && (await this.keyHistory(entityId)).has(key) ? key : null;
  }

  private async keyHistory(entityId: string): Promise<Set<string>> {
    const { rows } = await this.db.query(`SELECT public_key, mac FROM ${T}.product_health_signing_key_history WHERE entity_id = $1`, [entityId]);
    return new Set((rows as unknown as { public_key: string; mac: string }[]).filter((r) => r.mac === this.keyMac(entityId, r.public_key)).map((r) => r.public_key));
  }

  // ---- entitlement ----

  private async isActive(entityId: string) {
    return (await this.store.getEntity(entityId))?.status === "active";
  }

  // The firms that may read a product's numbers: its approved licence providers now; its liquidity providers when
  // they exist. Computed each time, so withdrawing a sponsorship, or a firm being suspended, ends access at once.
  async entitledFirms(productId: string): Promise<{ entity_id: string; as: "licence_provider" | "liquidity_provider" }[]> {
    const sponsors = await this.store.sponsorships({ product_id: productId, status: "approved" });
    const lps = this.deps.liquidityProvidersOf ? await this.deps.liquidityProvidersOf(productId) : [];
    const firms: { entity_id: string; as: "licence_provider" | "liquidity_provider" }[] = [];
    for (const entity_id of new Set(sponsors.map((s) => s.provider_entity_id))) if (await this.isActive(entity_id)) firms.push({ entity_id, as: "licence_provider" });
    for (const entity_id of lps) if (!firms.some((f) => f.entity_id === entity_id) && (await this.isActive(entity_id))) firms.push({ entity_id, as: "liquidity_provider" });
    return firms;
  }

  // A named licence-provider role is needed, and an admin account is refused even if it also holds one: Mynt's own
  // staff don't open a firm's books, or sign or replace keys in its name.
  // A liquidity provider that has fully exited keeps what it could already read: snapshots up to `until`, none after.
  async entitlement(user: User, productId: string): Promise<{ entity_id: string; as: string; until?: Date; books?: string[] } | null> {
    const me = (await this.store.getUser(user.id)) ?? user;
    if (!me.entity_id || me.roles.includes("admin")) return null;
    const firms = await this.entitledFirms(productId);
    const hit = firms.find((f) => f.entity_id === me.entity_id);
    const books = this.deps.liquidityProviderBooks ? await this.deps.liquidityProviderBooks(productId, me.entity_id) : undefined;
    if (!hit) {
      const until = (await this.deps.exitedLiquidityProvider?.(productId, me.entity_id)) ?? null;
      return until && me.roles.includes("liquidity_provider") && (await this.isActive(me.entity_id)) ? { entity_id: me.entity_id, as: "liquidity_provider", until, books } : null;
    }
    if (hit.as === "liquidity_provider") return me.roles.includes("liquidity_provider") ? { ...hit, books } : null;
    if (hit.as === "licence_provider" && !me.roles.includes("license_provider")) return null;
    return hit;
  }

  // ---- computing a snapshot ----

  private async subjects(): Promise<Subject[]> {
    const sponsored = await this.store.sponsorships({ status: "approved" });
    const byProduct = new Map<string, typeof sponsored>();
    for (const s of sponsored) byProduct.set(s.product_id, [...(byProduct.get(s.product_id) ?? []), s]);
    const out: Subject[] = [];
    for (const [productId, list] of byProduct) {
      const record = await this.store.getProduct(productId);
      if (!record || record.status === "unpublished") continue;
      // The earliest-approved licence provider still in good standing supplies the books and the key.
      const ordered = [...list].sort((a, b) => new Date(a.decided_at ?? 0).getTime() - new Date(b.decided_at ?? 0).getTime() || a.id.localeCompare(b.id));
      let partner: string | null = null;
      for (const s of ordered) {
        if (await this.isActive(s.provider_entity_id)) {
          partner = s.provider_entity_id;
          break;
        }
      }
      if (!partner) continue;
      const pools = this.deps.poolsOf ? await this.deps.poolsOf(productId) : [];
      for (const poolId of [null, ...pools]) {
        // A pool reads its own sponsor's books, when that sponsor is still in good standing on this product.
        const own = poolId && this.deps.poolSponsorOf ? await this.deps.poolSponsorOf(poolId) : null;
        const books = own && list.some((s) => s.provider_entity_id === own) && (await this.isActive(own)) ? own : partner;
        out.push({ productId, poolId, subject: hexOf(this.subjectOf(productId, poolId)), partner: books, live: record.status === "published" });
      }
    }
    return out;
  }

  private anchorMac(a: Pick<Anchor, "subject" | "epoch" | "reason" | "program_id" | "prev_verdict" | "prev_head_sequence" | "prev_head_chain">): string {
    const key = derivedKey("product-health-anchors");
    if (!key) throw new HealthError("Product health needs MYNT_VAULT_KEY set on the server");
    return createHmac("sha256", key)
      .update(canonicalJson({ subject: a.subject, epoch: a.epoch, reason: a.reason, program_id: a.program_id, prev_verdict: a.prev_verdict, prev_head_sequence: a.prev_head_sequence, prev_head_chain: a.prev_head_chain }))
      .digest("hex");
  }

  // The newest record. A row with a bad MAC still counts here, so it shows as a mismatch and a gap rather than quietly
  // moving the record back to an earlier epoch.
  private async currentEpoch(subject: string): Promise<number> {
    const { rows } = await this.db.query(`SELECT COALESCE(MAX(epoch), 0)::int AS epoch FROM ${T}.product_health_anchors WHERE subject = $1`, [subject]);
    return (rows[0] as { epoch: number }).epoch;
  }

  private async lastRow(subject: string): Promise<SnapshotRow | undefined> {
    const { rows } = await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE subject = $1 ORDER BY epoch DESC, sequence DESC LIMIT 1`, [subject]);
    return rows[0] as unknown as SnapshotRow | undefined;
  }

  private async insertMissed(s: Subject, epoch: number, start: Date, end: Date, reason: string, sequence: number) {
    // The epoch is read again where the row is written: a re-anchor in between makes this a no-op, and the next tick retries.
    await this.db.query(
      `INSERT INTO ${T}.product_health_snapshots (id, subject, epoch, product_id, pool_id, sequence, period_start, period_end, status, source, partner_entity_id, missed_reason, publish_deadline)
       SELECT $1::uuid, $2::text, $3::int, $4::text, $5::text, $6::int, $7::timestamptz, $8::timestamptz, 'missed', 'unavailable', $9::uuid, $10::text, $11::timestamptz
       WHERE $3::int = (SELECT COALESCE(MAX(epoch), 0) FROM ${T}.product_health_anchors WHERE subject = $2::text) ON CONFLICT DO NOTHING`,
      [randomUUID(), s.subject, epoch, s.productId, s.poolId ?? "", sequence, start, end, s.partner, reason, end],
    );
  }

  private async flows(s: Subject, start: Date, end: Date, source: HealthReport["source"]): Promise<AdaptedFlows> {
    // The rails leave out sandbox movements, so a sandbox report showing them would put real money beside test figures.
    if (source === "sandbox") return { flows: null, reason: "Sandbox ledger: real money flows aren't shown beside test figures", not_measured: {}, partial: NOT_PARTIAL };
    if (!this.deps.flowsFor) return { flows: null, reason: FLOWS_UNAVAILABLE, not_measured: {}, partial: NOT_PARTIAL };
    try {
      return adaptRailFlows(await this.deps.flowsFor(s.productId, start, end));
    } catch (e) {
      console.error("product health: the money rails failed:", (e as Error).message);
      return { flows: null, reason: "The money rails failed to answer for this period", not_measured: {}, partial: NOT_PARTIAL };
    }
  }

  // Builds one snapshot for a period, sealed and ready to go. Never throws for a figure it can't get.
  private async compute(s: Subject, start: Date, end: Date, sequence: number): Promise<{ report: HealthReport; fingerprint: string; sealed: string; enclave: { key: string; signature: string } | null }> {
    const ledger = await this.ledgerOf(s.partner);
    let reading = await ledger
      .read({ product_id: s.productId, pool_id: s.poolId, provider_entity_id: s.partner, period_end: end.toISOString(), now: () => this.now() })
      .catch(() => ({ error: { code: "ledger_error", message: "The ledger call failed" } }));
    // A statement sealed to the confidential service: computed there, and only that product's figures come back.
    if (isSealedReading(reading)) {
      if (this.deps.confidential && ledger.kind === "live") return this.computeSealed(s, start, end, sequence, ledger, reading);
      reading = { error: { code: "no_confidential_host", message: "The partner sealed its statement, and this Mynt has no confidential host to open it" } };
    }
    const failed = isLedgerError(reading);
    // partner_ledger only ever means a ledger that says it's live; anything else counts as sandbox.
    const source: HealthReport["source"] = failed ? "unavailable" : ledger.kind === "live" ? "partner_ledger" : "sandbox";
    const flows = await this.flows(s, start, end, source);
    const withdrawals = this.deps.openWithdrawalRequests ? await this.deps.openWithdrawalRequests(s.productId, s.poolId).catch(() => null) : null;
    const figures = buildFigures({ reading, flows: flows.flows, flowsReason: flows.reason, partial: flows.partial, withdrawals });
    const report: HealthReport = {
      schema: SCHEMA,
      product_id: s.productId,
      pool_id: s.poolId,
      sequence,
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      computed_at: this.now().toISOString(),
      salt: randomBytes(32).toString("hex"),
      source,
      // Sandbox figures are never live, whatever the product's status.
      live: s.live && source === "partner_ledger",
      partner: { entity_id: s.partner, ledger: ledger.id, ledger_name: ledger.name },
      ledger_as_of: failed ? null : (reading as PartnerLedgerReading).as_of,
      flows_basis: FLOWS_BASIS,
      flows_not_measured: flows.not_measured,
      figures,
      notes: source === "sandbox" ? ["Sandbox ledger: test figures, not real money."] : [],
    };
    const canonical = canonicalJson(report);
    const fingerprint = fingerprintOf(canonical);
    const sealed = sealReport(await this.dataKey(s.subject), canonical, s.subject, sequence, fingerprint);
    return { report, fingerprint, sealed, enclave: null };
  }

  // The confidential host opens the partner's statement, checks it against the firm's registered key, computes the
  // report exactly as compute() would, and signs its fingerprint with its health-attester key. The signature is kept
  // with the snapshot, so anyone holding the host's attested public key can check the figures came from there.
  private async computeSealed(s: Subject, start: Date, end: Date, sequence: number, ledger: PartnerLedger, reading: SealedLedgerReading) {
    const flows = await this.flows(s, start, end, "partner_ledger");
    const withdrawals = this.deps.openWithdrawalRequests ? await this.deps.openWithdrawalRequests(s.productId, s.poolId).catch(() => null) : null;
    const r = await this.deps.confidential!.computeHealth({
      envelope: reading.sealed.envelope,
      expect: reading.sealed.expect,
      now: this.now().toISOString(),
      report: {
        schema: SCHEMA,
        product_id: s.productId,
        pool_id: s.poolId,
        sequence,
        period_start: start.toISOString(),
        period_end: end.toISOString(),
        computed_at: this.now().toISOString(),
        live: s.live,
        partner: { entity_id: s.partner, ledger: ledger.id, ledger_name: ledger.name },
      },
      flows,
      withdrawals,
      host: this.deps.confidential!.kind,
    });
    // Never taken on trust: the fingerprint is recomputed from the report, and the signature checked, here.
    const canonical = canonicalJson(r.report);
    const fingerprint = fingerprintOf(canonical);
    if (fingerprint !== r.fingerprint || canonical !== r.canonical) throw new HealthError("The confidential host's report doesn't match its fingerprint");
    if (r.report.product_id !== s.productId || r.report.sequence !== sequence || r.report.period_end !== end.toISOString()) throw new HealthError("The confidential host answered for another snapshot");
    const attester = await this.deps.confidential!.publicKey(HEALTH_ATTESTER_KEY);
    if (r.attestation.public_key !== attester || !verifyHealthAttestation(attester, fingerprint, r.attestation.signature)) throw new HealthError("The confidential host's signature doesn't verify");
    const sealed = sealReport(await this.dataKey(s.subject), canonical, s.subject, sequence, fingerprint);
    return { report: r.report, fingerprint, sealed, enclave: { key: attester, signature: r.attestation.signature } };
  }

  // Brings one product's record up to the last complete period. A stretch Mynt didn't cover is one missed record, and
  // every record starts where the last ended, whatever the interval was or has become.
  private async advance(s: Subject, now: Date) {
    const interval = this.config.intervalMs;
    const lastEnd = new Date(Math.floor(now.getTime() / interval) * interval);
    let periodStart = new Date(lastEnd.getTime() - interval);
    const last = await this.lastRow(s.subject);
    if (last && new Date(last.period_end).getTime() >= lastEnd.getTime()) return;
    // The first record names the program it's on, so a later change of program can be told from anything else.
    const programId = this.chain?.programId ?? this.config.programId;
    await this.db.query(`INSERT INTO ${T}.product_health_anchors (subject, epoch, reason, program_id, mac) VALUES ($1, 0, 'first record', $2, $3) ON CONFLICT DO NOTHING`, [
      s.subject,
      programId,
      this.anchorMac({ subject: s.subject, epoch: 0, reason: "first record", program_id: programId, prev_verdict: null, prev_head_sequence: null, prev_head_chain: null }),
    ]);
    const epoch = await this.currentEpoch(s.subject);
    let sequence = last && last.epoch === epoch ? last.sequence + 1 : 1;
    if (last) {
      const previous = new Date(last.period_end);
      if (previous.getTime() < periodStart.getTime()) {
        await this.insertMissed(s, epoch, previous, periodStart, "Mynt computed no snapshot for this period", sequence);
        sequence++;
      } else periodStart = previous;
    }
    let result: Awaited<ReturnType<ProductHealthService["compute"]>>;
    try {
      result = await this.compute(s, periodStart, lastEnd, sequence);
    } catch (e) {
      await this.insertMissed(s, epoch, periodStart, lastEnd, `The snapshot couldn't be computed: ${(e as Error).message.slice(0, ERROR_LIMIT)}`, sequence);
      return;
    }
    const key = await this.signingKey(s.partner);
    const signDeadline = key ? new Date(now.getTime() + this.config.cosignWindowMs) : null;
    const publishDeadline = new Date(lastEnd.getTime() + interval);
    await this.db.query(
      `INSERT INTO ${T}.product_health_snapshots
        (id, subject, epoch, product_id, pool_id, sequence, period_start, period_end, status, source, live, partner_entity_id, fingerprint, report_sealed, attestation, sign_deadline, publish_deadline, enclave_key, enclave_signature)
       SELECT $1::uuid, $2::text, $3::int, $4::text, $5::text, $6::int, $7::timestamptz, $8::timestamptz, $9::text, $10::text, $11::boolean, $12::uuid, $13::text, $14::text, 'mynt_only', $15::timestamptz, $16::timestamptz, $17::text, $18::text
       WHERE $3::int = (SELECT COALESCE(MAX(epoch), 0) FROM ${T}.product_health_anchors WHERE subject = $2::text) ON CONFLICT DO NOTHING`,
      [randomUUID(), s.subject, epoch, s.productId, s.poolId ?? "", sequence, periodStart, lastEnd, key ? "pending_signature" : "ready", result.report.source, result.report.live, s.partner, result.fingerprint, result.sealed, signDeadline, publishDeadline, result.enclave?.key ?? null, result.enclave?.signature ?? null],
    );
  }

  // ---- publishing ----

  private commitmentOf(r: SnapshotRow): Uint8Array {
    if (!r.partner_key || !r.partner_signature) return ZERO_32;
    return partnerCommitment(hexToBytes(r.subject), base58Decode(r.partner_key), hexToBytes(r.partner_signature));
  }

  private entry(r: SnapshotRow): SnapshotEntry {
    const commitment = this.commitmentOf(r);
    return {
      sequence: r.sequence,
      fingerprint: hexToBytes(r.fingerprint!),
      period_start: unix(r.period_start),
      period_end: unix(r.period_end),
      source: r.source as SnapshotEntry["source"],
      partner_commitment: commitment === ZERO_32 ? null : commitment,
    };
  }

  // Everything a record puts on chain, as Mynt's row says it. A row changed afterwards won't reproduce the chain.
  private linkOf(r: SnapshotRow): ChainLink {
    const missed = r.status === "missed";
    return {
      subject: hexToBytes(r.subject),
      sequence: r.sequence,
      fingerprint: missed ? ZERO_32 : hexToBytes(r.fingerprint ?? ""),
      period_start: unix(r.period_start),
      period_end: unix(r.period_end),
      kind: missed ? KIND_MISSED : KIND_SNAPSHOT,
      source: missed ? SOURCE_FLAG.unavailable : (SOURCE_FLAG[r.source as keyof typeof SOURCE_FLAG] ?? 255),
      partner_commitment: missed ? ZERO_32 : this.commitmentOf(r),
    };
  }

  private backoff(attempts: number) {
    return Math.min(this.config.intervalMs, 30_000 * 2 ** Math.min(attempts, 8));
  }

  private async failPublish(r: SnapshotRow, e: unknown, now: Date) {
    const error = (e as Error).message.slice(0, ERROR_LIMIT);
    await this.db.query(`UPDATE ${T}.product_health_snapshots SET attempts = attempts + 1, last_error = $2, next_attempt_at = $3 WHERE id = $1`, [r.id, error, new Date(now.getTime() + this.backoff(r.attempts))]);
  }

  // The chain disagrees with Mynt's record in a way retrying can't fix: shown to admins, who can re-anchor.
  private async stall(r: SnapshotRow, reason: string, now: Date) {
    await this.db.query(`UPDATE ${T}.product_health_snapshots SET stalled_reason = $2, next_attempt_at = $3 WHERE id = $1`, [r.id, reason.slice(0, ERROR_LIMIT), new Date(now.getTime() + this.config.intervalMs)]);
  }

  private async rowById(id: string): Promise<SnapshotRow | undefined> {
    return (await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE id = $1`, [id])).rows[0] as unknown as SnapshotRow | undefined;
  }

  private async markLanded(r: SnapshotRow, published: boolean, tx: string | null, now: Date) {
    await this.db.query(
      `UPDATE ${T}.product_health_snapshots SET status = CASE WHEN $2 THEN 'published' ELSE status END, on_chain = true, tx_signature = COALESCE($3, tx_signature), published_at = $4, last_error = NULL, stalled_reason = NULL, missed_reason = CASE WHEN $2 THEN NULL ELSE missed_reason END WHERE id = $1`,
      [r.id, published, tx, now],
    );
  }

  // One row toward the chain. Returns whether the next row of this product may go.
  private async publishRow(start: SnapshotRow, now: Date): Promise<boolean> {
    const chain = this.chain;
    if (!chain) return false;
    let r = start;
    if (r.status === "pending_signature") {
      if (new Date(r.sign_deadline!) > now) return false;
      // Whichever wins, the row returned is the row that goes: a co-signature that just landed is never lost.
      const flipped = (await this.db.query(`UPDATE ${T}.product_health_snapshots SET status = 'ready' WHERE id = $1 AND status = 'pending_signature' RETURNING *`, [r.id])).rows[0] as unknown as SnapshotRow | undefined;
      const current = flipped ?? (await this.rowById(r.id));
      if (!current) return false;
      r = current;
    }
    if (r.next_attempt_at && new Date(r.next_attempt_at) > now) return false;
    const subject = hexToBytes(r.subject);
    let head: HeadAccount | null;
    try {
      head = await chain.head(subject);
    } catch (e) {
      // Can't see the chain, so nothing can be concluded about this row: it isn't marked missed until Mynt can look.
      await this.failPublish(r, e, now);
      return false;
    }
    try {
      const at = head?.sequence ?? 0;
      if (at >= r.sequence) {
        // Already there (a confirmation Mynt never saw): adopted, whatever its deadline said, with its transaction.
        const landedTx = async () => {
          if (!chain.latestRecordTx) return null;
          // Only a transaction that really is this record: the instruction's subject, sequence and (for a snapshot) fingerprint, in order.
          const seq = Buffer.alloc(8);
          seq.writeBigUInt64LE(BigInt(r.sequence));
          const expected = Uint8Array.from(Buffer.concat([Buffer.from(subject), seq, ...(head?.kind === KIND_SNAPSHOT ? [Buffer.from(head.fingerprint)] : [])]));
          return chain.latestRecordTx(subject, expected).catch(() => null);
        };
        if (at === r.sequence && head && r.fingerprint && head.kind === KIND_SNAPSHOT && same(head.fingerprint, hexToBytes(r.fingerprint))) {
          await this.markLanded(r, true, await landedTx(), now);
          return true;
        }
        if (at === r.sequence && head && r.status === "missed" && head.kind === KIND_MISSED) {
          await this.markLanded(r, false, await landedTx(), now);
          return true;
        }
        await this.stall(r, `The chain's head is at sequence ${at} and doesn't match this record. Re-anchoring doesn't apply while the chain holds a record: this needs investigating`, now);
        return false;
      }
      if (at !== r.sequence - 1) {
        await this.stall(
          r,
          head
            ? `The chain's head is at sequence ${at}, not the one before ${r.sequence}. Re-anchoring doesn't apply while the chain holds a record: this needs investigating`
            : `The chain has no record at sequence ${r.sequence - 1} (a chain reset or a new program); an admin can re-anchor it (reanchor_product_health)`,
          now,
        );
        return false;
      }
      if (r.status === "ready" && r.publish_deadline && new Date(r.publish_deadline) <= now) {
        const reason = `Couldn't publish before the deadline: ${r.last_error ?? "it was never sent"}`.slice(0, ERROR_LIMIT);
        const flipped = (await this.db.query(`UPDATE ${T}.product_health_snapshots SET status = 'missed', missed_reason = $2 WHERE id = $1 AND status = 'ready' RETURNING *`, [r.id, reason])).rows[0] as unknown as SnapshotRow | undefined;
        if (!flipped) return false;
        r = flipped;
      }
      const opening = head === null;
      const missed = r.status === "missed";
      const tx = missed
        ? await chain.publishMissed(subject, { sequence: r.sequence, period_start: unix(r.period_start), period_end: unix(r.period_end), reason: 0 }, opening)
        : await chain.publishSnapshot(subject, this.entry(r), opening);
      await this.markLanded(r, !missed, tx, now);
      return true;
    } catch (e) {
      await this.failPublish(r, e, now);
      return false;
    }
  }

  private async publishDue(now: Date) {
    if (!this.chain) return;
    const { rows } = await this.db.query(
      `SELECT s.id, s.subject FROM ${T}.product_health_snapshots s
       WHERE (s.status IN ('pending_signature', 'ready') OR (s.status = 'missed' AND NOT s.on_chain))
         AND s.epoch = (SELECT COALESCE(MAX(a.epoch), 0) FROM ${T}.product_health_anchors a WHERE a.subject = s.subject)
       ORDER BY s.subject, s.sequence`,
    );
    const bySubject = new Map<string, string[]>();
    for (const r of rows as unknown as { id: string; subject: string }[]) bySubject.set(r.subject, [...(bySubject.get(r.subject) ?? []), r.id]);
    for (const ids of bySubject.values()) {
      for (const id of ids) {
        const r = await this.rowById(id); // as it is now: a co-signature may have landed since the list was read
        if (!r || !(await this.publishRow(r, now))) break;
      }
    }
  }

  // One round: bring every product's record up to date, then send what's due. Safe to run at any time.
  async tick() {
    const now = this.now();
    if (!vaultAvailable(false)) return;
    await this.db.query(`INSERT INTO ${T}.product_health_worker (id, last_tick_at) VALUES ('worker', $1) ON CONFLICT (id) DO UPDATE SET last_tick_at = EXCLUDED.last_tick_at`, [now]);
    // Firms in parallel, each firm's products in turn: a partner's ledger is read once per firm per round (partner-kit.ts),
    // so a slow or unreachable partner holds up its own products only, for at most its request's time limit.
    const byFirm = new Map<string, Subject[]>();
    for (const s of await this.subjects()) byFirm.set(s.partner, [...(byFirm.get(s.partner) ?? []), s]);
    await Promise.all(
      [...byFirm.values()].map(async (subjects) => {
        for (const s of subjects) {
          await this.advance(s, now).catch((e) => console.error("product health:", s.productId, (e as Error).message));
          if (!s.poolId && this.afterAdvance) await this.afterAdvance(s.productId).catch((e) => console.error("product health:", s.productId, (e as Error).message));
        }
      }),
    );
    await this.publishDue(now);
  }

  startWorker() {
    if (!this.config.programId || !this.chain) {
      console.error("product health: not running (set PRODUCT_HEALTH_PROGRAM_ID to the deployed program, and keep MYNT_VAULT_KEY set)");
      return;
    }
    this.timer = serialLoop(() => this.tick(), this.config.pollMs, "product health");
  }
  stopWorker() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- co-signing ----

  // Who may register a firm's live key, and whether the key may be one: refused for anyone but the firm's own active,
  // non-admin licence-provider member, for a weak key, and for any key ever registered as a test key (partner-kit.ts).
  // The partner kit's tool adds its own gates (the member cool-off, a second member's approval) before registering.
  async checkSigningKey(user: User, publicKey: string): Promise<string> {
    const me = (await this.store.getUser(user.id)) ?? user;
    if (!me.entity_id) throw new HealthError("You don't belong to a firm yet");
    if (!me.roles.includes("license_provider") || me.roles.includes("admin")) throw new HealthError("Only a licence provider firm's own member registers a signing key");
    if (!(await this.isActive(me.entity_id))) throw new HealthError("Your firm isn't active");
    // The role alone isn't enough: the account needs licence-provider standing at its firm (firm-notices.ts).
    const { rows: standing } = await this.db.query(`SELECT lp_since FROM ${T}.users WHERE id = $1`, [me.id]);
    if (!standing[0]?.lp_since) throw new HealthError("You have no licence-provider standing at this firm yet: one of its existing licence providers accepts you first (decide_firm_member)");
    if (!isAddress(publicKey) || isWeakEd25519Key(base58Decode(publicKey))) throw new HealthError("public_key must be a usable Ed25519 public key, base58 (a Solana-style address)");
    // A key ever used to sign test books, by any firm, is never a live key.
    const { rows: testKey } = await this.db.query(`SELECT 1 FROM ${T}.partner_test_signing_key_history WHERE public_key = $1 UNION SELECT 1 FROM ${T}.partner_test_signing_keys WHERE public_key = $1`, [publicKey]);
    if (testKey.length) throw new HealthError("That key has been registered as a test signing key: the live key must be a different key");
    return me.entity_id;
  }

  async registerSigningKey(user: User, publicKey: string) {
    const entityId = await this.checkSigningKey(user, publicKey);
    return this.registerSigningKeyFor(entityId, publicKey, user.id);
  }

  // Records the firm's live key (after the checks above, and any approval the partner kit needed).
  async registerSigningKeyFor(entityId: string, publicKey: string, registeredBy: string, approvedBy: string | null = null, tx: Pick<Db, "query"> = this.db) {
    await tx.query(
      `INSERT INTO ${T}.product_health_signing_keys (entity_id, public_key, registered_by) VALUES ($1, $2, $3)
       ON CONFLICT (entity_id) DO UPDATE SET public_key = EXCLUDED.public_key, registered_by = EXCLUDED.registered_by, registered_at = now()`,
      [entityId, publicKey, registeredBy],
    );
    // Earlier snapshots stay checkable against the key that signed them.
    await tx.query(
      `INSERT INTO ${T}.product_health_signing_key_history (entity_id, public_key, registered_by, mac) VALUES ($1, $2, $3, $4) ON CONFLICT (entity_id, public_key) DO UPDATE SET mac = EXCLUDED.mac`,
      [entityId, publicKey, registeredBy, this.keyMac(entityId, publicKey)],
    );
    // Audited on its own connection only outside a caller's transaction (which audits once it commits).
    if (tx === this.db) await this.store.audit(registeredBy, "register_partner_signing_key", entityId, { public_key: publicKey, ...(approvedBy ? { approved_by: approvedBy } : {}) });
    return { entity_id: entityId, public_key: publicKey, sign: "with Ed25519, the UTF-8 text 'mynt.product_health.cosign.v1', one zero byte, then the 32 bytes of the snapshot's fingerprint (sha256, hex in list_product_health)" };
  }

  // When the firm's current live key was registered (the partner kit keys its cached reads by it), or null.
  async signingKeyRegisteredAt(entityId: string): Promise<string | null> {
    const { rows } = await this.db.query(`SELECT registered_at FROM ${T}.product_health_signing_keys WHERE entity_id = $1`, [entityId]);
    return rows[0] ? new Date(rows[0].registered_at as string).toISOString() : null;
  }

  // A partner's co-signature over one snapshot. Refused unless the firm still sponsors the product, the window is
  // open, and it verifies with the firm's registered key.
  async submitSignature(user: User, productId: string, poolId: string | null, sequence: number, signature: string) {
    const me = (await this.store.getUser(user.id)) ?? user;
    const subject = hexOf(this.subjectOf(productId, poolId));
    const epoch = await this.currentEpoch(subject);
    const r = (await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE subject = $1 AND epoch = $2 AND sequence = $3`, [subject, epoch, sequence])).rows[0] as unknown as SnapshotRow | undefined;
    if (!r) throw new HealthError(`No snapshot ${sequence} for that product`);
    const firm = await this.entitlement(user, productId);
    if (!me.entity_id || !firm || firm.as !== "licence_provider" || r.partner_entity_id !== me.entity_id) throw new HealthError("Only the licence provider this snapshot's numbers came from, while it still sponsors the product, can co-sign it");
    if (r.status !== "pending_signature") throw new HealthError(`Snapshot ${sequence} is ${r.status}: it can only be co-signed while it waits for a signature`);
    const now = this.now();
    if (!r.sign_deadline || new Date(r.sign_deadline) <= now) throw new HealthError(`The co-signing window for snapshot ${sequence} has closed`);
    const key = await this.signingKey(me.entity_id);
    if (!key) throw new HealthError("Your firm has no registered signing key: use register_partner_signing_key");
    const bytes = /^[0-9a-fA-F]{128}$/.test(signature) ? hexToBytes(signature) : (() => { try { return base58Decode(signature); } catch { return new Uint8Array(0); } })();
    if (!verifyEd25519(key, cosignMessage(hexToBytes(r.fingerprint!)), bytes)) {
      await this.store.audit(user.id, "submit_partner_signature_refused", productId, { sequence, reason: "signature doesn't verify" });
      throw new HealthError("That signature doesn't verify over this snapshot's fingerprint with your firm's registered key");
    }
    const { rows } = await this.db.query(
      `UPDATE ${T}.product_health_snapshots SET status = 'ready', attestation = 'partner_signed', partner_key = $2, partner_signature = $3
       WHERE id = $1 AND status = 'pending_signature' AND sign_deadline > $4 RETURNING id`,
      [r.id, key, hexOf(bytes), now],
    );
    if (!rows.length) throw new HealthError(`Snapshot ${sequence} is no longer waiting for a signature`);
    await this.store.audit(user.id, "submit_partner_signature", productId, { sequence, fingerprint: r.fingerprint });
    return { product_id: productId, sequence, status: "ready", attestation: "partner_signed" };
  }

  // ---- reading ----

  private async rows(subject: string) {
    return (await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE subject = $1 ORDER BY epoch, sequence`, [subject])).rows as unknown as SnapshotRow[];
  }

  private async headOf(subject: Uint8Array): Promise<{ head: HeadAccount | null; error: string | null }> {
    if (!this.chain) return { head: null, error: "The product-health program isn't deployed on this Mynt yet" };
    try {
      return { head: await this.chain.head(subject), error: null };
    } catch (e) {
      return { head: null, error: (e as Error).message.slice(0, ERROR_LIMIT) };
    }
  }

  private replayTo(rows: SnapshotRow[], upto: number): Uint8Array {
    let chain: Uint8Array = ZERO_32;
    for (const r of rows.filter((x) => x.on_chain && x.sequence <= upto)) chain = nextChain(chain, this.linkOf(r));
    return chain;
  }

  // What an earlier record's rows say now, against what was saved when it ended: a record that didn't match then, or
  // has been changed since, doesn't read as if it did.
  private previousVerdict(rows: SnapshotRow[], a: Anchor | undefined): string {
    if (a && !a.valid) return "previous_chain_mismatch";
    if (!a || a.prev_verdict === "gone" || !a.prev_head_chain || a.prev_head_sequence === null) return "previous_chain_unverifiable";
    if (a.prev_verdict !== "matches") return "previous_chain_mismatch";
    return hexOf(this.replayTo(rows, a.prev_head_sequence)) === a.prev_head_chain ? "previous_chain_matched" : "previous_chain_mismatch";
  }

  // Replays the chain from Mynt's own rows and compares it to the head: any change to history shows. Earlier epochs are
  // judged against what was saved when they ended.
  verifyAgainstChain(rows: SnapshotRow[], head: HeadAccount | null, chainError: string | null, epoch: number, anchors: Anchor[] = []) {
    const verdict = new Map<string, string>();
    for (const r of rows) verdict.set(r.id, r.on_chain ? "pending" : "not_on_chain");
    for (const e of new Set(rows.filter((r) => r.epoch !== epoch).map((r) => r.epoch))) {
      const old = rows.filter((r) => r.epoch === e);
      const anchor = anchors.find((a) => a.epoch === e + 1);
      // A record that was replaced always has the anchor that replaced it. None means it was removed.
      const v = !anchor ? "previous_chain_mismatch" : this.previousVerdict(old, anchor);
      for (const r of old) if (r.on_chain) verdict.set(r.id, v);
    }
    const current = rows.filter((r) => r.epoch === epoch);
    const ours = current.filter((r) => r.on_chain);
    if (chainError) {
      for (const r of ours) verdict.set(r.id, "unavailable");
      return { verdict, ok: false };
    }
    let chain: Uint8Array = ZERO_32;
    let expected = 1;
    let continuous = true;
    const upto = head?.sequence ?? 0;
    for (const r of ours) {
      if (r.sequence > upto) break;
      if (r.sequence !== expected++) continuous = false;
      chain = nextChain(chain, this.linkOf(r));
    }
    const lastOurs = ours[ours.length - 1];
    // The head's own fields, against the record the replay ended on.
    const flagsMatch = (r: SnapshotRow | undefined) => {
      if (!head || !r) return !head && !r;
      const l = this.linkOf(r);
      return head.source === l.source && head.kind === l.kind && head.partner_signed === !same(l.partner_commitment, ZERO_32) && same(head.fingerprint, l.fingerprint) && same(head.partner_commitment, l.partner_commitment);
    };
    const ok = !!head && continuous && expected - 1 === head.sequence && lastOurs?.sequence === head.sequence && same(chain, head.chain) && flagsMatch(lastOurs);
    // One ahead, and it's our next row: that transaction landed and this Mynt hasn't recorded it yet. Not tampering.
    const next = head ? current.find((r) => r.sequence === head.sequence && !r.on_chain) : undefined;
    const landing = !!head && !ok && continuous && head.sequence === (lastOurs?.sequence ?? 0) + 1 && !!next && same(nextChain(chain, this.linkOf(next)), head.chain);
    for (const r of ours) verdict.set(r.id, (ok || landing) && r.sequence <= upto ? "matches" : "mismatch");
    if (landing) verdict.set(next!.id, "pending");
    return { verdict, ok: ok || landing, landing };
  }

  // What Mynt can establish about each stored snapshot, from what's authenticated rather than from stored flags.
  private async assess(all: SnapshotRow[], subject: string, verdict: Map<string, string>): Promise<Map<string, Assessment>> {
    const key = await this.dataKey(subject);
    const histories = new Map<string, Set<string>>();
    const out = new Map<string, Assessment>();
    for (const r of all) {
      let report: HealthReport | null = null;
      let reportMatches: boolean | null = null;
      if (r.status !== "missed" && r.report_sealed && r.fingerprint) {
        try {
          const text = openReport(key, r.report_sealed, r.subject, r.sequence, r.fingerprint);
          reportMatches = fingerprintOf(text) === r.fingerprint;
          report = reportMatches ? (JSON.parse(text) as HealthReport) : null;
        } catch {
          reportMatches = false;
        }
      }
      let signatureOk: boolean | null = null;
      if (r.partner_signature) {
        const entity = r.partner_entity_id ?? "";
        if (!histories.has(entity)) histories.set(entity, entity ? await this.keyHistory(entity) : new Set());
        signatureOk = !!r.partner_key && !!r.fingerprint && histories.get(entity)!.has(r.partner_key) && verifyEd25519(r.partner_key, cosignMessage(hexToBytes(r.fingerprint)), hexToBytes(r.partner_signature));
      }
      out.set(r.id, {
        report,
        report_matches: reportMatches,
        source: r.status === "missed" ? "unavailable" : (report?.source ?? "unknown"),
        live: report?.live === true && report.source === "partner_ledger",
        attestation: r.status === "missed" ? null : r.partner_signature ? (signatureOk ? "partner_signed" : "invalid_signature") : "mynt_only",
        signature_ok: signatureOk,
        on_chain: verdict.get(r.id) ?? "not_on_chain",
        enclave_signature_ok: r.enclave_signature && r.enclave_key && r.fingerprint ? verifyHealthAttestation(r.enclave_key, r.fingerprint, r.enclave_signature) : null,
      });
    }
    return out;
  }

  private async anchors(subject: string): Promise<Anchor[]> {
    const rows = (await this.db.query(`SELECT * FROM ${T}.product_health_anchors WHERE subject = $1 ORDER BY epoch`, [subject])).rows as unknown as Anchor[];
    return rows.map((a) => ({ ...a, valid: a.mac === this.anchorMac(a) }));
  }

  private async gapsOf(all: SnapshotRow[], anchors: Anchor[], epoch: number, head: HeadAccount | null, error: string | null): Promise<Gap[]> {
    const gaps: Gap[] = anchors
      .filter((a) => a.epoch > 0)
      .map((a) => ({ kind: "re_anchored", from: iso(a.anchored_at), detail: `An admin started this product's on-chain record again (epoch ${a.epoch}): ${a.reason}. The record before it: ${a.prev_verdict ?? "unknown"}${a.prev_head_sequence === null ? "" : `, head at sequence ${a.prev_head_sequence}`}` }));
    for (const a of anchors.filter((x) => !x.valid)) gaps.push({ kind: "stalled", detail: `The stored record of epoch ${a.epoch}'s anchor failed its integrity check: it was changed outside Mynt` });
    // Holes in earlier records stay visible; only the current one is compared with the chain or can be overdue.
    for (const e of new Set(all.filter((r) => r.epoch !== epoch).map((r) => r.epoch))) gaps.push(...findGaps(all.filter((r) => r.epoch === e), null, this.now(), this.config.intervalMs, false).filter((g) => g.kind !== "overdue"));
    gaps.push(...findGaps(all.filter((r) => r.epoch === epoch), head, this.now(), this.config.intervalMs, !error));
    if (!all.length) gaps.push({ kind: "no_record", detail: "This sponsored product has no health record yet" });
    return gaps;
  }

  // What anyone allowed to see a product's record gets: fingerprints and status, no numbers.
  async listFor(user: User, productId: string | undefined, limit: number) {
    const me = (await this.store.getUser(user.id)) ?? user;
    const admin = me.roles.includes("admin");
    const { rows } = await this.db.query(`SELECT DISTINCT subject, product_id, pool_id FROM ${T}.product_health_snapshots`);
    // A sponsored product with no record at all is itself something to see.
    const known = new Map((rows as unknown as { subject: string; product_id: string; pool_id: string }[]).map((r) => [r.subject, r]));
    for (const s of await this.subjects()) if (!known.has(s.subject)) known.set(s.subject, { subject: s.subject, product_id: s.productId, pool_id: s.poolId ?? "" });
    const out = [];
    for (const row of known.values()) {
      if (productId && row.product_id !== productId) continue;
      let until: Date | undefined;
      let books: string[] | undefined;
      if (!admin) {
        const record = await this.store.getProduct(row.product_id);
        const own = !!me.entity_id && record?.entity_id === me.entity_id;
        const firm = own ? null : await this.entitlement(user, row.product_id);
        if (!own && !firm) continue;
        until = firm?.until;
        books = firm?.as === "liquidity_provider" ? firm.books : undefined;
      }
      const all = await this.rows(row.subject);
      // The chain is compared against everything; what a firm that left, or a firm in another sponsor's pool, is shown isn't.
      const shown = all.filter((r) => (!until || new Date(r.period_end) <= until) && (!books || (!!r.partner_entity_id && books.includes(r.partner_entity_id))));
      const { head, error } = await this.headOf(hexToBytes(row.subject));
      const epoch = await this.currentEpoch(row.subject);
      const anchors = await this.anchors(row.subject);
      const { verdict } = this.verifyAgainstChain(all, head, error, epoch, anchors);
      const assessed = await this.assess(shown.slice(-limit), row.subject, verdict);
      const gaps = until ? [] : await this.gapsOf(all, anchors, epoch, head, error);
      out.push({
        product_id: row.product_id,
        pool_id: row.pool_id || null,
        chain: error ? { status: "unavailable", detail: error } : head ? { status: "ok", head_sequence: head.sequence } : { status: "no_record_yet" },
        gaps,
        snapshots: shown.slice(-limit).reverse().map((r) => snapshotStatus(r, assessed.get(r.id)!)),
      });
    }
    return out;
  }

  async get(user: User, productId: string, poolId: string | null, limit: number) {
    const firm = await this.entitlement(user, productId);
    if (!firm) {
      await this.store.audit(user.id, "get_product_health_refused", productId, {});
      throw new HealthError("You aren't entitled to this product's numbers: only its licence provider and liquidity providers are");
    }
    const subjectBytes = this.subjectOf(productId, poolId);
    const subject = hexOf(subjectBytes);
    const all = await this.rows(subject);
    const { head, error } = await this.headOf(subjectBytes);
    const epoch = await this.currentEpoch(subject);
    const anchors = await this.anchors(subject);
    const { verdict } = this.verifyAgainstChain(all, head, error, epoch, anchors);
    // A sponsor's numbers are its own books: another sponsor of the product doesn't read them.
    const visible = all.filter((r) => (firm.as !== "licence_provider" || r.partner_entity_id === firm.entity_id) && (firm.as !== "liquidity_provider" || !firm.books || (!!r.partner_entity_id && firm.books.includes(r.partner_entity_id))) && (!firm.until || new Date(r.period_end) <= firm.until));
    const slice = visible.slice(-limit);
    const assessed = await this.assess(slice, subject, verdict);
    const history = slice.reverse().map((r) => {
      const a = assessed.get(r.id)!;
      return {
        ...snapshotStatus(r, a),
        // Withheld on a missed period: it never reached the chain, so nothing can vouch for it.
        report: a.report,
        // Entitled readers only: what they need to check the co-signature themselves.
        partner_key: r.partner_key,
        partner_signature: r.partner_signature,
        verification: {
          report_matches_fingerprint: a.report_matches,
          partner_signature_valid: a.signature_ok,
          on_chain: a.on_chain,
          integrity_ok: a.report_matches === true && a.signature_ok !== false && a.on_chain === "matches",
          detail: a.on_chain === "unavailable" ? error : a.report_matches === false ? "The stored report doesn't match its fingerprint: it was changed after it was recorded, so it's withheld" : null,
        },
      };
    });
    await this.store.audit(user.id, "get_product_health", productId, { as: firm.as, pool_id: poolId, sequences: history.map((h) => h.sequence) });
    return {
      product_id: productId,
      pool_id: poolId,
      entitled_as: firm.as,
      latest: history[0] ?? null,
      history,
      gaps: firm.until ? [] : await this.gapsOf(all, anchors, epoch, head, error), // no record of what came after the firm left
      ...(firm.until ? { access_ended_at: firm.until.toISOString() } : {}),
      chain: {
        program_id: this.chain?.programId ?? null,
        cluster: "devnet",
        epoch,
        // Entitled readers only: where to look on chain, to check this without Mynt (scripts/product-health-verify.mjs).
        subject,
        head_address: this.chain ? headAddress(this.chain.programId, subjectBytes) : null,
        head_sequence: head?.sequence ?? null,
        ...(error ? { unavailable: error } : {}),
      },
    };
  }

  // The newest finished record of a subject, for Mynt's own checks (a pool's reserve gate): a period still waiting for
  // its signature or the chain isn't decided yet, so it doesn't count. No entitlement here, and nothing leaves Mynt.
  async latestFinished(productId: string, poolId: string | null): Promise<PoolHealthReading | null> {
    const subjectBytes = this.subjectOf(productId, poolId);
    const subject = hexOf(subjectBytes);
    const epoch = await this.currentEpoch(subject);
    const all = await this.rows(subject);
    const latest = all.filter((r) => r.epoch === epoch && (r.status === "published" || r.status === "missed")).at(-1);
    if (!latest) return null;
    const { head, error } = await this.headOf(subjectBytes);
    const { verdict } = this.verifyAgainstChain(all, head, error, epoch, await this.anchors(subject));
    const a = (await this.assess([latest], subject, verdict)).get(latest.id)!;
    const status = snapshotStatus(latest, a);
    return { sequence: latest.sequence, status: latest.status, source: status.source, live: status.live, verified: status.verified, notes: status.notes, report: a.report };
  }

  // ---- for covenants (covenants.ts) ----

  // The product's own record (not a pool's), oldest first, and which epoch is current. Readable with no vault key.
  async covenantRows(productId: string): Promise<{ rows: SnapshotRow[]; epoch: number }> {
    const rows = (await this.db.query(`SELECT * FROM ${T}.product_health_snapshots WHERE product_id = $1 AND pool_id = '' ORDER BY epoch, sequence`, [productId])).rows as unknown as SnapshotRow[];
    return { rows, epoch: rows.length ? await this.currentEpoch(rows[0].subject) : 0 };
  }

  // Whether the ledger this firm's snapshots would come from is a real one: when there's no snapshot to read it from.
  async ledgerIsLive(entityId: string) {
    return (await this.ledgerState(entityId)) === "live";
  }

  // What a firm's ledger is now: live, sandbox, or unknown when Mynt can't tell (which is never taken for sandbox).
  async ledgerState(entityId: string): Promise<"live" | "sandbox" | "unknown"> {
    try {
      return (await (this.deps.ledgerFor ?? defaultLedgerFor)(entityId)).kind === "live" ? "live" : "sandbox";
    } catch {
      return "unknown";
    }
  }

  // The ledger a sponsor's snapshots read (the partner kit decides it per firm: partner-kit.ts). One that can't be
  // chosen reads as unavailable, never as live.
  private async ledgerOf(entityId: string): Promise<PartnerLedger> {
    try {
      return await (this.deps.ledgerFor ?? defaultLedgerFor)(entityId);
    } catch {
      return UNCHOSEN_LEDGER;
    }
  }

  // The authenticated report of one stored snapshot; null when it can't be opened (no vault key).
  async assessOne(r: SnapshotRow): Promise<Assessment | null> {
    try {
      return (await this.assess([r], r.subject, new Map())).get(r.id) ?? null;
    } catch {
      return null;
    }
  }

  // When the newest validly partner-signed period ended; null if none has been, undefined if it can't be checked.
  async lastPartnerSignedAt(rows: SnapshotRow[]): Promise<Date | null | undefined> {
    const candidates = rows.filter((r) => r.partner_signature && r.status !== "missed").slice(-50).reverse();
    for (const r of candidates) {
      const a = await this.assessOne(r);
      if (!a) return undefined;
      if (a.attestation === "partner_signed" && a.signature_ok === true) return new Date(r.period_end);
    }
    return null;
  }

  async fingerprintAt(productId: string, epoch: number, sequence: number): Promise<string | null> {
    const { rows } = await this.db.query(`SELECT fingerprint FROM ${T}.product_health_snapshots WHERE product_id = $1 AND pool_id = '' AND epoch = $2 AND sequence = $3`, [productId, epoch, sequence]);
    return (rows[0] as { fingerprint: string | null } | undefined)?.fingerprint ?? null;
  }

  // After a chain reset or a move to a new program, a product's record can't continue where it was. An admin starts it
  // again, in the open. Only when the chain has no record for it: a head that disagrees with Mynt is evidence, not
  // something an admin can start over from. What the old record looked like is saved and stays reported.
  async reanchor(user: User, productId: string, poolId: string | null, reason: string) {
    const me = (await this.store.getUser(user.id)) ?? user;
    const refuse = async (message: string): Promise<never> => {
      await this.store.audit(user.id, "reanchor_product_health_refused", productId, { pool_id: poolId, reason: reason.slice(0, MAX_REANCHOR_REASON), refused: message.slice(0, ERROR_LIMIT) });
      throw new HealthError(message);
    };
    if (!me.roles.includes("admin")) return refuse("Only an admin can re-anchor a product's record");
    if (reason.trim().length < 10 || reason.length > MAX_REANCHOR_REASON) return refuse(`Say what happened to the chain, in 10 to ${MAX_REANCHOR_REASON} characters`);
    const chain = this.chain;
    if (!chain) return refuse("The product-health program isn't deployed on this Mynt yet");
    const subjectBytes = this.subjectOf(productId, poolId);
    const subject = hexOf(subjectBytes);
    const all = await this.rows(subject);
    if (!all.length) return refuse("That product has no record to re-anchor");
    const { head, error } = await this.headOf(subjectBytes);
    if (error) return refuse(`The chain can't be read, so a reset can't be confirmed: ${error}`);
    if (head) return refuse(`The chain still holds this product's record, at sequence ${head.sequence}, so it can't be re-anchored. If it disagrees with Mynt's record, that needs investigating`);
    // A head that's gone but has history wasn't wiped by a reset, and if the history can't be read that can't be ruled out.
    let hadHistory: boolean;
    try {
      hadHistory = await chain.hasHeadHistory(subjectBytes);
    } catch (e) {
      return refuse(`The chain's history can't be read, so a reset can't be confirmed: ${(e as Error).message.slice(0, ERROR_LIMIT)}`);
    }
    if (hadHistory) return refuse("The chain has no head for this product but does have its transaction history, so it wasn't reset: this needs investigating");
    const anchors = await this.anchors(subject);
    if (anchors.some((a) => !a.valid)) return refuse("A stored anchor for this product failed its integrity check, so it can't be re-anchored: this needs investigating");
    const epoch = await this.currentEpoch(subject);
    const current = all.filter((r) => r.epoch === epoch);
    const previousProgram = anchors.find((a) => a.epoch === epoch)?.program_id ?? null;
    const programChanged = !!previousProgram && previousProgram !== chain.programId;
    if (!programChanged && !current.some((r) => r.on_chain)) return refuse("Nothing of this product's record has reached the chain, so there's nothing to re-anchor");
    // A program that was replaced may still be there to compare against; a reset chain isn't.
    let oldHead: HeadAccount | null = null;
    if (programChanged) {
      try {
        oldHead = await chain.head(subjectBytes, previousProgram!);
      } catch (e) {
        return refuse(`The previous program can't be read, so its record can't be saved: ${(e as Error).message.slice(0, ERROR_LIMIT)}`);
      }
      // The same test under the old program: its head gone but its history there means it wasn't a reset.
      if (!oldHead) {
        let oldHistory: boolean;
        try {
          oldHistory = await chain.hasHeadHistory(subjectBytes, previousProgram!);
        } catch (e) {
          return refuse(`The previous program's history can't be read, so a reset can't be confirmed: ${(e as Error).message.slice(0, ERROR_LIMIT)}`);
        }
        if (oldHistory) return refuse("The previous program has no head for this product but does have its transaction history, so it wasn't reset: this needs investigating");
      }
    }
    const check = oldHead ? this.verifyAgainstChain(current, oldHead, null, epoch) : null;
    const verdict = check ? (check.ok ? "matches" : "mismatch") : "gone";
    // A head one ahead (a landing Mynt hadn't recorded): saved as of the last record Mynt holds, or that row reads as tampered later.
    const lastHeld = check?.landing ? (oldHead!.sequence - 1) : null;
    const savedSequence = lastHeld ?? oldHead?.sequence ?? null;
    const savedChain = lastHeld !== null ? hexOf(this.replayTo(current, lastHeld)) : oldHead ? hexOf(oldHead.chain) : null;
    const saved = { subject, epoch: epoch + 1, reason, program_id: chain.programId, prev_verdict: verdict, prev_head_sequence: savedSequence, prev_head_chain: savedChain };
    // One statement, so one transaction: the epoch is read again where it's written, and the old record's rows change
    // with it or not at all.
    const { rows } = await this.db.query(
      `WITH cur AS (SELECT COALESCE(MAX(epoch), 0)::int AS e FROM ${T}.product_health_anchors WHERE subject = $1),
       ins AS (
         INSERT INTO ${T}.product_health_anchors (subject, epoch, reason, anchored_by, program_id, prev_verdict, prev_head_sequence, prev_head_chain, mac)
         SELECT $1, e + 1, $2, $3::uuid, $4, $5, $6::int, $7, $10 FROM cur WHERE e = $8::int RETURNING epoch
       ),
       upd AS (
         UPDATE ${T}.product_health_snapshots
            SET status = CASE WHEN on_chain THEN status ELSE 'missed' END,
                missed_reason = CASE WHEN on_chain THEN missed_reason ELSE COALESCE(missed_reason, $9) END,
                stalled_reason = NULL
          WHERE subject = $1 AND epoch = $8::int AND EXISTS (SELECT 1 FROM ins) RETURNING 1
       )
       SELECT epoch FROM ins`,
      [subject, reason, me.id, chain.programId, verdict, savedSequence, savedChain, epoch, `Not published: the record was re-anchored (${reason})`.slice(0, ERROR_LIMIT), this.anchorMac(saved)],
    );
    const next = (rows[0] as { epoch: number } | undefined)?.epoch;
    if (next === undefined) return refuse("Someone else re-anchored this record first");
    await this.store.audit(user.id, "reanchor_product_health", productId, { pool_id: poolId, from_epoch: epoch, to_epoch: next, reason, previous_record: verdict, previous_program: previousProgram, program_id: chain.programId });
    return { product_id: productId, pool_id: poolId, epoch: next, next_sequence: 1, previous_record: verdict };
  }
}

// ---- Mynt's own chain, through the existing RPC client's retry and backoff ----

const PUBLISHER_LOW = 5_000_000; // lamports: below this, the faucet is asked
const PUBLISHER_FLOAT = 20_000_000; // and enough for a good while on devnet

export class SolanaHealthChain implements HealthChain {
  readonly programId: string;
  private publisherKey: Awaited<ReturnType<SolanaService["healthPublisher"]>> | null = null;
  constructor(
    private readonly solana: SolanaService,
    programId: string,
  ) {
    this.programId = programId;
  }

  get publisher() {
    return this.publisherKey?.address ?? "";
  }
  private async signer() {
    this.publisherKey ??= await this.solana.healthPublisher(this.programId);
    return this.publisherKey;
  }

  private signatures(subject: Uint8Array, limit: number, programId: string = this.programId) {
    return this.solana.rpc("devnet").call<{ signature: string; err: unknown }[]>("getSignaturesForAddress", [headAddress(programId, subject), { limit, commitment: "confirmed" }]);
  }

  async hasHeadHistory(subject: Uint8Array, programId: string = this.programId): Promise<boolean> {
    return (await this.signatures(subject, 1, programId)).length > 0;
  }

  // Never just the newest transaction: only one that carries this record's own bytes.
  async latestRecordTx(subject: Uint8Array, expected: Uint8Array): Promise<string | null> {
    const wanted = Buffer.from(expected);
    for (const s of await this.signatures(subject, 10)) {
      if (s.err !== null) continue;
      const tx = await this.solana.rpc("devnet").call<{ transaction: [string, string]; meta: { err: unknown } | null } | null>("getTransaction", [s.signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (tx && tx.meta?.err === null && Buffer.from(tx.transaction[0], "base64").includes(wanted)) return s.signature;
    }
    return null;
  }

  async head(subject: Uint8Array, programId: string = this.programId): Promise<HeadAccount | null> {
    const { value } = await this.solana.rpc("devnet").call<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [
      headAddress(programId, subject),
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!value) return null;
    if (value.owner !== programId) throw new HealthError("The product's head account isn't owned by the product-health program");
    const head = decodeHead(Buffer.from(value.data[0], "base64"));
    if (!head) throw new HealthError("The product's head account can't be read");
    return head;
  }

  private async send(ixs: Parameters<SolanaService["sendAsHealthPublisher"]>[1]) {
    const signer = await this.signer();
    await this.solana.topUpHealthPublisher(signer.address, PUBLISHER_LOW, PUBLISHER_FLOAT).catch(() => undefined); // the send says what's wrong if it can't pay
    return this.solana.sendAsHealthPublisher(signer, ixs);
  }

  async publishSnapshot(subject: Uint8Array, entry: SnapshotEntry, opening: boolean) {
    const signer = await this.signer();
    return this.send([...(opening ? [healthIx.openSubject(this.programId, signer.address, subject)] : []), healthIx.recordSnapshot(this.programId, signer.address, subject, entry)]);
  }

  async publishMissed(subject: Uint8Array, entry: MissedEntry, opening: boolean) {
    const signer = await this.signer();
    return this.send([...(opening ? [healthIx.openSubject(this.programId, signer.address, subject)] : []), healthIx.recordMissed(this.programId, signer.address, subject, entry)]);
  }
}

// The money rails, if that module has landed: resolved at startup so the two PRs merge in either order, and bound to
// the store here because that's the one argument the worker doesn't have.
export async function loadFlowsFor(store: Store): Promise<FlowsFor | null> {
  const specifier = "./money-rails.js";
  let flowsFor: unknown;
  try {
    flowsFor = ((await import(specifier)) as { flowsFor?: unknown }).flowsFor;
  } catch (e) {
    if ((e as { code?: string }).code !== "ERR_MODULE_NOT_FOUND") console.error("product health: the money rails didn't load:", (e as Error).message);
    return null;
  }
  if (typeof flowsFor !== "function" || flowsFor.length !== 4) {
    console.error("product health: money-rails' flowsFor isn't flowsFor(store, productId, from, to); flows stay unmeasured");
    return null;
  }
  const call = flowsFor as (store: Store, productId: string, from: Date, to: Date) => Promise<unknown>;
  return (productId, from, to) => call(store, productId, from, to);
}

// For the operator's CLI: the publisher's address, and its one-time initialisation.
export async function initializeHealthProgram(solana: SolanaService, programId: string, authority: Keypair) {
  const publisher = await solana.healthPublisher(programId);
  return solana.initializeHealthProgram(publisher, authority);
}
