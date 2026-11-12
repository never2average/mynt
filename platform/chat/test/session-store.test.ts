import { describe, expect, it } from "vitest";
import { SessionOAuthProvider } from "@mynt/auth";
import { oauthClientName } from "@/lib/config";
import { SessionStore } from "@/lib/session-store";

const REDIRECT = "http://localhost:3000/api/auth/callback";

describe("SessionStore", () => {
  it("creates sessions with unguessable ids and finds them again", () => {
    const store = new SessionStore();
    const a = store.create();
    const b = store.create();
    expect(a.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.id).not.toBe(b.id);
    expect(store.get(a.id)).toBe(a);
    expect(a.history).toEqual([]);
    expect(a.transcript).toEqual([]);
  });

  it("ignores missing, malformed and unknown ids", () => {
    const store = new SessionStore();
    store.create();
    expect(store.get(undefined)).toBeUndefined();
    expect(store.get("../../etc/passwd")).toBeUndefined();
    expect(store.get("A".repeat(43))).toBeUndefined();
  });

  it("expires idle sessions and keeps active ones", () => {
    let now = 0;
    const store = new SessionStore(1000, () => now);
    const idle = store.create();
    const active = store.create();
    now = 900;
    store.get(active.id); // touch
    now = 1500;
    expect(store.get(idle.id)).toBeUndefined();
    expect(store.get(active.id)).toBe(active);
  });

  it("sweeps expired sessions when new ones are created", () => {
    let now = 0;
    const store = new SessionStore(1000, () => now);
    store.create();
    store.create();
    now = 5000;
    store.create();
    expect(store.size).toBe(1);
  });

  it("expires sessions that never sign in after a short idle time", () => {
    let now = 0;
    const store = new SessionStore(10_000, () => now, 1000);
    const signedOut = store.create();
    const signedIn = store.create();
    signedIn.tokens = { access_token: "t", token_type: "Bearer" };
    now = 1500;
    expect(store.get(signedOut.id)).toBeUndefined();
    expect(store.get(signedIn.id)).toBe(signedIn);
  });

  it("holds at most maxSessions, dropping signed-out sessions first", () => {
    let now = 0;
    const store = new SessionStore(10_000, () => now, 10_000, 2);
    const signedIn = store.create();
    signedIn.tokens = { access_token: "t", token_type: "Bearer" };
    now = 1;
    const signedOut = store.create();
    now = 2;
    const third = store.create();
    expect(store.size).toBe(2);
    expect(store.get(signedOut.id)).toBeUndefined();
    expect(store.get(signedIn.id)).toBe(signedIn);
    expect(store.get(third.id)).toBe(third);
  });

  it("rotates to a new id with the tokens and an empty chat", () => {
    const store = new SessionStore();
    const old = store.create();
    old.tokens = { access_token: "t", token_type: "Bearer" };
    old.transcript.push({ kind: "user", text: "someone else's chat" });
    old.accepted.push("p1");
    const fresh = store.rotate(old);
    expect(fresh.id).not.toBe(old.id);
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(fresh.id)).toBe(fresh);
    expect(fresh.tokens?.access_token).toBe("t");
    expect(fresh.transcript).toEqual([]);
    expect(fresh.accepted).toEqual([]);
  });

  it("destroys sessions", () => {
    const store = new SessionStore();
    const s = store.create();
    store.destroy(s.id);
    expect(store.get(s.id)).toBeUndefined();
  });
});

describe("SessionOAuthProvider", () => {
  it("keeps tokens, verifier and state in the session, and the client registration app-wide", () => {
    const store = new SessionStore();
    const s1 = store.create();
    const s2 = store.create();
    const p1 = new SessionOAuthProvider(s1, store, REDIRECT, "openid profile email", oauthClientName());
    const p2 = new SessionOAuthProvider(s2, store, REDIRECT, "openid profile email", oauthClientName());

    p1.saveClientInformation!({ client_id: "client-1" });
    expect(p2.clientInformation()).toEqual({ client_id: "client-1" });

    p1.saveCodeVerifier("verifier-1");
    p1.saveTokens({ access_token: "token-1", token_type: "Bearer" });
    expect(s1.codeVerifier).toBe("verifier-1");
    expect(p1.tokens()?.access_token).toBe("token-1");
    expect(p2.tokens()).toBeUndefined();
    expect(() => p2.codeVerifier()).toThrow(/start sign-in again/);

    const state = p1.state();
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(s1.oauthState).toBe(state);
    expect(p1.state()).not.toBe(state);
  });

  it("captures the authorization URL instead of redirecting", () => {
    const store = new SessionStore();
    const provider = new SessionOAuthProvider(store.create(), store, REDIRECT, "openid", oauthClientName());
    provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    expect(provider.authorizationUrl?.toString()).toBe("https://auth.example.com/authorize?x=1");
  });

  it("registers as a public PKCE client with this app's redirect URL", () => {
    const store = new SessionStore();
    const meta = new SessionOAuthProvider(store.create(), store, REDIRECT, "openid profile", oauthClientName()).clientMetadata;
    expect(meta.redirect_uris).toEqual([REDIRECT]);
    expect(meta.token_endpoint_auth_method).toBe("none");
    expect(meta.grant_types).toContain("authorization_code");
    expect(meta.scope).toBe("openid profile");
    expect(meta.client_name).toBe("Mynt chat (sample)");
  });

  it("invalidates exactly what it's asked to", () => {
    const store = new SessionStore();
    const s = store.create();
    const p = new SessionOAuthProvider(s, store, REDIRECT, "openid", oauthClientName());
    p.saveClientInformation!({ client_id: "c" });
    p.saveTokens({ access_token: "t", token_type: "Bearer" });
    p.saveCodeVerifier("v");

    p.invalidateCredentials("tokens");
    expect(s.tokens).toBeUndefined();
    expect(s.codeVerifier).toBe("v");
    expect(p.clientInformation()).toEqual({ client_id: "c" });

    p.invalidateCredentials("all");
    expect(s.codeVerifier).toBeUndefined();
    expect(p.clientInformation()).toBeUndefined();
  });
});
