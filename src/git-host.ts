// Managed repositories: Mynt keeps a private git repository per app on a git host, so a developer needs no account
// of their own there for builds to push, pull requests to open, deploy_app to fetch a verified commit and
// continue_from to pick up where a build left off. A git host's adapter implements this; the rest of Mynt reaches
// managed repositories only through this interface.

export interface GitRepoHost {
  readonly name: string;
  // Whether a repository ("owner/name") is one of Mynt's managed ones.
  owns(repository: string): boolean;
  // The access handle Mynt mints push and read tokens with for managed repositories (the same handle the repository
  // access for builds takes); null when the host isn't reachable that way.
  access(): Promise<number | null>;
  // A private repository with a first commit (so it has a default branch). Creating one that exists returns it.
  create(name: string, description: string): Promise<{ repository: string; access: number }>;
  // Short-lived (an hour), read-only git credentials for one managed repository.
  readCredentials(repository: string): Promise<{ username: string; password: string }>;
  // Where git clones a repository from (no credentials in it).
  cloneUrl(repository: string): string;
}

// Whether a repository is one of Mynt's managed ones: in the managed organization by name, or recorded as an app's
// managed repository (so a name the host still redirects, after the organization was renamed, is recognised too).
export async function isManagedRepository(db: { query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, host: GitRepoHost | null, repository: string) {
  if (host?.owns(repository)) return true;
  const r = await db
    .query("SELECT 1 FROM financial_products.app_repositories WHERE managed_repository = $1", [repository.toLowerCase()])
    .catch(() => ({ rows: [] })); // a deployment that never created the table has no managed repositories
  return r.rows.length > 0;
}

// The one guard every path that connects a repository by name goes through (a developer's connect_repository and
// set_app_repository, a firm's desk workspace, and so the desk's explorations): Mynt's managed repositories are reached
// only through their own app's builds, never connected by name. The installation alone proves nothing: the App is
// installed on every managed repository.
export async function refuseManagedRepository(db: Parameters<typeof isManagedRepository>[0], host: GitRepoHost | null, repository: string) {
  if (await isManagedRepository(db, host, repository))
    throw new Error(`'${repository}' is one of Mynt's managed repositories, reached only through its own app; connect a repository of your own`);
}
