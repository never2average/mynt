// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ADMIN_TOOLS, parseAdminCall, parseStudioCall, STUDIO_TOOLS } from "@/lib/studio-tools";

// The platform admin's routes (app/api/admin/*) and pages (app/(platform), /platform/…): only for an account Mynt says is an admin (anyone else, a 404,
// with nothing sent to Mynt), writes only from the studio's own origin, strict bodies, and every action an existing
// admin tool with exactly the arguments the sheet gave. Admin tools are a separate allow-list nobody else can call.

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
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

const overview = await import("@/app/api/admin/overview/route");
const settings = await import("@/app/api/admin/settings/route");
const workspaces = await import("@/app/api/admin/workspaces/route");
const workspace = await import("@/app/api/admin/workspaces/[workspaceId]/route");
const wsMembers = await import("@/app/api/admin/workspaces/[workspaceId]/members/route");
const firms = await import("@/app/api/admin/firms/route");
const firm = await import("@/app/api/admin/firms/[firmId]/route");
const members = await import("@/app/api/admin/firms/[firmId]/members/route");
const firmStatus = await import("@/app/api/admin/firms/[firmId]/status/route");
const licences = await import("@/app/api/admin/licences/route");
const licence = await import("@/app/api/admin/licences/[licenceId]/route");
const vendors = await import("@/app/api/admin/vendors/route");
const serviceTypes = await import("@/app/api/admin/vendors/service-types/route");
const offering = await import("@/app/api/admin/vendors/offerings/[offeringId]/route");
const overviewPage = await import("@/app/(platform)/platform/page");
const sectionPage = await import("@/app/(platform)/platform/[section]/page");
const detailPage = await import("@/app/(platform)/platform/[section]/[id]/page");
const platformLayout = await import("@/app/(platform)/layout");
const settingsPage = await import("@/app/(studio)/settings/page");

const WS = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const INV = "66666666-6666-4666-8666-666666666666";
const FIRM = "33333333-3333-4333-8333-333333333333";
const LIC = "44444444-4444-4444-8444-444444444444";
const OFF = "55555555-5555-4555-8555-555555555555";

const session = (roles: string[]) => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() }) as Session;
const req = (path: string, body?: unknown) =>
  new Request(`http://studio.test${path}`, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const called = (name: string) => fake.calls.filter((c) => c.name === name).map((c) => c.args);

const ENTITY = {
  id: FIRM,
  name: "Acme Trust",
  status: "active",
  legal_form: "company_private",
  incorporation: { country: "us" },
  regions: ["US"],
  members: [{ id: "u1", name: "Lee", email: "lee@example.com", roles: ["license_provider"] }],
  licenses: [{ id: LIC, entity_id: FIRM, region: "US", regulator_id: "occ", license_id: "trust_charter", registration_number: "T-1", status: "pending", valid_from: null, valid_to: "2027-01-01" }],
  created_at: "2026-10-01T00:00:00.000Z",
};

beforeEach(() => {
  fake.session = session(["admin"]);
  fake.sameOrigin = true;
  fake.tools = Object.keys(ADMIN_TOOLS).map((name) => ({ name }));
  fake.calls = [];
  fake.refuse = {};
  fake.reply = {
    ops_status: { attention: ["builds: 1 failed in the last 24h"], window_hours: 24, agents: { builds: { failures: [{}], stuck: [], spend_this_month_usd: 6.75 } }, hosting: {}, backups: { status: "no status file" } },
    get_platform_settings: { settings: [{ key: "BUILD_CAP_USD", value: "10", default: "10", source: "default", description: "Spend cap" }] },
    list_all_workspaces: { workspaces: [{ id: WS, name: "Team", status: "frozen", members: 2, apps: 1, owner: { id: "u", email: "ana@example.com" } }], total: 1 },
    admin_get_workspace: { workspace: { id: WS, name: "Team", status: "active" }, members: [{ user_id: USER, name: "Ana", email: "ana@example.com", role: "owner" }], apps: [], invitations: [{ id: INV, email: "new@example.com", role: "member", status: "open" }], activity: [] },
    admin_invite_workspace_member: { id: INV, workspace_id: WS, email: "new@example.com", role: "member", mynt_role: "developer", note: "new@example.com can now sign in to Mynt as a user and accept the invite" },
    list_all_products: { products: [{ id: "p1", name: "Fixed deposit", status: "published", stage: "production", firm: { id: FIRM, name: "Acme Trust" }, sponsors: [] }], total: 1 },
    list_entities: [ENTITY],
    list_whitelist: { whitelist: [{ email: "boss@example.com", roles: ["admin"] }, { email: "lee@example.com", roles: ["license_provider", "consumer"] }], users: [] },
    register_firm: { id: FIRM, name: "Acme Trust" },
    list_license_reviews: [],
    list_service_types: [{ region: "US", key: "kyc_basic", name: "KYC", category: "kyc", consent_purpose: "kyc", moves_money: false }],
    list_vendor_offerings: [{ offering_id: OFF, name: "Fast KYC", vendor: "Acme Trust", vendor_entity_id: FIRM, region: "US", service_type: { key: "kyc_basic", name: "KYC", category: "kyc" }, status: "listed", conformance: { passed: true, at: "2026-11-01T00:00:00.000Z" } }],
    get_vendor_onboarding: { firms: [{ entity_id: FIRM, name: "Acme Trust", status: "active", vendor_members: 1, services: 1, listed: 1, progress: { done: 5, total: 6, next: { key: "terms", title: "Set your standard terms", status: "next" }, complete: false } }] },
  };
});

describe("who gets in", () => {
  it("a non-admin gets 404 from every route and the page, and nothing reaches Mynt's admin tools", async () => {
    fake.session = session(["developer", "license_provider", "vendor"]);
    const gets = [overview.GET(req("/api/admin/overview")), settings.GET(), workspaces.GET(), workspace.GET(req("/x"), p({ workspaceId: WS })), firms.GET(), firm.GET(req("/x"), p({ firmId: FIRM })), licences.GET(), vendors.GET()];
    for (const res of await Promise.all(gets)) expect(res.status).toBe(404);
    const posts = [
      firms.POST(req("/api/admin/firms", { name: "X" })),
      members.POST(req("/x", { action: "invite", email: "a@example.com", roles: ["vendor"] }), p({ firmId: FIRM })),
      members.POST(req("/x", { action: "remove", email: "lee@example.com", confirm_email: "lee@example.com" }), p({ firmId: FIRM })),
      wsMembers.POST(req("/x", { action: "invite", email: "a@example.com", role: "member" }), p({ workspaceId: WS })),
      wsMembers.POST(req("/x", { action: "remove", user_id: USER, confirm: true }), p({ workspaceId: WS })),
      firmStatus.POST(req("/x", { status: "suspended", note: "registry says so" }), p({ firmId: FIRM })),
      licence.POST(req("/x", { decision: "verified" }), p({ licenceId: LIC })),
      offering.POST(req("/x", { suspended: true, note: "broken" }), p({ offeringId: OFF })),
    ];
    for (const res of await Promise.all(posts)) expect(res.status).toBe(404);
    expect(fake.calls).toEqual([]);
    const pages = () => [
      overviewPage.default(),
      sectionPage.default({ params: Promise.resolve({ section: "firms" }) }),
      detailPage.default({ params: Promise.resolve({ section: "firms", id: FIRM }) }),
      platformLayout.default({ children: null }),
    ];
    for (const page of pages()) await expect(page).rejects.toThrow("NEXT_NOT_FOUND");
    fake.session = undefined;
    expect((await firms.GET()).status).toBe(401);
    for (const page of pages()) await expect(page).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("an admin gets each section at its own address, and each detail at /platform/<section>/<id>", async () => {
    type El = { props: { tab: string; id: string | null } };
    expect(((await overviewPage.default()) as El).props).toMatchObject({ tab: "overview", id: null });
    for (const section of ["workspaces", "firms", "vendors", "audit", "risk-models", "risk-register", "settings"]) {
      const el = (await sectionPage.default({ params: Promise.resolve({ section }) })) as El;
      expect(el.props).toMatchObject({ tab: section, id: null });
    }
    for (const section of ["workspaces", "firms", "audit", "risk-models"]) {
      const el = (await detailPage.default({ params: Promise.resolve({ section, id: FIRM }) })) as El;
      expect(el.props).toMatchObject({ tab: section, id: FIRM });
    }
    // Tab titles: the section's name ("Platform settings · Mynt platform admin", from the layout's template).
    expect(await sectionPage.generateMetadata({ params: Promise.resolve({ section: "settings" }) })).toEqual({ title: "Platform settings" });
    expect(await detailPage.generateMetadata({ params: Promise.resolve({ section: "firms", id: FIRM }) })).toEqual({ title: "Regulated firms" });
    expect(await sectionPage.generateMetadata({ params: Promise.resolve({ section: "firms" }) })).toEqual({ title: "Regulated firms" });
    expect(platformLayout.metadata.title).toEqual({ default: "Mynt platform admin", template: "%s · Mynt platform admin" });
    // Anything else is a 404: an unknown section, Overview by name, an id where a section has no details, an id that isn't one.
    expect(await sectionPage.generateMetadata({ params: Promise.resolve({ section: "audit" }) })).toEqual({ title: "Audit trails" });
    expect(await sectionPage.generateMetadata({ params: Promise.resolve({ section: "risk-models" }) })).toEqual({ title: "Risk models" });
    expect(await sectionPage.generateMetadata({ params: Promise.resolve({ section: "risk-register" }) })).toEqual({ title: "Risk register" });
    expect(await detailPage.generateMetadata({ params: Promise.resolve({ section: "risk-models", id: FIRM }) })).toEqual({ title: "Risk models" });
    // Apps, People and Products are no longer sections: their pages and details are 404s.
    // Licences isn't one either (it's the firms section's tab; the proxy redirects its old address before the page is asked).
    for (const section of ["nope", "overview", "admin", "apps", "people", "products", "risks", "licences"]) await expect(sectionPage.default({ params: Promise.resolve({ section }) })).rejects.toThrow("NEXT_NOT_FOUND");
    const bad: [string, string][] = [["products", FIRM], ["licences", LIC], ["vendors", OFF], ["settings", "x"], ["overview", FIRM], ["firms", "../x"], ["apps", FIRM], ["people", FIRM], ["products", FIRM], ["risks", FIRM], ["risk-register", FIRM], ["risk-models", "../x"], ["firms", "x".repeat(101)]];
    for (const [section, id] of bad) await expect(detailPage.default({ params: Promise.resolve({ section, id }) })).rejects.toThrow("NEXT_NOT_FOUND");
    // The layout is the platform admin's own, not the studio's shell.
    const layout = (await platformLayout.default({ children: "page" })) as { type: { name: string }; props: { children: unknown } };
    expect(layout.type.name).toBe("PlatformShell");
    expect(layout.props.children).toBe("page");
  });

  it("workspace Settings' old E-signature tab goes to the platform admin's Platform settings", async () => {
    await expect(settingsPage.default({ searchParams: Promise.resolve({ tab: "esign" }) })).rejects.toThrow("NEXT_REDIRECT /platform/settings");
  });

  it("writes come only from the studio's own origin, with strict bodies", async () => {
    fake.sameOrigin = false;
    expect((await firms.POST(req("/api/admin/firms", { name: "X" }))).status).toBe(403);
    fake.sameOrigin = true;
    expect((await firms.POST(req("/api/admin/firms", { name: "X", owner: "me" }))).status).toBe(400);
    expect((await members.POST(req("/x", { action: "invite", email: "a@example.com", roles: ["root"] }), p({ firmId: FIRM }))).status).toBe(400);
    expect((await members.POST(req("/x", { action: "invite", email: "a@example.com", roles: ["admin"] }), p({ firmId: FIRM }))).status).toBe(400); // never Mynt's admin role from a firm
    expect((await members.POST(req("/x", { action: "change_role", email: "a@example.com", roles: ["admin"] }), p({ firmId: FIRM }))).status).toBe(400);
    expect((await members.POST(req("/x", { email: "a@example.com", roles: ["vendor"] }), p({ firmId: FIRM }))).status).toBe(400); // an action is named
    expect((await members.POST(req("/x", { action: "invite", email: "a@example.com", roles: ["vendor"] }), p({ firmId: "../x" }))).status).toBe(400);
    expect((await members.POST(req("/x", { action: "remove", email: "lee@example.com", confirm_email: "someone@example.com" }), p({ firmId: FIRM }))).status).toBe(400);
    expect((await wsMembers.POST(req("/x", { action: "remove", user_id: USER }), p({ workspaceId: WS }))).status).toBe(400); // confirmed
    expect((await wsMembers.POST(req("/x", { action: "change_role", user_id: USER, role: "root" }), p({ workspaceId: WS }))).status).toBe(400);
    expect((await wsMembers.POST(req("/x", { action: "invite", email: "a@example.com", role: "member", mynt_role: "admin" }), p({ workspaceId: WS }))).status).toBe(400);
    expect((await wsMembers.POST(req("/x", { action: "invite", email: "a@example.com", role: "member" }), p({ workspaceId: "x" }))).status).toBe(400);
    expect((await licence.POST(req("/x", { decision: "rejected" }), p({ licenceId: LIC }))).status).toBe(400); // a rejection says why
    expect(fake.calls).toEqual([]);
  });
});

describe("the allow-list", () => {
  it("admin tools are their own list: never callable through the studio's, and strict", () => {
    for (const t of Object.keys(ADMIN_TOOLS)) if (!["list_vendor_offerings", "list_service_types", "get_vendor_onboarding", "list_risks", "add_risk", "update_risk"].includes(t)) expect(Object.keys(STUDIO_TOOLS)).not.toContain(t);
    // The risk tools are on both lists: the studio's take an app's or a product's register, the admin area's only Mynt's own.
    expect(parseStudioCall("list_risks", { subject_type: "platform", subject_id: "mynt" })).toHaveProperty("error");
    expect(parseAdminCall("list_risks", { subject_type: "platform", subject_id: "mynt" })).toHaveProperty("tool");
    expect(parseAdminCall("list_risks", { subject_type: "app", subject_id: FIRM })).toHaveProperty("error");
    // The apps' tools and People's revoke_user are no longer the Studio's (they stay Mynt's MCP admin tools).
    for (const t of ["list_all_apps", "admin_get_app", "remove_app", "revoke_user"]) expect(Object.keys(ADMIN_TOOLS)).not.toContain(t);
    // get_vendor_onboarding is on both lists: a service provider reads its own firm's through the studio's, which never
    // takes an admin's arguments (another firm, or every firm).
    expect(parseStudioCall("get_vendor_onboarding", { all_firms: true })).toHaveProperty("error");
    expect(parseStudioCall("get_vendor_onboarding", { entity_id: FIRM })).toHaveProperty("error");
    expect(parseAdminCall("get_vendor_onboarding", { all_firms: true })).toHaveProperty("tool");
    expect(parseAdminCall("get_vendor_onboarding", { entity_id: FIRM })).toHaveProperty("error");
    for (const t of ["get_esign_settings", "remove_app", "register_firm", "review_license", "invite_user"]) expect(parseStudioCall(t, {})).toHaveProperty("error");
    expect(parseAdminCall("invite_user", { email: "a@example.com", roles: ["vendor"] })).toHaveProperty("tool");
    expect(parseAdminCall("invite_user", { email: "a@example.com", roles: [] })).toHaveProperty("error");
    expect(parseAdminCall("list_vendor_offerings", { include_unlisted: false })).toHaveProperty("error");
    expect(parseAdminCall("approve_mainnet_program", {})).toHaveProperty("error"); // not in the Admin area
    expect(parseAdminCall("define_region", {})).toHaveProperty("error");
  });
});

describe("each tab's read", () => {
  it("platform-wide reads, never with a workspace; an older Mynt says not yet", async () => {
    const ops = await (await overview.GET(req("/api/admin/overview?hours=48"))).json();
    expect(called("ops_status")).toEqual([{ hours: 48 }]);
    expect(ops.ops.attention).toEqual(["builds: 1 failed in the last 24h"]);
    const builds = ops.ops.agents.find((a: { name: string }) => a.name === "builds");
    expect(builds).toMatchObject({ failed: 1, spend: 6.75, measured: true });
    expect(ops.ops.agents.find((a: { name: string }) => a.name === "desk")).toMatchObject({ spend: null, measured: false }); // not 0
    expect((await (await settings.GET()).json()).settings[0].key).toBe("BUILD_CAP_USD");
    expect((await (await workspaces.GET()).json()).workspaces[0]).toMatchObject({ id: WS, status: "frozen", owner: { email: "ana@example.com" } });
    expect(called("list_all_workspaces")).toEqual([{ limit: 500 }]);
    expect((await (await workspace.GET(req("/x"), p({ workspaceId: WS }))).json()).detail.workspace.name).toBe("Team");
    const f = await (await firms.GET()).json();
    expect(f.firms[0]).toMatchObject({ name: "Acme Trust", types: ["license_provider"] });
    const one = await (await firm.GET(req("/x"), p({ firmId: FIRM }))).json();
    expect(one.offerings.map((o: { id: string }) => o.id)).toEqual([OFF]);
    expect(one.products.map((x: { id: string }) => x.id)).toEqual(["p1"]);
    expect(called("list_vendor_offerings")).toEqual([{ include_unlisted: true }]);
    await licences.GET();
    expect(called("list_license_reviews")).toEqual([{ status: "pending" }, { status: "verified" }, { status: "rejected" }, { status: "suspended" }]);
    const v = await (await vendors.GET()).json();
    expect(v.serviceTypes[0].key).toBe("kyc_basic");
    expect(v.offerings[0].conformance.passed).toBe(true);
    expect(v.firms[0]).toMatchObject({ entityId: FIRM, done: 5, total: 6, next: { title: "Set your standard terms", waitingOnMynt: false } });
    expect(called("get_vendor_onboarding")).toEqual([{ all_firms: true }]);
    expect(fake.calls.every((c) => !("workspace_id" in c.args) || c.name === "admin_get_workspace")).toBe(true);

    fake.tools = [];
    for (const res of [await overview.GET(req("/api/admin/overview")), await workspaces.GET(), await settings.GET(), await firms.GET(), await licences.GET(), await vendors.GET()])
      expect(await res.json()).toEqual({ supported: false });
  });
});

describe("each action", () => {
  it("Register firm → register_firm", async () => {
    const body = { name: "Acme Trust", legal_form: "company_private", incorporation: { country: "us" }, regions: ["US"], identifiers: [{ scheme: "lei", value: "5493001KJTIIGC8Y1R12" }] };
    const res = await firms.POST(req("/api/admin/firms", body));
    expect(res.status).toBe(200);
    expect(called("register_firm")).toEqual([body]);
  });

  it("a firm's Invite member → invite_user then add_entity_member; someone not signed in yet is invited only", async () => {
    const res = await members.POST(req("/x", { action: "invite", email: "New@Example.com", roles: ["license_provider"] }), p({ firmId: FIRM }));
    expect((await res.json()).added).toBe(true);
    expect(called("invite_user")).toEqual([{ email: "new@example.com", roles: ["license_provider"] }]);
    expect(called("add_entity_member")).toEqual([{ email: "new@example.com", entity_id: FIRM }]);
    fake.refuse.add_entity_member = JSON.stringify({ error: "new@example.com hasn't signed in to Mynt yet" });
    const later = await (await members.POST(req("/x", { action: "invite", email: "new@example.com", roles: ["vendor"] }), p({ firmId: FIRM }))).json();
    expect(later).toMatchObject({ ok: true, added: false });
    expect(later.message).toContain("Once they have");
    // Someone already allowed in keeps their roles: an admin added to a firm stays an admin.
    await members.POST(req("/x", { action: "invite", email: "boss@example.com", roles: ["vendor"] }), p({ firmId: FIRM }));
    expect(called("invite_user").at(-1)).toEqual({ email: "boss@example.com", roles: ["admin", "vendor"] });
  });

  it("a firm's Invite member for someone not signed in yet: Mynt keeps the membership for their first sign-in, and Remove cancels it", async () => {
    fake.reply.add_entity_member = { entity_id: FIRM, member: "new@example.com", status: "pending_sign_in", note: "new@example.com hasn't signed in to Mynt yet: they join Acme Trust when they first sign in" };
    const invited = await (await members.POST(req("/x", { action: "invite", email: "new@example.com", roles: ["vendor"] }), p({ firmId: FIRM }))).json();
    expect(invited).toMatchObject({ ok: true, added: false, pending_sign_in: true });
    expect(invited.message).toContain("joins the firm when they first do");
    expect(invited.message).not.toContain("Invite member again");
    fake.reply.remove_entity_member = { entity_id: FIRM, removed: "new@example.com", was: "pending_sign_in" };
    const removed = await (await members.POST(req("/x", { action: "remove", email: "new@example.com", confirm_email: "new@example.com" }), p({ firmId: FIRM }))).json();
    expect(removed.message).toContain("won't join the firm when they sign in");
  });

  it("a firm's Change role → invite_user with the firm's roles replaced and every other role kept; nothing sent when nothing changes", async () => {
    const res = await (await members.POST(req("/x", { action: "change_role", email: "lee@example.com", roles: ["vendor"] }), p({ firmId: FIRM }))).json();
    expect(called("invite_user")).toEqual([{ email: "lee@example.com", roles: ["consumer", "vendor"] }]);
    expect(res.message).toContain("removing: Licence provider");
    await members.POST(req("/x", { action: "change_role", email: "boss@example.com", roles: ["license_provider"] }), p({ firmId: FIRM }));
    expect(called("invite_user").at(-1)).toEqual({ email: "boss@example.com", roles: ["admin", "license_provider"] }); // Mynt admin stays
    fake.calls = [];
    await members.POST(req("/x", { action: "change_role", email: "lee@example.com", roles: ["license_provider"] }), p({ firmId: FIRM }));
    expect(called("invite_user")).toEqual([]);
  });

  it("a firm's Remove → remove_entity_member, once the email is typed again; an older Mynt says not yet", async () => {
    expect((await members.POST(req("/x", { action: "remove", email: "lee@example.com", confirm_email: "lee@example.com" }), p({ firmId: FIRM }))).status).toBe(200);
    expect(called("remove_entity_member")).toEqual([{ entity_id: FIRM, email: "lee@example.com" }]);
    expect(called("invite_user")).toEqual([]); // their sign-in and roles are untouched
    fake.tools = fake.tools.filter((t) => t.name !== "remove_entity_member");
    expect(await (await members.POST(req("/x", { action: "remove", email: "lee@example.com", confirm_email: "lee@example.com" }), p({ firmId: FIRM }))).json()).toEqual({ supported: false });
  });

  it("a workspace's Invite member, Change role, Remove and withdrawing an invitation → the admin workspace tools", async () => {
    const inv = await (await wsMembers.POST(req("/x", { action: "invite", email: "New@Example.com", role: "admin" }), p({ workspaceId: WS }))).json();
    expect(inv.message).toContain("can now sign in");
    await wsMembers.POST(req("/x", { action: "change_role", user_id: USER, role: "member" }), p({ workspaceId: WS }));
    await wsMembers.POST(req("/x", { action: "remove", user_id: USER, confirm: true }), p({ workspaceId: WS }));
    await wsMembers.POST(req("/x", { action: "revoke_invite", invite_id: INV }), p({ workspaceId: WS }));
    expect(called("admin_invite_workspace_member")).toEqual([{ workspace_id: WS, email: "new@example.com", role: "admin" }]);
    expect(called("admin_change_workspace_member_role")).toEqual([{ workspace_id: WS, user_id: USER, role: "member" }]);
    expect(called("admin_remove_workspace_member")).toEqual([{ workspace_id: WS, user_id: USER }]);
    expect(called("admin_revoke_workspace_invite")).toEqual([{ invite_id: INV }]);
    // An invitation that isn't this workspace's isn't withdrawn.
    const other = await wsMembers.POST(req("/x", { action: "revoke_invite", invite_id: LIC }), p({ workspaceId: WS }));
    expect(other.status).toBe(404);
    expect(called("admin_revoke_workspace_invite")).toHaveLength(1);
    // Mynt's refusal (the last owner) in its words.
    fake.refuse.admin_remove_workspace_member = JSON.stringify({ error: "A workspace needs an owner: it can't lose its last one" });
    const refused = await wsMembers.POST(req("/x", { action: "remove", user_id: USER, confirm: true }), p({ workspaceId: WS }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("A workspace needs an owner: it can't lose its last one");
    fake.tools = [];
    expect(await (await wsMembers.POST(req("/x", { action: "invite", email: "a@example.com", role: "member" }), p({ workspaceId: WS }))).json()).toEqual({ supported: false });
  });

  it("Set firm status → set_entity_status", async () => {
    expect((await firmStatus.POST(req("/x", { status: "suspended", note: "Registry shows it suspended" }), p({ firmId: FIRM }))).status).toBe(200);
    expect(called("set_entity_status")).toEqual([{ entity_id: FIRM, status: "suspended", note: "Registry shows it suspended" }]);
  });

  it("Verify licence / Reject licence → review_license; Mynt's refusal in its words", async () => {
    expect((await licence.POST(req("/x", { decision: "verified" }), p({ licenceId: LIC }))).status).toBe(200);
    expect((await licence.POST(req("/x", { decision: "rejected", note: "Not on the register" }), p({ licenceId: LIC }))).status).toBe(200);
    expect(called("review_license")).toEqual([{ license_record_id: LIC, decision: "verified" }, { license_record_id: LIC, decision: "rejected", note: "Not on the register" }]);
    fake.refuse.review_license = JSON.stringify({ error: "No licence record 'x'" });
    const refused = await licence.POST(req("/x", { decision: "verified" }), p({ licenceId: LIC }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("No licence record 'x'");
  });

  it("Add service type → define_service_type, never replacing one that exists", async () => {
    const t = { region: "US", key: "bank_account_check", name: "Bank account check", category: "account_data", input_schema: { type: "object" }, output_schema: { type: "object" }, consent_purpose: "account_check", moves_money: false };
    expect((await serviceTypes.POST(req("/x", { service_type: t }))).status).toBe(200);
    expect(called("define_service_type")).toEqual([{ service_type: t }]);
    const dup = await serviceTypes.POST(req("/x", { service_type: { ...t, key: "kyc_basic" } }));
    expect(dup.status).toBe(409);
    expect(called("define_service_type")).toHaveLength(1);
    expect((await serviceTypes.POST(req("/x", { service_type: { ...t, client_result: {} } }))).status).toBe(400);
  });

  it("Suspend offering / Reinstate offering → suspend_vendor_offering", async () => {
    await offering.POST(req("/x", { suspended: true, note: "Conformance keeps failing" }), p({ offeringId: OFF }));
    await offering.POST(req("/x", { suspended: false, note: "Fixed by the vendor" }), p({ offeringId: OFF }));
    expect(called("suspend_vendor_offering")).toEqual([
      { offering_id: OFF, suspended: true, note: "Conformance keeps failing" },
      { offering_id: OFF, suspended: false, note: "Fixed by the vendor" },
    ]);
  });
});
