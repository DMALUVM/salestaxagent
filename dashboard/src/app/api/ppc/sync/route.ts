import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/ppc/sync — enqueue a short ads catch-up for the Mac Mini worker.
 *
 * Catch-up is campaigns-only for the last 7 closed days (nightly SP lookback).
 * Search terms (~90 min) and placements stay on their scheduled jobs. The
 * worker also defaults the same way, so a payload that only has `{days: 7}`
 * cannot start a full ads suite.
 *
 * Body: { days?: number }  (clamped 1..90, default 7)
 * Optional: campaigns_only (default true), search_terms_only, placements_only
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = Math.min(Math.max(Number(body.days) || 7, 1), 90);
    const searchTermsOnly = Boolean(body.search_terms_only);
    const placementsOnly = Boolean(body.placements_only);
    const campaignsOnly =
      body.campaigns_only === false || searchTermsOnly || placementsOnly
        ? Boolean(body.campaigns_only)
        : true;

    const sb = getServerSupabase();
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "ads_sync",
        status: "pending",
        payload: {
          days,
          campaigns_only: campaignsOnly,
          search_terms_only: searchTermsOnly,
          placements_only: placementsOnly,
          source: "dashboard",
        },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json(
        {
          error: error.message,
          hint: "Could not enqueue ads_sync. Confirm agent_jobs exists and SUPABASE_SERVICE_KEY is set. Or run on the Mac Mini: python -m src.main ads-sync --days " + days + " --campaigns-only",
        },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      job_id: job?.id,
      message: `ads_sync enqueued (days=${days}, campaigns_only=${campaignsOnly}). Mac Mini job worker will pick it up.`,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
