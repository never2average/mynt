import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// A fake Mynt: the tools the route calls, what it was asked, and the activity it reports.
const fake = {
  session: undefined as Session | undefined,
  tools: [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {} } } }] as { name: string; inputSchema?: unknown }[],
  builds: [] as Record<string, unknown>[],
  activity: [] as unknown[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  saved: 0,
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => {
    const o = req.headers.get("origin");
    return o === null || o === "http://localhost:3000";
  },
}));

vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({ save: async () => void fake.saved++ }),
}));

vi.mock("@/lib/mynt-client", () => {
  class NotSignedInError extends Error {}
  class NotAllowedError extends Error {}
  return {
    NotSignedInError,
    NotAllowedError,
    connectMynt: async () => ({
      listTools: async () => ({ tools: fake.tools }),
      close: async () => undefined,
    }),
    callMyntTool: async (_client: unknown, name: string, args: Record<string, unknown>) => {
      fake.calls.push({ name, args });
      const reply = (data: unknown) => ({ isError: false, text: JSON.stringify(data) });
      switch (name) {
        case "whoami":
          return reply({ id: "u1", effective_roles: ["developer"] });
        case "list_builds":
          return reply({ builds: fake.builds });
        case "start_build":
          return reply({ id: "new-build", status: "queued" });
        case "steer_build":
          return reply({ build_id: args.build_id, steered: true });
        case "get_build_activity":
          return reply(fake.activity.shift() ?? { status: "coding", activity: [] });
        default:
          return { isError: true, text: JSON.stringify({ error: `unexpected ${name}` }) };
      }
    },
  };
});

const { POST } = await import("@/app/api/chat/route");

function post(body: unknown, origin = "http://localhost:3000") {
  return POST(new Request("http://localhost:3000/api/chat", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
}

const userMessage = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });

// The SSE stream's JSON chunks.
async function chunks(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" } } as Session;
  fake.tools = [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {} } } }];
  fake.builds = [];
  fake.activity = [];
  fake.calls = [];
  fake.saved = 0;
});

describe("/api/chat", () => {
  it("starts a build for the app when none is running, and streams what the agent does", async () => {
    fake.activity = [
      {
        status: "coding",
        phase_message: "Writing the app",
        activity: [{ type: "turn_finished", summary: "success" }, { type: "tool_use", summary: 'Bash {"command":"npm test"}' }, { type: "message", summary: "On it" }],
      },
    ];
    const res = await post({ projectId: "app1", conversationId: null, messages: [userMessage("Build a savings goal screen")] });
    expect(res.status).toBe(200);
    const out = await chunks(res);
    expect(fake.calls.find((c) => c.name === "start_build")?.args).toEqual({ goal: "Build a savings goal screen", app_id: "app1" });
    expect(fake.calls.some((c) => c.name === "steer_build")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "data-build", data: { buildId: "new-build", started: true } }));
    expect(out).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "On it" }));
    expect(out).toContainEqual(expect.objectContaining({ type: "tool-input-available", toolName: "bashTool", input: { command: "npm test" } }));
    expect(fake.saved).toBeGreaterThan(0);
  });

  it("starts a session build where Mynt offers them", async () => {
    fake.tools = [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {}, mode: {}, continue_from: {} } } }, { name: "finish_build" }];
    fake.builds = [{ id: "prev", app_id: "app1", status: "succeeded", commit_sha: "abc", updated_at: "2026-11-01" }];
    fake.activity = [{ status: "failed", activity: [] }];
    await chunks(await post({ projectId: "app1", messages: [userMessage("Add a statements page")] }));
    expect(fake.calls.find((c) => c.name === "start_build")?.args).toEqual({ goal: "Add a statements page", app_id: "app1", mode: "session", continue_from: "prev" });
  });

  it("steers the running build, showing only what came after the message", async () => {
    fake.builds = [{ id: "live", app_id: "app1", status: "coding", updated_at: "2026-11-02" }];
    fake.activity = [
      { status: "coding", activity: [{ type: "message", summary: "Earlier work", seq: 7 }], cursor: 7, first_seq: 1 },
      { status: "coding", activity: [{ type: "message", summary: "Making it green", seq: 8 }, { type: "turn_finished", summary: "success", seq: 9 }], cursor: 9, first_seq: 1 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("Make it green")] }));
    const names = fake.calls.map((c) => c.name);
    expect(names.indexOf("get_build_activity")).toBeLessThan(names.indexOf("steer_build")); // baseline first
    expect(fake.calls.find((c) => c.name === "steer_build")?.args).toEqual({ build_id: "live", message: "Make it green" });
    expect(fake.calls.filter((c) => c.name === "get_build_activity")[1].args).toEqual({ build_id: "live", limit: 200, after: 7 });
    const texts = out.filter((c) => c.type === "text-delta").map((c) => c.delta);
    expect(texts).toContain("Making it green");
    expect(texts).not.toContain("Earlier work");
    expect(fake.calls.some((c) => c.name === "start_build")).toBe(false);
  });

  it("answers in the chat when a message is too short to start a build", async () => {
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("hi")] }));
    expect(out.find((c) => c.type === "text-delta")?.delta).toMatch(/at least 10/);
    expect(fake.calls.some((c) => c.name === "start_build")).toBe(false);
  });

  it("refuses other origins, the signed-out, non-developers and bad requests", async () => {
    expect((await post({ projectId: "app1", messages: [userMessage("Build it now please")] }, "https://evil.example")).status).toBe(403);
    expect((await post({ projectId: "", messages: [] })).status).toBe(400);
    fake.session = undefined;
    expect((await post({ projectId: "app1", messages: [userMessage("Build it now please")] })).status).toBe(401);
    fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["consumer"] } as Session;
    expect((await post({ projectId: "app1", messages: [userMessage("Build it now please")] })).status).toBe(403);
    expect(fake.calls.some((c) => c.name === "start_build")).toBe(false);
  });
});
