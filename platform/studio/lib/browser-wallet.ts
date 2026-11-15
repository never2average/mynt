"use client";

// The user's own browser wallet, through the Wallet Standard (@wallet-standard/app's getWallets,
// with the Solana features from @solana/wallet-standard-features): the wallets installed in this
// browser that can sign and send a transaction on Solana devnet. The studio never holds a key: it
// hands Mynt's unsigned transaction to the wallet untouched, the wallet asks the user to approve
// it, signs it and sends it, and the studio gets back only the signature. Called only from the
// user's own click, never from the assistant.
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, type StandardConnectFeature } from "@wallet-standard/features";
import { SolanaSignAndSendTransaction, type SolanaSignAndSendTransactionFeature } from "@solana/wallet-standard-features";
import bs58 from "bs58";
import { DEVNET_CHAIN } from "./wallets";
import { shortAddress } from "./linked-accounts";

// What the page needs of a wallet: its name and icon, and the two features it uses.
export type BrowserWallet = Wallet;

export const canSignOnDevnet = (w: Wallet) =>
  w.chains.includes(DEVNET_CHAIN) && SolanaSignAndSendTransaction in w.features && StandardConnect in w.features;

// The wallets in this browser that can do it (none on the server, or before any registers).
export function devnetWallets(source: () => readonly Wallet[] = () => (typeof window === "undefined" ? [] : getWallets().get())): Wallet[] {
  try {
    return source().filter(canSignOnDevnet);
  } catch {
    return [];
  }
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export type SignResult = { signature: string } | { error: string; mismatch?: boolean };

// Connects the wallet (it asks the user if it hasn't before), checks that the account it gives is
// exactly the linked wallet the user chose, and only then asks it to sign and send. Anything else
// stops before signing, with why.
export async function signAndSend(wallet: Wallet, expected: string, transactionBase64: string): Promise<SignResult> {
  let accounts: readonly WalletAccount[];
  try {
    const connect = (wallet.features as StandardConnectFeature)[StandardConnect];
    accounts = (await connect.connect()).accounts;
  } catch {
    return { error: `${wallet.name} didn't connect. Nothing was signed.` };
  }
  const account = accounts.find((a) => a.address === expected);
  if (!account) {
    const got = accounts[0]?.address;
    return {
      mismatch: true,
      error: `${wallet.name} is connected to ${got ? shortAddress(got) : "no account"}, not your chosen wallet ${shortAddress(expected)}. Switch to ${shortAddress(expected)} in ${wallet.name}, or choose the wallet you're using in the chat bar. Nothing was signed.`,
    };
  }
  if (account.chains.length && !account.chains.includes(DEVNET_CHAIN)) return { error: `${wallet.name} can't use this account on devnet. Nothing was signed.` };
  try {
    const feature = (wallet.features as SolanaSignAndSendTransactionFeature)[SolanaSignAndSendTransaction];
    const [out] = await feature.signAndSendTransaction({ account, chain: DEVNET_CHAIN, transaction: base64ToBytes(transactionBase64) });
    if (!out?.signature?.length) return { error: `${wallet.name} didn't return a signature.` };
    return { signature: bs58.encode(out.signature) };
  } catch (err) {
    const msg = err instanceof Error && err.message ? err.message.slice(0, 200) : "";
    return { error: `${wallet.name} didn't send it${msg ? `: ${msg}` : ""}. If you declined, nothing was sent.` };
  }
}
