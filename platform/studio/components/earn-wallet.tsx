"use client"

// Earn's wallet: the picker in the chat bar (the user's verified linked wallets, each with its short
// address, network and live devnet USDC and SOL balances, and Link wallet), the one-line
// disclaimer under the composer, and the on-chain deposit and withdrawal on a draft. The
// on-chain flow runs only from the user's own clicks: Prepare asks Mynt for an unsigned devnet
// transaction and its summary; the summary shown is Mynt's, never the assistant's; Sign asks the
// user's own browser wallet (which must be the chosen linked wallet) to sign and send it, untouched;
// then the page follows its status until it's confirmed and reads the positions again. Mynt never
// signs and never holds funds or keys. Devnet only: mainnet is never offered.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, ChevronLeft, Info, Link2, Loader2, Wallet } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { StatusDot } from "@/components/promotion-view"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { devnetWallets, signAndSend, type BrowserWallet } from "@/lib/browser-wallet"
import { shortAddress } from "@/lib/linked-accounts"
import { positionKey, type LiquidityData, type PoolRow, type Position } from "@/lib/liquidity"
import { newIdempotencyKey } from "@/lib/idempotency"
import {
  balancesText,
  BLOCKHASH_FRESH_MS,
  depositStanding,
  durationText,
  explorerTxUrl,
  parseUsdc,
  sameSummary,
  standingText,
  usdcText,
  type EarnWallet,
  type EarnWallets,
  type Prepared,
  type TxStatus,
} from "@/lib/wallets"

// ---- the disclaimer ----

export const EARN_DISCLOSURE = "Not investment advice · Mynt never holds your funds"
export const EARN_DISCLOSURE_DETAILS =
  "Money moves only on rails a pool's sponsoring licence provider approved, or, for a pool with an on-chain treasury, as USDC through that pool's treasury program on Solana devnet, signed in your own wallet. Mynt never holds your funds or keys and never signs for you. Real commitments wait until a Mynt admin clears a pool's offering; sandbox pools and devnet move test money only. Earn explains pool terms and matches them to what you ask: it isn't investment advice and shows no promised returns, only figures Mynt measures."

export function EarnDisclosure() {
  return (
    <span className="inline-flex items-center gap-1" data-earn-disclosure>
      {EARN_DISCLOSURE}
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none" aria-label="About Earn and your money" data-earn-disclosure-info>
            <Info className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm text-left" data-earn-disclosure-details>
          {EARN_DISCLOSURE_DETAILS}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

export function DevnetBadge() {
  return (
    <Badge variant="outline" className="border-sky-500/60" data-devnet>
      Devnet
    </Badge>
  )
}

// ---- what the page gives the wallet parts ----

export type PrepareInput = { kind: "deposit" | "withdrawal"; pool_id: string; wallet: string; amount_usdc_base_units: number; deposit?: string; idempotency_key: string }
export type TreasuryActions = {
  prepare(input: PrepareInput): Promise<{ prepared: Prepared } | { error: string }>
  status(signature: string): Promise<TxStatus | { error: string }>
}
export type EarnWalletState = {
  list: EarnWallets | null // null while loading
  chosen: EarnWallet | null
  choose(address: string): void
  treasury: TreasuryActions
  browserWallets: () => BrowserWallet[]
  // Read positions again; the page's answer lets a confirmed transaction wait until Mynt shows it.
  onSettled(): void | Promise<LiquidityData | null>
  pollMs?: number
  // After "confirmed", Mynt indexes the pool in the background: positions are read again after
  // these waits (2s, then 5s, then 10s from confirming) until the deposit or request shows.
  settleDelaysMs?: number[]
}
const NO_STATE: EarnWalletState = {
  list: null,
  chosen: null,
  choose: () => undefined,
  treasury: { prepare: async () => ({ error: "On-chain deposits coming soon." }), status: async () => ({ error: "unsupported" }) },
  browserWallets: () => devnetWallets(),
  onSettled: () => undefined,
}
const WalletContext = createContext<EarnWalletState>(NO_STATE)
export const EarnWalletProvider = ({ value, children }: { value: EarnWalletState; children: ReactNode }) => <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
export const useEarnWallet = () => useContext(WalletContext)

// ---- the picker ----

function WalletRow({ w }: { w: EarnWallet }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-1.5">
        <span className="font-mono text-xs">{shortAddress(w.address)}</span>
        <span className="text-xs text-muted-foreground">{w.network}</span>
      </span>
      {w.chain === "solana" && (
        <span className="text-xs text-muted-foreground tabular-nums" data-wallet-balances>
          {balancesText(w.balances)}
          {w.balances ? " · devnet" : ""}
        </span>
      )}
    </span>
  )
}

export function WalletPicker() {
  const { list, chosen, choose } = useEarnWallet()
  if (!list) return <span className="h-8" data-wallet-picker="loading" />
  if (!list.supported)
    return (
      <Button type="button" size="sm" variant="ghost" className="h-8 text-muted-foreground" disabled title="Linking wallets comes with Mynt's next update" data-wallet-picker="unsupported">
        <Wallet />
        No wallets yet
      </Button>
    )
  if (!list.wallets.length) {
    if (!list.manageUrl)
      return (
        <Button type="button" size="sm" variant="ghost" className="h-8" disabled data-wallet-picker="none">
          <Wallet />
          Link wallet
        </Button>
      )
    return (
      <Button type="button" size="sm" variant="ghost" className="h-8" asChild data-wallet-picker="none">
        <a href={list.manageUrl} rel="noreferrer">
          <Link2 />
          Link wallet
        </a>
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5" aria-label={chosen ? `Wallet ${chosen.address}` : "Choose a wallet"} data-wallet-picker="wallets">
          <Wallet />
          <span className="font-mono text-xs">{chosen ? shortAddress(chosen.address) : "Choose wallet"}</span>
          {chosen?.chain === "solana" && <span className="text-xs text-muted-foreground">Devnet</span>}
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72" data-wallet-picker-menu>
        {list.wallets.map((w) => (
          <DropdownMenuItem key={w.address} onSelect={() => choose(w.address)} data-wallet-option={w.address} aria-checked={chosen?.address === w.address} role="menuitemradio">
            <WalletRow w={w} />
            {chosen?.address === w.address && <Check className="ml-auto" />}
          </DropdownMenuItem>
        ))}
        {!list.balancesSupported && <p className="px-2 py-1 text-xs text-muted-foreground">Live balances come with Mynt&apos;s next update.</p>}
        <DropdownMenuSeparator />
        {list.manageUrl ? (
          <DropdownMenuItem asChild data-wallet-link>
            <a href={list.manageUrl} rel="noreferrer">
              <Link2 />
              Link wallet
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled data-wallet-link>
            <Link2 />
            Link wallet
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ---- the on-chain deposit and withdrawal ----

type Flow =
  | { kind: "idle" }
  | { kind: "preparing" }
  | { kind: "review"; prepared: Prepared; at: number; changed?: boolean }
  | { kind: "refreshing"; prepared: Prepared }
  | { kind: "signing"; prepared: Prepared; wallet: string }
  | { kind: "sent"; signature: string; stage: string | null }
  | { kind: "confirmed"; signature: string; updating: "yes" | "done" | "late" }
  | { kind: "failed"; signature: string; error: string }
  | { kind: "error"; message: string }

const expired = (p: Prepared, now: number) => Boolean(p.expiresAt && Number.isFinite(Date.parse(p.expiresAt)) && Date.parse(p.expiresAt) <= now)

function Signature({ signature }: { signature: string }) {
  const href = explorerTxUrl(signature)
  return (
    <span className="font-mono text-xs break-all" data-signature={signature}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="text-(--link) underline">
          {signature}
        </a>
      ) : (
        signature
      )}
    </span>
  )
}

export function UnverifiedBuildBadge() {
  return (
    <StatusDot tone="amber" label="Unverified build" title="Mynt hasn't rebuilt this treasury program from its template at this address, so its code isn't verified. Devnet accepts it; test money only." data-unverified-build />
  )
}

// On a draft for a pool with an on-chain treasury, or a deposit's Withdraw: "Deposit from
// <wallet> · devnet" (or "Withdraw to …"), then Mynt's summary to confirm, then the user's wallet.
// A prepared transaction's blockhash lasts about a minute: one older than BLOCKHASH_FRESH_MS when
// the user clicks Sign is prepared again first ("Refreshing…"), and signed only if Mynt's summary
// is unchanged; otherwise the new summary is shown to confirm again. `blocked` is why it can't
// start; `amountText` is the amount as the user or the draft gave it.
export function OnChainAction({
  kind,
  poolId,
  amountBaseUnits,
  amountText,
  deposit,
  wallet,
  blocked,
  newKey,
  now = Date.now,
}: {
  kind: "deposit" | "withdrawal"
  poolId: string
  amountBaseUnits: bigint
  amountText?: string
  deposit?: string | null
  wallet: string | null
  blocked: string | null
  newKey: () => string
  now?: () => number
}) {
  const { list, chosen, treasury, browserWallets, onSettled, pollMs = 2000, settleDelaysMs = SETTLE_DELAYS_MS } = useEarnWallet()
  const [flow, setFlow] = useState<Flow>({ kind: "idle" })
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  const address = wallet ?? (chosen?.chain === "solana" ? chosen.address : null)
  const supported = kind === "deposit" ? list?.treasury.deposit : list?.treasury.withdraw
  const notLinked = address && list && !list.wallets.some((w) => w.address === address && w.chain === "solana")
  const tooBig = amountBaseUnits > BigInt(Number.MAX_SAFE_INTEGER)
  const reason = !list
    ? "Checking your wallets…"
    : !supported
      ? kind === "deposit" ? "On-chain deposits coming soon." : "On-chain withdrawals coming soon."
      : !address
        ? "Choose one of your linked Solana wallets in the chat bar first."
        : notLinked
          ? `${shortAddress(address)} isn't one of your linked wallets. Choose it in the chat bar after linking it, or use a deposit of a wallet you've linked.`
          : kind === "withdrawal" && !deposit
            ? "Mynt didn't name the deposit to withdraw from."
            : tooBig
              ? "That amount is too large."
              : blocked
  const label = kind === "deposit" ? `Deposit from ${address ? shortAddress(address) : "your wallet"} · devnet` : `Withdraw to ${address ? shortAddress(address) : "your wallet"} · devnet`

  const ask = () =>
    treasury.prepare({ kind, pool_id: poolId, wallet: address!, amount_usdc_base_units: Number(amountBaseUnits), ...(kind === "withdrawal" && deposit ? { deposit } : {}), idempotency_key: newKey() })

  const prepare = async () => {
    if (reason || !address || flow.kind === "preparing") return
    setFlow({ kind: "preparing" })
    const r = await ask()
    if (!live.current) return
    setFlow("error" in r ? { kind: "error", message: r.error } : { kind: "review", prepared: r.prepared, at: now() })
  }

  // Confirmed on chain; Mynt indexes it in the background, so positions are read again a few
  // times until a deposit or request with this signature shows ("Updating positions…").
  const settle = async (signature: string) => {
    setFlow({ kind: "confirmed", signature, updating: "yes" })
    let waited = 0
    for (const at of settleDelaysMs) {
      await new Promise((r) => setTimeout(r, Math.max(0, at - waited)))
      waited = at
      if (!live.current) return
      const data = await onSettled()
      if (!live.current) return
      if (data && showsTransaction(data, signature)) return setFlow({ kind: "confirmed", signature, updating: "done" })
    }
    setFlow({ kind: "confirmed", signature, updating: "late" })
  }

  const follow = async (signature: string) => {
    for (let i = 0; i < 60 && live.current; i++) {
      const s = await treasury.status(signature)
      if (!live.current) return
      if ("status" in s && s.status === "confirmed") return void (await settle(signature))
      if ("status" in s && s.status === "failed") return setFlow({ kind: "failed", signature, error: s.error ?? "The transaction failed on devnet." })
      if ("status" in s) setFlow({ kind: "sent", signature, stage: s.stage })
      await new Promise((r) => setTimeout(r, pollMs))
    }
    // Still not confirmed after about two minutes: positions are read again in case it settled.
    if (live.current) onSettled()
  }

  const sign = async (w: BrowserWallet) => {
    if (flow.kind !== "review" || !address) return
    let prepared = flow.prepared
    if (prepared.summary.wallet !== address) return setFlow({ kind: "error", message: "Mynt's summary names a different wallet. Nothing was signed." })
    // A blockhash lasts about a minute: an older transaction is prepared again before signing.
    if (now() - flow.at > BLOCKHASH_FRESH_MS || expired(prepared, now())) {
      setFlow({ kind: "refreshing", prepared })
      const r = await ask()
      if (!live.current) return
      if ("error" in r) return setFlow({ kind: "error", message: r.error })
      if (r.prepared.summary.wallet !== address) return setFlow({ kind: "error", message: "Mynt's summary names a different wallet. Nothing was signed." })
      if (!sameSummary(prepared.summary, r.prepared.summary)) return setFlow({ kind: "review", prepared: r.prepared, at: now(), changed: true })
      prepared = r.prepared
    }
    setFlow({ kind: "signing", prepared, wallet: w.name })
    const r = await signAndSend(w, address, prepared.transactionBase64)
    if (!live.current) return
    if ("error" in r) return setFlow({ kind: "error", message: r.error })
    setFlow({ kind: "sent", signature: r.signature, stage: null })
    void follow(r.signature)
  }

  const installed = flow.kind === "review" ? browserWallets() : []
  const shown = flow.kind === "review" || flow.kind === "refreshing" || flow.kind === "signing" ? flow.prepared : null

  return (
    <div className="flex w-full flex-col gap-2" data-on-chain={kind}>
      {flow.kind === "idle" || flow.kind === "preparing" || flow.kind === "error" ? (
        <>
          {reason && (
            <p className="text-sm text-amber-600 dark:text-amber-300" data-refusal>
              {reason}
            </p>
          )}
          {flow.kind === "error" && (
            <p role="alert" className="text-sm text-destructive" data-on-chain-error>
              {flow.message}
            </p>
          )}
          <div>
            <Button onClick={() => void prepare()} disabled={Boolean(reason) || flow.kind === "preparing"} data-prepare={kind}>
              {flow.kind === "preparing" && <Loader2 className="animate-spin" />}
              {label}
            </Button>
          </div>
        </>
      ) : null}

      {shown && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-prepared>
          <div className="flex flex-wrap items-center gap-2 font-medium">
            Mynt&apos;s summary <DevnetBadge />
            {shown.summary.verifiedBuild === false && <UnverifiedBuildBadge />}
          </div>
          {flow.kind === "review" && flow.changed && (
            <p className="text-amber-600 dark:text-amber-300" data-terms-changed>
              Mynt prepared it again and something changed. Check the summary before you sign.
            </p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Pool</dt>
            <dd data-summary-pool>{shown.summary.pool}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="tabular-nums" data-summary-amount>
              {shown.summary.amount}
              {amountText && <span className="text-muted-foreground"> (asked {amountText})</span>}
            </dd>
            <dt className="text-muted-foreground">{kind === "deposit" ? "From" : "To"}</dt>
            <dd className="font-mono text-xs" data-summary-wallet>
              {shown.summary.wallet}
            </dd>
            <dt className="text-muted-foreground">Lock-in</dt>
            <dd>{durationText(shown.summary.lockInSeconds)}</dd>
            <dt className="text-muted-foreground">Notice period</dt>
            <dd>{durationText(shown.summary.noticeSeconds)}</dd>
            {shown.summary.reviewWindowSeconds !== null && (
              <>
                <dt className="text-muted-foreground">Review window</dt>
                <dd>{durationText(shown.summary.reviewWindowSeconds)}</dd>
              </>
            )}
          </dl>
          <p className="text-muted-foreground">Your wallet shows the transaction again before you approve it. Mynt never signs it and never holds the money.</p>
          {flow.kind === "refreshing" ? (
            <p role="status" className="flex items-center gap-2" data-refreshing>
              <Loader2 className="size-4 animate-spin" /> Refreshing…
            </p>
          ) : flow.kind === "signing" ? (
            <p role="status" className="flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" /> Waiting for {flow.wallet}…
            </p>
          ) : installed.length ? (
            <div className="flex flex-wrap gap-2">
              {installed.map((w) => (
                <Button key={w.name} onClick={() => void sign(w)} data-sign-with={w.name}>
                  {w.icon?.startsWith("data:image/") && <img src={w.icon} alt="" className="size-4" />}
                  Sign in {w.name}
                </Button>
              ))}
              <Button variant="outline" onClick={() => setFlow({ kind: "idle" })}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-amber-600 dark:text-amber-300" data-no-browser-wallet>
                No Solana wallet that can sign on devnet was found in this browser. Install or unlock one, then prepare again.
              </p>
              <div>
                <Button variant="outline" onClick={() => setFlow({ kind: "idle" })}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {flow.kind === "sent" && (
        <p role="status" className="flex flex-col gap-1 text-sm" data-tx="pending">
          <span className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin" /> {flow.stage === "processed" ? "Processed on devnet. Waiting for it to be confirmed…" : "Sent on devnet. Waiting for it to be confirmed…"}
          </span>
          <Signature signature={flow.signature} />
        </p>
      )}
      {flow.kind === "confirmed" && (
        <p role="status" className="flex flex-col gap-1 text-sm" data-tx="confirmed">
          <span>Confirmed on devnet.</span>
          {flow.updating === "yes" ? (
            <span className="flex items-center gap-2 text-muted-foreground" data-updating-positions>
              <Loader2 className="size-4 animate-spin" /> Updating positions…
            </span>
          ) : flow.updating === "done" ? (
            <span className="text-muted-foreground" data-positions-updated>
              Your positions show it.
            </span>
          ) : (
            <span className="text-muted-foreground" data-positions-late>
              Mynt is still catching up: it&apos;ll show on your pool&apos;s card in Pools shortly.
            </span>
          )}
          <Signature signature={flow.signature} />
        </p>
      )}
      {flow.kind === "failed" && (
        <p role="alert" className="flex flex-col gap-1 text-sm text-destructive" data-tx="failed">
          <span>{flow.error}</span>
          <Signature signature={flow.signature} />
        </p>
      )}
    </div>
  )
}

export const SETTLE_DELAYS_MS = [2_000, 5_000, 10_000]

// Whether positions show a deposit or withdrawal request made by this transaction.
export const showsTransaction = (data: LiquidityData, signature: string) =>
  (data.provider?.positions ?? []).some((p) => p.chain?.deposits.some((d) => d.signature === signature) || p.chain?.requests.some((r) => r.signature === signature))

export function DepositsPausedBadge({ reason }: { reason: string }) {
  return (
    <StatusDot tone="amber" label="Deposits paused: approvers changed" title={reason} data-attesters-flag />
  )
}

// ---- on-chain positions (a pool card's Withdraw and Details, on Pools) ----

// A wallet's totals in USDC: held, queued and available, laid out like the dashboard's key figures.
function WalletFigures({ held, queued, available }: { held: bigint; queued: bigint; available: bigint }) {
  const figures: [string, string, bigint][] = [
    ["held", "Held", held],
    ["queued", "Queued", queued],
    ["available", "Available", available],
  ]
  return (
    <dl className="grid grid-cols-3 divide-x" data-wallet-figures>
      {figures.map(([key, label, value]) => (
        <div key={key} className="flex min-w-0 flex-col gap-1 px-4 first:pl-0" data-figure={key}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="text-lg font-semibold tabular-nums">{usdcText(value)}</dd>
        </div>
      ))}
    </dl>
  )
}

export type OpenDeposit = { poolId: string; poolName: string; wallet: string; deposit: string; seq: string | null; free: bigint; noticeSeconds: number | null; minRequest: bigint | null }

// One wallet's position in an on-chain pool, in a sheet opened from its pool card's Withdraw on
// Pools: its totals, then deposit by deposit (amount, what's left, when it unlocks, whether it's in
// review, locked or available, and what's queued), then its withdrawal requests. Withdraw on a
// deposit turns the sheet into that deposit's withdrawal, with Back to return to the deposits.
export function OnChainPositionSheet({ position: p, pools, onClose }: { position: Position | null; pools: PoolRow[]; onClose: () => void }) {
  const [open, setOpen] = useState<OpenDeposit | null>(null)
  const c = p?.chain ?? null
  const close = () => {
    setOpen(null)
    onClose()
  }
  return (
    <Sheet open={Boolean(p && c)} onOpenChange={(o) => !o && close()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl" aria-describedby={undefined} data-sheet={open ? "on-chain-withdraw" : "on-chain-deposits"}>
        <SheetHeader>
          <SheetTitle>{open ? `Withdraw from ${open.poolName}` : p ? p.name : "Deposits"}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4">{p && c ? <OnChainHolding position={p} pools={pools} open={open} onOpen={setOpen} /> : null}</div>
      </SheetContent>
    </Sheet>
  )
}

// One wallet's on-chain position, as the deposits sheet and a pool card's Details show it: the
// wallet's totals, its deposits (each with Withdraw) and its requests; with a deposit opened, that
// deposit's withdrawal and Back to deposits.
export function OnChainHolding({ position: p, pools, open, onOpen: setOpen }: { position: Position; pools: PoolRow[]; open: OpenDeposit | null; onOpen: (d: OpenDeposit | null) => void }) {
  const c = p.chain
  const pool = pools.find((x) => x.id === p.poolId) ?? null
  if (!c) return null
  if (open)
    return (
      <>
        <div>
          <Button variant="outline" size="sm" onClick={() => setOpen(null)} data-back-to-deposits>
            <ChevronLeft />
            Back to deposits
          </Button>
        </div>
        <WithdrawDeposit key={`${open.wallet}|${open.deposit}`} {...open} />
      </>
    )
  return (
            <div className="flex flex-col gap-3" data-on-chain-positions data-on-chain-position={positionKey(p)}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground" title={c.wallet}>
                  {shortAddress(c.wallet)}
                </span>
                <DevnetBadge />
                {pool?.treasury?.verifiedBuild === false && <UnverifiedBuildBadge />}
                {pool?.treasury?.attestersFlag && <DepositsPausedBadge reason={pool.treasury.attestersFlag} />}
              </div>
              <WalletFigures held={c.principal} queued={c.queued} available={c.availableToRequest} />
              <div className="overflow-auto rounded-lg border">
                <Table>
                  <TableHeader className="bg-card">
                    <TableRow>
                      <TableHead>Deposit</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Remaining</TableHead>
                      <TableHead className="text-right">Queued</TableHead>
                      <TableHead>Unlocks</TableHead>
                      <TableHead>Standing</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {c.deposits.length ? (
                      c.deposits.map((d) => {
                        const s = depositStanding(d)
                        return (
                          <TableRow key={d.deposit} data-deposit={d.deposit} data-standing={s.kind}>
                            <TableCell className="font-mono text-xs" title={d.deposit}>
                              {d.seq !== null ? `#${d.seq} · ` : ""}
                              {shortAddress(d.deposit)}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">{usdcText(d.amount)}</TableCell>
                            <TableCell className="text-right tabular-nums">{usdcText(d.remaining)}</TableCell>
                            <TableCell className="text-right tabular-nums">{usdcText(d.queued)}</TableCell>
                            <TableCell>{d.unlocksAt ? d.unlocksAt.slice(0, 10) : "—"}</TableCell>
                            <TableCell>{standingText(s)}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={s.kind !== "available"}
                                title={s.kind !== "available" ? standingText(s) : undefined}
                                onClick={() => setOpen({ poolId: p.poolId, poolName: p.name, wallet: c.wallet, deposit: d.deposit, seq: d.seq, free: s.free, noticeSeconds: pool?.treasury?.noticeSeconds ?? null, minRequest: pool?.treasury?.minRequest ?? null })}
                                data-withdraw-deposit={d.deposit}
                              >
                                Withdraw
                              </Button>
                            </TableCell>
                          </TableRow>
                        )
                      })
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="py-4 text-center text-muted-foreground">
                          No deposits from this wallet yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              {c.requests.length > 0 && (
                <div className="overflow-auto rounded-lg border" data-on-chain-requests>
                  <Table>
                    <TableHeader className="bg-card">
                      <TableRow>
                        <TableHead>Withdrawal request</TableHead>
                        <TableHead className="text-right">Asked</TableHead>
                        <TableHead className="text-right">Paid</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Payable from</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.requests.map((r) => (
                        <TableRow key={r.address} data-on-chain-request={r.address}>
                          <TableCell className="font-mono text-xs" title={r.address}>
                            {r.seq !== null ? `#${r.seq}` : shortAddress(r.address)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums" data-asked>
                            {usdcText(r.amount)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums" data-paid>
                            {usdcText(r.paid)}
                          </TableCell>
                          <TableCell className="capitalize" data-status>
                            {r.status}
                          </TableCell>
                          <TableCell>{r.payableAt ? r.payableAt.slice(0, 10) : "—"}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
  )
}

// One deposit's Withdraw: an amount in USDC (all that's available by default), then the on-chain flow.
function WithdrawDeposit({ poolId, wallet, deposit, seq, free, noticeSeconds, minRequest }: OpenDeposit) {
  const [text, setText] = useState(usdcText(free).replace(/ USDC$/, "").replace(/,/g, ""))
  const amount = parseUsdc(text)
  const blocked = amount === null ? "Enter an amount in USDC, like 25 or 12.5." : amount > free ? `This deposit has ${usdcText(free)} available.` : minRequest !== null && amount < minRequest ? `This pool's smallest withdrawal request is ${usdcText(minRequest)}.` : null
  return (
    <div className="flex flex-col gap-4" data-withdraw-form={deposit}>
      <p className="text-sm text-muted-foreground" data-consequence>
        Joins the pool&apos;s first-in, first-out queue and is paid to this wallet after the notice period ({durationText(noticeSeconds)}), only as far as the pool stays above its reserve.
      </p>
      <p className="text-sm">
        <span className="text-muted-foreground">Deposit </span>
        <span className="font-mono text-xs" title={deposit}>
          {seq !== null ? `#${seq} · ` : ""}
          {shortAddress(deposit)}
        </span>
      </p>
      <label className="flex max-w-xs flex-col gap-1 text-sm">
        Amount (USDC)
        <Input value={text} onChange={(e) => setText(e.target.value)} inputMode="decimal" aria-label="Amount in USDC" />
      </label>
      <OnChainAction kind="withdrawal" poolId={poolId} amountBaseUnits={amount ?? 0n} amountText={amount !== null ? usdcText(amount) : undefined} deposit={deposit} wallet={wallet} blocked={blocked} newKey={newIdempotencyKey} />
    </div>
  )
}
