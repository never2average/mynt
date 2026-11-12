"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Loader2Icon, LogOutIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

// In place of Adorable's API-key gate: people sign in as themselves, with their Mynt account
// (OAuth with PKCE, through /api/auth/login). The browser never sees a token or a key.

const AUTH_ERRORS: Record<string, string> = {
  denied: "Sign-in was cancelled.",
  state: "Sign-in expired. Please try again.",
  session: "Sign-in expired. Please try again.",
  exchange: "Mynt couldn't finish signing you in. Please try again.",
  start: "Couldn't reach Mynt to sign in. Please try again.",
  code: "Sign-in didn't complete. Please try again.",
};

export function SignInGate({ children }: { children: ReactNode }) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("auth_error");
    if (code) {
      setAuthError(AUTH_ERRORS[code] ?? "Sign-in failed. Please try again.");
      window.history.replaceState(window.history.state, "", window.location.pathname);
    }
    const check = () =>
      fetch("/api/session", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ signedIn?: boolean }>)
        .then((data) => setSignedIn(Boolean(data.signedIn)))
        .catch(() => setSignedIn(false));
    void check();
    const onSignedOut = () => setSignedIn(false);
    window.addEventListener("mynt:signed-out", onSignedOut);
    return () => window.removeEventListener("mynt:signed-out", onSignedOut);
  }, []);

  if (signedIn === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2Icon className="size-6 animate-spin text-muted-foreground/40" />
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">Mynt Studio</h1>
          <p className="text-sm text-muted-foreground">
            Build apps on Mynt with Mynt&apos;s coding agent. Sign in with your
            Mynt developer account to see your apps.
          </p>
          {authError && (
            <p role="alert" className="text-sm text-destructive">
              {authError}
            </p>
          )}
          <Button asChild>
            {/* A full page navigation: the server sends the browser to Mynt's sign-in. */}
            <a href="/api/auth/login">Sign in with Mynt</a>
          </Button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}

// POST only, so a link elsewhere can't sign anyone out.
export function SignOutButton() {
  return (
    <form method="post" action="/api/auth/logout">
      <Button type="submit" variant="ghost" size="sm" title="Sign out">
        <LogOutIcon />
        Sign out
      </Button>
    </form>
  );
}
