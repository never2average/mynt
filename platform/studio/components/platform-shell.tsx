"use client"

// The platform admin's own layout (app/(platform)/layout.tsx), for Mynt's staff: not the studio's shell. A sidebar laid
// out as the studio's (shadcn/ui's sidebar-07 block, MIT, collapsible to icons), titled "Mynt platform admin", listing
// its eight sections, each its own page (/platform, /platform/workspaces, …, /platform/settings), with a labelled
// Back to Studio link and the signed-in account at its foot (components/nav-user.tsx). No workspace switcher and no
// app folders: everything here is across all workspaces and firms. Beside it, a sticky header with the section's
// name, Back to Studio and the theme switcher.
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { ArrowLeft, Building2, FileCheck2, Gauge, Globe2, Layers, Package, ShieldCheck, SlidersHorizontal, Store } from "lucide-react"

import { NavUser } from "@/components/nav-user"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import { adminHref, PLATFORM_NAME, platformRouteOf, platformTitle, type AdminTab } from "@/lib/admin"

type Account = { name: string | null; email: string | null }

// The sections, in order: one entry each, and one route (app/(platform)/platform).
export const PLATFORM_SECTIONS: { tab: AdminTab; label: string; icon: typeof Gauge }[] = [
  { tab: "overview", label: "Overview", icon: Gauge },
  { tab: "workspaces", label: "Workspaces", icon: Layers },
  { tab: "apps", label: "Apps", icon: Globe2 },
  { tab: "products", label: "Products", icon: Package },
  { tab: "firms", label: "Firms", icon: Building2 },
  { tab: "licences", label: "Licences", icon: FileCheck2 },
  { tab: "vendors", label: "Vendors", icon: Store },
  { tab: "settings", label: "Platform settings", icon: SlidersHorizontal },
]

export const BACK_TO_STUDIO = "Back to Studio"

// What the platform admin's sidebar shows; rendered on the server by the tests.
export function PlatformSidebarView({ pathname, account, ...props }: { pathname: string; account: Account } & React.ComponentProps<typeof Sidebar>) {
  const active = platformRouteOf(pathname)?.tab ?? null
  return (
    <Sidebar collapsible="icon" data-platform-sidebar {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={PLATFORM_NAME}>
              <Link href={adminHref("overview")} data-platform-title>
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <ShieldCheck className="size-4" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">{PLATFORM_NAME}</span>
                  <span className="truncate text-xs text-muted-foreground">All workspaces and firms</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Sections</SidebarGroupLabel>
          <SidebarMenu>
            {PLATFORM_SECTIONS.map(({ tab, label, icon: Icon }) => (
              <SidebarMenuItem key={tab}>
                <SidebarMenuButton asChild tooltip={label} isActive={active === tab}>
                  <Link href={adminHref(tab)} data-platform-link={tab}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip={BACK_TO_STUDIO}>
              <Link href="/" data-back-to-studio>
                <ArrowLeft />
                <span>{BACK_TO_STUDIO}</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <NavUser user={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

// The header beside it: the sidebar's toggle, the section's name, then Back to Studio and the theme switcher.
export function PlatformHeader({ title }: { title: string }) {
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80" data-platform-header>
      <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="truncate text-base font-medium">{title}</h1>
        <span className="ml-1 hidden shrink-0 rounded-md border px-2 py-0.5 text-xs text-muted-foreground sm:inline" data-header-scope>
          All workspaces
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/" data-header-back-to-studio>
              <ArrowLeft />
              {BACK_TO_STUDIO}
            </Link>
          </Button>
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  )
}

export function PlatformShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const [account, setAccount] = useState<Account>({ name: null, email: null })
  useEffect(() => {
    let live = true
    void fetch("/api/session", { cache: "no-store" })
      .then((r) => r.json())
      .then((s: Account | null) => live && s && setAccount({ name: s.name ?? null, email: s.email ?? null }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])
  return (
    <SidebarProvider className="h-full min-h-0" style={{ "--sidebar-width": "16rem", "--header-height": "3rem" } as React.CSSProperties} data-platform-shell>
      <PlatformSidebarView variant="inset" pathname={pathname} account={account} />
      <SidebarInset className="min-h-0 overflow-hidden">
        <PlatformHeader title={platformTitle(pathname)} />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  )
}
