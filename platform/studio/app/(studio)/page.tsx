"use client";

// Home: the dashboard. Builders see how their apps are doing, as a P&L
// (components/dashboard-view.tsx); liquidity providers see their portfolio
// (components/investor-view.tsx). Someone with both roles switches between them at the top; the
// choice is remembered per user in this browser (lib/investor.ts).
import { useCallback, useEffect, useState } from "react";

import { DashboardView } from "@/components/dashboard-view";
import { InvitationsBanner } from "@/components/invitations";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspace } from "@/components/workspace-context";
import type { Dashboard } from "@/lib/dashboard";
import type { Granularity, Pnl, Range } from "@/lib/pnl";
import type { StagesData } from "@/components/dashboard-panels";
import type { AttentionItem } from "@/lib/attention";
import type { AuditEvent } from "@/lib/compliance";
import { useComplianceData } from "@/lib/use-compliance";
import { useRepositories } from "@/components/repositories";
import { InvestorView } from "@/components/investor-view";
import { ModeSwitch } from "@/components/mode-switch";
import type { AuditRow } from "@/lib/audit-classes";
import { modesFor, rememberedMode, rememberMode, type DashboardMode } from "@/lib/investor";
import { NO_ACCESS, type LiquidityAccess, type LiquidityData } from "@/lib/liquidity";
import type { Loaded } from "@/lib/use-compliance";
import type { EarnWallets } from "@/lib/wallets";

type State = { dashboard: Dashboard } | { unavailable: string } | { error: string } | null;

// What each lower card reads from its route's answer (stable, for useComplianceData).
const pickAttention = (b: Record<string, unknown>) => (Array.isArray(b.items) ? (b.items as AttentionItem[]) : undefined);
const pickStages = (b: Record<string, unknown>) => (Array.isArray(b.apps) ? ({ checks: b.checks === true, apps: b.apps } as StagesData) : undefined);
// The route has already read Mynt's answer (lib/pnl.ts fromPnl).
const pickPnl = (b: Record<string, unknown>) => (Array.isArray((b.pnl as Pnl | undefined)?.series) ? (b.pnl as Pnl) : undefined);
const pickActivity = (b: Record<string, unknown>) => (b.page as { events?: AuditEvent[] } | undefined)?.events;

function BuilderDashboard() {
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
  const { selected, loading } = useWorkspace();

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
    <>
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
        <DashboardView dashboard={state.dashboard} attention={attention} stages={stages} activity={activity} repos={repos} onReposChanged={reloadRepos}
          pnl={pnl}
          granularity={granularity}
          periods={periods}
          onGranularity={setGranularity}
          onPeriods={setPeriods}
        />
      )}
    </>
  );
}

// ---- the investor view ----

const pickFinancial = (b: Record<string, unknown>) => (b.classes === true && Array.isArray((b.page as { rows?: unknown } | undefined)?.rows) ? ((b.page as { rows: AuditRow[] }).rows) : undefined);

/** A plain GET of one of the studio's own routes, as a Loaded state. */
function useRead<T>(path: string, pick: (b: Record<string, unknown>) => T | undefined): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetch(path, { cache: "no-store" }).catch(() => null);
      if (res?.status === 401) return window.location.assign("/api/auth/login");
      const body = (await res?.json().catch(() => null)) as Record<string, unknown> | null;
      if (!live) return;
      if (!res?.ok || !body) return setState({ kind: "error", message: (body?.message as string) ?? "Couldn't reach Mynt. Please try again." });
      if (body.supported === false) return setState({ kind: "unsupported" });
      const data = pick(body);
      setState(data === undefined ? { kind: "unsupported" } : { kind: "ready", data });
    })();
    return () => {
      live = false;
    };
  }, [path, pick]);
  return state;
}
const pickLiquidity = (b: Record<string, unknown>) => b as unknown as LiquidityData;
const pickWallets = (b: Record<string, unknown>) => b as unknown as EarnWallets;

function InvestorDashboard() {
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [periods, setPeriods] = useState<Range>(6);
  const liquidity = useRead("/api/liquidity", pickLiquidity);
  // Earn's wallets route answers "supported: false" itself before Mynt has linked accounts.
  const walletsRaw = useRead("/api/earn/wallets", pickWallets);
  const { state: attention } = useComplianceData("/api/attention", pickAttention);
  // Only the financial class: an unclassified trail isn't shown here as if it were.
  const { state: activity } = useComplianceData("/api/audit?class=financial", pickFinancial);
  return (
    <InvestorView
      liquidity={liquidity}
      wallets={walletsRaw}
      activity={activity}
      attention={attention}
      granularity={granularity}
      periods={periods}
      onGranularity={setGranularity}
      onPeriods={setPeriods}
    />
  );
}

// ---- the page ----

function useDashboardAccess(): { access: LiquidityAccess | null; owner: string | null } {
  const [value, setValue] = useState<{ access: LiquidityAccess | null; owner: string | null }>({ access: null, owner: null });
  useEffect(() => {
    let live = true;
    void fetch("/api/liquidity/access", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { access?: Partial<LiquidityAccess>; owner?: string } | null) => {
        if (live) setValue({ access: b?.access ? { builder: b.access.builder === true, liquidityProvider: b.access.liquidityProvider === true } : NO_ACCESS, owner: b?.owner ?? null });
      })
      .catch(() => live && setValue({ access: NO_ACCESS, owner: null }));
    return () => {
      live = false;
    };
  }, []);
  return value;
}

export default function DashboardPage() {
  const { invitations, answerInvitation } = useWorkspace();
  const { access, owner } = useDashboardAccess();
  const modes = modesFor(access);
  const [mode, setMode] = useState<DashboardMode | null>(null);
  useEffect(() => {
    if (access) setMode(rememberedMode(modesFor(access), owner));
  }, [access, owner]);
  const pick = useCallback(
    (m: DashboardMode) => {
      setMode(m);
      rememberMode(m, owner);
    },
    [owner],
  );
  const shown = mode && modes.includes(mode) ? mode : null;

  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <InvitationsBanner invitations={invitations} onAnswer={answerInvitation} />
      {modes.length > 1 && shown && (
        <div className="px-4 pt-4 lg:px-6">
          <ModeSwitch modes={modes} mode={shown} onMode={pick} />
        </div>
      )}
      {shown === null ? (
        <div className="flex flex-col gap-4 p-4 lg:p-6">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : shown === "investor" ? (
        <div className="flex flex-1 flex-col p-4 lg:p-6">
          <InvestorDashboard />
        </div>
      ) : (
        <BuilderDashboard />
      )}
    </div>
  );
}
