"use client";

// Audits: the selected workspace's audit trail, paged by Mynt's cursor (components/audits-view.tsx).
import { useCallback, useEffect, useMemo, useState } from "react";

import { AuditsView, NO_AUDIT_FILTERS, type AuditFilters, type Option } from "@/components/audits-view";
import { NotReady } from "@/components/not-available";
import { useWorkspace } from "@/components/workspace-context";
import type { AuditEvent, AuditPage } from "@/lib/compliance";
import { useComplianceData } from "@/lib/use-compliance";

const pick = (body: Record<string, unknown>) => body.page as AuditPage | undefined;

export default function AuditsPage() {
  const { selected, loading } = useWorkspace();
  const [filters, setFilters] = useState<AuditFilters>(NO_AUDIT_FILTERS);
  // The cursors of the pages before this one, so Previous goes back without Mynt keeping state.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1] ?? "";
  const query = useMemo(() => {
    const q = new URLSearchParams(Object.entries({ ...filters, cursor }).filter(([, v]) => v));
    return `/api/audit?${q}`;
  }, [filters, cursor]);
  const { state } = useComplianceData(query, pick);

  const [seen, setSeen] = useState<AuditEvent[]>([]);
  useEffect(() => {
    if (state.kind === "ready") setSeen((s) => [...s, ...state.data.events].slice(-500));
  }, [state]);
  const actions = useMemo(() => [...new Set(seen.map((e) => e.action))].sort(), [seen]);

  // Members and apps for the filters.
  const [members, setMembers] = useState<Option[]>([]);
  const [apps, setApps] = useState<Option[]>([]);
  useEffect(() => {
    if (loading) return;
    // Search's "Audit actions" open the trail filtered to one (/audits?action=<action>).
    const action = (new URLSearchParams(window.location.search).get("action") ?? "").trim().slice(0, 120);
    setFilters({ ...NO_AUDIT_FILTERS, action });
    setCursors([]);
    setSeen([]);
    const ws = encodeURIComponent(selected.id);
    void fetch(`/api/projects?workspace=${ws}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { projects?: { id: string; name: string }[] }) => setApps((b.projects ?? []).map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setApps([]));
    if (selected.implicit) return setMembers([]);
    void fetch(`/api/workspaces/${ws}/members`, { cache: "no-store" })
      .then((r) => r.json())
      .then((b: { members?: { userId: string; name: string | null; email: string | null }[] }) =>
        setMembers((b.members ?? []).map((m) => ({ id: m.userId, name: m.name ?? m.email ?? m.userId }))),
      )
      .catch(() => setMembers([]));
  }, [selected.id, selected.implicit, loading]);
  // Before the members list is known, the people seen in the trail.
  const memberOptions = useMemo(() => {
    if (members.length) return members;
    const byId = new Map(seen.flatMap((e) => (e.actor.id ? [[e.actor.id, e.actor.name ?? e.actor.id] as const] : [])));
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [members, seen]);

  const onFilters = useCallback((f: AuditFilters) => {
    setFilters(f);
    setCursors([]);
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col p-4 lg:p-6">
        {state.kind === "ready" || (state.kind === "loading" && cursors.length + Object.values(filters).filter(Boolean).length > 0) ? (
          <AuditsView
            events={state.kind === "ready" ? state.data.events : []}
            loading={state.kind === "loading"}
            filters={filters}
            onFilters={onFilters}
            members={memberOptions}
            apps={apps}
            actions={actions}
            page={cursors.length + 1}
            hasNext={state.kind === "ready" && Boolean(state.data.nextCursor)}
            onPrev={() => setCursors((c) => c.slice(0, -1))}
            onNext={() => state.kind === "ready" && state.data.nextCursor && setCursors((c) => [...c, state.data.nextCursor!])}
          />
        ) : (
          <NotReady state={state as Exclude<typeof state, { kind: "ready" }>} what="The audit trail" />
        )}
      </div>
    </div>
  );
}
