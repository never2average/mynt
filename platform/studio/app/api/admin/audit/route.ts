import { z } from "zod";
import { firmsFrom, workspacesFrom } from "@/lib/admin";
import { AUDIT_LIMIT, auditEntriesFrom, type AuditNames } from "@/lib/admin-audit";
import { hasTools, UNSUPPORTED } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Audit trails: Mynt's audit log across every workspace and firm (audit_log), the newest 500 entries, with
// the workspaces' and firms' names to show them by (list_all_workspaces, list_entities, when this Mynt has them).
// audit_log takes only a limit (no filters, no cursor), so the section filters and pages what this returns
// (lib/admin-audit.ts). The query takes only `limit`; anything else is refused. Mynt admins only, 404 otherwise.
const Query = z.object({ limit: z.coerce.number().int().min(1).max(AUDIT_LIMIT).optional() }).strict();

export async function GET(req: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return json({ error: "bad_request", message: "That isn't a query this takes." }, 400);
  const limit = parsed.data.limit ?? AUDIT_LIMIT;
  return asAdmin("reading the audit log", async (mynt, session) => {
    if (!(await hasTools(mynt, "audit_log"))) return json(UNSUPPORTED);
    const names: AuditNames = { workspaces: {}, firms: {} };
    if (await hasTools(mynt, "list_all_workspaces"))
      for (const w of workspacesFrom(await callAdminTool(mynt, session, "list_all_workspaces", { limit: 500 }))?.rows ?? []) names.workspaces[w.id] = w.name;
    if (await hasTools(mynt, "list_entities")) for (const f of firmsFrom(await callAdminTool(mynt, session, "list_entities", {})) ?? []) names.firms[f.id] = f.name;
    const entries = auditEntriesFrom(await callAdminTool(mynt, session, "audit_log", { limit }), names);
    return entries ? json({ entries, limit }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
