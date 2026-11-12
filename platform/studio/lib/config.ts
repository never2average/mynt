// All configuration comes from the environment. See .env.example. The studio holds no secrets
// of its own: no model keys and no hosting-provider keys. Everything goes through Mynt as the
// signed-in user.

import { preRegisteredClientFromEnv, type PreRegisteredClient } from "@mynt/auth/first-party-client";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

// Where Mynt's MCP endpoint lives, e.g. https://mynt.example.com/mcp
export function myntMcpUrl(): URL {
  return new URL(required("MYNT_MCP_URL"));
}

// This app's public origin. OAuth redirects are built from it rather than from the request's
// Host header, which a proxy may rewrite.
export function appUrl(): URL {
  return new URL(process.env.APP_URL?.trim() || "http://localhost:3000");
}

export function oauthRedirectUrl(): string {
  return new URL("/api/auth/callback", appUrl()).toString();
}

// Session cookies are Secure unless the app is plain http on localhost (local development).
export function secureCookies(): boolean {
  const url = appUrl();
  return !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
}

// How this app names itself to Mynt: in dynamic client registration (shown on the consent
// screen) and as an MCP client.
export function oauthClientName(): string {
  return "Mynt Studio";
}

export function mcpClientInfo(): { name: string; version: string } {
  return { name: "mynt-studio", version: "0.1.0" };
}

export function oauthScope(): string {
  return process.env.MYNT_OAUTH_SCOPE?.trim() || "openid profile email";
}

// The OAuth client an operator registered for this app with `mynt clerk first-party`
// (MYNT_OAUTH_CLIENT_ID and MYNT_OAUTH_CLIENT_SECRET), so users aren't shown a consent screen.
// Unset, the app registers itself dynamically. Read on the server only.
export function oauthClient(): PreRegisteredClient | null {
  return preRegisteredClientFromEnv();
}

// Every page needs a signed-in user, so a failed sign-in and a sign-out land on pages that don't
// (app/signin-error, app/signed-out): no loop when sign-in fails, and no silent sign-in straight
// after signing out.
export function authErrorPath(): string {
  return "/signin-error";
}

export function signedOutPath(): string {
  return "/signed-out";
}
