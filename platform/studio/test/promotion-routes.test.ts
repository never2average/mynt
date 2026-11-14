import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// The promotion, attention, stages and workspace-settings routes: each waits for Mynt's tool,
// and only owners and admins change anything, checked before anything reaches Mynt.

const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const BASE = [
  { name: "list_workspaces", inputSchema: props() },
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "list_builds", inputSchema: props("workspace_id") },
  { name: "rename_workspace", inputSchema: props("workspace_id", "name") },
];
const PROMOTIONS = ["get_promotion_checks", "promote_app", "demote_app", "request_promotion_signoff"].map((name) => ({ name, inputSchema: props() }));

const fake = {
  session: undefined as Session | undefined,
  tools: BASE as { name: string; inputSchema?: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  myRole: "owner",
  canPromote: true,
  stage: "staging",
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
          return ok([
            { id: "me", name: "Ines", role: "owner", personal: true, created_at: "2026-01-01T00:00:00Z", members: 1, apps: 0 },
            { id: "w1", name: "Acme", role: fake.myRole, created_at: "2026-09-01T00:00:00Z", members: 3, apps: 2 },
          ]);
        case "list_my_apps":
          return ok([
            { id: "a1", name: "Cards", status: "draft", stage: fake.stage, workspace_id: "w1", owner_id: "u1" },
            { id: "a2", name: "Vault", status: "draft", stage: "idea", workspace_id: "w1", owner_id: "u2" },
          ]);
        case "list_builds":
          return ok({ builds: [] });
        case "get_promotion_checks":
          return ok({
            app_id: args.app_id,
            from_stage: fake.stage,
            to_stage: args.to_stage,
            checks: [{ id: "build", label: "Latest build verified", status: fake.canPromote ? "pass" : "fail" }],
            can_promote: fake.canPromote,
            needs_admin_signoff: false,
          });
        case "get_workspace_pnl":
          return ok({ currency: "USD", series: [{ start: "2026-11-01", end: "2026-11-30", revenue_cents: 5000, costs_cents: null, net_cents: null }], statement: { columns: [], revenue: [], costs: [], totals: {} }, unmeasured: [] });
        case "get_workspace_attention":
          return ok({ items: [{ id: "x", severity: "high", title: "Build failed", href: "/a1" }] });
        default:
          return ok({ ok: true });
      }
    },
    close: async () => undefined,
  }),
}));

const promotion = await import("@/app/api/apps/[appId]/promotion/route");
const attentionRoute = await import("@/app/api/attention/route");
const stagesRoute = await import("@/app/api/stages/route");
const pnlRoute = await import("@/app/api/pnl/route");
const workspaceRoute = await import("@/app/api/workspaces/[workspaceId]/route");

const req = (path: string, method = "GET", body?: unknown, origin = "http://localhost:3000") =>
  new Request(`http://localhost:3000${path}`, body === undefined ? { method } : { method, headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const app = (appId: string) => ({ params: Promise.resolve({ appId }) });
const wsParams = (workspaceId: string) => ({ params: Promise.resolve({ workspaceId }) });
const called = (name: string) => fake.calls.filter((c) => c.name === name);

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.tools = BASE;
  fake.calls = [];
  fake.myRole = "owner";
  fake.canPromote = true;
  fake.stage = "staging";
});

describe("promotion route", () => {
  it("says not supported until Mynt has promotion checks", async () => {
    expect(await (await promotion.GET(req("/api/apps/a1/promotion"), app("a1"))).json()).toEqual({ supported: false });
    expect(called("get_promotion_checks")).toHaveLength(0);
  });

  it("reads the checks for the stage asked for, with the user's role in the app's workspace", async () => {
    fake.tools = [...BASE, ...PROMOTIONS];
    fake.myRole = "member";
    const body = await (await promotion.GET(req("/api/apps/a1/promotion?to=production"), app("a1"))).json();
    expect(called("get_promotion_checks")[0].args).toEqual({ app_id: "a1", to_stage: "production" });
    expect(body).toMatchObject({ supported: true, role: "member", canChange: false, app: { id: "a1", stage: "staging" }, checks: { canPromote: true, toStage: "production" } });
    expect((await promotion.GET(req("/api/apps/a1/promotion?to=moon"), app("a1"))).status).toBe(400);
    expect((await promotion.GET(req("/api/apps/zzz/promotion"), app("zzz"))).status).toBe(404);
  });

  it("refuses members before anything reaches Mynt", async () => {
    fake.tools = [...BASE, ...PROMOTIONS];
    fake.myRole = "member";
    const res = await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "promote", to_stage: "production" }), app("a1"));
    expect(res.status).toBe(403);
    expect(called("promote_app")).toHaveLength(0);
    expect(called("get_promotion_checks")).toHaveLength(0);
  });

  it("promotes only when Mynt's checks say it can", async () => {
    fake.tools = [...BASE, ...PROMOTIONS];
    fake.canPromote = false;
    const refused = await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "promote", to_stage: "production" }), app("a1"));
    expect(refused.status).toBe(409);
    expect(called("promote_app")).toHaveLength(0);
    fake.canPromote = true;
    const done = await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "promote", to_stage: "production" }), app("a1"));
    expect(await done.json()).toMatchObject({ ok: true, stage: "production", message: "Cards is now in Production." });
    expect(called("promote_app")[0].args).toEqual({ app_id: "a1", to_stage: "production" });
  });

  it("moves back only to an earlier stage, with a reason, and asks for sign-off", async () => {
    fake.tools = [...BASE, ...PROMOTIONS];
    expect((await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "demote", to_stage: "staging", reason: "Paused" }), app("a1"))).status).toBe(400);
    expect((await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "demote", to_stage: "idea" }), app("a1"))).status).toBe(400);
    const back = await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "demote", to_stage: "idea", reason: "Partner paused it" }), app("a1"));
    expect(back.status).toBe(200);
    expect(called("demote_app")[0].args).toEqual({ app_id: "a1", to_stage: "idea", reason: "Partner paused it" });
    await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "request_signoff" }), app("a1"));
    expect(called("request_promotion_signoff")[0].args).toEqual({ app_id: "a1" });
  });

  it("refuses other origins and changes this Mynt doesn't offer", async () => {
    fake.tools = [...BASE, ...PROMOTIONS];
    expect((await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "promote", to_stage: "staging" }, "https://evil.example"), app("a1"))).status).toBe(403);
    fake.tools = [...BASE, ...PROMOTIONS.filter((t) => t.name !== "demote_app")];
    expect((await promotion.POST(req("/api/apps/a1/promotion", "POST", { action: "demote", to_stage: "idea", reason: "Because" }), app("a1"))).status).toBe(501);
  });
});

describe("attention and stages routes", () => {
  it("attention: not supported until Mynt has it; then the selected workspace's, or the user's own for Personal", async () => {
    expect(await (await attentionRoute.GET(req("/api/attention?workspace=w1"))).json()).toEqual({ supported: false });
    fake.tools = [...BASE, { name: "get_workspace_attention", inputSchema: props("workspace_id") }];
    const body = await (await attentionRoute.GET(req("/api/attention?workspace=w1"))).json();
    expect(called("get_workspace_attention")[0].args).toEqual({ workspace_id: "w1" });
    expect(body.items[0]).toMatchObject({ id: "x", severity: "high", href: "/a1" });
    await attentionRoute.GET(req("/api/attention?workspace=personal"));
    expect(called("get_workspace_attention")[1].args).toEqual({ workspace_id: "me" });
  });

  it("pnl: not supported until Mynt has get_workspace_pnl; then the workspace's, with the period and range checked", async () => {
    expect(await (await pnlRoute.GET(req("/api/pnl?workspace=w1&granularity=month&periods=6"))).json()).toEqual({ supported: false });
    expect(called("get_workspace_pnl")).toHaveLength(0);
    fake.tools = [...BASE, { name: "get_workspace_pnl", inputSchema: props("workspace_id", "granularity", "periods", "app_id") }];
    const body = await (await pnlRoute.GET(req("/api/pnl?workspace=w1&granularity=week&periods=12"))).json();
    expect(called("get_workspace_pnl")[0].args).toEqual({ workspace_id: "w1", granularity: "week", periods: 12 });
    expect(body.pnl.series[0]).toMatchObject({ revenue: 5000, costs: null, netIncome: null });
    expect(body.pnl.columns.map((c: { label: string }) => c.label)).toEqual(["This period", "Last period", "Year to date"]);
    // Anything else falls back to a month over 6; Personal is the user's own workspace.
    await pnlRoute.GET(req("/api/pnl?workspace=personal&granularity=year&periods=99"));
    expect(called("get_workspace_pnl")[1].args).toEqual({ workspace_id: "me", granularity: "month", periods: 6 });
  });

  it("stages: the apps by stage, with readiness only where Mynt has promotion checks", async () => {
    const before = await (await stagesRoute.GET(req("/api/stages?workspace=w1"))).json();
    expect(before).toMatchObject({ supported: true, checks: false });
    expect(before.apps.map((a: { id: string; stage: string; readiness: unknown }) => [a.id, a.stage, a.readiness])).toEqual([["a1", "staging", null], ["a2", "idea", null]]);
    fake.tools = [...BASE, ...PROMOTIONS];
    const after = await (await stagesRoute.GET(req("/api/stages?workspace=w1"))).json();
    expect(after.checks).toBe(true);
    expect(called("get_promotion_checks").map((c) => c.args)).toEqual([{ app_id: "a1", to_stage: "production" }, { app_id: "a2", to_stage: "staging" }]);
    expect(after.apps[0].readiness).toMatchObject({ toStage: "production", canPromote: true, failing: 0 });
  });
});

describe("workspace route (the Workspace page's card and Settings)", () => {
  it("describes the workspace and which settings this Mynt offers", async () => {
    const body = await (await workspaceRoute.GET(req("/api/workspaces/w1"), wsParams("w1"))).json();
    expect(body.workspace).toMatchObject({ id: "w1", name: "Acme", createdAt: "2026-09-01T00:00:00Z", memberCount: 3, appCount: 2 });
    expect(body.tools).toEqual({ rename: true, archive: false, unarchive: false, relink: false });
    fake.tools = [...BASE, ...["archive_workspace", "unarchive_workspace", "relink_workspace_org"].map((name) => ({ name, inputSchema: props() }))];
    expect((await (await workspaceRoute.GET(req("/api/workspaces/w1"), wsParams("w1"))).json()).tools).toEqual({ rename: true, archive: true, unarchive: true, relink: true });
    expect((await workspaceRoute.GET(req("/api/workspaces/nope"), wsParams("nope"))).status).toBe(404);
  });

  it("renames for owners and admins; archives for owners only, and only where Mynt has the tool", async () => {
    fake.myRole = "member";
    expect((await workspaceRoute.PATCH(req("/api/workspaces/w1", "PATCH", { name: "Acme Labs" }), wsParams("w1"))).status).toBe(403);
    fake.myRole = "admin";
    expect((await workspaceRoute.PATCH(req("/api/workspaces/w1", "PATCH", { name: "Acme Labs" }), wsParams("w1"))).status).toBe(200);
    expect(called("rename_workspace")[0].args).toEqual({ workspace_id: "w1", name: "Acme Labs" });
    expect((await workspaceRoute.POST(req("/api/workspaces/w1", "POST", { action: "archive" }), wsParams("w1"))).status).toBe(501);
    fake.tools = [...BASE, { name: "archive_workspace", inputSchema: props() }];
    expect((await workspaceRoute.POST(req("/api/workspaces/w1", "POST", { action: "archive" }), wsParams("w1"))).status).toBe(403);
    fake.myRole = "owner";
    expect((await workspaceRoute.POST(req("/api/workspaces/w1", "POST", { action: "archive" }), wsParams("w1"))).status).toBe(200);
    expect(called("archive_workspace")[0].args).toEqual({ workspace_id: "w1" }); // never `now`: archiving stays undoable
  });
});
