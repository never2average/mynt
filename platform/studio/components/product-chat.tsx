"use client"

// New app's Create product mode (lib/product-chat.ts): the same shared Thread as Build app, on the AI
// SDK chat runtime Earn uses, streamed from app/api/product-chat with its reasoning. The assistant's
// draft_product calls are drawn in the chat as cards: a refused draft says what Mynt checked, a draft
// shows its fields with Review and create, which opens the Create product sheet filled with it. Once
// that product is created the card says so and can't be sent again. Also the composer's labelled
// Build app / Create product toggle.
import { AssistantRuntimeProvider, type ToolCallMessagePartComponent } from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { UseChatHelpers } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { Hammer, Package } from "lucide-react"
import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react"

import { AskAiMarkdownText } from "@/components/ask-ai-markdown"
import { Thread } from "@/components/assistant-ui/thread"
import { Button } from "@/components/ui/button"
import { DRAFT_PRODUCT, draftFromResult, MODE_LABELS, PRODUCT_PLACEHOLDER, type NewAppMode, type ProductDraft } from "@/lib/product-chat"
import { flagsFor } from "@/lib/products"
import type { SlashCommand } from "@/lib/slash-commands"

type Chat = UseChatHelpers<UIMessage>

// ---- the composer's mode toggle ----

const MODE_ICONS: Record<NewAppMode, typeof Package> = { build: Hammer, product: Package }

export function ModeToggle({ mode, onMode }: { mode: NewAppMode; onMode: (m: NewAppMode) => void }) {
  return (
    <div role="radiogroup" aria-label="What to do" className="inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5" data-mode-toggle>
      {(["build", "product"] as const).map((m) => {
        const Icon = MODE_ICONS[m]
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={m === mode}
            data-mode-option={m}
            data-state={m === mode ? "on" : "off"}
            onClick={() => m !== mode && onMode(m)}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium whitespace-nowrap text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            <Icon className="size-3.5" aria-hidden />
            {MODE_LABELS[m]}
          </button>
        )
      })}
    </div>
  )
}

// ---- the draft card ----

export type DraftCards = {
  // Opens the Create product sheet filled with the draft.
  review: (draft: ProductDraft) => void
  // The drafts already created, by draft id: the product id each became.
  created: Record<string, string>
}
const DraftContext = createContext<DraftCards>({ review: () => undefined, created: {} })

const words = (v: string) => v.replace(/_/g, " ")

export const ProductDraftCard: ToolCallMessagePartComponent = ({ result, status }) => {
  const { review, created } = useContext(DraftContext)
  const parsed = draftFromResult(result)
  if (!parsed)
    return status?.type === "running" ? (
      <p className="my-1 text-xs text-muted-foreground" role="status" data-draft-drafting>
        Drafting the product…
      </p>
    ) : null
  if ("error" in parsed)
    return (
      <p className="my-1 text-xs text-muted-foreground" data-draft-refused>
        Mynt sent the draft back to fix: {parsed.error}
      </p>
    )
  const { draft } = parsed
  const r = draft.request
  const done = created[draft.id]
  const flags = flagsFor([r.region]).map((f) => f.emoji).join(" ")
  const rows: [string, string][] = [
    ["Product line", words(r.product_line)],
    ["Category", r.category],
    ["Jurisdiction", `${flags ? `${flags} ` : ""}${r.region} · ${r.regulator}`],
    ["Action", r.action === "issuance" ? "Issuance" : `${r.action === "sale" ? "Sale" : "Repackaging"} of ${r.underlying_product_ids.join(", ")}`],
    ["Profile", `${words(r.risk_level)} risk · ${words(r.liquidity)} liquidity · ${words(r.typical_horizon)} horizon · ${words(r.return_type)}`],
  ]
  return (
    <div className="my-2 flex flex-col gap-3 rounded-xl border bg-card p-4 text-sm" data-product-draft={draft.id}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium" data-draft-name>
          {r.name}
        </span>
        <span className="font-mono text-xs text-muted-foreground" data-draft-id>
          {r.id}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="first-letter:uppercase" data-draft-row={k}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <p className="line-clamp-3 text-xs text-muted-foreground" title={r.description}>
        {r.description}
      </p>
      {done ? (
        <p role="status" className="text-xs" data-draft-created>
          Created as an idea. Move it to staging in the Products tab.
        </p>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => review(draft)} data-draft-review>
            Review and create
          </Button>
          <span className="text-xs text-muted-foreground">Nothing is created until you confirm.</span>
        </div>
      )}
    </div>
  )
}

const CARDS = { [DRAFT_PRODUCT]: ProductDraftCard }

// ---- the chat ----

// The thread draws text, reasoning and tool calls; data parts would throw in assistant-ui's AI SDK
// runtime (none are sent here, but a stray one is dropped rather than break the chat).
const withoutDataParts = (messages: UIMessage[]): UIMessage[] => messages.map((m) => (m.parts.some((p) => p.type.startsWith("data-")) ? { ...m, parts: m.parts.filter((p) => !p.type.startsWith("data-")) } : m))

export function ProductChat({
  chat,
  cards,
  welcome,
  toolbar,
  commands,
  note,
  sendBlocked,
  seed,
  onText,
}: {
  chat: Chat
  cards: DraftCards
  welcome: ReactNode
  toolbar: ReactNode
  commands: readonly SlashCommand[]
  note?: ReactNode
  sendBlocked?: string | null
  // Text carried over from Build app's composer when switching (n changes each time).
  seed: { text: string; n: number } | null
  // What's typed, so switching back carries it.
  onText: (text: string) => void
}) {
  const messages = useMemo(() => withoutDataParts(chat.messages), [chat.messages])
  const threadChat = useMemo(() => ({ ...chat, messages }), [chat, messages])
  const runtime = useAISDKRuntime(threadChat)
  useEffect(() => {
    if (seed) runtime.thread.composer.setText(seed.text)
    // Only when a new seed arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.n])
  useEffect(() => {
    const composer = runtime.thread.composer
    const read = () => onText(composer.getState().text)
    read()
    return composer.subscribe(read)
  }, [runtime, onText])
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <DraftContext.Provider value={cards}>
        <div className="relative h-full" data-product-chat>
          <Thread
            Text={AskAiMarkdownText}
            welcome={welcome}
            placeholder={chat.messages.length ? "Answer, or say what to change…" : PRODUCT_PLACEHOLDER}
            toolbar={toolbar}
            commands={commands}
            note={note}
            sendBlocked={sendBlocked}
            sendBlockedNote={false}
            toolCards={CARDS}
          />
        </div>
      </DraftContext.Provider>
    </AssistantRuntimeProvider>
  )
}
