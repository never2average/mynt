import { NextResponse } from "next/server";
import { asAgreementParty, hasTool, NOT_YET, UUID } from "@/lib/agreement-esign-server";
import { callStudioTool } from "@/lib/studio-server";
import { json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agreementId: string }> };

// GET ?part=signed|certificate: the signed copy of a program agreement (Download signed copy), or the e-signature
// service's audit certificate with it, as a PDF download. Either party's members only (Mynt checks), and the file is
// checked against the SHA-256 Mynt recorded before it's sent.
export async function GET(req: Request, { params }: Params) {
  const { agreementId } = await params;
  if (!UUID.test(agreementId)) return json({ error: "bad_request" }, 400);
  const part = new URL(req.url).searchParams.get("part") === "certificate" ? "certificate" : "signed";
  return asAgreementParty("downloading a signed agreement", async (mynt) => {
    if (!(await hasTool(mynt, "download_agreement_document"))) return NOT_YET;
    const reply = (await callStudioTool(mynt, "download_agreement_document", { agreement_id: agreementId, part })) as { content_base64?: unknown; sha256?: unknown } | null;
    if (typeof reply?.content_base64 !== "string" || typeof reply.sha256 !== "string") return json({ error: "unreachable", message: "Mynt didn't send the file." }, 502);
    const bytes = Buffer.from(reply.content_base64, "base64");
    const name = `agreement-${agreementId.slice(0, 8)}-${part}.pdf`;
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        "x-content-sha256": reply.sha256.replace(/[^a-f0-9]/g, ""),
      },
    });
  });
}
