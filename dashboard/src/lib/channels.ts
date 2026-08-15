/**
 * Canonical channel / source identifiers and display helpers.
 *
 * Every place that groups or labels data by "shopify" vs "amazon" should
 * use these helpers instead of raw string comparisons.
 */

// Canonical channel names (match the DB CHECK constraint on sales_by_state)
export const SHOPIFY = "shopify" as const;
export const AMAZON = "amazon" as const;
export const OTHER = "other" as const;

const CHANNEL_MAP: Record<string, string> = {
  shopify: SHOPIFY,
  shopify_api: SHOPIFY,
  shopify_orders: SHOPIFY,
  shopify_csv: SHOPIFY,
  amazon: AMAZON,
  amazon_inventory: AMAZON,
  amazon_sales: AMAZON,
  amazon_custom_combined_tax: AMAZON,
  amazon_tax_report: AMAZON,
  amazon_spapi: AMAZON,
};

/** Map any source / file_type / channel string to its canonical channel. */
export function normalizeChannel(raw: string): string {
  const key = raw.trim().toLowerCase();
  if (key in CHANNEL_MAP) return CHANNEL_MAP[key];
  if (key.startsWith("shopify")) return SHOPIFY;
  if (key.startsWith("amazon")) return AMAZON;
  return key;
}

/** True if this channel is a marketplace facilitator (Amazon). */
export function isMarketplace(channel: string): boolean {
  return normalizeChannel(channel) === AMAZON;
}

/** Human-readable label for a channel. */
export function channelLabel(channel: string): string {
  const c = normalizeChannel(channel);
  if (c === SHOPIFY) return "Shopify";
  if (c === AMAZON) return "Amazon FBA";
  return channel;
}

/** Human-readable label for a file_type from ingestion_log. */
export function fileTypeLabel(fileType: string): string {
  const labels: Record<string, string> = {
    amazon_inventory: "Amazon Inventory",
    amazon_sales: "Amazon Tax Report",
    shopify_orders: "Shopify Orders",
    shopify_api: "Shopify API",
    registrations: "Registrations",
  };
  return labels[fileType] ?? fileType.replace(/_/g, " ");
}

/**
 * Base state-level sales tax rates (2026).
 *
 * These are STATE-LEVEL rates only — local/county/city taxes are additional.
 * Used for rough liability estimates; NOT for filing-ready calculations.
 */
export const STATE_TAX_RATES: Record<string, number> = {
  AL: 0.04,
  AZ: 0.056,
  AR: 0.065,
  CA: 0.0725,
  CO: 0.029,
  CT: 0.0635,
  DC: 0.06,
  FL: 0.06,
  GA: 0.04,
  HI: 0.04,
  ID: 0.06,
  IL: 0.0625,
  IN: 0.07,
  IA: 0.06,
  KS: 0.065,
  KY: 0.06,
  LA: 0.0445,
  ME: 0.055,
  MD: 0.06,
  MA: 0.0625,
  MI: 0.06,
  MN: 0.06875,
  MS: 0.07,
  MO: 0.04225,
  NE: 0.055,
  NV: 0.0685,
  NJ: 0.06625,
  NM: 0.05125,
  NY: 0.04,
  NC: 0.0475,
  ND: 0.05,
  OH: 0.0575,
  OK: 0.045,
  PA: 0.06,
  RI: 0.07,
  SC: 0.06,
  SD: 0.045,
  TN: 0.07,
  TX: 0.0625,
  UT: 0.061,
  VT: 0.06,
  VA: 0.053,
  WA: 0.065,
  WV: 0.06,
  WI: 0.05,
  WY: 0.04,
};
