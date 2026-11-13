import { fromLinkedAccounts, NOT_LINKED } from "@/lib/linked-accounts";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The user's linked GitHub and wallets, for the dashboard's tiles (get_linked_accounts, where
// Mynt offers it; otherwise nothing linked and no link to manage them yet).
export async function GET() {
  return asDeveloper("loading linked accounts", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "get_linked_accounts")) return json({ linked: NOT_LINKED });
    return json({ linked: fromLinkedAccounts(await callStudioTool(mynt, "get_linked_accounts")) });
  });
}
