// One of Mynt's own apps (the studio, the chat app) signs in as a pre-registered OAuth client: an operator registers
// it once with `mynt clerk first-party <name> <redirect-uri>`, which turns Clerk's consent screen off for it, and
// puts its client id and secret in the app's environment. The app then never registers itself dynamically. Without
// both settings it registers itself as before (and its users see Clerk's consent screen).
//
// The secret is used only on the server, at the token endpoint; it's never logged or sent to the browser.
// MYNT_OAUTH_ISSUER (optional) binds the client to one authorization server: if Mynt's metadata ever names another,
// sign-in and refresh stop instead of sending the secret there.

export interface PreRegisteredClient {
  client_id: string;
  client_secret: string;
  issuer?: string;
}

export function preRegisteredClientFromEnv(env: Record<string, string | undefined> = process.env): PreRegisteredClient | null {
  const client_id = env.MYNT_OAUTH_CLIENT_ID?.trim() || "";
  const client_secret = env.MYNT_OAUTH_CLIENT_SECRET?.trim() || "";
  const issuer = env.MYNT_OAUTH_ISSUER?.trim() || "";
  if (!client_id && !client_secret) {
    if (issuer) throw new Error("MYNT_OAUTH_ISSUER is set without MYNT_OAUTH_CLIENT_ID and MYNT_OAUTH_CLIENT_SECRET");
    return null;
  }
  // Half a setting is a mistake: signing in would quietly fall back to dynamic registration.
  if (!client_id || !client_secret) throw new Error("Set both MYNT_OAUTH_CLIENT_ID and MYNT_OAUTH_CLIENT_SECRET, or neither");
  if (!issuer) return { client_id, client_secret };
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("MYNT_OAUTH_ISSUER must be the authorization server's https URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))
    throw new Error("MYNT_OAUTH_ISSUER must be the authorization server's https URL");
  return { client_id, client_secret, issuer: url.href };
}
