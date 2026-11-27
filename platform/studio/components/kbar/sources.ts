'use client';
// What the Cmd+K bar searches, loaded from Mynt when it opens: in Studio the selected workspace's apps, the user's own
// financial products, members and audit actions; in the platform admin every workspace and regulated firm. And
// whether Ask AI can answer here.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkspace } from '@/components/workspace-context';
import { ASK_URL, type AskArea } from '@/lib/ask-answer';
import type { PlatformSearchSources, SearchSources } from '@/lib/studio-search';
import { myProductsFrom } from '@/lib/threads';
import { useStudioAccess } from '@/lib/use-liquidity-access';
import { withWorkspace } from '@/lib/workspaces';

export type AskStatus = 'loading' | 'enabled' | 'disabled';

const pick = async <T,>(url: string, read: (body: Record<string, unknown>) => T | undefined): Promise<T | undefined> => {
  const res = await fetch(url, { cache: 'no-store' }).catch(() => null);
  if (!res?.ok) return undefined;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return body ? read(body) : undefined;
};

// What search covers, for the selected workspace: loaded each time the bar opens.
export function useSearchSources(open: boolean): SearchSources {
  const { selected, loading } = useWorkspace();
  // Apps, members and audit actions are developers' (their routes are developer-only).
  const access = useStudioAccess();
  const developer = access?.developer === true;
  // The platform admin's sections, only for Mynt admins (its pages are a 404 for anyone else).
  const admin = access?.admin === true;
  const [fetched, setSources] = useState<SearchSources>({});
  const sources = useMemo(() => ({ ...fetched, admin }), [fetched, admin]);
  useEffect(() => {
    if (!open || loading || !developer) return;
    let live = true;
    const ws = encodeURIComponent(selected.id);
    const set = (patch: SearchSources) => live && setSources((s) => ({ ...s, ...patch }));
    // The workspace's apps, and its services (listed apart by the same route: a service is never an app).
    void pick(withWorkspace('/api/projects', selected), (b) => ({ apps: b.projects as SearchSources['apps'], services: b.services as SearchSources['services'] })).then((found) =>
      set({ apps: found?.apps ?? [], services: found?.services ?? [] })
    );
    // The user's own financial products: each opens its workspace.
    void pick('/api/products?mine=1', (b) => myProductsFrom(b.mine)).then((products) => set({ products: products ?? [] }));
    if (!selected.implicit)
      void pick(`/api/workspaces/${ws}/members`, (b) => b.members as SearchSources['members']).then((members) => set({ members: members ?? [] }));
    else set({ members: [] });
    void pick(withWorkspace('/api/audit', selected), (b) => (b.page as { events?: { action: string }[] } | undefined)?.events).then((events) =>
      set({ auditActions: (events ?? []).map((e) => e.action) })
    );
    return () => {
      live = false;
    };
  }, [open, loading, selected, developer]);
  return sources;
}

// Every workspace and firm on Mynt, for the platform admin's search: fetched once, the first time the bar opens.
export function usePlatformSearchSources(open: boolean): PlatformSearchSources {
  const [sources, setSources] = useState<PlatformSearchSources>({});
  const started = useRef(false);
  useEffect(() => {
    if (!open || started.current) return;
    started.current = true;
    const set = (patch: PlatformSearchSources) => setSources((s) => ({ ...s, ...patch }));
    void pick('/api/admin/workspaces', (b) => (Array.isArray(b.workspaces) ? (b.workspaces as PlatformSearchSources['workspaces']) : undefined)).then((workspaces) =>
      set({ workspaces: workspaces ?? [] })
    );
    void pick('/api/admin/firms', (b) => (Array.isArray(b.firms) ? (b.firms as PlatformSearchSources['firms']) : undefined)).then((firms) => set({ firms: firms ?? [] }));
  }, [open]);
  return sources;
}

// Whether Ask AI can answer (GET /api/ask, or /api/admin/ask in the platform admin), checked whenever the bar opens.
export function useAskStatus(open: boolean, area: AskArea): AskStatus {
  const [status, setStatus] = useState<AskStatus>('loading');
  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetch(ASK_URL[area], { cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { enabled?: unknown } | null;
        if (live) setStatus(res.ok && body?.enabled === true ? 'enabled' : 'disabled');
      })
      .catch(() => live && setStatus('disabled'));
    return () => {
      live = false;
    };
  }, [open, area]);
  return status;
}
