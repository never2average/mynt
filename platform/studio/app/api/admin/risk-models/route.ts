import { adminOwnersFrom, areaParam } from "@/lib/admin-risks";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { RISK_AREAS, unavailable } from "@/lib/risk-register";
import { modelListFrom, productModelsFrom } from "@/lib/risk-models";
import { callAdminTool, isAuthError } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Risk models (/platform/risk-models), one risk area at a time (?area=…, as the Risk register's). GET: Mynt's
// own risk models in that area (list_risk_models), the admins who may own one (list_whitelist), and on the Regulated
// product risk tab the risk models financial products declare in their definitions (admin_list_product_risk_models,
// read-only). An older Mynt without risk models answers { supported: false }. POST: Add risk model (add_risk_model),
// its own arguments, checked here first and again by Mynt.
export async function GET(req: Request) {
  const area = areaParam(new URL(req.url).searchParams.get("area"));
  if (!area) return json({ error: "bad_request", message: `area must be one of ${RISK_AREAS.join(", ")}.` }, 400);
  return asAdmin("reading risk models", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_risk_models"))) return json(UNSUPPORTED);
    const models = modelListFrom(await callAdminTool(mynt, session, "list_risk_models", { risk_area: area })) ?? unavailable("Mynt didn't answer with its risk models.");
    const whitelist = (await hasTools(mynt, "list_whitelist")) ? await callAdminTool(mynt, session, "list_whitelist", {}).catch((e) => (isAuthError(e) ? Promise.reject(e) : null)) : null;
    let productModels = null;
    if (area === "regulated_product")
      productModels = (await hasTools(mynt, "admin_list_product_risk_models"))
        ? productModelsFrom(await callAdminTool(mynt, session, "admin_list_product_risk_models", {}).catch((e) => (isAuthError(e) ? Promise.reject(e) : null)))
        : unavailable("Reading financial products' own risk models comes with Mynt's next update.");
    return json({ area, models, owners: adminOwnersFrom(whitelist), productModels });
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, ADMIN_TOOLS.add_risk_model);
  if (!w.ok) return w.res;
  return asAdmin("adding a risk model", async (mynt, session) => {
    if (!(await hasTools(mynt, "add_risk_model"))) return json({ error: "unsupported", message: "Risk models come with Mynt's next update." }, 422);
    const reply = (await callAdminTool(mynt, session, "add_risk_model", w.body)) as { model?: { id?: string } } | null;
    return json({ ok: true, id: reply?.model?.id ?? null, message: "Risk model added at version 1. It's recorded in the audit trail." });
  });
}
