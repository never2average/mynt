import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app is one of the repository's npm workspaces: its dependencies are installed at the
  // repository root, and the sign-in code is the @mynt/auth workspace package (TypeScript source).
  turbopack: { root: fileURLToPath(new URL("../..", import.meta.url)) },
  transpilePackages: ["@mynt/auth"],
  // Run these from node_modules on the server rather than bundling them.
  serverExternalPackages: ["@modelcontextprotocol/sdk", "@anthropic-ai/vertex-sdk", "google-auth-library"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
