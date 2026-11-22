"use client"

// The studio's sidebar, laid out as shadcn/ui's sidebar-07 block (MIT), collapsible to icons:
// the workspace switcher at the top, Dashboard, Licences (with Coverage as a tab), Audits and Workspace (its
// members, invitations, apps and settings), the workspace's apps in three folders by stage
// (Production, Staging, Ideas: a rocket, a flask and a lightbulb), and the signed-in account at the
// foot, its Log out an icon button shown on hover or focus (components/nav-user.tsx). Under the Apps
// folders, Financial products (components/nav-products.tsx): the user's products and product chats. Each
// app and product says which it is (an icon, "App: …" / "Financial product: …" to screen readers).
// New app is in every page's header; Builds isn't in the sidebar (/builds still works).
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { Coins, FileBadge, History, LayoutDashboard, Settings } from "lucide-react"

import { NavFolders } from "@/components/nav-folders"
import { NavProducts } from "@/components/nav-products"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import { useWorkspace } from "@/components/workspace-context"
import { useWorkspaceSettings, type WorkspaceSettings } from "@/components/workspace-settings"
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
import { hasLiquidity } from "@/lib/liquidity"
import { useStudioAccess } from "@/lib/use-liquidity-access"
import { listProductChats, mergeThreads, myProductsFrom, THREADS_UPDATED, type StudioThread, type ThreadsUpdatedDetail } from "@/lib/threads"
import { groupByStage, withWorkspace, type Stage, type StagedApp, type Workspace } from "@/lib/workspaces"

type Account = { name: string | null; email: string | null }

// The fixed pages, above the Apps folders, in order. A new fixed page is one entry here (and one
// in STUDIO_PAGES, lib/studio-search.ts, for its title and search).
const PAGES = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/licences", label: "Licences", icon: FileBadge },
  { href: "/audits", label: "Audits", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
] as const
// Only for builders and liquidity providers, after Settings.
const EARN_PAGE = { href: "/earn", label: "Earn", icon: Coins } as const

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
  liquidity?: boolean
  developer?: boolean // false: only Dashboard (and Earn for liquidity providers); no workspaces or apps
  workspaceSettings?: WorkspaceSettings // the switcher's Rename / Archive / Unarchive workspace
  productThreads?: StudioThread[] | null // the Financial products group: the user's products and product chats (null while loading)
}

// What the sidebar shows, from its data; rendered on the server by the tests.
export function SidebarView({ workspaces, selected, supported, groups, account, pathname, onSelectWorkspace, onCreateWorkspace, invitations, onAnswerInvitation, liquidity, developer = true, workspaceSettings, productThreads = null, ...props }: SidebarViewProps & React.ComponentProps<typeof Sidebar>) {
  const appId = pathname.split("/").filter(Boolean)[0]
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        {developer && <TeamSwitcher
          workspaces={workspaces}
          selected={selected}
          supported={supported}
          onSelect={onSelectWorkspace}
          onCreate={onCreateWorkspace}
          invitations={invitations}
          onAnswerInvitation={onAnswerInvitation}
          settings={workspaceSettings}
        />}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {[...(developer ? PAGES : PAGES.slice(0, 1)), ...(liquidity ? [EARN_PAGE] : [])].map(({ href, label, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton asChild tooltip={label} isActive={pathname === href}>
                  <Link href={href}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {developer && <NavFolders groups={groups} activeAppId={appId} />}
        {developer && <NavProducts threads={productThreads} />}
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
  const access = useStudioAccess()
  const liquidity = hasLiquidity(access?.liquidity)
  const developer = access?.developer === true
  const workspaceSettings = useWorkspaceSettings(selected, reload, developer && supported)

  // The selected workspace's apps (the API routes scope to it through the switcher's cookie).
  const loadApps = useCallback(async () => {
    if (developer) try {
      const res = await fetch(withWorkspace("/api/projects", selected), { cache: "no-store" })
      const data = (await res.json().catch(() => null)) as { projects?: StagedApp[] } | null
      setGroups(groupByStage(res.ok ? (data?.projects ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage })) : []))
    } catch {
      setGroups(groupByStage([]))
    }
    // The account is known once the apps have loaded (roles, name and email come together).
    const s = (await fetch("/api/session", { cache: "no-store" }).then((r) => r.json()).catch(() => null)) as Account | null
    if (s) setAccount({ name: s.name ?? null, email: s.email ?? null })
  }, [selected, developer])

  useEffect(() => {
    setGroups(null)
    void loadApps()
    const again = () => void loadApps()
    window.addEventListener("adorable:projects-updated", again)
    return () => window.removeEventListener("adorable:projects-updated", again)
  }, [loadApps])

  // The Financial products group: the user's own products (from Mynt) and their product chats (kept in
  // this browser under the key the route gives), read again when either changes.
  const [productThreads, setProductThreads] = useState<StudioThread[] | null>(null)
  useEffect(() => {
    if (!developer) return
    let live = true
    let owner: string | null = null
    let mine: ReturnType<typeof myProductsFrom> = []
    const show = () => live && setProductThreads(mergeThreads([], listProductChats(owner), mine))
    const load = async () => {
      const res = await fetch("/api/products?mine=1", { cache: "no-store" }).catch(() => null)
      const data = res?.ok ? ((await res.json().catch(() => null)) as { mine?: unknown; owner?: unknown } | null) : null
      mine = myProductsFrom(data?.mine)
      owner = typeof data?.owner === "string" && data.owner ? data.owner : null
      show()
    }
    void load()
    const again = (e: Event) => ((e as CustomEvent<ThreadsUpdatedDetail>).detail?.products ? void load() : show())
    window.addEventListener(THREADS_UPDATED, again)
    return () => {
      live = false
      window.removeEventListener(THREADS_UPDATED, again)
    }
  }, [developer])

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
      liquidity={liquidity}
      developer={access ? developer : true}
      workspaceSettings={workspaceSettings}
      productThreads={productThreads}
    />
  )
}
