import { getServerSupabase } from "@/lib/supabase-server";

/** GET /api/ppc — Ads campaigns, search terms, recommendations, TACOS. */
export async function GET() {
  try {
    const sb = getServerSupabase();
    let campaigns: unknown[] = [];
    let searchTerms: unknown[] = [];
    let recommendations: unknown[] = [];
    let totalSales7d = 0;
    let totalSales30d = 0;

    try {
      const r = await sb.from("ads_campaigns_daily").select("*").order("date", { ascending: false }).limit(200);
      campaigns = r.data ?? [];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("ads_search_terms_daily").select("*").order("spend", { ascending: false }).limit(300);
      searchTerms = r.data ?? [];
    } catch { /* */ }

    try {
      const r = await sb.from("ads_recommendations").select("*").eq("status", "open").order("impact_estimate", { ascending: false }).limit(50);
      recommendations = r.data ?? [];
    } catch { /* */ }

    // Total sales for TACOS from sales_daily (Amazon channel)
    try {
      const now = new Date();
      const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
      const d30 = new Date(now); d30.setDate(d30.getDate() - 30);
      const r = await sb.from("sales_daily").select("sale_date,gross_sales").eq("channel", "amazon");
      for (const row of r.data ?? []) {
        const g = Number(row.gross_sales ?? 0);
        if (row.sale_date >= d7.toISOString().slice(0, 10)) totalSales7d += g;
        if (row.sale_date >= d30.toISOString().slice(0, 10)) totalSales30d += g;
      }
    } catch { /* */ }

    return Response.json({ campaigns, searchTerms, recommendations, totalSales7d, totalSales30d });
  } catch (e) {
    return Response.json({ campaigns: [], searchTerms: [], recommendations: [], totalSales7d: 0, totalSales30d: 0 });
  }
}

/** POST /api/ppc — Update recommendation status (dismiss/apply). */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { id, status } = body;
    if (!id || !status) return Response.json({ error: "id and status required" }, { status: 400 });
    const sb = getServerSupabase();
    await sb.from("ads_recommendations").update({ status }).eq("id", id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
