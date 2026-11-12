// Signing in to Mynt from a Next.js app, shared by Mynt Studio and mynt-chat: OAuth with PKCE
// through the MCP SDK, a server-side session behind an httpOnly cookie, and an MCP client that
// connects as the signed-in user. Each app wires in its own settings, cookie name and session
// store in its lib/session.ts and lib/mynt-client.ts.
export type { AuthApp, AuthConfig, AuthSession, AuthSessionStore } from "./types";
export { SessionOAuthProvider } from "./oauth-provider";
export { createSessions, type Sessions } from "./session";
export { createConnectMynt, callMyntTool, NotAllowedError, NotSignedInError, type ToolOutcome } from "./mynt-client";
export { loginRoute, callbackRoute, logoutRoute, type RouteDeps } from "./routes";
