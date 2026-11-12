"use client";

// Home: the dashboard of how the user's apps are doing (components/dashboard-view.tsx).
import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";

import { DashboardView } from "@/components/dashboard-view";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { Dashboard } from "@/lib/dashboard";

type State = { dashboard: Dashboard } | { error: string } | null;

export default function DashboardPage() {
  const [state, setState] = useState<State>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await fetch("/api/dashboard", { cache: "no-store" }).catch(() => null);
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
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SiteHeader title="Dashboard">
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
        <DashboardView dashboard={state.dashboard} />
      )}
    </div>
  );
}
