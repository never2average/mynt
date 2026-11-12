// All configuration comes from the environment. See .env.example.

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
// Host header, which a reverse proxy may rewrite.
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
  return "Mynt chat (sample)";
}

export function mcpClientInfo(): { name: string; version: string } {
  return { name: "mynt-chat", version: "0.1.0" };
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

export function chatModel(): string {
  return process.env.CHAT_MODEL?.trim() || "claude-opus-5-5";
}

// Chat messages each Mynt user may send per day (UTC); 0 turns the cap off.
export function chatDailyMessages(): number {
  const raw = process.env.CHAT_DAILY_MESSAGES?.trim();
  const n = raw ? Number(raw) : 50;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 50;
}
