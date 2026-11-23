import { z } from "zod";
import { isUuid, writeBody } from "@/lib/admin-routes";
import { callAdminTool, MyntRefusedError } from "@/lib/studio-server";
import { ADMIN_TOOLS } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ firmId: string }> };

// Admin → Firms → Invite member: lets the email sign in to Mynt with the roles picked (invite_user), then makes them
// a member of the firm (add_entity_member). Someone who hasn't signed in yet can't be added: they're allowed in, and
// the admin adds them once they have (the same action again). The firm's members are told by Mynt when someone joins.
// A firm's people: never Mynt's admin role from here.
const FIRM_ROLES = ["consumer", "developer", "innovator", "vendor", "license_provider", "liquidity_provider"] as const;
const Body = z.object({ email: ADMIN_TOOLS.invite_user.shape.email, roles: z.array(z.enum(FIRM_ROLES)).min(1).max(FIRM_ROLES.length) }).strict();

export async function POST(req: Request, { params }: Params) {
  const { firmId } = await params;
  if (!isUuid(firmId)) return json({ error: "bad_request" }, 400);
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  const { email, roles } = w.body;
  return asAdmin("inviting a firm member", async (mynt, session) => {
    // invite_user sets an email's roles outright: someone already allowed in keeps the roles they had (an admin stays
    // an admin), and gets the ones picked as well.
    const list = (await callAdminTool(mynt, session, "list_whitelist", {})) as { whitelist?: { email?: string; roles?: string[] }[] } | null;
    const had = (list?.whitelist ?? []).find((i) => i.email?.toLowerCase() === email)?.roles ?? [];
    await callAdminTool(mynt, session, "invite_user", { email, roles: [...new Set([...had, ...roles])] });
    try {
      const r = (await callAdminTool(mynt, session, "add_entity_member", { email, entity_id: firmId })) as { status?: string; note?: string } | null;
      const pending = r?.status === "pending_acceptance";
      return json({
        ok: true,
        added: true,
        message: pending
          ? `${email} can sign in and is in the firm, but its licence providers accept them before they have any licence-provider powers there.`
          : `${email} can sign in and is a member of the firm. Its members were told.`,
      });
    } catch (err) {
      // Not signed in yet: invited only. Any other refusal is Mynt's, in its words.
      if (err instanceof MyntRefusedError && /hasn't signed in/.test(err.raw))
        return json({ ok: true, added: false, message: `${email} can now sign in with those roles. Once they have, use Invite member again to add them to the firm.` });
      throw err;
    }
  });
}
