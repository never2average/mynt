import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, frameSources } from "@/lib/csp";

describe("Content-Security-Policy", () => {
  it("frames only the preview origins from PREVIEW_FRAME_SRC, and nobody frames the studio", () => {
    const csp = contentSecurityPolicy("https://*.preview.example https://boxes.example:8443");
    expect(csp).toContain("frame-src https://*.preview.example https://boxes.example:8443");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("allows scripts only by the request's nonce, never inline scripts in general", () => {
    const csp = contentSecurityPolicy(undefined, false, "AAAAAAAAAAAAAAAAAAAAAA==");
    expect(csp).toContain("script-src 'self' 'nonce-AAAAAAAAAAAAAAAAAAAAAA==' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(contentSecurityPolicy(undefined)).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(() => contentSecurityPolicy(undefined, false, "x' 'unsafe-inline")).toThrow(/nonce/);
  });

  it("frames nothing when PREVIEW_FRAME_SRC is unset", () => {
    expect(contentSecurityPolicy(undefined)).toContain("frame-src 'none'");
    expect(contentSecurityPolicy("  ")).toContain("frame-src 'none'");
  });

  it("refuses sources that aren't plain https origins", () => {
    for (const bad of ["*", "https:", "http://pv.example", "https://pv.example/path", "'unsafe-inline'", "https://a.example;script-src *", "'self'"]) {
      expect(() => frameSources(bad)).toThrow(/PREVIEW_FRAME_SRC/);
    }
  });

  it("allows local http previews only in development", () => {
    expect(() => frameSources("http://localhost:5173")).toThrow();
    expect(frameSources("http://localhost:5173", true)).toEqual(["http://localhost:5173"]);
    expect(contentSecurityPolicy(undefined, true)).toContain("'unsafe-eval'");
  });
});
