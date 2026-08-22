import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/spapi-refresh
 *
 * Enqueues an `agent_jobs` row with job_type `spapi_refresh`. The Mac Mini
 * Python worker (`_run_job_worker` in src/main.py) claims pending jobs and
 * runs the SP-API orders + inventory refresh. Do not shell out from Vercel.
 *
 * Body: { days?: number }  (default 30)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = typeof body.days === "number" ? body.days : 30;

    const sb = getServerSupabase();

    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "spapi_refresh",
        status: "pending",
        payload: { days, source: "dashboard" },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json(
        { error: `Failed to enqueue refresh: ${error.message}` },
        { status: 500 },
      );
    }

    await sb.from("audit_log").insert({
      action: "request_spapi_refresh",
      category: "ingestion",
      details: { days, source: "dashboard", job_id: job?.id },
    });

    return Response.json({
      success: true,
      job_id: job?.id,
      message: `SP-API refresh enqueued (last ${days} days). The Mac Mini agent job worker will process it on the next poll.`,
    });
  } catch (e) {
    return Response.json(
      { error: `Request failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
