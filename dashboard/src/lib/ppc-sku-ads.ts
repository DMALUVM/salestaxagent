/**
 * SKU / ASIN ads vs contribution — read-only rollup.
 *
 * Ads reports we sync have no advertised_sku / advertised_asin column, and
 * pnl_daily SKU rows store ad_spend = 0 (unallocated by design). So:
 *
 *   - Spend / ad sales / ACOS come from ads_campaigns_daily.
 *   - A campaign is labelled with a SKU/ASIN only when its name contains
 *     exactly one catalog token (sku_costs.sku or sku_costs.asin) as a
 *     whole word. Ambiguous or unmatched campaigns stay as campaigns.
 *   - Contribution is UNAVAILABLE unless that join is unique AND a P&L SKU
 *     row exists for the same window. We never invent an allocation.
 */

export interface SkuCatalogRow {
  sku: string;
  asin?: string | null;
  product_name?: string | null;
}

export interface CampaignSpend {
  campaign_name: string;
  campaign_type?: string;
  spend: number;
  sales: number;
}

export interface PnlSkuRow {
  sku: string;
  est_contribution?: number | null;
  net_after_ads?: number | null;
}

export interface SkuAdsRow {
  key: string;
  grain: "sku" | "campaign";
  sku: string | null;
  asin: string | null;
  label: string;
  campaignType: string;
  campaigns: number;
  spend: number;
  adSales: number;
  acos: number | null;
  contribution: number | null;
  contributionAvailable: boolean;
  contributionNote: string;
}

const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9_-]{2,}/g;

export function tokensOf(name: string): string[] {
  return (name.match(TOKEN_RE) ?? []).map((t) => t.toLowerCase());
}

/**
 * Unique catalog hit for a campaign name, or null when zero/ambiguous.
 * Whole-token only — a SKU that is a substring of a longer word does not match.
 */
export function matchCampaignToSku(
  campaignName: string,
  catalog: SkuCatalogRow[],
): SkuCatalogRow | null {
  const tokens = new Set(tokensOf(campaignName));
  if (tokens.size === 0) return null;
  const hits: SkuCatalogRow[] = [];
  const seen = new Set<string>();
  for (const row of catalog) {
    const sku = String(row.sku ?? "").trim();
    const asin = String(row.asin ?? "").trim();
    const skuHit = sku.length >= 3 && tokens.has(sku.toLowerCase());
    const asinHit = asin.length >= 3 && tokens.has(asin.toLowerCase());
    if (!skuHit && !asinHit) continue;
    if (seen.has(sku)) continue;
    seen.add(sku);
    hits.push(row);
  }
  return hits.length === 1 ? hits[0] : null;
}

export function rollUpSkuAds(
  campaigns: CampaignSpend[],
  catalog: SkuCatalogRow[],
  pnlBySku: Map<string, number> | Record<string, number> = {},
): { rows: SkuAdsRow[]; matchedCampaigns: number; unmatchedCampaigns: number } {
  const pnl = pnlBySku instanceof Map ? pnlBySku : new Map(Object.entries(pnlBySku));
  const byKey = new Map<string, SkuAdsRow>();
  let matchedCampaigns = 0;
  let unmatchedCampaigns = 0;

  for (const c of campaigns) {
    const spend = Number(c.spend ?? 0);
    const sales = Number(c.sales ?? 0);
    if (spend <= 0 && sales <= 0) continue;
    const hit = catalog.length ? matchCampaignToSku(c.campaign_name, catalog) : null;
    const type = String(c.campaign_type ?? "SP").toUpperCase() || "SP";

    if (hit) {
      matchedCampaigns += 1;
      const sku = String(hit.sku);
      const key = `sku:${sku}`;
      const existing = byKey.get(key);
      const contribution = pnl.has(sku) ? Number(pnl.get(sku)) : null;
      if (existing) {
        existing.spend += spend;
        existing.adSales += sales;
        existing.campaigns += 1;
        existing.acos = existing.adSales > 0
          ? Math.round((existing.spend / existing.adSales) * 1000) / 10
          : null;
        continue;
      }
      byKey.set(key, {
        key, grain: "sku", sku,
        asin: hit.asin ? String(hit.asin) : null,
        label: hit.product_name || sku,
        campaignType: type,
        campaigns: 1, spend, adSales: sales,
        acos: sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null,
        contribution,
        contributionAvailable: contribution !== null,
        contributionNote: contribution !== null
          ? "P&L SKU contribution for this window (ads are not allocated at SKU grain — this is the stored operating figure, not spend subtracted twice)."
          : "Contribution unavailable — no pnl_daily SKU row for this window.",
      });
    } else {
      unmatchedCampaigns += 1;
      const key = `camp:${c.campaign_name}`;
      byKey.set(key, {
        key, grain: "campaign", sku: null, asin: null,
        label: c.campaign_name || "(unnamed campaign)",
        campaignType: type,
        campaigns: 1, spend, adSales: sales,
        acos: sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null,
        contribution: null,
        contributionAvailable: false,
        contributionNote: "Contribution unavailable — campaign did not uniquely match a sku_costs SKU/ASIN.",
      });
    }
  }

  const rows = [...byKey.values()].sort((a, b) => b.spend - a.spend);
  return { rows, matchedCampaigns, unmatchedCampaigns };
}

export const SB_SD_NOTE =
  "SB/SD have no search-term grain (Amazon limitation). Spend here is campaign-level for every ad product.";

export const CONTRIBUTION_UNAVAILABLE_NOTE =
  "Contribution is shown only when a campaign name uniquely matches a sku_costs SKU or ASIN and a pnl_daily SKU-grain row exists. Ads we sync have no advertised SKU column, and P&L SKU rows do not carry allocated ad spend — unmatched rows stay as campaigns with contribution unavailable rather than an invented allocation.";
