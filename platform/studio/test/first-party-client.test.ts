import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { auth, type discoverOAuthServerInfo, type refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { SessionOAuthProvider } from "@mynt/auth";
import { oauthClient, oauthClientName, oauthRedirectUrl } from "@/lib/config";
import { MemoryKeyValue, Sealer, SessionStore } from "@/lib/session-store";
import { refreshWithMynt } from "@/lib/tokens";

const MCP = new URL("https://mynt.example.com/mcp");
const CLIENT = { client_id: "first-party-id", client_secret: "first-party-secret" };

function memoryStore() {
  return new SessionStore(new MemoryKeyValue(() => 0), new Sealer(randomBytes(32)), { now: () => 0 });
}

// Mynt and its authorization server, as far as the MCP SDK's sign-in reaches them. Records every request.
function fakeServers() {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
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
        token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
      });
    if (path === "/register") return json({ client_id: "dynamic-id", redirect_uris: [oauthRedirectUrl()] });
    if (path === "/token") return json({ access_token: "access", token_type: "Bearer", refresh_token: "refresh" });
    return new Response("not found", { status: 404 });
  };
  return { calls, fetchFn };
}

const ENV = ["MYNT_OAUTH_CLIENT_ID", "MYNT_OAUTH_CLIENT_SECRET", "MYNT_OAUTH_ISSUER"] as const;
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe("the studio's pre-registered client", () => {
  it("comes from MYNT_OAUTH_CLIENT_ID and MYNT_OAUTH_CLIENT_SECRET, both or neither", () => {
    expect(oauthClient()).toBeNull();
    process.env.MYNT_OAUTH_CLIENT_ID = CLIENT.client_id;
    expect(() => oauthClient()).toThrow(/both/);
    process.env.MYNT_OAUTH_CLIENT_SECRET = CLIENT.client_secret;
    expect(oauthClient()).toEqual(CLIENT);
  });

  it("signs in without registering, and nothing about the client is written to the store", async () => {
    const { calls, fetchFn } = fakeServers();
    const store = memoryStore();
    const s = store.create();
    const p = new SessionOAuthProvider(s, store, oauthRedirectUrl(), "openid", oauthClientName(), CLIENT);

    expect(await auth(p, { serverUrl: MCP, fetchFn })).toBe("REDIRECT");
    expect(await auth(p, { serverUrl: MCP, fetchFn, authorizationCode: "code" })).toBe("AUTHORIZED");
    expect(calls.some((c) => c.url.endsWith("/register"))).toBe(false);
    const token = calls.find((c) => c.url.endsWith("/token"))!;
    expect(token.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT.client_id}:${CLIENT.client_secret}`)}`);
    expect(s.tokens?.access_token).toBe("access");
    expect(await store.clientInformation(oauthRedirectUrl())).toBeUndefined();

    // A refused sign-in can't drop it either.
    await p.invalidateCredentials("client");
    expect(await p.clientInformation()).toEqual(CLIENT);
  });

  it("refreshes tokens with it although the store holds no registration", async () => {
    process.env.MYNT_MCP_URL = MCP.href;
    process.env.MYNT_OAUTH_CLIENT_ID = CLIENT.client_id;
    process.env.MYNT_OAUTH_CLIENT_SECRET = CLIENT.client_secret;
    const store = memoryStore();
    const s = store.create();
    s.tokens = { access_token: "old", refresh_token: "r-old", token_type: "Bearer", expires_in: 3600 };
    const server = { authorizationServerUrl: "https://auth.example.com", authorizationServerMetadata: undefined } as unknown as Awaited<
      ReturnType<typeof discoverOAuthServerInfo>
    >;
    let usedClient: unknown;
    const refreshAuth = (async (_url, opts) => {
      usedClient = opts.clientInformation;
      return { access_token: "new", refresh_token: "r-new", token_type: "Bearer" };
    }) as typeof refreshAuthorization;

    await refreshWithMynt(s, store, { discover: async () => server, refreshAuth });
    expect(usedClient).toEqual(CLIENT);
    expect(s.tokens?.access_token).toBe("new");
    expect(await store.clientInformation(oauthRedirectUrl())).toBeUndefined();
  });

  it("bound to an authorization server (MYNT_OAUTH_ISSUER), it refreshes only there", async () => {
    process.env.MYNT_MCP_URL = MCP.href;
    process.env.MYNT_OAUTH_CLIENT_ID = CLIENT.client_id;
    process.env.MYNT_OAUTH_CLIENT_SECRET = CLIENT.client_secret;
    process.env.MYNT_OAUTH_ISSUER = "https://auth.example.com";
    const server = (url: string) =>
      ({ authorizationServerUrl: url, authorizationServerMetadata: undefined }) as unknown as Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
    let sent = 0;
    const refreshAuth = (async () => {
      sent++;
      return { access_token: "new", refresh_token: "r-new", token_type: "Bearer" };
    }) as typeof refreshAuthorization;
    const store = memoryStore();

    // Tokens with no issuer stamp (as an older sign-in left them): the client's binding still decides.
    const s = store.create();
    s.tokens = { access_token: "old", refresh_token: "r-old", token_type: "Bearer", expires_in: 3600 };
    await expect(refreshWithMynt(s, store, { discover: async () => server("https://elsewhere.example"), refreshAuth })).rejects.toThrow();
    expect(sent).toBe(0);
    expect(s.tokens).toBeUndefined(); // signed out: sign in again

    const t = store.create();
    t.tokens = { access_token: "old", refresh_token: "r-old", token_type: "Bearer", expires_in: 3600 };
    await refreshWithMynt(t, store, { discover: async () => server("https://auth.example.com"), refreshAuth });
    expect(sent).toBe(1);
    expect(t.tokens?.access_token).toBe("new");
  });

  it("without it, refreshing still needs the stored dynamic registration", async () => {
    process.env.MYNT_MCP_URL = MCP.href;
    const store = memoryStore();
    const s = store.create();
    s.tokens = { access_token: "old", refresh_token: "r-old", token_type: "Bearer", expires_in: 3600 };
    await expect(refreshWithMynt(s, store, { discover: async () => { throw new Error("not reached"); } })).rejects.toThrow();
    expect(s.tokens).toBeUndefined(); // no registration to refresh with: sign in again
  });
});
