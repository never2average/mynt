// One of Mynt's own apps (the studio, the chat app) signs in as a pre-registered OAuth client: an operator registers
// it once with `mynt clerk first-party <name> <redirect-uri>`, which turns Clerk's consent screen off for it, and
// puts its client id and secret in the app's environment. The app then never registers itself dynamically. Without
// both settings it registers itself as before (and its users see Clerk's consent screen).
//
// The secret is used only on the server, at the token endpoint; it's never logged or sent to the browser.

export interface PreRegisteredClient {
  client_id: string;
  client_secret: string;
}

export function preRegisteredClientFromEnv(env: Record<string, string | undefined> = process.env): PreRegisteredClient | null {
  const client_id = env.MYNT_OAUTH_CLIENT_ID?.trim() || "";
  const client_secret = env.MYNT_OAUTH_CLIENT_SECRET?.trim() || "";
  if (!client_id && !client_secret) return null;
  // Half a setting is a mistake: signing in would quietly fall back to dynamic registration.
  if (!client_id || !client_secret) throw new Error("Set both MYNT_OAUTH_CLIENT_ID and MYNT_OAUTH_CLIENT_SECRET, or neither");
  return { client_id, client_secret };
}
