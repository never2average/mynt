import { createHash, createPrivateKey, randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { LocalConfidentialHost } from "./confidential/local.js";
import type { ConfidentialHost } from "./confidential/host.js";
import { inTransaction, type Db } from "./db.js";
import { ESIGN_ENV } from "./esign/adapters.js";
import type { Store, User } from "./store.js";
import { open as openLegacy } from "./vault.js";

// The platform key vault: the keys Mynt's own server uses (its sandbox and hosting providers, its agents' model
// provider, sign-in, GitHub, Solana, custody, e-signature), set by a Mynt admin from Mynt instead of the server's
// environment file. One flat table, `platform_secrets`:
//
//   - one row per key; each key is exactly one type from PLATFORM_KEY_TYPES (the name the server reads it by);
//   - one active key per type: setting a key again makes a new row and retires the old one, whose value is destroyed
//     (the retired row keeps who, when and its fingerprint, never the value);
//   - no on/off switch: a key is there or it's removed;
//   - values are write-only: sealed by the confidential host (ConfidentialHost.seal, purpose "secret", so the same
//     code runs in-process and against the enclave), never returned by a tool, a route or a log. What's shown is who
//     set it, when, and the first 8 hex characters of its SHA-256.
//
// Where a key's value comes from, the same for every type: the server's environment when it sets the name (so every
// deployment keeps working exactly as before, and the operator can always override or recover from the server), else
// the vault's active row, else nothing.
//
// Two kinds of consumer:
//   - read where used (needs_restart false): platformSecret() answers from this process's copy, replaced the moment
//     an admin changes the key;
//   - captured when the server starts (needs_restart true): the provider clients built at boot. Their values come
//     from bootEnv(), the environment with the vault's keys filled in underneath, so a new key takes effect at the
//     next restart and the row says so.
//
// What can't live here stays on the server (SERVER_ONLY_KEYS): whatever is read before the database and the vault are
// open, and paths to files on the server's disk.

const T = "financial_products";

export interface PlatformKeyType {
  key: string; // the type: the name the server reads the key by
  label: string;
  purpose: string; // what it's for
  used_by: string; // which part of Mynt uses it
  validation: string; // how a value is checked, in words
  needs_restart: boolean;
  multiline?: boolean; // a PEM block rather than one line
  check: (value: string) => string | null; // why the value isn't one, or null
  slot?: string; // the active row's name, where it differs from the key (rows from before this table was general)
  esign?: { provider: string; what: "api_key" | "webhook_id" }; // kept in step with the e-signature settings
}

const ONE_LINE = /^[\x21-\x7e]+$/;
const token =
  (min = 8, max = 500) =>
  (v: string) =>
    v.length >= min && v.length <= max && ONE_LINE.test(v) ? null : `one line of ${min} to ${max} characters, without spaces`;
const shaped = (pattern: RegExp, words: string) => (v: string) => (v.length <= 500 && pattern.test(v) ? null : words);
const httpsUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && v.length <= 1000 && ONE_LINE.test(v) ? null : "an https address";
  } catch {
    return "an https address";
  }
};
const pem = (v: string) => {
  try {
    createPrivateKey(v.replace(/\\n/g, "\n"));
    return null;
  } catch {
    return "a private key in PEM form (the whole block, from -----BEGIN to -----END)";
  }
};

// Provider names appear in these labels only (and in the names the server already reads the keys by).
const ESIGN_LABELS: Record<string, string> = { signwell: "SignWell" };
const esignTypes = (): PlatformKeyType[] =>
  Object.entries(ESIGN_ENV).flatMap(([provider, names]) => {
    const service = ESIGN_LABELS[provider] ?? provider;
    return [
      {
        key: names.apiKey,
        label: `E-signature API key (${service})`,
        purpose: "Sends program agreements for signature and fetches the signed copies",
        used_by: "E-signature",
        validation: "Checked with the e-signature service before it's kept",
        needs_restart: false,
        check: token(),
        slot: `esign:${provider}:api_key`,
        esign: { provider, what: "api_key" as const },
      },
      {
        key: names.webhookId,
        label: `E-signature webhook id (${service})`,
        purpose: "Verifies the events the e-signature service sends. Mynt sets it when it registers the webhook",
        used_by: "E-signature",
        validation: "One line, without spaces",
        needs_restart: false,
        check: token(4),
        slot: `esign:${provider}:webhook_id`,
        esign: { provider, what: "webhook_id" as const },
      },
    ];
  });

export const PLATFORM_KEY_TYPES: readonly PlatformKeyType[] = [
  {
    key: "FREESTYLE_API_KEY",
    label: "Hosting and sandbox provider key (Freestyle)",
    purpose: "Runs developers' hosted apps and, where chosen, the agents' sandboxes",
    used_by: "Hosting and agent sandboxes",
    validation: "One line of 8 to 500 characters, without spaces",
    needs_restart: true,
    check: token(),
  },
  {
    key: "BOAT_API_KEY",
    label: "Agent sandbox provider key (boat.dev)",
    purpose: "Runs the coding, desk, review and exploration agents' sandboxes",
    used_by: "Agent sandboxes",
    validation: "One line of 8 to 500 characters, without spaces",
    needs_restart: true,
    check: token(),
  },
  {
    key: "HOSTING_DO_TOKEN",
    label: "Hosting provider token (DigitalOcean)",
    purpose: "Makes a VM per developer for hosted apps, where that hosting is used",
    used_by: "Hosting",
    validation: "One line of 8 to 500 characters, without spaces",
    needs_restart: true,
    check: token(),
  },
  {
    key: "ANTHROPIC_API_KEY",
    label: "Model provider key (Anthropic API)",
    purpose: "Pays for every agent's model calls through Mynt's agent proxy. Never sent to a sandbox",
    used_by: "Every agent, through the agent proxy",
    validation: "Starts with sk-ant-",
    needs_restart: true,
    check: shaped(/^sk-ant-[A-Za-z0-9_-]{8,}$/, "a key starting with sk-ant-"),
  },
  {
    key: "CLERK_SECRET_KEY",
    label: "Sign-in provider secret key (Clerk)",
    purpose: "Checks who is signed in, and keeps the allowlist and workspaces' organizations in step. Mynt's apps (Studio, the chat) keep their own copy in their own settings",
    used_by: "Sign-in and workspaces",
    validation: "Starts with sk_test_ or sk_live_",
    needs_restart: true,
    check: shaped(/^sk_(test|live)_[A-Za-z0-9]{8,}$/, "a key starting with sk_test_ or sk_live_"),
  },
  {
    key: "CLERK_WEBHOOK_SECRET",
    label: "Sign-in provider webhook secret (Clerk)",
    purpose: "Verifies the organization, membership and invitation events the sign-in provider sends",
    used_by: "Workspace sync",
    validation: "Starts with whsec_",
    needs_restart: false,
    check: shaped(/^whsec_[A-Za-z0-9+/=_-]{8,}$/, "a secret starting with whsec_"),
  },
  {
    key: "GITHUB_APP_PRIVATE_KEY",
    label: "GitHub App private key",
    purpose: "Lets builds push branches and open pull requests, and hosting fetch verified commits (with the app's id and slug, which stay on the server)",
    used_by: "Builds, the product desk and hosting",
    validation: "A private key in PEM form",
    needs_restart: true,
    multiline: true,
    check: (v) => (v.length <= 8000 ? pem(v) : "a private key in PEM form"),
  },
  {
    key: "SOLANA_RPC_URL_DEVNET",
    label: "Solana devnet RPC address",
    purpose: "The devnet RPC endpoint; a provider's address carries its key",
    used_by: "Solana programs, treasuries and product health",
    validation: "An https address",
    needs_restart: true,
    check: httpsUrl,
  },
  {
    key: "SOLANA_RPC_URL_MAINNET",
    label: "Solana mainnet RPC address",
    purpose: "The mainnet RPC endpoint; a provider's address carries its key",
    used_by: "Solana mainnet deploys",
    validation: "An https address",
    needs_restart: true,
    check: httpsUrl,
  },
  {
    key: "TURNKEY_API_PRIVATE_KEY",
    label: "Custody service API private key (Turnkey)",
    purpose: "Signs Mynt's requests to the custody service that holds the mainnet deploy key (with the organization id and API public key, which stay on the server)",
    used_by: "Solana mainnet signing",
    validation: "A P-256 private key: up to 64 hex characters",
    needs_restart: true,
    check: shaped(/^[0-9a-fA-F]{32,64}$/, "a P-256 private key: 64 hex characters"),
  },
  ...esignTypes(),
  {
    key: "MYNT_PSEUDONYM_SECRET",
    label: "Product-request pseudonym key",
    purpose: "Turns each requester into a stable pseudonym per innovator. Changing it changes every pseudonym, so requests made before no longer match ones made after",
    used_by: "Product requests",
    validation: "One line of 16 to 500 characters, without spaces",
    needs_restart: false,
    check: token(16),
  },
];
const TYPE = new Map(PLATFORM_KEY_TYPES.map((t) => [t.key, t]));
export const PLATFORM_KEY_NAMES = PLATFORM_KEY_TYPES.map((t) => t.key) as [string, ...string[]];
export const platformKeyType = (key: string): PlatformKeyType | undefined => TYPE.get(key);
const slotOf = (t: PlatformKeyType) => t.slot ?? t.key;

// What stays on the server, and why. Listed read-only; only whether each is set is ever read.
export const SERVER_ONLY_KEYS: readonly { key: string; label: string; used_by: string; why: string }[] = [
  { key: "DATABASE_URL", label: "Database connection string", used_by: "Everything", why: "Mynt needs it to open the database the key vault is kept in" },
  { key: "MYNT_VAULT_KEY", label: "Vault key", used_by: "The key vault and every sealed value", why: "It's the key the vault is sealed with, so it can't be kept inside it" },
  { key: "CONFIDENTIAL_HOST_CLIENT_KEY", label: "Confidential service client key (a file path)", used_by: "The confidential host", why: "It's read before the vault opens, and it names a file on the server's disk" },
  { key: "CONFIDENTIAL_HOST_CLIENT_CERT", label: "Confidential service client certificate (a file path)", used_by: "The confidential host", why: "It's read before the vault opens, and it names a file on the server's disk" },
  { key: "GOOGLE_APPLICATION_CREDENTIALS", label: "Model provider service account (a file path)", used_by: "Every agent, through the agent proxy", why: "It names a key file on the server's disk; the file stays there" },
  { key: "FINANCIAL_PRODUCTS_TOKEN", label: "Command-line user token", used_by: "The stdio command", why: "It says who is running the command on the server, before anyone is signed in" },
];

export const fingerprintOf = (value: string) => createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
const isSet = (v: string | undefined): v is string => typeof v === "string" && v.trim() !== "";
const iso = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string).toISOString());

type Cached = { value: string | null; id: string }; // value null: the row is there but couldn't be opened
export type KeySource = "environment" | "vault" | "none";
const SOURCE_WORDS: Record<KeySource, string> = { environment: "Server environment", vault: "Key vault", none: "Not set" };
const REFRESH_MS = 30_000;
const USED_WRITE_MS = 60 * 60_000;

export interface PlatformKeyVaultOptions {
  host?: ConfidentialHost; // defaults to the local host (in-process, keyed by MYNT_VAULT_KEY)
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export class PlatformKeyVault {
  private cache = new Map<string, Cached>();
  private loadedAt = 0;
  private refreshing: Promise<void> | null = null;
  private usedWritten = new Map<string, number>();
  private listeners: ((type: string) => void | Promise<void>)[] = [];
  private readonly host: ConfidentialHost;
  readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  private constructor(
    private readonly db: Db,
    private readonly audit: Store["audit"],
    opts: PlatformKeyVaultOptions,
  ) {
    this.host = opts.host ?? new LocalConfidentialHost();
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? Date.now;
  }

  static async open(store: Store, opts: PlatformKeyVaultOptions = {}): Promise<PlatformKeyVault> {
    const v = new PlatformKeyVault(store.db, (...a) => store.audit(...a), opts);
    // Rows from before this table was general are named by their slot: give each its type, once.
    for (const t of PLATFORM_KEY_TYPES) if (t.slot) await store.db.query(`UPDATE ${T}.platform_secrets SET key_type = $1 WHERE name = $2 AND key_type IS NULL`, [t.key, t.slot]);
    await v.load().catch((e) => console.error("platform key vault: not loaded:", (e as Error).name));
    return v;
  }

  /** Told after a key is set or removed (the e-signature settings rebuild their client). */
  onChange(f: (type: string) => void | Promise<void>) {
    this.listeners.push(f);
  }

  private async unseal(sealed: string, type: string): Promise<string> {
    // Rows from before this table was general were sealed by the vault itself (vault.ts); new ones by the host, bound
    // to their key type (cs2), so a row moved to another type in the database doesn't open there.
    return /^cs[12]:/.test(sealed) ? (await this.host.unseal("secret", sealed, type)).toString("utf8") : openLegacy(sealed, false);
  }

  /** Reads every active key into this process. A row that can't be opened stays listed, without a value. */
  async load(): Promise<void> {
    const { rows } = await this.db.query(`SELECT id::text AS id, key_type, sealed, fingerprint FROM ${T}.platform_secrets WHERE status = 'active' AND key_type IS NOT NULL`);
    const next = new Map<string, Cached>();
    for (const r of rows) {
      const type = r.key_type as string;
      const was = this.cache.get(type);
      if (was && was.id === r.id && was.value !== null) {
        next.set(type, was);
        continue;
      }
      let value: string | null = null;
      try {
        value = r.sealed ? await this.unseal(r.sealed as string, type) : null;
      } catch {
        console.error(`platform key vault: ${type} couldn't be opened (is the vault key set?)`);
      }
      // A row the host sealed before values were bound to their type (cs1) is sealed again, bound, once it has opened.
      if (value !== null && (r.sealed as string).startsWith("cs1:")) {
        const bound = await this.host.seal("secret", Buffer.from(value, "utf8"), type).catch(() => null);
        if (bound) await this.db.query(`UPDATE ${T}.platform_secrets SET sealed = $2 WHERE id = $1 AND sealed = $3`, [r.id, bound, r.sealed]);
      }
      // A row from before fingerprints were kept gets its own the first time it's opened.
      if (value !== null && !r.fingerprint) await this.db.query(`UPDATE ${T}.platform_secrets SET fingerprint = $2 WHERE id = $1 AND fingerprint IS NULL`, [r.id, fingerprintOf(value)]);
      next.set(type, { value, id: r.id as string });
    }
    this.cache = next;
    this.loadedAt = this.now();
  }

  private refreshSoon() {
    if (this.refreshing || this.now() - this.loadedAt < REFRESH_MS) return;
    // Another process sharing the database may have changed a key: catch up in the background.
    this.refreshing = this.load()
      .catch(() => undefined)
      .finally(() => (this.refreshing = null));
  }

  source(type: string): KeySource {
    return isSet(this.env[type]) ? "environment" : this.cache.has(type) ? "vault" : "none";
  }

  /** The key in effect, from this process's copy: the environment's, else the vault's, else null. Never logged. */
  peek(type: string): string | null {
    const fromEnv = this.env[type];
    if (isSet(fromEnv)) return fromEnv;
    if (!TYPE.has(type)) return null;
    this.refreshSoon();
    const c = this.cache.get(type);
    if (!c || c.value === null) return null;
    this.used(type, c.id);
    return c.value;
  }

  /** The same, after catching up with the database when this process's copy is old. */
  async get(type: string): Promise<string | null> {
    if (!isSet(this.env[type]) && this.now() - this.loadedAt >= REFRESH_MS) await this.load().catch(() => undefined);
    return this.peek(type);
  }

  // When a key was last read, kept to the hour: enough to see that a key is in use, without a write per use.
  private used(type: string, id: string) {
    const at = this.now();
    if (at - (this.usedWritten.get(type) ?? 0) < USED_WRITE_MS) return;
    this.usedWritten.set(type, at);
    void this.db.query(`UPDATE ${T}.platform_secrets SET last_used_at = now() WHERE id = $1`, [id]).catch(() => undefined);
  }

  /** The environment as the server's start-up reads it: every vault key filled in where the environment doesn't set it. */
  bootEnv(): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...this.env };
    for (const t of PLATFORM_KEY_TYPES) {
      if (isSet(this.env[t.key])) continue;
      const c = this.cache.get(t.key);
      if (c?.value) {
        out[t.key] = c.value;
        this.used(t.key, c.id);
      }
    }
    return out;
  }

  /** Whether the host can seal here (the local host needs the vault key). Seals and discards a probe. */
  async ready(): Promise<boolean> {
    try {
      await this.host.seal("secret", Buffer.from("probe"));
      return true;
    } catch {
      return false;
    }
  }

  /** Every key type as the page shows it: never a value. */
  async list() {
    const { rows } = await this.db.query(
      `SELECT s.id::text AS id, s.key_type, s.set_at, s.fingerprint, s.validated_at, s.last_used_at, u.name AS set_by,
              (SELECT count(*)::int FROM ${T}.platform_secrets r WHERE r.key_type = s.key_type AND r.status = 'retired') AS replaced
       FROM ${T}.platform_secrets s LEFT JOIN ${T}.users u ON u.id = s.set_by WHERE s.status = 'active' AND s.key_type IS NOT NULL`,
    );
    const active = new Map(rows.map((r) => [r.key_type as string, r]));
    const keys = PLATFORM_KEY_TYPES.map((t) => {
      const fromEnv = isSet(this.env[t.key]);
      const row = active.get(t.key);
      const source: KeySource = fromEnv ? "environment" : row ? "vault" : "none";
      const inVault = row
        ? { set_at: iso(row.set_at), set_by: (row.set_by as string | null) ?? null, fingerprint: (row.fingerprint as string | null) ?? null, validated_at: iso(row.validated_at), last_used_at: iso(row.last_used_at) }
        : null;
      const readable = row ? this.cache.get(t.key)?.value !== null : null;
      return {
        type: t.key,
        label: t.label,
        purpose: t.purpose,
        used_by: t.used_by,
        validation: t.validation,
        multiline: t.multiline === true,
        source,
        source_label: SOURCE_WORDS[source],
        server_only: false,
        // The environment's key is never fingerprinted or dated: Mynt only knows that it's set.
        set_at: source === "vault" ? inVault!.set_at : null,
        set_by: source === "vault" ? inVault!.set_by : null,
        fingerprint: source === "vault" ? inVault!.fingerprint : null,
        validated_at: source === "vault" ? inVault!.validated_at : null,
        last_used_at: source === "vault" ? inVault!.last_used_at : null,
        needs_restart: t.needs_restart,
        takes_effect: t.needs_restart ? "After a restart" : "At once",
        // A vault key the environment currently overrides: it takes over when the server stops setting the name.
        vault_key: inVault,
        readable,
        times_replaced: row ? Number(row.replaced ?? 0) : 0,
        note: fromEnv ? "Set on the server; overrides the vault" : readable === false ? "This key can't be opened: the vault key it was sealed with isn't available. Set it again" : null,
      };
    });
    const server = SERVER_ONLY_KEYS.map((k) => {
      const source: KeySource = isSet(this.env[k.key]) ? "environment" : "none";
      return {
        type: k.key,
        label: k.label,
        purpose: k.why,
        used_by: k.used_by,
        validation: null,
        multiline: false,
        source,
        source_label: SOURCE_WORDS[source],
        server_only: true,
        set_at: null,
        set_by: null,
        fingerprint: null,
        validated_at: null,
        last_used_at: null,
        needs_restart: true,
        takes_effect: "After a restart",
        vault_key: null,
        readable: null,
        times_replaced: 0,
        note: `Set on the server only. ${k.why}`,
      };
    });
    return [...keys, ...server];
  }

  /** The retired rows of a type, newest first: who and when, never a value (there is none left). */
  async history(type: string) {
    const { rows } = await this.db.query(
      `SELECT s.set_at, s.retired_at, s.fingerprint, s.retired_reason, u.name AS set_by, r.name AS retired_by, s.sealed IS NULL AS destroyed
       FROM ${T}.platform_secrets s LEFT JOIN ${T}.users u ON u.id = s.set_by LEFT JOIN ${T}.users r ON r.id = s.retired_by
       WHERE s.key_type = $1 AND s.status = 'retired' ORDER BY s.retired_at DESC LIMIT 50`,
      [type],
    );
    return rows.map((r) => ({ set_at: iso(r.set_at), set_by: (r.set_by as string | null) ?? null, retired_at: iso(r.retired_at), retired_by: (r.retired_by as string | null) ?? null, reason: r.retired_reason as string, fingerprint: (r.fingerprint as string | null) ?? null, value_destroyed: r.destroyed === true }));
  }

  /** The active row of a type: who set it and when. For the e-signature settings' own status. */
  async row(type: string): Promise<{ set_at: string; set_by: string | null } | null> {
    const r = (await this.db.query(`SELECT s.set_at, u.name FROM ${T}.platform_secrets s LEFT JOIN ${T}.users u ON u.id = s.set_by WHERE s.key_type = $1 AND s.status = 'active'`, [type])).rows[0];
    return r ? { set_at: iso(r.set_at)!, set_by: (r.name as string | null) ?? null } : null;
  }

  /** The vault's own key of a type, whatever the environment says (the e-signature settings delete their webhook with it). */
  async stored(type: string): Promise<string | null> {
    await this.load().catch(() => undefined);
    return this.cache.get(type)?.value ?? null;
  }

  private async changed(type: string) {
    await this.load();
    for (const f of this.listeners) await f(type);
  }

  /**
   * Sets a type's key: checked, sealed by the confidential host, and made the type's one active row. The row it
   * replaces is retired and its value destroyed. `validated`: a provider check passed (the e-signature service's).
   */
  async set(user: User, type: string, raw: string, opts: { validated?: boolean } = {}): Promise<{ ok: true; replaced: boolean; fingerprint: string; in_effect: boolean; needs_restart: boolean } | { ok: false; error: string }> {
    const t = TYPE.get(type);
    if (!t) return { ok: false, error: `${type} isn't a key the vault keeps` };
    const value = raw.trim();
    const problem = t.check(value);
    if (problem) {
      await this.audit(user.id, "set_platform_key_refused", type, { type, reason: "format" });
      return { ok: false, error: `${t.label}: expected ${problem}. Nothing was kept` };
    }
    let sealed: string;
    try {
      sealed = await this.host.seal("secret", Buffer.from(value, "utf8"), type);
    } catch {
      await this.audit(user.id, "set_platform_key_refused", type, { type, reason: "vault_unavailable" });
      return { ok: false, error: "This server can't seal keys yet: its vault key (MYNT_VAULT_KEY) or confidential host isn't available. Nothing was kept" };
    }
    const id = randomUUID();
    const fingerprint = fingerprintOf(value);
    const replaced = await inTransaction(this.db, async (tx) => {
      const old = await tx.query(
        `UPDATE ${T}.platform_secrets SET status = 'retired', sealed = NULL, name = 'retired:' || id::text, retired_at = now(), retired_by = $2, retired_reason = 'replaced'
         WHERE key_type = $1 AND status = 'active' RETURNING id`,
        [type, user.id],
      );
      await tx.query(
        `INSERT INTO ${T}.platform_secrets (id, name, key_type, status, sealed, fingerprint, set_by, validated_at) VALUES ($1, $2, $3, 'active', $4, $5, $6, ${opts.validated ? "now()" : "NULL"})`,
        [id, slotOf(t), type, sealed, fingerprint, user.id],
      );
      return old.rows.length > 0;
    });
    const inEffect = !isSet(this.env[type]);
    await this.audit(user.id, "set_platform_key", type, { type, fingerprint, replaced, validated_with_provider: opts.validated === true, needs_restart: t.needs_restart, in_effect: inEffect, ...(inEffect ? {} : { overridden_by: "environment" }) });
    await this.changed(type);
    return { ok: true, replaced, fingerprint, in_effect: inEffect, needs_restart: t.needs_restart };
  }

  /** Removes a type's key: its row is retired and its value destroyed. */
  async remove(user: User, type: string): Promise<{ removed: boolean; still_set_by_environment: boolean }> {
    const r = await this.db.query(
      `UPDATE ${T}.platform_secrets SET status = 'retired', sealed = NULL, name = 'retired:' || id::text, retired_at = now(), retired_by = $2, retired_reason = 'removed'
       WHERE key_type = $1 AND status = 'active' RETURNING id`,
      [type, user.id],
    );
    const removed = r.rows.length > 0;
    const stillEnv = isSet(this.env[type]);
    if (removed) await this.audit(user.id, "remove_platform_key", type, { type, still_set_by_environment: stillEnv, needs_restart: TYPE.get(type)?.needs_restart ?? false });
    await this.changed(type);
    return { removed, still_set_by_environment: stillEnv };
  }
}

// The server's vault, for the consumers that read a key where they use it. Installed once at start-up (index.ts).
let installed: PlatformKeyVault | null = null;
export const installPlatformKeys = (vault: PlatformKeyVault | null) => void (installed = vault);

/** A platform key where it's used: the environment's when it sets the name, else the vault's active key, else null. */
export function platformSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env[name];
  if (isSet(fromEnv)) return fromEnv;
  return installed?.peek(name) ?? null;
}

// One per store, for servers made without one (tests, the stdio command).
const OPENED = new WeakMap<Store, Promise<PlatformKeyVault>>();
export const platformKeysFor = (store: Store): Promise<PlatformKeyVault> => {
  let v = OPENED.get(store);
  if (!v) OPENED.set(store, (v = PlatformKeyVault.open(store)));
  return v;
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (error: string) => ({ ...json({ error }), isError: true });

// The e-signature settings, as far as the vault's tools need them: its API key is checked with the service and its
// webhook registered there, so setting or removing that key goes through them (esign-settings.ts).
export interface EsignKeyHooks {
  setKey(user: User, provider: string, apiKey: string): Promise<{ ok: true; webhook: { registered: boolean; reused?: boolean; reason?: string } } | { ok: false; error: string }>;
  removeKey(user: User): Promise<{ removed: boolean; webhook_deleted: boolean; still_configured_by_environment: boolean }>;
}

/** Admins only: the platform key vault. No tool here ever answers with a value. */
export function registerPlatformKeyTools(server: McpServer, store: Store, user: User, given?: PlatformKeyVault | null, esign?: EsignKeyHooks | null) {
  const vault = async () => given ?? (await platformKeysFor(store));
  const rowOf = async (v: PlatformKeyVault, type: string) => (await v.list()).find((k) => k.type === type)!;

  server.registerTool(
    "list_platform_keys",
    {
      title: "The platform key vault",
      description:
        "Admin: every key Mynt's own server uses, one row per key type: what it's for, which part of Mynt uses it, where its value comes from (Key vault, Server environment or Not set; the server's environment overrides the vault), who set it and when, a short fingerprint (the first 8 hex characters of its SHA-256), when it was last checked with its provider and last used where known, and whether a change needs a restart. The keys that can only be set on the server are listed too, with why. Never a key's value. include_history adds each type's retired keys (who, when, why; their values are destroyed).",
      inputSchema: z.object({ include_history: z.boolean().optional() }).strict(),
      annotations: { readOnlyHint: true },
    },
    async ({ include_history }) => {
      const v = await vault();
      const keys = await v.list();
      const history = include_history ? Object.fromEntries(await Promise.all(PLATFORM_KEY_TYPES.map(async (t) => [t.key, await v.history(t.key)] as const))) : undefined;
      return json({ keys, vault_ready: await v.ready(), precedence: "The server's environment, where it sets a key, overrides the vault; otherwise the vault's key is used.", ...(history ? { history } : {}) });
    },
  );

  server.registerTool(
    "set_platform_key",
    {
      title: "Set or replace a platform key",
      description:
        "Admin: set one of Mynt's own keys (list_platform_keys names the types and how each is checked). The value is checked for its type's format (the e-signature API key is also checked with the service, and its webhook registered), sealed, and becomes the type's one active key: a key it replaces is retired and its value destroyed. The value is never shown again. Keys read where they're used apply at once; the others after the server restarts, and the answer says which. Where the server's environment sets the same key, the environment keeps winning. Audited without the value.",
      inputSchema: z.object({ type: z.enum(PLATFORM_KEY_NAMES), value: z.string().min(8).max(8000).describe("The key, sent once. Never returned") }).strict(),
    },
    async ({ type, value }) => {
      const v = await vault();
      const t = TYPE.get(type)!;
      let webhook: { registered: boolean; reused?: boolean; reason?: string } | undefined;
      if (t.esign?.what === "api_key" && esign) {
        const problem = t.check(value.trim());
        if (problem) return fail(`${t.label}: expected ${problem}. Nothing was kept`);
        const r = await esign.setKey(user, t.esign.provider, value.trim());
        if (!r.ok) return fail(r.error);
        webhook = r.webhook;
      } else {
        const r = await v.set(user, type, value);
        if (!r.ok) return fail(r.error);
      }
      const key = await rowOf(v, type);
      const overridden = key.source === "environment";
      const message = overridden
        ? `${t.label} is kept in the vault, but the server's environment sets this key and overrides the vault until it's removed there.`
        : t.needs_restart
          ? `${t.label} is kept in the vault. It takes effect after the server restarts.`
          : `${t.label} is kept in the vault and in use now.`;
      return json({ ok: true, type, in_effect: !overridden && !t.needs_restart, needs_restart: t.needs_restart, message, ...(webhook ? { webhook } : {}), key });
    },
  );

  server.registerTool(
    "remove_platform_key",
    {
      title: "Remove a platform key",
      description:
        "Admin: remove a key from the vault: its row is retired and its value destroyed. Whatever uses it stops (at once, or after a restart for keys read when the server starts) unless the server's environment sets the same key. Removing the e-signature API key also deletes its webhook at the service. Audited.",
      inputSchema: z.object({ type: z.enum(PLATFORM_KEY_NAMES), confirm: z.literal(true) }).strict(),
    },
    async ({ type }) => {
      const v = await vault();
      const t = TYPE.get(type)!;
      let removed: boolean;
      let stillEnv: boolean;
      if (t.esign?.what === "api_key" && esign) {
        const r = await esign.removeKey(user);
        removed = r.removed;
        stillEnv = r.still_configured_by_environment;
      } else {
        const r = await v.remove(user, type);
        removed = r.removed;
        stillEnv = r.still_set_by_environment;
      }
      if (!removed) return fail(`${t.label} isn't in the vault${stillEnv ? ": it's set on the server, where it has to be removed" : ""}`);
      const message = stillEnv
        ? `${t.label} is removed from the vault. The server's environment still sets it, so it stays in use.`
        : t.needs_restart
          ? `${t.label} is removed from the vault and its value destroyed. What uses it stops after the server restarts.`
          : `${t.label} is removed from the vault and its value destroyed.`;
      return json({ ok: true, type, removed: true, still_set_by_environment: stillEnv, needs_restart: t.needs_restart, message, key: await rowOf(v, type) });
    },
  );
}
