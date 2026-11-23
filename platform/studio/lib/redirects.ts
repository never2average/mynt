// Redirects Next applies before the proxy's sign-in check (next.config.ts), so they work for signed-out visitors.
// /connect (the old Connect your agent page) is the public docs' page now.
export const STUDIO_REDIRECTS = [{ source: "/connect", destination: "/docs/connect", permanent: false }] as const;
