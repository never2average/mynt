import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { derivedKey } from "./vault.js";

// Proof that a person may push to a repository before Mynt lets them connect or use it. The repository host's app
// being installed on a repository only says the app can reach it, not that the person asking can: without this,
// anyone could connect someone else's repository by name and get push and pull-request tokens for it.
//
// Each person authorises Mynt's app on the git host as themselves, once (OAuth with PKCE). Mynt keeps their user token
// sealed at rest (a key derived from MYNT_VAULT_KEY for this purpose only) and asks the host, as them, whether they can
// push to a repository. Every path that connects or uses a repository by name checks it.
//
// Linking is bound to the Mynt account that started it. Mynt's server has no browser session of its own (people use it
// through MCP clients), so the binding is made over the authenticated MCP channel: the host's callback, in the same
// browser that opened Mynt's start link (a host-only cookie holds a hash of the state), shows a one-time code, and
// only the Mynt account that started the sign-in can confirm it (confirm_git_account). A sign-in link someone else
// started, completed in your browser, links nothing: you can't confirm their sign-in, and they never see your code.
//
// The host's specifics are in its adapter (src/github.ts: GitHubUserAuth); the rest of Mynt reaches them only here.

export interface GitUserToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null; // when access_token stops working, if it expires
  login: string | null; // the person's account name on the host, for display
  user_id: string | null; // the host's stable id for the person
}

// The host refused a refresh token (expired or revoked): the person has to authorise again. Any other error while
// refreshing is a passing failure (the host unreachable), and says so.
export class GitAuthorizationEnded extends Error {}

export interface RepoOwnershipProvider {
  readonly name: string;
  // Where the person authorises Mynt's app as themselves (PKCE S256); the host sends them back to `redirectUri`.
  authorizeUrl(state: string, redirectUri: string, codeChallenge: string): string;
  exchange(code: string, redirectUri: string, codeVerifier: string): Promise<GitUserToken>;
  refresh(refreshToken: string): Promise<GitUserToken>; // throws GitAuthorizationEnded when the host refuses it
  // Whether the token's owner can push to `repository`; "unauthorized" when the token itself no longer works. Throws,
  // with an accurate message, when the host can't say (single sign-on not authorised, rate limited, unreachable).
  canPush(accessToken: string, repository: string): Promise<boolean | "unauthorized">;
  // Withdraws Mynt's authorization at the host (best effort).
  revoke?(accessToken: string): Promise<void>;
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.git_accounts (
    user_id uuid PRIMARY KEY REFERENCES financial_products.users(id),
    provider text NOT NULL,
    login text,
    token_sealed text NOT NULL,
    refresh_sealed text,
    expires_at timestamptz,
    -- The host's own id for the person, always known: one host account links to one Mynt account.
    provider_user_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS git_accounts_provider_user ON financial_products.git_accounts (provider, provider_user_id);
  -- Sign-ins in flight: ten minutes each, a few per person. The PKCE verifier and, once the host has answered, the
  -- person's token wait here, sealed, until the Mynt account that started it confirms the code shown to them.
  CREATE TABLE IF NOT EXISTS financial_products.git_account_states (
    state text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
  ALTER TABLE financial_products.git_account_states ADD COLUMN IF NOT EXISTS verifier_sealed text;
  ALTER TABLE financial_products.git_account_states ADD COLUMN IF NOT EXISTS token_sealed text;
  ALTER TABLE financial_products.git_account_states ADD COLUMN IF NOT EXISTS code_hash text;
  ALTER TABLE financial_products.git_account_states ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
`;

export const GIT_START_PATH = "/oauth/git/start";
export const GIT_CALLBACK_PATH = "/oauth/git/callback";
export const GIT_STATE_COOKIE = "__Host-mynt-git";
// One cookie per sign-in (named by its state), so two sign-ins in one browser don't overwrite each other.
export const stateCookieName = (state: string) => `${GIT_STATE_COOKIE}-${createHash("sha256").update(`name:${state}`).digest("hex").slice(0, 16)}`;
const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 3; // sign-ins in flight per person
const MAX_ATTEMPTS = 5; // wrong codes before a sign-in is dropped

type Row = Record<string, unknown>;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Buffer) => b.toString("base64url");
const sameHex = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Eight characters from an unambiguous 32-letter alphabet (40 bits), shown as XXXX-XXXX; a sign-in allows a few tries.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const confirmCode = () => {
  const c = [...randomBytes(8)].map((b) => ALPHABET[b % 32]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

// Sealed with a key derived from MYNT_VAULT_KEY for people's git tokens only.
function tokenKey(): Buffer {
  const k = derivedKey("git-user-tokens");
  if (!k) throw new Error("MYNT_VAULT_KEY isn't set, so Mynt can't keep git authorizations");
  return k;
}
function sealToken(value: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", tokenKey(), iv);
  const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return ["g1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}
function openToken(sealed: string) {
  const [v, iv, tag, ct] = sealed.split(":");
  if (v !== "g1") throw new Error("unknown sealed-token format");
  const d = createDecipheriv("aes-256-gcm", tokenKey(), Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
}

const SETUP_MISSING =
  "Mynt can't check who may push to a repository yet: the git host's user authorization isn't set up on this Mynt (an operator's step). Until it is, no repository can be connected, built on, or used as a desk workspace";

export class RepoOwnershipService {
  // How long a "can push" answer is reused. Short, so revoked access stops the next build soon. A "can't" is never
  // reused: granting access takes effect at once.
  static CHECK_TTL_MS = 5 * 60 * 1000;
  private cache = new Map<string, number>(); // "user|repo" -> when push was confirmed
  private locks = new Map<string, Promise<unknown>>(); // one refresh at a time per person, in this process

  private constructor(
    private readonly db: Db,
    readonly provider: RepoOwnershipProvider | null,
    private readonly publicUrl: string,
  ) {}

  static async open(db: Db, provider: RepoOwnershipProvider | null, publicUrl: string) {
    await db.exec(TABLES);
    return new RepoOwnershipService(db, provider, publicUrl.replace(/\/+$/, ""));
  }

  get redirectUri() {
    return `${this.publicUrl}${GIT_CALLBACK_PATH}`;
  }

  private ready() {
    if (!this.provider || !this.publicUrl) throw new Error(SETUP_MISSING);
    if (!derivedKey("git-user-tokens")) throw new Error(`${SETUP_MISSING} (MYNT_VAULT_KEY isn't set)`);
  }

  // Starts a sign-in for the person: a Mynt link to open in their browser.
  async begin(userId: string) {
    this.ready();
    await this.db.query("DELETE FROM financial_products.git_account_states WHERE created_at < now() - interval '10 minutes'");
    // A few in flight per person: starting another drops the oldest.
    await this.db.query(
      `DELETE FROM financial_products.git_account_states WHERE user_id = $1 AND state NOT IN
         (SELECT state FROM financial_products.git_account_states WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
      [userId, MAX_PENDING - 1],
    );
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    await this.db.query("INSERT INTO financial_products.git_account_states (state, user_id, verifier_sealed) VALUES ($1, $2, $3)", [state, userId, sealToken(verifier)]);
    return { link: `${this.publicUrl}${GIT_START_PATH}?state=${state}`, expires_in_minutes: STATE_TTL_MS / 60000 };
  }

  private async pending(state: string) {
    const r = (await this.db.query("SELECT * FROM financial_products.git_account_states WHERE state = $1", [state])).rows[0] as Row | undefined;
    if (!r || Date.now() - Date.parse(String(r.created_at)) > STATE_TTL_MS) throw new Error("This sign-in link has expired or was already used; start again with connect_git_account");
    return r;
  }

  // Mynt's start link: the host's authorize URL (with the PKCE challenge), and the cookie value tying the callback to
  // this browser (a hash of the state).
  async startRedirect(state: string) {
    this.ready();
    const r = await this.pending(state);
    if (r.token_sealed) throw new Error("This sign-in was already completed; start again with connect_git_account");
    const challenge = b64url(createHash("sha256").update(openToken(String(r.verifier_sealed))).digest());
    return { location: this.provider!.authorizeUrl(state, this.redirectUri, challenge), cookieName: stateCookieName(state), cookie: sha256(state) };
  }

  // The host's callback, in the browser that opened the start link. Nothing is linked yet: the token waits, sealed,
  // for the Mynt account that started the sign-in to confirm the code returned here (shown only in this browser).
  async callback(state: string, code: string, cookie: string | null) {
    this.ready();
    if (!cookie || !sameHex(cookie, sha256(state))) {
      // Dropped, so whatever reached this callback can't be replayed.
      await this.db.query("DELETE FROM financial_products.git_account_states WHERE state = $1", [state]);
      throw new Error("This sign-in didn't start in this browser, so it was cancelled; start again with connect_git_account");
    }
    const r = await this.pending(state);
    if (r.token_sealed) throw new Error("This sign-in was already completed; start again with connect_git_account");
    const token = await this.provider!.exchange(code, this.redirectUri, openToken(String(r.verifier_sealed)));
    const confirm = confirmCode();
    if (!token.user_id) throw new Error("The git host didn't say which account signed in, so nothing was linked; start again with connect_git_account");
    await this.db.query("UPDATE financial_products.git_account_states SET token_sealed = $2, code_hash = $3 WHERE state = $1", [state, sealToken(JSON.stringify(token)), sha256(confirm)]);
    // Who started it, for the page to say: the Mynt account (and its firm) the host account would be linked to.
    const who = (await this.db.query(
      "SELECT u.name, e.name AS firm FROM financial_products.users u LEFT JOIN financial_products.entities e ON e.id = u.entity_id WHERE u.id = $1",
      [r.user_id],
    )).rows[0] as Row | undefined;
    return { confirm_code: confirm, login: token.login, mynt_account: { name: (who?.name as string) ?? "unknown", firm: (who?.firm as string | null) ?? null } };
  }

  // The last step, over the person's own authenticated Mynt session: links the host account to the Mynt account that
  // started the sign-in, and only to it.
  async confirm(userId: string, code: string) {
    this.ready();
    const hash = sha256(code.trim().toUpperCase());
    const mine = (await this.db.query(
      "SELECT * FROM financial_products.git_account_states WHERE user_id = $1 AND token_sealed IS NOT NULL AND created_at > now() - interval '10 minutes'",
      [userId],
    )).rows as Row[];
    const hit = mine.find((r) => r.code_hash && sameHex(String(r.code_hash), hash));
    if (!hit) {
      // Someone else's sign-in, completed in this person's browser: refused, and dropped.
      const other = (await this.db.query("DELETE FROM financial_products.git_account_states WHERE code_hash = $1 AND user_id <> $2 RETURNING state", [hash, userId])).rows;
      if (other.length) throw new Error("That sign-in was started from another Mynt account, so nothing was linked. If you didn't start it, someone tried to link your git account to theirs");
      for (const r of mine) {
        const n = (await this.db.query("UPDATE financial_products.git_account_states SET attempts = attempts + 1 WHERE state = $1 RETURNING attempts", [r.state])).rows[0] as Row | undefined;
        if (n && Number(n.attempts) >= MAX_ATTEMPTS) await this.db.query("DELETE FROM financial_products.git_account_states WHERE state = $1", [r.state]);
      }
      throw new Error("That code doesn't match a sign-in of yours; check it, or start again with connect_git_account");
    }
    const token = JSON.parse(openToken(String(hit.token_sealed))) as GitUserToken;
    await this.db.query("DELETE FROM financial_products.git_account_states WHERE state = $1", [hit.state]);
    if (!token.user_id) throw new Error("The git host didn't say which account signed in, so nothing was linked");
    const taken = (await this.db.query("SELECT user_id FROM financial_products.git_accounts WHERE provider = $1 AND provider_user_id = $2 AND user_id <> $3", [
      this.provider!.name,
      token.user_id,
      userId,
    ])).rows;
    if (taken.length) throw new Error(`That git account${token.login ? ` (${token.login})` : ""} is already linked to another Mynt account`);
    await this.store(userId, token);
    this.forget(userId);
    return { login: token.login, provider_user_id: token.user_id };
  }

  // Admins: every link, and who it belongs to.
  async links() {
    const rows = (await this.db.query(
      `SELECT g.user_id, u.name, g.provider, g.login, g.provider_user_id, g.created_at, g.updated_at
       FROM financial_products.git_accounts g JOIN financial_products.users u ON u.id = g.user_id ORDER BY g.created_at`,
    )).rows as Row[];
    return rows.map((r) => ({
      user_id: String(r.user_id),
      name: r.name as string,
      provider: r.provider as string,
      login: (r.login as string | null) ?? null,
      provider_user_id: r.provider_user_id as string,
      linked_at: new Date(String(r.created_at)).toISOString(),
    }));
  }

  private async store(userId: string, t: GitUserToken) {
    await this.db.query(
      `INSERT INTO financial_products.git_accounts (user_id, provider, provider_user_id, login, token_sealed, refresh_sealed, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, provider_user_id = COALESCE(EXCLUDED.provider_user_id, git_accounts.provider_user_id),
         login = COALESCE(EXCLUDED.login, git_accounts.login), token_sealed = EXCLUDED.token_sealed, refresh_sealed = EXCLUDED.refresh_sealed,
         expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [userId, this.provider!.name, t.user_id, t.login, sealToken(t.access_token), t.refresh_token ? sealToken(t.refresh_token) : null, t.expires_at],
    );
  }

  async account(userId: string) {
    const r = (await this.db.query("SELECT provider, login, created_at FROM financial_products.git_accounts WHERE user_id = $1", [userId])).rows[0] as Row | undefined;
    return r ? { provider: r.provider as string, login: (r.login as string | null) ?? null, connected_at: new Date(String(r.created_at)).toISOString() } : null;
  }

  // Removes Mynt's authorization: withdrawn at the host too (best effort), then deleted here.
  async disconnect(userId: string) {
    const r = (await this.db.query("SELECT token_sealed FROM financial_products.git_accounts WHERE user_id = $1", [userId])).rows[0] as Row | undefined;
    if (r && this.provider?.revoke) await this.provider.revoke(openToken(String(r.token_sealed))).catch(() => undefined);
    await this.db.query("DELETE FROM financial_products.git_accounts WHERE user_id = $1", [userId]);
    this.forget(userId);
  }

  private forget(userId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${userId}|`)) this.cache.delete(k);
  }

  // One at a time per person in this process, so a rotating refresh token is never spent twice.
  private serial<T>(userId: string, f: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(f);
    this.locks.set(userId, next.catch(() => undefined));
    return next;
  }

  // The person's working token, refreshed once it has expired (or `force`, when the host stopped accepting it).
  // null: they have to authorise again. A passing failure to refresh throws, saying so.
  private token(userId: string, force = false): Promise<string | null> {
    return this.serial(userId, async () => {
      const read = async () =>
        (await this.db.query("SELECT token_sealed, refresh_sealed, expires_at FROM financial_products.git_accounts WHERE user_id = $1", [userId])).rows[0] as Row | undefined;
      const r = await read();
      if (!r) return null;
      const expired = r.expires_at != null && Date.parse(String(r.expires_at)) - 60_000 < Date.now();
      if (!expired && !force) return openToken(String(r.token_sealed));
      if (!r.refresh_sealed) return null;
      let t: GitUserToken;
      try {
        t = await this.provider!.refresh(openToken(String(r.refresh_sealed)));
      } catch (e) {
        if (!(e instanceof GitAuthorizationEnded)) throw new Error(`Mynt couldn't reach the git host to renew your authorization; try again in a moment (${(e as Error).message})`);
        // Refused: unless another Mynt process renewed it meanwhile, the person must authorise again.
        const now = await read();
        if (now && now.token_sealed !== r.token_sealed) return openToken(String(now.token_sealed));
        return null;
      }
      // Compare-and-swap on the token it replaced, for other Mynt processes.
      const moved = await this.db.query(
        `UPDATE financial_products.git_accounts SET token_sealed = $2, refresh_sealed = $3, expires_at = $4, updated_at = now()
         WHERE user_id = $1 AND token_sealed = $5 RETURNING user_id`,
        [userId, sealToken(t.access_token), t.refresh_token ? sealToken(t.refresh_token) : null, t.expires_at, r.token_sealed],
      );
      if (moved.rows.length === 0) {
        const now = await read();
        return now ? openToken(String(now.token_sealed)) : null;
      }
      return t.access_token;
    });
  }

  // Throws, saying what to do, unless the person can push to `repository`. Only a "yes" is reused (CHECK_TTL_MS).
  async requirePush(userId: string, repository: string) {
    this.ready();
    const repo = repository.toLowerCase();
    const key = `${userId}|${repo}`;
    const at = this.cache.get(key);
    if (at !== undefined && Date.now() - at < RepoOwnershipService.CHECK_TTL_MS) return;
    let token = await this.token(userId);
    if (!token) {
      const linked = await this.account(userId);
      throw new Error(
        linked
          ? `Your git account's authorization has expired or was revoked; connect it again with connect_git_account`
          : `Connect your git account first (connect_git_account), so Mynt can check that you can push to ${repository}`,
      );
    }
    let can = await this.provider!.canPush(token, repo);
    if (can === "unauthorized") {
      token = await this.token(userId, true);
      can = token ? await this.provider!.canPush(token, repo) : "unauthorized";
    }
    if (can === "unauthorized") throw new Error(`Your git account's authorization has expired or was revoked; connect it again with connect_git_account`);
    if (!can) throw new Error(`Your git account can't push to ${repository}; only a repository you can push to can be connected or used`);
    this.cache.set(key, Date.now());
  }
}

// The check every path calls. Without the service it refuses: a repository is never used on the strength of the
// app's installation alone.
export async function requirePush(ownership: RepoOwnershipService | null | undefined, userId: string, repository: string) {
  if (!ownership) throw new Error(SETUP_MISSING);
  await ownership.requirePush(userId, repository);
}

// connect_git_account, confirm_git_account and git_account: for anyone who connects repositories (developers, and
// innovators' desks).
type Audit = (actorId: string, action: string, target: string, details?: unknown) => Promise<void>;

export function registerGitAccountTools(server: McpServer, userId: string, ownership: RepoOwnershipService, audit: Audit) {
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const fail = (error: string) => ({ ...json({ error }), isError: true });
  const attempt = async (f: () => Promise<unknown>) => {
    try {
      return json(await f());
    } catch (e) {
      return fail((e as Error).message);
    }
  };
  server.registerTool(
    "connect_git_account",
    {
      title: "Connect your git account",
      description:
        "Authorise Mynt's app on your git host as yourself, once, so Mynt can check (as you) that you can push to a repository before you connect it or build on it. Open the link in your browser (it expires in ten minutes); the page you land on shows a code: finish with confirm_git_account and that code. Your token is kept encrypted and never shown.",
      inputSchema: {},
    },
    async () => attempt(async () => ({ ...(await ownership.begin(userId)), connected: await ownership.account(userId), next: "Open link, approve, then confirm_git_account with the code shown" })),
  );
  server.registerTool(
    "confirm_git_account",
    {
      title: "Finish connecting your git account",
      description: "The code shown after you approved Mynt on your git host (connect_git_account). Only the Mynt account that started that sign-in can finish it.",
      inputSchema: { code: z.string().min(4).max(20) },
    },
    async ({ code }) =>
      attempt(async () => {
        const linked = await ownership.confirm(userId, code);
        await audit(userId, "confirm_git_account", userId, { provider: ownership.provider?.name ?? null, login: linked.login, provider_user_id: linked.provider_user_id });
        return { connected: { login: linked.login } };
      }),
  );
  server.registerTool(
    "git_account",
    {
      title: "Your git account",
      description: "Whether your git account is connected (and as whom); disconnect: true withdraws Mynt's authorization at the host and deletes it here.",
      inputSchema: { disconnect: z.boolean().default(false) },
    },
    async ({ disconnect }) =>
      attempt(async () => {
        if (disconnect) {
          const was = await ownership.account(userId);
          await ownership.disconnect(userId);
          if (was) await audit(userId, "disconnect_git_account", userId, { provider: was.provider, login: was.login });
        }
        return { connected: await ownership.account(userId) };
      }),
  );
}

// Admins: see every git-account link, and unlink one (its grant withdrawn at the host), on the audit log.
export function registerGitAccountAdminTools(server: McpServer, adminId: string, ownership: RepoOwnershipService, audit: Audit) {
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  server.registerTool(
    "list_git_account_links",
    {
      title: "People's git-account links",
      description: "Admin: every Mynt account's linked git-host account (who, which host account, since when). Tokens are never shown.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => json(await ownership.links()),
  );
  server.registerTool(
    "unlink_git_account",
    {
      title: "Unlink a person's git account",
      description: "Admin: remove a Mynt account's git-host link (its grant withdrawn at the host). They can link again with connect_git_account. Recorded in the audit log.",
      inputSchema: { user_id: z.string().uuid(), reason: z.string().min(3).max(500) },
      annotations: { destructiveHint: true },
    },
    async ({ user_id, reason }) => {
      const was = await ownership.account(user_id);
      if (!was) return { ...json({ error: `No git account is linked to '${user_id}'` }), isError: true };
      await ownership.disconnect(user_id);
      await audit(adminId, "unlink_git_account", user_id, { provider: was.provider, login: was.login, reason });
      return json({ unlinked: true, user_id, login: was.login });
    },
  );
}
