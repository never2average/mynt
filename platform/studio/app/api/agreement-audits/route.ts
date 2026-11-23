import { fromAgreementAuditList } from "@/lib/agreement-audits";
import { readJson, sessionCanUseAgreementAudits, TOO_LARGE } from "@/lib/agreement-audits-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { isDeveloper, STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";
import { scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// GET: the Audits page's Agreement audits tab: list_agreement_audits. A developer sees the selected
// workspace's apps' audits (and, if they're also a licence provider, those on agreements with their
// firm); a licence provider sees those on agreements with their firm. `supported: false` until this
// Mynt has the tool. Mynt decides who reads what: only an agreement's parties.
export async function GET(req: Request) {
  return asDeveloper(
    "loading agreement audits",
    async (mynt, session) => {
      const tools = await listMyntTools(mynt);
      if (!tools.some((t) => t.name === "list_agreement_audits")) return json({ supported: false });
      let args: Record<string, unknown> = {};
      if (isDeveloper(session.roles ?? [])) {
        const scope = await scopeFor(mynt, req, workspaceSupport(tools));
        if (scope.unavailable !== undefined) return json({ supported: true, unavailable: scope.unavailable });
        if (scope.workspace) args = { workspace_id: scope.workspace };
      } else args = { side: "counterparty" };
      const list = fromAgreementAuditList(await callStudioTool(mynt, "list_agreement_audits", args));
      if (!list) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
      return json({ supported: true, list, canAddRequirement: tools.some((t) => t.name === "add_agreement_audit_requirement") });
    },
    sessionCanUseAgreementAudits,
  );
}

const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const Requirement = STUDIO_TOOLS.add_agreement_audit_requirement;

// POST: Add audit requirement (a licence provider, on a program agreement with their firm). Same
// origin, a signed-in developer or licence provider, a small JSON body; Mynt checks the rest
// (their firm is the agreement's counterparty, the cadence and dates) and its refusal comes back as
// the message.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const body = await readJson(req);
  if (body === TOO_LARGE) return json({ error: "too_large", message: "That's too much to send at once." }, 413);
  const raw = body && typeof body === "object" ? Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, blank(v)]).filter(([, v]) => v !== undefined)) : null;
  const parsed = Requirement.safeParse(raw);
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That requirement isn't valid." }, 400);
  return asDeveloper(
    "adding an agreement audit requirement",
    async (mynt) => {
      if (!(await listMyntTools(mynt)).some((t) => t.name === "add_agreement_audit_requirement")) return json({ error: "unsupported", message: "Audit requirements come with Mynt's next update." }, 501);
      const reply = (await callStudioTool(mynt, "add_agreement_audit_requirement", parsed.data)) as { opened?: unknown[] } | null;
      const opened = Array.isArray(reply?.opened) ? reply.opened.length : 0;
      return json({ ok: true, message: opened ? "Audit requirement added. Its first audit is open now." : "Audit requirement added. Mynt opens each audit when it's due, once the agreement is signed." });
    },
    sessionCanUseAgreementAudits,
  );
}
