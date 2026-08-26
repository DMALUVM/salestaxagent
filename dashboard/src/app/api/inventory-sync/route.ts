import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/inventory-sync
 *
 * Enqueues full inventory sync (FBA + AWD + restock + inbound + rate signals)
 * for the Mac Mini job worker — same as scheduled 06:30 inventory_sync.
 */
export async function POST(request: NextRequest) {
  try {
    await request.json().catch(() => ({}));

    const sb = getServerSupabase();
    const { data: job, error } = await sb
      .from("agent_jobs")
      .insert({
        job_type: "inventory_sync",
        status: "pending",
        payload: { source: "dashboard" },
      })
      .select("id")
      .single();

    if (error) {
      return Response.json(
        {
          error: error.message,
          hint: "Run on Mac Mini: python -m src.main inventory-sync",
        },
        { status: 500 },
      );
    }

    await sb.from("audit_log").insert({
      action: "request_inventory_sync",
      category: "ingestion",
      details: { source: "dashboard", job_id: job?.id },
    });

    return Response.json({
      ok: true,
      job_id: job?.id,
      message:
        "inventory_sync enqueued. Mac Mini worker will run FBA + AWD + restock + calibration.",
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
