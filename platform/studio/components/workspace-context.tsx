"use client";

// The selected workspace, shared by the sidebar, the dashboard and the Members page. It's
// remembered in a cookie (the API routes read it too), so a reload or a new tab keeps it.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { PERSONAL, selectWorkspace, WORKSPACE_COOKIE, type Workspace } from "@/lib/workspaces";

type WorkspaceState = {
  workspaces: Workspace[];
  selected: Workspace;
  supported: boolean; // Mynt has workspaces (else one implicit Personal workspace)
  loading: boolean;
  select(id: string): void;
  reload(): Promise<void>;
};

const Ctx = createContext<WorkspaceState>({
  workspaces: [PERSONAL],
  selected: PERSONAL,
  supported: false,
  loading: true,
  select: () => undefined,
  reload: async () => undefined,
});

function rememberedId(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${WORKSPACE_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function remember(id: string) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${WORKSPACE_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([PERSONAL]);
  const [supported, setSupported] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await fetch("/api/workspaces", { cache: "no-store" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { workspaces?: Workspace[]; supported?: boolean } | null;
    setWorkspaces(data?.workspaces?.length ? data.workspaces : [PERSONAL]);
    setSupported(data?.supported === true);
    setLoading(false);
  }, []);

  useEffect(() => {
    setSelectedId(rememberedId());
    void reload();
  }, [reload]);

  const select = useCallback((id: string) => {
    remember(id);
    setSelectedId(id);
    window.dispatchEvent(new CustomEvent("mynt:workspace-changed", { detail: { id } }));
    window.dispatchEvent(new Event("adorable:projects-updated"));
  }, []);

  const value = useMemo(
    () => ({ workspaces, selected: selectWorkspace(workspaces, selectedId), supported, loading, select, reload }),
    [workspaces, selectedId, supported, loading, select, reload],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);
