// The dashboard's second row of tiles, beside the money cards (same Card layout as shadcn/ui's
// dashboard-01 section cards): active products, licences, the linked GitHub account and crypto
// wallet. Link GitHub and Link wallet go to the identity provider's account page in the same
// tab (never an embedded sign-in); the page reads the accounts again when the user comes back.
import { Github, Link2, Wallet } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
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

export function AccountTiles({ dashboard, linked }: { dashboard: Dashboard; linked: LinkedAccounts | null }) {
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
        <CardFooter className="text-sm text-muted-foreground">Partner licences behind your products</CardFooter>
      </Card>

      <Card className="@container/card" data-tile="github">
        <CardHeader>
          <CardDescription className="flex items-center gap-1.5">
            <Github className="size-4" />
            GitHub
          </CardDescription>
          <CardTitle className={valueClass(Boolean(linked?.github))}>{linked?.github ?? (linked ? "Not linked" : "…")}</CardTitle>
        </CardHeader>
        <CardFooter>{linked && !linked.github && <LinkOut href={linked.manageUrl} label="Link GitHub" />}</CardFooter>
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
          {linked?.wallet?.chain && (
            <CardAction>
              <Badge variant="outline" className="capitalize">
                {linked.wallet.chain}
              </Badge>
            </CardAction>
          )}
        </CardHeader>
        <CardFooter>{linked && !linked.wallet && <LinkOut href={linked.manageUrl} label="Link wallet" />}</CardFooter>
      </Card>
    </div>
  )
}
