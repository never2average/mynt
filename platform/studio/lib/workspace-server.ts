import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callStudioTool, listMyntTools } from "./studio-server";
import { fromListWorkspaces, PERSONAL, PERSONAL_ID, WORKSPACE_COOKIE, WORKSPACE_ID, type Workspace } from "./workspaces";

// What this Mynt offers for workspaces, read from its tool list. Each part is used only once
// Mynt has it; until then the studio has one implicit Personal workspace.
export type WorkspaceSupport = {
  workspaces: boolean; // list_workspaces and the members tools
  appsByWorkspace: boolean; // list_my_apps takes workspace_id
  dashboardByWorkspace: boolean; // get_developer_dashboard takes workspace_id
  buildsByWorkspace: boolean; // list_builds takes workspace_id (teammates' builds too)
  createByWorkspace: boolean; // create_app takes workspace_id
  invitations: boolean; // list_my_invitations, accept_workspace_invite and decline_workspace_invite
};

type Tool = { name: string; inputSchema?: unknown };
const takes = (tools: Tool[], name: string, arg: string) => {
  const schema = tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, unknown> } | undefined;
  return Boolean(schema?.properties && arg in schema.properties);
};

export function workspaceSupport(tools: Tool[]): WorkspaceSupport {
  return {
    workspaces: tools.some((t) => t.name === "list_workspaces"),
    appsByWorkspace: takes(tools, "list_my_apps", "workspace_id"),
    dashboardByWorkspace: takes(tools, "get_developer_dashboard", "workspace_id"),
    buildsByWorkspace: takes(tools, "list_builds", "workspace_id"),
    createByWorkspace: takes(tools, "create_app", "workspace_id"),
    invitations: ["list_my_invitations", "accept_workspace_invite", "decline_workspace_invite"].every((n) => tools.some((t) => t.name === n)),
  };
}

// The workspace a request is about: ?workspace=<id>, else the one the switcher remembered (its
// cookie); null for the implicit Personal one. Mynt checks membership on every call.
export function workspaceParam(url: URL, remembered?: string | null): string | null {
  const id = url.searchParams.get("workspace") ?? remembered ?? null;
  return id && id !== PERSONAL_ID && WORKSPACE_ID.test(id) ? id : null;
}

export function workspaceOf(req: Request): string | null {
  const cookie = (req.headers.get("cookie") ?? "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${WORKSPACE_COOKIE}=`))
    ?.slice(WORKSPACE_COOKIE.length + 1);
  let remembered: string | null = null;
  try {
    remembered = cookie ? decodeURIComponent(cookie) : null;
  } catch {
    remembered = null;
  }
  return workspaceParam(new URL(req.url), remembered);
}

// The user's workspaces, as Mynt lists them, or the implicit Personal one.
export async function loadWorkspaces(mynt: Client, support: WorkspaceSupport): Promise<Workspace[]> {
  if (!support.workspaces) return [PERSONAL];
  const list = fromListWorkspaces(await callStudioTool(mynt, "list_workspaces"));
  return list.length ? list : [PERSONAL];
}

export async function supportOf(mynt: Client): Promise<WorkspaceSupport> {
  return workspaceSupport(await listMyntTools(mynt));
}

// The workspace a request may be scoped to: the one asked for (or remembered) if it's still one
// of the user's, else null, the implicit Personal workspace. A cookie naming a workspace the user
// has left falls back quietly to Personal instead of Mynt refusing the call.
export async function resolveWorkspace(mynt: Client, requested: string | null, support: WorkspaceSupport): Promise<string | null> {
  if (!requested || !support.workspaces) return null;
  const mine = await loadWorkspaces(mynt, support);
  return mine.some((w) => w.id === requested && !w.implicit) ? requested : null;
}

// The user's own workspace on Mynt (list_workspaces marks it personal), if Mynt has one.
export async function ownWorkspace(mynt: Client, support: WorkspaceSupport): Promise<string | null> {
  if (!support.workspaces) return null;
  return (await loadWorkspaces(mynt, support)).find((w) => w.personal && !w.implicit)?.id ?? null;
}

// What a shared workspace's page says when this Mynt can't scope that data to it yet. The studio
// never shows the user's unscoped data under a workspace's name.
export const NOT_SCOPED = "This workspace's data comes with Mynt's next update. Your Personal workspace still shows everything.";
