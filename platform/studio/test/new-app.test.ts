import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";

// New app: create_app on the picked products, then the first build, then the workspace.

const fake = {
  session: undefined as Session | undefined,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  tools: [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {} } } }] as { name: string; inputSchema?: unknown }[],
  createFails: false,
  startFails: false,
};
const claimed = new Set<string>();

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));

vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({
    save: async () => true,
    wasTouched: () => false,
    claim: async (name: string, subject: string) => {
      const k = `${name}\n${subject}`;
      if (claimed.has(k)) return null;
      claimed.add(k);
      return async () => void claimed.delete(k);
    },
  }),
}));

vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      const refused = (error: string) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] });
      if (name === "whoami") return ok({ id: "u1", name: "Ines", email: "ines@example.com", effective_roles: ["developer"] });
      if (name === "create_app") return fake.createFails ? refused("Products not available: p9") : ok({ id: "app-1", name: args.name });
      if (name === "start_build") return fake.startFails ? refused("Monthly build budget used up (US$100.00 of US$100 spent this month)") : ok({ id: "build-1", status: "queued" });
      return refused(`unexpected ${name}`);
    },
    close: async () => undefined,
  }),
}));

const { POST } = await import("@/app/api/apps/route");
const { appFieldsFromPrompt, submitNewApp } = await import("@/lib/new-app");

const post = (body: unknown, origin = "http://localhost:3000") =>
  POST(new Request("http://localhost:3000/api/apps", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
const prompt = "A savings app that rounds up card purchases. It moves the change into a high-yield account.";

beforeEach(() => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" } } as Session;
  fake.calls = [];
  fake.tools = [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {} } } }];
  fake.createFails = false;
  fake.startFails = false;
  claimed.clear();
});

describe("app fields from the prompt", () => {
  it("names the app by its first sentence and keeps the whole prompt as its description", () => {
    expect(appFieldsFromPrompt(prompt)).toEqual({
      name: "A savings app that rounds up card purchases",
      description: prompt,
      audience: "As described in the app's description",
    });
    expect(appFieldsFromPrompt("x".repeat(100)).name.length).toBeLessThanOrEqual(61);
  });
});

describe("/api/apps", () => {
  it("creates the app on the picked products, then starts its first build", async () => {
    const res = await post({ prompt, product_ids: ["p1", "p2"] });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ appId: "app-1", buildId: "build-1" });
    const names = fake.calls.map((c) => c.name);
    expect(names.indexOf("create_app")).toBeLessThan(names.indexOf("start_build"));
    expect(fake.calls.find((c) => c.name === "create_app")?.args).toMatchObject({ product_ids: ["p1", "p2"], description: prompt });
    expect(fake.calls.find((c) => c.name === "start_build")?.args).toEqual({ goal: prompt, app_id: "app-1" });
  });

  it("starts a session build where Mynt offers them", async () => {
    fake.tools = [{ name: "start_build", inputSchema: { type: "object", properties: { goal: {}, app_id: {}, mode: {}, continue_from: {} } } }, { name: "finish_build" }];
    await post({ prompt, product_ids: ["p1"] });
    expect(fake.calls.find((c) => c.name === "start_build")?.args).toEqual({ goal: prompt, app_id: "app-1", mode: "session" });
  });

  it("still opens the app when its first build couldn't start, saying why", async () => {
    fake.startFails = true;
    const res = await post({ prompt, product_ids: ["p1"] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ appId: "app-1", buildId: null });
    expect(body.message).toMatch(/Monthly build budget used up/);
  });

  it("passes on Mynt's refusal to create the app, and lets the user try again", async () => {
    fake.createFails = true;
    const res = await post({ prompt, product_ids: ["p9"] });
    expect(res.status).toBe(422);
    expect((await res.json()).message).toBe("Products not available: p9");
    fake.createFails = false;
    expect((await post({ prompt, product_ids: ["p9"] })).status).toBe(201);
  });

  it("creates one app for a double submit", async () => {
    await post({ prompt, product_ids: ["p1"] });
    const again = await post({ prompt, product_ids: ["p1"] });
    expect(again.status).toBe(409);
    expect(fake.calls.filter((c) => c.name === "create_app")).toHaveLength(1);
  });

  it("refuses bad input, other origins and the signed-out", async () => {
    expect((await post({ prompt: "short", product_ids: ["p1"] })).status).toBe(400);
    expect((await post({ prompt, product_ids: [] })).status).toBe(400);
    expect((await post({ prompt, product_ids: ["p1"], extra: 1 })).status).toBe(400);
    expect((await post({ prompt, product_ids: ["p1"] }, "https://evil.example.com")).status).toBe(403);
    fake.session = undefined;
    expect((await post({ prompt, product_ids: ["p1"] })).status).toBe(401);
    expect(fake.calls.some((c) => c.name === "create_app")).toBe(false);
  });
});

describe("the New app page's submit", () => {
  const respond = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("opens the new app's workspace on its first build", async () => {
    const went: string[] = [];
    const err = await submitNewApp({ prompt, product_ids: ["p1"] }, { fetch: respond(201, { appId: "app-1", buildId: "build-1" }), navigate: (p) => went.push(p) });
    expect(err).toBeNull();
    expect(went).toEqual(["/app-1/build-1"]);
  });

  it("opens the app itself when there's no build yet", async () => {
    const went: string[] = [];
    await submitNewApp({ prompt, product_ids: ["p1"] }, { fetch: respond(201, { appId: "app-1", buildId: null }), navigate: (p) => went.push(p) });
    expect(went).toEqual(["/app-1"]);
  });

  it("stays on the page with Mynt's message when it fails", async () => {
    const went: string[] = [];
    const err = await submitNewApp({ prompt, product_ids: ["p9"] }, { fetch: respond(422, { message: "Products not available: p9" }), navigate: (p) => went.push(p) });
    expect(err).toBe("Products not available: p9");
    expect(went).toEqual([]);
  });
});
