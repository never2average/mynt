import { randomBytes } from "node:crypto";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type Anthropic from "@anthropic-ai/sdk";
import type { TranscriptItem } from "./events";

// Everything the server keeps for one browser. None of it is ever sent to the browser: the
// browser only holds the random session id in an httpOnly cookie.
export interface Session {
  id: string;
  createdAt: number;
  lastSeen: number;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  oauthState?: string; // CSRF check between /api/auth/login and /api/auth/callback
  history: Anthropic.Beta.BetaMessageParam[]; // the chat with Claude, append-only
  transcript: TranscriptItem[]; // what the user has seen, so a reload can redraw it
  accepted: string[]; // product ids the user enrolled in from this chat's cards
  sentRequests: string[]; // ids of proposed product requests the user sent to Mynt
  pendingEvents: string[]; // app events (accept, request) for Claude, sent with the next message
  busy?: boolean; // one chat turn, accept or request at a time per session
  userId?: string; // the signed-in Mynt user (from whoami), for the daily message cap
  roles?: string[]; // their effective Mynt roles (from whoami), refreshed when /developer loads
}

export const SESSION_COOKIE = "mynt_chat_sid";
const SESSION_ID = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

// A server-side session store.
//
// This sample keeps sessions in memory: they're lost on restart and aren't shared between
// processes, so run a single instance. A real deployment would put them in Redis or a database
// (encrypting the OAuth tokens at rest) behind the same small interface.
//
// Anyone can create a session by starting sign-in, so sessions that never finish signing in
// expire quickly, and the store holds at most `maxSessions`, dropping signed-out ones first.
export class SessionStore {
  private sessions = new Map<string, Session>();
  // Dynamic client registration happens once per app (per redirect URL), not per user.
  private clients = new Map<string, OAuthClientInformationMixed>();

  constructor(
    private ttlMs = 7 * 24 * 60 * 60 * 1000,
    private now: () => number = Date.now,
    private signedOutTtlMs = 10 * 60 * 1000,
    private maxSessions = 10_000,
  ) {}

  create(): Session {
    this.sweep();
    while (this.sessions.size >= this.maxSessions) this.evictOne();
    const id = randomBytes(32).toString("base64url");
    const t = this.now();
    const session: Session = { id, createdAt: t, lastSeen: t, history: [], transcript: [], accepted: [], sentRequests: [], pendingEvents: [] };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string | undefined): Session | undefined {
    if (!id || !SESSION_ID.test(id)) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (this.expired(session, this.now())) {
      this.sessions.delete(id);
      return undefined;
    }
    session.lastSeen = this.now();
    return session;
  }

  // After sign-in: a new id holding the old session's tokens, with an empty chat. The old id
  // stops working, so a session id planted before sign-in is useless after it.
  rotate(old: Session): Session {
    const fresh = this.create();
    fresh.tokens = old.tokens;
    this.destroy(old.id);
    return fresh;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  clientInformation(redirectUrl: string): OAuthClientInformationMixed | undefined {
    return this.clients.get(redirectUrl);
  }

  saveClientInformation(redirectUrl: string, info: OAuthClientInformationMixed): void {
    this.clients.set(redirectUrl, info);
  }

  forgetClient(redirectUrl: string): void {
    this.clients.delete(redirectUrl);
  }

  get size(): number {
    return this.sessions.size;
  }

  private expired(s: Session, t: number): boolean {
    return t - s.lastSeen > (s.tokens ? this.ttlMs : Math.min(this.ttlMs, this.signedOutTtlMs));
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (this.expired(s, t)) this.sessions.delete(id);
  }

  // The least recently seen signed-out session, or failing that the least recently seen one.
  private evictOne(): void {
    let victim: Session | undefined;
    for (const s of this.sessions.values()) {
      if (!victim || (!s.tokens && victim.tokens) || (!s.tokens === !victim.tokens && s.lastSeen < victim.lastSeen)) victim = s;
    }
    if (victim) this.sessions.delete(victim.id);
  }
}

// One store per server process. Kept on globalThis so Next's dev-mode module reloads don't
// drop everyone's session.
const globalStore = globalThis as typeof globalThis & { __myntChatSessions?: SessionStore };
export function sessionStore(): SessionStore {
  globalStore.__myntChatSessions ??= new SessionStore();
  return globalStore.__myntChatSessions;
}
