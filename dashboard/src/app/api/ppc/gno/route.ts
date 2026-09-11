import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday, windowStart } from "@/lib/as-of";
import {
  AUTO_LOOSE_NAME,
  GNO_DESK_SPEND_LOOKBACK_DAYS,
  GNO_LAUNCHED_AT,
  GNO_OBSERVE_ONLY,
  NEW_EXACT,
  evaluateGnoAlerts,
  harvestQueue,
  hoursSinceLaunch,
  keeperHeartbeats,
  newExactTiles,
  type CampaignDailyRow,
  type CampaignMeta,
  type KeywordTarget,
  type PlacementRow,
  type SearchTermRow,
} from "@/lib/gno-ppc-watch";
import { exportBannerFromState } from "@/lib/gno-export-state";
import { loadGnoExportState, loadGnoLedger } from "@/lib/gno-store";
import {
  loadSoldScopeCompetitorKr,
  loadSoldScopeKeywordIntel,
  loadSoldScopeOutlierSources,
  loadSoldScopeRankStatus,
} from "@/lib/soldscope-load";
import { attachKeywordIntel } from "@/lib/soldscope-status";
import { OUTLIER_EMPTY_COPY, buildKeywordOutliers } from "@/lib/soldscope-outliers";
import { buildOrganicRankJoinIndex } from "@/lib/organic-rank-progress";
import {
  COMPETITOR_OUTLIER_EMPTY_COPY,
  blakeSurfaceFromWarehouse,
  extraExactFromWatch,
} from "@/lib/soldscope-competitor-outliers";

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
    const start = windowStart(asOf, GNO_DESK_SPEND_LOOKBACK_DAYS);
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

    let campaignMeta: CampaignMeta[] = [];
    let keywordTargets: KeywordTarget[] = [];
    try {
      const META_WITH_CREATE =
        "campaign_id,campaign_name,state,daily_budget,portfolio_id,portfolio_name,tos_modifier_pct,ros_modifier_pct,pp_modifier_pct,created_at,snapshot_at";
      const META_BASE =
        "campaign_id,campaign_name,state,daily_budget,portfolio_id,portfolio_name,tos_modifier_pct,ros_modifier_pct,pp_modifier_pct";
      const withCreate = await sb.from("ads_campaign_meta")
        .select(META_WITH_CREATE)
        .order("campaign_id", { ascending: true })
        .range(0, 999);
      if (!withCreate.error) {
        campaignMeta = (withCreate.data ?? []) as unknown as CampaignMeta[];
      } else if (/created_at|snapshot_at|schema cache|PGRST/i.test(withCreate.error.message || "")) {
        const base = await sb.from("ads_campaign_meta")
          .select(META_BASE)
          .order("campaign_id", { ascending: true })
          .range(0, 999);
        if (!base.error) campaignMeta = (base.data ?? []) as unknown as CampaignMeta[];
      }
    } catch { /* snapshot optional until migration */ }
    try {
      const kw = await sb.from("ads_keyword_targets")
        .select("keyword_id,campaign_id,campaign_name,keyword_text,match_type,state,bid")
        .order("keyword_id", { ascending: true })
        .range(0, 9999);
      if (!kw.error) keywordTargets = (kw.data ?? []) as unknown as KeywordTarget[];
    } catch { /* snapshot optional until migration */ }

    let sqp: {
      available: boolean;
      newestAsOf: string | null;
      stale: boolean;
      keywords: number;
      source: "sqp_weekly" | "keyword_organic_rank" | null;
    } = {
      available: false, newestAsOf: null, stale: true, keywords: 0, source: null,
    };
    try {
      // Prefer Brand Analytics / SP-API week_end from sqp_weekly — that is what
      // the upload banner tracks. Fall back to keyword_organic_rank.as_of.
      const weekly = await sb.from("sqp_weekly")
        .select("week_end")
        .order("week_end", { ascending: false })
        .limit(1);
      let newest: string | null = null;
      let source: "sqp_weekly" | "keyword_organic_rank" | null = null;
      if (!weekly.error && weekly.data?.[0]?.week_end) {
        newest = String(weekly.data[0].week_end);
        source = "sqp_weekly";
      } else {
        const r = await sb.from("keyword_organic_rank")
          .select("as_of")
          .order("as_of", { ascending: false })
          .limit(1);
        if (!r.error && r.data?.[0]?.as_of) {
          newest = String(r.data[0].as_of);
          source = "keyword_organic_rank";
        }
      }
      if (newest || source) {
        const age = newest
          ? Math.round((Date.now() - Date.parse(`${newest}T00:00:00Z`)) / 86_400_000)
          : null;
        sqp = {
          available: true,
          newestAsOf: newest,
          stale: age == null || age > 21,
          keywords: 0,
          source,
        };
      }
    } catch {
      /* SQP load failed — do not fake shares */
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

    let acks: string[] = [];
    try {
      const r = await sb.from("gno_alert_acks")
        .select("alert_key,status")
        .eq("status", "done");
      if (!r.error) {
        acks = (r.data ?? [])
          .map((row) => String((row as { alert_key?: string }).alert_key ?? ""))
          .filter(Boolean);
      }
    } catch { /* table optional until migration_gno_alert_acks.sql */ }

    const now = new Date();
    const [ledger, exportState] = await Promise.all([
      loadGnoLedger(sb),
      loadGnoExportState(sb),
    ]);
    const alerts = evaluateGnoAlerts({
      asOf, today, now, campaigns, searchTerms, placements,
      negativesAvailable: false,
      bidsKnown: keywordTargets.some((t) => t.bid != null),
      lookbackDays: GNO_DESK_SPEND_LOOKBACK_DAYS,
      ledger,
      keywordTargets,
      campaignMeta,
    });
    const harvestRaw = harvestQueue(searchTerms, campaigns, asOf, { keywordTargets, ledger });
    const [ssIntel, ssRank, ssOutlierSrc, ssCompetitorKr] = await Promise.all([
      loadSoldScopeKeywordIntel(sb),
      loadSoldScopeRankStatus(sb),
      loadSoldScopeOutlierSources(sb),
      loadSoldScopeCompetitorKr(sb),
    ]);
    const keywordOutliers = buildKeywordOutliers({
      rankRows: ssOutlierSrc.rankRows,
      researchRows: ssOutlierSrc.researchRows,
      targets: keywordTargets,
      searchTerms: searchTerms.map((t) => ({
        search_term: t.search_term,
        campaign_name: t.campaign_name,
      })),
    });
    const competitorOutliers = blakeSurfaceFromWarehouse({
      krRows: ssCompetitorKr,
      targets: keywordTargets,
      extraExact: extraExactFromWatch(NEW_EXACT),
      organicIndex: buildOrganicRankJoinIndex(ssOutlierSrc.rankRows),
    });
    const harvest = attachKeywordIntel(
      harvestRaw as unknown as Record<string, unknown>[],
      (t) => String(t.customer_search_term ?? ""),
      ssIntel,
    );
    const p0 = alerts.filter((a) => a.priority === "P0");
    const p1 = alerts.filter((a) => a.priority === "P1");
    const exportBanner = exportBannerFromState(exportState, { now, p0, p1 });
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
      nextReviewAt: exportBanner.nextReviewAt,
      hoursSinceLaunch: hoursSinceLaunch(now),
      autoLooseName: AUTO_LOOSE_NAME,
      alerts,
      p0,
      p1,
      p2: alerts.filter((a) => a.priority === "P2"),
      newExact: newExactTiles(campaigns, asOf, now, { campaignMeta, ledger }),
      exportBanner,
      lastExportAt: exportState?.last_export_at ?? null,
      lastExportReason: exportState?.last_export_reason ?? null,
      keepers: keeperHeartbeats(campaigns, asOf, campaignMeta),
      harvestQueue: harvest.filter((t) => t.proposed_tag === "HARVEST_CANDIDATE"),
      junkQueue: harvest.filter((t) => t.proposed_tag === "JUNK_CANDIDATE"),
      harvestAll: harvest,
      soldscope: {
        observeOnly: true,
        rankTrackerCopy: ssRank.copy,
        groups: ssRank.groups,
        phrases: ssRank.phrases,
        keywordOutliers,
        outlierEmptyCopy: OUTLIER_EMPTY_COPY,
        competitorOutliers,
        competitorEmptyCopy: COMPETITOR_OUTLIER_EMPTY_COPY,
      },
      acks,
      lookbackDays: GNO_DESK_SPEND_LOOKBACK_DAYS,
      sbL7: [...sbByName.entries()].map(([campaign_name, m]) => ({
        campaign_name, ...m,
        acos: m.sales > 0 ? (m.spend / m.sales) * 100 : null,
      })).sort((a, b) => b.spend - a.spend).slice(0, 12),
      sqp,
      lastSync,
      gaps: [
        "Keyword bids / portfolio / placement modifiers come from ads_campaign_meta (Campaigns API snapshot). Missing snapshot is empty, not invented.",
        "Campaign / ad-group negatives live in ads_negatives after the GNO snapshot. Core-negative P0 stays skipped until that table is populated.",
        "SQP Brand Analytics is not in the Ads API — weekly SP-API pull for complete Sun–Sat weeks. CSV is fallback. Shares are never invented.",
      ],
      loadErrors,
    });
  } catch (e) {
    let exportState = null;
    try {
      exportState = await loadGnoExportState();
    } catch { /* last_export_* stays null */ }
    const exportBanner = exportBannerFromState(exportState);
    return Response.json({
      observeOnly: true,
      error: e instanceof Error ? e.message : String(e),
      nextReviewAt: exportBanner.nextReviewAt,
      lastExportAt: exportState?.last_export_at ?? null,
      lastExportReason: exportState?.last_export_reason ?? null,
      exportBanner,
      alerts: [],
      p0: [],
      newExact: [],
      keepers: [],
      harvestQueue: [],
    }, { status: 500 });
  }
}
