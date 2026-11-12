import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { resetUntrustedEdgeWarning } from "@/lib/rate-limit";

// The studio on Mynt's domain: only Mynt's server (a trusted edge) reaches the deployment;
// everyone else is sent to APP_URL, whatever the path.
const saved = { ...process.env };
beforeEach(() => {
  process.env.VERCEL = "1";
  process.env.TRUSTED_EDGE_IPS = "edge-a";
  process.env.APP_URL = "https://mynt.example.com";
  resetUntrustedEdgeWarning();
});
afterEach(() => {
  process.env = { ...saved };
});

const request = (path: string, headers: Record<string, string>, host = "studio-abc.example.com") =>
  new NextRequest(new URL(path, `https://${host}`), { headers: { host, "x-forwarded-host": host, ...headers } });

describe("proxy", () => {
  for (const path of ["/", "/app-1?tab=builds", "/api/session", "/api/chat", "/api/auth/login", "/_next/static/chunks/main.js", "/favicon.ico"]) {
    it(`sends a direct caller of ${path} (no X-Mynt-Client-IP) to the same path on APP_URL`, async () => {
      const res = await proxy(request(path, { "x-vercel-forwarded-for": "someone" }));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(new URL(path, "https://mynt.example.com").toString());
    });
  }

  it("serves Mynt's server", async () => {
    const res = await proxy(request("/api/session", { "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("serves X-Mynt-Client-IP from an untrusted address (a missing server address must not loop), with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await proxy(request("/api/session", { "x-vercel-forwarded-for": "edge-a-v6", "x-mynt-client-ip": "client-x" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      await proxy(request("/api/session", { "x-vercel-forwarded-for": "edge-a-v6", "x-mynt-client-ip": "client-y" }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("edge-a-v6");
    } finally {
      warn.mockRestore();
    }
  });

  it("serves a request whose Host is already APP_URL's, rather than redirecting it to itself", async () => {
    const res = await proxy(request("/api/session", { "x-vercel-forwarded-for": "someone" }, "mynt.example.com"));
    expect(res.status).toBe(200);
  });

  it("runs on every path, Next's assets included", async () => {
    const { config } = await import("@/proxy");
    expect(config.matcher).toEqual(["/:path*"]);
  });
});
