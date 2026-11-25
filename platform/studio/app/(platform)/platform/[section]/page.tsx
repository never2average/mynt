import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PlatformSection } from "@/components/platform-view";
import { ADMIN_TAB_LABELS, PLATFORM_BASE, platformRouteOf } from "@/lib/admin";
import { requireAdminPage } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ section: string }> };
const routeOf = async (params: Props["params"]) => platformRouteOf(`${PLATFORM_BASE}/${encodeURIComponent((await params).section)}`);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const route = await routeOf(params);
  return route ? { title: ADMIN_TAB_LABELS[route.tab] } : {};
}

// A section of the platform admin (/platform/workspaces, /firms, /vendors, /audit, /risk-models, /risk-register, /settings).
// Mynt admins only, else 404; so is a section that isn't one. Firms has its own tabs in the page (?tab=firms or
// ?tab=licences, read by components/platform-view.tsx); the old /platform/licences is sent there by proxy.ts.
export default async function Page({ params }: Props) {
  await requireAdminPage();
  const route = await routeOf(params);
  if (!route || route.tab === "overview" || route.id) notFound();
  return <PlatformSection tab={route.tab} id={null} />;
}
