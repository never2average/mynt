import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { readTimed } from "./stream-timing";

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
  build: null as Record<string, unknown> | null, // what get_build answers (null: no such build)
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => {
    const o = req.headers.get("origin");
    return o === null || o === "http://localhost:3000";
  },
}));

// Claims as the store keeps them: key -> owner token and expiry (on a clock the tests move); a
// release frees only its own claim.
const claimed = new Map<string, number>();
const expiry = new Map<string, number>();
const clock = { now: 0 };
let claimToken = 0;
vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({
    save: async () => {
      fake.saved++;
      return true;
    },
    claim: async (name: string, subject: string, ttlSeconds: number) => {
      const key = `${name}\n${subject}`;
      if (claimed.has(key) && (expiry.get(key) ?? Infinity) > clock.now) return null;
      const mine = ++claimToken;
      claimed.set(key, mine);
      expiry.set(key, clock.now + ttlSeconds * 1000);
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
            return { isError: true, text: JSON.stringify({ error: "Monthly build budget used up (US$100.00 of US$100 spent this month)" }) };
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
        case "get_build":
          return fake.build ? reply(fake.build) : { isError: true, text: JSON.stringify({ error: `No build of yours with id '${args.build_id}'` }) };
        case "get_build_activity":
          {
            // An entry may be a function: the activity as it is when Mynt is asked.
            const next = fake.activity.shift();
            return reply((typeof next === "function" ? next() : next) ?? { status: "coding", activity: [] });
          }
        case "explode":
          return { isError: true, text: "Traceback: internal detail at /srv/secret.py line 3" };
        default:
          return { isError: true, text: JSON.stringify({ error: `unexpected ${name}` }) };
      }
    },
  };
});

const { GET, POST, WATCH_MS, maxDuration, START_LOCK_SECONDS } = await import("@/app/api/chat/route");

function follow(query: string, origin: string | null = null) {
  return GET(new Request(`http://localhost:3000/api/chat?${query}`, { headers: origin ? { origin } : {} }));
}

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
  fake.build = null;
  claimed.clear();
  expiry.clear();
  clock.now = 0;
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
    expect(out).toContainEqual(expect.objectContaining({ type: "data-build", data: { buildId: "new-build", started: true, session: false } }));
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
    expect(out).toContainEqual(expect.objectContaining({ type: "data-build", data: { buildId: "q", started: false, session: false } }));
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

describe("/api/chat streaming the agent's words", () => {
  const withDeltas = () => {
    fake.tools = [
      { name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {} } } },
      { name: "get_build_activity", inputSchema: { type: "object", properties: { build_id: {}, limit: {}, after: {}, text_deltas: {} } } },
    ];
  };
  const delta = (seq: number, summary: string, stream = "msg_1:0") => ({ type: "text_delta", summary, stream, seq });

  it("asks for the words where Mynt offers them, and draws a message's words into one part that its whole message closes", async () => {
    withDeltas();
    fake.activity = [
      // Without a cursor, Mynt answers newest first.
      { status: "coding", activity: [delta(2, "the spec "), delta(1, "Reading ")], cursor: 2, first_seq: 1 },
      {
        status: "coding",
        activity: [
          delta(3, "now."),
          { type: "message", summary: "Reading the spec now.", stream: "msg_1:0", seq: 4 },
          { type: "tool_use", summary: 'Bash {"command":"npm test"}', seq: 5 },
          { type: "message", summary: "Not streamed", seq: 6 },
          { type: "turn_finished", summary: "success", seq: 7 },
        ],
        cursor: 7,
        first_seq: 1,
      },
    ];
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(fake.calls.filter((c) => c.name === "get_build_activity").map((c) => c.args)).toEqual([
      { build_id: "new-build", limit: 200, text_deltas: true },
      { build_id: "new-build", limit: 200, after: 2, text_deltas: true },
    ]);
    const shown = out.filter((c) => ["text-start", "text-delta", "text-end", "tool-input-available"].includes(c.type as string)).map((c) => [c.type, c.delta ?? c.toolName ?? ""]);
    expect(shown).toEqual([
      ["text-start", ""],
      ["text-delta", "Reading "],
      ["text-delta", "the spec "],
      ["text-delta", "now."],
      ["text-end", ""],
      ["tool-input-available", "bashTool"],
      ["text-start", ""],
      ["text-delta", "Not streamed"],
      ["text-end", ""],
    ]);
    // One part for the streamed message: its pieces share an id, and its whole text isn't printed again.
    const ids = new Set(out.filter((c) => c.type === "text-delta").slice(0, 3).map((c) => c.id));
    expect(ids.size).toBe(1);
  });

  it("asks for the agent's reasoning where Mynt offers it, and draws each thinking block as one reasoning part before its words", async () => {
    fake.tools = [
      { name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {} } } },
      { name: "get_build_activity", inputSchema: { type: "object", properties: { build_id: {}, limit: {}, after: {}, text_deltas: {}, reasoning: {} } } },
    ];
    const think = (seq: number, summary: string) => ({ type: "thinking_delta", summary, stream: "msg_1:0", seq });
    fake.activity = [
      { status: "coding", activity: [think(2, "a goal screen. "), think(1, "They want ")], cursor: 2, first_seq: 1 },
      {
        status: "coding",
        activity: [
          think(3, "Start there."),
          { type: "thinking", summary: "They want a goal screen. Start there.", stream: "msg_1:0", seq: 4 },
          delta(5, "On it.", "msg_1:1"),
          { type: "message", summary: "On it.", stream: "msg_1:1", seq: 6 },
          { type: "thinking", summary: "Not streamed thought", seq: 7 },
          { type: "turn_finished", summary: "success", seq: 8 },
        ],
        cursor: 8,
        first_seq: 1,
      },
    ];
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(fake.calls.filter((c) => c.name === "get_build_activity").map((c) => c.args)).toEqual([
      { build_id: "new-build", limit: 200, text_deltas: true, reasoning: true },
      { build_id: "new-build", limit: 200, after: 2, text_deltas: true, reasoning: true },
    ]);
    const shown = out.filter((c) => /^(reasoning|text)-/.test(String(c.type))).map((c) => [c.type, c.delta ?? ""]);
    expect(shown).toEqual([
      ["reasoning-start", ""],
      ["reasoning-delta", "They want "],
      ["reasoning-delta", "a goal screen. "],
      ["reasoning-delta", "Start there."],
      ["reasoning-end", ""],
      ["text-start", ""],
      ["text-delta", "On it."],
      ["text-end", ""],
      ["reasoning-start", ""],
      ["reasoning-delta", "Not streamed thought"],
      ["reasoning-end", ""],
    ]);
    // One part per thinking block: the streamed block's pieces share an id.
    expect(new Set(out.filter((c) => c.type === "reasoning-delta").slice(0, 3).map((c) => c.id)).size).toBe(1);
  });

  it("streams in real time: the first words reach the browser before the agent has written the last", async () => {
    withDeltas();
    const pieces = ["I'll add ", "a savings ", "goal screen ", "with a progress ring."];
    const producedAt: number[] = [];
    // Mynt's activity as the agent writes: one more piece each time it's read.
    fake.activity = pieces.map((piece, i) => () => {
      producedAt.push(performance.now());
      const last = i === pieces.length - 1;
      const activity: unknown[] = [delta(i + 1, piece)];
      if (last) activity.push({ type: "message", summary: pieces.join(""), stream: "msg_1:0", seq: i + 2 }, { type: "turn_finished", summary: "success", seq: i + 3 });
      return { status: "coding", activity, cursor: last ? i + 3 : i + 1, first_seq: 1 };
    });
    const res = await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    const got = await readTimed(res);
    const deltas = got.filter((c) => c.chunk.type === "text-delta");
    expect(deltas.map((c) => c.chunk.delta)).toEqual(pieces);
    expect(producedAt).toHaveLength(pieces.length);
    const gaps = producedAt.slice(1).map((t, i) => t - producedAt[i]);
    console.info(
      `chat: first delta at +${(deltas[0].at - producedAt[0]).toFixed(1)} ms after Mynt reported it; ${(producedAt[pieces.length - 1] - deltas[0].at).toFixed(1)} ms before the last piece was reported; polls ${gaps.map((g) => g.toFixed(0)).join(", ")} ms apart`,
    );
    expect(deltas[0].at).toBeLessThan(producedAt[pieces.length - 1]);
    for (let i = 0; i < pieces.length - 1; i++) expect(deltas[i].at).toBeLessThan(producedAt[i + 1]);
    // While the agent is talking, Mynt is read about every 700 ms rather than every 2 s.
    for (const g of gaps) expect(g).toBeLessThan(1500);
  }, 15_000);
});

describe("/api/chat follow-ups", () => {
  const statements = () => ({ projectId: "app1", messages: [userMessage("Add a statements page")] });

  it("gives the message back when the build couldn't start, so sending it again works", async () => {
    fake.startFails = 1;
    fake.activity = [{ status: "failed", activity: [] }];
    const first = await chunks(await post(statements()));
    expect(first).toContainEqual(expect.objectContaining({ type: "error", errorText: "Monthly build budget used up (US$100.00 of US$100 spent this month)" }));
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

  it("B's list_builds answered before A's start, but arriving after it: B decides again under the lock and follows A's build", async () => {
    fake.activity = [{ status: "failed", activity: [] }, { status: "failed", activity: [] }];
    // B asks first; its (stale, empty) answer arrives only after A has started and finished.
    fake.listDelays = [150];
    fake.session = deviceB();
    const b = post({ projectId: "app1", messages: [userMessage("Build a budgeting screen instead")] });
    await new Promise((r) => setTimeout(r, 20));
    fake.session = deviceA();
    await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(startLocks()).toHaveLength(0); // released once A's start was done
    const out = await chunks(await b);
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(out).toContainEqual(expect.objectContaining({ type: "data-build", data: { buildId: "new-build", started: false, session: false } }));
    expect(startLocks()).toHaveLength(0);
  });

  it("the start lock is the app's, not the user's: a teammate starting a build on it keeps anyone else from starting a second", async () => {
    // A teammate (another user, another session) holds the app's start lock.
    claimed.set("start-lock\napp1", -1);
    expiry.set("start-lock\napp1", clock.now + 60_000);
    fake.session = deviceA();
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(0);
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.delta).join("")).toMatch(/being started right now/);
    claimed.delete("start-lock\napp1");
  });

  it("A's start running past 70 s still keeps B from starting a second build", async () => {
    expect(START_LOCK_SECONDS).toBeGreaterThan(120); // a second list_builds and start_build, each up to 60 s
    fake.activity = [{ status: "failed", activity: [] }, { status: "failed", activity: [] }];
    fake.startDelayMs = 100;
    fake.session = deviceA();
    const a = post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] });
    await new Promise((r) => setTimeout(r, 40)); // A holds the lock and waits on start_build
    clock.now = 100_000; // 100 s into A's start: past the earlier 70 s lock
    fake.session = deviceB();
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a budgeting screen instead")] }));
    await chunks(await a);
    expect(fake.calls.filter((c) => c.name === "start_build")).toHaveLength(1);
    expect(out.find((c) => c.type === "text-delta")?.delta).toMatch(/being started right now/);
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

describe("/api/chat: what comes after the agent's answer", () => {
  const sessionTools = [
    { name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {}, mode: {}, continue_from: {} } } },
    { name: "finish_build" },
    { name: "get_build_activity", inputSchema: { type: "object", properties: { build_id: {}, text_deltas: {}, reasoning: {} } } },
  ];
  const texts = (out: Record<string, unknown>[]) => out.filter((c) => c.type === "text-delta").map((c) => c.delta as string);

  it("a session's agent has answered: the chat says it's waiting, and how the work ships", async () => {
    fake.tools = sessionTools;
    fake.activity = [{ status: "coding", phase_message: "Waiting for your next message", activity: [{ type: "turn_finished", summary: "success", seq: 5 }, { type: "message", summary: "Done", seq: 4 }], cursor: 5, first_seq: 1 }];
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(texts(out).at(-1)).toMatch(/waiting for your next message\. When you.re done, press Ship \(or type \/ship\).*With no message for 15 minutes, it ships on its own/);
    expect(out.some((c) => c.type === "data-follow")).toBe(false);
  });

  it("a one-off build's agent has handed over, or the watch ran out of time: the page is told to follow it on", async () => {
    fake.activity = [{ status: "pushing", activity: [{ type: "turn_finished", summary: "success", seq: 9 }, { type: "message", summary: "Pushed", seq: 8 }], cursor: 9, first_seq: 1 }];
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    expect(out).toContainEqual(expect.objectContaining({ type: "data-follow", data: { buildId: "new-build", after: 9 } }));
    expect(texts(out).join("\n")).not.toMatch(/open it again/);
  });

  it("a build that finishes while it's watched ends the reply with how it ended", async () => {
    fake.build = { id: "new-build", app_id: "app1", status: "failed", error: "Not production-ready: secrets_scan (1 secret(s): generic-api-key in api/.env.example)" };
    fake.activity = [{ status: "failed", phase_message: fake.build.error, activity: [], cursor: 0, first_seq: null }];
    const out = await chunks(await post({ projectId: "app1", messages: [userMessage("Build a savings goal screen")] }));
    const said = texts(out);
    expect(said).toContain("_failed: Not production-ready: secrets_scan (1 secret(s): generic-api-key in api/.env.example)_");
    expect(said.at(-1)).toMatch(/^\*\*This build didn't ship\*\*: Not production-ready: secrets_scan .*Your next message starts a new build/);
    expect(out.some((c) => c.type === "data-follow")).toBe(false);
  });
});

describe("GET /api/chat: following a build on", () => {
  it("follows a running build from the cursor the page has shown, to the end of the agent's turn in a session", async () => {
    fake.tools = [{ name: "get_build_activity", inputSchema: { type: "object", properties: { build_id: {}, text_deltas: {} } } }];
    fake.build = { id: "b1", app_id: "app1", status: "coding", mode: "session" };
    fake.activity = [
      { status: "coding", activity: [{ type: "text_delta", summary: "Adding the ", stream: "m:0", seq: 13 }], cursor: 13, first_seq: 1 },
      { status: "coding", activity: [{ type: "message", summary: "Adding the chart", stream: "m:0", seq: 14 }, { type: "turn_finished", summary: "success", seq: 15 }], cursor: 15, first_seq: 1 },
    ];
    const res = await follow("projectId=app1&buildId=b1&after=12");
    expect(res.status).toBe(200);
    const out = await chunks(res);
    expect(fake.calls.filter((c) => c.name === "get_build_activity")[0].args).toEqual({ build_id: "b1", limit: 200, after: 12, text_deltas: true });
    expect(out.filter((c) => c.type === "text-delta").map((c) => c.delta)).toContain("Adding the ");
    expect(out.filter((c) => c.type === "text-delta").at(-1)?.delta).toMatch(/waiting for your next message/);
    expect(fake.calls.some((c) => ["start_build", "steer_build"].includes(c.name))).toBe(false);
  });

  it("follows a build being verified until it finishes, then says how it ended", async () => {
    fake.build = { id: "b1", app_id: "app1", status: "verifying", mode: "session" };
    fake.activity = [
      { status: "verifying", phase_message: "Running Mynt's checks", activity: [{ type: "turn_finished", summary: "success", seq: 30 }], cursor: 30, first_seq: 1 },
      () => {
        fake.build = { id: "b1", app_id: "app1", status: "succeeded", pr_url: "https://github.com/acme/app/pull/3" };
        return { status: "succeeded", phase_message: "Verified", activity: [], cursor: 30, first_seq: 1 };
      },
    ];
    const out = await chunks(await follow("projectId=app1&buildId=b1&after=29"));
    const said = out.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
    expect(said).toEqual(["_verifying: Running Mynt's checks_", "_succeeded: Verified_", expect.stringMatching(/^\*\*Shipped\.\*\* .*pull\/3/)]);
  }, 15_000);

  it("has nothing to follow for a finished build, and refuses another app's or a missing one", async () => {
    fake.build = { id: "b1", app_id: "app1", status: "succeeded" };
    expect((await follow("projectId=app1&buildId=b1&after=3")).status).toBe(204);
    expect((await follow("projectId=other&buildId=b1")).status).toBe(404);
    fake.build = null;
    expect((await follow("projectId=app1&buildId=b1")).status).toBe(404);
    expect((await follow("projectId=app1&buildId=b1&after=-1")).status).toBe(400);
    expect((await follow("projectId=app1&buildId=b1", "https://evil.example")).status).toBe(403);
    fake.session = undefined;
    expect((await follow("projectId=app1&buildId=b1")).status).toBe(401);
    expect(fake.calls.some((c) => c.name === "get_build_activity")).toBe(false);
  });

  it("after Ship, says what shipping does and follows the shipping session to its end, not to its turn's end", async () => {
    fake.build = { id: "b1", app_id: "app1", status: "coding", mode: "session", finish_requested_at: "2026-11-22T10:00:00Z" };
    fake.activity = [
      { status: "pushing", activity: [{ type: "turn_finished", summary: "success", seq: 4 }], cursor: 4, first_seq: 1 },
      () => {
        fake.build = { id: "b1", app_id: "app1", status: "succeeded" };
        return { status: "succeeded", phase_message: "Verified", activity: [], cursor: 4, first_seq: 1 };
      },
    ];
    const out = await chunks(await follow("projectId=app1&buildId=b1&after=3&shipping=1"));
    const said = out.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
    expect(said[0]).toMatch(/^_Shipping: the agent wraps up its current request/);
    expect(said.at(-1)).toMatch(/^\*\*Shipped\.\*\*/);
    // The page hears how the build's status moves (Ship goes, the cap comes back).
    expect(out.filter((c) => c.type === "data-state").map((c) => (c.data as { status: string }).status)).toEqual(["pushing", "succeeded", "succeeded"]);
    expect(out.find((c) => c.type === "data-state")?.data).toEqual({ buildId: "b1", status: "pushing", after: 4, session: true, finishing: true });
  }, 15_000);
});

describe("/api/chat: Ship, the cap, and messages held during verification", () => {
  const sessionTools = [
    { name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {}, mode: {}, continue_from: {} } } },
    { name: "finish_build" },
  ];

  it("starts a build with the cap the developer picked", async () => {
    fake.activity = [{ status: "queued", activity: [], cursor: 0, first_seq: null }, { status: "failed", activity: [], cursor: 0, first_seq: null }];
    await chunks(await post({ projectId: "app1", capUsd: 6.5, messages: [userMessage("Build a savings goal screen")] }));
    expect(fake.calls.find((c) => c.name === "start_build")?.args).toEqual({ goal: "Build a savings goal screen", app_id: "app1", cap_usd: 6.5 });
    // A cap that isn't a whole number of cents, or isn't positive, is refused before anything starts.
    expect((await post({ projectId: "app1", capUsd: -1, messages: [userMessage("Build a savings goal screen")] })).status).toBe(400);
  }, 15_000);

  it("holds a message sent while the app's build is verified: nothing is sent or started, the page keeps it, and the chat follows verification", async () => {
    fake.tools = sessionTools;
    fake.builds = [{ id: "v", app_id: "app1", status: "verifying", mode: "session", finish_requested_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22" }];
    fake.build = { id: "v", app_id: "app1", status: "failed", error: "Not production-ready: tests" };
    fake.activity = [
      { status: "verifying", activity: [{ type: "turn_finished", summary: "success", seq: 12 }], cursor: 12, first_seq: 1 },
      { status: "verifying", phase_message: "Running Mynt's checks", activity: [], cursor: 12, first_seq: 1 },
      { status: "failed", phase_message: "Not production-ready: tests", activity: [], cursor: 12, first_seq: 1 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "v", messages: [userMessage("Add a statements page")] }));
    expect(fake.calls.some((c) => ["start_build", "steer_build", "finish_build"].includes(c.name))).toBe(false);
    const said = out.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
    expect(said[0]).toBe("Queued — sent when verification finishes.");
    expect(out.find((c) => c.type === "data-hold")?.data).toEqual({ buildId: "v", text: "Add a statements page", after: 12 });
    // Followed to verification's end, from where the message was held; the page then sends it.
    expect(fake.calls.filter((c) => c.name === "get_build_activity")[1].args).toMatchObject({ after: 12 });
    expect(said).toContain("_failed: Not production-ready: tests_");
    expect(out.filter((c) => c.type === "data-state").at(-1)?.data).toMatchObject({ buildId: "v", status: "failed" });
  }, 15_000);

  it("holds a message for a session that's shipping, too", async () => {
    fake.tools = sessionTools;
    fake.builds = [{ id: "live", app_id: "app1", status: "pushing", mode: "session", finish_requested_at: "2026-11-22T10:00:00Z", updated_at: "2026-11-22" }];
    fake.activity = [{ status: "pushing", activity: [], cursor: 3, first_seq: 1 }, { status: "stopped", activity: [], cursor: 3, first_seq: 1 }];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("Make it green")] }));
    expect(fake.calls.some((c) => c.name === "steer_build")).toBe(false);
    expect(out.find((c) => c.type === "data-hold")?.data).toMatchObject({ buildId: "live", text: "Make it green" });
  }, 15_000);

  it("a session's answer while Ship was pressed meanwhile: no waiting note, the page follows it on", async () => {
    fake.tools = sessionTools;
    fake.builds = [{ id: "live", app_id: "app1", status: "coding", mode: "session", updated_at: "2026-11-22" }];
    fake.build = { id: "live", app_id: "app1", status: "coding", mode: "session", finish_requested_at: "2026-11-22T10:00:00Z" };
    fake.activity = [
      { status: "coding", activity: [{ type: "tool_use", summary: 'Bash {"command":"npm test"}', seq: 7 }], cursor: 7, first_seq: 1 },
      { status: "coding", activity: [{ type: "turn_finished", summary: "interrupted", seq: 8 }, { type: "message", summary: "Done", seq: 9 }, { type: "turn_finished", summary: "success", seq: 10 }], cursor: 10, first_seq: 1 },
    ];
    const out = await chunks(await post({ projectId: "app1", conversationId: "live", messages: [userMessage("Make it green")] }));
    const said = out.filter((c) => c.type === "text-delta").map((c) => c.delta as string);
    expect(said.join("\n")).not.toMatch(/waiting for your next message/);
    expect(out).toContainEqual(expect.objectContaining({ type: "data-follow", data: { buildId: "live", after: 10 } }));
  }, 15_000);
});
