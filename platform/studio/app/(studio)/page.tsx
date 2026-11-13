"use client";

// Home: the dashboard of how the user's apps are doing (components/dashboard-view.tsx).
import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { DashboardView } from "@/components/dashboard-view";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspace-context";
import type { Dashboard } from "@/lib/dashboard";
import type { LinkedAccounts } from "@/lib/linked-accounts";

type State = { dashboard: Dashboard } | { error: string } | null;

export default function DashboardPage() {
  const [state, setState] = useState<State>(null);
  const [linked, setLinked] = useState<LinkedAccounts | null>(null);
  const { selected, loading } = useWorkspace();

  // The linked GitHub and wallet; read again when the user comes back (from linking one on the
  // identity provider's page) or returns to the tab.
  useEffect(() => {
    const load = async () => {
      const res = await fetch("/api/linked-accounts", { cache: "no-store" }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { linked?: LinkedAccounts } | null;
      if (data?.linked) setLinked(data.linked);
    };
    void load();
    const again = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", again);
    window.addEventListener("pageshow", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      window.removeEventListener("pageshow", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, []);

  // The selected workspace's dashboard; again whenever another workspace is picked.
  useEffect(() => {
    if (loading) return;
    let live = true;
    setState(null);
    (async () => {
      const res = await fetch(`/api/dashboard?workspace=${encodeURIComponent(selected.id)}`, { cache: "no-store" }).catch(() => null);
      if (res?.status === 401) {
        window.location.assign("/api/auth/login"); // the session ended meanwhile
        return;
      }
      const data = (await res?.json().catch(() => null)) as { dashboard?: Dashboard; message?: string } | null;
      if (!live) return;
      setState(res?.ok && data?.dashboard ? { dashboard: data.dashboard } : { error: data?.message ?? "Couldn't load the dashboard." });
    })();
    return () => {
      live = false;
    };
  }, [selected.id, loading]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SiteHeader title={`Dashboard · ${selected.name}`}>
        <Button asChild size="sm">
          <Link href="/new">
            <Plus />
            New app
          </Link>
        </Button>
      </SiteHeader>
      {state === null ? (
        <div className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-5 lg:p-6">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : "error" in state ? (
        <p role="alert" className="p-6 text-sm text-destructive">
          {state.error}
        </p>
      ) : (
        <DashboardView dashboard={state.dashboard} linked={linked} />
      )}
    </div>
  );
}
