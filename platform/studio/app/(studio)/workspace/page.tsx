import { redirect } from "next/navigation";
import { tabOf } from "@/lib/workspace-tabs";

// The Workspace page is now Settings (/settings), on the same tab; its old Settings tab is General.
export default async function WorkspacePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  redirect(`/settings?tab=${tabOf(Array.isArray(tab) ? tab[0] : tab)}`);
}
