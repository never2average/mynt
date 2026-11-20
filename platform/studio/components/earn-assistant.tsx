"use client"

// Earn (/earn): the investing assistant in the studio's chat workspace, the same shell as an app's
// builder (components/chat-workspace-shell.tsx), with different tabs on the right. The chat starts
// as the big centred prompt ("What do you want to earn?") with example chips; after the first
// message the right panel opens beside it with Pools (what the conversation matched, the default),
// Opportunities, My positions, My pools (builders) and Drafts (liquidity providers: the
// commitments and withdrawals the assistant proposed, each confirmed only by the user's own click,
// which calls the same routes as the tables; the assistant can't send anything itself). The chat
// bar has the wallet picker, and a draft for a pool with an on-chain treasury is a devnet deposit
// or withdrawal the user signs in their own wallet (components/earn-wallet.tsx).
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { UseChatHelpers } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { ChevronRight, Loader2 } from "lucide-react"
import Link from "next/link"
import { useMemo, useState } from "react"

import { AskAiMarkdownText } from "@/components/ask-ai-markdown"
import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { Panel, Section } from "@/components/dashboard-panels"
import { DevnetBadge, EarnDisclosure, EarnWalletProvider, DepositsPausedBadge, OnChainAction, UnverifiedBuildBadge, WalletPicker, type EarnWalletState } from "@/components/earn-wallet"
import { commitOutcome, EarnTable, Money, newIdempotencyKey, StageBadge, withdrawalOutcome, type LiquidityActions } from "@/components/earn-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableHead, TableHeader, TableCell, TableRow } from "@/components/ui/table"
import { depositFor, panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn"
import { shortAddress } from "@/lib/linked-accounts"
import { centsToUsdcBaseUnits, DEPOSITS_PAUSED, onDevnet } from "@/lib/wallets"
import {
  commitRefusal,
  earnTabFromQuery,
  limitsText,
  lockInText,
  noticeText,
  stageOf,
  statusText,
  TAB_LABELS,
  tabOpensPanel,
  tabsFor,
  positionKey,
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
        welcome={<ChatWelcome title={WELCOME_TITLE} chips={PROMPT_EXAMPLES} />}
        note={<EarnDisclosure />}
        toolbar={<WalletPicker />}
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
      <div className="mx-auto group-data-[chat-align=left]/chat:ml-0 flex w-full max-w-(--thread-max-width) flex-col gap-4 pb-2 md:pb-3">
        <textarea disabled rows={2} aria-label="Message input" placeholder={status === "loading" ? "…" : "AI is not configured"} className="w-full resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm opacity-60" />
        <p className="-mt-2 px-2 text-center group-data-[chat-align=left]/chat:text-left text-xs text-muted-foreground">
          <EarnDisclosure />
        </p>
      </div>
    </div>
  )
}

// ---- the panel ----

// One pool as a row of the Pools table: its name and badges, product and line, lock-in, notice,
// commitment limits and status.
export function PoolRowView({ pool }: { pool: PoolRow }) {
  return (
    <TableRow data-pool-row={pool.id}>
      <TableCell className="whitespace-normal">
        <div className="font-medium">{pool.name}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <Money sandbox={pool.sandbox} />
          {pool.treasury && (
            <Badge variant="outline" data-treasury={pool.treasury.cluster}>
              {onDevnet(pool.treasury) ? "On-chain treasury" : "On-chain treasury, not on devnet"}
            </Badge>
          )}
          {onDevnet(pool.treasury) && <DevnetBadge />}
          {pool.treasury?.verifiedBuild === false && <UnverifiedBuildBadge />}
          {pool.treasury?.attestersFlag && <DepositsPausedBadge reason={pool.treasury.attestersFlag} />}
        </div>
      </TableCell>
      <TableCell className="whitespace-normal" data-product>
        {pool.productName ?? pool.productId}
        {pool.productLine ? ` · ${pool.productLine}` : ""}
      </TableCell>
      <TableCell data-lock-in>{lockInText(pool.lockInDays)}</TableCell>
      <TableCell data-notice>{noticeText(pool.noticePeriodDays)}</TableCell>
      <TableCell className="tabular-nums" data-limits>
        {limitsText(pool)}
      </TableCell>
      <TableCell className="whitespace-normal">
        <StageBadge stage={stageOf(pool)} />
        <div className="mt-1 text-xs text-muted-foreground">{statusText(pool)}</div>
      </TableCell>
    </TableRow>
  )
}

// A draft from the assistant: nothing happens until the user clicks its button. It's checked again
// here against the pool as the page has it, and Mynt checks everything again.
export function DraftPanel({ draft, pool, position, actions, canCommit, canWithdraw, newKey = newIdempotencyKey }: { draft: Draft; pool: PoolRow | null; position: Position | null; actions: LiquidityActions; canCommit: boolean; canWithdraw: boolean; newKey?: () => string }) {
  const [key, setKey] = useState(newKey)
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "error"; message: string }>({ kind: "idle" })
  const commit = draft.kind === "commit"
  // On-chain: the pool's treasury (a deposit) or the position's source (a withdrawal), as the page
  // reads them now, not as the draft says.
  const onChain = commit ? Boolean(pool?.treasury) : Boolean(position?.onChain || draft.onChain)
  const units = BigInt(centsToUsdcBaseUnits(draft.amountCents))
  // An on-chain withdrawal draws from one deposit: the one drafted, checked again as Mynt lists it now.
  const picked = !commit && onChain ? (position?.chain ? depositFor(position.chain.deposits, units, draft.deposit ?? undefined) : { error: "The drafted wallet has no deposit in this pool any more." }) : null
  const onChainBlock = commit
    ? !pool
      ? "This pool isn't open to you any more."
      : !onDevnet(pool.treasury)
        ? "On-chain deposits run on devnet only, and this pool's treasury isn't on devnet."
        : pool.treasury.attestersFlag
          ? DEPOSITS_PAUSED
          : null
    : picked && "error" in picked
      ? picked.error
      : null
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
      ? await actions.commit({ pool_id: draft.poolId, amount_cents: draft.amountCents, state: draft.state ?? "", idempotency_key: key })
      : await actions.withdraw({ pool_id: draft.poolId, amount_cents: draft.amountCents, idempotency_key: key })
    if ("error" in r) {
      if (r.refused) setKey(newKey())
      return setState({ kind: "error", message: r.error })
    }
    setState({ kind: "done", message: commit ? commitOutcome(r.reply, draft.sandbox) : withdrawalOutcome(r.reply, draft.sandbox) })
  }

  return (
    <div data-draft={draft.kind}>
      <Panel id={`draft-${draft.id}`}>
        <Section id={`draft-${draft.id}`} title={commit ? "Draft commitment" : "Draft withdrawal"} action={draft.sandbox ? <Money sandbox /> : undefined}>
          <p className="text-sm text-muted-foreground">Nothing has been sent: review it, then confirm it yourself.</p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Pool</dt>
            <dd className="min-w-0">
              <span className="block max-w-60 truncate font-medium" title={draft.poolName} data-draft-pool>
                {draft.poolName}
              </span>
            </dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="font-semibold tabular-nums" data-draft-amount>
              {usd(draft.amountCents)}
            </dd>
            {pool && (
              <>
                <dt className="text-muted-foreground">Lock-in</dt>
                <dd data-lock-in>{lockInText(pool.lockInDays)}</dd>
                <dt className="text-muted-foreground">Notice period</dt>
                <dd data-notice>{noticeText(pool.noticePeriodDays)}</dd>
              </>
            )}
            {draft.kind === "commit" && !onChain && draft.state && (
              <>
                <dt className="text-muted-foreground">From</dt>
                <dd>{draft.state.slice(3).toUpperCase()}</dd>
              </>
            )}
            {onChain && (
              <>
                <dt className="text-muted-foreground">{commit ? "From" : "To"}</dt>
                <dd className="flex items-center gap-2" data-draft-wallet>
                  <span className="font-mono text-xs">{draft.wallet ? shortAddress(draft.wallet) : "your chosen wallet"}</span>
                  <DevnetBadge />
                </dd>
              </>
            )}
          </dl>
          {pool && !onChain && <p className="text-sm text-muted-foreground">{commit ? `${limitsText(pool)}.` : `Paid first in, first out after the notice period, and only as far as the latest verified health snapshot keeps the pool above its minimum reserve.`}</p>}
          {onChain && <p className="text-sm text-muted-foreground">{commit ? "A USDC deposit on devnet, signed in your own wallet after you check Mynt's summary. Test money only." : "A USDC withdrawal on devnet back to your wallet, signed in your own wallet after you check Mynt's summary."}</p>}
          {!onChain && refusal && state.kind !== "done" && (
            <p className="text-sm text-amber-600 dark:text-amber-300" data-refusal>
              {refusal}
            </p>
          )}
          {state.kind === "done" && (
            <p role="status" className="text-sm" data-draft-done>
              {state.message}
            </p>
          )}
          {state.kind === "error" && (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {onChain ? (
              <OnChainAction kind={commit ? "deposit" : "withdrawal"} poolId={draft.poolId} amountBaseUnits={units} amountText={usd(draft.amountCents)} deposit={picked && "deposit" in picked ? picked.deposit : null} wallet={draft.wallet ?? null} blocked={onChainBlock} newKey={newKey} />
            ) : (
              <Button onClick={() => void confirm()} disabled={Boolean(refusal) || state.kind === "busy" || state.kind === "done"} data-confirm={draft.kind}>
                {state.kind === "busy" && <Loader2 className="animate-spin" />}
                {label}
              </Button>
            )}
          </div>
        </Section>
      </Panel>
    </div>
  )
}

export const POSITIONS_PREVIEW = 5

// Pools: the pools the assistant last matched (every pool open to the user until it has) as a
// table, then a preview of the user's positions ending with View all (the My positions tab).
export function PoolsTab({ data, poolIds, onViewPositions }: { data: LiquidityData; poolIds: string[] | null; onViewPositions?: () => void }) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  const matched = poolIds && poolIds.length ? poolIds.map((id) => pools.find((p) => p.id === id)).filter((p): p is PoolRow => Boolean(p)) : pools
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-earn-pools-tab>
      <Panel id="earn-pools">
        <Section
          id="earn-pools"
          title={poolIds && poolIds.length ? "Matching pools" : "Pools open to you"}
          action={
            <span className="text-xs text-muted-foreground tabular-nums" data-pool-count>
              {matched.length} {matched.length === 1 ? "pool" : "pools"}
            </span>
          }
        >
          {matched.length ? (
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Pool</TableHead>
                    <TableHead>Product · line</TableHead>
                    <TableHead>Lock-in</TableHead>
                    <TableHead>Notice</TableHead>
                    <TableHead>Commitment</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {matched.map((p) => (
                    <PoolRowView key={p.id} pool={p} />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="py-3 text-sm text-muted-foreground">No pools to show yet.</p>
          )}
        </Section>
      </Panel>
      {data.provider && (
        <div data-earn-positions>
          <Panel id="earn-positions">
            <Section id="earn-positions" title="Your positions">
              {positions.length ? (
                <div className="overflow-auto rounded-lg border">
                  <Table>
                    <TableHeader className="bg-card">
                      <TableRow>
                        <TableHead>Pool</TableHead>
                        <TableHead className="text-right">Settled</TableHead>
                        <TableHead className="text-right">Available</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {positions.slice(0, POSITIONS_PREVIEW).map((p) => (
                        <TableRow key={positionKey(p)} data-position-preview={positionKey(p)}>
                          <TableCell>
                            <span className="font-medium">{p.name}</span> {p.sandbox && <Money sandbox />} {p.onChain && <DevnetBadge />}
                          </TableCell>
                          <TableCell className="text-right tabular-nums" data-settled>
                            {usd(p.settledCents)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums" data-available>
                            {usd(p.availableCents)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="py-3 text-sm text-muted-foreground">No positions yet.</p>
              )}
              {/* The whole list is the My positions tab, on a row of its own at the bottom right. */}
              <div className="flex justify-end border-t pt-3" data-view-all>
                {onViewPositions ? (
                  <Button variant="outline" size="sm" onClick={onViewPositions}>
                    View all
                    <ChevronRight />
                  </Button>
                ) : (
                  <Button asChild variant="outline" size="sm">
                    <Link href="/earn?tab=my-positions">
                      View all
                      <ChevronRight />
                    </Link>
                  </Button>
                )}
              </div>
            </Section>
          </Panel>
        </div>
      )}
    </div>
  )
}

// Drafts: each draft the assistant proposed, as a panel the user confirms (or not).
export function DraftsTab({ data, drafts, actions }: { data: LiquidityData; drafts: Draft[]; actions: LiquidityActions }) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4" data-earn-drafts-tab>
      {drafts.length ? (
        drafts.map((d) => (
          <DraftPanel
            key={d.id}
            draft={d}
            pool={pools.find((p) => p.id === d.poolId) ?? null}
            position={positions.find((p) => p.poolId === d.poolId && (d.kind === "withdraw" && d.onChain ? p.onChain && p.wallet === d.wallet : !p.onChain)) ?? null}
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
  wallet,
}: {
  wallet?: EarnWalletState
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
    t === "pools" ? <PoolsTab data={data} poolIds={poolIds} onViewPositions={available.includes("my-positions") ? () => choose("my-positions") : undefined} /> : t === "drafts" ? <DraftsTab data={data} drafts={drafts} actions={actions} /> : <EarnTable tab={t} data={data} actions={actions} />

  const shell = (
    <ChatWorkspaceShell
      chat={<EarnChat chat={chat} status={status} />}
      showPanel={opened || chat.messages.length > 0}
      tabs={available.map((t) => ({ id: t, label: TAB_LABELS[t], badge: t === "drafts" ? drafts.length : undefined, content: content(t) }))}
      tab={tab}
      onTab={(id) => {
        choose(id)
        setOpened(true)
      }}
      isMobile={isMobile}
    />
  )
  return wallet ? <EarnWalletProvider value={wallet}>{shell}</EarnWalletProvider> : shell
}
