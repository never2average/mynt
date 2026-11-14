import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Session } from "@/lib/session-store";

// The API routes scope to the workspace picked in the switcher, and the Members routes let
// only owners and admins change anything.

const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const WITH_WORKSPACES = [
  { name: "list_workspaces", inputSchema: props() },
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "get_developer_dashboard", inputSchema: props("days", "workspace_id") },
];
const fake = {
  session: undefined as Session | undefined,
  tools: WITH_WORKSPACES as { name: string; inputSchema?: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  myRole: "owner",
  personal: false, // list_workspaces includes the user's own workspace
  refuse: {} as Record<string, string>, // tool -> Mynt's refusal text
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
const claims: string[] = [];
vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({
    save: async () => true,
    wasTouched: () => false,
    claim: async (name: string, subject: string) => {
      claims.push(`${name}\n${subject}`);
      return async () => undefined;
    },
  }),
}));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: fake.refuse[name] }] };
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: ["developer"] });
        case "list_workspaces":
          return ok({
            workspaces: [
              ...(fake.personal ? [{ id: "me", name: "Ines", role: "owner", personal: true }] : []),
              { id: "w1", name: "Acme", role: fake.myRole },
              { id: "w2", name: "Beta", role: "member" },
            ],
          });
        case "list_my_invitations":
          return ok({
            invitations: [
              { id: "inv1", workspace: { id: "w7", name: "Gamma" }, invited_by: { name: "Sam Lee", email: "sam@example.com" }, role: "admin" },
              { id: "../evil", workspace: { id: "w8", name: "Bad" }, role: "member" },
            ],
          });
        case "accept_workspace_invite":
          return ok({ workspace_id: "w7" });
        case "list_my_apps":
          return ok([{ id: "a1", name: "Cards", status: "published" }]);
        case "list_builds":
          return ok({ builds: [] });
        case "get_compliance_coverage":
          return ok({ states: [{ code: "CA", status: "unlocked", partners: [{ entity_id: "e1", name: "Harbor Bank" }] }] });
        case "list_workspace_licences":
          return ok({ licences: [{ partner: "Harbor Bank", number: "MT-1", states: ["CA"], status: "active" }] });
        case "list_workspace_audit":
          if (args.class)
            return ok({
              rows: [{ id: "r1", at: "2026-11-12T10:00:00Z", class: args.class, kind: "build.audit_finding", actor: { id: "u1", name: "Ines" }, app_id: "a1", target: { type: "build", id: "b1" }, summary: "Secret in logs", severity: "high", status: "open", details: { file: "a.ts" } }],
              next_cursor: null,
            });
          return ok({ events: [{ at: "2026-11-12T10:00:00Z", actor: { id: "u1", name: "Ines" }, action: "app.created", target: { type: "app", id: "a1" } }], next_cursor: "c2" });
        case "get_workspace_obligations":
          return ok([{ licence_id: "l1", partner: "Harbor Bank", regulator: "CA DFPI", obligation_id: "o1", title: "Quarterly report", products: [{ name: "Cards" }], status: "overdue", due_at: "2026-10-01", evidence: null }]);
        case "create_app":
          return ok({ id: "new-app" });
        case "start_build":
          return ok({ id: "b1" });
        case "get_developer_dashboard":
          return ok({ apps: [] });
        case "get_linked_accounts":
          return ok({ git: { username: "ines" }, wallets: [], manage_url: "https://accounts.example.com/user" });
        case "list_workspace_members":
          return ok({ members: [{ user_id: "u1", name: "Ines", email: "ines@example.com", role: fake.myRole }], invites: [] });
        default:
          return ok({ ok: true });
      }
    },
    close: async () => undefined,
  }),
}));

const projects = await import("@/app/api/projects/route");
const dashboard = await import("@/app/api/dashboard/route");
const workspaces = await import("@/app/api/workspaces/route");
const members = await import("@/app/api/workspaces/[workspaceId]/members/route");
const linkedAccounts = await import("@/app/api/linked-accounts/route");
const apps = await import("@/app/api/apps/route");
const coverageRoute = await import("@/app/api/coverage/route");
const licencesRoute = await import("@/app/api/licences/route");
const auditRoute = await import("@/app/api/audit/route");
const obligationsRoute = await import("@/app/api/obligations/route");
const { complianceRead } = await import("@/lib/compliance-server");
const invitationsRoute = await import("@/app/api/invitations/route");
const invitationRoute = await import("@/app/api/invitations/[inviteId]/route");

const get = (path: string, cookie?: string) => new NextRequest(`http://localhost:3000${path}`, cookie ? { headers: { cookie } } : undefined);
const send = (method: string, body: unknown) =>
  new Request("http://localhost:3000/api/workspaces/w1/members", { method, headers: { origin: "http://localhost:3000", "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name);

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.tools = WITH_WORKSPACES;
  fake.calls = [];
  fake.myRole = "owner";
  fake.personal = false;
  fake.refuse = {};
  claims.length = 0;
});

describe("the switcher's scope", () => {
  it("lists the selected workspace's apps, with their stage", async () => {
    const res = await projects.GET(get("/api/projects?workspace=w2"));
    expect(called("list_my_apps")[0].args).toEqual({ workspace_id: "w2" });
    expect((await res.json()).projects[0]).toMatchObject({ id: "a1", stage: "production" });
  });

  it("uses the remembered workspace (its cookie) when the request doesn't name one", async () => {
    await projects.GET(get("/api/projects", "__Host-mynt_workspace=w1"));
    expect(called("list_my_apps")[0].args).toEqual({ workspace_id: "w1" });
  });

  it("scopes the dashboard to the workspace", async () => {
    await dashboard.GET(get("/api/dashboard?workspace=w2"));
    expect(called("get_developer_dashboard")[0].args).toEqual({ days: 30, workspace_id: "w2" });
  });

  it("before Mynt has workspaces: one implicit Personal workspace, and nothing scoped", async () => {
    fake.tools = [{ name: "get_developer_dashboard", inputSchema: props("days") }];
    const ws = await (await workspaces.GET()).json();
    expect(ws).toEqual({ workspaces: [{ id: "personal", name: "Personal", role: "owner", implicit: true }], supported: false });
    // Personal (as the switcher asks for it, or a leftover cookie) is unscoped.
    await projects.GET(get("/api/projects?workspace=personal"));
    await dashboard.GET(get("/api/dashboard", "__Host-mynt_workspace=w2"));
    expect(called("list_my_apps")[0].args).toEqual({});
    expect(called("get_developer_dashboard")[0].args).toEqual({ days: 30 });
    // A shared workspace named explicitly can't be one of the user's yet: unavailable, not Personal's data.
    expect((await (await dashboard.GET(get("/api/dashboard?workspace=w2"))).json()).unavailable).toMatch(/no longer a member/);
  });

  it("never shows unscoped data under a shared workspace's name", async () => {
    fake.tools = [
      { name: "list_workspaces", inputSchema: props() },
      { name: "list_my_apps", inputSchema: props() },
      { name: "get_developer_dashboard", inputSchema: props("days") },
    ];
    const p = await (await projects.GET(get("/api/projects?workspace=w1"))).json();
    expect(p.projects).toEqual([]);
    expect(p.unavailable).toMatch(/next update/);
    const d = await (await dashboard.GET(get("/api/dashboard?workspace=w1"))).json();
    expect(d.dashboard).toBeNull();
    expect(d.unavailable).toMatch(/next update/);
    expect(called("list_my_apps")).toEqual([]);
    expect(called("get_developer_dashboard")).toEqual([]);
    // Without get_developer_dashboard, the fallback's list_my_apps isn't unscoped either.
    fake.tools = fake.tools.slice(0, 2);
    expect((await (await dashboard.GET(get("/api/dashboard?workspace=w1"))).json()).dashboard).toBeNull();
    expect(called("list_my_apps")).toEqual([]);
  });

  it("falls back quietly to Personal when the remembered workspace is no longer the user's", async () => {
    const res = await projects.GET(get("/api/projects", "__Host-mynt_workspace=w9"));
    expect(res.status).toBe(200);
    expect(called("list_my_apps")[0].args).toEqual({});
  });

  it("lists the workspace's builds (teammates' too) where Mynt can", async () => {
    await projects.GET(get("/api/projects?workspace=w1"));
    expect(called("list_builds")[0].args).toEqual({});
    fake.tools = [...WITH_WORKSPACES, { name: "list_builds", inputSchema: props("app_id", "workspace_id") }];
    fake.calls = [];
    await projects.GET(get("/api/projects?workspace=w1"));
    expect(called("list_builds")[0].args).toEqual({ workspace_id: "w1" });
  });

  it("creates a new app in the selected workspace, and refuses where Mynt can't yet", async () => {
    const newApp = (cookie?: string) =>
      new NextRequest("http://localhost:3000/api/apps", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify({ prompt: "A savings goal app for students", product_ids: ["p1"] }),
      });
    fake.tools = [...WITH_WORKSPACES, { name: "create_app", inputSchema: props("name", "product_ids", "workspace_id") }];
    expect((await apps.POST(newApp("__Host-mynt_workspace=w1"))).status).toBe(201);
    expect(called("create_app")[0].args).toMatchObject({ workspace_id: "w1", product_ids: ["p1"] });
    expect(claims.find((c) => c.startsWith("new-app"))).toContain("\nw1\n");
    fake.tools = [...WITH_WORKSPACES, { name: "create_app", inputSchema: props("name", "product_ids") }];
    fake.calls = [];
    expect((await apps.POST(newApp("__Host-mynt_workspace=w1"))).status).toBe(501);
    expect(called("create_app")).toEqual([]);
    expect((await apps.POST(newApp())).status).toBe(201); // Personal
    expect(called("create_app")[0].args).not.toHaveProperty("workspace_id");
  });

  it("in Personal, creates the app in the user's own workspace, never one they were invited to", async () => {
    const newApp = () =>
      new NextRequest("http://localhost:3000/api/apps", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "A savings goal app for students", product_ids: ["p1"] }),
      });
    fake.tools = [...WITH_WORKSPACES, { name: "create_app", inputSchema: props("name", "product_ids", "workspace_id") }];
    fake.personal = true;
    expect((await apps.POST(newApp())).status).toBe(201);
    expect(called("create_app")[0].args).toMatchObject({ workspace_id: "me" });
    // No own workspace to name: the user is asked to choose, and nothing is created.
    fake.personal = false;
    fake.calls = [];
    const res = await apps.POST(newApp());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "choose_workspace" });
    expect(called("create_app")).toEqual([]);
    // Mynt's own "choose a workspace" refusal reads the same way.
    fake.personal = true;
    fake.refuse = { create_app: JSON.stringify({ error: "Choose a workspace for this app" }) };
    const refused = await apps.POST(newApp());
    expect(refused.status).toBe(409);
    expect((await refused.json()).message).toMatch(/Choose the workspace/);
  });

  it("ignores a malformed workspace id", async () => {
    await projects.GET(get("/api/projects?workspace=../../etc"));
    expect(called("list_my_apps")[0].args).toEqual({});
  });
});

describe("Members routes", () => {
  it("let an owner invite, change roles, remove members and revoke invites", async () => {
    expect((await members.POST(send("POST", { email: "New@Example.com", role: "admin" }), params("w1"))).status).toBe(200);
    expect(called("invite_to_workspace")[0].args).toEqual({ workspace_id: "w1", email: "new@example.com", role: "admin" });
    expect((await members.PATCH(send("PATCH", { user_id: "u2", role: "member" }), params("w1"))).status).toBe(200);
    expect(called("change_member_role")[0].args).toEqual({ workspace_id: "w1", user_id: "u2", role: "member" });
    expect((await members.DELETE(send("DELETE", { user_id: "u2" }), params("w1"))).status).toBe(200);
    expect(called("remove_workspace_member")[0].args).toEqual({ workspace_id: "w1", user_id: "u2" });
    expect((await members.DELETE(send("DELETE", { invite_id: "i1" }), params("w1"))).status).toBe(200);
    expect(called("revoke_workspace_invite")[0].args).toEqual({ workspace_id: "w1", invite_id: "i1" });
  });

  it("refuse a member, before anything reaches Mynt", async () => {
    fake.myRole = "member";
    for (const res of [
      await members.POST(send("POST", { email: "x@example.com", role: "member" }), params("w1")),
      await members.PATCH(send("PATCH", { user_id: "u2", role: "admin" }), params("w1")),
      await members.DELETE(send("DELETE", { user_id: "u2" }), params("w1")),
    ]) {
      expect(res.status).toBe(403);
    }
    for (const t of ["invite_to_workspace", "change_member_role", "remove_workspace_member"]) expect(called(t)).toEqual([]);
    const list = await (await members.GET(get("/api/workspaces/w1/members"), params("w1"))).json();
    expect(list).toMatchObject({ supported: true, canManage: false, role: "member" });
  });

  it("refuse workspaces that aren't the user's, other origins and ownership changes", async () => {
    expect((await members.POST(send("POST", { email: "x@example.com", role: "member" }), params("w9"))).status).toBe(404);
    const foreign = new Request("http://localhost:3000/x", { method: "POST", headers: { origin: "https://evil.example.com" }, body: "{}" });
    expect((await members.POST(foreign, params("w1"))).status).toBe(403);
    expect((await members.POST(send("POST", { email: "x@example.com", role: "owner" }), params("w1"))).status).toBe(400);
    expect(called("invite_to_workspace")).toEqual([]);
  });

  it("say when Mynt doesn't have workspaces yet", async () => {
    fake.tools = [];
    expect((await members.POST(send("POST", { email: "x@example.com", role: "member" }), params("w1"))).status).toBe(501);
    expect(await (await members.GET(get("/api/workspaces/w1/members"), params("w1"))).json()).toMatchObject({ supported: false });
  });
});

describe("linked accounts route", () => {
  it("reads get_linked_accounts where Mynt has it, and says not linked otherwise", async () => {
    fake.tools = [...WITH_WORKSPACES, { name: "get_linked_accounts", inputSchema: props() }];
    expect((await (await linkedAccounts.GET()).json()).linked).toMatchObject({ supported: true, github: "ines", manageUrl: "https://accounts.example.com/user" });
    fake.tools = WITH_WORKSPACES;
    expect((await (await linkedAccounts.GET()).json()).linked).toEqual({ supported: false, github: null, wallet: null, manageUrl: null });
  });
});

describe("compliance routes (Coverage, Licences, Audits)", () => {
  const COMPLIANCE = ["get_compliance_coverage", "list_workspace_licences", "list_workspace_audit"].map((name) => ({ name, inputSchema: props("workspace_id", "cursor", "action", "user_id", "app_id", "from", "to") }));

  it("read the selected workspace's coverage, licences and audit trail", async () => {
    fake.tools = [...WITH_WORKSPACES, ...COMPLIANCE];
    const c = await (await coverageRoute.GET(get("/api/coverage?workspace=w1"))).json();
    expect(c).toMatchObject({ supported: true, coverage: { states: [{ code: "CA", status: "unlocked", partners: [{ name: "Harbor Bank" }] }] } });
    expect(called("get_compliance_coverage")[0].args).toEqual({ workspace_id: "w1" });
    const l = await (await licencesRoute.GET(get("/api/licences?workspace=w1"))).json();
    expect(l.licences[0]).toMatchObject({ partner: "Harbor Bank", number: "MT-1" });
    const a = await (await auditRoute.GET(get("/api/audit?workspace=w1&action=app.created&user_id=u1&from=2026-11-01&to=2026-11-13&cursor=c1"))).json();
    expect(a.page).toMatchObject({ nextCursor: "c2", events: [{ action: "app.created" }] });
    expect(called("list_workspace_audit")[0].args).toEqual({ workspace_id: "w1", action: "app.created", user_id: "u1", from: "2026-11-01", to: "2026-11-13", cursor: "c1" });
  });

  it("refuse bad audit filters before anything reaches Mynt", async () => {
    fake.tools = [...WITH_WORKSPACES, ...COMPLIANCE];
    expect((await auditRoute.GET(get("/api/audit?from=yesterday"))).status).toBe(400);
    expect((await auditRoute.GET(get("/api/audit?owner_id=u9"))).status).toBe(400);
    expect(called("list_workspace_audit")).toEqual([]);
  });

  it("refuse impossible dates, a start after the end and an empty cursor", async () => {
    fake.tools = [...WITH_WORKSPACES, ...COMPLIANCE];
    for (const q of ["from=2026-02-30", "to=2026-13-01", "from=2026-11-13&to=2026-11-01", "cursor=", "action="]) {
      expect((await auditRoute.GET(get(`/api/audit?${q}`))).status, q).toBe(400);
    }
    expect(called("list_workspace_audit")).toEqual([]);
    expect((await auditRoute.GET(get("/api/audit?from=2024-02-29&to=2024-02-29"))).status).toBe(200);
  });

  it("always send the selected workspace, whatever the caller's arguments say", async () => {
    fake.tools = [...WITH_WORKSPACES, ...COMPLIANCE];
    await complianceRead(get("/api/audit?workspace=w1"), "list_workspace_audit", "test", () => ({}), { workspace_id: "w2", action: "x" });
    expect(called("list_workspace_audit")[0].args).toEqual({ workspace_id: "w1", action: "x" });
  });

  it("say unavailable for a workspace the user has left, never Personal's data under its name", async () => {
    fake.tools = [...WITH_WORKSPACES, ...COMPLIANCE];
    expect((await (await coverageRoute.GET(get("/api/coverage?workspace=w9"))).json()).unavailable).toMatch(/no longer a member/);
    expect(await (await projects.GET(get("/api/projects?workspace=w9"))).json()).toMatchObject({ projects: [], unavailable: expect.stringMatching(/no longer a member/) });
    expect(await (await dashboard.GET(get("/api/dashboard?workspace=w9"))).json()).toMatchObject({ dashboard: null, unavailable: expect.stringMatching(/no longer a member/) });
    for (const t of ["get_compliance_coverage", "list_my_apps", "get_developer_dashboard"]) expect(called(t)).toEqual([]);
  });

  it("say not available yet before Mynt has the tools, or when they can't be scoped to a shared workspace", async () => {
    fake.tools = WITH_WORKSPACES;
    expect(await (await coverageRoute.GET(get("/api/coverage?workspace=w1"))).json()).toEqual({ supported: false });
    fake.tools = [...WITH_WORKSPACES, { name: "get_compliance_coverage", inputSchema: props() }];
    expect((await (await coverageRoute.GET(get("/api/coverage?workspace=w1"))).json()).unavailable).toMatch(/next update/);
    expect(called("get_compliance_coverage")).toEqual([]);
    await coverageRoute.GET(get("/api/coverage")); // Personal: nothing to scope
    expect(called("get_compliance_coverage")[0].args).toEqual({});
  });
});

describe("invitations (always explicit)", () => {
  const INVITE_TOOLS = ["list_my_invitations", "accept_workspace_invite", "decline_workspace_invite"].map((name) => ({ name, inputSchema: props() }));
  const answer = (id: string, body: unknown, origin = "http://localhost:3000") =>
    invitationRoute.POST(new Request(`http://localhost:3000/api/invitations/${id}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ inviteId: id }),
    });

  it("lists pending invitations with workspace, inviter, role and what they grant", async () => {
    fake.tools = [...WITH_WORKSPACES, ...INVITE_TOOLS];
    const body = await (await invitationsRoute.GET()).json();
    expect(body.supported).toBe(true);
    expect(body.invitations).toHaveLength(1); // the malformed id is dropped
    expect(body.invitations[0]).toMatchObject({ id: "inv1", workspaceId: "w7", workspaceName: "Gamma", inviter: "Sam Lee", role: "admin" });
    expect(body.invitations[0].grants.length).toBeGreaterThan(0);
  });

  it("accept joins and answers the workspace to switch to; decline declines", async () => {
    fake.tools = [...WITH_WORKSPACES, ...INVITE_TOOLS];
    const accepted = await answer("inv1", { action: "accept" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true, workspaceId: "w7" });
    expect(called("accept_workspace_invite")[0].args).toEqual({ invite_id: "inv1" });
    expect((await answer("inv1", { action: "decline" })).status).toBe(200);
    expect(called("decline_workspace_invite")[0].args).toEqual({ invite_id: "inv1" });
  });

  it("refuse other origins, unknown invitations, bad answers and Mynts without invitations", async () => {
    fake.tools = [...WITH_WORKSPACES, ...INVITE_TOOLS];
    expect((await answer("inv1", { action: "accept" }, "https://evil.example.com")).status).toBe(403);
    expect((await answer("inv9", { action: "accept" })).status).toBe(404);
    expect((await answer("inv1", { action: "join" })).status).toBe(400);
    expect((await answer("..%2Fx", { action: "accept" })).status).toBe(400);
    expect(called("accept_workspace_invite")).toEqual([]);
    fake.tools = WITH_WORKSPACES;
    expect(await (await invitationsRoute.GET()).json()).toEqual({ supported: false, invitations: [] });
    expect((await answer("inv1", { action: "accept" })).status).toBe(501);
  });
});

describe("the Audits page's classes", () => {
  const AUDIT = (classed: boolean) => ({ name: "list_workspace_audit", inputSchema: props("workspace_id", "cursor", "action", "user_id", "app_id", "from", "to", ...(classed ? ["class"] : [])) });

  it("where Mynt classifies its records: each tab asks for its class and gets rows", async () => {
    fake.tools = [...WITH_WORKSPACES, AUDIT(true)];
    const body = await (await auditRoute.GET(get("/api/audit?workspace=w1&class=security&app_id=a1"))).json();
    expect(called("list_workspace_audit")[0].args).toEqual({ workspace_id: "w1", app_id: "a1", class: "security" });
    expect(body.classes).toBe(true);
    expect(body.page.rows[0]).toMatchObject({ id: "r1", class: "security", kind: "build.audit_finding", appId: "a1", summary: "Secret in logs", severity: "high", status: "open", details: '{"file":"a.ts"}' });
    expect((await auditRoute.GET(get("/api/audit?workspace=w1&class=made-up"))).status).toBe(400);
  });

  it("before it does: Workspace activity is the whole trail as it is, the other classes aren't supported yet", async () => {
    fake.tools = [...WITH_WORKSPACES, AUDIT(false)];
    const ws = await (await auditRoute.GET(get("/api/audit?workspace=w1&class=workspace"))).json();
    expect(called("list_workspace_audit")[0].args).toEqual({ workspace_id: "w1" }); // no class sent to a Mynt that doesn't take it
    expect(ws).toMatchObject({ supported: true, classes: false });
    expect(ws.page.rows[0]).toMatchObject({ kind: "app.created", class: "workspace", appId: "a1" });
    for (const c of ["security", "obligations", "financial"]) expect(await (await auditRoute.GET(get(`/api/audit?workspace=w1&class=${c}`))).json(), c).toEqual({ supported: false });
    expect(called("list_workspace_audit")).toHaveLength(1);
    // Without class (the dashboard's Recent activity), as before.
    expect((await (await auditRoute.GET(get("/api/audit?workspace=w1"))).json()).page.events[0].action).toBe("app.created");
  });

  it("obligations: not supported until Mynt has get_workspace_obligations; then the workspace's", async () => {
    fake.tools = WITH_WORKSPACES;
    expect(await (await obligationsRoute.GET(get("/api/obligations?workspace=w1"))).json()).toEqual({ supported: false });
    fake.tools = [...WITH_WORKSPACES, { name: "get_workspace_obligations", inputSchema: props("workspace_id") }];
    const body = await (await obligationsRoute.GET(get("/api/obligations?workspace=w1"))).json();
    expect(called("get_workspace_obligations")[0].args).toEqual({ workspace_id: "w1" });
    expect(body.obligations[0]).toMatchObject({ partner: "Harbor Bank", obligationId: "o1", products: ["Cards"], status: "overdue", evidence: null });
  });
});
