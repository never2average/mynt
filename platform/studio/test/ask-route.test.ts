import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ASK_TOOLS, askToolDefs, historyFrom, isAskTool, runAsk } from "@/lib/ask";
import { STUDIO_TOOLS } from "@/lib/studio-tools";

// A fake Mynt, a fake model and a fake sign-in.
type Step = { text?: string; tool?: { name: string; input: Record<string, unknown> }; stop?: string };
const fake = {
  session: undefined as Session | undefined,
  configured: true,
  steps: [] as Step[],
  requests: [] as { tools: { name: string }[]; messages: unknown[]; system: unknown }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
  logged: [] as string[],
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => {
    const o = req.headers.get("origin");
    return o === null || o === "http://localhost:3000";
  },
  setSessionCookie: () => undefined,
}));

vi.mock("@/lib/session-store", () => {
  const held = new Set<string>();
  return {
    sessionStore: () => ({
      save: async () => true,
      wasTouched: () => false,
      claim: async (name: string, subject: string) => {
        const key = `${name}\n${subject}`;
        if (held.has(key)) return null;
        held.add(key);
        return async () => void held.delete(key);
      },
    }),
  };
});

// Every tool Mynt offers this user, writes included: Ask AI must only ever offer the reads.
const ALL_TOOLS = Object.keys(STUDIO_TOOLS).map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } }));

vi.mock("@/lib/mynt-client", () => {
  class NotSignedInError extends Error {}
  class NotAllowedError extends Error {}
  return {
    NotSignedInError,
    NotAllowedError,
    connectMynt: async () => ({ listTools: async () => ({ tools: ALL_TOOLS }), close: async () => undefined }),
    callMyntTool: async (_c: unknown, name: string, args: Record<string, unknown>) => {
      fake.calls.push({ name, args });
      if (name === "whoami") return { isError: false, text: JSON.stringify({ id: "u1", effective_roles: ["developer"] }) };
      if (name === "list_my_apps") return { isError: false, text: JSON.stringify({ apps: [{ id: "a1", name: "Round-up savings" }] }) };
      return { isError: true, text: JSON.stringify({ error: `unexpected ${name}` }) };
    },
  };
});

function fakeLlm() {
  return {
    stream: (params: { tools: { name: string }[]; messages: unknown[]; system: unknown }) => {
      fake.requests.push({ tools: params.tools, messages: structuredClone(params.messages), system: params.system });
      const step = fake.steps.shift() ?? { text: "Done." };
      const listeners: ((d: string) => void)[] = [];
      return {
        on: (_e: "text", cb: (d: string) => void) => listeners.push(cb),
        finalMessage: async () => {
          if (step.text) for (const l of listeners) l(step.text);
          const content: unknown[] = [];
          if (step.text) content.push({ type: "text", text: step.text });
          if (step.tool) content.push({ type: "tool_use", id: `call-${fake.requests.length}`, name: step.tool.name, input: step.tool.input });
          return { content, stop_reason: step.stop ?? (step.tool ? "tool_use" : "end_turn") };
        },
      };
    },
  };
}

vi.mock("@/lib/llm", () => ({
  askConfigured: () => fake.configured,
  askModel: () => "claude-opus-5-5",
  createLlm: () => fakeLlm(),
}));

const { GET, POST } = await import("@/app/api/ask/route");

const question = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
const post = (body: unknown, origin = "http://localhost:3000") =>
  POST(new Request("http://localhost:3000/api/ask", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));

async function chunks(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "user-token", token_type: "Bearer" } } as Session;
  fake.configured = true;
  fake.steps = [];
  fake.requests = [];
  fake.calls = [];
  fake.logged = [];
  vi.spyOn(console, "error").mockImplementation((...args) => void fake.logged.push(args.join(" ")));
  vi.spyOn(console, "log").mockImplementation((...args) => void fake.logged.push(args.join(" ")));
});

describe("/api/ask", () => {
  it("refuses unauthenticated calls, both the status check and questions", async () => {
    fake.session = undefined;
    expect((await GET()).status).toBe(401);
    expect((await post({ messages: [question("Which apps do I have?")] })).status).toBe(401);
    fake.session = { id: "s", createdAt: 0, lastSeen: 0 } as Session; // a session that never signed in
    expect((await post({ messages: [question("Which apps do I have?")] })).status).toBe(401);
    expect(fake.calls).toEqual([]);
    expect(fake.requests).toEqual([]);
  });

  it("refuses questions from another origin", async () => {
    expect((await post({ messages: [question("hi")] }, "https://evil.example")).status).toBe(403);
    expect(fake.requests).toEqual([]);
  });

  it("says when no model is configured (503), and the status check says it's off", async () => {
    fake.configured = false;
    expect(await (await GET()).json()).toEqual({ enabled: false });
    const res = await post({ messages: [question("hi")] });
    expect(res.status).toBe(503);
    expect((await res.json()).message).toBe("AI is not configured.");
    expect(fake.requests).toEqual([]);
  });

  it("offers the model only read tools, though Mynt lists writes too", async () => {
    fake.steps = [{ text: "You have no apps yet." }];
    const res = await post({ messages: [question("Which apps do I have?")] });
    expect(res.status).toBe(200);
    await chunks(res);
    const offered = fake.requests[0].tools.map((t) => t.name).sort();
    expect(offered).toEqual([...ASK_TOOLS].sort());
    for (const write of ["create_app", "start_build", "steer_build", "invite_to_workspace", "remove_workspace_member", "accept_workspace_invite", "rename_workspace", "leave_workspace"])
      expect(offered).not.toContain(write);
  });

  it("streams the answer, reading through Mynt as the user", async () => {
    fake.steps = [{ text: "Let me look.", tool: { name: "list_my_apps", input: {} } }, { text: "You have one app: Round-up savings." }];
    const res = await post({ messages: [question("Which apps do I have?")] });
    const parts = await chunks(res);
    const text = parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");
    expect(text).toBe("Let me look.You have one app: Round-up savings.");
    expect(parts.some((p) => p.type === "tool-input-available" && p.toolName === "list_my_apps")).toBe(true);
    // The browser sees that a read ran, not Mynt's reply.
    expect(JSON.stringify(parts)).not.toContain('"apps"');
    expect(fake.calls.map((c) => c.name)).toContain("list_my_apps");
    // The model saw Mynt's reply.
    expect(JSON.stringify(fake.requests[1].messages)).toContain("Round-up savings");
  });

  it("never runs a write the model asks for", async () => {
    fake.steps = [{ tool: { name: "create_app", input: { name: "x", description: "x", audience: "x", product_ids: ["p"] } } }, { text: "I can't create apps." }];
    const parts = await chunks(await post({ messages: [question("Make me an app")] }));
    expect(fake.calls.map((c) => c.name)).not.toContain("create_app");
    expect(JSON.stringify(fake.requests[1].messages)).toContain("can only read");
    expect(parts.some((p) => p.type === "tool-output-available" && (p.output as { ok?: boolean }).ok === false)).toBe(true);
  });

  it("never logs what was asked or answered", async () => {
    fake.steps = [{ text: "secret-answer-text" }];
    await chunks(await post({ messages: [question("secret-question-text")] }));
    expect(fake.logged.join("\n")).not.toMatch(/secret-(question|answer)-text/);
  });

  it("refuses a body with no question", async () => {
    expect((await post({ messages: [{ role: "assistant", parts: [{ type: "text", text: "hi" }] }] })).status).toBe(400);
  });
});

describe("Ask AI's tools", () => {
  it("are all studio tools, and none of them writes", () => {
    for (const t of ASK_TOOLS) expect(Object.prototype.hasOwnProperty.call(STUDIO_TOOLS, t)).toBe(true);
    for (const t of ASK_TOOLS) expect(t).toMatch(/^(whoami|list_|get_|hosting_status|app_status)/);
    const writes = Object.keys(STUDIO_TOOLS).filter((t) => /^(create|rename|invite|revoke|change|remove|leave|accept|decline|start|steer)_/.test(t));
    expect(writes.length).toBeGreaterThan(5);
    for (const w of writes) expect(isAskTool(w)).toBe(false);
    expect(askToolDefs(ALL_TOOLS).map((t) => t.name).sort()).toEqual([...ASK_TOOLS].sort());
  });

  it("take the conversation as text, ending with the user's question", () => {
    expect(historyFrom([question("a"), { role: "assistant", parts: [{ type: "text", text: "b" }, { type: "tool-x" }] }, question("c")])).toEqual([
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]);
    expect(historyFrom([{ role: "assistant", parts: [{ type: "text", text: "b" }] }])).toBeNull();
  });

  it("stop at the step limit", async () => {
    const events: string[] = [];
    const llm = { stream: () => ({ on: () => undefined, finalMessage: async () => ({ content: [{ type: "tool_use", id: "c", name: "whoami", input: {} }], stop_reason: "tool_use" }) }) };
    await runAsk([{ role: "user", content: "loop" }], {
      llm: llm as never,
      model: "m",
      tools: [],
      workspaceId: null,
      callTool: async () => ({ text: "{}", isError: false }),
      emit: (e) => void (e.type === "text" && events.push(e.delta)),
    });
    expect(events.join("")).toContain("too many steps");
  });
});
