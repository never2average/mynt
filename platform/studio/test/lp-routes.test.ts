import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// The dashboard's investor view reads Needs attention and the audit trail's financial class, so a
// liquidity provider without the developer role may call /api/attention and /api/audit. Mynt's
// tools still decide what each caller may read: the studio passes their answers through and adds
// nothing. Every other developer route stays closed to them.

const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const fake = {
  session: undefined as Session | undefined,
  calls: [] as { name: string; args: Record<string, unknown> }[],
};
const TOOLS = [
  { name: "list_workspaces", inputSchema: props() },
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "list_builds", inputSchema: props("workspace_id") },
  { name: "get_workspace_attention", inputSchema: props("workspace_id") },
  { name: "list_workspace_audit", inputSchema: props("workspace_id", "cursor", "action", "user_id", "app_id", "from", "to", "class") },
  { name: "get_compliance_coverage", inputSchema: props("workspace_id") },
  { name: "list_workspace_licences", inputSchema: props("workspace_id") },
  { name: "get_workspace_obligations", inputSchema: props("workspace_id") },
  { name: "get_workspace_pnl", inputSchema: props("workspace_id", "granularity", "periods") },
  { name: "get_developer_dashboard", inputSchema: props("days", "workspace_id") },
];

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: () => true,
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: TOOLS }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      switch (name) {
        case "whoami":
          return ok({ id: "lp1", effective_roles: ["liquidity_provider"] });
        case "list_workspaces":
          return ok([{ id: "me", name: "Lena", role: "owner", personal: true, created_at: "2026-01-01T00:00:00Z", members: 1, apps: 0 }]);
        case "get_workspace_attention":
          return ok({ items: [{ id: "x1", kind: "withdrawal", severity: "medium", title: "Withdrawal parked", href: "/earn?tab=my-positions" }] });
        case "list_workspace_audit":
          return ok({ rows: [{ id: "f1", at: "2026-11-14T10:00:00Z", class: "financial", kind: "liquidity.commit", summary: "Committed", status: "settled" }], next_cursor: null });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const attention = await import("@/app/api/attention/route");
const audit = await import("@/app/api/audit/route");
const req = (path: string) => new Request(`http://localhost:3000${path}`);

beforeEach(() => {
  fake.session = { id: "s", userId: "lp1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["liquidity_provider"], rolesAt: Date.now() } as Session;
  fake.calls = [];
});

describe("a liquidity provider without the developer role", () => {
  it("gets Needs attention: 200, exactly what Mynt's tool answered, for their own workspace", async () => {
    const res = await attention.GET(req("/api/attention?workspace=personal"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(["x1"]);
    expect(fake.calls.filter((c) => c.name === "get_workspace_attention").map((c) => c.args)).toEqual([{ workspace_id: "me" }]);
  });

  it("gets the audit trail's financial class: 200, only the rows Mynt's tool returned, with the class sent to Mynt", async () => {
    const res = await audit.GET(req("/api/audit?workspace=personal&class=financial"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page.rows.map((r: { id: string }) => r.id)).toEqual(["f1"]);
    expect(fake.calls.filter((c) => c.name === "list_workspace_audit").map((c) => c.args)).toEqual([{ class: "financial" }]);
  });

  it("is still refused every other developer route, before anything reaches Mynt's data tools", async () => {
    const routes: [string, () => Promise<Response>][] = [
      ["/api/dashboard", async () => (await import("@/app/api/dashboard/route")).GET(req("/api/dashboard") as never)],
      ["/api/pnl", async () => (await import("@/app/api/pnl/route")).GET(req("/api/pnl"))],
      ["/api/stages", async () => (await import("@/app/api/stages/route")).GET(req("/api/stages"))],
      ["/api/coverage", async () => (await import("@/app/api/coverage/route")).GET(req("/api/coverage"))],
      ["/api/licences", async () => (await import("@/app/api/licences/route")).GET(req("/api/licences"))],
      ["/api/obligations", async () => (await import("@/app/api/obligations/route")).GET(req("/api/obligations"))],
      ["/api/projects", async () => (await import("@/app/api/projects/route")).GET(req("/api/projects") as never)],
    ];
    for (const [path, call] of routes) {
      const res = await call();
      expect(res.status, path).toBe(403);
    }
    const dataTools = fake.calls.filter((c) => c.name !== "whoami");
    expect(dataTools).toEqual([]);
  });

  it("someone with neither role is refused attention and audit too", async () => {
    fake.session = { ...fake.session!, roles: [] } as Session;
    expect((await attention.GET(req("/api/attention"))).status).toBe(403);
    expect((await audit.GET(req("/api/audit?class=financial"))).status).toBe(403);
  });
});
