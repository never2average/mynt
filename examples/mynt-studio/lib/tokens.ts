import { discoverOAuthServerInfo, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import { InvalidClientError, InvalidGrantError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { myntMcpUrl, oauthRedirectUrl } from "./config";
import { connectMynt, NotSignedInError } from "./mynt-client";
import { sessionStore, type Session, type SessionStore } from "./session-store";

// Refreshing an OAuth token spends its refresh token. If two requests from one browser
// refreshed at once with the same refresh token, the authorization server would reject the
// second (refresh tokens rotate) and sign the user out. So the studio refreshes ahead of
// expiry, before connecting, one request at a time per session (a short lock in the store);
// the others wait and pick up the new tokens.
//
// Only the authorization server saying the refresh token or the client is no longer valid
// signs the user out. Anything else (a timeout, a 5xx, a network error) keeps the tokens and
// fails this request, so a passing outage never signs anyone out.

const EARLY_MS = 60_000; // refresh this long before the access token expires
const WAIT_MS = 8_000;
const STEP_MS = 250;
export const REFRESH_TIMEOUT_MS = 10_000;

export class RefreshFailedError extends Error {}

export function expiresSoon(session: Session, now = Date.now()): boolean {
  const lifetime = session.tokens?.expires_in;
  if (!session.tokens?.refresh_token || typeof lifetime !== "number" || session.tokensAt === undefined) return false;
  return session.tokensAt + lifetime * 1000 - now < EARLY_MS;
}

export async function ensureFreshTokens(
  session: Session,
  opts: { store?: SessionStore; refresh?: (s: Session) => Promise<void>; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const store = opts.store ?? sessionStore();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const refresh = opts.refresh ?? ((s: Session) => refreshWithMynt(s, store));
  if (!expiresSoon(session, now())) return;

  for (let waited = 0; waited <= WAIT_MS; waited += STEP_MS) {
    const release = await store.lock(session.id, "refresh", Math.ceil((REFRESH_TIMEOUT_MS + 5_000) / 1000));
    if (release) {
      try {
        await store.reloadTokens(session); // another request may have just refreshed
        if (expiresSoon(session, now())) {
          try {
            await refresh(session);
          } finally {
            await store.save(session); // new tokens, or a sign-out the server asked for
          }
        }
      } finally {
        await release();
      }
      return;
    }
    await sleep(STEP_MS);
    await store.reloadTokens(session);
    if (!expiresSoon(session, now())) return;
  }
  // Nobody finished refreshing in time: carry on; Mynt answers 401 if the token is stale.
}

// A fetch that gives up after REFRESH_TIMEOUT_MS.
const timedFetch: typeof fetch = (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) });

// One refresh with the stored refresh token, straight against the authorization server.
export async function refreshWithMynt(
  session: Session,
  store: SessionStore,
  deps: { discover?: typeof discoverOAuthServerInfo; refreshAuth?: typeof refreshAuthorization } = {},
): Promise<void> {
  const refreshToken = session.tokens?.refresh_token;
  if (!refreshToken) return;
  const discover = deps.discover ?? discoverOAuthServerInfo;
  const refreshAuth = deps.refreshAuth ?? refreshAuthorization;
  const client = await store.clientInformation(oauthRedirectUrl());
  if (!client) {
    session.tokens = undefined; // no registration to refresh with: sign in again
    throw new NotSignedInError();
  }
  try {
    const server = await discover(myntMcpUrl(), { fetchFn: timedFetch });
    const resource = server.resourceMetadata?.resource ? new URL(server.resourceMetadata.resource) : resourceUrlFromServerUrl(myntMcpUrl());
    const tokens = await refreshAuth(server.authorizationServerUrl, {
      metadata: server.authorizationServerMetadata,
      clientInformation: client,
      refreshToken,
      resource,
      fetchFn: timedFetch,
    });
    session.tokens = tokens;
  } catch (err) {
    if (err instanceof InvalidGrantError || err instanceof InvalidClientError) {
      session.tokens = undefined;
      throw new NotSignedInError();
    }
    throw new RefreshFailedError(err instanceof Error ? err.name : "refresh failed");
  }
}

// Connects to Mynt as the session's user, with fresh tokens.
export async function connectStudio(session: Session): Promise<Client> {
  await ensureFreshTokens(session);
  return connectMynt(session);
}
