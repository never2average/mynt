import { z } from "zod";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { settingsFrom } from "@/lib/platform-settings";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Platform admin → Platform settings → Operational settings. GET: the non-secret settings this Mynt runs with
// (get_platform_settings): each one's value, default, where the value comes from and how a new one is checked; no
// secret is ever among them. POST: Change setting (set_platform_setting with the new value, or null for Mynt's
// default). Same origin, signed in, and an account Mynt says is an admin, or 404; Mynt checks the role, the type and
// the range again, its refusal the message. The server's environment, where it sets a setting, keeps winning.
const SettingChange = z.object({ key: ADMIN_TOOLS.set_platform_setting.shape.key, value: ADMIN_TOOLS.set_platform_setting.shape.value }).strict();

export async function GET() {
  return asAdmin("reading the platform settings", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_platform_settings"))) return json(UNSUPPORTED);
    const settings = settingsFrom(await callAdminTool(mynt, session, "get_platform_settings", {}));
    // An older Mynt lists the settings but can't change them: the page then shows them without Change setting.
    return settings ? json({ settings, editable: await hasTools(mynt, "set_platform_setting") }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, SettingChange);
  if (!w.ok) return w.res;
  const change = w.body;
  return asAdmin("changing an operational setting", async (mynt, session) => {
    if (!(await hasTools(mynt, "set_platform_setting"))) return json({ error: "unsupported", message: "Changing settings here comes with Mynt's next update." }, 422);
    const reply = (await callAdminTool(mynt, session, "set_platform_setting", { key: change.key, value: change.value })) as { message?: string } | null;
    return json({ ok: true, message: typeof reply?.message === "string" ? reply.message : `${change.key} is changed.` });
  });
}
