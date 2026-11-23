import { settingsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Platform settings: the operational settings this Mynt runs with (get_platform_settings), read-only. They're
// changed on the server, never from here; no secret is ever among them.
export async function GET() {
  return asAdmin("reading the platform settings", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_platform_settings"))) return json(UNSUPPORTED);
    const settings = settingsFrom(await callAdminTool(mynt, session, "get_platform_settings", {}));
    return settings ? json({ settings }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
