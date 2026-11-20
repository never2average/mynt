"use client"

// What stands in for a page the user can't use yet. DeveloperGate: the studio is for developers
// (one message and who to ask, nothing else on the page); liquidity providers keep the dashboard's investor view
// and Earn. CreateWorkspace: a developer with no workspace on Mynt yet (they skipped choosing or
// creating one when signing in) names one here first, in a panel centred on the page;
// create_workspace makes it. DeveloperOnly:
// header controls only developers get (GitHub, the wallet, New app). Which page is open to whom:
// pageGateFor.
import { useState } from "react"

import { Panel, Section } from "@/components/dashboard-panels"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useStudioAccess, type StudioAccess } from "@/lib/use-liquidity-access"

export const FOR_DEVELOPERS = "Mynt Studio is for developers"
export const ASK_FOR_ROLE = "Ask a Mynt admin for the developer role."

/** Which stand-in a page gets: none, the developer gate, or creating a workspace first. */
export function pageGateFor(pathname: string, access: StudioAccess, needsWorkspace: boolean): "none" | "developer" | "workspace" {
  const investorPage = pathname === "/" || pathname === "/earn" || pathname.startsWith("/earn/") || pathname === "/liquidity"
  if (!access.developer) return access.liquidity.liquidityProvider && investorPage ? "none" : "developer"
  // Everything but Earn needs a workspace (Earn's pools and positions are the user's own).
  if (needsWorkspace && pathname !== "/" && investorPage) return "none"
  return needsWorkspace ? "workspace" : "none"
}

export function DeveloperGate() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center" data-gate="developer">
      <h2 className="text-sm font-semibold">{FOR_DEVELOPERS}</h2>
      <p className="max-w-md text-sm text-muted-foreground">{ASK_FOR_ROLE}</p>
    </div>
  )
}

export function CreateWorkspace({ onCreate }: { onCreate: (name: string) => Promise<string | null> }) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-4 lg:p-6" data-gate="workspace">
      <Panel id="create-workspace" className="w-full max-w-sm">
        <Section id="create-workspace" title="Create your workspace">
          <form
            className="flex flex-col gap-3"
            onSubmit={async (e) => {
              e.preventDefault()
              if (busy || !name.trim()) return
              setBusy(true)
              setError(null)
              const failed = await onCreate(name.trim())
              setBusy(false)
              if (failed) setError(failed)
            }}
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Labs" aria-label="Workspace name" maxLength={80} autoFocus />
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Creating…" : "Create workspace"}
            </Button>
          </form>
        </Section>
      </Panel>
    </div>
  )
}

/** Header controls only developers get; nothing while the roles are being read. */
export function DeveloperOnly({ children }: { children: React.ReactNode }) {
  const access = useStudioAccess()
  return access?.developer ? <>{children}</> : null
}
