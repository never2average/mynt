import { z } from "zod";
import { sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { fromOwnOrigin } from "@/lib/session";
import { callStudioTool, listMyntTools, MyntRefusedError } from "@/lib/studio-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { SIGNATURE, treasuryRefusal, txStatusFrom } from "@/lib/wallets";

export const dynamic = "force-dynamic";

const Body = z.object({ signature: z.string().regex(SIGNATURE) });

// Where a treasury transaction the user's wallet sent stands (get_treasury_tx_status): Mynt's
// not_found, processed, confirmed, finalized or failed, as pending, confirmed or failed (with the
// stage). The page polls it after signing, then reads the positions again.
export async function POST(req: Request) {
  if (!fromOwnOrigin(req)) return json({ error: "forbidden" }, 403);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "bad_request", message: "That isn't a transaction signature." }, 400);
  return asDeveloper(
    "reading a treasury transaction",
    async (mynt) => {
      if (!(await listMyntTools(mynt)).some((t) => t.name === "get_treasury_tx_status")) return json({ error: "unsupported", message: "Mynt can't report on-chain transactions yet." }, 501);
      let reply: unknown;
      try {
        reply = await callStudioTool(mynt, "get_treasury_tx_status", { signature: parsed.data.signature });
      } catch (err) {
        const coded = err instanceof MyntRefusedError ? treasuryRefusal(err.raw) : null;
        if (coded) return json({ error: coded.code, message: coded.message }, 422);
        throw err;
      }
      const status = txStatusFrom(reply);
      if (!status) return json({ error: "bad_status", message: "Mynt's answer wasn't a transaction status." }, 502);
      return json(status);
    },
    sessionCanUseLiquidity,
  );
}
