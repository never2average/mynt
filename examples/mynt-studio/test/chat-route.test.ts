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

const claimed = new Set<string>();
vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({
    save: async () => void fake.saved++,
    claim: async (name: string, subject: string) => {
      const key = `${name}\n${subject}`;
      if (claimed.has(key)) return false;
      claimed.add(key);
      return true;
    },
  }),
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
        case "explode":
          return { isError: true, text: "Traceback: internal detail at /srv/secret.py line 3" };
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
  claimed.clear();
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
    expect(fake.saved).toBe(1); // once, before the long watch; not again at its end (the sign-in didn't change)
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
      { status: "coding", activity: [{ type: "turn_finished", summary: "interrupted", seq: 8 }, { type: "message", summary: "Making it green", seq: 9 }, { type: "turn_finished", summary: "success", seq: 10 }], cursor: 10, first_seq: 1 },
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

  it("steering mid-turn: skips the interrupted turn's end and streams the answer (baseline 7, end 8, answer 9-10)", async () => {
    fake.builds = [{ id: "live", app_id: "app1", status: "coding", updated_at: "2026-11-02" }];
    fake.activity = [
      { status: "coding", activity: [{ type: "tool_use", summary: 'Bash {"command":"npm test"}', seq: 7 }], cursor: 7, first_seq: 1 },
      { status: "coding", activity: [{ type: "turn_finished", summary: "interrupted", seq: 8 }], cursor: 8, first_seq: 1 },
      { status: "coding", activity: [{ type: "message", summary: "Switching to green", seq: 9 }, { type: "turn_finished", summary: "success", seq: 10 }], cursor: 10, first_seq: 1 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("Make it green")] }));
    expect(fake.calls.some((c) => c.name === "steer_build")).toBe(true);
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.delta)).toContain("Switching to green");
    expect(fake.calls.filter((c) => c.name === "get_build_activity")).toHaveLength(3);
  }, 15_000);

  it("without session builds, doesn't steer an agent that has finished its turn (the message would be dropped)", async () => {
    fake.builds = [{ id: "live", app_id: "app1", status: "previewing", updated_at: "2026-11-02" }];
    fake.activity = [
      { status: "previewing", activity: [{ type: "turn_finished", summary: "success", seq: 5 }], cursor: 5, first_seq: 1 },
      { status: "succeeded", activity: [], cursor: 5, first_seq: 1 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("One more thing please")] }));
    expect(fake.calls.some((c) => c.name === "steer_build")).toBe(false);
    expect(fake.calls.some((c) => c.name === "start_build")).toBe(false);
    expect(out.find((c) => c.type === "text-delta")?.delta).toMatch(/can't take more instructions/);
  });

  it("with session builds, steers an agent waiting between turns", async () => {
    fake.tools = [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {}, mode: {}, continue_from: {} } } }, { name: "finish_build" }];
    fake.builds = [{ id: "live", app_id: "app1", status: "coding", updated_at: "2026-11-02" }];
    fake.activity = [
      { status: "coding", activity: [{ type: "turn_finished", summary: "success", seq: 5 }], cursor: 5, first_seq: 1 },
      { status: "coding", activity: [{ type: "message", summary: "Added it", seq: 6 }, { type: "turn_finished", summary: "success", seq: 7 }], cursor: 7, first_seq: 1 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("One more thing please")] }));
    expect(fake.calls.find((c) => c.name === "steer_build")?.args).toEqual({ build_id: "live", message: "One more thing please" });
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.delta)).toContain("Added it");
  });

  it("follows a build that's still starting instead of starting a second one", async () => {
    fake.builds = [{ id: "q", app_id: "app1", status: "queued", updated_at: "2026-11-02" }];
    fake.activity = [{ status: "failed", activity: [] }];
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(fake.calls.some((c) => c.name === "start_build")).toBe(false);
    expect(out).toContainEqual(expect.objectContaining({ type: "data-build", data: { buildId: "q", started: false } }));
  });

  it("acts once on a message sent twice", async () => {
    fake.activity = [{ status: "failed", activity: [] }, { status: "failed", activity: [] }];
    const body = { projectId: "app1", messages: [{ id: "m1", ...userMessage("Build a savings goal screen") }] };
    await chunks(await post(body));
    const second = await chunks(await post(body));
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(second.find((c) => c.type === "text-delta")?.delta).toMatch(/just sent that/);
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
