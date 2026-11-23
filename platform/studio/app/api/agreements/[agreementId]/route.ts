import { z } from "zod";
import { isLicenceProvider } from "@/lib/lp-agreements";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agreementId: string }> };

// The licence provider's row actions on the Licences page's Agreements tab: Accept and Decline a proposal
// (respond_to_app_agreement, with an optional note), Sign an accepted one (sign_app_agreement) and End agreement
// (terminate_app_agreement, with the reason). Each tells the app's workspace (its attention list).
const note = STUDIO_TOOLS.respond_to_app_agreement.shape.note;
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), note }).strict(),
  z.object({ action: z.literal("decline"), note }).strict(),
  z.object({ action: z.literal("sign") }).strict(),
  z.object({ action: z.literal("terminate"), reason: STUDIO_TOOLS.terminate_app_agreement.shape.reason }).strict(),
]);

const TOOL = { accept: "respond_to_app_agreement", decline: "respond_to_app_agreement", sign: "sign_app_agreement", terminate: "terminate_app_agreement" } as const;
const DONE = {
  accept: "Accepted. Both sides sign it next; the app's workspace is told.",
  decline: "Declined. The app's workspace is told.",
  sign: "Signed for your firm. It's signed once the app's side has signed too.",
  terminate: "Ended. The app's workspace is told, with your reason.",
} as const;

// POST: same origin and a signed-in licence provider only, and only for an agreement Mynt lists to their firm. Mynt
// checks the rest again (its status, who signs), and its refusal comes back as the message.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { agreementId } = await params;
  if (!z.string().uuid().safeParse(agreementId).success) return json({ error: "bad_request" }, 400);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That action isn't valid." }, 400);
  const body = parsed.data;
  return asDeveloper(
    "acting on a firm's app agreement",
    async (mynt) => {
      const tool = TOOL[body.action];
      if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "Agreements come with Mynt's next update." }, 501);
      const listed = (await callStudioTool(mynt, "list_app_agreements", {})) as { agreements?: { id?: unknown }[] } | null;
      if (!(listed?.agreements ?? []).some((a) => a?.id === agreementId)) return json({ error: "not_found", message: "That agreement isn't one made with your firm." }, 404);
      const args =
        body.action === "accept" || body.action === "decline"
          ? { agreement_id: agreementId, decision: body.action, ...(body.note ? { note: body.note } : {}) }
          : body.action === "terminate"
            ? { agreement_id: agreementId, reason: body.reason }
            : { agreement_id: agreementId };
      await callStudioTool(mynt, tool, args);
      return json({ ok: true, message: DONE[body.action] });
    },
    (session) => isLicenceProvider(session.roles ?? []),
  );
}
