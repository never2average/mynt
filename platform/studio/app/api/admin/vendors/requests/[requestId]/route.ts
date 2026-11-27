import { z } from "zod";
import { hasTools, isUuid, writeBody } from "@/lib/admin-routes";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ requestId: string }> };

// Admin → Vendors → Requested service types → Decline (decline_service_type_request): the request, and the reason its
// requester reads. Defining one instead is Add service type with the request named (define_service_type { from_request }).
const Body = z.object({ reason: ADMIN_TOOLS.decline_service_type_request.shape.reason }).strict();

export async function POST(req: Request, { params }: Params) {
  const { requestId } = await params;
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  if (!isUuid(requestId)) return json({ error: "bad_request", message: "That isn't a request." }, 400);
  return asAdmin("declining a service type request", async (mynt, session) => {
    if (!(await hasTools(mynt, "decline_service_type_request"))) return json({ error: "unsupported", message: "Declining a request comes with Mynt's next update." }, 501);
    await callAdminTool(mynt, session, "decline_service_type_request", { request_id: requestId, reason: w.body.reason });
    return json({ ok: true, message: "Declined. The requester reads your reason on their own list." });
  });
}
