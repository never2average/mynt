import { redirect } from "next/navigation";
import { earnTabFromLiquidity } from "@/lib/liquidity";

// Liquidity is now Earn (/earn), on the matching tab (Open pools is Opportunities).
export default async function LiquidityPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { tab } = await searchParams;
  redirect(`/earn?tab=${earnTabFromLiquidity(Array.isArray(tab) ? tab[0] : tab)}`);
}
