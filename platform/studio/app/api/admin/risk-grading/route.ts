import { z } from "zod";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { gradingFrom } from "@/lib/risk-grading";
import { callAdminTool } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Admin → Platform settings → Risk grading. GET: how Mynt grades every risk (get_risk_grading): the levels, the
// inherent and residual bands, the residual method, the version in force and every version kept. POST: Edit grading
// (set_risk_grading with what changes and why) or Restore this version (set_risk_grading with restore_version and
// why); either becomes a new version, and Mynt derives the residual scores that aren't overridden again. Same origin,
// signed in, and an account Mynt says is an admin, or 404; Mynt checks the role and the bands again, its refusal the
// message. An older Mynt without risk grading answers { supported: false }.
const set = ADMIN_TOOLS.set_risk_grading.omit({ restore_version: true });
const GradingChange = z.discriminatedUnion("action", [
  set.extend({ action: z.literal("set") }).strict(),
  z.object({ action: z.literal("restore"), version: z.number().int().min(1), note: set.shape.note }).strict(),
]);

export async function GET() {
  return asAdmin("reading the risk grading", async (mynt, session) => {
    if (!(await hasTools(mynt, "get_risk_grading"))) return json(UNSUPPORTED);
    const grading = gradingFrom(await callAdminTool(mynt, session, "get_risk_grading", {}));
    return grading ? json({ grading }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
  });
}

export async function POST(req: Request) {
  const w = await writeBody(req, GradingChange);
  if (!w.ok) return w.res;
  const change = w.body;
  return asAdmin("changing the risk grading", async (mynt, session) => {
    if (!(await hasTools(mynt, "set_risk_grading"))) return json({ error: "unsupported", message: "Risk grading comes with Mynt's next update." }, 422);
    const { action: _a, ...rest } = change;
    const args = change.action === "restore" ? { restore_version: change.version, note: change.note } : rest;
    const reply = (await callAdminTool(mynt, session, "set_risk_grading", args)) as { version?: number; residuals_changed?: number } | null;
    const moved = typeof reply?.residuals_changed === "number" ? reply.residuals_changed : null;
    const movedWords = moved === null ? "" : moved === 1 ? " 1 residual score was derived again and moved." : ` ${moved} residual scores were derived again and moved.`;
    return json({ ok: true, version: reply?.version ?? null, message: `${change.action === "restore" ? `Version ${change.version} restored` : "Grading changed"}: it is version ${reply?.version ?? "the newest"} now.${movedWords}` });
  });
}
