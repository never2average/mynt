import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { frameSources } from "./lib/csp";
import { STUDIO_REDIRECTS } from "./lib/redirects";

const dev = process.env.NODE_ENV !== "production";

// Fails the build on a malformed PREVIEW_FRAME_SRC rather than serving a broken policy. The
// policy itself is set per request, by proxy.ts.
frameSources(process.env.PREVIEW_FRAME_SRC, dev);

const nextConfig: NextConfig = {
  devIndicators: false,
  // This app is one of the repository's npm workspaces: its dependencies are installed at the
  // repository root, and the sign-in code is the @mynt/auth workspace package (TypeScript source).
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  transpilePackages: ["@mynt/auth"],
  // Run the MCP SDK from node_modules on the server rather than bundling it.
  serverExternalPackages: ["@modelcontextprotocol/sdk"],
  poweredByHeader: false,
  // Before the sign-in check runs (lib/redirects.ts), so a signed-out visitor to /connect lands on the docs.
  async redirects() {
    return STUDIO_REDIRECTS.map((r) => ({ ...r }));
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
