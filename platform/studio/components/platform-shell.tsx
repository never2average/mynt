"use client"

// The platform admin's own layout (app/(platform)/layout.tsx), for Mynt's staff: not the studio's shell. A sidebar laid
// out as the studio's (shadcn/ui's sidebar-07 block, MIT, collapsible to icons), titled "Mynt platform admin", listing
// its nine sections, each its own page (/platform, /platform/workspaces, /platform/firms, …, /platform/settings), with
// the labelled Back to Studio link and the signed-in account at its foot (components/nav-user.tsx). No workspace
// switcher and no app folders: everything here is across all workspaces and firms. Beside it, a sticky header with the
// section's name, the studio header's search field (scoped to the platform admin), Docs and the theme switcher (Back to
// Studio is the sidebar's, once); on the Overview, Invite person too (components/admin-members.tsx).
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { ArrowLeft, Building2, FlaskConical, Gauge, History, Layers, ShieldAlert, ShieldCheck, SlidersHorizontal, Sigma, Store } from "lucide-react"

import { InvitePersonButton } from "@/components/admin-members"
import { DocsButton } from "@/components/connect-agent"
import { NavUser } from "@/components/nav-user"
import KBar from "@/components/kbar"
import SearchInput from "@/components/search-input"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
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

// The sections, in order: one entry each, and one route (app/(platform)/platform). Licences isn't one: it's a tab of
// Firms (/platform/firms?tab=licences).
export const PLATFORM_SECTIONS: { tab: AdminTab; label: string; icon: typeof Gauge }[] = [
  { tab: "overview", label: "Overview", icon: Gauge },
  { tab: "workspaces", label: "Workspaces", icon: Layers },
  { tab: "firms", label: "Regulated firms", icon: Building2 },
  { tab: "vendors", label: "Vendors", icon: Store },
  { tab: "audit", label: "Audit trails", icon: History },
  { tab: "risk-models", label: "Risk models", icon: Sigma },
  { tab: "risk-register", label: "Risk register", icon: ShieldAlert },
  { tab: "benchmarks", label: "Agent benchmarks", icon: FlaskConical },
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
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
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

// The header beside it: the sidebar's toggle, the section's name, then its actions (the Overview's Invite person), the
// studio header's search field (Cmd+K; here it searches the platform admin, components/kbar), the labelled
// Docs button (/docs) and the theme switcher. No scope tag (everything here is across Mynt) and no second Back to Studio
// (the sidebar's foot has it). The search is a box from tablet width up and an icon button named Search on a phone.
export function PlatformHeader({ title, actions = null }: { title: string; actions?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80" data-platform-header>
      <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="truncate text-base font-medium">{title}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {actions}
          <SearchInput />
          <DocsButton />
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
    <KBar area="admin">
      <SidebarProvider className="h-full min-h-0" style={{ "--sidebar-width": "16rem", "--header-height": "3rem" } as React.CSSProperties} data-platform-shell>
        <PlatformSidebarView variant="inset" pathname={pathname} account={account} />
        <SidebarInset className="min-h-0 overflow-hidden">
          <PlatformHeader title={platformTitle(pathname)} actions={platformRouteOf(pathname)?.tab === "overview" ? <InvitePersonButton /> : null} />
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </KBar>
  )
}
