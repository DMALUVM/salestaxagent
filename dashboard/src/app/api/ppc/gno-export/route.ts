import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday, windowStart } from "@/lib/as-of";
import { loadPack, storePack } from "@/lib/gno-export-handoff";
import { isPackToken, safePackFilename } from "@/lib/gno-export-download";
import { readyZipResponse, streamingExportStatus, zipStore } from "@/lib/zip-store";
import {
  NEW_EXACT,
  buildGnoPack,
  evaluateGnoAlerts,
  gnoPackStamp,
  GNO_DESK_SPEND_LOOKBACK_DAYS,
  SQP_SLICE_QUERIES,
  type AsinCatalogRow,
  type CampaignDailyRow,
  type CampaignMeta,
  type KeywordTarget,
  type NegativeRow,
  type PlacementRow,
  type SearchTermRow,
  type SqpSliceRow,
} from "@/lib/gno-ppc-watch";
import { ackPayload, exportBannerFromState, packIdFromExportFilename } from "@/lib/gno-export-state";
import { csvDataRowCount } from "@/lib/gno-pack-contract";
import { loadGnoExportState, loadGnoLedger, saveGnoExportAck } from "@/lib/gno-store";
import { loadOrganicRankSources, loadSoldScopeCompetitorKr } from "@/lib/soldscope-load";
import { buildOrganicRankJoinIndex } from "@/lib/organic-rank-progress";
import {
  blakeSurfaceFromWarehouse,
  extraExactFromWatch,
} from "@/lib/soldscope-competitor-outliers";

/**
 * GET /api/ppc/gno-export — Export GNO pack zip.
 * watch_campaigns.csv + auto_loose / fat_parent / broad_m search terms
 * + keyword_targets.csv + advertised_product_l7.csv + organic_rank_snapshot.csv
 * + competitor_kr_outliers.csv + gno_decision_rules.txt + gno_outcomes.csv
 * + README.txt
 * (+ optional sqp_weekly_slice.csv, negatives_snapshot.csv).
 * Today = config only (metrics_complete=false). L2/L7 = closed days
 * ending yesterday; a lagging ads day flags metrics_complete=false and
 * does not slide the window. SUMMARY search-term stamps are not L2/L7.
 * sqp_weekly_slice.csv is the newest stored complete Sun–Sat SQP week.
 * Older weeks, if shipped, are COMPARISON / PRE_RAISE only.
 * Observe / export only. Never writes to Amazon.
 *
 * The zip is deflated. The build response is a tiny text status stream
 * (heartbeat lines, then READY or GNOERR) so the socket stays up without
 * putting framing bytes in the file. The zip is stored and the browser
 * downloads it with a short same-origin GET. fetch()+arrayBuffer() on the
 * long build stream returned Failed to fetch / NetworkError after headers
 * — and after this route had already logged the finished zip.
 * A native download does not surface a browser-bar failure in the page
 * banner. GNOERR and HTTP errors still do. Observe only.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CAMP_COLS =
  "date,campaign_id,campaign_name,campaign_type,campaign_status,budget,spend,sales_14d,orders_14d,clicks,impressions";
const TERM_COLS =
  "date,search_term,campaign_id,campaign_name,ad_group_id,match_type,keyword,keyword_id,spend,sales_14d,orders_14d,clicks,impressions";
const PLACE_COLS =
  "date,campaign_id,campaign_name,placement,spend";
const META_COLS =
  "campaign_id,campaign_name,state,daily_budget,portfolio_id,portfolio_name,tos_modifier_pct,ros_modifier_pct,pp_modifier_pct,created_at,snapshot_at";
const META_COLS_BASE =
  "campaign_id,campaign_name,state,daily_budget,portfolio_id,portfolio_name,tos_modifier_pct,ros_modifier_pct,pp_modifier_pct";
const KW_COLS =
  "keyword_id,campaign_id,campaign_name,ad_group_id,keyword_text,match_type,state,bid";
const NEG_COLS =
  "negative_id,campaign_id,campaign_name,ad_group_id,keyword,match_type,state,level";

async function pageRows(
  sb: ReturnType<typeof getServerSupabase>,
  table: string,
  cols: string,
  start: string,
  end: string,
  order2: string,
  order3?: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    let q = sb.from(table).select(cols)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true })
      .order(order2, { ascending: true });
    if (order3) q = q.order(order3, { ascending: true });
    const r = await q.range(offset, offset + 999);
    if (r.error) throw new Error(`${table}: ${r.error.message}`);
    const page = (r.data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

const SQP_COLS =
  "week_start,week_end,asin,search_query,query_normalized,search_query_volume,impression_share,click_share,purchase_share,asin_impressions,asin_clicks,asin_purchases,source";

async function pageSqpSlice(
  sb: ReturnType<typeof getServerSupabase>,
): Promise<SqpSliceRow[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const r = await sb.from("sqp_weekly").select(SQP_COLS)
      .in("query_normalized", [...SQP_SLICE_QUERIES])
      .order("week_end", { ascending: true })
      .order("query_normalized", { ascending: true })
      .order("asin", { ascending: true })
      .range(offset, offset + 999);
    if (r.error) {
      const msg = r.error.message || "";
      if (/does not exist|schema cache|PGRST/i.test(msg)) return [];
      throw new Error(`sqp_weekly: ${msg}`);
    }
    const page = (r.data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows as unknown as SqpSliceRow[];
}

async function pageAsinCatalog(
  sb: ReturnType<typeof getServerSupabase>,
): Promise<AsinCatalogRow[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const r = await sb.from("sku_costs").select("sku,asin,product_name,cogs_per_unit,updated_at")
      .order("sku", { ascending: true })
      .range(offset, offset + 999);
    if (r.error) {
      const msg = r.error.message || "";
      if (/does not exist|schema cache|PGRST/i.test(msg)) return [];
      throw new Error(`sku_costs: ${msg}`);
    }
    const page = (r.data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows
    .map((r) => ({
      asin: String(r.asin ?? "").trim(),
      sku: r.sku != null ? String(r.sku) : "",
      product_name: r.product_name != null ? String(r.product_name) : "",
      cogs_per_unit: r.cogs_per_unit == null || r.cogs_per_unit === "" ? null : Number(r.cogs_per_unit),
      updated_at: r.updated_at != null ? String(r.updated_at) : "",
    }))
    .filter((r) => r.asin);
}

async function pageAll(
  sb: ReturnType<typeof getServerSupabase>,
  table: string,
  cols: string,
  order: string,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (true) {
    const r = await sb.from(table).select(cols)
      .order(order, { ascending: true })
      .range(offset, offset + 999);
    if (r.error) {
      const msg = r.error.message || "";
      if (/does not exist|schema cache|PGRST/i.test(msg)) return [];
      throw new Error(`${table}: ${msg}`);
    }
    const page = (r.data ?? []) as unknown as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < 1000) break;
    offset += 1000;
  }
  return rows;
}

const EXPORT_HINT =
  "Export reads stored ads tables + Campaigns API snapshot. Nothing writes to Amazon.";

async function buildGnoExportZip(now: Date): Promise<Uint8Array> {
  try {
    const asOf = amazonAsOf();
    const today = amazonToday();
    const start = windowStart(today, 60);
    const sb = getServerSupabase();
    const [campaigns, searchTerms, placements, metaLoaded, keywords, negatives, sqpWeekly, asinCatalog, organicSources, competitorKr] = await Promise.all([
      pageRows(sb, "ads_campaigns_daily", CAMP_COLS, start, today, "campaign_id"),
      pageRows(sb, "ads_search_terms_daily", TERM_COLS, start, today, "campaign_id", "search_term"),
      pageRows(sb, "ads_placement_daily", PLACE_COLS, start, today, "campaign_id", "placement"),
      pageAll(sb, "ads_campaign_meta", META_COLS, "campaign_id"),
      pageAll(sb, "ads_keyword_targets", KW_COLS, "keyword_id"),
      pageAll(sb, "ads_negatives", NEG_COLS, "negative_id"),
      pageSqpSlice(sb),
      pageAsinCatalog(sb),
      loadOrganicRankSources(sb),
      loadSoldScopeCompetitorKr(sb),
    ]);
    const meta = metaLoaded.length
      ? metaLoaded
      : await pageAll(sb, "ads_campaign_meta", META_COLS_BASE, "campaign_id");
    const [ledger, exportState] = await Promise.all([
      loadGnoLedger(sb),
      loadGnoExportState(sb),
    ]);
    const campRows = campaigns as unknown as CampaignDailyRow[];
    const termRows = searchTerms as unknown as SearchTermRow[];
    const placeRows = placements as unknown as PlacementRow[];
    const priorId = packIdFromExportFilename(exportState?.last_export_filename);
    const pack = buildGnoPack({
      asOf,
      today,
      now,
      campaigns: campRows,
      searchTerms: termRows,
      placements: placeRows,
      campaignMeta: meta as unknown as CampaignMeta[],
      keywordTargets: keywords as unknown as KeywordTarget[],
      negatives: negatives as unknown as NegativeRow[],
      ledger,
      sqpWeekly,
      asinCatalog,
      organicSnapshots: organicSources.snapshots,
      competitorOutliers: blakeSurfaceFromWarehouse({
        krRows: competitorKr,
        targets: keywords as unknown as KeywordTarget[],
        extraExact: extraExactFromWatch(NEW_EXACT),
        organicIndex: buildOrganicRankJoinIndex(organicSources.snapshots),
      }),
      priorPack: priorId || exportState?.last_row_counts
        ? { id: priorId ?? undefined, counts: exportState?.last_row_counts ?? undefined }
        : null,
    });
    const alerts = evaluateGnoAlerts({
      asOf, today, now, campaigns: campRows, searchTerms: termRows, placements: placeRows,
      lookbackDays: GNO_DESK_SPEND_LOOKBACK_DAYS,
      ledger,
      keywordTargets: keywords as unknown as KeywordTarget[],
      campaignMeta: meta as unknown as CampaignMeta[],
    });
    const p0 = alerts.filter((a) => a.priority === "P0");
    const p1 = alerts.filter((a) => a.priority === "P1");
    const banner = exportBannerFromState(exportState, { now, p0, p1 });
    const countOf = (name: string) => csvDataRowCount(pack.files.find((f) => f.name === name)?.body ?? "");
    await saveGnoExportAck({
      ...ackPayload(banner, p0, p1, pack.filename, now),
      last_row_counts: {
        auto_loose: countOf("auto_loose_search_terms.csv"),
        broad_m: countOf("broad_m_search_terms.csv"),
        watch: countOf("watch_campaigns.csv"),
        sqp: countOf("sqp_weekly_slice.csv"),
      },
    });
    const zip = zipStore(pack.files);
    return zip;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`${detail} ${EXPORT_HINT}`);
  }
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function publishGnoExport(now: Date): Promise<{ token: string; filename: string }> {
  const filename = `gno-pack-${gnoPackStamp(now)}.zip`;
  const zip = await buildGnoExportZip(now);
  console.info("gno-export zip bytes", zip.byteLength, filename);
  const token = crypto.randomUUID();
  try {
    await storePack(token, zip);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not store the pack for download. ${detail} ${EXPORT_HINT}`);
  }
  return { token, filename };
}

async function readyPackResponse(token: string, name: string | null): Promise<Response> {
  const filename = safePackFilename(name);
  if (!isPackToken(token)) return plain(404, "Unknown pack.");
  try {
    const zip = await loadPack(token);
    if (!zip || zip.byteLength < 22) {
      return plain(404, "That pack is no longer available. Click Export again.");
    }
    console.info("gno-export ready", zip.byteLength, filename);
    return readyZipResponse(zip, filename, { "x-gno-observe-only": "1" });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("gno-export ready failed", detail);
    return plain(503, "Export file could not be read. Click Export again.");
  }
}

export function GET(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  const pack = url.searchParams.get("pack");
  if (pack) return readyPackResponse(pack, url.searchParams.get("name"));
  const now = new Date();
  const filename = `gno-pack-${gnoPackStamp(now)}.zip`;
  console.info("gno-export handler", filename);
  return streamingExportStatus(filename, () => publishGnoExport(now), {
    extraHeaders: { "x-gno-observe-only": "1" },
  });
}
