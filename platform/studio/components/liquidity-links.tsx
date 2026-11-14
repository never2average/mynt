"use client"

// The dashboard wallet tile's liquidity links, by role: "Manage pools" for builders and
// "Provide liquidity" for liquidity providers, both to /liquidity. Given `access`, it renders
// from it (the tests); otherwise it reads the user's roles itself.
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { walletLinksFor, type LiquidityAccess } from "@/lib/liquidity"
import { useLiquidityAccess } from "@/lib/use-liquidity-access"

export function LiquidityLinks({ access }: { access?: LiquidityAccess | null }) {
  const loaded = useLiquidityAccess(access === undefined)
  const links = walletLinksFor(access === undefined ? loaded : access)
  if (!links.length) return null
  return (
    <>
      {links.map((l) => (
        <Button key={l.href} size="sm" variant="outline" asChild data-liquidity-link={l.label}>
          <Link href={l.href}>
            {l.label}
            <ArrowRight />
          </Link>
        </Button>
      ))}
    </>
  )
}
