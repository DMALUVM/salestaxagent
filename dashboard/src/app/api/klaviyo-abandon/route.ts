import { getServerSupabase } from "@/lib/supabase-server";
import { summarizeKlaviyo } from "@/lib/shopify-funnel";

/**
 * GET /api/klaviyo-abandon
 *
 * Read-only. Rows are Kit-seeded into klaviyo_abandon_flow_daily.
 * This route never calls Klaviyo and never writes.
 */
export const dynamic = "force-dynamic";

const SETUP =
  "Run supabase/migration_shopify_funnel_expand.sql. " +
  "Kit refreshes klaviyo_abandon_flow_daily; this app does not write to Klaviyo.";

export async function GET() {
  try {
    const sb = getServerSupabase();
    const r = await sb
      .from("klaviyo_abandon_flow_daily")
      .select(
        "as_of,window_days,flow_id,flow_name,trigger_metric," +
        "conversion_metric_id,conversion_metric_name,recipients," +
        "unique_conversions,conversion_rate,revenue,rpr,unique_clicks,source,notes",
      )
      .order("as_of", { ascending: false })
      .order("window_days", { ascending: false });
    if (r.error) {
      return Response.json({
        available: false,
        error: r.error.message.slice(0, 300),
        setupHint: /klaviyo_abandon/.test(r.error.message) ? SETUP : null,
      });
    }
    const rows = r.data ?? [];
    return Response.json({
      available: true,
      empty: !rows.length,
      rows,
      summary: summarizeKlaviyo(rows),
      setupHint: SETUP,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({
      available: false,
      error: msg.slice(0, 300),
      setupHint: SETUP,
    });
  }
}
