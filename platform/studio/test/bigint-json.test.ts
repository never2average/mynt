import { describe, expect, it } from "vitest";

import { reviveLiquidity, type LiquidityData } from "@/lib/liquidity";
import { json } from "@/lib/studio-route";

// The admin's Earn page 502'd: /api/liquidity's reply carried on-chain amounts as bigints, which
// JSON.stringify can't serialize ("Do not know how to serialize a BigInt").
describe("bigint amounts over JSON", () => {
  const chain = {
    wallet: "Wallet111",
    principal: 12_000_000n,
    deposited: 12_000_000n,
    paid: 0n,
    queued: 1_000_000n,
    availableToRequest: 9_007_199_254_740_993n, // above 2^53: must stay exact
    deposits: [{ deposit: "Dep111", seq: "1", amount: 12_000_000n, remaining: 12_000_000n, queued: 1_000_000n, settledAt: null, reviewUntil: null, unlocksAt: null, lockInSeconds: 600, unlocked: false, rejected: false, signature: "sig" }],
    requests: [{ address: "Req111", deposit: "Dep111", seq: "1", amount: 1_000_000n, remaining: 1_000_000n, paid: 0n, payableAt: null, status: "open", signature: "sig2" }],
  };
  const data = { supported: true, access: { builder: false, liquidityProvider: true }, provider: { pools: [], positions: [{ poolId: "p", onChain: true, chain }], withdrawals: [], canCommit: true, canWithdraw: true } } as unknown as LiquidityData;

  it("a route reply with bigints serializes them as decimal strings", async () => {
    const res = json(data);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.provider.positions[0].chain.availableToRequest).toBe("9007199254740993");
    expect(body.provider.positions[0].chain.deposits[0].amount).toBe("12000000");
  });

  it("the browser turns them back into the exact bigints", async () => {
    const body = await json(data).json();
    const revived = reviveLiquidity(body as LiquidityData);
    const c = revived.provider!.positions[0].chain!;
    expect(c.availableToRequest).toBe(9_007_199_254_740_993n);
    expect(c.principal).toBe(12_000_000n);
    expect(c.deposits[0].remaining - c.deposits[0].queued).toBe(11_000_000n);
    expect(c.requests[0].paid).toBe(0n);
  });

  it("leaves data without on-chain positions alone", () => {
    const d = { supported: true, access: { builder: true, liquidityProvider: false } } as unknown as LiquidityData;
    expect(reviveLiquidity(d)).toBe(d);
    expect(reviveLiquidity(null)).toBeNull();
  });
});
