import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { PreRegisteredClient } from "./first-party-client";
import type { AuthSession, AuthSessionStore } from "./types";

// The MCP SDK's OAuth hooks, backed by one server-side session.
//
// The SDK does the protocol: it reads Mynt's protected-resource metadata, finds the
// authorization server (Clerk), registers this app dynamically (unless the app was
// pre-registered, see first-party-client.ts), and runs the authorization-code
// flow with PKCE. This class only stores what the SDK hands it. Instead of redirecting a
// browser itself (there is none on the server), it remembers the authorization URL so the
// login route can send a 302.
//
// Tokens, verifier and state are set on the session object; the routes save the session to the
// store afterwards (a no-op for an in-memory store).
export class SessionOAuthProvider<S extends AuthSession = AuthSession> implements OAuthClientProvider {
  authorizationUrl?: URL;

  constructor(
    private session: S,
    private store: AuthSessionStore<S>,
    readonly redirectUrl: string,
    private scope: string,
    private clientName: string, // how the app names itself on the consent screen
    // A client registered ahead of time by an operator. When set, the app never registers itself
    // dynamically and the store's registration is neither read, written nor forgotten.
    private preRegistered: PreRegisteredClient | null = null,
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      // A dynamically registered app is a public client (PKCE, no secret). A pre-registered one has a secret; the
      // SDK picks Basic or POST for it from what the authorization server advertises.
      token_endpoint_auth_method: this.preRegistered ? "client_secret_basic" : "none",
      scope: this.scope,
    };
  }

  state(): string {
    this.session.oauthState = randomBytes(24).toString("base64url");
    return this.session.oauthState;
  }

  // The client registration is app-wide, so it lives in the store, not the session. These return
  // whatever the app's store returns: a value from an in-memory store, a promise from a remote one.
  clientInformation() {
    if (this.preRegistered) {
      const { client_id, client_secret } = this.preRegistered;
      return { client_id, client_secret };
    }
    return this.store.clientInformation(this.redirectUrl);
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
    if (this.preRegistered) return; // never registers dynamically, so there's nothing to keep
    return this.store.saveClientInformation(this.redirectUrl, info);
  }

  tokens(): OAuthTokens | undefined {
    return this.session.tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.session.tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.session.codeVerifier = verifier;
  }

  codeVerifier(): string {
    if (!this.session.codeVerifier) throw new Error("No PKCE code verifier for this session; start sign-in again");
    return this.session.codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.session.tokens = undefined;
    if (scope === "all" || scope === "verifier") this.session.codeVerifier = undefined;
    // A pre-registered client can't be re-registered; forgetting it would only switch sign-in to dynamic registration.
    if ((scope === "all" || scope === "client") && !this.preRegistered) return this.store.forgetClient(this.redirectUrl);
  }
}
