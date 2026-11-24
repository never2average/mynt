import type { Metadata } from "next";

import { PlatformSection } from "@/components/platform-view";
import { PLATFORM_NAME } from "@/lib/admin";
import { requireAdminPage } from "@/lib/admin-server";

export const metadata: Metadata = { title: { absolute: PLATFORM_NAME } };
export const dynamic = "force-dynamic";

// The platform admin's Overview (/platform): what needs attention across Mynt. Mynt admins only, else 404.
export default async function Page() {
  await requireAdminPage();
  return <PlatformSection tab="overview" id={null} />;
}
