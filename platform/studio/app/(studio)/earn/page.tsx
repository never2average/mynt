"use client";

// Earn (/earn): the investing assistant first, then Opportunities, My positions and, for
// builders, My pools (components/earn-view.tsx, components/earn-assistant.tsx).
// ?tab=assistant|opportunities|my-positions|my-pools picks the first tab.
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { EarnAssistant, type EarnStatus } from "@/components/earn-assistant";
import { EarnView, type ActionResult, type LiquidityActions } from "@/components/earn-view";
import { NotReady } from "@/components/not-available";
import type { LiquidityData } from "@/lib/liquidity";
import type { Loaded } from "@/lib/use-compliance";

async function post(path: string, body: unknown): Promise<ActionResult> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (res?.status === 401) {
    window.location.assign("/api/auth/login?next=/earn");
    return { error: "Please sign in again." };
  }
  const data = (await res?.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res?.ok) return { error: typeof data?.message === "string" ? data.message : "Couldn't reach Mynt. Please try again.", refused: res?.status === 422 };
  return { ok: true, reply: data?.pool ?? data?.commitment ?? data?.withdrawal ?? null };
}

export default function EarnPage() {
  const [state, setState] = useState<Loaded<LiquidityData>>({ kind: "loading" });
  const [tab, setTab] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState<EarnStatus>("loading");
  const transport = useMemo(() => new DefaultChatTransport<UIMessage>({ api: "/api/earn" }), []);
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
      setTab(new URLSearchParams(window.location.search).get("tab"));
      if (!res?.ok || !body) return setState({ kind: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." });
      setState(body.supported === false ? { kind: "unsupported" } : { kind: "ready", data: body });
    })();
    return () => {
      live = false;
    };
  }, [tick]);

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
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex w-full flex-1 flex-col p-4 lg:p-6">
        {state.kind === "ready" ? (
          <EarnView data={state.data} actions={actions} initialTab={tab} assistant={<EarnAssistant chat={chat} status={status} data={state.data} actions={actions} />} />
        ) : (
          <NotReady state={state} what="Earn" />
        )}
      </div>
    </div>
  );
}
