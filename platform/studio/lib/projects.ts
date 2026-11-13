import { stageOf } from "./workspaces";
import type { ProjectConversationSummary, ProjectItem } from "./project-types";

// Turns Mynt's replies (list_my_apps, list_builds) into the studio's projects. Pure, so the
// route and the tests share it.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);

// A preview URL the studio will put in an iframe: https only (http only for localhost, in local
// development). Anything else (javascript:, data:, a malformed value) is dropped.
export function safePreviewUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) return url.toString();
  return null;
}

// A build's preview: the live one while the agent is coding, when Mynt reports one; otherwise
// the one Mynt made when it verified the build.
export function buildPreviewUrl(build: Obj): string | null {
  return safePreviewUrl(build.live_preview_url) ?? safePreviewUrl(build.preview_url);
}

function conversation(build: Obj): ProjectConversationSummary | null {
  const id = str(build.id);
  if (!id) return null;
  const goal = str(build.goal).trim().replace(/\s+/g, " ");
  return {
    id,
    title: goal.slice(0, 80) || "Untitled build",
    status: str(build.status, "unknown"),
    phaseMessage: typeof build.phase_message === "string" ? build.phase_message : null,
    previewUrl: buildPreviewUrl(build),
    createdAt: str(build.created_at),
    updatedAt: str(build.updated_at, str(build.created_at)),
  };
}

const newestFirst = (a: { updatedAt: string }, b: { updatedAt: string }) => b.updatedAt.localeCompare(a.updatedAt);

export function toProjects(appsReply: unknown, buildsReply: unknown): ProjectItem[] {
  const apps = Array.isArray(appsReply) ? appsReply.filter(isObj) : [];
  const builds = isObj(buildsReply) && Array.isArray(buildsReply.builds) ? buildsReply.builds.filter(isObj) : [];

  const byApp = new Map<string, ProjectConversationSummary[]>();
  for (const b of builds) {
    const appId = str(b.app_id);
    const c = conversation(b);
    if (!appId || !c) continue;
    byApp.set(appId, [...(byApp.get(appId) ?? []), c]);
  }

  return apps
    .filter((a) => str(a.id))
    .map((a) => {
      const conversations = (byApp.get(str(a.id)) ?? []).sort(newestFirst);
      return {
        id: str(a.id),
        name: str(a.name, "Untitled app") || "Untitled app",
        description: str(a.description),
        status: str(a.status, "draft"),
        stage: stageOf(a, conversations[0] ?? null),
        previewUrl: conversations.find((c) => c.previewUrl)?.previewUrl ?? null,
        conversations,
        updatedAt: str(a.updated_at),
      };
    })
    .sort(newestFirst)
    .map(({ updatedAt: _updatedAt, ...project }) => project);
}
