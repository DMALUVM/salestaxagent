/** Per-day ads reconciliation — flags partial SP-only sync days vs Seller Central. */

export interface CampaignDailyRow {
  date?: string;
  campaign_type?: string;
  spend?: number | string | null;
  sales_14d?: number | string | null;
  orders_14d?: number | string | null;
  clicks?: number | string | null;
  impressions?: number | string | null;
}

export interface DailyTypeSlice {
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  impressions: number;
  rows: number;
}

export interface DailyReconcileDay {
  date: string;
  spend: number;
  sales: number;
  orders: number;
  clicks: number;
  impressions: number;
  cpc: number | null;
  ctr: number | null;
  roas: number | null;
  productsPresent: string[];
  productsMissing: string[];
  /** SP landed but SB/SD missing while other days in the window have them. */
  partialSync: boolean;
  byType: Record<string, DailyTypeSlice>;
}

export interface DailyReconcileSummary {
  windowDays: number;
  /** Nightly SB/SD sync re-fetches this many closed days (business_rules.json). */
  sbSdRetryDays: number;
  from: string;
  asOf: string;
  days: DailyReconcileDay[];
  partialDayCount: number;
}

const AD_TYPES = ["SP", "SB", "SD"] as const;

function campaignTypeOf(c: CampaignDailyRow): string {
  const t = String(c.campaign_type ?? "").trim().toUpperCase();
  return t || "SP";
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build per-day reconcile rows for [asOf - (windowDays-1) .. asOf].
 * Seller Central totals span SP+SB+SD; partialSync marks days that look SP-only.
 */
export function buildDailyReconcile(
  rows: CampaignDailyRow[],
  asOf: string,
  windowDays = 7,
  sbSdRetryDays = 7,
): DailyReconcileSummary | null {
  if (!asOf) return null;

  const from = shiftDate(asOf, -(windowDays - 1));
  const accountHasType: Record<string, boolean> = { SP: false, SB: false, SD: false };

  for (const r of rows) {
    const d = String(r.date ?? "");
    if (!d || d < from || d > asOf) continue;
    accountHasType[campaignTypeOf(r)] = true;
  }

  const byDate = new Map<string, Map<string, DailyTypeSlice>>();

  for (const r of rows) {
    const d = String(r.date ?? "");
    if (!d || d < from || d > asOf) continue;
    const t = campaignTypeOf(r);
    let dateMap = byDate.get(d);
    if (!dateMap) {
      dateMap = new Map();
      byDate.set(d, dateMap);
    }
    const slice = dateMap.get(t) ?? {
      spend: 0, sales: 0, orders: 0, clicks: 0, impressions: 0, rows: 0,
    };
    slice.spend += num(r.spend);
    slice.sales += num(r.sales_14d);
    slice.orders += num(r.orders_14d);
    slice.clicks += num(r.clicks);
    slice.impressions += num(r.impressions);
    slice.rows += 1;
    dateMap.set(t, slice);
  }

  const days: DailyReconcileDay[] = [];
  for (let i = 0; i < windowDays; i++) {
    const date = shiftDate(from, i);
    const dateMap = byDate.get(date) ?? new Map<string, DailyTypeSlice>();
    const byType: Record<string, DailyTypeSlice> = {};
    let spend = 0;
    let sales = 0;
    let orders = 0;
    let clicks = 0;
    let impressions = 0;

    for (const t of AD_TYPES) {
      const slice = dateMap.get(t);
      if (!slice) continue;
      byType[t] = {
        spend: round2(slice.spend),
        sales: round2(slice.sales),
        orders: slice.orders,
        clicks: slice.clicks,
        impressions: slice.impressions,
        rows: slice.rows,
      };
      spend += slice.spend;
      sales += slice.sales;
      orders += slice.orders;
      clicks += slice.clicks;
      impressions += slice.impressions;
    }

    const productsPresent = AD_TYPES.filter((t) => dateMap.has(t));
    const productsMissing = AD_TYPES.filter((t) => !dateMap.has(t));
    const hasSp = dateMap.has("SP");
    const partialSync = hasSp && productsMissing.some(
      (t) => t !== "SP" && accountHasType[t],
    );

    days.push({
      date,
      spend: round2(spend),
      sales: round2(sales),
      orders,
      clicks,
      impressions,
      cpc: clicks > 0 ? round2(spend / clicks) : null,
      ctr: impressions > 0 ? round2((clicks / impressions) * 100) : null,
      roas: spend > 0 ? round2(sales / spend) : null,
      productsPresent,
      productsMissing,
      partialSync,
      byType,
    });
  }

  return {
    windowDays,
    sbSdRetryDays,
    from,
    asOf,
    days,
    partialDayCount: days.filter((d) => d.partialSync).length,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** ISO date shift without UTC midnight drift. */
function shiftDate(iso: string, deltaDays: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}
