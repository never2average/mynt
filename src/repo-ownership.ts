import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import { open, seal } from "./vault.js";

// Proof that a person may push to a repository before Mynt lets them connect it. The repository host's app being
// installed on a repository only says the app can reach it, not that the person asking can: without this, anyone
// could connect someone else's repository by name and get push and pull-request tokens for it.
//
// Each person authorises Mynt's app on the git host as themselves, once (OAuth). Mynt keeps their user token sealed
// at rest (vault.ts, MYNT_VAULT_KEY) and asks the host, as them, whether they can push to a repository. Every path that
// connects or uses a repository by name checks it: connect_repository, a build naming a repository (re-checked at each
// build start, so revoked access stops builds), a firm's desk workspace, and each desk exploration.
//
// The host's specifics are in its adapter (src/github.ts: GitHubUserAuth); the rest of Mynt reaches them only here.

export interface GitUserToken {
  access_token: string;
  refresh_token: string | null;
  expires_at: string | null; // when access_token stops working, if it expires
  login: string | null; // the person's account name on the host, for display
}

export interface RepoOwnershipProvider {
  readonly name: string;
  // Where the person authorises Mynt's app as themselves; the host sends them back to `redirectUri` with a code.
  authorizeUrl(state: string, redirectUri: string): string;
  exchange(code: string, redirectUri: string): Promise<GitUserToken>;
  refresh(refreshToken: string): Promise<GitUserToken>;
  // Whether the token's owner can push to `repository`; "unauthorized" when the token itself no longer works.
  canPush(accessToken: string, repository: string): Promise<boolean | "unauthorized">;
}

const TABLES = `
  CREATE TABLE IF NOT EXISTS financial_products.git_accounts (
    user_id uuid PRIMARY KEY REFERENCES financial_products.users(id),
    provider text NOT NULL,
    login text,
    token_sealed text NOT NULL,
    refresh_sealed text,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- One sign-in in flight per state: single use, and only for ten minutes.
  CREATE TABLE IF NOT EXISTS financial_products.git_account_states (
    state text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES financial_products.users(id),
    created_at timestamptz NOT NULL DEFAULT now()
  );
`;

export const GIT_CALLBACK_PATH = "/oauth/git/callback";
const STATE_TTL_MS = 10 * 60 * 1000;

type Row = Record<string, unknown>;

export class RepoOwnershipService {
  // How long one answer ("can push" or not) is reused. Short, so revoked access stops the next build soon.
  static CHECK_TTL_MS = 5 * 60 * 1000;
  private cache = new Map<string, { ok: boolean; at: number }>();

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

  private notSetUp() {
    return new Error(
      "Mynt can't check who may push to a repository yet: the git host's user authorization isn't set up on this Mynt (an operator's step), so repositories can't be connected",
    );
  }

  // Starts the person's authorization: the link to open.
  async begin(userId: string) {
    if (!this.provider || !this.publicUrl) throw this.notSetUp();
    const state = randomBytes(24).toString("base64url");
    await this.db.query("DELETE FROM financial_products.git_account_states WHERE created_at < now() - interval '10 minutes'");
    await this.db.query("INSERT INTO financial_products.git_account_states (state, user_id) VALUES ($1, $2)", [state, userId]);
    return { authorize_url: this.provider.authorizeUrl(state, this.redirectUri), expires_in_minutes: STATE_TTL_MS / 60000 };
  }

  // The host's callback: the state names who started it (single use, ten minutes), the code becomes their token.
  async complete(state: string, code: string) {
    if (!this.provider) throw this.notSetUp();
    const r = (await this.db.query("DELETE FROM financial_products.git_account_states WHERE state = $1 RETURNING user_id, created_at", [state])).rows[0] as Row | undefined;
    if (!r || Date.now() - Date.parse(String(r.created_at)) > STATE_TTL_MS) throw new Error("This sign-in link has expired or was already used; start again with connect_git_account");
    const token = await this.provider.exchange(code, this.redirectUri);
    await this.store(String(r.user_id), token);
    this.forget(String(r.user_id));
    return { user_id: String(r.user_id), login: token.login };
  }

  private async store(userId: string, t: GitUserToken) {
    await this.db.query(
      `INSERT INTO financial_products.git_accounts (user_id, provider, login, token_sealed, refresh_sealed, expires_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET provider = EXCLUDED.provider, login = COALESCE(EXCLUDED.login, git_accounts.login), token_sealed = EXCLUDED.token_sealed,
         refresh_sealed = EXCLUDED.refresh_sealed, expires_at = EXCLUDED.expires_at, updated_at = now()`,
      [userId, this.provider!.name, t.login, seal(t.access_token, false), t.refresh_token ? seal(t.refresh_token, false) : null, t.expires_at],
    );
  }

  async account(userId: string) {
    const r = (await this.db.query("SELECT provider, login, created_at, updated_at FROM financial_products.git_accounts WHERE user_id = $1", [userId])).rows[0] as Row | undefined;
    return r ? { provider: r.provider as string, login: (r.login as string | null) ?? null, connected_at: new Date(String(r.created_at)).toISOString() } : null;
  }

  async disconnect(userId: string) {
    await this.db.query("DELETE FROM financial_products.git_accounts WHERE user_id = $1", [userId]);
    this.forget(userId);
  }

  private forget(userId: string) {
    for (const k of this.cache.keys()) if (k.startsWith(`${userId}|`)) this.cache.delete(k);
  }

  // The person's working token: refreshed when it has expired (or the host says it no longer works); null when
  // they have to authorise again.
  private async token(userId: string, forceRefresh = false): Promise<string | null> {
    const r = (await this.db.query("SELECT token_sealed, refresh_sealed, expires_at FROM financial_products.git_accounts WHERE user_id = $1", [userId])).rows[0] as
      | Row
      | undefined;
    if (!r) return null;
    const expired = r.expires_at != null && Date.parse(String(r.expires_at)) - 60_000 < Date.now();
    if (!expired && !forceRefresh) return open(String(r.token_sealed), false);
    if (!r.refresh_sealed) return null;
    try {
      const t = await this.provider!.refresh(open(String(r.refresh_sealed), false));
      await this.store(userId, t);
      return t.access_token;
    } catch {
      return null;
    }
  }

  // Throws, saying what to do, unless the person can push to `repository` (an answer reused for CHECK_TTL_MS).
  async requirePush(userId: string, repository: string) {
    if (!this.provider) throw this.notSetUp();
    const repo = repository.toLowerCase();
    const key = `${userId}|${repo}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < RepoOwnershipService.CHECK_TTL_MS) {
      if (hit.ok) return;
      throw this.cannotPush(repository);
    }
    let token = await this.token(userId);
    if (!token) throw new Error(`Connect your git account first (connect_git_account), so Mynt can check that you can push to ${repository}`);
    let can = await this.provider.canPush(token, repo);
    if (can === "unauthorized") {
      token = await this.token(userId, true);
      can = token ? await this.provider.canPush(token, repo) : "unauthorized";
    }
    if (can === "unauthorized") throw new Error(`Your git account's authorization has expired or was revoked; connect it again with connect_git_account`);
    this.cache.set(key, { ok: can, at: Date.now() });
    if (!can) throw this.cannotPush(repository);
  }

  private cannotPush(repository: string) {
    return new Error(`Your git account can't push to ${repository}; only a repository you can push to can be connected or built`);
  }
}

// The check every connect path calls. Without the service (or with no git host's user authorization configured) it
// refuses: a repository is never connected on the strength of the app's installation alone.
export async function requirePush(ownership: RepoOwnershipService | null | undefined, userId: string, repository: string) {
  if (!ownership) throw new Error("Mynt can't check who may push to a repository yet (an operator's step), so repositories can't be connected or built on");
  await ownership.requirePush(userId, repository);
}

// connect_git_account and git_account: for anyone who connects repositories (developers, and innovators' desks).
export function registerGitAccountTools(server: McpServer, userId: string, ownership: RepoOwnershipService) {
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const fail = (error: string) => ({ ...json({ error }), isError: true });
  server.registerTool(
    "connect_git_account",
    {
      title: "Connect your git account",
      description:
        "Authorise Mynt's app on your git host as yourself, once. Mynt then checks, as you, that you can push to any repository before you connect it or build on it (and again at each build). Open the link in your browser; it expires in ten minutes. Your token is kept encrypted and never shown.",
      inputSchema: {},
    },
    async () => {
      try {
        return json({ ...(await ownership.begin(userId)), connected: await ownership.account(userId), next: "Open authorize_url, approve, then come back" });
      } catch (e) {
        return fail((e as Error).message);
      }
    },
  );
  server.registerTool(
    "git_account",
    {
      title: "Your git account",
      description: "Whether your git account is connected (and as whom); disconnect: true removes Mynt's stored authorization.",
      inputSchema: { disconnect: z.boolean().default(false) },
    },
    async ({ disconnect }) => {
      if (disconnect) await ownership.disconnect(userId);
      return json({ connected: await ownership.account(userId) });
    },
  );
}
