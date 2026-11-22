import { budgetFrom } from "@/lib/build-cap";
import { capabilitiesFrom } from "@/lib/chat";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;

// GET: what a new build's cap may be (list_builds' budget), for the cap pickers in New app and
// an app's builder chat. With ?appId, the app's workspace's budget counts too. `session`: new
// builds start as sessions here, whose cap must be above the shipping reserve. `budget` is null
// where this Mynt doesn't report one (the pickers then hide, and Mynt's usual cap applies).
export async function GET(req: Request) {
  const appId = new URL(req.url).searchParams.get("appId");
  if (appId !== null && !APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  return asDeveloper("reading the build budget", async (mynt) => {
    const session = capabilitiesFrom(await listMyntTools(mynt)).sessionBuilds;
    return json({ budget: budgetFrom(await callStudioTool(mynt, "list_builds", appId ? { app_id: appId } : {})), session });
  });
}
