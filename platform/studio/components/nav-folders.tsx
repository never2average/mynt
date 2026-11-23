"use client"

// From shadcn/ui's sidebar-07 block (nav-main.tsx, MIT): collapsible groups, here the
// workspace's apps and the user's financial products under an "Apps and products" label, in three
// folders by stage (Production, Staging, Ideas): both go through the same stages. Each item says which
// it is (its icon, AppWindow or Landmark, and "App: …" / "Financial product: …" to screen readers).
// Exactly one folder is open at a time, like a single-select: opening one closes the others,
// and the open one can't be closed to none. It starts at the stage of the app on screen, else the
// last one picked (remembered in this browser), else Production. Collapsed to icons, the three
// icons stay, the open folder's marked as selected, and clicking one picks it and expands the
// sidebar to show its items. An app opens its workspace view; a product opens the Build page's
// Products tab on it (in place when that page is open).
import Link from "next/link"
import { useEffect, useState } from "react"
import { AppWindow, ChevronRight, FlaskConical, Landmark, Lightbulb, Rocket, type LucideIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { APP_STATUS, appHref, openThreadInPlace, productHref, THREAD_KIND_LABELS } from "@/lib/threads"
import { STAGE_LABELS, STAGES, type StagedApp, type Stage } from "@/lib/workspaces"

// Every item says what it is: an app or a financial product.
const KIND_ICONS: Record<"app" | "product", LucideIcon> = { app: AppWindow, product: Landmark }
export const FOLDERS_LABEL = "Apps and products"

// Each folder its own icon, expanded and collapsed (where the icon is all that shows, with the
// folder's name as its tooltip).
export const FOLDER_ICONS: Record<Stage, LucideIcon> = { production: Rocket, staging: FlaskConical, idea: Lightbulb }

export const FOLDER_KEY = "mynt_studio_folder"

function remembered(): Stage | null {
  try {
    const v = window.localStorage.getItem(FOLDER_KEY)
    return STAGES.includes(v as Stage) ? (v as Stage) : null
  } catch {
    return null
  }
}

function remember(stage: Stage) {
  try {
    window.localStorage.setItem(FOLDER_KEY, stage)
  } catch {
    // private window or blocked storage: it just isn't remembered
  }
}

/** The folder to open: the open app's stage, else the one remembered, else Production. */
export function initialFolder(groups: Record<Stage, StagedApp[]> | null, activeAppId: string | undefined, saved: Stage | null): Stage {
  const own = activeAppId && groups ? STAGES.find((s) => groups[s].some((a) => (a.kind ?? "app") === "app" && a.id === activeAppId)) : undefined
  return own ?? saved ?? "production"
}

export function NavFolders({
  groups,
  activeAppId,
}: {
  groups: Record<Stage, StagedApp[]> | null // null while loading
  activeAppId?: string
}) {
  const { state, setOpen } = useSidebar()
  const collapsed = state === "collapsed"
  const [active, setActive] = useState<Stage>(() => initialFolder(groups, activeAppId, null))

  // After mounting (localStorage is the browser's), and whenever another app is opened: its stage.
  const appStage = activeAppId && groups ? STAGES.find((s) => groups[s].some((a) => (a.kind ?? "app") === "app" && a.id === activeAppId)) : undefined
  useEffect(() => {
    setActive((current) => appStage ?? remembered() ?? current)
  }, [appStage])

  const pick = (stage: Stage) => {
    setActive(stage)
    remember(stage)
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>{FOLDERS_LABEL}</SidebarGroupLabel>
      <SidebarMenu>
        {STAGES.map((stage) => {
          const apps = groups?.[stage] ?? []
          const Icon = FOLDER_ICONS[stage]
          const open = stage === active
          return (
            <Collapsible
              key={stage}
              asChild
              open={open}
              // Opening picks it; closing the open one does nothing: one is always open.
              onOpenChange={(next) => next && pick(stage)}
              className="group/collapsible"
            >
              <SidebarMenuItem data-folder={stage} data-active-folder={open ? "true" : undefined}>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton
                    tooltip={`${FOLDERS_LABEL} · ${STAGE_LABELS[stage]}`}
                    isActive={collapsed && open}
                    aria-pressed={open}
                    onClick={() => {
                      if (collapsed) {
                        pick(stage)
                        setOpen(true)
                      }
                    }}
                  >
                    <Icon data-folder-icon={stage} />
                    <span>{STAGE_LABELS[stage]}</span>
                    <span className="ml-auto text-xs text-muted-foreground tabular-nums">{groups ? apps.length : ""}</span>
                    <ChevronRight className="transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
                  </SidebarMenuButton>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarMenuSub>
                    {groups && apps.length === 0 && (
                      <SidebarMenuSubItem>
                        <span className="px-2 py-1 text-xs text-muted-foreground">No apps or products</span>
                      </SidebarMenuSubItem>
                    )}
                    {apps.map((item) => {
                      const kind = item.kind ?? "app"
                      const Icon = KIND_ICONS[kind]
                      const label = THREAD_KIND_LABELS[kind]
                      return (
                        <SidebarMenuSubItem key={`${kind}:${item.id}`}>
                          <SidebarMenuSubButton asChild isActive={kind === "app" && item.id === activeAppId}>
                            <Link
                              href={kind === "app" ? appHref(item.id) : productHref(item.id)}
                              aria-label={`${label}: ${item.name}`}
                              title={`${label} · ${APP_STATUS[stage]}`}
                              onClick={kind === "product" ? () => openThreadInPlace({ product: item.id }) : undefined}
                              data-thread-item={`${kind}:${item.id}`}
                              data-kind={kind}
                            >
                              <Icon className="size-3.5" aria-hidden data-thread-icon={kind} />
                              <span>{item.name}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      )
                    })}
                  </SidebarMenuSub>
                </CollapsibleContent>
              </SidebarMenuItem>
            </Collapsible>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
