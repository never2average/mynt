import type { RepoAccess } from "./github.js";
import type { LinkedAccountsService } from "./linked-accounts.js";

// Whether a developer may push to a repository they connect, so their connection needs no admin's approval
// (repo-approvals.ts). The person is the git account linked to their sign-in, verified, as the identity provider
// reports it to Mynt's server (never anything the client sends, and no sign-in to the git host of Mynt's own). The
// git host is asked, through Mynt's app installation that covers the repository, what permission that account has:
// admin, maintain or write means they can push, and the connection is approved. The repository is pinned by its
// stable id across the check, so a rename or transfer in the middle (a different repository answering to the name)
// is refused. Anything else (no linked account, no push permission, the host unreachable) leaves the request with
// an admin, as before, saying why.

export const PUSH_PERMISSIONS = ["admin", "maintain", "write"] as const;

export type OwnershipCheck =
  | { approved: true; repo_id: string; login: string; permission: string }
  | { approved: false; reason: "no_identity" | "unlinked" | "no_push" | "changed" | "mismatch" | "unreachable"; message: string; manage_url?: string | null };

export async function checkRepoOwnership(o: {
  repos: RepoAccess;
  identity: LinkedAccountsService | null;
  userId: string;
  repository: string;
  installationId: number;
  // The repository's id recorded with an earlier connection of theirs, if any: it must still be the same repository.
  recordedRepoId?: string | null;
}): Promise<OwnershipCheck> {
  const { repos } = o;
  if (!o.identity || !repos.repositoryInfo || !repos.permissionOf || !repos.loginOf)
    return { approved: false, reason: "no_identity", message: "Mynt can't check who can push to it here, so an admin approves it" };
  const linked = await o.identity.forUser(o.userId);
  const git = linked.git;
  if (!git?.user_id)
    return {
      approved: false,
      reason: "unlinked",
      message:
        "unavailable" in linked
          ? `Mynt couldn't read the accounts linked to your sign-in (${linked.unavailable}), so an admin approves it`
          : "No verified GitHub account is linked to your sign-in, so an admin approves it. To skip the wait next time, link your GitHub account (manage_url) and run connect_repository again",
      manage_url: linked.manage_url,
    };
  try {
    const before = await repos.repositoryInfo(o.repository, o.installationId);
    if (!before) return { approved: false, reason: "unreachable", message: `GitHub didn't show ${o.repository} to Mynt's app, so an admin approves it` };
    if (before.full_name.toLowerCase() !== o.repository.toLowerCase())
      return { approved: false, reason: "mismatch", message: `${o.repository} now answers as ${before.full_name} (renamed or transferred), so an admin approves it` };
    if (o.recordedRepoId && o.recordedRepoId !== before.id)
      return { approved: false, reason: "changed", message: `${o.repository} is a different repository from the one you connected before, so an admin approves it` };
    // The account's current name, from its stable id (a name can change hands; the id can't).
    const login = await repos.loginOf(git.user_id, o.repository, o.installationId);
    if (!login) return { approved: false, reason: "unlinked", message: "GitHub doesn't know the account linked to your sign-in any more, so an admin approves it", manage_url: linked.manage_url };
    const permission = await repos.permissionOf(o.repository, o.installationId, login);
    const after = await repos.repositoryInfo(o.repository, o.installationId);
    if (!after || after.id !== before.id || after.full_name.toLowerCase() !== before.full_name.toLowerCase())
      return { approved: false, reason: "changed", message: `${o.repository} changed (renamed or transferred) while Mynt was checking it, so an admin approves it` };
    if (!(PUSH_PERMISSIONS as readonly string[]).includes(permission))
      return { approved: false, reason: "no_push", message: `Your GitHub account ${login} can't push to ${o.repository} (its permission there is ${permission}), so an admin approves it` };
    return { approved: true, repo_id: before.id, login, permission };
  } catch {
    // Only that it failed: the host's message may carry request details.
    return { approved: false, reason: "unreachable", message: "GitHub couldn't be reached to check who can push to it, so an admin approves it (or run connect_repository again shortly)" };
  }
}
