"use client";

// Earn (/earn): the investing assistant in the studio's chat workspace, with Pools, My pools
// (builders) and My strategies on the right (components/earn-assistant.tsx).
// ?tab=pools|my-pools|my-strategies picks the right-hand tab; a table or My strategies opens the
// panel at once. Old links keep working: ?tab=opportunities is Pools showing all pools,
// ?tab=my-positions is Pools showing the pools invested in, ?tab=drafts is My strategies,
// ?tab=assistant and /liquidity too. The chat bar's
// wallet picker reads /api/earn/wallets; the chosen wallet is remembered per user in this browser
// and sent with every message (only its address: the server checks it's the user's). The same
// list's owner (a hash of the user) keys the past conversations kept in this browser.
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { askFetch } from "@/lib/ask-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EarnWorkspace, type EarnStatus } from "@/components/earn-assistant";
import type { ActionResult, LiquidityActions } from "@/components/earn-view";
import type { EarnWalletState, TreasuryActions } from "@/components/earn-wallet";
import { devnetWallets } from "@/lib/browser-wallet";
import { chosenWallet, rememberWallet, type EarnWallet, type EarnWallets, type Prepared, type TxStatus } from "@/lib/wallets";
import { NotReady } from "@/components/not-available";
import { reviveLiquidity, type LiquidityData } from "@/lib/liquidity";
import type { Loaded } from "@/lib/use-compliance";

async function post(path: string, body: unknown): Promise<ActionResult> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (res?.status === 401) {
    window.location.assign("/api/auth/login?next=/earn");
    return { error: "Please sign in again." };
  }
  const data = (await res?.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res?.ok) return { error: typeof data?.message === "string" ? data.message : "Couldn't reach Mynt. Please try again.", refused: res?.status === 422 };
  return { ok: true, reply: data?.pool ?? data?.commitment ?? data?.withdrawal ?? data?.correction ?? null };
}

async function postJson<T>(path: string, body: unknown): Promise<{ ok: true; body: T } | { error: string }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (res?.status === 401) {
    window.location.assign("/api/auth/login?next=/earn");
    return { error: "Please sign in again." };
  }
  const data = (await res?.json().catch(() => null)) as (T & { message?: unknown }) | null;
  if (!res?.ok || !data) return { error: typeof data?.message === "string" ? data.message : "Couldn't reach Mynt. Please try again." };
  return { ok: true, body: data };
}

const treasury: TreasuryActions = {
  prepare: async (input) => {
    const r = await postJson<{ prepared: Prepared }>("/api/earn/treasury/prepare", input);
    return "error" in r ? r : { prepared: r.body.prepared };
  },
  status: async (signature) => {
    const r = await postJson<TxStatus>("/api/earn/treasury/status", { signature });
    return "error" in r ? r : r.body;
  },
};

// The wallet picker's list, read on load and again when the user comes back to the tab (from
// linking a wallet on their account page) or after a transaction settles.
function useEarnWallets(): [EarnWallets | null, () => void] {
  const [list, setList] = useState<EarnWallets | null>(null);
  const load = useCallback(() => {
    void fetch("/api/earn/wallets", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: EarnWallets | null) => b && setList(b))
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    load();
    const again = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [load]);
  return [list, load];
}

export default function EarnPage() {
  const [state, setState] = useState<Loaded<LiquidityData>>({ kind: "loading" });
  const [tab, setTab] = useState<string | null>(null);
  const [thread, setThread] = useState<string | null>(null); // ?thread=: a chat picked in the sidebar's Search chats
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<EarnStatus>("loading");
  const [wallets, reloadWallets] = useEarnWallets();
  const [picked, setPicked] = useState<string | null>(null);
  const chosen: EarnWallet | null = useMemo(() => (wallets ? (wallets.wallets.find((w) => w.address === picked) ?? chosenWallet(wallets)) : null), [wallets, picked]);
  // The transport reads the chosen wallet when each message is sent, so it stays one transport.
  const chosenRef = useRef<EarnWallet | null>(null);
  chosenRef.current = chosen;
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({ api: "/api/earn", fetch: askFetch, body: () => ({ wallet: chosenRef.current ? { address: chosenRef.current.address } : null }) }), []);
  const chat = useChat<UIMessage>({ id: "studio-earn", transport });

  useEffect(() => {
    void fetch("/api/earn", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { enabled?: boolean } | null) => setStatus(b?.enabled ? "enabled" : "disabled"))
      .catch(() => setStatus("disabled"));
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/liquidity", { cache: "no-store" }).catch(() => null);
      if (res?.status === 401) return window.location.assign("/api/auth/login?next=/earn");
      const body = (await res?.json().catch(() => null)) as (LiquidityData & { message?: string }) | null;
      if (!live) return;
      const q = new URLSearchParams(window.location.search);
      setTab(q.get("tab"));
      setThread(q.get("thread"));
      if (!res?.ok || !body) return setState({ kind: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." });
      setState(body.supported === false ? { kind: "unsupported" } : { kind: "ready", data: reviveLiquidity(body) });
    })();
    return () => {
      live = false;
    };
  }, [tick]);

  // A confirmed on-chain transaction: read the positions again now and hand them back, so its
  // card can tell whether Mynt shows it yet. A failed read keeps what's on screen.
  const refreshPositions = useCallback(async (): Promise<LiquidityData | null> => {
    const res = await fetch("/api/liquidity", { cache: "no-store" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as LiquidityData | null;
    if (!res?.ok || !body || body.supported === false) return null;
    const data = reviveLiquidity(body);
    setState({ kind: "ready", data });
    return data;
  }, []);

  // After a change, read everything again (positions and queues move only on Mynt's side).
  const after = useCallback(async (p: Promise<ActionResult>) => {
    const r = await p;
    if ("ok" in r) setTimeout(() => setTick((t) => t + 1), 1500);
    return r;
  }, []);
  const actions: LiquidityActions = {
    propose: (input) => after(post("/api/liquidity/pools", input)),
    commit: (input) => after(post("/api/liquidity/commit", input)),
    withdraw: (input) => after(post("/api/liquidity/withdraw", input)),
    cancel: (id) => after(post(`/api/liquidity/withdrawals/${encodeURIComponent(id)}/cancel`, {})),
    respond: (id, answer) => after(post(`/api/liquidity/corrections/${encodeURIComponent(id)}`, answer)),
  };

  const wallet: EarnWalletState = {
    list: wallets,
    chosen,
    choose: (address) => {
      setPicked(address);
      rememberWallet(wallets?.owner ?? null, address);
    },
    treasury,
    browserWallets: () => devnetWallets(),
    onSettled: () => {
      reloadWallets();
      return refreshPositions();
    },
  };

  if (state.kind === "ready")
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <EarnWorkspace chat={chat} status={status} data={state.data} actions={actions} initialTab={tab} wallet={wallet} historyOwner={wallets?.owner ?? null} initialThread={thread} />
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex w-full flex-1 flex-col p-4 lg:p-6">
        <NotReady state={state} what="Earn" />
      </div>
    </div>
  );
}
