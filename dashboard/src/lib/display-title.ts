/**
 * Display-layer product title rewriter.
 *
 * Replaces legacy brand "Dr. Dave's Primal Essence" with "Tallowbourn"
 * in product titles shown in the UI. Does NOT modify database records.
 *
 * Priority: shopifyTitle > rewritten amazonTitle > sku
 */

const BRAND_REPLACEMENTS: [RegExp, string][] = [
  [/Dr\.\s*Dave['']s\s+Primal\s+Essence\s*/gi, "Tallowbourn "],
  [/Dr\.\s*Dave['']s\s*/gi, "Tallowbourn "],
];

/**
 * Return a display-friendly product title.
 *
 * @param amazonTitle  — raw title from Amazon SP-API / sales_by_sku
 * @param shopifyTitle — title from Shopify (already uses Tallowbourn)
 * @returns cleaned title for UI display
 */
export function displayTitle(
  amazonTitle?: string | null,
  shopifyTitle?: string | null,
): string {
  // Prefer Shopify title (already branded correctly)
  if (shopifyTitle?.trim()) return shopifyTitle.trim();

  if (!amazonTitle?.trim()) return "";

  let title = amazonTitle.trim();
  for (const [pattern, replacement] of BRAND_REPLACEMENTS) {
    title = title.replace(pattern, replacement);
  }

  // Clean up double spaces
  return title.replace(/\s{2,}/g, " ").trim();
}

/**
 * Return the raw Amazon title for tooltip/support context.
 */
export function rawTitle(amazonTitle?: string | null): string {
  return amazonTitle?.trim() ?? "";
}
