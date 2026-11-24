import { z } from "zod";
import { AUDIT_ID, readJson, sessionCanUseAgreementAudits, TOO_LARGE } from "@/lib/agreement-audits-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slaId: string }> };

// One commitment's actions on the SLA tab, from either party: Record breach (record_sla_breach), Resolve breach
// (resolve_sla_breach) and Retire commitment (retire_agreement_sla, with the reason). Mynt checks who may.
const R = STUDIO_TOOLS.record_sla_breach.shape;
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("record_breach"), period_start: R.period_start, period_end: R.period_end, measured_value: R.measured_value, note: R.note }).strict(),
  z.object({ action: z.literal("resolve_breach"), breach_id: STUDIO_TOOLS.resolve_sla_breach.shape.breach_id, note: STUDIO_TOOLS.resolve_sla_breach.shape.note }).strict(),
  z.object({ action: z.literal("retire"), reason: STUDIO_TOOLS.retire_agreement_sla.shape.reason }).strict(),
]);
const TOOL = { record_breach: "record_sla_breach", resolve_breach: "resolve_sla_breach", retire: "retire_agreement_sla" } as const;
const DONE = {
  record_breach: "Breach recorded. The other side is told.",
  resolve_breach: "Breach resolved.",
  retire: "Commitment retired.",
} as const;
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);

export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { slaId } = await params;
  if (!AUDIT_ID.test(slaId)) return json({ error: "bad_request" }, 400);
  const body = await readJson(req);
  if (body === TOO_LARGE) return json({ error: "too_large", message: "That's too much to send at once." }, 413);
  const raw = body && typeof body === "object" ? Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, blank(v)]).filter(([, v]) => v !== undefined)) : null;
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That action isn't valid." }, 400);
  const b = parsed.data;
  return asDeveloper(
    "acting on an SLA commitment",
    async (mynt) => {
      const tool = TOOL[b.action];
      if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "SLA commitments come with Mynt's next update." }, 501);
      const args =
        b.action === "record_breach"
          ? { sla_id: slaId, period_start: b.period_start, period_end: b.period_end, measured_value: b.measured_value, ...(b.note ? { note: b.note } : {}) }
          : b.action === "resolve_breach"
            ? { breach_id: b.breach_id, ...(b.note ? { note: b.note } : {}) }
            : { sla_id: slaId, reason: b.reason };
      await callStudioTool(mynt, tool, args);
      return json({ ok: true, message: DONE[b.action] });
    },
    sessionCanUseAgreementAudits,
  );
}
