import { z } from "zod";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ buildId: string }> };

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const Body = z.object({ projectId: z.string().regex(ID) }).strict();

// POST: Ship. Ends the app's session build (finish_build): once its current request is done, the
// agent reviews, checks and pushes the work, then Mynt verifies it in a clean sandbox, and only
// that decides whether it ships. It never interrupts the request under way (Mynt guarantees it),
// so it's offered whenever the session is open. The build must be this app's.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { buildId } = await params;
  if (!ID.test(buildId)) return json({ error: "bad_request" }, 400);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request" }, 400);
  return asDeveloper("shipping a build", async (mynt) => {
    const build = (await callStudioTool(mynt, "get_build", { build_id: buildId })) as { app_id?: unknown } | null;
    if (build?.app_id !== parsed.data.projectId) return json({ error: "not_found", message: "That build isn't one of this app's." }, 404);
    await callStudioTool(mynt, "finish_build", { build_id: buildId });
    return json({ ok: true, message: "Shipping: the agent wraps up its current request, reviews, checks and pushes the work, then Mynt verifies it in a clean sandbox." });
  });
}
