"use client"

// The studio's sidebar, laid out as shadcn/ui's sidebar-07 block (MIT), collapsible to icons:
// the workspace switcher at the top, Dashboard, Licences (agreements with licence providers), Marketplace (service providers'
// standard services), Audits and Workspace (its
// members, invitations, apps and settings), the workspace's apps in three folders by stage
// (Production, Staging, Ideas: a rocket, a flask and a lightbulb) together with the user's financial
// products, which go through the same stages, and the signed-in account at the foot, its Log out an icon
// button shown on hover or focus (components/nav-user.tsx). Each app and product says which it is (an
// icon, "App: …" / "Financial product: …" to screen readers). Product chats that haven't made a product
// yet have no stage, so they aren't in the folders: they reopen from the Build page (?thread=).
// Service providers (Mynt's vendor role) also get My services (/vendor), their own services and onboarding.
// Regulated firms' own people (Mynt's licence-provider role, as granted) also get My firm (/firm).
// Docs isn't in the sidebar (the header's Docs button opens /docs). Build is in every page's header; Builds isn't in
// the sidebar (/builds still works). Mynt admins (the role Mynt gave their account, never a list in the studio's
// settings) also get a labelled "Platform admin" badge at the foot, above their name: it opens the platform admin
// (/platform), which has its own layout (components/platform-shell.tsx), outside the studio's shell.
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useCallback, useEffect, useState } from "react"
import { Coins, FileBadge, Handshake, History, Landmark, LayoutDashboard, ServerCog, Settings, ShieldCheck } from "lucide-react"

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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import type { Invitation } from "@/lib/invitations"
import { PLATFORM_BASE } from "@/lib/admin"
import { hasLiquidity } from "@/lib/liquidity"
import { useStudioAccess } from "@/lib/use-liquidity-access"
import { myProductsFrom, productIdOfPath, THREADS_UPDATED, type MyProduct, type ThreadsUpdatedDetail } from "@/lib/threads"
import { productStageOf } from "@/lib/products"
import { serviceIdOfPath } from "@/lib/services"
import { groupByStage, STAGES, withWorkspace, type Stage, type StagedApp, type Workspace } from "@/lib/workspaces"

type Account = { name: string | null; email: string | null }

// The fixed pages, above the Apps folders, in order. A new fixed page is one entry here (and one
// in STUDIO_PAGES, lib/studio-search.ts, for its title and search).
const PAGES = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/licences", label: "Licences", icon: FileBadge },
  // Service providers' standard services, subscribed to by accepting their standard terms.
  { href: "/marketplace", label: "Marketplace", icon: Handshake },
  { href: "/audits", label: "Audits", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
] as const
// Only for builders and liquidity providers, after Settings.
const EARN_PAGE = { href: "/earn", label: "Earn", icon: Coins } as const
// Only for service providers (Mynt's vendor role): their own services and onboarding, last of the fixed pages.
export const VENDOR_PAGE = { href: "/vendor", label: "My services", icon: ServerCog } as const
// Only for regulated firms' own people (Mynt's licence-provider role, as granted): their firm's onboarding, licences,
// sponsorship requests, roster, people and notices.
export const FIRM_PAGE = { href: "/firm", label: "My firm", icon: Landmark } as const
// Only for Mynt admins, at the foot above their name: the platform admin, in its own layout.
export const PLATFORM_ADMIN_LABEL = "Platform admin"
export function PlatformAdminLink() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          asChild
          tooltip={PLATFORM_ADMIN_LABEL}
          className="border border-sidebar-border bg-sidebar-accent/60 font-medium group-data-[collapsible=icon]:border-transparent"
        >
          <Link href={PLATFORM_BASE} data-platform-admin-link>
            <ShieldCheck />
            <span>{PLATFORM_ADMIN_LABEL}</span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}

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
  licenceProvider?: boolean // a licence provider: Licences (its agreement tabs) even without the developer role
  workspaceSettings?: WorkspaceSettings // the switcher's Rename / Archive / Unarchive workspace
  products?: MyProduct[] | null // the user's own financial products, in the stage folders with the apps (null while loading)
  admin?: boolean // a Mynt admin: the Platform admin badge above their name
  vendor?: boolean // a service provider: My services (/vendor)
  firm?: boolean // a regulated firm's own licence provider (the role as granted): My firm (/firm)
}

// The folders' items: the workspace's apps and the user's products, each in its stage.
export function stagedItems(groups: Record<Stage, StagedApp[]> | null, products: MyProduct[] | null): Record<Stage, StagedApp[]> | null {
  if (!groups) return null
  const all = [...STAGES.flatMap((s) => groups[s].map((a) => ({ ...a, kind: a.kind ?? ("app" as const) }))), ...(products ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage ?? productStageOf(p), kind: "product" as const }))]
  return groupByStage(all)
}

// What the sidebar shows, from its data; rendered on the server by the tests.
export function SidebarView({ workspaces, selected, supported, groups, account, pathname, onSelectWorkspace, onCreateWorkspace, invitations, onAnswerInvitation, liquidity, developer = true, licenceProvider = false, workspaceSettings, products = null, admin = false, vendor = false, firm = false, ...props }: SidebarViewProps & React.ComponentProps<typeof Sidebar>) {
  // The app or product on screen, marked in its folder: an app's workspace is /<app id>, a product's /products/<id>.
  // A service's is /services/<id>.
  const activeProductId = productIdOfPath(pathname)
  const activeServiceId = serviceIdOfPath(pathname)
  const appId = activeProductId || activeServiceId ? undefined : pathname.split("/").filter(Boolean)[0]
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
            {[...(developer ? PAGES : [...PAGES.slice(0, 1), ...(licenceProvider ? PAGES.slice(1, 2) : [])]), ...(liquidity ? [EARN_PAGE] : []), ...(vendor ? [VENDOR_PAGE] : []), ...(firm ? [FIRM_PAGE] : [])].map(({ href, label, icon: Icon }) => (
              <SidebarMenuItem key={href}>
                <SidebarMenuButton asChild tooltip={label} isActive={pathname === href || (href === VENDOR_PAGE.href && pathname.startsWith(`${href}/`))}>
                  <Link href={href}>
                    <Icon />
                    <span>{label}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
        {developer && <NavFolders groups={stagedItems(groups, products)} activeAppId={appId} activeProductId={activeProductId} activeServiceId={activeServiceId} />}
      </SidebarContent>
      <SidebarFooter>
        {admin && <PlatformAdminLink />}
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
      const data = (await res.json().catch(() => null)) as { projects?: (StagedApp & { conversations?: { id: string }[] })[]; services?: StagedApp[] } | null
      // Each app with its newest build (conversations come newest first), which the sidebar opens; then the
      // workspace's services (the route lists them apart: a service is never an app), each opening /services/<id>.
      setGroups(
        groupByStage(
          res.ok
            ? [
                ...(data?.projects ?? []).map((p) => ({ id: p.id, name: p.name, stage: p.stage, conversationId: p.conversations?.[0]?.id ?? null })),
                ...(data?.services ?? []).map((s) => ({ id: s.id, name: s.name, stage: s.stage, kind: "service" as const })),
              ]
            : [],
        ),
      )
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
      vendor={access?.vendor === true}
      firm={access?.firm === true}
    />
  )
}
