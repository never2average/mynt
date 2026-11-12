import { createSign } from "node:crypto";
import { GitAuthorizationEnded, type GitUserToken, type RepoOwnershipProvider } from "./repo-ownership.js";
import type { GitRepoHost } from "./git-host.js";

// Pushes from builds go through a GitHub App the developer installs on their repository. For each build
// Mynt mints an installation token limited to that one repository, with contents and pull-request write
// access, valid for an hour; no long-lived credential reaches the build sandbox.

export interface RepoAccess {
  installationFor(repo: string): Promise<number | null>;
  tokenFor(repo: string, installationId: number): Promise<{ token: string; expires_at: string }>;
  installUrl(): string;
  // Opened by Mynt, only after a build passes its gates.
  openPullRequest(repo: string, installationId: number, pr: { head: string; title: string; body: string }): Promise<string>;
  // The commit a branch, tag or SHA points at now (null when it doesn't exist), so Mynt can pin what it checks.
  resolveRef(repo: string, installationId: number, ref: string): Promise<string | null>;
  // A branch Mynt creates itself at a commit it checked (e.g. to propose exactly what it scored).
  createBranch(repo: string, installationId: number, branch: string, sha: string): Promise<void>;
}

// Mynt's managed repositories on GitHub: private repositories in an organization Mynt owns
// (BUILD_MANAGED_REPO_OWNER), created and reached through the same GitHub App, installed on that organization with
// Administration (write) as well as contents and pull requests.
export class GitHubRepoHost implements GitRepoHost {
  readonly name = "github";
  constructor(
    private readonly app: GitHubApp,
    private readonly org: string,
  ) {}

  static fromEnv(app: GitHubApp | null, env = process.env): GitHubRepoHost | null {
    const org = env.BUILD_MANAGED_REPO_OWNER?.trim();
    return app && org ? new GitHubRepoHost(app, org) : null;
  }

  owns(repository: string) {
    return repository.toLowerCase().startsWith(`${this.org.toLowerCase()}/`);
  }

  access() {
    return this.app.orgInstallation(this.org);
  }

  async create(name: string, description: string) {
    const access = await this.access();
    if (!access) throw new Error("Mynt's GitHub App isn't installed on its managed-repository organization");
    return { repository: (await this.app.createRepository(this.org, access, name, description)).toLowerCase(), access };
  }

  cloneUrl(repository: string) {
    return `https://github.com/${repository}.git`;
  }

  async readCredentials(repository: string) {
    const access = await this.access();
    if (!access) throw new Error("Mynt's GitHub App isn't installed on its managed-repository organization");
    return { username: "x-access-token", password: await this.app.readTokenFor(repository, access) };
  }
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export class GitHubApp implements RepoAccess {
  constructor(
    private readonly appId: string,
    private readonly privateKey: string,
    private readonly slug: string,
    private readonly api = "https://api.github.com",
  ) {}

  static fromEnv(env = process.env): GitHubApp | null {
    if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_SLUG) return null;
    return new GitHubApp(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"), env.GITHUB_APP_SLUG);
  }

  private jwt(): string {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.appId }));
    const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(this.privateKey);
    return `${head}.${body}.${b64url(sig)}`;
  }

  private async call(method: string, path: string, body?: unknown) {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.jwt()}`, Accept: "application/vnd.github+json", "User-Agent": "mynt", "X-GitHub-Api-Version": "2022-11-28" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: res.status === 204 ? {} : await res.json() };
  }

  async installationFor(repo: string) {
    const r = await this.call("GET", `/repos/${repo}/installation`);
    return r.status === 200 ? (r.data as { id: number }).id : null;
  }

  async tokenFor(repo: string, installationId: number) {
    const name = repo.split("/")[1];
    const r = await this.call("POST", `/app/installations/${installationId}/access_tokens`, {
      repositories: [name],
      permissions: { contents: "write", pull_requests: "write" },
    });
    if (r.status !== 201) throw new Error(`GitHub refused a token for ${repo} (${r.status})`);
    return r.data as { token: string; expires_at: string };
  }

  // Read-only, for fetching a verified commit onto a hosting VM.
  async readTokenFor(repo: string, installationId: number) {
    const r = await this.call("POST", `/app/installations/${installationId}/access_tokens`, { repositories: [repo.split("/")[1]], permissions: { contents: "read" } });
    if (r.status !== 201) throw new Error(`GitHub refused a token for ${repo} (${r.status})`);
    return (r.data as { token: string }).token;
  }

  async orgInstallation(org: string) {
    const r = await this.call("GET", `/orgs/${encodeURIComponent(org)}/installation`);
    return r.status === 200 ? (r.data as { id: number }).id : null;
  }

  // A private repository in Mynt's organization, with a first commit (so it has a default branch for pull
  // requests). Needs the App's Administration (write) permission on that installation. Creating one that already
  // exists returns it, so a retry after a lost response is safe.
  async createRepository(org: string, installationId: number, name: string, description: string) {
    const r = await this.call("POST", `/app/installations/${installationId}/access_tokens`, { permissions: { administration: "write", contents: "read" } });
    if (r.status !== 201) throw new Error(`GitHub refused a token to create repositories in ${org} (${r.status})`);
    const token = (r.data as { token: string }).token;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${this.api}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "mynt", "X-GitHub-Api-Version": "2022-11-28" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
    const created = await call("POST", `/orgs/${encodeURIComponent(org)}/repos`, { name, description, private: true, auto_init: true, has_issues: false, has_wiki: false, has_projects: false });
    if (created.status === 201) return created.data.full_name as string;
    if (created.status === 422) {
      // It exists (a retry after a lost response, or a concurrent create): read it back, giving a just-created
      // repository a moment to become readable.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 500 * attempt));
        const existing = await call("GET", `/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`);
        if (existing.status === 200) {
          if (existing.data.private === true) return existing.data.full_name as string;
          break; // never use a public repository of that name
        }
      }
    }
    throw new Error(`GitHub refused to create ${org}/${name} (${created.status})`);
  }

  installUrl() {
    return `https://github.com/apps/${this.slug}/installations/new`;
  }

  // Calls as the installation, with a token limited to the one repository.
  private async asInstallation(repo: string, installationId: number) {
    const { token } = await this.tokenFor(repo, installationId);
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${this.api}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "mynt", "X-GitHub-Api-Version": "2022-11-28" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: (res.status === 204 ? {} : await res.json().catch(() => ({}))) as Record<string, unknown> };
    };
  }

  async resolveRef(repo: string, installationId: number, ref: string) {
    const call = await this.asInstallation(repo, installationId);
    const r = await call("GET", `/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    if (r.status === 404 || r.status === 422) return null;
    if (r.status !== 200) throw new Error(`GitHub couldn't resolve ${ref} (${r.status})`);
    return r.data.sha as string;
  }

  async createBranch(repo: string, installationId: number, branch: string, sha: string) {
    const call = await this.asInstallation(repo, installationId);
    const r = await call("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    if (r.status !== 201) throw new Error(`GitHub refused to create branch ${branch} (${r.status})`);
  }

  async openPullRequest(repo: string, installationId: number, pr: { head: string; title: string; body: string }) {
    const call = await this.asInstallation(repo, installationId);
    const info = await call("GET", `/repos/${repo}`);
    const base = info.data.default_branch as string;
    if (pr.head === base) throw new Error("Refusing to open a pull request from the default branch");
    const created = await call("POST", `/repos/${repo}/pulls`, { head: pr.head, base, title: pr.title, body: pr.body });
    if (created.status !== 201) throw new Error(`GitHub refused the pull request (${created.status})`);
    return created.data.html_url as string;
  }
}

// The GitHub App's user-to-server authorization (OAuth, with PKCE): a person authorises the App as themselves, and
// Mynt asks GitHub, with their user token, whether they can push to a repository (GET /repos/{owner}/{repo}:
// permissions.push). GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are the App's own; the secret stays on the server.
export class GitHubUserAuth implements RepoOwnershipProvider {
  readonly name = "github";
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly web = "https://github.com",
    private readonly api = "https://api.github.com",
  ) {}

  static fromEnv(env = process.env): GitHubUserAuth | null {
    return env.GITHUB_APP_CLIENT_ID && env.GITHUB_APP_CLIENT_SECRET ? new GitHubUserAuth(env.GITHUB_APP_CLIENT_ID, env.GITHUB_APP_CLIENT_SECRET) : null;
  }

  authorizeUrl(state: string, redirectUri: string, codeChallenge: string) {
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, state, code_challenge: codeChallenge, code_challenge_method: "S256" });
    return `${this.web}/login/oauth/authorize?${q}`;
  }

  private async tokenCall(body: Record<string, string>, refreshing: boolean): Promise<GitUserToken> {
    const res = await fetch(`${this.web}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "mynt" },
      body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, ...body }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof data.access_token !== "string") {
      // GitHub answers 200 with an error for a refresh token it won't take (expired, revoked, already used).
      if (refreshing && data.error === "bad_refresh_token") throw new GitAuthorizationEnded("GitHub no longer accepts this authorization");
      throw new Error(`GitHub refused the authorization (${String(data.error ?? res.status)})`);
    }
    const token = data.access_token;
    const user = await fetch(`${this.api}/user`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "mynt" } });
    const who = user.ok ? ((await user.json()) as { login?: string; id?: number }) : {};
    return {
      access_token: token,
      refresh_token: typeof data.refresh_token === "string" ? data.refresh_token : null,
      expires_at: typeof data.expires_in === "number" ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null,
      login: who.login ?? null,
      user_id: who.id != null ? String(who.id) : null,
    };
  }

  exchange(code: string, redirectUri: string, codeVerifier: string) {
    return this.tokenCall({ code, redirect_uri: redirectUri, code_verifier: codeVerifier }, false);
  }

  refresh(refreshToken: string) {
    return this.tokenCall({ grant_type: "refresh_token", refresh_token: refreshToken }, true);
  }

  async canPush(accessToken: string, repository: string): Promise<boolean | "unauthorized"> {
    const res = await fetch(`${this.api}/repos/${repository}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "mynt", "X-GitHub-Api-Version": "2022-11-28" },
    });
    if (res.status === 401) return "unauthorized";
    if (res.status === 404) return false; // not there, or not visible to them
    if (res.status === 403) {
      // A 403 isn't always "no": the organization may require single sign-on for this token, or the rate limit is spent.
      if (res.headers.get("x-github-sso"))
        throw new Error(`The organization that owns ${repository} requires single sign-on: authorise Mynt's GitHub App for it (GitHub's SSO prompt), then try again`);
      if (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after"))
        throw new Error(`GitHub's rate limit is spent for your account; try again in a few minutes`);
      return false;
    }
    if (!res.ok) throw new Error(`GitHub couldn't say who can push to ${repository} (${res.status}); try again in a moment`);
    const data = (await res.json()) as { permissions?: { push?: boolean } };
    return data.permissions?.push === true;
  }

  // Withdraws the App's authorization for this person (DELETE /applications/{client_id}/grant).
  async revoke(accessToken: string) {
    await fetch(`${this.api}/applications/${this.clientId}/grant`, {
      method: "DELETE",
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "mynt",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
  }
}
