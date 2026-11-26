import { adminOwnersFrom } from "@/lib/admin-risks";
import { hasTools, isUuid, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { modelListFrom } from "@/lib/risk-models";
import type { LinkChoices, RiskDetailData } from "@/lib/risk-detail";
import { applyRiskDetailChange, loadRiskDetail, NO_DETAIL_YET, RiskDetailChangeRequest, type Call } from "@/lib/risk-detail-server";
import { callAdminTool, isAuthError } from "@/lib/studio-server";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ riskId: string }> };

// Admin → Risk register → one risk (/platform/risk-register/<id>). GET: the risk in full (get_risk): one of Mynt's
// own, which Mynt's admins keep, or an app's or a product's opened from the register's table, which they read (Mynt
// answers can_manage false, and refuses a write). With it: the admins who may own it or its tasks (list_whitelist)
// and Mynt's risk models, for the Link item picker (list_risk_models). POST: one of the detail's labelled actions
// (lib/risk-detail-server.ts RiskDetailChangeRequest): its own tool's arguments for this risk, and nothing else.
// Same origin, signed in, and an account Mynt says is an admin, or 404; Mynt checks the role again.
export async function GET(_req: Request, { params }: Params) {
  const { riskId } = await params;
  if (!isUuid(riskId)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading a risk", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_risk"))) return json(UNSUPPORTED);
    const call: Call = (tool, args) => callAdminTool(mynt, session, tool, args);
    const detail = await loadRiskDetail(call, riskId);
    if (!detail) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    const read = async (tool: "list_whitelist" | "list_risk_models") => ((await hasTools(mynt, tool)) ? await callAdminTool(mynt, session, tool, {}).catch((e) => (isAuthError(e) ? Promise.reject(e) : null)) : null);
    const models = modelListFrom(await read("list_risk_models"));
    const linkChoices: LinkChoices = models?.available ? { risk_model: models.models.filter((m) => m.status !== "retired").map((m) => ({ id: m.id, name: m.name })) } : {};
    const data: RiskDetailData = { detail, owners: adminOwnersFrom(await read("list_whitelist")), linkChoices };
    return json(data);
  });
}

export async function POST(req: Request, { params }: Params) {
  const { riskId } = await params;
  if (!isUuid(riskId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, RiskDetailChangeRequest);
  if (!w.ok) return w.res;
  return asAdmin("changing a risk", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_risk"))) return json({ error: "unsupported", message: NO_DETAIL_YET }, 422);
    return json({ ok: true, message: await applyRiskDetailChange((tool, args) => callAdminTool(mynt, session, tool, args), riskId, w.body) });
  });
}
