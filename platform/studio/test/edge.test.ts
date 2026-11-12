import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { oauthRedirectUrl } from "@/lib/config";
import {
  appUrlFor,
  clientAddress,
  connectingAddress,
  requestHost,
  resetUntrustedEdgeWarning,
  shouldGoToAppUrl,
  trustedEdges,
  viaTrustedEdge,
  warnUntrustedEdgeOnce,
} from "@/lib/rate-limit";
import { MemoryKeyValue, Sealer, SessionStore } from "@/lib/session-store";

// The studio served on Mynt's domain through Mynt's server (its host installer's --studio-upstream):
// that server is the "edge". Addresses are placeholders.
const vercel = { VERCEL: "1", TRUSTED_EDGE_IPS: "edge-a, edge-b" };
const h = (o: Record<string, string>) => new Headers(o);

describe("the caller's address behind Mynt's server", () => {
  it("trusts X-Mynt-Client-IP only from a trusted edge", () => {
    expect(clientAddress(h({ "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }), vercel)).toBe("client-x");
    expect(clientAddress(h({ "x-vercel-forwarded-for": "edge-b", "x-mynt-client-ip": "client-y" }), vercel)).toBe("client-y");
  });

  it("ignores X-Mynt-Client-IP from anyone else, so callers can't pick their bucket", () => {
    expect(clientAddress(h({ "x-vercel-forwarded-for": "someone", "x-mynt-client-ip": "client-x" }), vercel)).toBe("someone");
    expect(clientAddress(h({ "x-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }), vercel)).toBeNull(); // x-forwarded-for isn't trusted on Vercel
    expect(clientAddress(h({ "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }), { VERCEL: "1" })).toBe("edge-a"); // no edges configured
  });

  it("falls back to the edge's own address when it didn't pass one clearly", () => {
    expect(clientAddress(h({ "x-vercel-forwarded-for": "edge-a" }), vercel)).toBe("edge-a");
    expect(clientAddress(h({ "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "a, b" }), vercel)).toBe("edge-a");
  });

  it("buckets the passed address like any other (IPv6 per /64)", () => {
    expect(clientAddress(h({ "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "2001:db8:1:2:aaaa::1" }), vercel)).toBe("2001:db8:1:2::/64");
  });

  it("off Vercel, the connecting address comes from TRUSTED_PROXY_HEADER and the edge list applies to it", () => {
    const env = { TRUSTED_PROXY_HEADER: "x-real-ip", TRUSTED_EDGE_IPS: "edge-a" };
    expect(connectingAddress(h({ "x-real-ip": "edge-a" }), env)).toBe("edge-a");
    expect(viaTrustedEdge(h({ "x-real-ip": "edge-a" }), env)).toBe(true);
    expect(clientAddress(h({ "x-real-ip": "edge-a", "x-mynt-client-ip": "client-z" }), env)).toBe("client-z");
    expect(clientAddress(h({ "x-mynt-client-ip": "client-z" }), { TRUSTED_EDGE_IPS: "edge-a" })).toBeNull(); // no connecting address known
  });

  it("reads the edge list leniently (commas, spaces, case, ports)", () => {
    expect([...trustedEdges({ TRUSTED_EDGE_IPS: " Edge-A ,edge-b  edge-c" })]).toEqual(["edge-a", "edge-b", "edge-c"]);
    expect(trustedEdges({}).size).toBe(0);
  });
});

describe("an edge missing from TRUSTED_EDGE_IPS", () => {
  it("is warned about once per instance, naming its address", () => {
    resetUntrustedEdgeWarning();
    const said: string[] = [];
    const log = (m: string) => void said.push(m);
    const fromV6 = h({ "x-vercel-forwarded-for": "edge-a-v6", "x-mynt-client-ip": "client-x" });
    expect(warnUntrustedEdgeOnce(fromV6, vercel, log)).toBe(true);
    expect(warnUntrustedEdgeOnce(fromV6, vercel, log)).toBe(false); // once
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("edge-a-v6");
    expect(said[0]).toMatch(/shares one sign-in rate-limit bucket/);
    expect(said[0]).toMatch(/add this address to TRUSTED_EDGE_IPS/);
  });

  it("isn't warned about for trusted edges, requests without the header, or when no edges are set", () => {
    resetUntrustedEdgeWarning();
    const log = () => {
      throw new Error("shouldn't warn");
    };
    expect(warnUntrustedEdgeOnce(h({ "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }), vercel, log)).toBe(false);
    expect(warnUntrustedEdgeOnce(h({ "x-vercel-forwarded-for": "someone" }), vercel, log)).toBe(false);
    expect(warnUntrustedEdgeOnce(h({ "x-vercel-forwarded-for": "someone", "x-mynt-client-ip": "c" }), { VERCEL: "1" }, log)).toBe(false);
  });
});

describe("visits to the studio's own deployment address", () => {
  it("keep their path and query on APP_URL, which can't be changed by the path", () => {
    const base = new URL("https://mynt.example.com");
    expect(appUrlFor("/app-1/build-2", "?x=1", base).toString()).toBe("https://mynt.example.com/app-1/build-2?x=1");
    expect(appUrlFor("//elsewhere.example.com/x", "", base).host).toBe("mynt.example.com");
  });

  const app = "mynt.example.com";
  const at = (o: Record<string, string>) => h({ host: "studio-abc.example.com", "x-forwarded-host": "studio-abc.example.com", ...o });
  it("without X-Mynt-Client-IP, from any address that isn't a trusted edge: go to APP_URL", () => {
    expect(shouldGoToAppUrl(at({ "x-vercel-forwarded-for": "someone" }), vercel, app)).toBe(true);
    expect(shouldGoToAppUrl(at({}), vercel, app)).toBe(true); // no connecting address at all
    expect(shouldGoToAppUrl(at({ "x-forwarded-for": "edge-a" }), vercel, app)).toBe(true); // x-forwarded-for isn't trusted
  });

  it("with X-Mynt-Client-IP from an untrusted address (a server address missing from the list, or a forger): served, so it can't loop", () => {
    expect(shouldGoToAppUrl(at({ "x-vercel-forwarded-for": "edge-a-v6", "x-mynt-client-ip": "client-x" }), vercel, app)).toBe(false);
    // ...and its callers are counted by the connecting address, not the header
    expect(clientAddress(at({ "x-vercel-forwarded-for": "edge-a-v6", "x-mynt-client-ip": "client-x" }), vercel)).toBe("edge-a-v6");
  });

  it("from a trusted edge, with or without its header: pass", () => {
    expect(shouldGoToAppUrl(at({ "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }), vercel, app)).toBe(false);
    expect(shouldGoToAppUrl(at({ "x-vercel-forwarded-for": "edge-b" }), vercel, app)).toBe(false);
  });

  it("already on APP_URL's host (read from x-forwarded-host on Vercel, else Host): pass", () => {
    expect(shouldGoToAppUrl(h({ "x-forwarded-host": "Mynt.Example.com", host: "internal", "x-vercel-forwarded-for": "someone" }), vercel, app)).toBe(false);
    expect(requestHost(h({ host: "mynt.example.com:443" }), {})).toBe("mynt.example.com:443");
    expect(requestHost(h({ host: "a.example.com", "x-forwarded-host": "b.example.com" }), {})).toBe("a.example.com"); // x-forwarded-host only on Vercel
    expect(requestHost(h({ host: "a.example.com", "x-forwarded-host": "b.example.com" }), { VERCEL: "1" })).toBe("b.example.com");
  });

  it("without edges configured, or off Vercel: never", () => {
    expect(shouldGoToAppUrl(at({ "x-vercel-forwarded-for": "someone" }), { VERCEL: "1" }, app)).toBe(false);
    expect(shouldGoToAppUrl(at({ "x-vercel-forwarded-for": "someone" }), { TRUSTED_EDGE_IPS: "edge-a" }, app)).toBe(false);
  });
});

describe("OAuth client registration", () => {
  const saved = process.env.APP_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = saved;
  });

  it("is kept per callback address: changing APP_URL registers again rather than reusing the old one", async () => {
    const store = new SessionStore(new MemoryKeyValue(), new Sealer(randomBytes(32)));
    process.env.APP_URL = "https://studio-abc.example.com";
    await store.saveClientInformation(oauthRedirectUrl(), { client_id: "bound-to-old-callback" });
    expect(await store.clientInformation(oauthRedirectUrl())).toEqual({ client_id: "bound-to-old-callback" });

    process.env.APP_URL = "https://mynt.example.com";
    expect(oauthRedirectUrl()).toBe("https://mynt.example.com/api/auth/callback");
    expect(await store.clientInformation(oauthRedirectUrl())).toBeUndefined(); // so the SDK registers anew

    process.env.APP_URL = "https://studio-abc.example.com";
    expect(await store.clientInformation(oauthRedirectUrl())).toEqual({ client_id: "bound-to-old-callback" });
  });
});
