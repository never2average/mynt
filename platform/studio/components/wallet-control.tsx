"use client"

// The header's wallet control, right beside New app. A linked wallet shows the wallet app's own
// icon and name when a wallet in this browser has connected it (as the Wallet Standard reports
// them), else a wallet icon and the short address only. Its menu names the network once, has the
// full address (and Copy), Connect wallet while the app isn't known, the liquidity links for the
// user's roles (Manage pools, Provide liquidity, to the Earn page's tabs) and Manage linked accounts
// (the identity provider's account page, in the same tab, never embedded). With no wallet it's
// Link wallet, to that same page. Given `linked`, `access` and `browserWallets` it renders from
// them (the tests); otherwise it reads them itself.
import Link from "next/link"
import { useState } from "react"
import { ArrowRight, Check, ChevronDown, Copy, ExternalLink, Wallet } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ConnectWalletItems, WalletAppIcon, WalletName } from "@/components/wallet-identity"
import { useBrowserWallets, walletAppFor, type BrowserWallet } from "@/lib/browser-wallet"
import { shortAddress, type LinkedAccounts } from "@/lib/linked-accounts"
import { walletLinksFor, type LiquidityAccess } from "@/lib/liquidity"
import { useLinkedAccounts } from "@/lib/use-linked-accounts"
import { useLiquidityAccess } from "@/lib/use-liquidity-access"

export const NOT_YET = "Linking accounts comes with Mynt's next update"

export function WalletControl({
  linked,
  access,
  browserWallets,
  compact = false,
}: {
  linked?: LinkedAccounts | null
  access?: LiquidityAccess | null
  /** The wallets detected in this browser; read from the Wallet Standard when not given. */
  browserWallets?: BrowserWallet[]
  /** The app's top bar: the short address only. */
  compact?: boolean
}) {
  const loadedLinked = useLinkedAccounts()
  const loadedAccess = useLiquidityAccess(access === undefined)
  const [detected, refresh] = useBrowserWallets()
  const accounts = linked === undefined ? loadedLinked : linked
  const links = walletLinksFor(access === undefined ? loadedAccess : access)
  const wallets = browserWallets ?? detected
  const [copied, setCopied] = useState(false)

  if (!accounts) return null // not known yet: nothing rather than a guess
  const size = compact ? "h-8" : undefined

  if (!accounts.wallet) {
    if (!accounts.manageUrl)
      return (
        <Button size="sm" variant="outline" className={size} disabled title={NOT_YET} data-wallet-control="none">
          <Wallet />
          Link wallet
        </Button>
      )
    return (
      <Button size="sm" variant="outline" className={size} asChild data-wallet-control="none">
        <a href={accounts.manageUrl} rel="noreferrer">
          <Wallet />
          Link wallet
        </a>
      </Button>
    )
  }

  const { address, network } = accounts.wallet
  const app = walletAppFor(address, wallets)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="outline" className={size} aria-label={`Wallet ${shortAddress(address)} on ${network}`} data-wallet-control="linked">
          <WalletAppIcon app={app} />
          {compact ? <span className="font-mono">{shortAddress(address)}</span> : <WalletName address={address} app={app} />}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80" data-wallet-menu>
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              <WalletAppIcon app={app} />
              {app ? <span data-wallet-app={app.name}>{app.name}</span> : <span className="font-mono">{shortAddress(address)}</span>}
            </span>
            <span data-network>{network}</span>
          </span>
          <span className="font-mono text-xs break-all text-foreground" data-full-address>
            {address}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault()
            void copy()
          }}
          data-copy-address
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy address"}
        </DropdownMenuItem>
        {!app && network === "Solana" && <ConnectWalletItems wallets={wallets} onConnected={refresh} />}
        {links.length > 0 && <DropdownMenuSeparator />}
        {links.map((l) => (
          <DropdownMenuItem key={l.href} asChild data-liquidity-link={l.label}>
            <Link href={l.href}>
              <ArrowRight />
              {l.label}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {accounts.manageUrl ? (
          <DropdownMenuItem asChild data-manage-wallet>
            <a href={accounts.manageUrl} rel="noreferrer">
              <ExternalLink />
              Manage linked accounts
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled title={NOT_YET} data-manage-wallet>
            <ExternalLink />
            Manage linked accounts
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
