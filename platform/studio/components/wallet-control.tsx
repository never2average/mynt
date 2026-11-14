"use client"

// The header's wallet control, right beside New app. A linked wallet shows its short address and
// network; clicking it opens a menu with the full address (and Copy), the liquidity links for the
// user's roles (Manage pools, Provide liquidity, to the Earn page's tabs) and Manage in Clerk
// (the identity provider's account page, in the same tab, never embedded). With no wallet it's
// Link wallet, to that same page. Given `linked` and `access` it renders from them (the tests);
// otherwise it reads them itself.
import Link from "next/link"
import { useState } from "react"
import { ArrowRight, Check, ChevronDown, Copy, ExternalLink, Link2, Wallet } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { shortAddress, type LinkedAccounts } from "@/lib/linked-accounts"
import { walletLinksFor, type LiquidityAccess } from "@/lib/liquidity"
import { useLinkedAccounts } from "@/lib/use-linked-accounts"
import { useLiquidityAccess } from "@/lib/use-liquidity-access"

export const NOT_YET = "Linking accounts comes with Mynt's next update"

export function WalletControl({
  linked,
  access,
  compact = false,
}: {
  linked?: LinkedAccounts | null
  access?: LiquidityAccess | null
  /** The app's top bar: the short address only, no network badge. */
  compact?: boolean
}) {
  const loadedLinked = useLinkedAccounts()
  const loadedAccess = useLiquidityAccess(access === undefined)
  const accounts = linked === undefined ? loadedLinked : linked
  const links = walletLinksFor(access === undefined ? loadedAccess : access)
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
          <Link2 />
          Link wallet
        </a>
      </Button>
    )
  }

  const { address, network } = accounts.wallet
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
          <Wallet />
          <span className="font-mono">{shortAddress(address)}</span>
          {!compact && (
            <Badge variant="secondary" className="font-normal" data-network>
              {network}
            </Badge>
          )}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80" data-wallet-menu>
        <DropdownMenuLabel className="flex flex-col gap-1 font-normal">
          <span className="flex items-center justify-between text-xs text-muted-foreground">
            Crypto wallet
            <Badge variant="outline" className="font-normal">
              {network}
            </Badge>
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
              Manage in Clerk
            </a>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem disabled title={NOT_YET} data-manage-wallet>
            <ExternalLink />
            Manage in Clerk
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
