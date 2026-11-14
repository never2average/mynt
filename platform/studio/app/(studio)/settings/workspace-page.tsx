"use client";

// The Settings page's data: the selected workspace (as list_workspaces describes it, with which
// settings this Mynt offers), its members and invites, and its apps. Each part loads on its own;
// Mynt checks every change again.
import { useCallback, useEffect, useMemo, useState } from "react";

import type { MembersActions, MembersData } from "@/components/members-view";
import { useWorkspace } from "@/components/workspace-context";
import { useRepositories } from "@/components/repositories";
import { NO_SETTINGS_TOOLS, WorkspaceView, type SettingsActions, type WorkspaceApp, type WorkspaceInfo } from "@/components/workspace-view";
import { Skeleton } from "@/components/ui/skeleton";
import type { ProjectItem } from "@/lib/project-types";
import type { WorkspaceTab } from "@/lib/workspace-tabs";

const read = async <T,>(url: string): Promise<{ ok: boolean; body: (T & { message?: string }) | null }> => {
  const res = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (res?.status === 401) window.location.assign("/api/auth/login");
  return { ok: Boolean(res?.ok), body: ((await res?.json().catch(() => null)) as (T & { message?: string }) | null) ?? null };
};

export function WorkspacePage({ initialTab }: { initialTab: WorkspaceTab }) {
  const { selected, loading, reload } = useWorkspace();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab);
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [members, setMembers] = useState<MembersData | null>(null);
  const [projects, setProjects] = useState<ProjectItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = encodeURIComponent(selected.id);
  const { state: repos, reload: reloadRepos } = useRepositories();

  const loadInfo = useCallback(async () => {
    const { ok, body } = await read<WorkspaceInfo>(`/api/workspaces/${id}`);
    if (ok && body) {
      setInfo({ ...body, tools: { ...NO_SETTINGS_TOOLS, ...body.tools }, canManage: body.canManage ?? false, isOwner: body.isOwner ?? false });
      setError(null);
    } else setError(body?.message ?? "Couldn't load the workspace.");
  }, [id]);

  const loadMembers = useCallback(async () => {
    const { ok, body } = await read<MembersData>(`/api/workspaces/${id}/members`);
    setMembers(ok && body ? body : { supported: false, canManage: false, members: [], invites: [], message: body?.message ?? "Couldn't load the members." });
  }, [id]);

  const loadApps = useCallback(async () => {
    const { ok, body } = await read<{ projects?: ProjectItem[] }>(`/api/projects?workspace=${id}`);
    setProjects(ok ? (body?.projects ?? []) : []);
  }, [id]);

  useEffect(() => {
    if (loading) return;
    setInfo(null);
    setMembers(null);
    setProjects(null);
    void loadInfo();
    void loadMembers();
    void loadApps();
  }, [loading, loadInfo, loadMembers, loadApps]);

  const onTab = (t: WorkspaceTab) => {
    setTab(t);
    window.history.replaceState(null, "", `/settings?tab=${t}`);
  };

  const send = useCallback(async (url: string, method: string, payload: unknown) => {
    const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { message?: string } | null;
    return res?.ok ? null : (body?.message ?? "That didn't work. Please try again.");
  }, []);

  const memberActions: MembersActions = useMemo(() => {
    const base = `/api/workspaces/${id}/members`;
    const then = async (failed: string | null) => {
      if (!failed) await loadMembers();
      return failed;
    };
    return {
      invite: async (email, role) => then(await send(base, "POST", { email, role })),
      changeRole: async (user_id, role) => then(await send(base, "PATCH", { user_id, role })),
      remove: async (user_id) => then(await send(base, "DELETE", { user_id })),
      revoke: async (invite_id) => then(await send(base, "DELETE", { invite_id })),
    };
  }, [id, loadMembers, send]);

  const settingsActions: SettingsActions = useMemo(() => {
    const base = `/api/workspaces/${id}`;
    const then = async (failed: string | null) => {
      if (!failed) await Promise.all([reload(), loadInfo()]);
      return failed;
    };
    return {
      rename: async (name) => then(await send(base, "PATCH", { name })),
      archive: async () => then(await send(base, "POST", { action: "archive" })),
      unarchive: async () => then(await send(base, "POST", { action: "unarchive" })),
      relink: async () => then(await send(base, "POST", { action: "relink" })),
    };
  }, [id, reload, loadInfo, send]);

  // Each app with its owner's name (from the members), stage and newest build.
  const apps: WorkspaceApp[] | null = useMemo(() => {
    if (!projects) return null;
    const who = new Map((members?.members ?? []).map((m) => [m.userId, m.name ?? m.email]));
    return projects.map((p) => {
      const b = p.conversations[0];
      return {
        id: p.id,
        name: p.name,
        stage: p.stage,
        owner: p.ownerId ? (who.get(p.ownerId) ?? null) : null,
        lastBuild: b ? { id: b.id, status: b.status, at: b.updatedAt || null } : null,
      };
    });
  }, [projects, members]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex min-h-0 w-full flex-1 flex-col p-4 lg:p-6">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : info ? (
          <WorkspaceView tab={tab} onTab={onTab} info={info} members={members} apps={apps} memberActions={memberActions} settingsActions={settingsActions} repos={repos} onReposChanged={reloadRepos} />
        ) : (
          <Skeleton className="h-40 w-full rounded-xl" />
        )}
      </div>
    </div>
  );
}
