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
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: ["developer"] });
        case "list_workspaces":
          return ok({ workspaces: [{ id: "w1", name: "Acme", role: fake.myRole }, { id: "w2", name: "Beta", role: "member" }] });
        case "list_my_apps":
          return ok([{ id: "a1", name: "Cards", status: "published" }]);
        case "list_builds":
          return ok({ builds: [] });
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
});

describe("the switcher's scope", () => {
  it("lists the selected workspace's apps, with their stage", async () => {
    const res = await projects.GET(get("/api/projects?workspace=w2"));
    expect(called("list_my_apps")[0].args).toEqual({ workspace_id: "w2" });
    expect((await res.json()).projects[0]).toMatchObject({ id: "a1", stage: "production" });
  });

  it("uses the remembered workspace (its cookie) when the request doesn't name one", async () => {
    await projects.GET(get("/api/projects", "mynt_workspace=w1"));
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
    await projects.GET(get("/api/projects?workspace=w2"));
    await dashboard.GET(get("/api/dashboard?workspace=w2"));
    expect(called("list_my_apps")[0].args).toEqual({});
    expect(called("get_developer_dashboard")[0].args).toEqual({ days: 30 });
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
