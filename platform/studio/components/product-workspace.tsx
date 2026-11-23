"use client"

// A financial product's own workspace (/products/<id>), laid out as an app's: the product's header (its
// name and stage, then the labelled Move to staging / Move to production / Move back and Archive, each
// opening its sheet: components/product-stage-sheet.tsx and components/product-archive-sheet.tsx, as on
// the Build page's Products tab), the product's chat on the left and its tabs on the right: Terms,
// Customers, Risk, Compliance, Integrations, Apps and Activity (lib/product-panel.ts). Tabs only show;
// every action is a labelled button opening a sheet. Each tab is live while it's on screen: read when it's
// opened or the page comes back into view, and every 30 seconds while both are visible, with when it was
// last read; whatever Mynt can't answer says why, never 0 or an empty table.
//
// The chat is the product's product chat: the one whose draft created it (lib/chat-sessions.ts
// chatForProduct), read back from Mynt with its drafts; a product made without a chat gets a new one with
// "Continue with <name>: " in the composer, tagged with the product so it's found here next time. It's
// kept on Mynt as the Build page keeps its product chats. Its slash commands show the tabs (/terms, …).
import { useChat } from "@ai-sdk/react"
import type { ChatTransport, UIMessage } from "ai"
import { ArchiveRestore, ChevronLeftIcon, RefreshCw } from "lucide-react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { ConnectAgentButton, DocsButton } from "@/components/connect-agent"
import { CreateProductSheet } from "@/components/create-product-sheet"
import { productTransport } from "@/components/new-app-workspace"
import { ProductArchiveSheet, type ArchiveMode } from "@/components/product-archive-sheet"
import { ProductChat, type DraftCards } from "@/components/product-chat"
import { demoteMove, ProductStageSheet, promoteMove, type ProductMove } from "@/components/product-stage-sheet"
import { NewAppButton } from "@/components/site-header"
import { DeveloperOnly } from "@/components/studio-gates"
import { SearchTrigger } from "@/components/studio-search"
import { ThemeSwitcher } from "@/components/theme-switcher"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useIsMobile } from "@/hooks/use-mobile"
import { LIVE_INTERVAL_MS, updatedAgo } from "@/lib/app-panel"
import { ChatSaver, chatForProduct, LIST_LIMIT_MAX, listChats, loadChat, newThreadId, SAVE_REFUSED } from "@/lib/chat-sessions"
import { PRODUCT_TAB_EVENT, PRODUCT_TAB_LABELS, PRODUCT_TABS, isProductTab, type NotYet, type ProductTab, type ProductTabData, type TabSection, type WorkspaceProduct } from "@/lib/product-panel"
import type { ProductDraft } from "@/lib/product-chat"
import { canArchive, MOVE_LABEL, type StudioProduct } from "@/lib/products"
import type { SlashCommand } from "@/lib/slash-commands"
import { announceThreads, productHref } from "@/lib/threads"
import { STAGE_LABELS, type Stage } from "@/lib/workspaces"

// ---- the header ----

export type ProductHeaderProps = {
  product: WorkspaceProduct | null // null while it loads
  error?: string | null
  onMove: (move: ProductMove) => void
  onArchive: (mode: ArchiveMode) => void
  onBack: () => void
}

/** The product's header, as an app's top bar: back, name, stage, its labelled actions, then search and the rest. */
export function ProductHeader({ product, error = null, onMove, onArchive, onBack }: ProductHeaderProps) {
  const up = product && !product.archived ? promoteMove(product.stage) : null
  const down = product && !product.archived ? demoteMove(product.stage) : null
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center gap-2 border-b bg-background px-4 lg:px-6" data-product-header>
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
      <Button type="button" variant="ghost" size="sm" onClick={onBack} aria-label="Back to Build" title="Back to Build" className="shrink-0 px-2 text-muted-foreground" data-product-back>
        <ChevronLeftIcon />
        Back
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden pr-2" data-product-title>
        <h1 className="truncate text-base font-medium" data-product-name>
          {product?.name ?? (error ? "Financial product" : "Loading product…")}
        </h1>
        {product && (
          <Badge variant="outline" className="hidden shrink-0 font-normal sm:inline-flex" data-product-stage={product.stage}>
            {STAGE_LABELS[product.stage]}
          </Badge>
        )}
        {product?.archived && (
          <Badge variant="secondary" className="shrink-0 font-normal" data-product-archived>
            Archived
          </Badge>
        )}
        {product && (
          <span className="flex shrink-0 items-center gap-2" data-product-actions>
            {up?.mode === "promote" && (
              <Button size="sm" variant="outline" className="h-8" onClick={() => onMove(up)} data-product-move={up.to}>
                {MOVE_LABEL[up.to]}
              </Button>
            )}
            {down && (
              <Button size="sm" variant="ghost" className="h-8" onClick={() => onMove(down)} data-product-move-back={down.to}>
                Move back
              </Button>
            )}
            {product.archived ? (
              <Button size="sm" variant="outline" className="h-8" onClick={() => onArchive("unarchive")} data-product-unarchive>
                <ArchiveRestore />
                Unarchive
              </Button>
            ) : (
              canArchive(product.stage) && (
                <Button size="sm" variant="ghost" className="h-8" onClick={() => onArchive("archive")} data-product-archive>
                  Archive
                </Button>
              )
            )}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex md:hidden">
          <SearchTrigger compact />
        </span>
        <span className="hidden md:flex">
          <SearchTrigger className="md:w-40 lg:w-48 xl:w-56" />
        </span>
        <DeveloperOnly>
          <span className="hidden md:flex">
            <NewAppButton />
          </span>
        </DeveloperOnly>
        <DocsButton />
        <ConnectAgentButton />
        <ThemeSwitcher compact />
      </div>
    </header>
  )
}

// ---- the tabs ----

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: ProductTabData | NotYet }

// Live data for one tab of one product; `refresh` changing reads it again (after a move or an archive).
export function useLiveProductTab(productId: string, tab: ProductTab, active: boolean, refresh = 0, interval = LIVE_INTERVAL_MS) {
  const [state, setState] = useState<Loaded>({ kind: "loading" })
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const inFlight = useRef(false)
  const load = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    try {
      const res = await fetch(`/api/products/${encodeURIComponent(productId)}/panel?tab=${tab}`, { cache: "no-store" }).catch(() => null)
      const body = (await res?.json().catch(() => null)) as { data?: ProductTabData | NotYet; message?: string } | null
      if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
      if (!res?.ok || !body?.data) setState({ kind: "error", message: body?.message ?? "Couldn't reach Mynt. Please try again." })
      else {
        setState({ kind: "ready", data: body.data })
        setUpdatedAt(Date.now())
      }
    } finally {
      inFlight.current = false
    }
  }, [productId, tab])

  useEffect(() => {
    if (!active) return
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden"
    if (visible()) void load()
    const timer = window.setInterval(() => {
      if (visible()) void load()
    }, interval)
    const onVisibility = () => {
      if (visible()) void load()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [active, load, interval, refresh])

  return { state, updatedAt, reload: load }
}

// One section: its heading, then its table, or (Mynt couldn't answer) why not.
export function TabSectionView({ section }: { section: TabSection }) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-tab-section={section.id} aria-labelledby={`product-section-${section.id}`}>
      <h2 id={`product-section-${section.id}`} className="text-sm font-semibold">
        {section.title}
      </h2>
      {section.rows === null ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground" data-not-available>
          Not available. {section.reason}
        </p>
      ) : section.rows.length === 0 ? (
        <p className="rounded-lg border px-4 py-4 text-sm text-muted-foreground" data-none>
          {section.empty}
        </p>
      ) : (
        // Cells wrap, so a table only scrolls sideways when the panel is narrower than its columns can go.
        <div className="min-w-0 overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {section.columns.map((c) => (
                  <TableHead key={c}>{c}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.rows.map((r) => (
                <TableRow key={r.key} data-row={r.key}>
                  {r.cells.map((cell, i) => (
                    <TableCell key={i} className={i === 0 ? "font-medium whitespace-normal" : "text-sm whitespace-normal break-words text-muted-foreground"}>
                      {i === 0 && r.href ? (
                        <Link href={r.href} className="hover:underline" data-row-link={r.href}>
                          {cell}
                        </Link>
                      ) : (
                        cell
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {section.note && (
        <p className="text-xs text-muted-foreground" data-section-note>
          {section.note}
        </p>
      )}
    </section>
  )
}

export function ProductTabBody({ data }: { data: ProductTabData | NotYet }) {
  if (!data.available)
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground" data-not-yet>
        Not available yet. {data.reason}
      </p>
    )
  return (
    <div className="flex flex-col gap-6">
      {data.sections.map((s) => (
        <TabSectionView key={s.id} section={s} />
      ))}
    </div>
  )
}

// One live tab: when it was read, a labelled Refresh, and its content.
export function ProductInfoTab({ productId, tab, active, refresh = 0 }: { productId: string; tab: ProductTab; active: boolean; refresh?: number }) {
  const { state, updatedAt, reload } = useLiveProductTab(productId, tab, active, refresh)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = window.setInterval(() => setNow(Date.now()), 5000)
    return () => window.clearInterval(t)
  }, [active])
  return (
    <div className="flex h-full flex-col" data-product-tab={tab}>
      <div className="flex h-9 shrink-0 items-center justify-end gap-2 border-b px-3 text-xs text-muted-foreground">
        <span data-updated>{updatedAgo(updatedAt, Math.max(now, updatedAt ?? 0))}</span>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => void reload()}>
          <RefreshCw /> Refresh
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {state.kind === "loading" && (
          <div className="flex flex-col gap-4" data-loading>
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}
        {state.kind === "ready" && <ProductTabBody data={state.data} />}
      </div>
    </div>
  )
}

// The product chat's slash commands: one per tab.
export function productTabCommands(show: (tab: ProductTab) => void): SlashCommand[] {
  return PRODUCT_TABS.map((t) => ({ name: t, description: `Show ${PRODUCT_TAB_LABELS[t]}`, run: () => show(t) }))
}

// ---- the chat: the product's product chat ----

type ChatState = "finding" | "restored" | "new" | "failed"

// Finds the product chat whose draft created this product and reads it back; else starts a new one,
// seeded "Continue with <name>: ". Saves it as it changes, tagged with this product.
export function useProductChat(productId: string, name: string | null, transport?: ChatTransport<UIMessage>) {
  const [chatTransport] = useState(() => transport ?? productTransport())
  const chat = useChat<UIMessage>({ id: `product-workspace:${productId}`, transport: chatTransport })
  const [threadId, setThreadId] = useState<string | null>(null)
  const [created, setCreated] = useState<Record<string, string>>({})
  const [state, setState] = useState<ChatState>("finding")
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const currentId = useRef<string | null>(null)
  currentId.current = threadId
  const saver = useMemo(() => new ChatSaver("product", { onSaved: () => announceThreads(), onRefused: (id) => id === currentId.current && setNotice(SAVE_REFUSED) }), [])
  useEffect(() => () => saver.dispose(), [saver])

  const opened = useRef<string | null>(null)
  useEffect(() => {
    if (name === null || opened.current === productId) return
    opened.current = productId
    let live = true
    void (async () => {
      const list = await listChats("product", { limit: LIST_LIMIT_MAX })
      const found = list ? chatForProduct(list, productId) : null
      const rec = found ? await loadChat(found.id) : null
      if (!live) return
      if (rec) {
        saver.adopt(rec.id, rec)
        chat.setMessages(rec.messages)
        setCreated(Object.fromEntries(Object.entries(rec.outcomes).filter(([, o]) => typeof o.product_id === "string").map(([d, o]) => [d, o.product_id as string])))
        setThreadId(rec.id)
        setState("restored")
        return
      }
      // None found (or it couldn't be read): a new chat about this product.
      setThreadId(newThreadId())
      setState(found ? "failed" : "new")
      setSeed((s) => ({ text: `Continue with ${name}: `, n: (s?.n ?? 0) + 1 }))
    })()
    return () => {
      live = false
    }
    // Once per product, when its name is known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, name])

  const drafting = chat.status === "submitted" || chat.status === "streaming"
  const snapshot = useCallback(
    (extra: Record<string, string> = {}) => {
      const all = { ...created, ...extra }
      const ids = [...new Set([productId, ...Object.values(all)])]
      return { messages: chat.messages, outcomes: Object.fromEntries(Object.entries(all).map(([d, p]) => [d, { product_id: p }])), metadata: { product_ids: ids } }
    },
    [chat.messages, created, productId],
  )
  // Saved from the first message, again whenever a reply settles.
  useEffect(() => {
    if (!threadId || !chat.messages.length || drafting) return
    saver.save(threadId, snapshot())
  }, [threadId, chat.messages, drafting, saver, snapshot])

  // A draft of this chat became a product: recorded, and saved at once (so its workspace finds this chat).
  const noteCreated = useCallback(
    async (draftId: string, newProductId: string) => {
      setCreated((c) => ({ ...c, [draftId]: newProductId }))
      if (!threadId) return
      saver.save(threadId, snapshot({ [draftId]: newProductId }), { now: true })
      await saver.flush()
    },
    [saver, snapshot, threadId],
  )
  return { chat, state, seed, notice, created, drafting, noteCreated }
}

// ---- the page ----

export function ProductWorkspace({ productId, transport, isMobile: forcedMobile }: { productId: string; transport?: ChatTransport<UIMessage>; isMobile?: boolean }) {
  const router = useRouter()
  const detected = useIsMobile()
  const isMobile = forcedMobile ?? detected
  const [product, setProduct] = useState<WorkspaceProduct | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)

  const loadProduct = useCallback(async () => {
    const res = await fetch(`/api/products/${encodeURIComponent(productId)}/panel`, { cache: "no-store" }).catch(() => null)
    const body = (await res?.json().catch(() => null)) as { product?: WorkspaceProduct; message?: string } | null
    if (res?.status === 401) window.dispatchEvent(new Event("mynt:signed-out"))
    if (res?.ok && body?.product) {
      setProduct(body.product)
      setError(null)
    } else setError(body?.message ?? "Couldn't reach Mynt. Please try again.")
  }, [productId])
  useEffect(() => {
    setProduct(null)
    void loadProduct()
  }, [loadProduct])

  const [tab, setTab] = useState<ProductTab>("terms")
  const [mobileView, setMobileView] = useState<"chat" | "panel">("chat")
  const showTab = useCallback((t: ProductTab) => {
    setTab(t)
    setMobileView("panel")
  }, [])
  useEffect(() => {
    const onTab = (e: Event) => {
      const d = (e as CustomEvent<{ productId?: string; tab?: unknown }>).detail
      if (!d || !isProductTab(d.tab) || (d.productId && d.productId !== productId)) return
      showTab(d.tab)
    }
    window.addEventListener(PRODUCT_TAB_EVENT, onTab)
    return () => window.removeEventListener(PRODUCT_TAB_EVENT, onTab)
  }, [productId, showTab])
  const panelVisible = !isMobile || mobileView === "panel"

  // The header's actions: a move between stages, or archiving, each through its sheet.
  const [moving, setMoving] = useState<ProductMove | null>(null)
  const [archiving, setArchiving] = useState<ArchiveMode | null>(null)
  const sheetProduct = product ? { id: product.id, name: product.name, stage: product.stage } : null
  const changed = (patch: Partial<WorkspaceProduct>) => {
    setProduct((p) => (p ? { ...p, ...patch } : p))
    setRefresh((n) => n + 1)
  }

  const { chat, state, seed, notice, created, drafting, noteCreated } = useProductChat(productId, product?.name ?? (error ? productId : null), transport)
  const [ai, setAi] = useState<"loading" | "enabled" | "disabled">("loading")
  useEffect(() => {
    let live = true
    void (async () => {
      const res = await fetch("/api/product-chat", { cache: "no-store" }).catch(() => null)
      const data = res?.ok ? ((await res.json().catch(() => null)) as { enabled?: unknown } | null) : null
      if (live) setAi(data?.enabled === true ? "enabled" : "disabled")
    })()
    return () => {
      live = false
    }
  }, [])

  // A draft card's Review and create: the Create product sheet, filled; once created, that product's workspace.
  const [draft, setDraft] = useState<ProductDraft | null>(null)
  const cards: DraftCards = { created, review: (d) => !created[d.id] && setDraft(d) }
  const onCreated = async (p: StudioProduct) => {
    const d = draft
    setDraft(null)
    announceThreads({ products: true })
    if (d) await noteCreated(d.id, p.id)
    router.push(productHref(p.id))
  }

  const commands = useMemo(() => productTabCommands(showTab), [showTab])
  const name = product?.name ?? "this product"
  return (
    <>
      <ChatWorkspaceShell
        topBar={<ProductHeader product={product} error={error} onMove={setMoving} onArchive={setArchiving} onBack={() => router.push("/new")} />}
        chat={
          <div className="relative h-full" data-product-workspace-chat data-chat-state={state}>
            {error && !product ? (
              <p role="alert" className="p-6 text-sm text-destructive" data-product-error>
                {error}
              </p>
            ) : (
              <ProductChat
                chat={chat}
                cards={cards}
                welcome={<ChatWelcome title={`Continue with ${name}`} />}
                toolbar={null}
                commands={commands}
                sendBlocked={ai === "enabled" || drafting ? null : ai === "loading" ? "Checking the assistant…" : "AI is not configured on this studio."}
                note={
                  notice ? (
                    <span role="alert" className="text-destructive" data-thread-error>
                      {notice}
                    </span>
                  ) : state === "failed" ? (
                    <span role="status" data-thread-error>
                      Couldn&apos;t open this product&apos;s earlier chat, so this is a new one.
                    </span>
                  ) : ai === "disabled" ? (
                    <span role="status" data-product-ai-off>
                      AI is not configured on this studio. The tabs still show the product.
                    </span>
                  ) : null
                }
                seed={seed}
                onText={noop}
              />
            )}
          </div>
        }
        showPanel
        tabs={PRODUCT_TABS.map((t) => ({
          id: t,
          label: PRODUCT_TAB_LABELS[t],
          content: <ProductInfoTab key={`${productId}:${t}`} productId={productId} tab={t} active={tab === t && panelVisible} refresh={refresh} />,
        }))}
        tab={tab}
        onTab={(id) => isProductTab(id) && setTab(id)}
        isMobile={isMobile}
        mobileView={mobileView}
        onMobileView={setMobileView}
      />
      <ProductStageSheet product={moving ? sheetProduct : null} move={moving} onClose={() => setMoving(null)} onMoved={(_, stage: Stage) => changed({ stage })} />
      <ProductArchiveSheet
        product={archiving ? sheetProduct : null}
        mode={archiving}
        onClose={() => setArchiving(null)}
        onDone={(_, mode, stage) => changed({ archived: mode === "archive", stage })}
      />
      <CreateProductSheet open={draft !== null} onOpenChange={(o) => !o && setDraft(null)} products={null} onCreated={(p) => void onCreated(p)} initial={draft ? { key: draft.id, request: draft.request } : null} />
    </>
  )
}

const noop = () => undefined
