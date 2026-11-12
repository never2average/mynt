"use client";

// Every signed-in page: the sidebar (components/app-sidebar.tsx) beside the page, as shadcn/ui's
// sidebar and dashboard blocks lay it out.
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider
      className="h-full min-h-0"
      style={{ "--sidebar-width": "16rem", "--header-height": "3rem" } as React.CSSProperties}
    >
      <AppSidebar variant="inset" />
      <SidebarInset className="min-h-0 overflow-hidden">{children}</SidebarInset>
    </SidebarProvider>
  );
}
