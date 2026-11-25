import { z } from "zod";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { isLicenceProvider } from "@/lib/lp-agreements";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { isDeveloper, STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";
import { scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ agreementId: string }> };

// An agreement's row actions on the Licences page, from either side: Accept and Decline a proposal the other side
// made (respond_to_app_agreement, with an optional note), Sign an accepted one (sign_app_agreement), and Withdraw a
// proposal of one's own or End agreement (terminate_app_agreement, with the reason). Each tells the other side.
// Change scope (update_agreement_scopes): what a proposal of one's own covers, while it's still proposed.
const note = STUDIO_TOOLS.respond_to_app_agreement.shape.note;
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept"), note }).strict(),
  z.object({ action: z.literal("decline"), note }).strict(),
  z.object({ action: z.literal("sign") }).strict(),
  z.object({ action: z.literal("terminate"), reason: STUDIO_TOOLS.terminate_app_agreement.shape.reason }).strict(),
  z.object({ action: z.literal("scopes"), scopes: STUDIO_TOOLS.update_agreement_scopes.shape.scopes }).strict(),
]);

const TOOL = { accept: "respond_to_app_agreement", decline: "respond_to_app_agreement", sign: "sign_app_agreement", terminate: "terminate_app_agreement", scopes: "update_agreement_scopes" } as const;
const DONE = {
  accept: "Accepted. Both sides sign it next; the other side is told.",
  decline: "Declined. The other side is told.",
  sign: "Signed for your side. It's signed once the other side has signed too.",
  terminate: "Ended. The other side is told, with your reason.",
  scopes: "Scope changed. The other side answers the proposal with it.",
} as const;

const ids = (reply: unknown): string[] => {
  const list = reply && typeof reply === "object" ? (reply as { agreements?: { id?: unknown }[] }).agreements : undefined;
  return (Array.isArray(list) ? list : []).map((a) => a?.id).filter((x): x is string => typeof x === "string");
};

// The agreements Mynt lists to this person: their firm's (a licence provider), and their selected workspace's (a developer).
async function listed(mynt: Client, req: Request, roles: string[]): Promise<Set<string>> {
  const tools = await listMyntTools(mynt);
  const seen = new Set<string>();
  if (isLicenceProvider(roles)) ids(await callStudioTool(mynt, "list_app_agreements", {})).forEach((i) => seen.add(i));
  if (isDeveloper(roles)) {
    const scope = await scopeFor(mynt, req, workspaceSupport(tools));
    if (scope.unavailable !== undefined) return seen;
    const schema = tools.find((t) => t.name === "list_app_agreements")?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    if (scope.workspace && schema?.properties && "workspace_id" in schema.properties) ids(await callStudioTool(mynt, "list_app_agreements", { workspace_id: scope.workspace })).forEach((i) => seen.add(i));
    else {
      const apps = await callStudioTool(mynt, "list_my_apps", scope.workspace ? { workspace_id: scope.workspace } : {});
      for (const a of (Array.isArray(apps) ? apps : []).slice(0, 100))
        if (typeof a?.id === "string") ids(await callStudioTool(mynt, "list_app_agreements", { app_id: a.id }).catch(() => null)).forEach((i) => seen.add(i));
    }
  }
  return seen;
}

// POST: same origin, a signed-in licence provider or developer, and only an agreement Mynt lists to them. Mynt checks
// the rest again (who proposed, its status, who signs, owners and admins only on the app's side), and its refusal
// comes back as the message.
export async function POST(req: Request, { params }: Params) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const { agreementId } = await params;
  if (!z.string().uuid().safeParse(agreementId).success) return json({ error: "bad_request" }, 400);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That action isn't valid." }, 400);
  const body = parsed.data;
  return asDeveloper(
    "acting on an agreement",
    async (mynt, session) => {
      const tool = TOOL[body.action];
      if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "Agreements come with Mynt's next update." }, 501);
      if (!(await listed(mynt, req, session.roles ?? [])).has(agreementId)) return json({ error: "not_found", message: "That agreement isn't one of yours." }, 404);
      const args =
        body.action === "accept" || body.action === "decline"
          ? { agreement_id: agreementId, decision: body.action, ...(body.note ? { note: body.note } : {}) }
          : body.action === "terminate"
            ? { agreement_id: agreementId, reason: body.reason }
            : body.action === "scopes"
              ? { agreement_id: agreementId, scopes: body.scopes }
              : { agreement_id: agreementId };
      await callStudioTool(mynt, tool, args);
      return json({ ok: true, message: DONE[body.action] });
    },
    (session) => isLicenceProvider(session.roles ?? []) || isDeveloper(session.roles ?? []),
  );
}
