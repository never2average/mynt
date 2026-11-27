import type { NextRequest } from "next/server";
import { capabilitiesFrom } from "@/lib/chat";
import { appFieldsFromPrompt } from "@/lib/new-app";
import { NEEDS_VENDOR_ROLE, NewServiceRequest, servicesFrom } from "@/lib/services";
import { fromOwnOrigin } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, certainlyNotDone, GENERIC_REFUSAL, listMyntTools, ToolRefusedError } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { sessionIsVendor } from "@/lib/vendor-server";
import { NOT_SCOPED, ownWorkspace, resolveWorkspace, scopeFor, workspaceOf, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// GET: the services the signed-in builder's workspace builds on Mynt (list_my_services), for the sidebar's stage
// folders and search. `supported: false` on a Mynt without services.
export async function GET(req: NextRequest) {
  return asDeveloper("loading services", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!tools.some((t) => t.name === "list_my_services")) return json({ supported: false, services: [] });
    const support = workspaceSupport(tools);
    const scoped = await scopeFor(mynt, req, support);
    if (scoped.unavailable !== undefined) return json({ supported: true, services: [], unavailable: scoped.unavailable });
    if (scoped.workspace && !support.workspaces) return json({ supported: true, services: [], unavailable: NOT_SCOPED });
    return json({ supported: true, services: servicesFrom(await callStudioTool(mynt, "list_my_services", scoped.workspace ? { workspace_id: scoped.workspace } : {})) });
  });
}

const CHOOSE_WORKSPACE = "Choose the workspace for this service in the switcher, then try again.";
const asksForWorkspace = (message: string) => /say which one|workspace_id|which workspace/i.test(message);

// POST: Build's Service type. Creates the service (create_service: one admin-defined service type in one region, with
// its vendor offering as a draft; Mynt derives its endpoint, nobody types one), then starts its first build with the
// message as the goal, exactly as an app's first build starts (start_build with the service's id). Only for an account
// with Mynt's vendor role: anyone else is told to ask a Mynt admin, before anything reaches Mynt.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = NewServiceRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Check what you entered." }, 400);
  const { prompt, service_type, region } = parsed.data;
  const requested = workspaceOf(req);

  return asDeveloper("creating a service", async (mynt, session) => {
    const tools = await listMyntTools(mynt);
    if (!sessionIsVendor(session) || !tools.some((t) => t.name === "create_service")) return json({ error: "not_vendor", message: `${NEEDS_VENDOR_ROLE}.` }, 403);
    const support = workspaceSupport(tools);
    const workspace = (await resolveWorkspace(mynt, requested, support)) ?? (await ownWorkspace(mynt, support));
    const scope = workspace ? { workspace_id: workspace } : {};

    // The same request twice (a double click) creates one service.
    const release = await sessionStore().claim("new-service", `${session.userId ?? session.id}\n${workspace ?? ""}\n${region}/${service_type}\n${prompt}`, 30);
    if (!release) return json({ error: "duplicate", message: "That service is already being created." }, 409);

    let serviceId: string;
    try {
      const fields = appFieldsFromPrompt(prompt);
      const name = fields.name === "New app" ? "New service" : fields.name;
      const made = (await callStudioTool(mynt, "create_service", { name, description: fields.description, service_type, region, ...scope })) as { id?: unknown } | null;
      if (typeof made?.id !== "string") throw new Error("create_service returned no service id");
      serviceId = made.id;
    } catch (err) {
      // Given back only when the service certainly wasn't created; after a lost reply it may exist, so a retry can't make a second.
      if (certainlyNotDone(err)) await release();
      if (err instanceof ToolRefusedError && asksForWorkspace(err.message)) return json({ error: "choose_workspace", message: CHOOSE_WORKSPACE }, 409);
      throw err;
    }

    const { sessionBuilds } = capabilitiesFrom(tools);
    try {
      const build = (await callStudioTool(mynt, "start_build", { goal: prompt, app_id: serviceId, ...(sessionBuilds ? { mode: "session" as const } : {}) })) as { id?: unknown } | null;
      return json({ serviceId, buildId: typeof build?.id === "string" ? build.id : null }, 201);
    } catch (err) {
      // The service exists; open it with a note rather than leaving the user on an error.
      const message = err instanceof ToolRefusedError ? err.message : GENERIC_REFUSAL;
      return json({ serviceId, buildId: null, message: `The service was created, but its first build didn't start: ${message}` }, 201);
    }
  });
}
