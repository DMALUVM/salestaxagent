/**
 * Server-only SoldScope warehouse reads. Missing tables → empty maps.
 * Service-role, read-only. No time series for a second sales desk.
 */
import { getServerSupabase } from "@/lib/supabase-server";
import {
  HERO_ASINS,
  mergeAsinIntel,
  mergeKeywordIntel,
  rankTrackerCopy,
  rankTrackerCounts,
  type SoldScopeAsinIntel,
  type SoldScopeKeywordIntel,
  type SoldScopeRankRow,
  type SoldScopeRatingRow,
  type SoldScopeSalesRow,
  type SoldScopeVolumeRow,
} from "@/lib/soldscope-status";

type Sb = ReturnType<typeof getServerSupabase>;

async function selectAll(sb: Sb, table: string): Promise<Record<string, unknown>[]> {
  try {
    const { data, error } = await sb.from(table).select("*").limit(5000);
    if (error) return [];
    return (data ?? []) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

export async function loadSoldScopeKeywordIntel(
  sb: Sb = getServerSupabase(),
): Promise<Map<string, SoldScopeKeywordIntel>> {
  const [volume, ranks] = await Promise.all([
    selectAll(sb, "soldscope_search_volume"),
    selectAll(sb, "soldscope_rank_snapshots"),
  ]);
  return mergeKeywordIntel(
    volume as SoldScopeVolumeRow[],
    ranks as SoldScopeRankRow[],
  );
}

export async function loadSoldScopeAsinIntel(
  sb: Sb = getServerSupabase(),
): Promise<Map<string, SoldScopeAsinIntel>> {
  const asins = [...HERO_ASINS];
  let ratings: SoldScopeRatingRow[] = [];
  let sales: SoldScopeSalesRow[] = [];
  try {
    const { data, error } = await sb
      .from("soldscope_ratings_history")
      .select("*")
      .in("asin", asins)
      .order("date", { ascending: false })
      .limit(500);
    if (!error) ratings = (data ?? []) as SoldScopeRatingRow[];
  } catch { /* table optional until migration */ }
  try {
    const { data, error } = await sb
      .from("soldscope_sales_history")
      .select("*")
      .in("asin", asins)
      .order("date", { ascending: false })
      .limit(30);
    if (!error) sales = (data ?? []) as SoldScopeSalesRow[];
  } catch { /* research warehouse optional */ }
  return mergeAsinIntel(ratings, sales, asins);
}

export async function loadSoldScopeRankStatus(
  sb: Sb = getServerSupabase(),
): Promise<{ groups: number; phrases: number; copy: string }> {
  const ranks = (await selectAll(sb, "soldscope_rank_snapshots")) as SoldScopeRankRow[];
  const counts = rankTrackerCounts(ranks);
  return { ...counts, copy: rankTrackerCopy(counts.groups, counts.phrases) };
}
