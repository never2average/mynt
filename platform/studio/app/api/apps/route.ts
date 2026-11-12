import { capabilitiesFrom } from "@/lib/chat";
import { appFieldsFromPrompt, NewAppRequest } from "@/lib/new-app";
import { fromOwnOrigin } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, GENERIC_REFUSAL, listMyntTools, ToolRefusedError } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// New app: creates a draft app on the picked products (create_app), then starts its first
// build with the prompt as the goal (start_build; in session mode where Mynt offers it, so the
// chat can keep steering it). The page then opens the app's workspace on that build.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = NewAppRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Check what you entered." }, 400);
  const { prompt, product_ids } = parsed.data;

  return asDeveloper("creating an app", async (mynt, session) => {
    // The same request twice (a double click) creates one app.
    const release = await sessionStore().claim("new-app", `${session.userId ?? session.id}\n${prompt}\n${product_ids.join(",")}`, 30);
    if (!release) return json({ error: "duplicate", message: "That app is already being created." }, 409);

    let appId: string;
    try {
      const app = (await callStudioTool(mynt, "create_app", { ...appFieldsFromPrompt(prompt), product_ids })) as { id?: unknown } | null;
      if (typeof app?.id !== "string") throw new Error("create_app returned no app id");
      appId = app.id;
    } catch (err) {
      await release(); // nothing was created; trying again is fine
      throw err;
    }

    const sessionBuilds = capabilitiesFrom(await listMyntTools(mynt)).sessionBuilds;
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
