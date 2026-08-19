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

/** POST /api/ppc — Update rec status OR generate recommendations. */
export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Generate recommendations action
    if (body.action === "generate") {
      const targetAcos = body.target_acos ?? 30;
      const sb = getServerSupabase();

      // Load search terms
      const { data: searchTerms } = await sb.from("ads_search_terms_daily")
        .select("*").order("spend", { ascending: false });
      const terms = searchTerms ?? [];

      if (!terms.length) {
        return Response.json({ ok: true, count: 0, message: "No search term data — run ads-sync first" });
      }

      // Generate recs server-side (same logic as Python action engine)
      const recs: Array<Record<string, unknown>> = [];

      for (const st of terms) {
        const spend = Number(st.spend ?? 0);
        const orders = Number(st.orders_14d ?? 0);
        const clicks = Number(st.clicks ?? 0);
        const acos = Number(st.acos ?? 0);
        const sales = Number(st.sales_14d ?? 0);
        const matchType = (st.match_type ?? "").toLowerCase();

        // P0: NEGATE — spend >= $5, 0 orders
        if (spend >= 5 && orders === 0) {
          recs.push({
            type: "NEGATE_SEARCH_TERM", priority: "P0",
            impact_estimate: spend,
            entity_type: "search_term", entity_name: st.search_term,
            campaign_name: st.campaign_name, campaign_id: st.campaign_id,
            ad_group_id: st.ad_group_id || "",
            evidence: JSON.stringify({ spend, orders: 0, clicks }),
            suggested_action: `Add negative exact: "${st.search_term}"`,
            status: "open",
          });
        }

        // P1: HARVEST — converting, good ACOS
        if (orders >= 1 && acos > 0 && acos <= targetAcos && spend >= 3 && matchType !== "exact") {
          recs.push({
            type: "HARVEST_SEARCH_TERM", priority: "P1",
            impact_estimate: sales,
            entity_type: "search_term", entity_name: st.search_term,
            campaign_name: st.campaign_name, campaign_id: st.campaign_id,
            ad_group_id: st.ad_group_id || "",
            evidence: JSON.stringify({ spend, orders, acos, sales_14d: sales, match_type: matchType }),
            suggested_action: `Add exact keyword: "${st.search_term}" (ACOS ${acos.toFixed(0)}%, ${orders} orders)`,
            status: "open",
          });
        }

        // P1: REDUCE_BID
        if (acos > targetAcos * 1.5 && clicks >= 5 && orders > 0 && spend >= 5) {
          const savings = Math.round(spend * (1 - targetAcos / Math.max(acos, 1)) * 100) / 100;
          recs.push({
            type: "REDUCE_BID", priority: "P1",
            impact_estimate: savings,
            entity_type: "keyword", entity_name: st.keyword || st.search_term,
            campaign_name: st.campaign_name, campaign_id: st.campaign_id,
            ad_group_id: st.ad_group_id || "",
            evidence: JSON.stringify({ spend, acos, orders, clicks, target_acos: targetAcos }),
            suggested_action: `Reduce bid: ACOS ${acos.toFixed(0)}% vs target ${targetAcos}% → save ~$${savings.toFixed(2)}`,
            status: "open",
          });
        }
      }

      // Clear old open recs, insert fresh
      await sb.from("ads_recommendations").delete().eq("status", "open");
      if (recs.length) {
        // Batch insert (Supabase limit ~1000)
        for (let i = 0; i < recs.length; i += 500) {
          await sb.from("ads_recommendations").insert(recs.slice(i, i + 500));
        }
      }

      return Response.json({ ok: true, count: recs.length });
    }

    // Update status
    const { id, status } = body;
    if (!id || !status) return Response.json({ error: "id and status required" }, { status: 400 });
    const sb = getServerSupabase();
    await sb.from("ads_recommendations").update({ status }).eq("id", id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
