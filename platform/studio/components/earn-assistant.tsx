"use client"

// Earn's Assistant tab, Lovable-style: first a big prompt box ("What do you want to earn?") with
// example chips; after the first prompt, a split view with the investing assistant's chat on the
// left (the Ask AI stack, app/api/earn) and a live panel on the right that follows the
// conversation: the pools the assistant matched, as cards, the user's positions, and any draft
// commitment or withdrawal it proposed. A draft is a card the user confirms with their own click,
// which calls the same routes as the tables; the assistant can't send anything itself.
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { UseChatHelpers } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { ArrowUp, Loader2, MessageSquarePlus } from "lucide-react"
import { useState } from "react"

import { AskAiMarkdownText } from "@/components/ask-ai-markdown"
import { Thread } from "@/components/assistant-ui/thread"
import { commitOutcome, EARN_DISCLOSURE, Money, newIdempotencyKey, StageBadge, withdrawalOutcome, type LiquidityActions } from "@/components/earn-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn"
import {
  commitRefusal,
  healthText,
  limitsText,
  noticeText,
  percentOfBps,
  reserveText,
  stageOf,
  statusText,
  usd,
  withdrawalRefusal,
  type LiquidityData,
  type PoolRow,
  type Position,
} from "@/lib/liquidity"

export type EarnStatus = "loading" | "enabled" | "disabled"
type Chat = UseChatHelpers<UIMessage>

// ---- the landing ----

export function EarnLanding({ status, onAsk }: { status: EarnStatus; onAsk: (text: string) => void }) {
  const [text, setText] = useState("")
  const off = status !== "enabled"
  const send = (t: string) => {
    const q = t.trim()
    if (!q || off) return
    onAsk(q)
    setText("")
  }
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 py-10" data-earn-landing>
      <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">What do you want to earn?</h2>
      <form
        className="relative w-full"
        onSubmit={(e) => {
          e.preventDefault()
          send(text)
        }}
      >
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              send(text)
            }
          }}
          rows={4}
          disabled={off}
          aria-label="What do you want to earn?"
          placeholder={status === "disabled" ? "AI is not configured" : "Describe an amount, a lock-in, a state or a product line…"}
          className="w-full resize-none rounded-2xl border border-input bg-card px-5 py-4 pr-16 text-base shadow-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
        />
        <Button type="submit" className="absolute right-3 bottom-4" disabled={off || !text.trim()} data-earn-send>
          {status === "loading" ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          Ask
        </Button>
      </form>
      <div className="flex flex-wrap justify-center gap-2">
        {PROMPT_EXAMPLES.map((ex) => (
          <Button key={ex} type="button" variant="outline" size="sm" className="rounded-full" disabled={off} onClick={() => send(ex)} data-earn-example={ex}>
            {ex}
          </Button>
        ))}
      </div>
      {status === "disabled" && (
        <p className="text-sm text-muted-foreground" role="status">
          AI is not configured on this studio. The Opportunities and My positions tabs still work.
        </p>
      )}
      <p className="max-w-xl text-center text-xs text-muted-foreground" data-earn-disclosure>
        {EARN_DISCLOSURE}
      </p>
    </div>
  )
}

// ---- the panel ----

export function PoolCard({ pool }: { pool: PoolRow }) {
  return (
    <Card className="gap-3 py-4" data-pool-card={pool.id}>
      <CardHeader className="px-4">
        <CardTitle className="text-base">{pool.name}</CardTitle>
        <CardDescription>
          {pool.productName ?? pool.productId}
          {pool.productLine ? ` · ${pool.productLine}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 px-4 text-sm">
        <div className="flex flex-wrap gap-1.5">
          <StageBadge stage={stageOf(pool)} />
          <Money sandbox={pool.sandbox} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">Lock-in (notice)</dt>
          <dd>{noticeText(pool.noticePeriodDays)}</dd>
          <dt className="text-muted-foreground">Minimum reserve</dt>
          <dd>{reserveText(pool)}</dd>
          <dt className="text-muted-foreground">Limits</dt>
          <dd className="tabular-nums">{limitsText(pool)}</dd>
          <dt className="text-muted-foreground">Health</dt>
          <dd data-health>
            {healthText(pool.health)}
            {pool.health?.coverageBps != null ? ` · coverage ${percentOfBps(pool.health.coverageBps)}` : ""}
          </dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{statusText(pool)}</dd>
          <dt className="text-muted-foreground">Yield</dt>
          <dd className="text-muted-foreground">Not available yet</dd>
        </dl>
      </CardContent>
    </Card>
  )
}

// A draft from the assistant: nothing happens until the user clicks its button. It's checked again
// here against the pool as the page has it, and Mynt checks everything again.
export function DraftCard({ draft, pool, position, actions, canCommit, canWithdraw, newKey = newIdempotencyKey }: { draft: Draft; pool: PoolRow | null; position: Position | null; actions: LiquidityActions; canCommit: boolean; canWithdraw: boolean; newKey?: () => string }) {
  const [key, setKey] = useState(newKey)
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "error"; message: string }>({ kind: "idle" })
  const commit = draft.kind === "commit"
  const refusal = commit
    ? !canCommit
      ? "Committing capital comes with Mynt's next update."
      : pool
        ? commitRefusal(pool, position, draft.amountCents)
        : "This pool isn't open to you any more."
    : !canWithdraw
      ? "Withdrawals come with Mynt's next update."
      : withdrawalRefusal(position, draft.amountCents)
  const label = commit ? "Commit capital" : "Request withdrawal"

  const confirm = async () => {
    if (refusal || state.kind === "busy" || state.kind === "done") return
    setState({ kind: "busy" })
    const r = commit
      ? await actions.commit({ pool_id: draft.poolId, amount_cents: draft.amountCents, state: draft.state, idempotency_key: key })
      : await actions.withdraw({ pool_id: draft.poolId, amount_cents: draft.amountCents, idempotency_key: key })
    if ("error" in r) {
      if (r.refused) setKey(newKey())
      return setState({ kind: "error", message: r.error })
    }
    setState({ kind: "done", message: commit ? commitOutcome(r.reply, draft.sandbox) : withdrawalOutcome(r.reply, draft.sandbox) })
  }

  return (
    <Card className="gap-3 border-primary/40 py-4" data-draft={draft.kind}>
      <CardHeader className="px-4">
        <CardTitle className="text-base">{commit ? "Draft commitment" : "Draft withdrawal"}</CardTitle>
        <CardDescription>Proposed by the assistant. Nothing has been sent: review it, then confirm it yourself.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-4 text-sm">
        <div>
          <span className="text-muted-foreground">Pool:</span> {draft.poolName} {draft.sandbox && <Money sandbox />}
        </div>
        <div className="tabular-nums">
          <span className="text-muted-foreground">Amount:</span> {usd(draft.amountCents)}
        </div>
        {draft.kind === "commit" && (
          <div>
            <span className="text-muted-foreground">From:</span> {draft.state.slice(3).toUpperCase()}
          </div>
        )}
        {pool && <div className="text-muted-foreground">{commit ? `${limitsText(pool)}; notice ${noticeText(pool.noticePeriodDays).toLowerCase()}.` : `Paid first in, first out after the notice period (${noticeText(pool.noticePeriodDays).toLowerCase()}), and only as far as the latest verified health snapshot keeps the pool above its minimum reserve.`}</div>}
        {refusal && state.kind !== "done" && (
          <p className="text-amber-600 dark:text-amber-300" data-refusal>
            {refusal}
          </p>
        )}
        {state.kind === "done" && (
          <p role="status" data-draft-done>
            {state.message}
          </p>
        )}
        {state.kind === "error" && (
          <p role="alert" className="text-destructive">
            {state.message}
          </p>
        )}
      </CardContent>
      <CardFooter className="px-4">
        <Button onClick={() => void confirm()} disabled={Boolean(refusal) || state.kind === "busy" || state.kind === "done"} data-confirm={draft.kind}>
          {state.kind === "busy" && <Loader2 className="animate-spin" />}
          {label}
        </Button>
      </CardFooter>
    </Card>
  )
}

export function EarnPanel({ data, poolIds, drafts, actions }: { data: LiquidityData; poolIds: string[] | null; drafts: Draft[]; actions: LiquidityActions }) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  const matched = poolIds && poolIds.length ? poolIds.map((id) => pools.find((p) => p.id === id)).filter((p): p is PoolRow => Boolean(p)) : pools
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-auto" data-earn-panel>
      {drafts.length > 0 && (
        <section className="flex flex-col gap-3">
          {drafts.map((d) => (
            <DraftCard
              key={d.id}
              draft={d}
              pool={pools.find((p) => p.id === d.poolId) ?? null}
              position={positions.find((p) => p.poolId === d.poolId) ?? null}
              actions={actions}
              canCommit={data.provider?.canCommit ?? false}
              canWithdraw={data.provider?.canWithdraw ?? false}
            />
          ))}
        </section>
      )}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {poolIds && poolIds.length ? "Matching pools" : "Pools open to you"} <Badge variant="secondary">{matched.length}</Badge>
        </h3>
        {matched.length ? matched.map((p) => <PoolCard key={p.id} pool={p} />) : <p className="text-sm text-muted-foreground">No pools to show yet.</p>}
      </section>
      {data.provider && (
        <section className="flex flex-col gap-2" data-earn-positions>
          <h3 className="text-sm font-medium">Your positions</h3>
          {positions.length ? (
            positions.map((p) => (
              <div key={p.poolId} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <span>
                  {p.name} {p.sandbox && <Money sandbox />}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {usd(p.settledCents)} settled · {usd(p.availableCents)} available
                </span>
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">No positions yet.</p>
          )}
        </section>
      )}
    </div>
  )
}

// ---- the tab ----

function EarnThread({ chat }: { chat: Chat }) {
  const runtime = useAISDKRuntime(chat)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread Text={AskAiMarkdownText} placeholder="Ask a follow-up…" />
    </AssistantRuntimeProvider>
  )
}

export function EarnAssistant({ chat, status, data, actions }: { chat: Chat; status: EarnStatus; data: LiquidityData; actions: LiquidityActions }) {
  if (!chat.messages.length) return <EarnLanding status={status} onAsk={(text) => void chat.sendMessage({ text })} />
  const { poolIds, drafts } = panelFrom(chat.messages as never)
  return (
    <div className="grid min-h-[36rem] flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)]" data-earn-split>
      <div className="flex min-h-0 flex-col rounded-xl border" role="region" aria-label="Investing assistant">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <span className="text-sm font-medium">Investing assistant</span>
          <span className="text-xs text-muted-foreground">explains terms; doesn&apos;t give advice or move money</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              void chat.stop()
              chat.setMessages([])
            }}
          >
            <MessageSquarePlus /> New chat
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <EarnThread chat={chat} />
        </div>
      </div>
      <EarnPanel data={data} poolIds={poolIds} drafts={drafts} actions={actions} />
    </div>
  )
}
