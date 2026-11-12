import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Mynt's live preview while its agents code (scripts/dev_preview.sh sets MYNT_LIVE_PREVIEW): the dev server on
// 127.0.0.1:5173 behind the sandbox host's HTTPS forwarder, which serves it at a private, unguessable name. So it
// takes any host name, hot reload connects back over the forwarder's port 443, and Vite's cache lives outside the
// app (MYNT_VITE_CACHE), never in the source Mynt packages. Without it, Vite keeps its defaults: localhost only,
// and only localhost host names.
const live = process.env.MYNT_LIVE_PREVIEW === "1";

// In dev, /api goes to the api service; in Compose and on Mynt, the web server proxies it the same way.
export default defineConfig({
  plugins: [react()],
  ...(live ? { cacheDir: process.env.MYNT_VITE_CACHE || "/tmp/mynt-vite-cache" } : {}),
  server: {
    port: live ? 5173 : 8080,
    proxy: { "/api": "http://localhost:3000" },
    ...(live ? { host: "127.0.0.1", strictPort: true, allowedHosts: true, hmr: { protocol: "wss", clientPort: 443 } } : {}),
  },
});
