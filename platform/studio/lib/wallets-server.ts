import { createHash } from "node:crypto";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { fromLinkedAccounts } from "./linked-accounts";
import type { Session } from "./session-store";
import { callStudioTool, isAuthError, listMyntTools } from "./studio-server";
import { balancesFrom, CLUSTER, NO_WALLETS, walletsFrom, type EarnWallet, type EarnWallets } from "./wallets";

// Earn's wallets, read from Mynt as the signed-in user (lib/wallets.ts): the verified wallets
// linked to their sign-in and, where Mynt has get_wallet_balances, each Solana wallet's devnet
// balances. A balance Mynt can't give is null ("Not measured"), never 0.

// Whose list this is, for remembering the chosen wallet per user in the browser: a hash, so the
// browser never stores the user's id.
export const ownerOf = (session: Session) => createHash("sha256").update(`earn-wallet\n${session.userId ?? session.id}`).digest("base64url").slice(0, 22);

export async function loadEarnWallets(mynt: Client, session: Session, opts: { balances?: boolean; only?: string } = {}): Promise<EarnWallets> {
  const names = new Set((await listMyntTools(mynt)).map((t) => t.name));
  const treasury = { deposit: names.has("prepare_treasury_deposit"), withdraw: names.has("prepare_treasury_withdrawal"), status: names.has("get_treasury_tx_status") };
  const owner = ownerOf(session);
  if (!names.has("get_linked_accounts")) return { ...NO_WALLETS, owner, treasury };
  const reply = await callStudioTool(mynt, "get_linked_accounts");
  const linked = walletsFrom(reply);
  const balancesSupported = names.has("get_wallet_balances");
  const wallets: EarnWallet[] = await Promise.all(
    linked.map(async (w) => {
      if (!balancesSupported || w.chain !== "solana" || opts.balances === false || (opts.only && w.address !== opts.only)) return { ...w, balances: null };
      try {
        return { ...w, balances: balancesFrom(await callStudioTool(mynt, "get_wallet_balances", { address: w.address, cluster: CLUSTER })) };
      } catch (err) {
        if (isAuthError(err)) throw err;
        return { ...w, balances: null };
      }
    }),
  );
  return { supported: true, balancesSupported, owner, wallets, manageUrl: fromLinkedAccounts(reply).manageUrl, treasury };
}

// The wallet, only if it's one of the user's verified linked wallets as Mynt answers now.
export async function linkedWallet(mynt: Client, session: Session, address: string, opts: { balances?: boolean } = {}): Promise<EarnWallet | null> {
  const list = await loadEarnWallets(mynt, session, { ...opts, only: address });
  return list.wallets.find((w) => w.address === address) ?? null;
}
