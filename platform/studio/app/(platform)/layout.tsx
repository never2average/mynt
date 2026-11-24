import type { Metadata } from "next";

import { PlatformShell } from "@/components/platform-shell";
import { PLATFORM_NAME } from "@/lib/admin";
import { requireAdminPage } from "@/lib/admin-server";

// The platform admin (/platform), in its own layout: not the studio's shell (no studio sidebar, no workspace
// switcher, no app folders), but its own sidebar of the nine sections (components/platform-shell.tsx). Only for Mynt
// admins: anyone else gets the 404 page, and each page checks again. Tab titles: "<section> · Mynt platform admin".
export const metadata: Metadata = { title: { default: PLATFORM_NAME, template: `%s · ${PLATFORM_NAME}` } };
export const dynamic = "force-dynamic";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  await requireAdminPage();
  return <PlatformShell>{children}</PlatformShell>;
}
