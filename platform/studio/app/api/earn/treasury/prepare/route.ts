import { z } from "zod";
import { fromPools, fromPositions } from "@/lib/liquidity";
import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, listMyntTools, MyntRefusedError } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { centsToUsdcBaseUnits, depositStanding, onDevnet, preparedFrom, SOLANA_ADDRESS, standingText, TREASURY_REFUSALS, treasuryRefusal, usdcText } from "@/lib/wallets";
import { linkedWallet } from "@/lib/wallets-server";

export const dynamic = "force-dynamic";

// How long a prepared request's key stays used: the same click sent twice prepares one transaction.
export const PREPARE_KEY_SECONDS = 10 * 60;

const amount = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Body = z
  .object({
    kind: z.enum(["deposit", "withdrawal"]),
    pool_id: z.string().uuid(),
    wallet: z.string().regex(SOLANA_ADDRESS),
    // A draft's amount in cents, or a typed USDC amount in base units (exactly one).
    amount_cents: amount.max(Number.MAX_SAFE_INTEGER / 10_000).optional(),
    amount_usdc_base_units: amount.optional(),
    // A withdrawal's deposit: the deposit record's address, from list_my_positions.
    deposit: z.string().regex(SOLANA_ADDRESS).optional(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
  })
  .refine((b) => (b.amount_cents === undefined) !== (b.amount_usdc_base_units === undefined))
  .refine((b) => b.kind === "deposit" || b.deposit);

// An on-chain treasury deposit or withdrawal, prepared by Mynt for the user to sign in their own
// browser wallet (prepare_treasury_deposit, prepare_treasury_withdrawal). Devnet only. Nothing is
// signed or sent here: the reply is Mynt's unsigned transaction and its own summary, which the page
// shows for the user to confirm before their wallet signs it. Checked first: the studio's own
// origin, a liquidity provider, a wallet that's one of the user's verified linked wallets, a pool
// whose treasury is on devnet, and for a withdrawal, a deposit of that wallet's in that pool that
// Mynt lists as available. Mynt's coded refusals come back in plain words.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Choose a pool, an amount and one of your linked Solana wallets (and, to withdraw, the deposit)." }, 400);
  const b = parsed.data;
  const tool = b.kind === "deposit" ? "prepare_treasury_deposit" : "prepare_treasury_withdrawal";
  const units = b.amount_usdc_base_units ?? Number(centsToUsdcBaseUnits(b.amount_cents!));
  if (!Number.isSafeInteger(units)) return json({ error: "bad_request", message: "That amount is too large." }, 400);

  return asDeveloper(
    `preparing a treasury ${b.kind}`,
    async (mynt, session) => {
      if (!sessionAccess(session).liquidityProvider) return json({ error: "not_liquidity_provider", message: TREASURY_REFUSALS.not_liquidity_provider }, 403);
      if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "On-chain deposits coming soon." }, 501);

      const wallet = await linkedWallet(mynt, session, b.wallet, { balances: false });
      if (!wallet || wallet.chain !== "solana") return json({ error: "wallet_not_linked", message: TREASURY_REFUSALS.wallet_not_linked }, 403);

      const pool = fromPools(await callStudioTool(mynt, "list_pools", {})).find((p) => p.id === b.pool_id);
      if (!pool) return json({ error: "no_pool", message: "That pool isn't open to you." }, 404);
      if (!pool.treasury) return json({ error: "not_on_chain", message: TREASURY_REFUSALS.not_on_chain }, 400);
      if (!onDevnet(pool.treasury)) return json({ error: "not_devnet", message: "On-chain deposits run on devnet only, and this pool's treasury isn't on devnet." }, 400);

      let args: Record<string, unknown>;
      if (b.kind === "deposit") {
        // The longest lock-in the user agreed to: the pool's terms as the page showed them.
        const lockIn = pool.treasury.lockInSeconds ?? (pool.lockInDays === null ? null : pool.lockInDays * 86_400);
        if (lockIn === null) return json({ error: "no_lock_in", message: "This pool's lock-in isn't set, so a deposit can't be prepared." }, 400);
        args = { pool_id: pool.id, wallet: wallet.address, amount_usdc_base_units: units, max_lock_in_seconds: lockIn };
      } else {
        const row = fromPositions(await callStudioTool(mynt, "list_my_positions", { pool_id: pool.id })).find((p) => p.poolId === pool.id && p.onChain && p.wallet === wallet.address);
        const dep = row?.chain?.deposits.find((d) => d.deposit === b.deposit);
        if (!dep) return json({ error: "deposit_not_found", message: TREASURY_REFUSALS.deposit_not_found }, 404);
        const standing = depositStanding(dep);
        if (standing.kind !== "available") return json({ error: standing.kind, message: `${standingText(standing)}: nothing can be withdrawn from this deposit now.` }, 400);
        if (BigInt(units) > standing.free) return json({ error: "too_much", message: `This deposit has ${usdcText(standing.free)} available to withdraw.` }, 400);
        if (pool.treasury.minRequest !== null && BigInt(units) < pool.treasury.minRequest) return json({ error: "below_min_request", message: `This pool's smallest withdrawal request is ${usdcText(pool.treasury.minRequest)}.` }, 400);
        const notice = pool.treasury.noticeSeconds ?? pool.noticePeriodDays * 86_400;
        args = { pool_id: pool.id, wallet: wallet.address, deposit: dep.deposit, amount_usdc_base_units: units, max_notice_seconds: notice };
      }

      // One prepare per click: the same key again is refused rather than preparing a second one.
      const who = session.userId ?? session.id;
      const release = await sessionStore().claim("earn-prepare", `${who}\n${b.idempotency_key}`, PREPARE_KEY_SECONDS);
      if (!release) return json({ error: "duplicate", message: "This request was already prepared. Start again to prepare a new one." }, 409);
      try {
        const prepared = preparedFrom(await callStudioTool(mynt, tool, args), wallet.address);
        if ("error" in prepared) {
          await release().catch(() => undefined);
          return json({ error: "bad_transaction", message: prepared.error }, 502);
        }
        return json({ ok: true, prepared });
      } catch (err) {
        await release().catch(() => undefined);
        const coded = err instanceof MyntRefusedError ? treasuryRefusal(err.raw) : null;
        if (coded) return json({ error: coded.code, message: coded.message }, 422);
        throw err;
      }
    },
    sessionCanUseLiquidity,
  );
}
