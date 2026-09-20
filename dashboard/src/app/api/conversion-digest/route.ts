import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  buildConversionDigest,
  isClosedEasternDay,
  parseDigestDate,
} from "@/lib/conversion-digest";
import {
  ensureFunnelJevTriage,
  evaluateViaGateway,
  hasGatewayKey,
} from "@/lib/funnel-jev-triage";
import { emptyPhase2, phase2FromLockedDay } from "@/lib/phase2-digest";
import type { AbandonedRow } from "@/lib/shopify-funnel";

/**
 * GET /api/conversion-digest?date=YYYY-MM-DD
 *
 * Iris contract. Dana owns the numbers. Default date = yesterday
 * America/New_York. Never substitutes an older complete day.
 *
 * After Mini writes shopify_funnel_* , this read runs or reuses Vercel
 * Jev triage and copies pursue (max 3) into improvements. Fail closed
 * → improvements: []. No Shopify / theme writes. No Mini gateway key.
 *
 * Phase 2 extras (`phase2.landing_drops` / `seo` / `connectors`) are
 * null/false until official-API rows exist for the locked day. Missing
 * tables are not an error. Never invents GA4/GSC/ads numbers.
 *
 * Auth: dashboard Basic Auth + service-role warehouse. Not anon.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

async function loadOptionalDay(
  sb: ReturnType<typeof getServerSupabase>,
  table: string,
  select: string,
  date: string,
): Promise<Array<Record<string, unknown>>> {
  const r = await sb.from(table).select(select).eq("metric_date", date).limit(500);
  if (r.error || !Array.isArray(r.data)) return [];
  return r.data as unknown as Array<Record<string, unknown>>;
}

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
    return Response.json({ ...digest, gap: parsed.error, phase2: emptyPhase2() });
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
        .select("id,funnel_ok,last_stats")
        .eq("id", 1)
        .limit(1)
        .maybeSingle(),
    ]);

    if (daily.error && /shopify_funnel_daily/.test(daily.error.message)) {
      return Response.json({
        ...buildConversionDigest({
          asOf: parsed.asOf,
          dailyRow: null,
          funnelOk: false,
          abandons: [],
          jev: null,
        }),
        phase2: emptyPhase2(),
      });
    }

    const lastStats = isRecord(status.data?.last_stats) ? status.data.last_stats : null;
    let jev: unknown = lastStats?.jev ?? null;
    const dailyRow = daily.data ?? null;
    if (dailyRow && isClosedEasternDay(parsed.asOf) && lastStats) {
      const keyed = hasGatewayKey();
      try {
        jev = await ensureFunnelJevTriage({
          stats: lastStats,
          hasGatewayKey: keyed,
          evaluate: keyed ? evaluateViaGateway : undefined,
          persist: status.data?.id === 1
            ? async (merged) => {
              const { error: writeErr } = await sb
                .from("shopify_funnel_status")
                .update({
                  last_stats: merged,
                  updated_at: new Date().toISOString(),
                })
                .eq("id", 1);
              if (writeErr) {
                throw new Error(writeErr.message);
              }
            }
            : undefined,
        });
      } catch {
        jev = lastStats.jev ?? null;
      }
    }

    const digest = buildConversionDigest({
      asOf: parsed.asOf,
      dailyRow,
      funnelOk: status.data?.funnel_ok ?? null,
      abandons: (abandons.data ?? []) as AbandonedRow[],
      jev,
    });

    const [ga4, gscQueries, gscPages, googleAds, metaAds] = await Promise.all([
      loadOptionalDay(sb, "ga4_landing_daily", "metric_date,landing_page,device,sessions,engaged_sessions,landings,view_item,add_to_cart,begin_checkout,purchase", parsed.asOf),
      loadOptionalDay(sb, "gsc_query_daily", "metric_date,query,clicks,impressions,ctr,position", parsed.asOf),
      loadOptionalDay(sb, "gsc_page_daily", "metric_date,page,clicks,impressions,ctr,position", parsed.asOf),
      loadOptionalDay(sb, "google_ads_daily", "metric_date,campaign_id,spend,clicks,conversions", parsed.asOf),
      loadOptionalDay(sb, "meta_ads_daily", "metric_date,campaign_id,spend,clicks,conversions", parsed.asOf),
    ]);

    return Response.json({
      ...digest,
      phase2: phase2FromLockedDay(parsed.asOf, {
        ga4, gscQueries, gscPages, googleAds, metaAds,
      }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({
      ...buildConversionDigest({
        asOf: parsed.asOf,
        dailyRow: null,
        funnelOk: false,
        abandons: [],
        jev: null,
      }),
      phase2: emptyPhase2(),
    }, { status: /not configured/i.test(msg) ? 503 : 200 });
  }
}
