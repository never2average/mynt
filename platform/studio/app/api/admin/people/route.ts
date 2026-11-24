import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { z } from "zod";
import { hasTools, UNSUPPORTED, writeBody } from "@/lib/admin-routes";
import { addRoles, changeWords, PERSON_ID, PERSON_ROLES, peopleFrom, personActivityFrom, replaceRoles, rolesWords, SIGN_IN_PREVIEW, type RoleChange } from "@/lib/people";
import type { Session } from "@/lib/session-store";
import { callAdminTool, MyntRefusedError } from "@/lib/studio-server";
import { ADMIN_TOOLS, MYNT_ROLES } from "@/lib/studio-tools";
import { asAdmin, json } from "@/lib/studio-route";

export const dynamic = "force-dynamic";

// Platform admin → People: everyone who may sign in to Mynt and everyone who has (list_whitelist), with their firm
// (list_entities). GET lists them, or with ?id= one person and their Activity (audit_log, when this Mynt has it).
// POST is one of three actions: invite (invite_user with the roles they already have kept, then add_entity_member
// when a firm is picked), set_roles (add, or replace when chosen explicitly) and revoke (revoke_user). Mynt's admin
// role only ever comes from make_admin, never from the role list.

const ACTIVITY_LIMIT = 500;

const loadPeople = async (mynt: Client, session: Session) => {
  const entities = (await hasTools(mynt, "list_entities")) ? await callAdminTool(mynt, session, "list_entities", {}) : null;
  const list = peopleFrom(await callAdminTool(mynt, session, "list_whitelist", {}), entities);
  const firms = Array.isArray(entities) ? (entities as { id?: unknown; name?: unknown }[]).map((e) => ({ id: String(e.id), name: String(e.name ?? e.id) })) : null;
  return { list, firms };
};

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  if (id !== null && !PERSON_ID.test(id)) return json({ error: "bad_request" }, 400);
  return asAdmin("reading people", async (mynt, session) => {
    if (!(await hasTools(mynt, "list_whitelist"))) return json(UNSUPPORTED);
    const { list, firms } = await loadPeople(mynt, session);
    if (!list) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    if (id === null) return json({ people: list.people, firms, publicSignup: list.publicSignup });
    const person = list.people.find((p) => p.id === id);
    if (!person) return json({ error: "not_found", message: "Nobody with that id may sign in to Mynt or has signed in." }, 404);
    // Activity: null when this Mynt has no audit log to read (the tab isn't shown then).
    const activity = (await hasTools(mynt, "audit_log")) ? personActivityFrom(await callAdminTool(mynt, session, "audit_log", { limit: ACTIVITY_LIMIT }), person) : null;
    return json({ person, firms, activity, activityLimit: ACTIVITY_LIMIT });
  });
}

const email = ADMIN_TOOLS.invite_user.shape.email;
const roles = z.array(z.enum(PERSON_ROLES)).max(PERSON_ROLES.length);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("invite"), email, roles, make_admin: z.boolean(), firm_id: z.string().uuid().optional() }).strict(),
  z.object({ action: z.literal("set_roles"), email, roles, make_admin: z.boolean(), mode: z.enum(["add", "replace"]) }).strict(),
  z.object({ action: z.literal("revoke"), email, confirm_email: email }).strict(),
]);

const isRole = (r: string): r is (typeof MYNT_ROLES)[number] => (MYNT_ROLES as readonly string[]).includes(r);

export async function POST(req: Request) {
  const w = await writeBody(req, Body);
  if (!w.ok) return w.res;
  const body = w.body;
  if (body.action !== "revoke" && !body.roles.length && !body.make_admin) return json({ error: "bad_request", message: "Pick at least one role." }, 400);
  if (body.action === "revoke" && body.confirm_email !== body.email) return json({ error: "bad_request", message: "Type their email again to confirm." }, 400);
  return asAdmin("changing who may sign in", async (mynt, session) => {
    const list = peopleFrom(await callAdminTool(mynt, session, "list_whitelist", {}));
    if (!list) return json({ error: "unreadable", message: "Mynt's answer wasn't readable." }, 502);
    const invited = list.people.find((p) => p.email === body.email && p.status !== "no_access") ?? null;

    if (body.action === "revoke") {
      if (!invited) return json({ error: "not_invited", message: `${body.email} isn't on the list of people who may sign in.` }, 422);
      await callAdminTool(mynt, session, "revoke_user", { email: body.email });
      return json({ ok: true, message: `${body.email} can no longer use Mynt, from their next request. What they created stays.` });
    }

    const had = (invited?.roles ?? []).filter(isRole);
    const picked = [...body.roles, ...(body.make_admin ? ["admin"] : [])];
    let change: RoleChange;
    if (body.action === "set_roles" && body.mode === "replace") {
      if (!invited) return json({ error: "not_invited", message: `${body.email} isn't on the list of people who may sign in. Use Invite person.` }, 422);
      change = replaceRoles(had, picked);
    } else {
      if (body.action === "set_roles" && !invited) return json({ error: "not_invited", message: `${body.email} isn't on the list of people who may sign in. Use Invite person.` }, 422);
      change = addRoles(had, picked);
    }
    const changes = change.adding.length > 0 || change.removing.length > 0 || !invited;
    if (changes) await callAdminTool(mynt, session, "invite_user", { email: body.email, roles: change.roles });
    const said = invited ? changeWords(change) : `${body.email} may now sign in as ${rolesWords(change.roles)}. ${SIGN_IN_PREVIEW}`;

    if (body.action === "invite" && body.firm_id) {
      try {
        const r = (await callAdminTool(mynt, session, "add_entity_member", { email: body.email, entity_id: body.firm_id })) as { status?: string; entity?: string; note?: string } | null;
        const firm = r?.entity ?? "the firm";
        const pending = r?.status === "pending_acceptance";
        return json({
          ok: true,
          added: true,
          ...change,
          message: `${said} ${pending ? `They're in ${firm}, but its licence providers accept them before they have any licence-provider powers there.` : r?.note === "Already a member" ? `Already a member of ${firm}.` : `Added to ${firm}; its members were told.`}`,
        });
      } catch (err) {
        // Not signed in yet: invited only, added to the firm once they have. Any other refusal is Mynt's, in its words.
        if (err instanceof MyntRefusedError && /hasn't signed in/.test(err.raw))
          return json({ ok: true, added: false, ...change, message: `${said} They haven't signed in yet, so they aren't in the firm: once they have, add them from the firm's page (Invite member).` });
        throw err;
      }
    }
    return json({ ok: true, ...change, message: said });
  });
}
