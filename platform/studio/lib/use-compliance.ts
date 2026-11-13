"use client";

// Loads a compliance page's data for the selected workspace, again whenever another is picked.
import { useCallback, useEffect, useState } from "react";
import { useWorkspace } from "@/components/workspace-context";

export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "unsupported" } // this Mynt doesn't have the data yet
  | { kind: "unavailable"; message: string } // not scoped to this shared workspace yet
  | { kind: "error"; message: string }
  | { kind: "ready"; data: T };

export function useComplianceData<T>(path: string, pick: (body: Record<string, unknown>) => T | undefined): { state: Loaded<T>; reload: () => void } {
  const { selected, loading } = useWorkspace();
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (loading) return;
    let live = true;
    setState({ kind: "loading" });
    (async () => {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${path}${sep}workspace=${encodeURIComponent(selected.id)}`, { cache: "no-store" }).catch(() => null);
      if (res?.status === 401) {
        window.location.assign("/api/auth/login");
        return;
      }
      const body = (await res?.json().catch(() => null)) as Record<string, unknown> | null;
      if (!live) return;
      if (!res?.ok || !body) return setState({ kind: "error", message: (body?.message as string) ?? "Couldn't reach Mynt. Please try again." });
      if (body.supported === false) return setState({ kind: "unsupported" });
      if (typeof body.unavailable === "string") return setState({ kind: "unavailable", message: body.unavailable });
      const data = pick(body);
      setState(data === undefined ? { kind: "error", message: "Mynt's answer wasn't readable." } : { kind: "ready", data });
    })();
    return () => {
      live = false;
    };
  }, [path, pick, selected.id, loading, tick]);

  return { state, reload };
}
