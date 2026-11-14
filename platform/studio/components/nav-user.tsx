"use client"

// From shadcn/ui's sidebar blocks (nav-user.tsx, MIT): the one signed-in account at the foot of
// the sidebar. Log out is an icon button on the account's row, shown while the row is hovered or
// anything in it has keyboard focus (Tab reaches it even while hidden, and it shows as soon as it
// has focus); on touch screens, which can't hover, it's always shown. Log out posts to
// /api/auth/logout (POST only, so a link elsewhere can't sign anyone out). One account at a
// time; there's no account switching.
import { LogOut } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { SidebarMenu, SidebarMenuItem } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export function initials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?"
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

// Hidden until the row is hovered or focused within; always shown where there's no hover (touch).
export const REVEAL_LOGOUT =
  "opacity-0 group-hover/account:opacity-100 group-focus-within/account:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"

export function NavUser({ user }: { user: { name: string | null; email: string | null } }) {
  const name = user.name ?? user.email ?? "Signed in"

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <div
          className="group/account flex items-center gap-2 rounded-md p-2 hover:bg-sidebar-accent focus-within:bg-sidebar-accent group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:p-0"
          data-account
        >
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarFallback className="rounded-lg">{initials(user.name, user.email)}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
            <span className="truncate font-medium">{name}</span>
            {user.email && user.email !== name && (
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            )}
          </div>
          <form method="post" action="/api/auth/logout" className="shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="submit"
                  aria-label="Log out"
                  data-logout
                  className={`flex size-8 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-sidebar-accent-foreground/10 hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:outline-none ${REVEAL_LOGOUT}`}
                >
                  <LogOut className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Log out</TooltipContent>
            </Tooltip>
          </form>
        </div>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
