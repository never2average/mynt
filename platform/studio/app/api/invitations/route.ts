import { fromInvitations } from "@/lib/invitations";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { supportOf } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// The user's pending invitations to other people's workspaces (list_my_invitations), for the
// dashboard's banner and the switcher's Invitations entry. Empty until Mynt has the tools.
export async function GET() {
  return asDeveloper("loading invitations", async (mynt) => {
    const support = await supportOf(mynt);
    if (!support.invitations) return json({ supported: false, invitations: [] });
    return json({ supported: true, invitations: fromInvitations(await callStudioTool(mynt, "list_my_invitations")) });
  });
}
