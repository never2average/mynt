import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PlatformSection } from "@/components/platform-view";
import { ADMIN_TAB_LABELS, PLATFORM_BASE, platformRouteOf } from "@/lib/admin";
import { requireAdminPage } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ section: string; id: string }> };
const routeOf = async (params: Props["params"]) => {
  const { section, id } = await params;
  return platformRouteOf(`${PLATFORM_BASE}/${encodeURIComponent(section)}/${encodeURIComponent(id)}`);
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const route = await routeOf(params);
  return route ? { title: ADMIN_TAB_LABELS[route.tab] } : {};
}

// One workspace, app or firm, opened from its section's list (/platform/workspaces/<id>, /apps/<id>, /firms/<id>).
// Mynt admins only, else 404; so is any other section with an id, or an id that isn't letters, digits and dashes.
export default async function Page({ params }: Props) {
  await requireAdminPage();
  const route = await routeOf(params);
  if (!route?.id) notFound();
  return <PlatformSection key={`${route.tab}:${route.id}`} tab={route.tab} id={route.id} />;
}
