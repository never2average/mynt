import { z } from "zod";
import { fromInvitations, INVITATION_ID } from "@/lib/invitations";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { supportOf } from "@/lib/workspace-server";
import { WORKSPACE_ID } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ inviteId: string }> };
const Answer = z.object({ action: z.enum(["accept", "decline"]) }).strict();

// Accept or decline one invitation: only ever the user's explicit choice, from this origin.
// Accepting answers the workspace joined, so the studio can switch to it.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { inviteId } = await params;
  if (!INVITATION_ID.test(inviteId)) return json({ error: "bad_request" }, 400);
  const parsed = Answer.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Accept or decline the invitation." }, 400);
  const { action } = parsed.data;

  return asDeveloper(`${action === "accept" ? "accepting" : "declining"} an invitation`, async (mynt) => {
    const support = await supportOf(mynt);
    if (!support.invitations) return json({ error: "unsupported", message: "Workspace invitations come with Mynt's next update." }, 501);
    // Only an invitation that's the user's and still pending (Mynt checks again).
    const mine = fromInvitations(await callStudioTool(mynt, "list_my_invitations")).find((i) => i.id === inviteId);
    if (!mine) return json({ error: "not_found", message: "That invitation isn't open any more." }, 404);
    if (action === "decline") {
      await callStudioTool(mynt, "decline_workspace_invite", { invite_id: inviteId });
      return json({ ok: true });
    }
    const reply = (await callStudioTool(mynt, "accept_workspace_invite", { invite_id: inviteId })) as { workspace_id?: unknown; workspace?: { id?: unknown } } | null;
    const joined = [reply?.workspace_id, reply?.workspace?.id, mine.workspaceId].find((v): v is string => typeof v === "string" && WORKSPACE_ID.test(v));
    return json({ ok: true, workspaceId: joined ?? null });
  });
}
