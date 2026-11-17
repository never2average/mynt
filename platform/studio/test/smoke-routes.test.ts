import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// What the production smoke test found, on the server side: a user with no workspace on Mynt,
// Mynt's real refusal messages, non-developers' requests, and Earn's page failing as a whole.

const props = (...names: string[]) => ({ type: "object", properties: Object.fromEntries(names.map((n) => [n, {}])) });
const fake = {
  session: undefined as Session | undefined,
  connects: 0,
  workspaces: [] as unknown[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  tools: [] as { name: string; inputSchema?: unknown }[],
  refuse: {} as Record<string, string>,
};
const TOOLS = [
  { name: "list_workspaces", inputSchema: props() },
  { name: "list_my_apps", inputSchema: props("workspace_id") },
  { name: "list_builds", inputSchema: props("workspace_id") },
  { name: "get_compliance_coverage", inputSchema: props("workspace_id") },
  { name: "list_workspace_licences", inputSchema: props("workspace_id") },
  { name: "list_workspace_audit", inputSchema: props("workspace_id", "class") },
  { name: "get_workspace_attention", inputSchema: props("workspace_id") },
  { name: "get_workspace_pnl", inputSchema: props("workspace_id", "granularity", "periods") },
  { name: "list_workspace_members", inputSchema: props("workspace_id") },
  { name: "list_pools", inputSchema: props() },
  { name: "list_my_positions", inputSchema: props() },
  { name: "list_pools_with_health", inputSchema: props() },
];

vi.mock("@/lib/session", () => ({ currentSession: async () => fake.session, fromOwnOrigin: () => true, setSessionCookie: () => undefined }));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => {
    fake.connects++;
    return {
      listTools: async () => ({ tools: fake.tools }),
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        fake.calls.push({ name, args });
        if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: fake.refuse[name] }] };
        const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
        if (name === "whoami") return ok({ id: "u1", effective_roles: fake.session?.roles ?? [] });
        if (name === "list_workspaces") return ok(fake.workspaces);
        if (name === "list_pools") return ok({ pools: [{ id: "p1", name: "Pool", product_id: "prod1", status: "open" }] });
        if (name === "list_my_positions") return ok({ positions: [] });
        if (name === "list_pools_with_health") return ok({ pools: [] });
        return ok({});
      },
      close: async () => undefined,
    };
  },
}));

const req = (path: string) => new Request(`http://localhost:3000${path}`);
const called = (name: string) => fake.calls.filter((c) => c.name === name);

beforeEach(() => {
  fake.session = { id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() } as Session;
  fake.connects = 0;
  fake.workspaces = [];
  fake.calls = [];
  fake.tools = TOOLS;
  fake.refuse = {};
});

describe("a developer with no workspace on Mynt (they skipped choosing one)", () => {
  it("is told to create one, and nothing is asked of Mynt without a workspace or with 'personal'", async () => {
    const { NO_WORKSPACE } = await import("@/lib/workspace-server");
    const routes = [
      (await import("@/app/api/audit/route")).GET(req("/api/audit?class=security")),
      (await import("@/app/api/licences/route")).GET(req("/api/licences")),
      (await import("@/app/api/coverage/route")).GET(req("/api/coverage")),
      (await import("@/app/api/attention/route")).GET(req("/api/attention")),
      (await import("@/app/api/pnl/route")).GET(req("/api/pnl")),
      (await import("@/app/api/obligations/route")).GET(req("/api/obligations")),
    ];
    for (const res of await Promise.all(routes)) {
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.unavailable === NO_WORKSPACE || body.supported === false, JSON.stringify(body)).toBe(true);
    }
    const sent = fake.calls.filter((c) => !["whoami", "list_workspaces"].includes(c.name));
    expect(sent).toEqual([]);
    expect(JSON.stringify(fake.calls)).not.toContain("personal");
  });

  it("asking for the 'personal' workspace's settings or members is a 404 that never reaches Mynt", async () => {
    const ws = await import("@/app/api/workspaces/[workspaceId]/route");
    const members = await import("@/app/api/workspaces/[workspaceId]/members/route");
    const params = { params: Promise.resolve({ workspaceId: "personal" }) };
    expect((await ws.GET(req("/api/workspaces/personal"), params)).status).toBe(404);
    expect((await members.GET(req("/api/workspaces/personal/members"), params)).status).toBe(404);
    expect(fake.connects).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("with a workspace, the same reads are scoped to it", async () => {
    fake.workspaces = [{ id: "w1", name: "Acme", role: "owner", personal: true }];
    await (await import("@/app/api/licences/route")).GET(req("/api/licences?workspace=w1"));
    expect(called("list_workspace_licences")[0].args).toEqual({ workspace_id: "w1" });
  });
});

describe("Mynt's refusals", () => {
  it("show Mynt's own message, from any shape it answers with; only empty or internal text is generic", async () => {
    const { refusalMessage, GENERIC_REFUSAL } = await import("@/lib/studio-server");
    expect(refusalMessage(JSON.stringify({ error: "No workspace of yours with id 'w9'" }))).toBe("No workspace of yours with id 'w9'");
    expect(refusalMessage(JSON.stringify({ error: { code: "not_found", message: "That pool isn't open" } }))).toBe("That pool isn't open");
    expect(refusalMessage(JSON.stringify({ message: "Rate limited, try in a minute" }))).toBe("Rate limited, try in a minute");
    expect(refusalMessage("MCP error -32602: Input validation error: workspace_id is required")).toBe("MCP error -32602: Input validation error: workspace_id is required");
    expect(refusalMessage("")).toBe(GENERIC_REFUSAL);
    expect(refusalMessage(JSON.stringify({ error: "  " }))).toBe(GENERIC_REFUSAL);
    expect(refusalMessage("TypeError: x\n    at handler (/srv/app/server.js:10:5)")).toBe(GENERIC_REFUSAL);
  });

  it("reach the page as Mynt worded them (422), not a generic line", async () => {
    fake.workspaces = [{ id: "w1", name: "Acme", role: "owner", personal: true }];
    fake.refuse = { list_workspace_licences: JSON.stringify({ error: "This workspace's licences are being reindexed" }) };
    const res = await (await import("@/app/api/licences/route")).GET(req("/api/licences?workspace=w1"));
    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe("This workspace's licences are being reindexed");
  });
});

describe("non-developers", () => {
  it("are refused developer routes at once, without connecting to Mynt, while their roles are fresh", async () => {
    fake.session = { ...fake.session!, roles: ["consumer"], rolesAt: Date.now() } as Session;
    const routes = await Promise.all([
      (await import("@/app/api/licences/route")).GET(req("/api/licences")),
      (await import("@/app/api/projects/route")).GET(req("/api/projects") as never),
      (await import("@/app/api/repositories/route")).GET(),
      (await import("@/app/api/workspaces/route")).GET(),
    ]);
    for (const res of routes) {
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe("not_developer");
    }
    expect(fake.connects).toBe(0);
  });

  it("with stale roles, Mynt is asked once who they are, then refused", async () => {
    fake.session = { ...fake.session!, roles: ["consumer"], rolesAt: Date.now() - 60 * 60 * 1000 } as Session;
    const res = await (await import("@/app/api/licences/route")).GET(req("/api/licences"));
    expect(res.status).toBe(403);
    expect(called("whoami")).toHaveLength(1);
    expect(called("list_workspace_licences")).toEqual([]);
  });
});

describe("Earn's page for an admin", () => {
  it("one section that fails to read leaves only that section out, not a 502 for the page", async () => {
    const liquidity = await import("@/lib/liquidity");
    const spy = vi.spyOn(liquidity, "fromPoolsWithHealth").mockImplementation(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'pool_id')");
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { loadLiquidity } = await import("@/lib/liquidity-server");
    const data = await loadLiquidity((await (await import("@/lib/tokens")).connectStudio(fake.session!)) as never, { builder: true, liquidityProvider: true });
    expect(data.supported).toBe(true);
    expect(data.unavailable).toEqual(["provider"]);
    expect(data.builder?.pools).toBeDefined();
    // The log names what and where, so the cause can be found.
    expect(errors.mock.calls.flat().join(" ")).toMatch(/provider section failed \(TypeError: Cannot read properties of undefined \(reading 'pool_id'\)/);
    spy.mockRestore();
    errors.mockRestore();
  });
});
