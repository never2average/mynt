import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auditEntriesFrom } from "@/lib/admin-audit";
import { adminOwnersFrom, areaParam, areaSignalsFrom, crossRisksFrom, PLATFORM_SUBJECT, TOP_RISKS, type RegisterAreaData } from "@/lib/admin-risks";
import { hasTools, writeBody } from "@/lib/admin-routes";
import { registerFrom, RISK_AREAS, unavailable } from "@/lib/risk-register";
import { RiskChangeRequest } from "@/lib/risk-register-server";
import type { Session } from "@/lib/session-store";
import { callAdminTool, isAuthError } from "@/lib/studio-server";
import type { AdminTool } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Risk register (/platform/risk-register), one risk area at a time (?area=financial, compliance, third_party,
// operations, business_process, technology or regulated_product). GET: Mynt's own risk register in that area, and its
// risks with no area (list_risks for the platform subject, which only Mynt admins keep and read), the open risks
// across every app and product in that area (admin_list_risks), and that area's signals (ops_status; for Technology,
// audit_log's security entries of the last 30 days). A part this Mynt can't answer is "Not available." with why, never
// an empty table. POST: Add risk or Review risk on the platform register (add_risk, update_risk), as the app and
// product registers' sheets send them; a platform risk always has an area.
const NO_REGISTER = "Mynt's own risk register comes with Mynt's next update.";

async function readOr(mynt: Client, session: Session, tool: AdminTool, args: Record<string, unknown>): Promise<unknown | null> {
  if (!(await hasTools(mynt, tool))) return null;
  try {
    return await callAdminTool(mynt, session, tool, args);
  } catch (err) {
    if (isAuthError(err)) throw err;
    return null;
  }
}

export async function GET(req: Request) {
  const area = areaParam(new URL(req.url).searchParams.get("area"));
  if (!area) return json({ error: "bad_request", message: `area must be one of ${RISK_AREAS.join(", ")}.` }, 400);
  return asAdmin("reading the risk register", async (mynt, session) => {
    const subject = { subject_type: PLATFORM_SUBJECT.type, subject_id: PLATFORM_SUBJECT.id };
    const [registerReply, unassignedReply, whitelist, cross, ops, log] = [
      await readOr(mynt, session, "list_risks", { ...subject, risk_area: area }),
      await readOr(mynt, session, "list_risks", { ...subject, risk_area: "unassigned" }),
      await readOr(mynt, session, "list_whitelist", {}),
      await readOr(mynt, session, "admin_list_risks", { limit: TOP_RISKS, risk_area: area }),
      await readOr(mynt, session, "ops_status", {}),
      area === "technology" ? await readOr(mynt, session, "audit_log", { limit: 500 }) : null,
    ];
    const owners = adminOwnersFrom(whitelist);
    const read = (reply: unknown) => (reply === null ? unavailable(NO_REGISTER) : (registerFrom(reply, owners) ?? unavailable("Mynt didn't answer with the risk register.")));
    const data: RegisterAreaData = {
      area,
      register: read(registerReply),
      unassigned: read(unassignedReply),
      cross: cross === null ? unavailable("Risks across apps and products come with Mynt's next update.") : crossRisksFrom(cross, area),
      signals: areaSignalsFrom(area, ops, log === null ? null : auditEntriesFrom(log)),
    };
    return json(data);
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, RiskChangeRequest);
  if (!w.ok) return w.res;
  const change = w.body;
  if (change.action === "add" && !change.risk_area) return json({ error: "bad_request", message: "Pick the risk's area: every risk on Mynt's own register has one." }, 400);
  return asAdmin("changing Mynt's risk register", async (mynt, session) => {
    if (!(await hasTools(mynt, "add_risk", "update_risk", "list_risks"))) return json({ error: "unsupported", message: NO_REGISTER }, 422);
    const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
    const subject = { subject_type: PLATFORM_SUBJECT.type, subject_id: PLATFORM_SUBJECT.id };
    if (change.action === "add") {
      const { action: _a, ...rest } = change;
      await callAdminTool(mynt, session, "add_risk", defined({ ...subject, ...rest }));
      return json({ ok: true, message: "Risk added. It's open on Mynt's register, and recorded in the audit trail." });
    }
    const { action: _a, ...rest } = change;
    // The risk must be on the platform register: Mynt refuses a risk_id that isn't.
    await callAdminTool(mynt, session, "list_risks", { ...subject, risk_id: change.risk_id });
    await callAdminTool(mynt, session, "update_risk", defined(rest));
    return json({ ok: true, message: "Risk reviewed. The change is recorded in its history." });
  });
}
