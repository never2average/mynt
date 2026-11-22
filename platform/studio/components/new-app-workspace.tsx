"use client"

// New app, on the same chat workspace as Earn (components/chat-workspace-shell.tsx): the centred
// "What do you want to build?" with the composer, and the tabs on the right: Templates (Mynt's app
// kinds) and Products (what the app builds on). The composer's Products picker and the Products tab
// share one selection. Sending the message is Build it: it creates the app on the picked products and
// starts its first build with the message as the goal (and the template's kind), then opens the app.
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react"
import { Check, ChevronDown, LayoutTemplate, Package } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { EmptyRow, pagerOf } from "@/components/earn-view"
import { COL, matches, PanelList, useFitRows, usePaged } from "@/components/list-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { NewAppRequest, picksForKind, sendBlockedReason, type AppKind } from "@/lib/new-app"
import type { SlashCommand } from "@/lib/slash-commands"
import { cn } from "@/lib/utils"

export type NewAppProduct = { id: string; name: string; productLine: string; by: string; accessMode: string }
export type NewAppTab = "templates" | "products"

export const WELCOME_TITLE = "What do you want to build?"
const TAB_LABELS: Record<NewAppTab, string> = { templates: "Templates", products: "Products" }
const TAB_ICONS: Record<NewAppTab, typeof Package> = { templates: LayoutTemplate, products: Package }
export const lineLabel = (line: string) => line.replace(/_/g, " ")

// What the composer's Products button says: the one product's name, how many, or that none are picked yet.
export function pickerLabel(picked: readonly string[], products: readonly NewAppProduct[] | null): string {
  if (!picked.length) return "Pick products"
  if (picked.length === 1) return products?.find((p) => p.id === picked[0])?.name ?? "Products · 1"
  return `Products · ${picked.length}`
}

export function newAppCommands(go: { tab: (t: NewAppTab) => void; applyKind: (k: AppKind) => void }, kinds: readonly AppKind[]): SlashCommand[] {
  return [
    { name: "templates", description: "Open Templates", run: () => go.tab("templates") },
    { name: "products", description: "Open Products", run: () => go.tab("products") },
    ...kinds.map((k) => ({ name: k.id, description: `Start from ${k.title}`, run: () => go.applyKind(k) })),
  ]
}

const pickedCount = (n: number) => (n ? `${n} picked` : "Pick at least one")

// ---- the composer's Products picker ----

export function ProductPicker({ products, picked, onToggle, onClear }: { products: NewAppProduct[] | null; picked: string[]; onToggle: (id: string) => void; onClear: () => void }) {
  const [query, setQuery] = useState("")
  const shown = (products ?? []).filter((p) => matches(query, p.name, p.by, lineLabel(p.productLine)))
  const lines = [...new Set(shown.map((p) => p.productLine))].sort()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-8 max-w-56 gap-1.5" aria-label={`Products: ${pickerLabel(picked, products)}`} data-product-picker>
          <Package />
          <span className="truncate text-xs" data-product-picker-label>
            {pickerLabel(picked, products)}
          </span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col gap-2 p-2" data-product-picker-menu>
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search products" aria-label="Search products to pick" className="h-8" />
        <div className="max-h-72 overflow-y-auto" role="group" aria-label="Products">
          {products === null ? (
            <Skeleton className="m-2 h-4" data-loading />
          ) : !shown.length ? (
            <p className="p-2 text-sm text-muted-foreground">No products match.</p>
          ) : (
            lines.map((line) => (
              <div key={line} data-picker-line={line}>
                <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground capitalize">{lineLabel(line) || "Other"}</p>
                {shown
                  .filter((p) => p.productLine === line)
                  .map((p) => {
                    const on = picked.includes(p.id)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => onToggle(p.id)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                        data-picker-option={p.id}
                      >
                        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="size-3" />}</span>
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                      </button>
                    )
                  })}
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t px-1 pt-2 text-xs">
          <span className="text-muted-foreground tabular-nums" data-picker-count>
            {pickedCount(picked.length)}
          </span>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={onClear} disabled={!picked.length} data-picker-clear>
            Clear
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ---- the tabs ----

const TEMPLATE_COLUMNS = [
  { label: "Kind", className: COL.name },
  { label: "Description", className: COL.wide },
  { label: "Product lines", className: COL.text },
  { label: "", className: COL.actions },
]

export function TemplatesTab({ kinds, onUse }: { kinds: AppKind[] | null; onUse: (k: AppKind) => void }) {
  const [query, setQuery] = useState("")
  const shown = (kinds ?? []).filter((k) => matches(query, k.title, k.description, ...k.productLines.map(lineLabel)))
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  return (
    <PanelList
      id="templates"
      noun={["template", "templates"]}
      search={query}
      onSearch={(v) => {
        setQuery(v)
        paged.setPage(1)
      }}
      searchLabel="Search templates"
      areaRef={fit.ref}
      {...pagerOf(paged, shown.length)}
    >
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            {TEMPLATE_COLUMNS.map((c) => (
              <TableHead key={c.label || "actions"} className={c.className}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {kinds === null ? (
            <TableRow data-loading>
              <TableCell colSpan={TEMPLATE_COLUMNS.length}>
                <Skeleton className="h-4" />
              </TableCell>
            </TableRow>
          ) : paged.shown.length ? (
            paged.shown.map((k) => (
              <TableRow key={k.id} data-template-row={k.id}>
                <TableCell className={`${COL.name} font-medium`}>{k.title}</TableCell>
                <TableCell className={COL.wide}>
                  <span className="block max-w-80 truncate" title={k.description}>
                    {k.description}
                  </span>
                </TableCell>
                <TableCell className={COL.text}>
                  <span className="flex flex-wrap gap-1">
                    {k.productLines.map((l) => (
                      <Badge key={l} variant="outline">
                        {lineLabel(l)}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell className={COL.actions}>
                  <Button size="sm" variant="outline" onClick={() => onUse(k)} data-use-template={k.id}>
                    Use
                  </Button>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <EmptyRow cols={TEMPLATE_COLUMNS.length}>{kinds.length ? "No templates match." : "No templates on this Mynt yet. Describe your app in the chat."}</EmptyRow>
          )}
        </TableBody>
      </Table>
    </PanelList>
  )
}

const PRODUCT_COLUMNS = [
  { label: "", className: "w-px" },
  { label: "Product", className: COL.name },
  { label: "By", className: COL.text },
  { label: "Product line", className: COL.text },
]

export function ProductsTab({
  products,
  picked,
  onToggle,
  lines,
  onLines,
}: {
  products: NewAppProduct[] | null
  picked: string[]
  onToggle: (id: string) => void
  lines: string[]
  onLines: (lines: string[]) => void
}) {
  const [query, setQuery] = useState("")
  const options = useMemo(
    () => [...new Set((products ?? []).map((p) => p.productLine).filter(Boolean))].sort().map((l) => ({ value: l, label: lineLabel(l) })),
    [products],
  )
  const shown = (products ?? []).filter((p) => matches(query, p.name, p.by) && (!lines.length || lines.includes(p.productLine)))
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  return (
    <PanelList
      id="products"
      noun={["product", "products"]}
      search={query}
      onSearch={(v) => {
        setQuery(v)
        paged.setPage(1)
      }}
      searchLabel="Search products"
      facets={[
        {
          id: "line",
          label: "Product line",
          options,
          selected: lines,
          onChange: (v) => {
            onLines(v)
            paged.setPage(1)
          },
        },
      ]}
      onClearFilters={() => {
        onLines([])
        paged.setPage(1)
      }}
      cta={
        <span className="text-sm text-muted-foreground tabular-nums" data-picked-count>
          {pickedCount(picked.length)}
        </span>
      }
      areaRef={fit.ref}
      {...pagerOf(paged, shown.length)}
    >
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            {PRODUCT_COLUMNS.map((c) => (
              <TableHead key={c.label || "pick"} className={c.className}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody data-product-list>
          {products === null ? (
            [0, 1, 2].map((i) => (
              <TableRow key={i} data-loading>
                <TableCell colSpan={PRODUCT_COLUMNS.length}>
                  <Skeleton className="h-4" />
                </TableCell>
              </TableRow>
            ))
          ) : paged.shown.length ? (
            paged.shown.map((p) => {
              const on = picked.includes(p.id)
              return (
                <TableRow key={p.id} data-product-row={p.id} data-state={on ? "selected" : undefined}>
                  <TableCell className="w-px">
                    <input type="checkbox" className="size-4 accent-primary" checked={on} onChange={() => onToggle(p.id)} aria-label={`Pick ${p.name}`} data-pick={p.id} />
                  </TableCell>
                  <TableCell className={`${COL.name} font-medium`}>{p.name}</TableCell>
                  <TableCell className={COL.text}>{p.by || "—"}</TableCell>
                  <TableCell className={COL.text}>{p.productLine ? <Badge variant="outline">{lineLabel(p.productLine)}</Badge> : "—"}</TableCell>
                </TableRow>
              )
            })
          ) : (
            <EmptyRow cols={PRODUCT_COLUMNS.length}>{products.length ? "No products match." : "No products you can build on yet."}</EmptyRow>
          )}
        </TableBody>
      </Table>
    </PanelList>
  )
}

// ---- the page ----

export function NewAppWorkspace({
  products,
  kinds,
  onBuild,
  isMobile,
}: {
  products: NewAppProduct[] | null
  kinds: AppKind[] | null
  // Creates the app and starts its build; returns an error to show, or null once it's on its way.
  onBuild: (request: NewAppRequest) => Promise<string | null>
  isMobile?: boolean
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [lines, setLines] = useState<string[]>([])
  const [kind, setKind] = useState<string | null>(null)
  const [tab, setTab] = useState<NewAppTab>("templates")
  const [opened, setOpened] = useState(false)
  const [messages, setMessages] = useState<ThreadMessageLike[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  // What's typed, for the composer's reason it can't send yet.
  const [text, setText] = useState("")
  const blocked = sendBlockedReason(picked, text)

  // One request at a time: a second send while one runs is ignored.
  const inFlight = useRef(false)
  const onNew = async (m: AppendMessage) => {
    const prompt = m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
    if (inFlight.current) return
    const request = { prompt, product_ids: picked, ...(kind ? { kind } : {}) }
    // The same rules the server applies (lib/new-app.ts); what's typed comes back to fix.
    const parsed = NewAppRequest.safeParse(request)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check what you entered.")
      setTimeout(() => runtime.thread.composer.setText(prompt), 0)
      return
    }
    inFlight.current = true
    setBusy(true)
    setError(null)
    setOpened(true)
    setMessages([{ role: "user", content: prompt }])
    const failed = await onBuild(parsed.data)
    if (failed) {
      setError(failed)
      setMessages([])
      setBusy(false)
      inFlight.current = false
      runtime.thread.composer.setText(prompt)
    }
  }
  const runtime = useExternalStoreRuntime({ messages, isRunning: busy, convertMessage: (m: ThreadMessageLike) => m, onNew })
  useEffect(() => {
    const composer = runtime.thread.composer
    const read = () => setText(composer.getState().text)
    read()
    return composer.subscribe(read)
  }, [runtime])

  const open = (t: NewAppTab) => {
    setTab(t)
    setOpened(true)
  }
  // A template: its goal in the composer to edit, its product lines filtered and one product of each picked.
  const applyKind = (k: AppKind) => {
    setKind(k.id)
    runtime.thread.composer.setText(k.goalTemplate)
    setLines(k.productLines)
    if (products) setPicked((p) => picksForKind(k, products, p))
    setError(null)
  }
  const commands = newAppCommands({ tab: open, applyKind }, kinds ?? [])
  const chips = (kinds ?? []).length ? (
    <div className="mt-6 flex flex-wrap justify-center gap-2 px-4" data-chips>
      {(kinds ?? []).map((k) => (
        <button
          key={k.id}
          type="button"
          onClick={() => applyKind(k)}
          className="rounded-full border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          data-chip={k.id}
          title={k.description}
        >
          {k.title}
        </button>
      ))}
    </div>
  ) : null

  const content = (t: NewAppTab) =>
    t === "templates" ? (
      <TemplatesTab
        kinds={kinds}
        onUse={(k) => {
          applyKind(k)
        }}
      />
    ) : (
      <ProductsTab products={products} picked={picked} onToggle={toggle} lines={lines} onLines={setLines} />
    )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatWorkspaceShell
        chat={
          <div className="relative h-full" data-new-app-chat>
            <Thread
              welcome={<ChatWelcome title={WELCOME_TITLE}>{chips}</ChatWelcome>}
              placeholder="Describe the app: who it's for and what they can do…"
              toolbar={<ProductPicker products={products} picked={picked} onToggle={toggle} onClear={() => setPicked([])} />}
              commands={commands}
              sendBlocked={busy ? null : blocked}
              note={
                error ? (
                  <span role="alert" className="text-destructive" data-new-app-error>
                    {error}
                  </span>
                ) : busy ? (
                  <span role="status">Creating the app and starting its first build…</span>
                ) : null
              }
            />
          </div>
        }
        onOpenPanel={() => setOpened(true)}
        showPanel={opened || messages.length > 0}
        tabs={(["templates", "products"] as const).map((t) => ({ id: t, label: TAB_LABELS[t], badge: t === "products" ? picked.length || undefined : undefined, content: content(t), icon: TAB_ICONS[t] }))}
        tab={tab}
        onTab={(id) => open(id as NewAppTab)}
        isMobile={isMobile}
      />
    </AssistantRuntimeProvider>
  )
}
