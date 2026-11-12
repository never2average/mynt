"use client"

// From shadcn/ui's sidebar blocks (nav-user.tsx, MIT): the signed-in account at the foot of the
// sidebar, with Sign out in its menu. Sign out posts to /api/auth/logout (POST only, so a link
// elsewhere can't sign anyone out).
import { useRef } from "react"
import { ChevronsUpDown, LogOut } from "lucide-react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"

export function initials(name: string | null, email: string | null): string {
  const source = (name ?? "").trim() || (email ?? "").split("@")[0] || "?"
  const parts = source.split(/[\s._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

export function NavUser({ user }: { user: { name: string | null; email: string | null } }) {
  const { isMobile } = useSidebar()
  const signOut = useRef<HTMLFormElement>(null)
  const name = user.name ?? user.email ?? "Signed in"

  const who = (
    <>
      <Avatar className="h-8 w-8 rounded-lg">
        <AvatarFallback className="rounded-lg">{initials(user.name, user.email)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{name}</span>
        {user.email && user.email !== name && (
          <span className="truncate text-xs text-muted-foreground">{user.email}</span>
        )}
      </div>
    </>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <form ref={signOut} method="post" action="/api/auth/logout" hidden />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {who}
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
            side={isMobile ? "bottom" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{who}</div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => signOut.current?.requestSubmit()}>
              <LogOut />
              Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
