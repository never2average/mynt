// The visual harness's build (not the app's): each studio screen rendered from the tests'
// fixtures, with the studio's own Tailwind build (app/globals.css through postcss.config.mjs).
// From platform/studio: npx vite build -c test/visual/vite.config.ts --outDir <dir>; then
// node test/visual/shoot.mjs <dir> <screenshots dir>.
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/postcss";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here("./"),
  base: "./",
  logLevel: "warn",
  resolve: {
    alias: [
      { find: /^@\//, replacement: here("../../") },
      { find: /^next\/link$/, replacement: here("./next-link.tsx") },
      { find: /^next\/navigation$/, replacement: here("./next-navigation.ts") },
    ],
    dedupe: ["react", "react-dom"],
  },
  define: { "process.env": "{}" },
  // postcss.config.mjs names the plugin as a string, which Vite can't load: the same plugin, inline.
  css: { postcss: { plugins: [tailwindcss({ base: here("../../") })] } },
  build: { emptyOutDir: true, sourcemap: false, minify: false, reportCompressedSize: false, chunkSizeWarningLimit: 100000 },
});
