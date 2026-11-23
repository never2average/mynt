import { opsFrom } from "@/lib/admin";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Overview: what needs attention across Mynt (ops_status), over the last `hours` (24 by default).
export async function GET(req: Request) {
  const raw = Number(new URL(req.url).searchParams.get("hours") ?? 24);
  const hours = Number.isInteger(raw) && raw >= 1 && raw <= 720 ? raw : 24;
  return asAdmin("reading what needs attention", async (mynt, session) => {
    if (!(await hasTools(mynt, "ops_status"))) return json(UNSUPPORTED);
    const ops = opsFrom(await callAdminTool(mynt, session, "ops_status", { hours }));
    return ops ? json({ ops }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
