import { z } from "zod";
import { hasTools, isUuid, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { FIRM_MEMBER_ROLES, firmRoleChange } from "@/lib/admin-members";
import { changeWords } from "@/lib/people";
import { callAdminTool, MyntRefusedError } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ firmId: string }> };

// Admin → Firms → one firm → Members: its three labelled actions, each from its own sheet.
// - invite: lets the email sign in to Mynt with the roles picked (invite_user, keeping every role they already have),
//   then makes them a member of the firm (add_entity_member). Someone who hasn't signed in yet has no account to add:
//   Mynt keeps the membership (status pending_sign_in) and applies it when they first sign in. A Mynt from before that
//   refuses instead, and the admin adds them once they have signed in (the same action again). The firm's members are
//   told by Mynt.
// - change_role: their roles for this firm are exactly the ones picked; every other role they hold (Mynt admin, user)
//   stays (invite_user with the merged list).
// - remove: takes them out of the firm (remove_entity_member); they keep their sign-in and roles.
// A firm's people: never Mynt's admin role from here (it isn't one of FIRM_MEMBER_ROLES).
const email = ADMIN_TOOLS.invite_user.shape.email;
const roles = z.array(z.enum(FIRM_MEMBER_ROLES)).min(1).max(FIRM_MEMBER_ROLES.length);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), email, roles }).strict(),
  z.object({ action: z.literal("change_role"), email, roles }).strict(),
  z.object({ action: z.literal("remove"), email, confirm_email: email }).strict(),
]);

type Whitelist = { whitelist?: { email?: string; roles?: string[] }[] } | null;

export async function POST(req: Request, { params }: Params) {
  const { firmId } = await params;
  if (!isUuid(firmId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  const body = w.body;
  if (body.action === "remove" && body.confirm_email !== body.email) return json({ error: "bad_request", message: "Type their email again to confirm." }, 400);
  return asAdmin("changing a firm's members", async (mynt, session) => {
    if (body.action === "remove") {
      if (!(await hasTools(mynt, "remove_entity_member"))) return json(UNSUPPORTED);
      const removed = (await callAdminTool(mynt, session, "remove_entity_member", { entity_id: firmId, email: body.email })) as { was?: string } | null;
      if (removed?.was === "pending_sign_in") return json({ ok: true, message: `${body.email} won't join the firm when they sign in. They can still sign in with their roles.` });
      return json({ ok: true, message: `${body.email} is no longer a member of the firm. They can still sign in with their roles; its members were told.` });
    }
    const list = (await callAdminTool(mynt, session, "list_whitelist", {})) as Whitelist;
    const had = (list?.whitelist ?? []).find((i) => i.email?.toLowerCase() === body.email)?.roles ?? [];

    if (body.action === "change_role") {
      const change = firmRoleChange(had, body.roles);
      if (change.adding.length || change.removing.length) await callAdminTool(mynt, session, "invite_user", { email: body.email, roles: change.roles });
      return json({ ok: true, ...change, message: changeWords(change) });
    }

    // invite_user sets an email's roles outright: someone already allowed in keeps the roles they had (an admin stays
    // an admin), and gets the ones picked as well.
    await callAdminTool(mynt, session, "invite_user", { email: body.email, roles: [...new Set([...had, ...body.roles])] });
    try {
      const r = (await callAdminTool(mynt, session, "add_entity_member", { email: body.email, entity_id: firmId })) as { status?: string; note?: string } | null;
      const pending = r?.status === "pending_acceptance";
      // No account yet (accounts are made at sign-in): Mynt keeps the membership and applies it at their first sign-in.
      if (r?.status === "pending_sign_in")
        return json({ ok: true, added: false, pending_sign_in: true, message: `${body.email} can now sign in with those roles, and joins the firm when they first do. Nothing more to do here.` });
      return json({
        ok: true,
        added: true,
        message: pending
          ? `${body.email} can sign in and is in the firm, but its licence providers accept them before they have any licence-provider powers there.`
          : r?.note === "Already a member"
            ? `${body.email} is already a member of the firm.`
            : `${body.email} can sign in and is a member of the firm. Its members were told.`,
      });
    } catch (err) {
      // Not signed in yet: invited only. Any other refusal is Mynt's, in its words.
      if (err instanceof MyntRefusedError && /hasn't signed in/.test(err.raw))
        return json({ ok: true, added: false, message: `${body.email} can now sign in with those roles. Once they have, use Invite member again to add them to the firm.` });
      throw err;
    }
  });
}
