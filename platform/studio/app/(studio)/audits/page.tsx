"use client";

// Audits (/audits?tab=security|obligations|financial|workspace): the workspace's records in four
// tabs (components/audits-view.tsx). App security, Financial activity and Workspace activity are
// list_workspace_audit's classes, paged by Mynt's cursor; Licence obligations is
// get_workspace_obligations. Until Mynt classifies its records, Workspace activity is the whole
// audit trail as it is and the other tabs say they aren't available yet.
import { useCallback, useEffect, useMemo, useState } from "react";

import { AuditsView, AuditTabs, NO_AUDIT_FILTERS, ObligationsView, type AuditFilters, type Option } from "@/components/audits-view";
import { NotReady } from "@/components/not-available";
import { useWorkspace } from "@/components/workspace-context";
import { AUDIT_CLASS_HELP, auditClassOf, type AuditClass, type AuditRow, type AuditRowPage, type Obligation } from "@/lib/audit-classes";
import { useComplianceData } from "@/lib/use-compliance";

type ClassPage = AuditRowPage & { classes: boolean };
const pickPage = (body: Record<string, unknown>) => (body.page ? ({ ...(body.page as AuditRowPage), classes: body.classes === true } as ClassPage) : undefined);
const pickObligations = (body: Record<string, unknown>) => body.obligations as Obligation[] | undefined;

function ClassTab({ auditClass, members, apps, initialAction }: { auditClass: Exclude<AuditClass, "obligations">; members: Option[]; apps: Option[]; initialAction: string }) {
  const [filters, setFilters] = useState<AuditFilters>({ ...NO_AUDIT_FILTERS, action: initialAction });
  // The cursors of the pages before this one, so Previous goes back without Mynt keeping state.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1] ?? "";
  const query = useMemo(() => `/api/audit?${new URLSearchParams(Object.entries({ class: auditClass, ...filters, cursor }).filter(([, v]) => v))}`, [auditClass, filters, cursor]);
  const { state } = useComplianceData(query, pickPage);

  const [seen, setSeen] = useState<AuditRow[]>([]);
  useEffect(() => {
    if (state.kind === "ready") setSeen((s) => [...s, ...state.data.rows].slice(-500));
  }, [state]);
  const kinds = useMemo(() => [...new Set(seen.map((r) => r.kind))].sort(), [seen]);
  // Before the members list is known, the people seen in these records.
  const memberOptions = useMemo(() => {
    if (members.length) return members;
    const byId = new Map(seen.flatMap((r) => (r.actor.id ? [[r.actor.id, r.actor.name ?? r.actor.id] as const] : [])));
    return [...byId].map(([id, name]) => ({ id, name }));
  }, [members, seen]);
  const onFilters = useCallback((f: AuditFilters) => {
    setFilters(f);
    setCursors([]);
  }, []);

  const filtering = cursors.length + Object.values(filters).filter(Boolean).length > 0;
  if (!(state.kind === "ready" || (state.kind === "loading" && filtering)))
    return <NotReady state={state as Exclude<typeof state, { kind: "ready" }>} what={auditClass === "workspace" ? "The audit trail" : "This tab"} />;
  return (
    <>
      {state.kind === "ready" && !state.data.classes && (
        <p className="text-xs text-muted-foreground" data-unclassified>
          Mynt doesn&apos;t sort its records into classes yet, so this is the whole audit trail.
        </p>
      )}
      <AuditsView
        auditClass={auditClass}
        rows={state.kind === "ready" ? state.data.rows : []}
        loading={state.kind === "loading"}
        filters={filters}
        onFilters={onFilters}
        members={memberOptions}
        apps={apps}
        actions={kinds}
        page={cursors.length + 1}
        hasNext={state.kind === "ready" && Boolean(state.data.nextCursor)}
        onPrev={() => setCursors((c) => c.slice(0, -1))}
        onNext={() => state.kind === "ready" && state.data.nextCursor && setCursors((c) => [...c, state.data.nextCursor!])}
      />
    </>
  );
}

function ObligationsTab() {
  const { state } = useComplianceData("/api/obligations", pickObligations);
  return state.kind === "ready" ? <ObligationsView obligations={state.data} /> : <NotReady state={state} what="Licence obligations" />;
}

export default function AuditsPage() {
  const { selected, loading } = useWorkspace();
  const [tab, setTab] = useState<AuditClass>("security");
  const [action, setAction] = useState("");
  const [members, setMembers] = useState<Option[]>([]);
  const [apps, setApps] = useState<Option[]>([]);

  // ?tab= picks the tab; search's "Audit actions" open Workspace activity filtered to one (?action=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const a = (params.get("action") ?? "").trim().slice(0, 120);
    setAction(a);
    setTab(a ? "workspace" : auditClassOf(params.get("tab")));
  }, []);

  // Members and apps for the filters.
  useEffect(() => {
    if (loading) return;
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

  const onTab = (t: AuditClass) => {
    setTab(t);
    setAction("");
    window.history.replaceState(null, "", `/audits?tab=${t}`);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3 p-4 lg:p-6">
        <div className="flex flex-wrap items-center gap-3">
          <AuditTabs tab={tab} onTab={onTab} />
          <p className="text-xs text-muted-foreground">{AUDIT_CLASS_HELP[tab]}</p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel={tab}>
          {tab === "obligations" ? (
            <ObligationsTab />
          ) : (
            // Keyed by tab and workspace: each starts on its first page with no filters.
            <ClassTab key={`${tab}-${selected.id}-${action}`} auditClass={tab} members={members} apps={apps} initialAction={tab === "workspace" ? action : ""} />
          )}
        </div>
      </div>
    </div>
  );
}
