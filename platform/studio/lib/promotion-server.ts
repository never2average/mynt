import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fromPromotionChecks, nextStage, readinessOf, type PromotionTarget, type Readiness } from "./promotions";
import { callStudioTool } from "./studio-server";
import { loadWorkspaces, type WorkspaceSupport } from "./workspace-server";
import { stageOf, type Role, type Stage } from "./workspaces";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

// The app as Mynt lists it to this user, with their role in the app's workspace. Null when it
// isn't one of theirs. Before Mynt has workspaces, every app the user sees is their own.
export async function appAndRole(
  mynt: Client,
  appId: string,
  support: WorkspaceSupport,
): Promise<{ id: string; name: string; stage: Stage; role: Role } | null> {
  const apps = await callStudioTool(mynt, "list_my_apps", {});
  const app = (Array.isArray(apps) ? apps : []).filter(isObj).find((a) => a.id === appId);
  if (!app) return null;
  const base = { id: appId, name: typeof app.name === "string" && app.name ? app.name : "Untitled app", stage: stageOf(app) };
  if (!support.workspaces) return { ...base, role: "owner" };
  const workspaces = await loadWorkspaces(mynt, support);
  const ws = typeof app.workspace_id === "string" ? workspaces.find((w) => w.id === app.workspace_id) : undefined;
  return { ...base, role: ws?.role ?? "member" };
}

// Each app's readiness for its next stage, a few at a time; at most `max` apps are checked (the
// rest say so). An app whose checks can't be read has none, never a guess.
export async function readinessFor(
  mynt: Client,
  apps: { id: string; stage: Stage }[],
  max = 12,
): Promise<Map<string, Readiness | "not_checked">> {
  const out = new Map<string, Readiness | "not_checked">();
  const todo = apps.filter((a) => nextStage(a.stage));
  todo.slice(max).forEach((a) => out.set(a.id, "not_checked"));
  const batch = todo.slice(0, max);
  for (let i = 0; i < batch.length; i += 4) {
    await Promise.all(
      batch.slice(i, i + 4).map(async (a) => {
        const to = nextStage(a.stage) as PromotionTarget;
        try {
          const checks = fromPromotionChecks(await callStudioTool(mynt, "get_promotion_checks", { app_id: a.id, to_stage: to }), to);
          out.set(a.id, checks ? readinessOf(checks) : "not_checked");
        } catch {
          out.set(a.id, "not_checked");
        }
      }),
    );
  }
  return out;
}
