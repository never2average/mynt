// Redirects and rewrites Next applies before the proxy's sign-in check (next.config.ts).
// Connect your agent is shown at /connect: the docs' page served there, and /docs/connect sends people to it.
export const STUDIO_REDIRECTS = [{ source: "/docs/connect", destination: "/connect", permanent: false }] as const;
export const STUDIO_REWRITES = [{ source: "/connect", destination: "/docs/connect" }] as const;
