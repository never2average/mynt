"use client"

// Earn (/earn): the investing assistant in the studio's chat workspace, the same shell as an app's
// builder (components/chat-workspace-shell.tsx), with different tabs on the right. The chat starts
// as the big centred prompt ("What do you want to earn?") with example chips; after the first
// message the right panel opens beside it with Pools (what the conversation matched, the default),
// Opportunities, My positions, My pools (builders) and Drafts (liquidity providers: the
// commitments and withdrawals the assistant proposed, each confirmed only by the user's own click,
// which calls the same routes as the tables; the assistant can't send anything itself).
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { UseChatHelpers } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { Loader2 } from "lucide-react"
import { useMemo, useState } from "react"

import { AskAiMarkdownText } from "@/components/ask-ai-markdown"
import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { commitOutcome, EARN_DISCLOSURE, EarnStats, EarnTable, Money, newIdempotencyKey, StageBadge, withdrawalOutcome, type LiquidityActions } from "@/components/earn-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn"
import {
  commitRefusal,
  earnTabFromQuery,
  healthText,
  limitsText,
  lockInText,
  noticeText,
  percentOfBps,
  reserveText,
  stageOf,
  statusText,
  TAB_LABELS,
  tabOpensPanel,
  tabsFor,
  usd,
  withdrawalRefusal,
  type EarnTab,
  type LiquidityData,
  type PoolRow,
  type Position,
} from "@/lib/liquidity"

export type EarnStatus = "loading" | "enabled" | "disabled"
type Chat = UseChatHelpers<UIMessage>

// ---- the chat ----

const WELCOME_TITLE = "What do you want to earn?"

// The thread draws text and reads; the panel's data parts (data-earn-pools, data-earn-draft) are
// the panel's, not the thread's, so they're left out of what the thread renders (assistant-ui's
// AI SDK runtime has no renderer for data parts and would throw on one).
export const withoutDataParts = (messages: UIMessage[]): UIMessage[] => messages.map((m) => (m.parts.some((p) => p.type.startsWith("data-")) ? { ...m, parts: m.parts.filter((p) => !p.type.startsWith("data-")) } : m))

function EarnThread({ chat }: { chat: Chat }) {
  const messages = useMemo(() => withoutDataParts(chat.messages), [chat.messages])
  const threadChat = useMemo(() => ({ ...chat, messages }), [chat, messages])
  const runtime = useAISDKRuntime(threadChat)
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        Text={AskAiMarkdownText}
        placeholder={chat.messages.length ? "Ask a follow-up…" : "Describe an amount, a lock-in, a state or a product line…"}
        welcome={<ChatWelcome title={WELCOME_TITLE} subtitle="The assistant explains pool terms and matches them to what you ask. It can't move money." chips={PROMPT_EXAMPLES} />}
        note={<span data-earn-disclosure>{EARN_DISCLOSURE}</span>}
      />
    </AssistantRuntimeProvider>
  )
}

// The chat side: the assistant, or, without a model, the same centred prompt that can't be used.
export function EarnChat({ chat, status }: { chat: Chat; status: EarnStatus }) {
  if (status === "enabled") return <EarnThread chat={chat} />
  return (
    <div className="flex h-full flex-col bg-background px-4 pt-4" style={{ ["--thread-max-width" as string]: "44rem" }} data-earn-chat-off>
      <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{WELCOME_TITLE}</h1>
        <p className="text-sm text-muted-foreground" role="status">
          {status === "loading" ? "Checking the assistant…" : "AI is not configured on this studio. The Opportunities and My positions tabs still work."}
        </p>
      </div>
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-4 pb-4 md:pb-6">
        <textarea disabled rows={2} aria-label="Message input" placeholder={status === "loading" ? "…" : "AI is not configured"} className="w-full resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm opacity-60" />
        <p className="-mt-2 text-center text-xs text-muted-foreground" data-earn-disclosure>
          {EARN_DISCLOSURE}
        </p>
      </div>
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
          <dt className="text-muted-foreground">Lock-in</dt>
          <dd data-lock-in>{lockInText(pool.lockInDays)}</dd>
          <dt className="text-muted-foreground">Notice period</dt>
          <dd data-notice>{noticeText(pool.noticePeriodDays)}</dd>
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
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">Pool</span>
          <span className="max-w-60 truncate rounded border bg-muted px-1.5 py-0.5 font-mono text-xs" title={draft.poolName} data-draft-pool>
            {draft.poolName}
          </span>
          {draft.sandbox && <Money sandbox />}
        </div>
        <div className="tabular-nums">
          <span className="text-muted-foreground">Amount</span> <span className="text-base font-semibold" data-draft-amount>{usd(draft.amountCents)}</span>
        </div>
        {pool && (
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-muted-foreground">Lock-in</span>
            <span data-lock-in>{lockInText(pool.lockInDays)}</span>
            <span className="text-muted-foreground">Notice period</span>
            <span data-notice>{noticeText(pool.noticePeriodDays)}</span>
          </div>
        )}
        {draft.kind === "commit" && (
          <div>
            <span className="text-muted-foreground">From:</span> {draft.state.slice(3).toUpperCase()}
          </div>
        )}
        {pool && <div className="text-muted-foreground">{commit ? `${limitsText(pool)}.` : `Paid first in, first out after the notice period, and only as far as the latest verified health snapshot keeps the pool above its minimum reserve.`}</div>}
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

// Pools: the pools the assistant last matched (every pool open to the user until it has), and
// the user's positions.
export function PoolsTab({ data, poolIds }: { data: LiquidityData; poolIds: string[] | null }) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  const matched = poolIds && poolIds.length ? poolIds.map((id) => pools.find((p) => p.id === id)).filter((p): p is PoolRow => Boolean(p)) : pools
  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4" data-earn-pools-tab>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">
          {poolIds && poolIds.length ? "Matching pools" : "Pools open to you"} <Badge variant="secondary">{matched.length}</Badge>
        </h3>
        {matched.length ? <div className="grid gap-3 xl:grid-cols-2">{matched.map((p) => <PoolCard key={p.id} pool={p} />)}</div> : <p className="text-sm text-muted-foreground">No pools to show yet.</p>}
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

// Drafts: each draft the assistant proposed, as a card the user confirms (or not).
export function DraftsTab({ data, drafts, actions }: { data: LiquidityData; drafts: Draft[]; actions: LiquidityActions }) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-4" data-earn-drafts-tab>
      {drafts.length ? (
        drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            pool={pools.find((p) => p.id === d.poolId) ?? null}
            position={positions.find((p) => p.poolId === d.poolId) ?? null}
            actions={actions}
            canCommit={data.provider?.canCommit ?? false}
            canWithdraw={data.provider?.canWithdraw ?? false}
          />
        ))
      ) : (
        <p className="text-sm text-muted-foreground">No drafts. Ask the assistant to draft a commitment or a withdrawal; you confirm each one yourself.</p>
      )}
    </div>
  )
}

// ---- the page ----

export function EarnWorkspace({
  chat,
  status,
  data,
  actions,
  initialTab,
  isMobile,
}: {
  chat: Chat
  status: EarnStatus
  data: LiquidityData
  actions: LiquidityActions
  initialTab?: string | null
  isMobile?: boolean
}) {
  const available = tabsFor(data.access)
  const wanted = earnTabFromQuery(initialTab)
  const [tab, setTab] = useState<EarnTab>(available.includes(wanted) ? wanted : "pools")
  const [opened, setOpened] = useState(tabOpensPanel(initialTab) && available.includes(wanted))
  const { poolIds, drafts } = panelFrom(chat.messages as never)

  // A new draft brings its tab forward, so the user sees what to confirm.
  const [seenDrafts, setSeenDrafts] = useState(drafts.length)
  if (drafts.length !== seenDrafts) {
    setSeenDrafts(drafts.length)
    if (drafts.length > seenDrafts && available.includes("drafts")) setTab("drafts")
  }

  const choose = (id: string) => {
    const t = id as EarnTab
    setTab(t)
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", `/earn?tab=${t}`)
  }

  if (!available.length)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground" data-empty="no-role">
        Earn is for builders of products with pools and for liquidity providers. Ask a Mynt admin if you should have one of those roles.
      </div>
    )

  const content = (t: EarnTab) =>
    t === "pools" ? <PoolsTab data={data} poolIds={poolIds} /> : t === "drafts" ? <DraftsTab data={data} drafts={drafts} actions={actions} /> : <EarnTable tab={t} data={data} actions={actions} />

  return (
    <ChatWorkspaceShell
      chat={<EarnChat chat={chat} status={status} />}
      showPanel={opened || chat.messages.length > 0}
      tabs={available.map((t) => ({ id: t, label: TAB_LABELS[t], badge: t === "drafts" ? drafts.length : undefined, content: content(t) }))}
      tab={tab}
      onTab={(id) => {
        choose(id)
        setOpened(true)
      }}
      panelHeader={<EarnStats data={data} />}
      isMobile={isMobile}
    />
  )
}
