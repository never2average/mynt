import { z } from "zod";
import { asAgreementParty, hasTool, NOT_YET, UUID } from "@/lib/agreement-esign-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ templateId: string }> };
const Body = z.object({ reason: STUDIO_TOOLS.retire_agreement_template.shape.reason }).strict();

// POST: stop using a template version for new agreements (Retire, on the templates table). Licence providers only.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { templateId } = await params;
  if (!UUID.test(templateId)) return json({ error: "bad_request" }, 400);
  const parsed = Body.safeParse((await req.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return json({ error: "bad_request", message: "That reason isn't valid." }, 400);
  return asAgreementParty(
    "retiring an agreement template",
    async (mynt) => {
      if (!(await hasTool(mynt, "retire_agreement_template"))) return NOT_YET;
      await callStudioTool(mynt, "retire_agreement_template", { template_id: templateId, ...(parsed.data.reason ? { reason: parsed.data.reason } : {}) });
      return json({ ok: true, message: "Retired. Agreements already made from it keep it." });
    },
    true,
  );
}
