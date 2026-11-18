"use client";

// Docs (/docs): using Mynt from your own AI agent over MCP. The address is this site's origin + /mcp,
// read in the browser (no host in the code); each agent's steps are the same ones the sidebar's
// "Connect your agent" dialog shows (components/connect-agent.tsx).
import { useEffect, useState } from "react";

import { AGENTS, AgentInstructions, mcpUrl } from "@/components/connect-agent";

const SECTIONS = [
  { id: "address", label: "Server address" },
  { id: "connect", label: "Connect an agent" },
  { id: "sign-in", label: "Signing in" },
  { id: "access", label: "What your agent can do" },
  { id: "try", label: "Things to try" },
  { id: "trouble", label: "Troubleshooting" },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20 space-y-3" data-docs-section={id}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;

export default function DocsPage() {
  const [url, setUrl] = useState("");
  useEffect(() => setUrl(mcpUrl(window.location.origin)), []);

  return (
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-4 py-8 md:px-8" data-docs>
      <nav className="sticky top-20 hidden h-fit w-44 shrink-0 space-y-1 text-sm lg:block" aria-label="On this page">
        <p className="mb-2 text-xs font-medium text-muted-foreground">On this page</p>
        {SECTIONS.map((s) => (
          <a key={s.id} href={`#${s.id}`} className="block rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            {s.label}
          </a>
        ))}
      </nav>

      <article className="min-w-0 flex-1 space-y-10">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Use Mynt from your agent</h1>
          <P>
            Mynt is an MCP server. If you'd rather work in Claude, Claude Code, Cursor, VS Code or ChatGPT than in the studio, connect it to Mynt and ask for what you'd do here: look up licences, start and follow builds, check an app's
            promotion gates, read audits. It signs in as you and sees only what you can see.
          </P>
        </header>

        <Section id="address" title="Server address">
          <P>Every agent needs this one address. It uses MCP's Streamable HTTP transport with OAuth sign-in.</P>
          {url && <AgentInstructions agent="other" url={url} />}
        </Section>

        <Section id="connect" title="Connect an agent">
          {url &&
            AGENTS.filter((a) => a.id !== "other").map((a) => (
              <div key={a.id} className="space-y-3 rounded-lg border p-4" data-docs-agent={a.id}>
                <h3 className="text-sm font-medium">{a.label}</h3>
                <AgentInstructions agent={a.id} url={url} />
              </div>
            ))}
        </Section>

        <Section id="sign-in" title="Signing in">
          <P>The first time your agent calls Mynt, it opens Mynt's sign-in page in your browser. Sign in with the same account you use here.</P>
          <P>Your agent then asks you once to allow it to use Mynt for you. Mynt's own apps skip that screen; any other agent always shows it.</P>
          <P>No key is copied anywhere: your agent holds a sign-in that is checked on every request. If your access is removed, the agent loses it on its next request.</P>
        </Section>

        <Section id="access" title="What your agent can do">
          <P>Exactly what your account can do here, and nothing more. Your roles decide which tools your agent sees, and your workspaces decide which apps and records those tools reach.</P>
          <P>Anything that needs a person's yes in the studio still does: promoting an app to Production, committing or withdrawing money, and inviting people. Mynt never moves money on an agent's say-so, and never signs for your wallet.</P>
        </Section>

        <Section id="try" title="Things to try">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>“Which licences does my workspace hold, and in which states?”</li>
            <li>“Start a build for a savings app and tell me when it's done.”</li>
            <li>“What's left before my app can move to Production?”</li>
            <li>“Show this week's audit records for my workspace.”</li>
          </ul>
        </Section>

        <Section id="trouble" title="Troubleshooting">
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">Sign-in page never opens:</span> check that the agent is using the HTTP transport and the address above, ending in <code className="font-mono text-xs">/mcp</code>.
            </li>
            <li>
              <span className="text-foreground">“Not authorised” after signing in:</span> your account hasn't been invited to Mynt yet. Ask a workspace owner or an admin to invite you.
            </li>
            <li>
              <span className="text-foreground">A tool you expected is missing:</span> it belongs to a role you don't have. Ask an admin if you need it.
            </li>
            <li>
              <span className="text-foreground">Wrong workspace:</span> ask the agent to list your workspaces and name the one you mean.
            </li>
          </ul>
        </Section>
      </article>
    </div>
  );
}
