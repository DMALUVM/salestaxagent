import { getServerSupabase } from "@/lib/supabase-server";

interface DailySeries {
  date: string;
  spend: number;
  ad_sales: number;
  orders: number;
  clicks: number;
  impressions: number;
}

interface KPIs {
  spend: number;
  adSales: number;
  orders: number;
  clicks: number;
  impressions: number;
  acos: number;
  roas: number;
  cpc: number;
  cvr: number;
  totalSales: number;
  tacos: number;
}

function aggregate(rows: DailySeries[], totalSales: number): KPIs {
  const spend = rows.reduce((s, r) => s + r.spend, 0);
  const adSales = rows.reduce((s, r) => s + r.ad_sales, 0);
  const orders = rows.reduce((s, r) => s + r.orders, 0);
  const clicks = rows.reduce((s, r) => s + r.clicks, 0);
  const impressions = rows.reduce((s, r) => s + r.impressions, 0);
  return {
    spend, adSales, orders, clicks, impressions,
    acos: adSales > 0 ? (spend / adSales) * 100 : 0,
    roas: spend > 0 ? adSales / spend : 0,
    cpc: clicks > 0 ? spend / clicks : 0,
    cvr: clicks > 0 ? (orders / clicks) * 100 : 0,
    totalSales,
    tacos: totalSales > 0 ? (spend / totalSales) * 100 : 0,
  };
}

/** GET /api/ppc — Server-side aggregated KPIs, daily series, search terms, recs. */
export async function GET() {
  try {
    const sb = getServerSupabase();

    // ── Fetch ALL campaign-daily rows (no limit — typically <5k rows for 30d) ──
    let allCampaignRows: Array<Record<string, unknown>> = [];
    try {
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        const r = await sb.from("ads_campaigns_daily").select("*")
          .order("date", { ascending: true })
          .range(offset, offset + pageSize - 1);
        const page = r.data ?? [];
        allCampaignRows = allCampaignRows.concat(page);
        if (page.length < pageSize) break;
        offset += pageSize;
      }
    } catch { /* table may not exist */ }

    // ── Build daily series from campaign rows ──
    const dailyMap = new Map<string, DailySeries>();
    for (const c of allCampaignRows) {
      const d = String(c.date ?? "");
      if (!d) continue;
      const entry = dailyMap.get(d) ?? { date: d, spend: 0, ad_sales: 0, orders: 0, clicks: 0, impressions: 0 };
      entry.spend += Number(c.spend ?? 0);
      entry.ad_sales += Number(c.sales_14d ?? 0);
      entry.orders += Number(c.orders_14d ?? 0);
      entry.clicks += Number(c.clicks ?? 0);
      entry.impressions += Number(c.impressions ?? 0);
      dailyMap.set(d, entry);
    }
    const dailySeries = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // ── Date range info ──
    const dateMin = dailySeries.length ? dailySeries[0].date : null;
    const dateMax = dailySeries.length ? dailySeries[dailySeries.length - 1].date : null;
    const daysInDb = dailySeries.length;

    // ── Compute KPIs for 7D / 14D / 30D windows ──
    const now = new Date();
    function cutoff(days: number) {
      const d = new Date(now);
      d.setDate(d.getDate() - days);
      return d.toISOString().slice(0, 10);
    }

    // Total Amazon sales from sales_daily for TACOS
    const salesByDate = new Map<string, number>();
    try {
      const r = await sb.from("sales_daily").select("sale_date,gross_sales").eq("channel", "amazon");
      for (const row of r.data ?? []) {
        const d = String(row.sale_date ?? "");
        salesByDate.set(d, (salesByDate.get(d) ?? 0) + Number(row.gross_sales ?? 0));
      }
    } catch { /* */ }

    function kpisForRange(days: number) {
      const c = cutoff(days);
      const filtered = dailySeries.filter(r => r.date >= c);
      let totalSales = 0;
      for (const [d, g] of salesByDate) {
        if (d >= c) totalSales += g;
      }
      return { kpis: aggregate(filtered, totalSales), days: filtered.length };
    }

    const kpi7 = kpisForRange(7);
    const kpi14 = kpisForRange(14);
    const kpi30 = kpisForRange(30);

    // ── Campaign-level aggregation for selected range (all available data) ──
    const campaignAgg: Record<string, { spend: number; sales: number; orders: number; clicks: number; impressions: number }> = {};
    for (const c of allCampaignRows) {
      const name = String(c.campaign_name ?? "");
      if (!campaignAgg[name]) campaignAgg[name] = { spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0 };
      campaignAgg[name].spend += Number(c.spend ?? 0);
      campaignAgg[name].sales += Number(c.sales_14d ?? 0);
      campaignAgg[name].orders += Number(c.orders_14d ?? 0);
      campaignAgg[name].clicks += Number(c.clicks ?? 0);
      campaignAgg[name].impressions += Number(c.impressions ?? 0);
    }
    const campaigns = Object.entries(campaignAgg)
      .map(([name, d]) => ({
        campaign_name: name, ...d,
        acos: d.sales > 0 ? (d.spend / d.sales) * 100 : 0,
        roas: d.spend > 0 ? d.sales / d.spend : 0,
        cvr: d.clicks > 0 ? (d.orders / d.clicks) * 100 : 0,
      }))
      .sort((a, b) => b.spend - a.spend);

    // ── Search terms ──
    let searchTerms: unknown[] = [];
    try {
      const r = await sb.from("ads_search_terms_daily").select("*").order("spend", { ascending: false }).limit(300);
      searchTerms = r.data ?? [];
    } catch { /* */ }

    // ── Recommendations ──
    let recommendations: unknown[] = [];
    try {
      const r = await sb.from("ads_recommendations").select("*").eq("status", "open").order("impact_estimate", { ascending: false }).limit(50);
      recommendations = r.data ?? [];
    } catch { /* */ }

    // ── Last sync time from job_runs ──
    let lastSync: string | null = null;
    try {
      const r = await sb.from("job_runs").select("started_at").eq("job_name", "ads_sync").order("started_at", { ascending: false }).limit(1);
      if (r.data?.[0]) lastSync = r.data[0].started_at;
    } catch { /* */ }

    return Response.json({
      kpi7: kpi7.kpis, kpi7Days: kpi7.days,
      kpi14: kpi14.kpis, kpi14Days: kpi14.days,
      kpi30: kpi30.kpis, kpi30Days: kpi30.days,
      dailySeries,
      dateMin, dateMax, daysInDb,
      campaigns, searchTerms, recommendations,
      lastSync,
    });
  } catch (e) {
    return Response.json({
      kpi7: null, kpi14: null, kpi30: null,
      dailySeries: [], campaigns: [], searchTerms: [], recommendations: [],
      dateMin: null, dateMax: null, daysInDb: 0, lastSync: null,
    });
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
