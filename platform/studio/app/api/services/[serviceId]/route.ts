import { z } from "zod";
import { serviceFrom } from "@/lib/services";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ serviceId: string }> };
const SERVICE_ID = /^[A-Za-z0-9_-]{1,200}$/;
const NOT_YOURS = { error: "not_found", message: "That isn't one of your services." } as const;
const NEXT_UPDATE = { error: "unsupported", message: "Services come with Mynt's next update." } as const;

// GET: one service, whole, for its workspace (/services/<id>): get_service's stage, contract, conformance and practice
// runs, standard terms, subscribers, reliability, activity and checklist (lib/services.ts). ?days= is the reliability
// window. Mynt answers only a member of the service's workspace; anything else is not found.
export async function GET(req: Request, { params }: Params) {
  const { serviceId } = await params;
  if (!SERVICE_ID.test(serviceId)) return json(NOT_YOURS, 404);
  const asked = Number(new URL(req.url).searchParams.get("days"));
  const days = [7, 30, 90].includes(asked) ? asked : 30;
  return asDeveloper("loading a service", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "get_service")) return json({ supported: false });
    const service = serviceFrom(await callStudioTool(mynt, "get_service", { service_id: serviceId, days }));
    return service ? json({ supported: true, service }) : json(NOT_YOURS, 404);
  });
}

// POST: Archive or Restore (archive_service). Archiving takes its offering off the Marketplace and stops Mynt calling
// it at once; its history stays. Restoring brings it back as a draft, to be put online and tested again. Mynt lets only
// the workspace's owners and admins, at the service's own firm.
const Body = z.object({ archived: z.boolean(), reason: z.string().trim().max(500).optional() }).strict();

export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { serviceId } = await params;
  if (!SERVICE_ID.test(serviceId)) return json(NOT_YOURS, 404);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That isn't a change this takes." }, 400);
  const { archived, reason } = parsed.data;
  return asDeveloper(archived ? "archiving a service" : "restoring a service", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "archive_service")) return json(NEXT_UPDATE, 501);
    const reply = (await callStudioTool(mynt, "archive_service", { service_id: serviceId, archived, ...(reason ? { reason } : {}) })) as { drifted_products?: unknown } | null;
    const drifted = Array.isArray(reply?.drifted_products) ? reply.drifted_products.length : 0;
    return json({
      ok: true,
      archived,
      message: archived
        ? `Archived. It's off the Marketplace and Mynt has stopped calling it.${drifted ? ` ${drifted} ${drifted === 1 ? "product that hands off through it has" : "products that hand off through it have"} paused new sales.` : ""}`
        : "Restored as a draft. Put it online again: Mynt then tests the build.",
    });
  });
}
