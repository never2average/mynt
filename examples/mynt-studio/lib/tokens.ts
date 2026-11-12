import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { myntMcpUrl, oauthScope } from "./config";
import { connectMynt, NotSignedInError } from "./mynt-client";
import { oauthProviderFor } from "./session";
import { sessionStore, type Session, type SessionStore } from "./session-store";

// Refreshing an OAuth token spends its refresh token. If two requests from one browser
// refreshed at once with the same refresh token, the authorization server would reject the
// second (refresh tokens rotate) and sign the user out. So the studio refreshes ahead of
// expiry, before connecting, one request at a time per session (a short lock in the store);
// the others wait and pick up the new tokens.

const EARLY_MS = 60_000; // refresh this long before the access token expires
const WAIT_MS = 8_000;
const STEP_MS = 250;

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
  const refresh = opts.refresh ?? refreshWithMynt;
  if (!expiresSoon(session, now())) return;

  for (let waited = 0; waited <= WAIT_MS; waited += STEP_MS) {
    const release = await store.lock(session.id, "refresh");
    if (release) {
      try {
        await store.reloadTokens(session); // another request may have just refreshed
        if (expiresSoon(session, now())) {
          await refresh(session);
          await store.save(session);
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

// The MCP SDK refreshes with the stored refresh token when it has one.
async function refreshWithMynt(session: Session): Promise<void> {
  const result = await auth(oauthProviderFor(session), { serverUrl: myntMcpUrl(), scope: oauthScope() });
  if (result !== "AUTHORIZED") {
    session.tokens = undefined;
    throw new NotSignedInError();
  }
}

// Connects to Mynt as the session's user, with fresh tokens.
export async function connectStudio(session: Session): Promise<Client> {
  await ensureFreshTokens(session);
  return connectMynt(session);
}
