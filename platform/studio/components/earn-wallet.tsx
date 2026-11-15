"use client"

// Earn's wallet: the picker in the chat bar (the user's verified linked wallets, each with its short
// address, network and live devnet USDC and SOL balances, and Link wallet), the one-line
// disclaimer under the composer, and the on-chain deposit and withdrawal on a draft's card. The
// on-chain flow runs only from the user's own clicks: Prepare asks Mynt for an unsigned devnet
// transaction and its summary; the summary shown is Mynt's, never the assistant's; Sign asks the
// user's own browser wallet (which must be the chosen linked wallet) to sign and send it, untouched;
// then the page follows its status until it's confirmed and reads the positions again. Mynt never
// signs and never holds funds or keys. Devnet only: mainnet is never offered.
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react"
import { Check, ChevronDown, Info, Link2, Loader2, Wallet } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { devnetWallets, signAndSend, type BrowserWallet } from "@/lib/browser-wallet"
import { shortAddress } from "@/lib/linked-accounts"
import { usd } from "@/lib/liquidity"
import { balancesText, durationText, explorerTxUrl, type EarnWallet, type EarnWallets, type Prepared, type TxStatus } from "@/lib/wallets"

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

export type PrepareInput = { kind: "deposit" | "withdrawal"; pool_id: string; wallet: string; amount_cents: number; idempotency_key: string }
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
  onSettled(): void // read positions again
  pollMs?: number
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
        <DropdownMenuLabel className="text-xs text-muted-foreground">Your linked wallets · balances on devnet</DropdownMenuLabel>
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
  | { kind: "review"; prepared: Prepared }
  | { kind: "signing"; prepared: Prepared; wallet: string }
  | { kind: "sent"; signature: string }
  | { kind: "confirmed"; signature: string }
  | { kind: "failed"; signature: string; error: string }
  | { kind: "error"; message: string }

const expired = (p: Prepared, now = Date.now()) => Boolean(p.expiresAt && Number.isFinite(Date.parse(p.expiresAt)) && Date.parse(p.expiresAt) <= now)

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

// On a draft for a pool with an on-chain treasury: "Deposit from <wallet> · devnet" (or "Withdraw
// to …"), then Mynt's summary to confirm, then the user's wallet. `blocked` is why it can't start.
export function OnChainAction({ kind, poolId, amountCents, wallet, blocked, newKey }: { kind: "deposit" | "withdrawal"; poolId: string; amountCents: number; wallet: string | null; blocked: string | null; newKey: () => string }) {
  const { list, chosen, treasury, browserWallets, onSettled, pollMs = 2000 } = useEarnWallet()
  const [flow, setFlow] = useState<Flow>({ kind: "idle" })
  const [key, setKey] = useState(newKey)
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
  const reason = !list
    ? "Checking your wallets…"
    : !supported
      ? "On-chain deposits coming soon."
      : !address
        ? "Choose one of your linked Solana wallets in the chat bar first."
        : notLinked
          ? `${shortAddress(address)} isn't one of your linked wallets any more. Choose another in the chat bar.`
          : blocked
  const label = kind === "deposit" ? `Deposit from ${address ? shortAddress(address) : "your wallet"} · devnet` : `Withdraw to ${address ? shortAddress(address) : "your wallet"} · devnet`

  const prepare = async () => {
    if (reason || !address || flow.kind === "preparing") return
    setFlow({ kind: "preparing" })
    const r = await treasury.prepare({ kind, pool_id: poolId, wallet: address, amount_cents: amountCents, idempotency_key: key })
    if (!live.current) return
    setKey(newKey())
    setFlow("error" in r ? { kind: "error", message: r.error } : { kind: "review", prepared: r.prepared })
  }

  const follow = async (signature: string) => {
    for (let i = 0; i < 60 && live.current; i++) {
      const s = await treasury.status(signature)
      if (!live.current) return
      if ("status" in s && s.status === "confirmed") {
        setFlow({ kind: "confirmed", signature })
        return onSettled()
      }
      if ("status" in s && s.status === "failed") return setFlow({ kind: "failed", signature, error: s.error ?? "The transaction failed on devnet." })
      await new Promise((r) => setTimeout(r, pollMs))
    }
    // Still not confirmed after about two minutes: positions are read again in case it settled.
    if (live.current) onSettled()
  }

  const sign = async (w: BrowserWallet) => {
    if (flow.kind !== "review" || !address) return
    const prepared = flow.prepared
    if (prepared.summary.wallet !== address) return setFlow({ kind: "error", message: "Mynt's summary names a different wallet. Nothing was signed." })
    if (expired(prepared)) return setFlow({ kind: "error", message: "This transaction expired before it was signed. Prepare it again." })
    setFlow({ kind: "signing", prepared, wallet: w.name })
    const r = await signAndSend(w, address, prepared.transactionBase64)
    if (!live.current) return
    if ("error" in r) return setFlow({ kind: "error", message: r.error })
    setFlow({ kind: "sent", signature: r.signature })
    void follow(r.signature)
  }

  const installed = flow.kind === "review" ? browserWallets() : []

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

      {(flow.kind === "review" || flow.kind === "signing") && (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm" data-prepared>
          <div className="flex items-center gap-2 font-medium">
            Mynt&apos;s summary <DevnetBadge />
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Pool</dt>
            <dd data-summary-pool>{flow.prepared.summary.pool}</dd>
            <dt className="text-muted-foreground">Amount</dt>
            <dd className="tabular-nums" data-summary-amount>
              {flow.prepared.summary.amount}
              <span className="text-muted-foreground"> (drafted {usd(amountCents)})</span>
            </dd>
            <dt className="text-muted-foreground">{kind === "deposit" ? "From" : "To"}</dt>
            <dd className="font-mono text-xs" data-summary-wallet>
              {flow.prepared.summary.wallet}
            </dd>
            <dt className="text-muted-foreground">Lock-in</dt>
            <dd>{durationText(flow.prepared.summary.lockInSeconds)}</dd>
            <dt className="text-muted-foreground">Notice period</dt>
            <dd>{durationText(flow.prepared.summary.noticeSeconds)}</dd>
            {flow.prepared.expiresAt && (
              <>
                <dt className="text-muted-foreground">Sign before</dt>
                <dd>{new Date(flow.prepared.expiresAt).toLocaleString()}</dd>
              </>
            )}
          </dl>
          <p className="text-muted-foreground">Your wallet shows the transaction again before you approve it. Mynt never signs it and never holds the money.</p>
          {flow.kind === "signing" ? (
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
            <Loader2 className="size-4 animate-spin" /> Sent on devnet. Waiting for it to be confirmed…
          </span>
          <Signature signature={flow.signature} />
        </p>
      )}
      {flow.kind === "confirmed" && (
        <p role="status" className="flex flex-col gap-1 text-sm" data-tx="confirmed">
          <span>Confirmed on devnet. Your positions are being read again.</span>
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

