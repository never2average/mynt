"use client"

// From shadcn/ui's sidebar blocks (nav-user.tsx, MIT): the one signed-in account at the foot of
// the sidebar. Expanded, it's one row that never wraps: the avatar, the name and email (cut off
// with an ellipsis) and a Log out icon button, always shown. Collapsed to the icon rail, it's
// the avatar alone, centred in the rail, with no Log out button there. Clicking the avatar
// opens the account menu (to the right when collapsed): name, email and Log out. Log out posts
// to /api/auth/logout (POST only, so a link elsewhere can't sign anyone out). One account at a
// time; there's no account switching.
import { LogOut } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function initials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?"
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

const LOGOUT = { method: "post", action: "/api/auth/logout" } as const

export function NavUser({ user }: { user: { name: string | null; email: string | null } }) {
  const { state, isMobile } = useSidebar()
  const collapsed = state === "collapsed" && !isMobile
  const name = user.name ?? user.email ?? "Signed in"
  const email = user.email && user.email !== name ? user.email : null

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div
          className="flex min-w-0 flex-nowrap items-center gap-2 rounded-md p-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
          data-account
          data-collapsed={collapsed}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account menu"
                className="shrink-0 rounded-lg focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
                data-account-trigger
              >
                <Avatar className="h-8 w-8 rounded-lg">
                  <AvatarFallback className="rounded-lg">{initials(user.name, user.email)}</AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side={collapsed ? "right" : "top"} align={collapsed ? "end" : "start"} className="min-w-56" data-account-menu>
              <DropdownMenuLabel className="flex min-w-0 flex-col gap-0.5 font-normal">
                <span className="truncate font-medium">{name}</span>
                {email && <span className="truncate text-xs text-muted-foreground">{email}</span>}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <form {...LOGOUT}>
                <DropdownMenuItem asChild>
                  <button type="submit" className="w-full" data-menu-logout>
                    <LogOut />
                    Log out
                  </button>
                </DropdownMenuItem>
              </form>
            </DropdownMenuContent>
          </DropdownMenu>
          {!collapsed && (
            <>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden" data-account-name>
                <span className="truncate font-medium">{name}</span>
                {email && <span className="truncate text-xs text-muted-foreground">{email}</span>}
              </div>
              <form {...LOGOUT} className="shrink-0 group-data-[collapsible=icon]:hidden">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="submit"
                      aria-label="Log out"
                      data-logout
                      className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none"
                    >
                      <LogOut className="size-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Log out</TooltipContent>
                </Tooltip>
              </form>
            </>
          )}
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
