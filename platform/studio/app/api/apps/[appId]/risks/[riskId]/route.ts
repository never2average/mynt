import { z } from "zod";
import { panelApp } from "@/lib/app-panel-server";
import type { RiskDetailData } from "@/lib/risk-detail";
import { applyRiskDetailChange, loadRiskDetail, NO_DETAIL_YET, RiskDetailChangeRequest, type Call } from "@/lib/risk-detail-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, isAuthError, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { fromListMembers } from "@/lib/workspaces";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ appId: string; riskId: string }> };
const APP_ID = /^[A-Za-z0-9_-]{1,200}$/;
const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

// One risk on this app's register, in full (the Security & risk tab's risk detail). GET: get_risk, only when the risk
// is on this app's register, with the workspace's members (who may own it or its tasks) and what the Link item picker
// can offer (the app and its products). POST: one of the detail's labelled actions (lib/risk-detail-server.ts), for
// this risk and nothing else. Same origin and a signed-in developer only; the app must be one Mynt lists as theirs,
// and Mynt checks the rest again (only the workspace's owners and admins change it), its refusal the message.
async function ready(mynt: Parameters<Parameters<typeof asDeveloper>[1]>[0], appId: string, riskId: string) {
  if (!(await listMyntTools(mynt)).some((t) => t.name === "get_risk")) return { ok: false, res: json({ error: "unsupported", message: NO_DETAIL_YET }, 501) } as const;
  const app = await panelApp(mynt, appId);
  if (!app) return { ok: false, res: json({ error: "not_found", message: "That app isn't one of yours." }, 404) } as const;
  const call: Call = (tool, args) => callStudioTool(mynt, tool, args);
  // The risk must be on this app's register: anything else is not found, whatever it is.
  const detail = await loadRiskDetail(call, riskId, { type: "app", id: app.id });
  if (!detail) return { ok: false, res: json({ error: "not_found", message: "That risk isn't on this app's register." }, 404) } as const;
  return { ok: true, app, call, detail } as const;
}

export async function GET(_req: Request, { params }: Params) {
  const { appId, riskId } = await params;
  if (!APP_ID.test(appId) || !isUuid(riskId)) return json({ error: "bad_request" }, 400);
  return asDeveloper("reading an app risk", async (mynt) => {
    const r = await ready(mynt, appId, riskId);
    if (!r.ok) return r.res;
    const { app } = r;
    const members = app.workspaceId ? await callStudioTool(mynt, "list_workspace_members", { workspace_id: app.workspaceId }).catch((e) => (isAuthError(e) ? Promise.reject(e) : null)) : null;
    const owners = members === null ? [] : fromListMembers(members).members.map((m) => ({ userId: m.userId, name: m.name ?? m.email ?? "Unnamed member" }));
    const data: RiskDetailData = { detail: r.detail, owners, linkChoices: { app: [{ id: app.id, name: app.name }], product: app.productIds.map((id) => ({ id, name: id })) } };
    return json(data);
  });
}

export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { appId, riskId } = await params;
  if (!APP_ID.test(appId) || !isUuid(riskId)) return json({ error: "bad_request" }, 400);
  const parsed = RiskDetailChangeRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That change isn't valid." }, 400);
  return asDeveloper("changing an app risk", async (mynt) => {
    const r = await ready(mynt, appId, riskId);
    if (!r.ok) return r.res;
    return json({ ok: true, message: await applyRiskDetailChange(r.call, riskId, parsed.data) });
  });
}
