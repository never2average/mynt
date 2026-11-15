import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/session-store";
import { parseStudioCall } from "@/lib/studio-tools";

// Earn's wallet and treasury routes: the picker's wallets and balances, preparing an on-chain
// deposit or withdrawal (devnet only, the user's own verified wallet, the studio's own origin, one
// prepare per key), and a transaction's status. Each degrades when Mynt lacks its tool.

const POOL = "11111111-1111-4111-8111-111111111111";
const RAIL_POOL = "11111111-1111-4111-8111-111111111112";
const SOL = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";
const OTHER_SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";
const TX = Buffer.alloc(300, 1).toString("base64");
const SIG = "5".repeat(87);
const DEP = "Dep1111111111111111111111111111111111111111";
const LOCKED = "Dep2222222222222222222222222222222222222222";
const ALL = ["get_linked_accounts", "get_wallet_balances", "list_pools", "list_my_positions", "prepare_treasury_deposit", "prepare_treasury_withdrawal", "get_treasury_tx_status"];
const pool = (id: string, over: Record<string, unknown> = {}) => ({ id, product_id: "p", name: `Pool ${id.slice(-1)}`, sandbox: true, status: "open", notice_period_days: 7, lock_in_days: 30, min_commitment_cents: 100, max_commitment_cents: 1_000_000, approved_at: "2026-11-01T00:00:00Z", ...over });
const TREASURY = { cluster: "devnet", program_id: "Prog", pool_address: OTHER_SOL, verified_build: true, on_chain_terms: { lock_in_seconds: 2_592_000, notice_seconds: 604_800 } };

const fake = {
  session: undefined as Session | undefined,
  tools: ALL,
  calls: [] as { name: string; args: Record<string, unknown> }[],
  claims: new Set<string>(),
  pools: [pool(POOL, { treasury: TREASURY }), pool(RAIL_POOL)] as unknown[],
  prepareReply: null as unknown,
  refusal: null as Record<string, unknown> | null,
  txStatus: "confirmed",
};

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
      const k = `${name}:${subject}`;
      if (fake.claims.has(k)) return null;
      fake.claims.add(k);
      return async () => void fake.claims.delete(k);
    },
  }),
}));
vi.mock("@/lib/tokens", () => ({
  connectStudio: async () => ({
    listTools: async () => ({ tools: fake.tools.map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }),
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      fake.calls.push({ name, args });
      const ok = (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
      switch (name) {
        case "whoami":
          return ok({ effective_roles: fake.session?.roles ?? [] });
        case "get_linked_accounts":
          return ok({ git: null, wallets: [{ chain: "solana", address: SOL, verified: true }, { chain: "ethereum", address: EVM, verified: true }, { chain: "solana", address: OTHER_SOL, verified: false }], manage_url: "https://accounts.example.com/user" });
        case "get_wallet_balances":
          return ok({ sol_lamports: 2_000_000_000, usdc_base_units: "50000000" });
        case "list_pools":
          return ok(fake.pools);
        case "list_my_positions":
          return ok([
            { source: "off-chain", pool_id: RAIL_POOL, name: "Pool 2", product_id: "p", balance_cents: 100 },
            {
              source: "on-chain",
              cluster: "devnet",
              pool_id: POOL,
              name: "Pool 1",
              product_id: "p",
              wallet: SOL,
              sandbox: true,
              principal: "150000000",
              queued: 0,
              available_to_request: 50_000_000,
              deposits: [
                { deposit: DEP, address: DEP, seq: 1, amount: 50_000_000, remaining: 50_000_000, queued: 0, review_until: "2026-01-01T00:00:00Z", unlocks_at: "2026-02-01T00:00:00Z", unlocked: true, rejected: false },
                { deposit: LOCKED, address: LOCKED, seq: 2, amount: "100000000", remaining: "100000000", queued: 0, review_until: "2026-01-01T00:00:00Z", unlocks_at: "2099-02-01T00:00:00Z", unlocked: false, rejected: false },
              ],
              requests: [],
            },
          ]);
        case "prepare_treasury_deposit":
        case "prepare_treasury_withdrawal":
          if (fake.refusal) return { isError: true, content: [{ type: "text", text: JSON.stringify(fake.refusal) }] };
          return ok(fake.prepareReply ?? { cluster: "devnet", transaction_base64: TX, expires_at: "2099-01-01T00:00:00Z", summary: { pool: "Pool 1", amount: args.amount_usdc_base_units, lock_in_seconds: 2_592_000, notice_seconds: 604_800, wallet: args.wallet } });
        case "get_treasury_tx_status":
          if (fake.refusal) return { isError: true, content: [{ type: "text", text: JSON.stringify(fake.refusal) }] };
          return ok({ status: fake.txStatus });
        default:
          return ok({});
      }
    },
    close: async () => undefined,
  }),
}));

const wallets = await import("@/app/api/earn/wallets/route");
const prepare = await import("@/app/api/earn/treasury/prepare/route");
const status = await import("@/app/api/earn/treasury/status/route");

const as = (...roles: string[]) => {
  fake.session = { id: "s", userId: "u1", createdAt: 0, lastSeen: 0, tokens: { access_token: "t", token_type: "Bearer" }, roles, rolesAt: Date.now() } as Session;
};
const post = (path: string, body: unknown, origin = "http://localhost:3000") => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
const called = (name: string) => fake.calls.filter((c) => c.name === name);
const deposit = (over: Record<string, unknown> = {}) => post("/api/earn/treasury/prepare", { kind: "deposit", pool_id: POOL, wallet: SOL, amount_cents: 2_500, idempotency_key: `key-${Math.random().toString(36).slice(2)}`, ...over });

beforeEach(() => {
  fake.tools = ALL;
  fake.calls = [];
  fake.claims = new Set();
  fake.pools = [pool(POOL, { treasury: TREASURY }), pool(RAIL_POOL)];
  fake.prepareReply = null;
  fake.refusal = null;
  fake.txStatus = "confirmed";
  as("liquidity_provider");
});

describe("the allow-list", () => {
  it("has the wallet and treasury tools, devnet only, with strict arguments", () => {
    expect(parseStudioCall("get_wallet_balances", { address: SOL, cluster: "devnet" })).toHaveProperty("tool");
    expect(parseStudioCall("get_wallet_balances", { address: SOL, cluster: "mainnet-beta" })).toHaveProperty("error");
    expect(parseStudioCall("get_wallet_balances", { address: EVM, cluster: "devnet" })).toHaveProperty("error");
    expect(parseStudioCall("prepare_treasury_deposit", { pool_id: POOL, wallet: SOL, amount_usdc_base_units: 1, max_lock_in_seconds: 0 })).toHaveProperty("tool");
    expect(parseStudioCall("prepare_treasury_deposit", { pool_id: POOL, wallet: SOL, amount_usdc_base_units: 1.5, max_lock_in_seconds: 0 })).toHaveProperty("error");
    expect(parseStudioCall("prepare_treasury_deposit", { pool_id: POOL, wallet: SOL, amount_usdc_base_units: 1, max_lock_in_seconds: 0, cluster: "mainnet-beta" })).toHaveProperty("error");
    expect(parseStudioCall("prepare_treasury_withdrawal", { pool_id: POOL, wallet: SOL, deposit: DEP, amount_usdc_base_units: 1, max_notice_seconds: 0 })).toHaveProperty("tool");
    expect(parseStudioCall("prepare_treasury_withdrawal", { pool_id: POOL, wallet: SOL, deposit: "dep-1", amount_usdc_base_units: 1, max_notice_seconds: 0 })).toHaveProperty("error");
    expect(parseStudioCall("get_treasury_tx_status", { signature: SIG })).toHaveProperty("tool");
    expect(parseStudioCall("get_treasury_tx_status", { signature: "short" })).toHaveProperty("error");
  });
});

describe("GET /api/earn/wallets", () => {
  it("lists verified wallets with devnet balances for Solana ones, and the treasury tools Mynt has", async () => {
    const body = await (await wallets.GET()).json();
    expect(body.supported).toBe(true);
    expect(body.wallets).toEqual([
      { address: SOL, chain: "solana", network: "Solana", balances: { solLamports: "2000000000", usdcBaseUnits: "50000000" } },
      { address: EVM, chain: "ethereum", network: "Ethereum", balances: null },
    ]);
    expect(called("get_wallet_balances")).toEqual([{ name: "get_wallet_balances", args: { address: SOL, cluster: "devnet" } }]);
    expect(body.treasury).toEqual({ deposit: true, withdraw: true, status: true });
    expect(body.owner).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(body)).not.toContain("u1");
  });

  it("degrades: wallets without balances, then no wallets at all", async () => {
    fake.tools = ALL.filter((t) => t !== "get_wallet_balances");
    let body = await (await wallets.GET()).json();
    expect(body.balancesSupported).toBe(false);
    expect(body.wallets.map((w: { balances: unknown }) => w.balances)).toEqual([null, null]);
    fake.tools = ["list_pools"];
    body = await (await wallets.GET()).json();
    expect(body).toMatchObject({ supported: false, wallets: [], treasury: { deposit: false, withdraw: false, status: false } });
  });

  it("is for builders and liquidity providers", async () => {
    as("consumer");
    expect((await wallets.GET()).status).toBe(403);
  });
});

describe("POST /api/earn/treasury/prepare", () => {
  it("prepares a devnet deposit from the user's own wallet with the pool's lock-in as the most they agreed to", async () => {
    const res = await prepare.POST(deposit());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prepared).toMatchObject({ cluster: "devnet", transactionBase64: TX, summary: { amount: "25 USDC", wallet: SOL, lockInSeconds: 2_592_000 } });
    expect(called("prepare_treasury_deposit")).toEqual([{ name: "prepare_treasury_deposit", args: { pool_id: POOL, wallet: SOL, amount_usdc_base_units: 25_000_000, max_lock_in_seconds: 2_592_000 } }]);
  });

  it("prepares a withdrawal from the deposit chosen, within what it has available", async () => {
    const res = await prepare.POST(deposit({ kind: "withdrawal", amount_cents: undefined, amount_usdc_base_units: 50_000_000, deposit: DEP }));
    expect(res.status).toBe(200);
    expect(called("prepare_treasury_withdrawal")[0].args).toEqual({ pool_id: POOL, wallet: SOL, deposit: DEP, amount_usdc_base_units: 50_000_000, max_notice_seconds: 604_800 });
    expect((await prepare.POST(deposit({ kind: "withdrawal", amount_cents: 5_001, deposit: DEP }))).status).toBe(400);
    const locked = await prepare.POST(deposit({ kind: "withdrawal", deposit: LOCKED }));
    expect(locked.status).toBe(400);
    expect((await locked.json()).message).toContain("Locked until 2099-02-01");
    expect((await prepare.POST(deposit({ kind: "withdrawal", deposit: OTHER_SOL }))).status).toBe(404);
    expect((await prepare.POST(deposit({ kind: "withdrawal" }))).status).toBe(400); // no deposit named
    expect(called("prepare_treasury_withdrawal")).toHaveLength(1);
  });

  it("answers Mynt's coded refusals in plain words, and frees the key for another try", async () => {
    fake.refusal = { error: "Insufficient USDC in wallet ...", code: "insufficient_usdc" };
    const res = await prepare.POST(deposit({ idempotency_key: "retry-key-1" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "insufficient_usdc", message: "Your wallet doesn't hold enough devnet USDC for that amount." });
    fake.refusal = { error: "x", code: "in_review", review_until: "2026-11-16T00:00:00Z" };
    const review = await (await prepare.POST(deposit({ kind: "withdrawal", deposit: DEP }))).json();
    expect(review.message).toBe("That deposit is still in its review window until 2026-11-16.");
    fake.refusal = null;
    expect((await prepare.POST(deposit({ idempotency_key: "retry-key-1" }))).status).toBe(200);
  });

  it("refuses another origin, a wallet that isn't the user's verified one, and a non-liquidity provider", async () => {
    expect((await prepare.POST(post("/api/earn/treasury/prepare", { kind: "deposit", pool_id: POOL, wallet: SOL, amount_cents: 1, idempotency_key: "abcdefgh" }, "https://evil.example"))).status).toBe(403);
    expect((await prepare.POST(deposit({ wallet: OTHER_SOL }))).status).toBe(403); // linked but not verified
    expect((await prepare.POST(deposit({ wallet: EVM }))).status).toBe(400);
    as("developer", "innovator");
    expect((await prepare.POST(deposit())).status).toBe(403);
    expect(called("prepare_treasury_deposit")).toHaveLength(0);
  });

  it("refuses a pool on rails, a treasury off devnet, and a reply that isn't devnet", async () => {
    expect((await prepare.POST(deposit({ pool_id: RAIL_POOL }))).status).toBe(400);
    fake.pools = [pool(POOL, { treasury: { ...TREASURY, cluster: "mainnet-beta" } })];
    const off = await prepare.POST(deposit());
    expect(off.status).toBe(400);
    expect((await off.json()).message).toContain("devnet only");
    expect(called("prepare_treasury_deposit")).toHaveLength(0);
    fake.pools = [pool(POOL, { treasury: TREASURY })];
    fake.prepareReply = { cluster: "mainnet-beta", transaction_base64: TX, summary: { wallet: SOL } };
    const res = await prepare.POST(deposit());
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(TX);
  });

  it("prepares once per key", async () => {
    const key = "same-key-123";
    expect((await prepare.POST(deposit({ idempotency_key: key }))).status).toBe(200);
    expect((await prepare.POST(deposit({ idempotency_key: key }))).status).toBe(409);
    expect(called("prepare_treasury_deposit")).toHaveLength(1);
  });

  it("says on-chain deposits are coming soon until Mynt has the tool", async () => {
    fake.tools = ALL.filter((t) => t !== "prepare_treasury_deposit");
    const res = await prepare.POST(deposit());
    expect(res.status).toBe(501);
    expect((await res.json()).message).toBe("On-chain deposits coming soon.");
  });
});

describe("POST /api/earn/treasury/status", () => {
  it("reads a signature's status from the studio's own origin only", async () => {
    const res = await status.POST(post("/api/earn/treasury/status", { signature: SIG }));
    expect(await res.json()).toEqual({ status: "confirmed", stage: "confirmed", error: null });
    for (const [raw, want] of [["not_found", "pending"], ["processed", "pending"], ["finalized", "confirmed"], ["failed", "failed"]]) {
      fake.txStatus = raw;
      expect((await (await status.POST(post("/api/earn/treasury/status", { signature: SIG }))).json()).status, raw).toBe(want);
    }
    fake.txStatus = "confirmed";
    fake.refusal = { error: "rpc down at some address", code: "rpc_unavailable" };
    const down = await status.POST(post("/api/earn/treasury/status", { signature: SIG }));
    expect(down.status).toBe(422);
    expect((await down.json()).message).toBe("Mynt couldn't reach devnet just now. Please try again in a minute.");
    fake.refusal = null;
    expect((await status.POST(post("/api/earn/treasury/status", { signature: SIG }, "https://evil.example"))).status).toBe(403);
    expect((await status.POST(post("/api/earn/treasury/status", { signature: "x" }))).status).toBe(400);
    fake.tools = [];
    expect((await status.POST(post("/api/earn/treasury/status", { signature: SIG }))).status).toBe(501);
  });
});
