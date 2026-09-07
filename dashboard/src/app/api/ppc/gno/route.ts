import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday, windowStart } from "@/lib/as-of";
import {
  AUTO_LOOSE_NAME,
  GNO_LAUNCHED_AT,
  GNO_NEXT_REVIEW_AT,
  GNO_OBSERVE_ONLY,
  evaluateGnoAlerts,
  harvestQueue,
  hoursSinceLaunch,
  keeperHeartbeats,
  newExactTiles,
  type CampaignDailyRow,
  type PlacementRow,
  type SearchTermRow,
} from "@/lib/gno-ppc-watch";

/**
 * GET /api/ppc/gno — GNO PPC Watch payload from stored Ads tables.
 * Observe + alert only. Never writes to Amazon.
 */

const CAMP_COLS =
  "date,campaign_id,campaign_name,campaign_type,campaign_status,budget,spend,sales_14d,orders_14d,clicks,impressions,cpc,acos";
const TERM_COLS =
  "date,search_term,campaign_id,campaign_name,ad_group_id,ad_group_name,keyword,match_type,spend,sales_14d,orders_14d,clicks,impressions";
const PLACE_COLS =
  "date,campaign_id,campaign_name,placement,spend,sales_14d,orders_14d,clicks,impressions";

async function pageRows(
  sb: ReturnType<typeof getServerSupabase>,
  table: string,
  cols: string,
  start: string,
  end: string,
  order2: string,
  order3?: string,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const rows: Record<string, unknown>[] = [];
  try {
    let offset = 0;
    while (true) {
      let q = sb.from(table).select(cols)
        .gte("date", start)
        .lte("date", end)
        .order("date", { ascending: true })
        .order(order2, { ascending: true });
      if (order3) q = q.order(order3, { ascending: true });
      const r = await q.range(offset, offset + 999);
      if (r.error) throw new Error(r.error.message);
      const page = (r.data ?? []) as unknown as Record<string, unknown>[];
      rows.push(...page);
      if (page.length < 1000) break;
      offset += 1000;
    }
    return { rows };
  } catch (e) {
    return { rows, error: `${table}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function GET() {
  try {
    const asOf = amazonAsOf();
    const today = amazonToday();
    const start = windowStart(asOf, 14);
    const sb = getServerSupabase();
    const loadErrors: string[] = [];

    const camp = await pageRows(sb, "ads_campaigns_daily", CAMP_COLS, start, today, "campaign_id");
    if (camp.error) loadErrors.push(camp.error);
    const term = await pageRows(sb, "ads_search_terms_daily", TERM_COLS, start, today, "campaign_id", "search_term");
    if (term.error) loadErrors.push(term.error);
    const place = await pageRows(sb, "ads_placement_daily", PLACE_COLS, start, today, "campaign_id", "placement");
    if (place.error) loadErrors.push(place.error);

    const campaigns = camp.rows as unknown as CampaignDailyRow[];
    const searchTerms = term.rows as unknown as SearchTermRow[];
    const placements = place.rows as unknown as PlacementRow[];

    let sqp: { available: boolean; newestAsOf: string | null; stale: boolean; keywords: number } = {
      available: false, newestAsOf: null, stale: true, keywords: 0,
    };
    try {
      const r = await sb.from("keyword_organic_rank")
        .select("as_of")
        .order("as_of", { ascending: false })
        .limit(1);
      if (!r.error) {
        const newest = r.data?.[0]?.as_of ? String(r.data[0].as_of) : null;
        const age = newest
          ? Math.round((Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000)
          : null;
        sqp = {
          available: true,
          newestAsOf: newest,
          stale: age == null || age > 21,
          keywords: 0,
        };
      }
    } catch {
      /* SQP stays a manual slot — do not fake shares */
    }

    let lastSync: { at: string | null; job: string | null; status: string | null } = {
      at: null, job: null, status: null,
    };
    try {
      const r = await sb.from("job_runs")
        .select("job_name,started_at,status")
        .in("job_name", [
          "ads_gno_campaigns_sync", "ads_campaigns_sync",
          "ads_search_terms_sync", "ads_placements_sync", "ads_sync",
        ])
        .in("status", ["success", "partial"])
        .order("started_at", { ascending: false })
        .limit(1);
      if (!r.error && r.data?.[0]) {
        lastSync = {
          at: r.data[0].started_at ?? null,
          job: r.data[0].job_name ?? null,
          status: r.data[0].status ?? null,
        };
      }
    } catch { /* optional */ }

    const now = new Date();
    const alerts = evaluateGnoAlerts({
      asOf, today, now, campaigns, searchTerms, placements,
      negativesAvailable: false,
      bidsKnown: false,
    });
    const harvest = harvestQueue(searchTerms, campaigns, asOf);
    const sbL7 = campaigns.filter((c) => {
      const t = String(c.campaign_type ?? "SP").toUpperCase();
      return t === "SB" && c.date >= windowStart(asOf, 7) && c.date <= asOf;
    });
    const sbByName = new Map<string, { spend: number; sales: number; orders: number }>();
    for (const r of sbL7) {
      const e = sbByName.get(r.campaign_name) ?? { spend: 0, sales: 0, orders: 0 };
      e.spend += Number(r.spend ?? 0);
      e.sales += Number(r.sales_14d ?? 0);
      e.orders += Number(r.orders_14d ?? 0);
      sbByName.set(r.campaign_name, e);
    }

    return Response.json({
      observeOnly: GNO_OBSERVE_ONLY,
      profile: "Tallowbourn",
      marketplace: "US",
      asOf,
      today,
      launchedAt: GNO_LAUNCHED_AT,
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      hoursSinceLaunch: hoursSinceLaunch(now),
      autoLooseName: AUTO_LOOSE_NAME,
      alerts,
      p0: alerts.filter((a) => a.priority === "P0"),
      p1: alerts.filter((a) => a.priority === "P1"),
      p2: alerts.filter((a) => a.priority === "P2"),
      newExact: newExactTiles(campaigns, asOf, now),
      keepers: keeperHeartbeats(campaigns, asOf),
      harvestQueue: harvest.filter((t) => t.proposed_tag === "HARVEST_CANDIDATE"),
      junkQueue: harvest.filter((t) => t.proposed_tag === "JUNK_CANDIDATE"),
      harvestAll: harvest,
      sbL7: [...sbByName.entries()].map(([campaign_name, m]) => ({
        campaign_name, ...m,
        acos: m.sales > 0 ? (m.spend / m.sales) * 100 : null,
      })).sort((a, b) => b.spend - a.spend).slice(0, 12),
      sqp,
      lastSync,
      gaps: [
        "Keyword bids are not stored — 0-impr P0 cannot confirm a bid bump.",
        "Campaign / ad-group negatives are not stored — core-negative P0 is skipped (not faked).",
        "Portfolio / bidding strategy / placement modifiers are not on ads_campaigns_daily.",
        "SQP Brand Analytics stays a manual CSV upload. Shares are never invented.",
      ],
      loadErrors,
    });
  } catch (e) {
    return Response.json({
      observeOnly: true,
      error: e instanceof Error ? e.message : String(e),
      alerts: [],
      p0: [],
      newExact: [],
      keepers: [],
      harvestQueue: [],
    }, { status: 500 });
  }
}
