"use client"

// From shadcn/ui's sidebar-07 block (nav-main.tsx, MIT): collapsible groups, here the
// workspace's apps and the user's financial products under an "Apps and products" label, in three
// folders by stage (Production, Staging, Ideas): both go through the same stages. Each item says which
// it is (its icon, AppWindow or Landmark, and "App: …" / "Financial product: …" to screen readers).
// Exactly one folder is open at a time, like a single-select: opening one closes the others,
// and the open one can't be closed to none. It starts at the stage of the app on screen, else the
// last one picked (remembered in this browser), else Production. Collapsed to icons, the three
// icons stay, the open folder's marked as selected, and clicking one picks it and expands the
// sidebar to show its items. An app opens its workspace view on its newest build's conversation; a
// product opens its own workspace (/products/<id>: its chat and its tabs). The item on screen is marked active.
import Link from "next/link"
import { useEffect, useState } from "react"
import { AppWindow, ChevronRight, FlaskConical, Landmark, Lightbulb, Rocket, ServerCog, type LucideIcon } from "lucide-react"

import { serviceHref } from "@/lib/services"

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
import { APP_STATUS, appHref, productHref, THREAD_KIND_LABELS } from "@/lib/threads"
import { STAGE_LABELS, STAGES, type StagedApp, type Stage } from "@/lib/workspaces"

// Every item says what it is: an app, a financial product or a service (a vendor service built on Mynt, which goes
// through the same stages and opens its own workspace, /services/<id>: never an app's).
type Kind = NonNullable<StagedApp["kind"]>
const KIND_ICONS: Record<Kind, LucideIcon> = { app: AppWindow, product: Landmark, service: ServerCog }
export const KIND_LABELS: Record<Kind, string> = { ...THREAD_KIND_LABELS, service: "Service" }
const hrefOf = (item: StagedApp) => (item.kind === "product" ? productHref(item.id) : item.kind === "service" ? serviceHref(item.id, item.conversationId) : appHref(item.id, item.conversationId))
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

// The stage of the app or product on screen, if it's in the folders.
const isActiveItem = (a: StagedApp, activeAppId: string | undefined, activeProductId: string | undefined, activeServiceId: string | undefined) => {
  const active = a.kind === "product" ? activeProductId : a.kind === "service" ? activeServiceId : activeAppId
  return Boolean(active) && a.id === active
}
function stageOf(groups: Record<Stage, StagedApp[]> | null, activeAppId: string | undefined, activeProductId: string | undefined, activeServiceId?: string): Stage | undefined {
  if (!groups) return undefined
  return STAGES.find((s) => groups[s].some((a) => isActiveItem(a, activeAppId, activeProductId, activeServiceId)))
}

/** The folder to open: the open app's (or product's, or service's) stage, else the one remembered, else Production. */
export function initialFolder(groups: Record<Stage, StagedApp[]> | null, activeAppId: string | undefined, saved: Stage | null, activeProductId?: string, activeServiceId?: string): Stage {
  return stageOf(groups, activeAppId, activeProductId, activeServiceId) ?? saved ?? "production"
}

export function NavFolders({
  groups,
  activeAppId,
  activeProductId,
  activeServiceId,
}: {
  groups: Record<Stage, StagedApp[]> | null // null while loading
  activeAppId?: string
  activeProductId?: string // the product whose workspace is open (/products/<id>)
  activeServiceId?: string // the service whose workspace is open (/services/<id>)
}) {
  const { state, setOpen } = useSidebar()
  const collapsed = state === "collapsed"
  const [active, setActive] = useState<Stage>(() => initialFolder(groups, activeAppId, null, activeProductId, activeServiceId))

  // After mounting (localStorage is the browser's), and whenever another app or product is opened: its stage.
  const appStage = stageOf(groups, activeAppId, activeProductId, activeServiceId)
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
                      const label = KIND_LABELS[kind]
                      return (
                        <SidebarMenuSubItem key={`${kind}:${item.id}`}>
                          <SidebarMenuSubButton asChild isActive={isActiveItem({ ...item, kind }, activeAppId, activeProductId, activeServiceId)}>
                            <Link
                              href={hrefOf({ ...item, kind })}
                              aria-label={`${label}: ${item.name}`}
                              title={`${label} · ${APP_STATUS[stage]}`}
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
