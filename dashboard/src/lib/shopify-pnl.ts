import { shiftDays } from "./as-of";

/**
 * DTC outbound from the Apr–Jun 2026 3PL invoice fit (tpl_cost_detail).
 * $2.00 order fee + $6.00 postage + $0.30 packaging + $0.50 per unit.
 * est_outbound_ship = 8.30 + 0.50 × units_in_order.
 * Flat $9.90/order when units are unknown.
 * Storage and account management are not included.
 * Must match config/business_rules.json → shopify.outbound_*.
 */
export const SHOPIFY_OUTBOUND_FIXED_PER_ORDER = 8.3;
export const SHOPIFY_OUTBOUND_PER_UNIT = 0.5;
export const SHOPIFY_OUTBOUND_FLAT_FALLBACK = 9.9;

/** Account-grain Shopify row from pnl_daily (channel=shopify). */
export interface ShopifyPnlRow {
  date: string;
  gross_sales: number;
  units: number;
  est_fba_fees: number;
  est_cogs: number;
  est_contribution: number;
  net_after_ads: number;
  merchandise?: number;
  shipping_charged?: number;
  est_outbound_ship?: number;
  order_count?: number;
  subscription_orders?: number;
  one_time_orders?: number;
  provisional_shipping_orders?: number;
  outbound_per_order?: number;
  outbound_basis?: string;
  cogs_basis?: string;
  /** Writer flag. Absent on older rows — inferred from units / cogs_basis. */
  units_known?: boolean;
  ad_spend?: number;
  google_ad_spend?: number;
  meta_ad_spend?: number;
}

export interface ShopifyPnlWindow {
  contribution: number;
  sales: number;
  merchandise: number;
  shippingCharged: number;
  estOutbound: number;
  cogs: number;
  adSpend: number;
  googleAdSpend: number;
  metaAdSpend: number;
  orders: number;
  subOrders: number;
  oneTimeOrders: number;
  provisionalOrders: number;
  days: number;
}

export interface ChannelAdSpend {
  date: string;
  spend: number;
}

export function emptyShopifyWindow(): ShopifyPnlWindow {
  return {
    contribution: 0, sales: 0, merchandise: 0, shippingCharged: 0,
    estOutbound: 0, cogs: 0, adSpend: 0, googleAdSpend: 0, metaAdSpend: 0,
    orders: 0, subOrders: 0, oneTimeOrders: 0,
    provisionalOrders: 0, days: 0,
  };
}

function money(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 8.30 + 0.50 × units, or $9.90/order when units are unknown. */
export function estimateShopifyOutbound(
  orderCount: number,
  units: number | null,
  unitsKnown: boolean,
): { amount: number; basis: string } {
  const n = Number(orderCount) || 0;
  if (n <= 0) return { amount: 0, basis: "none" };
  if (!unitsKnown) {
    return { amount: money(n * SHOPIFY_OUTBOUND_FLAT_FALLBACK), basis: "tpl_flat_fallback" };
  }
  const u = Number(units) || 0;
  return {
    amount: money(n * SHOPIFY_OUTBOUND_FIXED_PER_ORDER + SHOPIFY_OUTBOUND_PER_UNIT * u),
    basis: "tpl_apr_jun_2026",
  };
}

function unitsAreKnown(row: ShopifyPnlRow): boolean {
  if (row.units_known === true) return true;
  if (row.units_known === false) return false;
  if (row.cogs_basis === "sales_by_sku_month_allocated") return true;
  return Number(row.units) > 0;
}

/** Sum campaign rows onto a date. Dates with no row are simply absent. */
export function sumAdSpendByDate(rows: ChannelAdSpend[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const date = (r.date || "").slice(0, 10);
    if (date.length !== 10) continue;
    out[date] = money((out[date] ?? 0) + (Number(r.spend) || 0));
  }
  return out;
}

/**
 * Subtract Google + Meta from Shopify contribution and replace the flat
 * $5.50 outbound with the 3PL formula. Idempotent when the writer already
 * stored the same outbound and ad_spend. Missing ad dates stay $0 — spend
 * is never copied from a neighboring day. Amazon ads are not an input.
 *
 * A date that has Google or Meta spend and no Shopify pnl row becomes a
 * zero-sales day so that spend is not dropped. Sales and units stay 0.
 */
export function applyShopifyProfitAdjustments(
  rows: ShopifyPnlRow[],
  google: ChannelAdSpend[],
  meta: ChannelAdSpend[],
): ShopifyPnlRow[] {
  const googleByDate = sumAdSpendByDate(google);
  const metaByDate = sumAdSpendByDate(meta);
  const seen = new Set<string>();
  const adjusted = rows.map((r) => {
    seen.add(r.date);
    return adjustShopifyRow(r, googleByDate[r.date] ?? 0, metaByDate[r.date] ?? 0);
  });
  const extras: ShopifyPnlRow[] = [];
  const adDates = new Set([...Object.keys(googleByDate), ...Object.keys(metaByDate)]);
  for (const date of adDates) {
    if (seen.has(date)) continue;
    const g = googleByDate[date] ?? 0;
    const m = metaByDate[date] ?? 0;
    const spend = money(g + m);
    if (spend === 0) continue;
    extras.push({
      date,
      gross_sales: 0,
      units: 0,
      est_fba_fees: 0,
      est_cogs: 0,
      est_contribution: money(-spend),
      net_after_ads: money(-spend),
      ad_spend: spend,
      google_ad_spend: g,
      meta_ad_spend: m,
      order_count: 0,
      est_outbound_ship: 0,
      merchandise: 0,
      shipping_charged: 0,
      units_known: false,
    });
  }
  return [...adjusted, ...extras].sort((a, b) => a.date.localeCompare(b.date));
}

function adjustShopifyRow(row: ShopifyPnlRow, google: number, meta: number): ShopifyPnlRow {
  const liveAds = money(google + meta);
  const storedAds = Number(row.ad_spend ?? 0);
  const orders = row.order_count;
  const storedOutbound = Number(row.est_outbound_ship ?? row.est_fba_fees ?? 0);
  let outbound = storedOutbound;
  let basis = row.outbound_basis;
  if (orders != null && orders > 0) {
    const est = estimateShopifyOutbound(orders, Number(row.units) || 0, unitsAreKnown(row));
    outbound = est.amount;
    basis = est.basis;
  }
  const contribution = money(
    Number(row.est_contribution ?? row.net_after_ads ?? 0)
    - (outbound - storedOutbound)
    - (liveAds - storedAds),
  );
  const perOrder = orders && orders > 0 ? money(outbound / orders) : row.outbound_per_order;
  return {
    ...row,
    est_outbound_ship: outbound,
    est_fba_fees: outbound,
    ad_spend: liveAds,
    google_ad_spend: google,
    meta_ad_spend: meta,
    est_contribution: contribution,
    net_after_ads: contribution,
    outbound_basis: basis,
    outbound_per_order: perOrder,
  };
}

/** Sum stored Shopify days in [from .. asOf] inclusive. Does not re-derive. */
export function summarizeShopifyWindow(
  rows: ShopifyPnlRow[],
  asOf: string,
  days: number,
): ShopifyPnlWindow {
  const from = shiftDays(asOf, -(days - 1));
  const slice = rows.filter((r) => r.date >= from && r.date <= asOf);
  const out = emptyShopifyWindow();
  out.days = slice.length;
  for (const r of slice) {
    out.contribution += Number(r.est_contribution ?? r.net_after_ads ?? 0);
    out.sales += Number(r.gross_sales ?? 0);
    out.merchandise += Number(r.merchandise ?? 0);
    out.shippingCharged += Number(r.shipping_charged ?? 0);
    out.estOutbound += Number(r.est_outbound_ship ?? r.est_fba_fees ?? 0);
    out.cogs += Number(r.est_cogs ?? 0);
    out.adSpend += Number(r.ad_spend ?? 0);
    out.googleAdSpend += Number(r.google_ad_spend ?? 0);
    out.metaAdSpend += Number(r.meta_ad_spend ?? 0);
    out.orders += Number(r.order_count ?? 0);
    out.subOrders += Number(r.subscription_orders ?? 0);
    out.oneTimeOrders += Number(r.one_time_orders ?? 0);
    out.provisionalOrders += Number(r.provisional_shipping_orders ?? 0);
  }
  return out;
}
