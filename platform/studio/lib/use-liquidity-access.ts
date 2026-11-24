"use client";

// The signed-in user's roles as the studio uses them, read once per page load from
// /api/liquidity/access and shared: whether they're a developer (the studio's pages, New app,
// Licences, Audits, Settings), a builder or a liquidity provider (Earn, the dashboard's investor
// view), and an opaque hash of the user for remembering choices in this browser. Null until
// known; no roles if they can't be read, so nothing developer-only is fetched on a guess.
import { useEffect, useState } from "react";
import { NO_ACCESS, type LiquidityAccess } from "./liquidity";

// licenceProvider: Mynt's licence-provider role, which opens the Licences page's Agreements tab (apps' agreements with its firm).
// admin: a Mynt admin (the role Mynt gave the account, read from its whoami), who gets the sidebar's Platform admin badge (/platform).
export type StudioAccess = { developer: boolean; liquidity: LiquidityAccess; owner: string | null; licenceProvider?: boolean; admin?: boolean };
export const NO_STUDIO_ACCESS: StudioAccess = { developer: false, liquidity: NO_ACCESS, owner: null };

let pending: Promise<StudioAccess> | null = null;

function load(): Promise<StudioAccess> {
  pending ??= fetch("/api/liquidity/access", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b: { access?: Partial<LiquidityAccess>; developer?: boolean; licenceProvider?: boolean; admin?: boolean; owner?: string } | null) => ({
      developer: b?.developer === true,
      licenceProvider: b?.licenceProvider === true,
      admin: b?.admin === true,
      liquidity: { builder: b?.access?.builder === true, liquidityProvider: b?.access?.liquidityProvider === true },
      owner: typeof b?.owner === "string" ? b.owner : null,
    }))
    .catch(() => {
      pending = null;
      return NO_STUDIO_ACCESS;
    });
  return pending;
}

/** For the tests: forget what was read. */
export const resetStudioAccess = () => {
  pending = null;
};

export function useStudioAccess(enabled = true): StudioAccess | null {
  const [access, setAccess] = useState<StudioAccess | null>(null);
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

export function useLiquidityAccess(enabled = true): LiquidityAccess | null {
  return useStudioAccess(enabled)?.liquidity ?? null;
}
