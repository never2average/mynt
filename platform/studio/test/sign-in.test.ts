import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Sign-in with no page in between: a signed-out visit to any page goes straight to
// /api/auth/login?next=<the page>, and the callback comes back to that page, but only to a
// relative path on this app.

// The SDK's OAuth dance, faked: login is sent to the authorization server; the callback's code
// is exchanged for tokens.
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@modelcontextprotocol/sdk/client/auth.js")>()),
  auth: async (provider: { redirectToAuthorization(u: URL): void; saveTokens(t: unknown): void; state(): string }, opts: { authorizationCode?: string }) => {
    if (opts.authorizationCode) {
      provider.saveTokens({ access_token: "t", token_type: "Bearer" });
      return "AUTHORIZED";
    }
    provider.state(); // as the SDK does: the CSRF state the callback checks
    provider.redirectToAuthorization(new URL("https://auth.example.com/authorize?x=1"));
    return "REDIRECT";
  },
}));

const { appUrlWithPath, callbackRoute, loginRoute, safeReturnPath, SessionOAuthProvider } = await import("@mynt/auth");
const { pageNeedsSignIn, signInPathFor } = await import("@/lib/page-gate");
const { MemoryKeyValue, Sealer, SessionStore } = await import("@/lib/session-store");
type Session = import("@/lib/session-store").Session;
const { randomBytes } = await import("node:crypto");

const APP = new URL("https://mynt.example.com");

describe("the return path", () => {
  it("keeps a relative path on this app, with its query", () => {
    expect(safeReturnPath("/builds", APP)).toBe("/builds");
    expect(safeReturnPath("/app-1/build-2?tab=preview", APP)).toBe("/app-1/build-2?tab=preview");
  });

  it("refuses anything that could leave the app", () => {
    for (const bad of [
      "https://evil.example.com/x",
      "//evil.example.com/x",
      "/\\evil.example.com",
      "\\\\evil.example.com",
      "javascript:alert(1)",
      "evil.example.com",
      "/x\nSet-Cookie: a=b",
      // Dot segments a URL parser collapses into a leading "//" (a host), raw or encoded.
      "/.//evil.example/x",
      "/..//evil.example",
      "/x/..//evil.example",
      "/%2e//evil.example",
      "/%2E%2E//evil.example",
      "/x/%2e%2E/y",
      "/.%2F/evil",
      "/x%2f%2fevil.example",
      "/x%5Cevil",
      // A tab or newline, which a URL parser drops.
      "/\t/evil.example",
      "/x\n/evil.example",
      "/a\tb",
      "",
      null,
      undefined,
      `/${"a".repeat(3000)}`,
    ]) {
      expect(safeReturnPath(bad, APP), String(bad)).toBe("/");
    }
  });
});

describe("redirects after sign-in", () => {
  const evil = [
    "/.//evil.example/x",
    "/..//evil.example",
    "/x/..//evil.example",
    "/%2e//evil.example",
    "/%2E%2E//evil.example",
    "/.%2F/evil",
    "/\t/evil.example",
    "//evil.example",
    "https://evil.example/",
  ];

  it("always stay on the app, whatever the path asked for", () => {
    for (const next of evil) {
      const to = appUrlWithPath(APP, next);
      expect(to.origin, next).toBe(APP.origin);
      expect(to.pathname, next).toBe("/");
    }
  });

  it("keep a good path, its query and its hash, built on the app's own URL", () => {
    expect(appUrlWithPath(APP, "/app-1/build-2?tab=x#chat").toString()).toBe("https://mynt.example.com/app-1/build-2?tab=x#chat");
    expect(appUrlWithPath(new URL("https://mynt.example.com/base"), "/new").toString()).toBe("https://mynt.example.com/new");
  });
});

describe("the page gate", () => {
  it("gates pages, not API routes, Next's assets or the sign-in error and signed-out pages", () => {
    for (const p of ["/", "/new", "/builds", "/app-1", "/app-1/build-2"]) expect(pageNeedsSignIn(p), p).toBe(true);
    for (const p of ["/api/session", "/api/auth/login", "/_next/static/x.js", "/favicon.ico", "/signin-error", "/signed-out"]) expect(pageNeedsSignIn(p), p).toBe(false);
  });

  it("sends a page to sign-in with itself as the way back", () => {
    expect(signInPathFor("/app-1/build-2", "?tab=x")).toEqual({ pathname: "/api/auth/login", search: `?next=${encodeURIComponent("/app-1/build-2?tab=x")}` });
    expect(signInPathFor("/", "")).toEqual({ pathname: "/api/auth/login", search: "" });
  });
});

describe("proxy", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.VERCEL;
    delete process.env.TRUSTED_EDGE_IPS;
    process.env.APP_URL = "http://localhost:3000";
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("sends a signed-out visit straight to sign-in, and lets a signed-in one through", async () => {
    const { proxy } = await import("@/proxy");
    const { sessionStore } = await import("@/lib/session-store");
    const { sessionCookieName } = await import("@/lib/session");

    const out = await proxy(new NextRequest("http://localhost:3000/builds?x=1"));
    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toBe(`http://localhost:3000/api/auth/login?next=${encodeURIComponent("/builds?x=1")}`);

    const s = sessionStore().create();
    s.tokens = { access_token: "t", token_type: "Bearer" };
    await sessionStore().save(s);
    const ok = await proxy(new NextRequest("http://localhost:3000/builds", { headers: { cookie: `${sessionCookieName()}=${s.id}` } }));
    expect(ok.status).toBe(200);

    const apiOut = await proxy(new NextRequest("http://localhost:3000/api/dashboard"));
    expect(apiOut.status).toBe(200); // API routes answer 401 themselves
  });
});

describe("login and callback", () => {
  // The routes from @mynt/auth, with an in-memory store and a cookie jar of one.
  function harness() {
    const store = new SessionStore(new MemoryKeyValue(), new Sealer(randomBytes(32)));
    let current: Session | undefined;
    const config = {
      myntMcpUrl: () => new URL("https://mynt.example.com/mcp"),
      appUrl: () => APP,
      oauthRedirectUrl: () => "https://mynt.example.com/api/auth/callback",
      secureCookies: () => true,
      oauthClientName: () => "Mynt Studio",
      mcpClientInfo: () => ({ name: "t", version: "0" }),
      oauthScope: () => "openid",
      authErrorPath: () => "/signin-error",
      signedOutPath: () => "/signed-out",
    };
    const sessions = {
      currentSession: async () => current,
      currentOrNewSession: async () => (current ? { session: current, isNew: false } : { session: (current = store.create()), isNew: true }),
      // A provider like createSessions makes, over this store.
      oauthProviderFor: (s: Session) => new SessionOAuthProvider(s, store, config.oauthRedirectUrl(), "openid", "Mynt Studio"),
      setSessionCookie: () => undefined,
      clearSessionCookie: () => undefined,
      fromOwnOrigin: () => true,
    };
    const deps = { config, sessions, sessionStore: () => store };
    return { store, deps, get current() { return current; }, set current(s) { current = s; } };
  }

  it("goes back to the page asked for after sign-in", async () => {
    const h = harness();
    const login = await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login?next=%2Fapp-1%2Fbuild-2%3Ftab%3Dx"));
    expect(login.headers.get("location")).toBe("https://auth.example.com/authorize?x=1");
    expect(h.current?.returnTo).toBe("/app-1/build-2?tab=x");

    const state = h.current!.oauthState!;
    const back = await callbackRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/callback?code=c&state=${state}`));
    expect(back.headers.get("location")).toBe("https://mynt.example.com/app-1/build-2?tab=x");
  });

  it("never leaves the app through dot segments, encoded or not", async () => {
    for (const next of ["/.//evil.example/x", "/..//evil.example", "/x/..//evil.example", "/%2e//evil.example"]) {
      const h = harness();
      const login = await loginRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/login?next=${encodeURIComponent(next)}`));
      expect(login.headers.get("location")).toBe("https://auth.example.com/authorize?x=1");
      const state = h.current!.oauthState!;
      const back = await callbackRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/callback?code=c&state=${state}`));
      expect(back.headers.get("location"), next).toBe("https://mynt.example.com/");

      const signedIn = harness();
      signedIn.current = signedIn.store.create();
      signedIn.current.tokens = { access_token: "t", token_type: "Bearer" };
      const direct = await loginRoute(signedIn.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/login?next=${encodeURIComponent(next)}`));
      expect(direct.headers.get("location"), next).toBe("https://mynt.example.com/");
    }
  });

  it("goes home instead of to another site", async () => {
    const h = harness();
    await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login?next=%2F%2Fevil.example.com%2Fx"));
    expect(h.current?.returnTo).toBe("/");
    const state = h.current!.oauthState!;
    const back = await callbackRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/callback?code=c&state=${state}`));
    expect(back.headers.get("location")).toBe("https://mynt.example.com/");
  });

  it("someone already signed in goes straight to the page", async () => {
    const h = harness();
    h.current = h.store.create();
    h.current.tokens = { access_token: "t", token_type: "Bearer" };
    const res = await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login?next=%2Fnew"));
    expect(res.headers.get("location")).toBe("https://mynt.example.com/new");
  });

  it("the authorization server's refusals: declining is 'cancelled'; anything else is set up wrongly, logged for an admin", async () => {
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => void errors.push(String(m)));
    try {
      const h = harness();
      await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login"));
      let state = h.current!.oauthState!;
      let res = await callbackRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/callback?error=access_denied&state=${state}`));
      expect(res.headers.get("location")).toBe("https://mynt.example.com/signin-error?auth_error=denied");
      expect(errors).toEqual([]);

      await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login"));
      state = h.current!.oauthState!;
      const description = encodeURIComponent("The OAuth 2.0 Client is not allowed to request scope 'openid'.\n\u0007" + "x".repeat(1000));
      res = await callbackRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/callback?error=invalid_scope&error_description=${description}&state=${state}&code=secretcode`));
      expect(res.headers.get("location")).toBe("https://mynt.example.com/signin-error?auth_error=config");
      expect(errors.length).toBe(1);
      expect(errors[0]).toMatch(/invalid_scope: The OAuth 2\.0 Client is not allowed to request scope 'openid'\./);
      expect(errors[0]).not.toMatch(/[\u0000-\u001f]/);
      expect(errors[0].length).toBeLessThan(450);
      expect(errors[0]).not.toContain(state);
      expect(errors[0]).not.toContain("secretcode");
      for (const code of ["invalid_client", "invalid_request", "server_error", "unauthorized_client"]) {
        await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login"));
        const r = await callbackRoute(h.deps as never)(new NextRequest(`https://mynt.example.com/api/auth/callback?error=${code}&state=${h.current!.oauthState}`));
        expect(r.headers.get("location"), code).toBe("https://mynt.example.com/signin-error?auth_error=config");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("the sign-in error page names the set-up problem", async () => {
    const { default: Page } = await import("@/app/signin-error/page");
    const el = await Page({ searchParams: Promise.resolve({ auth_error: "config" }) });
    expect(JSON.stringify(el)).toContain("Sign-in isn't set up correctly on Mynt's side. Please tell your admin.");
  });

  it("a failed sign-in lands on the error page, which isn't gated (no loop)", async () => {
    const h = harness();
    await loginRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/login"));
    const res = await callbackRoute(h.deps as never)(new NextRequest("https://mynt.example.com/api/auth/callback?code=c&state=wrong"));
    expect(res.headers.get("location")).toBe("https://mynt.example.com/signin-error?auth_error=state");
    expect(pageNeedsSignIn("/signin-error")).toBe(false);
  });
});
