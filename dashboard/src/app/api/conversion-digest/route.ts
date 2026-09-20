import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  buildConversionDigest,
  parseDigestDate,
} from "@/lib/conversion-digest";
import type { AbandonedRow } from "@/lib/shopify-funnel";

/**
 * GET /api/conversion-digest?date=YYYY-MM-DD
 *
 * Read-only Conversion Digest for Iris. Dana owns the numbers.
 * Default date = yesterday America/New_York. Never substitutes an older
 * complete day when the requested day is missing (Iris date-lock).
 *
 * Auth: same dashboard Basic Auth + service-role warehouse as other
 * /api routes. Not anon. No Shopify / theme writes. No Mini gateway key.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const parsed = parseDigestDate(request.nextUrl.searchParams.get("date"));
  if (parsed.error) {
    const digest = buildConversionDigest({
      asOf: parsed.asOf,
      dailyRow: null,
      funnelOk: null,
      abandons: [],
      jev: null,
    });
    return Response.json({ ...digest, gap: parsed.error });
  }

  try {
    const sb = getServerSupabase();
    const [daily, abandons, status] = await Promise.all([
      sb.from("shopify_funnel_daily")
        .select("metric_date,split_kind,split_value,sessions,pdp_sessions,add_to_cart,checkout_started,purchases")
        .eq("metric_date", parsed.asOf)
        .eq("split_kind", "all")
        .limit(1)
        .maybeSingle(),
      sb.from("shopify_abandoned_checkouts")
        .select("checkout_id,checkout_name,checkout_date,created_at,completed_at,total_price,currency,recovered,line_items,line_items_qty,triage_severity,triage_note")
        .eq("checkout_date", parsed.asOf),
      sb.from("shopify_funnel_status")
        .select("funnel_ok,last_stats")
        .eq("id", 1)
        .limit(1)
        .maybeSingle(),
    ]);

    if (daily.error && /shopify_funnel_daily/.test(daily.error.message)) {
      return Response.json(buildConversionDigest({
        asOf: parsed.asOf,
        dailyRow: null,
        funnelOk: false,
        abandons: [],
        jev: null,
      }));
    }

    const lastStats = status.data?.last_stats && typeof status.data.last_stats === "object"
      ? status.data.last_stats as Record<string, unknown>
      : null;
    const digest = buildConversionDigest({
      asOf: parsed.asOf,
      dailyRow: daily.data ?? null,
      funnelOk: status.data?.funnel_ok ?? null,
      abandons: (abandons.data ?? []) as AbandonedRow[],
      jev: lastStats?.jev ?? null,
    });
    return Response.json(digest);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json(buildConversionDigest({
      asOf: parsed.asOf,
      dailyRow: null,
      funnelOk: false,
      abandons: [],
      jev: null,
    }), { status: /not configured/i.test(msg) ? 503 : 200 });
  }
}
