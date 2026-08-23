import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import {
  normalizePaidAdsPayload,
  toUpsertRows,
} from "@/lib/paid-ads";

/**
 * POST /api/paid-ads/ingest
 *
 * Upsert an Ads Ops structured payload into the production tables:
 *   paid_ads_snapshots         on (channel, as_of, window_days)
 *   paid_ads_campaigns_window  on (channel, as_of, window_days, campaign_name)
 *
 * Protected by dashboard Basic Auth. Service-role client. No Ads Manager scrape.
 * Dashboard Agent may upsert the same uniques in Supabase when Ads Ops
 * delivers the JSON over chat.
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

    if (rows.campaignWindows.length) {
      const { error } = await sb
        .from("paid_ads_campaigns_window")
        .upsert(rows.campaignWindows, {
          onConflict: "channel,as_of,window_days,campaign_name",
        });
      if (error) {
        return Response.json(
          { ok: false, error: `paid_ads_campaigns_window: ${error.message}` },
          { status: 500 },
        );
      }
    }

    return Response.json({
      ok: true,
      channel: normalized.data.channel,
      as_of: normalized.data.as_of,
      source: normalized.data.source,
      snapshots_upserted: rows.snapshots.length,
      campaigns_upserted: rows.campaignWindows.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
