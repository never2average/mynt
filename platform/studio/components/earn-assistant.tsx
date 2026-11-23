"use client"

// Earn (/earn): the investing assistant in the studio's chat workspace, the same shell as an app's
// builder (components/chat-workspace-shell.tsx), with different tabs on the right. The chat starts
// as the big centred prompt ("What do you want to earn?") with example chips; after the first
// message the right panel opens beside it with Pools (every pool open to the user as a table,
// showing the ones the conversation matched first, with Commit capital for liquidity providers and,
// on the pools they're invested in, their position with Withdraw and Details), My pools (builders)
// and My strategies (the commitments and withdrawals the assistant drafted for liquidity
// providers, and the pool proposals it drafted for builders, as a table, each approved only by the
// user's own click in its approval sheet, which calls the same routes as the tables and My pools'
// Propose pool, or declined; the assistant can't send anything itself). The chat bar has
// the wallet picker, and a draft for a pool with an on-chain treasury is a devnet deposit or
// withdrawal the user signs in their own wallet (components/earn-wallet.tsx). The chat's top right
// has Past conversations: this user's earlier Earn threads, kept on Mynt (lib/earn-history.ts),
// to pick one up again, or start a new one.
import { AssistantRuntimeProvider } from "@assistant-ui/react"
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk"
import type { UseChatHelpers } from "@ai-sdk/react"
import type { UIMessage } from "ai"
import { History, Layers, Loader2, Target, Wallet } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AskAiMarkdownText } from "@/components/ask-ai-markdown"
import { Thread } from "@/components/assistant-ui/thread"
import { ChatWelcome } from "@/components/chat-welcome"
import { ChatSearchDialog } from "@/components/chat-search"
import { ChatWorkspaceShell } from "@/components/chat-workspace-shell"
import { ViewSwitch } from "@/components/filter-controls"
import { downloadCsv } from "@/components/licences-view"
import { COL, PanelList, useFitRows, usePaged } from "@/components/list-layout"
import { APPROVAL_LABELS, ApprovalStatus, ApprovalSteps, ApprovalSummary, linearSteps, type ApprovalState, type Step } from "@/components/approval"
import { DevnetBadge, EarnDisclosure, EarnWalletProvider, DepositsPausedBadge, LinkedWallet, OnChainAction, OnChainPositionSheet, UnverifiedBuildBadge, WalletPicker, type EarnWalletState, type OnChainFlow } from "@/components/earn-wallet"
import { shortAddress } from "@/lib/linked-accounts"
import {
  CommitForm,
  commitOutcome,
  EarnTable,
  EmptyRow,
  FormDone,
  FormSheet,
  holdingFigures,
  holdingIn,
  Money,
  newIdempotencyKey,
  pagerOf,
  poolFacets,
  PositionDetailsSheet,
  correctionsOf,
  proposeConsequence,
  ProposeForm,
  StageStatus,
  waitingText,
  WithdrawForm,
  withdrawalOutcome,
  type DetailsView,
  type Holding,
  type LiquidityActions,
  type OpenForm,
} from "@/components/earn-view"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { depositFor, panelFrom, PROMPT_EXAMPLES, proposalFields, proposalOptions, type Draft, type MoneyDraft, type ProposalDraft } from "@/lib/earn"
import { ChatSaver, listChats, loadChat, migrateLocalChats, OPEN_FAILED, SAVE_REFUSED, sessionIdFor } from "@/lib/chat-sessions"
import { newThreadId, savedOutcomesFrom, type EarnThreadRecord, type SavedOutcome, type ThreadMatch } from "@/lib/earn-history"
import type { SlashCommand } from "@/lib/slash-commands"
import { centsToUsdcBaseUnits, DEPOSITS_PAUSED, onDevnet } from "@/lib/wallets"
import { toCsv } from "@/lib/compliance"
import {
  commitRefusal,
  earnTabFromQuery,
  filterPools,
  healthText,
  NO_POOL_FILTERS,
  STAGE_LABELS,
  limitsText,
  lockInText,
  noticeText,
  percentOfBps,
  poolCommitBlock,
  poolsViewFromQuery,
  reserveText,
  stageOf,
  stateName,
  statusText,
  TAB_LABELS,
  tabOpensPanel,
  tabsFor,
  usd,
  withdrawalRefusal,
  type EarnTab,
  type LiquidityAccess,
  type LiquidityData,
  type PoolFilters,
  type PoolRow,
  type PoolStage,
  type PoolsView,
  type Position,
  type Sponsored,
} from "@/lib/liquidity"

export type EarnStatus = "loading" | "enabled" | "disabled"
type Chat = UseChatHelpers<UIMessage>

// ---- the chat ----

const WELCOME_TITLE = "What do you want to earn?"

// The thread draws text and reads; the panel's data parts (data-earn-pools, data-earn-draft) are
// the panel's, not the thread's, so they're left out of what the thread renders (assistant-ui's
// AI SDK runtime has no renderer for data parts and would throw on one).
export const withoutDataParts = (messages: UIMessage[]): UIMessage[] => messages.map((m) => (m.parts.some((p) => p.type.startsWith("data-")) ? { ...m, parts: m.parts.filter((p) => !p.type.startsWith("data-")) } : m))

function EarnThread({ chat, commands, roles }: { chat: Chat; commands?: readonly SlashCommand[]; roles?: readonly string[] }) {
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
        commands={commands}
        roles={roles}
      />
    </AssistantRuntimeProvider>
  )
}

// Past conversations, as the chat's history button and its sheet use them.
export type EarnHistory = { threads: EarnThreadRecord[]; current: string; onPick: (id: string) => void; onNew: () => void; search?: (query: string) => Promise<ThreadMatch[] | null> }

// The round button floating at the chat's top right (icon only, named by its tooltip and label),
// and the centred pop-up it opens (about two thirds of the screen): New conversation, then this user's threads,
// newest first.
export function PastConversations({ history, open: shown, onOpenChange }: { history: EarnHistory; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const [own, setOwn] = useState(false)
  const open = shown ?? own
  const setOpen = onOpenChange ?? setOwn
  return (
    <>
      <span className="flex" data-earn-history>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="icon-sm" className="rounded-full bg-background" aria-label="Past conversations" onClick={() => setOpen(true)} data-history-button>
              <History />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Past conversations</TooltipContent>
        </Tooltip>
      </span>
      <ChatSearchDialog open={open} onOpenChange={setOpen} threads={history.threads} current={history.current} onPick={history.onPick} onNew={history.onNew} search={history.search} />
    </>
  )
}

// Each tab's icon: shown beside Past conversations while the panel is collapsed (ChatWorkspaceShell).
const TAB_ICONS: Record<EarnTab, typeof Layers> = { pools: Layers, "my-pools": Wallet, "my-strategies": Target }

// The chat side: the assistant, or, without a model, the same centred prompt that can't be used.
// (Past conversations floats at the chat's top right, beside Show tabs: ChatWorkspaceShell's chatCorner.)
// `notice`: a past conversation that couldn't be opened, or one too long to keep, said in the chat.
export function EarnChat({ chat, status, commands, roles, notice = null, onDismissNotice }: { chat: Chat; status: EarnStatus; commands?: readonly SlashCommand[]; roles?: readonly string[]; notice?: string | null; onDismissNotice?: () => void }) {
  if (status === "enabled")
    return (
      <div className="relative h-full" data-earn-chat>
        {notice ? (
          <div role="alert" className="absolute inset-x-0 top-3 z-10 mx-auto flex w-fit max-w-[90%] items-center gap-2 rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-sm text-destructive shadow-sm" data-thread-error>
            <span>{notice}</span>
            {onDismissNotice ? (
              <Button type="button" variant="ghost" size="sm" className="h-6 px-2" onClick={onDismissNotice}>
                Dismiss
              </Button>
            ) : null}
          </div>
        ) : null}
        <EarnThread chat={chat} commands={commands} roles={roles} />
      </div>
    )
  return (
    <div className="flex h-full flex-col bg-background px-4 pt-4" style={{ ["--thread-max-width" as string]: "44rem" }} data-earn-chat-off>
      <div className="mx-auto my-auto flex w-full max-w-(--thread-max-width) grow flex-col items-center justify-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl">{WELCOME_TITLE}</h1>
        <p className="text-sm text-muted-foreground" role="status">
          {status === "loading" ? "Checking the assistant…" : "AI is not configured on this studio. Pools and the other tabs still work."}
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

const ALL_STAGES: PoolStage[] = ["awaiting_approval", "sandbox", "uncleared", "cleared"]
const VIEW_LABELS: Record<PoolsView, string> = { matched: "Matched", all: "All", invested: "Invested" }

// Pools' columns: every one shows at every width, each with a min width for what it holds (a table
// wider than the panel scrolls sideways). Liquidity providers also get their position's columns,
// and, when they can act, the row's buttons.
export function poolColumns(provider: boolean, withActions: boolean): { label: string; className: string }[] {
  return [
    { label: "Pool", className: COL.name },
    { label: "State", className: COL.text },
    { label: "Money", className: COL.short },
    { label: "Lock-in", className: COL.short },
    { label: "Notice", className: COL.short },
    { label: "Limits", className: `${COL.wide} tabular-nums` },
    { label: "Reserve", className: COL.wide },
    { label: "Health", className: COL.text },
    ...(provider
      ? [
          { label: "Your position", className: COL.money },
          { label: "Queued", className: COL.money },
          { label: "Paid", className: COL.money },
          { label: "Waiting requests", className: COL.wide },
        ]
      : []),
    ...(withActions ? [{ label: "Actions", className: COL.actions }] : []),
  ]
}

// One pool as a table row: its name with product and line under it; its state and status; sandbox
// or real money (and its on-chain treasury); its terms; its reserve and latest health; then, for
// liquidity providers, what they hold in it (settled, queued and paid, and any withdrawal requests
// still waiting, and any correction to their state that needs their answer) and its buttons: Details
// and Withdraw where they hold a position, Respond on a correction, and Commit capital.
function PoolTableRow({
  pool,
  holding,
  provider,
  actionsColumn,
  commit,
  withdraw,
  respond,
  onDetails,
}: {
  pool: PoolRow
  holding: Holding | null
  provider: boolean // a liquidity provider's row: the position columns show, "—" without one
  actionsColumn: boolean // the table has its Actions column (empty on a row with no button)
  commit?: { blocked: string | null; onClick: () => void }
  withdraw?: { blocked: string | null; onClick: () => void }
  respond?: { blocked: string | null; onClick: () => void } // a correction to the firm's state waits for its answer
  onDetails?: () => void
}) {
  const product = `${pool.productName ?? pool.productId}${pool.productLine ? ` · ${pool.productLine}` : ""}`
  const coverage = pool.health?.coverageBps !== null && pool.health?.coverageBps !== undefined ? `Coverage ${percentOfBps(pool.health.coverageBps)}` : ""
  const f = holding ? holdingFigures(holding) : null
  const waiting = waitingText(holding)
  const correction = correctionsOf(holding)[0] ?? null
  const line = "block max-w-56 truncate"
  const sub = `${line} text-xs text-muted-foreground`
  return (
    <TableRow data-pool-row={pool.id} data-invested={holding ? "true" : undefined}>
      <TableCell className={COL.name}>
        <span className={`${line} font-medium`} title={pool.name} data-pool-name>
          {pool.name}
        </span>
        <span className={sub} title={product} data-product>
          {product}
        </span>
      </TableCell>
      <TableCell className={COL.text}>
        <StageStatus stage={stageOf(pool)} />
        <span className={sub} title={statusText(pool)} data-status>
          {statusText(pool)}
        </span>
      </TableCell>
      <TableCell className={COL.short}>
        <Money sandbox={pool.sandbox} />
        {pool.treasury ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0" data-treasury={pool.treasury.cluster}>
              {onDevnet(pool.treasury) ? "On-chain treasury" : "On-chain treasury, not on devnet"}
            </span>
            {onDevnet(pool.treasury) && <DevnetBadge />}
            {pool.treasury.verifiedBuild === false && <UnverifiedBuildBadge />}
            {pool.treasury.attestersFlag && <DepositsPausedBadge reason={pool.treasury.attestersFlag} />}
          </span>
        ) : null}
      </TableCell>
      <TableCell className={COL.short}>
        <span data-lock-in>{lockInText(pool.lockInDays)}</span>
      </TableCell>
      <TableCell className={COL.short}>
        <span data-notice>{noticeText(pool.noticePeriodDays)}</span>
      </TableCell>
      <TableCell className={`${COL.wide} tabular-nums`}>
        <span data-limits>{limitsText(pool)}</span>
      </TableCell>
      <TableCell className={COL.wide}>
        <span className={line} title={reserveText(pool)} data-reserve>
          {reserveText(pool)}
        </span>
      </TableCell>
      <TableCell className={COL.text}>
        <span className={line} title={healthText(pool.health)} data-health>
          {healthText(pool.health)}
        </span>
        {coverage && (
          <span className={sub} data-coverage>
            {coverage}
          </span>
        )}
      </TableCell>
      {provider && (
        <>
          <TableCell className={`${COL.money} font-medium`}>
            <span data-your-position>{f ? f.held : "—"}</span>
          </TableCell>
          <TableCell className={COL.money}>
            <span data-your-queued>{f ? f.queued : "—"}</span>
          </TableCell>
          <TableCell className={COL.money}>
            <span data-your-paid>{f ? f.paid : "—"}</span>
          </TableCell>
          <TableCell className={COL.wide}>
            {correction && <ApprovalStatus state="needs-answer" reason={`US state ${stateName(correction.fromState)} → ${stateName(correction.toState)}`} className="max-w-56" data-correction-status />}
            {waiting ? (
              <ApprovalStatus state="waiting" label={waiting} className="max-w-56" data-waiting-requests />
            ) : correction ? null : (
              <span className="text-muted-foreground">{holding ? "None" : "—"}</span>
            )}
          </TableCell>
        </>
      )}
      {actionsColumn && (
        <TableCell className={COL.actions}>
          <div className="flex items-center justify-end gap-2" data-row-actions>
            {holding && onDetails && (
              <Button size="sm" variant="outline" onClick={onDetails} data-row-details={pool.id}>
                Details
              </Button>
            )}
            {holding && respond && correction && (
              <Button size="sm" variant="default" disabled={Boolean(respond.blocked)} title={respond.blocked ?? undefined} onClick={respond.onClick} data-row-respond={pool.id}>
                Respond
              </Button>
            )}
            {holding && withdraw && (
              <Button size="sm" variant="outline" disabled={Boolean(withdraw.blocked)} title={withdraw.blocked ?? undefined} onClick={withdraw.onClick} data-row-withdraw={pool.id}>
                Withdraw
              </Button>
            )}
            {commit && (
              <Button size="sm" variant="outline" disabled={Boolean(commit.blocked)} title={commit.blocked ?? undefined} onClick={commit.onClick} data-commit={pool.id}>
                Commit capital
              </Button>
            )}
          </div>
        </TableCell>
      )}
    </TableRow>
  )
}

// Pools: every pool open to the user, as a table. The toolbar's view switch picks which: Matched
// (the pools the assistant matched, shown first once it has; only then), All, and Invested
// (liquidity providers: the pools they hold a position in; always offered to them, empty until they
// hold one). A liquidity provider's row shows what they hold there, with Withdraw (the withdrawal
// form, or an on-chain position's deposits) and Details (its amounts, deposits and withdrawal
// requests), and Commit capital (also the toolbar's CTA). A new match from the assistant shows
// Matched again.
export function PoolsTab({
  data,
  poolIds,
  actions,
  showAll = false,
  initialView = null,
  initialForm = null,
}: {
  data: LiquidityData
  poolIds: string[] | null
  actions?: LiquidityActions
  showAll?: boolean // a link to the old Opportunities: All
  initialView?: PoolsView | null // a link's view (?tab=my-positions is Invested)
  initialForm?: OpenForm
}) {
  const pools = useMemo(() => {
    const all = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
    return all.filter((p, i) => all.findIndex((x) => x.id === p.id) === i)
  }, [data])
  const lp = data.provider ?? null
  const withdrawals = lp?.withdrawals ?? []
  const holdings = useMemo(() => new Map(lp ? pools.map((p) => [p.id, holdingIn(p.id, lp.positions, lp.withdrawals)] as const) : []), [lp, pools])
  const holdingOf = (id: string) => holdings.get(id) ?? null
  const matchedIds = poolIds && poolIds.length ? poolIds : null
  const views: PoolsView[] = [...(matchedIds ? (["matched"] as const) : []), "all", ...(lp ? (["invested"] as const) : [])]
  // A new match from the assistant shows the matched pools again.
  const sig = matchedIds?.join(",") ?? ""
  const [scope, setScope] = useState<{ sig: string; view: PoolsView | null }>({ sig, view: initialView ?? (showAll ? "all" : null) })
  if (scope.sig !== sig) setScope({ sig, view: null })
  const view: PoolsView = scope.view && views.includes(scope.view) ? scope.view : matchedIds ? "matched" : "all"
  const [f, setF] = useState<PoolFilters>(NO_POOL_FILTERS)
  const [form, setForm] = useState<OpenForm>(initialForm)
  const [done, setDone] = useState<string | null>(null)
  const [deposits, setDeposits] = useState<Position | null>(null)
  const [details, setDetails] = useState<string | null>(null)
  const [detailsView, setDetailsView] = useState<DetailsView>(null)
  const base = view === "matched" && matchedIds ? matchedIds.map((id) => pools.find((p) => p.id === id)).filter((p): p is PoolRow => Boolean(p)) : view === "invested" ? pools.filter((p) => holdingOf(p.id)) : pools
  const shown = filterPools(base, f)
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  // The Actions column, for a liquidity provider who can commit or withdraw, or has a position's Details to open.
  const actionsColumn = Boolean(lp && (actions || paged.shown.some((p) => holdingOf(p.id))))
  const columns = poolColumns(Boolean(lp), actionsColumn)
  const filter = (n: PoolFilters) => {
    setF(n)
    paged.setPage(1)
  }
  const commitBlock = (p: PoolRow): string | null => {
    if (!lp) return "Only liquidity providers commit capital"
    if (!lp.canCommit) return "Committing capital comes with Mynt's next update"
    if (!lp.pools.some((x) => x.id === p.id)) return "This pool isn't open to your commitments"
    return poolCommitBlock(p, lp.positions.find((x) => x.poolId === p.id))
  }
  const anyOpen = lp ? lp.pools.some((p) => !commitBlock(p)) : false
  const openCommit = (poolId?: string) => {
    setDone(null)
    setForm({ kind: "commit", poolId })
  }
  // Withdraw on a row: the withdrawal form for a position on rails; for one on chain only, its
  // deposits (each with its own Withdraw).
  const withdrawOf = (h: Holding): { blocked: string | null; onClick: () => void } =>
    h.rails
      ? {
          blocked: !lp?.canWithdraw ? "Withdrawals come with Mynt's next update" : h.rails.availableCents <= 0 ? "Nothing settled is available to withdraw" : null,
          onClick: () => {
            setDone(null)
            setForm({ kind: "withdraw", poolId: h.rails!.poolId })
          },
        }
      : { blocked: null, onClick: () => setDeposits(h.chain[0] ?? null) }
  const exportCsv = () =>
    downloadCsv(
      "pools.csv",
      toCsv(
        ["Pool", "Product", "Product line", "Lock-in", "Notice", "Commitment limits", "Minimum reserve", "Health", "State", "Status", ...(lp ? ["Your position (settled)", "Queued", "Paid", "Available", "Withdrawal requests waiting"] : [])],
        shown.map((p) => {
          const h = holdingOf(p.id)
          const fig = h ? holdingFigures(h) : null
          return [p.name, p.productName ?? p.productId, p.productLine, lockInText(p.lockInDays), noticeText(p.noticePeriodDays), limitsText(p), reserveText(p), healthText(p.health), STAGE_LABELS[stageOf(p)], statusText(p), ...(lp ? (fig ? [fig.held, fig.queued, fig.paid, fig.available, waitingText(h) || "None"] : ["—", "—", "—", "—", "—"]) : [])]
        }),
      ),
    )
  // Respond on a row: its Details sheet, opened at the correction's approval panel.
  const respondOf = (poolId: string, h: Holding): { blocked: string | null; onClick: () => void } | undefined => {
    const c = correctionsOf(h)[0]
    if (!c) return undefined
    return {
      blocked: lp?.canRespond ? null : "Answering a state correction comes with Mynt's next update",
      onClick: () => {
        setDetailsView({ kind: "correction", correction: c })
        setDetails(poolId)
      },
    }
  }
  const rails = lp ? lp.positions.filter((p) => !p.onChain) : []
  const detailsPool = details ? (pools.find((p) => p.id === details) ?? null) : null

  return (
    <div className="h-full" data-earn-pools-tab>
      <PanelList
        id="pools"
        noun={["pool", "pools"]}
        search={f.query}
        onSearch={(query) => filter({ ...f, query })}
        searchLabel="Search pools"
        view={
          views.length > 1 ? (
            <ViewSwitch
              label="Show"
              value={view}
              options={views.map((v) => ({ value: v, label: VIEW_LABELS[v] }))}
              onChange={(v) => {
                setScope({ sig, view: v })
                paged.setPage(1)
              }}
            />
          ) : undefined
        }
        facets={poolFacets(f, filter, pools, ALL_STAGES, true)}
        onClearFilters={() => filter({ ...NO_POOL_FILTERS, query: f.query })}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        cta={
          lp && actions ? (
            <Button onClick={() => openCommit()} disabled={!lp.canCommit || !anyOpen} title={!lp.canCommit ? "Committing capital comes with Mynt's next update" : !anyOpen ? "No pool is taking commitments right now" : undefined} data-cta="commit">
              Commit capital
            </Button>
          ) : undefined
        }
        areaRef={fit.ref}
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              {columns.map((c) => (
                <TableHead key={c.label} className={c.className}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.shown.length ? (
              paged.shown.map((p) => {
                const h = holdingOf(p.id)
                return (
                  <PoolTableRow
                    key={p.id}
                    pool={p}
                    provider={Boolean(lp)}
                    actionsColumn={actionsColumn}
                    holding={h}
                    commit={lp && actions ? { blocked: commitBlock(p), onClick: () => openCommit(p.id) } : undefined}
                    withdraw={h && actions ? withdrawOf(h) : undefined}
                    respond={h && actions?.respond ? respondOf(p.id, h) : undefined}
                    onDetails={h ? () => setDetails(p.id) : undefined}
                  />
                )
              })
            ) : (
              <EmptyRow cols={columns.length}>{view === "invested" && !base.length ? "No positions yet. Commit capital to an open pool to start one." : base.length ? "No pools match these filters." : "No pools to show yet."}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </PanelList>
      {lp && actions && (
        <FormSheet open={form?.kind === "commit" && lp.pools.length > 0} onClose={() => setForm(null)} title="Commit capital" id="commit">
          {done ? <FormDone message={done} /> : form?.kind === "commit" && lp.pools.length ? <CommitForm key={form.poolId ?? "any"} pools={lp.pools} positions={lp.positions} poolId={form.poolId} canCommit={lp.canCommit} actions={actions} onDone={setDone} /> : null}
        </FormSheet>
      )}
      {lp && actions && (
        <FormSheet open={form?.kind === "withdraw" && rails.length > 0} onClose={() => setForm(null)} title="Request withdrawal" id="withdraw">
          {done ? <FormDone message={done} /> : form?.kind === "withdraw" && rails.length ? <WithdrawForm key={form.poolId ?? "any"} positions={rails} pools={lp.pools} poolId={form.poolId} canWithdraw={lp.canWithdraw} actions={actions} onDone={setDone} /> : null}
        </FormSheet>
      )}
      {lp && <OnChainPositionSheet position={deposits} pools={lp.pools} onClose={() => setDeposits(null)} />}
      {lp && (
        <PositionDetailsSheet
          name={detailsPool?.name ?? ""}
          holding={details ? holdingOf(details) : null}
          withdrawals={withdrawals}
          pools={lp.pools}
          onClose={() => setDetails(null)}
          view={detailsView}
          onView={setDetailsView}
          actions={actions}
          canCancel={Boolean(lp.canCancel)}
          canRespond={Boolean(lp.canRespond)}
        />
      )}
    </div>
  )
}

// A draft checked against the pool and position as the page has them now (Mynt checks it all again).
export function draftCheck(draft: MoneyDraft, pool: PoolRow | null, position: Position | null, canCommit: boolean, canWithdraw: boolean) {
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

// What became of a draft, and the idempotency key it was (or will be) sent with. The workspace
// keeps it (and saves it with the thread), so neither closing the sheet nor coming back to the
// thread later lets it be sent twice. A declined draft is never sent.
type DraftState = { kind: "idle" } | { kind: "busy" } | { kind: "done"; message: string } | { kind: "error"; message: string } | { kind: "declined" }
export type DraftOutcome = { state: DraftState; key: string | null }
const NOT_SENT: DraftOutcome = { state: { kind: "idle" }, key: null }

// Where an on-chain draft's signing stands (components/earn-wallet.tsx OnChainAction), for its
// row's status and its sheet's steps. Only the page knows it, so it isn't saved with the thread.
export type ChainStep = { kind: "idle" } | { kind: "preparing" } | { kind: "sign" } | { kind: "sending" } | { kind: "confirmed"; signature: string } | { kind: "failed"; message: string; signed: boolean }
const chainStepOf = (f: OnChainFlow): ChainStep =>
  f.kind === "preparing"
    ? { kind: "preparing" }
    : f.kind === "review" || f.kind === "refreshing" || f.kind === "signing"
      ? { kind: "sign" }
      : f.kind === "sent"
        ? { kind: "sending" }
        : f.kind === "confirmed"
          ? { kind: "confirmed", signature: f.signature }
          : f.kind === "failed"
            ? { kind: "failed", message: f.error, signed: true }
            : f.kind === "error"
              ? { kind: "failed", message: f.message, signed: false }
              : { kind: "idle" }

const RAIL_STEPS = ["Review", "Approve", "Done"]
const CHAIN_STEPS = ["Review", "Approve", "Sign in wallet", "Done"]

// The approval sheet's steps for a draft: Review, Approve, (on chain) Sign in wallet, Done.
export function draftSteps(o: DraftOutcome, onChain: boolean, chain: ChainStep = { kind: "idle" }): Step[] {
  const labels = onChain ? CHAIN_STEPS : RAIL_STEPS
  const s = o.state.kind
  if (s === "declined") return linearSteps(labels, 1, "declined")
  if (s === "done") return linearSteps(labels, labels.length)
  if (!onChain) return s === "busy" ? linearSteps(labels, 1) : s === "error" ? linearSteps(labels, 1, "failed") : linearSteps(labels, 0)
  switch (chain.kind) {
    case "preparing":
      return linearSteps(labels, 1)
    case "sign":
      return linearSteps(labels, 2)
    case "sending":
      return linearSteps(labels, 3)
    case "confirmed":
      return linearSteps(labels, 4)
    case "failed":
      return linearSteps(labels, chain.signed ? 2 : 1, "failed")
    default:
      return linearSteps(labels, 0)
  }
}

// The Decline button: the draft is marked declined (and kept so with the thread); it's never sent.
function DeclineButton({ id, disabled, onDecline }: { id: string; disabled: boolean; onDecline?: () => void }) {
  if (!onDecline) return null
  return (
    <Button variant="outline" onClick={onDecline} disabled={disabled} data-decline={id}>
      Decline
    </Button>
  )
}

// A draft from the assistant, as its approval sheet shows it: where the approval stands, what will
// happen, then Approve and Decline. Nothing happens until the user clicks Approve (on chain, then
// signs in their own wallet).
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
  onChainStep,
  onDecline,
}: {
  draft: MoneyDraft
  pool: PoolRow | null
  position: Position | null
  actions: LiquidityActions
  canCommit: boolean
  canWithdraw: boolean
  newKey?: () => string
  outcome?: DraftOutcome
  onOutcome?: (o: DraftOutcome) => void
  onChainStep?: (s: ChainStep) => void
  onDecline?: () => void
}) {
  const [local, setLocal] = useState<DraftOutcome>(NOT_SENT)
  const o = outcome ?? local
  const set = onOutcome ?? setLocal
  const state = o.state
  const [chain, setChain] = useState<ChainStep>({ kind: "idle" })
  // An on-chain draft already done when its sheet opened says so; one signed while it's open keeps
  // the wallet flow's own confirmation on screen.
  const [doneAtOpen] = useState(state.kind === "done")
  const { commit, onChain, units, picked, onChainBlock, refusal } = draftCheck(draft, pool, position, canCommit, canWithdraw)
  const closed = state.kind === "done" || state.kind === "declined"

  const confirm = async () => {
    if (refusal || state.kind === "busy" || closed) return
    const key = o.key ?? newKey()
    set({ state: { kind: "busy" }, key })
    const r = draft.kind === "commit"
      ? await actions.commit({ pool_id: draft.poolId, amount_cents: draft.amountCents, state: draft.state ?? "", idempotency_key: key })
      : await actions.withdraw({ pool_id: draft.poolId, amount_cents: draft.amountCents, idempotency_key: key })
    if ("error" in r) return set({ state: { kind: "error", message: r.error }, key: r.refused ? null : key })
    set({ state: { kind: "done", message: commit ? commitOutcome(r.reply, draft.sandbox) : withdrawalOutcome(r.reply, draft.sandbox) }, key })
  }
  const flow = (f: OnChainFlow) => {
    const s = chainStepOf(f)
    setChain(s)
    onChainStep?.(s)
    if (s.kind === "confirmed" && state.kind !== "done") set({ state: { kind: "done", message: `Signed in your wallet and confirmed (transaction ${shortAddress(s.signature)}).` }, key: o.key })
  }
  const inFlight = state.kind === "busy" || chain.kind === "preparing" || chain.kind === "sign" || chain.kind === "sending"
  const decline = <DeclineButton id={draft.id} disabled={closed || inFlight} onDecline={onDecline} />
  const effect = commit
    ? "It counts in your position once it settles. Withdrawals later wait the notice period and are paid only while the pool stays above its minimum reserve."
    : "Paid first in, first out after the notice period, and only as far as the latest verified health snapshot keeps the pool above its minimum reserve."

  return (
    <div className="flex flex-col gap-4" data-draft={draft.kind}>
      <ApprovalSteps steps={draftSteps(o, onChain, chain)} />
      <ApprovalSummary
        rows={[
          [
            "Pool",
            <span key="pool" className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="block max-w-60 truncate font-medium" title={draft.poolName} data-draft-pool>
                {draft.poolName}
              </span>
              {draft.sandbox && <Money sandbox />}
            </span>,
            "pool",
          ],
          [
            "Amount",
            <span key="amount" className="font-semibold tabular-nums" data-draft-amount>
              {usd(draft.amountCents)}
            </span>,
            "amount",
          ],
          pool && ["Lock-in", <span key="lock-in" data-lock-in>{lockInText(pool.lockInDays)}</span>, "lock-in"],
          pool && ["Notice period", <span key="notice" data-notice>{noticeText(pool.noticePeriodDays)}</span>, "notice"],
          pool && commit && ["Limits", <span key="limits" className="tabular-nums">{limitsText(pool)}</span>, "limits"],
          pool && ["Minimum reserve", <span key="reserve">{reserveText(pool)}</span>, "reserve"],
          draft.kind === "commit" && !onChain && Boolean(draft.state) && ["From", <span key="from">{draft.state!.slice(3).toUpperCase()}</span>, "from"],
          onChain && [
            commit ? "From" : "To",
            <span key="wallet" className="flex items-center gap-2" data-draft-wallet>
              {draft.wallet ? <LinkedWallet address={draft.wallet} /> : <span className="text-xs">your chosen wallet</span>}
              <DevnetBadge />
            </span>,
            "wallet",
          ],
          pool && ["What happens", <span key="effect" data-approval-effect>{effect}</span>, "effect"],
        ]}
      />
      {!onChain && refusal && !closed && (
        <p className="text-sm text-amber-600 dark:text-amber-300" data-refusal>
          {refusal}
        </p>
      )}
      {state.kind === "declined" && (
        <p role="status" className="text-sm text-muted-foreground" data-draft-declined>
          Declined. Nothing was sent.
        </p>
      )}
      {state.kind === "done" && (!onChain || doneAtOpen) && (
        <p role="status" className="text-sm" data-draft-done>
          {state.message}
        </p>
      )}
      {state.kind === "error" && (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2" data-approval-footer>
        {onChain ? (
          state.kind === "declined" || (state.kind === "done" && doneAtOpen) ? null : (
            <OnChainAction kind={commit ? "deposit" : "withdrawal"} poolId={draft.poolId} amountBaseUnits={units} amountText={usd(draft.amountCents)} deposit={picked && "deposit" in picked ? picked.deposit : null} wallet={draft.wallet ?? null} blocked={onChainBlock} newKey={newKey} label="Approve" beside={decline} onFlow={flow} />
          )
        ) : (
          <>
            <Button onClick={() => void confirm()} disabled={Boolean(refusal) || state.kind === "busy" || closed} data-confirm={draft.kind}>
              {state.kind === "busy" && <Loader2 className="animate-spin" />}
              Approve
            </Button>
            {decline}
          </>
        )}
      </div>
    </div>
  )
}

// Why a drafted pool proposal can't be sent now, or null (Mynt checks it all again).
export function proposalBlock(draft: ProposalDraft, options: Sponsored[] | null): string | null {
  if (options === null) return "Proposing pools comes with Mynt's next update."
  if (!proposalOptions(options, draft.productId, draft.componentKey, draft.sponsorId).length) return "This component has no approved sponsorship any more, so it can't have a pool."
  return null
}

// A proposal's terms, as plain text.
export const proposalTermsText = (t: ProposalDraft["terms"]) =>
  `Reserve ${percentOfBps(t.min_reserve_bps)}, at least ${usd(t.min_reserve_floor_cents)} · Notice ${noticeText(t.notice_period_days)} · ${usd(t.min_commitment_cents)} – ${usd(t.max_commitment_cents)} per firm`

// A pool proposal from the assistant, as its approval sheet shows it: its steps and summary, then
// the Propose pool form, prefilled from the draft, with Approve and Decline. It's sent with the
// draft's idempotency key, kept in its outcome (and saved with the thread), so a retry after a
// network error, or after coming back to the thread, is the pool Mynt may already have made, never
// a second one. Only a refusal from Mynt lets go of the key.
export function ProposalPanel({ draft, options, actions, outcome, onOutcome, newKey = newIdempotencyKey, onDecline }: { draft: ProposalDraft; options: Sponsored[] | null; actions: LiquidityActions; outcome?: DraftOutcome; onOutcome?: (o: DraftOutcome) => void; newKey?: () => string; onDecline?: () => void }) {
  const [local, setLocal] = useState<DraftOutcome>(NOT_SENT)
  const o = outcome ?? local
  const set = onOutcome ?? setLocal
  const sending = useRef(false)
  // The key it will be sent with, until one is kept in its outcome.
  const [fresh, setFresh] = useState(newKey)
  const key = o.key ?? fresh
  const block = proposalBlock(draft, options)
  const closed = o.state.kind === "done" || o.state.kind === "declined"
  const decline = <DeclineButton id={draft.id} disabled={closed || o.state.kind === "busy"} onDecline={onDecline} />
  const once: LiquidityActions = {
    ...actions,
    propose: async (input) => {
      if (sending.current || o.state.kind === "busy" || closed) return { error: "This proposal is already being sent." }
      sending.current = true
      const sent = input.idempotency_key ?? key
      set({ state: { kind: "busy" }, key: sent })
      const r = await actions.propose({ ...input, idempotency_key: sent })
      if ("error" in r) {
        sending.current = false
        if (r.refused) setFresh(newKey())
        set({ state: { kind: "error", message: r.error }, key: r.refused ? null : sent })
      }
      return r
    },
  }
  const option = options && !block ? options.indexOf(proposalOptions(options, draft.productId, draft.componentKey, draft.sponsorId)[0]) : -1
  return (
    <div className="flex flex-col gap-4" data-draft="proposal">
      <ApprovalSteps steps={draftSteps(o, false)} />
      <ApprovalSummary
        rows={[
          ["Pool", <span key="pool" className="block max-w-60 truncate font-medium" title={draft.poolName} data-draft-pool>{draft.poolName}</span>, "pool"],
          ["Product", <span key="product">{`${draft.productName}${draft.componentKey ? ` · ${draft.componentKey}` : ""}`}</span>, "product"],
          ["Sponsor", <span key="sponsor">{draft.sponsorName ?? "Not named"}</span>, "sponsor"],
          ["Money", <Money key="money" sandbox={draft.sandbox} />, "money"],
          ["Terms", <span key="terms" data-draft-terms>{proposalTermsText(draft.terms)}</span>, "terms"],
          ["What happens", <span key="effect" data-approval-effect>{proposeConsequence(draft.sponsorName ?? "The sponsoring licence provider")}</span>, "effect"],
        ]}
      />
      {o.state.kind === "done" ? (
        <FormDone message={o.state.message} />
      ) : o.state.kind === "declined" ? (
        <p role="status" className="text-sm text-muted-foreground" data-draft-declined>
          Declined. Nothing was sent.
        </p>
      ) : block || !options ? (
        <>
          <p className="text-sm text-amber-600 dark:text-amber-300" data-refusal>
            {block}
          </p>
          <div className="flex flex-wrap items-center gap-2" data-approval-footer>
            {decline}
          </div>
        </>
      ) : (
        <ProposeForm options={options} actions={once} idempotencyKey={key} initial={{ option, ...proposalFields(draft.terms) }} onDone={(message) => set({ state: { kind: "done", message }, key })} submitLabel="Approve" beside={decline} consequence={false} />
      )}
    </div>
  )
}

const KIND_OPTIONS = [
  { value: "commit", label: "Commitment" },
  { value: "withdraw", label: "Withdrawal" },
]
const PROPOSAL_OPTION = { value: "proposal", label: "Pool proposal" }

// Draft outcomes as a thread keeps them (lib/earn-history.ts, saved as outcome events), and back: the key a draft was (or
// will be) sent with, what Mynt answered once it was sent, and whether the user declined it.
export const savedOutcomes = (all: Record<string, DraftOutcome>): Record<string, SavedOutcome> =>
  Object.fromEntries(Object.entries(all).map(([id, o]) => [id, { key: o.key, sent: o.state.kind === "done" ? o.state.message : null, ...(o.state.kind === "declined" ? { declined: true as const } : {}) }]))
export const restoredOutcomes = (all: Record<string, SavedOutcome>): Record<string, DraftOutcome> =>
  Object.fromEntries(Object.entries(all).map(([id, o]) => [id, { key: o.key, state: o.sent !== null ? { kind: "done", message: o.sent } : o.declined ? { kind: "declined" } : { kind: "idle" } } as DraftOutcome]))

// My strategies' columns: every one shows at every width, each with a min width for what it holds.
export const STRATEGY_COLUMNS = [
  { label: "Strategy", className: COL.name },
  { label: "Pool", className: COL.text },
  { label: "Amount", className: COL.money },
  { label: "Terms", className: COL.wide },
  { label: "Status", className: COL.text },
  { label: "Actions", className: COL.actions },
]

// My strategies: what the assistant drafted for the user (commitments and withdrawals, or pool
// proposals for a builder), one table row each, with its approval status. Review opens the
// approval sheet (its steps, what will happen, Approve and Decline); Decline on the row or in the
// sheet marks it declined, never sent. The outcomes are the workspace's when it passes them (so a
// thread keeps them), else this tab's own.
export function StrategiesTab({
  data,
  drafts,
  actions,
  outcomes: given,
  onOutcome,
}: {
  data: LiquidityData
  drafts: Draft[]
  actions: LiquidityActions
  outcomes?: Record<string, DraftOutcome>
  onOutcome?: (id: string, o: DraftOutcome) => void
}) {
  const pools = [...(data.provider?.pools ?? []), ...(data.builder?.pools ?? [])]
  const positions = data.provider?.positions ?? []
  const canCommit = data.provider?.canCommit ?? false
  const canWithdraw = data.provider?.canWithdraw ?? false
  const [own, setOwn] = useState<Record<string, DraftOutcome>>({})
  const outcomes = given ?? own
  const setOutcome = (id: string, o: DraftOutcome) => (onOutcome ? onOutcome(id, o) : setOwn((all) => ({ ...all, [id]: o })))
  const [chain, setChain] = useState<Record<string, ChainStep>>({})
  const [open, setOpen] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [kind, setKind] = useState<string[]>([])
  const proposable = data.builder?.proposable ?? null
  const poolOf = (d: MoneyDraft) => pools.find((p) => p.id === d.poolId) ?? null
  const positionOf = (d: MoneyDraft) => positions.find((p) => p.poolId === d.poolId && (d.kind === "withdraw" && d.onChain ? p.onChain && p.wallet === d.wallet : !p.onChain)) ?? null
  const outcomeOf = (d: Draft) => outcomes[d.id] ?? NOT_SENT
  const statusOf = (d: Draft): { state: ApprovalState; label?: string; reason?: string } => {
    const o = outcomeOf(d)
    if (o.state.kind === "declined") return { state: "declined" }
    if (o.state.kind === "done") return { state: "done", label: d.kind === "proposal" ? "Proposed" : d.onChain || (d.kind === "commit" && poolOf(d)?.treasury) ? "Done" : "Sent", reason: o.state.message }
    if (o.state.kind === "busy") return { state: "sending" }
    if (o.state.kind === "error") return { state: "failed", reason: o.state.message }
    if (d.kind === "proposal") {
      const block = proposalBlock(d, proposable)
      return block ? { state: "blocked", label: block, reason: block } : { state: "needs-approval" }
    }
    const c = draftCheck(d, poolOf(d), positionOf(d), canCommit, canWithdraw)
    if (c.onChain) {
      const s = chain[d.id]
      if (s?.kind === "preparing" || s?.kind === "sending") return { state: "sending" }
      if (s?.kind === "sign") return { state: "sign" }
      if (s?.kind === "failed") return { state: "failed", reason: s.message }
      return c.onChainBlock ? { state: "blocked", label: c.onChainBlock, reason: c.onChainBlock } : { state: "needs-approval" }
    }
    return c.refusal ? { state: "blocked", label: c.refusal, reason: c.refusal } : { state: "needs-approval" }
  }
  // A draft can be declined until it's sent (or being sent, or waiting in the wallet).
  const declinable = (d: Draft) => {
    const s = outcomeOf(d).state.kind
    const c = chain[d.id]?.kind
    return s !== "done" && s !== "declined" && s !== "busy" && c !== "preparing" && c !== "sign" && c !== "sending" && c !== "confirmed"
  }
  const decline = (d: Draft) => {
    if (!declinable(d)) return
    setOutcome(d.id, { state: { kind: "declined" }, key: outcomeOf(d).key })
    setOpen(null)
  }
  // Closing the sheet before anything was signed lets go of the wallet step (it starts again on Review).
  const close = () => {
    const id = open
    if (id && (chain[id]?.kind === "preparing" || chain[id]?.kind === "sign")) setChain((all) => ({ ...all, [id]: { kind: "idle" } }))
    setOpen(null)
  }
  const q = query.trim().toLowerCase()
  const shown = drafts.filter((d) => (!q || d.poolName.toLowerCase().includes(q) || (d.kind === "proposal" && d.productName.toLowerCase().includes(q))) && (!kind.length || kind.includes(d.kind)))
  const fit = useFitRows()
  const paged = usePaged(shown, fit.size)
  const kindText = (d: Draft) => (d.kind === "commit" ? "Commitment" : d.kind === "proposal" ? "Pool proposal" : "Withdrawal request")
  const termsOf = (d: Draft) => {
    if (d.kind === "proposal") return proposalTermsText(d.terms)
    const pool = poolOf(d)
    return pool ? `Lock-in ${lockInText(pool.lockInDays)} · Notice ${noticeText(pool.noticePeriodDays)}` : "Terms not available"
  }
  const statusWords = (d: Draft) => {
    const s = statusOf(d)
    const label = s.label ?? APPROVAL_LABELS[s.state]
    return s.state === "failed" && s.reason ? `${label}: ${s.reason}` : label
  }
  const exportCsv = () => downloadCsv("my-strategies.csv", toCsv(["Strategy", "Pool", "Amount", "Terms", "Status"], shown.map((d) => [kindText(d), d.poolName, d.kind === "proposal" ? "—" : usd(d.amountCents), termsOf(d), statusWords(d)])))
  const current = drafts.find((d) => d.id === open) ?? null
  const kindOptions = [...(data.access.liquidityProvider ? KIND_OPTIONS : []), ...(data.access.builder ? [PROPOSAL_OPTION] : [])]
  const asked = [data.access.liquidityProvider && "a commitment or a withdrawal", data.access.builder && "a pool proposal"].filter(Boolean).join(", or ")
  const line = "block max-w-56 truncate"
  const sub = `${line} text-xs text-muted-foreground`

  return (
    <div className="h-full" data-earn-strategies-tab>
      <PanelList
        id="my-strategies"
        noun={["strategy", "strategies"]}
        search={query}
        onSearch={(v) => {
          setQuery(v)
          paged.setPage(1)
        }}
        searchLabel="Search strategies"
        facets={[
          {
            id: "kind",
            label: "Kind",
            options: kindOptions,
            selected: kind,
            onChange: (v) => {
              setKind(v)
              paged.setPage(1)
            },
          },
        ]}
        onClearFilters={() => {
          setKind([])
          paged.setPage(1)
        }}
        onExport={exportCsv}
        exportDisabled={!shown.length}
        areaRef={fit.ref}
        {...pagerOf(paged, shown.length)}
      >
        <Table>
          <TableHeader className="sticky top-0 bg-card">
            <TableRow>
              {STRATEGY_COLUMNS.map((c) => (
                <TableHead key={c.label} className={c.className}>
                  {c.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paged.shown.length ? (
              paged.shown.map((d) => {
                const s = statusOf(d)
                const needsYou = s.state === "needs-approval" || s.state === "sign"
                const onChain = d.kind !== "proposal" && (d.onChain || (d.kind === "commit" && Boolean(poolOf(d)?.treasury)))
                return (
                  <TableRow key={d.id} data-draft-row={d.id} data-draft-kind={d.kind}>
                    <TableCell className={COL.name}>
                      <span className={`${line} font-medium`} data-draft-title>
                        {kindText(d)}
                      </span>
                      <span className={`${sub} flex items-center gap-1.5`}>
                        {d.kind === "proposal" ? (
                          <span className="min-w-0 truncate" title={d.productName} data-draft-product>
                            {d.productName}
                          </span>
                        ) : (
                          <Money sandbox={d.sandbox} />
                        )}
                        {onChain && <DevnetBadge />}
                      </span>
                    </TableCell>
                    <TableCell className={COL.text}>
                      <span className={line} title={d.poolName} data-draft-pool>
                        {d.poolName}
                      </span>
                      {d.kind === "proposal" && d.sandbox && <Money sandbox />}
                    </TableCell>
                    <TableCell className={`${COL.money} font-medium`}>
                      <span data-draft-amount>{d.kind === "proposal" ? "—" : usd(d.amountCents)}</span>
                    </TableCell>
                    <TableCell className={COL.wide}>
                      <span className="block max-w-72 truncate" title={termsOf(d)} data-draft-terms>
                        {termsOf(d)}
                      </span>
                    </TableCell>
                    <TableCell className={COL.text}>
                      <ApprovalStatus state={s.state} label={s.label} reason={s.reason} className="max-w-56" data-draft-status />
                    </TableCell>
                    <TableCell className={COL.actions}>
                      <div className="flex items-center justify-end gap-2" data-row-actions>
                        <Button size="sm" variant={needsYou ? "default" : "outline"} onClick={() => setOpen(d.id)} data-review={d.id}>
                          Review
                        </Button>
                        <Button size="sm" variant="outline" disabled={!declinable(d)} onClick={() => decline(d)} data-row-decline={d.id}>
                          Decline
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <EmptyRow cols={STRATEGY_COLUMNS.length}>{drafts.length ? "No strategies match these filters." : `No strategies yet. Ask the assistant to draft ${asked}; you approve each one yourself.`}</EmptyRow>
            )}
          </TableBody>
        </Table>
      </PanelList>
      <Sheet open={current !== null} onOpenChange={(o) => !o && close()}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg" aria-describedby={undefined} data-sheet="draft">
          <SheetHeader>
            <SheetTitle>{current?.kind === "withdraw" ? "Approve withdrawal request" : current?.kind === "proposal" ? "Approve pool proposal" : "Approve commitment"}</SheetTitle>
          </SheetHeader>
          <div className="px-4 pb-4">
            {current?.kind === "proposal" && (
              <ProposalPanel key={current.id} draft={current} options={proposable} actions={actions} outcome={outcomeOf(current)} onOutcome={(o) => setOutcome(current.id, o)} onDecline={() => decline(current)} />
            )}
            {current && current.kind !== "proposal" && (
              <DraftPanel
                key={current.id}
                draft={current}
                pool={poolOf(current)}
                position={positionOf(current)}
                actions={actions}
                canCommit={canCommit}
                canWithdraw={canWithdraw}
                outcome={outcomeOf(current)}
                onOutcome={(o) => setOutcome(current.id, o)}
                onChainStep={(s) => setChain((all) => ({ ...all, [current.id]: s }))}
                onDecline={() => decline(current)}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

// ---- the page ----

// The chat search's words: Mynt looks through the user's Earn chats (titles and what was said).
const searchEarnChats = async (query: string): Promise<ThreadMatch[] | null> => {
  const list = await listChats("earn", { query })
  return list && list.map((t) => ({ thread: t, snippet: t.snippet ?? null }))
}

// The chat's slash commands, and the roles they're shown to (the menu hides the others).
export const earnRoles = (a: LiquidityAccess): string[] => [...(a.builder ? ["builder"] : []), ...(a.liquidityProvider ? ["liquidity-provider"] : [])]
export function earnCommands(go: { tab: (t: EarnTab, view?: PoolsView) => void; history?: () => void; newChat: () => void }): SlashCommand[] {
  return [
    { name: "pools", description: "Open the Pools tab", run: () => go.tab("pools") },
    { name: "invested", description: "Show the pools you're invested in", run: () => go.tab("pools", "invested"), roles: ["liquidity-provider"] },
    { name: "my-pools", description: "Open My pools", run: () => go.tab("my-pools"), roles: ["builder"] },
    { name: "strategies", description: "Open My strategies", run: () => go.tab("my-strategies") },
    ...(go.history ? [{ name: "history", description: "Open Past conversations", run: go.history }] : []),
    { name: "new", description: "Start a new conversation", run: go.newChat },
    { name: "commit", description: "Draft a commitment to a pool", template: "Commit $ to ", roles: ["liquidity-provider"] },
    { name: "withdraw", description: "Draft a withdrawal from a pool", template: "Withdraw $ from ", roles: ["liquidity-provider"] },
    { name: "propose", description: "Draft a pool proposal", template: "Draft a pool proposal for ", roles: ["builder"] },
  ]
}

export function EarnWorkspace({
  chat,
  status,
  data,
  actions,
  initialTab,
  isMobile,
  wallet,
  historyOwner = null,
  initialThread = null,
}: {
  wallet?: EarnWalletState
  chat: Chat
  status: EarnStatus
  data: LiquidityData
  actions: LiquidityActions
  initialTab?: string | null
  isMobile?: boolean
  historyOwner?: string | null // the key an older studio kept this user's chats under in this browser (a hash): only for moving those to Mynt
  initialThread?: string | null // ?thread=: a chat picked in the sidebar's Search chats, opened once known
}) {
  const available = tabsFor(data.access)
  const wanted = earnTabFromQuery(initialTab)
  const [tab, setTab] = useState<EarnTab>(available.includes(wanted) ? wanted : "pools")
  const [opened, setOpened] = useState(tabOpensPanel(initialTab) && available.includes(wanted))
  const [poolsView, setPoolsView] = useState(() => poolsViewFromQuery(initialTab))
  // A command picking Pools' view shows Pools afresh on it.
  const [poolsKey, setPoolsKey] = useState(0)
  const [historyOpen, setHistoryOpen] = useState(false)
  const { poolIds, drafts } = panelFrom(chat.messages as never)

  // What became of each draft, kept here (not in the tab) so a thread keeps it too.
  const [outcomes, setOutcomes] = useState<Record<string, DraftOutcome>>({})

  // A new draft brings its tab forward, so the user sees what to confirm.
  const [seenDrafts, setSeenDrafts] = useState(drafts.length)
  if (drafts.length !== seenDrafts) {
    setSeenDrafts(drafts.length)
    if (drafts.length > seenDrafts && available.includes("my-strategies")) setTab("my-strategies")
  }

  // Past conversations: this thread is kept on Mynt for the signed-in user (lib/chat-sessions.ts; Mynt
  // knows who from the session, so nothing here waits on a key of the user's) from its first question,
  // again whenever a reply settles and whenever a draft's outcome changes (its key before it's sent,
  // then sent or declined). A save that fails is tried again; the open chat is never lost for it. One
  // picked from the list is read back and replaces the chat's messages, so the user carries on where
  // they left it.
  const [threadId, setThreadId] = useState(newThreadId)
  const [threads, setThreads] = useState<EarnThreadRecord[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const reloadThreads = useCallback(async () => {
    const list = await listChats("earn")
    if (list) setThreads(list)
  }, [])
  const currentId = useRef(threadId)
  currentId.current = threadId
  const saver = useMemo(
    () => new ChatSaver("earn", { onSaved: () => void reloadThreads(), onRefused: (id) => id === currentId.current && setNotice(SAVE_REFUSED) }),
    [reloadThreads],
  )
  useEffect(() => () => saver.dispose(), [saver])
  // The user's chats, read once on load.
  useEffect(() => {
    void reloadThreads()
  }, [reloadThreads])
  // Chats an older studio kept in this browser (under the user's hashed key, once known) go to Mynt, then the list is read again.
  useEffect(() => {
    if (!historyOwner) return
    let live = true
    void migrateLocalChats("earn", historyOwner).then((moved) => {
      if (live && moved) void reloadThreads()
    })
    return () => {
      live = false
    }
  }, [historyOwner, reloadThreads])
  const busy = chat.status === "streaming" || chat.status === "submitted"
  const savedFirst = useRef("")
  useEffect(() => {
    if (!chat.messages.length) return
    const first = savedFirst.current !== threadId
    // While a reply streams, only the first question is saved (at once); the reply once it settles.
    if (busy && !first) return
    savedFirst.current = threadId
    const messages = busy ? chat.messages.filter((m, i, all) => !(i === all.length - 1 && m.role === "assistant")) : chat.messages
    saver.save(threadId, { messages, outcomes: savedOutcomes(outcomes) }, { now: first })
  }, [busy, chat.messages, outcomes, threadId, saver])
  const switchTo = (id: string, messages: UIMessage[], kept: Record<string, SavedOutcome>) => {
    if (busy) void chat.stop()
    setNotice(null)
    savedFirst.current = messages.length ? id : ""
    chat.setMessages(messages)
    setThreadId(id)
    setOutcomes(restoredOutcomes(kept))
    setSeenDrafts(panelFrom(messages as never).drafts.length)
  }
  // Opens a chat picked from Past conversations or a link: read back from Mynt, even the one already
  // open (so it shows what was last saved). One that can't be read says so in the chat.
  const openThread = async (link: string) => {
    const id = sessionIdFor(link)
    const t = await loadChat(id)
    if (!t) {
      setNotice(OPEN_FAILED)
      return
    }
    // The open chat with a reply still coming, or something not yet saved, stays as it is: reopening it
    // doesn't throw that away.
    if (t.id === threadId && (busy || saver.isPending(t.id))) {
      setNotice(null)
      return
    }
    saver.adopt(t.id, t)
    switchTo(t.id, t.messages, savedOutcomesFrom(t.outcomes))
  }
  // A chat picked from the sidebar's Search chats arrives as ?thread=; it's opened once.
  const openedInitial = useRef(false)
  useEffect(() => {
    if (openedInitial.current || !initialThread) return
    openedInitial.current = true
    void openThread(initialThread)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialThread])
  const history: EarnHistory = {
    threads,
    current: threadId,
    onPick: (id) => void openThread(id),
    onNew: () => switchTo(newThreadId(), [], {}),
    search: searchEarnChats,
  }

  const choose = (id: string) => {
    const t = id as EarnTab
    setTab(t)
    if (typeof window !== "undefined") window.history.replaceState(window.history.state, "", `/earn?tab=${t}`)
  }
  const commands = earnCommands({
    tab: (t, view) => {
      if (view) {
        setPoolsView(view)
        setPoolsKey((k) => k + 1)
      }
      choose(t)
      setOpened(true)
    },
    history: status === "enabled" ? () => setHistoryOpen(true) : undefined,
    newChat: () => switchTo(newThreadId(), [], {}),
  })

  if (!available.length)
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground" data-empty="no-role">
        Earn is for builders of products with pools and for liquidity providers. Ask a Mynt admin if you should have one of those roles.
      </div>
    )

  const content = (t: EarnTab) =>
    t === "pools" ? (
      <PoolsTab key={poolsKey} data={data} poolIds={poolIds} actions={actions} initialView={poolsView} />
    ) : t === "my-strategies" ? (
      <StrategiesTab data={data} drafts={drafts} actions={actions} outcomes={outcomes} onOutcome={(id, o) => setOutcomes((all) => ({ ...all, [id]: o }))} />
    ) : (
      <EarnTable tab="my-pools" data={data} actions={actions} />
    )

  const shell = (
    <ChatWorkspaceShell
      chat={<EarnChat chat={chat} status={status} commands={commands} roles={earnRoles(data.access)} notice={notice} onDismissNotice={() => setNotice(null)} />}
      chatCorner={status === "enabled" ? <PastConversations history={history} open={historyOpen} onOpenChange={setHistoryOpen} /> : null}
      onOpenPanel={() => setOpened(true)}
      showPanel={opened || chat.messages.length > 0}
      tabs={available.map((t) => ({ id: t, label: TAB_LABELS[t], badge: t === "my-strategies" ? drafts.length : undefined, content: content(t), icon: TAB_ICONS[t] }))}
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
