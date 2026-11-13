"use client";

// The selected workspace, shared by the sidebar, the dashboard and the Members page. It's
// remembered in a cookie (the API routes read it too), so a reload or a new tab keeps it. It also
// holds the user's pending invitations, which they accept or decline explicitly.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Invitation } from "@/lib/invitations";
import { PERSONAL, selectWorkspace, WORKSPACE_COOKIE, type Workspace } from "@/lib/workspaces";

export type InvitationAnswer = (id: string, action: "accept" | "decline") => Promise<string | null>; // an error to show, or null

type WorkspaceState = {
  workspaces: Workspace[];
  selected: Workspace;
  supported: boolean; // Mynt has workspaces (else one implicit Personal workspace)
  loading: boolean;
  select(id: string): void;
  reload(): Promise<void>;
  invitations: Invitation[];
  answerInvitation: InvitationAnswer;
};

const Ctx = createContext<WorkspaceState>({
  workspaces: [PERSONAL],
  selected: PERSONAL,
  supported: false,
  loading: true,
  select: () => undefined,
  reload: async () => undefined,
  invitations: [],
  answerInvitation: async () => null,
});

function rememberedId(): string | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${WORKSPACE_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function remember(id: string) {
  // __Host- cookies need Secure, Path=/ and no Domain (browsers treat localhost as secure).
  document.cookie = `${WORKSPACE_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`;
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

  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const loadInvitations = useCallback(async () => {
    const res = await fetch("/api/invitations", { cache: "no-store" }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { invitations?: Invitation[] } | null;
    setInvitations(res?.ok && data?.invitations ? data.invitations : []);
  }, []);

  useEffect(() => {
    setSelectedId(rememberedId());
    void reload();
    void loadInvitations();
  }, [reload, loadInvitations]);

  const select = useCallback((id: string) => {
    remember(id);
    setSelectedId(id);
    window.dispatchEvent(new CustomEvent("mynt:workspace-changed", { detail: { id } }));
    window.dispatchEvent(new Event("adorable:projects-updated"));
  }, []);

  // Accept or decline; after accepting, the joined workspace is listed and selected.
  const answerInvitation: InvitationAnswer = useCallback(
    async (id, action) => {
      const res = await fetch(`/api/invitations/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { workspaceId?: string | null; message?: string } | null;
      if (!res?.ok) return data?.message ?? "That didn't work. Please try again.";
      await Promise.all([loadInvitations(), action === "accept" ? reload() : Promise.resolve()]);
      if (action === "accept" && data?.workspaceId) select(data.workspaceId);
      return null;
    },
    [loadInvitations, reload, select],
  );

  const value = useMemo(
    () => ({ workspaces, selected: selectWorkspace(workspaces, selectedId), supported, loading, select, reload, invitations, answerInvitation }),
    [workspaces, selectedId, supported, loading, select, reload, invitations, answerInvitation],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useWorkspace = () => useContext(Ctx);
