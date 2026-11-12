"use client"

// The studio's sidebar, laid out as shadcn/ui's sidebar-07 block (MIT): collapsible to icons,
// the main destinations, the user's apps, and the account at the foot.
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { AppWindow, Hammer, LayoutDashboard, Plus } from "lucide-react"

import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"

type AppLink = { id: string; name: string }
type Account = { name: string | null; email: string | null }

const MAIN = [
  { title: "Dashboard", href: "/", icon: LayoutDashboard },
  { title: "New app", href: "/new", icon: Plus },
  { title: "Builds", href: "/builds", icon: Hammer },
]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const [apps, setApps] = useState<AppLink[] | null>(null)
  const [account, setAccount] = useState<Account>({ name: null, email: null })

  const loadApps = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" })
      const data = (await res.json().catch(() => null)) as { projects?: AppLink[] } | null
      setApps(res.ok ? (data?.projects ?? []).map((p) => ({ id: p.id, name: p.name })) : [])
    } catch {
      setApps([])
    }
    // The account is known once the apps have loaded (roles, name and email come together).
    const s = (await fetch("/api/session", { cache: "no-store" }).then((r) => r.json()).catch(() => null)) as Account | null
    if (s) setAccount({ name: s.name ?? null, email: s.email ?? null })
  }, [])

  useEffect(() => {
    void loadApps()
    const reload = () => void loadApps()
    window.addEventListener("adorable:projects-updated", reload)
    return () => window.removeEventListener("adorable:projects-updated", reload)
  }, [loadApps])

  const appId = pathname.split("/").filter(Boolean)[0]

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link href="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground font-semibold">
                  M
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Mynt Studio</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {MAIN.map((item) => (
              <SidebarMenuItem key={item.href}>
                <SidebarMenuButton asChild tooltip={item.title} isActive={pathname === item.href}>
                  <Link href={item.href}>
                    <item.icon />
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="group-data-[collapsible=icon]:hidden">
          <SidebarGroupLabel>Apps</SidebarGroupLabel>
          <SidebarMenu>
            {apps === null
              ? // Fixed widths: SidebarMenuSkeleton picks random ones, which differ between the server's
                // render and the browser's.
                ["60%", "75%", "50%"].map((w) => (
                  <SidebarMenuItem key={w}>
                    <div className="flex h-8 items-center px-2">
                      <Skeleton className="h-4" style={{ width: w }} />
                    </div>
                  </SidebarMenuItem>
                ))
              : apps.map((app) => (
                  <SidebarMenuItem key={app.id}>
                    <SidebarMenuButton asChild isActive={app.id === appId}>
                      <Link href={`/${encodeURIComponent(app.id)}`}>
                        <AppWindow />
                        <span>{app.name}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
