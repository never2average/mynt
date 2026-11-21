"use client";

// The user's own browser wallet, through the Wallet Standard (@wallet-standard/app's getWallets,
// with the Solana features from @solana/wallet-standard-features): the wallets installed in this
// browser that can sign and send a transaction on Solana devnet. The studio never holds a key: it
// hands Mynt's unsigned transaction to the wallet untouched, the wallet asks the user to approve
// it, signs it and sends it, and the studio gets back only the signature. Called only from the
// user's own click, never from the assistant.
import { useCallback, useEffect, useRef, useState } from "react";
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { StandardConnect, StandardEvents, type StandardConnectFeature, type StandardEventsFeature } from "@wallet-standard/features";
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

// ---- naming the wallet app ----

// The wallet app as it names itself: its own name and icon from its Wallet Standard registration
// (the icon only when it's an image data URI, as the standard requires). Mynt draws no brand marks.
export type WalletApp = { name: string; icon: string | null };
export const appOf = (w: Wallet): WalletApp => ({ name: w.name, icon: typeof w.icon === "string" && w.icon.startsWith("data:image/") ? w.icon : null });

// The app holding `address`: a detected wallet that has connected that account to this page.
// Null when none has (a linked wallet with no known app shows its short address only).
export function walletAppFor(address: string, wallets: readonly Wallet[]): WalletApp | null {
  const w = wallets.find((x) => x.accounts.some((a) => a.address === address));
  return w ? appOf(w) : null;
}

// Connect: the wallet asks the user to approve this page, and then its accounts are known (so a
// linked wallet shows the app's name). Nothing is signed. Only from the user's own click.
export async function connectWallet(wallet: Wallet): Promise<{ accounts: string[] } | { error: string }> {
  try {
    const connect = (wallet.features as StandardConnectFeature)[StandardConnect];
    return { accounts: (await connect.connect()).accounts.map((a) => a.address) };
  } catch {
    return { error: `${wallet.name} didn't connect.` };
  }
}

// The detected wallets, kept current as wallets register, unregister or change accounts. Empty on
// the server and on the first render (so the page hydrates the same), read once mounted.
export function useBrowserWallets(read: () => Wallet[] = devnetWallets): [Wallet[], () => void] {
  const [list, setList] = useState<Wallet[]>([]);
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  const refresh = useCallback(() => setList(readRef.current()), []);
  useEffect(() => {
    let watching: (() => void)[] = [];
    const watch = () => {
      watching.forEach((off) => off());
      watching = readRef.current().flatMap((w) => {
        const events = (w.features as Partial<StandardEventsFeature>)[StandardEvents];
        try {
          return events ? [events.on("change", refresh)] : [];
        } catch {
          return [];
        }
      });
    };
    const again = () => {
      refresh();
      watch();
    };
    let offs: (() => void)[] = [];
    try {
      if (typeof window !== "undefined") {
        const api = getWallets();
        offs = [api.on("register", again), api.on("unregister", again)];
      }
    } catch {
      // No Wallet Standard registry here: the list stays as first read.
    }
    again();
    return () => {
      offs.forEach((off) => off());
      watching.forEach((off) => off());
    };
  }, [refresh]);
  return [list, refresh];
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
