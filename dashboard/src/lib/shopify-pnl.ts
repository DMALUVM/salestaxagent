import { shiftDays } from "./as-of";

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
}

export interface ShopifyPnlWindow {
  contribution: number;
  sales: number;
  merchandise: number;
  shippingCharged: number;
  estOutbound: number;
  cogs: number;
  orders: number;
  subOrders: number;
  oneTimeOrders: number;
  provisionalOrders: number;
  days: number;
}

export function emptyShopifyWindow(): ShopifyPnlWindow {
  return {
    contribution: 0, sales: 0, merchandise: 0, shippingCharged: 0,
    estOutbound: 0, cogs: 0, orders: 0, subOrders: 0, oneTimeOrders: 0,
    provisionalOrders: 0, days: 0,
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
    out.orders += Number(r.order_count ?? 0);
    out.subOrders += Number(r.subscription_orders ?? 0);
    out.oneTimeOrders += Number(r.one_time_orders ?? 0);
    out.provisionalOrders += Number(r.provisional_shipping_orders ?? 0);
  }
  return out;
}
