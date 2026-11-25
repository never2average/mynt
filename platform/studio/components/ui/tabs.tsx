"use client"

// The studio's tab bars, after shadcn/ui's tabs with its "line" variant: left-aligned labels,
// muted when inactive, the active one in the foreground with a 2px underline, one bottom border
// across the bar, no pill or box behind them and no accent colour. Every page-level tab bar uses
// it (Audits, Settings, the right panels of an app and of Earn). The bars are controlled: each
// tab is a button the page answers (its tab lives in the address), so tabs are a TabList of
// Tab buttons rather than Radix's Tabs with content panels. Arrow keys, Home and End move
// between tabs, as a tablist's keyboard pattern has it.
//
// A line bar scrolls sideways when its tabs don't fit (a phone), without showing a scrollbar (scrollbar-none, in
// app/globals.css) and never vertically (overflow-y-hidden). Its bottom line is an inset shadow rather than a border,
// so the active tab's underline paints over it inside the bar instead of hanging 1px past it (which is what made a
// scrollbar appear next to the tabs); the focus ring is inset so the bar's clipping never hides it.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const tabListVariants = cva("flex min-w-0 items-center", {
  variants: {
    variant: {
      line: "scrollbar-none shrink-0 gap-4 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)]",
      default: "inline-flex w-fit gap-1 rounded-lg bg-muted p-1",
    },
  },
  defaultVariants: { variant: "line" },
})

const tabVariants = cva(
  "inline-flex shrink-0 items-center gap-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        // The underline covers the bar's bottom line, in the foreground colour.
        line: "border-b-2 border-transparent px-0.5 py-2 focus-visible:ring-inset data-[state=active]:border-foreground data-[state=active]:text-foreground",
        default: "rounded-md px-3 py-1.5 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm",
      },
    },
    defaultVariants: { variant: "line" },
  },
)

type Variant = VariantProps<typeof tabListVariants>["variant"]
const VariantContext = React.createContext<Variant>("line")

function onArrows(e: React.KeyboardEvent<HTMLDivElement>) {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')]
  const at = tabs.indexOf(document.activeElement as HTMLButtonElement)
  if (at < 0) return
  const next = e.key === "ArrowRight" ? at + 1 : e.key === "ArrowLeft" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : null
  if (next === null) return
  e.preventDefault()
  const tab = tabs[(next + tabs.length) % tabs.length]
  tab.focus()
  tab.click()
}

function TabList({ className, variant = "line", ...props }: React.ComponentProps<"div"> & { variant?: Variant }) {
  return (
    <VariantContext.Provider value={variant}>
      <div role="tablist" {...props} data-slot="tabs-list" data-variant={variant} onKeyDown={onArrows} className={cn(tabListVariants({ variant }), className)} />
    </VariantContext.Provider>
  )
}

function Tab({ selected, className, ...props }: React.ComponentProps<"button"> & { selected: boolean }) {
  const variant = React.useContext(VariantContext)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      {...props}
      tabIndex={selected ? 0 : -1}
      data-slot="tabs-trigger"
      data-state={selected ? "active" : "inactive"}
      className={cn(tabVariants({ variant }), className)}
    />
  )
}

export { TabList, Tab, tabListVariants, tabVariants }
