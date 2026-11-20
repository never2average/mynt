"use client";

// Connect your agent (/connect, from the header's plug button beside the theme switcher; /docs comes
// here too): using Mynt from your own AI agent over MCP. The agent picker and each agent's steps first
// (components/connect-agent.tsx), then the server address, signing in, what the agent can do, things to
// try and troubleshooting. The address is this site's origin + /mcp, read in the browser (no host in the code).
import { useEffect, useRef, useState } from "react";

import { AgentInstructions, ConnectAgentPanel, mcpUrl } from "@/components/connect-agent";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "connect", label: "Connect an agent" },
  { id: "address", label: "Server address" },
  { id: "sign-in", label: "Signing in" },
  { id: "access", label: "What your agent can do" },
  { id: "try", label: "Things to try" },
  { id: "trouble", label: "Troubleshooting" },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-6 space-y-3" data-docs-section={id}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

const P = ({ children }: { children: React.ReactNode }) => <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>;

// Scrolls to a section wherever the page's scroll lives (the studio scrolls inside its own panel, where a
// bare #link doesn't always move it), and keeps the address's #section in step.
function goTo(id: string, smooth = true) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: smooth && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto", block: "start" });
  if (window.location.hash !== `#${id}`) window.history.replaceState(null, "", `#${id}`);
}

function OnThisPage({ active, className, row = false }: { active: string; className: string; row?: boolean }) {
  return (
    <nav className={className} aria-label="On this page" data-on-this-page={row ? "row" : "side"}>
      {!row && <p className="mb-2 text-xs font-medium text-muted-foreground">On this page</p>}
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          onClick={(e) => {
            e.preventDefault();
            goTo(s.id);
          }}
          aria-current={active === s.id ? "location" : undefined}
          className={cn(
            "block rounded-md px-2 py-1 whitespace-nowrap text-muted-foreground hover:bg-muted hover:text-foreground",
            active === s.id && "bg-muted font-medium text-foreground",
          )}
          data-section-link={s.id}
        >
          {s.label}
        </a>
      ))}
    </nav>
  );
}

export default function ConnectPage() {
  const [url, setUrl] = useState("");
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  // The page scrolls in its own box (the studio shell fixes the window; every long page scrolls itself).
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => setUrl(mcpUrl(window.location.origin)), []);
  // Opened at #section (or redirected from /docs#section): go there once the page is drawn.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (SECTIONS.some((s) => s.id === id)) {
      setActive(id);
      requestAnimationFrame(() => goTo(id, false));
    }
  }, []);
  // The section being read is the one highlighted.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = SECTIONS.find((s) => seen.get(s.id));
        if (first) setActive(first.id);
      },
      { root: scroller.current, rootMargin: "-24px 0px -60% 0px" },
    );
    for (const s of SECTIONS) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);

  return (
    <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto" data-connect-scroll>
    <div className="mx-auto flex w-full max-w-5xl gap-10 px-4 py-8 md:px-8" data-connect-page data-docs>
      <article className="min-w-0 flex-1 space-y-10">
        <OnThisPage active={active} row className="-mx-2 flex gap-1 overflow-x-auto pb-1 text-sm md:hidden" />
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Connect your agent</h1>
        </header>

        <Section id="connect" title="Connect an agent">
          <div className="rounded-lg border p-4">
            <ConnectAgentPanel />
          </div>
        </Section>

        <Section id="address" title="Server address">
          <P>Every agent needs this one address. It uses MCP's Streamable HTTP transport with OAuth sign-in.</P>
          {url && <AgentInstructions agent="other" url={url} />}
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

      {/* On this page: on the right, set off by a vertical rule. */}
      <OnThisPage active={active} className="sticky top-6 hidden h-fit w-52 shrink-0 space-y-1 border-l pl-6 text-sm md:block" />
    </div>
    </div>
  );
}
