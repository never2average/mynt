// From shadcn/ui's dashboard-01 block (site-header.tsx, MIT): the page's name beside the
// sidebar's toggle, then search (Search or ask AI, Cmd+K) and New app, on every page outside an
// app, with the GitHub and wallet controls (components/github-control.tsx, wallet-control.tsx) right beside New app
// (GitHub and the wallet from md up; Search and New app as icons below md), and the theme switcher at the far right. Sticky: it stays at the top while the page scrolls. The workspace isn't repeated here; the
// sidebar's switcher shows it.
import Link from "next/link"
import { Plus } from "lucide-react"

import { SearchTrigger } from "@/components/studio-search"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { GithubControl } from "@/components/github-control"
import { DeveloperOnly } from "@/components/studio-gates"
import { ConnectAgentButton, DocsButton } from "@/components/connect-agent"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { WalletControl } from "@/components/wallet-control"

/** Build, everywhere: the /new flow (an app or a financial product). `compact`: an icon button with a tooltip-style title. */
export function NewAppButton({ compact = false }: { compact?: boolean }) {
  return (
    <Button asChild size={compact ? "icon" : "sm"} className={compact ? "size-8" : undefined}>
      <Link href="/new" aria-label={compact ? "Build" : undefined} title={compact ? "Build" : undefined} data-new-app>
        <Plus />
        {!compact && "Build"}
      </Link>
    </Button>
  )
}

export function SiteHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header
      className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)"
      data-site-header
    >
      <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" data-toggle-separator />
        <h1 className="truncate text-base font-medium">{title}</h1>
        {/* What a page puts beside its title (the dashboard's "/ Builder ▾"): HeaderTabs. */}
        <div id={HEADER_TABS_ID} className="ml-1 flex min-w-0 items-center overflow-hidden" data-header-slot />
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {children}
          {/* As the app's top bar has them: labelled Search and New app where there's room, icons
              below md; GitHub and the wallet from md up (the page's title keeps its room on a phone). */}
          <span className="hidden md:flex">
            <SearchTrigger />
          </span>
          <span className="flex md:hidden">
            <SearchTrigger compact />
          </span>
          <DeveloperOnly>
            <span className="hidden md:flex">
              <GithubControl />
            </span>
            <span className="hidden md:flex" data-header-wallet>
              <WalletControl />
            </span>
            <span className="hidden md:flex">
              <NewAppButton />
            </span>
            <span className="flex md:hidden">
              <NewAppButton compact />
            </span>
          </DeveloperOnly>
          <DocsButton />
          <ConnectAgentButton />
          <ThemeSwitcher />
        </div>
      </div>
    </header>
  )
}

export const HEADER_TABS_ID = "page-header-tabs"
