import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callStudioTool, listMyntTools } from "./studio-server";
import { asDeveloper, json } from "./studio-route";
import { NOT_SCOPED, scopeFor, workspaceSupport } from "./workspace-server";

type Tool = { name: string; inputSchema?: unknown };
export const takes = (tool: Tool | undefined, arg: string) => {
  const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && arg in props);
};

// A compliance page's read (Coverage, Licences, Audits): one Mynt tool, for the selected
// workspace. `supported: false` until this Mynt has the tool; `unavailable` for a workspace that
// isn't the user's any more, or a shared one the tool can't be scoped to yet (never the user's
// unscoped data under its name). `answer` is told what the tool takes, for arguments only newer
// Mynts accept (the Audits page's `class`).
export function complianceRead(
  req: Request,
  tool: "get_compliance_coverage" | "list_workspace_licences" | "list_workspace_audit",
  what: string,
  answer: (reply: unknown, found: Tool) => Record<string, unknown>,
  args: Record<string, unknown> | ((found: Tool) => Record<string, unknown> | null) = {},
) {
  return asDeveloper(what, async (mynt: Client) => {
    const tools = await listMyntTools(mynt);
    const found = tools.find((t) => t.name === tool);
    if (!found) return json({ supported: false });
    // null: this Mynt's tool can't answer what was asked yet.
    const given = typeof args === "function" ? args(found) : args;
    if (given === null) return json({ supported: false });
    const scope = await scopeFor(mynt, req, workspaceSupport(tools));
    if (scope.unavailable !== undefined) return json({ supported: true, unavailable: scope.unavailable });
    const { workspace } = scope;
    if (workspace && !takes(found, "workspace_id")) return json({ supported: true, unavailable: NOT_SCOPED });
    // The caller's filters first, so the workspace always wins.
    const reply = await callStudioTool(mynt, tool, { ...given, ...(workspace ? { workspace_id: workspace } : {}) });
    return json({ supported: true, ...answer(reply, found) });
  });
}
