import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// The /api/developer/tools route, with Mynt and the cookie session faked: it calls tools as the
// signed-in user, refuses non-developers, and passes credentials through without keeping them.

const fake = vi.hoisted(() => {
  const state = {
    session: undefined as Session | undefined,
    whoami: { id: "u1", roles: ["developer"], effective_roles: ["consumer", "developer"] } as unknown,
    replies: new Map<string, { isError: boolean; text: string }>(),
    calls: [] as { name: string; args: Record<string, unknown> }[],
    connectError: undefined as Error | undefined,
  };
  return state;
});

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => {
    const origin = req.headers.get("origin");
    return origin === null || origin === "http://localhost:3000";
  },
}));

vi.mock("@/lib/mynt", () => {
  class NotSignedInError extends Error {}
  class NotAllowedError extends Error {}
  return {
    NotSignedInError,
    NotAllowedError,
    connectMynt: async () => {
      if (fake.connectError) throw fake.connectError;
      return { close: async () => undefined };
    },
    callMyntTool: async (_client: unknown, name: string, args: Record<string, unknown>) => {
      fake.calls.push({ name, args });
      if (name === "whoami") return { isError: false, text: JSON.stringify(fake.whoami) };
      return fake.replies.get(name) ?? { isError: true, text: JSON.stringify({ error: `Tool ${name} not found` }) };
    },
  };
});

const { POST } = await import("@/app/api/developer/tools/route");

function session(): Session {
  return { id: "s".repeat(43), createdAt: 0, lastSeen: 0, tokens: { access_token: "at", token_type: "Bearer" }, history: [], transcript: [], accepted: [], sentRequests: [], pendingEvents: [] };
}

function post(body: unknown, origin: string | null = "http://localhost:3000") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (origin) headers.origin = origin;
  return POST(new Request("http://localhost:3000/api/developer/tools", { method: "POST", headers, body: JSON.stringify(body) }) as never);
}

const PASSWORD = "pw-7f3a9c-very-secret";
const SSH = "ssh -p 2222 -i <(echo key-material-xyz) developer@vm.example.com";

beforeEach(() => {
  fake.session = session();
  fake.whoami = { id: "u1", roles: ["developer"], effective_roles: ["consumer", "developer"] };
  fake.replies.clear();
  fake.calls.length = 0;
  fake.connectError = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/developer/tools", () => {
  it("calls the tool as the signed-in developer and returns Mynt's reply", async () => {
    fake.replies.set("list_builds", { isError: false, text: JSON.stringify({ builds: [{ id: "b1" }] }) });
    const res = await post({ tool: "list_builds", args: {} });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { builds: [{ id: "b1" }] } });
    expect(fake.calls.map((c) => c.name)).toEqual(["whoami", "list_builds"]);
    expect(fake.session!.roles).toEqual(["consumer", "developer"]);
  });

  it("passes the editor password and SSH login through without keeping or logging them", async () => {
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    fake.replies.set("open_sandbox_editor", { isError: false, text: JSON.stringify({ url: "https://box.example.com/", password: PASSWORD }) });
    fake.replies.set("vm_access", { isError: false, text: JSON.stringify({ logins: [{ app_id: "a1", ssh: SSH }], expires_at: "2026-10-31T18:00:00Z", user: "developer", note: "n" }) });

    const editor = await post({ tool: "open_sandbox_editor", args: { build_id: "b1" } });
    expect(editor.headers.get("cache-control")).toBe("no-store");
    expect((await editor.json()).data.password).toBe(PASSWORD);

    const vm = await post({ tool: "vm_access", args: { hours: 8 } });
    expect(vm.headers.get("cache-control")).toBe("no-store");
    expect((await vm.json()).data.logins[0].ssh).toBe(SSH);

    const kept = JSON.stringify(fake.session);
    expect(kept).not.toContain(PASSWORD);
    expect(kept).not.toContain("key-material-xyz");
    for (const spy of logs) expect(spy).not.toHaveBeenCalled();
  });

  it("doesn't log arguments or replies when a call fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fake.connectError = new Error(`connection reset while sending ${PASSWORD}`);
    const res = await post({ tool: "sandbox_run", args: { build_id: "b1", command: `echo ${PASSWORD}` } });
    expect(res.status).toBe(502);
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain(PASSWORD);
  });

  it("refuses users whose Mynt roles don't include developer", async () => {
    fake.whoami = { id: "u2", roles: ["consumer"], effective_roles: ["consumer"] };
    const res = await post({ tool: "list_builds" });
    expect(res.status).toBe(403);
    expect(fake.calls.map((c) => c.name)).toEqual(["whoami"]);
  });

  it("refuses tools outside the console's list, bad arguments, other origins and signed-out sessions", async () => {
    expect((await post({ tool: "start_build", args: { goal: "build everything now" } })).status).toBe(400);
    expect((await post({ tool: "sandbox_run", args: { build_id: "b1" } })).status).toBe(400);
    expect((await post({ tool: "list_builds" }, "https://evil.example.com")).status).toBe(403);
    fake.session = undefined;
    expect((await post({ tool: "list_builds" })).status).toBe(401);
    expect(fake.calls).toEqual([]);
  });

  it("returns Mynt's refusal as a 422 with its message", async () => {
    fake.replies.set("stop_build", { isError: true, text: JSON.stringify({ error: "No build of yours with id 'b9'" }) });
    const res = await post({ tool: "stop_build", args: { build_id: "b9" } });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, data: { error: "No build of yours with id 'b9'" } });
  });
});
