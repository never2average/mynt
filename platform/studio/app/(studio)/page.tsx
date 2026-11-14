"use client";

// Home: the dashboard of how the user's apps are doing, as a P&L (components/dashboard-view.tsx).
import { useEffect, useState } from "react";

import { DashboardView } from "@/components/dashboard-view";
import { InvitationsBanner } from "@/components/invitations";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspace-context";
import type { Dashboard } from "@/lib/dashboard";
import type { Granularity, Pnl, Range } from "@/lib/pnl";
import { useLinkedAccounts } from "@/lib/use-linked-accounts";
import type { StagesData } from "@/components/dashboard-panels";
import type { AttentionItem } from "@/lib/attention";
import type { AuditEvent } from "@/lib/compliance";
import { useComplianceData } from "@/lib/use-compliance";
import { useRepositories } from "@/components/repositories";

type State = { dashboard: Dashboard } | { unavailable: string } | { error: string } | null;

// What each lower card reads from its route's answer (stable, for useComplianceData).
const pickAttention = (b: Record<string, unknown>) => (Array.isArray(b.items) ? (b.items as AttentionItem[]) : undefined);
const pickStages = (b: Record<string, unknown>) => (Array.isArray(b.apps) ? ({ checks: b.checks === true, apps: b.apps } as StagesData) : undefined);
// The route has already read Mynt's answer (lib/pnl.ts fromPnl).
const pickPnl = (b: Record<string, unknown>) => (Array.isArray((b.pnl as Pnl | undefined)?.series) ? (b.pnl as Pnl) : undefined);
const pickActivity = (b: Record<string, unknown>) => (b.page as { events?: AuditEvent[] } | undefined)?.events;

export default function DashboardPage() {
  const [state, setState] = useState<State>(null);
  const { state: attention } = useComplianceData("/api/attention", pickAttention);
  const { state: stages, reload: reloadStages } = useComplianceData("/api/stages", pickStages);
  const { state: activity } = useComplianceData("/api/audit", pickActivity);
  const { state: repos, reload: reloadRepos } = useRepositories();

  // A promotion elsewhere moves apps between stages.
  useEffect(() => {
    window.addEventListener("adorable:projects-updated", reloadStages);
    return () => window.removeEventListener("adorable:projects-updated", reloadStages);
  }, [reloadStages]);
  const linked = useLinkedAccounts();
  const { selected, loading, invitations, answerInvitation } = useWorkspace();

  // The P&L: per month or week, over the last 3, 6 or 12 (read again when either changes).
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [periods, setPeriods] = useState<Range>(6);
  const { state: pnl } = useComplianceData(`/api/pnl?granularity=${granularity}&periods=${periods}`, pickPnl);

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
      const data = (await res?.json().catch(() => null)) as { dashboard?: Dashboard; unavailable?: string; message?: string } | null;
      if (!live) return;
      setState(
        res?.ok && data?.dashboard
          ? { dashboard: data.dashboard }
          : res?.ok && data?.unavailable
            ? { unavailable: data.unavailable }
            : { error: data?.message ?? "Couldn't load the dashboard." },
      );
    })();
    return () => {
      live = false;
    };
  }, [selected.id, loading]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <InvitationsBanner invitations={invitations} onAnswer={answerInvitation} />
      {state === null ? (
        <div className="flex flex-col gap-4 p-4 lg:p-6">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : "unavailable" in state ? (
        <p className="p-6 text-sm text-muted-foreground">{state.unavailable}</p>
      ) : "error" in state ? (
        <p role="alert" className="p-6 text-sm text-destructive">
          {state.error}
        </p>
      ) : (
        <DashboardView dashboard={state.dashboard} linked={linked} attention={attention} stages={stages} activity={activity} repos={repos} onReposChanged={reloadRepos}
          pnl={pnl}
          granularity={granularity}
          periods={periods}
          onGranularity={setGranularity}
          onPeriods={setPeriods}
        />
      )}
    </div>
  );
}
