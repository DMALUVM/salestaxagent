import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/ppc/sync — enqueue ads-sync for the Mac Mini worker.
 *
 * Previously this route `exec`'d `python -m src.main ads-sync` on the Vercel
 * serverless host (no venv, no Ads credentials, request timeouts). It now
 * inserts an `agent_jobs` row with job_type `ads_sync`; `_run_job_worker`
 * handles it the same way as the scheduled ads sync jobs.
 *
 * Body: { days?: number }  (clamped 1..90, default 14)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = Math.min(Math.max(Number(body.days) || 14, 1), 90);

    const sb = getServerSupabase();
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "ads_sync",
        status: "pending",
        payload: { days, source: "dashboard" },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json(
        {
          error: error.message,
          hint: "Could not enqueue ads_sync. Confirm agent_jobs exists and SUPABASE_SERVICE_KEY is set. Or run on the Mac Mini: python -m src.main ads-sync --days " + days,
        },
        { status: 500 },
      );
    }

    return Response.json({
      ok: true,
      job_id: job?.id,
      message: `ads_sync enqueued (days=${days}). Mac Mini job worker will pick it up.`,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
