import { hasTools, isUuid, UNSUPPORTED } from "@/lib/admin-routes";
import { reviewFrom } from "@/lib/production-reviews";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ reviewId: string }> };

// Platform admin → Audit trails → Production reviews → one review (/platform/audit/<id>?tab=reviews): the review in
// full (get_production_review): its findings, coverage, cost, time, why it isn't complete, and any exception recorded
// for its build. Read-only; its actions post to /api/admin/production-reviews. Mynt admins only, 404 otherwise.
export async function GET(_req: Request, { params }: Params) {
  const { reviewId } = await params;
  if (!isUuid(reviewId)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading a production code review", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_production_review"))) return json(UNSUPPORTED);
    const review = reviewFrom(await callAdminTool(mynt, session, "get_production_review", { id: reviewId }));
    return review ? json({ review }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}
