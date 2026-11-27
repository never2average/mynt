import { serviceTypeChoices, typeRequestsFrom } from "@/lib/services";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, isAuthError, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";
import { sessionIsVendor } from "@/lib/vendor-server";

export const dynamic = "force-dynamic";

// GET: what Build's Service type picks from: Mynt's admin-defined service types with each one's licence prerequisite
// (list_service_types), whether this account may create a service (Mynt's vendor role, and a Mynt that has services),
// and the service types this account or its firm asked Mynt for, with where each stands (list_service_type_requests;
// null on a Mynt without requests).
export async function GET() {
  return asDeveloper("loading service types", async (mynt, session) => {
    const tools = new Set((await listMyntTools(mynt)).map((t) => t.name));
    const optional = async <T>(tool: string, read: (reply: unknown) => T, none: T): Promise<T> => {
      if (!tools.has(tool)) return none;
      try {
        return read(await callStudioTool(mynt, tool, {}));
      } catch (err) {
        if (isAuthError(err)) throw err;
        return none;
      }
    };
    return json({
      supported: tools.has("list_my_services"),
      vendor: sessionIsVendor(session) && tools.has("create_service"),
      canRequest: tools.has("request_service_type"),
      serviceTypes: await optional("list_service_types", serviceTypeChoices, []),
      requests: await optional<ReturnType<typeof typeRequestsFrom> | null>("list_service_type_requests", typeRequestsFrom, null),
    });
  });
}

// POST: Request a service type (request_service_type): its name, what it does, and one example input and one example
// output, each a JSON object. A Mynt admin defines it from the request or declines with a reason.
const Body = STUDIO_TOOLS.request_service_type;

export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return json({ error: "bad_request", message: i ? `${i.path.join(".") || "The form"}: ${i.message}` : "That isn't a request this takes." }, 400);
  }
  return asDeveloper("requesting a service type", async (mynt) => {
    if (!(await listMyntTools(mynt)).some((t) => t.name === "request_service_type")) return json({ error: "unsupported", message: "Requesting a service type comes with Mynt's next update." }, 501);
    const [request] = typeRequestsFrom([await callStudioTool(mynt, "request_service_type", parsed.data)]);
    return json({ ok: true, request: request ?? null, message: `Sent to Mynt. An admin defines ${parsed.data.name} or declines with a reason. Where it stands shows under Requested service types.` });
  });
}
