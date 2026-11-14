"use client";

// Every signed-in page: the sidebar (components/app-sidebar.tsx) beside the page, as shadcn/ui's
// sidebar and dashboard blocks lay it out, all scoped to the workspace picked in its switcher.
// Outside an app, the page sits under the sticky header (its name, search and New app); inside
// an app, the app's own top bar takes its place (components/app-top-bar.tsx). Search and Ask AI
// open from either, or with Cmd+K.
import { usePathname } from "next/navigation";

import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { StudioSearchProvider } from "@/components/studio-search";
import { WorkspaceProvider } from "@/components/workspace-context";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { pageTitle } from "@/lib/studio-search";

export function StudioShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const title = pageTitle(pathname);
  return (
    <WorkspaceProvider>
      <StudioSearchProvider>
        <SidebarProvider
          className="h-full min-h-0"
          style={{ "--sidebar-width": "16rem", "--header-height": "3rem" } as React.CSSProperties}
        >
          <AppSidebar variant="inset" />
          <SidebarInset className="min-h-0 overflow-hidden">
            {title !== null && <SiteHeader title={title} />}
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </SidebarInset>
        </SidebarProvider>
      </StudioSearchProvider>
    </WorkspaceProvider>
  );
}
