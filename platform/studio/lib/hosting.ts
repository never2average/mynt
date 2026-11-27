// Put online: hosting an app's verified build on Mynt from the studio, as pure functions for the
// route (app/api/apps/[appId]/hosting), the app's top bar and the tests. Mynt's tools do the work:
// hosting_status (the workspace's hosting and the apps it runs), request_hosting (turning the
// workspace's hosting on, owners and admins only; asking again is harmless) and deploy_app (one app,
// from one build Mynt verified and pushed). The app's Mynt key is added at Mynt's edge to the app's
// calls, never stored on the app's machine.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** An https address, or null (anything else Mynt might send is never shown as a link). */
export function httpsAddress(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? s : null;
  } catch {
    return null;
  }
}

export const shortCommit = (sha: string | null) => (sha ? sha.slice(0, 7) : null);

/** Where the app stands on Mynt's hosting: the app top bar's state. */
export type OnlineState = "online" | "deploying" | "not_online";
export const ONLINE_LABELS: Record<OnlineState, string> = { online: "Online", deploying: "Deploying", not_online: "Not online" };
export const ONLINE_TONE: Record<OnlineState, "green" | "amber" | "gray"> = { online: "green", deploying: "amber", not_online: "gray" };

export type AppOnline = {
  state: OnlineState;
  /** The app's public address once it has one (or its first service's, for a compose app). */
  url: string | null;
  /** The build and commit it runs (or is being deployed from). */
  buildId: string | null;
  commitSha: string | null;
  /** Why it stopped, in Mynt's words (the end of its deploy log), when it did. */
  error: string | null;
};

export type WorkspaceHosting = {
  /** Whether the workspace's hosting is on (Mynt has a tenant for it). */
  on: boolean;
  /** Its status as Mynt says it (running, provisioning, suspended, failed...), when on. */
  status: string | null;
  app: AppOnline;
};

const NOT_ONLINE: AppOnline = { state: "not_online", url: null, buildId: null, commitSha: null, error: null };

const MAX_ERROR = 600;
const cleanError = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const clean = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim();
  return clean.length > MAX_ERROR ? `…${clean.slice(-MAX_ERROR)}` : clean;
};

/** hosting_status's reply, for one app: { tenant, apps: [{ app_id, status, build_id, commit_sha, url, services, error }] }. */
export function fromHostingStatus(reply: unknown, appId: string): WorkspaceHosting {
  const r = isObj(reply) ? reply : {};
  const tenant = isObj(r.tenant) ? r.tenant : null;
  const apps = Array.isArray(r.apps) ? r.apps.filter(isObj) : [];
  const h = apps.find((a) => a.app_id === appId);
  if (!h) return { on: !!tenant, status: tenant ? str(tenant.status) : null, app: NOT_ONLINE };
  const services = Array.isArray(h.services) ? h.services.filter(isObj) : [];
  const url = httpsAddress(h.url) ?? services.map((s) => httpsAddress(s.url)).find((u) => u !== null) ?? null;
  const status = str(h.status);
  const state: OnlineState = status === "running" ? "online" : status === "deploying" ? "deploying" : "not_online";
  return {
    on: !!tenant,
    status: tenant ? str(tenant.status) : null,
    app: { state, url: state === "online" ? url : null, buildId: str(h.build_id), commitSha: str(h.commit_sha), error: state === "not_online" ? cleanError(h.error) : null },
  };
}

/** The build Put online hosts: the app's newest build that Mynt verified (succeeded). */
export type ShippedBuild = {
  id: string;
  goal: string | null;
  /** owner/name, or null when the build pushed nowhere (no repository was set for the app then). */
  repository: string | null;
  commitSha: string | null;
  branch: string | null;
  finishedAt: string | null;
};

const REPO = /^[\w.-]+\/[\w.-]+$/;
export function toShippedBuild(b: unknown): ShippedBuild | null {
  if (!isObj(b) || b.status !== "succeeded") return null;
  const id = str(b.id);
  if (!id) return null;
  const repository = str(b.repository);
  return {
    id,
    goal: str(b.goal),
    repository: repository && REPO.test(repository) ? repository : null,
    commitSha: str(b.commit_sha),
    branch: str(b.branch),
    finishedAt: str(b.updated_at) ?? str(b.created_at),
  };
}

/** list_builds' reply ({ builds: [...] }): this app's newest succeeded build. */
export function latestShippedBuild(listBuildsReply: unknown, appId: string): ShippedBuild | null {
  const builds = isObj(listBuildsReply) && Array.isArray(listBuildsReply.builds) ? listBuildsReply.builds.filter(isObj) : [];
  const mine = builds.filter((b) => b.app_id === appId && b.status === "succeeded");
  mine.sort((a, b) => String(b.updated_at ?? b.created_at ?? "").localeCompare(String(a.updated_at ?? a.created_at ?? "")));
  return toShippedBuild(mine[0]);
}

/** Whether Mynt can host this build: it pushed a verified commit to a repository. */
export const deployable = (b: ShippedBuild | null): b is ShippedBuild & { repository: string; commitSha: string } => !!b?.repository && !!b.commitSha;

/** What the sheet's confirm button says: put it online, or move it on to a newer build. */
export function putOnlineLabel(online: AppOnline, build: ShippedBuild | null): string {
  if (online.state !== "not_online" && build && online.buildId && online.buildId !== build.id) return "Put the new build online";
  return "Put online";
}

/** Whether the app already runs (or is being deployed from) exactly this build. */
export const runsBuild = (online: AppOnline, build: ShippedBuild | null) => !!build && online.state !== "not_online" && online.buildId === build.id;

/** The sheet's words for a build that pushed nowhere: what's missing, and exactly what's needed. */
export const NO_REPOSITORY =
  "This build wasn't saved to a repository, so Mynt has no commit to host. Choose a repository for the app below: Mynt pushes the app's next build there. Then send the coding agent a message (or press Ship on a session); once Mynt has verified that new build, Put online hosts it. This build can't be put online itself, because its code was never pushed anywhere.";

/** The sheet's words for what Put online does. */
export const WHAT_HAPPENS = [
  "Mynt's hosting fetches exactly this commit, builds it and starts it on the app's own machine.",
  "The app gets its own public address, shown here once it answers.",
  "The app's Mynt key is added at Mynt's edge to the app's calls to Mynt. It is never stored on the app's machine.",
  "The app uses a sandbox key until it's in Production and published.",
];

/** Turning on the workspace's hosting is for its owners and admins. */
export const canTurnOnHosting = (role: string | null | undefined) => role === "owner" || role === "admin";
export const MEMBERS_HOSTING =
  "Your workspace's hosting isn't on yet. An owner or admin turns it on, by putting one of its apps online here; then any member can put apps in Ideas and Staging online (in Production, owners and admins).";

/**
 * In Production, what is online is the workspace's owners' and admins' to change (Mynt refuses anyone
 * else, and records the attempt). In Idea and Staging any member puts a build online.
 */
export const canPutOnline = (stage: string | null | undefined, role: string | null | undefined) => stage !== "production" || role === "owner" || role === "admin";
export const PRODUCTION_OWNERS_ONLY =
  "This is in Production: only the workspace's owners and admins put a build online there. Ask one of them. In Idea and Staging any member of the workspace can.";
/** What Put online adds for an app in Production, said before the click. */
export const PRODUCTION_CHECKS =
  "This is in Production, so Mynt puts the build online only if it passes the production checks about the build: Mynt verified it, its independent audit passed, it has no open critical or high findings and, when the app moves value, a Mynt admin signed off this build. If one fails, Mynt says which here, and the build that is online stays.";

/** How often the sheet and top bar ask Mynt again while the app is being deployed. */
export const POLL_MS = 5000;
