import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { EARN_TOOLS, PANEL_TOOLS, validateDraft } from "@/lib/earn";
import { fromPools, fromPositions } from "@/lib/liquidity";
import { STUDIO_TOOLS } from "@/lib/studio-tools";

// Earn's assistant route: the Ask AI stack with Earn's reads and panel tools. A fake Mynt, a fake
// model and a fake sign-in.

const POOL = "11111111-1111-4111-8111-111111111111";
const UNCLEARED = "11111111-1111-4111-8111-111111111112";
const pool = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  product_id: "their-product",
  component_key: "lending",
  sponsor_entity_id: "22222222-2222-4222-8222-222222222222",
  name: `Pool ${id.slice(-1)}`,
  sandbox: false,
  status: "open",
  min_reserve_bps: 2000,
  min_reserve_floor_cents: 0,
  notice_period_days: 90,
  min_commitment_cents: 100_000,
  max_commitment_cents: 10_000_000,
  deposit_rail_id: "33333333-3333-4333-8333-333333333333",
  withdrawal_rail_id: "44444444-4444-4444-8444-444444444444",
  approved_at: "2026-11-01T00:00:00Z",
  offering_cleared: true,
  ...over,
});
const POOLS = [pool(POOL), pool(UNCLEARED, { offering_cleared: false })];
const POSITIONS = [{ pool_id: POOL, name: "Pool 1", product_id: "their-product", sandbox: false, state: "us-ny", contributed_cents: 500_000, balance_cents: 500_000, available_to_withdraw_cents: 200_000 }];

type Step = { text?: string; tool?: { name: string; input: Record<string, unknown> } };
const fake = {
  session: undefined as Session | undefined,
  steps: [] as Step[],
  requests: [] as { tools: { name: string }[]; system: { text: string }[]; messages: unknown[] }[],
  calls: [] as { name: string; args: Record<string, unknown> }[],
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
const counts = new Map<string, number>();
vi.mock("@/lib/session-store", () => ({
  sessionStore: () => ({
    save: async () => true,
    wasTouched: () => false,
    count: async (name: string) => {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      return counts.get(name)!;
    },
    claim: async () => async () => undefined,
  }),
}));
// Every studio tool, writes included: the assistant must be offered only Earn's reads.
const ALL_TOOLS = Object.keys(STUDIO_TOOLS).map((name) => ({ name, description: `${name} tool`, inputSchema: { type: "object", properties: {} } }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: ALL_TOOLS }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (d: unknown) => ({ content: [{ type: "text", text: JSON.stringify(d) }] });
      if (name === "list_pools") return ok(POOLS);
      if (name === "list_my_positions") return ok(POSITIONS);
      return ok([]);
    },
    close: async () => undefined,
  }),
}));
vi.mock("@/lib/llm", () => ({
  askConfigured: () => true,
  askModel: () => "claude-opus-5-5",
  createLlm: () => ({
    stream: (params: { tools: { name: string }[]; system: { text: string }[]; messages: unknown[] }) => {
      fake.requests.push({ tools: params.tools, system: params.system, messages: structuredClone(params.messages) });
      const step = fake.steps.shift() ?? { text: "Done." };
      const listeners: ((d: string) => void)[] = [];
      return {
        on: (_e: string, cb: (d: string) => void) => listeners.push(cb),
        finalMessage: async () => {
          if (step.text) for (const l of listeners) l(step.text);
          const content: unknown[] = [];
          if (step.text) content.push({ type: "text", text: step.text });
          if (step.tool) content.push({ type: "tool_use", id: `call-${fake.requests.length}`, name: step.tool.name, input: step.tool.input });
          return { content, stop_reason: step.tool ? "tool_use" : "end_turn" };
        },
      };
    },
  }),
}));

const { POST, GET } = await import("@/app/api/earn/route");

const as = (...roles: string[]) => {
  fake.session = { id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() } as Session;
};
const ask = (text: string, origin = "http://localhost:3000") =>
  POST(new Request("http://localhost:3000/api/earn", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", parts: [{ type: "text", text }] }] }) }));
async function chunks(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text())
    .split("\n")
    .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
    .map((l) => JSON.parse(l.slice(6)));
}
const WRITES = Object.keys(STUDIO_TOOLS).filter((t) => !EARN_TOOLS.includes(t as never));

beforeEach(() => {
  as("liquidity_provider");
  fake.steps = [];
  fake.requests = [];
  fake.calls = [];
  counts.clear();
});

describe("/api/earn", () => {
  it("offers the model Earn's reads and its panel tools only: no write tool, and none of Mynt's other tools", async () => {
    const res = await ask("$50k, 90-day lock-in, US credit");
    await chunks(res);
    const offered = fake.requests[0].tools.map((t) => t.name).sort();
    expect(offered).toEqual([...EARN_TOOLS, ...PANEL_TOOLS].sort());
    for (const w of ["commit_to_pool", "request_withdrawal", "create_pool", "cancel_withdrawal", "start_build", "create_app"]) expect(offered).not.toContain(w);
    expect(WRITES).toEqual(expect.arrayContaining(["commit_to_pool", "request_withdrawal", "create_pool"]));
    expect(fake.requests[0].system[0].text).toContain("You don't give investment advice");
    expect(fake.requests[0].system[1].text).toContain("liquidity provider");
  });

  it("refuses a write the model asks for anyway, without calling Mynt", async () => {
    fake.steps = [{ tool: { name: "commit_to_pool", input: { pool_id: POOL, amount_cents: 500_000, state: "us-ny", idempotency_key: "k-12345678" } } }, { text: "I can't." }];
    await chunks(await ask("commit $5,000 now"));
    expect(fake.calls.map((c) => c.name)).not.toContain("commit_to_pool");
    expect(JSON.stringify(fake.requests[1].messages)).toContain("isn't available to this assistant: it can only read");
  });

  it("a draft commitment is checked against the pool's current terms and only drawn as a card: nothing is committed", async () => {
    fake.steps = [{ tool: { name: "draft_commitment", input: { pool_id: POOL, amount_cents: 5_000_000, state: "US-NY" } } }, { text: "The draft is in the panel." }];
    const parts = await chunks(await ask("Draft $50,000 into Pool 1 from New York"));
    const draft = parts.find((p) => p.type === "data-earn-draft");
    expect(draft?.data).toMatchObject({ kind: "commit", poolId: POOL, amountCents: 5_000_000, state: "us-ny", sandbox: false });
    expect(fake.calls.map((c) => c.name)).not.toContain("commit_to_pool");
    expect(fake.calls.map((c) => c.name)).toEqual(expect.arrayContaining(["list_pools", "list_my_positions"]));
  });

  it("an invalid draft draws nothing and tells the model why", async () => {
    fake.steps = [{ tool: { name: "draft_commitment", input: { pool_id: UNCLEARED, amount_cents: 500_000, state: "us-ny" } } }, { text: "ok" }];
    const parts = await chunks(await ask("put $5,000 in the uncleared pool"));
    expect(parts.some((p) => p.type === "data-earn-draft")).toBe(false);
    // An uncleared real pool isn't open to a liquidity provider with no position in it (Mynt's own rule).
    expect(JSON.stringify(fake.requests[1].messages)).toContain("Draft refused: That pool isn't one open to this user.");
  });

  it("reads pools and positions once per answer, however many panel tools it calls, and afresh for the next answer", async () => {
    fake.steps = [
      { tool: { name: "show_pools", input: { pool_ids: [POOL] } } },
      { tool: { name: "draft_commitment", input: { pool_id: POOL, amount_cents: 500_000, state: "us-ny" } } },
      { tool: { name: "draft_withdrawal", input: { pool_id: POOL, amount_cents: 100_000 } } },
      { text: "Both drafts are in the panel." },
    ];
    const parts = await chunks(await ask("show and draft"));
    expect(parts.filter((p) => p.type === "data-earn-draft")).toHaveLength(2);
    const reads = (name: string) => fake.calls.filter((c) => c.name === name).length;
    expect(reads("list_pools")).toBe(1);
    expect(reads("list_my_positions")).toBe(1);
    expect(reads("get_product")).toBe(1);
    fake.steps = [{ tool: { name: "show_pools", input: { pool_ids: [] } } }, { text: "ok" }];
    await chunks(await ask("again"));
    expect(reads("list_pools")).toBe(2);
  });

  it("show_pools draws only pools the user can see", async () => {
    fake.steps = [{ tool: { name: "show_pools", input: { pool_ids: [POOL, "not-a-pool", POOL] } } }, { text: "Here they are." }];
    const parts = await chunks(await ask("90-day lock-in"));
    expect(parts.find((p) => p.type === "data-earn-pools")?.data).toEqual({ pool_ids: [POOL] });
  });

  it("is for builders and liquidity providers, from the studio's own origin, with its own hourly count", async () => {
    as("consumer");
    expect((await ask("hi")).status).toBe(403);
    as("developer", "innovator");
    const builder = await ask("my pools?");
    expect(builder.status).toBe(200);
    await chunks(builder);
    as("liquidity_provider");
    expect((await ask("hi", "https://elsewhere.example")).status).toBe(403);
    expect(counts.get("earn")).toBe(1);
    expect(counts.has("ask")).toBe(false);
    // A builder can't draft: only liquidity providers commit.
    as("developer", "innovator");
    fake.steps = [{ tool: { name: "draft_commitment", input: { pool_id: POOL, amount_cents: 500_000, state: "us-ny" } } }, { text: "ok" }];
    const parts = await chunks(await ask("commit"));
    expect(parts.some((p) => p.type === "data-earn-draft")).toBe(false);
    expect((await (await GET()).json()).enabled).toBe(true);
  });
});

describe("validateDraft", () => {
  const pools = fromPools(POOLS).map((p) => ({ ...p, queueLength: null, health: null }));
  const positions = fromPositions(POSITIONS);
  it("takes a draft within the pool's terms and refuses the rest with the reason", () => {
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 100_000, state: "us-ny" }, pools, positions, "d1")).toEqual({ draft: { kind: "commit", id: "d1", poolId: POOL, poolName: "Pool 1", amountCents: 100_000, state: "us-ny", sandbox: false } });
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 9_600_000, state: "us-ny" }, pools, positions, "d1")).toMatchObject({ error: expect.stringMatching(/over this pool's limit/) });
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 100_000, state: "us-ca" }, pools, positions, "d1")).toMatchObject({ error: expect.stringMatching(/moves from us-ny/) });
    expect(validateDraft("commit", { pool_id: UNCLEARED, amount_cents: 100_000, state: "us-ny" }, pools, positions, "d1")).toMatchObject({ error: expect.stringMatching(/^Sandbox only/) });
    expect(validateDraft("commit", { pool_id: "11111111-1111-4111-8111-999999999999", amount_cents: 100_000, state: "us-ny" }, pools, positions, "d1")).toEqual({ error: "That pool isn't one open to this user." });
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 1.5, state: "us-ny" }, pools, positions, "d1")).toHaveProperty("error");
    expect(validateDraft("commit", { pool_id: POOL, amount_cents: 100_000, state: "zz" }, pools, positions, "d1")).toHaveProperty("error");
    expect(validateDraft("withdraw", { pool_id: POOL, amount_cents: 200_000 }, pools, positions, "d2")).toMatchObject({ draft: { kind: "withdraw", amountCents: 200_000 } });
    expect(validateDraft("withdraw", { pool_id: POOL, amount_cents: 200_001 }, pools, positions, "d2")).toMatchObject({ error: expect.stringMatching(/at most \$2,000\.00/) });
    expect(validateDraft("withdraw", { pool_id: UNCLEARED, amount_cents: 1 }, pools, positions, "d2")).toEqual({ error: "The user holds no position in that pool." });
  });
});
