"use client";

// The signed-in user's liquidity roles (builder, liquidity provider), read once per page load
// and shared by the sidebar and the header's wallet control. Null until known; no roles if it can't be read.
import { useEffect, useState } from "react";
import { NO_ACCESS, type LiquidityAccess } from "./liquidity";

let pending: Promise<LiquidityAccess> | null = null;

function load(): Promise<LiquidityAccess> {
  pending ??= fetch("/api/liquidity/access", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { access?: Partial<LiquidityAccess> } | null) => ({ builder: b?.access?.builder === true, liquidityProvider: b?.access?.liquidityProvider === true }))
    .catch(() => {
      pending = null;
      return NO_ACCESS;
    });
  return pending;
}

export function useLiquidityAccess(enabled = true): LiquidityAccess | null {
  const [access, setAccess] = useState<LiquidityAccess | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void load().then((a) => live && setAccess(a));
    return () => {
      live = false;
    };
  }, [enabled]);
  return access;
}
