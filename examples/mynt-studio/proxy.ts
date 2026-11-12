import { NextResponse } from "next/server";
import { contentSecurityPolicy } from "./lib/csp";

// Sets the Content-Security-Policy on every response, from PREVIEW_FRAME_SRC as the server
// sees it now (not when the app was built), so changing it only needs a restart or redeploy
// of the same build. The other security headers are static (next.config.ts).
export function proxy() {
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", contentSecurityPolicy(process.env.PREVIEW_FRAME_SRC, process.env.NODE_ENV !== "production"));
  return res;
}

export const config = {
  // Pages and API routes; not Next's static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
