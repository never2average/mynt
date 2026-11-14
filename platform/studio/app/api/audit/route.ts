import { z } from "zod";
import { AUDIT_CLASSES, fromClassAudit, rowsFromEvents } from "@/lib/audit-classes";
import { fromAudit, isCalendarDate } from "@/lib/compliance";
import { complianceRead, takes } from "@/lib/compliance-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const date = z.string().refine(isCalendarDate, "Use a real date (YYYY-MM-DD).");
const Filters = z
  .object({
    cursor: z.string().min(1).max(500),
    action: z.string().trim().min(1).max(120),
    user_id: z.string().trim().min(1).max(200),
    app_id: z.string().trim().min(1).max(200),
    from: date,
    to: date,
    class: z.enum(AUDIT_CLASSES),
  })
  .partial()
  .strict()
  .refine((f) => !f.from || !f.to || f.from <= f.to, "The start date is after the end date.");

// Audits: a page of the selected workspace's audit trail (list_workspace_audit), filtered by
// action, member, app and date range, and paged by Mynt's cursor. Without `class` it's the trail
// as before (the dashboard's Recent activity). With `class` (the Audits page's tabs) it's that
// class's rows, where Mynt classifies them; until it does, Workspace activity is the whole trail
// as it is (`classes: false`) and the other classes aren't supported yet.
export async function GET(req: Request) {
  // Every filter sent must be valid: an empty one (even an empty cursor) is refused, not ignored.
  const query = Object.fromEntries([...new URL(req.url).searchParams].filter(([k]) => k !== "workspace"));
  const filters = Filters.safeParse(query);
  if (!filters.success) return json({ error: "bad_request", message: filters.error.issues[0]?.message ?? "Those filters aren't valid." }, 400);
  const { class: cls, ...rest } = filters.data;
  if (!cls) return complianceRead(req, "list_workspace_audit", "loading the audit trail", (reply) => ({ page: fromAudit(reply) }), rest);
  return complianceRead(
    req,
    "list_workspace_audit",
    "loading the audit trail",
    (reply, found) => {
      if (takes(found, "class")) return { classes: true, page: fromClassAudit(reply) };
      const page = fromAudit(reply);
      return { classes: false, page: { rows: rowsFromEvents(page.events), nextCursor: page.nextCursor } };
    },
    (found) => (takes(found, "class") ? { ...rest, class: cls } : cls === "workspace" ? rest : null),
  );
}
