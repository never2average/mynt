import { appKindsFrom } from "@/lib/new-app";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// New app's templates: Mynt's app kinds (list_app_kinds), each with the app ideas on it from Mynt's database
// (list_app_ideas). A Mynt without kinds has none, and New app starts from a blank prompt; one without ideas yet
// (not seeded, or older) gives the kinds alone, and New app offers those.
export async function GET() {
  return asDeveloper("loading templates", async (mynt) => {
    const tools = new Set((await listMyntTools(mynt)).map((t) => t.name));
    if (!tools.has("list_app_kinds")) return json({ kinds: [] });
    const [kinds, ideas] = await Promise.all([
      callStudioTool(mynt, "list_app_kinds", {}),
      tools.has("list_app_ideas") ? callStudioTool(mynt, "list_app_ideas", {}) : Promise.resolve(null),
    ]);
    return json({ kinds: appKindsFrom(kinds, ideas) });
  });
}
