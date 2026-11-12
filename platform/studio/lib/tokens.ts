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

// A fetch for one refresh: all of its requests (discovery and the token request) share one
// deadline, so the whole refresh ends within REFRESH_TIMEOUT_MS, inside the lock's TTL.
export function deadlineFetch(ms = REFRESH_TIMEOUT_MS, base: typeof fetch = fetch): typeof fetch {
  const signal = AbortSignal.timeout(ms);
  return (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal });
}

// An issuer as a comparable string: the URL's canonical form, without trailing slashes.
export function normalIssuer(value: string): string {
  try {
    return new URL(value).href.replace(/\/+$/, "");
  } catch {
    return value.replace(/\/+$/, "");
  }
}

type WithIssuer = { issuer?: unknown };
const issuerOf = (v: unknown): string | undefined => {
  const i = (v as WithIssuer | undefined)?.issuer;
  return typeof i === "string" && i ? i : undefined;
};

// One refresh with the stored refresh token, straight against the authorization server.
//
// Tokens and the client registration are bound to the authorization server that issued them:
// if discovery now names another one, the refresh token isn't sent there, and the user signs in
// again.
export async function refreshWithMynt(
  session: Session,
  store: SessionStore,
  deps: { discover?: typeof discoverOAuthServerInfo; refreshAuth?: typeof refreshAuthorization; fetchFn?: typeof fetch } = {},
): Promise<void> {
  const refreshToken = session.tokens?.refresh_token;
  if (!refreshToken) return;
  const discover = deps.discover ?? discoverOAuthServerInfo;
  const refreshAuth = deps.refreshAuth ?? refreshAuthorization;
  const fetchFn = deps.fetchFn ?? deadlineFetch();
  const client = await store.clientInformation(oauthRedirectUrl());
  if (!client) {
    session.tokens = undefined; // no registration to refresh with: sign in again
    throw new NotSignedInError();
  }
  let issuer: string;
  try {
    const server = await discover(myntMcpUrl(), { fetchFn });
    issuer = normalIssuer(String(server.authorizationServerUrl));
    const boundTo = issuerOf(session.tokens) ?? issuerOf(client);
    if (boundTo && normalIssuer(boundTo) !== issuer) {
      session.tokens = undefined;
      throw new NotSignedInError();
    }
    const resource = server.resourceMetadata?.resource ? new URL(server.resourceMetadata.resource) : resourceUrlFromServerUrl(myntMcpUrl());
    const tokens = await refreshAuth(server.authorizationServerUrl, {
      metadata: server.authorizationServerMetadata,
      clientInformation: client,
      refreshToken,
      resource,
      fetchFn,
    });
    session.tokens = { ...tokens, issuer } as typeof tokens;
  } catch (err) {
    if (err instanceof NotSignedInError) throw err;
    if (err instanceof InvalidGrantError || err instanceof InvalidClientError) {
      session.tokens = undefined;
      throw new NotSignedInError();
    }
    throw new RefreshFailedError(err instanceof Error ? err.name : "refresh failed");
  }
  // The registration learns which server it belongs to the first time it's used.
  if (!issuerOf(client)) await store.saveClientInformation(oauthRedirectUrl(), { ...client, issuer } as typeof client).catch(() => undefined);
}

// Connects to Mynt as the session's user, with fresh tokens.
export async function connectStudio(session: Session): Promise<Client> {
  await ensureFreshTokens(session);
  return connectMynt(session);
}
