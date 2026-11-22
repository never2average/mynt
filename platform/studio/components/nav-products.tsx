"use client"

// The sidebar's Financial products, under the Apps folders: one collapsible group (like an Apps folder)
// listing the user's financial products and their product chats on the Build page, newest first, each
// with its status (lib/threads.ts). Open or closed is remembered in this browser. Collapsed to icons, its
// landmark icon stays (the Apps folders keep theirs), and clicking it opens the group and expands the
// sidebar. A product chat reopens on the Build page in Create product; a product opens Products on it.
import Link from "next/link"
import { useEffect, useState } from "react"
import { ChevronRight, Landmark } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
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
import { openThreadInPlace, THREAD_KIND_LABELS, type StudioThread } from "@/lib/threads"

export const PRODUCTS_OPEN_KEY = "mynt_studio_products_open"
export const PRODUCTS_GROUP_LABEL = "Financial products"

function rememberedOpen(): boolean | null {
  try {
    const v = window.localStorage.getItem(PRODUCTS_OPEN_KEY)
    return v === "1" ? true : v === "0" ? false : null
  } catch {
    return null
  }
}

function rememberOpen(open: boolean) {
  try {
    window.localStorage.setItem(PRODUCTS_OPEN_KEY, open ? "1" : "0")
  } catch {
    // private window or blocked storage: it just isn't remembered
  }
}

export function NavProducts({ threads }: { threads: StudioThread[] | null }) {
  const { state, setOpen: setSidebarOpen } = useSidebar()
  const collapsed = state === "collapsed"
  const [open, setOpen] = useState(true)
  useEffect(() => {
    const saved = rememberedOpen()
    if (saved !== null) setOpen(saved)
  }, [])
  const change = (next: boolean) => {
    setOpen(next)
    rememberOpen(next)
  }
  const label = THREAD_KIND_LABELS.product
  return (
    <SidebarGroup data-products-group>
      <SidebarGroupLabel>{PRODUCTS_GROUP_LABEL}</SidebarGroupLabel>
      <SidebarMenu>
        <Collapsible asChild open={open} onOpenChange={(next) => !collapsed && change(next)} className="group/collapsible">
          <SidebarMenuItem data-products-folder data-open={open ? "true" : undefined}>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                tooltip={PRODUCTS_GROUP_LABEL}
                aria-expanded={open}
                onClick={() => {
                  if (collapsed) {
                    change(true)
                    setSidebarOpen(true)
                  }
                }}
              >
                <Landmark data-products-icon />
                <span>{PRODUCTS_GROUP_LABEL}</span>
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{threads ? threads.length : ""}</span>
                <ChevronRight className="transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {threads && threads.length === 0 && (
                  <SidebarMenuSubItem>
                    <span className="px-2 py-1 text-xs text-muted-foreground">No financial products</span>
                  </SidebarMenuSubItem>
                )}
                {(threads ?? []).map((t) => (
                  <SidebarMenuSubItem key={t.key}>
                    <SidebarMenuSubButton asChild>
                      <Link
                        href={t.href}
                        aria-label={`${label}: ${t.name}`}
                        title={`${label} · ${t.status}`}
                        onClick={() => openThreadInPlace(t.source === "chat" ? { thread: t.id } : { product: t.id })}
                        data-thread-item={t.key}
                        data-kind="product"
                      >
                        <Landmark className="size-3.5" aria-hidden data-thread-icon="product" />
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground" data-thread-status>
                          {t.status}
                        </span>
                      </Link>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      </SidebarMenu>
    </SidebarGroup>
  )
}
