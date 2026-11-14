import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  accessFrom,
  canUseLiquidity,
  fromPools,
  fromPoolsWithHealth,
  fromPositions,
  fromProductHealth,
  fromSponsorships,
  fromWithdrawals,
  healthFor,
  queueLength,
  stageOf,
  type LiquidityAccess,
  type LiquidityData,
  type Pool,
} from "./liquidity";
import type { Session } from "./session-store";
import { callStudioTool, isAuthError, listMyntTools } from "./studio-server";

// The /liquidity page's data, read from Mynt as the signed-in user. Each part waits for Mynt to
// offer its tool: without list_pools there's nothing to show ("not available yet"); without a
// health, queue or proposal tool that part says so instead of showing zeros.

export const sessionCanUseLiquidity = (session: Session) => canUseLiquidity(session.roles ?? []);
export const sessionAccess = (session: Session): LiquidityAccess => accessFrom(session.roles ?? []);

// The most products whose line and name are looked up for one page.
const MAX_PRODUCTS = 40;

export async function loadLiquidity(mynt: Client, access: LiquidityAccess): Promise<LiquidityData> {
  const names = new Set((await listMyntTools(mynt)).map((t) => t.name));
  if (!names.has("list_pools")) return { supported: false, access };
  // A part that fails (a refusal, a tool this Mynt lacks) is left out; a lost sign-in isn't.
  const read = async (tool: string, args: Record<string, unknown> = {}): Promise<unknown | null> => {
    if (!names.has(tool)) return null;
    try {
      return await callStudioTool(mynt, tool, args);
    } catch (err) {
      if (isAuthError(err)) throw err;
      return null;
    }
  };

  const [poolsReply, sponsorships, withdrawalsReply] = await Promise.all([read("list_pools"), access.builder ? read("list_my_sponsorships") : null, read("list_withdrawals")]);
  const pools = fromPools(poolsReply);
  const withdrawals = withdrawalsReply === null ? null : fromWithdrawals(withdrawalsReply);
  const sponsored = sponsorships === null ? null : fromSponsorships(sponsorships);
  // The builder's own pools: on a product of its firm (every pool needs an approved sponsorship of
  // one of the firm's products). list_pools also answers pools the user may see as a liquidity
  // provider, or every pool for an admin, so those are told apart by product.
  const own = (p: Pool) => (sponsored ? sponsored.productIds.has(p.productId) : !access.liquidityProvider);

  const data: LiquidityData = { supported: true, access };

  if (access.builder) {
    const healthReply = await read("list_product_health");
    const health = healthReply === null ? null : fromProductHealth(healthReply);
    const mine = pools.filter(own);
    const productNames = new Map((sponsored?.approved ?? []).map((s) => [s.productId, s.productName]));
    data.builder = {
      pools: mine.map((p) => ({ ...p, productName: productNames.get(p.productId) ?? null, queueLength: withdrawals ? queueLength(withdrawals, p.id) : null, health: health ? healthFor(health, p) : null })),
      proposable: names.has("create_pool") && sponsored ? sponsored.approved : null,
      withdrawalsShown: withdrawals !== null,
    };
  }

  if (access.liquidityProvider) {
    const [positionsReply, healthReply] = await Promise.all([read("list_my_positions"), read("list_pools_with_health")]);
    const positions = positionsReply === null ? [] : fromPositions(positionsReply);
    const held = new Set(positions.map((p) => p.poolId));
    const health = healthReply === null ? null : fromPoolsWithHealth(healthReply);
    // Pools open to commitments (approved, sandbox or cleared, not closed), and any the firm is
    // already in, whatever their state now. Never the user's own firm's pools.
    const open = pools.filter((p) => !(access.builder && own(p)) && (held.has(p.id) || (stageOf(p) !== "awaiting_approval" && stageOf(p) !== "uncleared" && p.status !== "closed")));
    const products = [...new Set(open.map((p) => p.productId))].slice(0, MAX_PRODUCTS);
    const described = new Map(
      await Promise.all(
        products.map(async (id) => {
          const r = (await read("get_product", { id })) as { name?: unknown; product_line?: unknown } | null;
          return [id, { name: typeof r?.name === "string" ? r.name : null, line: typeof r?.product_line === "string" ? r.product_line : null }] as const;
        }),
      ),
    );
    data.provider = {
      pools: open.map((p) => ({
        ...p,
        productName: described.get(p.productId)?.name ?? null,
        productLine: described.get(p.productId)?.line ?? null,
        queueLength: null,
        health: health?.get(p.id) ?? null,
      })),
      positions,
      // The firm's own requests: those in pools it holds a position in.
      withdrawals: (withdrawals ?? []).filter((w) => held.has(w.poolId)),
      canCommit: names.has("commit_to_pool"),
      canWithdraw: names.has("request_withdrawal"),
    };
  }
  return data;
}
