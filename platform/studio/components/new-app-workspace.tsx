"use client"

// New app, on the same chat workspace as Earn (components/chat-workspace-shell.tsx): the centred
// "What do you want to build?" with the composer and a few app ideas as chips, and the tabs on the right:
// Templates (the ideas on each of Mynt's app kinds) and Products (what the app builds on). The composer's
// Products picker and the Products tab share one selection. Sending the message is Build it: it creates the app on the picked products and
// starts its first build with the message as the goal (and the template's kind), then opens the app.
// The first build runs on Mynt's own cap (there is no cap control here). Until it can send, the reason
// is the disabled Send's tooltip, never a line under the composer.
// An idea's chip picks its products (lib/new-app.ts picksForKind); one with no published product isn't a chip.
// Each product shows the flags of the countries it's offered in, and its stage as apps show theirs (Idea,
// Staging, Production). Create product (the picker's last item and the Products tab's button) opens one
// sheet; the new product is listed as an Idea, with Move to staging on its row, and can't be picked until
// it's in Staging (sandbox builds) or Production. The user's own products move between stages from their
// rows (Move to staging, Move to production, Move back), each through the approval sheet
// (components/product-stage-sheet.tsx), as apps move.
// The composer's toggle switches between Build app and Create product (so does /create-product, and
// "/create-product <description>" sent from Build app goes there with its description). In Create
// product the chat drafts a product with the assistant (components/product-chat.tsx, lib/product-chat.ts);
// its draft card opens the same sheet, filled in. Its chips and Templates rows are product ideas
// (lib/product-ideas.ts) instead of app ideas: a chip starts the chat with the idea as the first message, a
// row's Use opens the sheet filled with the idea. A Build app message that clearly asks for a product
// only offers the switch: what's sent in Build app is always a build.
// A product chat reopened from the sidebar or a link (?thread=, ?product=; lib/threads.ts) comes back here in
// Create product with its messages and drafts; a product opens the Products tab on it.
import { useChat } from "@ai-sdk/react"
import { AssistantRuntimeProvider, useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from "@assistant-ui/react"
import { DefaultChatTransport, type ChatTransport, type UIMessage } from "ai"
import { Check, ChevronDown, LayoutTemplate, Package, Plus } from "lucide-react"
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react"

import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { CreateProductSheet } from "@/components/create-product-sheet"
import { ChatSaver, listChats, loadChat, migrateLocalChats, newThreadId, sessionIdFor } from "@/lib/chat-sessions"
import { announceThreads, type AppThreadSource, type MyProduct, type OpenThreadDetail, type ProductChatRecord } from "@/lib/threads"
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
import { chipIdeas, CHIPS_MAX, ideaProducts, kindAsIdea, kindIdeas, NewAppRequest, picksForKind, sendBlockedReason, type AppIdea, type AppKind } from "@/lib/new-app"
import { chipProductIdeas, productIdeaMessage, productIdeaPrefill, type ProductIdea } from "@/lib/product-ideas"
import { ProductStageSheet, demoteMove, promoteMove, type ProductMove } from "@/components/product-stage-sheet"
import { StageMark } from "@/components/promotion-view"
import { flagsFor, isPickable, MOVE_LABEL, NOT_PUBLISHED, productStageOf, STAGE_STATUS, type StudioProduct } from "@/lib/products"
import type { Stage } from "@/lib/workspaces"
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
                        {stageOf(p) !== "production" && <span className="shrink-0 text-xs text-muted-foreground" data-picker-stage>{STAGE_STATUS[stageOf(p)]}</span>}
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

export const NO_PRODUCT_YET = "No product yet"

// Every kind's app ideas, grouped by kind: a heading row where each kind's ideas start on the page. Once the
// products are known, an idea with no published product to build on says so, with Create product beside Use.
export function TemplatesTab({
  kinds,
  onUse,
  products = null,
  onCreate,
}: {
  kinds: AppKind[] | null
  onUse: (k: AppKind, idea: AppIdea) => void
  products?: NewAppProduct[] | null
  onCreate?: () => void
}) {
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
                  <TableCell className={`${COL.name} font-medium`}>
                    {idea.problem}
                    {products !== null && !ideaProducts(idea, products).length && (
                      <span className="mt-1 block text-xs font-normal text-muted-foreground" data-no-product>
                        {NO_PRODUCT_YET}
                      </span>
                    )}
                  </TableCell>
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
                    <span className="flex justify-end gap-2">
                      {products !== null && !ideaProducts(idea, products).length && onCreate && (
                        <Button size="sm" variant="outline" onClick={onCreate} data-template-create={idea.id}>
                          Create product
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => onUse(kind, idea)} data-use-template={idea.id}>
                        Use
                      </Button>
                    </span>
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

// Financial product mode's Templates: ideas for new financial products (lib/product-ideas.ts), one row each: the
// draft product's name, then the problem it answers. Use opens the Create product sheet filled with the idea.
const PRODUCT_IDEA_COLUMNS = [
  { label: "Product", className: COL.name },
  { label: "For", className: COL.wide },
  { label: "Product line", className: COL.text },
  { label: "", className: COL.actions },
]

export function ProductIdeasTab({ ideas, onUse }: { ideas: ProductIdea[] | null; onUse: (idea: ProductIdea) => void }) {
  const [query, setQuery] = useState("")
  const shown = (ideas ?? []).filter((i) => matches(query, i.label, i.productName, i.summary, lineLabel(i.productLine), lineLabel(i.category), ...i.keyFeatures))
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  return (
    <PanelList
      id="product-ideas"
      noun={["product idea", "product ideas"]}
      search={query}
      onSearch={(v) => {
        setQuery(v)
        paged.setPage(1)
      }}
      searchLabel="Search product ideas"
      areaRef={fit.ref}
      {...pagerOf(paged, shown.length)}
    >
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            {PRODUCT_IDEA_COLUMNS.map((c) => (
              <TableHead key={c.label || "actions"} className={c.className}>
                {c.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {ideas === null ? (
            <TableRow data-loading>
              <TableCell colSpan={PRODUCT_IDEA_COLUMNS.length}>
                <Skeleton className="h-4" />
              </TableCell>
            </TableRow>
          ) : paged.shown.length ? (
            paged.shown.map((idea) => (
              <TableRow key={idea.id} data-product-idea-row={idea.id}>
                <TableCell className={`${COL.name} font-semibold`} title={idea.summary || undefined} data-product-idea-name>
                  {idea.productName}
                </TableCell>
                <TableCell className={COL.wide}>
                  <span className="block max-w-80 truncate text-muted-foreground" title={idea.label} data-product-idea-problem>
                    {idea.label}
                  </span>
                </TableCell>
                <TableCell className={COL.text}>
                  <span className="flex flex-wrap gap-1">
                    <Badge variant="outline">{lineLabel(idea.productLine)}</Badge>
                    {idea.category && <Badge variant="outline">{lineLabel(idea.category)}</Badge>}
                  </span>
                </TableCell>
                <TableCell className={COL.actions}>
                  <span className="flex justify-end">
                    <Button size="sm" variant="outline" onClick={() => onUse(idea)} data-use-product-idea={idea.id}>
                      Use
                    </Button>
                  </span>
                </TableCell>
              </TableRow>
            ))
          ) : (
            <EmptyRow cols={PRODUCT_IDEA_COLUMNS.length}>{ideas.length ? "No product ideas match." : "No product ideas on this Mynt yet. Describe your product in the chat."}</EmptyRow>
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

// A product's stage: Mynt's word, else from its status.
const stageOf = (p: Pick<StudioProduct, "stage" | "status">): Stage => p.stage ?? productStageOf(p)

export function ProductsTab({
  products,
  picked,
  onToggle,
  lines,
  onLines,
  onCreate,
  onMoved,
  fetcher,
  focus = null,
}: {
  products: NewAppProduct[] | null
  picked: string[]
  onToggle: (id: string) => void
  lines: string[]
  onLines: (lines: string[]) => void
  onCreate?: () => void
  // One of the user's own products moved stage (through the approval sheet).
  onMoved?: (id: string, stage: Stage) => void
  fetcher?: typeof fetch
  // A product opened from Recent or the sidebar: searched for and marked.
  focus?: string | null
}) {
  // The approval sheet a row's action opened: the product, its move and the stage it was opened at (the
  // sheet keeps it: after the move it still shows what was done).
  const [moving, setMoving] = useState<{ id: string; move: ProductMove; stage: Stage } | null>(null)
  const movingProduct = moving ? products?.find((p) => p.id === moving.id) : undefined
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
              const stage = stageOf(p)
              const up = promoteMove(stage)
              const down = demoteMove(stage)
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
                      <span className="shrink-0 font-normal" data-product-status={stage}>
                        <StageMark stage={stage} label={STAGE_STATUS[stage]} />
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className={COL.text}>{p.by || "—"}</TableCell>
                  <TableCell className={COL.text}>{p.productLine ? <Badge variant="outline">{lineLabel(p.productLine)}</Badge> : "—"}</TableCell>
                  <TableCell className={COL.actions}>
                    {p.mine && onMoved && (
                      <span className="flex justify-end gap-2">
                        {up?.mode === "promote" && (
                          <Button size="sm" variant="outline" onClick={() => setMoving({ id: p.id, move: up, stage })} data-product-move={up.to}>
                            {MOVE_LABEL[up.to]}
                          </Button>
                        )}
                        {down && (
                          <Button size="sm" variant="ghost" onClick={() => setMoving({ id: p.id, move: down, stage })} data-product-move-back={down.to}>
                            Move back
                          </Button>
                        )}
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
      <ProductStageSheet
        product={movingProduct && moving ? { id: movingProduct.id, name: movingProduct.name, stage: moving.stage } : null}
        move={moving?.move ?? null}
        onClose={() => setMoving(null)}
        onMoved={(id, stage) => onMoved?.(id, stage)}
        fetcher={fetcher}
      />
    </PanelList>
  )
}

// ---- the page ----

export function NewAppWorkspace({
  products,
  kinds,
  productIdeas = null,
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
  // Financial product mode's ideas for new products (list_product_ideas): its chips and Templates rows.
  productIdeas?: ProductIdea[] | null
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
  // Or the product idea whose Use opened it (n: a new fill each time).
  const [sheetIdea, setSheetIdea] = useState<{ idea: ProductIdea; n: number } | null>(null)
  const openSheet = () => {
    setSheetDraft(null)
    setSheetIdea(null)
    setCreating(true)
  }
  const openProductIdea = (idea: ProductIdea) => {
    setSheetDraft(null)
    setSheetIdea((s) => ({ idea, n: (s?.n ?? 0) + 1 }))
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
    } else if (sheetIdea) {
      setSheetIdea(null)
      setTab("products")
      setOpened(true)
    }
  }
  const cards: DraftCards = {
    created: createdDrafts,
    review: (d) => {
      if (createdDrafts[d.id]) return
      setSheetIdea(null)
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
  // One of the user's products moved stage: the page's list, the picks and Recent follow.
  const onMoved = (id: string, stage: Stage) => {
    const status = stage === "production" ? ("published" as const) : stage === "staging" ? ("unpublished" as const) : ("draft" as const)
    onProductsChange?.((list) => list.map((p) => (p.id === id ? { ...p, stage, status } : p)))
    if (stage === "idea") setPicked((picks) => picks.filter((x) => x !== id))
    const p = products?.find((x) => x.id === id)
    if (p) noteMine({ id, name: p.name, status, stage, updatedAt: new Date().toISOString() })
  }
  const [picked, setPicked] = useState<string[]>([])
  const [lines, setLines] = useState<string[]>([])
  const [kind, setKind] = useState<string | null>(null)
  const [tab, setTab] = useState<NewAppTab>("templates")
  const [opened, setOpened] = useState(false)
  const [messages, setMessages] = useState<ThreadMessageLike[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only products in Staging or Production can be picked (an idea's checkbox is disabled; this holds whatever calls it).
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
  // An idea (or a kind's own goal): its goal in the composer to edit, its kind, its product lines filtered, and
  // its products picked in place of what was picked (the published ones in its categories and names, or one of
  // each line). One with nothing to pick leaves the picks as they were.
  const applyIdea = (k: AppKind, idea?: AppIdea) => {
    const target = idea ?? kindAsIdea(k)
    setKind(k.id)
    runtime.thread.composer.setText(target.goal)
    setLines(target.productLines)
    if (products) {
      const next = picksForKind(target, products.filter(isPickable), [])
      if (next.length) setPicked(next)
    }
    setError(null)
  }
  const applyKind = (k: AppKind) => applyIdea(k)
  const commands = newAppCommands({ tab: open, applyKind, createProduct: () => switchMode("product", { text: "" }) }, kinds ?? [])
  const productCommands = productModeCommands({ tab: open, buildApp: () => switchMode("build", { text: "" }) })
  const drafting = productChat.status === "submitted" || productChat.status === "streaming"

  // ---- threads: saving the product chat, and reopening one from the sidebar or a link ----
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
  const modeToggle = <ModeToggle mode={mode} onMode={(m) => switchMode(m)} />
  // Build app: what's typed clearly asks for a product, so Create product is offered (never switched to unasked).
  const suggestProduct = mode === "build" && !busy && !error && asksForProduct(text)
  // A few ideas under the welcome, each labelled by its problem, picked once per page load (a Mynt with no
  // ideas yet shows the kinds). Once the products are known, only ones with a published product to pick.
  const [seed] = useState(() => Math.random())
  const chipList = useMemo<{ kind: AppKind; idea: AppIdea | null }[]>(() => {
    const all = kinds ?? []
    if (all.some((k) => k.ideas.length)) return chipIdeas(all, seed, CHIPS_MAX, products)
    return all.filter((k) => products === null || ideaProducts(kindAsIdea(k), products).length).map((kind) => ({ kind, idea: null }))
  }, [kinds, seed, products])
  // Financial product mode's chips: a few product ideas, picked once per page load, each named by its draft
  // product name with the problem it answers as the tooltip (a long name wraps). One starts the product chat
  // with the idea as its first message (or, until the assistant is known to be on, puts it in the composer).
  const productChipList = useMemo(() => chipProductIdeas(productIdeas ?? [], seed), [productIdeas, seed])
  const startProductIdea = (idea: ProductIdea) => {
    const message = productIdeaMessage(idea)
    setError(null)
    if (ai === "enabled" && !drafting) void productChat.sendMessage({ text: message })
    else setCarry((c) => ({ text: message, n: (c?.n ?? 0) + 1 }))
  }
  const productChips = productChipList.length ? (
    <div className="mt-6 flex flex-wrap justify-center gap-2 px-4" data-product-chips>
      {productChipList.map((idea) => (
        <button
          key={idea.id}
          type="button"
          onClick={() => startProductIdea(idea)}
          className="max-w-xs rounded-2xl border bg-background px-3 py-1.5 text-sm text-balance text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          data-product-chip={idea.id}
          title={idea.label}
        >
          {idea.productName}
        </button>
      ))}
    </div>
  ) : null
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
      mode === "product" ? (
        <ProductIdeasTab ideas={productIdeas} onUse={openProductIdea} />
      ) : (
        <TemplatesTab kinds={kinds} onUse={applyIdea} products={products} onCreate={openSheet} />
      )
    ) : (
      <ProductsTab products={products} picked={picked} onToggle={toggle} lines={lines} onLines={setLines} onCreate={openSheet} onMoved={onMoved} fetcher={fetcher} focus={focus} />
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
                welcome={
                  <ChatWelcome title={PRODUCT_WELCOME_TITLE}>
                    
                    {productChips}
                  </ChatWelcome>
                }
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
        initial={
          sheetDraft
            ? { key: sheetDraft.id, request: sheetDraft.request }
            : sheetIdea
              ? { key: `idea:${sheetIdea.idea.id}:${sheetIdea.n}`, request: productIdeaPrefill(sheetIdea.idea) }
              : null
        }
      />
    </AssistantRuntimeProvider>
  )
}
