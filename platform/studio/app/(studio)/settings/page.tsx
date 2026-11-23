import { tabOf } from "@/lib/workspace-tabs";
import { EsignSettingsPage } from "./esign-page";
import { WorkspacePage } from "./workspace-page";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Settings" };

// Settings (/settings?tab=members|invitations|apps|repositories|esign): the selected workspace's
// members, invitations, apps and repositories. /workspace and
// /members redirect here.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  const asked = Array.isArray(tab) ? tab[0] : tab;
  // E-signature (admins): Mynt's own setting, not the workspace's.
  if (asked === "esign") return <EsignSettingsPage />;
  return <WorkspacePage initialTab={tabOf(asked)} />;
}
