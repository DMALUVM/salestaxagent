import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/3pl-costs
 * Returns monthly summary, fee breakdown, and detail counts.
 */
export async function GET() {
  try {
    const sb = getServerSupabase();
    const [monthly, fees, detailCounts] = await Promise.all([
      sb.from("tpl_cost_monthly").select("*").order("month").then((r) => r.data ?? []),
      sb.from("tpl_cost_fees").select("*").order("month").then((r) => r.data ?? []),
      sb.from("tpl_cost_detail").select("month,category,amount").then((r) => r.data ?? []),
    ]);
    return Response.json({ monthly, fees, detail: detailCounts });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
