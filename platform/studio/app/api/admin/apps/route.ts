import { appsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Apps: every app across all workspaces (list_all_apps), the newest 500; the tab searches, filters and pages them.
export async function GET() {
  return asAdmin("reading every app", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_all_apps"))) return json(UNSUPPORTED);
    const page = appsFrom(await callAdminTool(mynt, session, "list_all_apps", { limit: 500 }));
    return page ? json({ apps: page.rows, total: page.total }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
