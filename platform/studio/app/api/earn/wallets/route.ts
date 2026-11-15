import { sessionCanUseLiquidity } from "@/lib/liquidity-server";
import { asDeveloper, json } from "@/lib/studio-route";
import { loadEarnWallets } from "@/lib/wallets-server";

export const dynamic = "force-dynamic";

// Earn's wallet picker (the chat bar): the user's verified linked wallets with their live devnet
// balances, where to link more, and which treasury tools this Mynt offers (lib/wallets-server.ts).
// Before Mynt has get_linked_accounts it's "supported: false"; before get_wallet_balances, each
// wallet's balances are null.
export async function GET() {
  return asDeveloper("loading Earn's wallets", async (mynt, session) => json(await loadEarnWallets(mynt, session)), sessionCanUseLiquidity);
}
