import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { ASK_TOOLS, askToolDefs, historyFrom, isAskTool, mapLimited, MAX_CALLS_PER_QUESTION, MAX_CALLS_PER_STEP, MAX_OUTPUT_TOKENS, MAX_TOOL_RESULT, OVER_CAP, runAsk } from "@/lib/ask";
import { STUDIO_TOOLS } from "@/lib/studio-tools";

// A fake Mynt, a fake model and a fake sign-in.
type Step = { text?: string; tool?: { name: string; input: Record<string, unknown> }; stop?: string };
const fake = {
  session: undefined as Session | undefined,
  configured: true,
  steps: [] as Step[],
  requests: [] as { tools: { name: string }[]; messages: unknown[]; system: unknown; max_tokens?: number }[],
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

const counts = new Map<string, number>();
vi.mock("@/lib/session-store", () => {
  const held = new Set<string>();
  return {
    sessionStore: () => ({
      save: async () => true,
      wasTouched: () => false,
      count: async (name: string, subject: string, windowSeconds: number) => {
        const key = `${name}\n${subject}\n${windowSeconds}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key)!;
      },
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
    stream: (params: { tools: { name: string }[]; messages: unknown[]; system: unknown; max_tokens?: number }) => {
      fake.requests.push({ tools: params.tools, messages: structuredClone(params.messages), system: params.system, max_tokens: params.max_tokens });
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

const { GET, POST, ASK_PER_HOUR, MAX_BODY_BYTES } = await import("@/app/api/ask/route");

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
  counts.clear();
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
    for (const t of ASK_TOOLS) expect(t).toMatch(/^(whoami|list_|get_)/);
    // Reads that reach a VM or the hosting provider are left out too.
    for (const t of ["app_status", "hosting_status", "app_logs", "sandbox_files", "sandbox_diff", "get_build_activity"]) expect(isAskTool(t)).toBe(false);
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

// A model whose every step asks for `perStep` reads (of whoami), then answers once they're refused.
function greedyLlm(perStep: number, steps: number) {
  const seen: unknown[][] = [];
  let i = 0;
  return {
    seen,
    llm: {
      stream: (params: { messages: unknown[] }) => {
        seen.push(structuredClone(params.messages));
        const step = i++;
        return {
          on: () => undefined,
          finalMessage: async () =>
            step < steps
              ? { content: Array.from({ length: perStep }, (_, k) => ({ type: "tool_use", id: `s${step}c${k}`, name: "whoami", input: {} })), stop_reason: "tool_use" }
              : { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
        };
      },
    },
  };
}

describe("Ask AI's limits", () => {
  it(`runs at most ${MAX_CALLS_PER_STEP} reads per step, a few at a time, and refuses the rest`, async () => {
    const { llm, seen } = greedyLlm(200, 1);
    let calls = 0;
    let running = 0;
    let most = 0;
    await runAsk([{ role: "user", content: "hi" }], {
      llm: llm as never,
      model: "m",
      tools: [],
      workspaceId: null,
      callTool: async () => {
        calls++;
        most = Math.max(most, ++running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return { text: "{}", isError: false };
      },
      emit: () => undefined,
    });
    expect(calls).toBe(MAX_CALLS_PER_STEP);
    expect(most).toBeLessThanOrEqual(4);
    // Every call gets a result; those over the cap say why.
    const results = (seen[1].at(-1) as { content: { is_error?: boolean; content: string }[] }).content;
    expect(results).toHaveLength(200);
    expect(results.filter((r) => r.content === OVER_CAP && r.is_error)).toHaveLength(200 - MAX_CALLS_PER_STEP);
  });

  it(`runs at most ${MAX_CALLS_PER_QUESTION} reads per question`, async () => {
    const { llm } = greedyLlm(MAX_CALLS_PER_STEP, 6);
    let calls = 0;
    await runAsk([{ role: "user", content: "hi" }], {
      llm: llm as never,
      model: "m",
      tools: [],
      workspaceId: null,
      callTool: async () => (calls++, { text: "{}", isError: false }),
      emit: () => undefined,
    });
    expect(calls).toBe(MAX_CALLS_PER_QUESTION);
  });

  it("keeps order with limited concurrency", async () => {
    expect(await mapLimited([5, 1, 3, 2], 2, async (n) => (await new Promise((r) => setTimeout(r, n)), n * 10))).toEqual([50, 10, 30, 20]);
  });

  it("asks for few output tokens per step, and cuts Mynt's long replies short", async () => {
    const long = "x".repeat(MAX_TOOL_RESULT * 3);
    let fed = "";
    await runAsk([{ role: "user", content: "hi" }], {
      llm: {
        stream: (p: { max_tokens: number; messages: unknown[] }) => {
          expect(p.max_tokens).toBe(MAX_OUTPUT_TOKENS);
          const first = p.messages.length === 1;
          if (!first) fed = JSON.stringify(p.messages.at(-1));
          return {
            on: () => undefined,
            finalMessage: async () =>
              first ? { content: [{ type: "tool_use", id: "c", name: "list_my_apps", input: {} }], stop_reason: "tool_use" } : { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" },
          };
        },
      } as never,
      model: "m",
      tools: [],
      workspaceId: null,
      callTool: async () => ({ text: long, isError: false }),
      emit: () => undefined,
    });
    expect(MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(4000);
    expect(MAX_TOOL_RESULT).toBeLessThanOrEqual(8000);
    expect(fed.length).toBeLessThan(MAX_TOOL_RESULT + 500);
    expect(fed).toContain("cut short");
  });

  it("the route asks the model for few output tokens", async () => {
    fake.steps = [{ text: "hi" }];
    await chunks(await post({ messages: [question("hi")] }));
    expect(fake.requests[0].max_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it("refuses a body over 64 KB with 413, by its declared length or by what's sent", async () => {
    const big = JSON.stringify({ messages: [question("x".repeat(MAX_BODY_BYTES))] });
    expect((await post(JSON.parse(big))).status).toBe(413);
    // No content-length (a stream): refused once it passes the limit.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < 20; i++) c.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)));
        c.close();
      },
    });
    const res = await POST(new Request("http://localhost:3000/api/ask", { method: "POST", headers: { origin: "http://localhost:3000" }, body, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    // A declared length over the limit is refused before reading.
    const declared = await POST(new Request("http://localhost:3000/api/ask", { method: "POST", headers: { origin: "http://localhost:3000", "content-length": String(MAX_BODY_BYTES + 1) }, body: "{}" }));
    expect(declared.status).toBe(413);
    expect(fake.requests).toEqual([]);
  });

  it(`answers ${ASK_PER_HOUR} questions an hour per user, then a polite 429`, async () => {
    for (let i = 0; i < ASK_PER_HOUR; i++) {
      fake.steps = [{ text: "ok" }];
      const res = await post({ messages: [question(`q${i}`)] });
      expect(res.status).toBe(200);
      await chunks(res);
    }
    const res = await post({ messages: [question("one more")] });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("3600");
    expect((await res.json()).message).toMatch(/questions in the last hour/);
    expect(fake.requests).toHaveLength(ASK_PER_HOUR);
  });
});
