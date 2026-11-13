import { z } from "zod";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { loadWorkspaces, supportOf } from "@/lib/workspace-server";
import { fromListWorkspaces } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

// The user's workspaces, for the sidebar's switcher. `supported` says whether Mynt has
// workspaces yet; until it does, there's one implicit Personal workspace.
export async function GET() {
  return asDeveloper("loading workspaces", async (mynt) => {
    const support = await supportOf(mynt);
    return json({ workspaces: await loadWorkspaces(mynt, support), supported: support.workspaces });
  });
}

const Create = z.object({ name: z.string().trim().min(1, "Name the workspace.").max(80) }).strict();

// Create workspace (from the switcher).
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Create.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Name the workspace." }, 400);
  return asDeveloper("creating a workspace", async (mynt) => {
    const support = await supportOf(mynt);
    if (!support.workspaces) return json({ error: "unsupported", message: "Workspaces come with Mynt's next update. For now, everything is in your Personal workspace." }, 501);
    const created = await callStudioTool(mynt, "create_workspace", { name: parsed.data.name });
    const [workspace] = fromListWorkspaces([created]);
    return json({ workspace: workspace ? { ...workspace, role: "owner" } : null }, 201);
  });
}
