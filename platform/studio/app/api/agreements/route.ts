import { z } from "zod";
import { fromAgreements } from "@/lib/app-panel";
import { appAgreementsFrom, isLicenceProvider, lpAgreementsFrom, proposeTargetsFrom, type LpAgreementRow, type ProposeTarget } from "@/lib/lp-agreements";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { isDeveloper, STUDIO_TOOLS } from "@/lib/studio-tools";
import { asDeveloper, json } from "@/lib/studio-route";
import { scopeFor, workspaceSupport } from "@/lib/workspace-server";

export const dynamic = "force-dynamic";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_APPS = 100;
type Tool = { name: string; inputSchema?: unknown };
// Whether this Mynt's tool takes an argument (an older Mynt lists an app's agreements only by app).
const takes = (tools: Tool[], name: string, prop: string) => {
  const schema = tools.find((t) => t.name === name)?.inputSchema;
  return isObj(schema) && isObj(schema.properties) && prop in schema.properties;
};
const allowed = (roles: string[]) => isLicenceProvider(roles) || isDeveloper(roles);

// The Licences page's agreement tabs (Business agreements, MSA, SLA), one list from both sides:
// - a licence provider: the agreements made with its firm, either side proposing (list_app_agreements without
//   app_id; Mynt answers only for their own firm), and the workspaces it may propose to;
// - a developer: the selected workspace's agreements (list_app_agreements with workspace_id, or app by app on an
//   older Mynt), and the firms sponsoring its apps' products, to propose to.
// An account with both roles gets both, each row saying its side. Mynt decides what each may read and do.
export async function GET(req: Request) {
  return asDeveloper(
    "reading agreements",
    async (mynt, session) => {
      const tools = await listMyntTools(mynt);
      if (!tools.some((t) => t.name === "list_app_agreements")) return json({ error: "unsupported", message: "Agreements come with Mynt's next update." }, 501);
      const roles = session.roles ?? [];
      const agreements: LpAgreementRow[] = [];
      const targets: ProposeTarget[] = [];
      if (isLicenceProvider(roles)) {
        const reply = await callStudioTool(mynt, "list_app_agreements", {});
        const rows = lpAgreementsFrom(reply);
        if (!rows) return json({ error: "unreadable", message: "Mynt didn't answer with your firm's agreements." }, 502);
        agreements.push(...rows);
        if (tools.some((t) => t.name === "propose_workspace_agreement")) targets.push(...proposeTargetsFrom(reply, "counterparty"));
      }
      if (isDeveloper(roles)) {
        const scope = await scopeFor(mynt, req, workspaceSupport(tools));
        if (scope.unavailable === undefined) {
          const list = await callStudioTool(mynt, "list_my_apps", scope.workspace ? { workspace_id: scope.workspace } : {});
          const mine = (Array.isArray(list) ? list : []).filter(isObj).filter((a) => typeof a.id === "string").slice(0, MAX_APPS);
          const names = new Map(mine.map((a) => [a.id as string, typeof a.name === "string" && a.name.trim() ? a.name : "Untitled app"]));
          if (scope.workspace && takes(tools, "list_app_agreements", "workspace_id")) {
            // The whole workspace at once: its apps' agreements, every kind.
            const reply = await callStudioTool(mynt, "list_app_agreements", { workspace_id: scope.workspace });
            const read = appAgreementsFrom(reply);
            if (read) {
              agreements.push(...read.rows);
              if (read.canManage) targets.push(...proposeTargetsFrom(reply, "app", names));
            }
          } else {
            const replies = await Promise.all(mine.map((a) => callStudioTool(mynt, "list_app_agreements", { app_id: a.id as string }).catch(() => null)));
            const byFirm = new Map<string, ProposeTarget>();
            mine.forEach((a, i) => {
              const app = { id: a.id as string, name: names.get(a.id as string)! };
              const read = appAgreementsFrom(replies[i], app);
              if (!read) return;
              agreements.push(...read.rows);
              const panel = fromAgreements(replies[i]);
              if (!read.canManage || !panel) return;
              for (const s of panel.sponsors) {
                const t = byFirm.get(s.entityId) ?? { side: "app" as const, id: s.entityId, name: s.name, apps: [] };
                t.apps.push({ ...app, productIds: s.productIds });
                byFirm.set(s.entityId, t);
              }
            });
            targets.push(...byFirm.values());
          }
        }
      }
      return json({ agreements, targets, canPropose: { app: tools.some((t) => t.name === "propose_app_agreement"), counterparty: tools.some((t) => t.name === "propose_workspace_agreement") } });
    },
    (session) => allowed(session.roles ?? []),
  );
}

// What the Propose agreement sheet sends, from either side: the other party (target_id: the firm, for the app's side;
// the workspace, for a licence provider), the app (every agreement is for one app, MSAs and SLAs too), the kind and
// the terms. An empty optional field is left out.
const blank = (v: unknown) => (typeof v === "string" && !v.trim() ? undefined : v);
const W = STUDIO_TOOLS.propose_workspace_agreement.shape;
const Proposal = z
  .object({
    side: z.enum(["app", "counterparty"]),
    target_id: z.string().trim().min(1).max(200),
    app_id: z.preprocess(blank, W.app_id.optional()),
    kind: W.kind,
    products: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    terms_summary: W.terms_summary,
    document_url: z.preprocess(blank, W.document_url),
    document_sha256: z.preprocess(blank, W.document_sha256),
    template_id: z.preprocess(blank, W.template_id),
    effective_from: z.preprocess(blank, W.effective_from),
    effective_to: z.preprocess(blank, W.effective_to),
  })
  .strict()
  .refine((p) => Boolean(p.app_id), { message: "Choose the app this agreement covers." })
  .refine((p) => p.side === "counterparty" || !p.template_id, { message: "Templates are the licence provider's to choose." });

const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));

// POST: propose an agreement, from either side. Same origin and a signed-in developer or licence provider; the side
// must be one their roles hold. Mynt checks the rest again (owners and admins only on the app's side, the firm
// sponsors the products named, ...), and its refusal comes back as the message.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Proposal.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "That agreement isn't valid." }, 400);
  const p = parsed.data;
  return asDeveloper(
    "proposing an agreement",
    async (mynt, session) => {
      const roles = session.roles ?? [];
      if (p.side === "counterparty" ? !isLicenceProvider(roles) : !isDeveloper(roles)) return json({ error: "forbidden", message: "You can't propose from that side." }, 403);
      const tool = p.side === "app" ? "propose_app_agreement" : "propose_workspace_agreement";
      if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "Proposing this agreement comes with Mynt's next update." }, 501);
      const terms = { kind: p.kind, products: p.products, terms_summary: p.terms_summary, document_url: p.document_url, document_sha256: p.document_sha256, effective_from: p.effective_from, effective_to: p.effective_to };
      let args: Record<string, unknown>;
      if (p.side === "app") {
        if (!z.string().uuid().safeParse(p.target_id).success) return json({ error: "bad_request", message: "Choose the firm." }, 400);
        // propose_app_agreement always takes the products, even none.
        args = { ...defined({ app_id: p.app_id, counterparty_entity_id: p.target_id, ...terms }), products: p.products };
      } else {
        if (!STUDIO_TOOLS.propose_workspace_agreement.shape.workspace_id.safeParse(p.target_id).success) return json({ error: "bad_request", message: "Choose the workspace." }, 400);
        args = defined({ workspace_id: p.target_id, app_id: p.app_id, template_id: p.template_id, ...terms });
      }
      const check = STUDIO_TOOLS[tool].safeParse(args);
      if (!check.success) return json({ error: "bad_request", message: check.error.issues[0]?.message ?? "That agreement isn't valid." }, 400);
      await callStudioTool(mynt, tool, check.data);
      return json({ ok: true, message: "Agreement proposed. The other side is told; it's in force once they accept and both sides sign." });
    },
    (session) => allowed(session.roles ?? []),
  );
}
