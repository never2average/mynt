import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { callStudioTool, listMyntTools } from "./studio-server";
import { asDeveloper, json } from "./studio-route";
import { NOT_SCOPED, resolveWorkspace, workspaceOf, workspaceSupport } from "./workspace-server";

type Tool = { name: string; inputSchema?: unknown };
const takesWorkspace = (tool: Tool | undefined) => {
  const props = (tool?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return Boolean(props && "workspace_id" in props);
};

// A compliance page's read (Coverage, Licences, Audits): one Mynt tool, for the selected
// workspace. `supported: false` until this Mynt has the tool; `unavailable` for a shared
// workspace the tool can't be scoped to yet (never the user's unscoped data under its name).
export function complianceRead(
  req: Request,
  tool: "get_compliance_coverage" | "list_workspace_licences" | "list_workspace_audit",
  what: string,
  answer: (reply: unknown) => Record<string, unknown>,
  args: Record<string, unknown> = {},
) {
  const requested = workspaceOf(req);
  return asDeveloper(what, async (mynt: Client) => {
    const tools = await listMyntTools(mynt);
    const found = tools.find((t) => t.name === tool);
    if (!found) return json({ supported: false });
    const workspace = await resolveWorkspace(mynt, requested, workspaceSupport(tools));
    if (workspace && !takesWorkspace(found)) return json({ supported: true, unavailable: NOT_SCOPED });
    const reply = await callStudioTool(mynt, tool, { ...(workspace ? { workspace_id: workspace } : {}), ...args });
    return json({ supported: true, ...answer(reply) });
  });
}
