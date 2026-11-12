import type Anthropic from "@anthropic-ai/sdk";
import type { TranscriptItem } from "./events";
import type { Session } from "./session-store";

// What this app keeps on a session besides sign-in (lib/session-store.ts, shared with the other
// example apps, holds that part). Never sent to the browser.
export interface AppState {
  history: Anthropic.Beta.BetaMessageParam[]; // the chat with Claude, append-only
  transcript: TranscriptItem[]; // what the user has seen, so a reload can redraw it
  accepted: string[]; // product ids the user enrolled in from this chat's cards
  sentRequests: string[]; // ids of proposed product requests the user sent to Mynt
  pendingEvents: string[]; // app events (accept, request) for Claude, sent with the next message
}

// The session cookie's name (lib/session.ts adds the __Host- prefix over https).
export const SESSION_COOKIE = "mynt_chat_sid";

// A new session's state, and a signed-in session's after sign-in: an empty chat.
export function newAppState(): AppState {
  return { history: [], transcript: [], accepted: [], sentRequests: [], pendingEvents: [] };
}

// Tells Claude about something the user did outside the chat (tapped Accept, sent a
// request). Queued and sent with the next message rather than written into the history now, so
// it can never land in the middle of a turn's tool calls.
export function queueAppEvent(session: Session, text: string): void {
  session.pendingEvents.push(`[App event, not typed by the user] ${text}`);
}
