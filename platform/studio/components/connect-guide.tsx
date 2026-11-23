"use client";

// The Connect your agent guide: the agent picker and each agent's steps first (components/connect-agent.tsx), then
// the server address, signing in, what the agent can do, things to try and troubleshooting, each a panel with the
// dashboard's section heading. Shown by /connect (in the studio's shell) and by /docs/connect (in the docs). The
// address is this site's origin + /mcp, read in the browser (no host in the code).
import { useEffect, useState } from "react";

import { AgentInstructions, ConnectAgentPanel, mcpUrl } from "@/components/connect-agent";

// Each section is a flat outlined panel with the dashboard's section heading (components/dashboard-panels.tsx).
function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 rounded-lg border" data-docs-section={id} data-panel aria-labelledby={`section-${id}`}>
      <div className="flex flex-col gap-3 p-4">
        <h2 id={`section-${id}`} className="text-sm font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;

export function ConnectGuide() {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(mcpUrl(window.location.origin)), []);
  return (
    <>
      <Section id="connect" title="Connect an agent">
        <ConnectAgentPanel />
      </Section>

      <Section id="address" title="Server address">
        <P>Every agent needs this one address. It uses MCP&apos;s Streamable HTTP transport with OAuth sign-in.</P>
        {url && <AgentInstructions agent="other" url={url} />}
      </Section>

      <Section id="sign-in" title="Signing in">
        <P>The first time your agent calls Mynt, it opens Mynt&apos;s sign-in page in your browser. Sign in with the same account you use here.</P>
        <P>Your agent then asks you once to allow it to use Mynt for you. Mynt&apos;s own apps skip that screen; any other agent always shows it.</P>
        <P>No key is copied anywhere: your agent holds a sign-in that is checked on every request. If your access is removed, the agent loses it on its next request.</P>
      </Section>

      <Section id="access" title="What your agent can do">
        <P>Exactly what your account can do here, and nothing more. Your roles decide which tools your agent sees, and your workspaces decide which apps and records those tools reach.</P>
        <P>Anything that needs a person&apos;s yes in the studio still does: promoting an app to Production, committing or withdrawing money, and inviting people. Mynt never moves money on an agent&apos;s say-so, and never signs for your wallet.</P>
      </Section>

      <Section id="try" title="Things to try">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>“Which licences does my workspace hold, and in which states?”</li>
          <li>“Start a build for a savings app and tell me when it&apos;s done.”</li>
          <li>“What&apos;s left before my app can move to Production?”</li>
          <li>“Show this week&apos;s audit records for my workspace.”</li>
        </ul>
      </Section>

      <Section id="trouble" title="Troubleshooting">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          <li>
            <span className="text-foreground">Sign-in page never opens:</span> check that the agent is using the HTTP transport and the address above, ending in <code className="font-mono text-xs">/mcp</code>.
          </li>
          <li>
            <span className="text-foreground">“Not authorised” after signing in:</span> your account hasn&apos;t been invited to Mynt yet. Ask a workspace owner or an admin to invite you.
          </li>
          <li>
            <span className="text-foreground">A tool you expected is missing:</span> it belongs to a role you don&apos;t have. Ask an admin if you need it.
          </li>
          <li>
            <span className="text-foreground">Wrong workspace:</span> ask the agent to list your workspaces and name the one you mean.
          </li>
        </ul>
      </Section>
    </>
  );
}
