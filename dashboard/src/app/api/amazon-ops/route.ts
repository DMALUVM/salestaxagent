import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/amazon-ops — Sales & Traffic + Reimbursements summary. */
export async function GET() {
  try {
    const sb = getServerSupabase();

    let traffic: unknown[] = [];
    let asinTraffic: unknown[] = [];
    let reimbursements: unknown[] = [];

    try {
      const r = await sb.from("amazon_sales_traffic").select("*").order("date", { ascending: false }).limit(30);
      traffic = r.data ?? [];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("amazon_asin_traffic").select("*").order("units_ordered", { ascending: false }).limit(20);
      asinTraffic = r.data ?? [];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("fba_reimbursements").select("*").order("approval_date", { ascending: false }).limit(100);
      reimbursements = r.data ?? [];
    } catch { /* table may not exist */ }

    return Response.json({ traffic, asinTraffic, reimbursements });
  } catch (e) {
    return Response.json({ traffic: [], asinTraffic: [], reimbursements: [] });
  }
}
