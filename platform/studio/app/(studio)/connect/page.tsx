"use client";

// Connect your agent (/connect, from the header's plug button beside the theme switcher): add Mynt's MCP server to
// the AI agent you work in. The steps for each agent are components/connect-agent.tsx's; /docs has the full guide.
import { ConnectAgentPanel } from "@/components/connect-agent";

export default function ConnectPage() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 md:px-8" data-connect-page>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">Connect your agent</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">Use Mynt from the AI agent you already work in. It signs in as you and sees only what you can see here.</p>
      </header>
      <div className="rounded-lg border p-4">
        <ConnectAgentPanel />
      </div>
    </div>
  );
}
