"use client"

// The studio's tab bars, after shadcn/ui's tabs with its "line" variant: left-aligned labels,
// muted when inactive, the active one in the foreground with a 2px underline, one bottom line
// across the bar, no pill or box behind them and no accent colour. Every page-level tab bar uses
// it (Audits, Settings, Licences, the right panels of an app and of Earn, the admin areas). The bars
// are controlled: each tab is a button the page answers (its tab lives in the address), so tabs are
// a TabList of Tab buttons rather than Radix's Tabs with content panels. Arrow keys, Home and End
// move between the tabs shown, as a tablist's keyboard pattern has it.
//
// A line bar never scrolls. When its tabs fit, every one shows and there's no More. When the row is
// too narrow for them (a phone, or a narrow panel on a wide screen), it shows as many as fit, at
// least the first two, and puts the rest under a labelled "More" menu after the tablist: the
// trigger reads "More: <tab>" and is underlined as active when the tab shown is one of those. The
// row's own width decides (a ResizeObserver on it), not the window's. The menu's items are the same
// tabs: choosing one does what clicking its tab does, so each page keeps its tab state and address.
// Where nothing can be measured (rendered on the server, or no layout), every tab shows.
import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { ChevronDown } from "lucide-react"

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

// At least this many tabs show inline, however narrow the row.
export const MIN_INLINE_TABS = 2
const GAP = 16 // gap-4, between tabs and before More
const MORE_GUESS = 80 // More's width before it has been measured

const tabListVariants = cva("flex min-w-0 items-center", {
  variants: {
    variant: {
      line: "gap-4",
      default: "inline-flex w-fit gap-1 rounded-lg bg-muted p-1",
    },
  },
  defaultVariants: { variant: "line" },
})

// The line bar's row: the tablist and, after it, More, as wide as the room it's given. Its bottom line is an inset
// shadow, so the active tab's underline paints over it inside the row. Nothing in it scrolls: what doesn't fit is
// under More (overflow-hidden only covers the moment before it's measured).
const tabRow = "flex w-full min-w-0 items-center gap-4 overflow-hidden shadow-[inset_0_-1px_0_var(--color-border)]"

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
const useLayout = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect

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

/**
 * How many of n tabs fit in a row `room` wide, given each tab's width (0 or missing: not measured) and More's: all of
 * them when they fit or nothing is measured, else as many as fit beside More, at least MIN_INLINE_TABS.
 */
export function tabsThatFit(n: number, room: number, widths: readonly number[], more: number): number {
  if (!(room > 0) || n <= MIN_INLINE_TABS) return n
  const known = widths.slice(0, n).filter((w) => w > 0)
  if (!known.length) return n
  const guess = known.reduce((a, b) => a + b, 0) / known.length
  const w = Array.from({ length: n }, (_, i) => (widths[i] > 0 ? widths[i] : guess))
  const span = (k: number) => w.slice(0, k).reduce((a, b) => a + b, 0) + GAP * Math.max(0, k - 1)
  if (span(n) <= room) return n
  let k = n - 1
  while (k > MIN_INLINE_TABS && span(k) + GAP + (more > 0 ? more : MORE_GUESS) > room) k--
  return Math.max(MIN_INLINE_TABS, k)
}

type TabProps = React.ComponentProps<"button"> & { selected: boolean; focusable?: boolean }
type TabElement = React.ReactElement<TabProps>

/** The data-* attributes a tab carries, for its item under More (so a page's own markers find it there too). */
const dataOf = (p: TabProps) => Object.fromEntries(Object.entries(p).filter(([k]) => k.startsWith("data-")))
const widthOf = (el: Element | null | undefined) => (el ? el.getBoundingClientRect().width : 0)

function TabList({ className, variant = "line", children, ...props }: React.ComponentProps<"div"> & { variant?: Variant }) {
  const tabs = React.Children.toArray(children).filter((c): c is TabElement => React.isValidElement(c))
  const n = tabs.length
  const rowRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const moreRef = React.useRef<HTMLButtonElement>(null)
  // Each tab's width, from when it last showed inline (every tab shows on the first layout), and More's.
  const widths = React.useRef<number[]>([])
  const moreWidth = React.useRef(0)
  const [fit, setFit] = React.useState(n)
  const measure = React.useCallback(() => {
    const row = rowRef.current
    const list = listRef.current
    if (!row || !list) return
    ;[...list.children].forEach((el, i) => {
      const w = widthOf(el)
      if (w > 0) widths.current[i] = w
    })
    const m = widthOf(moreRef.current)
    if (m > 0) moreWidth.current = m
    const next = tabsThatFit(n, widthOf(row), widths.current, moreWidth.current)
    setFit((cur) => (cur === next ? cur : next))
  }, [n])
  useLayout(() => {
    if (variant === "line") measure()
  })
  React.useEffect(() => {
    if (variant !== "line" || typeof ResizeObserver === "undefined" || !rowRef.current) return
    const ro = new ResizeObserver(() => measure())
    ro.observe(rowRef.current)
    return () => ro.disconnect()
  }, [measure, variant])

  const list = (shown: React.ReactNode, extra?: string) => (
    <div ref={listRef} role="tablist" {...props} data-slot="tabs-list" data-variant={variant} onKeyDown={onArrows} className={cn(tabListVariants({ variant }), extra)}>
      {shown}
    </div>
  )
  if (variant !== "line") return <VariantContext.Provider value={variant}>{list(children, className)}</VariantContext.Provider>
  const k = Math.min(Math.max(fit, MIN_INLINE_TABS), n)
  const overflow = k < n ? tabs.slice(k) : []
  const inline = overflow.length ? tabs.slice(0, k) : tabs
  const active = overflow.find((t) => t.props.selected)
  // With the tab shown under More, the first tab shown takes the tablist's place in the keyboard order.
  const shown = active ? inline.map((t, i) => (i === 0 ? React.cloneElement(t, { focusable: true }) : t)) : inline
  return (
    <VariantContext.Provider value={variant}>
      <div ref={rowRef} className={cn(tabRow, className)} data-slot="tabs-row" data-variant={variant}>
        {list(shown, "shrink-0")}
        {overflow.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button ref={moreRef} type="button" data-slot="tabs-more" data-state={active ? "active" : "inactive"} className={tabVariants({ variant })} data-tabs-more>
                {active ? <>More: {active.props.children}</> : "More"}
                <ChevronDown className="size-4" aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" data-tabs-more-menu>
              {overflow.map((t, i) => (
                <DropdownMenuItem
                  key={t.key ?? i}
                  {...dataOf(t.props)}
                  disabled={t.props.disabled}
                  data-state={t.props.selected ? "active" : "inactive"}
                  aria-current={t.props.selected ? "page" : undefined}
                  className={t.props.selected ? "font-medium" : undefined}
                  onSelect={(e) => t.props.onClick?.(e as unknown as React.MouseEvent<HTMLButtonElement>)}
                  data-tabs-more-item
                >
                  {t.props.children}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </VariantContext.Provider>
  )
}

function Tab({ selected, focusable, className, ...props }: TabProps) {
  const variant = React.useContext(VariantContext)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      {...props}
      tabIndex={selected || focusable ? 0 : -1}
      data-slot="tabs-trigger"
      data-state={selected ? "active" : "inactive"}
      className={cn(tabVariants({ variant }), className)}
    />
  )
}

export { TabList, Tab, tabListVariants, tabVariants }
