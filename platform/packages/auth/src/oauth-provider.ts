import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { AuthSession, AuthSessionStore } from "./types";

// The MCP SDK's OAuth hooks, backed by one server-side session.
//
// The SDK does the protocol: it reads Mynt's protected-resource metadata, finds the
// authorization server (Clerk), registers this app dynamically, and runs the authorization-code
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
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none", // a public client: PKCE, no client secret
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
    return this.store.clientInformation(this.redirectUrl);
  }

  saveClientInformation(info: OAuthClientInformationMixed) {
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
    if (scope === "all" || scope === "client") return this.store.forgetClient(this.redirectUrl);
  }
}
