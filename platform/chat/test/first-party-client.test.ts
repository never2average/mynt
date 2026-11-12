import { afterEach, describe, expect, it } from "vitest";
import { auth } from "@modelcontextprotocol/sdk/client/auth.js";
import { preRegisteredClientFromEnv, SessionOAuthProvider } from "@mynt/auth";
import { oauthClient, oauthClientName } from "@/lib/config";
import { SessionStore } from "@/lib/session-store";

const REDIRECT = "http://localhost:3000/api/auth/callback";
const MCP = new URL("https://mynt.example.com/mcp");
const CLIENT = { client_id: "first-party-id", client_secret: "first-party-secret" };

// Mynt and its authorization server, as far as the MCP SDK's sign-in reaches them. Records every request.
function fakeServers(authMethods: string[]) {
  const calls: { url: string; method: string; headers: Headers; body: string }[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: String(init?.body ?? "") });
    const path = new URL(url).pathname;
    if (url.startsWith("https://mynt.example.com/.well-known/oauth-protected-resource"))
      return json({ resource: MCP.href, authorization_servers: ["https://auth.example.com"] });
    if (url.startsWith("https://auth.example.com/.well-known/oauth-authorization-server"))
      return json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: authMethods,
      });
    if (path === "/register") return json({ client_id: "dynamic-id", redirect_uris: [REDIRECT] });
    if (path === "/token") return json({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchFn };
}

const ENV = ["MYNT_OAUTH_CLIENT_ID", "MYNT_OAUTH_CLIENT_SECRET", "MYNT_OAUTH_ISSUER"] as const;
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe("the pre-registered client setting", () => {
  it("is both values, neither, or an error", () => {
    expect(preRegisteredClientFromEnv({})).toBeNull();
    expect(preRegisteredClientFromEnv({ MYNT_OAUTH_CLIENT_ID: " id ", MYNT_OAUTH_CLIENT_SECRET: " secret\n" })).toEqual({
      client_id: "id",
      client_secret: "secret",
    });
    expect(() => preRegisteredClientFromEnv({ MYNT_OAUTH_CLIENT_ID: "id" })).toThrow(/both/);
    expect(() => preRegisteredClientFromEnv({ MYNT_OAUTH_CLIENT_SECRET: "secret" })).toThrow(/both/);
  });

  it("takes an optional issuer, as a normalised https URL, only with the client", () => {
    const both = { MYNT_OAUTH_CLIENT_ID: "id", MYNT_OAUTH_CLIENT_SECRET: "secret" };
    expect(preRegisteredClientFromEnv({ ...both, MYNT_OAUTH_ISSUER: "https://Auth.example.com" })).toEqual({
      client_id: "id",
      client_secret: "secret",
      issuer: "https://auth.example.com/",
    });
    expect(() => preRegisteredClientFromEnv({ ...both, MYNT_OAUTH_ISSUER: "http://auth.example.com" })).toThrow(/https/);
    expect(() => preRegisteredClientFromEnv({ ...both, MYNT_OAUTH_ISSUER: "auth.example.com" })).toThrow(/https/);
    expect(() => preRegisteredClientFromEnv({ MYNT_OAUTH_ISSUER: "https://auth.example.com" })).toThrow(/without/);
  });

  it("the error names the settings, never the value", () => {
    try {
      preRegisteredClientFromEnv({ MYNT_OAUTH_CLIENT_SECRET: "do-not-show" });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("do-not-show");
    }
  });

  it("is read by this app's config from its environment", () => {
    expect(oauthClient()).toBeNull();
    process.env.MYNT_OAUTH_CLIENT_ID = CLIENT.client_id;
    process.env.MYNT_OAUTH_CLIENT_SECRET = CLIENT.client_secret;
    expect(oauthClient()).toEqual(CLIENT);
  });
});

describe("signing in with a pre-registered client", () => {
  it("returns that client, and never saves or forgets a registration in the store", () => {
    const store = new SessionStore();
    const s = store.create();
    const p = new SessionOAuthProvider(s, store, REDIRECT, "openid", oauthClientName(), CLIENT);
    expect(p.clientInformation()).toEqual(CLIENT);
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("client_secret_basic");

    // No save hook at all: the SDK can't swap it for a dynamic registration.
    expect(p.saveClientInformation).toBeUndefined();

    store.saveClientInformation(REDIRECT, { client_id: "left-over" });
    p.saveTokens({ access_token: "t", token_type: "Bearer" });
    p.invalidateCredentials("all");
    expect(s.tokens).toBeUndefined();
    expect(store.clientInformation(REDIRECT)).toEqual({ client_id: "left-over" });
    expect(p.clientInformation()).toEqual(CLIENT);
  });

  it("never registers; the secret goes only to the token endpoint, in Basic auth when the server offers it", async () => {
    const { calls, fetchFn } = fakeServers(["client_secret_basic", "client_secret_post", "none"]);
    const store = new SessionStore();
    const s = store.create();
    const p = new SessionOAuthProvider(s, store, REDIRECT, "openid", oauthClientName(), CLIENT);

    expect(await auth(p, { serverUrl: MCP, fetchFn })).toBe("REDIRECT");
    expect(calls.some((c) => c.url.endsWith("/register"))).toBe(false);
    expect(p.authorizationUrl?.searchParams.get("client_id")).toBe(CLIENT.client_id);
    expect(p.authorizationUrl?.href).not.toContain(CLIENT.client_secret);

    expect(await auth(p, { serverUrl: MCP, fetchFn, authorizationCode: "code" })).toBe("AUTHORIZED");
    const token = calls.find((c) => c.url.endsWith("/token"))!;
    expect(token.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT.client_id}:${CLIENT.client_secret}`)}`);
    expect(token.body).not.toContain(CLIENT.client_secret);
    expect(calls.filter((c) => c !== token).every((c) => !c.body.includes(CLIENT.client_secret) && !c.url.includes(CLIENT.client_secret))).toBe(true);
    expect(s.tokens?.access_token).toBe("access");
    expect(store.clientInformation(REDIRECT)).toBeUndefined();
  });

  it("sends the secret in the form body when the server only takes client_secret_post", async () => {
    const { calls, fetchFn } = fakeServers(["client_secret_post"]);
    const store = new SessionStore();
    const p = new SessionOAuthProvider(store.create(), store, REDIRECT, "openid", oauthClientName(), CLIENT);
    await auth(p, { serverUrl: MCP, fetchFn });
    await auth(p, { serverUrl: MCP, fetchFn, authorizationCode: "code" });
    const token = calls.find((c) => c.url.endsWith("/token"))!;
    expect(token.headers.get("authorization")).toBeNull();
    const form = new URLSearchParams(token.body);
    expect(form.get("client_id")).toBe(CLIENT.client_id);
    expect(form.get("client_secret")).toBe(CLIENT.client_secret);
  });
});

describe("a pre-registered client bound to its authorization server (MYNT_OAUTH_ISSUER)", () => {
  it("signs in when Mynt names that server", async () => {
    const { calls, fetchFn } = fakeServers(["client_secret_basic"]);
    const store = new SessionStore();
    const s = store.create();
    const bound = { ...CLIENT, issuer: "https://auth.example.com/" };
    const p = new SessionOAuthProvider(s, store, REDIRECT, "openid", oauthClientName(), bound);
    expect(p.clientInformation()).toEqual(bound);
    expect(await auth(p, { serverUrl: MCP, fetchFn })).toBe("REDIRECT");
    expect(await auth(p, { serverUrl: MCP, fetchFn, authorizationCode: "code" })).toBe("AUTHORIZED");
    expect(calls.some((c) => c.url.endsWith("/register"))).toBe(false);
    expect(s.tokens?.access_token).toBe("access");
  });

  it("refuses, without registering or sending the secret, when Mynt names another server", async () => {
    const { calls, fetchFn } = fakeServers(["client_secret_basic", "client_secret_post"]);
    const store = new SessionStore();
    const s = store.create();
    const p = new SessionOAuthProvider(s, store, REDIRECT, "openid", oauthClientName(), { ...CLIENT, issuer: "https://elsewhere.example/" });
    await expect(auth(p, { serverUrl: MCP, fetchFn })).rejects.toThrow(/bound to authorization server/);
    s.codeVerifier = "v";
    await expect(auth(p, { serverUrl: MCP, fetchFn, authorizationCode: "code" })).rejects.toThrow(/bound to authorization server/);
    expect(calls.some((c) => c.url.endsWith("/register") || c.url.endsWith("/token"))).toBe(false);
    expect(calls.every((c) => !c.body.includes(CLIENT.client_secret) && !c.headers.get("authorization"))).toBe(true);
    expect(p.authorizationUrl).toBeUndefined();
    expect(s.tokens).toBeUndefined();
  });
});

describe("signing in without one", () => {
  it("registers dynamically as a public client, as before, and keeps the registration app-wide", async () => {
    const { calls, fetchFn } = fakeServers(["client_secret_basic", "none"]);
    const store = new SessionStore();
    const s = store.create();
    const p = new SessionOAuthProvider(s, store, REDIRECT, "openid", oauthClientName());
    expect(p.clientMetadata.token_endpoint_auth_method).toBe("none");

    expect(await auth(p, { serverUrl: MCP, fetchFn })).toBe("REDIRECT");
    const register = calls.find((c) => c.url.endsWith("/register"))!;
    expect(JSON.parse(register.body).token_endpoint_auth_method).toBe("none");
    expect(store.clientInformation(REDIRECT)).toMatchObject({ client_id: "dynamic-id" });
    expect(p.authorizationUrl?.searchParams.get("client_id")).toBe("dynamic-id");

    await auth(p, { serverUrl: MCP, fetchFn, authorizationCode: "code" });
    const token = calls.find((c) => c.url.endsWith("/token"))!;
    expect(token.headers.get("authorization")).toBeNull();
    expect(new URLSearchParams(token.body).get("client_secret")).toBeNull();
    expect(s.tokens?.access_token).toBe("access");
  });
});
