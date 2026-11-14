import { tabOf } from "@/lib/workspace-tabs";
import { WorkspacePage } from "./workspace-page";

// Workspace (/workspace?tab=members|invitations|apps|settings): the selected workspace's details
// and its members, invitations, apps and settings.
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  return <WorkspacePage initialTab={tabOf(Array.isArray(tab) ? tab[0] : tab)} />;
}
