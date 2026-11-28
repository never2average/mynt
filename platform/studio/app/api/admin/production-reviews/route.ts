import { z } from "zod";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { reviewsFrom, shortId } from "@/lib/production-reviews";
import { callAdminTool } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Platform admin → Audit trails → Production reviews: every workspace's production code reviews
// (list_production_reviews, as a Mynt admin sees them), newest first. GET takes no query. POST is one of the
// detail page's two labelled actions: Stop review ({ action: "stop", id }) or Record exception
// ({ action: "waive", app_id, build_id, reason }: one build may go to Production without a complete review; Mynt
// records it in the audit trail with the admin's name). Same origin, signed in, and an account Mynt says is an
// admin, or 404; Mynt checks the role again, and that the admin isn't in the app's workspace.
const LIMIT = 300;
const uuid = z.string().uuid();
const Change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("stop"), id: uuid }).strict(),
  z.object({ action: z.literal("waive"), app_id: uuid, build_id: uuid, reason: z.string().trim().min(20, "Give the reason in a sentence (at least 20 characters).").max(1000) }).strict(),
]);

export async function GET(req: Request) {
  if ([...new URL(req.url).searchParams.keys()].length) return json({ error: "bad_request", message: "That isn't a query this takes." }, 400);
  return asAdmin("reading production code reviews", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_production_reviews"))) return json(UNSUPPORTED);
    const reviews = reviewsFrom(await callAdminTool(mynt, session, "list_production_reviews", { limit: LIMIT }));
    return reviews ? json({ reviews, limit: LIMIT }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, Change);
  if (!w.ok) return w.res;
  const change = w.body;
  return asAdmin(change.action === "stop" ? "stopping a production code review" : "recording an exception to a production code review", async (mynt, session) => {
    if (!(await hasTools(mynt, change.action === "stop" ? "stop_production_review" : "waive_production_review")))
      return json({ error: "unsupported", message: "Production code reviews come with Mynt's next update." }, 422);
    if (change.action === "stop") {
      await callAdminTool(mynt, session, "stop_production_review", { id: change.id });
      return json({ ok: true, message: "Review stopped. What it had found and spent so far is kept." });
    }
    await callAdminTool(mynt, session, "waive_production_review", { app_id: change.app_id, build_id: change.build_id, reason: change.reason });
    return json({ ok: true, message: `Exception recorded for build ${shortId(change.build_id)}. It is in the audit trail and on the app's promotion checks.` });
  });
}
