import { esignFrameSources, framable } from "@/lib/agreement-esign";
import { asAgreementParty, hasTool, NOT_YET, UUID } from "@/lib/agreement-esign-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agreementId: string }> };

// POST: the signed-in signer's embedded signing page for a program agreement (Sign, on either side's agreement row).
// framable says whether the studio may show it in its sheet: only from an origin in ESIGN_FRAME_SRC (the same list the
// Content-Security-Policy allows); otherwise the sheet offers it in a new tab. The link is never stored.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { agreementId } = await params;
  if (!UUID.test(agreementId)) return json({ error: "bad_request" }, 400);
  return asAgreementParty("opening an agreement's signing page", async (mynt) => {
    if (!(await hasTool(mynt, "get_agreement_signing_link"))) return NOT_YET;
    const reply = (await callStudioTool(mynt, "get_agreement_signing_link", { agreement_id: agreementId })) as { signing_url?: unknown; message?: unknown; test_mode?: unknown } | null;
    const url = typeof reply?.signing_url === "string" && reply.signing_url.startsWith("https://") ? reply.signing_url : null;
    if (!url) return json({ ok: true, url: null, message: typeof reply?.message === "string" ? reply.message : "There's nothing for you to sign on it right now." });
    return json({ ok: true, url, framable: framable(url, esignFrameSources(process.env.ESIGN_FRAME_SRC)), testMode: reply?.test_mode === true });
  });
}
