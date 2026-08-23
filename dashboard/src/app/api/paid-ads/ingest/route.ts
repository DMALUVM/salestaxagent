import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  normalizePaidAdsPayload,
  toUpsertRows,
} from "@/lib/paid-ads";

/**
 * POST /api/paid-ads/ingest
 *
 * Upsert an Ads Ops structured payload into paid_ads_*.
 * Protected by the same dashboard Basic Auth as every other route.
 * Uses the service-role client. Does not scrape Ads Manager.
 *
 * Dashboard Agent may also upsert these tables directly in Supabase when
 * Ads Ops delivers the same JSON over chat — this route is the HTTP path.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ ok: false, error: "JSON body required" }, { status: 400 });
    }

    const normalized = normalizePaidAdsPayload(body);
    if (!normalized.ok) {
      return Response.json({ ok: false, error: normalized.error }, { status: 400 });
    }

    const ingestedAt = new Date().toISOString();
    const rows = toUpsertRows(normalized.data, ingestedAt);
    const sb = getServerSupabase();

    if (rows.daily.length) {
      const { error } = await sb
        .from("paid_ads_daily")
        .upsert(rows.daily, { onConflict: "channel,date" });
      if (error) {
        return Response.json(
          { ok: false, error: `paid_ads_daily: ${error.message}` },
          { status: 500 },
        );
      }
    }

    if (rows.campaigns.length) {
      const { error } = await sb
        .from("paid_ads_campaigns_daily")
        .upsert(rows.campaigns, { onConflict: "channel,date,campaign_id" });
      if (error) {
        return Response.json(
          { ok: false, error: `paid_ads_campaigns_daily: ${error.message}` },
          { status: 500 },
        );
      }
    }

    if (rows.snapshots.length) {
      const { error } = await sb
        .from("paid_ads_snapshots")
        .upsert(rows.snapshots, { onConflict: "channel,as_of,window_days" });
      if (error) {
        return Response.json(
          { ok: false, error: `paid_ads_snapshots: ${error.message}` },
          { status: 500 },
        );
      }
    }

    return Response.json({
      ok: true,
      channel: normalized.data.channel,
      as_of: normalized.data.as_of,
      source: normalized.data.source,
      daily_upserted: rows.daily.length,
      campaigns_upserted: rows.campaigns.length,
      snapshots_upserted: rows.snapshots.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
