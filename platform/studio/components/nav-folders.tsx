"use client"

// From shadcn/ui's sidebar-07 block (nav-main.tsx, MIT): collapsible groups, here the
// workspace's apps under an "Apps" label, in three folders by stage (Production, Staging, Ideas).
// Exactly one folder is open at a time, like a single-select: opening one closes the others,
// and the open one can't be closed to none. It starts at the stage of the app on screen, else the
// last one picked (remembered in this browser), else Production. Collapsed to icons, the three
// icons stay, the open folder's marked as selected, and clicking one picks it and expands the
// sidebar to show its apps. Each app opens its workspace view.
import Link from "next/link"
import { useEffect, useState } from "react"
import { ChevronRight, FlaskConical, Lightbulb, Rocket, type LucideIcon } from "lucide-react"

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
import { STAGE_LABELS, STAGES, type StagedApp, type Stage } from "@/lib/workspaces"

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
  const own = activeAppId && groups ? STAGES.find((s) => groups[s].some((a) => a.id === activeAppId)) : undefined
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
  const appStage = activeAppId && groups ? STAGES.find((s) => groups[s].some((a) => a.id === activeAppId)) : undefined
  useEffect(() => {
    setActive((current) => appStage ?? remembered() ?? current)
  }, [appStage])

  const pick = (stage: Stage) => {
    setActive(stage)
    remember(stage)
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Apps</SidebarGroupLabel>
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
                    tooltip={STAGE_LABELS[stage]}
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
                        <span className="px-2 py-1 text-xs text-muted-foreground">No apps</span>
                      </SidebarMenuSubItem>
                    )}
                    {apps.map((app) => (
                      <SidebarMenuSubItem key={app.id}>
                        <SidebarMenuSubButton asChild isActive={app.id === activeAppId}>
                          <Link href={`/${encodeURIComponent(app.id)}`}>
                            <span>{app.name}</span>
                          </Link>
                        </SidebarMenuSubButton>
                      </SidebarMenuSubItem>
                    ))}
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
