/**
 * Sales-map aggregation: destination (ship-to) state, sales_by_state.gross_sales.
 * Amazon + additive Shopify (seller + Shop + sub). Quarantined tax dumps skipped.
 */

import {
  AMAZON,
  SHOPIFY,
  SHOPIFY_SHOP,
  SHOPIFY_SUB,
  isQuarantinedSource,
  isShopifyFamily,
  normalizeChannel,
} from "@/lib/channels";

export const UNMAPPED_STATE = "XX";

/** Destination states drawn on the US map (50 + DC). Anything else is a hole. */
const US_DEST_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

export type YearFilter = "all" | "2024" | "2025" | "2026";
export type ChannelFilter = "all" | "shopify" | "amazon";
/** null = full year/all; "latest" = most recent month; "YYYY-MM" = specific */
export type MonthFilter = null | "latest" | string;

export interface SalesMapRow {
  state_code: string | null;
  channel: string;
  period_start: string | null;
  gross_sales: number;
  order_count: number;
  source: string | null;
}

export interface StateAgg {
  total: number;
  shopify: number;
  shopifySeller: number;
  shopifyShop: number;
  shopifySub: number;
  amazon: number;
  orders: number;
  shopifyOrders: number;
  amazonOrders: number;
}

export interface SalesMapAggResult {
  byState: Record<string, StateAgg>;
  unmapped: StateAgg;
  skippedQuarantine: number;
}

export function emptyAgg(): StateAgg {
  return {
    total: 0,
    shopify: 0,
    shopifySeller: 0,
    shopifyShop: 0,
    shopifySub: 0,
    amazon: 0,
    orders: 0,
    shopifyOrders: 0,
    amazonOrders: 0,
  };
}

/** Ship-to key. Blank / non-US codes are holes, not invent a state. */
export function destStateKey(stateCode: string | null | undefined): string {
  const sc = (stateCode ?? "").trim().toUpperCase();
  if (!US_DEST_STATES.has(sc)) return UNMAPPED_STATE;
  return sc;
}

function matchesChannel(ch: string, filter: ChannelFilter): boolean {
  if (filter === "all") return true;
  if (filter === "amazon") return ch === AMAZON;
  return isShopifyFamily(ch);
}

function addTo(bucket: StateAgg, row: SalesMapRow, ch: string): void {
  const amt = Number(row.gross_sales) || 0;
  const orders = Number(row.order_count) || 0;
  bucket.total += amt;
  bucket.orders += orders;
  if (ch === AMAZON) {
    bucket.amazon += amt;
    bucket.amazonOrders += orders;
    return;
  }
  if (ch === SHOPIFY) {
    bucket.shopify += amt;
    bucket.shopifySeller += amt;
    bucket.shopifyOrders += orders;
    return;
  }
  if (ch === SHOPIFY_SHOP) {
    bucket.shopify += amt;
    bucket.shopifyShop += amt;
    bucket.shopifyOrders += orders;
    return;
  }
  if (ch === SHOPIFY_SUB) {
    bucket.shopify += amt;
    bucket.shopifySub += amt;
    bucket.shopifyOrders += orders;
  }
}

export function aggregateSalesMap(
  sales: SalesMapRow[],
  year: YearFilter,
  channel: ChannelFilter,
  month: MonthFilter,
  availableMonths: string[],
): SalesMapAggResult {
  const byState: Record<string, StateAgg> = {};
  const unmapped = emptyAgg();
  let skippedQuarantine = 0;

  const resolvedMonth =
    month === "latest" && availableMonths.length > 0
      ? availableMonths[availableMonths.length - 1]
      : month;

  for (const s of sales) {
    const ps = s.period_start ?? "";
    if (year !== "all" && ps.slice(0, 4) !== year) continue;
    if (resolvedMonth && resolvedMonth !== "latest") {
      if (ps.slice(0, 7) !== resolvedMonth) continue;
    }
    if (isQuarantinedSource(s.source)) {
      skippedQuarantine += Number(s.gross_sales) || 0;
      continue;
    }

    const ch = normalizeChannel(s.channel);
    if (!matchesChannel(ch, channel)) continue;

    const sc = destStateKey(s.state_code);
    if (sc === UNMAPPED_STATE) {
      addTo(unmapped, s, ch);
      continue;
    }
    if (!byState[sc]) byState[sc] = emptyAgg();
    addTo(byState[sc], s, ch);
  }

  return { byState, unmapped, skippedQuarantine };
}
