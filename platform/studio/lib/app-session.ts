// What this app keeps on a session besides sign-in (lib/session-store.ts, shared with the other
// example apps, holds that part). The studio stores nothing of its own yet: apps, builds and
// their previews all live in Mynt and are read through it on each request.
export type AppState = Record<never, never>;

// The session cookie's name (lib/session.ts adds the __Host- prefix over https).
export const SESSION_COOKIE = "mynt_studio_sid";

export function newAppState(): AppState {
  return {};
}
