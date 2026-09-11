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
  type SoldScopeResearchRow,
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

export async function loadSoldScopeOutlierSources(
  sb: Sb = getServerSupabase(),
): Promise<{ rankRows: SoldScopeRankRow[]; researchRows: SoldScopeResearchRow[] }> {
  const [ranks, research] = await Promise.all([
    selectAll(sb, "soldscope_rank_snapshots"),
    selectAll(sb, "soldscope_keyword_research"),
  ]);
  return {
    rankRows: ranks as SoldScopeRankRow[],
    researchRows: research as SoldScopeResearchRow[],
  };
}

async function pageTable(
  sb: Sb,
  table: string,
  cols: string,
  orderCol: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  try {
    let offset = 0;
    while (true) {
      const { data, error } = await sb
        .from(table)
        .select(cols)
        .in("asin", [...HERO_ASINS])
        .order(orderCol, { ascending: false })
        .range(offset, offset + 999);
      if (error) return rows;
      const page = (data ?? []) as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
      if (offset > 8000) break;
    }
  } catch { /* optional until migration */ }
  return rows;
}

export async function loadOrganicRankSources(
  sb: Sb = getServerSupabase(),
): Promise<{
  snapshots: SoldScopeRankRow[];
  sqpRows: Array<{
    asin?: string | null;
    query_normalized?: string | null;
    week_start?: string | null;
    click_share?: number | null;
    impression_share?: number | null;
    search_query_volume?: number | null;
  }>;
  korRows: Array<{
    asin?: string | null;
    keyword_normalized?: string | null;
    as_of?: string | null;
    organic_rank?: number | null;
    impression_share_organic?: number | null;
  }>;
}> {
  const RANK_COLS = [
    "asin", "phrase", "organic_position", "organic_previous_position",
    "sponsored_position", "search_volume", "aba_search_frequency_rank",
    "aba_total_click_share", "aba_total_conv_share", "as_of", "group_id",
  ].join(",");
  const RANK_COLS_BASE =
    "asin,phrase,organic_position,sponsored_position,search_volume,as_of,group_id";
  const SQP_COLS =
    "asin,query_normalized,week_start,click_share,impression_share,search_query_volume";
  const KOR_COLS =
    "asin,keyword_normalized,as_of,organic_rank,impression_share_organic";

  let snapshots: Record<string, unknown>[] = [];
  try {
    snapshots = await pageTable(sb, "soldscope_rank_snapshots", RANK_COLS, "as_of");
    if (snapshots.length === 0) {
      snapshots = await pageTable(sb, "soldscope_rank_snapshots", RANK_COLS_BASE, "as_of");
    }
  } catch { /* table optional */ }

  const [sqpRows, korRows] = await Promise.all([
    pageTable(sb, "sqp_weekly", SQP_COLS, "week_start"),
    pageTable(sb, "keyword_organic_rank", KOR_COLS, "as_of"),
  ]);

  return {
    snapshots: snapshots as SoldScopeRankRow[],
    sqpRows,
    korRows,
  };
}
