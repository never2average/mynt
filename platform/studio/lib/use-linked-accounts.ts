"use client";

// The accounts linked to the user's sign-in (/api/linked-accounts), shared by the header's
// wallet control and the dashboard's workspace facts. Read once per page load and again when the
// user comes back to the tab (from linking one on the identity provider's page). Null until known.
import { useEffect, useState } from "react";
import type { LinkedAccounts } from "./linked-accounts";

let pending: Promise<LinkedAccounts | null> | null = null;
const listeners = new Set<(l: LinkedAccounts | null) => void>();

function load(fresh = false): Promise<LinkedAccounts | null> {
  if (fresh || !pending)
    pending = fetch("/api/linked-accounts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { linked?: LinkedAccounts } | null) => b?.linked ?? null)
      .catch(() => null)
      .then((l) => {
        if (!l) pending = null; // not read: try again next time rather than remember a failure
        listeners.forEach((f) => f(l));
        return l;
      });
  return pending;
}

export function useLinkedAccounts(): LinkedAccounts | null {
  const [linked, setLinked] = useState<LinkedAccounts | null>(null);
  useEffect(() => {
    let live = true;
    const set = (l: LinkedAccounts | null) => live && l && setLinked(l);
    listeners.add(set);
    void load().then(set);
    const again = () => {
      if (document.visibilityState === "visible") void load(true);
    };
    window.addEventListener("focus", again);
    window.addEventListener("pageshow", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      live = false;
      listeners.delete(set);
      window.removeEventListener("focus", again);
      window.removeEventListener("pageshow", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);
  return linked;
}
