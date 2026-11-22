import { appKindsFrom } from "@/lib/new-app";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// New app's templates: Mynt's app kinds (list_app_kinds). A Mynt without them has none, and New app
// starts from a blank prompt.
export async function GET() {
  return asDeveloper("loading templates", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "list_app_kinds")) return json({ kinds: [] });
    return json({ kinds: appKindsFrom(await callStudioTool(mynt, "list_app_kinds", {})) });
  });
}
