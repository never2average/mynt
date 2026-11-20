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
import { Loader2 } from "lucide-react"
import { useMemo, useState } from "react"

import { AskAiMarkdownText } from "@/components/ask-ai-markdown"
import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { FilterSelect } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { MID_COL, PanelList, useFitRows, usePaged, WIDE_COL } from "@/components/list-layout"
import { DevnetBadge, EarnDisclosure, EarnWalletProvider, DepositsPausedBadge, OnChainAction, UnverifiedBuildBadge, WalletPicker, type EarnWalletState } from "@/components/earn-wallet"
import { commitOutcome, EarnTable, EmptyRow, Money, newIdempotencyKey, OneLine, pagerOf, PoolFilterControls, poolFiltersOn, StageBadge, withdrawalOutcome, type LiquidityActions } from "@/components/earn-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableHead, TableHeader, TableCell, TableRow } from "@/components/ui/table"
import { depositFor, panelFrom, PROMPT_EXAMPLES, type Draft } from "@/lib/earn"
import { shortAddress } from "@/lib/linked-accounts"
import { centsToUsdcBaseUnits, DEPOSITS_PAUSED, onDevnet } from "@/lib/wallets"
import { toCsv } from "@/lib/compliance"
import {
  commitRefusal,
  earnTabFromQuery,
  filterPools,
  NO_POOL_FILTERS,
  STAGE_LABELS,
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
  type PoolFilters,
  type PoolRow,
  type PoolStage,
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
// commitment limits and status, then (for liquidity providers) what they hold in it.
export function PoolRowView({ pool, yours }: { pool: PoolRow; yours?: string }) {
  return (
    <TableRow data-pool-row={pool.id}>
      <TableCell>
        <OneLine className="font-medium" text={pool.name} />
        <div className="flex h-5 flex-nowrap items-center gap-1.5 overflow-hidden">
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
      <TableCell className={WIDE_COL} data-product>
        {pool.productName ?? pool.productId}
        {pool.productLine ? ` · ${pool.productLine}` : ""}
      </TableCell>
      <TableCell className={MID_COL} data-lock-in>
        {lockInText(pool.lockInDays)}
      </TableCell>
      <TableCell className={WIDE_COL} data-notice>
        {noticeText(pool.noticePeriodDays)}
      </TableCell>
      <TableCell className={`${WIDE_COL} tabular-nums`} data-limits>
        {limitsText(pool)}
      </TableCell>
      <TableCell>
        <StageBadge stage={stageOf(pool)} />
        <OneLine className="text-xs text-muted-foreground" text={statusText(pool)} />
      </TableCell>
      {yours !== undefined && (
        <TableCell className={`${MID_COL} text-right tabular-nums`} data-your-position>
          {yours}
        </TableCell>
      )}
    </TableRow>
  )
}

// What a liquidity provider holds in a pool, settled, over all its positions there (on rails and
// on chain); "—" when it holds none.
const heldIn = (positions: Position[], poolId: string) => {
  const mine = positions.filter((p) => p.poolId === poolId)
  return mine.length ? usd(mine.reduce((n, p) => n + p.settledCents, 0)) : "—"
}

const ALL_STAGES: PoolStage[] = ["awaiting_approval", "sandbox", "uncleared", "cleared"]

// Pools: one table of the pools the assistant last matched (Show · Matched, until the user picks
// All pools; every pool open to the user before it has matched any), with what the user holds in
// each when they provide liquidity. The whole list of positions is the My positions tab.
export function PoolsTab({ data, poolIds }: { data: LiquidityData; poolIds: string[] | null }) {
  const pools = useMemo(() => {
    const all = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
    return all.filter((p, i) => all.findIndex((x) => x.id === p.id) === i)
  }, [data])
  const positions = data.provider ? data.provider.positions : null
  const matchedIds = poolIds && poolIds.length ? poolIds : null
  // A new match from the assistant shows the matched pools again.
  const sig = matchedIds?.join(",") ?? ""
  const [scope, setScope] = useState({ sig, all: false })
  if (scope.sig !== sig) setScope({ sig, all: false })
  const matchedOnly = Boolean(matchedIds) && !(scope.sig === sig && scope.all)
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const base = matchedOnly && matchedIds ? matchedIds.map((id) => pools.find((p) => p.id === id)).filter((p): p is PoolRow => Boolean(p)) : pools
  const shown = filterPools(base, f)
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  const filter = (n: PoolFilters) => {
    setF(n)
    paged.setPage(1)
  }
  const exportCsv = () =>
    downloadCsv(
      "pools.csv",
      toCsv(
        ["Pool", "Product", "Product line", "Lock-in", "Notice", "Commitment", "State", "Status", ...(positions ? ["Your position (settled)"] : [])],
        shown.map((p) => [p.name, p.productName ?? p.productId, p.productLine, lockInText(p.lockInDays), noticeText(p.noticePeriodDays), limitsText(p), STAGE_LABELS[stageOf(p)], statusText(p), ...(positions ? [heldIn(positions, p.id)] : [])]),
      ),
    )

  return (
    <div className="h-full" data-earn-pools-tab>
      <PanelList
        id="pools"
        search={f.query}
        onSearch={(query) => filter({ ...f, query })}
        searchLabel="Search pools"
        filters={
          <>
            {matchedIds && (
              <FilterSelect
                label="Show"
                value={matchedOnly ? "matched" : "all"}
                onChange={(v) => {
                  setScope({ sig, all: v !== "matched" })
                  paged.setPage(1)
                }}
                options={[
                  { value: "matched", label: "Matched" },
                  { value: "all", label: "All pools" },
                ]}
              />
            )}
            <PoolFilterControls f={f} setF={filter} pools={pools} stages={ALL_STAGES} productLines />
          </>
        }
        activeFilters={poolFiltersOn(f) + (matchedOnly ? 1 : 0)}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        areaRef={fit.ref}
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead>Pool</TableHead>
              <TableHead className={WIDE_COL}>Product · line</TableHead>
              <TableHead className={MID_COL}>Lock-in</TableHead>
              <TableHead className={WIDE_COL}>Notice</TableHead>
              <TableHead className={WIDE_COL}>Commitment</TableHead>
              <TableHead>Status</TableHead>
              {positions && <TableHead className={`${MID_COL} text-right`}>Your position</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.shown.length ? (
              paged.shown.map((p) => <PoolRowView key={p.id} pool={p} yours={positions ? heldIn(positions, p.id) : undefined} />)
            ) : (
              <EmptyRow cols={positions ? 7 : 6}>{base.length ? "No pools match these filters." : "No pools to show yet."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </PanelList>
    </div>
  )
}

// A draft checked against the pool and position as the page has them now (Mynt checks it all again).
export function draftCheck(draft: Draft, pool: PoolRow | null, position: Position | null, canCommit: boolean, canWithdraw: boolean) {
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
  return { commit, onChain, units, picked, onChainBlock, refusal }
}

// What became of a draft confirmed on rails, and the idempotency key it was (or will be) sent
// with. The Drafts tab keeps it, so closing the draft's sheet never lets it be sent twice.
type DraftState = { kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "error"; message: string }
export type DraftOutcome = { state: DraftState; key: string | null }
const NOT_SENT: DraftOutcome = { state: { kind: "idle" }, key: null }

// A draft from the assistant, as its sheet shows it: nothing happens until the user clicks its button.
export function DraftPanel({
  draft,
  pool,
  position,
  actions,
  canCommit,
  canWithdraw,
  newKey = newIdempotencyKey,
  outcome,
  onOutcome,
}: {
  draft: Draft
  pool: PoolRow | null
  position: Position | null
  actions: LiquidityActions
  canCommit: boolean
  canWithdraw: boolean
  newKey?: () => string
  outcome?: DraftOutcome
  onOutcome?: (o: DraftOutcome) => void
}) {
  const [local, setLocal] = useState<DraftOutcome>(NOT_SENT)
  const o = outcome ?? local
  const set = onOutcome ?? setLocal
  const state = o.state
  const { commit, onChain, units, picked, onChainBlock, refusal } = draftCheck(draft, pool, position, canCommit, canWithdraw)
  const label = commit ? "Commit capital" : "Request withdrawal"

  const confirm = async () => {
    if (refusal || state.kind === "busy" || state.kind === "done") return
    const key = o.key ?? newKey()
    set({ state: { kind: "busy" }, key })
    const r = draft.kind === "commit"
      ? await actions.commit({ pool_id: draft.poolId, amount_cents: draft.amountCents, state: draft.state ?? "", idempotency_key: key })
      : await actions.withdraw({ pool_id: draft.poolId, amount_cents: draft.amountCents, idempotency_key: key })
    if ("error" in r) return set({ state: { kind: "error", message: r.error }, key: r.refused ? null : key })
    set({ state: { kind: "done", message: commit ? commitOutcome(r.reply, draft.sandbox) : withdrawalOutcome(r.reply, draft.sandbox) }, key })
  }

  return (
    <div className="flex flex-col gap-4" data-draft={draft.kind}>
      <p className="text-sm text-muted-foreground">Nothing has been sent: review it, then confirm it yourself.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Pool</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="block max-w-60 truncate font-medium" title={draft.poolName} data-draft-pool>
            {draft.poolName}
          </span>
          {draft.sandbox && <Money sandbox />}
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
    </div>
  )
}

const KIND_OPTIONS = [
  { value: "commit", label: "Commitment" },
  { value: "withdraw", label: "Withdrawal" },
]

// Drafts: one table of the commitments and withdrawals the assistant drafted, each reviewed and
// confirmed (or not) in a sheet from its row's Review.
export function DraftsTab({ data, drafts, actions }: { data: LiquidityData; drafts: Draft[]; actions: LiquidityActions }) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  const canCommit = data.provider?.canCommit ?? false
  const canWithdraw = data.provider?.canWithdraw ?? false
  const [outcomes, setOutcomes] = useState<Record<string, DraftOutcome>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState("")
  const poolOf = (d: Draft) => pools.find((p) => p.id === d.poolId) ?? null
  const positionOf = (d: Draft) => positions.find((p) => p.poolId === d.poolId && (d.kind === "withdraw" && d.onChain ? p.onChain && p.wallet === d.wallet : !p.onChain)) ?? null
  const statusOf = (d: Draft): { text: string; tone: "muted" | "warn" | "plain" } => {
    const o = outcomes[d.id] ?? NOT_SENT
    if (o.state.kind === "done") return { text: "Sent", tone: "plain" }
    if (o.state.kind === "busy") return { text: "Sending…", tone: "muted" }
    if (o.state.kind === "error") return { text: o.state.message, tone: "warn" }
    const c = draftCheck(d, poolOf(d), positionOf(d), canCommit, canWithdraw)
    if (c.onChain) return c.onChainBlock ? { text: c.onChainBlock, tone: "warn" } : { text: "Ready to sign in your wallet", tone: "muted" }
    return c.refusal ? { text: c.refusal, tone: "warn" } : { text: "Ready to confirm", tone: "muted" }
  }
  const q = query.trim().toLowerCase()
  const shown = drafts.filter((d) => (!q || d.poolName.toLowerCase().includes(q)) && (!kind || d.kind === kind))
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  const kindText = (d: Draft) => (d.kind === "commit" ? "Commitment" : "Withdrawal")
  const termsOf = (d: Draft) => {
    const pool = poolOf(d)
    return pool ? `${lockInText(pool.lockInDays)} lock-in · ${noticeText(pool.noticePeriodDays)} notice` : "—"
  }
  const exportCsv = () => downloadCsv("drafts.csv", toCsv(["Draft", "Pool", "Amount", "Terms", "Status"], shown.map((d) => [kindText(d), d.poolName, usd(d.amountCents), termsOf(d), statusOf(d).text])))
  const current = drafts.find((d) => d.id === open) ?? null

  return (
    <div className="h-full" data-earn-drafts-tab>
      <PanelList
        id="drafts"
        search={query}
        onSearch={(v) => {
          setQuery(v)
          paged.setPage(1)
        }}
        searchLabel="Search drafts"
        filters={
          <FilterSelect
            label="Kind"
            value={kind}
            onChange={(v) => {
              setKind(v)
              paged.setPage(1)
            }}
            options={KIND_OPTIONS}
          />
        }
        activeFilters={kind ? 1 : 0}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        areaRef={fit.ref}
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              <TableHead className={MID_COL}>Draft</TableHead>
              <TableHead>Pool</TableHead>
              <TableHead className="text-right">Amount</TableHead>
              <TableHead className={WIDE_COL}>Terms</TableHead>
              <TableHead className={MID_COL}>Status</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.shown.length ? (
              paged.shown.map((d) => {
                const s = statusOf(d)
                return (
                  <TableRow key={d.id} data-draft-row={d.id} data-draft-kind={d.kind}>
                    <TableCell className={MID_COL}>
                      <OneLine className="font-medium" text={kindText(d)} />
                      <div className="flex h-5 flex-nowrap items-center gap-1.5 overflow-hidden">
                        {d.sandbox && <Money sandbox />}
                        {(d.onChain || (d.kind === "commit" && poolOf(d)?.treasury)) && <DevnetBadge />}
                      </div>
                    </TableCell>
                    <TableCell>
                      <OneLine className="font-medium" text={d.poolName} />
                      <OneLine className="text-xs text-muted-foreground" text={kindText(d)} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{usd(d.amountCents)}</TableCell>
                    <TableCell className={WIDE_COL}>{termsOf(d)}</TableCell>
                    <TableCell className={`${MID_COL} ${s.tone === "warn" ? "text-amber-600 dark:text-amber-300" : s.tone === "muted" ? "text-muted-foreground" : ""}`} data-draft-status>
                      <OneLine text={s.text} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="outline" onClick={() => setOpen(d.id)} data-review={d.id}>
                        Review
                      </Button>
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <EmptyRow cols={6}>{drafts.length ? "No drafts match these filters." : "No drafts yet. Ask the assistant to draft a commitment or a withdrawal; you confirm each one yourself."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </PanelList>
      <Sheet open={current !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" aria-describedby={undefined} data-sheet="draft">
          <SheetHeader>
            <SheetTitle>{current?.kind === "withdraw" ? "Draft withdrawal" : "Draft commitment"}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">
            {current && (
              <DraftPanel
                key={current.id}
                draft={current}
                pool={poolOf(current)}
                position={positionOf(current)}
                actions={actions}
                canCommit={canCommit}
                canWithdraw={canWithdraw}
                outcome={outcomes[current.id] ?? NOT_SENT}
                onOutcome={(o) => setOutcomes((all) => ({ ...all, [current.id]: o }))}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
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
    t === "pools" ? <PoolsTab data={data} poolIds={poolIds} /> : t === "drafts" ? <DraftsTab data={data} drafts={drafts} actions={actions} /> : <EarnTable tab={t} data={data} actions={actions} />

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
