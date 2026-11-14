// Workspaces: everything in the studio (the dashboard, the sidebar's apps, members) is scoped to
// the workspace picked in the sidebar's switcher. Pure, so routes, pages and tests share it.
//
// Until Mynt offers workspaces (list_workspaces), the user has one implicit "Personal"
// workspace holding all their apps, and an app's stage is derived from its status and last
// build.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];
// Roles that can be given by invite or role change (ownership isn't handed over from here).
export const ASSIGNABLE_ROLES = ["admin", "member"] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

// `personal`: the user's own workspace on Mynt (where their apps go unless they pick another).
// The rest is what list_workspaces says about it, when it says so (the Workspace page's card):
// when it was made, how many members and apps it has, and whether it's archived (an owner can
// undo that until `offboardingAt`) or frozen because its organization was deleted.
export type Workspace = {
  id: string;
  name: string;
  role: Role;
  implicit?: boolean;
  personal?: boolean;
  createdAt?: string;
  memberCount?: number;
  appCount?: number;
  archivedAt?: string;
  offboardingAt?: string;
  orgMissingSince?: string;
};

export const PERSONAL_ID = "personal";
export const PERSONAL: Workspace = { id: PERSONAL_ID, name: "Personal", role: "owner", implicit: true };

// The cookie that remembers the selected workspace (not a credential: Mynt checks membership on
// every call). __Host-: set only by this origin, over https, for the whole site.
export const WORKSPACE_COOKIE = "__Host-mynt_workspace";
export const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,100}$/;

const role = (v: unknown): Role => (ROLES.includes(v as Role) ? (v as Role) : "member");

// list_workspaces' reply: an array, or { workspaces: [...] }.
export function fromListWorkspaces(reply: unknown): Workspace[] {
  const list = Array.isArray(reply) ? reply : isObj(reply) && Array.isArray(reply.workspaces) ? reply.workspaces : [];
  return list.filter(isObj).flatMap((w) => {
    const id = str(w.id) ?? str(w.workspace_id);
    if (!id || !WORKSPACE_ID.test(id)) return [];
    const personal = w.personal === true || w.kind === "personal" || w.type === "personal";
    const extra: Partial<Workspace> = {};
    if (str(w.created_at)) extra.createdAt = str(w.created_at);
    if (countOf(w.members) !== undefined) extra.memberCount = countOf(w.members);
    if (countOf(w.apps) !== undefined) extra.appCount = countOf(w.apps);
    if (str(w.archived_at)) extra.archivedAt = str(w.archived_at);
    if (str(w.offboarding_at)) extra.offboardingAt = str(w.offboarding_at);
    if (str(w.org_missing_since)) extra.orgMissingSince = str(w.org_missing_since);
    return [{ id, name: str(w.name) ?? "Untitled workspace", role: role(w.role ?? w.my_role), ...(personal ? { personal } : {}), ...extra }];
  });
}

const countOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);

// The workspace to show: the remembered one if it's still the user's, else their own, else the
// first.
export function selectWorkspace(workspaces: Workspace[], remembered: string | null | undefined): Workspace {
  return workspaces.find((w) => w.id === remembered) ?? workspaces.find((w) => w.personal) ?? workspaces[0] ?? PERSONAL;
}

export const canManageMembers = (r: Role | undefined) => r === "owner" || r === "admin";

// --- stages ------------------------------------------------------------------------------------

export const STAGES = ["production", "staging", "idea"] as const;
export type Stage = (typeof STAGES)[number];
export const STAGE_LABELS: Record<Stage, string> = { production: "Production", staging: "Staging", idea: "Ideas" };

// An app's stage: Mynt's `stage` when it gives one; until then, from the app's status and last
// build (published: production; a build that succeeded or has a preview: staging; else an idea).
export function stageOf(app: { stage?: unknown; status?: unknown }, lastBuild?: { status?: string; previewUrl?: string | null } | null): Stage {
  if (STAGES.includes(app.stage as Stage)) return app.stage as Stage;
  if (app.status === "published") return "production";
  if (lastBuild && (lastBuild.status === "succeeded" || lastBuild.previewUrl)) return "staging";
  return "idea";
}

export type StagedApp = { id: string; name: string; stage: Stage };

export function groupByStage(apps: StagedApp[]): Record<Stage, StagedApp[]> {
  const out: Record<Stage, StagedApp[]> = { production: [], staging: [], idea: [] };
  for (const a of apps) out[a.stage].push(a);
  for (const s of STAGES) out[s].sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// --- members -----------------------------------------------------------------------------------

export type Member = { userId: string; name: string | null; email: string | null; role: Role; joinedAt?: string };
export type Invite = { id: string; email: string; role: Role; expiresAt: string | null; sentAt?: string };

// The identity provider's page for managing the workspace's organization: https only.
export function safeManageUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

// list_workspace_members' reply: { members: [...], open_invites: [...] (owners and admins only),
// manage_url? }. `invites` is read too.
export function fromListMembers(reply: unknown): { members: Member[]; invites: Invite[]; manageUrl: string | null } {
  const r = isObj(reply) ? reply : {};
  const members = (Array.isArray(r.members) ? r.members : []).filter(isObj).flatMap((m) => {
    const userId = str(m.user_id) ?? str(m.id);
    const joinedAt = str(m.joined_at);
    return userId ? [{ userId, name: str(m.name) ?? null, email: str(m.email) ?? null, role: role(m.role), ...(joinedAt ? { joinedAt } : {}) }] : [];
  });
  const rawInvites = Array.isArray(r.open_invites) ? r.open_invites : Array.isArray(r.invites) ? r.invites : [];
  const invites = rawInvites.filter(isObj).flatMap((i) => {
    const id = str(i.id) ?? str(i.invite_id);
    const email = str(i.email);
    const sentAt = str(i.created_at);
    return id && email ? [{ id, email, role: role(i.role), expiresAt: str(i.expires_at) ?? null, ...(sentAt ? { sentAt } : {}) }] : [];
  });
  return { members, invites, manageUrl: safeManageUrl(r.manage_url) };
}
