import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

const request = (path: string, headers: Record<string, string>) => new NextRequest(new URL(path, "https://studio-abc.example.com"), { headers });

describe("proxy", () => {
  for (const path of ["/", "/app-1?tab=builds", "/api/session", "/api/chat", "/api/auth/login", "/_next/static/chunks/main.js", "/favicon.ico"]) {
    it(`sends a direct caller of ${path} to the same path on APP_URL`, async () => {
      const res = await proxy(request(path, { "x-vercel-forwarded-for": "someone", "x-mynt-client-ip": "forged" }));
      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe(new URL(path, "https://mynt.example.com").toString());
    });
  }

  it("lets Mynt's server through", async () => {
    const res = await proxy(request("/api/session", { "x-vercel-forwarded-for": "edge-a", "x-mynt-client-ip": "client-x" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("runs on every path, Next's assets included", async () => {
    const { config } = await import("@/proxy");
    expect(config.matcher).toEqual(["/:path*"]);
  });
});
