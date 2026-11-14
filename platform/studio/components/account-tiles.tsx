// The dashboard's second row of tiles, beside the money cards (same Card layout as shadcn/ui's
// dashboard-01 section cards): active products, licences, the linked GitHub account and crypto
// wallet. The GitHub tile also lists up to five of the developer's connected repositories with
// their approval, View all, and Connect repository (components/repositories.tsx). Link GitHub and Link wallet go to the identity provider's account page in the same
// tab (never an embedded sign-in); the page reads the accounts again when the user comes back.
import Link from "next/link"
import { ArrowRight, Github, Link2, Wallet } from "lucide-react"

import { ConnectRepository, RepoTileList, type ReposState } from "@/components/repositories"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { LiquidityLinks } from "@/components/liquidity-links"
import type { LiquidityAccess } from "@/lib/liquidity"
import { count, type Dashboard } from "@/lib/dashboard"
import { shortAddress, type LinkedAccounts } from "@/lib/linked-accounts"

function LinkOut({ href, label }: { href: string | null; label: string }) {
  if (!href)
    return (
      <Button size="sm" variant="outline" disabled title="Linking accounts comes with Mynt's next update">
        <Link2 />
        {label}
      </Button>
    )
  return (
    <Button size="sm" variant="outline" asChild>
      <a href={href} rel="noreferrer">
        <Link2 />
        {label}
      </a>
    </Button>
  )
}

const valueClass = (measured: boolean) =>
  measured ? "text-2xl font-semibold tabular-nums @[250px]/card:text-3xl" : "text-lg font-medium text-muted-foreground"

export function AccountTiles({
  dashboard,
  linked,
  repos = { kind: "loading" },
  onReposChanged,
  liquidity,
}: {
  dashboard: Dashboard
  linked: LinkedAccounts | null
  repos?: ReposState // the developer's connected repositories, on the GitHub tile
  onReposChanged?: () => void
  liquidity?: LiquidityAccess | null // the wallet tile's liquidity links; read by the tile itself when not given
}) {
  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
      <Card className="@container/card" data-tile="active-products">
        <CardHeader>
          <CardDescription>Active products</CardDescription>
          <CardTitle className={valueClass(dashboard.activeProducts !== null)}>{count(dashboard.activeProducts)}</CardTitle>
        </CardHeader>
        <CardFooter className="text-sm text-muted-foreground">Live in this workspace&apos;s apps</CardFooter>
      </Card>

      <Card className="@container/card" data-tile="licences">
        <CardHeader>
          <CardDescription>Licences</CardDescription>
          <CardTitle className={valueClass(dashboard.licences !== null)}>{count(dashboard.licences)}</CardTitle>
        </CardHeader>
        <CardFooter className="flex flex-col items-start gap-2 text-sm text-muted-foreground">
          Partner licences behind your products
          <Link href="/licences" className="flex shrink-0 items-center gap-1 font-medium text-foreground hover:underline">
            View licences
            <ArrowRight className="size-3.5" />
          </Link>
        </CardFooter>
      </Card>

      <Card className="@container/card" data-tile="github">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <Github className="size-4" />
            GitHub
          </CardDescription>
          <CardTitle className={valueClass(Boolean(linked?.github))}>{linked?.github ?? (linked ? "Not linked" : "…")}</CardTitle>
        </CardHeader>
        <CardFooter className="flex flex-col items-start gap-3 text-sm">
          <RepoTileList state={repos} />
          <div className="flex flex-wrap gap-2">
            {linked && !linked.github && <LinkOut href={linked.manageUrl} label="Link GitHub" />}
            <ConnectRepository enabled={repos.kind === "ready" && repos.connect} onConnected={onReposChanged} />
          </div>
        </CardFooter>
      </Card>

      <Card className="@container/card" data-tile="wallet">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <Wallet className="size-4" />
            Crypto wallet
          </CardDescription>
          <CardTitle className={linked?.wallet ? "font-mono text-xl font-semibold" : valueClass(false)}>
            {linked?.wallet ? shortAddress(linked.wallet.address) : linked ? "Not linked" : "…"}
          </CardTitle>
          {linked?.wallet && (
            <CardAction>
              <Badge variant="outline" data-network>
                {linked.wallet.network}
              </Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardFooter className="flex flex-wrap gap-2">
          {linked && !linked.wallet && <LinkOut href={linked.manageUrl} label="Link wallet" />}
          <LiquidityLinks access={liquidity} />
        </CardFooter>
      </Card>
    </div>
  )
}
