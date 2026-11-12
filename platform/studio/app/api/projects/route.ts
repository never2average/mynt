import { toProjects } from "@/lib/projects";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// The signed-in developer's projects: their Mynt apps, each with its builds and previews. Read
// from Mynt on every load; the studio keeps no copy.
export async function GET() {
  return asDeveloper("loading projects", async (mynt) => {
    const [apps, builds] = await Promise.all([callStudioTool(mynt, "list_my_apps"), callStudioTool(mynt, "list_builds")]);
    return json({ projects: toProjects(apps, builds) });
  });
}
