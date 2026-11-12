"use client";

import { useCallback, useEffect, useState } from "react";
import type { AppRow } from "@/lib/developer";
import type { ToolResult } from "./api";
import { BuildDetail, BuildsSection } from "./Builds";
import { AppDetail, HostingSection } from "./Hosting";
import { Notice, Tabs } from "./ui";

interface Access {
  signedIn: boolean;
  developer: boolean;
  error?: string;
}

const SECTIONS = [
  { id: "builds", label: "Builds" },
  { id: "hosting", label: "Hosting" },
] as const;
type Section = (typeof SECTIONS)[number]["id"];

// The developer console: your coding-agent builds and your hosting, through your own Mynt
// session. Shown to signed-in users whose Mynt roles include developer; Mynt checks every call.
export function DeveloperConsole() {
  const [access, setAccess] = useState<Access | null>(null);
  const [section, setSection] = useState<Section>("builds");
  const [buildId, setBuildId] = useState<string | null>(null);
  const [app, setApp] = useState<AppRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setAccess(null);
    try {
      const res = await fetch("/api/developer", { cache: "no-store" });
      setAccess((await res.json()) as Access);
    } catch {
      setAccess({ signedIn: true, developer: false, error: "You seem to be offline. Please try again." });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Every tool call reports here: errors show in one place, and an expired sign-in signs out.
  const report = useCallback((r: ToolResult) => {
    if (r.signedOut) setAccess({ signedIn: false, developer: false });
    if (!r.ok) setError(r.error ?? "Mynt refused this.");
    return r.ok;
  }, []);

  const pick = (s: Section) => {
    setSection(s);
    setBuildId(null);
    setApp(null);
    setError(null);
  };

  return (
    <div className="dev-app">
      <header className="dev-header">
        <h1 className="brand">
          <span className="dot" aria-hidden="true" />
          Mynt <span className="dev-brand-sub">Developer</span>
        </h1>
        <nav className="header-actions" aria-label="App">
          <a className="ghost dev-link" href="/">
            Back to chat
          </a>
        </nav>
      </header>

      <main className="dev-main">
        {access === null ? <p className="dev-muted">Checking your Mynt access…</p> : null}

        {access && !access.signedIn ? (
          <div className="dev-gate">
            <h2>Sign in to use the developer console</h2>
            <p className="dev-muted">Sign in with your Mynt account. After signing in you land on the chat; come back to this page from there.</p>
            <a className="btn btn-primary signin" href="/api/auth/login">
              Sign in with Mynt
            </a>
          </div>
        ) : null}

        {access && access.signedIn && !access.developer ? (
          <div className="dev-gate">
            <h2>Developer access needed</h2>
            <p className="dev-muted">{access.error ?? "Your Mynt account doesn't have the developer role. Ask a Mynt admin to grant it, then reload this page."}</p>
            <button type="button" className="btn btn-secondary dev-btn" onClick={() => void check()}>
              Check again
            </button>
          </div>
        ) : null}

        {access?.signedIn && access.developer ? (
          <>
            <Tabs tabs={SECTIONS} current={section} onChange={pick} label="Developer console sections" />
            {error ? (
              <Notice tone="error" onDismiss={() => setError(null)}>
                {error}
              </Notice>
            ) : null}
            {section === "builds" ? (
              buildId ? (
                <BuildDetail key={buildId} buildId={buildId} report={report} onBack={() => setBuildId(null)} />
              ) : (
                <BuildsSection report={report} onOpen={setBuildId} />
              )
            ) : app ? (
              <AppDetail key={app.app_id} initial={app} report={report} onBack={() => setApp(null)} />
            ) : (
              <HostingSection report={report} onOpen={setApp} />
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
