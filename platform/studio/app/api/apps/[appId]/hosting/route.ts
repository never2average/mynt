import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { panelApp } from "@/lib/app-panel-server";
import {
  canPutOnline,
  canTurnOnHosting,
  deployable,
  fromHostingStatus,
  latestShippedBuild,
  MEMBERS_HOSTING,
  NO_REPOSITORY,
  shortCommit,
  toShippedBuild,
  type WorkspaceHosting,
} from "@/lib/hosting";
import { fromListRepositories, REPOSITORY } from "@/lib/repositories";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, isAuthError, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { loadWorkspaces, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };
type Tools = { name: string }[];

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const NOT_YOURS = "That app isn't one of yours.";
const has = (tools: Tools, name: string) => tools.some((t) => t.name === name);

// A read that Mynt refuses is left out (null); a lost sign-in isn't.
async function read(mynt: Client, tool: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await callStudioTool(mynt, tool, args);
  } catch (err) {
    if (isAuthError(err)) throw err;
    return null;
  }
}

// The app's workspace's hosting and the app's place on it.
async function hostingOf(mynt: Client, appId: string, workspaceId: string | null): Promise<WorkspaceHosting> {
  return fromHostingStatus(await read(mynt, "hosting_status", workspaceId ? { workspace_id: workspaceId } : {}), appId);
}

// The user's role in the app's workspace (owner where Mynt has no workspaces yet).
async function roleIn(mynt: Client, tools: Tools, workspaceId: string | null): Promise<string> {
  const support = workspaceSupport(tools);
  if (!support.workspaces || !workspaceId) return "owner";
  const ws = (await loadWorkspaces(mynt, support)).find((w) => w.id === workspaceId);
  return ws?.role ?? "member";
}

// GET: Put online's sheet and the app top bar's hosting state, for this app only: whether this
// Mynt hosts apps, the app's state on its workspace's hosting (Online at its address, Deploying,
// Not online), the newest build Mynt verified with the repository and commit it would deploy, and,
// for a build that pushed nowhere, the app's repository and the user's approved repositories to
// choose from. ?only=status: just the state (polled while it deploys).
export async function GET(req: Request, { params }: Params) {
  const { appId } = await params;
  if (!ID.test(appId)) return json({ error: "bad_request" }, 400);
  const only = new URL(req.url).searchParams.get("only");
  return asDeveloper("loading an app's hosting", async (mynt) => {
    const tools = await listMyntTools(mynt);
    if (!has(tools, "deploy_app") || !has(tools, "hosting_status")) return json({ supported: false });
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: NOT_YOURS }, 404);
    const hosting = await hostingOf(mynt, appId, app.workspaceId);
    if (only === "status") return json({ supported: true, hosting });

    const build = latestShippedBuild(await read(mynt, "list_builds", { app_id: appId }), appId);
    const role = await roleIn(mynt, tools, app.workspaceId);
    const chooser = build && !deployable(build) && has(tools, "set_app_repository");
    const current = chooser && has(tools, "get_app_repository") ? ((await read(mynt, "get_app_repository", { app_id: appId })) as { repository?: unknown; managed?: unknown } | null) : null;
    const repositories = chooser && has(tools, "list_repositories") ? fromListRepositories(await read(mynt, "list_repositories", {})).filter((r) => r.approval === "approved") : null;
    return json({
      supported: true,
      app: { id: app.id, name: app.name, workspaceId: app.workspaceId },
      role,
      // In Production only owners and admins put a build online (Mynt refuses anyone else): said before the click.
      stage: app.stage,
      canPutOnline: canPutOnline(app.stage, role),
      // Turning the workspace's hosting on is for owners and admins; Put online does it on the way.
      canTurnOn: canTurnOnHosting(role),
      hosting,
      build,
      repository: current ? { current: typeof current.repository === "string" ? current.repository : null, managed: current.managed === true } : null,
      repositories,
      canChooseRepository: !!chooser,
    });
  });
}

const Change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("put_online"), build_id: z.string().regex(ID) }).strict(),
  z.object({ action: z.literal("set_repository"), repository: z.string().trim().max(200).regex(REPOSITORY, "Choose a repository as owner/name.") }).strict(),
]);

// POST: Put online ({ action: "put_online", build_id }): the build must be this app's, verified by
// Mynt and pushed to a repository. The app's workspace's hosting is turned on first if it isn't
// (request_hosting, which Mynt keeps idempotent; owners and admins only), then deploy_app hosts the
// build. For an app in Production Mynt puts it online only for an owner or admin of its workspace, and only
// if the build passes the production checks about it; its refusal comes back in its own words (422) and
// is shown in the sheet. The app is deploying when this answers; GET ?only=status follows it until it's online.
// Or choose the repository the app's next builds push to ({ action: "set_repository", repository }).
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId } = await params;
  if (!ID.test(appId)) return json({ error: "bad_request" }, 400);
  const parsed = Change.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That isn't a valid request." }, 400);
  const change = parsed.data;
  return asDeveloper(change.action === "put_online" ? "putting an app online" : "choosing an app's repository", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const app = await panelApp(mynt, appId);
    if (!app) return json({ error: "not_found", message: NOT_YOURS }, 404);

    if (change.action === "set_repository") {
      if (!has(tools, "set_app_repository")) return json({ error: "unsupported", message: "Choosing an app's repository comes with Mynt's next update." }, 501);
      await callStudioTool(mynt, "set_app_repository", { app_id: appId, repository: change.repository });
      return json({
        ok: true,
        repository: change.repository.toLowerCase(),
        message: `${app.name}'s next build pushes to ${change.repository}. Send the coding agent a message to start it; once Mynt has verified that build, put it online from here.`,
      });
    }

    if (!has(tools, "deploy_app") || !has(tools, "hosting_status")) return json({ error: "unsupported", message: "Hosting apps from the studio comes with Mynt's next update." }, 501);
    const raw = (await callStudioTool(mynt, "get_build", { build_id: change.build_id })) as { app_id?: unknown } | null;
    const build = toShippedBuild(raw);
    if (!build || raw?.app_id !== appId) return json({ error: "not_found", message: "That isn't a build of this app that Mynt verified." }, 404);
    if (!deployable(build)) return json({ error: "no_repository", message: NO_REPOSITORY }, 409);

    // The workspace's hosting: turned on if it isn't yet, or set up again if setting it up failed
    // (asking again otherwise returns the same hosting).
    let hosting = await hostingOf(mynt, appId, app.workspaceId);
    if ((!hosting.on || hosting.status === "failed") && app.workspaceId) {
      if (!canTurnOnHosting(await roleIn(mynt, tools, app.workspaceId))) return json({ error: "not_allowed", message: MEMBERS_HOSTING }, 403);
      await callStudioTool(mynt, "request_hosting", { workspace_id: app.workspaceId });
      hosting = await hostingOf(mynt, appId, app.workspaceId);
    }
    if (hosting.on && hosting.status === "provisioning")
      return json({ error: "not_ready", message: "Your workspace's hosting is still being set up. Put the app online again in a few minutes." }, 409);

    const reply = (await callStudioTool(mynt, "deploy_app", { app_id: appId, build_id: build.id })) as { url?: unknown; beside_serving_build?: unknown; service?: { next?: unknown } } | null;
    // A service with a build serving: the new one goes online beside it, and takes over only once Mynt has passed it.
    const beside = typeof reply?.beside_serving_build === "string" ? reply.beside_serving_build : null;
    const after = await hostingOf(mynt, appId, app.workspaceId);
    return json({
      ok: true,
      hosting: after["app"].state === "not_online" && !after["app"].error ? { ...after, app: { ...after["app"], state: "deploying", buildId: build.id, commitSha: build.commitSha } } : after,
      message: beside
        ? `Build ${build.id.slice(0, 8)} is going online beside build ${beside.slice(0, 8)}, which keeps serving. ${typeof reply?.service?.next === "string" ? reply.service.next : "Mynt tests the new build and switches to it only if it passes"}.`
        : `Putting ${app.name} online: Mynt's hosting fetches commit ${shortCommit(build.commitSha)} from ${build.repository}, builds it and starts it. This takes a few minutes; its address shows here once it answers.`,
      // Where it will answer, when Mynt already says (it isn't up until the state says Online).
      address: typeof reply?.url === "string" && reply.url.startsWith("https://") ? reply.url : null,
    });
  });
}
