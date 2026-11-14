// The developer's connected GitHub repositories (list_repositories) and connecting one
// (connect_repository). A repository is approved at once when the GitHub account linked to the
// sign-in can push to it, or by an admin; otherwise it waits for an admin, and Mynt says why.
// Mynt-managed repositories (one per app) are left out: they're reached through each app.
// Pure, for the route, the dashboard, the Workspace page and the tests.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
export type RepoApproval = "approved" | "pending" | "rejected";
export const APPROVAL_LABELS: Record<RepoApproval, string> = { approved: "Approved", pending: "Waiting for an admin", rejected: "Rejected" };
export const APPROVAL_TONE: Record<RepoApproval, "green" | "amber" | "red"> = { approved: "green", pending: "amber", rejected: "red" };

export type Repo = { repository: string; approval: RepoApproval; note: string | null; connectedAt: string | null };

const approvalOf = (v: unknown): RepoApproval => (v === "approved" ? "approved" : v === "rejected" ? "rejected" : "pending");

// https pages only (GitHub's install page, the identity provider's account page).
export function httpsUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

// list_repositories' reply: an array of { repository, approval, approval_note, created_at, managed }.
export function fromListRepositories(reply: unknown): Repo[] {
  const list = Array.isArray(reply) ? reply : isObj(reply) && Array.isArray(reply.repositories) ? reply.repositories : [];
  return list
    .filter(isObj)
    .flatMap((r): Repo[] => {
      const repository = str(r.repository);
      if (!repository || !REPOSITORY.test(repository) || r.managed === true) return [];
      return [{ repository, approval: approvalOf(r.approval), note: str(r.approval_note), connectedAt: str(r.created_at) }];
    });
}

// connect_repository's answer, as the studio shows it.
export type ConnectResult =
  | { kind: "install"; repository: string; installUrl: string | null; next: string | null } // the GitHub App isn't on it yet
  | { kind: "approved"; repository: string }
  | { kind: "pending" | "rejected"; repository: string; why: string | null; manageUrl: string | null };

export function fromConnectRepository(reply: unknown, repository: string): ConnectResult {
  const r = isObj(reply) ? reply : {};
  if (r.connected === false) return { kind: "install", repository, installUrl: httpsUrl(r.install_url), next: str(r.next) };
  const approval = approvalOf(r.approval);
  if (approval === "approved") return { kind: "approved", repository };
  return { kind: approval, repository, why: str(r.why), manageUrl: httpsUrl(r.manage_url) };
}

export function connectResultText(c: ConnectResult): string {
  if (c.kind === "install") return `Install Mynt's GitHub App on ${c.repository} first, then connect it again.`;
  if (c.kind === "approved") return `${c.repository} is connected and approved: builds can push to it now.`;
  if (c.kind === "rejected") return `${c.repository} is connected, but an admin rejected access to it.${c.why ? ` ${c.why}.` : ""}`;
  return `${c.repository} is connected and sent to an admin for approval.${c.why ? ` Why: ${c.why}.` : ""}`;
}
