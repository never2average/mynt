import { z } from "zod";
import { panelApp } from "@/lib/app-panel-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;

// What the Agreements tab's Propose agreement sheet sends: propose_app_agreement's own arguments
// but the app's id, which is the route's. An empty optional field is left out.
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const Proposal = STUDIO_TOOLS.propose_app_agreement.omit({ app_id: true }).extend({
  document_url: z.preprocess(blank, STUDIO_TOOLS.propose_app_agreement.shape.document_url),
  document_sha256: z.preprocess(blank, STUDIO_TOOLS.propose_app_agreement.shape.document_sha256),
  effective_from: z.preprocess(blank, STUDIO_TOOLS.propose_app_agreement.shape.effective_from),
  effective_to: z.preprocess(blank, STUDIO_TOOLS.propose_app_agreement.shape.effective_to),
});

// POST: propose an agreement for this app to another firm (a sponsor of its products, or a vendor).
// Same origin and a signed-in developer only; Mynt checks the rest again (owners and admins only, the
// firm sponsors the products named, ...), and its refusal comes back as the message.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId } = await params;
  if (!APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  const parsed = Proposal.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That agreement isn't valid." }, 400);
  return asDeveloper("proposing an app agreement", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "propose_app_agreement")) return json({ error: "unsupported", message: "Agreements come with Mynt's next update." }, 501);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    const args = Object.fromEntries(Object.entries({ app_id: app.id, ...parsed.data }).filter(([, v]) => v !== undefined));
    await callStudioTool(mynt, "propose_app_agreement", args);
    return json({ ok: true, message: "Agreement proposed. The other firm is told, and it shows here as Proposed until they answer." });
  });
}
