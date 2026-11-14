import { z } from "zod";
import { appAndRole } from "@/lib/promotion-server";
import { canChangeStage, earlierStages, fromPromotionChecks, promotionSupport, STAGE_NAMES, type PromotionTarget } from "@/lib/promotions";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string }> };

const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;
const Target = z.enum(["staging", "production"]);
const NOT_YOURS = "That app isn't one of yours.";
const NOT_ALLOWED = "Only the workspace's owners and admins move apps between stages.";

// GET: whether this Mynt has promotions, the app's stage and the user's role in its workspace,
// and with ?to=staging|production the checks for moving it there (get_promotion_checks).
export async function GET(req: Request, { params }: Params) {
  const { appId } = await params;
  if (!APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  const to = new URL(req.url).searchParams.get("to");
  const target = to === null ? null : Target.safeParse(to);
  if (target && !target.success) return json({ error: "bad_request", message: "Promote to staging or production." }, 400);
  return asDeveloper("loading promotion checks", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const ps = promotionSupport(tools);
    if (!ps.checks || !ps.promote) return json({ supported: false });
    const app = await appAndRole(mynt, appId, workspaceSupport(tools));
    if (!app) return json({ error: "not_found", message: NOT_YOURS }, 404);
    const summary = { id: app.id, name: app.name, stage: app.stage };
    const base = { supported: true, app: summary, role: app.role, canChange: canChangeStage(app.role), tools: { demote: ps.demote, signoff: ps.signoff } };
    if (!target) return json(base);
    const checks = fromPromotionChecks(await callStudioTool(mynt, "get_promotion_checks", { app_id: appId, to_stage: target.data }), target.data);
    if (!checks) return json({ error: "unreadable", message: "Mynt's checks weren't readable. Please try again." }, 502);
    return json({ ...base, app: { ...summary, stage: checks.fromStage ?? app.stage }, checks });
  });
}

const Change = z.discriminatedUnion("action", [
  z.object({ action: z.literal("promote"), to_stage: Target }).strict(),
  z.object({ action: z.literal("demote"), to_stage: z.enum(["idea", "staging"]), reason: z.string().trim().min(3, "Say why it's moving back.").max(1000) }).strict(),
  z.object({ action: z.literal("request_signoff") }).strict(),
]);

// POST: promote (only when Mynt's checks say it can), move back with a reason, or ask an admin
// to sign off. Owners and admins only, checked here before anything reaches Mynt (which checks
// again).
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId } = await params;
  if (!APP_ID.test(appId)) return json({ error: "bad_request" }, 400);
  const parsed = Change.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That change isn't valid." }, 400);
  const change = parsed.data;
  return asDeveloper("changing an app's stage", async (mynt) => {
    const tools = await listMyntTools(mynt);
    const ps = promotionSupport(tools);
    const offered = change.action === "promote" ? ps.checks && ps.promote : change.action === "demote" ? ps.demote : ps.signoff;
    if (!offered) return json({ error: "unsupported", message: "That comes with Mynt's next update." }, 501);
    const app = await appAndRole(mynt, appId, workspaceSupport(tools));
    if (!app) return json({ error: "not_found", message: NOT_YOURS }, 404);
    if (!canChangeStage(app.role)) return json({ error: "not_allowed", message: NOT_ALLOWED }, 403);

    if (change.action === "promote") {
      const to: PromotionTarget = change.to_stage;
      const checks = fromPromotionChecks(await callStudioTool(mynt, "get_promotion_checks", { app_id: appId, to_stage: to }), to);
      if (!checks?.canPromote) return json({ error: "not_ready", message: `${app.name} can't move to ${STAGE_NAMES[to]} until its checks pass.` }, 409);
      await callStudioTool(mynt, "promote_app", { app_id: appId, to_stage: to });
      return json({ ok: true, stage: to, message: `${app.name} is now in ${STAGE_NAMES[to]}.` });
    }
    if (change.action === "demote") {
      if (!earlierStages(app.stage).includes(change.to_stage)) return json({ error: "bad_request", message: `${app.name} is in ${STAGE_NAMES[app.stage]}; it can only move back to an earlier stage.` }, 400);
      await callStudioTool(mynt, "demote_app", { app_id: appId, to_stage: change.to_stage, reason: change.reason });
      return json({ ok: true, stage: change.to_stage, message: `${app.name} is back in ${STAGE_NAMES[change.to_stage]}.` });
    }
    await callStudioTool(mynt, "request_promotion_signoff", { app_id: appId });
    return json({ ok: true, message: "Sign-off requested. A Mynt admin reviews it; this page shows their answer." });
  });
}
