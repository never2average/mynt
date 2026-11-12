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
  startFails: 0, // start_build refuses this many times
  startThrows: 0, // start_build's reply is lost (a transport error) this many times
  listDelays: [] as number[], // per list_builds call: answer with the builds as they were, this much later
  startDelayMs: 0,
  refreshOnConnect: false, // connecting refreshes the session's tokens
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => {
    const o = req.headers.get("origin");
    return o === null || o === "http://localhost:3000";
  },
}));

// Claims as the store keeps them: key -> owner token; a release frees only its own claim.
const claimed = new Map<string, number>();
let claimToken = 0;
vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({
    save: async () => {
      fake.saved++;
      return true;
    },
    claim: async (name: string, subject: string) => {
      const key = `${name}\n${subject}`;
      if (claimed.has(key)) return null;
      const mine = ++claimToken;
      claimed.set(key, mine);
      return async () => {
        if (claimed.get(key) === mine) claimed.delete(key);
      };
    },
  }),
}));
const startLocks = () => [...claimed.keys()].filter((k) => k.startsWith("start-lock"));

vi.mock("@/lib/mynt-client", () => {
  class NotSignedInError extends Error {}
  class NotAllowedError extends Error {}
  return {
    NotSignedInError,
    NotAllowedError,
    connectMynt: async () => {
      if (fake.refreshOnConnect && fake.session) fake.session.tokens = { access_token: "refreshed", token_type: "Bearer" };
      return {
        listTools: async () => ({ tools: fake.tools }),
        close: async () => undefined,
      };
    },
    callMyntTool: async (_client: unknown, name: string, args: Record<string, unknown>) => {
      fake.calls.push({ name, args });
      const reply = (data: unknown) => ({ isError: false, text: JSON.stringify(data) });
      switch (name) {
        case "whoami":
          return reply({ id: "u1", effective_roles: ["developer"] });
        case "list_builds": {
          const snapshot = [...fake.builds];
          const delay = fake.listDelays.shift() ?? 0;
          if (delay) await new Promise((r) => setTimeout(r, delay));
          return reply({ builds: snapshot });
        }
        case "start_build":
          if (fake.startDelayMs) await new Promise((r) => setTimeout(r, fake.startDelayMs));
          if (fake.startFails > 0) {
            fake.startFails--;
            return { isError: true, text: JSON.stringify({ error: "Monthly build budget reached" }) };
          }
          if (fake.startThrows > 0) {
            fake.startThrows--;
            throw new Error("socket hang up");
          }
          // Mynt lists the new build from now on.
          fake.builds.push({ id: "new-build", app_id: args.app_id, status: "queued", updated_at: "2026-11-12" });
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

const { POST, WATCH_MS, maxDuration } = await import("@/app/api/chat/route");

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
  fake.startFails = 0;
  fake.startThrows = 0;
  fake.listDelays = [];
  fake.startDelayMs = 0;
  fake.refreshOnConnect = false;
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
    fake.builds = []; // as if Mynt didn't list the new build yet: the duplicate check is what stops it
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
    // Roles read from Mynt a moment ago (they're read again after a few minutes).
    fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["consumer"], rolesAt: Date.now() } as Session;
    expect((await post({ projectId: "app1", messages: [userMessage("Build it now please")] })).status).toBe(403);
    expect(fake.calls.some((c) => c.name === "start_build")).toBe(false);
  });
});

describe("/api/chat follow-ups", () => {
  const statements = () => ({ projectId: "app1", messages: [userMessage("Add a statements page")] });

  it("gives the message back when the build couldn't start, so sending it again works", async () => {
    fake.startFails = 1;
    fake.activity = [{ status: "failed", activity: [] }];
    const first = await chunks(await post(statements()));
    expect(first).toContainEqual(expect.objectContaining({ type: "error", errorText: "Monthly build budget reached" }));
    expect(claimed.size).toBe(0); // claims and the start lock released
    await chunks(await post(statements()));
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(2);
  });

  it("claims nothing when a steer is withheld because the build is finishing", async () => {
    fake.builds = [{ id: "live", app_id: "app1", status: "previewing", updated_at: "2026-11-02" }];
    fake.activity = [{ status: "previewing", activity: [{ type: "turn_finished", summary: "success", seq: 5 }], cursor: 5 }, { status: "succeeded", activity: [], cursor: 5 }];
    await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("One more thing please")] }));
    expect(claimed.size).toBe(0);
  });

  it("two devices of one user starting at the same moment start one build", async () => {
    fake.startDelayMs = 50;
    fake.activity = [{ status: "failed", activity: [] }, { status: "failed", activity: [] }];
    const deviceA = { id: "a", createdAt: 0, lastSeen: 0, tokens: { access_token: "a", token_type: "Bearer" } } as Session;
    const deviceB = { id: "b", createdAt: 0, lastSeen: 0, tokens: { access_token: "b", token_type: "Bearer" } } as Session;
    fake.session = deviceA;
    const first = post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] });
    await new Promise((r) => setTimeout(r, 10));
    fake.session = deviceB;
    const second = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a budgeting screen instead")] }));
    await chunks(await first);
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(second.find((c) => c.type === "text-delta")?.delta).toMatch(/being started right now/);
  });

  it("the same text from another device of the same user counts as sent", async () => {
    fake.activity = [{ status: "failed", activity: [] }];
    fake.session = { id: "a", createdAt: 0, lastSeen: 0, tokens: { access_token: "a", token_type: "Bearer" } } as Session;
    await chunks(await post(statements()));
    fake.builds = []; // as if Mynt didn't list the new build yet: the duplicate check is what stops it
    fake.session = { id: "b", createdAt: 0, lastSeen: 0, tokens: { access_token: "b", token_type: "Bearer" } } as Session;
    const again = await chunks(await post(statements()));
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(again.find((c) => c.type === "text-delta")?.delta).toMatch(/just sent that/);
  });

  it("saves the session on early answers only when something changed", async () => {
    const fresh = () => ({ id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles: ["developer"], rolesAt: Date.now() }) as Session;
    fake.session = fresh();
    await chunks(await post({ projectId: "app1", messages: [userMessage("hi")] })); // refused: too short
    expect(fake.saved).toBe(0);
    fake.session = fresh();
    fake.refreshOnConnect = true;
    await chunks(await post({ projectId: "app1", messages: [userMessage("hi")] }));
    expect(fake.saved).toBe(1); // refreshed tokens are kept
  });

  it("stops watching with time to spare for the last call before Vercel's limit", () => {
    const mcpTimeoutMs = 60_000;
    expect(WATCH_MS + mcpTimeoutMs).toBeLessThan(maxDuration * 1000);
  });

  it("without session builds, says the message may not have arrived when no answer came", async () => {
    fake.builds = [{ id: "live", app_id: "app1", status: "coding", updated_at: "2026-11-02" }];
    fake.activity = [
      { status: "coding", activity: [{ type: "message", summary: "Working", seq: 7 }], cursor: 7 },
      { status: "coding", activity: [{ type: "turn_finished", summary: "success", seq: 8 }], cursor: 8 }, // the natural end, taken as the interrupted one
      { status: "succeeded", activity: [], cursor: 8 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("Make it green")] }));
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.delta).join("\n")).toMatch(/may not have reached the agent/);
  }, 15_000);
});

describe("/api/chat start races", () => {
  const deviceA = () => ({ id: "a", createdAt: 0, lastSeen: 0, tokens: { access_token: "a", token_type: "Bearer" } }) as Session;
  const deviceB = () => ({ id: "b", createdAt: 0, lastSeen: 0, tokens: { access_token: "b", token_type: "Bearer" } }) as Session;

  it("B's list_builds answered before A's start, but arriving after it: still one build", async () => {
    fake.activity = [{ status: "failed", activity: [] }, { status: "failed", activity: [] }];
    // B asks first; its (stale, empty) answer arrives only after A has started and finished.
    fake.listDelays = [150];
    fake.session = deviceB();
    const b = post({ projectId: "app1", messages: [userMessage("Build a budgeting screen instead")] });
    await new Promise((r) => setTimeout(r, 20));
    fake.session = deviceA();
    await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    const out = await chunks(await b);
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(out.find((c) => c.type === "text-delta")?.delta).toMatch(/being started right now/); // A's lock is still held
  });

  it("once A's lock has lapsed, B decides again under its own lock and follows A's build", async () => {
    fake.activity = [{ status: "failed", activity: [] }, { status: "failed", activity: [] }];
    fake.listDelays = [150];
    fake.session = deviceB();
    const b = post({ projectId: "app1", messages: [userMessage("Build a budgeting screen instead")] });
    await new Promise((r) => setTimeout(r, 20));
    fake.session = deviceA();
    await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(startLocks()).toHaveLength(1); // kept after a successful start
    for (const k of startLocks()) claimed.delete(k); // its 10 s TTL lapses
    const out = await chunks(await b);
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(out).toContainEqual(expect.objectContaining({ type: "data-build", data: { buildId: "new-build", started: false } }));
    expect(startLocks()).toHaveLength(0); // B gave its lock back: it started nothing
  });

  it("keeps the claims when start_build's reply is lost, so a retry can't start a second build", async () => {
    fake.startThrows = 1;
    const first = await chunks(await post({ projectId: "app1", messages: [userMessage("Add a statements page")] }));
    expect(first).toContainEqual(expect.objectContaining({ type: "error" }));
    const again = await chunks(await post({ projectId: "app1", messages: [userMessage("Add a statements page")] }));
    expect(again.find((c) => c.type === "text-delta")?.delta).toMatch(/just sent that/);
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
  });
});
