import { getServerSupabase } from "@/lib/supabase-server";
import {
  loadShippedAsinTitleOverrides,
  resolveParentProductNames,
} from "@/lib/amazon-ops-titles";

/** GET /api/amazon-ops — Sales & Traffic + Reimbursements with title resolution. */
export async function GET() {
  try {
    const sb = getServerSupabase();

    let traffic: unknown[] = [];
    let asinTraffic: Record<string, unknown>[] = [];
    let reimbursements: unknown[] = [];
    let snsSeller: unknown[] = [];
    let snsOffers: unknown[] = [];

    try {
      const r = await sb.from("amazon_sales_traffic").select("*").order("date", { ascending: false }).limit(30);
      traffic = r.data ?? [];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("amazon_asin_traffic").select("*").order("units_ordered", { ascending: false }).limit(20);
      asinTraffic = (r.data ?? []) as Record<string, unknown>[];
    } catch { /* table may not exist */ }

    try {
      const r = await sb.from("fba_reimbursements").select("*").order("approval_date", { ascending: false }).limit(100);
      reimbursements = r.data ?? [];
    } catch { /* table may not exist */ }

    // Parent ASIN → parent display name. Overrides ship with the dashboard
    // (not process.cwd()). Exact DB match only — no child-ASIN prefix fallback.
    if (asinTraffic.length > 0) {
      const dbTitles: { asin?: string | null; product_name?: string | null }[] = [];
      for (const table of ["sku_velocity", "fba_returns", "fba_reimbursements", "inventory_restock"]) {
        try {
          const r = await sb.from(table).select("asin,product_name").limit(300);
          for (const row of r.data ?? []) dbTitles.push(row);
        } catch { /* table may not exist */ }
      }
      resolveParentProductNames(
        asinTraffic,
        loadShippedAsinTitleOverrides(),
        dbTitles,
      );
    }

    try {
      const r = await sb.from("sns_seller_metrics").select("*").order("week_start").limit(200);
      snsSeller = r.data ?? [];
    } catch { /* table may not exist */ }

    try {
      // One row per ASIN per week is stored. Without a week filter, top-N by subs
      // mixes weeks and the same SKU/ASIN appears twice (last week + prior week).
      const r = await sb.from("sns_offer_metrics").select("*").order("week_start", { ascending: false }).limit(500);
      const offerRows = (r.data ?? []) as Array<{
        asin: string;
        sku?: string | null;
        week_start: string;
        week_end: string;
        active_subscriptions?: number;
      }>;
      const completeOffers = offerRows.filter((o) => {
        const s = new Date(`${o.week_start}T00:00:00`);
        const e = new Date(`${o.week_end}T00:00:00`);
        return (e.getTime() - s.getTime()) >= 6 * 86400000;
      });
      const latestOfferWeek = completeOffers.reduce(
        (max, o) => (o.week_start > max ? o.week_start : max),
        "",
      );
      snsOffers = latestOfferWeek
        ? completeOffers
            .filter((o) => o.week_start === latestOfferWeek)
            .sort((a, b) => (b.active_subscriptions ?? 0) - (a.active_subscriptions ?? 0))
        : [];
    } catch { /* table may not exist */ }

    return Response.json({ traffic, asinTraffic, reimbursements, snsSeller, snsOffers });
  } catch (e) {
    return Response.json({ traffic: [], asinTraffic: [], reimbursements: [], snsSeller: [], snsOffers: [] });
  }
}
