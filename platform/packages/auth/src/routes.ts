import type { Sessions } from "./session";
import type { AuthConfig, AuthSession, AuthSessionStore } from "./types";

// What the sign-in routes use. An app passes its lib/session.ts module itself (`import * as`), so
// its exports are looked up when a request comes in, as a direct import would be.
export interface RouteDeps<S extends AuthSession> {
  config: AuthConfig;
  sessions: Pick<
    Sessions<S>,
    "currentSession" | "currentOrNewSession" | "oauthProviderFor" | "setSessionCookie" | "clearSessionCookie" | "fromOwnOrigin"
  >;
  sessionStore(): AuthSessionStore<S>;
}

export { loginRoute } from "./login";
export { callbackRoute } from "./callback";
export { logoutRoute } from "./logout";
