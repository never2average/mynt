"use client"

// The studio's sidebar, laid out as shadcn/ui's sidebar-07 block (MIT), collapsible to icons:
// the workspace switcher at the top, Dashboard, Licences (with Coverage as a tab), Marketplace (service providers'
// standard services), Audits and Workspace (its
// members, invitations, apps and settings), the workspace's apps in three folders by stage
// (Production, Staging, Ideas: a rocket, a flask and a lightbulb) together with the user's financial
// products, which go through the same stages, and the signed-in account at the foot, its Log out an icon
// button shown on hover or focus (components/nav-user.tsx). Each app and product says which it is (an
// icon, "App: …" / "Financial product: …" to screen readers). Product chats that haven't made a product
// yet have no stage, so they aren't in the folders: they reopen from the Build page (?thread=).
// Docs isn't in the sidebar (the header's Docs button opens /docs). Build is in every page's header; Builds isn't in
// the sidebar (/builds still works). Mynt admins (the role Mynt gave their account, never a list in the studio's
// settings) also get the Admin group (/admin, components/admin-view.tsx). The Admin area is across all workspaces:
// while it's open the switcher gives way to "All workspaces" and the workspace's folders aren't shown.
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { Blocks, Building2, Coins, FileBadge, FileCheck2, Gauge, Globe2, History, LayoutDashboard, Layers, Package, Settings, SlidersHorizontal, Store } from "lucide-react"

import { NavFolders } from "@/components/nav-folders"
import { NavUser } from "@/components/nav-user"
import { TeamSwitcher } from "@/components/team-switcher"
import { useWorkspace } from "@/components/workspace-context"
import { useWorkspaceSettings, type WorkspaceSettings } from "@/components/workspace-settings"
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
import type { Invitation } from "@/lib/invitations"
import { ADMIN_TAB_CHANGED, adminHref, adminTabOf, type AdminTab } from "@/lib/admin"
import { hasLiquidity } from "@/lib/liquidity"
import { useStudioAccess } from "@/lib/use-liquidity-access"
import { myProductsFrom, productIdOfPath, THREADS_UPDATED, type MyProduct, type ThreadsUpdatedDetail } from "@/lib/threads"
import { productStageOf } from "@/lib/products"
import { groupByStage, STAGES, withWorkspace, type Stage, type StagedApp, type Workspace } from "@/lib/workspaces"

type Account = { name: string | null; email: string | null }

// The fixed pages, above the Apps folders, in order. A new fixed page is one entry here (and one
// in STUDIO_PAGES, lib/studio-search.ts, for its title and search).
const PAGES = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/licences", label: "Licences", icon: FileBadge },
  // Service providers' standard services, subscribed to by accepting their standard terms.
  { href: "/marketplace", label: "Marketplace", icon: Blocks },
  { href: "/audits", label: "Audits", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
] as const
// Only for builders and liquidity providers, after Settings.
const EARN_PAGE = { href: "/earn", label: "Earn", icon: Coins } as const
// Only for Mynt admins: the Admin area's tabs, across all workspaces.
export const ADMIN_PAGES: { tab: AdminTab; label: string; icon: typeof Gauge }[] = [
  { tab: "overview", label: "Overview", icon: Gauge },
  { tab: "workspaces", label: "Workspaces", icon: Layers },
  { tab: "apps", label: "Apps", icon: Globe2 },
  { tab: "products", label: "Products", icon: Package },
  { tab: "firms", label: "Firms", icon: Building2 },
  { tab: "licences", label: "Licences", icon: FileCheck2 },
  { tab: "vendors", label: "Vendors", icon: Store },
  { tab: "settings", label: "Platform settings", icon: SlidersHorizontal },
]
export const isAdminPath = (pathname: string) => pathname === "/admin" || pathname.startsWith("/admin/")

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
  developer?: boolean // false: only Dashboard (and Earn for liquidity providers, Licences for licence providers); no workspaces or apps
  licenceProvider?: boolean // a licence provider: Licences (its Agreements tab) even without the developer role
  workspaceSettings?: WorkspaceSettings // the switcher's Rename / Archive / Unarchive workspace
  products?: MyProduct[] | null // the user's own financial products, in the stage folders with the apps (null while loading)
  admin?: boolean // a Mynt admin: the Admin group
  adminTab?: AdminTab | null // the Admin area's tab on screen, marked in the group
}

// The folders' items: the workspace's apps and the user's products, each in its stage.
export function stagedItems(groups: Record<Stage, StagedApp[]> | null, products: MyProduct[] | null): Record<Stage, StagedApp[]> | null {
  if (!groups) return null
  const all = [...STAGES.flatMap((s) => groups[s].map((a) => ({ ...a, kind: a.kind ?? ("app" as const) }))), ...(products ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage ?? productStageOf(p), kind: "product" as const }))]
  return groupByStage(all)
}

// What the sidebar shows, from its data; rendered on the server by the tests.
export function SidebarView({ workspaces, selected, supported, groups, account, pathname, onSelectWorkspace, onCreateWorkspace, invitations, onAnswerInvitation, liquidity, developer = true, licenceProvider = false, workspaceSettings, products = null, admin = false, adminTab = null, ...props }: SidebarViewProps & React.ComponentProps<typeof Sidebar>) {
  // The app or product on screen, marked in its folder: an app's workspace is /<app id>, a product's /products/<id>.
  const activeProductId = productIdOfPath(pathname)
  const appId = activeProductId ? undefined : pathname.split("/").filter(Boolean)[0]
  // The Admin area is across all workspaces: no switcher, no workspace folders, only admins (a non-admin's /admin is a 404).
  const inAdmin = admin && isAdminPath(pathname)
  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        {inAdmin ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" className="cursor-default" data-all-workspaces>
                <span className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Globe2 className="size-4" />
                </span>
                <span className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">All workspaces</span>
                  <span className="truncate text-xs text-muted-foreground">Mynt admin</span>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : developer && <TeamSwitcher
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
            {[...(developer ? PAGES : [...PAGES.slice(0, 1), ...(licenceProvider ? PAGES.slice(1, 2) : [])]), ...(liquidity ? [EARN_PAGE] : [])].map(({ href, label, icon: Icon }) => (
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
        {admin && (
          <SidebarGroup data-admin-group>
            <SidebarGroupLabel>Admin</SidebarGroupLabel>
            <SidebarMenu>
              {ADMIN_PAGES.map(({ tab, label, icon: Icon }) => (
                <SidebarMenuItem key={tab}>
                  <SidebarMenuButton asChild tooltip={`Admin: ${label}`} isActive={inAdmin && adminTab === tab}>
                    <Link href={adminHref(tab)} data-admin-link={tab}>
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {developer && !inAdmin && <NavFolders groups={stagedItems(groups, products)} activeAppId={appId} activeProductId={activeProductId} />}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={account} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}

// The Admin area's tab, from the address (?tab=), read again whenever the page or its tab changes.
function useAdminTab(pathname: string): AdminTab | null {
  const [tab, setTab] = useState<AdminTab | null>(null)
  useEffect(() => {
    if (!isAdminPath(pathname)) return setTab(null)
    const read = () => setTab(adminTabOf(new URLSearchParams(window.location.search).get("tab")))
    read()
    window.addEventListener("popstate", read)
    window.addEventListener(ADMIN_TAB_CHANGED, read)
    return () => {
      window.removeEventListener("popstate", read)
      window.removeEventListener(ADMIN_TAB_CHANGED, read)
    }
  }, [pathname])
  return tab
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const pathname = usePathname()
  const adminTab = useAdminTab(pathname)
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
      const data = (await res.json().catch(() => null)) as { projects?: (StagedApp & { conversations?: { id: string }[] })[] } | null
      // Each app with its newest build (conversations come newest first), which the sidebar opens.
      setGroups(groupByStage(res.ok ? (data?.projects ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage, conversationId: p.conversations?.[0]?.id ?? null })) : []))
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

  // The user's own financial products (from Mynt), in the stage folders with the apps; read again when
  // one is created or moves stage.
  const [products, setProducts] = useState<MyProduct[] | null>(null)
  useEffect(() => {
    if (!developer) return
    let live = true
    const load = async () => {
      const res = await fetch("/api/products?mine=1", { cache: "no-store" }).catch(() => null)
      const data = res?.ok ? ((await res.json().catch(() => null)) as { mine?: unknown } | null) : null
      if (live) setProducts(myProductsFrom(data?.mine))
    }
    void load()
    const again = (e: Event) => void ((e as CustomEvent<ThreadsUpdatedDetail>).detail?.products && load())
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
      licenceProvider={access?.licenceProvider === true}
      workspaceSettings={workspaceSettings}
      products={products}
      admin={access?.admin === true}
      adminTab={adminTab}
    />
  )
}
