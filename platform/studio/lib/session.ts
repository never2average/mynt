// Sign-in sessions (@mynt/auth), with this app's settings, cookie name and session store.
import { createSessions } from "@mynt/auth";
import * as config from "./config";
import { SESSION_COOKIE } from "./app-session";
import { sessionStore, type Session } from "./session-store";

export const {
  sessionCookieName,
  currentSession,
  currentOrNewSession,
  setSessionCookie,
  clearSessionCookie,
  fromOwnOrigin,
  oauthProviderFor,
} = createSessions<Session>({ config, sessionCookie: SESSION_COOKIE, sessionStore: () => sessionStore() });
