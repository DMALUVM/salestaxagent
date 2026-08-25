import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/sqp-sync?job_id=… — poll agent_jobs row for dashboard enqueue status.
 * POST — enqueue Brand Analytics SQP pull for the Mac Mini worker.
 */
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("job_id");
  if (!jobId) {
    return Response.json({ ok: false, error: "job_id required" }, { status: 400 });
  }
  try {
    const sb = getServerSupabase();
    const { data, error } = await sb
      .from("agent_jobs")
      .select("id,job_type,status,started_at,finished_at,error_text")
      .eq("id", jobId)
      .maybeSingle();
    if (error) {
      return Response.json({ ok: false, error: error.message }, { status: 500 });
    }
    if (!data) {
      return Response.json({ ok: false, error: "job not found" }, { status: 404 });
    }
    return Response.json({ ok: true, job: data });
  } catch (e) {
    return Response.json({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 });
  }
}

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
