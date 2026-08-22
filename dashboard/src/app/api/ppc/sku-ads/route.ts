import { getServerSupabase } from "@/lib/supabase-server";
import { amazonAsOf, windowStart } from "@/lib/as-of";
import {
  rollUpSkuAds, SB_SD_NOTE, CONTRIBUTION_UNAVAILABLE_NOTE,
  type CampaignSpend, type SkuCatalogRow,
} from "@/lib/ppc-sku-ads";

/**
 * GET /api/ppc/sku-ads?days=7 — top SKUs/ASINs (or campaigns) by ad spend.
 *
 * Read-only. Does not change ads sync. Contribution is omitted unless a
 * campaign uniquely matches sku_costs AND a pnl_daily SKU row exists.
 */

const ALLOWED_DAYS = new Set([7, 14, 30, 90]);

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const raw = Number(url.searchParams.get("days") ?? 7);
    const days = ALLOWED_DAYS.has(raw) ? raw : 7;
    const asOf = amazonAsOf();
    const start = windowStart(asOf, days);
    const sb = getServerSupabase();

    const campaigns: CampaignSpend[] = [];
    const loadErrors: string[] = [];
    try {
      let offset = 0;
      const byName = new Map<string, CampaignSpend>();
      while (true) {
        const r = await sb.from("ads_campaigns_daily")
          .select("campaign_name,campaign_type,spend,sales_14d")
          .gte("date", start)
          .lte("date", asOf)
          .order("date", { ascending: true })
          .order("campaign_id", { ascending: true })
          .range(offset, offset + 999);
        if (r.error) throw new Error(r.error.message);
        const page = r.data ?? [];
        for (const row of page) {
          const name = String(row.campaign_name ?? "");
          const e = byName.get(name) ?? {
            campaign_name: name,
            campaign_type: String(row.campaign_type ?? "SP").toUpperCase() || "SP",
            spend: 0, sales: 0,
          };
          e.spend += Number(row.spend ?? 0);
          e.sales += Number(row.sales_14d ?? 0);
          byName.set(name, e);
        }
        if (page.length < 1000) break;
        offset += 1000;
      }
      campaigns.push(...byName.values());
    } catch (e) {
      loadErrors.push(`ads_campaigns_daily: ${e instanceof Error ? e.message : String(e)}`);
    }

    let catalog: SkuCatalogRow[] = [];
    try {
      const r = await sb.from("sku_costs").select("sku,asin,product_name");
      if (r.error) throw new Error(r.error.message);
      catalog = (r.data ?? []) as SkuCatalogRow[];
    } catch (e) {
      loadErrors.push(`sku_costs: ${e instanceof Error ? e.message : String(e)}`);
    }

    const pnlBySku = new Map<string, number>();
    try {
      let offset = 0;
      while (true) {
        const r = await sb.from("pnl_daily")
          .select("sku,est_contribution")
          .eq("grain", "sku")
          .gte("date", start)
          .lte("date", asOf)
          .order("date", { ascending: true })
          .order("sku", { ascending: true })
          .range(offset, offset + 999);
        if (r.error) throw new Error(r.error.message);
        const page = r.data ?? [];
        for (const row of page) {
          const sku = String(row.sku ?? "");
          if (!sku || sku.startsWith("__")) continue;
          pnlBySku.set(sku, (pnlBySku.get(sku) ?? 0) + Number(row.est_contribution ?? 0));
        }
        if (page.length < 1000) break;
        offset += 1000;
      }
    } catch {
      // P&L SKU grain may be absent — contribution stays unavailable.
    }

    const rolled = rollUpSkuAds(campaigns, catalog, pnlBySku);
    const top = rolled.rows.slice(0, 12);
    const anyContribution = top.some((r) => r.contributionAvailable);

    return Response.json({
      available: loadErrors.length === 0 || campaigns.length > 0,
      asOf, start, days,
      rows: top,
      matchedCampaigns: rolled.matchedCampaigns,
      unmatchedCampaigns: rolled.unmatchedCampaigns,
      catalogSize: catalog.length,
      contributionAvailable: anyContribution,
      notes: [CONTRIBUTION_UNAVAILABLE_NOTE, SB_SD_NOTE],
      loadErrors,
    });
  } catch (e) {
    return Response.json({
      available: false,
      rows: [],
      error: e instanceof Error ? e.message : String(e),
      notes: [CONTRIBUTION_UNAVAILABLE_NOTE, SB_SD_NOTE],
    }, { status: 500 });
  }
}
