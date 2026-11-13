import { capabilitiesFrom } from "@/lib/chat";
import { appFieldsFromPrompt, NewAppRequest } from "@/lib/new-app";
import { fromOwnOrigin } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, certainlyNotDone, GENERIC_REFUSAL, listMyntTools, ToolRefusedError } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { ownWorkspace, resolveWorkspace, workspaceOf, workspaceSupport } from "@/lib/workspace-server";

const CHOOSE_WORKSPACE = "Choose the workspace for this app in the switcher, then try again.";
// Mynt's refusal when it can't tell which workspace an app belongs in.
const asksForWorkspace = (message: string) => /choose a workspace|workspace_id|which workspace/i.test(message);

export const dynamic = "force-dynamic";

// New app: creates a draft app on the picked products (create_app), then starts its first
// build with the prompt as the goal (start_build; in session mode where Mynt offers it, so the
// chat can keep steering it). The page then opens the app's workspace on that build. The app is
// created in the selected workspace, always named: in Personal, the user's own workspace (Mynt
// doesn't default into workspaces they were invited to). A shared workspace this Mynt can't
// create apps in yet is refused rather than the app landing somewhere else.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = NewAppRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Check what you entered." }, 400);
  const { prompt, product_ids } = parsed.data;
  const requested = workspaceOf(req);

  return asDeveloper("creating an app", async (mynt, session) => {
    const tools = await listMyntTools(mynt);
    const support = workspaceSupport(tools);
    const selected = await resolveWorkspace(mynt, requested, support);
    if (selected && !support.createByWorkspace)
      return json({ error: "unsupported", message: "Creating apps in a shared workspace comes with Mynt's next update. Switch to Personal to create one now." }, 501);
    const workspace = selected ?? (support.createByWorkspace ? await ownWorkspace(mynt, support) : null);
    if (support.createByWorkspace && support.workspaces && !workspace) return json({ error: "choose_workspace", message: CHOOSE_WORKSPACE }, 409);
    const scope = workspace ? { workspace_id: workspace } : {};

    // The same request twice (a double click) creates one app.
    const release = await sessionStore().claim("new-app", `${session.userId ?? session.id}\n${workspace ?? ""}\n${prompt}\n${product_ids.join(",")}`, 30);
    if (!release) return json({ error: "duplicate", message: "That app is already being created." }, 409);

    let appId: string;
    try {
      const app = (await callStudioTool(mynt, "create_app", { ...appFieldsFromPrompt(prompt), product_ids, ...scope })) as { id?: unknown } | null;
      if (typeof app?.id !== "string") throw new Error("create_app returned no app id");
      appId = app.id;
    } catch (err) {
      // Given back only when the app certainly wasn't created (Mynt refused it before creating
      // anything, or it was never sent). After a timeout or a lost reply it may exist, so the
      // claim stays: a retry can't create a second app.
      if (certainlyNotDone(err)) await release();
      if (err instanceof ToolRefusedError && asksForWorkspace(err.message)) return json({ error: "choose_workspace", message: CHOOSE_WORKSPACE }, 409);
      throw err;
    }

    const sessionBuilds = capabilitiesFrom(tools).sessionBuilds;
    try {
      const build = (await callStudioTool(mynt, "start_build", { goal: prompt, app_id: appId, ...(sessionBuilds ? { mode: "session" as const } : {}) })) as {
        id?: unknown;
      } | null;
      return json({ appId, buildId: typeof build?.id === "string" ? build.id : null }, 201);
    } catch (err) {
      // The app exists; open it with a note rather than leaving the user on an error.
      const message = err instanceof ToolRefusedError ? err.message : GENERIC_REFUSAL;
      return json({ appId, buildId: null, message: `The app was created, but its first build didn't start: ${message}` }, 201);
    }
  });
}
