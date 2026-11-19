"use client"

// "Connect your agent" (/connect, from the header's plug button): for people who'd rather work from their own AI agent, how to add
// Mynt's MCP server to it. The server's address is this site's own origin + /mcp (Mynt's paths share
// the studio's domain), read in the browser, so no host is written into the code. Signing in from the
// agent goes through Mynt's normal sign-in (OAuth), so nothing secret is shown here.
import Link from "next/link"
import { useEffect, useState } from "react"
import { Check, Copy, ExternalLink, Plug } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type AgentId = "claude-code" | "claude" | "cursor" | "vscode" | "chatgpt" | "other"
export const AGENTS: { id: AgentId; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude", label: "Claude" },
  { id: "cursor", label: "Cursor" },
  { id: "vscode", label: "VS Code" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "other", label: "Other" },
]

export const mcpUrl = (origin: string) => `${origin.replace(/\/+$/, "")}/mcp`
export const claudeCodeCommand = (url: string) => `claude mcp add --transport http mynt ${url}`
// Cursor's one-click install: the server config, base64-encoded JSON.
export const cursorInstallLink = (url: string) => `cursor://anysphere.cursor-deeplink/mcp/install?name=mynt&config=${encodeURIComponent(btoa(JSON.stringify({ url })))}`
// VS Code's one-click install: the server definition, URL-encoded JSON.
export const vscodeInstallLink = (url: string) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: "mynt", type: "http", url }))}`

function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs" data-copy-value>
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            },
            () => {},
          )
        }}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check /> : <Copy />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  )
}

export function AgentInstructions({ agent, url }: { agent: AgentId; url: string }) {
  switch (agent) {
    case "claude-code":
      return (
        <div className="space-y-3" data-agent="claude-code">
          <p className="text-sm text-muted-foreground">Run this in your terminal, then start Claude Code and sign in to Mynt when it asks.</p>
          <CopyField value={claudeCodeCommand(url)} label="command" />
        </div>
      )
    case "claude":
      return (
        <div className="space-y-3" data-agent="claude">
          <Steps items={["Open Claude (web or desktop) → Settings → Connectors.", "Choose Add custom connector, name it Mynt, and paste this address.", "Connect, then sign in to Mynt."]} />
          <CopyField value={url} label="server address" />
        </div>
      )
    case "cursor":
      return (
        <div className="space-y-3" data-agent="cursor">
          <Button asChild size="sm">
            <a href={cursorInstallLink(url)} data-install-link="cursor">
              <ExternalLink />
              Add to Cursor
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">Or add it by hand in Cursor's MCP settings with this address:</p>
          <CopyField value={url} label="server address" />
        </div>
      )
    case "vscode":
      return (
        <div className="space-y-3" data-agent="vscode">
          <Button asChild size="sm">
            <a href={vscodeInstallLink(url)} data-install-link="vscode">
              <ExternalLink />
              Add to VS Code
            </a>
          </Button>
          <p className="text-sm text-muted-foreground">Or run “MCP: Add Server” in VS Code, choose HTTP, and paste:</p>
          <CopyField value={url} label="server address" />
        </div>
      )
    case "chatgpt":
      return (
        <div className="space-y-3" data-agent="chatgpt">
          <Steps items={["In ChatGPT, open Settings → Connectors (turn on developer mode if asked).", "Create a connector named Mynt with this address and OAuth sign-in.", "Connect, then sign in to Mynt."]} />
          <CopyField value={url} label="server address" />
        </div>
      )
    default:
      return (
        <div className="space-y-3" data-agent="other">
          <p className="text-sm text-muted-foreground">Any agent that supports remote MCP servers over HTTP with OAuth sign-in can use Mynt at:</p>
          <CopyField value={url} label="server address" />
        </div>
      )
  }
}

// The agent picker and its steps, as the /connect page shows them.
export function ConnectAgentPanel() {
  const [agent, setAgent] = useState<AgentId>("claude-code")
  const [url, setUrl] = useState("")
  useEffect(() => setUrl(mcpUrl(window.location.origin)), [])
  return (
    <div className="flex flex-col gap-4" data-connect-agent>
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Agent">
        {AGENTS.map((a) => (
          <Button key={a.id} type="button" size="sm" variant={a.id === agent ? "secondary" : "ghost"} role="tab" aria-selected={a.id === agent} onClick={() => setAgent(a.id)} data-agent-tab={a.id}>
            {a.label}
          </Button>
        ))}
      </div>
      {url && <AgentInstructions agent={agent} url={url} />}
      <Link href="/docs" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" data-docs-link>
        Read the full guide: signing in, what your agent can do, troubleshooting
      </Link>
    </div>
  )
}

// The header's icon button beside the theme switcher, opening /connect. Outlined and sized like the theme button.
export function ConnectAgentButton() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="outline" size="icon" className="size-8 shrink-0 p-0">
          <Link href="/connect" aria-label="Connect your agent" data-connect-agent-open>
            <Plug />
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Connect your agent</TooltipContent>
    </Tooltip>
  )
}
