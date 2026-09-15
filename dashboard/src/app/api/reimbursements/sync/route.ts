import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { REIMBURSEMENTS_DEFAULT_DAYS } from "@/lib/reimbursements-desk";

/**
 * POST /api/reimbursements/sync
 *
 * Enqueues `reimbursements_sync` for the Mac Mini job worker.
 * Same GET_FBA_REIMBURSEMENTS_DATA pull as nightly (default 90 closed LA days).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Number(body.days);
    const days = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(Math.trunc(raw), 1), 365)
      : REIMBURSEMENTS_DEFAULT_DAYS;

    const sb = getServerSupabase();
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "reimbursements_sync",
        status: "pending",
        payload: { days, source: "dashboard" },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json(
        {
          error: error.message,
          hint: "Could not enqueue reimbursements_sync. Confirm agent_jobs exists and SUPABASE_SERVICE_KEY is set. Or on the Mini: ./.venv/bin/python -m src.main spapi-reimbursements --days " + days,
        },
        { status: 500 },
      );
    }

    try {
      await sb.from("audit_log").insert({
        action: "request_reimbursements_sync",
        category: "ingestion",
        details: { source: "dashboard", days, job_id: job?.id },
      });
    } catch {
      /* audit is best-effort */
    }

    return Response.json({
      ok: true,
      job_id: job?.id,
      message:
        `Reimbursements sync enqueued (last ${days} closed LA days). `
        + "The Mac Mini worker runs GET_FBA_REIMBURSEMENTS_DATA — this desk does not open Amazon cases.",
    });
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : String(e),
        hint: "Run on the Mini: ./.venv/bin/python -m src.main spapi-reimbursements --days 90",
      },
      { status: 500 },
    );
  }
}
