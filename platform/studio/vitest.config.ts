import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  // Tests never need the app's Tailwind build (components import CSS, e.g. assistant-ui's markdown).
  css: { postcss: {} },
  test: { include: ["test/**/*.test.{ts,tsx}"], environment: "node" },
});
