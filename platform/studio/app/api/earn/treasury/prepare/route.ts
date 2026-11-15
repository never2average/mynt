import { z } from "zod";
import { fromPools, fromPositions } from "@/lib/liquidity";
import { sessionAccess, sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { sessionStore } from "@/lib/session-store";
import { callStudioTool, listMyntTools } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { centsToUsdcBaseUnits, onDevnet, preparedFrom, SOLANA_ADDRESS } from "@/lib/wallets";
import { linkedWallet } from "@/lib/wallets-server";

export const dynamic = "force-dynamic";

// How long a prepared request's key stays used: the same click sent twice prepares one transaction.
export const PREPARE_KEY_SECONDS = 10 * 60;

const Body = z.object({
  kind: z.enum(["deposit", "withdrawal"]),
  pool_id: z.string().uuid(),
  wallet: z.string().regex(SOLANA_ADDRESS),
  amount_cents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER / 10_000),
  idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,200}$/),
});

// An on-chain treasury deposit or withdrawal, prepared by Mynt for the user to sign in their own
// browser wallet (prepare_treasury_deposit, prepare_treasury_withdrawal). Devnet only. Nothing is
// signed or sent here: the reply is Mynt's unsigned transaction and its own summary, which the page
// shows for the user to confirm before their wallet signs it. Checked first: the studio's own
// origin, a liquidity provider, a wallet that's one of the user's verified linked wallets, a pool
// whose treasury is on devnet, and (for a withdrawal) an on-chain position Mynt lists as theirs.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "Choose a pool, an amount and one of your linked Solana wallets." }, 400);
  const b = parsed.data;
  const tool = b.kind === "deposit" ? "prepare_treasury_deposit" : "prepare_treasury_withdrawal";

  return asDeveloper(
    `preparing a treasury ${b.kind}`,
    async (mynt, session) => {
      if (!sessionAccess(session).liquidityProvider) return json({ error: "not_liquidity_provider", message: "Only a liquidity provider can deposit to or withdraw from a pool." }, 403);
      if (!(await listMyntTools(mynt)).some((t) => t.name === tool)) return json({ error: "unsupported", message: "On-chain deposits coming soon." }, 501);

      const wallet = await linkedWallet(mynt, session, b.wallet, { balances: false });
      if (!wallet || wallet.chain !== "solana") return json({ error: "wallet_not_linked", message: "That wallet isn't one of your verified linked Solana wallets. Link it on your account page first." }, 403);

      const pool = fromPools(await callStudioTool(mynt, "list_pools", {})).find((p) => p.id === b.pool_id);
      if (!pool) return json({ error: "no_pool", message: "That pool isn't open to you." }, 404);
      if (!pool.treasury) return json({ error: "not_on_chain", message: "This pool moves money on its approved rails, not on-chain." }, 400);
      if (!onDevnet(pool.treasury)) return json({ error: "not_devnet", message: "On-chain deposits run on devnet only, and this pool's treasury isn't on devnet." }, 400);

      let args: Record<string, unknown>;
      const amount = Number(centsToUsdcBaseUnits(b.amount_cents));
      if (!Number.isSafeInteger(amount)) return json({ error: "bad_request", message: "That amount is too large." }, 400);
      if (b.kind === "deposit") {
        // The longest lock-in the user agreed to: the pool's terms as the page showed them.
        const lockIn = pool.treasury.lockInSeconds ?? (pool.lockInDays === null ? null : pool.lockInDays * 86_400);
        if (lockIn === null) return json({ error: "no_lock_in", message: "This pool's lock-in isn't set, so a deposit can't be prepared." }, 400);
        args = { pool_id: pool.id, wallet: wallet.address, amount_usdc_base_units: amount, max_lock_in_seconds: lockIn };
      } else {
        const position = fromPositions(await callStudioTool(mynt, "list_my_positions", { pool_id: pool.id })).find((p) => p.poolId === pool.id && p.onChain);
        if (!position?.deposit) return json({ error: "no_deposit", message: "Mynt lists no on-chain deposit of yours in this pool to withdraw from." }, 404);
        if (b.amount_cents > position.availableCents) return json({ error: "too_much", message: "That's more than is available to withdraw from this pool right now." }, 400);
        const notice = pool.treasury.noticeSeconds ?? pool.noticePeriodDays * 86_400;
        args = { pool_id: pool.id, wallet: wallet.address, deposit: position.deposit, amount_usdc_base_units: amount, max_notice_seconds: notice };
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
        throw err;
      }
    },
    sessionCanUseLiquidity,
  );
}
