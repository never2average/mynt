"use client";

// Audits (/audits?tab=security|obligations|agreements|financial|workspace): the workspace's records
// in five tabs (components/audits-view.tsx). App security, Financial activity and Workspace activity
// are list_workspace_audit's classes, paged by Mynt's cursor; Licence obligations is
// get_workspace_obligations; Agreement audits (components/agreement-audits-view.tsx) is
// list_agreement_audits, ?agreement=<id> opening it filtered to one agreement. Until Mynt classifies its records, Workspace activity is the whole
// audit trail as it is and the other tabs say they aren't available yet.
import { useCallback, useEffect, useMemo, useState } from "react";

import { auditFiltersOn, auditQuery, AuditsView, AuditTabs, NO_AUDIT_FILTERS, ObligationsView, type AuditFilters, type Option } from "@/components/audits-view";
import { NotReady } from "@/components/not-available";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/components/workspace-context";
import { AgreementAuditsPanel, pickAgreementAudits } from "@/components/agreement-audits-panel";
import { auditsTabOf, type AuditClass, type AuditRow, type AuditRowPage, type AuditsTab, type Obligation } from "@/lib/audit-classes";
import { useComplianceData } from "@/lib/use-compliance";
import { withWorkspace } from "@/lib/workspaces";

type ClassPage = AuditRowPage & { classes: boolean };
const pickPage = (body: Record<string, unknown>) => (body.page ? ({ ...(body.page as AuditRowPage), classes: body.classes === true } as ClassPage) : undefined);
const pickObligations = (body: Record<string, unknown>) => body.obligations as Obligation[] | undefined;

function ClassTab({ auditClass, members, apps, initialAction }: { auditClass: Exclude<AuditClass, "obligations">; members: Option[]; apps: Option[]; initialAction: string }) {
  const [filters, setFilters] = useState<AuditFilters>({ ...NO_AUDIT_FILTERS, action: initialAction ? [initialAction] : [] });
  // The cursors of the pages before this one, so Previous goes back without Mynt keeping state.
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors[cursors.length - 1] ?? "";
  const query = useMemo(() => auditQuery(auditClass, filters, cursor), [auditClass, filters, cursor]);
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

  const filtering = cursors.length > 0 || auditFiltersOn(filters);
  if (!(state.kind === "ready" || (state.kind === "loading" && filtering)))
    return <NotReady state={state as Exclude<typeof state, { kind: "ready" }>} what={auditClass === "workspace" ? "The audit trail" : "This tab"} />;
  return (
    <>
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

// Agreement audits past their due date flag the apps here too, without touching the regulator's
// obligations: a line above the table, with a labelled button to the overdue ones.
function OverdueAgreementAudits({ onShow }: { onShow: () => void }) {
  const { state } = useComplianceData("/api/agreement-audits", pickAgreementAudits);
  const overdue = state.kind === "ready" ? state.data.list.audits.filter((a) => a.overdue).length : 0;
  if (!overdue) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm" role="status" data-overdue-agreement-audits={overdue}>
      <span>
        {overdue} agreement {overdue === 1 ? "audit is" : "audits are"} overdue: past the due date a licence provider set and not closed.
      </span>
      <Button size="sm" variant="outline" onClick={onShow}>
        Show overdue agreement audits
      </Button>
    </div>
  );
}

function ObligationsTab({ onShowOverdue }: { onShowOverdue: () => void }) {
  const { state } = useComplianceData("/api/obligations", pickObligations);
  return (
    <>
      <OverdueAgreementAudits onShow={onShowOverdue} />
      {state.kind === "ready" ? <ObligationsView obligations={state.data} /> : <NotReady state={state} what="Licence obligations" />}
    </>
  );
}

// The list, its sheets and its data are shared with the Licences page's Audit obligations tab (read-only there).
function AgreementAuditsTab({ agreement, overdue }: { agreement: string; overdue: boolean }) {
  return <AgreementAuditsPanel agreement={agreement} overdue={overdue} />;
}

export default function AuditsPage() {
  const { selected, loading } = useWorkspace();
  const [tab, setTab] = useState<AuditsTab>("security");
  const [action, setAction] = useState("");
  // Agreement audits: ?agreement=<id> opens it filtered to that agreement; Show overdue from Licence obligations, to overdue ones.
  const [agreement, setAgreement] = useState("");
  const [overdue, setOverdue] = useState(false);
  const [members, setMembers] = useState<Option[]>([]);
  const [apps, setApps] = useState<Option[]>([]);

  // ?tab= picks the tab; search's "Audit actions" open Workspace activity filtered to one (?action=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const a = (params.get("action") ?? "").trim().slice(0, 120);
    setAction(a);
    const ag = (params.get("agreement") ?? "").trim();
    setAgreement(/^[0-9a-f-]{36}$/i.test(ag) ? ag : "");
    setTab(a ? "workspace" : auditsTabOf(params.get("tab")));
  }, []);

  // Members and apps for the filters.
  useEffect(() => {
    if (loading) return;
    const ws = encodeURIComponent(selected.id);
    void fetch(withWorkspace("/api/projects", selected), { cache: "no-store" })
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

  const onTab = (t: AuditsTab) => {
    setTab(t);
    setAction("");
    setAgreement("");
    setOverdue(false);
    window.history.replaceState(null, "", `/audits?tab=${t}`);
  };

  return (
    <div className="@container/main flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4 lg:gap-5 lg:p-6">
        <AuditTabs tab={tab} onTab={onTab} />
        <div className="flex min-h-0 flex-1 flex-col gap-3" data-tab-panel={tab}>
          {tab === "obligations" ? (
            <ObligationsTab
              onShowOverdue={() => {
                onTab("agreements");
                setOverdue(true);
              }}
            />
          ) : tab === "agreements" ? (
            <AgreementAuditsTab key={`agreements-${selected.id}-${agreement}-${overdue}`} agreement={agreement} overdue={overdue} />
          ) : (
            // Keyed by tab and workspace: each starts on its first page with no filters.
            <ClassTab key={`${tab}-${selected.id}-${action}`} auditClass={tab} members={members} apps={apps} initialAction={tab === "workspace" ? action : ""} />
          )}
        </div>
      </div>
    </div>
  );
}
