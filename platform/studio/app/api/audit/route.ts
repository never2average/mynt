import { z } from "zod";
import { AUDIT_DATE, fromAudit } from "@/lib/compliance";
import { complianceRead } from "@/lib/compliance-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const Filters = z
  .object({
    cursor: z.string().max(500),
    action: z.string().trim().min(1).max(120),
    user_id: z.string().trim().min(1).max(200),
    app_id: z.string().trim().min(1).max(200),
    from: z.string().regex(AUDIT_DATE),
    to: z.string().regex(AUDIT_DATE),
  })
  .partial()
  .strict();

// Audits: a page of the selected workspace's audit trail (list_workspace_audit), filtered by
// action, member, app and date range, and paged by Mynt's cursor.
export async function GET(req: Request) {
  const query = Object.fromEntries([...new URL(req.url).searchParams].filter(([k, v]) => k !== "workspace" && v !== ""));
  const filters = Filters.safeParse(query);
  if (!filters.success) return json({ error: "bad_request", message: "Those filters aren't valid." }, 400);
  return complianceRead(req, "list_workspace_audit", "loading the audit trail", (reply) => ({ page: fromAudit(reply) }), filters.data);
}
