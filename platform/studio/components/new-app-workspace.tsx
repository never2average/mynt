"use client"

// New app, on the same chat workspace as Earn (components/chat-workspace-shell.tsx): the centred
// "What do you want to build?" with the composer and a few app ideas as chips, and the tabs on the right:
// Templates (the ideas on each of Mynt's app kinds) and Products (what the app builds on). The composer's
// Products picker and the Products tab share one selection. Sending the message is Build it: it creates the app on the picked products and
// starts its first build with the message as the goal (and the template's kind), then opens the app.
// The first build runs on Mynt's own cap (there is no cap control here). Until it can send, the reason
// is the disabled Send's tooltip, never a line under the composer.
// Each product shows the flags of the countries it's offered in. Create product (the picker's last item
// and the Products tab's button) opens one sheet; the new product is listed as Draft, with Test and
// Publish on its row, and can't be picked until it's published.
// The composer's toggle switches between Build app and Create product (so does /create-product, and
// "/create-product <description>" sent from Build app goes there with its description). In Create
// product the chat drafts a product with the assistant (components/product-chat.tsx, lib/product-chat.ts);
// its draft card opens the same sheet, filled in. A Build app message that clearly asks for a product
// only offers the switch: what's sent in Build app is always a build.
// Under the welcome, Recent lists the threads the user touched last (components/recent-threads.tsx,
// lib/threads.ts): an app opens its page, a product chat comes back here in Create product with its
// messages and drafts, a product opens the Products tab on it.
import { useChat } from "@ai-sdk/react"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react"
import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai"
import { Check, ChevronDown, LayoutTemplate, Package, Plus } from "lucide-react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { CreateProductSheet } from "@/components/create-product-sheet"
import { RecentThreads } from "@/components/recent-threads"
import { ChatSaver, listChats, loadChat, migrateLocalChats, newThreadId, sessionIdFor } from "@/lib/chat-sessions"
import { announceThreads, mergeThreads, type AppThreadSource, type MyProduct, type OpenThreadDetail, type ProductChatRecord, type StudioThread } from "@/lib/threads"
import { EmptyRow, pagerOf } from "@/components/earn-view"
import { COL, matches, PanelList, useFitRows, usePaged } from "@/components/list-layout"
import { ModeToggle, ProductChat, type DraftCards } from "@/components/product-chat"
import { askFetch, withoutReasoning } from "@/lib/ask-client"
import { asksForProduct, PRODUCT_WELCOME_TITLE, productCommandText, SWITCH_SUGGESTION, type NewAppMode, type ProductDraft } from "@/lib/product-chat"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { chipIdeas, kindIdeas, NewAppRequest, picksForKind, sendBlockedReason, type AppIdea, type AppKind } from "@/lib/new-app"
import { flagsFor, isPickable, NOT_PUBLISHED, runProductAction, STATUS_LABEL, type ProductAction, type StudioProduct } from "@/lib/products"
import type { SlashCommand } from "@/lib/slash-commands"
import { cn } from "@/lib/utils"

export type NewAppProduct = StudioProduct
export type NewAppTab = "templates" | "products"

export const WELCOME_TITLE = "What do you want to build?"
const TAB_LABELS: Record<NewAppTab, string> = { templates: "Templates", products: "Products" }
const TAB_ICONS: Record<NewAppTab, typeof Package> = { templates: LayoutTemplate, products: Package }
export const lineLabel = (line: string) => line.replace(/_/g, " ")

// A product's flags: one per country it's offered in, before its name (none for global or unknown).
export const flagText = (p: Pick<NewAppProduct, "jurisdictions"> | undefined) =>
  flagsFor(p?.jurisdictions ?? [])
    .map((f) => f.emoji)
    .join(" ")

export function Flags({ product }: { product: Pick<NewAppProduct, "jurisdictions"> }) {
  const flags = flagsFor(product.jurisdictions ?? [])
  if (!flags.length) return null
  return (
    <span className="inline-flex shrink-0 gap-0.5" data-flags>
      {flags.map((f) => (
        <span key={f.code} role="img" aria-label={f.name} title={f.name} data-flag={f.code}>
          {f.emoji}
        </span>
      ))}
    </span>
  )
}

// What the composer's Products button says: the one product's name (after its flags), how many, or that none are picked yet.
export function pickerLabel(picked: readonly string[], products: readonly NewAppProduct[] | null): string {
  if (!picked.length) return "Pick products"
  if (picked.length === 1) {
    const one = products?.find((p) => p.id === picked[0])
    if (!one) return "Products · 1"
    const flags = flagText(one)
    return flags ? `${flags} ${one.name}` : one.name
  }
  return `Products · ${picked.length}`
}

// Build app's commands. /create-product switches to Create product (typed with a description after it
// and sent, it sends that description there).
export function newAppCommands(go: { tab: (t: NewAppTab) => void; applyKind: (k: AppKind) => void; createProduct?: () => void }, kinds: readonly AppKind[]): SlashCommand[] {
  return [
    { name: "templates", description: "Open Templates", run: () => go.tab("templates") },
    { name: "products", description: "Open Products", run: () => go.tab("products") },
    ...(go.createProduct ? [{ name: "create-product", description: "Create a product: describe it in the chat", run: go.createProduct }] : []),
    ...kinds.map((k) => ({ name: k.id, description: `Start from ${k.title}`, run: () => go.applyKind(k) })),
  ]
}

// Create product's commands: back to Build app, and the tabs.
export function productModeCommands(go: { tab: (t: NewAppTab) => void; buildApp: () => void }): SlashCommand[] {
  return [
    { name: "build-app", description: "Build an app instead", run: go.buildApp },
    { name: "templates", description: "Open Templates", run: () => go.tab("templates") },
    { name: "products", description: "Open Products", run: () => go.tab("products") },
  ]
}

const productTransport = () => new DefaultChatTransport<UIMessage>({ api: "/api/product-chat", fetch: askFetch, prepareSendMessagesRequest: withoutReasoning })
export const AI_OFF = "AI is not configured on this studio. Use Create product in the Products tab instead."

const pickedCount = (n: number) => (n ? `${n} picked` : "Pick at least one")

// ---- the composer's Products picker ----

export function ProductPicker({
  products,
  picked,
  onToggle,
  onClear,
  onCreate,
}: {
  products: NewAppProduct[] | null
  picked: string[]
  onToggle: (id: string) => void
  onClear: () => void
  onCreate?: () => void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const shown = (products ?? []).filter((p) => matches(query, p.name, p.by, lineLabel(p.productLine)))
  const lines = [...new Set(shown.map((p) => p.productLine))].sort()
  return (
    <Popover open={open} onOpenChange={setOpen}>
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
                    const pickable = isPickable(p)
                    return (
                      <button
                        key={p.id}
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        onClick={() => onToggle(p.id)}
                        disabled={!pickable}
                        title={pickable ? undefined : NOT_PUBLISHED}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                        data-picker-option={p.id}
                      >
                        <span className={cn("flex size-4 shrink-0 items-center justify-center rounded border", on && "border-primary bg-primary text-primary-foreground")}>{on && <Check className="size-3" />}</span>
                        <Flags product={p} />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {!pickable && p.status && <span className="shrink-0 text-xs text-muted-foreground">{STATUS_LABEL[p.status]}</span>}
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
        {onCreate && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-8 justify-start"
            onClick={() => {
              setOpen(false)
              onCreate()
            }}
            data-picker-create
          >
            <Plus />
            Create product
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ---- the tabs ----

const TEMPLATE_COLUMNS = [
  { label: "Problem", className: COL.name },
  { label: "What the app does", className: COL.wide },
  { label: "Kind", className: COL.text },
  { label: "Product lines", className: COL.text },
  { label: "", className: COL.actions },
]

// Every kind's app ideas, grouped by kind: a heading row where each kind's ideas start on the page.
export function TemplatesTab({ kinds, onUse }: { kinds: AppKind[] | null; onUse: (k: AppKind, idea: AppIdea) => void }) {
  const [query, setQuery] = useState("")
  const shown = kindIdeas(kinds ?? []).filter(({ kind, idea }) => matches(query, idea.problem, idea.pitch, kind.title, ...idea.productLines.map(lineLabel)))
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
            paged.shown.map(({ kind, idea }, i) => (
              <Fragment key={`${kind.id}/${idea.id}`}>
                {(i === 0 || paged.shown[i - 1].kind.id !== kind.id) && (
                  <TableRow className="hover:bg-transparent" data-template-group={kind.id}>
                    <TableCell colSpan={TEMPLATE_COLUMNS.length} className="bg-muted/40 py-1.5 text-xs font-medium text-muted-foreground">
                      {kind.title}
                    </TableCell>
                  </TableRow>
                )}
                <TableRow data-template-row={idea.id} data-template-kind={kind.id}>
                  <TableCell className={`${COL.name} font-medium`}>{idea.problem}</TableCell>
                  <TableCell className={COL.wide}>
                    <span className="block max-w-80 truncate" title={idea.pitch}>
                      {idea.pitch}
                    </span>
                  </TableCell>
                  <TableCell className={COL.text}>{kind.title}</TableCell>
                  <TableCell className={COL.text}>
                    <span className="flex flex-wrap gap-1">
                      {idea.productLines.map((l) => (
                        <Badge key={l} variant="outline">
                          {lineLabel(l)}
                        </Badge>
                      ))}
                    </span>
                  </TableCell>
                  <TableCell className={COL.actions}>
                    <Button size="sm" variant="outline" onClick={() => onUse(kind, idea)} data-use-template={idea.id}>
                      Use
                    </Button>
                  </TableCell>
                </TableRow>
              </Fragment>
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
  { label: "", className: COL.actions },
]

// A draft's Test or Publish: what Mynt said, shown on its row.
export type RowNote = { text: string; failed: boolean }

export function ProductsTab({
  products,
  picked,
  onToggle,
  lines,
  onLines,
  onCreate,
  onAction,
  focus = null,
}: {
  products: NewAppProduct[] | null
  picked: string[]
  onToggle: (id: string) => void
  lines: string[]
  onLines: (lines: string[]) => void
  onCreate?: () => void
  // Test or Publish one of the user's drafts: what to show on its row.
  onAction?: (id: string, action: ProductAction) => Promise<RowNote>
  // A product opened from Recent or the sidebar: searched for and marked.
  focus?: string | null
}) {
  const [notes, setNotes] = useState<Record<string, RowNote>>({})
  const [running, setRunning] = useState<string | null>(null)
  const act = async (id: string, action: ProductAction) => {
    if (!onAction || running) return
    setRunning(`${id}:${action}`)
    const note = await onAction(id, action)
    setRunning(null)
    setNotes((n) => ({ ...n, [id]: note }))
  }
  const [query, setQuery] = useState("")
  const options = useMemo(
    () => [...new Set((products ?? []).map((p) => p.productLine).filter(Boolean))].sort().map((l) => ({ value: l, label: lineLabel(l) })),
    [products],
  )
  const shown = (products ?? []).filter((p) => matches(query, p.name, p.by) && (!lines.length || lines.includes(p.productLine)))
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  const focused = focus ? products?.find((p) => p.id === focus) : undefined
  useEffect(() => {
    if (!focused) return
    setQuery(focused.name)
    onLines([])
    paged.setPage(1)
    // Only when another product is opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focused?.id])
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
        <span className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground tabular-nums" data-picked-count>
            {pickedCount(picked.length)}
          </span>
          {onCreate && (
            <Button size="sm" className="h-9" onClick={onCreate} data-create-product>
              <Plus />
              Create product
            </Button>
          )}
        </span>
      }
      areaRef={fit.ref}
      {...pagerOf(paged, shown.length)}
    >
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            {PRODUCT_COLUMNS.map((c) => (
              <TableHead key={c.label || (c.className === COL.actions ? "actions" : "pick")} className={c.className}>
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
              const pickable = isPickable(p)
              const note = notes[p.id]
              return (
                <TableRow key={p.id} data-product-row={p.id} data-state={on ? "selected" : undefined} data-focused={p.id === focus ? "true" : undefined} className={cn(p.id === focus && "bg-muted/60")}>
                  <TableCell className="w-px">
                    <span className="inline-flex" title={pickable ? undefined : NOT_PUBLISHED}>
                      <input
                        type="checkbox"
                        className="size-4 accent-primary disabled:cursor-not-allowed"
                        checked={on}
                        onChange={() => onToggle(p.id)}
                        disabled={!pickable}
                        title={pickable ? undefined : NOT_PUBLISHED}
                        aria-label={`Pick ${p.name}`}
                        aria-description={pickable ? undefined : NOT_PUBLISHED}
                        data-pick={p.id}
                      />
                    </span>
                  </TableCell>
                  <TableCell className={`${COL.name} font-medium`}>
                    <span className="flex items-center gap-1.5">
                      <Flags product={p} />
                      <span className="truncate">{p.name}</span>
                      {!pickable && p.status && (
                        <span className="shrink-0 text-xs font-normal text-muted-foreground" data-product-status>
                          {STATUS_LABEL[p.status]}
                        </span>
                      )}
                    </span>
                    {note && (
                      <span role={note.failed ? "alert" : "status"} className={cn("mt-1 block max-w-96 text-xs font-normal whitespace-normal", note.failed ? "text-destructive" : "text-muted-foreground")} data-product-note>
                        {note.text}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className={COL.text}>{p.by || "—"}</TableCell>
                  <TableCell className={COL.text}>{p.productLine ? <Badge variant="outline">{lineLabel(p.productLine)}</Badge> : "—"}</TableCell>
                  <TableCell className={COL.actions}>
                    {p.mine && !pickable && onAction && (
                      <span className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" disabled={running !== null} onClick={() => void act(p.id, "test")} data-product-test={p.id}>
                          {running === `${p.id}:test` ? "Testing…" : "Test"}
                        </Button>
                        <Button size="sm" variant="outline" disabled={running !== null} onClick={() => void act(p.id, "publish")} data-product-publish={p.id}>
                          {running === `${p.id}:publish` ? "Publishing…" : "Publish"}
                        </Button>
                      </span>
                    )}
                  </TableCell>
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
  onProductsChange,
  isMobile,
  fetcher = (...a) => fetch(...a),
  transport,
  apps = null,
  myProducts = null,
  historyOwner = null,
  openRequest = null,
  onOpenApp,
}: {
  products: NewAppProduct[] | null
  kinds: AppKind[] | null
  // Creates the app and starts its build; returns an error to show, or null once it's on its way.
  onBuild: (request: NewAppRequest) => Promise<string | null>
  // A product created or published here: the page's list, changed.
  onProductsChange?: (change: (products: NewAppProduct[]) => NewAppProduct[]) => void
  isMobile?: boolean
  fetcher?: typeof fetch
  // Create product mode's chat (app/api/product-chat unless given).
  transport?: ChatTransport<UIMessage>
  // Recent's threads (lib/threads.ts): the user's apps, their own products, and the user's key (their
  // product chats are kept on Mynt once it's known; older ones in this browser under it move there).
  apps?: AppThreadSource[] | null
  myProducts?: MyProduct[] | null
  historyOwner?: string | null
  // A product chat or product to open (from the address or the sidebar); n changes each time.
  openRequest?: (OpenThreadDetail & { n: number }) | null
  // Opens an app's page (its chat).
  onOpenApp?: (href: string) => void
}) {
  // ---- Create product: the sheet, and the chat that drafts for it ----
  const [creating, setCreating] = useState(false)
  // The chat's draft the sheet is open on (null: the plain form).
  const [sheetDraft, setSheetDraft] = useState<ProductDraft | null>(null)
  // Drafts already created, by draft id: their cards can't be sent again.
  const [createdDrafts, setCreatedDrafts] = useState<Record<string, string>>({})
  const openSheet = () => {
    setSheetDraft(null)
    setCreating(true)
  }
  const onCreated = (p: NewAppProduct) => {
    onProductsChange?.((list) => [...list.filter((x) => x.id !== p.id), p])
    noteMine({ id: p.id, name: p.name, status: p.status ?? "draft", updatedAt: new Date().toISOString() })
    if (sheetDraft) {
      const id = sheetDraft.id
      setCreatedDrafts((c) => ({ ...c, [id]: p.id }))
      setSheetDraft(null)
      // The new Draft, with its Test and Publish, in view.
      setTab("products")
      setOpened(true)
    }
  }
  const cards: DraftCards = {
    created: createdDrafts,
    review: (d) => {
      if (createdDrafts[d.id]) return
      setSheetDraft(d)
      setCreating(true)
    },
  }
  const [chatTransport] = useState(() => transport ?? productTransport())
  const productChat = useChat<UIMessage>({ id: "studio-new-product", transport: chatTransport })
  const [mode, setMode] = useState<NewAppMode>("build")
  const [ai, setAi] = useState<"loading" | "enabled" | "disabled">("loading")
  const aiChecked = useRef(false)
  useEffect(() => {
    if (mode !== "product" || aiChecked.current) return
    aiChecked.current = true
    void (async () => {
      const res = await fetcher("/api/product-chat", { cache: "no-store" }).catch(() => null)
      const data = res?.ok ? ((await res.json().catch(() => null)) as { enabled?: unknown } | null) : null
      setAi(data?.enabled === true ? "enabled" : "disabled")
    })()
  }, [mode, fetcher])
  // What's typed in Create product's composer, and what Build app's carries over to it.
  const productText = useRef("")
  const onProductText = useCallback((t: string) => void (productText.current = t), [])
  const [carry, setCarry] = useState<{ text: string; n: number } | null>(null)
  const onAction = async (id: string, action: ProductAction): Promise<RowNote> => {
    const result = await runProductAction(id, action, fetcher)
    if (!result.ok) return { text: result.message, failed: true }
    if (action === "publish") {
      onProductsChange?.((list) => list.map((p) => (p.id === id ? { ...p, status: "published" as const } : p)))
      const p = products?.find((x) => x.id === id)
      if (p) noteMine({ id, name: p.name, status: "published", updatedAt: new Date().toISOString() })
    }
    return { text: result.data.message ?? (action === "publish" ? "Published." : "Tested."), failed: action === "test" && result.data.passed === false }
  }
  const [picked, setPicked] = useState<string[]>([])
  const [lines, setLines] = useState<string[]>([])
  const [kind, setKind] = useState<string | null>(null)
  const [tab, setTab] = useState<NewAppTab>("templates")
  const [opened, setOpened] = useState(false)
  const [messages, setMessages] = useState<ThreadMessageLike[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only published products can be picked (a draft's checkbox is disabled; this holds whatever calls it).
  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : products?.some((x) => x.id === id && isPickable(x)) ? [...p, id] : p))
  // What's typed, for the composer's reason it can't send yet.
  const [text, setText] = useState("")
  // "/create-product <description>" goes to Create product, so it isn't held back by Build app's rules.
  const blocked = productCommandText(text) !== null ? null : sendBlockedReason(picked, text)

  // Switching mode carries what's typed to the other composer; `send` is sent there at once.
  const switchMode = (next: NewAppMode, opts: { text?: string; send?: string } = {}) => {
    if (next === mode && opts.send === undefined) return
    setError(null)
    if (next === "product") {
      const typed = opts.text ?? runtime.thread.composer.getState().text
      runtime.thread.composer.setText("")
      setMode("product")
      setCarry((c) => ({ text: opts.send ? "" : typed, n: (c?.n ?? 0) + 1 }))
      if (opts.send) void productChat.sendMessage({ text: opts.send })
    } else {
      const typed = opts.text ?? productText.current
      setMode("build")
      runtime.thread.composer.setText(typed)
    }
  }

  // One request at a time: a second send while one runs is ignored.
  const inFlight = useRef(false)
  const onNew = async (m: AppendMessage) => {
    const prompt = m.content.map((p) => (p.type === "text" ? p.text : "")).join("\n")
    if (inFlight.current) return
    // "/create-product <description>": drafting, never a build.
    const described = productCommandText(prompt)
    if (described !== null) return switchMode("product", described ? { send: described } : { text: "" })
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
  // An idea (or a kind's own goal): its goal in the composer to edit, its kind, its product lines filtered
  // and one product of each picked.
  const applyIdea = (k: AppKind, idea?: AppIdea) => {
    const lines = idea?.productLines ?? k.productLines
    setKind(k.id)
    runtime.thread.composer.setText(idea?.goal ?? k.goalTemplate)
    setLines(lines)
    if (products) setPicked((p) => picksForKind({ productLines: lines }, products.filter(isPickable), p))
    setError(null)
  }
  const applyKind = (k: AppKind) => applyIdea(k)
  const commands = newAppCommands({ tab: open, applyKind, createProduct: () => switchMode("product", { text: "" }) }, kinds ?? [])
  const productCommands = productModeCommands({ tab: open, buildApp: () => switchMode("build", { text: "" }) })
  const drafting = productChat.status === "submitted" || productChat.status === "streaming"

  // ---- threads: Recent, View all, and reopening a product chat ----
  // This product chat is kept on Mynt for the user (lib/chat-sessions.ts) from its first message, and
  // again whenever a reply settles or a draft of it is created. A save that fails is tried again; the
  // open chat is never lost for it.
  const [threadId, setThreadId] = useState(newThreadId)
  const [chats, setChats] = useState<ProductChatRecord[]>([])
  // The fetcher as of the last render, behind one function that never changes (the saver lives as long as the page).
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher
  const threadFetch = useCallback<typeof fetch>((...a) => fetchRef.current(...a), [])
  const reloadChats = useCallback(async () => {
    const list = await listChats("product", { fetcher: threadFetch })
    if (list) setChats(list)
  }, [threadFetch])
  const saver = useMemo(() => new ChatSaver("product", { fetcher: threadFetch, onSaved: () => void reloadChats().then(() => announceThreads()) }), [threadFetch, reloadChats])
  useEffect(() => () => saver.dispose(), [saver])
  // Once the user is known: chats an older studio kept in this browser go to Mynt, then the list is read.
  useEffect(() => {
    if (!historyOwner) return
    let live = true
    void (async () => {
      const moved = await migrateLocalChats("product", historyOwner, { fetcher: threadFetch })
      if (!live) return
      await reloadChats()
      if (moved) announceThreads()
    })()
    return () => {
      live = false
    }
  }, [historyOwner, threadFetch, reloadChats])
  const savedFirst = useRef("")
  useEffect(() => {
    if (!historyOwner || !productChat.messages.length) return
    const first = savedFirst.current !== threadId
    // While a reply streams, only the first message is saved (at once); the reply once it settles.
    if (drafting && !first) return
    savedFirst.current = threadId
    const messages = drafting ? productChat.messages.filter((m, i, all) => !(i === all.length - 1 && m.role === "assistant")) : productChat.messages
    const created = Object.entries(createdDrafts)
    saver.save(
      threadId,
      { messages, outcomes: Object.fromEntries(created.map(([d, p]) => [d, { product_id: p }])), metadata: created.length ? { product_ids: created.map(([, p]) => p) } : undefined },
      { now: first },
    )
  }, [historyOwner, drafting, productChat.messages, createdDrafts, threadId, saver])
  // Products created or published here, until the page's list says so.
  const [localMine, setLocalMine] = useState<MyProduct[]>([])
  const noteMine = (p: MyProduct) => {
    setLocalMine((l) => [...l.filter((x) => x.id !== p.id), p])
    announceThreads({ products: true })
  }
  const threads = useMemo(() => {
    const mine = [...(myProducts ?? []).filter((p) => !localMine.some((l) => l.id === p.id)), ...localMine]
    return mergeThreads(apps, chats, mine)
  }, [apps, chats, myProducts, localMine])
  const [focus, setFocus] = useState<string | null>(null)
  // Reopens one of the user's product chats, read back from Mynt with the drafts it created (so none
  // is created twice). What it holds is already saved, so reopening it saves nothing.
  const restoreChat = async (link: string): Promise<boolean> => {
    const id = sessionIdFor(link)
    if (id === threadId && productChat.messages.length) {
      setMode("product")
      return true
    }
    const rec = await loadChat(id, threadFetch)
    if (!rec) return false
    if (drafting) void productChat.stop()
    const created = Object.fromEntries(Object.entries(rec.outcomes).filter(([, o]) => typeof o.product_id === "string").map(([d, o]) => [d, o.product_id as string]))
    saver.adopt(rec.id, rec)
    savedFirst.current = rec.id
    productChat.setMessages(rec.messages)
    setThreadId(rec.id)
    setCreatedDrafts(created)
    setError(null)
    setMode("product")
    return true
  }
  const focusProduct = (id: string) => {
    setFocus(id)
    setTab("products")
    setOpened(true)
    if (products?.some((p) => p.id === id && isPickable(p))) setPicked((p) => (p.includes(id) ? p : [...p, id]))
  }
  const openThread = (t: StudioThread) => {
    if (t.source === "app") {
      if (onOpenApp) onOpenApp(t.href)
      else if (typeof window !== "undefined") window.location.assign(t.href)
    } else if (t.source === "chat") void restoreChat(t.id)
    else focusProduct(t.id)
  }
  // From the address (?thread=, ?product=) or the sidebar: once what it needs has loaded.
  const appliedOpen = useRef(0)
  useEffect(() => {
    if (!openRequest || appliedOpen.current === openRequest.n) return
    if (openRequest.thread) {
      if (!historyOwner) return
      appliedOpen.current = openRequest.n
      void restoreChat(openRequest.thread)
    } else if (openRequest.product) {
      if (!products) return
      appliedOpen.current = openRequest.n
      focusProduct(openRequest.product)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest?.n, historyOwner, products])
  const recent = <RecentThreads threads={threads} onOpen={openThread} />
  const modeToggle = <ModeToggle mode={mode} onMode={(m) => switchMode(m)} />
  // Build app: what's typed clearly asks for a product, so Create product is offered (never switched to unasked).
  const suggestProduct = mode === "build" && !busy && !error && asksForProduct(text)
  // A few ideas under the welcome, each labelled by its problem, picked once per page load (a Mynt with no
  // ideas yet shows the kinds).
  const [seed] = useState(() => Math.random())
  const chipList = useMemo<{ kind: AppKind; idea: AppIdea | null }[]>(() => {
    const ideas = chipIdeas(kinds ?? [], seed)
    return ideas.length ? ideas : (kinds ?? []).map((kind) => ({ kind, idea: null }))
  }, [kinds, seed])
  const chips = chipList.length ? (
    <div className="mt-6 flex flex-wrap justify-center gap-2 px-4" data-chips>
      {chipList.map(({ kind, idea }) => (
        <button
          key={idea?.id ?? kind.id}
          type="button"
          onClick={() => applyIdea(kind, idea ?? undefined)}
          className="rounded-full border bg-background px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          data-chip={idea?.id ?? kind.id}
          data-chip-kind={kind.id}
          title={idea?.pitch ?? kind.description}
        >
          {idea?.problem ?? kind.title}
        </button>
      ))}
    </div>
  ) : null

  const content = (t: NewAppTab) =>
    t === "templates" ? (
      <TemplatesTab kinds={kinds} onUse={applyIdea} />
    ) : (
      <ProductsTab products={products} picked={picked} onToggle={toggle} lines={lines} onLines={setLines} onCreate={openSheet} onAction={onAction} focus={focus} />
    )

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatWorkspaceShell
        chat={
          <div className="relative h-full" data-new-app-chat data-mode={mode}>
            {mode === "build" ? (
              <Thread
                welcome={
                  <ChatWelcome title={WELCOME_TITLE}>
                    {recent}
                    {chips}
                  </ChatWelcome>
                }
                placeholder="Describe the app: who it's for and what they can do…"
                toolbar={
                  <>
                    {modeToggle}
                    <ProductPicker products={products} picked={picked} onToggle={toggle} onClear={() => setPicked([])} onCreate={openSheet} />
                  </>
                }
                commands={commands}
                sendBlocked={busy ? null : blocked}
                sendBlockedNote={false}
                note={
                  error ? (
                    <span role="alert" className="text-destructive" data-new-app-error>
                      {error}
                    </span>
                  ) : busy ? (
                    <span role="status">Creating the app and starting its first build…</span>
                  ) : suggestProduct ? (
                    <span className="inline-flex flex-wrap items-center justify-center gap-2" data-suggest-product>
                      {SWITCH_SUGGESTION}
                      <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => switchMode("product")} data-switch-to-product>
                        Create product instead
                      </Button>
                    </span>
                  ) : null
                }
              />
            ) : (
              <ProductChat
                chat={productChat}
                cards={cards}
                welcome={<ChatWelcome title={PRODUCT_WELCOME_TITLE}>{recent}</ChatWelcome>}
                toolbar={modeToggle}
                commands={productCommands}
                sendBlocked={ai === "enabled" || drafting ? null : ai === "loading" ? "Checking the assistant…" : AI_OFF}
                note={
                  ai === "disabled" ? (
                    <span role="status" data-product-ai-off>
                      {AI_OFF}
                    </span>
                  ) : (
                    <span data-product-note>Drafts only: nothing is created until you confirm it in the Create product form.</span>
                  )
                }
                seed={carry}
                onText={onProductText}
              />
            )}
          </div>
        }
        onOpenPanel={() => setOpened(true)}
        showPanel={opened || messages.length > 0 || productChat.messages.length > 0}
        tabs={(["templates", "products"] as const).map((t) => ({ id: t, label: TAB_LABELS[t], badge: t === "products" ? picked.length || undefined : undefined, content: content(t), icon: TAB_ICONS[t] }))}
        tab={tab}
        onTab={(id) => open(id as NewAppTab)}
        isMobile={isMobile}
      />
      <CreateProductSheet
        open={creating}
        onOpenChange={setCreating}
        products={products}
        onCreated={onCreated}
        fetcher={fetcher}
        initial={sheetDraft ? { key: sheetDraft.id, request: sheetDraft.request } : null}
      />
    </AssistantRuntimeProvider>
  )
}
