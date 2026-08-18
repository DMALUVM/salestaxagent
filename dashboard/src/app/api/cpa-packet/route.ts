import { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/cpa-packet?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Downloads a JSON CPA review packet containing:
 * - Non-quarantined sales_by_state for the period
 * - nexus_status (registered states with account numbers)
 * - filing_events in the period
 *
 * Labeled "For CPA review — not a tax return."
 */

const QUARANTINED = new Set(["amazon_custom_combined_tax", "amazon_tax_report"]);

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const start = url.searchParams.get("start") || "2020-01-01";
    const end = url.searchParams.get("end") || new Date().toISOString().slice(0, 10);

    const sb = getServerSupabase();

    const [salesRes, nexusRes, eventsRes] = await Promise.all([
      sb.from("sales_by_state")
        .select("*")
        .gte("period_start", start)
        .lte("period_end", end)
        .order("state_code")
        .order("period_start"),
      sb.from("nexus_status")
        .select("state_code,is_registered,registration_date,assigned_frequency,last_filed_through,account_number,has_physical_nexus,has_economic_nexus,economic_progress_percent"),
      sb.from("filing_events")
        .select("*")
        .gte("period_start", start)
        .lte("period_end", end)
        .order("state_code"),
    ]);

    // Filter quarantined sources
    const sales = (salesRes.data ?? []).filter(
      (r: Record<string, unknown>) => !QUARANTINED.has((r.source as string) ?? ""),
    );

    const packet = {
      _disclaimer: "FOR CPA REVIEW ONLY — NOT A TAX RETURN. Estimates based on available data. Amazon Custom Combined Tax CSV data excluded (quarantined). Rates are state-level approximations; local surcharges not included.",
      generated_at: new Date().toISOString(),
      period: { start, end },
      sales_by_state: sales,
      nexus_status: nexusRes.data ?? [],
      filing_events: eventsRes.data ?? [],
      summary: {
        total_states: new Set(sales.map((r: Record<string, unknown>) => r.state_code)).size,
        total_sales: sales.length,
        total_filing_events: (eventsRes.data ?? []).length,
        registered_states: (nexusRes.data ?? []).filter((r: Record<string, unknown>) => r.is_registered).length,
      },
    };

    return new Response(JSON.stringify(packet, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="cpa_packet_${start}_${end}.json"`,
      },
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
