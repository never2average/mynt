import { z } from "zod";
import { panelApp } from "@/lib/app-panel-server";
import { NO_REVIEWS_YET, reviewFrom, shortId } from "@/lib/production-reviews";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;
const uuid = z.string().uuid();

// An app's (or a service's) production code reviews, for the Security & risk tab's sheets.
// GET ?id=<review>: one review with its findings (the tab's table has only their counts). POST: Request production
// review ({ action: "request", build_id }) or Stop review ({ action: "stop", id }). Same origin and a signed-in
// developer only; the app must be one Mynt lists as theirs, the review must be this app's, and Mynt checks the rest
// again (only the workspace's owners and admins ask or stop; the monthly limits), its refusal coming back as the
// message.
const Change = z.discriminatedUnion("action", [z.object({ action: z.literal("request"), build_id: uuid.optional() }).strict(), z.object({ action: z.literal("stop"), id: uuid }).strict()]);

export async function GET(req: Request, { params }: Params) {
  const { appId } = await params;
  const id = uuid.safeParse(new URL(req.url).searchParams.get("id"));
  if (!APP_ID.test(appId) || !id.success) return json({ error: "bad_request" }, 400);
  return asDeveloper("reading a production code review", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "get_production_review")) return json({ error: "unsupported", message: NO_REVIEWS_YET }, 501);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    const review = reviewFrom(await callStudioTool(mynt, "get_production_review", { id: id.data }));
    if (!review || review.appId !== app.id) return json({ error: "not_found", message: "That review isn't this app's." }, 404);
    return json({ review });
  });
}

export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId } = await params;
  if (!APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  const parsed = Change.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That isn't a change this takes." }, 400);
  const change = parsed.data;
  return asDeveloper(change.action === "request" ? "requesting a production code review" : "stopping a production code review", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === (change.action === "request" ? "request_production_review" : "stop_production_review")))
      return json({ error: "unsupported", message: NO_REVIEWS_YET }, 501);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    if (change.action === "request") {
      const review = reviewFrom(await callStudioTool(mynt, "request_production_review", { app_id: app.id, ...(change.build_id ? { build_id: change.build_id } : {}) }));
      return json({ ok: true, message: review ? `Review of build ${shortId(review.buildId)} requested. It starts when a reviewer is free; this tab shows its findings as they are recorded.` : "Review requested.", review });
    }
    // Only this app's review is stopped from its page.
    const current = reviewFrom(await callStudioTool(mynt, "get_production_review", { id: change.id }));
    if (!current || current.appId !== app.id) return json({ error: "not_found", message: "That review isn't this app's." }, 404);
    const review = reviewFrom(await callStudioTool(mynt, "stop_production_review", { id: change.id }));
    return json({ ok: true, message: "Review stopped. What it had found and spent so far is kept; a stopped review doesn't pass.", review });
  });
}
