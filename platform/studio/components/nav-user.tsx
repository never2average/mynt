"use client"

// From shadcn/ui's sidebar blocks (nav-user.tsx, MIT): the one signed-in account at the foot of
// the sidebar, with a Log out button always in view (not inside a menu). Log out posts to
// /api/auth/logout (POST only, so a link elsewhere can't sign anyone out). One account at a
// time; there's no account switching.
import { LogOut } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function initials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?"
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

export function NavUser({ user }: { user: { name: string | null; email: string | null } }) {
  const name = user.name ?? user.email ?? "Signed in"

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div className="flex items-center gap-2 rounded-md p-2 group-data-[collapsible=icon]:p-0" data-account>
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarFallback className="rounded-lg">{initials(user.name, user.email)}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">{name}</span>
            {user.email && user.email !== name && (
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            )}
          </div>
        </div>
      </SidebarMenuItem>
      <SidebarMenuItem>
        <form method="post" action="/api/auth/logout">
          <SidebarMenuButton type="submit" tooltip="Log out" className="text-muted-foreground hover:text-foreground">
            <LogOut />
            <span>Log out</span>
          </SidebarMenuButton>
        </form>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
