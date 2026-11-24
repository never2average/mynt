import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { auditEntriesFrom } from "@/lib/admin-audit";
import { adminOwnersFrom, crossRisksFrom, PLATFORM_SUBJECT, platformSignalsFrom, securityEventsFrom, TOP_RISKS, type RisksData } from "@/lib/admin-risks";
import { hasTools, writeBody } from "@/lib/admin-routes";
import { registerFrom, unavailable } from "@/lib/risk-register";
import { RiskChangeRequest } from "@/lib/risk-register-server";
import type { Session } from "@/lib/session-store";
import { callAdminTool, isAuthError } from "@/lib/studio-server";
import type { AdminTool } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Security & risk (/platform/risks). GET: Mynt's own risk register (list_risks for the platform subject, which
// only Mynt admins keep and read), the open risks across every app and product (admin_list_risks: counts by level
// and the 20 highest scored), and the platform's signals (ops_status; audit_log's security entries of the last 30
// days). A part this Mynt can't answer is "Not available." with why, never an empty table. POST: Add risk or Review
// risk on the platform register (add_risk, update_risk), as the app and product registers' sheets send them.
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

export async function GET() {
  return asAdmin("reading security and risk", async (mynt, session) => {
    const subject = { subject_type: PLATFORM_SUBJECT.type, subject_id: PLATFORM_SUBJECT.id };
    const [registerReply, whitelist, cross, ops, log] = [
      await readOr(mynt, session, "list_risks", subject),
      await readOr(mynt, session, "list_whitelist", {}),
      await readOr(mynt, session, "admin_list_risks", { limit: TOP_RISKS }),
      await readOr(mynt, session, "ops_status", {}),
      await readOr(mynt, session, "audit_log", { limit: 500 }),
    ];
    const register = registerReply === null ? unavailable(NO_REGISTER) : (registerFrom(registerReply, adminOwnersFrom(whitelist)) ?? unavailable("Mynt didn't answer with the risk register."));
    const data: RisksData = {
      register,
      cross: cross === null ? unavailable("Risks across apps and products come with Mynt's next update.") : crossRisksFrom(cross),
      signals: platformSignalsFrom(ops),
      security: securityEventsFrom(log === null ? null : auditEntriesFrom(log)),
    };
    return json(data);
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, RiskChangeRequest);
  if (!w.ok) return w.res;
  const change = w.body;
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
