import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callStudioTool, listMyntTools } from "./studio-server";
import { fromListWorkspaces, PERSONAL, PERSONAL_ID, WORKSPACE_COOKIE, WORKSPACE_ID, type Workspace } from "./workspaces";

// What this Mynt offers for workspaces, read from its tool list. Each part is used only once
// Mynt has it; until then the studio has one implicit Personal workspace.
export type WorkspaceSupport = {
  workspaces: boolean; // list_workspaces and the members tools
  appsByWorkspace: boolean; // list_my_apps takes workspace_id
  dashboardByWorkspace: boolean; // get_developer_dashboard takes workspace_id
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
  };
}

// The workspace a request is about: ?workspace=<id>, else the one the switcher remembered (its
// cookie); null for the implicit Personal one. Mynt checks membership on every call.
export function workspaceParam(url: URL, remembered?: string | null): string | null {
  const id = url.searchParams.get("workspace") ?? remembered ?? null;
  return id && id !== PERSONAL_ID && WORKSPACE_ID.test(id) ? id : null;
}

export function workspaceOf(req: { nextUrl: URL; cookies: { get(name: string): { value: string } | undefined } }): string | null {
  return workspaceParam(req.nextUrl, req.cookies.get(WORKSPACE_COOKIE)?.value);
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
