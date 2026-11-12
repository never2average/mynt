import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";

// What the sign-in code needs from an app. Each app keeps its own settings (lib/config.ts), its
// own session cookie name (lib/app-session.ts) and its own session store (lib/session-store.ts:
// in memory for mynt-chat, in Redis for Mynt Studio), and hands them to this package in
// lib/session.ts.

// The part of a session this package reads and writes. An app's sessions hold more.
export interface AuthSession {
  id: string;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  oauthState?: string; // CSRF check between /api/auth/login and /api/auth/callback
  returnTo?: string; // the page to go back to after sign-in (a checked relative path)
}

// The store's methods this package calls. Each returns a value (an in-memory store) or a promise
// (a remote one); callers await them either way.
export interface AuthSessionStore<S extends AuthSession> {
  create(): S;
  get(id: string | undefined): S | undefined | Promise<S | undefined>;
  save(session: S): unknown;
  rotate(old: S): S | Promise<S>;
  destroy(id: string | undefined): void | Promise<void>;
  clientInformation(redirectUrl: string): OAuthClientInformationMixed | undefined | Promise<OAuthClientInformationMixed | undefined>;
  saveClientInformation(redirectUrl: string, info: OAuthClientInformationMixed): void | Promise<void>;
  forgetClient(redirectUrl: string): void | Promise<void>;
}

// The app's settings, read on every call (they come from the environment).
export interface AuthConfig {
  myntMcpUrl(): URL;
  appUrl(): URL;
  oauthRedirectUrl(): string;
  secureCookies(): boolean;
  oauthClientName(): string;
  mcpClientInfo(): { name: string; version: string };
  oauthScope(): string;
  // Optional. A client id registered with the authorization server ahead of time (for example a
  // first-party client that skips the consent screen). Without one, the app registers itself
  // dynamically on first sign-in.
  oauthClientId?(): string | undefined;
  // Optional. Where a failed sign-in lands (with ?auth_error=<reason>), and where sign-out lands.
  // Both default to "/". An app that sends signed-out visitors straight to sign-in points them at
  // pages that don't, so a failure can't loop and signing out doesn't sign straight back in.
  authErrorPath?(): string;
  signedOutPath?(): string;
}

export interface AuthApp<S extends AuthSession> {
  config: AuthConfig;
  sessionCookie: string; // the cookie's bare name; __Host- is added over https
  sessionStore(): AuthSessionStore<S>;
}
