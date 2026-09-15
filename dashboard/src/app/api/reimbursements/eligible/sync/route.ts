import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";
import { CASE_QUEUE_DEFAULT_DAYS } from "@/lib/reimbursements-eligible";

/**
 * POST /api/reimbursements/eligible/sync
 *
 * Enqueues `reimbursements_case_sync` for the Mac Mini job worker.
 * Dana owns tab + sync. Pulls GET_LEDGER_DETAIL_VIEW_DATA Adjustments
 * and rebuilds the Needs-case queue. Never opens Amazon cases.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const raw = Number(body.days);
    const days = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.max(Math.trunc(raw), 1), 365)
      : CASE_QUEUE_DEFAULT_DAYS;
    const fetchLedger = body.fetch_ledger !== false;

    const sb = getServerSupabase();
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "reimbursements_case_sync",
        status: "pending",
        payload: { days, fetch_ledger: fetchLedger, source: "dashboard" },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json(
        {
          error: error.message,
          hint:
            "Could not enqueue reimbursements_case_sync. Confirm agent_jobs exists. "
            + "Or on the Mini: ./.venv/bin/python -m src.main reimbursements-case-sync --days " + days,
        },
        { status: 500 },
      );
    }

    try {
      await sb.from("audit_log").insert({
        action: "request_reimbursements_case_sync",
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
        `Needs-case sync enqueued (last ${days} closed LA days). `
        + "Mini pulls ledger Adjustments + inbound shorts. This desk does not open Amazon cases.",
    });
  } catch (e) {
    return Response.json(
      {
        error: e instanceof Error ? e.message : String(e),
        hint: "Run on the Mini: ./.venv/bin/python -m src.main reimbursements-case-sync --days 90",
      },
      { status: 500 },
    );
  }
}
