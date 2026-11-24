// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, STUDIO_TOOLS } from "@/lib/studio-tools";
import { personIdOf } from "@/lib/people";

// Platform admin → People's route (/api/admin/people): Mynt admins only (anyone else, a 404 with nothing sent to Mynt),
// writes only from the studio's own origin with a strict body, invite_user always given the roles someone already has
// plus the ones picked (replacing only when asked), Mynt's admin role only from make_admin, a firm added when picked,
// revoke_user confirmed by the email, and Mynt's refusals in its words.

const fake = {
  session: undefined as Session | undefined,
  sameOrigin: true,
  tools: [] as { name: string }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: {} as Record<string, string>,
  reply: {} as Record<string, unknown>,
};
vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => fake.sameOrigin, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: fake.refuse[name] }] };
      return { content: [{ type: "text", text: JSON.stringify(fake.reply[name] ?? { ok: true }) }] };
    },
    close: async () => undefined,
  }),
}));

const people = await import("@/app/api/admin/people/route");

const FIRM = "33333333-3333-4333-8333-333333333333";
const LEE = "66666666-6666-4666-8666-666666666666";
const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const get = (q = "") => people.GET(new Request(`http://studio.test/api/admin/people${q}`));
const post = (body: unknown) => people.POST(new Request("http://studio.test/api/admin/people", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = {};
  fake.reply = {
    list_whitelist: {
      public_signup: false,
      whitelist: [
        { email: "boss@example.com", roles: ["admin"], created_at: "2026-09-01T00:00:00.000Z" },
        { email: "lee@example.com", roles: ["license_provider"], created_at: "2026-10-01T00:00:00.000Z" },
        { email: "new@example.com", roles: ["developer"], created_at: "2026-11-01T00:00:00.000Z" },
      ],
      users: [
        { id: LEE, name: "Lee", email: "lee@example.com", roles: ["license_provider"], created_at: "2026-10-02T00:00:00.000Z" },
        { id: "77777777-7777-4777-8777-777777777777", name: "Gone", email: "gone@example.com", roles: ["consumer"], created_at: "2026-08-01T00:00:00.000Z" },
      ],
    },
    list_entities: [{ id: FIRM, name: "Acme Trust", members: [{ id: LEE, email: "lee@example.com", roles: ["license_provider"] }] }],
    audit_log: [
      { id: "a1", action: "invite_user", target: "lee@example.com", actor_email: "boss@example.com", details: { roles: ["license_provider"] }, created_at: "2026-10-01T00:00:00.000Z" },
      { id: "a2", action: "add_entity_member", target: FIRM, actor_email: "boss@example.com", details: { email: "lee@example.com" }, created_at: "2026-10-03T00:00:00.000Z" },
      { id: "a3", action: "invite_user", target: "someone@example.com", actor_email: "boss@example.com", details: {}, created_at: "2026-10-04T00:00:00.000Z" },
    ],
    add_entity_member: { entity_id: FIRM, entity: "Acme Trust", member: "lee@example.com" },
  };
});

describe("who gets in", () => {
  it("a non-admin gets 404 from reading and every action, and nothing reaches Mynt's admin tools", async () => {
    fake.session = session(["developer", "license_provider", "vendor"]);
    expect((await get()).status).toBe(404);
    expect((await get(`?id=${personIdOf("lee@example.com", null)}`)).status).toBe(404);
    for (const body of [
      { action: "invite", email: "a@example.com", roles: ["vendor"], make_admin: false },
      { action: "set_roles", email: "lee@example.com", roles: ["vendor"], make_admin: false, mode: "add" },
      { action: "revoke", email: "lee@example.com", confirm_email: "lee@example.com" },
    ])
      expect((await post(body)).status).toBe(404);
    expect(fake.calls).toEqual([]);
  });

  it("signed out is 401; another origin is 403; a body that isn't one of the actions is 400", async () => {
    fake.session = undefined;
    expect((await get()).status).toBe(401);
    fake.session = session(["admin"]);
    fake.sameOrigin = false;
    expect((await post({ action: "invite", email: "a@example.com", roles: ["vendor"], make_admin: false })).status).toBe(403);
    fake.sameOrigin = true;
    for (const body of [
      { action: "invite", email: "a@example.com", roles: ["admin"], make_admin: false }, // admin is never a role checkbox
      { action: "invite", email: "not an email", roles: ["vendor"], make_admin: false },
      { action: "invite", email: "a@example.com", roles: [], make_admin: false }, // no role at all
      { action: "invite", email: "a@example.com", roles: ["vendor"] }, // make_admin must be said
      { action: "invite", email: "a@example.com", roles: ["vendor"], make_admin: false, firm_id: "../x" },
      { action: "invite", email: "a@example.com", roles: ["vendor"], make_admin: false, extra: 1 },
      { action: "set_roles", email: "lee@example.com", roles: ["vendor"], make_admin: false }, // add or replace must be said
      { action: "revoke", email: "lee@example.com", confirm_email: "someone@example.com" },
      { action: "delete_everything" },
    ])
      expect((await post(body)).status, JSON.stringify(body)).toBe(400);
    expect(called("invite_user")).toEqual([]);
    expect((await get("?id=../x")).status).toBe(400);
  });

  it("the new tools are admin tools only, never the studio's", () => {
    for (const t of ["revoke_user", "audit_log"]) {
      expect(Object.keys(ADMIN_TOOLS)).toContain(t);
      expect(Object.keys(STUDIO_TOOLS)).not.toContain(t);
    }
  });
});

describe("reading", () => {
  it("lists everyone invited or signed in, with status in words' keys, firm and dates", async () => {
    const body = await (await get()).json();
    expect(body.publicSignup).toBe(false);
    expect(body.firms).toEqual([{ id: FIRM, name: "Acme Trust" }]);
    const by = Object.fromEntries(body.people.map((p: { email: string }) => [p.email, p]));
    expect(by["lee@example.com"]).toMatchObject({ status: "signed_in", userId: LEE, name: "Lee", roles: ["license_provider"], firms: [{ id: FIRM, name: "Acme Trust" }], joinedAt: "2026-10-02T00:00:00.000Z" });
    expect(by["new@example.com"]).toMatchObject({ status: "invited", userId: null, joinedAt: null, invitedAt: "2026-11-01T00:00:00.000Z" });
    expect(by["gone@example.com"]).toMatchObject({ status: "no_access" });
    expect(called("list_whitelist")).toEqual([{}]);
  });

  it("one person, with their activity from the audit log (about them or by them)", async () => {
    const body = await (await get(`?id=${personIdOf("lee@example.com", LEE)}`)).json();
    expect(body.person.email).toBe("lee@example.com");
    expect(body.activity.map((a: { id: string }) => a.id)).toEqual(["a1", "a2"]);
    expect(called("audit_log")).toEqual([{ limit: 500 }]);
  });

  it("no audit log on this Mynt: activity is null, not an empty list", async () => {
    fake.tools = fake.tools.filter((t) => t.name !== "audit_log");
    const body = await (await get(`?id=${personIdOf("lee@example.com", LEE)}`)).json();
    expect(body.activity).toBeNull();
  });

  it("an older Mynt without list_whitelist: not supported", async () => {
    fake.tools = [];
    expect(await (await get()).json()).toEqual({ supported: false });
  });
});

describe("Invite person", () => {
  it("someone new: invite_user with exactly the roles picked, and the sign-in line", async () => {
    const res = await post({ action: "invite", email: "Fresh@Example.com", roles: ["vendor", "liquidity_provider"], make_admin: false });
    expect(res.status).toBe(200);
    expect(called("invite_user")).toEqual([{ email: "fresh@example.com", roles: ["vendor", "liquidity_provider"] }]);
    expect((await res.json()).message).toContain("They can sign in with this email straight away.");
  });

  it("someone already on the list: their roles are merged, never dropped, and the answer says so", async () => {
    const body = await (await post({ action: "invite", email: "lee@example.com", roles: ["vendor"], make_admin: false })).json();
    expect(called("invite_user")).toEqual([{ email: "lee@example.com", roles: ["license_provider", "vendor"] }]);
    expect(body.message).toBe("Already has: Licence provider; adding: Vendor.");
    expect(body.adding).toEqual(["vendor"]);
  });

  it("Mynt's admin role only with make_admin, and kept for an admin invited again", async () => {
    await post({ action: "invite", email: "fresh@example.com", roles: ["developer"], make_admin: true });
    await post({ action: "invite", email: "boss@example.com", roles: ["vendor"], make_admin: false });
    expect(called("invite_user")).toEqual([
      { email: "fresh@example.com", roles: ["developer", "admin"] },
      { email: "boss@example.com", roles: ["admin", "vendor"] },
    ]);
  });

  it("with a firm: also add_entity_member; someone not signed in yet is invited and told to be added later", async () => {
    const ok = await (await post({ action: "invite", email: "lee@example.com", roles: ["license_provider"], make_admin: false, firm_id: FIRM })).json();
    expect(called("add_entity_member")).toEqual([{ email: "lee@example.com", entity_id: FIRM }]);
    expect(called("invite_user")).toEqual([]); // nothing new to add: the list isn't touched
    expect(ok).toMatchObject({ ok: true, added: true });
    expect(ok.message).toContain("Added to Acme Trust");
    fake.refuse.add_entity_member = JSON.stringify({ error: "fresh@example.com hasn't signed in to Mynt yet" });
    const later = await (await post({ action: "invite", email: "fresh@example.com", roles: ["vendor"], make_admin: false, firm_id: FIRM })).json();
    expect(later).toMatchObject({ ok: true, added: false });
    expect(later.message).toContain("haven't signed in yet");
  });

  it("Mynt's refusal is shown in its words", async () => {
    fake.refuse.invite_user = JSON.stringify({ error: "That would remove the last admin; make someone else an admin first" });
    const res = await post({ action: "set_roles", email: "boss@example.com", roles: ["vendor"], make_admin: false, mode: "replace" });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe("That would remove the last admin; make someone else an admin first");
  });
});

describe("Change roles and Revoke access", () => {
  it("add keeps what they have; replace sets exactly what's picked and says what goes", async () => {
    await post({ action: "set_roles", email: "lee@example.com", roles: ["vendor"], make_admin: false, mode: "add" });
    const replaced = await (await post({ action: "set_roles", email: "lee@example.com", roles: ["vendor"], make_admin: false, mode: "replace" })).json();
    expect(called("invite_user")).toEqual([
      { email: "lee@example.com", roles: ["license_provider", "vendor"] },
      { email: "lee@example.com", roles: ["vendor"] },
    ]);
    expect(replaced.message).toBe("Already has: Licence provider; adding: Vendor; removing: Licence provider.");
  });

  it("changing the roles of someone who isn't on the list is refused: Invite person instead", async () => {
    const res = await post({ action: "set_roles", email: "nobody@example.com", roles: ["vendor"], make_admin: false, mode: "add" });
    expect(res.status).toBe(422);
    expect(called("invite_user")).toEqual([]);
  });

  it("revoke: revoke_user with their email, once confirmed", async () => {
    const res = await post({ action: "revoke", email: "lee@example.com", confirm_email: "lee@example.com" });
    expect(res.status).toBe(200);
    expect(called("revoke_user")).toEqual([{ email: "lee@example.com" }]);
    expect((await res.json()).message).toContain("can no longer use Mynt");
    expect((await post({ action: "revoke", email: "nobody@example.com", confirm_email: "nobody@example.com" })).status).toBe(422);
  });
});
