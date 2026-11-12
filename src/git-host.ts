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
