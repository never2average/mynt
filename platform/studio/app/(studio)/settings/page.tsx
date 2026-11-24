import { redirect } from "next/navigation";
import { tabOf } from "@/lib/workspace-tabs";
import { WorkspacePage } from "./workspace-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

// Settings (/settings?tab=members|invitations|apps|repositories): the selected workspace's members, invitations, apps
// and repositories. /workspace and /members redirect here. E-signature is Mynt's own setting, not a workspace's: it's
// in the platform admin (/platform/settings), and its old address goes there (proxy.ts sends it first).
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  const asked = Array.isArray(tab) ? tab[0] : tab;
  if (asked === "esign") redirect("/platform/settings");
  return <WorkspacePage initialTab={tabOf(asked)} />;
}
