import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/sqp-sync — enqueue Brand Analytics SQP pull for the Mac Mini worker.
 *
 * Previously this route shelled out to `python -m src.main sqp-sync` on the
 * Vercel host (no venv, no SP-API credentials, timeouts). The Mini agent's
 * job worker (`_run_job_worker`) runs `_run_sqp_sync()` when it claims a
 * pending `sqp_sync` row.
 */
export async function POST() {
  try {
    const sb = getServerSupabase();
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "sqp_sync",
        status: "pending",
        payload: { source: "dashboard" },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json({
        ok: false,
        error: error.message,
        hint:
          "Could not enqueue sqp_sync. Confirm agent_jobs exists and SUPABASE_SERVICE_KEY is set. "
          + "Or on the Mini: python -m src.main sqp-sync --apply",
      }, { status: 500 });
    }

    try {
      await sb.from("audit_log").insert({
        action: "request_sqp_sync",
        category: "ingestion",
        details: { source: "dashboard", job_id: job?.id },
      });
    } catch {
      /* audit is best-effort */
    }

    return Response.json({
      ok: true,
      enqueued: true,
      job_id: job?.id,
      message:
        "SQP sync enqueued. The Mac Mini agent (python -m src.main run) picks this up within ~45s. "
        + "Amazon may take several minutes to finish generating the report.",
    });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      hint: "Request failed before enqueue. Check dashboard Supabase env vars.",
    }, { status: 500 });
  }
}
