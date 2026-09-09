import { getServerSupabase } from "@/lib/supabase-server";
import { loadSoldScopeRankStatus } from "@/lib/soldscope-load";
import {
  EMPTY_STATE_COPY,
  RT_EMPTY_COPY,
  SOLDSCOPE_OBSERVE_ONLY,
  heroList,
  summarizeFreshness,
} from "@/lib/soldscope-status";

/**
 * GET /api/soldscope — research-warehouse status for the three hero ASINs.
 *
 * Counts + last job only. No time series, no sales/BSR chart payload.
 * Missing tables → empty + setup hint. Service-role, read-only.
 */
export async function GET() {
  const heroes = heroList();
  const out: Record<string, unknown> = {
    available: false,
    observeOnly: SOLDSCOPE_OBSERVE_ONLY,
    source: "soldscope_research",
    heroes,
    empty: true,
    emptyCopy: EMPTY_STATE_COPY,
    rankTrackerCopy: RT_EMPTY_COPY,
  };

  try {
    const sb = getServerSupabase();
    const asins = heroes.map((h) => h.asin);

    const countOf = async (table: string, filterAsins = true) => {
      let q = sb.from(table).select("*", { count: "exact", head: true });
      if (filterAsins) q = q.in("asin", asins);
      const { count, error } = await q;
      if (error) {
        if (/soldscope_|does not exist|PGRST/i.test(error.message ?? "")) {
          return { missing: true as const, count: 0 };
        }
        throw error;
      }
      return { missing: false as const, count: count ?? 0 };
    };

    const newestOf = async (table: string, col: "date") => {
      const { data, error } = await sb
        .from(table)
        .select("*")
        .in("asin", asins)
        .order(col, { ascending: false })
        .limit(1);
      if (error || !data?.length) return null;
      const row = data[0] as { date?: string | null };
      return row.date != null ? String(row.date) : null;
    };

    const [sales, bsr, price, rank, ratings, volume] = await Promise.all([
      countOf("soldscope_sales_history"),
      countOf("soldscope_bsr_history"),
      countOf("soldscope_price_history"),
      countOf("soldscope_rank_snapshots"),
      countOf("soldscope_ratings_history"),
      countOf("soldscope_search_volume", false),
    ]);

    if (sales.missing && bsr.missing && price.missing) {
      out.setupHint =
        "Run supabase/migration_soldscope.sql, set SOLDSCOPE_API_TOKEN on the Mini, then wait for soldscope_weekly_sync (Sunday 10:30 ET).";
      return Response.json(out);
    }

    const newestDate =
      (await newestOf("soldscope_sales_history", "date"))
      ?? (await newestOf("soldscope_price_history", "date"))
      ?? (await newestOf("soldscope_bsr_history", "date"));

    const freshness = summarizeFreshness({
      salesRows: sales.count,
      bsrRows: bsr.count,
      priceRows: price.count,
      rankRows: rank.count,
      ratingsRows: ratings.count,
      volumeRows: volume.count,
      newestDate,
    });

    let lastJob: Record<string, unknown> | null = null;
    const job = await sb
      .from("job_runs")
      .select("job_name,status,started_at,finished_at,message")
      .eq("job_name", "soldscope_weekly_sync")
      .order("started_at", { ascending: false })
      .limit(1);
    if (!job.error && job.data?.[0]) lastJob = job.data[0];

    try {
      const rt = await loadSoldScopeRankStatus(sb);
      out.rankTrackerCopy = rt.copy;
      out.rankGroups = rt.groups;
      out.rankPhrases = rt.phrases;
    } catch {
      out.rankTrackerCopy = RT_EMPTY_COPY;
    }

    out.available = true;
    out.empty = freshness.empty;
    out.stored = freshness.stored;
    out.newestDate = freshness.newestDate;
    out.counts = {
      sales: sales.count,
      bsr: bsr.count,
      price: price.count,
      rank: rank.count,
      ratings: ratings.count,
      search_volume: volume.count,
    };
    out.lastJob = lastJob;
    return Response.json(out);
  } catch (e) {
    out.error = e instanceof Error ? e.message : "unknown error";
    return Response.json(out);
  }
}
