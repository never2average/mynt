import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { parseStudioCall, STUDIO_TOOLS } from "@/lib/studio-tools";

// The liquidity routes: who they serve, what they read from Mynt, and the three writes (propose a
// pool, commit capital, request a withdrawal), cancelling a request and answering a state
// correction, each only through the studio's allow-list.

const POOL = "11111111-1111-4111-8111-111111111111";
const OTHER = "11111111-1111-4111-8111-111111111119";
const SPONSOR = "22222222-2222-4222-8222-222222222222";
const LIQUIDITY_TOOLS = ["list_pools", "list_withdrawals", "list_my_positions", "list_pools_with_health", "list_product_health", "list_my_sponsorships", "create_pool", "commit_to_pool", "request_withdrawal", "cancel_withdrawal", "respond_to_state_correction", "get_product"];
const pool = (id: string, product: string, over: Record<string, unknown> = {}) => ({
  id,
  product_id: product,
  component_key: "lending",
  sponsor_entity_id: SPONSOR,
  name: `Pool ${product}`,
  sandbox: false,
  status: "open",
  min_reserve_bps: 2000,
  min_reserve_floor_cents: 0,
  notice_period_days: 30,
  min_commitment_cents: 100,
  max_commitment_cents: 1_000_000,
  deposit_rail_id: "33333333-3333-4333-8333-333333333333",
  withdrawal_rail_id: "44444444-4444-4444-8444-444444444444",
  approved_at: "2026-11-01T00:00:00Z",
  offering_cleared: true,
  ...over,
});

const fake = {
  session: undefined as Session | undefined,
  tools: LIQUIDITY_TOOLS,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  refuse: {} as Record<string, string>,
};

vi.mock("@/lib/session", () => ({
  currentSession: async () => fake.session,
  fromOwnOrigin: (req: Request) => [null, "http://localhost:3000"].includes(req.headers.get("origin")),
  setSessionCookie: () => undefined,
}));
vi.mock("@/lib/session-store", () => ({ sessionStore: () => ({ save: async () => true, wasTouched: () => false }) }));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      if (fake.refuse[name]) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: fake.refuse[name] }) }] };
      switch (name) {
        case "list_pools":
          // Both roles: the builder's own product's pool, and another firm's open pool.
          return ok([pool(POOL, "own-product", { approved_at: null, status: "paused", pause_kind: "awaiting_approval" }), pool(OTHER, "their-product")]);
        case "list_my_sponsorships":
          return ok([{ status: "approved", product_id: "own-product", component_key: "lending", provider_entity_id: SPONSOR, product: { id: "own-product", name: "Own product" }, provider: { name: "Harbor Bank" } }]);
        case "list_withdrawals":
          return ok([{ id: "w1", seq: 1, pool_id: POOL, amount_cents: 500, status: "queued" }, { id: "w2", seq: 2, pool_id: OTHER, amount_cents: 700, status: "queued" }]);
        case "list_product_health":
          return ok([{ product_id: "own-product", pool_id: POOL, snapshots: [{ sequence: 3, status: "published", verified: true, period_end: "2026-11-13T00:00:00Z" }] }]);
        case "list_my_positions":
          return ok([{ pool_id: OTHER, name: "Pool their-product", product_id: "their-product", sandbox: false, contributed_cents: 1000, balance_cents: 1000, available_to_withdraw_cents: 300, queued_withdrawal_cents: 700 }]);
        case "list_pools_with_health":
          return ok([{ pool_id: OTHER, verified: true, coverage_bps: 15000, snapshot: { sequence: 5, status: "published", period_end: "2026-11-13T00:00:00Z" } }]);
        case "get_product":
          return ok({ id: args.id, name: "Their product", product_line: "credit" });
        case "commit_to_pool":
          return ok({ pool_id: args.pool_id, amount_cents: args.amount_cents, sandbox: false, movement_id: "m1", movement_status: "requested" });
        case "request_withdrawal":
          return ok({ id: "w3", seq: 3, pool_id: args.pool_id, amount_cents: args.amount_cents, status: "queued", eligible_at: "2026-12-14T00:00:00Z", sandbox: false });
        case "create_pool":
          return ok({ id: "new-pool", status: "paused", pause_kind: "awaiting_approval" });
        case "cancel_withdrawal":
          return ok({ withdrawal_id: args.withdrawal_id, status: "cancelled", sandbox: false });
        case "respond_to_state_correction":
          return ok({ correction_id: args.correction_id, status: args.accept ? "confirmed" : "disputed", unparked: [] });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const liquidity = await import("@/app/api/liquidity/route");
const access = await import("@/app/api/liquidity/access/route");
const pools = await import("@/app/api/liquidity/pools/route");
const commit = await import("@/app/api/liquidity/commit/route");
const withdraw = await import("@/app/api/liquidity/withdraw/route");
const cancel = await import("@/app/api/liquidity/withdrawals/[id]/cancel/route");
const correction = await import("@/app/api/liquidity/corrections/[id]/route");

const as = (...roles: string[]) => {
  fake.session = { id: "s", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() } as Session;
};
const post = (path: string, body: unknown, origin = "http://localhost:3000") => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const called = (name: string) => fake.calls.filter((c) => c.name === name);
const KEY = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

beforeEach(() => {
  fake.tools = LIQUIDITY_TOOLS;
  fake.calls = [];
  fake.refuse = {};
  as("developer", "consumer", "innovator");
});

describe("the studio's liquidity tools", () => {
  it("are the reads and the writes the page needs, never a sponsor's or an admin's pool tool", () => {
    const names = Object.keys(STUDIO_TOOLS);
    expect(names).toEqual(expect.arrayContaining(["list_pools", "list_withdrawals", "list_my_positions", "list_pools_with_health", "list_product_health", "list_my_sponsorships", "create_pool", "commit_to_pool", "request_withdrawal", "cancel_withdrawal", "respond_to_state_correction"]));
    for (const banned of [
      "approve_pool",
      "set_pool_offering_cleared",
      "report_pool_movement",
      "pause_pool",
      "resume_pool",
      "set_pool_firm_state",
      "list_pool_flags",
      "resolve_pool_flag",
      "reanchor_product_health",
      "register_partner_signing_key",
      "submit_partner_signature",
      "approve_sponsorship",
      "revoke_sponsorship",
    ])
      expect(names, banned).not.toContain(banned);
  });

  it("check their arguments strictly", () => {
    const ok = (t: string, a: object) => expect(parseStudioCall(t, a), t).toHaveProperty("tool");
    const bad = (t: string, a: object) => expect(parseStudioCall(t, a), `${t} ${JSON.stringify(a)}`).toHaveProperty("error");
    ok("commit_to_pool", { pool_id: POOL, amount_cents: 100, state: "us-ny", idempotency_key: KEY });
    bad("commit_to_pool", { pool_id: POOL, amount_cents: 1.5, state: "us-ny", idempotency_key: KEY });
    bad("commit_to_pool", { pool_id: POOL, amount_cents: -1, state: "us-ny", idempotency_key: KEY });
    bad("commit_to_pool", { pool_id: POOL, amount_cents: 100, state: "NY", idempotency_key: KEY });
    bad("commit_to_pool", { pool_id: "not-a-uuid", amount_cents: 100, state: "us-ny", idempotency_key: KEY });
    bad("commit_to_pool", { pool_id: POOL, amount_cents: 100, state: "us-ny", idempotency_key: "short" });
    bad("commit_to_pool", { pool_id: POOL, amount_cents: 100, state: "us-ny", idempotency_key: KEY, lp_entity_id: SPONSOR });
    ok("request_withdrawal", { pool_id: POOL, amount_cents: 100, idempotency_key: KEY });
    bad("request_withdrawal", { pool_id: POOL, amount_cents: 0, idempotency_key: KEY });
    ok("cancel_withdrawal", { withdrawal_id: POOL });
    bad("cancel_withdrawal", { withdrawal_id: "w1" });
    bad("cancel_withdrawal", { withdrawal_id: POOL, lp_entity_id: SPONSOR });
    ok("respond_to_state_correction", { correction_id: POOL, accept: true });
    ok("respond_to_state_correction", { correction_id: POOL, accept: false, reason: "We still move from NY" });
    bad("respond_to_state_correction", { correction_id: POOL });
    bad("respond_to_state_correction", { correction_id: POOL, accept: "yes" });
    bad("respond_to_state_correction", { correction_id: POOL, accept: true, reason: "x".repeat(1001) });
    bad("respond_to_state_correction", { correction_id: POOL, accept: true, state: "us-nj" });
    ok("list_pools", { status: "open" });
    bad("list_pools", { status: "everything" });
  });
});

describe("GET /api/liquidity", () => {
  it("a builder gets its own products' pools with health and queue length, and what it may propose", async () => {
    const body = await (await liquidity.GET()).json();
    expect(body.supported).toBe(true);
    expect(body.access).toEqual({ builder: true, liquidityProvider: false });
    expect(body.provider).toBeUndefined();
    expect(body.builder.pools.map((p: { id: string }) => p.id)).toEqual([POOL]);
    expect(body.builder.pools[0]).toMatchObject({ productName: "Own product", queueLength: 1, health: { verified: true, sequence: 3 } });
    expect(body.builder.proposable).toEqual([{ productId: "own-product", productName: "Own product", componentKey: "lending", sponsorId: SPONSOR, sponsorName: "Harbor Bank" }]);
    expect(called("list_my_positions")).toHaveLength(0);
    expect(called("list_pools_with_health")).toHaveLength(0);
  });

  it("a liquidity provider (with no developer role) is served: open pools with health and product line, positions and its own requests", async () => {
    as("liquidity_provider");
    const res = await liquidity.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.builder).toBeUndefined();
    expect(body.provider.pools.map((p: { id: string }) => p.id)).toEqual([OTHER]); // the unapproved pool isn't open
    expect(body.provider.pools[0]).toMatchObject({ productLine: "credit", productName: "Their product", health: { coverageBps: 15000, verified: true } });
    expect(body.provider.positions[0]).toMatchObject({ poolId: OTHER, settledCents: 1000, availableCents: 300 });
    expect(body.provider.withdrawals.map((w: { id: string }) => w.id)).toEqual(["w2"]);
    expect(body.provider).toMatchObject({ canCommit: true, canWithdraw: true, canCancel: true, canRespond: true });
    expect(called("list_my_sponsorships")).toHaveLength(0);
  });

  it("both roles: the builder's own pools are never offered to it as a liquidity provider", async () => {
    as("developer", "innovator", "liquidity_provider");
    const body = await (await liquidity.GET()).json();
    expect(body.builder.pools.map((p: { id: string }) => p.id)).toEqual([POOL]);
    expect(body.provider.pools.map((p: { id: string }) => p.id)).toEqual([OTHER]);
  });

  it("degrades: not available without list_pools; no proposing or committing without their tools", async () => {
    fake.tools = ["get_product"];
    expect(await (await liquidity.GET()).json()).toEqual({ supported: false, access: { builder: true, liquidityProvider: false } });
    fake.tools = ["list_pools", "list_my_sponsorships"];
    as("innovator", "liquidity_provider");
    const body = await (await liquidity.GET()).json();
    expect(body.builder.proposable).toBeNull();
    expect(body.builder.withdrawalsShown).toBe(false);
    expect(body.builder.pools[0].queueLength).toBeNull();
    expect(body.builder.pools[0].health).toBeNull();
    expect(body.provider).toMatchObject({ canCommit: false, canWithdraw: false, canCancel: false, canRespond: false, positions: [] });
  });

  it("isn't for anyone else", async () => {
    as("consumer");
    expect((await liquidity.GET()).status).toBe(403);
    expect(await (await access.GET()).json()).toEqual({ access: { builder: false, liquidityProvider: false }, developer: false, licenceProvider: false, admin: false, vendor: false, owner: expect.any(String) });
    as("liquidity_provider");
    expect(await (await access.GET()).json()).toEqual({ access: { builder: false, liquidityProvider: true }, developer: false, licenceProvider: false, admin: false, vendor: false, owner: expect.any(String) });
  });
});

describe("writes", () => {
  it("request a withdrawal: a liquidity provider joins the queue, and Mynt's answer comes back", async () => {
    as("liquidity_provider");
    const res = await withdraw.POST(post("/api/liquidity/withdraw", { pool_id: OTHER, amount_cents: 300, idempotency_key: KEY }));
    expect(res.status).toBe(200);
    expect(called("request_withdrawal")).toEqual([{ name: "request_withdrawal", args: { pool_id: OTHER, amount_cents: 300, idempotency_key: KEY } }]);
    expect((await res.json()).withdrawal).toMatchObject({ seq: 3, status: "queued", eligible_at: "2026-12-14T00:00:00Z" });
  });

  it("a withdrawal is refused for builders, from another origin, with bad amounts, and Mynt's refusal is shown", async () => {
    as("developer", "innovator");
    expect((await withdraw.POST(post("/api/liquidity/withdraw", { pool_id: OTHER, amount_cents: 300, idempotency_key: KEY }))).status).toBe(403);
    as("liquidity_provider");
    expect((await withdraw.POST(post("/api/liquidity/withdraw", { pool_id: OTHER, amount_cents: 300, idempotency_key: KEY }, "https://elsewhere.example"))).status).toBe(403);
    expect((await withdraw.POST(post("/api/liquidity/withdraw", { pool_id: OTHER, amount_cents: -3, idempotency_key: KEY }))).status).toBe(400);
    fake.refuse.request_withdrawal = "You can withdraw at most 300 cents from this pool right now";
    const refused = await withdraw.POST(post("/api/liquidity/withdraw", { pool_id: OTHER, amount_cents: 301, idempotency_key: KEY }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("You can withdraw at most 300 cents from this pool right now");
    fake.tools = LIQUIDITY_TOOLS.filter((t) => t !== "request_withdrawal");
    expect((await withdraw.POST(post("/api/liquidity/withdraw", { pool_id: OTHER, amount_cents: 300, idempotency_key: KEY }))).status).toBe(501);
  });

  it("commit capital: only a liquidity provider, with a US state; an uncleared pool's refusal is Mynt's to give and is shown", async () => {
    as("liquidity_provider");
    const res = await commit.POST(post("/api/liquidity/commit", { pool_id: OTHER, amount_cents: 500, state: "us-ny", idempotency_key: KEY }));
    expect((await res.json()).commitment).toMatchObject({ movement_id: "m1", movement_status: "requested" });
    expect(called("commit_to_pool")[0].args).toEqual({ pool_id: OTHER, amount_cents: 500, state: "us-ny", idempotency_key: KEY });
    expect((await commit.POST(post("/api/liquidity/commit", { pool_id: OTHER, amount_cents: 500, idempotency_key: KEY }))).status).toBe(400);
    fake.refuse.commit_to_pool = "Real money can't be committed to this pool yet";
    const refused = await commit.POST(post("/api/liquidity/commit", { pool_id: OTHER, amount_cents: 500, state: "us-ny", idempotency_key: KEY }));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("Real money can't be committed to this pool yet");
    as("developer", "innovator");
    expect((await commit.POST(post("/api/liquidity/commit", { pool_id: OTHER, amount_cents: 500, state: "us-ny", idempotency_key: KEY }))).status).toBe(403);
  });

  it("propose a pool: only on an approved sponsorship of the builder's product", async () => {
    const terms = { component_key: "lending", name: "Float", sandbox: true, min_reserve_bps: 2000, min_reserve_floor_cents: 0, notice_period_days: 30, min_commitment_cents: 100, max_commitment_cents: 10_000 };
    const refused = await pools.POST(post("/api/liquidity/pools", { ...terms, product_id: "their-product" }));
    expect(refused.status).toBe(422);
    expect(called("create_pool")).toHaveLength(0);
    const res = await pools.POST(post("/api/liquidity/pools", { ...terms, product_id: "own-product" }));
    expect(res.status).toBe(200);
    expect(called("create_pool")[0].args).toEqual({ ...terms, product_id: "own-product" });
    // An idempotency key goes through to Mynt as given; a malformed one is refused before Mynt is asked.
    const keyed = await pools.POST(post("/api/liquidity/pools", { ...terms, product_id: "own-product", idempotency_key: KEY }));
    expect(keyed.status).toBe(200);
    expect(called("create_pool")[1].args).toEqual({ ...terms, product_id: "own-product", idempotency_key: KEY });
    expect((await pools.POST(post("/api/liquidity/pools", { ...terms, product_id: "own-product", idempotency_key: "short" }))).status).toBe(400);
    expect(called("create_pool")).toHaveLength(2);
    as("liquidity_provider");
    expect((await pools.POST(post("/api/liquidity/pools", { ...terms, product_id: "own-product" }))).status).toBe(403);
  });
});

describe("cancelling a withdrawal request and answering a state correction", () => {
  const W = "55555555-5555-4555-8555-555555555555";
  const C = "66666666-6666-4666-8666-666666666666";
  const params = (id: string) => ({ params: Promise.resolve({ id }) });
  const cancelReq = (body?: unknown, origin = "http://localhost:3000") =>
    new Request(`http://localhost:3000/api/liquidity/withdrawals/${W}/cancel`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  it("cancel: a liquidity provider's request, named by the path, goes to cancel_withdrawal with nothing else", async () => {
    as("liquidity_provider");
    const res = await cancel.POST(cancelReq(), params(W));
    expect(res.status).toBe(200);
    expect(called("cancel_withdrawal")).toEqual([{ name: "cancel_withdrawal", args: { withdrawal_id: W } }]);
    expect((await res.json()).withdrawal).toEqual({ withdrawal_id: W, status: "cancelled", sandbox: false });
    expect((await cancel.POST(cancelReq({}), params(W))).status).toBe(200);
    expect(called("cancel_withdrawal")).toHaveLength(2);
  });

  it("cancel: sign-in required; refused from another origin, for builders, with a bad id or any body field; Mynt's refusal is shown", async () => {
    fake.session = undefined;
    expect((await cancel.POST(cancelReq(), params(W))).status).toBe(401);
    as("liquidity_provider");
    expect((await cancel.POST(cancelReq(undefined, "https://elsewhere.example"), params(W))).status).toBe(403);
    expect((await cancel.POST(cancelReq(), params("w1"))).status).toBe(400);
    expect((await cancel.POST(cancelReq({ withdrawal_id: W }), params(W))).status).toBe(400);
    expect((await cancel.POST(cancelReq({ lp_entity_id: SPONSOR }), params(W))).status).toBe(400);
    expect((await cancel.POST(cancelReq([]), params(W))).status).toBe(400);
    expect(called("cancel_withdrawal")).toHaveLength(0);
    fake.refuse.cancel_withdrawal = "That request is paying; only a queued request can be cancelled";
    const refused = await cancel.POST(cancelReq(), params(W));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("That request is paying; only a queued request can be cancelled");
    fake.tools = LIQUIDITY_TOOLS.filter((t) => t !== "cancel_withdrawal");
    expect((await cancel.POST(cancelReq(), params(W))).status).toBe(501);
    as("developer", "innovator");
    fake.tools = LIQUIDITY_TOOLS;
    fake.refuse = {};
    expect((await cancel.POST(cancelReq(), params(W))).status).toBe(403);
    expect(called("cancel_withdrawal")).toHaveLength(1); // only the refused one reached Mynt
  });

  it("respond: accept or dispute, with an optional reason, goes to respond_to_state_correction for the correction in the path", async () => {
    as("liquidity_provider");
    const res = await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: true }), params(C));
    expect(res.status).toBe(200);
    expect((await res.json()).correction).toEqual({ correction_id: C, status: "confirmed", unparked: [] });
    await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: false, reason: "  We move from NY  " }), params(C));
    expect(called("respond_to_state_correction")).toEqual([
      { name: "respond_to_state_correction", args: { correction_id: C, accept: true } },
      { name: "respond_to_state_correction", args: { correction_id: C, accept: false, reason: "We move from NY" } },
    ]);
  });

  it("respond: sign-in required; refused from another origin, for builders, without an answer or with extra fields; Mynt's refusal is shown", async () => {
    fake.session = undefined;
    expect((await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: true }), params(C))).status).toBe(401);
    as("liquidity_provider");
    expect((await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: true }, "https://elsewhere.example"), params(C))).status).toBe(403);
    for (const body of [{}, { accept: "yes" }, { accept: true, correction_id: C }, { accept: true, state: "us-nj" }, { accept: true, reason: "x".repeat(1001) }, null])
      expect((await correction.POST(post(`/api/liquidity/corrections/${C}`, body), params(C))).status, JSON.stringify(body)).toBe(400);
    expect((await correction.POST(post("/api/liquidity/corrections/c1", { accept: true }), params("c1"))).status).toBe(400);
    expect(called("respond_to_state_correction")).toHaveLength(0);
    fake.refuse.respond_to_state_correction = "That correction can no longer be disputed";
    const refused = await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: false }), params(C));
    expect(refused.status).toBe(422);
    expect((await refused.json()).message).toBe("That correction can no longer be disputed");
    fake.tools = LIQUIDITY_TOOLS.filter((t) => t !== "respond_to_state_correction");
    expect((await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: true }), params(C))).status).toBe(501);
    as("developer", "innovator");
    fake.tools = LIQUIDITY_TOOLS;
    expect((await correction.POST(post(`/api/liquidity/corrections/${C}`, { accept: true }), params(C))).status).toBe(403);
  });
});
