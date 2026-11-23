import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// Put online (GET and POST /api/apps/[appId]/hosting): signed-in developers only, same-origin
// writes, this app's own verified build only, the workspace's hosting turned on first (owners and
// admins) and Mynt's refusals in its own words.

const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const ALL = [
  { name: "list_workspaces", inputSchema: props() },
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "list_builds", inputSchema: props("app_id", "workspace_id") },
  { name: "get_build", inputSchema: props("build_id") },
  { name: "hosting_status", inputSchema: props("workspace_id") },
  { name: "request_hosting", inputSchema: props("workspace_id") },
  { name: "deploy_app", inputSchema: props("app_id", "build_id") },
  { name: "get_app_repository", inputSchema: props("app_id") },
  { name: "set_app_repository", inputSchema: props("app_id", "repository") },
  { name: "list_repositories", inputSchema: props() },
];

type Build = Record<string, unknown>;
const shipped: Build = { id: "b2", app_id: "a1", status: "succeeded", goal: "A savings goal tracker", repository: "octo/cards", commit_sha: "abcdef1234567890", branch: "mynt/b2", updated_at: "2026-11-20T10:00:00Z" };

const fake = {
  session: undefined as Session | undefined,
  tools: ALL as { name: string; inputSchema?: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  role: "owner",
  tenant: null as Record<string, unknown> | null,
  hosted: [] as Record<string, unknown>[],
  builds: [shipped] as Build[],
  refuse: {} as Record<string, string>,
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
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse[name] }) }] };
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: ["developer"] });
        case "list_workspaces":
          return ok([{ id: "w1", name: "Acme", role: fake.role, created_at: "2026-09-01T00:00:00Z", members: 3, apps: 1 }]);
        case "list_my_apps":
          return ok([{ id: "a1", name: "Cards", status: "draft", stage: "staging", workspace_id: "w1" }]);
        case "list_builds":
          return ok({ builds: fake.builds });
        case "get_build":
          return ok(fake.builds.find((b) => b.id === args.build_id) ?? { id: args.build_id, app_id: "other", status: "succeeded" });
        case "hosting_status":
          return ok(fake.tenant ? { tenant: fake.tenant, apps: fake.hosted } : { tenant: null, apps: [] });
        case "request_hosting":
          fake.tenant = { id: "t1", workspace_id: args.workspace_id, status: "running" };
          return ok(fake.tenant);
        case "deploy_app":
          fake.hosted = [{ app_id: args.app_id, build_id: args.build_id, commit_sha: "abcdef1234567890", status: "deploying", url: "https://cards.example.test" }];
          return ok({ ...fake.hosted[0], environment: "sandbox" });
        case "get_app_repository":
          return ok({ app_id: "a1", repository: null, managed: false });
        case "list_repositories":
          return ok([
            { repository: "octo/cards", approval: "approved" },
            { repository: "octo/pending", approval: "pending" },
            { repository: "mynt-apps/mynt-app-a1", approval: "approved", managed: true },
          ]);
        case "set_app_repository":
          return ok({ app_id: args.app_id, repository: args.repository, managed: false, previous: null });
        default:
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: `unexpected ${name}` }) }] };
      }
    },
    close: async () => undefined,
  }),
}));

const route = await import("@/app/api/apps/[appId]/hosting/route");
const params = (appId = "a1") => ({ params: Promise.resolve({ appId }) });
const get = (query = "", appId = "a1") => route.GET(new Request(`http://localhost:3000/api/apps/${appId}/hosting${query}`), params(appId));
const post = (body: unknown, origin = "http://localhost:3000", appId = "a1") =>
  route.POST(new Request(`http://localhost:3000/api/apps/${appId}/hosting`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), params(appId));
const called = (name: string) => fake.calls.filter((c) => c.name === name);

beforeEach(() => {
  fake.session = { id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.tools = ALL;
  fake.calls = [];
  fake.role = "owner";
  fake.tenant = null;
  fake.hosted = [];
  fake.builds = [shipped, { id: "b1", app_id: "a1", status: "succeeded", repository: "octo/cards", commit_sha: "1111111", updated_at: "2026-11-10T10:00:00Z" }, { id: "b3", app_id: "a1", status: "failed", updated_at: "2026-11-21T10:00:00Z" }];
  fake.refuse = {};
});

describe("GET /api/apps/[appId]/hosting", () => {
  it("shows the newest verified build, its repository and commit, and that the app isn't online", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ supported: true, role: "owner", canTurnOn: true, hosting: { on: false, app: { state: "not_online" } } });
    expect(body.build).toMatchObject({ id: "b2", repository: "octo/cards", commitSha: "abcdef1234567890" });
    // A deployable build needs no repository chooser.
    expect(body.canChooseRepository).toBe(false);
    expect(called("hosting_status")[0]?.args).toEqual({ workspace_id: "w1" });
  });

  it("is Online at the app's address once Mynt's hosting runs it", async () => {
    fake.tenant = { id: "t1", status: "running" };
    fake.hosted = [{ app_id: "a1", build_id: "b2", commit_sha: "abcdef1234567890", status: "running", url: "https://cards.example.test" }];
    const body = await (await get("?only=status")).json();
    expect(body).toEqual({ supported: true, hosting: { on: true, status: "running", app: { state: "online", url: "https://cards.example.test", buildId: "b2", commitSha: "abcdef1234567890", error: null } } });
    expect(called("list_builds")).toHaveLength(0);
  });

  it("offers the user's approved repositories (never pending or Mynt-managed ones) when the build pushed nowhere", async () => {
    fake.builds = [{ id: "b9", app_id: "a1", status: "succeeded", repository: null, commit_sha: null, updated_at: "2026-11-22T10:00:00Z" }];
    const body = await (await get()).json();
    expect(body.canChooseRepository).toBe(true);
    expect(body.repositories.map((r: { repository: string }) => r.repository)).toEqual(["octo/cards"]);
    expect(body.repository).toEqual({ current: null, managed: false });
  });

  it("says unsupported where this Mynt has no deploy_app, and not_found for someone else's app", async () => {
    fake.tools = ALL.filter((t) => t.name !== "deploy_app");
    expect(await (await get()).json()).toEqual({ supported: false });
    fake.tools = ALL;
    expect((await get("", "zz")).status).toBe(404);
  });
});

describe("POST /api/apps/[appId]/hosting: Put online", () => {
  it("turns the workspace's hosting on, then deploys the build, and answers Deploying", async () => {
    const res = await post({ action: "put_online", build_id: "b2" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(called("request_hosting").map((c) => c.args)).toEqual([{ workspace_id: "w1" }]);
    expect(called("deploy_app").map((c) => c.args)).toEqual([{ app_id: "a1", build_id: "b2" }]);
    const order = fake.calls.map((c) => c.name);
    expect(order.indexOf("request_hosting")).toBeLessThan(order.indexOf("deploy_app"));
    expect(body.hosting["app"]).toMatchObject({ state: "deploying", buildId: "b2" });
    expect(body.message).toMatch(/^Putting Cards online: Mynt's hosting fetches commit abcdef1 from octo\/cards/);
  });

  it("doesn't ask for hosting again when the workspace already has it", async () => {
    fake.tenant = { id: "t1", status: "running" };
    expect((await post({ action: "put_online", build_id: "b2" })).status).toBe(200);
    expect(called("request_hosting")).toHaveLength(0);
    expect(called("deploy_app")).toHaveLength(1);
  });

  it("leaves turning hosting on to owners and admins: a member is told so before anything reaches Mynt's hosting", async () => {
    fake.role = "member";
    const res = await post({ action: "put_online", build_id: "b2" });
    expect(res.status).toBe(403);
    expect((await res.json()).message).toMatch(/owner or admin turns it on/);
    expect(called("request_hosting")).toHaveLength(0);
    expect(called("deploy_app")).toHaveLength(0);
  });

  it("refuses a build with no repository, another app's build, a build that didn't succeed, another site, bad input and someone signed out, before deploy_app", async () => {
    fake.builds = [...fake.builds, { id: "b9", app_id: "a1", status: "succeeded", repository: null, commit_sha: null }];
    const none = await post({ action: "put_online", build_id: "b9" });
    expect(none.status).toBe(409);
    expect((await none.json()).message).toMatch(/wasn't saved to a repository/);
    expect((await post({ action: "put_online", build_id: "elsewhere" })).status).toBe(404);
    expect((await post({ action: "put_online", build_id: "b3" })).status).toBe(404);
    expect((await post({ action: "put_online", build_id: "b2" }, "https://evil.example")).status).toBe(403);
    expect((await post({ action: "put_online", build_id: "b2", environment: "live" })).status).toBe(400);
    expect((await post({ action: "put_online", build_id: "b 2" })).status).toBe(400);
    fake.session = undefined;
    expect((await post({ action: "put_online", build_id: "b2" })).status).toBe(401);
    expect(called("deploy_app")).toHaveLength(0);
    expect(called("request_hosting")).toHaveLength(0);
  });

  it("shows Mynt's refusal in its own words", async () => {
    fake.tenant = { id: "t1", status: "running" };
    fake.refuse.deploy_app = "Repository 'octo/cards' is waiting for an admin's approval";
    const res = await post({ action: "put_online", build_id: "b2" });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe("Repository 'octo/cards' is waiting for an admin's approval");
  });

  it("chooses the repository the app's next builds push to", async () => {
    const res = await post({ action: "set_repository", repository: "octo/cards" });
    expect(res.status).toBe(200);
    expect(called("set_app_repository").map((c) => c.args)).toEqual([{ app_id: "a1", repository: "octo/cards" }]);
    expect((await res.json()).message).toMatch(/next build pushes to octo\/cards/);
    expect((await post({ action: "set_repository", repository: "not a repo" })).status).toBe(400);
  });
});
