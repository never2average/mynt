import { tabOf } from "@/lib/workspace-tabs";
import { WorkspacePage } from "./workspace-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

// Settings (/settings?tab=members|invitations|apps|repositories|general): the selected workspace's details
// and its members, invitations, apps, repositories and general settings. /workspace and
// /members redirect here.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  return <WorkspacePage initialTab={tabOf(Array.isArray(tab) ? tab[0] : tab)} />;
}
