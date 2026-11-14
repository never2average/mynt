import { z } from "zod";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { loadWorkspaces, workspaceSupport } from "@/lib/workspace-server";
import { canManageMembers, PERSONAL, WORKSPACE_ID } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ workspaceId: string }> };

const UNSUPPORTED = "Workspace settings come with Mynt's workspaces. For now, your Personal workspace is yours alone.";
const NOT_YOURS = "That workspace isn't one of yours.";

// The Settings tab's tools, offered only where this Mynt lists them (archiving and relinking
// come with a later Mynt update).
const SETTINGS_TOOLS = { rename: "rename_workspace", archive: "archive_workspace", unarchive: "unarchive_workspace", relink: "relink_workspace_org" } as const;
type SettingsTool = keyof typeof SETTINGS_TOOLS;

// GET: the workspace as list_workspaces describes it, the user's role, and which settings this
// Mynt offers.
export async function GET(_req: Request, { params }: Params) {
  const { workspaceId } = await params;
  if (!WORKSPACE_ID.test(workspaceId)) return json({ error: "bad_request" }, 400);
  return asDeveloper("loading a workspace", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const support = workspaceSupport(tools);
    if (!support.workspaces) return json({ supported: false, message: UNSUPPORTED, workspace: PERSONAL, tools: {} });
    const workspace = (await loadWorkspaces(mynt, support)).find((w) => w.id === workspaceId && !w.implicit);
    if (!workspace) return json({ error: "not_found", message: NOT_YOURS }, 404);
    const offered = Object.fromEntries(
      (Object.keys(SETTINGS_TOOLS) as SettingsTool[]).map((k) => [k, tools.some((t) => t.name === SETTINGS_TOOLS[k])]),
    ) as Record<SettingsTool, boolean>;
    return json({ supported: true, workspace, canManage: canManageMembers(workspace.role), isOwner: workspace.role === "owner", tools: offered });
  });
}

const Rename = z.object({ name: z.string().trim().min(1, "Name the workspace.").max(80) }).strict();
const Action = z.object({ action: z.enum(["archive", "unarchive", "relink"]) }).strict();

async function change(req: Request, params: Params["params"], what: string, tool: SettingsTool, ownersOnly: boolean, args: Record<string, unknown>) {
  const { workspaceId } = await params;
  if (!WORKSPACE_ID.test(workspaceId)) return json({ error: "bad_request" }, 400);
  return asDeveloper(what, async (mynt) => {
    const tools = await listMyntTools(mynt);
    const support = workspaceSupport(tools);
    if (!support.workspaces) return json({ error: "unsupported", message: UNSUPPORTED }, 501);
    if (!tools.some((t) => t.name === SETTINGS_TOOLS[tool])) return json({ error: "unsupported", message: "That comes with Mynt's next update." }, 501);
    const workspace = (await loadWorkspaces(mynt, support)).find((w) => w.id === workspaceId && !w.implicit);
    if (!workspace) return json({ error: "not_found", message: NOT_YOURS }, 404);
    const allowed = ownersOnly ? workspace.role === "owner" : canManageMembers(workspace.role);
    if (!allowed) return json({ error: "not_allowed", message: ownersOnly ? "Only the workspace's owners can do that." : "Only the workspace's owners and admins can rename it." }, 403);
    await callStudioTool(mynt, SETTINGS_TOOLS[tool], { workspace_id: workspaceId, ...args });
    return json({ ok: true });
  });
}

// PATCH: rename (owners and admins).
export async function PATCH(req: Request, ctx: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const p = Rename.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: "bad_request", message: p.error.issues[0]?.message ?? "Name the workspace." }, 400);
  return change(req, ctx.params, "renaming a workspace", "rename", false, { name: p.data.name });
}

// POST: archive (undoable for 7 days), unarchive, or give it a new organization (owners only).
export async function POST(req: Request, ctx: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const p = Action.safeParse(await req.json().catch(() => null));
  if (!p.success) return json({ error: "bad_request", message: "Say what to do." }, 400);
  return change(req, ctx.params, `${p.data.action} a workspace`, p.data.action, true, {});
}
