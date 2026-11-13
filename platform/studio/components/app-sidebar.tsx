"use client"

// The studio's sidebar, laid out as shadcn/ui's sidebar-07 block (MIT), collapsible to icons:
// the workspace switcher at the top, Dashboard, the workspace's apps in three folders by stage
// (Production, Staging, Ideas), and the signed-in account with a visible Log out at the foot.
// New app and Builds aren't in the sidebar (their pages, /new and /builds, still work).
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { LayoutDashboard } from "lucide-react"

import { NavFolders } from "@/components/nav-folders"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import { useWorkspace } from "@/components/workspace-context"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import type { Invitation } from "@/lib/invitations"
import { groupByStage, type Stage, type StagedApp, type Workspace } from "@/lib/workspaces"

type Account = { name: string | null; email: string | null }

export type SidebarViewProps = {
  workspaces: Workspace[]
  selected: Workspace
  supported: boolean
  groups: Record<Stage, StagedApp[]> | null
  account: Account
  pathname: string
  onSelectWorkspace: (id: string) => void
  onCreateWorkspace: (name: string) => Promise<string | null>
  invitations?: Invitation[]
  onAnswerInvitation?: (id: string, action: "accept" | "decline") => Promise<string | null>
}

// What the sidebar shows, from its data; rendered on the server by the tests.
export function SidebarView({ workspaces, selected, supported, groups, account, pathname, onSelectWorkspace, onCreateWorkspace, invitations, onAnswerInvitation, ...props }: SidebarViewProps & React.ComponentProps<typeof Sidebar>) {
  const appId = pathname.split("/").filter(Boolean)[0]
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <TeamSwitcher
          workspaces={workspaces}
          selected={selected}
          supported={supported}
          onSelect={onSelectWorkspace}
          onCreate={onCreateWorkspace}
          invitations={invitations}
          onAnswerInvitation={onAnswerInvitation}
        />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Dashboard" isActive={pathname === "/"}>
                <Link href="/">
                  <LayoutDashboard />
                  <span>Dashboard</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <NavFolders groups={groups} activeAppId={appId} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const { workspaces, selected, supported, select, reload, invitations, answerInvitation } = useWorkspace()
  const [groups, setGroups] = useState<Record<Stage, StagedApp[]> | null>(null)
  const [account, setAccount] = useState<Account>({ name: null, email: null })

  // The selected workspace's apps (the API routes scope to it through the switcher's cookie).
  const loadApps = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects?workspace=${encodeURIComponent(selected.id)}`, { cache: "no-store" })
      const data = (await res.json().catch(() => null)) as { projects?: StagedApp[] } | null
      setGroups(groupByStage(res.ok ? (data?.projects ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage })) : []))
    } catch {
      setGroups(groupByStage([]))
    }
    // The account is known once the apps have loaded (roles, name and email come together).
    const s = (await fetch("/api/session", { cache: "no-store" }).then((r) => r.json()).catch(() => null)) as Account | null
    if (s) setAccount({ name: s.name ?? null, email: s.email ?? null })
  }, [selected.id])

  useEffect(() => {
    setGroups(null)
    void loadApps()
    const again = () => void loadApps()
    window.addEventListener("adorable:projects-updated", again)
    return () => window.removeEventListener("adorable:projects-updated", again)
  }, [loadApps])

  const create = useCallback(
    async (name: string) => {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => null)
      const data = (await res?.json().catch(() => null)) as { workspace?: Workspace | null; message?: string } | null
      if (!res?.ok) return data?.message ?? "Couldn't create the workspace."
      await reload()
      if (data?.workspace) select(data.workspace.id)
      return null
    },
    [reload, select],
  )

  return (
    <SidebarView
      {...props}
      workspaces={workspaces}
      selected={selected}
      supported={supported}
      groups={groups}
      account={account}
      pathname={pathname}
      onSelectWorkspace={select}
      onCreateWorkspace={create}
      invitations={invitations}
      onAnswerInvitation={answerInvitation}
    />
  )
}
