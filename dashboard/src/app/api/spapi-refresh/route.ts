import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * POST /api/spapi-refresh
 *
 * Triggers a server-side SP-API data refresh by inserting a task
 * into the research_tasks table that the Python agent picks up.
 *
 * The actual SP-API call happens in the Python process — the dashboard
 * simply enqueues the request and returns immediately.
 *
 * Body: { days?: number }  (default 30)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const days = typeof body.days === "number" ? body.days : 30;

    const sb = getServerSupabase();

    // Insert a high-priority research task for the Python agent to pick up
    const { error } = await sb.from("research_tasks").insert({
      title: `SP-API refresh (last ${days} days)`,
      description: `Fetch orders and inventory data from Amazon SP-API for the last ${days} days. Triggered from dashboard.`,
      priority: "high",
      task_type: "spapi_refresh",
      status: "open",
      state_code: null,
    });

    if (error) {
      return Response.json(
        { error: `Failed to enqueue refresh: ${error.message}` },
        { status: 500 },
      );
    }

    // Also log the request
    await sb.from("audit_log").insert({
      action: "request_spapi_refresh",
      category: "ingestion",
      details: { days, source: "dashboard" },
    });

    return Response.json({
      success: true,
      message: `SP-API refresh enqueued (last ${days} days). The Python agent will process it on its next cycle, or run: python -m src.main spapi-refresh --days ${days}`,
    });
  } catch (e) {
    return Response.json(
      { error: `Request failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 500 },
    );
  }
}
