import type { NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase-server";

/**
 * GET /api/pnl/day?date=YYYY-MM-DD — drill-down for one Amazon day.
 *
 * Read-only over existing tables; no formula lives here. Returns the stored
 * account row, the grain='sku' rows for that date, and the campaigns that made
 * up the day's ad spend, so the panel can show what the headline number is
 * built from.
 */
export async function GET(request: NextRequest) {
  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });
  }

  try {
    const sb = getServerSupabase();

    const { data: acctRows } = await sb.from("pnl_daily").select("*")
      .eq("grain", "account").eq("date", date).limit(1);
    const account = acctRows?.[0] ?? null;

    // SKU-grain rows for the day, if pnl-sync stored them.
    const { data: skuRows } = await sb.from("pnl_daily")
      .select("sku,gross_sales,units,ad_spend,est_referral_fees,est_fba_fees,est_cogs,est_contribution")
      .eq("grain", "sku").eq("date", date)
      .order("est_contribution", { ascending: false })
      .limit(200);

    // Campaigns behind that day's ad spend — same table the account figure sums.
    const campaigns: Array<{ campaign_name: string; spend: number; sales: number }> = [];
    let adSpendTotal = 0;
    try {
      let offset = 0;
      const pageSize = 1000;
      const byCampaign = new Map<string, { spend: number; sales: number }>();
      while (true) {
        const { data, error } = await sb.from("ads_campaigns_daily")
          .select("campaign_name,spend,sales_14d")
          .eq("date", date)
          .range(offset, offset + pageSize - 1);
        if (error) break;
        const page = data ?? [];
        for (const r of page) {
          const name = String(r.campaign_name ?? "");
          const e = byCampaign.get(name) ?? { spend: 0, sales: 0 };
          e.spend += Number(r.spend ?? 0);
          e.sales += Number(r.sales_14d ?? 0);
          adSpendTotal += Number(r.spend ?? 0);
          byCampaign.set(name, e);
        }
        if (page.length < pageSize) break;
        offset += pageSize;
      }
      campaigns.push(...[...byCampaign.entries()]
        .map(([campaign_name, v]) => ({ campaign_name, ...v }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 10));
    } catch { /* ads table may not exist */ }

    const parseMeta = (m: unknown): Record<string, unknown> => {
      if (!m) return {};
      if (typeof m === "object") return m as Record<string, unknown>;
      try { return JSON.parse(String(m)) as Record<string, unknown>; } catch { return {}; }
    };
    const meta = parseMeta(account?.meta);

    return Response.json({
      date,
      account,
      skus: skuRows ?? [],
      campaigns,
      adSpendTotal: Math.round(adSpendTotal * 100) / 100,
      feesBasis: typeof meta.fees_basis === "string" ? meta.fees_basis : "estimated",
      cogsBasis: typeof meta.cogs_basis === "string" ? meta.cogs_basis : null,
      settledPayout: typeof meta.settled_payout === "number" ? meta.settled_payout : null,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
