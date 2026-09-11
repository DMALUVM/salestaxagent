import { loadOrganicRankSources } from "@/lib/soldscope-load";
import { buildOrganicRankProgress } from "@/lib/organic-rank-progress";
import { getServerSupabase } from "@/lib/supabase-server";
import { SOLDSCOPE_OBSERVE_ONLY } from "@/lib/soldscope-status";

/**
 * GET /api/ppc/organic-rank — weekly Rank Tracker heatmap + WoW flags.
 * Reads soldscope_rank_snapshots and joins ABA SFR + sqp_weekly /
 * keyword_organic_rank. Observe-only. Empty tables stay empty.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const sources = await loadOrganicRankSources(sb);
    const progress = buildOrganicRankProgress(sources);
    return Response.json({
      observeOnly: SOLDSCOPE_OBSERVE_ONLY,
      createGroups: false,
      ...progress,
    });
  } catch (e) {
    return Response.json({
      observeOnly: SOLDSCOPE_OBSERVE_ONLY,
      createGroups: false,
      empty: true,
      emptyCopy:
        "Could not load organic-rank snapshots. Empty is shown — nothing invented.",
      families: [],
      weeks: [],
      rows: [],
      movers: [],
      baselineOnly: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
