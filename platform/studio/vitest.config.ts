import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  // Tests never need the app's Tailwind build (components import CSS, e.g. assistant-ui's markdown).
  css: { postcss: {} },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    // Fumadocs ships ESM that imports next/navigation without an extension (as Next's bundler allows): run it
    // through Vite, so it resolves (and the tests' mocks of next/navigation reach it).
    server: { deps: { inline: [/fumadocs-(core|ui)/] } },
  },
});
