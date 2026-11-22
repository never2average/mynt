import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// The builder's Ship (POST /api/builds/[buildId]/finish): signed-in developers only, same-origin
// writes, the build must be the app's, and Mynt's refusals come back in its own words. (The studio
// has no cap pickers, so no budget route: Mynt applies its own cap to every build.)

const fake = {
  session: undefined as Session | undefined,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  build: { id: "b1", app_id: "app-1", status: "coding", mode: "session" } as Record<string, unknown> | null,
  finishRefusal: null as string | null,
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({
      tools: [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {}, mode: {}, continue_from: {} } } }, { name: "finish_build" }],
    }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      const refuse = (error: string) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });
      switch (name) {
        case "whoami":
          return ok({ id: "u1", effective_roles: ["developer"] });
        case "get_build":
          return fake.build ? ok(fake.build) : refuse(`No build of yours with id '${args.build_id}'`);
        case "finish_build":
          return fake.finishRefusal ? refuse(fake.finishRefusal) : ok({ build_id: args.build_id, finishing: true });
        default:
          return refuse(`unexpected ${name}`);
      }
    },
    close: async () => undefined,
  }),
}));

const finish = await import("@/app/api/builds/[buildId]/finish/route");

const ship = (buildId: string, body: unknown, origin = "http://localhost:3000") =>
  finish.POST(new Request(`http://localhost:3000/api/builds/${buildId}/finish`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ buildId }),
  });

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" } } as Session;
  fake.calls = [];
  fake.build = { id: "b1", app_id: "app-1", status: "coding", mode: "session" };
  fake.finishRefusal = null;
});

describe("Ship", () => {
  it("finishes the app's session build", async () => {
    const res = await ship("b1", { projectId: "app-1" });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toMatch(/^Shipping: the agent wraps up its current request/);
    expect(fake.calls.find((c) => c.name === "finish_build")?.args).toEqual({ build_id: "b1" });
  });

  it("refuses another app's build, another site, a bad request, and someone signed out, before anything reaches Mynt's finish", async () => {
    expect((await ship("b1", { projectId: "other" })).status).toBe(404);
    expect((await ship("b1", { projectId: "app-1" }, "https://evil.example")).status).toBe(403);
    expect((await ship("b1", { projectId: "app-1", reason: "ttl" })).status).toBe(400);
    expect((await ship("b 1", { projectId: "app-1" })).status).toBe(400);
    fake.session = undefined;
    expect((await ship("b1", { projectId: "app-1" })).status).toBe(401);
    expect(fake.calls.some((c) => c.name === "finish_build")).toBe(false);
  });

  it("shows Mynt's refusal in its own words", async () => {
    fake.finishRefusal = "Build is verifying; only a running session can be finished";
    const res = await ship("b1", { projectId: "app-1" });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe("Build is verifying; only a running session can be finished");
  });
});

describe("the build budget route", () => {
  it("is gone: no cap picker reads it", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync(new URL("../app/api/builds/budget/route.ts", import.meta.url))).toBe(false);
  });
});
