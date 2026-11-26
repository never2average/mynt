import { z } from "zod";
import { adminOwnersFrom } from "@/lib/admin-risks";
import { hasTools, isUuid, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { modelDetailFrom } from "@/lib/risk-models";
import { registerFrom } from "@/lib/risk-register";
import { callAdminTool, isAuthError } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ modelId: string }> };

// Admin → Risk models → one model (/platform/risk-models/<id>). GET: the model with every version and validation
// (list_risk_models with model_id), and the admins who may own it. POST: the detail's labelled actions, each its own
// tool's arguments for this model: Edit model (update_risk_model: a change to what it is adds a version), Record
// validation (validate_risk_model) and Retire model (retire_risk_model); and Link risk on its Linked risks tab
// (link_risk: one of Mynt's own risks, which the route's GET lists as riskChoices, to this model).
const ModelChange = z.discriminatedUnion("action", [
  ADMIN_TOOLS.update_risk_model.omit({ model_id: true }).extend({ action: z.literal("edit") }).strict(),
  ADMIN_TOOLS.validate_risk_model.omit({ model_id: true }).extend({ action: z.literal("validate") }).strict(),
  ADMIN_TOOLS.retire_risk_model.omit({ model_id: true }).extend({ action: z.literal("retire") }).strict(),
  z.object({ action: z.literal("link_risk"), risk_id: ADMIN_TOOLS.link_risk.shape.risk_id, note: z.preprocess((v) => (typeof v === "string" && !v.trim() ? undefined : v), ADMIN_TOOLS.link_risk.shape.note) }).strict(),
]);

export async function GET(_req: Request, { params }: Params) {
  const { modelId } = await params;
  if (!isUuid(modelId)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading a risk model", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_risk_models"))) return json(UNSUPPORTED);
    const detail = modelDetailFrom(await callAdminTool(mynt, session, "list_risk_models", { model_id: modelId }));
    if (!detail) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    const whitelist = (await hasTools(mynt, "list_whitelist")) ? await callAdminTool(mynt, session, "list_whitelist", {}).catch((e) => (isAuthError(e) ? Promise.reject(e) : null)) : null;
    // Link risk's choices: Mynt's own risks not yet linked to this model (an admin keeps that register).
    const own = (await hasTools(mynt, "list_risks", "link_risk")) ? registerFrom(await callAdminTool(mynt, session, "list_risks", { subject_type: "platform", subject_id: "mynt" }).catch((e) => (isAuthError(e) ? Promise.reject(e) : null))) : null;
    const taken = new Set((detail.linked ?? []).map((l) => l.risk.id));
    const riskChoices = own ? own.risks.filter((r) => !taken.has(r.id)).map((r) => ({ id: r.id, title: r.title })) : null;
    return json({ detail, owners: adminOwnersFrom(whitelist), riskChoices });
  });
}

const DONE = {
  edit: "Model changed. A change to what it is is a new version; the old one is kept.",
  validate: "Validation recorded. It's the model's last validation now, and in its history.",
  retire: "Model retired. It stays listed with its versions and validations.",
  link_risk: "Risk linked to this model. It's in the risk's history.",
} as const;
const TOOL = { edit: "update_risk_model", validate: "validate_risk_model", retire: "retire_risk_model", link_risk: "link_risk" } as const;

export async function POST(req: Request, { params }: Params) {
  const { modelId } = await params;
  if (!isUuid(modelId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, ModelChange);
  if (!w.ok) return w.res;
  const { action, ...args } = w.body;
  return asAdmin("changing a risk model", async (mynt, session) => {
    if (!(await hasTools(mynt, TOOL[action]))) return json({ error: "unsupported", message: "Risk models come with Mynt's next update." }, 422);
    if (w.body.action === "link_risk") await callAdminTool(mynt, session, "link_risk", { risk_id: w.body.risk_id, target_type: "risk_model", target_id: modelId, ...(w.body.note ? { note: w.body.note } : {}) });
    else await callAdminTool(mynt, session, TOOL[action], { model_id: modelId, ...args });
    return json({ ok: true, message: DONE[action] });
  });
}
