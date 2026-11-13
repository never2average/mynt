"use client";

// Members of the selected workspace (from the switcher's menu).
import { useCallback, useEffect, useMemo, useState } from "react";

import { MembersView, type MembersActions, type MembersData } from "@/components/members-view";
import { SiteHeader } from "@/components/site-header";
import { useWorkspace } from "@/components/workspace-context";

export default function MembersPage() {
  const { selected, loading } = useWorkspace();
  const [data, setData] = useState<MembersData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const base = `/api/workspaces/${encodeURIComponent(selected.id)}/members`;

  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as (MembersData & { message?: string }) | null;
    if (res?.ok && body) {
      setData(body);
      setError(null);
    } else setError(body?.message ?? "Couldn't load the members.");
  }, [base]);

  useEffect(() => {
    if (loading) return;
    setData(null);
    void load();
  }, [load, loading]);

  const actions: MembersActions = useMemo(() => {
    const send = async (method: string, payload: unknown) => {
      const res = await fetch(base, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { message?: string } | null;
      if (!res?.ok) return body?.message ?? "That didn't work. Please try again.";
      await load();
      return null;
    };
    return {
      invite: (email, role) => send("POST", { email, role }),
      changeRole: (user_id, role) => send("PATCH", { user_id, role }),
      remove: (user_id) => send("DELETE", { user_id }),
      revoke: (invite_id) => send("DELETE", { invite_id }),
    };
  }, [base, load]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <SiteHeader title={`Members · ${selected.name}`} />
      <div className="mx-auto w-full max-w-4xl p-4 lg:p-6">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : data ? (
          <MembersView workspace={selected} data={data} actions={actions} />
        ) : (
          <p className="text-sm text-muted-foreground">Loading members…</p>
        )}
      </div>
    </div>
  );
}
