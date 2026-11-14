"use client"

// From shadcn/ui's sidebar-07 block (nav-main.tsx, MIT): collapsible groups, here the
// workspace's apps in three folders by stage (Production, Staging, Ideas). Each app opens its
// workspace view.
import Link from "next/link"
import { ChevronRight, FlaskConical, Lightbulb, Rocket, type LucideIcon } from "lucide-react"

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import { STAGE_LABELS, STAGES, type StagedApp, type Stage } from "@/lib/workspaces"

// Each folder its own icon, expanded and collapsed (where the icon is all that shows, with the
// folder's name as its tooltip).
export const FOLDER_ICONS: Record<Stage, LucideIcon> = { production: Rocket, staging: FlaskConical, idea: Lightbulb }

export function NavFolders({
  groups,
  activeAppId,
}: {
  groups: Record<Stage, StagedApp[]> | null // null while loading
  activeAppId?: string
}) {
  return (
    <SidebarGroup>
      <SidebarMenu>
        {STAGES.map((stage) => {
          const apps = groups?.[stage] ?? []
          const Icon = FOLDER_ICONS[stage]
          return (
            <Collapsible
              key={stage}
              asChild
              defaultOpen={stage !== "idea" || apps.some((a) => a.id === activeAppId)}
              className="group/collapsible"
            >
              <SidebarMenuItem data-folder={stage}>
                <CollapsibleTrigger asChild>
                  <SidebarMenuButton tooltip={STAGE_LABELS[stage]}>
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
