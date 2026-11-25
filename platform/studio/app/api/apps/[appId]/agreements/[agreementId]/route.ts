import { z } from "zod";
import { panelApp } from "@/lib/app-panel-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string; agreementId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;

// The app side's row actions on the Agreements tab: Accept and Decline a proposal the other firm made
// (respond_to_app_agreement), Sign (sign_app_agreement), and Withdraw or End agreement (terminate_app_agreement, with
// the reason).
const note = STUDIO_TOOLS.respond_to_app_agreement.shape.note;
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), note }).strict(),
  z.object({ action: z.literal("decline"), note }).strict(),
  z.object({ action: z.literal("sign") }).strict(),
  z.object({ action: z.literal("terminate"), reason: STUDIO_TOOLS.terminate_app_agreement.shape.reason }).strict(),
]);

const TOOL = { accept: "respond_to_app_agreement", decline: "respond_to_app_agreement", sign: "sign_app_agreement", terminate: "terminate_app_agreement" } as const;
const DONE = {
  accept: "Accepted. Both sides sign it next; the other firm is told.",
  decline: "Declined. The other firm is told.",
  sign: "Signed for your side. It's signed once the other firm has signed too.",
  terminate: "Ended. The other firm is told, with your reason.",
} as const;

// POST: same origin and a signed-in developer only; the agreement must be one of this app's (as Mynt lists them to
// this user). Mynt checks the rest again (owners and admins only, its status) and its refusal comes back as the message.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId, agreementId } = await params;
  if (!APP_ID.test(appId) || !z.string().uuid().safeParse(agreementId).success) return json({ error: "bad_request" }, 400);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That action isn't valid." }, 400);
  const body = parsed.data;
  return asDeveloper("acting on an app agreement", async (mynt) => {
    const tool = TOOL[body.action];
    if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "Agreements come with Mynt's next update." }, 501);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: "That app isn't one of yours." }, 404);
    const listed = (await callStudioTool(mynt, "list_app_agreements", { app_id: app.id })) as { agreements?: { id?: unknown }[] } | null;
    if (!(listed?.agreements ?? []).some((a) => a?.id === agreementId)) return json({ error: "not_found", message: "That agreement isn't one of this app's." }, 404);
    const args =
      body.action === "accept" || body.action === "decline"
        ? { agreement_id: agreementId, decision: body.action, ...(body.note ? { note: body.note } : {}) }
        : body.action === "terminate"
          ? { agreement_id: agreementId, reason: body.reason }
          : { agreement_id: agreementId };
    await callStudioTool(mynt, tool, args);
    return json({ ok: true, message: DONE[body.action] });
  });
}
