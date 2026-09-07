import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, amazonToday, windowStart } from "@/lib/as-of";
import { zipStore } from "@/lib/zip-store";
import {
  buildGnoPack,
  evaluateGnoAlerts,
  GNO_DESK_SPEND_LOOKBACK_DAYS,
  GNO_NEXT_REVIEW_AT,
  type CampaignDailyRow,
  type PlacementRow,
  type SearchTermRow,
} from "@/lib/gno-ppc-watch";
import { ackPayload, evaluateExportNeed } from "@/lib/gno-export-state";
import { loadGnoExportState, loadGnoLedger, saveGnoExportAck } from "@/lib/gno-store";

/**
 * GET /api/ppc/gno-export — Export GNO pack zip.
 * watch_campaigns.csv + auto_loose_search_terms.csv (Last 2 + Last 7).
 * Observe / export only. Never writes to Amazon.
 */

const CAMP_COLS =
  "date,campaign_id,campaign_name,campaign_type,campaign_status,budget,spend,sales_14d,orders_14d,clicks,impressions";
const TERM_COLS =
  "date,search_term,campaign_id,campaign_name,ad_group_id,match_type,keyword,spend,sales_14d,orders_14d,clicks,impressions";
const PLACE_COLS =
  "date,campaign_id,campaign_name,placement,spend";

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

export async function GET() {
  try {
    const asOf = amazonAsOf();
    const today = amazonToday();
    const start = windowStart(asOf, 14);
    const sb = getServerSupabase();
    const [campaigns, searchTerms, placements] = await Promise.all([
      pageRows(sb, "ads_campaigns_daily", CAMP_COLS, start, today, "campaign_id"),
      pageRows(sb, "ads_search_terms_daily", TERM_COLS, start, today, "campaign_id", "search_term"),
      pageRows(sb, "ads_placement_daily", PLACE_COLS, start, today, "campaign_id", "placement"),
    ]);
    const [ledger, exportState] = await Promise.all([
      loadGnoLedger(sb),
      loadGnoExportState(sb),
    ]);
    const campRows = campaigns as unknown as CampaignDailyRow[];
    const termRows = searchTerms as unknown as SearchTermRow[];
    const placeRows = placements as unknown as PlacementRow[];
    const pack = buildGnoPack({
      asOf,
      campaigns: campRows,
      searchTerms: termRows,
      placements: placeRows,
      ledger,
    });
    const now = new Date();
    const alerts = evaluateGnoAlerts({
      asOf, today, now, campaigns: campRows, searchTerms: termRows, placements: placeRows,
      lookbackDays: GNO_DESK_SPEND_LOOKBACK_DAYS,
      ledger,
    });
    const p0 = alerts.filter((a) => a.priority === "P0");
    const p1 = alerts.filter((a) => a.priority === "P1");
    const banner = evaluateExportNeed({
      now,
      nextReviewAt: GNO_NEXT_REVIEW_AT,
      p0,
      p1,
      lastExportAt: exportState?.last_export_at,
      lastExportReason: exportState?.last_export_reason,
      ackedP0Keys: exportState?.acked_p0_keys,
      ackedP1Keys: exportState?.acked_p1_keys,
    });
    await saveGnoExportAck(ackPayload(banner, p0, p1, pack.filename, now));
    const zip = zipStore(pack.files);
    return new Response(Buffer.from(zip), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${pack.filename}"`,
        "cache-control": "no-store",
        "x-gno-observe-only": "1",
      },
    });
  } catch (e) {
    return Response.json({
      error: e instanceof Error ? e.message : String(e),
      hint: "Export reads stored ads_campaigns_daily / ads_search_terms_daily. Nothing writes to Amazon.",
    }, { status: 503 });
  }
}
