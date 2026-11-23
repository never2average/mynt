import { z } from "zod";
import { fromAgreementAudit } from "@/lib/agreement-audits";
import { AUDIT_ID, readJson, sessionCanUseAgreementAudits, TOO_LARGE } from "@/lib/agreement-audits-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ auditId: string }> };

// GET: one audit for its detail sheet (get_agreement_audit): findings, evidence, history and what
// the caller may do next. Only the agreement's parties read it; Mynt checks.
export async function GET(_req: Request, { params }: Params) {
  const { auditId } = await params;
  if (!AUDIT_ID.test(auditId)) return json({ error: "bad_request" }, 400);
  return asDeveloper(
    "loading an agreement audit",
    async (mynt) => {
      if (!(await listMyntTools(mynt)).some((t) => t.name === "get_agreement_audit")) return json({ supported: false });
      const audit = fromAgreementAudit(await callStudioTool(mynt, "get_agreement_audit", { audit_id: auditId }));
      return audit ? json({ supported: true, audit }) : json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    },
    sessionCanUseAgreementAudits,
  );
}

// The sheet's labelled actions, each one of Mynt's tools. The licence provider's: Open audit,
// Record finding, Resolve finding, Pass, Fail, Waive. The app side's: Submit evidence, Respond to
// finding. Mynt checks the caller's side on the agreement again.
const T = STUDIO_TOOLS;
const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open") }).strict(),
  T.record_agreement_audit_finding.omit({ audit_id: true }).extend({ action: z.literal("record_finding") }),
  T.resolve_agreement_audit_finding.omit({ audit_id: true }).extend({ action: z.literal("resolve_finding") }),
  z.object({ action: z.literal("pass"), note: z.string().trim().max(4000).optional() }).strict(),
  z.object({ action: z.literal("fail"), note: z.string().trim().min(3).max(4000) }).strict(),
  z.object({ action: z.literal("waive"), note: z.string().trim().min(3).max(4000) }).strict(),
  T.submit_agreement_audit_evidence.omit({ audit_id: true }).extend({ action: z.literal("submit_evidence") }),
  T.respond_to_agreement_audit_finding.omit({ audit_id: true }).extend({ action: z.literal("respond_to_finding") }),
]);
type ActionBody = z.infer<typeof Action>;

const DONE: Record<ActionBody["action"], string> = {
  open: "Audit opened. You're its reviewer, and the app's side is told.",
  record_finding: "Finding recorded. The app's side can answer it.",
  resolve_finding: "Finding resolved.",
  pass: "Audit passed. Mynt opens the next one when it's due.",
  fail: "Audit failed. Mynt opens the next one when it's due.",
  waive: "Audit waived. Mynt opens the next one when it's due.",
  submit_evidence: "Evidence submitted. The licence provider is told and reviews it.",
  respond_to_finding: "Response sent to the licence provider.",
};

function toolCall(auditId: string, b: ActionBody): { tool: string; args: Record<string, unknown> } {
  const { action, ...rest } = b;
  const args = { audit_id: auditId, ...rest };
  switch (action) {
    case "open":
      return { tool: "open_agreement_audit", args };
    case "record_finding":
      return { tool: "record_agreement_audit_finding", args };
    case "resolve_finding":
      return { tool: "resolve_agreement_audit_finding", args };
    case "pass":
    case "fail":
    case "waive":
      return { tool: "close_agreement_audit", args: { ...args, outcome: action === "pass" ? "passed" : action === "fail" ? "failed" : "waived" } };
    case "submit_evidence":
      return { tool: "submit_agreement_audit_evidence", args };
    case "respond_to_finding":
      return { tool: "respond_to_agreement_audit_finding", args };
  }
}

// POST { action, ... }: one of the sheet's actions. Same origin, a signed-in developer or licence
// provider, a small JSON body (evidence is https links with their SHA-256, never files).
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { auditId } = await params;
  if (!AUDIT_ID.test(auditId)) return json({ error: "bad_request" }, 400);
  const body = await readJson(req);
  if (body === TOO_LARGE) return json({ error: "too_large", message: "That's too much to send at once." }, 413);
  const parsed = Action.safeParse(body);
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That isn't valid." }, 400);
  const call = toolCall(auditId, parsed.data);
  return asDeveloper(
    "acting on an agreement audit",
    async (mynt) => {
      if (!(await listMyntTools(mynt)).some((t) => t.name === call.tool)) return json({ error: "unsupported", message: "That comes with Mynt's next update." }, 501);
      await callStudioTool(mynt, call.tool, call.args);
      return json({ ok: true, message: DONE[parsed.data.action] });
    },
    sessionCanUseAgreementAudits,
  );
}
