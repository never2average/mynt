// Redirects and rewrites Next applies before the proxy's sign-in check (next.config.ts).
// Connect your agent is shown at /connect: the docs' page served there, and /docs/connect sends people to it.
import { adminHref, adminIdOk, adminTabOf, MOVED_TABS, movedHref, PLATFORM_BASE } from "./admin";

export const STUDIO_REDIRECTS = [{ source: "/docs/connect", destination: "/connect", permanent: false }] as const;
export const STUDIO_REWRITES = [{ source: "/connect", destination: "/docs/connect" }] as const;

// Old addresses whose new one comes from their query, which proxy.ts sends on (a temporary redirect, before the
// sign-in check). Not in STUDIO_REDIRECTS: Next's config redirects carry the old query onto the new address, so
// /admin?tab=firms&id=… would land on /platform/firms/…?tab=firms&id=….
// - The platform admin was /admin?tab=<section>&id=<id> inside the studio; it's /platform/<section>/<id> now. A section it
//   no longer has (apps, people, products) goes to /platform.
// - Workspace Settings' old E-signature tab (/settings?tab=esign) is the platform admin's Platform settings.
// - A platform admin section that moved (/platform/risks, Security & risk) goes to where it went (/platform/risk-register),
//   as does /admin?tab=risks.
// - Licences is the Regulated firms section's Licences tab now: /platform/licences, anything under it and /admin?tab=licences go
//   to /platform/firms?tab=licences.
export function legacyRedirect(pathname: string, query: URLSearchParams): string | null {
  if (pathname === "/admin" || pathname === "/admin/") {
    const went = movedHref(query.get("tab"));
    if (went) return went;
    const tab = adminTabOf(query.get("tab"));
    const id = query.get("id");
    return adminHref(tab, id && adminIdOk(tab, id) ? id : undefined);
  }
  const [, moved, under] = /^\/platform\/([a-z-]+)(?:\/(.*))?$/.exec(pathname) ?? [];
  if (moved && Object.hasOwn(MOVED_TABS, moved) && (!under || MOVED_TABS[moved].under)) return movedHref(moved);
  if (pathname === "/settings" && query.get("tab") === "esign") return `${PLATFORM_BASE}/settings`;
  return null;
}
