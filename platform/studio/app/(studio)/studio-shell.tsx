"use client";

// Every signed-in page: the sidebar (components/app-sidebar.tsx) beside the page, as shadcn/ui's
// sidebar and dashboard blocks lay it out, all scoped to the workspace picked in its switcher.
// Outside an app, the page sits under the sticky header (its name, search and New app); inside
// an app, the app's own top bar takes its place (components/app-top-bar.tsx). Search and Ask AI
// open from either, or with Cmd+K.
//
// Roles come first (lib/use-liquidity-access.ts): until they're known the page waits, so nothing
// developer-only is fetched for someone who isn't one. A non-developer gets the single "for
// developers" message on every page but the dashboard's investor view and Earn (liquidity
// providers); a developer with no workspace yet creates one first (components/studio-gates.tsx).
import { usePathname } from "next/navigation";
import { useCallback } from "react";

import { AppSidebar, isAdminPath } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { CreateWorkspace, DeveloperGate, pageGateFor } from "@/components/studio-gates";
import { StudioSearchProvider } from "@/components/studio-search";
import { useWorkspace, WorkspaceProvider } from "@/components/workspace-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { isDocsPath } from "@/lib/page-gate";
import { pageTitle } from "@/lib/studio-search";
import { useStudioAccess } from "@/lib/use-liquidity-access";
import type { Workspace } from "@/lib/workspaces";

function PageBody({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const access = useStudioAccess();
  const { needsWorkspace, loading, reload, select } = useWorkspace();
  const create = useCallback(
    async (name: string) => {
      const res = await fetch("/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { workspace?: Workspace | null; message?: string } | null;
      if (!res?.ok) return data?.message ?? "Couldn't create the workspace. Please try again.";
      await reload();
      if (data?.workspace) select(data.workspace.id);
      return null;
    },
    [reload, select],
  );
  // The docs are public: no stand-in, for any role.
  if (isDocsPath(pathname)) return <>{children}</>;
  if (!access || (access.developer && loading))
    return (
      <div className="flex flex-col gap-4 p-4 lg:p-6" data-gate="loading">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  const gate = pageGateFor(pathname, access, needsWorkspace);
  if (gate === "developer") return <DeveloperGate />;
  if (gate === "workspace") return <CreateWorkspace onCreate={create} />;
  return <>{children}</>;
}

// `title`: the header's title where it isn't the page's own (the docs, app/docs/layout.tsx, are "Docs" throughout).
export function StudioShell({ title: fixedTitle, children }: { title?: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const title = fixedTitle ?? pageTitle(pathname);
  const access = useStudioAccess();
  return (
    <WorkspaceProvider enabled={access?.developer === true}>
      <StudioSearchProvider>
        <SidebarProvider
          className="h-full min-h-0"
          style={{ "--sidebar-width": "16rem", "--header-height": "3rem" } as React.CSSProperties}
        >
          <AppSidebar variant="inset" />
          <SidebarInset className="min-h-0 overflow-hidden">
            {title !== null && <SiteHeader title={title} scope={access?.admin && isAdminPath(pathname) ? "All workspaces" : undefined} />}
            <div className="flex min-h-0 flex-1 flex-col">
              <PageBody>{children}</PageBody>
            </div>
          </SidebarInset>
        </SidebarProvider>
      </StudioSearchProvider>
    </WorkspaceProvider>
  );
}
