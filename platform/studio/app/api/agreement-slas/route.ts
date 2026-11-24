import { readJson, sessionCanUseAgreementAudits, TOO_LARGE } from "@/lib/agreement-audits-server";
import { fromSlaList } from "@/lib/agreement-slas";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { isDeveloper, STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";
import { scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

// GET: the Licences page's SLA tab: the commitments and breaches of the service level agreements the caller is a
// party to (list_agreement_slas). A developer sees the selected workspace's (and, as a licence provider too, its
// firm's); a licence provider sees its firm's. `supported: false` until this Mynt has the tool.
export async function GET(req: Request) {
  return asDeveloper(
    "loading agreement SLAs",
    async (mynt, session) => {
      const tools = await listMyntTools(mynt);
      if (!tools.some((t) => t.name === "list_agreement_slas")) return json({ supported: false });
      let args: Record<string, unknown> = {};
      if (isDeveloper(session.roles ?? [])) {
        const scope = await scopeFor(mynt, req, workspaceSupport(tools));
        if (scope.unavailable !== undefined) return json({ supported: true, unavailable: scope.unavailable });
        if (scope.workspace) args = { workspace_id: scope.workspace };
      } else args = { side: "counterparty" };
      const list = fromSlaList(await callStudioTool(mynt, "list_agreement_slas", { ...args, include_retired: true }));
      if (!list) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
      return json({ supported: true, list });
    },
    sessionCanUseAgreementAudits,
  );
}

const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);

// POST: Add commitment (either party, on a service level agreement not yet signed). Same origin, a small JSON body;
// Mynt checks the rest and its refusal comes back as the message.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const body = await readJson(req);
  if (body === TOO_LARGE) return json({ error: "too_large", message: "That's too much to send at once." }, 413);
  const raw = body && typeof body === "object" ? Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, blank(v)]).filter(([, v]) => v !== undefined)) : null;
  const parsed = STUDIO_TOOLS.add_agreement_sla.safeParse(raw);
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That commitment isn't valid." }, 400);
  return asDeveloper(
    "adding an SLA commitment",
    async (mynt) => {
      if (!(await listMyntTools(mynt)).some((t) => t.name === "add_agreement_sla")) return json({ error: "unsupported", message: "SLA commitments come with Mynt's next update." }, 501);
      await callStudioTool(mynt, "add_agreement_sla", parsed.data);
      return json({ ok: true, message: "Commitment added. It's in force once the service level agreement is signed by both sides." });
    },
    sessionCanUseAgreementAudits,
  );
}
