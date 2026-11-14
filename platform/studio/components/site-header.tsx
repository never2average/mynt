// From shadcn/ui's dashboard-01 block (site-header.tsx, MIT): the page's name beside the
// sidebar's toggle, then search (Search or ask AI, Cmd+K) and New app, on every page outside an
// app. Sticky: it stays at the top while the page scrolls. The workspace isn't repeated here; the
// sidebar's switcher shows it.
import Link from "next/link"
import { Plus } from "lucide-react"

import { SearchTrigger } from "@/components/studio-search"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

/** New app, everywhere: the /new flow. `compact`: an icon button with a tooltip-style title. */
export function NewAppButton({ compact = false }: { compact?: boolean }) {
  return (
    <Button asChild size={compact ? "icon" : "sm"} className={compact ? "size-8" : undefined}>
      <Link href="/new" aria-label={compact ? "New app" : undefined} title={compact ? "New app" : undefined} data-new-app>
        <Plus />
        {!compact && "New app"}
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
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <h1 className="truncate text-base font-medium">{title}</h1>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {children}
          <SearchTrigger />
          <NewAppButton />
        </div>
      </div>
    </header>
  )
}
